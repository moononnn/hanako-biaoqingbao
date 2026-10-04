import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 只执行现有注入函数，不导入会读取宿主状态的模块；修前也能直接复现。
const source = fs.readFileSync(new URL('../extensions/observer.js', import.meta.url), 'utf8');
const start = source.indexOf('function injectPrompt(');
const end = source.indexOf('// ── Pi SDK Extension 入口', start);
assert.ok(start >= 0 && end > start, '必须找到真实注入函数，禁止零测试假绿灯');
const injectPrompt = vm.runInNewContext(`${source.slice(start, end)}\ninjectPrompt;`);

// Pi 的 AgentMessage 转换契约：custom 转 user，未知 role（包括 system）丢弃。
// 最终另用当前宿主的真实 convertToLlm 复验，不把此模拟当实机证据。
function providerMessages(messages) {
  return messages.flatMap((message) => {
    if (message.role === 'custom') return [{ role: 'user', content: message.content }];
    return ['user', 'assistant', 'toolResult'].includes(message.role) ? [message] : [];
  });
}
function contentText(message) {
  return typeof message.content === 'string' ? message.content :
    message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}
function reminder(event) {
  return event.messages.find((message) => message.role === 'custom');
}

test('完整配图提醒通过 AgentMessage 转换，不能依赖会被过滤的 system role', () => {
  const event = { messages: [{ role: 'user', content: '哈喽小花' }] };
  assert.equal(injectPrompt(event, '开心'), true);
  const note = reminder(event);
  assert.ok(note, '提醒应使用 SDK 支持的 custom 消息');
  assert.equal(note.customType, 'biaoqingbao-expression-hint');
  assert.equal(note.display, false, '插件提醒不在聊天中另起一条可见消息');
  assert.equal(event.messages.some((message) => message.role === 'system'), false);
  assert.match(providerMessages(event.messages).map(contentText).join('\n'), /表情包插件感知到/);
});

