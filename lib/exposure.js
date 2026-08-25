// 表情包曝光账本与探索重排。
// 曝光记录独立于 preferences.json：用户没反馈不等于不喜欢，系统只记录图片是否真正送达。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const EXPOSURE_FILE_NAME = 'exposure-stats.json';
export const EXPOSURE_VERSION = 2;
export const HISTORICAL_DEDUPE_WINDOW_MS = 5 * 1000;
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FRESH_EXPOSURE_CAP = 3;
export const FRESH_MAX_BONUS = 3;
export const UNSEEN_MAX_BONUS = 1;
export const UNDEREXPOSED_MAX_BONUS = 0.5;
export const EXPLORATION_RATE = 0.2;
export const EXPLORATION_RELEVANCE_FLOOR = 0.65;

const writeChains = new Map();

function resolveDataDir(dataDir) {
  return path.resolve(dataDir || DATA_DIR);
}

function exposureFile(dataDir) {
  return path.join(resolveDataDir(dataDir), EXPOSURE_FILE_NAME);
}

function normalizeAgentId(value) {
  const id = String(value || 'default').trim();
  return id || 'default';
}

function normalizeStickerId(value) {
  return String(value || '').trim();
}

function emptyStats() {
  return { version: EXPOSURE_VERSION, byAgent: {} };
}

function normalizeStats(raw) {
  const stats = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : { version: 1, byAgent: {} };
  if (!Number.isFinite(Number(stats.version))) stats.version = 1;
  if (!stats.byAgent || typeof stats.byAgent !== 'object' || Array.isArray(stats.byAgent)) stats.byAgent = {};
  return stats;
}

function readJson(filePath, fallback = emptyStats()) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeHistoricalEvent({ agentId, stickerId, rawTs, sessionId = '', source = '' } = {}) {
  return {
    agentId: normalizeAgentId(agentId),
    stickerId: normalizeStickerId(stickerId),
    ts: timestampOf(rawTs),
    sessionId: String(sessionId || '').trim(),
    source,
  };
}

function sameHistoricalEvent(left, right) {
  return left?.agentId === right?.agentId
    && left?.stickerId === right?.stickerId
    && left?.sessionId
    && right?.sessionId
    && left.sessionId === right.sessionId
    && Math.abs(Number(left.ts) - Number(right.ts)) <= HISTORICAL_DEDUPE_WINDOW_MS;
}

function readHistoricalSources(dataDir) {
  const dir = resolveDataDir(dataDir);
  const decisions = readJson(path.join(dir, 'decision-log.json'), { entries: [] });
  const decisionEvents = (Array.isArray(decisions?.entries) ? decisions.entries : [])
    .filter((entry) => entry?.type === 'express' && entry?.decision === 'accepted')
    .map((entry) => normalizeHistoricalEvent({
      agentId: entry.agent || 'default',
      stickerId: entry.sticker_id,
      rawTs: entry.ts || entry.context_ts,
      sessionId: entry.session_id || entry.sessionId,
      source: 'decision',
    }))
    .filter((event) => event.stickerId);

  const recent = readJson(path.join(dir, 'recent-match.json'), { bySession: {} });
  const recentEvents = [];
  for (const [sessionId, records] of Object.entries(recent?.bySession || {})) {
    const list = Array.isArray(records) ? records : (records ? [records] : []);
    for (const record of list) {
      const event = normalizeHistoricalEvent({
        agentId: record?.agentId || 'default',
        stickerId: record?.stickerId,
        rawTs: record?.ts,
        sessionId: record?.sessionId || sessionId,
        source: 'recent',
      });
      if (event.stickerId) recentEvents.push(event);
    }
  }
  return { decisionEvents, recentEvents };
}

function appendHistoricalExposure(stats, event, seen) {
  if (!event?.stickerId) return;
  const key = `${event.agentId}|${event.stickerId}|${event.sessionId}|${event.ts}`;
  if (seen.has(key)) return;
  seen.add(key);
  const aid = event.agentId;
  const sid = event.stickerId;
  if (!stats.byAgent[aid] || typeof stats.byAgent[aid] !== 'object') stats.byAgent[aid] = {};
  const current = stats.byAgent[aid][sid];
  const at = new Date(event.ts).toISOString();
  stats.byAgent[aid][sid] = {
    exposureCount: Math.max(0, Number(current?.exposureCount) || 0) + 1,
    firstExposedAt: current?.firstExposedAt && Date.parse(current.firstExposedAt) <= event.ts ? current.firstExposedAt : at,
    lastExposedAt: current?.lastExposedAt && Date.parse(current.lastExposedAt) >= event.ts ? current.lastExposedAt : at,
  };
}

