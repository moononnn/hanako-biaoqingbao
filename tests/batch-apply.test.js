// 批量识图落盘逻辑 + 批量配置测试（v0.34.37）
// 覆盖：配置默认值与往返、识别结果转条目、写库字段口径、异常输入不炸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BATCH_CONFIG,
  readBatchConfig,
  writeBatchConfig,
  isAutoApplyEnabled,
  selectPendingApplyIds,
  buildApplyItems,
  applyItemsToMeta,
} from '../lib/batch-apply.js';

let seq = 0;
function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bqb-batch-${process.pid}-${seq++}-`));
  return { dir, file: path.join(dir, 'batch-config.json') };
}

test('默认自动应用是打开的（用户拍板），文件不存在时也返回默认值', () => {
  const { dir, file } = tempConfigPath();
  try {
    assert.equal(DEFAULT_BATCH_CONFIG.autoApply, true);
    assert.equal(readBatchConfig(file).autoApply, true);
    assert.equal(isAutoApplyEnabled(readBatchConfig(file)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置写入后能读回来，关掉自动应用能持久化', () => {
  const { dir, file } = tempConfigPath();
  try {
    const saved = writeBatchConfig({ autoApply: false }, file);
    assert.equal(saved.autoApply, false);
    assert.equal(readBatchConfig(file).autoApply, false);
    assert.equal(isAutoApplyEnabled(readBatchConfig(file)), false);

    writeBatchConfig({ autoApply: true }, file);
    assert.equal(readBatchConfig(file).autoApply, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置内容损坏或取值非法时回退默认，不抛错', () => {
  const { dir, file } = tempConfigPath();
  try {
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    assert.equal(readBatchConfig(file).autoApply, true);

    fs.writeFileSync(file, JSON.stringify({ autoApply: 'yes' }), 'utf8');
    assert.equal(readBatchConfig(file).autoApply, 'yes');
    // 写入时非法值被收敛回默认，避免把脏值留在文件里
    assert.equal(writeBatchConfig({}, file).autoApply, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('构建应用条目：只收识别成功的，失败和缺失的跳过', () => {
  const task = {
    results: {
      a: { ok: true, data: { description: '猫在笑', emotion: ['开心'], scene: ['日常'], keywords: ['猫'], semantic_description: '一只猫' } },
      b: { ok: false, error: '模型超时' },
      c: { ok: true, data: { description: '', emotion: [], scene: [], keywords: [] } },
    },
  };

  const items = buildApplyItems(task, ['a', 'b', 'missing', 'c']);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'a');
  assert.equal(items[0].description, '猫在笑');
  assert.deepEqual(items[0].emotion, ['开心']);
  assert.equal(items[0].semantic_description, '一只猫');
  assert.equal(items[1].id, 'c');
  assert.deepEqual(items[1].emotion, []);

  assert.deepEqual(buildApplyItems(task, []), []);
  assert.deepEqual(buildApplyItems(null, ['a']), []);
});

test('写库：字段写入、tagged_at 打点、找不到的图跳过', () => {
  const meta = [
    { id: 'stk_001', file: 'a.png', description: '旧标题', tags: { emotion: [], scene: [], keywords: [] } },
    { id: 'stk_002', file: 'b.png', description: '没被识别', tags: { emotion: ['难过'] } },
  ];
  const items = [
    { id: 'stk_001', description: '猫在笑', semantic_description: '一只猫', emotion: ['开心', '可爱'], scene: ['日常'], keywords: ['猫', '笑'] },
    { id: 'stk_999', description: '不存在' },
  ];

  const now = '2026-09-11T12:00:00.000Z';
  const updated = applyItemsToMeta(meta, items, now);

  assert.equal(updated, 1, '找不到的 id 不计入更新数');
  assert.equal(meta[0].description, '猫在笑');
  assert.equal(meta[0].semantic_description, '一只猫');
  assert.deepEqual(meta[0].tags.emotion, ['开心', '可爱']);
  assert.deepEqual(meta[0].tags.scene, ['日常']);
  assert.deepEqual(meta[0].tags.keywords, ['猫', '笑']);
  assert.equal(meta[0].tagged_at, now);
  // 没被点到的图不动
  assert.equal(meta[1].description, '没被识别');
  assert.deepEqual(meta[1].tags.emotion, ['难过']);
  assert.equal(meta[1].tagged_at, undefined);
});

test('写库：标签接受字符串写法，空值不误写；tags 缺失时补上', () => {
  const meta = [{ id: 'stk_010', file: 'c.png' }];
  applyItemsToMeta(meta, [{ id: 'stk_010', emotion: '开心, 治愈 ,', keywords: '猫' }], 'T');

  assert.deepEqual(meta[0].tags.emotion, ['开心', '治愈']);
  assert.deepEqual(meta[0].tags.keywords, ['猫']);
  // 没传的字段不覆盖（不写入 undefined）
  assert.equal(meta[0].description, undefined);
});

test('挑出待应用 id：已经写过的不会被重复写', () => {
  assert.deepEqual(selectPendingApplyIds({ completed: ['a', 'b', 'c'], applied: ['a'] }), ['b', 'c']);
  assert.deepEqual(selectPendingApplyIds({ completed: ['a'], applied: ['a'] }), []);
  assert.deepEqual(selectPendingApplyIds({ completed: [], applied: [] }), []);
  assert.deepEqual(selectPendingApplyIds(null), []);
});

test('写库：异常输入直接返回 0，不抛错', () => {
  assert.equal(applyItemsToMeta(null, [{ id: 'x' }]), 0);
  assert.equal(applyItemsToMeta([], null), 0);
  assert.equal(applyItemsToMeta([{ id: 'a' }], [{ description: '没有 id' }]), 0);
});
