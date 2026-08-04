import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getConditionalScenePercent,
  passesFrequency,
} from '../extensions/observer.js';
import { recoverInterruptedItems } from '../routes/_batch-tasks.js';
import { scoreStickers, applyVectorBonus } from '../tools/express.js';
import { collectPrefsForEmotion, matchRitualWord, sanitizeTag, AUTOTAG_PROMPT } from '../lib/shared.js';
import { KNOWN_CONFUSABLES, buildConfusableSection } from '../lib/known-confusables.js';

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
    dislikes: {},
  });
  assert.deepEqual(preferred.map(item => item.id), ['b']);
  assert.equal(preferred[0]._score, 18);

  const excluded = scoreStickers(stickers, '开心', ['b'], {
    preferred: [],
    vetoed: [],
    dislikes: {},
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

test('累计不喜欢降权：次数越多分越低，多轮后基本出局（v0.25.0）', () => {
  const stickers = [
    { id: 'a', description: '开心大笑', tags: { emotion: ['开心'], scene: ['问候'] } },
  ];

  // 1 次不喜欢：-5，标签分 11 - 5 = 6，轻降频但还能出现（有机会再点）
  const once = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 1 } });
  assert.equal(once.length, 1);
  assert.equal(once[0]._score, 6);

  // 2 次不喜欢：-10，标签分 11 - 10 = 1，明显降频但仍在场（排最后，还能挽救）
  const twice = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 2 } });
  assert.equal(twice.length, 1);
  assert.equal(twice[0]._score, 1);

  // 3 次不喜欢：-15，跌破 0 基本不出现
  const thrice = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 3 } });
  assert.equal(thrice.length, 0);

  // 5 次及以上惩罚封顶 -25，彻底出局
  const many = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: [], dislikes: { a: 9 } });
  assert.equal(many.length, 0);
});

test('不喜欢累计与硬拉黑叠加：veto 的图再被点不喜欢，分更低（v0.25.0）', () => {
  const stickers = [
    { id: 'a', description: '开心大笑', tags: { emotion: ['开心'], scene: ['问候'] } },
  ];
  const result = scoreStickers(stickers, '开心', [], { preferred: [], vetoed: ['a'], dislikes: { a: 2 } });
  assert.equal(result.length, 0);
});

test('向量补充通道同样吃偏好惩罚：veto/不喜欢的图不能绕道向量复出（v0.25.0 漏洞修复）', () => {
  const stickers = [
    { id: 'v1', description: '一只猫在打盹', tags: { emotion: ['困'], keywords: ['猫'] } },
    { id: 'v2', description: '开心大笑', tags: { emotion: ['开心'], keywords: ['笑'] } },
  ];
  const tiredVec = [1, 0.9, 0.2];
  const vectors = {
    v1: [0.95, 0.85, 0.1],   // 与「疲惫」语义高度相似
    v2: [0.1, 0.1, 0.9],
  };

  // v1 被硬拉黑：即使语义相似度极高（sim>0.35 会被补充），也要被 -20 拉回来
  const scored = [];
  const withVeto = applyVectorBonus(scored, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: ['v1'], dislikes: {},
  });
  assert.equal(withVeto.length, 1);
  assert.equal(withVeto[0].id, 'v1');
  assert.ok(withVeto[0]._score < 0, 'veto 惩罚应盖过向量加分，分数为负');

  // v1 被不喜欢 2 次：同样不能靠向量通道翻身
  const scored2 = [];
  const withDislike = applyVectorBonus(scored2, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: [], dislikes: { v1: 2 },
  });
  assert.equal(withDislike.length, 1);
  assert.equal(withDislike[0].id, 'v1');
  assert.ok(withDislike[0]._score < 0, '2 次不喜欢的惩罚应盖过向量加分');

  // 对照：没有偏好的图，向量通道正常加分
  const scored3 = [];
  const clean = applyVectorBonus(scored3, stickers, tiredVec, vectors, [], {
    preferred: [], vetoed: [], dislikes: {},
  });
  assert.equal(clean.length, 1);
  assert.ok(clean[0]._score > 0, '无偏好时向量命中应为正分');
});

