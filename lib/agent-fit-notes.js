// 伙伴配图自评账本：伙伴对「这次配的图贴不贴自己想表达的」留下的一笔。
// 与用户的喜欢/不喜欢（preferences.json）、应景（context-feedback.json）完全隔离，各记各的，互不污染。
// v1 只降权不升权：被标「跑偏」的图，在这个伙伴的这个情境下降权；
// 「到位」只如实记下（供管理页翻看），不参与打分，等看过实际效果再决定要不要升权。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson, AGENT_FIT_STEP, AGENT_FIT_MAX_COUNT } from './shared.js';

export const AGENT_FIT_FILE_NAME = 'agent-fit-notes.json';
export const AGENT_FIT_VERSION = 1;
export const AGENT_FIT_NOTE_MAX = 80;

const writeChains = new Map();

function resolveDataDir(dataDir) {
  return path.resolve(dataDir || DATA_DIR);
}

function filePathOf(dataDir) {
  return path.join(resolveDataDir(dataDir), AGENT_FIT_FILE_NAME);
}

function displayConfigPath(dataDir) {
  return path.join(resolveDataDir(dataDir), 'display-config.json');
}

function clean(value, maxLength = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function agentIdOf(value) {
  return clean(value, 100) || 'default';
}

function stickerIdOf(value) {
  return clean(value, 120);
}

function contextOf(value) {
  return clean(value, 80);
}

function emptyData() {
  return { version: AGENT_FIT_VERSION, byAgent: {} };
}

function normalizeData(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyData();
  data.version = AGENT_FIT_VERSION;
  if (!data.byAgent || typeof data.byAgent !== 'object' || Array.isArray(data.byAgent)) data.byAgent = {};
  return data;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function enqueue(filePath, task) {
  const previous = writeChains.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

function contextBucket(data, agentId, emotion, create = false) {
  const aid = agentIdOf(agentId);
  const context = contextOf(emotion);
  if (!context) return null;
  if (!data.byAgent[aid]) {
    if (!create) return null;
    data.byAgent[aid] = {};
  }
  if (!data.byAgent[aid][context]) {
    if (!create) return null;
    data.byAgent[aid][context] = {};
  }
  return data.byAgent[aid][context];
}

function entryOf(bucket, stickerId) {
  const entry = bucket?.[stickerId];
  if (!entry || typeof entry !== 'object') return { off: 0, on: 0, lastAt: '', note: '' };
  return {
    off: Math.max(0, Math.min(AGENT_FIT_MAX_COUNT, Number(entry.off) || 0)),
    on: Math.max(0, Number(entry.on) || 0),
    lastAt: String(entry.lastAt || ''),
    note: clean(entry.note, AGENT_FIT_NOTE_MAX),
  };
}

/**
 * 该伙伴在这个情境下被标「跑偏」的图与次数（只收 off，on 不参与打分）。
 */
export function readAgentFits({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '' } = {}) {
  if (!isAgentSelfNoteEnabled({ dataDir })) return {};
  const data = readAgentFitNotes({ dataDir });
  const bucket = contextBucket(data, agentId, contextEmotion, false);
  const result = {};
  if (!bucket) return result;
  for (const [stickerId, entry] of Object.entries(bucket)) {
    const { off } = entryOf(bucket, stickerId);
    if (off > 0) result[stickerId] = off;
  }
  return result;
}

/** 降权幅度（正数，调用方从分数里减）。 */
export function agentFitPenalty(count) {
  const n = Math.max(0, Math.min(AGENT_FIT_MAX_COUNT, Number(count) || 0));
  return n * AGENT_FIT_STEP;
}

export function readAgentFitNotes({ dataDir = DATA_DIR } = {}) {
  return normalizeData(readJson(filePathOf(dataDir), emptyData()));
}

/** 管理页用：摊平成一条条记录（按最近时间倒序）。 */
export function listAgentFitNotes({ dataDir = DATA_DIR, limit = 200 } = {}) {
  const data = readAgentFitNotes({ dataDir });
  const rows = [];
  for (const [agentId, contexts] of Object.entries(data.byAgent)) {
    if (!contexts || typeof contexts !== 'object') continue;
    for (const [emotion, bucket] of Object.entries(contexts)) {
      if (!bucket || typeof bucket !== 'object') continue;
      for (const stickerId of Object.keys(bucket)) {
        const entry = entryOf(bucket, stickerId);
        if (!entry.off && !entry.on) continue;
        rows.push({ agentId, emotion, stickerId, ...entry });
      }
    }
  }
  rows.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  const size = Math.max(1, Math.min(Number(limit) || 200, 1000));
  return rows.slice(0, size);
}

/** 开关：默认开启；用户关掉后，自评既不产生也不生效，已记的账原样保留。 */
export function isAgentSelfNoteEnabled({ dataDir = DATA_DIR } = {}) {
  const cfg = readJson(displayConfigPath(dataDir), null);
  if (!cfg || typeof cfg !== 'object') return true;
  return cfg.agentSelfNote !== false;
}

/**
 * 记一笔自评。fit: 'off'（跑偏）| 'on'（到位）。
 */
export function applyAgentFitNote({
  dataDir = DATA_DIR,
  agentId = 'default',
  emotion = '',
  stickerId,
  fit = 'off',
  note = '',
  now = Date.now(),
} = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(emotion);
  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId' });
  if (!context) return Promise.resolve({ ok: false, status: 400, error: '缺少情绪情境' });
  if (!['off', 'on'].includes(fit)) return Promise.resolve({ ok: false, status: 400, error: 'fit 只能是 off 或 on' });
  if (!isAgentSelfNoteEnabled({ dataDir })) {
    return Promise.resolve({ ok: false, status: 403, error: '伙伴配图自评已被用户关闭' });
  }
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath, emptyData()));
    const bucket = contextBucket(data, aid, context, true);
    const previous = entryOf(bucket, sid);
    const next = {
      off: fit === 'off' ? Math.min(AGENT_FIT_MAX_COUNT, previous.off + 1) : previous.off,
      on: fit === 'on' ? previous.on + 1 : previous.on,
      lastAt: new Date(Number(now) || Date.now()).toISOString(),
      note: clean(note, AGENT_FIT_NOTE_MAX) || previous.note,
    };
    bucket[sid] = next;
    atomicWriteJson(filePath, data);
    return { ok: true, fit, off: next.off, on: next.on, agentId: aid, emotion: context, stickerId: sid };
  });
}

