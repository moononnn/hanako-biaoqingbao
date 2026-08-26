// tests/style-profile.test.js - 学我说话 v2：数据画像（profile）+ 修正回流（feedback）存储
// 覆盖：profile 读写与空值兜底、feedback 读写、mergeDiffIntoFeedback 沉淀（去重/上限/跳过空）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FEEDBACK_MAX,
  readStyleProfile, writeStyleProfile,
  readStyleFeedback, writeStyleFeedback,
  mergeDiffIntoFeedback,
} from '../lib/style-profile.js';

const tempDirs = [];
function useTempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-profile-test-'));
  process.env.BIAOQINGBAO_STYLE_PROFILE = path.join(dir, 'style-profile.json');
  process.env.BIAOQINGBAO_STYLE_FEEDBACK = path.join(dir, 'style-feedback.json');
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('profile：默认空值 / 写入回读 / 字段归一化', () => {
  useTempData();
  const empty = readStyleProfile();
  assert.equal(empty.built_at, null);
  assert.equal(empty.level, '');
  assert.deepEqual(empty.source_agents, []);
  assert.equal(empty.baseline, null);
  assert.deepEqual(empty.channels, {});

  const p = writeStyleProfile({
    level: 'deep',
    source_agents: ['hanako', 'hanako', 'feiyue'], // 重复去重
    baseline: { sampled: 10 },
    channels: { lexicon: { status: 'ok' } },
  });
  assert.ok(p.built_at, 'built_at 自动填');
  assert.deepEqual(p.source_agents, ['hanako', 'feiyue']);
  const again = readStyleProfile();
  assert.equal(again.baseline.sampled, 10);
  assert.equal(again.channels.lexicon.status, 'ok');
});

test('feedback：读写 + 上限截断', () => {
  useTempData();
  const fb = {
    counterexamples: Array.from({ length: FEEDBACK_MAX + 5 }, (_, i) => ({ feature: '反例' + i })),
    locked: [{ content: '锁定句' }],
  };
  writeStyleFeedback(fb);
  const r = readStyleFeedback();
  assert.ok(r.counterexamples.length <= FEEDBACK_MAX, '反例超限应截断');
  assert.equal(r.counterexamples[0].feature, '反例5', '保留最近（尾部）');
  assert.equal(r.locked.length, 1);
  // 空读取兜底
  useTempData();
  const empty = readStyleFeedback();
  assert.deepEqual(empty.counterexamples, []);
  assert.deepEqual(empty.locked, []);
});

test('mergeDiffIntoFeedback：删→反例、增→锁定、去重、源标记', () => {
  useTempData();
  const fb = mergeDiffIntoFeedback(
    { removed: ['你爱堆感叹号哦。'], added: ['你偶尔加个小波浪~'] },
    'user-edit',
  );
  assert.equal(fb.counterexamples.length, 1);
  assert.equal(fb.counterexamples[0].feature, '你爱堆感叹号哦。');
  assert.equal(fb.counterexamples[0].source, 'user-edit');
  assert.equal(fb.locked.length, 1);
  assert.equal(fb.locked[0].content, '你偶尔加个小波浪~');

  // 再次合并同样的 → 去重不新增
  const fb2 = mergeDiffIntoFeedback({ removed: ['你爱堆感叹号哦。'], added: ['你偶尔加个小波浪~'] });
  assert.equal(fb2.counterexamples.length, 1);
  assert.equal(fb2.locked.length, 1);

  // 空/无意义输入不写坏
  const fb3 = mergeDiffIntoFeedback({ removed: ['', '  '], added: [null, 123] });
  assert.equal(fb3.counterexamples.length, 1);
  assert.equal(fb3.locked.length, 1);
});
