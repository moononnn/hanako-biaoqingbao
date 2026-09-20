// 表情包 · 对外索引（公开快照）
//
// 给别的消费者（比如茶话会这类 App）读的只读索引：图库里有什么、每个伙伴能发哪些、
// 哪些被偏好/被否掉、最近发过哪些。
//
// 三条纪律：
//   1. **不做挑选、不做评分**。挑图权在消费方，这里只摊平事实。
//   2. **不改动任何现有决策逻辑**。这是纯新增的一条出口，坏了也只坏这一条。
//   3. 格式冻结在 schemaVersion 上，内部账本怎么改都不影响这份门面。
//      契约文档见仓库根目录 PUBLIC-INDEX.md。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, META_FILE, PREFERENCES_FILE, atomicWriteJson } from './shared.js';
import { readGroupStore, filterStickersForAgent, getAgentGroupConfig } from './sticker-groups.js';

export const PUBLIC_INDEX_FILE_NAME = 'public-index.json';
export const PUBLIC_INDEX_SCHEMA_VERSION = 1;
/** 每个伙伴在索引里保留多少条最近发送记录（消费方拿去去重用）。 */
export const PUBLIC_INDEX_RECENT_LIMIT = 60;

const DESCRIPTION_LIMIT = 80;
const TEXT_LIMIT = 24;
/** 去抖窗口：短时间内的多次刷新请求合成一次写盘。 */
const SCHEDULE_DEBOUNCE_MS = 2000;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function cleanTagList(value) {
  return asArray(value).map((item) => cleanText(item, TEXT_LIMIT)).filter(Boolean);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function publicIndexPath(dataDir = DATA_DIR) {
  return path.join(dataDir, PUBLIC_INDEX_FILE_NAME);
}

/** 把 preferences.json 摊平成「每个伙伴读过什么、否过什么」。 */
export function collectPreferences(preferences) {
  const out = {};
  const users = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? preferences.users
    : null;
  if (!users || typeof users !== 'object') return out;
  for (const [agentId, user] of Object.entries(users)) {
    if (!agentId || !user || typeof user !== 'object') continue;
    const preferred = new Set();
    const vetoed = new Set();
    for (const mapping of asArray(user.mappings)) {
      if (!mapping || typeof mapping !== 'object') continue;
      for (const id of asArray(mapping.preferred_ids)) {
        const clean = cleanText(id, 120);
        if (clean) preferred.add(clean);
      }
      for (const id of asArray(mapping.vetoed_ids)) {
        const clean = cleanText(id, 120);
        if (clean) vetoed.add(clean);
      }
    }
    // 明确否掉的优先于偏好：两边都在时，否决算数。
    for (const id of vetoed) preferred.delete(id);
    out[agentId] = { preferred: [...preferred], vetoed: [...vetoed] };
  }
  return out;
}

/** 把 recent-match.json 的 bySession 摊平成按伙伴分组的最近发送记录（新的在前）。 */
export function collectRecent(recentMatches, limit = PUBLIC_INDEX_RECENT_LIMIT) {
  const bySession = recentMatches && typeof recentMatches === 'object' && !Array.isArray(recentMatches)
    ? recentMatches.bySession
    : null;
  const flat = [];
  if (bySession && typeof bySession === 'object') {
    for (const record of Object.values(bySession)) {
      const rows = Array.isArray(record) ? record : (record && typeof record === 'object' ? [record] : []);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const stickerId = cleanText(row.stickerId, 120);
        const agentId = cleanText(row.agentId, 100);
        if (!stickerId || !agentId) continue;
        flat.push({ stickerId, agentId, ts: Number(row.ts) || 0 });
      }
    }
  }
  flat.sort((a, b) => b.ts - a.ts);
  const out = {};
  for (const row of flat) {
    const list = out[row.agentId] || (out[row.agentId] = []);
    if (list.length >= Math.max(1, Number(limit) || PUBLIC_INDEX_RECENT_LIMIT)) continue;
    if (list.includes(row.stickerId)) continue;
    list.push(row.stickerId);
  }
  return out;
}

