// tests/expression-bias.test.js - 方言×表情包联动（v0.27.0）
// 覆盖：气质表放大、按助手方言取权重、情绪系数解析、选图打分排序
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIALECT_EXPRESSION_BIAS,
  scaleBias,
  getAgentExpressionBias,
  writeDialectConfig,
  _resetDialectCache,
} from '../lib/dialect.js';
import { resolveEmotionFactor, TAG_TO_GROUP } from '../lib/emotion-groups.js';
import { scoreStickers } from '../tools/express.js';

// ── 测试隔离：配置路径指向临时文件 ──
const tempDirs = [];
function useTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-bias-test-'));
  const file = path.join(dir, 'dialect-config.json');
  process.env.BIAOQINGBAO_DIALECT_CONFIG = file;
  tempDirs.push(dir);
  _resetDialectCache();
  return file;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function sticker(id, emotionTags, intensity) {
  return {
    id,
    file: `${id}.png`,
    tags: { emotion: emotionTags, scene: [], keywords: [] },
    _source: intensity ? { intensity } : undefined,
  };
}

test('气质表：9 种方言都有 emotion 系数和 intensity 偏移', () => {
  const ids = Object.keys(DIALECT_EXPRESSION_BIAS);
  assert.equal(ids.length, 9);
  const GROUPS = ['搞笑', '开心', '难过', '无语', '感谢', '鼓励'];
  const LEVELS = ['light', 'medium', 'strong', 'high'];
  for (const id of ids) {
    const b = DIALECT_EXPRESSION_BIAS[id];
    assert.ok(b.label, `${id} 缺 label`);
    for (const g of GROUPS) {
      assert.equal(typeof b.emotion[g], 'number', `${id} 缺情绪系数 ${g}`);
    }
    for (const l of LEVELS) {
      assert.equal(typeof b.intensity[l], 'number', `${id} 缺强度偏移 ${l}`);
    }
  }
});

test('scaleBias：普通档返回原表，boost 放大偏离部分', () => {
  const base = DIALECT_EXPRESSION_BIAS.dongbei;
  assert.equal(scaleBias(base, false), base); // 普通档原样
  const boosted = scaleBias(base, true);
  // emotion：1 + (1.6 - 1) × 2 = 2.2
  assert.equal(boosted.emotion['搞笑'], 2.2);
  assert.equal(boosted.emotion['难过'], 1 + (0.8 - 1) * 2);
  // intensity：偏移 ×2
  assert.equal(boosted.intensity.light, base.intensity.light * 2);
  assert.equal(boosted.intensity.strong, base.intensity.strong * 2);
  assert.equal(scaleBias(null, true), null);
});

test('getAgentExpressionBias：未开方言返回 null，普通档基础表，boost 放大表', () => {
  useTempConfig();
  assert.equal(getAgentExpressionBias('test-agent'), null, '未配置方言应返回 null');

  writeDialectConfig({ agents: { 'test-agent': { dialect: 'dongbei', enabled: true } } });
  const normal = getAgentExpressionBias('test-agent');
  assert.equal(normal.emotion['搞笑'], 1.6, '普通档应是基础系数');

  writeDialectConfig({ agents: { 'test-agent': { dialect: 'dongbei', enabled: true, boost: true } } });
  const heavy = getAgentExpressionBias('test-agent');
  assert.equal(heavy.emotion['搞笑'], 2.2, 'boost 档应是放大系数');
  assert.equal(heavy.intensity.strong, DIALECT_EXPRESSION_BIAS.dongbei.intensity.strong * 2);
});

