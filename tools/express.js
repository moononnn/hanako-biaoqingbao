// express.js - 极简情绪表达工具
// 助手传一个情绪词 -> 插件匹配标签 + 语义向量 -> 返回最佳表情包
// v0.16.0：加向量检索双通道（标签打分 + 语义相似度）
// v0.17.4-share: 公共常量和工具函数从 lib/shared.js 导入
// v0.32.3：加 stickerId 可选参数，有 stickerId 时跳过匹配直接发指定图；
//          prefs.vetoed 仍生效；cooldown/pushRecent/logDecision 照常走。
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
  collectPrefsForEmotion, atomicWriteJson, prefsScoreBonus,
} from '../lib/shared.js';
import { resolveEmotionFactor } from '../lib/emotion-groups.js';
import { getAgentExpressionBias } from '../lib/dialect.js';
import { fitDecision } from '../lib/smart-fit.js';
import { imageSizeFromBuffer } from '../lib/image-size.js';
import { recordRecentMatch } from '../lib/recent-match.js';

const OUTPUT_DIR_CFG = join(dataDir, 'output-dir.json');
const NATIVE_MEDIA_MIN_VERSION = [0, 679, 0];

const recentlyUsedByAgent = new Map(); // v0.19.5 - 最近使用按助手隔离，避免不同助手互相影响去重
const MAX_RECENT = 5;

function getRecent(agentId) {
  return recentlyUsedByAgent.get(agentId) || [];
}

function pushRecent(agentId, id) {
  const list = getRecent(agentId);
  list.push(id);
  if (list.length > MAX_RECENT) list.shift();
  recentlyUsedByAgent.set(agentId, list);
}

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