test('问候和用户尾部提示都给出搜索与正式调用入口，不只留下裸 express 名字', () => {
  const event = { messages: [{ role: 'user', content: '哈喽小花' }] };
  injectPrompt(event, '开心');
  const note = reminder(event);
  assert.ok(note);
  for (const text of [contentText(note), contentText(event.messages[0])]) {
    assert.match(text, /tool_search/);
    assert.match(text, /biaoqingbao_express/);
    assert.match(text, /tool_call/);
    assert.match(text, /server.*biaoqingbao/);
    assert.match(text, /emotion.*开心/);
    assert.doesNotMatch(text, /调用 express\(\{/, '发现路线前不能先要求调用尚未提供的裸工具');
  }
});

test('情境关键词、场景、语气和强度完整保留在发图参数里', () => {
  const event = { messages: [{ role: 'user', content: '又在加班' }] };
  injectPrompt(event, '无奈', ['加班', '电脑'], '加班让伙伴想调侃两句',
    { scene: '加班', tone: '自嘲', intensity: 'light' });
  const note = reminder(event);
  assert.ok(note);
  assert.match(contentText(note), /加班让伙伴想调侃两句/);
  const text = contentText(event.messages[0]);
  for (const value of ['无奈', '加班、电脑', '自嘲', 'light']) assert.ok(text.includes(value));
  assert.match(text, /keywords/);
  assert.match(text, /scene/);
});

test('没有真实 user 消息时不产生半份提醒，也不改工具结果或背景消息', () => {
  const event = { messages: [
    { role: 'toolResult', content: [{ type: 'text', text: '结果' }] },
    { role: 'custom', customType: 'other-context', content: '背景' },
  ] };
  const before = JSON.stringify(event.messages);
  assert.equal(injectPrompt(event, '开心'), false);
  assert.equal(JSON.stringify(event.messages), before);
  for (const content of [null, { text: '未知内容形状' }]) {
    const unsupported = { messages: [{ role: 'user', content }] };
    const original = JSON.stringify(unsupported.messages);
    assert.equal(injectPrompt(unsupported, '开心'), false);
    assert.equal(JSON.stringify(unsupported.messages), original);
  }
});

test('只提示最后一条真实用户消息，不给后面的背景与工具结果拼字', () => {
  const event = { messages: [
    { role: 'user', content: '上一轮' },
    { role: 'user', content: '这一轮' },
    { role: 'custom', customType: 'other-context', content: '背景' },
    { role: 'toolResult', content: [{ type: 'text', text: '结果' }] },
  ] };
  injectPrompt(event, '开心');
  assert.equal(event.messages[0].content, '上一轮');
  assert.match(event.messages[1].content, /tool_search/);
  assert.equal(event.messages[2].content, '背景');
  assert.equal(event.messages[3].content[0].text, '结果');
});

test('多模态用户消息保留所有原文字和图片，仅追加配图提示', () => {
  const original = [{ type: 'text', text: '这张乖不乖' }, { type: 'image', data: 'unchanged', mimeType: 'image/png' }];
  const event = { messages: [{ role: 'user', content: [...original] }] };
  assert.equal(injectPrompt(event, '开心'), true);
  assert.deepEqual(event.messages[0].content.slice(0, 2), original);
  assert.equal(event.messages[0].content.length, 3);
  assert.match(event.messages[0].content[2].text, /biaoqingbao_express/);
});

test('真实 observer 问候与情绪路径都接上新提醒，50%频率和正事门禁保持原样', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-observer-prompt-'));
  const code = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';
    const data = path.join(process.env.HANA_HOME, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'agent-freq.json'), JSON.stringify({
      version: 2, global_enabled: true,
      agents: { partner: { enabled: true, daily: 50, task: 0 } }
    }));
    fs.writeFileSync(path.join(data, 'text-config.json'), JSON.stringify({ enabled: true }));
    fs.writeFileSync(path.join(process.env.HANA_HOME, 'server-info.json'), JSON.stringify({ port: 1, token: 'test-only' }));
    const handlers = {};
    const observer = await import('./extensions/observer.js');
    observer.default({ on(type, handler) { handlers[type] = handler; } });
    let calls = 0;
    let scene = '闲聊';
    globalThis.fetch = async () => {
      calls++;
      return { json: async () => ({ ok: true, data: { has_emotion: true,
        emotion: '欣喜', keywords: ['聊天'], scene_type: scene, scene: '闲聊', tone: '调侃', intensity: 'light' } }) };
    };
    Math.random = () => 0.49;
    const greet = { messages: [{ role: 'user', content: '哈喽小花' }] };
    await handlers.context(greet, { agentId: 'partner' });
    const greetingCalls = calls;
    Math.random = () => 0.51;
    const rejected = { messages: [{ role: 'user', content: '好惬意呀' }] };
    await handlers.context(rejected, { agentId: 'partner' });
    const rejectedCalls = calls;
    Math.random = () => 0.49;
    const emotion = { messages: [{ role: 'user', content: '好惬意呀' }] };
    await handlers.context(emotion, { agentId: 'partner' });
    scene = '正事';
    const work = { messages: [{ role: 'user', content: '继续查代码' }] };
    await handlers.context(work, { agentId: 'partner' });
    const hasHint = event => event.messages.some(m => m.customType === 'biaoqingbao-expression-hint');
    console.log(JSON.stringify({ greetingCalls, rejectedCalls,
      greetingHint: hasHint(greet), rejectedHint: hasHint(rejected),
      emotionHint: hasHint(emotion), workHint: hasHint(work), calls,
      emotionText: emotion.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n') }));
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HANA_HOME: home }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.greetingCalls, 0, '问候不调用辅助模型');
    assert.equal(result.rejectedCalls, 0, '50%预筛拒绝时不调用辅助模型');
    assert.equal(result.greetingHint, true);
    assert.equal(result.rejectedHint, false);
    assert.equal(result.emotionHint, true);
    assert.equal(result.workHint, false, 'task=0仍拒绝正事配图');
    assert.equal(result.calls, 2);
    assert.match(result.emotionText, /biaoqingbao_express/);
    assert.match(result.emotionText, /聊天/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
