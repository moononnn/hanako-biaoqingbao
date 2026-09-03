import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  getConditionalScenePercent,
  passesFrequency,
} from '../extensions/observer.js';
import { recoverInterruptedItems } from '../routes/_batch-tasks.js';
import {
  scoreStickers,
  selectPreferenceMappings,
  applyVectorBonus,
  buildStickerCard,
  primaryEmotionOf,
  buildStickerMediaDetails,
  buildStickerDeliveryDetails,
  supportsNativeMediaDetails,
  isMediaOnlyHost,
  trySendDeferredImage,
} from '../tools/express.js';
import { backfillTaggedAtEntries, collectPrefsForEmotion, matchRitualWord, sanitizeTag, AUTOTAG_PROMPT } from '../lib/shared.js';
import { KNOWN_CONFUSABLES, buildConfusableSection } from '../lib/known-confusables.js';

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('deferred 原生图片块：成功时注册为 ui-only image task 并返回 taskId', async () => {
  const calls = [];
  const ctx = {
    sessionId: 'sess_test_1',
    sessionPath: 'C:/sessions/test.jsonl',
    log: { debug() {}, warn() {} },
    bus: {
      async request(type, payload) {
        calls.push({ type, payload });
        return { ok: true };
      },
    },
  };
  const staged = {
    file: { fileId: 'sf_1', filePath: 'C:/stickers/a.jpg', kind: 'image', mime: 'image/jpeg', storageKind: 'plugin_data', status: 'available' },
    mediaItem: { type: 'session_file', fileId: 'sf_1', filePath: 'C:/stickers/a.jpg', kind: 'image' },
  };
  // v0.33.64 - resolve 延迟到占位块挂载后：短延迟 + 等待断言
  const result = await trySendDeferredImage(ctx, staged, { resolveDelayMs: 20 });
  assert.equal(result.ok, true);
  assert.match(result.taskId, /^bqbq-/);
  assert.equal(calls.length, 1, 'register 同步完成，resolve 延迟执行');
  assert.equal(calls[0].type, 'deferred:register');
  assert.equal(calls[0].payload.taskId, result.taskId);
  assert.equal(calls[0].payload.sessionPath, 'C:/sessions/test.jsonl');
  assert.equal(calls[0].payload.meta.type, 'image-generation');
  assert.equal(calls[0].payload.meta.mediaKind, 'image');
  assert.equal(calls[0].payload.meta.toolName, 'biaoqingbao');
  assert.equal(calls[0].payload.meta.deliveryIntent, 'ui_only');
  assert.equal(calls[0].payload.meta.triggerParentTurn, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 2, '延迟后应执行 resolve');
  assert.equal(calls[1].type, 'deferred:resolve');
  assert.equal(calls[1].payload.taskId, result.taskId);
  assert.deepEqual(calls[1].payload.result.sessionFiles, [staged.file]);
});

test('deferred 原生图片块：bus 请求失败时返回 false 供降级', async () => {
  const ctx = {
    sessionPath: 'C:/sessions/test.jsonl',
    log: { debug() {}, warn() {} },
    bus: {
      async request() {
        throw new Error('no handler');
      },
    },
  };
  const staged = { file: { filePath: 'C:/stickers/a.jpg' } };
  assert.equal((await trySendDeferredImage(ctx, staged)).ok, false);
});

test('deferred 原生图片块：register/resolve 返回错误对象时处理', async () => {
  const staged = { file: { filePath: 'C:/stickers/a.jpg' } };
  // register 返回 { ok: false }（旧宿主可能不抛错而返回错误对象）→ 必须降级，且不再延迟 resolve
  let registerCalled = 0;
  let resolveCalled = 0;
  const ctxRegisterFail = {
    sessionPath: 'C:/sessions/test.jsonl',
    log: { debug() {}, warn() {} },
    bus: {
      async request(type) {
        if (type === 'deferred:register') {
          registerCalled += 1;
          return { ok: false, error: 'unknown bus type' };
        }
        resolveCalled += 1;
        return { ok: true };
      },
    },
  };
  assert.equal((await trySendDeferredImage(ctxRegisterFail, staged, { resolveDelayMs: 5 })).ok, false);
  assert.equal(registerCalled, 1, 'register 失败后不应继续 resolve');
  assert.equal(resolveCalled, 0, 'register 失败后不应触发延迟 resolve');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolveCalled, 0, '延迟窗口内也不应出现 resolve');

  // v0.33.64 - resolve 失败改为后台异步：工具已返回成功（任务已注册），resolve 失败只记 warn，不再同步降级
  const warns = [];
  const ctxResolveFail = {
    sessionPath: 'C:/sessions/test.jsonl',
    log: { debug() {}, warn() { warns.push(arguments); } },
    bus: {
      async request(type) {
        if (type === 'deferred:register') return { ok: true };
        if (type === 'deferred:resolve') return { ok: false, error: 'resolve failed' };
        return { ok: true };
      },
    },
  };
  const resolveFailResult = await trySendDeferredImage(ctxResolveFail, staged, { resolveDelayMs: 5 });
  assert.equal(resolveFailResult.ok, true, 'register 成功即视为通道可用，resolve 异步执行');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(warns.length > 0, 'resolve 失败应记 warn 日志');

  // register 返回 undefined（无返回值）→ 也降级
  const ctxNoReturn = {
    sessionPath: 'C:/sessions/test.jsonl',
    log: { debug() {}, warn() {} },
    bus: {
      async request() {
        return undefined;
      },
    },
  };
  assert.equal((await trySendDeferredImage(ctxNoReturn, staged)).ok, false);
});