// v0.19.5 - 向量打分纯函数（供 execute 与单元测试复用）
// ⚠️ 副作用契约：原地修改 scored 数组（叠加 _score、补充新项）并返回同一个数组；
// 调用方依赖此行为，改动返回值语义前必须先改 execute。
// v0.25.0 - 新增 prefs 参数：向量补充通道同样应用偏好惩罚（修复 veto/不喜欢绕道向量通道钻回来的漏洞）
export function applyVectorBonus(scored, allStickers, emotionVec, vectorMap, excludeIds, prefs) {
  if (!emotionVec || !vectorMap || Object.keys(vectorMap).length === 0) return scored;

  // 给已有打分的表情包加向量 bonus
  for (const sticker of scored) {
    const vec = vectorMap[sticker.id];
    if (vec) {
      sticker._score += cosineSimilarity(emotionVec, vec) * 10;
    }
  }

  // 补充纯向量命中（标签没匹配但语义相近的）
  const scoredIds = new Set(scored.map(s => s.id));
  for (const sticker of allStickers) {
    if (scoredIds.has(sticker.id) || excludeIds.includes(sticker.id)) continue;
    const vec = vectorMap[sticker.id];
    if (vec) {
      const sim = cosineSimilarity(emotionVec, vec);
      if (sim > 0.35) {
        // v0.25.0 - 补充命中也要吃偏好惩罚：vetoed/不喜欢次数照常降权，避免绕道向量通道复出
        scored.push({ ...sticker, _score: sim * 10 + prefsScoreBonus(sticker.id, prefs) });
      }
    }
  }

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// 向量检索：给已有打分加向量 bonus，并补充纯向量命中
async function applyVectorScoring(scored, allStickers, emotion, excludeIds, prefs) {
  // v0.19.5 - 修复：readVectorsCached 是 async，少了 await 会导致向量通道整体静默失效
  const vectorsData = await readVectorsCached();
  if (!vectorsData?.vectors || Object.keys(vectorsData.vectors).length === 0) return scored;

  // 获取或缓存情绪词向量（v0.19.5 - key 带模型与维度，换模型后不会命中旧缓存）
  const cacheKey = `${emotion}|${vectorsData.model || ''}|${vectorsData.dimensions || 0}`;
  let emotionVec = emotionVectorCache.get(cacheKey);
  if (!emotionVec) {
    emotionVec = await generateEmbedding(emotion);
    if (emotionVec) {
      emotionVectorCache.set(cacheKey, emotionVec);
      if (emotionVectorCache.size > EMOTION_CACHE_MAX) {
        const firstKey = emotionVectorCache.keys().next().value;
        emotionVectorCache.delete(firstKey);
      }
    }
  }
  if (!emotionVec) return scored;

  return applyVectorBonus(scored, allStickers, emotionVec, vectorsData.vectors, excludeIds, prefs);
}

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// v0.31.7 - 卡片必须显式提供宽高比；新宿主对缺失 aspectRatio 的插件卡片可能不创建可见 iframe。
// v0.33.1 - 宿主槽位宽恒 400（只按比例算初始高度），且响应 ui.resize 宽度收窄（50~400 有效）。
// 卡片初始尺寸直接用 400:<目标高度> 贴合图高，图片加载后 fitCard 再上报实际宽度：
//   短边<400 的图贴原尺寸（小卡），≥400 的图填满 400（大卡），整卡随图收缩。
// size 缺省或解析失败时回退 '400:430'（旧行为，保证异常不炸）。
const BTN_RESERVE = 64; // 底部反馈按钮排预留：14(img-card 边框+padding) + 8(gap) + 30(按钮区) + 12(body padding)
function calcCardAspectRatio(size, smart) {
  if (!size || !size.width || !size.height) return '400:430';
  const minSide = Math.min(size.width, size.height);
  const ratio = size.height / size.width;
  let dispW;
  if (smart !== false) {
    // 自适应二分（v0.33.1）：短边 <400 → 贴原图尺寸；≥400 → 放大填满 400（宿主可用宽上限）
    const d = fitDecision(minSide, true, 200);
    dispW = d.fit ? 400 : size.width;
  } else {
    // 关闭智能：回退旧行为（大图按 400 基准放大填满、小图原尺寸交给 iframe 内 fitCard）
    dispW = minSide >= 200 ? 400 : size.width;
  }
  dispW = Math.max(50, Math.round(dispW));
  const imgH = Math.round(dispW * ratio);
  const totalH = Math.min(600, imgH + BTN_RESERVE);
  return `400:${Math.round(totalH)}`;
}

export function buildStickerCard({
  id,
  description,
  score,
  emotion,
  agentId,
  sessionId,
  sessionRef,
  sessionPath,
  size,     // v0.32.3 - { width, height }，可选；缺省回退 '400:430'
  smart,    // v0.32.3 - 是否启用智能多档（默认 true）；false 回退旧行为
}) {
  return {
    type: 'iframe',
    pluginId: 'biaoqingbao',
    sessionId,
    sessionRef,
    sessionPath,
    route: `/sticker?id=${encodeURIComponent(id)}&label=${encodeURIComponent(description)}&score=${score}&emotion=${encodeURIComponent(emotion)}&agent=${encodeURIComponent(agentId || '')}`,
    aspectRatio: calcCardAspectRatio(size, smart),
    title: description,
    description: '表情包配图 · biaoqingbao',
  };
}

// Hana 0.679+ 将 plugin_card 作为 Chalkboard 入口，聊天里只显示占位卡；
// 0.679 的聊天流对插件工具的 details.media 也不消费（media 只进模型视觉 + session 文件注册），
// 唯一能让助手消息直接显示原图的原生通道是 deferred 任务广播的 file block（image-gen 同款）。
export function buildStickerMediaDetails(stagedFile, taskId = null) {
  // 0.679 的 ctx.stageFile 返回 { file, mediaItem }；旧宿主可能直接返回 mediaItem。
  const mediaItem = stagedFile?.mediaItem || stagedFile;
  return {
    media: { items: [mediaItem] },
    // 标准媒体占位契约：宿主先把 pending block 挂到当前助手消息，
    // deferred 文件到达后按 taskId 原地替换，避免图片漂到下一轮。
    ...(taskId ? {
      mediaGeneration: {
        source: 'plugin',
        kind: 'image',
        tasks: [{ taskId }],
      },
    } : {}),
  };
}

// v0.33.2 - deferred 原生图片块通道：
// server 对 deferred:resolve 的 result.sessionFiles 会广播 content_block(file)（image-gen 同款链路），
// 渲染端直接显示原图。这是 0.679 聊天流里助手消息显示图片的官方原生通道。
// 返回 { ok, taskId } = 图片已以原生块提交；ok=false = 通道不可用，由调用方降级到 card/media 协议。
export async function trySendDeferredImage(ctx, stagedFile) {
  const file = stagedFile?.file || stagedFile?.mediaItem || stagedFile;
  if (!file?.filePath) return { ok: false };
  const sessionPath = ctx?.sessionPath;
  const sessionId = ctx?.sessionId || file?.sessionId || null;
  if (!sessionPath && !sessionId) return { ok: false };
  if (typeof ctx?.bus?.request !== 'function') return { ok: false };
  const taskId = `bqbq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    // 检查 register 返回值：旧宿主若对未知总线类型返回错误对象（而非抛错），
    // 不检查会误判成功导致假发图（工具回 success 但聊天里没有图）。
    const registered = await ctx.bus.request('deferred:register', {
      taskId,
      sessionId: sessionId || undefined,
      sessionPath: sessionPath || undefined,
      // 与 Hana 原生生图保持同一交付语义：成功只更新 UI，不唤醒父助手。
      // image-generation 类型还让历史恢复器把 sessionFiles 归回原回复。
      meta: {
        type: 'image-generation',
        mediaKind: 'image',
        toolName: 'biaoqingbao',
        deliveryIntent: 'ui_only',
        triggerParentTurn: false,
      },
    });
    if (!registered || registered.ok === false) {
      ctx?.log?.warn?.('[biaoqingbao] deferred:register 未获确认，降级:', registered ? JSON.stringify(registered) : '无返回');
      return { ok: false };
    }
    const resolved = await ctx.bus.request('deferred:resolve', {
      taskId,
      result: { sessionFiles: [file] },
    });
    if (!resolved || resolved.ok === false) {
      ctx?.log?.warn?.('[biaoqingbao] deferred:resolve 未获确认，降级:', resolved ? JSON.stringify(resolved) : '无返回');
      return { ok: false };
    }
    ctx?.log?.debug?.(`[biaoqingbao] deferred 原生图片块已提交: ${taskId}`);
    return { ok: true, taskId };
  } catch (e) {
    ctx?.log?.warn?.('[biaoqingbao] deferred 发图失败，降级:', e?.message || String(e));
    return { ok: false };
  }
}

function parseAppVersion(version) {
  const match = String(version || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

// 0.679+ 的新主聊天把 plugin_card 统一交给 Chalkboard；未知版本保守走旧卡片。
export function supportsNativeMediaDetails(version) {
  const current = parseAppVersion(version);
  if (!current) return false;
  for (let i = 0; i < NATIVE_MEDIA_MIN_VERSION.length; i += 1) {
    if (current[i] !== NATIVE_MEDIA_MIN_VERSION[i]) return current[i] > NATIVE_MEDIA_MIN_VERSION[i];
  }
  return true;
}

async function readHanaAppVersion() {
  try {
    const info = JSON.parse(await readFile(join(HANA_HOME, 'server-info.json'), 'utf8'));
    return typeof info?.version === 'string' ? info.version : null;
  } catch {
    return null;
  }
}

export function buildStickerDeliveryDetails(stagedFile, cardOptions, hostVersion) {
  return supportsNativeMediaDetails(hostVersion)
    ? buildStickerMediaDetails(stagedFile)
    : { card: buildStickerCard(cardOptions) };
}

async function getOutputDir() {
  try {
    const raw = JSON.parse(await readFile(OUTPUT_DIR_CFG, 'utf-8'));
    return join(raw.path || join(tmpdir(), 'biaoqingbao_sent'), 'biaoqingbao_sent');
  } catch {
    return join(tmpdir(), 'biaoqingbao_sent');
  }
}

// 偏好加载（v0.19.5 - 按 agentId 隔离：优先当前助手，旧格式兼容 users.default / 根级 mappings）
async function loadPreferencesFor(emotion, agentId) {
  try {
    const raw = await readFile(PREFERENCES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const users = data.users || {};
    // 优先级：当前助手 > 旧格式 default > 更老的根级 mappings（都只取一个，不合并，避免串号）
    const target = (agentId && users[agentId]) || users.default || (Array.isArray(data.mappings) ? { mappings: data.mappings } : null);
    if (!target) return { preferred: [], vetoed: [], dislikes: {} };
    return collectPrefsForEmotion(target.mappings, emotion);
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
      agent: resolveAgentId(null, ctx),  // v0.19.5 - 与选图/反馈统一口径，避免写 unknown 导致前端反馈落错桶
    };
    if (sessionId) entry.session_id = sessionId;           // v0.18.0 新增：session 指针
    if (safeSessionPath) entry.session_path = safeSessionPath; // 相对 HANA_HOME 的可迁移路径

    data.entries.push(entry);
    if (data.entries.length > 500) data.entries = data.entries.slice(-500);
    atomicWriteJson(DECISION_LOG_FILE, data);
  } catch {}
}

// 纯标签匹配打分（不调模型）
// v0.27.0：新增 bias 参数（方言表情气质权重），情绪贡献分乘方言系数 + 加强度偏移；
// 只影响情绪匹配分，prefs 偏好惩罚在系数之外照常生效。bias=null 时与原逻辑完全一致。
export function scoreStickers(stickers, emotion, excludeIds, prefs, bias = null) {
  const emoLower = (emotion || '').toLowerCase();
  return stickers
    .filter(s => !excludeIds.includes(s.id))
    .map(sticker => {
      let emotionScore = 0;
      const emotionHitTags = [];
      const tags = sticker.tags || {};

      // 情绪词匹配 emotion 标签
      for (const tag of (tags.emotion || [])) {
        const tagLower = tag.toLowerCase();
        if (tag === emotion) { emotionScore += 8; emotionHitTags.push(tag); }
        else if (tag.includes(emotion) || emotion.includes(tag)) { emotionScore += 5; emotionHitTags.push(tag); }
        else if (tagLower.includes(emoLower) || emoLower.includes(tagLower)) { emotionScore += 3; emotionHitTags.push(tag); }
      }

      // 情绪词匹配 scene 标签
      for (const tag of (tags.scene || [])) {
        if (tag === emotion) { emotionScore += 5; emotionHitTags.push(tag); }
        else if (tag.includes(emotion) || emotion.includes(tag)) { emotionScore += 3; emotionHitTags.push(tag); }
      }

      // 情绪词匹配 keywords 标签
      for (const tag of (tags.keywords || [])) {
        if (tag === emotion) { emotionScore += 4; emotionHitTags.push(tag); }
        else if (tag.includes(emotion) || emotion.includes(tag)) { emotionScore += 2; emotionHitTags.push(tag); }
      }

      // 情绪词匹配 description
      if (sticker.description && sticker.description.includes(emotion)) { emotionScore += 3; }

      // v0.27.0 方言×表情包联动：有情绪命中才参与（关键词/场景独立查询不受干扰）
      if (emotionScore > 0 && bias) {
        emotionScore *= resolveEmotionFactor(emotionHitTags, bias);
        const intensity = sticker._source?.intensity;
        if (intensity && bias.intensity && bias.intensity[intensity] !== undefined) {
          emotionScore += bias.intensity[intensity];
        }
      }

      // v0.25.0 - 偏好加权统一走 prefsScoreBonus（preferred +10 / vetoed -20 / 不喜欢次数 -10×count）
      const score = emotionScore + prefsScoreBonus(sticker.id, prefs);

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
    },
    stickerId: {
      type: "string",
      description: "可选：指定要发送的表情包 ID（精确匹配）。有 stickerId 时跳过情绪匹配，直接发指定图，但仍走偏好与冷却检查。配合 search_stickers 用：先搜出 id，再主动发想发的那张。传 emotion 只是为了兼容 schema 与偏好加载（vetoed/不喜欢仍生效）。"
    }
  },
  required: ["emotion"]
};

export async function execute(input, ctx) {
  const { emotion, exclude_ids = [], stickerId } = input || {};
  if (!emotion) return reply({ ok: false, error: '请传入你想表达的情绪' });

  ctx?.log?.info?.(`[biaoqingbao] express 被调用: emotion="${emotion}"${stickerId ? `, stickerId="${stickerId}"` : ''}`);

  // 主动调用不再重复抽概率，只遵守每位助手的全局开关。
  const agentId = resolveAgentId(null, ctx);
  // v0.27.0 方言×表情包联动：按当前助手方言设置取气质权重（没开方言返回 null，不干预）
  const expressionBias = getAgentExpressionBias(agentId);
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

  // 加载偏好（v0.19.5 - 传入 agentId，偏好只属于当前助手）
  const prefs = await loadPreferencesFor(emotion, agentId);

  // v0.32.3 - stickerId 指定路径：跳过打分/向量匹配，直接用指定图
  // prefs.vetoed 仍生效（手动指定不是绕过偏好的后门），pushRecent/cooldown/logDecision 后面统一走
  let best = null;
  if (stickerId) {
    const found = stickers.find(s => s.id === stickerId);
    if (!found) {
      return reply({ ok: false, error: `未找到ID为 "${stickerId}" 的表情包` });
    }
    if (prefs.vetoed?.includes(found.id)) {
      ctx?.log?.info?.(`[biaoqingbao] stickerId 指定路径拒绝: ${found.id} 已被 vetoed`);
      return reply({ ok: false, error: `表情包 "${found.id}" 已被标记为不喜欢（vetoed），拒绝发送` });
    }
    best = { ...found, _score: 'manual' };
  } else {
    const allExclude = [...new Set([...(exclude_ids || []), ...getRecent(agentId)])];

    // 打分匹配（v0.27.0：传入方言气质权重）
    const scored = scoreStickers(stickers, emotion, allExclude, prefs, expressionBias);

    if (scored.length === 0) {
      // 放宽限制：不排除最近用过的，再试一次
      const relaxed = scoreStickers(stickers, emotion, [], prefs, expressionBias);
      scored.push(...relaxed);
    }

    // v0.19.5 - 修复：applyVectorScoring 原地修改 scored 并返回同一个引用，
    // 若先 length=0 再 push(...vectorScored) 会把结果一起清空（vectorScored === scored），
    // 导致永远走到 no_match。恢复原地修改语义，不回填。
    // v0.25.0 - applyVectorScoring 传入 prefs：向量补充通道同样应用偏好惩罚
    await applyVectorScoring(scored, stickers, emotion, allExclude, prefs);

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
    best = topN[Math.floor(Math.random() * topN.length)];
  }

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

  // 防重复（v0.19.5 - 按助手独立记录；发图确认后才写，见下方）

  ctx?.log?.info?.(`[biaoqingbao] express 选中: ${best.description} (score=${best._score})`);

  // stage 发图（v0.19.5 - await，确保拿到 mediaItem 而非 Promise）
  let mediaItem = null;
  let stageSuccess = false;
  try {
    mediaItem = await ctx.stageFile({ filePath, sessionPath: ctx.sessionPath, label: best.description });
    stageSuccess = true;
  } catch (e) {
    ctx?.log?.warn?.('[biaoqingbao] stageFile 失败:', e.message);
  }

  // v0.19.5 - 记录移到发图确认之后：stage 成功或降级 base64 都算已发出
  pushRecent(agentId, best.id);
  await logDecision(emotion, best.id, ctx);
  markAgentStickerCooldown(agentId);

  if (stageSuccess && mediaItem) {
    // 当前公开 ToolContext 没有宿主版本字段，只读取 Hana 本机 server-info。
    const hostVersion = await readHanaAppVersion();
    // v0.33.2 - 0.679+ 优先走 deferred 原生图片块（聊天流直接显示原图）；
    // 通道不可用（旧版 Hana / bus 无此方法）自动降级到 media / iframe 卡片协议。
    const deferredResult = await trySendDeferredImage(ctx, mediaItem);
    const deferredOk = deferredResult.ok === true;
    const useNativeMedia = supportsNativeMediaDetails(hostVersion);
    let size;
    let smart = true;
    if (!deferredOk && !useNativeMedia) {
      // 旧版卡片继续使用原有尺寸协议，避免向下兼容时退回大白卡。
      size = imageSizeFromBuffer(buffer);
      try {
        const cfg = JSON.parse(await readFile(join(dataDir, 'display-config.json'), 'utf8'));
        smart = cfg.smallImageFit !== false;
      } catch {}
    }
    const cardOptions = {
      id: best.id,
      description: best.description,
      score: best._score,
      emotion,
      agentId,
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      sessionPath: ctx.sessionPath,
      size,
      smart,
    };
    const details = deferredOk
      ? buildStickerMediaDetails(mediaItem, deferredResult.taskId)
      : buildStickerDeliveryDetails(mediaItem, cardOptions, hostVersion);
    const delivery = deferredOk ? 'deferred' : (useNativeMedia ? 'media' : 'card');
    await recordRecentMatch({
      dataDir,
      ctx,
      stickerId: best.id,
      description: best.description,
      emotion,
      agentId,
      ts: Date.now(),
      delivery,
    }).catch((error) => ctx?.log?.warn?.('[biaoqingbao] 最近配图记录失败:', error?.message || error));
    ctx?.log?.debug?.(`[biaoqingbao] express 交付协议: ${delivery}${hostVersion ? ` (Hana ${hostVersion})` : ' (未知版本)'}`);
    return {
      content: [{ type: 'text', text: `已发送表情包「${best.description}」（匹配度 ${best._score}）` }],
      details,
    };
  }

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
