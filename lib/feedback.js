// 表情包反馈公共逻辑：卡片、Agent 工具和纸飞机共用同一套偏好写入。
// 只负责 preferences.json；旧 bad-matches / missing-categories 兼容记录仍由工具层维护。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

const writeChains = new Map();

function enqueue(filePath, task) {
  const previous = writeChains.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function normalizeAgentId(value) {
  const id = String(value || 'default').trim();
  return id || 'default';
}

function mappingMatches(mapping, emotion, keywords) {
  const context = mapping?.context || {};
  if (String(context.emotion || '') !== String(emotion || '')) return false;
  const existing = Array.isArray(context.keywords) ? context.keywords : [];
  if (keywords.length === 0 && existing.length === 0) return true;
  return keywords.some((item) => existing.includes(item))
    && existing.some((item) => keywords.includes(item));
}

function ensureUser(prefs, agentId) {
  if (!prefs || typeof prefs !== 'object') prefs = { version: 1, users: {} };
  if (!prefs.users || typeof prefs.users !== 'object' || Array.isArray(prefs.users)) prefs.users = {};
  if (!prefs.users[agentId] || typeof prefs.users[agentId] !== 'object') {
    prefs.users[agentId] = { mappings: [] };
  }
  if (!Array.isArray(prefs.users[agentId].mappings)) prefs.users[agentId].mappings = [];
  return prefs.users[agentId];
}

function findMapping(user, emotion, keywords) {
  const mappings = Array.isArray(user?.mappings) ? user.mappings : [];
  const index = mappings.findIndex((mapping) => mappingMatches(mapping, emotion, keywords));
  return index >= 0 ? { mapping: mappings[index], index } : null;
}

function ensureMapping(user, emotion, keywords) {
  const found = findMapping(user, emotion, keywords);
  if (found) {
    const mapping = found.mapping;
    if (!mapping.id) mapping.id = crypto.randomUUID();
    mapping.context = mapping.context && typeof mapping.context === 'object' ? mapping.context : {};
    const currentKeywords = Array.isArray(mapping.context.keywords) ? mapping.context.keywords : [];
    mapping.context.emotion = String(mapping.context.emotion || emotion || '');
    mapping.context.keywords = [...new Set([...currentKeywords, ...keywords])];
    if (!Array.isArray(mapping.preferred_ids)) mapping.preferred_ids = [];
    if (!Array.isArray(mapping.vetoed_ids)) mapping.vetoed_ids = [];
    if (!mapping.dislike_counts || typeof mapping.dislike_counts !== 'object') mapping.dislike_counts = {};
    if (!Number.isFinite(Number(mapping.weight))) mapping.weight = 1;
    return found;
  }

  const mapping = {
    id: crypto.randomUUID(),
    context: { emotion: String(emotion || ''), keywords },
    preferred_ids: [],
    vetoed_ids: [],
    dislike_counts: {},
    weight: 1,
    updated_at: new Date().toISOString(),
  };
  user.mappings.push(mapping);
  return { mapping, index: user.mappings.length - 1 };
}

function snapshotMapping(user, agentId, emotion, keywords, stickerId) {
  const found = findMapping(user, emotion, keywords);
  if (!found) return { hadMapping: false, mappingIndex: Array.isArray(user?.mappings) ? user.mappings.length : 0, emotion: String(emotion || '') };
  const mapping = found.mapping;
  if (!mapping.id) mapping.id = crypto.randomUUID();
  return {
    hadMapping: true,
    mappingId: mapping.id,
    mappingIndex: found.index,
    contextKeywords: Array.isArray(mapping.context?.keywords) ? mapping.context.keywords.slice() : [],
    preferred: Array.isArray(mapping.preferred_ids) && mapping.preferred_ids.includes(stickerId),
    vetoed: Array.isArray(mapping.vetoed_ids) && mapping.vetoed_ids.includes(stickerId),
    preferredIds: Array.isArray(mapping.preferred_ids) ? mapping.preferred_ids.slice() : [],
    vetoedIds: Array.isArray(mapping.vetoed_ids) ? mapping.vetoed_ids.slice() : [],
    dislikeCounts: mapping.dislike_counts && typeof mapping.dislike_counts === 'object' ? { ...mapping.dislike_counts } : {},
    dislikeCount: Number(mapping.dislike_counts?.[stickerId] || 0),
    weight: Number.isFinite(Number(mapping.weight)) ? Number(mapping.weight) : 1,
    agentId,
    emotion: String(emotion || ''),
  };
}

function locateSnapshotMapping(user, snapshot) {
  if (!snapshot?.hadMapping) return null;
  const mappings = Array.isArray(user?.mappings) ? user.mappings : [];
  if (snapshot.mappingId) {
    const index = mappings.findIndex((mapping) => mapping?.id === snapshot.mappingId);
    return index >= 0 ? { mapping: mappings[index], index } : null;
  }
  const byIndex = mappings[snapshot.mappingIndex];
  if (byIndex && String(byIndex.context?.emotion || '') === String(snapshot.emotion || '')) {
    return { mapping: byIndex, index: snapshot.mappingIndex };
  }
  return findMapping(user, snapshot.emotion || '', snapshot.contextKeywords || []);
}

function stickerState(mapping, stickerId) {
  const sid = String(stickerId || '');
  return {
    preferred: Array.isArray(mapping?.preferred_ids) && mapping.preferred_ids.includes(sid),
    vetoed: Array.isArray(mapping?.vetoed_ids) && mapping.vetoed_ids.includes(sid),
    dislikeCount: Math.max(0, Number(mapping?.dislike_counts?.[sid]) || 0),
  };
}

function snapshotStickerState(snapshot, stickerId) {
  const sid = String(stickerId || '');
  return {
    preferred: Array.isArray(snapshot?.preferredIds)
      ? snapshot.preferredIds.includes(sid)
      : snapshot?.preferred === true,
    vetoed: Array.isArray(snapshot?.vetoedIds)
      ? snapshot.vetoedIds.includes(sid)
      : snapshot?.vetoed === true,
    dislikeCount: Math.max(0, Number(
      snapshot?.dislikeCounts && typeof snapshot.dislikeCounts === 'object'
        ? snapshot.dislikeCounts[sid]
        : snapshot?.dislikeCount,
    ) || 0),
  };
}

function expectedAfterFeedback(before, feedbackType) {
  if (feedbackType === 'positive') return { preferred: true, vetoed: false, dislikeCount: 0 };
  if (feedbackType === 'negative') {
    return {
      preferred: false,
      vetoed: before.vetoed,
      dislikeCount: before.dislikeCount + 1,
    };
  }
  return null;
}

function sameStickerState(a, b) {
  return !!a && !!b
    && a.preferred === b.preferred
    && a.vetoed === b.vetoed
    && a.dislikeCount === b.dislikeCount;
}

function mappingHasReferences(mapping) {
  return (Array.isArray(mapping?.preferred_ids) && mapping.preferred_ids.length > 0)
    || (Array.isArray(mapping?.vetoed_ids) && mapping.vetoed_ids.length > 0)
    || Object.values(mapping?.dislike_counts || {}).some((count) => Number(count) > 0);
}

function setStickerState(mapping, stickerId, state) {
  const sid = String(stickerId || '');
  mapping.preferred_ids = Array.isArray(mapping.preferred_ids)
    ? mapping.preferred_ids.filter((id) => id !== sid)
    : [];
  mapping.vetoed_ids = Array.isArray(mapping.vetoed_ids)
    ? mapping.vetoed_ids.filter((id) => id !== sid)
    : [];
  mapping.dislike_counts = mapping.dislike_counts && typeof mapping.dislike_counts === 'object'
    ? { ...mapping.dislike_counts }
    : {};
  delete mapping.dislike_counts[sid];
  if (state?.preferred) mapping.preferred_ids.push(sid);
  if (state?.vetoed) mapping.vetoed_ids.push(sid);
  if (Number(state?.dislikeCount) > 0) mapping.dislike_counts[sid] = Number(state.dislikeCount);
}

function restoreConflict(message) {
  return { ok: false, status: 409, error: message || '这条反馈对应的偏好已被其他操作改变，无法安全撤销' };
}

function restoreSnapshot(prefs, agentId, stickerId, snapshot, originalFeedbackType = '') {
  if (!snapshot) return { ok: true, changed: false };
  const user = ensureUser(prefs, normalizeAgentId(agentId));
  const mappings = user.mappings || [];
  const feedbackType = String(originalFeedbackType || snapshot.feedbackType || '').trim();

  if (!snapshot.hadMapping) {
    let found = null;
    if (snapshot.mappingId) {
      const index = mappings.findIndex((mapping) => mapping?.id === snapshot.mappingId);
      if (index >= 0) found = { mapping: mappings[index], index };
    } else {
      const current = mappings[snapshot.mappingIndex];
      if (current && String(current.context?.emotion || '') === String(snapshot.emotion || '')) {
        found = { mapping: current, index: snapshot.mappingIndex };
      }
    }
    if (!found) return restoreConflict();

    const mapping = found.mapping;
    const currentState = stickerState(mapping, stickerId);
    const expected = feedbackType
      ? expectedAfterFeedback({ preferred: false, vetoed: false, dislikeCount: 0 }, feedbackType)
      : null;
    if (expected && !sameStickerState(currentState, expected)) {
      return restoreConflict();
    }
    if (!currentState.preferred && !currentState.vetoed && currentState.dislikeCount <= 0) {
      return restoreConflict();
    }

    // 只撤回本次反馈涉及的图片；mapping 后来被其他反馈复用时，保留其他图片。
    setStickerState(mapping, stickerId, { preferred: false, vetoed: false, dislikeCount: 0 });
    if (mappingHasReferences(mapping)) {
      mapping.updated_at = new Date().toISOString();
    } else {
      mappings.splice(found.index, 1);
    }
    return { ok: true, changed: true };
  }

  const found = locateSnapshotMapping(user, snapshot);
  if (!found) return restoreConflict();
  const mapping = found.mapping;
  const currentState = stickerState(mapping, stickerId);
  const expected = feedbackType ? expectedAfterFeedback(snapshotStickerState(snapshot, stickerId), feedbackType) : null;
  if (expected && !sameStickerState(currentState, expected)) {
    return restoreConflict();
  }

  // 快照只用于恢复当前 sticker 的旧状态，绝不覆盖 mapping 中后来新增的其他图片。
  setStickerState(mapping, stickerId, snapshotStickerState(snapshot, stickerId));
  const snapshotWeight = Number(snapshot.weight);
  const currentWeight = Number(mapping.weight);
  if (Number.isFinite(snapshotWeight) && Number.isFinite(currentWeight) && currentWeight <= snapshotWeight + 1) {
    mapping.weight = snapshotWeight;
  }
  mapping.updated_at = new Date().toISOString();
  if (!mappingHasReferences(mapping)) mappings.splice(found.index, 1);
  return { ok: true, changed: true };
}

function applySet(mapping, stickerId, feedbackType) {
  mapping.preferred_ids = Array.isArray(mapping.preferred_ids) ? mapping.preferred_ids : [];
  mapping.vetoed_ids = Array.isArray(mapping.vetoed_ids) ? mapping.vetoed_ids : [];
  mapping.dislike_counts = mapping.dislike_counts && typeof mapping.dislike_counts === 'object'
    ? mapping.dislike_counts
    : {};

  if (feedbackType === 'positive') {
    mapping.vetoed_ids = mapping.vetoed_ids.filter((id) => id !== stickerId);
    delete mapping.dislike_counts[stickerId];
    if (!mapping.preferred_ids.includes(stickerId)) mapping.preferred_ids.push(stickerId);
  } else {
    mapping.preferred_ids = mapping.preferred_ids.filter((id) => id !== stickerId);
    mapping.dislike_counts[stickerId] = (mapping.dislike_counts[stickerId] || 0) + 1;
  }
  mapping.weight = Math.min(10, (Number(mapping.weight) || 1) + 1);
  mapping.updated_at = new Date().toISOString();
}

function validateSticker(stickersFile, stickerId) {
  const stickers = readJson(stickersFile, null);
  if (!Array.isArray(stickers)) return { ok: false, status: 500, error: '表情包库读取失败，请稍后再试' };
  if (!stickers.some((item) => item?.id === stickerId)) {
    return { ok: false, status: 404, error: '表情包不存在: ' + stickerId };
  }
  return { ok: true };
}

/**
 * 写入一次正向/负向反馈，或撤销当前纸飞机这一次反馈。
 * restoreSnapshot 只由 recent-match 当前记录提供，避免误删历史偏好。
 */
export function applyPreferenceFeedback({
  dataDir = DATA_DIR,
  stickerId,
  feedbackType,
  agentId = 'default',
  contextEmotion = '',
  contextKeywords = '',
  restoreSnapshot: snapshotToRestore = null,
  originalFeedbackType = '',
} = {}) {
  const sid = typeof stickerId === 'string' ? stickerId.trim() : '';
  const type = String(feedbackType || '').trim();
  const normalizedAgent = normalizeAgentId(agentId);
  const emotion = String(contextEmotion || '').trim();
  const keywords = normalizeKeywords(contextKeywords);
  const prefsFile = path.join(dataDir, 'preferences.json');
  const stickersFile = path.join(dataDir, 'stickers.json');

  if (!sid) return Promise.resolve({ ok: false, status: 400, error: '缺少 sticker_id' });
  if (!['positive', 'negative', 'clear'].includes(type)) {
    return Promise.resolve({ ok: false, status: 400, error: 'feedback_type 必须是 positive、negative 或 clear' });
  }
  const valid = validateSticker(stickersFile, sid);
  if (!valid.ok) return Promise.resolve(valid);

  return enqueue(prefsFile, async () => {
    try {
      const prefs = readJson(prefsFile, { version: 1, users: {} });
      prefs.version = Number(prefs.version) || 1;
      const user = ensureUser(prefs, normalizedAgent);

      if (snapshotToRestore) {
        const restored = restoreSnapshot(
          prefs,
          normalizedAgent,
          sid,
          snapshotToRestore,
          originalFeedbackType,
        );
        if (restored?.ok === false) return restored;
      }
      if (type === 'clear') {
        if (!snapshotToRestore) {
          return { ok: false, status: 409, error: '这次反馈没有可撤销的记录' };
        }
        atomicWriteJson(prefsFile, prefs);
        return {
          ok: true,
          feedback_type: 'clear',
          dislike_count: 0,
          snapshot: null,
        };
      }

      const snapshot = snapshotToRestore || snapshotMapping(user, normalizedAgent, emotion, keywords, sid);
      const found = ensureMapping(user, emotion, keywords);
      snapshot.mappingId = found.mapping.id;
      snapshot.feedbackType = type;
      applySet(found.mapping, sid, type);
      atomicWriteJson(prefsFile, prefs);
      return {
        ok: true,
        feedback_type: type,
        dislike_count: Number(found.mapping.dislike_counts?.[sid] || 0),
        snapshot,
        mapping: found.mapping,
      };
    } catch (error) {
      return { ok: false, status: 500, error: error?.message || '偏好写入失败' };
    }
  });
}

export function normalizeFeedbackKeywords(value) {
  return normalizeKeywords(value);
}

// 管理页的手动偏好调整也走同一条文件写队列，避免和纸飞机反馈互相覆盖。
export function mutatePreferences({ dataDir = DATA_DIR, mutator } = {}) {
  const prefsFile = path.join(dataDir, 'preferences.json');
  if (typeof mutator !== 'function') return Promise.resolve({ ok: false, status: 400, error: '缺少偏好修改函数' });
  return enqueue(prefsFile, async () => {
    try {
      const prefs = readJson(prefsFile, { version: 1, users: {} });
      const result = await mutator(prefs);
      if (result && result.ok === false) return result;
      atomicWriteJson(prefsFile, prefs);
      return result || { ok: true };
    } catch (error) {
      return { ok: false, status: 500, error: error?.message || '偏好写入失败' };
    }
  });
}

export { ensureMapping, ensureUser, findMapping, snapshotMapping, restoreSnapshot };