test('deferred 原生图片块：无 bus / 无 session / 无文件路径时直接降级', async () => {
  assert.equal((await trySendDeferredImage({ sessionPath: 'C:/s.jsonl' }, { file: { filePath: 'C:/a.jpg' } })).ok, false);
  assert.equal((await trySendDeferredImage({ bus: { request: async () => ({ ok: true }) } }, { file: { filePath: 'C:/a.jpg' } })).ok, false);
  assert.equal((await trySendDeferredImage({ bus: { request: async () => ({ ok: true }) }, sessionPath: 'C:/s.jsonl' }, { file: {} })).ok, false);
  assert.equal((await trySendDeferredImage({ bus: { request: async () => ({ ok: true }) }, sessionPath: 'C:/s.jsonl' }, null)).ok, false);
});

test('deferred 降级路径：非 0.679 宿主仍走 iframe 卡片', () => {
  const staged = { fileId: 'sf_x', filePath: 'C:/a.jpg' };
  const cardOptions = { id: 'stk_1', description: 'd', score: 1, emotion: '开心' };
  assert.deepEqual(buildStickerDeliveryDetails(staged, cardOptions, '0.678.9'), {
    card: buildStickerCard(cardOptions),
  });
});

test('两阶段抽样保持目标场景频率', () => {
  assert.equal(getConditionalScenePercent(20, 80), 25);
  assert.equal(getConditionalScenePercent(50, 50), 100);
  assert.equal(getConditionalScenePercent(0, 80), 0);
  assert.equal(getConditionalScenePercent(20, 0), 0);

  assert.equal(passesFrequency(20, 0.1999), true);
  assert.equal(passesFrequency(20, 0.2), false);
  assert.equal(passesFrequency(-1, 0), false);
  assert.equal(passesFrequency(101, 0.9999), true);

  const random = seededRandom(20260730);
  const trials = 100_000;
  let hits = 0;
  const conditional = getConditionalScenePercent(20, 80);
  for (let i = 0; i < trials; i++) {
    if (passesFrequency(80, random()) && passesFrequency(conditional, random())) hits++;
  }
  const actual = hits / trials;
  assert.ok(Math.abs(actual - 0.2) < 0.01, `目标 20%，实际 ${(actual * 100).toFixed(2)}%`);
});

test('表情包配图卡片显式给出高度比例，避免新宿主只显示文字不创建图片 iframe', () => {
  const card = buildStickerCard({
    id: 'stk_352',
    description: '鲸鱼娘少女睁大蓝色眼睛',
    score: 12.5,
    emotion: '开心',
    primaryEmotion: '开心',
    agentId: 'hanako',
    sessionId: 'sess_test',
    sessionPath: 'C:/sessions/test.jsonl',
  });

  assert.equal(card.type, 'iframe');
  assert.equal(card.pluginId, 'biaoqingbao');
  // v0.33.0 - 未传图片尺寸时回退默认宽高比（异常不炸）
  assert.equal(card.aspectRatio, '400:430');
  assert.match(card.route, /id=stk_352/);
  assert.match(card.route, /emotion=%E5%BC%80%E5%BF%83/);
  assert.equal(card.title, '开心小表情来啦');
  assert.equal(card.description, undefined);
});

test('表情包卡片标题优先取图片主情绪标签，缺失时回退当前情绪', () => {
  assert.equal(primaryEmotionOf({ tags: { emotion: ['', '委屈', '开心'] } }), '委屈');
  assert.equal(primaryEmotionOf({ tags: { emotion: ['这是一个过长的情绪标签'] } }), '');

  const card = buildStickerCard({ id: 'stk_title', description: '测试', emotion: '开心', primaryEmotion: '委屈' });
  assert.equal(card.title, '委屈小表情来啦');

  const fallback = buildStickerCard({ id: 'stk_fallback', description: '测试', emotion: '开心' });
  assert.equal(fallback.title, '开心小表情来啦');
});

test('新版 Hana 前端配图走 details.media，并从 stageFile 包装结果取出 session_file', () => {
  const mediaItem = { type: 'session_file', fileId: 'sf_test', mime: 'image/png', label: '测试表情包' };
  const staged = { file: { fileId: 'sf_test', filePath: 'C:/tmp/test.png' }, mediaItem };
  assert.deepEqual(buildStickerMediaDetails(staged), {
    media: { items: [mediaItem] },
  });
  assert.deepEqual(buildStickerMediaDetails(staged, 'bqbq-test'), {
    media: { items: [mediaItem] },
    mediaGeneration: {
      source: 'plugin',
      kind: 'image',
      tasks: [{ taskId: 'bqbq-test' }],
    },
  });
});

