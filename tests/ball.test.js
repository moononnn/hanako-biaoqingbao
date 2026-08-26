import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizePinnedIds,
  safeStickerPath,
  sanitizeBallText,
  buildAttachmentMessage,
  buildBallSendPayload,
  buildSemanticContext,
  createRequestId,
  sessionFileDirFor,
  materializeStickerCopy,
  readSessionIdFromFile,
  validatePinnedReorder,
} from '../lib/ball-core.js';
import { findMostActiveSession, listRecentSessions } from '../lib/ball-session.js';
import { recordRecentMatch, readRecentRecord } from '../lib/recent-match.js';
import {
  BALL_VARIANTS,
  normalizeBallVariant,
  readBallVariant,
  setBallVariant,
  readPinnedTarget,
  setPinnedTarget,
  resolveTarget,
  listSessions,
  sessionTitleOf,
  recentSessionTitle,
  filterRecentMatchesForPublicSessions,
  submitBallFeedback,
  shouldAutoVectorOnSave,
  buildBallStickerEntry,
} from '../lib/ball.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-ball-'));
}

function writeSession(root, agentId, fileName, lines) {
  const dir = path.join(root, 'agents', agentId, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, lines.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  return file;
}

test('normalizePinnedIds 只保留现存 id、去重并固定版本', () => {
  const result = normalizePinnedIds(['stk_002', 'stk_002', 'missing', 3], [
    { id: 'stk_001' },
    { id: 'stk_002' },
  ]);
  assert.deepEqual(result, { version: 1, pinnedIds: ['stk_002'] });
});

test('纸飞机识图入库记录 tagged_at，图库不会误判为未识图', () => {
  const now = '2026-08-24T07:00:00.000Z';
  const entry = buildBallStickerEntry({
    id: 'stk_new',
    file: 'stk_new.png',
    now,
    tags: {
      description: '一只开心的小猫',
      semantic_description: '适合分享好消息时使用',
      emotion: ['开心'],
      scene: ['分享'],
      keywords: ['小猫'],
    },
  });
  assert.equal(entry.added_at, now);
  assert.equal(entry.tagged_at, now);
  assert.equal(entry.description, '一只开心的小猫');
  assert.deepEqual(entry.tags.emotion, ['开心']);
});

test('safeStickerPath 拒绝路径穿越和目录外文件', () => {
  const root = path.join(tempDir(), 'stickers');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stk_001.png'), 'x');
  assert.equal(safeStickerPath(root, 'stk_001.png'), path.join(root, 'stk_001.png'));
  assert.equal(safeStickerPath(root, '../secret.txt'), null);
  assert.equal(safeStickerPath(root, 'C:\\secret.txt'), null);
  assert.equal(safeStickerPath(root, ''), null);
});

test('sanitizeBallText 清除控制字符并限制长度', () => {
  assert.equal(sanitizeBallText('  你好\u0000\u0007\n世界  ', 6), '你好\n世界');
  assert.equal(sanitizeBallText(null, 10), '');
});

test('隐藏语义只给模型本轮理解，不落进可见消息', () => {
  const context = buildSemanticContext({
    sticker: {
      file: 'stk_001.png',
      description: '一只猫猫认真点头',
      tags: { emotion: ['认可', '乖巧'], scene: ['回应'], keywords: ['猫'] },
    },
  });
  assert.match(context, /一只猫猫认真点头/);
  assert.match(context, /认可\/乖巧\/回应\/猫/);
  assert.match(context, /不显示给用户/);
  assert.match(context, /不要再次读取或识别图片文件/);
  assert.doesNotMatch(context, /\[SessionFile\]/);
  assert.doesNotMatch(context, /\[attached_image/);
});

test('buildAttachmentMessage 保留 SessionFile 图源、图片暗号与正文', () => {
  const text = buildAttachmentMessage({
    fileId: 'sf_1',
    sessionPath: 'C:/agents/hanako/sessions/a.jsonl',
    sessionId: 'sess_1',
    stagedPath: 'C:/stage/stk_001.png',
    sticker: {
      file: 'stk_001.png',
      description: '一只猫猫认真点头',
      tags: { emotion: ['认可', '乖巧'], scene: ['回应'], keywords: ['猫'] },
    },
    text: '收到啦',
  });
  assert.match(text, /\[SessionFile\]/);
  assert.match(text, /\"fileId\":\"sf_1\"/);
  assert.match(text, /\"label\":\"stk_001\.png\"/);
  assert.ok(text.includes('[attached_image: C:/stage/stk_001.png]'));
  assert.ok(text.includes('收到啦'));
  assert.doesNotMatch(text, /一只猫猫认真点头/);
  assert.doesNotMatch(text, /认可\/乖巧/);
});


test('buildAttachmentMessage 缺少托管路径时抛错', () => {
  assert.throws(() => buildAttachmentMessage({ sticker: {}, text: 'x' }), /图片登记信息不完整/);
});

test('悬浮球发送优先用附件暗号显示原图，隐藏语义不进入可见正文', () => {
  const payload = buildBallSendPayload({
    sessionPath: 'C:/agents/hanako/sessions/a.jsonl',
    sticker: {
      file: 'stk_001.png',
      description: '一只猫猫认真点头',
      tags: { emotion: ['认可'], scene: ['回应'], keywords: ['猫'] },
    },
    text: '收到啦',
    staged: { fileId: 'sf_1', sessionId: 'sess_1', stagedPath: 'C:/stage/stk_001.png' },
    images: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
  });
  assert.match(payload.text, /\[SessionFile\]/);
  assert.match(payload.text, /\[attached_image: C:\/stage\/stk_001\.png\]/);
  assert.ok(payload.text.includes('收到啦'));
  assert.doesNotMatch(payload.text, /一只猫猫认真点头|认可|回应|猫/);
  assert.equal('images' in payload, false);
  assert.match(payload.context.afterUser[0].text, /一只猫猫认真点头/);
});

test('悬浮球附件登记失败时退回原生 images，正文仍不泄露语义', () => {
  const payload = buildBallSendPayload({
    sessionPath: 'C:/agents/hanako/sessions/a.jsonl',
    sticker: { file: 'stk_001.png', description: '猫猫描述', tags: { emotion: ['开心'] } },
    text: '',
    staged: null,
    images: [{ type: 'image', data: 'base64', mimeType: 'image/png' }],
  });
  assert.equal(payload.text, '\u200B');
  assert.equal(payload.images.length, 1);
  assert.doesNotMatch(payload.text, /猫猫描述|开心/);
});

test('悬浮球没有附件也没有原图时拒绝发送', () => {
  assert.throws(() => buildBallSendPayload({ sessionPath: 'x', sticker: {}, text: 'x' }), /图片读取和登记都失败/);
});

test('悬浮球开关在主页，表情包加入操作在图库，设置页不再承载悬浮球配置', () => {
  const ui = fs.readFileSync(path.join(process.cwd(), 'routes', 'ui.js'), 'utf8');
  const client = fs.readFileSync(path.join(process.cwd(), 'assets', 'sticker-manager.js'), 'utf8');
  const api = fs.readFileSync(path.join(process.cwd(), 'routes', 'api.js'), 'utf8');
  assert.match(ui, /id="ball-toggle-top"/);
  assert.doesNotMatch(ui, /ball-settings-section/);
  assert.match(client, /加入悬浮球/);
  assert.match(client, /ball-toggle-top/);
  assert.doesNotMatch(client, /ball-toggle-btn/);
  assert.doesNotMatch(api, /\/api\/poc-/);
});

test('管理页 surface session API 请求走凭证头，legacy token 才走 query', () => {
  const client = fs.readFileSync(path.join(process.cwd(), 'assets', 'sticker-manager.js'), 'utf8');
  assert.match(client, /params\.get\('pluginSurfaceSession'\)/);
  assert.match(client, /params\.get\('token'\)/);
  assert.match(client, /X-Hana-Plugin-Surface-Session/);
  assert.match(client, /headers\.set\('X-Hana-Plugin-Surface-Session', auth\.surface\)/);
  assert.match(client, /if \(auth\.token\)/);
  assert.doesNotMatch(client, /if \(surface\) result\.pluginSurfaceSession/);
});

test('createRequestId 每次生成非空且不重复', () => {
  const a = createRequestId();
  const b = createRequestId();
  assert.match(a, /^ball-/);
  assert.notEqual(a, b);
});

test('悬浮球样式已收束为纸飞机，旧配置统一回落唯一主体', () => {
  assert.deepEqual(BALL_VARIANTS, ['plane']);
  assert.equal(normalizeBallVariant('plane'), 'plane');
  assert.equal(normalizeBallVariant(' PAW '), 'plane');
  assert.equal(normalizeBallVariant('missing'), 'plane');
  assert.equal(normalizeBallVariant(null), 'plane');
});

test('纸飞机样式配置可持久化并拒绝新增样式', async () => {
  const ctx = { dataDir: tempDir() };
  assert.equal(readBallVariant(ctx), 'plane');
  assert.deepEqual(await setBallVariant(ctx, 'plane'), { ok: true, variant: 'plane' });
  assert.equal(readBallVariant(ctx), 'plane');
  const bad = await setBallVariant(ctx, 'rocket');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(readBallVariant(ctx), 'plane');
});

test('listRecentSessions 按最后用户消息倒序、限长并带标题', () => {
  const root = tempDir();
  writeSession(root, 'hanako', 'old.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '旧对话' } },
  ]);
  writeSession(root, 'hanako', 'new.jsonl', [
    { type: 'message', timestamp: '2026-08-18T01:00:00.000Z', message: { role: 'user', content: '新对话' } },
  ]);
  writeSession(root, 'yumi', 'zzz.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:30:00.000Z', message: { role: 'user', content: '更早一段' } },
  ]);
  const list = listRecentSessions({ hanaHome: root, limit: 2 });
  assert.equal(list.length, 2);
  assert.match(list[0].sessionPath, /new\.jsonl$/);
  assert.equal(list[0].title, '新对话');
  assert.equal(list[0].agentId, 'hanako');
});

test('listRecentSessions 空会话/助手轮空不报错', () => {
  const root = tempDir();
  const list = listRecentSessions({ hanaHome: root });
  assert.deepEqual(list, []);
});

test('图片消息不会用零宽占位符污染会话标题', () => {
  const root = tempDir();
  writeSession(root, 'hanako', 'image.jsonl', [
    {
      type: 'message',
      timestamp: '2026-08-18T02:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '\u200B' },
          { type: 'image', data: 'base64', mimeType: 'image/png' },
        ],
      },
    },
  ]);
  const list = listRecentSessions({ hanaHome: root });
  assert.equal(list[0].title, '图片消息');
});

