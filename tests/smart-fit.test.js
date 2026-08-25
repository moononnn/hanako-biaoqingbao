import test from 'node:test';
import assert from 'node:assert/strict';

import { fitDecision, AUTO_FIT_MAX } from '../lib/smart-fit.js';

test('v0.33.72：智能开一律放大填满（0.686+ 聊天流宽度锁死，ui.resize 不生效）', () => {
  assert.equal(AUTO_FIT_MAX, 400);
  assert.deepEqual(fitDecision(30, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(99, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(159, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(200, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(399, true), { fit: true, cap: 400 });
});

test('自适应二分：短边 ≥ 400 放大填满 400（宿主槽位上限）', () => {
  assert.deepEqual(fitDecision(400, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(600, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(1024, true), { fit: true, cap: 400 });
  assert.deepEqual(fitDecision(4096, true), { fit: true, cap: 400 });
});

test('关闭智能：回退到旧行为（阈值 200：大图放大填满、小图原尺寸，无 cap）', () => {
  assert.deepEqual(fitDecision(230, false, 200), { fit: true, cap: null });
  assert.deepEqual(fitDecision(199, false, 200), { fit: false, cap: null });
  assert.deepEqual(fitDecision(200, false, 200), { fit: true, cap: null });
  assert.deepEqual(fitDecision(150, false, 200), { fit: false, cap: null });
});

test('非法输入：不放大、不崩溃', () => {
  assert.deepEqual(fitDecision(0, true), { fit: false, cap: null });
  assert.deepEqual(fitDecision(-5, true), { fit: false, cap: null });
  assert.deepEqual(fitDecision(Number.NaN, true), { fit: false, cap: null });
  assert.deepEqual(fitDecision(Number.POSITIVE_INFINITY, true), { fit: false, cap: null });
});