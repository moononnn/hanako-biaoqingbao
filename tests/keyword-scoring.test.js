// tests/keyword-scoring.test.js - 情境关键词通道（v0.34.51）
// 覆盖：keywords 不传时行为与旧版一致、关键词命中提权、话题分封顶、
//       关键词可独立于 emotion 命中、observer 侧关键词清洗
import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreStickers, pickTopCandidate } from '../tools/express.js';
import { sanitizeKeywords } from '../extensions/observer.js';

const NO_PREFS = { preferred: [], vetoed: [], dislikes: {} };

function sticker(id, { emotion = [], scene = [], keywords = [], description = '', semantic = '' } = {}) {
  return {
    id,
    file: `${id}.png`,
    description,
    semantic_description: semantic,
    tags: { emotion, scene, keywords },
    _source: { intensity: 'medium' },
  };
}

// ── 向后兼容：不传 keywords（或传空）时打分与旧版逐项一致 ──
test('不传 keywords 时打分与旧行为完全一致', () => {
  const list = [
    sticker('a', { emotion: ['无语'], description: '无语的猫' }),
    sticker('b', { emotion: ['无语', '疲惫'], keywords: ['加班', '老板'], description: '你看，又加班' }),
    sticker('c', { emotion: ['开心'] }),
  ];

  const legacy = scoreStickers(list, '无语', [], NO_PREFS);
  const withEmpty = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, []);
  const withUndefined = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, undefined);

  assert.deepEqual(withEmpty.map(s => [s.id, s._score]), legacy.map(s => [s.id, s._score]));
  assert.deepEqual(withUndefined.map(s => [s.id, s._score]), legacy.map(s => [s.id, s._score]));
});

// ── 关键词精确命中：把贴当前话题的图顶到前面 ──
test('关键词精确命中能超过同情绪的泛图', () => {
  const list = [
    sticker('generic', { emotion: ['无语'], description: '无语的猫' }),
    sticker('overtime', { emotion: ['无语'], keywords: ['加班'], description: '你看，又加班' }),
  ];

  const withoutKw = scoreStickers(list, '无语', [], NO_PREFS);
  assert.equal(withoutKw[0].id, 'generic', '不传关键词时两者同分，排序不应由关键词决定');

  const withKw = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, ['加班']);
  assert.equal(withKw[0].id, 'overtime', '带关键词后应命中「加班」的图排第一');
  assert.ok(withKw[0]._score > withKw[1]._score);
});

// ── 关键词近似命中（包含）权重低于精确 ──
test('关键词近似命中权重低于精确命中', () => {
  const exact = sticker('exact', { emotion: ['无语'], keywords: ['加班'] });
  const partial = sticker('partial', { emotion: ['无语'], keywords: ['又加班'] });
  const list = [exact, partial];

  const ranked = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, ['加班']);
  assert.equal(ranked[0].id, 'exact');
  assert.equal(ranked[0]._score - ranked[1]._score, 20 - 6);
});

// ── 单字关键词只走精确匹配：防「困」命中「困惑」式误配 ──
test('单字关键词不做包含匹配，避免误配', () => {
  const confusable = sticker('confusable', { emotion: ['开心'], keywords: ['困惑'] });
  const exactHit = sticker('exactHit', { emotion: ['无语'], keywords: ['累'] });
  const list = [confusable, exactHit];

  const ranked = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, ['累']);
  assert.equal(ranked.length, 1, '「困惑」不应该被单字「累」命中');
  assert.equal(ranked[0].id, 'exactHit');
});

// ── 话题分封顶：多词命中不能碾压情绪 ──
test('关键词总分封顶 40，不给单字段碾压情绪的机会', () => {
  const list = [
    sticker('allhit', { keywords: ['a', 'b', 'c', 'd', 'e'] }),
  ];
  const ranked = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]._score, 40);
});

// ── 关键词独立命中：情绪不匹配的图也能进候选 ──
test('emotion 完全不匹配时，关键词命中仍能让图进入候选', () => {
  const list = [
    sticker('happy', { emotion: ['得意'] }),
    sticker('work', { emotion: ['疲惫'], keywords: ['加班'] }),
  ];

  const noKw = scoreStickers(list, '无语', [], NO_PREFS);
  assert.equal(noKw.length, 0, '不带关键词时两张图都不该命中「无语」');

  const withKw = scoreStickers(list, '无语', [], NO_PREFS, null, null, null, ['加班']);
  assert.equal(withKw.length, 1);
  assert.equal(withKw[0].id, 'work');
});