test('pinnedTarget 写入/读取/清除', async () => {
  const ctx = { dataDir: tempDir() };
  assert.equal(readPinnedTarget(ctx), null);
  await setPinnedTarget(ctx, { agentId: 'hanako', sessionPath: 'C:/agents/hanako/sessions/a.jsonl', title: '标题' });
  assert.deepEqual(readPinnedTarget(ctx), {
    agentId: 'hanako',
    sessionPath: 'C:/agents/hanako/sessions/a.jsonl',
    title: '标题',
  });
  await setPinnedTarget(ctx, null);
  assert.equal(readPinnedTarget(ctx), null);
});

test('resolveTarget 固定会话优先，文件失效自动清除并回落自动', async () => {
  const root = tempDir();
  const sessionFile = writeSession(root, 'hanako', 'fixed.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '固定窗口' } },
  ]);
  const ctx = {
    dataDir: path.join(root, 'data'),
    bus: {
      request: async () => ({
        sessions: [{ path: sessionFile, visibility: 'public', agentId: 'hanako' }],
      }),
    },
  };
  await setPinnedTarget(ctx, { agentId: 'hanako', sessionPath: sessionFile, title: '固定标题' });
  const target = await resolveTarget(ctx);
  assert.equal(target.sessionPath, sessionFile);
  assert.equal(target.pinned, true);
  assert.equal(target.title, '固定标题');
  fs.rmSync(sessionFile);
  const after = await resolveTarget(ctx);
  assert.equal(after, null); // 自动监测白名单为空（bus 返回空），没有可回落会话
  assert.equal(readPinnedTarget(ctx), null); // 失效已自动清除
});