/**
 * 纯函数：把原始数据摊平成对外索引。
 * @param {object} input
 * @param {Array}  input.meta           stickers.json 的原始数组
 * @param {object} input.groupStore     sticker-groups.json 的原始对象
 * @param {object} input.preferences    preferences.json 的原始对象
 * @param {object} input.recentMatches  recent-match.json 的原始对象
 * @param {string[]} [input.agentIds]   额外要出现在索引里的伙伴（比如启动时扫到的）
 */
export function buildPublicIndex({
  meta,
  groupStore,
  preferences,
  recentMatches,
  agentIds = [],
  generatedAt = new Date().toISOString(),
  recentLimit = PUBLIC_INDEX_RECENT_LIMIT,
} = {}) {
  const source = Array.isArray(meta) ? meta.filter((item) => item && typeof item === 'object' && item.id) : [];
  const stickers = source.map((item) => ({
    id: cleanText(item.id, 120),
    file: `stickers/${cleanText(item.file, 200)}`,
    emotion: cleanTagList(item.tags?.emotion),
    scene: cleanTagList(item.tags?.scene),
    keywords: cleanTagList(item.tags?.keywords),
    description: cleanText(item.description, DESCRIPTION_LIMIT),
  }));

  const prefs = collectPreferences(preferences);
  const recent = collectRecent(recentMatches, recentLimit);

  const ids = new Set();
  for (const id of Array.isArray(agentIds) ? agentIds : []) {
    const clean = cleanText(id, 100);
    if (clean) ids.add(clean);
  }
  for (const id of Object.keys(prefs)) ids.add(id);
  for (const id of Object.keys(recent)) ids.add(id);
  const groupAgents = groupStore && typeof groupStore === 'object' && groupStore.agents && typeof groupStore.agents === 'object'
    ? Object.keys(groupStore.agents)
    : [];
  for (const id of groupAgents) {
    const clean = cleanText(id, 100);
    if (clean) ids.add(clean);
  }

  const partners = {};
  for (const id of [...ids].sort()) {
    const config = getAgentGroupConfig(groupStore, id);
    const allowed = filterStickersForAgent(source, id, groupStore)
      .map((item) => cleanText(item.id, 120))
      .filter(Boolean);
    partners[id] = {
      configured: config.configured === true,
      allowed,
      preferred: (prefs[id]?.preferred || []).filter((sid) => allowed.includes(sid)),
      vetoed: prefs[id]?.vetoed || [],
      recent: recent[id] || [],
    };
  }

  return {
    schemaVersion: PUBLIC_INDEX_SCHEMA_VERSION,
    generatedAt,
    stickerCount: stickers.length,
    stickers,
    partners,
  };
}

/** 读盘 + 摊平 + 原子写回 public-index.json。返回索引对象（即使写失败也返回内容）。 */
export function writePublicIndex({ dataDir = DATA_DIR, agentIds = [], now = new Date() } = {}) {
  const index = buildPublicIndex({
    meta: readJson(path.join(dataDir, 'stickers.json'), []),
    groupStore: readGroupStore(dataDir),
    preferences: readJson(path.join(dataDir, 'preferences.json'), { version: 1, users: {} }),
    recentMatches: readJson(path.join(dataDir, 'recent-match.json'), { version: 2, bySession: {} }),
    agentIds,
    generatedAt: now.toISOString(),
  });
  atomicWriteJson(publicIndexPath(dataDir), index);
  return index;
}

let scheduleTimer = null;
let scheduledArgs = null;

/**
 * 去抖刷新。任何改动图库/分组/偏好/最近发送的地方都可以fire-and-forget地喊一声，
 * 短时间内多次调用只写一次盘。失败绝不外抛——这条出口坏了不能反噬主流程。
 */
export function schedulePublicIndex({ dataDir = DATA_DIR, agentIds = [] } = {}) {
  scheduledArgs = { dataDir, agentIds: agentIds.length ? agentIds : (scheduledArgs?.agentIds || []) };
  if (scheduleTimer) return;
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    const args = scheduledArgs;
    scheduledArgs = null;
    try {
      writePublicIndex(args);
    } catch {
      // 对外索引刷新失败不影响表情包自身。
    }
  }, SCHEDULE_DEBOUNCE_MS);
  if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
}

/** 仅供测试：清掉待执行的去抖任务。 */
export function __cancelScheduledPublicIndex() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
  scheduledArgs = null;
}