// ── 关键词同样吃偏好惩罚（vetoed 不能靠关键词钻回来）──
test('被 veto 的图不会因关键词命中而排到普通图前面', () => {
  const list = [
    sticker('vetoed', { emotion: ['无语'], keywords: ['加班'] }),
    sticker('ok', { emotion: ['无语'] }),
  ];
  const prefs = { preferred: [], vetoed: ['vetoed'], dislikes: {} };

  const ranked = scoreStickers(list, '无语', [], prefs, null, null, null, ['加班']);
  const vetoedEntry = ranked.find(s => s.id === 'vetoed');
  const okEntry = ranked.find(s => s.id === 'ok');
  assert.ok(okEntry, '普通图应该在结果里');
  if (vetoedEntry) {
    assert.ok(vetoedEntry._score <= okEntry._score, 'vetoed 图不应排在普通图前面');
  }
});

// ── 语义描述命中：现成信息白捡一层情境（v0.34.52）──
test('语义描述命中能加分，但低于标签精确', () => {
  const bySemantic = sticker('bySemantic', { emotion: ['无语'], semantic: '适合吐槽对方回复慢时使用' });
  const byTag = sticker('byTag', { emotion: ['无语'], keywords: ['回复'] });

  const ranked = scoreStickers([bySemantic, byTag], '无语', [], NO_PREFS, null, null, null, ['回复']);
  assert.equal(ranked[0].id, 'byTag', '标签精确应该高于语义描述命中');
  assert.equal(ranked[0]._score - ranked[1]._score, 20 - 4);
});

test('单字关键词不扫语义描述，避免噪声命中', () => {
  const s = sticker('s', { emotion: ['开心'], semantic: '适合在工作中使用' });
  const ranked = scoreStickers([s], '无语', [], NO_PREFS, null, null, null, ['中']);
  assert.equal(ranked.length, 0, '单字不应命中语义描述里的「中」');
});

test('结构化场景、语气与强度只在有明确证据时加权', () => {
  const list = [
    { ...sticker('generic', { emotion: ['无奈'], keywords: ['已读不回'] }), _source: {} },
    { ...sticker('fit', { emotion: ['无奈'], scene: ['等回复'], keywords: ['已读不回'], semantic: '等人回复时自嘲一下' }), _source: { intensity: 'light' } },
    { ...sticker('heavy', { emotion: ['无奈'], scene: ['等回复'], keywords: ['已读不回'] }), _source: { intensity: 'strong' } },
  ];
  const query = { scene: '等回复', tone: '自嘲', intensity: 'light' };
  const ranked = scoreStickers(list, '无奈', [], NO_PREFS, null, null, null, ['已读不回'], query);
  assert.deepEqual(ranked.map(s => s.id), ['fit', 'heavy', 'generic']);
  const noQuery = scoreStickers(list, '无奈', [], NO_PREFS, null, null, null, ['已读不回']);
  assert.equal(noQuery[0]._score, noQuery[1]._score, '没传新字段时不应改变旧得分');
  assert.ok(ranked.find(s => s.id === 'generic'), '缺失强度/语气不应被当成强烈图处罚');
});

test('只有语气匹配、没有情绪情境命中时不能混入候选', () => {
  const list = [sticker('off-topic', { emotion: ['开心'], semantic: '适合自嘲' })];
  assert.deepEqual(scoreStickers(list, '无奈', [], NO_PREFS, null, null, null, [], { tone: '自嘲' }), []);
});

test('候选前三名按分数抽样，高分优先且仍留变化空间', () => {
  const list = [{ id: 'best', _score: 30 }, { id: 'middle', _score: 20 }, { id: 'last', _score: 10 }];
  assert.equal(pickTopCandidate(list, () => 0).id, 'best');
  assert.equal(pickTopCandidate(list, () => 0.7).id, 'middle');
  assert.equal(pickTopCandidate(list, () => 0.99).id, 'last');
});

// ── observer 侧关键词清洗 ──
test('sanitizeKeywords 接受数组与逗号分隔字符串', () => {
  assert.deepEqual(sanitizeKeywords(['加班', '老板']), ['加班', '老板']);
  assert.deepEqual(sanitizeKeywords('加班,老板、下班'), ['加班', '老板', '下班']);
  assert.deepEqual(sanitizeKeywords('加班，老板'), ['加班', '老板']);
});

test('sanitizeKeywords 去重、限长、限个数、清注入面', () => {
  assert.deepEqual(sanitizeKeywords(['加班', '加班', '老板']), ['加班', '老板']);
  assert.deepEqual(sanitizeKeywords(['这是一个特别特别长的关键词超过限制']), ['这是一个特别特别长的关键']);
  assert.deepEqual(
    sanitizeKeywords(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  assert.deepEqual(sanitizeKeywords(['加"班`$']), ['加班']);
  assert.deepEqual(sanitizeKeywords(null), []);
  assert.deepEqual(sanitizeKeywords(['', '  ']), []);
});