test('resolveTarget 不把固定目标绕过公开会话白名单', async () => {
  const root = tempDir();
  const privateFile = writeSession(root, 'hanako', 'private-fixed.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '私密固定窗口' } },
  ]);
  const ctx = {
    dataDir: path.join(root, 'data'),
    bus: {
      request: async () => ({
        sessions: [{ path: privateFile, visibility: 'private', agentId: 'hanako' }],
      }),
    },
  };
  await setPinnedTarget(ctx, { agentId: 'hanako', sessionPath: privateFile, title: '私密固定' });
  assert.equal(await resolveTarget(ctx), null);
  assert.equal(readPinnedTarget(ctx), null);
});

test('session:list 缺少 visibility 时不进入公开目标白名单', async () => {
  const root = tempDir();
  const missingVisibility = writeSession(root, 'hanako', 'unknown.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '未标注公开性的对话' } },
  ]);
  const ctx = {
    dataDir: path.join(root, 'data'),
    bus: { request: async () => ({ sessions: [{ path: missingVisibility, agentId: 'hanako' }] }) },
  };
  await setPinnedTarget(ctx, { agentId: 'hanako', sessionPath: missingVisibility, title: '未标注' });
  assert.equal(await resolveTarget(ctx), null);
  assert.equal(readPinnedTarget(ctx), null);
});

test('listSessions 用 session:list 标题并提供助手名，私密会话不出现', async () => {
  const root = tempDir();
  const publicPath = writeSession(root, 'hanako', 'a.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '公开对话' } },
  ]);
  writeSession(root, 'yumi', 'b.jsonl', [
    { type: 'message', timestamp: '2026-08-18T01:00:00.000Z', message: { role: 'user', content: '私密对话' } },
  ]);
  const ctx = {
    dataDir: path.join(root, 'data'),
    bus: {
      request: async (name) => {
        if (name === 'session:list') {
          return {
            sessions: [
              { path: publicPath, visibility: 'public', title: '真实标题A', agentId: 'hanako', agentName: '小花' },
              { path: path.join(root, 'agents', 'yumi', 'sessions', 'b.jsonl'), visibility: 'private', title: '私密隐藏', agentId: 'yumi' },
            ],
          };
        }
        return {};
      },
    },
  };
  const sessions = await listSessions(ctx, 5);
  assert.ok(Array.isArray(sessions) && sessions.length > 0, '应返回至少一条公开会话');
  assert.equal(sessions[0].sessionPath, publicPath);
  assert.equal(sessions[0].title, '真实标题A');
  assert.equal(sessions[0].agentName, '小花');
  assert.ok(!sessions.some((s) => s.title === '私密隐藏'), '私密会话不得出现在列表');
});

