// express.js - 极简情绪表达工具
// 助手传一个情绪词 -> 插件匹配标签 + 语义向量 -> 返回最佳表情包
// v0.16.0：加向量检索双通道（标签打分 + 语义相似度）
// v0.17.4-share: 公共常量和工具函数从 lib/shared.js 导入
import { readFile, copyFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import {
  DATA_DIR as dataDir, STICKERS_DIR as stickersDir,
  PREFERENCES_FILE, DECISION_LOG_FILE, VECTORS_FILE,
  HANA_HOME, MIME_MAP,
  readEmbeddingConfig, resolveEmbeddingApi, generateEmbeddings,
  cosineSimilarity, readVectors, getAgentFreqSettings, markAgentStickerCooldown, resolveAgentId,
} from '../lib/shared.js';

const OUTPUT_DIR_CFG = join(dataDir, 'output-dir.json');

const recentlyUsed = [];
const MAX_RECENT = 5;

// v0.16.0 - 情绪词向量缓存（避免同一情绪词反复调 API）
const emotionVectorCache = new Map();
const EMOTION_CACHE_MAX = 50;

// v0.18.0 - 调一次 embedding API 取单个情绪词的向量
async function generateEmbedding(text) {
  const result = await generateEmbeddings(text);
  if (result?.ok && result.data?.[0]) return result.data[0];
  return null;
}

// v0.18.0 - 从 shared.js 读取已缓存的向量表
async function readVectorsCached() {
  return readVectors();
}

// 向量检索：给已有打分加向量 bonus，并补充纯向量命中
async function applyVectorScoring(scored, allStickers, emotion, excludeIds) {
  const vectorsData = readVectorsCached();
  if (!vectorsData?.vectors || Object.keys(vectorsData.vectors).length === 0) return scored;

  // 获取或缓存情绪词向量
  let emotionVec = emotionVectorCache.get(emotion);
  if (!emotionVec) {
    emotionVec = await generateEmbedding(emotion);
    if (emotionVec) {
      emotionVectorCache.set(emotion, emotionVec);
      if (emotionVectorCache.size > EMOTION_CACHE_MAX) {
        const firstKey = emotionVectorCache.keys().next().value;
        emotionVectorCache.delete(firstKey);
      }
    }
  }
  if (!emotionVec) return scored;

  // 给已有打分的表情包加向量 bonus
  for (const sticker of scored) {
    const vec = vectorsData.vectors[sticker.id];
    if (vec) {
      sticker._score += cosineSimilarity(emotionVec, vec) * 10;
    }
  }

  // 补充纯向量命中（标签没匹配但语义相近的）
  const scoredIds = new Set(scored.map(s => s.id));
  for (const sticker of allStickers) {
    if (scoredIds.has(sticker.id) || excludeIds.includes(sticker.id)) continue;
    const vec = vectorsData.vectors[sticker.id];
    if (vec) {
      const sim = cosineSimilarity(emotionVec, vec);
      if (sim > 0.35) {
        scored.push({ ...sticker, _score: sim * 10 });
      }
    }
  }

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

async function getOutputDir() {
  try {
    const raw = JSON.parse(await readFile(OUTPUT_DIR_CFG, 'utf-8'));
    return join(raw.path || join(tmpdir(), 'biaoqingbao_sent'), 'biaoqingbao_sent');
  } catch {
    return join(tmpdir(), 'biaoqingbao_sent');
  }
}

// 偏好加载（复用 express 的逻辑）
async function loadPreferencesFor(emotion) {
  try {
    const raw = await readFile(PREFERENCES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const result = { preferred: [], vetoed: [] };
    for (const uid in (data.users || {})) {
      for (const m of (data.users[uid].mappings || [])) {
        if (m.context.emotion && emotion.includes(m.context.emotion) || m.context.emotion && m.context.emotion.includes(emotion)) {
          result.preferred = result.preferred.concat(m.preferred_ids || []);
          result.vetoed = result.vetoed.concat(m.vetoed_ids || []);
        }
      }
    }
    return result;
  } catch {
    return { preferred: [], vetoed: [] };
  }
}

async function logDecision(emotion, stickerId, ctx) {
  try {
    let data = { version: 1, entries: [] };
    try { data = JSON.parse(await readFile(DECISION_LOG_FILE, 'utf-8')); } catch {}

    // v0.18.0 - 历史定位：存 session_id + 毫秒时间戳 + session 文件路径
    // 让后续聊天调整标签时能定位到当时具体那轮对话
    const sessionId = ctx?.sessionId || ctx?.sessionRef?.id || null;
    const sessionPath = ctx?.sessionPath || null;
    // 只记录 HANA_HOME 内的相对路径，避免把机器用户名和用户目录写进日志。
    let safeSessionPath = null;
    if (sessionPath) {
      const rel = relative(HANA_HOME, sessionPath);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) safeSessionPath = rel;
    }
    const contextTs = Date.now(); // express 被调用的毫秒时间戳

    const entry = {
      ts: new Date(contextTs).toISOString(),
      context_ts: contextTs,  // v0.18.0 新增：毫秒时间戳，供历史定位用
      type: 'express',
      decision: 'accepted',
      emotion,
      sticker_id: stickerId,
      agent: ctx?.agentId || 'unknown',
    };
    if (sessionId) entry.session_id = sessionId;           // v0.18.0 新增：session 指针
    if (safeSessionPath) entry.session_path = safeSessionPath; // 相对 HANA_HOME 的可迁移路径

    data.entries.push(entry);
    if (data.entries.length > 500) data.entries = data.entries.slice(-500);
    await writeFile(DECISION_LOG_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch {}
}

// 纯标签匹配打分（不调模型）
export function scoreStickers(stickers, emotion, excludeIds, prefs) {
  const emoLower = (emotion || '').toLowerCase();
  return stickers
    .filter(s => !excludeIds.includes(s.id))
    .map(sticker => {
      let score = 0;
      const tags = sticker.tags || {};

      // 情绪词匹配 emotion 标签
      for (const tag of (tags.emotion || [])) {
        const tagLower = tag.toLowerCase();
        if (tag === emotion) { score += 8; }
        else if (tag.includes(emotion) || emotion.includes(tag)) { score += 5; }
        else if (tagLower.includes(emoLower) || emoLower.includes(tagLower)) { score += 3; }
      }

      // 情绪词匹配 scene 标签
      for (const tag of (tags.scene || [])) {
        if (tag === emotion) { score += 5; }
        else if (tag.includes(emotion) || emotion.includes(tag)) { score += 3; }
      }

      // 情绪词匹配 keywords 标签
      for (const tag of (tags.keywords || [])) {
        if (tag === emotion) { score += 4; }
        else if (tag.includes(emotion) || emotion.includes(tag)) { score += 2; }
      }

      // 情绪词匹配 description
      if (sticker.description && sticker.description.includes(emotion)) { score += 3; }

      // 偏好加权
      if (prefs.preferred.includes(sticker.id)) { score += 10; }
      if (prefs.vetoed.includes(sticker.id)) { score -= 20; }

      return { ...sticker, _score: score };
    })
    .filter(s => s._score > 0)
    .sort((a, b) => b._score - a._score);
}

export const name = "express";
export const description = "用表情包表达你（助手）自己的情绪。当你回复用户时，如果自己感受到了开心、委屈、心疼、无奈、感动、得意、无语等情绪，想用一张图片来表达自己的感受，就调用这个工具。只需要传一个情绪词，比如 express({ emotion: '开心' }) 或 express({ emotion: '心疼想抱抱你' })。这是助手自己的情绪表达方式，不是必须执行的任务。";
export const sessionPermission = { kind: "session_file_output" };

export const parameters = {
  type: "object",
  properties: {
    emotion: {
      type: "string",
      description: "你想表达的情绪或感受，一个词或短句。如：开心、委屈、心疼、想抱抱你、得意、无语、感动、治愈、吃瓜、撒娇、社死、emo"
    },
    exclude_ids: {
      type: "array",
      items: { type: "string" },
      description: "可选：最近用过的表情包ID，避免重复"
    }
  },
  required: ["emotion"]
};

export async function execute(input, ctx) {
  const { emotion, exclude_ids = [] } = input || {};
  if (!emotion) return reply({ ok: false, error: '请传入你想表达的情绪' });

  ctx?.log?.info?.(`[biaoqingbao] express 被调用: emotion="${emotion}"`);

  // 主动调用不再重复抽概率，只遵守每位助手的全局开关。
  const agentId = resolveAgentId(null, ctx);
  try {
    const freqSettings = getAgentFreqSettings(agentId);
    if (!freqSettings.enabled) {
      ctx?.log?.info?.(`[biaoqingbao] 助手 ${agentId} 已关闭配图，拒绝发图`);
      return reply({ ok: false, error: '此助手已关闭表情包功能' });
    }
  } catch {}

  // 读取表情包库
  let stickers = [];
  try {
    stickers = JSON.parse(await readFile(join(dataDir, 'stickers.json'), 'utf-8'));
  } catch {
    return reply({ ok: false, error: '表情包库为空或读取失败' });
  }

  if (stickers.length === 0) {
    return reply({ ok: false, error: '表情包库是空的，请先添加一些表情包' });
  }

  // 加载偏好
  const prefs = await loadPreferencesFor(emotion);
  const allExclude = [...new Set([...(exclude_ids || []), ...recentlyUsed])];

  // 打分匹配
  const scored = scoreStickers(stickers, emotion, allExclude, prefs);

  if (scored.length === 0) {
    // 放宽限制：不排除最近用过的，再试一次
    const relaxed = scoreStickers(stickers, emotion, [], prefs);
    scored.push(...relaxed);
  }

  // v0.16.0 - 向量检索双通道：标签打分 + 语义相似度
  await applyVectorScoring(scored, stickers, emotion, allExclude);

  if (scored.length === 0) {
    return reply({
      ok: true,
      data: {
        action: 'no_match',
        message: `没有找到匹配「${emotion}」的表情包。你可以换个情绪词试试。`
      }
    });
  }

  // 从 top 3 里随机选一张（避免每次都发同一张）
  const topN = scored.slice(0, Math.min(3, scored.length));
  const best = topN[Math.floor(Math.random() * topN.length)];

  // 读取图片 -> 复制 -> stage
  const srcPath = join(stickersDir, best.file);
  let buffer;
  try {
    buffer = await readFile(srcPath);
  } catch {
    return reply({ ok: false, error: `图片文件 ${best.file} 读取失败` });
  }

  const sentDir = await getOutputDir();
  await mkdir(sentDir, { recursive: true }).catch(() => {});
  const filePath = join(sentDir, best.file);
  try { await copyFile(srcPath, filePath); } catch {}
  await chmod(filePath, 0o666).catch(() => {});

  const ext = best.file.split('.').pop().toLowerCase();
  const mime = MIME_MAP[ext] || 'image/png';

  // 防重复
  recentlyUsed.push(best.id);
  if (recentlyUsed.length > MAX_RECENT) recentlyUsed.shift();

  // 记录决策
  await logDecision(emotion, best.id, ctx);

  ctx?.log?.info?.(`[biaoqingbao] express 选中: ${best.description} (score=${best._score})`);

  // stage 发图
  let mediaItem = null;
  let stageSuccess = false;
  try {
    mediaItem = ctx.stageFile({ filePath, sessionPath: ctx.sessionPath, label: best.description });
    stageSuccess = true;
  } catch (e) {
    ctx?.log?.warn?.('[biaoqingbao] stageFile 失败:', e.message);
  }

  if (stageSuccess && mediaItem) {
    markAgentStickerCooldown(agentId);
    return {
      content: [{ type: 'text', text: `已发送表情包「${best.description}」（匹配度 ${best._score}）` }],
      details: {
        card: {
          type: 'iframe',
          pluginId: 'biaoqingbao',
          sessionId: ctx.sessionId,
          sessionRef: ctx.sessionRef,
          sessionPath: ctx.sessionPath,
          route: `/sticker?id=${encodeURIComponent(best.id)}&label=${encodeURIComponent(best.description)}&score=${best._score}`,
          title: best.description,
          description: '表情包配图 · biaoqingbao',
        }
      }
    };
  }

  markAgentStickerCooldown(agentId);
  return reply({
    ok: true,
    data: {
      action: 'selected',
      sticker: {
        id: best.id,
        file: best.file,
        description: best.description,
        filePath,
        mime,
        url: `data:${mime};base64,${buffer.toString('base64')}`,
        score: best._score,
      }
    }
  });
}