/** 管理页手动移除单条（整条删除，不是递减）。 */
export function removeAgentFitEntry({ dataDir = DATA_DIR, agentId = 'default', emotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(emotion);
  if (!sid || !context) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId 或情绪情境' });
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath, emptyData()));
    const bucket = contextBucket(data, aid, context, false);
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, sid)) {
      delete bucket[sid];
      if (Object.keys(bucket).length === 0) delete data.byAgent[aid][context];
      if (data.byAgent[aid] && Object.keys(data.byAgent[aid]).length === 0) delete data.byAgent[aid];
      atomicWriteJson(filePath, data);
      return { ok: true, removed: true };
    }
    return { ok: true, removed: false };
  });
}

/** 删图时清掉这张图在所有伙伴、所有情境下的自评记录。 */
export function removeStickerAgentFitNotes({ dataDir = DATA_DIR, stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  if (!sid) return Promise.resolve({ ok: true, removed: false });
  const filePath = filePathOf(dataDir);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath, emptyData()));
    let removed = false;
    for (const [aid, contexts] of Object.entries(data.byAgent)) {
      if (!contexts || typeof contexts !== 'object') continue;
      for (const [emotion, bucket] of Object.entries(contexts)) {
        if (bucket && Object.prototype.hasOwnProperty.call(bucket, sid)) {
          delete bucket[sid];
          removed = true;
        }
        if (bucket && Object.keys(bucket).length === 0) delete contexts[emotion];
      }
      if (Object.keys(contexts).length === 0) delete data.byAgent[aid];
    }
    if (removed) atomicWriteJson(filePath, data);
    return { ok: true, removed };
  });
}

/** 搬家/重置用：读全量原始数据。 */
export function readAgentFitRaw({ dataDir = DATA_DIR } = {}) {
  return readAgentFitNotes({ dataDir });
}

/** 搬家/重置用：整体写入。 */
export function writeAgentFitRaw({ dataDir = DATA_DIR, data } = {}) {
  return enqueue(filePathOf(dataDir), async () => {
    atomicWriteJson(filePathOf(dataDir), normalizeData(data));
    return { ok: true };
  });
}

export { clean as cleanAgentFitText, agentIdOf, contextOf, stickerIdOf, normalizeData };
