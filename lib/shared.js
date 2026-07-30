// 表情包插件 - 公共函数模块
// 从 api.js / _batch-tasks.js / ui.js / express.js / observer.js 中提取的重复代码
// 所有路径基于插件根目录计算，不含任何硬编码用户路径

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { prepareVisionImages } from './gif-frames.js';

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

export function writeMeta(d) {
  ensureDataDir();
  fs.writeFileSync(META_FILE, JSON.stringify(d, null, 2), 'utf-8');
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
  ensureDataDir();
  fs.writeFileSync(VISION_CFG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
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
export const AUTOTAG_PROMPT = `分析这张表情包图片，为它生成管理标签。仔细观察图片内容、表情、动作、文字、风格。

只返回纯JSON对象，不要其他任何文字，不要用代码块包裹：

{"description":"","semantic_description":"","emotion":[],"scene":[],"keywords":[],"atmosphere":[]}

字段要求：
- description：一句话描述这张图的具体内容和给人的感觉（10-25字）
- semantic_description：以"这张表情包在聊天中回复什么"为中心，综合原图内容、文字梗、动作变化、说话视角、复合语气和触发场景，生成30-50字的语义描述。例如："猫咪一脸委屈地低头认错，适合犯错后道歉或被批评时发，又可怜又好笑"
- emotion：1-3个具体情绪词（如：委屈、撒娇、得意、社死）
- scene：适用对话场景，每个不超过4个字（如：催回复、吐槽、早安、安慰）
- keywords：4-8个画面元素词（动物种类、动作、表情、文字等）
- atmosphere：1-3个风格词（如：沙雕、治愈、温馨、俏皮）

重要：不要返回模板里的空值，必须根据图片实际内容填写。`;

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
    const prompt = prepared.animated
      ? AUTOTAG_PROMPT + `\n\n以下 ${prepared.images.length} 张图按时间顺序截取自同一个动态 GIF（原动画共 ${prepared.totalFrames} 帧）。请综合前后变化理解完整动作和梗，不要只描述第一帧。`
      : AUTOTAG_PROMPT;
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

    return {
      ok: true,
      data: {
        description: String(tags.description || '').trim(),
        semantic_description: String(tags.semantic_description || '').trim(),
        emotion: Array.isArray(tags.emotion) ? tags.emotion.map(s => String(s).trim()).filter(Boolean) : [],
        scene: Array.isArray(tags.scene) ? tags.scene.map(s => String(s).trim()).filter(Boolean) : [],
        keywords: Array.isArray(tags.keywords) ? tags.keywords.map(s => String(s).trim()).filter(Boolean) : [],
        atmosphere: Array.isArray(tags.atmosphere) ? tags.atmosphere.map(s => String(s).trim()).filter(Boolean) : [],
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
  ensureDataDir();
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
  fs.writeFileSync(EMBEDDING_CFG_FILE, JSON.stringify(clean, null, 2), 'utf-8');
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
    const embeddings = (data.data || []).map(d => d.embedding).filter(Boolean);
    if (embeddings.length === 0) {
      return { ok: false, error: 'Embedding API 返回空向量' };
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
  ensureDataDir();
  fs.writeFileSync(VECTORS_FILE, JSON.stringify(data), 'utf-8');
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
  ensureDataDir();
  fs.writeFileSync(TEXT_CFG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
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
  ensureDataDir();
  agentFreqCache = normalizeAgentFreqConfig(config);
  fs.writeFileSync(AGENT_FREQ_FILE, JSON.stringify(agentFreqCache, null, 2), 'utf-8');
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
