// report-bad-match.js — 表情包配图反馈工具（v0.9）
// 同时支持正向反馈（"这个我喜欢"）和负向反馈（"这图不合适"）
// 记录到偏好记忆库、决策日志、bad-matches 兼容库
//
// v0.9 改动：
//   - 新增 feedback_type 参数：positive（喜欢）/ negative（不喜欢）
//   - 正向反馈记录到 preferences.json（preferred_ids）
//   - 负向反馈记录到 preferences.json（vetoed_ids）+ bad-matches.json（兼容）
//   - 两种反馈都记 decision-log.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BAD_MATCHES_FILE = join(DATA_DIR, 'bad-matches.json');
const PREFERENCES_FILE = join(DATA_DIR, 'preferences.json');
const DECISION_LOG_FILE = join(DATA_DIR, 'decision-log.json');
const MISSING_CATS_FILE = join(DATA_DIR, 'missing-categories.json');

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// ── 读写偏好记忆库 ──
async function loadPreferences() {
  try {
    return JSON.parse(await readFile(PREFERENCES_FILE, 'utf-8'));
  } catch {
    return { version: 1, users: {} };
  }
}

async function savePreferences(data) {
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await writeFile(PREFERENCES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ── 读写决策日志 ──
async function loadDecisionLog() {
  try {
    return JSON.parse(await readFile(DECISION_LOG_FILE, 'utf-8'));
  } catch {
    return { version: 1, entries: [] };
  }
}

async function saveDecisionLog(data) {
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await writeFile(DECISION_LOG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ── 获取当前 agent ID ──
function getAgentId(ctx) {
  return ctx?.agentId || ctx?.agent?.id || 'unknown';
}

// ── 查找或创建用户的偏好映射 ──
function ensureUserMapping(prefs, agentId, emotion, keywords) {
  if (!prefs.users[agentId]) {
    prefs.users[agentId] = { mappings: [] };
  }
  const user = prefs.users[agentId];
  const kwList = keywords || [];
  const sortedKws = [...kwList].sort();

  // 找已有映射（同 emotion + 关键词重叠）
  let mapping = user.mappings.find(m => {
    if (m.context.emotion !== emotion) return false;
    const mKws = m.context.keywords || [];
    return sortedKws.some(k => mKws.includes(k)) && mKws.some(k => sortedKws.includes(k));
  });

  if (!mapping) {
    mapping = {
      context: { emotion, keywords: kwList },
      preferred_ids: [],
      vetoed_ids: [],
      weight: 1,
      updated_at: new Date().toISOString()
    };
    user.mappings.push(mapping);
  } else {
    // 合并关键词
    const merged = [...new Set([...mapping.context.keywords, ...kwList])];
    mapping.context.keywords = merged;
  }
  return mapping;
}

export const name = "report_bad_match";
export const description = "记录用户对表情包的反馈（喜欢/不喜欢）。当用户说'这图不合适''这张不配'时调这个工具（feedback_type=negative），当用户说'这张我喜欢''这个图好'时也调这个工具（feedback_type=positive）。";

export const parameters = {
  type: "object",
  properties: {
    sticker_id: {
      type: "string",
      description: "表情包 ID"
    },
    feedback_type: {
      type: "string",
      enum: ["positive", "negative"],
      description: "反馈类型：positive = 用户说喜欢这张图，negative = 用户说不合适",
      default: "negative"
    },
    reason: {
      type: "string",
      description: "反馈原因。negative 时说明为什么不合适，positive 时说明为什么喜欢（可选）"
    },
    context_keywords: {
      type: "string",
      description: "对话里的关键词，逗号分隔，例如'下雨,大雨,天气'"
    },
    context_emotion: {
      type: "string",
      description: "当时的情绪分析结果，可选：搞笑/开心/难过/无语/感谢/鼓励"
    }
  },
  required: ["sticker_id", "feedback_type"]
};

export async function execute(input, ctx) {
  const { sticker_id, feedback_type, reason, context_keywords, context_emotion } = input || {};
  if (!sticker_id) return reply({ ok: false, error: '缺少 sticker_id' });
  // 默认 negative（向后兼容）
  const fbType = feedback_type || 'negative';

  const agentId = getAgentId(ctx);
  const kwList = context_keywords
    ? context_keywords.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const emotion = context_emotion || '';

  ctx?.log?.info?.(`[biaoqingbao] 反馈: sticker=${sticker_id} type=${feedback_type} agent=${agentId}`);

  // ── 1. 写偏好记忆库 ──
  const prefs = await loadPreferences();
  const mapping = ensureUserMapping(prefs, agentId, emotion, kwList);

  if (fbType === 'negative') {
    // 从 preferred 中移除（如果之前喜欢过）
    mapping.preferred_ids = mapping.preferred_ids.filter(id => id !== sticker_id);
    // 加入 vetoed（防止重复）
    if (!mapping.vetoed_ids.includes(sticker_id)) {
      mapping.vetoed_ids.push(sticker_id);
    }
  } else {
    // positive —— 从 vetoed 中移除（如果之前不喜欢过），加入 preferred
    mapping.vetoed_ids = mapping.vetoed_ids.filter(id => id !== sticker_id);
    if (!mapping.preferred_ids.includes(sticker_id)) {
      mapping.preferred_ids.push(sticker_id);
    }
  }
  mapping.weight = Math.min(10, mapping.weight + 1);
  mapping.updated_at = new Date().toISOString();
  await savePreferences(prefs);
  ctx?.log?.info?.(`[biaoqingbao] 偏好已更新: ${fbType}, mapping.weight=${mapping.weight}`);

  // ── 2. 兼容旧 bad-matches.json（仅 negative） ──
  if (fbType === 'negative') {
    let bmData;
    try {
      bmData = JSON.parse(await readFile(BAD_MATCHES_FILE, 'utf-8'));
    } catch {
      bmData = { records: [] };
    }
    let existing = null;
    for (const r of bmData.records) {
      if (r.sticker_id !== sticker_id) continue;
      const rkws = r.context_keywords || [];
      const overlap = kwList.filter(k => rkws.includes(k));
      if (overlap.length > 0 || (!kwList.length && !rkws.length)) {
        existing = r;
        break;
      }
    }
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.last_occurrence = new Date().toISOString();
      existing.reason = reason || existing.reason;
    } else {
      bmData.records.push({
        sticker_id,
        context_keywords: kwList,
        context_emotion: emotion,
        reason: reason || '',
        count: 1,
        created_at: new Date().toISOString(),
        last_occurrence: new Date().toISOString()
      });
    }
    try {
      await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await writeFile(BAD_MATCHES_FILE, JSON.stringify(bmData, null, 2), 'utf-8');
    } catch {}

    // 也记到缺图统计
    if (kwList.length > 0 || emotion) {
      try {
        const mcRaw = await readFile(MISSING_CATS_FILE, 'utf-8').catch(() => '{"categories":{}}');
        const mcData = JSON.parse(mcRaw);
        const sortedKws = [...kwList].sort().join('_') || 'unknown';
        const key = `${emotion || 'any'}_${sortedKws}`;
        if (!mcData.categories[key]) {
          mcData.categories[key] = {
            keywords: kwList, emotion, miss_count: 0, bad_match_count: 0, last_occurrence: new Date().toISOString()
          };
        }
        mcData.categories[key].bad_match_count = (mcData.categories[key].bad_match_count || 0) + 1;
        mcData.categories[key].last_occurrence = new Date().toISOString();
        await writeFile(MISSING_CATS_FILE, JSON.stringify(mcData, null, 2), 'utf-8');
      } catch {}
    }
  }

  // ── 3. 写决策日志 ──
  const log = await loadDecisionLog();
  log.entries.push({
    ts: new Date().toISOString(),
    agent: agentId,
    type: 'user_feedback',
    feedback_type,
    sticker_id,
    emotion,
    keywords: kwList,
    reason: reason || '',
  });
  // 只保留最近 500 条
  if (log.entries.length > 500) log.entries = log.entries.slice(-500);
  await saveDecisionLog(log);

  const msg = feedback_type === 'positive'
    ? '已记住，以后类似情景优先推荐这张图'
    : '已记录，以后类似情景不会再配这张图';

  return reply({
    ok: true,
    data: {
      sticker_id,
      feedback_type,
      message: msg
    }
  });
}
