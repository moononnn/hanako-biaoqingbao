import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevRequest, jevEndpoint, JEV_DEFAULT_BASE_URL } from '../lib/jev.js';

test('Jev 默认 API 地址拼成 systemone 端点', () => {
  assert.equal(jevEndpoint(JEV_DEFAULT_BASE_URL), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jevEndpoint('https://api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(jevEndpoint('https://proxy.example/v1/systemone'), 'https://proxy.example/v1/systemone');
});

test('Jev 请求保留 state、questions 和模型名', () => {
  const body = buildJevRequest({
    state: { message: '测试' },
    model: 'jev-1.13.0',
    questions: { urgent: { type: 'noul', instructions: '是否紧急？' } },
  });
  assert.deepEqual(body, {
    model: 'jev-1.13.0',
    state: { message: '测试' },
    questions: { urgent: { type: 'noul', instructions: '是否紧急？' } },
  });
});

test('Jev 请求拒绝空 state 和空 questions', () => {
  assert.throws(() => buildJevRequest({ state: '', questions: { ok: {} } }), /state/);
  assert.throws(() => buildJevRequest({ state: 'x', questions: {} }), /questions/);
});

test('Jev 接口源码不把测试请求接入现有自动配图决策', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../routes/api.js', import.meta.url), 'utf8'));
  assert.match(source, /\/api\/jev-test/);
  assert.match(source, /不自动接管现有判断/);
});