test('表情包按 Hana 宿主版本分流：新版 media、旧版和未知版本 card', () => {
  const mediaItem = { type: 'session_file', fileId: 'sf_test', mime: 'image/png', label: '测试表情包' };
  const staged = { file: { fileId: 'sf_test', filePath: 'C:/tmp/test.png' }, mediaItem };
  const cardOptions = {
    id: 'stk_test',
    description: '测试表情包',
    score: 10,
    emotion: '兴奋',
    agentId: 'hanako',
    sessionId: 'session_test',
    sessionPath: 'C:/tmp/session.jsonl',
  };

  assert.equal(supportsNativeMediaDetails('0.679.3'), true);
  assert.equal(supportsNativeMediaDetails('v0.679.3-beta'), true);
  assert.equal(supportsNativeMediaDetails('0.678.9'), false);
  assert.equal(supportsNativeMediaDetails('0.448.3'), false);
  assert.equal(supportsNativeMediaDetails(null), false);

  // v0.33.65 - 0.686+ 宿主对插件 details.media 直接渲染且不生成插件占位块，必须走 media-only。
  assert.equal(isMediaOnlyHost('0.686.15'), true);
  assert.equal(isMediaOnlyHost('v0.686.0-beta'), true);
  assert.equal(isMediaOnlyHost('0.687.0'), true);
  assert.equal(isMediaOnlyHost('1.0.0'), true);
  assert.equal(isMediaOnlyHost('0.685.9'), false);
  assert.equal(isMediaOnlyHost('0.679.3'), false);
  assert.equal(isMediaOnlyHost(null), false);
  assert.equal(isMediaOnlyHost(undefined), false);
  assert.deepEqual(buildStickerDeliveryDetails(staged, cardOptions, '0.679.3'), {
    media: { items: [mediaItem] },
  });
  assert.deepEqual(buildStickerDeliveryDetails(staged, cardOptions, '0.678.9'), {
    card: buildStickerCard(cardOptions),
  });
  assert.deepEqual(buildStickerDeliveryDetails(staged, cardOptions, null), {
    card: buildStickerCard(cardOptions),
  });
});

test('配图卡片按图片实际尺寸动态定宽高比（v0.33.72：智能开一律放大填满 400；v0.33.4 去掉边框后 BTN_RESERVE=50）', () => {
  // 微小图（短边 100）：智能开 → 放大填满 400，高度按比例+按钮预留（BTN_RESERVE=50）
  assert.equal(buildStickerCard({ id: 'a', description: '小图', score: 1, emotion: '开心', size: { width: 100, height: 100 }, smart: true }).aspectRatio, '400:450');
  // 横向小图 100x60
  assert.equal(buildStickerCard({ id: 'a', description: '横向小图', score: 1, emotion: '开心', size: { width: 100, height: 60 }, smart: true }).aspectRatio, '400:290');
  // 中等图 200px：同样放大填满
  assert.equal(buildStickerCard({ id: 'a', description: '200图', score: 1, emotion: '开心', size: { width: 200, height: 200 }, smart: true }).aspectRatio, '400:450');
  // 中图 600px（短边 ≥400 → 填满 400，正方形图高度按 400 算）
  assert.equal(buildStickerCard({ id: 'a', description: '600图', score: 1, emotion: '开心', size: { width: 600, height: 600 }, smart: true }).aspectRatio, '400:450');
  // 大图 2000px（≥400 → 填满 400）
  assert.equal(buildStickerCard({ id: 'a', description: '大图', score: 1, emotion: '开心', size: { width: 2000, height: 2000 }, smart: true }).aspectRatio, '400:450');
  // 关闭智能：回退旧行为（短边≥200 按 400 放大填满）
  assert.equal(buildStickerCard({ id: 'a', description: '关智能', score: 1, emotion: '开心', size: { width: 400, height: 200 }, smart: false }).aspectRatio, '400:250');
  // 关闭智能：极小图（短边<200）保持原尺寸比例（防糊）
  assert.equal(buildStickerCard({ id: 'a', description: '关智能小图', score: 1, emotion: '开心', size: { width: 100, height: 100 }, smart: false }).aspectRatio, '400:150');
  // 尺寸缺失/非法回退默认
  assert.equal(buildStickerCard({ id: 'a', description: '缺尺寸', score: 1, emotion: '开心' }).aspectRatio, '400:430');
  assert.equal(buildStickerCard({ id: 'a', description: '非法尺寸', score: 1, emotion: '开心', size: { width: -1, height: 0 } }).aspectRatio, '400:430');
});

test('sticker iframe 页面遵守 Hana 握手与新版尺寸协议', () => {
  const source = fs.readFileSync(new URL('../routes/ui.js', import.meta.url), 'utf8');
  assert.ok(source.includes("type: 'hana.ready'"), '卡片页面必须发送 hana.ready');
  assert.ok(source.includes("type: 'ui.resize'"), '卡片页面必须发送 ui.resize（宿主可识别的尺寸事件名）');
  assert.ok(!source.includes("type: 'hana.ui.resize'"), '旧错误事件名 hana.ui.resize 必须移除，宿主不识别');
  // v0.33.4 - 0.712.5 宿主聊天流内嵌卡裸分支只认 resize-request，必须补发（老宿主忽略未知 type）
  assert.ok(source.includes("type: 'resize-request'"), '必须补发 resize-request 裸消息（0.712.5 宿主唯一认的裸尺寸事件）');
});

