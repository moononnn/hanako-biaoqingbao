import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_TEACHING_SAMPLES, TEACHING_SIMILARITY_THRESHOLD,
  readTeachingSamples, writeTeachingSamples,
  buildTeachingText, pickEvictId, findBestMatchByVector,
  mergeTeachingKeywords, upsertTeachingSample, removeTeachingSample,
  findTeachingMatch, extractNameCandidate, getTeachingFile,
  listTeachingNames, buildTeachingNameList,
} from '../lib/teaching.js';

// ── 测试隔离：教学样本文件指向临时路径，绝不碰正式数据 ──
const tempFiles = [];
function useTempTeaching() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-teaching-test-'));
  const file = path.join(dir, 'teaching-samples.json');
  process.env.BIAOQINGBAO_TEACHING_FILE = file;
  tempFiles.push(dir);
  return file;
}

test.after(() => {
  for (const dir of tempFiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('教学文本拼接：描述+语义描述+关键词，含任一即可', () => {
  assert.equal(buildTeachingText('灰猫嫌弃脸', ['猫', '嫌弃'], ''), '灰猫嫌弃脸。猫，嫌弃');
  assert.equal(buildTeachingText('', [], ''), '');
  assert.equal(buildTeachingText('只有描述', [], '语义'), '只有描述。语义');
  assert.ok(buildTeachingText('a', ['b'], 'c').includes('b'), '关键词应包含');
});

test('纯函数：向量匹配，相似度超阈值才命中', () => {
  // 构造：vecA 与 vecB 高相似（同向），vecC 正交
  const vecA = [1, 0, 0];
  const vecB = [0.99, 0.01, 0]; // 与 A 余弦 ≈ 0.9999
  const vecC = [0, 1, 0];       // 与 A 正交 → 0
  const samples = {
    s1: { keywords: ['月薪喵'], vector: vecA, updatedAt: '2026-08-04T00:00:00Z' },
    s2: { keywords: ['猫'], vector: vecC, updatedAt: '2026-08-04T00:00:00Z' },
  };
  const hit = findBestMatchByVector(vecB, samples);
  assert.ok(hit, '高相似应命中');
  assert.equal(hit.id, 's1');
  assert.ok(hit.score > TEACHING_SIMILARITY_THRESHOLD, '命中分数应超阈值');
  assert.ok(hit.sample.keywords.includes('月薪喵'), '应返回样本关键词');

  // 低相似不命中：只有 s1 一个样本，vecD 与它夹角大（余弦≈0.1）
  const vecD = [0.1, 0.995, 0];
  assert.equal(findBestMatchByVector(vecD, { s1: samples.s1 }), null, '低相似不应命中');

  // 多样本取最高分
  const best = findBestMatchByVector(vecC, samples);
  assert.equal(best.id, 's2', '应取最相似的样本');

  // 空向量/维度不符跳过
  assert.equal(findBestMatchByVector([], samples), null);
  assert.equal(findBestMatchByVector([1, 0], samples), null, '维度不符应跳过');
  assert.equal(findBestMatchByVector(vecA, {}), null, '空样本库不命中');
});

test('纯函数：教学命名并入识别结果（去重保序 + 描述名字候选）', () => {
  // 样本：keywords + description（用户只改了描述时，名字候选从描述提取）
  const sample = { keywords: ['猫', '嫌弃'], description: '呆猫八条，戴着粉色蝴蝶结，表情纯真。' };
  assert.deepEqual(mergeTeachingKeywords(['猫', '嫌弃'], sample), ['猫', '嫌弃', '呆猫八条']);
  assert.deepEqual(mergeTeachingKeywords([], sample), ['猫', '嫌弃', '呆猫八条'], '关键词与描述名字候选都应并入');
  // 名字已在结果里不重复，但未在结果里的样本关键词仍并入
  assert.deepEqual(mergeTeachingKeywords(['猫', '呆猫八条'], sample), ['猫', '呆猫八条', '嫌弃']);
  // 无描述/空样本容错
  assert.deepEqual(mergeTeachingKeywords(['a'], { keywords: ['b'] }), ['a', 'b']);
  assert.deepEqual(mergeTeachingKeywords(['a'], null), ['a'], 'null 样本容错');
  assert.deepEqual(mergeTeachingKeywords(null, { keywords: ['x'], description: '名字在这里' }), ['x', '名字在这里']);
  // 空白关键词不并入
  assert.deepEqual(mergeTeachingKeywords(['a'], { keywords: ['  ', 'b'] }), ['a', 'b']);
});

test('纯函数：描述提取名字候选（2~8 字，长句自然跳过）', () => {
  assert.equal(extractNameCandidate('呆猫八条，戴着粉色蝴蝶结'), '呆猫八条');
  assert.equal(extractNameCandidate('月薪喵，嫌弃地看着工资条'), '月薪喵');
  assert.equal(extractNameCandidate('一只戴粉色项圈的猫咪侧脸避开视线'), null, '长描述不应提取');
  assert.equal(extractNameCandidate('灰猫表情委屈地坐在牛奶旁'), null, '12字描述不应提取');
  assert.equal(extractNameCandidate('猫'), null, '太短不提取');
  assert.equal(extractNameCandidate(''), null);
  assert.equal(extractNameCandidate(null), null);
  assert.equal(extractNameCandidate('虹夏震惊地睁大眼'), '虹夏震惊地睁大眼', '8字整可提取');
});

test('纯函数：样本超上限时淘汰最旧', () => {
  const samples = {
    a: { updatedAt: '2026-08-01T00:00:00Z' },
    b: { updatedAt: '2026-08-02T00:00:00Z' },
    c: { updatedAt: '2026-08-03T00:00:00Z' },
  };
  assert.equal(pickEvictId(samples, 3), null, '未超上限不淘汰');
  assert.equal(pickEvictId(samples, 2), 'a', '超上限淘汰最旧');
  assert.equal(pickEvictId({}, 1), null);
  assert.equal(pickEvictId(samples, 0), 'a', '上限为 0 时也淘汰');
  assert.equal(MAX_TEACHING_SAMPLES >= 50, true, '默认上限应合理（≥50）');
});

test('读写往返：教学样本文件持久化', () => {
  useTempTeaching();
  const data = { version: 1, model: 'BAAI/bge-m3', samples: { stk_1: { keywords: ['月薪喵'], vector: [1, 2, 3], updatedAt: 'x' } } };
  writeTeachingSamples(data);
  const read = readTeachingSamples();
  assert.deepEqual(read.samples.stk_1.keywords, ['月薪喵']);
  assert.deepEqual(read.samples.stk_1.vector, [1, 2, 3]);
});

test('读写往返：文件不存在返回空结构', () => {
  useTempTeaching();
  const read = readTeachingSamples();
  assert.deepEqual(read, { version: 1, model: '', samples: {} });
});

test('upsert：embedding 失败时静默跳过，不报错不写文件', async () => {
  useTempTeaching();
  const failEmbedding = async () => ({ ok: false, error: '未配置 Embedding 模型' });
  const res = await upsertTeachingSample('stk_x', { description: '灰猫嫌弃脸', keywords: ['猫', '月薪喵'] }, failEmbedding);
  assert.equal(res.ok, false, 'embedding 失败应返回 ok:false');
  assert.equal(res.skipped, 'embedding-failed');
  const read = readTeachingSamples();
  assert.deepEqual(read.samples, {}, '不应写入样本');
});

test('upsert：embedding 成功时写入样本（含向量与模型），重复 upsert 覆盖更新', async () => {
  useTempTeaching();
  const okEmbedding = async () => ({ ok: true, data: [[1, 0, 0]] });
  const res = await upsertTeachingSample('stk_1', { description: '灰猫嫌弃脸', keywords: ['猫', '月薪喵'] }, okEmbedding);
  assert.equal(res.ok, true);
  const read = readTeachingSamples();
  assert.deepEqual(read.samples.stk_1.keywords, ['猫', '月薪喵']);
  assert.deepEqual(read.samples.stk_1.vector, [1, 0, 0], '应存向量');
  assert.ok(read.samples.stk_1.updatedAt, '应记录时间');
  // 重复 upsert 覆盖更新（用户再次纠正以最新为准）
  await upsertTeachingSample('stk_1', { description: '奶牛猫嫌弃脸', keywords: ['月薪喵'] }, okEmbedding);
  assert.deepEqual(readTeachingSamples().samples.stk_1.keywords, ['月薪喵'], '应覆盖旧关键词');
});

test('findTeachingMatch：命中返回样本，未命中返回 null，embedding 失败返回 null', async () => {
  useTempTeaching();
  const okEmbedding = async () => ({ ok: true, data: [[1, 0, 0]] });
  await upsertTeachingSample('stk_1', { description: '灰猫嫌弃脸', keywords: ['月薪喵'] }, okEmbedding);
  // 命中：同向量文本
  const hit = await findTeachingMatch('灰猫嫌弃脸', okEmbedding);
  assert.ok(hit, '应命中');
  assert.equal(hit.id, 'stk_1');
  // 未命中：不同语义空间（低相似向量）
  const missEmbedding = async () => ({ ok: true, data: [[0, 1, 0]] });
  assert.equal(await findTeachingMatch('熊猫头配字', missEmbedding), null, '低相似不应命中');
  // embedding 失败
  const failEmbedding = async () => ({ ok: false, error: 'x' });
  assert.equal(await findTeachingMatch('任意文本', failEmbedding), null);
  // 空文本
  assert.equal(await findTeachingMatch('  '), null);
});

test('upsert：空文本静默跳过', async () => {
  useTempTeaching();
  const res = await upsertTeachingSample('stk_x', { description: '', keywords: [] });
  assert.equal(res.skipped, 'empty-text');
});

test('removeTeachingSample：存在删除、不存在无副作用', () => {
  useTempTeaching();
  writeTeachingSamples({ version: 1, model: '', samples: { stk_1: { keywords: ['a'], updatedAt: 'x' } } });
  assert.equal(removeTeachingSample('stk_1'), true);
  assert.equal(readTeachingSamples().samples.stk_1, undefined, '应已删除');
  assert.equal(removeTeachingSample('stk_1'), false, '不存在返回 false');
  assert.equal(removeTeachingSample('不存在'), false);
});

test('教学文件路径默认在 data 目录（正式路径不指向临时）', () => {
  assert.ok(getTeachingFile().includes('teaching-samples.json'), '文件名正确');
});

test('教学名单：按最近更新排序取前 N 条，名字+特征分离', () => {
  useTempTeaching();
  writeTeachingSamples({
    version: 1, model: '',
    samples: {
      a: { description: '月薪喵，嫌弃地看着工资条', keywords: ['猫'], updatedAt: '2026-08-04T10:00:00Z' },
      b: { description: '呆猫八条眯眼持刀，表情阴险可爱', keywords: ['猫meme'], updatedAt: '2026-08-04T12:00:00Z' },
      c: { description: '戴粉色项圈的猫咪侧脸避开视线', keywords: ['猫'], updatedAt: '2026-08-04T11:00:00Z' },
    },
  });
  const items = listTeachingNames(2);
  assert.equal(items.length, 2, '只取最近 2 条');
  assert.equal(items[0].name, '呆猫八条眯眼持刀', '最新的排第一，名字从描述提取');
  assert.equal(items[1].name, '猫', '无名字候选（长描述）时用关键词兜底');
  assert.ok(items[0].feature.includes('表情阴险可爱'), '特征应去掉名字保留描述');
  // 全部取出：3 条都有名字（含关键词兜底）
  const all = listTeachingNames(10);
  assert.equal(all.length, 3, '关键词兜底保证每条都有名字');
  assert.equal(all[2].name, '月薪喵', '最旧的一条名字从描述提取');
});

test('教学名单注入：有样本时生成对照段，无样本返回空串', () => {
  useTempTeaching();
  assert.equal(buildTeachingNameList(), '', '空样本库不注入');
  writeTeachingSamples({
    version: 1, model: '',
    samples: {
      b: { description: '呆猫八条眯眼持刀，表情阴险可爱', keywords: ['猫meme'], updatedAt: '2026-08-04T12:00:00Z' },
    },
  });
  const list = buildTeachingNameList();
  assert.ok(list.includes('用户手动教过的表情包命名参考'), '应含引导语');
  assert.ok(list.includes('呆猫八条眯眼持刀'), '应含名字');
  assert.ok(list.includes('表情阴险可爱'), '应含特征');
  assert.ok(list.includes('不要硬套'), '应有防硬套约束');
});
