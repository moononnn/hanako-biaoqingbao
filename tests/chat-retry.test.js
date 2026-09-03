import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// API 路由在模块加载时读取 HANA_HOME；用子进程隔离真实插件数据和模型请求。
test('配图聊天：思考耗尽自动重试，并在最终失败后保留会话供继续', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-chat-retry-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(path.join(dataDir, 'stickers'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{
      id: 'stk_test',
      file: 'stk_test.png',
      description: '一张测试表情包',
      tags: { emotion: ['疑惑'], scene: ['吐槽'], keywords: ['猫'] },
    }]));
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: {
      test: {
        baseUrl: 'https://model.test',
        api: 'openai-completions',
        models: [{ id: 'deepseek-v4-flash', input: ['text'], reasoning: true }],
      },
    }}));
    fs.writeFileSync(path.join(home, 'provider-catalog.json'), JSON.stringify({ providers: {} }));
    fs.writeFileSync(path.join(dataDir, 'text-config.json'), JSON.stringify({
      enabled: true,
      source: 'hana',
      providerId: 'test',
      modelId: 'deepseek-v4-flash',
      customBaseUrl: '',
      customApiKey: '',
      customModel: '',
    }));

    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      const call = requests.length;
      if (call === 1 || call === 3 || call === 4) {
        return new Response(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: '', reasoning_content: '只有思考' },
            finish_reason: 'length',
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: '我理解了。', reasoning_content: '短思考' },
          finish_reason: 'stop',
        }],
      }), { status: 200 });
    };

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
    const call = (body) => routes['POST /api/sticker/chat']({ req: { json: async () => body } });

    const firstResponse = await call({ sticker_id: 'stk_test', message: '这张图的情绪要更偏疑惑', session_id: null });
    const first = await firstResponse.json();
    // 第二轮沿用第一轮成功的 session，验证失败后仍能继续原上下文。
    const failedResponse = await call({ sticker_id: 'stk_test', message: '这次请直接帮我改', session_id: first.session_id });
    const failed = await failedResponse.json();
    const continuedResponse = await call({ sticker_id: 'stk_test', message: '继续哈', session_id: failed.session_id });
    const continued = await continuedResponse.json();

    console.log(JSON.stringify({
      firstStatus: firstResponse.status,
      first,
      failedStatus: failedResponse.status,
      failed,
      continuedStatus: continuedResponse.status,
      continued,
      requestCount: requests.length,
      maxTokens: requests.map(({ body }) => body.max_tokens),
      reasoningEffort: requests.map(({ body }) => body.reasoning_effort || null),
      thinking: requests.map(({ body }) => body.thinking || null),
      continuedMessages: requests[4]?.body?.messages?.map((message) => ({ role: message.role, content: message.content })),
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

    assert.equal(result.firstStatus, 200);
    assert.equal(result.first.ok, true);
    assert.equal(result.first.reply, '我理解了。');
    assert.equal(result.failedStatus, 500);
    assert.equal(result.failed.ok, false);
    assert.equal(result.failed.session_id, result.first.session_id, '失败应保留原有聊天会话号');
    assert.equal(result.continuedStatus, 200);
    assert.equal(result.continued.ok, true);
    assert.equal(result.requestCount, 5, '第一次失败重试一次，最终失败重试一次，继续后再请求一次');
    assert.deepEqual(result.maxTokens, [900, 2400, 900, 2400, 900]);
    assert.deepEqual(result.reasoningEffort, ['low', 'low', 'low', 'low', 'low']);
    assert.deepEqual(result.thinking, [
      { type: 'disabled' },
      { type: 'disabled' },
      { type: 'disabled' },
      { type: 'disabled' },
      { type: 'disabled' },
    ]);
    assert.deepEqual(result.continuedMessages.slice(-3), [
      { role: 'assistant', content: '我理解了。' },
      { role: 'user', content: '这次请直接帮我改' },
      { role: 'user', content: '继续哈' },
    ]);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
