// 表情包插件 - 公共函数模块
// 从 api.js / _batch-tasks.js / ui.js / express.js / observer.js 中提取的重复代码
// 所有路径基于插件根目录计算，不含任何硬编码用户路径

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { prepareVisionImages } from './gif-frames.js';
import { buildConfusableSection } from './known-confusables.js';
import { findTeachingMatch, mergeTeachingKeywords, buildTeachingText, buildTeachingNameList } from './teaching.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(__dirname, '..');

// ── 路径常量 ──
export const STICKERS_DIR = path.join(PLUGIN_ROOT, 'stickers');
export const DATA_DIR = path.join(PLUGIN_ROOT, 'data');
export const META_FILE = path.join(DATA_DIR, 'stickers.json');
export const VISION_CFG_FILE = path.join(DATA_DIR, 'vision-config.json');
export const TEXT_CFG_FILE = path.join(DATA_DIR, 'text-config.json');
export const EMBEDDING_CFG_FILE = path.join(DATA_DIR, 'embedding-config.json');
export const VECTORS_FILE = path.join(DATA_DIR, 'vectors.json');
export const PREFERENCES_FILE = path.join(DATA_DIR, 'preferences.json');
export const DECISION_LOG_FILE = path.join(DATA_DIR, 'decision-log.json');
export const AGENT_FREQ_FILE = path.join(DATA_DIR, 'agent-freq.json');
export const BLOCKED_FILE = path.join(DATA_DIR, 'blocked-agents.json');

export const HANA_HOME = process.env.HANA_HOME || path.join(homedir(), '.hanako');
export const MODELS_JSON = path.join(HANA_HOME, 'models.json');

export function resolveAgentId(event, ctx) {
  if (event?.agentId) return event.agentId;
  if (event?.agent?.id) return event.agent.id;
  if (ctx?.agentId) return ctx.agentId;
  if (ctx?.agent?.id) return ctx.agent.id;
  const sessionPath = ctx?.sessionManager?.sessionFile || ctx?.sessionManager?.sessionDir || ctx?.sessionPath;
  if (typeof sessionPath === 'string') {
    const match = sessionPath.match(/[\\/]agents[\\/]([^\\/]+)/);
    if (match) return match[1];
  }
  if (ctx?.cwd) {
    const match = String(ctx.cwd).match(/[\\/]agents[\\/]([^\\/]+)/);
    if (match) return match[1];
  }
  return 'unknown';
}
export const PROVIDER_CATALOG = path.join(HANA_HOME, 'provider-catalog.json');
export const SERVER_INFO = path.join(HANA_HOME, 'server-info.json');

export const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
};

// ── JSON 响应辅助 ──
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── 元数据读写 ──
export function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); }
  catch { return []; }
}

