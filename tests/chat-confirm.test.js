import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// 确认请求可能已经落盘，但 iframe 在收到响应前断开；同一确认不能因此变成不可恢复的 409。
test('配图聊天确认：回包丢失后同一建议可幂等重试，并可按 ID 查询当前标签', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-chat-confirm-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(path.join(dataDir, 'stickers'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{
      id: 'stk_test',
      file: 'stk_test.png',
      description: '旧描述',
      tags: { emotion: ['开心'], scene: ['聊天'], keywords: ['猫'] },
    }, {
      id: 'stk_other',
      file: 'stk_other.png',
      description: '另一张图',
      tags: { emotion: ['难过'], scene: ['安慰'], keywords: ['狗'] },
    }]));
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: {
      test: {
        baseUrl: 'https://model.test',
        api: 'openai-completions',
        models: [{ id: 'text-model', input: ['text'] }],
      },
    }}));
    fs.writeFileSync(path.join(home, 'provider-catalog.json'), JSON.stringify({ providers: {} }));
    fs.writeFileSync(path.join(dataDir, 'text-config.json'), JSON.stringify({
      enabled: true,
      source: 'hana',
      providerId: 'test',
      modelId: 'text-model',
      customBaseUrl: '',
      customApiKey: '',
      customModel: '',
    }));

    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
      role: 'assistant',
      content: '我理解了。\\n<suggestion>{"description":"新的描述","semantic_description":"","emotion":["疑惑"],"scene":["吐槽"],"keywords":["猫","歪头"]}</suggestion>',
    }, finish_reason: 'stop' }] }), { status: 200 });

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    const ctx = {
      bus: { request: async () => ({ baseUrl: 'https://model.test', apiKey: 'test-key' }) },
      log: { info() {}, warn() {}, error() {} },
    };
    await registerRoutes(app, ctx);
    const call = (route, body) => routes[route]({ req: { json: async () => body } });

    const chatResponse = await call('POST /api/sticker/chat', {
      sticker_id: 'stk_test', message: '请把它改得更偏疑惑', session_id: null,
    });
    const chat = await chatResponse.json();
    const suggestion = chat.suggestion;
    const confirmBody = { session_id: chat.session_id, sticker_id: 'stk_test', new_tags: suggestion };
    const firstResponse = await call('POST /api/sticker/chat/confirm', confirmBody);
    const first = await firstResponse.json();
    // 模拟第一次确认已经写入但前端没收到响应，随后用户再次点确认。
    const secondResponse = await call('POST /api/sticker/chat/confirm', confirmBody);
    const second = await secondResponse.json();
    const conflictResponse = await call('POST /api/sticker/chat/confirm', {
      ...confirmBody,
      new_tags: { ...suggestion, description: '另一份描述' },
    });
    const conflict = await conflictResponse.json();
    const nextChatResponse = await call('POST /api/sticker/chat', {
      sticker_id: 'stk_test', message: '确认后继续聊', session_id: chat.session_id,
    });
    const nextChat = await nextChatResponse.json();
    const listResponse = await routes['GET /api/list']({ req: { query: (key) => key === 'id' ? 'stk_test' : '' } });
    const list = await listResponse.json();
    console.log(JSON.stringify({
      chatStatus: chatResponse.status,
      chatSessionId: chat.session_id,
      firstStatus: firstResponse.status,
      first,
      secondStatus: secondResponse.status,
      second,
      conflictStatus: conflictResponse.status,
      conflict,
      nextChatSessionId: nextChat.session_id,
      list,
    }));
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childCode],
      {
        cwd: process.cwd(),
        env: { ...process.env, HANA_HOME: home },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = child.stdout.trim().split(/\r?\n/).at(-1);
    const result = JSON.parse(output);

    assert.equal(result.chatStatus, 200);
    assert.equal(result.firstStatus, 200);
    assert.equal(result.first.ok, true);
    assert.equal(result.secondStatus, 200, '同一建议的重试必须幂等成功');
    assert.equal(result.second.ok, true);
    assert.equal(result.second.already_applied, true);
    assert.equal(result.conflictStatus, 409, '同一会话不能用另一份旧建议覆盖已确认结果');
    assert.equal(result.conflict.ok, false);
    assert.notEqual(result.nextChatSessionId, result.chatSessionId, '确认后的旧会话不能继续承载新的修改建议');
    assert.equal(result.list.ok, true);
    assert.equal(result.list.data.length, 1, '按 ID 回查不能把整张图库返回');
    assert.deepEqual(result.list.data.map((sticker) => ({
      id: sticker.id,
      description: sticker.description,
      emotion: sticker.tags?.emotion,
      scene: sticker.tags?.scene,
      keywords: sticker.tags?.keywords,
    })), [{
      id: 'stk_test',
      description: '新的描述',
      emotion: ['疑惑'],
      scene: ['吐槽'],
      keywords: ['猫', '歪头'],
    }]);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
