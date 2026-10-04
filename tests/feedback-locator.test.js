// 配图反馈定位：宿主整目录迁移后旧入口以 junction 保留，同一个会话文件会出现两种路径字面量。
// 2026-10-02 现场：卡片点「喜欢 / 应景」一律回 409「这段对话当前不可用于配图反馈」，
// 根因候选是 session:get 返回真实根路径、与插件手里的旧入口路径做了字面比较。
// 本组用例把两种写法的同一文件判为同一段对话，同时守住「真的是两段对话」这条防线。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HANA_HOME 在 lib/shared.js 载入时求值，本文件所有会话都写在同一个根下。
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-locator-home-')));
process.env.HANA_HOME = HOME;

const { submitBallFeedback, samePath } = await import('../lib/ball.js');
const { isDesktopSessionPath } = await import('../lib/ball-session.js');
const { recordRecentMatch } = await import('../lib/recent-match.js');

function tempDir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-locator-' + tag + '-')));
}

function writeSession(fileName, sessionId) {
  const dir = path.join(HOME, 'agents', 'hanako', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session', version: 3, sessionId }) + '\n'
      + JSON.stringify({ type: 'message', timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    'utf8',
  );
  return file;
}

function makeJunction(target) {
  // junction 不需要管理员权限；非 Windows 或不支持时返回 null，调用方自行降级。
  if (process.platform !== 'win32') return null;
  const link = path.join(tempDir('link'), 'home-link');
  try {
    fs.symlinkSync(target, link, 'junction');
    return link;
  } catch {
    return null;
  }
}

async function seedMatch(dataDir, sessionId, sessionPath, stickerId, ts) {
  fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{ id: stickerId }]), 'utf8');
  await recordRecentMatch({
    dataDir,
    ctx: { sessionId, sessionPath },
    stickerId,
    description: '定位测试图',
    emotion: '开心',
    agentId: 'hanako',
    delivery: 'card',
    ts,
  });
}

test('samePath：同一个文件的两种路径写法（junction 旧入口 vs 真实根）判为同一处', () => {
  const real = writeSession('same-path.jsonl', 'sess_same_path');
  const link = makeJunction(HOME);
  if (!link) {
    assert.equal(samePath(real, real), true);
    return;
  }
  const viaLink = path.join(link, 'agents', 'hanako', 'sessions', 'same-path.jsonl');
  assert.notEqual(path.normalize(viaLink), path.normalize(real), '前置条件：两种写法确实不同');
  assert.equal(samePath(viaLink, real), true);
  // 真正指向另一个文件时必须判否，否则会写进别的会话。
  const other = writeSession('same-path-other.jsonl', 'sess_other');
  assert.equal(samePath(viaLink, other), false);
  assert.equal(samePath('', real), false);
});

test('宿主用真实根回路径时，按旧入口路径提交的反馈仍能记上（修前 409）', async () => {
  const real = writeSession('moved.jsonl', 'sess_moved');
  const link = makeJunction(HOME);
  const askedPath = link ? path.join(link, 'agents', 'hanako', 'sessions', 'moved.jsonl') : real;
  const dataDir = tempDir('data');
  await seedMatch(dataDir, 'sess_moved', real, 'stk_moved', 900);

  const warns = [];
  const ctx = {
    dataDir,
    log: { warn: (...args) => warns.push(args.join(' ')) },
    bus: {
      request: async (name) => name === 'session:list'
        ? { sessions: [{ path: real, visibility: 'public', title: '搬过家的对话' }] }
        // 宿主把 junction 解析成真实根再回给调用方。
        : { session: { path: real, sessionId: 'sess_moved', visibility: 'public', agentId: 'hanako' } },
    },
  };

  const result = await submitBallFeedback(ctx, {
    sessionId: 'sess_moved',
    sessionPath: askedPath,
    stickerId: 'stk_moved',
    feedback: 'positive',
    feedbackKind: 'image',
    expectedTs: 900,
  });
  assert.equal(result.ok, true, '同一文件的两种写法不该被判成不可反馈 ' + JSON.stringify(result) + ' warns=' + JSON.stringify(warns));
  assert.equal(result.feedback_kind, 'image');
  assert.deepEqual(warns, [], '成功路径不该留下拒绝日志');
});