test('卡片内聊天的修改按钮在固定 iframe 高度下仍可达（回归：建议区落在卡片裁切线下方）', () => {
  const source = fs.readFileSync(new URL('../routes/ui.js', import.meta.url), 'utf8');
  // v0.34.2 - 面板改为固定高度（420px，JS 按视口兜底），不再依赖 calc(100vh) 跟随 iframe 收缩
  assert.match(source, /\.chat-panel\s*\{\s*width: 100%; height: 420px; min-height: 0; overflow: hidden;/, '聊天面板必须固定高度（不再跟随 iframe 收缩）');
  assert.ok(source.includes('height: auto; min-height: 64px; flex: 1 1 190px; overflow-y: auto;'), '消息区必须让出空间并独立滚动');
  // v0.34.8 - 建议卡改成嵌进聊天流（随消息滚动），不再占面板中间固定区块：
  //   建议区不再是独立 flex 区块，消息区也不再因 has-sug 被压缩
  assert.ok(source.includes('width: 100%; flex-shrink: 0; box-sizing: border-box;'), '建议卡必须作为消息流内的卡片（满宽、不参与压缩）');
  assert.ok(!source.includes('.chat-panel.has-sug .chat-msgs { flex-basis: 110px; }'), '消息区不再因建议卡让空间（建议卡嵌进聊天流）');
  assert.ok(!source.includes('max-height: 55%;'), '建议卡不再限高 55%（改为随聊天流滚动）');
  assert.ok(!source.includes('chatPanel.classList.add(\'has-sug\')'), '不再用 has-sug 类压缩消息区');
  assert.ok(source.includes('.chat-sug-diff {'), 'diff 区样式必须存在');
  assert.ok(source.includes('.chat-sug-actions { display: flex; gap: 8px; margin-top: 8px; flex-shrink: 0; }'), '确认修改操作栏必须始终保留');
  // v0.34.8 - 建议卡 move 进消息区末尾并滚动到底，确保完整 diff 与按钮可达
  assert.ok(source.includes('box.appendChild(sugEl);'), '建议卡必须 append 进消息区末尾');
  assert.ok(source.includes('box.scrollTop = box.scrollHeight;'), '建议卡出现后必须滚动到消息区底部让按钮可达');
  assert.ok(!source.includes('postResize({ height: clampH(Math.round(h)), width: clampW(window.innerWidth) });'), '聊天尺寸上报不得调用另一个 IIFE 里的不可见函数');
  // v0.34.2 - 输入框不得每次 input 都重设高度 + 上报（自引用收缩循环的根源）
  assert.ok(!source.includes("this.style.height = Math.min(this.scrollHeight, 80) + 'px';"), '输入框不得在每次 input 里按 scrollHeight 重设高度');
  assert.ok(source.includes('chatPanel.style.height = chatFixedHeight() + \'px\''), '打开聊天时必须按当前视口设置面板高度');
});

test('确认修改支持回包丢失自检、不依赖 iframe AbortSignal，且卡片页面不缓存旧脚本', () => {
  const ui = fs.readFileSync(new URL('../routes/ui.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../assets/sticker-manager.js', import.meta.url), 'utf8');
  const uiStart = ui.indexOf('async function confirmSuggestion()');
  const uiEnd = ui.indexOf('function openChat()', uiStart);
  assert.ok(uiStart >= 0 && uiEnd > uiStart, '主卡片确认函数必须存在');
  const uiConfirm = ui.slice(uiStart, uiEnd);
  assert.doesNotMatch(uiConfirm, /new AbortController|AbortSignal\.timeout|confirmInit\.signal/, '主卡片确认请求不能绑定不稳定的 signal');
  const catchStart = uiConfirm.lastIndexOf('} catch (e) {');
  const catchEnd = uiConfirm.indexOf('chatBusy = false;', catchStart);
  assert.ok(catchStart >= 0 && catchEnd > catchStart, '主卡片确认失败分支必须存在');
  const failureCatch = uiConfirm.slice(catchStart, catchEnd);
  assert.doesNotMatch(failureCatch, /closeChat\(\)/, '网络/超时失败不能关闭聊天面板');
  assert.match(uiConfirm, /function resetConfirmButton\(\)/, '失败后必须有统一的确认按钮恢复逻辑');
  assert.match(uiConfirm, /finally \{[\s\S]*?if \(!finished\) resetConfirmButton\(\);/, '确认请求结束后必须无论异常与否恢复按钮状态');
  assert.match(uiConfirm, /recoverConfirmedChange\(requestStickerId, requestSuggestion\)/, '确认异常时必须回查标签是否已落盘');
  assert.match(uiConfirm, /确认回包没接到，修改建议先留着/, '会话回包异常也要保留修改建议');
  const conflictStart = uiConfirm.indexOf('if (res.status === 409)');
  const conflictEnd = uiConfirm.indexOf('} else {', conflictStart);
  assert.ok(conflictStart >= 0 && conflictEnd > conflictStart, '409 失败分支必须存在');
  assert.doesNotMatch(uiConfirm.slice(conflictStart, conflictEnd), /closeChat\(\)/, '会话回包异常不能关闭聊天面板');

  const clientStart = client.indexOf('async function confirmChatChange()');
  const clientEnd = client.indexOf('function closeChatModal()', clientStart);
  assert.ok(clientStart >= 0 && clientEnd > clientStart, '图库确认函数必须存在');
  const clientConfirm = client.slice(clientStart, clientEnd);
  assert.match(clientConfirm, /noAbort:\s*true/, '图库确认请求必须显式跳过 AbortController');
  assert.match(clientConfirm, /recoverChatChange\(requestStickerId, requestSuggestion\)/, '图库确认异常时必须回查标签是否已落盘');
  assert.match(clientConfirm, /刷新展柜失败不能倒灌成“确认失败”/, '确认成功后的刷新失败不能被误报成确认失败');
  assert.match(client, /if \(!noAbort && !init\.signal\)/, 'apiFetch 必须支持按请求跳过 signal');

  assert.match(ui, /X-Hana-Plugin-Surface-Session/, '主卡片请求必须支持新版 surface session 请求头');
  assert.match(ui, /function authUrl\(url\)/, '带查询参数的回查 URL 必须有统一鉴权拼接函数');
  assert.match(ui, /url\.indexOf\('\?'\) >= 0 \? '&' : ''/, '回查 URL 不能把鉴权参数拼成第二个问号');
  assert.match(ui, /timedPromise\(res\.json\(\), 5000\)/, '确认响应体解析也必须有超时保护');
  assert.match(ui, /c\.header\('Cache-Control', 'no-store, no-cache, must-revalidate'\)/, '卡片页面必须禁止缓存旧版内联脚本');
});

test('新宿主（0.686+ 纯 card iframe）也必须按图片尺寸算 aspectRatio（回归：size 被旧分支条件挡住 → 恒回退 400:430 大白卡）', () => {
  const source = fs.readFileSync(new URL('../tools/express.js', import.meta.url), 'utf8');
  // size 必须无条件读取，不能再次被 `if (!deferredOk && !useNativeMedia)` 包住
  const sizeAssign = 'let size = imageSizeFromBuffer(buffer);';
  assert.ok(source.includes(sizeAssign), 'express 主流程必须无条件读取图片尺寸');
  // 条件块内不能再有 size = imageSizeFromBuffer（即 size 读取必须在外层）
  const condBlock = source.split('let size = imageSizeFromBuffer(buffer);')[1] || '';
  assert.ok(!condBlock.startsWith('\n    if (!deferredOk'), 'size 读取不得重新退回旧分支条件内');
  // 新宿主分支的 details 构造必须透传 size/smart（cardOptions 带 size 字段）
  assert.ok(condBlock.includes('size,'), 'cardOptions 必须携带 size 传给 buildStickerCard');
});

test('sticker iframe 兼容 devkit 1.0 裸消息（回归：0.686+ 宿主只保证裸 { type: ready } 兼容，ui.resize 双发幂等）', () => {
  const source = fs.readFileSync(new URL('../routes/ui.js', import.meta.url), 'utf8');
  assert.ok(source.includes("window.parent.postMessage({ type: 'ready' }, '*')"), '必须补发裸 ready 握手消息');
  assert.ok(source.includes("window.parent.postMessage({ type: 'ui.resize', payload: payload }, '*')"), '必须补发裸 ui.resize 消息');
});

test('标签打分遵守偏好、否决和排除名单', () => {
  const stickers = [
    {
      id: 'a',
      description: '开心猫咪挥手',
      tags: { emotion: ['开心'], scene: ['问候'], keywords: ['猫咪'] },
    },
    {
      id: 'b',
      description: '笑着打招呼',
      tags: { emotion: ['开心'], scene: ['早安'], keywords: ['挥手'] },
    },
    {
      id: 'c',
      description: '伤心落泪',
      tags: { emotion: ['难过'], scene: ['安慰'], keywords: ['眼泪'] },
    },
  ];

  const preferred = scoreStickers(stickers, '开心', [], {
    preferred: ['b'],
    vetoed: ['a'],
    dislikes: {},
  });
  assert.deepEqual(preferred.map(item => item.id), ['b']);
  assert.equal(preferred[0]._score, 18);

  const excluded = scoreStickers(stickers, '开心', ['b'], {
    preferred: [],
    vetoed: [],
    dislikes: {},
  });
  assert.deepEqual(excluded.map(item => item.id), ['a']);
});

test('极老根级偏好在新助手桶出现后仍参与选图，不静默失效', () => {
  const legacy = {
    context: { emotion: '开心', keywords: [] },
    preferred_ids: ['legacy'],
    vetoed_ids: [],
    dislike_counts: {},
  };
  const current = {
    context: { emotion: '开心', keywords: [] },
    preferred_ids: ['current'],
    vetoed_ids: [],
    dislike_counts: {},
  };
  const mappings = selectPreferenceMappings({ mappings: [legacy], users: { hanako: { mappings: [current] } } }, 'hanako');
  assert.deepEqual(mappings.map((mapping) => mapping.preferred_ids[0]), ['current', 'legacy']);
});

test('已有标签但缺少 tagged_at 的图片按 added_at 回填，空标签不误标记', () => {
  const entries = [
    { id: 'tagged', added_at: '2026-08-24T00:00:00.000Z', tags: { emotion: ['开心'], scene: [], keywords: [] } },
    { id: 'semantic', added_at: '2026-08-24T01:00:00.000Z', semantic_description: '一只开心的小狗', tags: {} },
    { id: 'empty', added_at: '2026-08-24T02:00:00.000Z', tags: { emotion: [], scene: [], keywords: [] } },
    { id: 'existing', tagged_at: '2026-08-23T00:00:00.000Z', tags: { emotion: ['开心'] } },
  ];
  const result = backfillTaggedAtEntries(entries, '2026-08-24T03:00:00.000Z');
  assert.equal(result.updated, 2);
  assert.equal(result.entries[0].tagged_at, result.entries[0].added_at);
  assert.equal(result.entries[1].tagged_at, result.entries[1].added_at);
  assert.equal(result.entries[2].tagged_at, undefined);
  assert.equal(result.entries[3].tagged_at, '2026-08-23T00:00:00.000Z');
});

test('场景正反馈只给当前情绪轻量加分，不等同于全局喜欢', () => {
  const stickers = [
    { id: 'fit', description: '一只猫', tags: { emotion: ['开心'] } },
    { id: 'plain', description: '一只狗', tags: { emotion: ['开心'] } },
  ];
  const ranked = scoreStickers(stickers, '开心', [], {
    preferred: [],
    vetoed: [],
    dislikes: {},
    contextFits: { fit: 2 },
  });
  assert.equal(ranked[0].id, 'fit');
  assert.equal(ranked[0]._score, 10);
  assert.equal(ranked[1]._score, 8);
});

test('重启恢复会回收中断图片，并去重、避开已完成和已失败图片', () => {
  const task = {
    status: 'running',
    pending: ['p2', 'dup', 'done'],
    current: 'legacy',
    current_ids: ['p1', 'dup', 'done', 'failed'],
    completed: ['done'],
    failed: [{ id: 'failed', error: '模型超时' }],
  };

  const recovered = recoverInterruptedItems(task);

  assert.deepEqual(recovered, ['p1', 'dup', 'legacy']);
  assert.deepEqual(task.pending, ['p1', 'dup', 'legacy', 'p2']);
  assert.deepEqual(task.current_ids, []);
  assert.equal(task.current, null);
});

test('已取消任务不会被重启恢复逻辑改动', () => {
  const task = {
    status: 'cancelled',
    pending: ['p2'],
    current: null,
    current_ids: ['p1'],
    completed: [],
    failed: [],
  };
  const before = structuredClone(task);

  assert.deepEqual(recoverInterruptedItems(task), []);
  assert.deepEqual(task, before);
});

test('向量通道参与选图：无标签匹配时，语义相近的图仍能被选中（回归：少 await 导致向量通道静默失效）', () => {
  const stickers = [
    { id: 'v1', description: '一只猫在打盹', tags: { emotion: ['困'], keywords: ['猫'] } },
    { id: 'v2', description: '开心大笑', tags: { emotion: ['开心'], keywords: ['笑'] } },
  ];

  // 情绪词「疲惫」的向量与 v1 相似度高，与 v2 低
  const tiredVec = [1, 0.9, 0.2];
  const vectors = {
    v1: [0.95, 0.85, 0.1],
    v2: [0.1, 0.1, 0.9],
  };

  // 标签通道没匹配到任何图（scored 为空），只有向量通道能捞出来
  const scored = [];
  const result = applyVectorBonus(scored, stickers, tiredVec, vectors, []);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'v1');
  assert.ok(result[0]._score > 0);
});

test('向量通道给已有标签打分叠加 bonus，相似度高的排前面', () => {
  const stickers = [
    { id: 'a', description: '开心', tags: { emotion: ['开心'] } },
    { id: 'b', description: '开心', tags: { emotion: ['开心'] } },
  ];
  const happyVec = [1, 0];
  const vectors = { a: [0.9, 0.1], b: [0.5, 0.5] };

  const scored = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [] });
  const result = applyVectorBonus(scored, stickers, happyVec, vectors, []);

  assert.equal(result[0].id, 'a');
});