function findHistoricalDuplicatePairs(dataDir) {
  const { decisionEvents, recentEvents } = readHistoricalSources(dataDir);
  const matchedDecisionIndexes = new Set();
  const pairs = [];
  for (const recent of recentEvents) {
    const index = decisionEvents.findIndex((decision, candidateIndex) =>
      !matchedDecisionIndexes.has(candidateIndex) && sameHistoricalEvent(decision, recent));
    if (index < 0) continue;
    matchedDecisionIndexes.add(index);
    pairs.push({ decision: decisionEvents[index], recent });
  }
  return pairs;
}

function bootstrapHistoricalStats(dataDir) {
  const stats = emptyStats();
  const seen = new Set();
  const { decisionEvents, recentEvents } = readHistoricalSources(dataDir);
  for (const event of decisionEvents) appendHistoricalExposure(stats, event, seen);

  const matchedDecisionIndexes = new Set();
  for (const recent of recentEvents) {
    const index = decisionEvents.findIndex((decision, candidateIndex) =>
      !matchedDecisionIndexes.has(candidateIndex) && sameHistoricalEvent(decision, recent));
    if (index >= 0) {
      matchedDecisionIndexes.add(index);
      continue;
    }
    appendHistoricalExposure(stats, recent, seen);
  }
  return stats;
}