test('findMostActiveSession 按最后用户消息时间选择，不被助手回复 mtime 抢走', () => {
  const root = tempDir();
  const older = writeSession(root, 'hanako', 'old.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '旧窗口' } },
    { type: 'message', timestamp: '2026-08-18T00:10:00.000Z', message: { role: 'assistant', content: '刚刚回复' } },
  ]);
  const newer = writeSession(root, 'yumi', 'new.jsonl', [
    { type: 'message', timestamp: 1787015000000, message: { role: 'user', content: '新窗口' } },
  ]);
  const picked = findMostActiveSession({ hanaHome: root });
  assert.equal(picked.agentId, 'yumi');
  assert.equal(picked.sessionPath, newer);
  assert.ok(fs.existsSync(older));
});

test('findMostActiveSession 可以按 session:list 白名单过滤私密会话', () => {
  const root = tempDir();
  const publicPath = writeSession(root, 'hanako', 'public.jsonl', [
    { type: 'message', timestamp: '2026-08-18T00:00:00.000Z', message: { role: 'user', content: '公开窗口' } },
  ]);
  writeSession(root, 'hanako', 'private.jsonl', [
    { type: 'message', timestamp: '2026-08-18T01:00:00.000Z', message: { role: 'user', content: '插件私密窗口' } },
  ]);
  const picked = findMostActiveSession({ hanaHome: root, allowedPaths: new Set([publicPath]) });
  assert.equal(picked.sessionPath, publicPath);
});

test('findMostActiveSession 无用户消息时才回退 mtime', () => {
  const root = tempDir();
  const first = writeSession(root, 'hanako', 'first.jsonl', [
    { type: 'session', timestamp: '2026-08-18T00:00:00.000Z' },
  ]);
  const second = writeSession(root, 'hanako', 'second.jsonl', [
    { type: 'session', timestamp: '2026-08-18T00:01:00.000Z' },
  ]);
  const now = Date.now();
  fs.utimesSync(first, new Date(now - 10_000), new Date(now - 10_000));
  fs.utimesSync(second, new Date(now), new Date(now));
  const picked = findMostActiveSession({ hanaHome: root });
  assert.equal(picked.sessionPath, second);
});

test('长会话末尾超过 256KB 时仍能找到最后一条用户消息（不被固定尾读截断）', () => {
  const root = tempDir();
  const longPath = writeSession(root, 'hanako', 'long.jsonl', [
    { type: 'message', timestamp: '2026-08-18T15:00:00.000Z', message: { role: 'user', content: '长会话里的用户消息' } },
  ]);
  // 追加一条远超 256KB 的助手回复，把用户消息推到“固定尾读窗口”之外
  fs.appendFileSync(
    longPath,
    JSON.stringify({ type: 'message', timestamp: '2026-08-18T15:01:00.000Z', message: { role: 'assistant', content: '长回复'.repeat(120_000) } }) + '\n',
    'utf8',
  );
  writeSession(root, 'yumi', 'short.jsonl', [
    { type: 'message', timestamp: '2026-08-18T10:00:00.000Z', message: { role: 'user', content: '短窗口' } },
  ]);
  const picked = findMostActiveSession({ hanaHome: root });
  assert.equal(picked.agentId, 'hanako');
  assert.equal(picked.sessionPath, longPath);
  assert.ok(fs.statSync(longPath).size > 256 * 1024, '夹具应超过 256KB');
});

test('悬浮球面板优先靠左、选图配正文后显式发送，并提供右键菜单', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  assert.match(src, /left_x = ax - pw - gap/);
  assert.match(src, /x = left_x if left_x >= left else right_x/);
  assert.match(src, /STICKER_COLUMNS = 4/);
  assert.match(src, /class BallContextMenu/);
  assert.match(src, /event\.button\(\) == Qt\.MouseButton\.RightButton/);
  assert.match(src, /self\.grid\.addWidget\(button, cell \/\/ self\.sticker_columns/);
  assert.match(src, /self\.select_sticker\(sid\)/);
  assert.match(src, /class MessageEdit/);
  assert.match(src, /self\.editor\.toPlainText\(\)/);
  assert.match(src, /self\.send_button\.clicked\.connect\(self\.send_selected\)/);
  assert.match(src, /send_requested\.connect\(self\.send_selected\)/);
  assert.match(src, /WA_StyledBackground/);
});

