// report-bad-match.js — 表情包配图反馈工具（v0.9）
// 同时支持正向反馈（"这个我喜欢"）和负向反馈（"这图不合适"）
// 记录到偏好记忆库、决策日志、bad-matches 兼容库
//
// v0.9 改动：
//   - 新增 feedback_type 参数：positive（喜欢）/ negative（不喜欢）
//   - 正向反馈记录到 preferences.json（preferred_ids）
//   - 负向反馈记录到 preferences.json（vetoed_ids）+ bad-matches.json（兼容）
//   - 两种反馈都记 decision-log.json

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentId, atomicWriteJson } from '../lib/shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STICKERS_FILE = join(DATA_DIR, 'stickers.json');
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
  atomicWriteJson(PREFERENCES_FILE, data);
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
  atomicWriteJson(DECISION_LOG_FILE, data);
}

// ── 获取当前 agent ID（v0.19.5 - 统一走 resolveAgentId，与 express 一致，避免反馈落到 unknown）──
function getAgentId(ctx) {
  return resolveAgentId(null, ctx);
}

// ── 查找或创建用户的偏好映射 ──
function ensureUserMapping(prefs, agentId, emotion, keywords) {
  if (!prefs.users[agentId]) {
    prefs.users[agentId] = { mappings: [] };
  }
  const user = prefs.users[agentId];
  const kwList = keywords || [];
  const sortedKws = [...kwList].sort();

  // 找已有映射（同 emotion + 关键词重叠；v0.19.5 - 双方都无关键词也算匹配，避免重复新建）
  let mapping = user.mappings.find(m => {
    if (m.context.emotion !== emotion) return false;
    const mKws = m.context.keywords || [];
    if (kwList.length === 0 && mKws.length === 0) return true;
    return sortedKws.some(k => mKws.includes(k)) && mKws.some(k => sortedKws.includes(k));
  });

  if (!mapping) {
    mapping = {
      context: { emotion, keywords: kwList },
      preferred_ids: [],
      vetoed_ids: [],
      dislike_counts: {},
      weight: 1,
      updated_at: new Date().toISOString()
    };
    user.mappings.push(mapping);
  } else {
    // 旧数据兼容：没有 dislike_counts 时补上
    if (!mapping.dislike_counts) mapping.dislike_counts = {};
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
  // v0.25.0 - 严格校验：非法 ID / 非法反馈类型直接拒绝，不再静默走错分支
  const sid = typeof sticker_id === 'string' ? sticker_id.trim() : '';
  if (!sid) return reply({ ok: false, error: '缺少 sticker_id' });
  if (feedback_type !== undefined && feedback_type !== 'positive' && feedback_type !== 'negative') {
    return reply({ ok: false, error: 'feedback_type 必须是 positive 或 negative' });
  }
  const fbType = feedback_type || 'negative';
  if (typeof context_keywords !== 'undefined' && typeof context_keywords !== 'string') {
    return reply({ ok: false, error: 'context_keywords 必须是字符串' });
  }
  // v0.25.0 - 校验 sticker 真实存在：空库 / 非法 ID 直接拒绝，防脏数据进偏好库
  try {
    const raw = await readFile(STICKERS_FILE, 'utf-8');
    const stickers = JSON.parse(raw);
    if (!stickers.some(s => s.id === sid)) return reply({ ok: false, error: '表情包不存在: ' + sid });
  } catch {
    return reply({ ok: false, error: '表情包库读取失败，请稍后再试' });
  }

  const agentId = getAgentId(ctx);
  const kwList = context_keywords
    ? context_keywords.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const emotion = context_emotion || '';

  ctx?.log?.info?.(`[biaoqingbao] 反馈: sticker=${sid} type=${feedback_type} agent=${agentId}`);

  // ── 1. 写偏好记忆库 ──
  const prefs = await loadPreferences();
  const mapping = ensureUserMapping(prefs, agentId, emotion, kwList);

  if (fbType === 'negative') {
    // v0.25.0 - 不喜欢改为累计计数（多轮不喜欢 → 频率衰减），不再写入 vetoed 硬拉黑
    // 历史 vetoed 数据保留硬排除语义（-20），不迁移
    mapping.preferred_ids = mapping.preferred_ids.filter(id => id !== sid);
    mapping.dislike_counts = mapping.dislike_counts || {};
    mapping.dislike_counts[sid] = (mapping.dislike_counts[sid] || 0) + 1;
  } else {
    // positive —— 从 vetoed 中移除（如果之前拉黑过），清零不喜欢次数，加入 preferred
    mapping.vetoed_ids = mapping.vetoed_ids.filter(id => id !== sid);
    if (mapping.dislike_counts) delete mapping.dislike_counts[sid];
    if (!mapping.preferred_ids.includes(sid)) {
      mapping.preferred_ids.push(sid);
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
      if (r.sticker_id !== sid) continue;
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
        sticker_id: sid,
        context_keywords: kwList,
        context_emotion: emotion,
        reason: reason || '',
        count: 1,
        created_at: new Date().toISOString(),
        last_occurrence: new Date().toISOString()
      });
    }
    try {
      atomicWriteJson(BAD_MATCHES_FILE, bmData);
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
        atomicWriteJson(MISSING_CATS_FILE, mcData);
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
    sticker_id: sid,
    emotion,
    keywords: kwList,
    reason: reason || '',
  });
  // 只保留最近 500 条
  if (log.entries.length > 500) log.entries = log.entries.slice(-500);
  await saveDecisionLog(log);

  const msg = feedback_type === 'positive'
    ? '已记住，以后类似情景优先推荐这张图'
    : `已记录，以后类似情景会少配这张图（累计 ${mapping.dislike_counts?.[sid] || 1} 次）`;

  return reply({
    ok: true,
    data: {
      sticker_id: sid,
      feedback_type,
      message: msg
    }
  });
}
