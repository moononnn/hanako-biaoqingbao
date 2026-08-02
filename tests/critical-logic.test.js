import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getConditionalScenePercent,
  passesFrequency,
} from '../extensions/observer.js';
import { recoverInterruptedItems } from '../routes/_batch-tasks.js';
import { scoreStickers, applyVectorBonus } from '../tools/express.js';
import { collectPrefsForEmotion, matchRitualWord, sanitizeTag } from '../lib/shared.js';

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

test('偏好按助手隔离：不合并其他助手的喜欢/反感记录（回归：遍历全部 users 导致串号）', () => {
  const agentA = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'] },
    { context: { emotion: '难过' }, preferred_ids: ['a3'] },
  ];
  const agentB = [
    { context: { emotion: '开心' }, preferred_ids: ['b1'], vetoed_ids: ['b2'] },
  ];

  const forA = collectPrefsForEmotion(agentA, '开心');
  assert.deepEqual(forA, { preferred: ['a1'], vetoed: ['a2'] });

  const forB = collectPrefsForEmotion(agentB, '开心');
  assert.deepEqual(forB, { preferred: ['b1'], vetoed: ['b2'] });

  // A 情绪是「难过」时拿不到「开心」的偏好
  const sadA = collectPrefsForEmotion(agentA, '难过');
  assert.deepEqual(sadA, { preferred: ['a3'], vetoed: [] });

  // 该助手没有记录时为空
  assert.deepEqual(collectPrefsForEmotion(undefined, '开心'), { preferred: [], vetoed: [] });
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

test('偏好收集：空情绪不收集任何偏好', () => {
  const mappings = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'] },
  ];
  assert.deepEqual(collectPrefsForEmotion(mappings, ''), { preferred: [], vetoed: [] });
  assert.deepEqual(collectPrefsForEmotion(mappings, undefined), { preferred: [], vetoed: [] });
});