test('execute 调用契约：向量通道原地修改 scored 并返回同一引用，候选必须非空（回归：v0.19.5 回填同一引用导致永远 no_match）', () => {
  const stickers = [
    { id: 'v1', description: '一只猫在打盹', tags: { emotion: ['困'], keywords: ['猫'] } },
    { id: 'v2', description: '开心大笑', tags: { emotion: ['开心'], keywords: ['笑'] } },
  ];
  const tiredVec = [1, 0.9, 0.2];
  const vectors = { v1: [0.95, 0.85, 0.1], v2: [0.1, 0.1, 0.9] };

  // 模拟 execute 的调用方式：先标签通道，再向量通道（原地修改）
  const scored = scoreStickers(stickers, '疲惫', [], { preferred: [], vetoed: [] });
  const vectorScored = applyVectorBonus(scored, stickers, tiredVec, vectors, []);

  // 契约：applyVectorBonus 原地修改并返回同一个数组引用。
  // ⚠️ 禁止在 execute 里做「scored.length = 0; scored.push(...vectorScored)」回填：
  //    因 vectorScored === scored，会把结果一起清空导致永远 no_match（v0.19.5 踩过）。
  assert.equal(vectorScored, scored);
  assert.ok(scored.length > 0, '向量通道后应有候选');
});