// 原子写：先写临时文件再 rename，避免断电/崩溃留下半截 JSON
// v0.19.5 - 统一应用到图库、向量、偏好、频率等数据文件
// O3: rename 失败时清理残留 tmp；fsync 对本地插件场景可不做（进程崩溃由 OS flush 兜底）
export function atomicWriteJson(file, data) {
  ensureDataDir();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeMeta(d) {
  atomicWriteJson(META_FILE, d);
}

// ── 确保 data 目录存在 ──
export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── ID 生成（统一格式：stk_NNN，找当前最大值 +1）──
export function genId() {
  const m = readMeta();
  let max = 0;
  for (const s of m) {
    const n = parseInt(String(s.id).replace(/^stk_/, '').replace(/^sticker_/, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return 'stk_' + String(max + 1).padStart(3, '0');
}

// v0.25.2 - 工具层串行写队列：把「读 meta → 分配 id → 写文件 → 写 meta」整体串行化，
// 防多会话并发调用工具时分配到同一个 id（add_sticker 用；api 路由层已有自己的上传队列）
let toolWriteChain = Promise.resolve();
export function enqueueToolWrite(task) {
  const p = toolWriteChain.then(task, task);
  toolWriteChain = p.catch(() => {});
  return p;
}

// ════════════════════════════════════════════════════════════════
//  视觉模型配置
// ════════════════════════════════════════════════════════════════

const VISION_CFG_DEFAULT = {
  source: 'hana', providerId: '', modelId: '',
  customBaseUrl: '', customApiKey: '', customModel: ''
};

export function readVisionConfig() {
  try {
    return { ...VISION_CFG_DEFAULT, ...JSON.parse(fs.readFileSync(VISION_CFG_FILE, 'utf-8')) };
  } catch { return { ...VISION_CFG_DEFAULT }; }
}

export function writeVisionConfig(cfg) {
  atomicWriteJson(VISION_CFG_FILE, cfg);
}

export function getProviderApiConfig(providerId) {
  try {
    if (fs.existsSync(PROVIDER_CATALOG)) {
      const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG, 'utf-8'));
      const provider = catalog.providers?.[providerId];
      if (provider) {
        return {
          apiKey: provider.api_key || '',
          baseUrl: provider.base_url || provider.api_base || '',
        };
      }
    }
  } catch {}
  return { apiKey: '', baseUrl: '' };
}

export function resolveVisionApi() {
  const cfg = readVisionConfig();
  if (cfg.source === 'custom') {
    return { baseUrl: cfg.customBaseUrl, apiKey: cfg.customApiKey, model: cfg.customModel };
  }
  if (cfg.providerId) {
    const pc = getProviderApiConfig(cfg.providerId);
    return { baseUrl: pc.baseUrl, apiKey: pc.apiKey, model: cfg.modelId };
  }
  return { baseUrl: '', apiKey: '', model: '' };
}

export function getAvailableVisionModels() {
  const result = [];
  try {
    if (!fs.existsSync(MODELS_JSON)) return result;
    const catalog = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf-8'));
    for (const [pid, provider] of Object.entries(catalog.providers || {})) {
      const visionModels = (provider.models || []).filter(m => (m.input || []).includes('image'));
      if (visionModels.length === 0) continue;
      result.push({
        providerId: pid,
        providerName: provider.name || pid,
        models: visionModels.map(m => ({ id: m.id, name: m.name || m.id })),
      });
    }
  } catch {}
  return result;
}

export function getAvailableTextModels() {
  const result = [];
  try {
    if (!fs.existsSync(MODELS_JSON)) return result;
    const catalog = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf-8'));
    for (const [pid, provider] of Object.entries(catalog.providers || {})) {
      const textModels = (provider.models || []).filter(m => (m.input || []).includes('text'));
      if (textModels.length === 0) continue;
      result.push({
        providerId: pid,
        providerName: provider.name || pid,
        models: textModels.map(m => ({ id: m.id, name: m.name || m.id })),
      });
    }
  } catch {}
  return result;
}

// 检测当前视觉模型是否是 reasoning/thinking 模型
export function isReasoningModel() {
  const cfg = readVisionConfig();
  if (cfg.source === 'custom') return true;
  if (!cfg.providerId || !cfg.modelId) return true;
  try {
    const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG, 'utf-8'));
    const models = catalog.providers?.[cfg.providerId]?.models || [];
    const m = models.find(x => (typeof x === 'string' ? x : x.id) === cfg.modelId);
    if (m && typeof m !== 'string' && m.reasoning !== undefined) return m.reasoning === true;
  } catch {}
  try {
    const mcatalog = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf-8'));
    const provider = mcatalog.providers?.[cfg.providerId];
    if (provider) {
      const m2 = (provider.models || []).find(x => x.id === cfg.modelId);
      if (m2 && m2.reasoning !== undefined) return m2.reasoning === true;
    }
  } catch {}
  return true;
}