test('偏好按助手隔离：不合并其他助手的喜欢/反感记录（回归：遍历全部 users 导致串号）', () => {
  const agentA = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'], dislike_counts: { a3: 2 } },
    { context: { emotion: '难过' }, preferred_ids: ['a3'] },
  ];
  const agentB = [
    { context: { emotion: '开心' }, preferred_ids: ['b1'], vetoed_ids: ['b2'] },
  ];

  const forA = collectPrefsForEmotion(agentA, '开心');
  assert.deepEqual(forA, { preferred: ['a1'], vetoed: ['a2'], dislikes: { a3: 2 } });

  const forB = collectPrefsForEmotion(agentB, '开心');
  assert.deepEqual(forB, { preferred: ['b1'], vetoed: ['b2'], dislikes: {} });

  // A 情绪是「难过」时拿不到「开心」的偏好
  const sadA = collectPrefsForEmotion(agentA, '难过');
  assert.deepEqual(sadA, { preferred: ['a3'], vetoed: [], dislikes: {} });

  // 该助手没有记录时为空
  assert.deepEqual(collectPrefsForEmotion(undefined, '开心'), { preferred: [], vetoed: [], dislikes: {} });
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

test('识图 prompt：含知名角色/梗图规则与防幻觉约束（v0.26.0）', () => {
  // 知名角色/梗图必须报名字（虹夏、月薪喵、猫meme、熊猫头）
  assert.ok(AUTOTAG_PROMPT.includes('虹夏'), 'prompt 应示范知名角色名');
  assert.ok(AUTOTAG_PROMPT.includes('月薪喵'), 'prompt 应示范新梗名');
  assert.ok(AUTOTAG_PROMPT.includes('猫meme'), 'prompt 应示范系列梗图名');
  assert.ok(AUTOTAG_PROMPT.includes('熊猫头'), 'prompt 应示范表情包系列名');
  assert.ok(AUTOTAG_PROMPT.includes('角色名、梗名或系列名'), 'keywords 应要求报名字/系列名');
  assert.ok(AUTOTAG_PROMPT.includes('外观描述词同样保留'), '外观描述词应与角色名共存');
  // 防幻觉：报名前核对至少两个独有特征，对不上不写名字
  assert.ok(AUTOTAG_PROMPT.includes('核对至少两个独有特征'), '应有特征核对要求');
  assert.ok(AUTOTAG_PROMPT.includes('只写外观描述，不要猜测'), '应有防幻觉约束');
  // 既有规则不被破坏：scene 限 4 字、emotion 是情绪词
  assert.ok(AUTOTAG_PROMPT.includes('每个不超过4个字'), 'scene 限长规则应保留');
  assert.ok(AUTOTAG_PROMPT.includes('情绪词'), 'emotion 情绪词规则应保留');
  // 易混淆对照表已拼接进 prompt
  assert.ok(AUTOTAG_PROMPT.includes('千早爱音'), 'prompt 应含对照表内容（爱音）');
  assert.ok(AUTOTAG_PROMPT.includes('后藤一里'), 'prompt 应含对照表内容（波奇）');
});

test('易混淆对照表：爱音/波奇辨别要点齐全，生成段落含对照引导（v0.26.0）', () => {
  assert.ok(KNOWN_CONFUSABLES.length >= 1, '对照表不应为空');
  const group = KNOWN_CONFUSABLES.find(g => g.topic === '粉发少女');
  assert.ok(group, '应有粉发少女分组');
  const anon = group.entries.find(e => e.name === '千早爱音');
  const bocchi = group.entries.find(e => e.name === '后藤一里');
  assert.ok(anon && anon.traits.length >= 10, '爱音应有可核对的辨别要点');
  assert.ok(bocchi && bocchi.traits.length >= 10, '波奇应有可核对的辨别要点');
  assert.ok(anon.traits.includes('无呆毛'), '爱音应明确写无呆毛');
  assert.ok(bocchi.traits.includes('呆毛'), '波奇要点应含呆毛（独有特征）');
  const section = buildConfusableSection();
  assert.ok(section.includes('高相似度角色容易认错'), '应含对照引导语');
  assert.ok(section.includes('千早爱音'), '生成段落应含名字');
});

test('偏好收集：空情绪不收集任何偏好', () => {
  const mappings = [
    { context: { emotion: '开心' }, preferred_ids: ['a1'], vetoed_ids: ['a2'], dislike_counts: { a3: 1 } },
  ];
  assert.deepEqual(collectPrefsForEmotion(mappings, ''), { preferred: [], vetoed: [], dislikes: {} });
  assert.deepEqual(collectPrefsForEmotion(mappings, undefined), { preferred: [], vetoed: [], dislikes: {} });
});
