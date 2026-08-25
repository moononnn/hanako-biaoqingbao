import test from 'node:test';
import assert from 'node:assert/strict';

import { isRetriableTextCallError } from '../lib/shared.js';

test('可重试：宿主输出契约「模型未回复正文」（思考型模型只吐思考）', () => {
  assert.equal(isRetriableTextCallError(new Error('模型未回复正文，请检查思考内容或稍后重试。')), true);
});

test('可重试：超时类错误', () => {
  assert.equal(isRetriableTextCallError(new Error('The operation was aborted due to timeout')), true);
  assert.equal(isRetriableTextCallError(new Error('请求超时')), true);
  assert.equal(isRetriableTextCallError('timeout'), true);
});

test('可重试：返回空正文（result 无 text/content 自造错误）', () => {
  assert.equal(isRetriableTextCallError(new Error('模型返回空正文（仅思考）')), true);
});

test('不可重试：确定性错误直接失败，不浪费重试', () => {
  assert.equal(isRetriableTextCallError(new Error('模型不存在: foo')), false);
  assert.equal(isRetriableTextCallError(new Error('401 Unauthorized')), false);
  assert.equal(isRetriableTextCallError(new Error('HTTP 500: upstream error')), false);
  assert.equal(isRetriableTextCallError(new Error('network fetch failed')), false);
  assert.equal(isRetriableTextCallError(undefined), false);
  assert.equal(isRetriableTextCallError(null), false);
});