// ── 识图 prompt（统一版本）──
// v0.26.0：新增知名角色/梗图规则——画面里是知名角色、明星、网红、名梗、知名表情包系列时直接报名字
//   （如虹夏、月薪喵、熊猫头、猫meme），同时保留外观描述词（两者都写，搜名字搜描述都找得到）；
//   防幻觉升级：报名字前先核对至少两个独有特征（发型/瞳色/服装/系列格式），对不上只写外观不瞎猜；
//   高相似度角色（如爱音/波奇）走 known-confusables.js 对照表，具体辨别要点直接喂给模型。
const CONFUSABLE_SECTION = buildConfusableSection();
export const AUTOTAG_PROMPT = `分析这张表情包图片，为它生成管理标签。仔细观察图片内容、表情、动作、文字、风格。

只返回纯JSON对象，不要其他任何文字，不要用代码块包裹：

{"description":"","semantic_description":"","emotion":[],"scene":[],"keywords":[],"atmosphere":[]}

字段要求：
- description：一句话描述这张图的具体内容和给人的感觉（10-25字）。画面里是知名角色/明星/网红/知名表情包系列时，优先用名字指代，如「虹夏震惊地睁大眼睛，表情夸张可爱」或「熊猫头一脸无辜地配着我不是我没有」
- semantic_description：以"这张表情包在聊天中回复什么"为中心，综合原图内容、文字梗、动作变化、说话视角、复合语气和触发场景，生成30-50字的语义描述。例如："猫咪一脸委屈地低头认错，适合犯错后道歉或被批评时发，又可怜又好笑"
- emotion：1-3个具体情绪词（如：委屈、撒娇、得意、社死）
- scene：适用对话场景，每个不超过4个字（如：催回复、吐槽、早安、安慰）
- keywords：4-8个画面元素词（动物种类、动作、表情、文字等）。画面里是知名动漫角色、明星、网红、知名梗图或表情包系列时，必须把角色名、梗名或系列名作为关键词打出（如「虹夏」「月薪喵」「猫meme」「熊猫头」），外观描述词同样保留，两者都写
- atmosphere：1-3个风格词（如：沙雕、治愈、温馨、俏皮）

重要：不要返回模板里的空值，必须根据图片实际内容填写。
${CONFUSABLE_SECTION ? `${CONFUSABLE_SECTION}
` : ''}防幻觉：报名字前先在心里核对至少两个独有特征（发型、瞳色、服装、配饰、标志物、系列格式），对得上才写名字；对不上或拿不准，只写外观描述，不要猜测。`;

// ── 单图识图（异步，供 api.js 和 _batch-tasks.js 复用）──
export async function tagImage(imageBase64, fileName) {
  const { baseUrl, apiKey, model } = resolveVisionApi();
  if (!apiKey || !baseUrl || !model) {
    return { ok: false, error: '未配置视觉模型，请先在设置里选择或填写模型' };
  }
  const reasoning = isReasoningModel();
  const maxTokens = reasoning === false ? 1200 : 2500;

  try {
    const prepared = await prepareVisionImages(imageBase64, fileName);
    // v0.26.0 - 教学名单注入：用户教过的命名（最近 30 条）随 prompt 喂给视觉模型对照，
    // 让模型直接认出「这是呆猫八条」，比识别后文本向量匹配更准（同角色不同表情也能认）
    const teachingList = buildTeachingNameList();
    const basePrompt = teachingList ? `${AUTOTAG_PROMPT}\n\n${teachingList}` : AUTOTAG_PROMPT;
    const prompt = prepared.animated
      ? basePrompt + `\n\n以下 ${prepared.images.length} 张图按时间顺序截取自同一个动态 GIF（原动画共 ${prepared.totalFrames} 帧）。请综合前后变化理解完整动作和梗，不要只描述第一帧。`
      : basePrompt;
    const visionContent = [
      { type: 'text', text: prompt },
      ...prepared.images.map(url => ({ type: 'image_url', image_url: { url } })),
    ];

    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: visionContent,
        }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(prepared.animated ? 120000 : 60000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `模型返回 HTTP ${resp.status}: ${text.substring(0, 200)}` };
    }

    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || '';
    const finishReason = data.choices?.[0]?.finish_reason || '';

    // reasoning 模型 fallback：content 为空时，从 reasoning_content 提取 JSON 块
    if (!content.trim() && reasoningContent) {
      const matches = [...reasoningContent.matchAll(/\{[\s\S]*?\}/g)];
      for (let i = matches.length - 1; i >= 0; i--) {
        const candidate = matches[i][0];
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && (parsed.description || parsed.emotion || parsed.scene || parsed.keywords)) {
            content = candidate;
            break;
          }
        } catch {}
      }
      if (!content.trim()) {
        const greedy = reasoningContent.match(/\{[\s\S]*\}/);
        if (greedy) content = greedy[0];
      }
    }

    let tags = null;
    try { tags = JSON.parse(content); } catch {}
    if (!tags) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { tags = JSON.parse(m[0]); } catch {} }
    }
    if (!tags) {
      return {
        ok: false,
        error: reasoning === true
          ? `thinking 模型未输出 JSON（finish_reason=${finishReason}），请尝试换非思考型视觉模型`
          : '返回格式无法解析',
        raw: content.substring(0, 500),
      };
    }

    // v0.26.0 教学匹配：识别文本与用户教学样本对比，命中则把用户命名并进关键词
    // （用户改过一次标签的图，下次同类图识别自动带上用户教的名字）
    let teachingUsed = false;
    try {
      const matchText = buildTeachingText(tags.description || '', Array.isArray(tags.keywords) ? tags.keywords : [], tags.semantic_description || '');
      const match = matchText.trim() ? await findTeachingMatch(matchText) : null;
      if (match && match.sample) {
        const merged = mergeTeachingKeywords(Array.isArray(tags.keywords) ? tags.keywords : [], match.sample);
        if (merged.length !== (Array.isArray(tags.keywords) ? tags.keywords.length : 0)) {
          tags.keywords = merged;
          teachingUsed = true;
        }
      }
    } catch {}

    return {
      ok: true,
      data: {
        // v0.19.5 - 识图结果统一走 sanitizeTag 清洗（去控制字符/换行/引号），不再只 trim
        description: sanitizeTag(tags.description || '', 100),
        semantic_description: sanitizeTag(tags.semantic_description || '', 300),
        emotion: Array.isArray(tags.emotion) ? tags.emotion.map(s => sanitizeTag(s)).filter(Boolean) : [],
        scene: Array.isArray(tags.scene) ? tags.scene.map(s => sanitizeTag(s, 10)).filter(Boolean) : [],
        keywords: Array.isArray(tags.keywords) ? tags.keywords.map(s => sanitizeTag(s, 30)).filter(Boolean) : [],
        atmosphere: Array.isArray(tags.atmosphere) ? tags.atmosphere.map(s => sanitizeTag(s, 30)).filter(Boolean) : [],
        teaching_used: teachingUsed,
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  Embedding 向量检索
// ════════════════════════════════════════════════════════════════

// v0.18.0 - schema 与 vision/text 对齐：source='hana'/'custom'
// 老 'preset' 自动迁移到 'custom'（预填 SF 入口）
const EMBEDDING_CFG_DEFAULT = {
  source: 'hana', providerId: '', modelId: '',
  dimensions: 1024, customBaseUrl: '', customApiKey: '', customModel: '', customDimensions: 1024,
};

// 把老 'preset' schema 平滑迁移到新 schema（用户无感升级）
function migrateEmbeddingCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ...EMBEDDING_CFG_DEFAULT };
  const out = { ...EMBEDDING_CFG_DEFAULT, ...cfg };
  if (cfg.source === 'preset') {
    // 老预设 = 硅基流动 BAAI/bge-m3，转成 custom 预填
    out.source = 'custom';
    out.customBaseUrl = out.customBaseUrl || 'https://api.siliconflow.cn/v1';
    out.customModel = out.customModel || cfg.model || 'BAAI/bge-m3';
    out.customDimensions = out.customDimensions || cfg.dimensions || 1024;
  }
  // 老 schema 用 'model'，新 schema 用 'modelId'
  if (cfg.model && !cfg.modelId) out.modelId = cfg.model;
  if (out.source === 'hana' && !out.providerId && out.modelId && !out.customApiKey) {
    // 兼容老 'preset' 但未迁移的场景：留 modelId 让 UI 兜底
  }
  return out;
}