test('悬浮球左右键不互斥：开面板不关右键菜单、开菜单不关面板，菜单与面板分侧', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  const togglePanel = src.match(/def toggle_panel\(self\):([\s\S]*?)\n    def /)?.[1] || '';
  const toggleMenu = src.match(/def toggle_context_menu\(self\):([\s\S]*?)\n    def /)?.[1] || '';
  assert.doesNotMatch(togglePanel, /context_menu\.close\(\)/);
  assert.doesNotMatch(toggleMenu, /panel\.close\(\)/);
  assert.match(src, /两个弹窗可并存/);
  assert.match(src, /prefer_side=\"right\"/);
});

test('悬浮球面板顶部有对话目标选择器（自动判断/自己选择），内嵌在面板内随面板长高', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  assert.match(src, /class TargetMenu/);
  assert.match(src, /btn_target/);
  assert.match(src, /自动判断▾|btn_auto/);
  assert.match(src, /自己选择/);
  assert.match(src, /_sync_target_state/);
  assert.match(src, /request_json\(\"POST\", \"\/target\"/);
  assert.match(src, /发到哪段对话/);
  assert.match(src, /self\.target_menu = TargetMenu\(self\)/);
  assert.match(src, /root\.addWidget\(self\.target_menu\)/);
  assert.match(src, /TARGET_MENU_EXTRA/);
  // TargetMenu 是面板内嵌子控件：类体内不得再有独立窗口的痕迹
  const block = src.match(/class TargetMenu[\s\S]*?(?=\nclass BallPanel)/)?.[1] || '';
  assert.doesNotMatch(block, /show_at\(self\)|WindowType\.Tool|setFixedWidth\(252\)/);
});

test('纸飞机最近配图、反馈和内嵌聊天都走本地代理，并按目标会话绑定', () => {
  const ballSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'ball.js'), 'utf8');
  const pySrc = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  assert.match(ballSrc, /route\('GET', '\/recent-match'/);
  assert.match(ballSrc, /route\('POST', '\/feedback'/);
  assert.match(ballSrc, /route\('POST', '\/chat'/);
  assert.match(ballSrc, /route\('POST', '\/chat\/confirm'/);
  assert.match(ballSrc, /sessionPath: target\.sessionPath/);
  assert.match(pySrc, /RECENT_POLL_MS = 1500/);
  assert.match(pySrc, /def _build_recent_card/);
  assert.match(pySrc, /open_recent_chat/);
  assert.match(pySrc, /trigger_recent_arrival/);
});

test('纸飞机使用连续 QPainter 动画，并带尾流与流星层', () => {
  const appSrc = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  const motifSrc = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_motifs.py'), 'utf8');
  assert.match(appSrc, /self\.animator = MotifAnimator\(self\.variant\)/);
  assert.match(appSrc, /self\.animator\.paint\(painter, self\.rect\(\)\)/);
  assert.doesNotMatch(appSrc, /QSvgRenderer|BALL_ASSET_PATHS|self\.renderer/);
  assert.match(motifSrc, /VARIANT_PLANE = "plane"/);
  const pythonVariants = [...motifSrc.matchAll(/^VARIANT_[A-Z]+ = "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(pythonVariants, BALL_VARIANTS, 'Node 与 Python 的纸飞机白名单必须同步');
  assert.match(motifSrc, /def _draw_plane\(/);
  assert.match(motifSrc, /def _draw_gas_trail\(/);
  assert.match(motifSrc, /def _draw_meteors\(/);
  assert.match(motifSrc, /hover_burst/);
  assert.match(motifSrc, /click_burst/);
  assert.doesNotMatch(motifSrc, /VARIANT_(STICKY|PAW|LANTERN)/);
  assert.doesNotMatch(motifSrc, /猫爪|挑灯|便签纸/);
});

test('右键菜单只保留关闭入口', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  const menu = src.match(/class BallContextMenu[\s\S]*?(?=\n\nclass TargetMenu)/)?.[0] || '';
  assert.match(menu, /纸飞机悬浮球/);
  assert.doesNotMatch(menu, /右键只保留关闭入口/);
  assert.doesNotMatch(menu, /刷新表情包|refresh_panel/);
  assert.match(menu, /关闭悬浮球/);
  assert.doesNotMatch(menu, /variant_buttons|switch_variant|\/variant|猫爪|挑灯|便签纸/);
});

test('普通面板支持点击空白关闭与延迟淡出，识图弹窗单独排除', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  assert.match(src, /PANEL_FADE_DELAY_MS = 1200/);
  assert.match(src, /PANEL_FADE_OPACITY = 0\.78/);
  assert.match(src, /def _refresh_panel_opacity\(/);
  assert.match(src, /self\.panel\.recog_panel\.isVisible\(\)/);
  assert.match(src, /self\.panel\.close\(\)/);
  assert.match(src, /def close_auxiliary_menus\(/);
  assert.match(src, /def toggle_context_menu\([\s\S]*?recog_panel\.isVisible\(\)[\s\S]*?return/);
});

test('持续自运动主体用全局光标、滞回热区和离开宽限判断 hover', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'python', 'ball_app.py'), 'utf8');
  assert.match(src, /QCursor\.pos\(\)/);
  assert.match(src, /adjusted\(-18, -18, 18, 18\)/);
  assert.match(src, /adjusted\(8, 8, -8, -8\)/);
  assert.match(src, />= 0\.22/);
});

test('sessionFileDirFor 目录名与 Hana 会话托管目录一致（sha256(id:sessionId) 前 24 位）', () => {
  const dir = sessionFileDirFor({ hanaHome: 'C:\\Users\\alice\\.hanako', sessionId: 'sess_0mszdn321_e339768dc1780076a60a' });
  assert.equal(dir, 'C:\\Users\\alice\\.hanako\\session-files\\98bb85ae89d38f9f7368f4a7');
  // 空/非法入参返回 null
  assert.equal(sessionFileDirFor({ hanaHome: null, sessionId: 'x' }), null);
  assert.equal(sessionFileDirFor({ hanaHome: 'H', sessionId: '  ' }), null);
});

test('materializeStickerCopy 把表情包复制到会话托管目录并返回托管路径', () => {
  const root = tempDir();
  const stickers = path.join(root, 'stickers');
  fs.mkdirSync(stickers, { recursive: true });
  const src = path.join(stickers, 'stk_001.png');
  fs.writeFileSync(src, 'png-data');
  const dest = materializeStickerCopy({
    hanaHome: root,
    sessionId: 'sess_test_abcdefg',
    srcPath: src,
    fileName: 'stk_001.png',
  });
  assert.ok(dest, '应返回托管路径');
  const dir = sessionFileDirFor({ hanaHome: root, sessionId: 'sess_test_abcdefg' });
  assert.equal(path.dirname(dest), dir);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'png-data');
  assert.match(path.basename(dest), /^\d+_stk_001\.png$/);
  // 源不存在时返回 null（调用方退化原路径）
  assert.equal(materializeStickerCopy({ hanaHome: root, sessionId: 'sess_test_abcdefg', srcPath: path.join(stickers, 'nope.png'), fileName: 'nope.png' }), null);
});

test('readSessionIdFromFile 从会话文件头部读出 sessionId', () => {
  const root = tempDir();
  const sessionPath = writeSession(root, 'hanako', 'sess_a.jsonl', [
    {
      type: 'message',
      id: 'm1',
      timestamp: '2026-08-19T00:00:00.000Z',
      sessionId: 'sess_real_id_123',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    },
  ]);
  assert.equal(readSessionIdFromFile(sessionPath), 'sess_real_id_123');
  // 文件不存在 → null
  assert.equal(readSessionIdFromFile(path.join(root, 'nope.jsonl')), null);
});

test('validatePinnedReorder 只调序不增删：合法重排通过并规范化', () => {
  const checked = validatePinnedReorder(['stk_003', 'stk_001', 'stk_002'], ['stk_001', 'stk_002', 'stk_003']);
  assert.deepEqual(checked, { ok: true, pinnedIds: ['stk_003', 'stk_001', 'stk_002'] });
  // 相同顺序也是合法重排
  const same = validatePinnedReorder(['stk_001', 'stk_002'], ['stk_001', 'stk_002']);
  assert.equal(same.ok, true);
});

test('validatePinnedReorder 拒绝数量不符、重复、混入和空集', () => {
  const current = ['stk_001', 'stk_002', 'stk_003'];
  assert.equal(validatePinnedReorder(['stk_001', 'stk_002'], current).ok, false); // 少了
  assert.equal(validatePinnedReorder(['stk_001', 'stk_002', 'stk_003', 'stk_004'], current).ok, false); // 多了
  assert.equal(validatePinnedReorder(['stk_001', 'stk_001', 'stk_003'], current).ok, false); // 重复
  assert.equal(validatePinnedReorder(['stk_001', 'stk_002', 'stk_999'], current).ok, false); // 混进不存在的
  assert.equal(validatePinnedReorder([], current).ok, false); // 空
  assert.equal(validatePinnedReorder(['stk_001', 'stk_002'], []).ok, false); // 当前为空
  assert.equal(validatePinnedReorder(null, current).ok, false);
  assert.equal(validatePinnedReorder(['stk_001', 'stk_002', 'stk_003'], null).ok, false);
});

test('validatePinnedReorder 容忍带空白的 id 并自动清理', () => {
  const checked = validatePinnedReorder([' stk_002 ', 'stk_001', ''], ['stk_001', 'stk_002']);
  assert.deepEqual(checked, { ok: true, pinnedIds: ['stk_002', 'stk_001'] });
});

test('shouldAutoVectorOnSave 分享版默认关，开关开才自动向量', () => {
  // 未显式配置 autoVectorOnSave（空对象/只有 source）→ 默认关，不自动向量
  assert.equal(shouldAutoVectorOnSave({}), false);
  assert.equal(shouldAutoVectorOnSave({ source: 'custom' }), false);
  // 显式开 → 自动向量
  assert.equal(shouldAutoVectorOnSave({ autoVectorOnSave: true }), true);
  // 显式关 → 不自动向量
  assert.equal(shouldAutoVectorOnSave({ autoVectorOnSave: false }), false);
  // 无参（读全局配置）只冒烟：返回布尔不抛错，值取决于环境配置不做硬断言
  assert.equal(typeof shouldAutoVectorOnSave(), 'boolean');
});

test('悬浮球异常退出自动重启：崩溃拉起、用户主动停不重启、连续失败放弃', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'ball.js'), 'utf8');
  // 自动重启参数
  assert.match(src, /AUTO_RESTART_DELAY_MS = 3000/);
  assert.match(src, /MAX_AUTO_RESTARTS = 3/);
  // 崩溃判定：exitCode 非 0 且不是用户主动停（stopping）
  assert.match(src, /const crashed = exitCode !== 0 && !runtimeState\.stopping/);
  assert.match(src, /scheduleAutoRestart\(runtimeState\)/);
  // 连续失败达到上限后放弃
  assert.match(src, /autoRestartCount >= MAX_AUTO_RESTARTS/);
  // 重启成功 / 用户主动停：清零计数
  assert.match(src, /if \(started\.ok\) autoRestartCount = 0/);
  assert.match(src, /else \{\s*autoRestartCount = 0;/);
  // stopBall 取消待执行的自动重启
  assert.match(src, /clearTimeout\(autoRestartTimer\)/);
});

test('sessionTitleOf 优先 Hana session:list 标题，不再显示最后一条消息', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-title-'));
  const sessionFile = path.join(tmp, 'session.jsonl');
  const privateFile = path.join(tmp, 'private.jsonl');
  const pluginFile = path.join(tmp, 'plugin-private.jsonl');
  const writeTitleFixture = (file, sessionId, message) => fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', sessionId, timestamp: '2026-08-23T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', role: 'user', id: 'u1', timestamp: '2026-08-23T00:00:01.000Z', content: [{ type: 'text', text: message }] }),
  ].join('\n'));
  writeTitleFixture(sessionFile, 's1', '这是最后一条消息');
  writeTitleFixture(privateFile, 's-private', '私密回退消息');
  writeTitleFixture(pluginFile, 's-plugin', '插件私有回退消息');
  // 总线返回真实标题 → 用真实标题；私密/插件私有会话不进入标题映射
  const ctx = { bus: { request: async () => ({ sessions: [
    { path: sessionFile, sessionId: 's1', visibility: 'public', title: '真实对话标题' },
    { path: privateFile, sessionId: 's-private', visibility: 'private', title: '不应透出的私密标题' },
    { path: pluginFile, sessionId: 's-plugin', visibility: 'public', ownerPluginId: 'other-plugin', title: '不应透出的插件标题' },
  ] }) } };
  assert.equal(await sessionTitleOf(ctx, sessionFile), '真实对话标题');
  assert.equal(await sessionTitleOf(ctx, privateFile), '私密回退消息');
  assert.equal(await sessionTitleOf(ctx, pluginFile), '插件私有回退消息');
  // 总线没有该会话标题（不同文件，避开标题缓存）→ 回退最后一条消息
  const sessionFile2 = path.join(tmp, 'session2.jsonl');
  writeTitleFixture(sessionFile2, 's2', '回退消息内容');
  const ctx2 = { bus: { request: async () => ({ sessions: [{ path: sessionFile, visibility: 'public', title: '真实对话标题' }] }) } };
  const fallback = await sessionTitleOf(ctx2, sessionFile2);
  assert.equal(fallback, '回退消息内容');
});