test('累计不喜欢降权：次数越多分越低，多轮后基本出局（v0.25.0）', () => {
  const stickers = [
    { id: 'a', description: '开心大笑', tags: { emotion: ['开心'], scene: ['问候'] } },
  ];

  // 1 次不喜欢：-5，标签分 11 - 5 = 6，轻降频但还能出现（有机会再点）
  const once = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 1 } });
  assert.equal(once.length, 1);
  assert.equal(once[0]._score, 6);

  // 2 次不喜欢：-10，标签分 11 - 10 = 1，明显降频但仍在场（排最后，还能挽救）
  const twice = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 2 } });
  assert.equal(twice.length, 1);
  assert.equal(twice[0]._score, 1);

  // 3 次不喜欢：-15，跌破 0 基本不出现
  const thrice = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 3 } });
  assert.equal(thrice.length, 0);

  // 5 次及以上惩罚封顶 -25，彻底出局
  const many = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 9 } });
  assert.equal(many.length, 0);
});

test('不喜欢累计与硬拉黑叠加：veto 的图再被点不喜欢，分更低（v0.25.0）', () => {
  const stickers = [
    { id: 'a', description: '开心大笑', tags: { emotion: ['开心'], scene: ['问候'] } },
  ];
  const result = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: ['a'], dislikes: { a: 2 } });
  assert.equal(result.length, 0);
});

