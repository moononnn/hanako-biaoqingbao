// tests/text-model.test.js - 选定内容分析模型的接口与思考开关
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMPTY_TEXT_RESPONSE,
  readTextModelDefinition,
  buildTextEndpoint,
  buildTextRequest,
  stripHiddenThinking,
  extractTextResponse,
  callConfiguredTextModel,
} from '../lib/text-model.js';

const messages = [
  { role: 'system', content: '只输出一句话。' },
  { role: 'user', content: '你好' },
];

test('DeepSeek Responses：根地址、模型选择和 reasoning.none 都进入请求', () => {
  const request = buildTextRequest({
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    api: 'openai-responses',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    reasoning: true,
  }, messages, { maxTokens: 900, temperature: 0.5 });

  assert.equal(request.url, 'https://api.deepseek.com/responses');
  assert.equal(request.body.model, 'deepseek-v4-flash');
  assert.equal(request.body.max_output_tokens, 900);
  assert.deepEqual(request.body.reasoning, { effort: 'none' });
  assert.equal(request.body.input, messages);
  assert.equal(request.headers.Authorization, 'Bearer test-key');
});

test('OpenAI 兼容 Chat Completions：DeepSeek 使用顶层 thinking.disabled', () => {
  const request = buildTextRequest({
    providerId: 'opencode-go',
    modelId: 'deepseek-v4-flash',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'test-key',
    reasoning: true,
  }, messages, { maxTokens: 800 });

  assert.equal(request.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.max_tokens, 800);
  assert.equal(request.body.stream, false);
});

test('buildTextEndpoint：三种已支持接口不重复拼接路径', () => {
  assert.equal(buildTextEndpoint('https://a.test/v1', 'openai-responses'), 'https://a.test/v1/responses');
  assert.equal(buildTextEndpoint('https://a.test/v1/chat/completions', 'openai-completions'), 'https://a.test/v1/chat/completions');
  assert.equal(buildTextEndpoint('https://a.test/v1', 'anthropic-messages'), 'https://a.test/v1/messages');
});

test('Codex Responses 内容模型使用 OAuth 凭据、系统指令和流式文本请求', () => {
  const request = buildTextRequest({
    providerId: 'openai-codex',
    modelId: 'gpt-6-luna',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: 'oauth-token',
    accountId: 'account-1',
    headers: {},
  }, messages, { maxTokens: 100 });

  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.headers['chatgpt-account-id'], 'account-1');
  assert.equal(request.headers.Authorization, 'Bearer oauth-token');
  assert.equal(request.body.model, 'gpt-6-luna');
  assert.equal(request.body.instructions, '只输出一句话。');
  assert.equal(request.body.input[0].role, 'user');
  assert.equal(request.body.input[0].content[0].text, '你好');
  assert.equal(request.body.stream, true);
  assert.equal('max_output_tokens' in request.body, false);
});

test('Responses 输出只取正文，不把 reasoning 混进模板', () => {
  const payload = {
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '内部思考' }] },
      { type: 'message', content: [{ type: 'output_text', text: '这是正文。' }] },
    ],
  };
  assert.equal(extractTextResponse(payload, 'openai-responses'), '这是正文。');
  assert.equal(extractTextResponse({ output: [{ type: 'reasoning', content: [] }] }, 'openai-responses'), '');
});

test('隐藏思考清洗：完整、混搭、未闭合块都不会漏进可见文案', () => {
  assert.equal(stripHiddenThinking('前文<think>内部</think>后文'), '前文后文');
  assert.equal(stripHiddenThinking('<analysis>内部</analysis>正文<thinking>未完'), '正文');
  assert.equal(stripHiddenThinking('正文</reasoning>'), '正文');
});

test('callConfiguredTextModel：真正请求插件选定模型，并显式关闭思考', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-text-model-'));
  const modelsPath = path.join(tempDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    test: {
      baseUrl: 'https://model.test',
      api: 'openai-responses',
      models: [{ id: 'reasoning-model', input: ['text'], reasoning: true }],
    },
  } }));

  const oldFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ output_text: '测试正文' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await callConfiguredTextModel(
      { bus: { request: async () => ({ apiKey: 'test-key' }) } },
      { providerId: 'test', modelId: 'reasoning-model' },
      messages,
      { modelsPath, maxTokens: 600, timeoutMs: 1000 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data, '测试正文');
    assert.equal(captured.url, 'https://model.test/responses');
    assert.deepEqual(captured.body.reasoning, { effort: 'none' });
    assert.equal(captured.body.max_output_tokens, 600);
  } finally {
    globalThis.fetch = oldFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('callConfiguredTextModel：Codex 内容模型走 OAuth Responses SSE，不误走 Chat Completions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-codex-text-'));
  const modelsPath = path.join(tempDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    'openai-codex': {
      api: 'openai-codex-responses',
      models: [{ id: 'gpt-6-luna', input: ['text'] }],
    },
  } }));

  const oldFetch = globalThis.fetch;
  let captured;
  let requestedProvider;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response([
      'data: {"type":"response.output_text.delta","delta":"内容"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"模型适配成功"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200 });
  };
  try {
    const result = await callConfiguredTextModel(
      { bus: { request: async (_topic, payload) => {
        requestedProvider = payload.providerId;
        return { baseUrl: 'https://chatgpt.com/backend-api', apiKey: 'oauth-token', accountId: 'account-1' };
      } } },
      { providerId: 'openai-codex', modelId: 'gpt-6-luna' },
      messages,
      { modelsPath, timeoutMs: 1000 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data, '内容模型适配成功');
    assert.equal(requestedProvider, 'openai-codex-oauth');
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.instructions, '只输出一句话。');
    assert.equal(captured.init.headers['chatgpt-account-id'], 'account-1');
  } finally {
    globalThis.fetch = oldFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('callConfiguredTextModel：正文为空时返回统一可重试错误', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-empty-text-'));
  const modelsPath = path.join(tempDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    test: { baseUrl: 'https://model.test', api: 'openai-responses', models: [{ id: 'm', input: ['text'], reasoning: true }] },
  } }));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '只有思考' }] }] }), { status: 200 });
  try {
    const result = await callConfiguredTextModel(
      { bus: { request: async () => ({ apiKey: 'test-key' }) } },
      { providerId: 'test', modelId: 'm' },
      messages,
      { modelsPath, timeoutMs: 1000 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, EMPTY_TEXT_RESPONSE);
    assert.equal(readTextModelDefinition('test', 'm', modelsPath).reasoning, true);
  } finally {
    globalThis.fetch = oldFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