test('配图手帐按 sessionId 显示对话框标题，拿不到标题时使用无标题兜底', () => {
  const titles = new Map([['sess_history', '插件开发讨论']]);
  assert.equal(recentSessionTitle({ sessionId: 'sess_history' }, titles), '插件开发讨论');
  assert.equal(recentSessionTitle({ sessionId: 'missing' }, titles), '（无标题对话）');
});

test('配图手帐只返回公开、非插件会话的记录', () => {
  const matches = [
    { sessionId: 'sess_public', stickerId: 'public-sticker' },
    { sessionId: 'sess_private', stickerId: 'private-sticker' },
  ];
  assert.deepEqual(
    filterRecentMatchesForPublicSessions(matches, new Set(['sess_public'])),
    [matches[0]],
  );
  assert.deepEqual(filterRecentMatchesForPublicSessions(matches, null), []);
});

test('纸飞机正反馈可区分图片喜欢与场景应景，并能替换和撤销', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const sessionPath = writeSession(root, 'hanako', 'feedback.jsonl', [
    { sessionId: 'sess_feedback', type: 'session' },
  ]);
  fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{ id: 'stk_feedback' }]), 'utf8');
  await recordRecentMatch({
    dataDir,
    ctx: { sessionId: 'sess_feedback', sessionPath },
    stickerId: 'stk_feedback',
    description: '测试图',
    emotion: '开心',
    agentId: 'hanako',
    delivery: 'deferred',
    ts: 100,
  });
  const ctx = { dataDir, bus: { request: async () => ({ sessions: [{ sessionId: 'sess_feedback', visibility: 'public', title: '公开对话' }] }) } };

  const context = await submitBallFeedback(ctx, {
    dataDir,
    sessionId: 'sess_feedback',
    stickerId: 'stk_feedback',
    feedback: 'positive',
    feedbackKind: 'context',
    expectedTs: 100,
  });
  assert.equal(context.ok, true);
  assert.equal(context.feedback_kind, 'context');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'context-feedback.json'), 'utf8')).byAgent.hanako['开心'].stk_feedback.count, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'preferences.json')), false, '只记应景不应创建全局喜欢偏好');

  const image = await submitBallFeedback(ctx, {
    dataDir,
    sessionId: 'sess_feedback',
    stickerId: 'stk_feedback',
    feedback: 'positive',
    feedbackKind: 'image',
    expectedTs: 100,
  });
  assert.equal(image.ok, true);
  assert.equal(image.feedback_kind, 'image');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'context-feedback.json'), 'utf8')).byAgent.hanako['开心']?.stk_feedback, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).users.hanako.mappings[0].preferred_ids, ['stk_feedback']);

  const cleared = await submitBallFeedback(ctx, {
    dataDir,
    sessionId: 'sess_feedback',
    stickerId: 'stk_feedback',
    feedback: 'clear',
    expectedTs: 100,
  });
  assert.equal(cleared.ok, true);
  assert.equal(readRecentRecord({ dataDir, sessionId: 'sess_feedback' })[0].feedback, null);
});