test('没挪过家的人：路径字面一致时直接放行，不碰文件系统，多余校验不会拖慢或误拒', () => {
  // 前提：下面这些路径字面合法，但文件并不存在。
  // 如果实现里去读了一次真实路径，realpath 就会抛错并被当成「不通过」——
  // 这里返回 true 才能证明字面一致时压根没做多余校验。
  const fake = path.join(HOME, 'agents', 'hanako', 'sessions', 'never-created.jsonl');
  assert.equal(fs.existsSync(fake), false, '前置条件：文件不存在');
  assert.equal(samePath(fake, fake), true, '字面一致就该直接判同');
  assert.equal(samePath(fake, path.join(HOME, 'agents', 'hanako', 'sessions', 'never-created.jsonl')), true);
  assert.equal(isDesktopSessionPath(fake, { hanaHome: HOME }), true, '字面合法就放行，不该去碰文件');
});

test('没挪过家的人：路径落在 agents 之外时仍然拒绝，解析真实路径也不能翻口子', () => {
  const outside = path.join(tempDir('outside'), 'notes.jsonl');
  fs.writeFileSync(outside, '{}\n', 'utf8');
  assert.equal(isDesktopSessionPath(outside, { hanaHome: HOME }), false, 'agents 外的文件进不来');

  const outsideShaped = path.join(tempDir('shaped'), 'docs', 'sessions', 'x.jsonl');
  fs.mkdirSync(path.dirname(outsideShaped), { recursive: true });
  fs.writeFileSync(outsideShaped, '{}\n', 'utf8');
  assert.equal(isDesktopSessionPath(outsideShaped, { hanaHome: HOME }), false, '长得像但不在 agents 下也进不来');

  const notJsonl = path.join(HOME, 'agents', 'hanako', 'sessions', 'real.txt');
  fs.writeFileSync(notJsonl, 'x', 'utf8');
  assert.equal(isDesktopSessionPath(notJsonl, { hanaHome: HOME }), false, '非 jsonl 一律拒绝');
});

test('路径确实指向另一段对话时仍然拦下，不因放宽比较而写错会话', async () => {
  const asked = writeSession('asked.jsonl', 'sess_asked');
  const hostPath = writeSession('asked-other.jsonl', 'sess_other');
  const dataDir = tempDir('data');
  await seedMatch(dataDir, 'sess_asked', asked, 'stk_asked', 901);

  const result = await submitBallFeedback({
    dataDir,
    bus: { request: async (name) => name === 'session:list'
      ? { sessions: [{ path: asked, visibility: 'public', title: '问的这段' }] }
      : { session: { path: hostPath, visibility: 'public', agentId: 'hanako' } } },
  }, {
    sessionId: 'sess_asked',
    sessionPath: asked,
    stickerId: 'stk_asked',
    feedback: 'positive',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test('session:get 抛错时记下原因，不再静默吞掉现场', async () => {
  const sessionPath = writeSession('boom.jsonl', 'sess_boom');
  const dataDir = tempDir('data');
  await seedMatch(dataDir, 'sess_boom', sessionPath, 'stk_boom', 902);

  const warns = [];
  const result = await submitBallFeedback({
    dataDir,
    log: { warn: (...args) => warns.push(args.join(' ')) },
    bus: {
      request: async (name) => name === 'session:list'
        ? { sessions: [{ path: sessionPath, visibility: 'public', title: '会炸的对话' }] }
        : (() => { throw new Error('supplied path does not match the sessionId current locator'); })(),
    },
  }, {
    sessionId: 'sess_boom',
    sessionPath,
    stickerId: 'stk_boom',
    feedback: 'positive',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(warns.length, 1, '拒绝必须留一条原因');
  assert.match(warns[0], /反馈定位失败: session-get-threw/);
  assert.match(warns[0], /current locator/);
  assert.match(warns[0], /sess_boom/);
});
