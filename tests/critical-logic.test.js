import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getConditionalScenePercent,
  passesFrequency,
} from '../extensions/observer.js';
import { recoverInterruptedItems } from '../routes/_batch-tasks.js';
import { scoreStickers } from '../tools/express.js';

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

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
  });
  assert.deepEqual(preferred.map(item => item.id), ['b']);
  assert.equal(preferred[0]._score, 18);

  const excluded = scoreStickers(stickers, '开心', ['b'], {
    preferred: [],
    vetoed: [],
  });
  assert.deepEqual(excluded.map(item => item.id), ['a']);
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