export function readEmbeddingConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(EMBEDDING_CFG_FILE, 'utf-8'));
    return migrateEmbeddingCfg(cfg);
  } catch { return { ...EMBEDDING_CFG_DEFAULT }; }
}

export function writeEmbeddingConfig(cfg) {
  // 写入时去掉迁移残留字段，保证磁盘是干净的 schema
  const clean = {
    source: cfg.source || 'hana',
    providerId: cfg.providerId || '',
    modelId: cfg.modelId || '',
    dimensions: cfg.dimensions || 1024,
    customBaseUrl: cfg.customBaseUrl || '',
    customApiKey: cfg.customApiKey || '',
    customModel: cfg.customModel || '',
    customDimensions: cfg.customDimensions || 1024,
  };
  atomicWriteJson(EMBEDDING_CFG_FILE, clean);
}

export function resolveEmbeddingApi(cfg) {
  if (!cfg) cfg = readEmbeddingConfig();
  if (cfg.source === 'custom') {
    return {
      baseUrl: cfg.customBaseUrl,
      apiKey: cfg.customApiKey,
      model: cfg.customModel,
      dimensions: cfg.customDimensions || 1024,
    };
  }
  // source === 'hana'
  const pc = getProviderApiConfig(cfg.providerId);
  return { baseUrl: pc.baseUrl, apiKey: pc.apiKey, model: cfg.modelId, dimensions: cfg.dimensions || 1024 };
}

