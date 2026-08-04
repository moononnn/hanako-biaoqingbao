// lib/teaching.js - 教学样本：让识图跟着用户学（v0.26.0）
//
// 背景：用户手动纠正表情包标签（改名字/描述）时，插件记住「这张图长什么样 + 用户叫它什么」。
// 之后识别新图时，用识别文本的向量跟教学样本对比，命中就把用户给的命名并进关键词——
// 用户教一次，以后同类图识别越来越准（月薪喵传第二张就能直接认出来）。
//
// 机制要点：
//   ① 只有「用户显式修改」才记教学样本（编辑器改标签、聊天式确认修改）；
//      模型自动识别的结果（批量应用、单张识图应用）不记，避免把模型自己的错误当成教学。
//   ② 样本存的是文本向量（embedding 模型编码「描述+关键词」），不是图片像素向量——
//      现有向量库（bge-m3）就是文本语义向量，识别后拿识别文本去对比，语义相近即命中。
//   ③ 阈值保守（宁可漏不可错）：相似度不够就不提示，避免误导识别。
//   ④ 上限自动淘汰最旧样本，无需用户管理。
//
// 依赖：embedding 配置（generateEmbeddings）。未配置时全部静默跳过，识别照常。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, generateEmbeddings, resolveEmbeddingApi, atomicWriteJson } from './shared.js';

// 配置路径支持环境变量覆盖（测试用隔离路径）
export function getTeachingFile() {
  return process.env.BIAOQINGBAO_TEACHING_FILE || path.join(DATA_DIR, 'teaching-samples.json');
}

// 教学样本上限：超过后淘汰最旧（按 updatedAt），防止样本膨胀干扰识别
export const MAX_TEACHING_SAMPLES = 200;
// 语义相似度阈值：bge-m3 同类描述通常 0.8+，不同话题通常 0.6 以下。
// 0.75 起步偏保守，宁可不提示也不误导；实测后可按效果调整。
export const TEACHING_SIMILARITY_THRESHOLD = 0.75;

export function readTeachingSamples() {
  try {
    return JSON.parse(fs.readFileSync(getTeachingFile(), 'utf-8'));
  } catch {
    return { version: 1, model: '', samples: {} };
  }
}

export function writeTeachingSamples(data) {
  atomicWriteJson(getTeachingFile(), data);
}

// 拼识别/教学文本：保持与向量编码输入一致（upsert 与查询用同一套拼接）
export function buildTeachingText(description, keywords, semanticDescription = '') {
  const parts = [];
  if (description) parts.push(description);
  if (semanticDescription) parts.push(semanticDescription);
  if (Array.isArray(keywords) && keywords.length) parts.push(keywords.join('，'));
  return parts.join('。');
}

// 纯函数：淘汰最旧的样本 id（按 updatedAt 升序取最早超出的）
export function pickEvictId(samples, max = MAX_TEACHING_SAMPLES) {
  const ids = Object.keys(samples);
  if (ids.length <= max) return null;
  let oldestId = null;
  let oldestTs = Infinity;
  for (const id of ids) {
    const ts = samples[id]?.updatedAt ? Date.parse(samples[id].updatedAt) : 0;
    if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
  }
  return oldestId;
}

// 纯函数：在样本里找与目标向量最相似的（相似度 > 阈值才返回）
export function findBestMatchByVector(vector, samples, threshold = TEACHING_SIMILARITY_THRESHOLD) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  let best = null;
  let bestScore = threshold; // 低于阈值不返回
  for (const [id, s] of Object.entries(samples || {})) {
    if (!Array.isArray(s?.vector) || s.vector.length !== vector.length) continue;
    const score = cosineSim(vector, s.vector);
    if (score > bestScore) { bestScore = score; best = { id, sample: s, score }; }
  }
  return best;
}

// 纯函数：余弦相似度（shared.js 里同名函数未导出，这里内置避免依赖）
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// 纯函数：从描述里提取「名字候选」——用户常把名字写在描述开头（如「呆猫八条，戴着粉色蝴蝶结」），
// 提取开头到第一个标点的片段，去掉常见修饰前缀，2~8 字才算（描述性长句自然跳过）。
export function extractNameCandidate(description) {
  if (!description) return null;
  const head = String(description).split(/[，。！？、,.!?;；]/)[0].trim();
  const cleaned = head.replace(/^(这是一?[只个张幅支条]|这是一张|这是一只|一个|一张|一只|这是|它)/, '').trim();
  if (cleaned.length >= 2 && cleaned.length <= 8) return cleaned;
  return null;
}