test('向量补充通道同样吃偏好惩罚：veto/不喜欢的图不能绕道向量复出（v0.25.0 漏洞修复）', () => {
  const stickers = [
    { id: 'v1', description: '一只猫在打盹', tags: { emotion: ['困'], keywords: ['猫'] } },
    { id: 'v2', description: '开心大笑', tags: { emotion: ['开心'], keywords: ['笑'] } },
  ];
  const tiredVec = [1, 0.9, 0.2];
  const vectors = {
    v1: [0.95, 0.85, 0.1],   // 与「疲惫」语义高度相似
    v2: [0.1, 0.1, 0.9],
  };

  // v1 被硬拉黑：即使语义相似度极高（sim>0.35 会被补充），也要被 -20 拉回来
  const scored = [];
  const withVeto = applyVectorBonus(scored, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: ['v1'], dislikes: {},
  });
  assert.equal(withVeto.length, 1);
  assert.equal(withVeto[0].id, 'v1');
  assert.ok(withVeto[0]._score < 0, 'veto 惩罚应盖过向量加分，分数为负');

  // v1 被不喜欢 2 次：同样不能靠向量通道翻身
  const scored2 = [];
  const withDislike = applyVectorBonus(scored2, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: [], dislikes: { v1: 2 },
  });
  assert.equal(withDislike.length, 1);
  assert.equal(withDislike[0].id, 'v1');
  assert.ok(withDislike[0]._score < 0, '2 次不喜欢的惩罚应盖过向量加分');

  // 对照：没有偏好的图，向量通道正常加分
  const scored3 = [];
  const clean = applyVectorBonus(scored3, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: [], dislikes: {},
  });
  assert.equal(clean.length, 1);
  assert.ok(clean[0]._score > 0, '无偏好时向量命中应为正分');
});

test('偏好按助手隔离：不合并其他助手的喜欢/反感记录（回归：遍历全部 users 导致串号）', () => {
  const agentA = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'], dislike_counts: { a3: 2 } },
    { context: { emotion: '难过' }, preferred_ids: ['a3'] },
  ];
  const agentB = [
    { context: { emotion: '开心' }, preferred_ids: ['b1'], vetoed_ids: ['b2'] },
  ];

  const forA = collectPrefsForEmotion(agentA, '开心');
  assert.deepEqual(forA, { preferred: ['a1'], vetoed: ['a2'], dislikes: { a3: 2 } });

  const forB = collectPrefsForEmotion(agentB, '开心');
  assert.deepEqual(forB, { preferred: ['b1'], vetoed: ['b2'], dislikes: {} });

  // A 情绪是「难过」时拿不到「开心」的偏好
  const sadA = collectPrefsForEmotion(agentA, '难过');
  assert.deepEqual(sadA, { preferred: ['a3'], vetoed: [], dislikes: {} });

  // 该助手没有记录时为空
  assert.deepEqual(collectPrefsForEmotion(undefined, '开心'), { preferred: [], vetoed: [], dislikes: {} });
});