// 自动发现 Hana 已配置的 embedding 模型
// 与 vision/text 一致：只读 models.json（用户主动勾选为「在用」的模型）
// 启发式筛选：id 含 bge/embed，且不是 reranker / 多模态 embedding
export function getAvailableEmbeddingModels() {
  const result = [];
  try {
    if (!fs.existsSync(MODELS_JSON)) return result;
    const catalog = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf-8'));
    for (const [pid, provider] of Object.entries(catalog.providers || {})) {
      const embedModels = (provider.models || []).filter(m => {
        const id = (m.id || '').toLowerCase();
        if (id.includes('rerank')) return false;
        if (id.includes('vl-embed') || id.includes('vision-embed') || id.includes('image-embed') || id.includes('audio-embed') || id.includes('video-embed')) return false;
        const isEmbed = id.includes('bge') || id.includes('embed');
        const hasTextInput = (m.input || []).includes('text');
        return isEmbed && hasTextInput;
      });
      if (embedModels.length === 0) continue;
      result.push({
        providerId: pid,
        providerName: provider.name || pid,
        models: embedModels.map(m => ({ id: m.id, name: m.name || m.id })),
      });
    }
  } catch {}
  return result;
}

export async function generateEmbeddings(texts) {
  const { baseUrl, apiKey, model } = resolveEmbeddingApi();
  if (!apiKey || !baseUrl || !model) {
    return { ok: false, error: '未配置 Embedding 模型' };
  }
  const input = Array.isArray(texts) ? texts : [texts];
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, error: `Embedding API HTTP ${resp.status}: ${t.substring(0, 200)}` };
    }
    const data = await resp.json();
    // v0.19.5 - 按 API 返回的 index 排序，避免个别实现乱序导致向量错位；d 可能为 null 用可选链
    const embeddings = (data.data || [])
      .slice()
      .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
      .map(d => d?.embedding)
      .filter(v => Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n)));
    if (embeddings.length === 0) {
      return { ok: false, error: 'Embedding API 返回空向量' };
    }
    if (embeddings.length !== input.length) {
      return { ok: false, error: `Embedding API 返回数量不一致（期望 ${input.length}，实际 ${embeddings.length}）` };
    }
    const dim = embeddings[0].length;
    for (const v of embeddings) {
      if (v.length !== dim) {
        return { ok: false, error: 'Embedding API 返回的向量维度不一致' };
      }
    }
    return { ok: true, data: embeddings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function readVectors() {
  try {
    return JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf-8'));
  } catch {
    return { version: 1, model: '', dimensions: 0, generated_at: '', vectors: {} };
  }
}

export function writeVectors(data) {
  atomicWriteJson(VECTORS_FILE, data);
}

// ════════════════════════════════════════════════════════════════
//  内容分析模型配置
// ════════════════════════════════════════════════════════════════

const TEXT_CFG_DEFAULT = {
  enabled: false, source: 'hana', providerId: '', modelId: '',
  customBaseUrl: '', customApiKey: '', customModel: ''
};

export function readTextConfig() {
  try {
    return { ...TEXT_CFG_DEFAULT, ...JSON.parse(fs.readFileSync(TEXT_CFG_FILE, 'utf-8')) };
  } catch { return { ...TEXT_CFG_DEFAULT }; }
}

export function writeTextConfig(cfg) {
  atomicWriteJson(TEXT_CFG_FILE, cfg);
}

// ════════════════════════════════════════════════════════════════
//  助手配图频率控制
// ════════════════════════════════════════════════════════════════

function clampFreq(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export function normalizeAgentFreqConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const defaultDaily = clampFreq(cfg.default_daily ?? cfg.default_freq, 50);
  const defaultTask = clampFreq(cfg.default_task, 20);
  const normalized = { version: 2, default_daily: defaultDaily, default_task: defaultTask, agents: {} };

  for (const [id, value] of Object.entries(cfg.agents || {})) {
    if (!id) continue;
    if (typeof value === 'number') {
      normalized.agents[id] = {
        enabled: value !== 0,
        daily: value === 0 ? defaultDaily : clampFreq(value, defaultDaily),
        task: defaultTask,
      };
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const daily = clampFreq(value.daily ?? value.overall, defaultDaily);
    const task = clampFreq(value.task, defaultTask);
    normalized.agents[id] = {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : !(daily === 0 && task === 0),
      daily,
      task,
    };
  }
  return normalized;
}

let agentFreqCache = null;

export function readAgentFreq() {
  if (agentFreqCache) return agentFreqCache;
  try {
    const raw = JSON.parse(fs.readFileSync(AGENT_FREQ_FILE, 'utf-8'));
    agentFreqCache = normalizeAgentFreqConfig(raw);
    if (Object.keys(raw?.agents || {}).length === 0) {
      try {
        const blocked = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf-8'));
        for (const id of (blocked.blockedIds || [])) {
          if (!agentFreqCache.agents[id]) {
            agentFreqCache.agents[id] = {
              enabled: false,
              daily: agentFreqCache.default_daily,
              task: agentFreqCache.default_task,
            };
          }
        }
      } catch {}
    }
  } catch {
    try {
      const blocked = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf-8'));
      const agents = {};
      for (const id of (blocked.blockedIds || [])) agents[id] = { enabled: false, daily: 50, task: 20 };
      agentFreqCache = normalizeAgentFreqConfig({ agents });
    } catch {
      agentFreqCache = normalizeAgentFreqConfig({});
    }
  }
  return agentFreqCache;
}

export function writeAgentFreq(config) {
  agentFreqCache = normalizeAgentFreqConfig(config);
  atomicWriteJson(AGENT_FREQ_FILE, agentFreqCache);
  return agentFreqCache;
}

export function getAgentFreqSettings(agentId) {
  const config = readAgentFreq();
  return config.agents[agentId] || {
    enabled: true,
    daily: config.default_daily,
    task: config.default_task,
  };
}

// express 真正发图后标记一次；下一个 context 消耗该标记，避免连续两轮都提示配图。
const agentCooldown = new Set();

export function markAgentStickerCooldown(agentId) {
  if (agentId) agentCooldown.add(agentId);
}

export function consumeAgentStickerCooldown(agentId) {
  if (!agentId || !agentCooldown.has(agentId)) return false;
  agentCooldown.delete(agentId);
  return true;
}

// ── HTML 转义（防止 XSS）──
export function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════
//  偏好与词匹配纯函数（v0.19.5 抽出，供 express / observer / 测试复用）
// ════════════════════════════════════════════════════════════════

// 标签文本清洗：去控制字符/换行/引号/反引号/$（收窄注入面），限制长度（识图结果与 observer 情绪共用）
export function sanitizeTag(raw, maxLen = 30) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')  // 控制字符（已含 \r \n \t）
    .replace(/[`$'"\[\]{}]/g, '')        // v0.19.5 - 模板字符串与引号注入面
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// 按情绪过滤某位助手自己的偏好映射（不串号：只收本助手的 mappings）
// v0.25.0 - 新增 dislikes：不喜欢累计次数（多轮不喜欢 → 频率衰减），跨映射同图次数相加
export function collectPrefsForEmotion(mappings, emotion) {
  const result = { preferred: [], vetoed: [], dislikes: {} };
  // v0.19.5 - 空情绪直接返回，避免 ctxEmotion.includes('') 恒真收集全部
  if (!emotion) return result;
  for (const m of (mappings || [])) {
    const ctxEmotion = m?.context?.emotion;
    if (ctxEmotion && (emotion.includes(ctxEmotion) || ctxEmotion.includes(emotion))) {
      result.preferred = result.preferred.concat(m.preferred_ids || []);
      result.vetoed = result.vetoed.concat(m.vetoed_ids || []);
      const dc = m.dislike_counts || {};
      for (const [id, count] of Object.entries(dc)) {
        if (count > 0) result.dislikes[id] = (result.dislikes[id] || 0) + count;
      }
    }
  }
  return result;
}

// v0.25.0 - 偏好对选图的分数加成（纯函数，标签通道与向量补充通道共用）
//   preferred +10（想多见）
//   vetoed   -20（历史硬拉黑，用户明确说过不喜欢的，保持强排除）
//   dislikes -5 × min(count, 5)（累计不喜欢四级梯度：1 次轻降频、2 次明显降频、3 次基本不出现、5 次以上彻底出局）
export function prefsScoreBonus(stickerId, prefs) {
  const p = prefs || {};
  let bonus = 0;
  if ((p.preferred || []).includes(stickerId)) bonus += 10;
  if ((p.vetoed || []).includes(stickerId)) bonus -= 20;
  const dc = (p.dislikes || {})[stickerId] || 0;
  if (dc > 0) bonus -= Math.min(dc, 5) * 5;
  return bonus;
}

// 问候词匹配：中文/日文词用包含判断，纯英文字母词用词边界（避免 this/while/something 误判 hi）
export function matchRitualWord(text, word) {
  if (/^[a-z]+$/.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  }
  return text === word || text.includes(word);
}