// 纯函数：把教学样本的命名并入识别结果（去重保序）——
// 并入范围：样本关键词 + 样本描述里提取的名字候选（用户可能只改了描述，如「呆猫八条」）。
export function mergeTeachingKeywords(resultKeywords, sample) {
  const result = Array.isArray(resultKeywords) ? resultKeywords.slice() : [];
  const existing = new Set(result.map((k) => String(k).trim()).filter(Boolean));
  const addIfAbsent = (word) => {
    const t = String(word).trim();
    if (t && !existing.has(t)) {
      result.push(t);
      existing.add(t);
    }
  };
  for (const k of Array.isArray(sample?.keywords) ? sample.keywords : []) {
    addIfAbsent(k);
  }
  // 名字候选：只并「不在结果里」的名字词（描述性词已在结果里就不重复加）
  const name = sample && sample.description ? extractNameCandidate(sample.description) : null;
  if (name) addIfAbsent(name);
  return result;
}

// 记录教学样本（用户改标签时调用）。异步算向量，embedding 不可用时静默跳过。
// embeddingFn 可注入（测试用 mock），默认走真实 generateEmbeddings。
// 返回 { ok, skipped }：skipped='no-embedding' | 'no-vector' 时不影响主流程。
export async function upsertTeachingSample(stickerId, { description = '', keywords = [], semanticDescription = '' }, embeddingFn = generateEmbeddings) {
  try {
    const text = buildTeachingText(description, keywords, semanticDescription);
    if (!text.trim()) return { ok: false, skipped: 'empty-text' };
    const emb = await embeddingFn(text);
    if (!emb.ok || !Array.isArray(emb.data) || !emb.data[0]) return { ok: false, skipped: 'embedding-failed' };
    const { model } = resolveEmbeddingApi();
    const data = readTeachingSamples();
    data.model = model || data.model || '';
    data.samples[stickerId] = {
      description,
      semanticDescription: semanticDescription || '',
      keywords: Array.isArray(keywords) ? keywords.slice() : [],
      vector: emb.data[0],
      updatedAt: new Date().toISOString(),
    };
    const evict = pickEvictId(data.samples);
    if (evict) delete data.samples[evict];
    writeTeachingSamples(data);
    return { ok: true };
  } catch (e) {
    // 教学是锦上添花，任何异常都不能影响改标签主流程
    return { ok: false, skipped: 'error', error: e.message };
  }
}

// 删除教学样本（删除表情包时调用）
export function removeTeachingSample(stickerId) {
  try {
    const data = readTeachingSamples();
    if (data.samples[stickerId]) {
      delete data.samples[stickerId];
      writeTeachingSamples(data);
      return true;
    }
  } catch {}
  return false;
}

// 识别后匹配：拿识别文本算向量，与教学样本对比，命中返回样本信息
// embeddingFn 可注入（测试用 mock），默认走真实 generateEmbeddings。
export async function findTeachingMatch(text, embeddingFn = generateEmbeddings) {
  try {
    if (!text || !text.trim()) return null;
    const emb = await embeddingFn(text);
    if (!emb.ok || !Array.isArray(emb.data) || !emb.data[0]) return null;
    const data = readTeachingSamples();
    const { model } = resolveEmbeddingApi();
    // 模型不一致的旧样本向量不参与对比（换了 embedding 模型后语义空间不同）
    if (data.model && model && data.model !== model) return null;
    return findBestMatchByVector(emb.data[0], data.samples);
  } catch {
    return null;
  }
}

// ── 教学名单（识别前注入，v0.26.0）──
// 背景：文本向量匹配对「同一角色不同表情」覆盖有限（戴蝴蝶结的纯真猫 vs 眯眼持刀的坏笑猫，
// 描述语义差很远，相似度上不去）。解法：把用户教过的命名做成名单，识图前直接喂给视觉模型对照——
// 模型看图认角色比文本相似度靠谱得多，名单里正好有它见过的样子。
// 只取最近 maxN 条（按 updatedAt），避免样本多了 prompt 膨胀。

export function listTeachingNames(maxN = 30) {
  try {
    const data = readTeachingSamples();
    const samples = Object.entries(data.samples || {})
      .sort((a, b) => (Date.parse(b[1]?.updatedAt) || 0) - (Date.parse(a[1]?.updatedAt) || 0))
      .slice(0, maxN);
    const items = [];
    for (const [id, s] of samples) {
      const name = extractNameCandidate(s?.description) || (Array.isArray(s?.keywords) ? s.keywords[0] : '') || '';
      if (!name) continue;
      // 特征 = 描述去掉名字后的部分（保留区分信息，控制长度）
      let feature = (s?.description || '').replace(name, '').replace(/^[，,、。\s]+/, '');
      if (feature.length > 30) feature = feature.slice(0, 30);
      items.push({ id, name, feature });
    }
    return items;
  } catch {
    return [];
  }
}

export function buildTeachingNameList(maxN = 30) {
  const items = listTeachingNames(maxN);
  if (!items.length) return '';
  const lines = items.map((it) => `- ${it.name}${it.feature ? `（${it.feature}）` : ''}`).join('\n');
  return `以下是用户手动教过的表情包命名参考：先核对画面特征，与某条高度吻合就优先用这个名字（写进描述和关键词）；不吻合就按画面描述，不要硬套。\n${lines}`;
}
