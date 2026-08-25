// 场景正反馈账本：记录“这次很应景”，不污染全局图片偏好。
// 负向场景修订仍走“和小花聊一聊”现有链路，当前模块只处理正向适配信号。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const CONTEXT_FEEDBACK_FILE_NAME = 'context-feedback.json';
export const CONTEXT_FEEDBACK_VERSION = 1;
export const CONTEXT_FIT_MAX_COUNT = 3;

const writeChains = new Map();

function resolveDataDir(dataDir) {
  return path.resolve(dataDir || DATA_DIR);
}

function filePathOf(dataDir) {
  return path.join(resolveDataDir(dataDir), CONTEXT_FEEDBACK_FILE_NAME);
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
  return { version: CONTEXT_FEEDBACK_VERSION, byAgent: {} };
}

function normalizeData(raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyData();
  data.version = CONTEXT_FEEDBACK_VERSION;
  if (!data.byAgent || typeof data.byAgent !== 'object' || Array.isArray(data.byAgent)) data.byAgent = {};
  return data;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return emptyData();
  }
}

function enqueue(filePath, task) {
  const previous = writeChains.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

function contextBucket(data, agentId, contextEmotion, create = false) {
  const aid = agentIdOf(agentId);
  const context = contextOf(contextEmotion);
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

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function readContextFeedback({ dataDir = DATA_DIR } = {}) {
  return normalizeData(readJson(filePathOf(dataDir)));
}

export function readContextFits({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '' } = {}) {
  const data = readContextFeedback({ dataDir });
  const bucket = contextBucket(data, agentId, contextEmotion, false);
  const result = {};
  if (!bucket) return result;
  for (const [stickerId, entry] of Object.entries(bucket)) {
    const count = Math.max(0, Math.min(CONTEXT_FIT_MAX_COUNT, Number(entry?.count) || 0));
    if (count > 0) result[stickerId] = count;
  }
  return result;
}

export function contextFitBonus(count) {
  return Math.max(0, Math.min(CONTEXT_FIT_MAX_COUNT, Number(count) || 0));
}

export function getContextFitSnapshot(data, { agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const bucket = contextBucket(data, agentId, contextEmotion, false);
  const existing = sid && bucket?.[sid];
  return {
    hadEntry: !!existing,
    count: Math.max(0, Number(existing?.count) || 0),
    lastAt: String(existing?.lastAt || ''),
    agentId: agentIdOf(agentId),
    contextEmotion: contextOf(contextEmotion),
    stickerId: sid,
  };
}

function restoreSnapshotInData(data, snapshot) {
  if (!snapshot || !snapshot.contextEmotion || !snapshot.stickerId) return;
  const bucket = contextBucket(data, snapshot.agentId, snapshot.contextEmotion, snapshot.hadEntry);
  if (!bucket) return;
  if (!snapshot.hadEntry || snapshot.count <= 0) {
    delete bucket[snapshot.stickerId];
    return;
  }
  bucket[snapshot.stickerId] = {
    count: Math.min(CONTEXT_FIT_MAX_COUNT, Math.max(0, Number(snapshot.count) || 0)),
    lastAt: String(snapshot.lastAt || ''),
  };
}

/**
 * 写入一次“这次很应景”或恢复这条反馈之前的场景账本状态。
 */
export function applyContextFit({
  dataDir = DATA_DIR,
  agentId = 'default',
  contextEmotion = '',
  stickerId,
  action = 'add',
  restoreSnapshot = null,
  now = Date.now(),
} = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(contextEmotion);
  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId' });
  if (!context) return Promise.resolve({ ok: false, status: 400, error: '缺少场景情绪' });
  if (!['add', 'clear', 'restore'].includes(action)) {
    return Promise.resolve({ ok: false, status: 400, error: '无效的场景反馈动作' });
  }
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    if (action === 'restore') {
      restoreSnapshotInData(data, restoreSnapshot);
      atomicWriteJson(filePath, data);
      return { ok: true, snapshot: null, count: 0 };
    }
    const snapshot = getContextFitSnapshot(data, { agentId: aid, contextEmotion: context, stickerId: sid });
    if (action === 'clear') {
      const bucket = contextBucket(data, aid, context, false);
      const nextCount = Math.max(0, snapshot.count - 1);
      if (bucket) {
        if (nextCount > 0) {
          bucket[sid] = { count: nextCount, lastAt: snapshot.lastAt };
        } else {
          delete bucket[sid];
        }
      }
      atomicWriteJson(filePath, data);
      return { ok: true, snapshot, count: nextCount };
    }
    const bucket = contextBucket(data, aid, context, true);
    const previous = bucket[sid];
    bucket[sid] = {
      count: Math.min(CONTEXT_FIT_MAX_COUNT, Math.max(0, Number(previous?.count) || 0) + 1),
      lastAt: new Date(Number(now) || Date.now()).toISOString(),
    };
    atomicWriteJson(filePath, data);
    return { ok: true, snapshot, count: bucket[sid].count };
  });
}

/**
 * 删除某助手某场景下的单条应景记录（管理页手动移除用，整条删除不是递减）。
 */
export function removeContextFitEntry({ dataDir = DATA_DIR, agentId = 'default', contextEmotion = '', stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  const context = contextOf(contextEmotion);
  if (!sid || !context) return Promise.resolve({ ok: false, status: 400, error: '缺少 stickerId 或场景情绪' });
  const filePath = filePathOf(dataDir);
  const aid = agentIdOf(agentId);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    const bucket = contextBucket(data, aid, context, false);
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, sid)) {
      delete bucket[sid];
      atomicWriteJson(filePath, data);
      return { ok: true, removed: true };
    }
    return { ok: true, removed: false };
  });
}

export function removeStickerContextFeedback({ dataDir = DATA_DIR, stickerId } = {}) {
  const sid = stickerIdOf(stickerId);
  if (!sid) return Promise.resolve({ ok: true, removed: false });
  const filePath = filePathOf(dataDir);
  return enqueue(filePath, async () => {
    const data = normalizeData(readJson(filePath));
    let removed = false;
    for (const bucket of Object.values(data.byAgent)) {
      if (!bucket || typeof bucket !== 'object') continue;
      for (const entries of Object.values(bucket)) {
        if (entries && typeof entries === 'object' && Object.prototype.hasOwnProperty.call(entries, sid)) {
          delete entries[sid];
          removed = true;
        }
      }
    }
    if (removed) atomicWriteJson(filePath, data);
    return { ok: true, removed };
  });
}

export { agentIdOf, contextOf, stickerIdOf, normalizeData };
