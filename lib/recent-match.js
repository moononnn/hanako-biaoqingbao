// 纸飞机最近配图记录：每个对话保留最近若干条，不保存绝对路径。

import path from 'node:path';
import { DATA_DIR } from './shared.js';
import { createJsonStore } from './atomic-store/index.js';
import { readSessionIdFromFile } from './ball-core.js';

const stores = new Map();
const DELIVERY_TYPES = new Set(['deferred', 'card', 'media']);
// v0.33.48 - 每个会话保留最近 N 条配图记录（配图手帐需要看多条历史）
const MAX_RECENT_PER_SESSION = 20;

function asList(record) {
  // 迁移：旧格式 bySession[sid] = 单条对象 → 新格式数组（新的在前）
  if (Array.isArray(record)) return record;
  if (record && typeof record === 'object') return [record];
  return [];
}

function resolveDataDir(dataDir) {
  return path.resolve(dataDir || DATA_DIR);
}

function storeFor(dataDir) {
  const dir = resolveDataDir(dataDir);
  let store = stores.get(dir);
  if (!store) {
    store = createJsonStore({
      filePath: path.join(dir, 'recent-match.json'),
      defaults: { version: 1, bySession: {} },
    });
    stores.set(dir, store);
  }
  return store;
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeSessionId(value) {
  const id = cleanText(value, 180);
  return id || '';
}

export function sessionIdFromPath(sessionPath) {
  return normalizeSessionId(readSessionIdFromFile(sessionPath));
}

export function sessionIdFromContext(ctx) {
  return normalizeSessionId(
    ctx?.sessionId
      || ctx?.sessionRef?.id
      || sessionIdFromPath(ctx?.sessionPath),
  );
}

function safeDelivery(value) {
  const delivery = String(value || '').trim();
  return DELIVERY_TYPES.has(delivery) ? delivery : 'media';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function publicRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    stickerId: cleanText(record.stickerId, 120),
    description: cleanText(record.description, 160),
    emotion: cleanText(record.emotion, 60),
    agentId: cleanText(record.agentId, 100),
    ts: Number(record.ts) || 0,
    delivery: safeDelivery(record.delivery),
    feedback: ['positive', 'negative'].includes(record.feedback) ? record.feedback : null,
  };
}

export async function recordRecentMatch({
  dataDir = DATA_DIR,
  ctx,
  stickerId,
  description,
  emotion,
  agentId,
  ts = Date.now(),
  delivery,
} = {}) {
  const sessionId = sessionIdFromContext(ctx);
  const sid = cleanText(stickerId, 120);
  if (!sessionId || !sid) return { ok: false, skipped: true, reason: '缺少 sessionId 或 stickerId' };

  await storeFor(dataDir).update((data) => {
    if (!data || typeof data !== 'object') data = { version: 2, bySession: {} };
    data.version = 2;
    if (!data.bySession || typeof data.bySession !== 'object' || Array.isArray(data.bySession)) data.bySession = {};
    const list = asList(data.bySession[sessionId]);
    list.unshift({
      stickerId: sid,
      description: cleanText(description, 160),
      emotion: cleanText(emotion, 60),
      agentId: cleanText(agentId, 100),
      ts: Number(ts) || Date.now(),
      delivery: safeDelivery(delivery),
      feedback: null,
    });
    if (list.length > MAX_RECENT_PER_SESSION) list.length = MAX_RECENT_PER_SESSION;
    data.bySession[sessionId] = list;
  });
  return { ok: true, sessionId };
}

export function readRecentRecord({ dataDir = DATA_DIR, sessionId } = {}) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const data = storeFor(dataDir).read();
  return clone(asList(data?.bySession?.[sid]));
}

export function readRecentMatch({ dataDir = DATA_DIR, sessionId } = {}) {
  const records = readRecentRecord({ dataDir, sessionId });
  return records && records.length ? publicRecord(records[0]) : null;
}

// v0.33.48 - 配图手帐：跨会话收集最近配图，按时间倒序取前 limit 条（每条带 sessionId）
export function readRecentMatches({ dataDir = DATA_DIR, limit = 10 } = {}) {
  const data = storeFor(dataDir).read();
  const bySession = data?.bySession || {};
  const all = [];
  for (const [sessionId, record] of Object.entries(bySession)) {
    for (const item of asList(record)) {
      const pub = publicRecord(item);
      if (!pub) continue;
      all.push({ sessionId, ...pub });
    }
  }
  all.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const size = Math.max(1, Math.min(Number(limit) || 10, 50));
  return all.slice(0, size);
}

export function readRecentMatchForPath({ dataDir = DATA_DIR, sessionPath } = {}) {
  const sessionId = sessionIdFromPath(sessionPath);
  return {
    sessionId,
    match: sessionId ? readRecentMatch({ dataDir, sessionId }) : null,
  };
}

export async function updateRecentFeedback({
  dataDir = DATA_DIR,
  sessionId,
  stickerId,
  feedback,
  feedbackBase,
  expectedTs,
  expectedFeedback,
} = {}) {
  const sid = normalizeSessionId(sessionId);
  const sticker = cleanText(stickerId, 120);
  let updated = null;
  if (!sid || !sticker) return { ok: false, status: 400, error: '缺少 sessionId 或 stickerId' };

  await storeFor(dataDir).update((data) => {
    const list = asList(data?.bySession?.[sid]);
    const index = list.findIndex((current) =>
      current?.stickerId === sticker
      && (expectedTs === undefined || Number(current.ts) === Number(expectedTs))
      && (expectedFeedback === undefined || (current.feedback || null) === (expectedFeedback || null))
    );
    if (index < 0) return;
    const current = list[index];
    current.feedback = ['positive', 'negative'].includes(feedback) ? feedback : null;
    if (current.feedback && feedbackBase) current.feedbackBase = clone(feedbackBase);
    else delete current.feedbackBase;
    updated = publicRecord(current);
  });
  if (!updated) return { ok: false, status: 404, error: '没有找到对应的配图记录' };
  return { ok: true, match: updated };
}

export { publicRecord, normalizeSessionId };