test('问候词英文用词边界：this/while/something 不误判 hi（回归：字符串包含误判）', () => {
  assert.equal(matchRitualWord('this is a test', 'hi'), false);
  assert.equal(matchRitualWord('while loop', 'hi'), false);
  assert.equal(matchRitualWord('something', 'hi'), false);
  assert.equal(matchRitualWord('hi 早上好', 'hi'), true);
  assert.equal(matchRitualWord('say hi to her', 'hi'), true);
  // 中文词保持包含判断
  assert.equal(matchRitualWord('早上好呀', '早上好'), true);
  assert.equal(matchRitualWord('晚上早点睡', '早上好'), false);
});

test('标签清洗：识图/情绪词去除换行、引号、控制字符并限长', () => {
  assert.equal(sanitizeTag('开心\n'), '开心');
  assert.equal(sanitizeTag('"得意"'), '得意');
  assert.equal(sanitizeTag('委屈\r\n想哭'), '委屈想哭');
  assert.equal(sanitizeTag('x'.repeat(50), 30).length, 30);
  assert.equal(sanitizeTag(undefined), '');
  assert.equal(sanitizeTag(''), '');
  // v0.19.5 - 反引号 / $ / 方括号是模板字符串注入面，必须清掉
  assert.equal(sanitizeTag('`开心`'), '开心');
  assert.equal(sanitizeTag('${开心}'), '开心');
  assert.equal(sanitizeTag('[开心]'), '开心');
});

test('识图 prompt：含知名角色/梗图规则与防幻觉约束（v0.26.0）', () => {
  // 知名角色/梗图必须报名字（虹夏、月薪喵、猫meme、熊猫头）
  assert.ok(AUTOTAG_PROMPT.includes('虹夏'), 'prompt 应示范知名角色名');
  assert.ok(AUTOTAG_PROMPT.includes('月薪喵'), 'prompt 应示范新梗名');
  assert.ok(AUTOTAG_PROMPT.includes('猫meme'), 'prompt 应示范系列梗图名');
  assert.ok(AUTOTAG_PROMPT.includes('熊猫头'), 'prompt 应示范表情包系列名');
  assert.ok(AUTOTAG_PROMPT.includes('角色名、梗名或系列名'), 'keywords 应要求报名字/系列名');
  assert.ok(AUTOTAG_PROMPT.includes('外观描述词同样保留'), '外观描述词应与角色名共存');
  // 防幻觉：报名前核对至少两个独有特征，对不上不写名字
  assert.ok(AUTOTAG_PROMPT.includes('核对至少两个独有特征'), '应有特征核对要求');
  assert.ok(AUTOTAG_PROMPT.includes('只写外观描述，不要猜测'), '应有防幻觉约束');
  // 既有规则不被破坏：scene 限 4 字、emotion 是情绪词
  assert.ok(AUTOTAG_PROMPT.includes('每个不超过4个字'), 'scene 限长规则应保留');
  assert.ok(AUTOTAG_PROMPT.includes('情绪词'), 'emotion 情绪词规则应保留');
  // 易混淆对照表已拼接进 prompt
  assert.ok(AUTOTAG_PROMPT.includes('千早爱音'), 'prompt 应含对照表内容（爱音）');
  assert.ok(AUTOTAG_PROMPT.includes('后藤一里'), 'prompt 应含对照表内容（波奇）');
});

test('易混淆对照表：爱音/波奇辨别要点齐全，生成段落含对照引导（v0.26.0）', () => {
  assert.ok(KNOWN_CONFUSABLES.length >= 1, '对照表不应为空');
  const group = KNOWN_CONFUSABLES.find(g => g.topic === '粉发少女');
  assert.ok(group, '应有粉发少女分组');
  const anon = group.entries.find(e => e.name === '千早爱音');
  const bocchi = group.entries.find(e => e.name === '后藤一里');
  assert.ok(anon && anon.traits.length >= 10, '爱音应有可核对的辨别要点');
  assert.ok(bocchi && bocchi.traits.length >= 10, '波奇应有可核对的辨别要点');
  assert.ok(anon.traits.includes('无呆毛'), '爱音应明确写无呆毛');
  assert.ok(bocchi.traits.includes('呆毛'), '波奇要点应含呆毛（独有特征）');
  const section = buildConfusableSection();
  assert.ok(section.includes('高相似度角色容易认错'), '应含对照引导语');
  assert.ok(section.includes('千早爱音'), '生成段落应含名字');
});

test('偏好收集：空情绪不收集任何偏好', () => {
  const mappings = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'], dislike_counts: { a3: 1 } },
  ];
  assert.deepEqual(collectPrefsForEmotion(mappings, ''), { preferred: [], vetoed: [], dislikes: {} });
  assert.deepEqual(collectPrefsForEmotion(mappings, undefined), { preferred: [], vetoed: [], dislikes: {} });
});