function repairLegacyStats(stats, dataDir) {
  let repaired = 0;
  for (const pair of findHistoricalDuplicatePairs(dataDir)) {
    const record = stats?.byAgent?.[pair.recent.agentId]?.[pair.recent.stickerId];
    if (!record || Number(record.exposureCount) <= 0) continue;
    record.exposureCount = Math.max(0, Number(record.exposureCount) - 1);
    repaired += 1;
  }
  return repaired;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function enqueue(filePath, task) {
  const previous = writeChains.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

export function readExposureStats({ dataDir = DATA_DIR } = {}) {
  const filePath = exposureFile(dataDir);
  if (!fs.existsSync(filePath)) {
    const migrated = bootstrapHistoricalStats(dataDir);
    const hasHistory = Object.values(migrated.byAgent).some((entries) => Object.keys(entries || {}).length > 0);
    if (hasHistory) {
      try { atomicWriteJson(filePath, migrated); } catch {}
    }
    return migrated;
  }

  const raw = readJson(filePath, { version: 1, byAgent: {} });
  const stats = normalizeStats(raw);
  if (Number(raw?.version) < EXPOSURE_VERSION) {
    repairLegacyStats(stats, dataDir);
    stats.version = EXPOSURE_VERSION;
    try { atomicWriteJson(filePath, stats); } catch {}
  } else {
    stats.version = EXPOSURE_VERSION;
  }
  return stats;
}

export function getExposureRecord(stats, agentId, stickerId) {
  const sid = normalizeStickerId(stickerId);
  if (!sid) return null;
  const agent = normalizeAgentId(agentId);
  const record = stats?.byAgent?.[agent]?.[sid];
  if (!record || typeof record !== 'object') return null;
  return {
    exposureCount: Math.max(0, Number(record.exposureCount) || 0),
    firstExposedAt: String(record.firstExposedAt || ''),
    lastExposedAt: String(record.lastExposedAt || ''),
  };
}

function parseAddedAt(sticker) {
  const time = Date.parse(String(sticker?.added_at || ''));
  return Number.isFinite(time) ? time : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/**
 * 计算一张图片的探索状态与加成。
 * 新图加成高于从未曝光旧图；加成有上限，并随时间/实际曝光次数衰减。
 */
export function explorationInfo(sticker, exposure = null, now = Date.now()) {
  const count = Math.max(0, Number(exposure?.exposureCount) || 0);
  const addedAt = parseAddedAt(sticker);
  const ageMs = addedAt === null ? null : Math.max(0, Number(now) - addedAt);
  const fresh = ageMs !== null && ageMs < FRESH_WINDOW_MS;

  if (fresh) {
    const ageFactor = clamp01(1 - ageMs / FRESH_WINDOW_MS);
    const exposureFactor = clamp01(1 - count / FRESH_EXPOSURE_CAP);
    const bonus = FRESH_MAX_BONUS * ageFactor * exposureFactor;
    if (bonus > 0.001) {
      return { kind: 'fresh', bonus, ageMs, exposureCount: count };
    }
  }

  if (count === 0) {
    return { kind: 'unseen', bonus: UNSEEN_MAX_BONUS, ageMs, exposureCount: count };
  }
  if (count < 2) {
    return { kind: 'underexposed', bonus: UNDEREXPOSED_MAX_BONUS, ageMs, exposureCount: count };
  }
  return { kind: 'ordinary', bonus: 0, ageMs, exposureCount: count };
}

/**
 * 在现有相关性排序之上做一次受预算约束的探索重排。
 * random/explorationRate 可注入，方便 node:test 做确定性回归。
 */
export function rerankWithExploration(
  scored,
  stickers,
  {
    stats = emptyStats(),
    agentId = 'default',
    blockedIds = [],
    now = Date.now(),
    random = Math.random,
    explorationRate = EXPLORATION_RATE,
    relevanceFloor = EXPLORATION_RELEVANCE_FLOOR,
  } = {},
) {
  if (!Array.isArray(scored) || scored.length === 0) {
    return { scored: Array.isArray(scored) ? scored : [], explored: false, kind: null };
  }

  const blocked = new Set(Array.isArray(blockedIds) ? blockedIds : []);
  const stickerMap = new Map((Array.isArray(stickers) ? stickers : []).map((item) => [item?.id, item]));
  const decorated = scored.map((item) => {
    const info = explorationInfo(
      stickerMap.get(item?.id) || item,
      getExposureRecord(stats, agentId, item?.id),
      now,
    );
    return { ...item, _baseScore: Number(item?._score) || 0, _explorationBonus: info.bonus, _explorationKind: info.kind };
  });

  const topBase = Math.max(...decorated.map((item) => item._baseScore).filter((value) => Number.isFinite(value)), 0);
  const floor = topBase * Math.max(0, Math.min(1, Number(relevanceFloor) || 0));
  const exploreCandidates = decorated.filter((item) =>
    item._explorationBonus > 0
    && item._baseScore > 0
    && item._baseScore >= floor
    && !blocked.has(item.id)
    && item._explorationKind !== 'ordinary'
  );
  if (exploreCandidates.length === 0 || Number(random()) >= Number(explorationRate)) {
    return {
      scored: decorated.map(({ _baseScore, _explorationBonus, _explorationKind, ...item }) => item),
      explored: false,
      kind: null,
    };
  }

  const exploredIds = new Set(exploreCandidates.map((item) => item.id));
  const reranked = decorated
    .map((item) => ({
      ...item,
      _score: item._baseScore + (exploredIds.has(item.id) ? item._explorationBonus : 0),
    }))
    .sort((a, b) => b._score - a._score);
  const selected = reranked.find((item) => exploredIds.has(item.id));
  return {
    scored: reranked,
    explored: true,
    kind: selected?._explorationKind || null,
  };
}

export function recordSuccessfulExposure({
  dataDir = DATA_DIR,
  agentId = 'default',
  stickerId,
  now = Date.now(),
} = {}) {
  const sid = normalizeStickerId(stickerId);
  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId' });
  const aid = normalizeAgentId(agentId);
  const filePath = exposureFile(dataDir);
  return enqueue(filePath, async () => {
    const stats = readExposureStats({ dataDir });
    if (!stats.byAgent[aid] || typeof stats.byAgent[aid] !== 'object' || Array.isArray(stats.byAgent[aid])) {
      stats.byAgent[aid] = {};
    }
    const previous = getExposureRecord(stats, aid, sid);
    const at = new Date(Number(now) || Date.now()).toISOString();
    stats.byAgent[aid][sid] = {
      exposureCount: (previous?.exposureCount || 0) + 1,
      firstExposedAt: previous?.firstExposedAt || at,
      lastExposedAt: at,
    };
    atomicWriteJson(filePath, stats);
    return { ok: true, agentId: aid, stickerId: sid, record: clone(stats.byAgent[aid][sid]) };
  });
}

export function removeStickerExposure({ dataDir = DATA_DIR, stickerId } = {}) {
  const sid = normalizeStickerId(stickerId);
  if (!sid) return Promise.resolve({ ok: true, removed: false });
  const filePath = exposureFile(dataDir);
  return enqueue(filePath, async () => {
    const stats = readExposureStats({ dataDir });
    let removed = false;
    for (const entries of Object.values(stats.byAgent)) {
      if (entries && typeof entries === 'object' && Object.prototype.hasOwnProperty.call(entries, sid)) {
        delete entries[sid];
        removed = true;
      }
    }
    if (removed) atomicWriteJson(filePath, stats);
    return { ok: true, removed };
  });
}

export { normalizeAgentId, normalizeStickerId };