test('纸飞机跨会话撤销不会抹掉同一情绪下后来图片的偏好', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const firstPath = writeSession(root, 'hanako', 'first-feedback.jsonl', [{ sessionId: 'sess_first_feedback', type: 'session' }]);
  const secondPath = writeSession(root, 'hanako', 'second-feedback.jsonl', [{ sessionId: 'sess_second_feedback', type: 'session' }]);
  fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{ id: 'stk_first' }, { id: 'stk_second' }]), 'utf8');
  await recordRecentMatch({ dataDir, ctx: { sessionId: 'sess_first_feedback', sessionPath: firstPath }, stickerId: 'stk_first', description: '第一张', emotion: '开心', agentId: 'hanako', delivery: 'deferred', ts: 100 });
  await recordRecentMatch({ dataDir, ctx: { sessionId: 'sess_second_feedback', sessionPath: secondPath }, stickerId: 'stk_second', description: '第二张', emotion: '开心', agentId: 'hanako', delivery: 'deferred', ts: 200 });
  const ctx = { dataDir, bus: { request: async () => ({ sessions: [
    { sessionId: 'sess_first_feedback', visibility: 'public', title: '第一段对话' },
    { sessionId: 'sess_second_feedback', visibility: 'public', title: '第二段对话' },
  ] }) } };

  assert.equal((await submitBallFeedback(ctx, { sessionId: 'sess_first_feedback', stickerId: 'stk_first', feedback: 'positive', feedbackKind: 'image', expectedTs: 100 })).ok, true);
  assert.equal((await submitBallFeedback(ctx, { sessionId: 'sess_second_feedback', stickerId: 'stk_second', feedback: 'positive', feedbackKind: 'image', expectedTs: 200 })).ok, true);
  const clearFirst = await submitBallFeedback(ctx, { sessionId: 'sess_first_feedback', stickerId: 'stk_first', feedback: 'clear', expectedTs: 100 });
  assert.equal(clearFirst.ok, true);
  let prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
  assert.deepEqual(prefs.users.hanako.mappings[0].preferred_ids, ['stk_second']);

  const clearSecond = await submitBallFeedback(ctx, { sessionId: 'sess_second_feedback', stickerId: 'stk_second', feedback: 'clear', expectedTs: 200 });
  assert.equal(clearSecond.ok, true);
  prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
  assert.deepEqual(prefs.users.hanako.mappings, []);
});

test('显式 sessionId 的手帐反馈拒绝私密或插件私有会话', async () => {
  const sessionId = `sess_private_guard_${Date.now()}_${Math.random()}`;
  const result = await submitBallFeedback({
    dataDir: tempDir(),
    bus: { request: async () => ({ sessions: [{ sessionId, visibility: 'private', title: '私密标题' }] }) },
  }, {
    sessionId,
    stickerId: 'stk_private',
    feedback: 'positive',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});