test('resolveEmotionFactor：命中大类取平均，未命中返回 1', () => {
  const dongbei = DIALECT_EXPRESSION_BIAS.dongbei;
  assert.equal(resolveEmotionFactor([], dongbei), 1, '无命中标签不干预');
  assert.equal(resolveEmotionFactor(['委屈'], dongbei), 0.8, '委屈属难过组');
  assert.equal(resolveEmotionFactor(['整活'], dongbei), 1.6, '整活属搞笑组');
  // 感动同时属开心+感谢+鼓励三组 → 平均（语义表里跨三组，行为正确）
  assert.equal(resolveEmotionFactor(['感动'], dongbei), (1.1 + 0.9 + 1.1) / 3);
  assert.equal(resolveEmotionFactor(['不知道啥组'], dongbei), 1, '不在表里的标签不干预');
  assert.equal(resolveEmotionFactor(['委屈'], null), 1, '无 bias 不干预');
  assert.ok(TAG_TO_GROUP['撒娇'].includes('搞笑'), '撒娇应归入搞笑组');
});

test('东北话 bias：同样开心，strong 炸裂图排前（light 被压）', () => {
  const dongbei = DIALECT_EXPRESSION_BIAS.dongbei;
  const strong = sticker('s1', ['开心'], 'strong');
  const light = sticker('s2', ['开心'], 'light');
  const ranked = scoreStickers([strong, light], '开心', [], {}, dongbei);
  assert.equal(ranked[0].id, 's1', '东北话开心应优先炸裂图');
  // 分数：8 × 1.1 + 2 = 10.8 vs 8 × 1.1 - 1.5 = 7.3
  assert.ok(ranked[0]._score > ranked[1]._score);
});

test('上海话 bias：同样开心，light 抿嘴笑图排前（strong 被压）', () => {
  const shanghai = DIALECT_EXPRESSION_BIAS.shanghai;
  const strong = sticker('s1', ['开心'], 'strong');
  const light = sticker('s2', ['开心'], 'light');
  const ranked = scoreStickers([strong, light], '开心', [], {}, shanghai);
  assert.equal(ranked[0].id, 's2', '上海话开心应优先抿嘴笑图');
});

test('东北话 bias：搞笑类图比难过类图优先（同分基础）', () => {
  const dongbei = DIALECT_EXPRESSION_BIAS.dongbei;
  const funny = sticker('f1', ['搞笑'], null);
  const sad = sticker('s1', ['难过'], null);
  const ranked = scoreStickers([funny, sad], '搞笑', [], {}, dongbei);
  assert.equal(ranked[0].id, 'f1');
  // 搞笑 8 × 1.6 = 12.8，难过标签的图只吃到包含匹配 3 × 0.8 = 2.4
  assert.equal(ranked[0]._score, 12.8);
});

test('无 bias：打分与原逻辑一致（开心图同分，顺序不干预）', () => {
  const a = sticker('a1', ['开心'], 'strong');
  const b = sticker('a2', ['开心'], 'light');
  const ranked = scoreStickers([a, b], '开心', [], {}, null);
  assert.equal(ranked[0]._score, ranked[1]._score, '无 bias 时强度不影响分数');
  assert.equal(ranked.length, 2);
});

test('intensity 缺失时只吃情绪系数，不吃强度偏移', () => {
  const dongbei = DIALECT_EXPRESSION_BIAS.dongbei;
  const noIntensity = sticker('n1', ['开心'], null);
  const ranked = scoreStickers([noIntensity], '开心', [], {}, dongbei);
  assert.equal(ranked[0]._score, 8 * 1.1, '无强度标签时只有系数作用');
});

test('boost 放大表：同一张图分数差异拉大', () => {
  const base = DIALECT_EXPRESSION_BIAS.dongbei;
  const boosted = scaleBias(base, true);
  const strong = sticker('s1', ['开心'], 'strong');
  const light = sticker('s2', ['开心'], 'light');
  const baseRanked = scoreStickers([strong, light], '开心', [], {}, base);
  const boostRanked = scoreStickers([strong, light], '开心', [], {}, boosted);
  const gapBase = baseRanked[0]._score - baseRanked[1]._score;
  const gapBoost = boostRanked[0]._score - boostRanked[1]._score;
  assert.ok(gapBoost > gapBase, 'boost 档排序差距应更大');
});
