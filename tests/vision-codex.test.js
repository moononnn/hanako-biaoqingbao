import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexRequest,
  codexContent,
  codexEndpoint,
  isCodexVisionProvider,
  parseCodexResponse,
} from '../lib/vision-codex.js';

test('Codex provider uses Responses endpoint and OpenAI input image parts', () => {
  const request = buildCodexRequest({
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKey: 'oauth-token',
    accountId: 'account-1',
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ] }],
    maxTokens: 50,
  });
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.headers['chatgpt-account-id'], 'account-1');
  assert.equal(request.body.input[0].content[0].type, 'input_text');
  assert.equal(request.body.input[0].content[1].type, 'input_image');
  assert.equal(request.body.input[0].content[1].image_url, 'data:image/png;base64,abc');
  assert.equal('max_output_tokens' in request.body, false);
  assert.equal('temperature' in request.body, false);
});

test('Codex SSE parser keeps visible text and ignores reasoning events', () => {
  const raw = [
    'data: {"type":"response.reasoning_summary_text.delta","delta":"内部思考"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"红"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"色"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.equal(parseCodexResponse(raw), '红色');
});

test('Codex helpers reject incomplete OAuth request', () => {
  assert.equal(isCodexVisionProvider('openai-codex', ''), true);
  assert.equal(codexEndpoint('https://chatgpt.com/backend-api/codex/responses'), 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(codexContent([{ type: 'text', text: 'x' }]), [{ type: 'input_text', text: 'x' }]);
  assert.throws(() => buildCodexRequest({ baseUrl: '', apiKey: 'x', accountId: 'a', model: 'm', messages: [] }), /API 地址/);
  assert.throws(() => buildCodexRequest({ baseUrl: 'https://x', apiKey: '', accountId: 'a', model: 'm', messages: [] }), /凭据/);
  assert.throws(() => buildCodexRequest({ baseUrl: 'https://x', apiKey: 'x', accountId: '', model: 'm', messages: [] }), /账号标识/);
});
