// 表情包悬浮球：本地代理、Python 进程与正式发送链路。
// Python 只画 UI；图库、会话选择、stageFile 和 session:send 全部留在 Node 侧。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalIpcServer } from './ipc-server/index.js';
import { PythonProcess, checkDeps } from './python-lifecycle/index.js';
import { createJsonStore } from './atomic-store/index.js';
import {
  DATA_DIR,
  HANA_HOME,
  MIME_MAP,
  STICKERS_DIR,
  META_FILE,
  readMeta,
  writeMeta,
  atomicWriteJson,
  genId,
  enqueueToolWrite,
  tagImage,
  generateEmbeddings,
  resolveEmbeddingApi,
  readEmbeddingConfig,
  readVectors,
  writeVectors,
} from './shared.js';
import { upsertTeachingSample } from './teaching.js';
import {
  readGroupStore,
  isGroupStoreReadable,
  buildRecognitionGroupHints,
  suggestGroupsForTags,
  getKnownGroupIds,
  normalizeGroupIds,
} from './sticker-groups.js';
import {
  buildBallSendPayload,
  createRequestId,
  createHeartbeatTracker,
  materializeStickerCopy,
  normalizePinnedIds,
  readSessionIdFromFile,
  safeStickerPath,
  sanitizeBallText,
  validatePinnedReorder,
} from './ball-core.js';
import { readServerInfo, uploadStickerAsUser } from './hana-upload.js';
import { applyPreferenceFeedback } from './feedback.js';
import { recordSuccessfulExposure } from './exposure.js';
import { applyContextFit } from './context-feedback.js';
import {
  normalizeSessionId,
  readRecentMatchForPath,
  readRecentMatches,
  readRecentRecord,
  sessionIdFromPath,
  updateRecentFeedback,
} from './recent-match.js';
import { findMostActiveSession, isDesktopSessionPath, lastUserMessageText, listRecentSessions, parseTimestamp } from './ball-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(__dirname, '..', 'python');
const BALL_SCRIPT = path.join(PY_DIR, 'ball_app.py');
const PROXY_PORT = Number(process.env.BIAOQINGBAO_BALL_PORT || 18904);
const MAX_TEXT_LENGTH = 2000;
const MAX_REQUEST_ID_LENGTH = 120;
const SEND_CACHE_MS = 2 * 60 * 1000;
const TARGET_RETRY_DELAYS = [2000, 5000, 10000];
const SESSION_LIST_TIMEOUT_MS = 5000;
// 悬浮球样式已定案为纸飞机；旧配置值统一归一化到唯一主体。
const BALL_VARIANTS = Object.freeze(['plane']);
const DEFAULT_BALL_VARIANT = 'plane';
const CONFIG_DEFAULTS = { version: 2, pinnedIds: [], pinnedTarget: null, variant: DEFAULT_BALL_VARIANT };

let runtime = null;
let operation = Promise.resolve();
let feedbackOperation = Promise.resolve();
let lastState = {
  running: false,
  connected: false,
  startedAt: null,
  exitCode: null,
  error: null,
};
// 半自动启动：用户手动关过悬浮球后，本次运行打开插件页面不再自动弹（Hana 重启内存重置）
let dismissedByUser = false;

// v0.33.42 - 非正常退出自动重启：崩溃/被杀时拉起，连续失败放弃（防死循环）；用户主动停不重启
const AUTO_RESTART_DELAY_MS = 3000;
const MAX_AUTO_RESTARTS = 3;
// 心跳：Python 每 15s 上报一次，超过 45s 没收到判失联（渲染崩了/进程卡死）
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_CHECK_MS = 5000;
const HEARTBEAT_STALE_AFTER_MS = 45000;
let autoRestartTimer = null;
let autoRestartCount = 0;
// 运行期心跳检查定时器（进程存在时活动）
let heartbeatCheckTimer = null;

export function consumeBallDismissed() {
  const v = dismissedByUser;
  dismissedByUser = false;
  return v;
}
const configStores = new Map();
const sendInFlight = new Map();
const sendCache = new Map();

function serializeOperation(task) {
  const next = operation.then(task, task);
  operation = next.catch(() => {});
  return next;
}

function serializeFeedbackOperation(task) {
  const next = feedbackOperation.then(task, task);
  feedbackOperation = next.catch(() => {});
  return next;
}

function dataDirOf(ctx) {
  const dir = ctx?.dataDir || DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configStoreOf(ctx) {
  const dataDir = dataDirOf(ctx);
  let store = configStores.get(dataDir);
  if (!store) {
    store = createJsonStore({
      filePath: path.join(dataDir, 'ball-config.json'),
      defaults: CONFIG_DEFAULTS,
    });
    configStores.set(dataDir, store);
  }
  return store;
}

function normalizeBallVariant(value) {
  const variant = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BALL_VARIANTS.includes(variant) ? variant : DEFAULT_BALL_VARIANT;
}

function normalizedConfig(ctx) {
  const config = configStoreOf(ctx).read();
  const pins = normalizePinnedIds(config?.pinnedIds, readMeta());
  return {
    version: 2,
    pinnedIds: pins.pinnedIds,
    variant: normalizeBallVariant(config?.variant),
  };
}

function readBallVariant(ctx) {
  return normalizeBallVariant(configStoreOf(ctx).read()?.variant);
}

async function setBallVariant(ctx, variant) {
  if (typeof variant !== 'string' || !BALL_VARIANTS.includes(variant.trim().toLowerCase())) {
    return { ok: false, status: 400, error: '没有这个悬浮球样式' };
  }
  const next = variant.trim().toLowerCase();
  await configStoreOf(ctx).update((current) => {
    current.version = 2;
    current.variant = next;
    if (!Array.isArray(current.pinnedIds)) current.pinnedIds = [];
    if (!Object.prototype.hasOwnProperty.call(current, 'pinnedTarget')) current.pinnedTarget = null;
  });
  return { ok: true, variant: next };
}

function serializedSticker(sticker) {
  if (!sticker || typeof sticker.id !== 'string' || typeof sticker.file !== 'string') return null;
  const tags = sticker.tags && typeof sticker.tags === 'object' ? sticker.tags : {};
  const list = (value) => Array.isArray(value)
    ? value.map((item) => sanitizeBallText(item, 40)).filter(Boolean).slice(0, 20)
    : [];
  return {
    id: sticker.id,
    file: sticker.file,
    description: sanitizeBallText(sticker.description || sticker.file, 120),
    tags: {
      emotion: list(tags.emotion),
      scene: list(tags.scene),
      keywords: list(tags.keywords),
    },
  };
}

function stickerById(stickerId) {
  const id = typeof stickerId === 'string' ? stickerId.trim() : '';
  if (!id) return null;
  const sticker = readMeta().find((item) => item?.id === id);
  if (!sticker) return null;
  const filePath = safeStickerPath(STICKERS_DIR, sticker.file);
  if (!filePath) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return { sticker, filePath };
}

async function updatePinned(ctx, stickerId, pinned) {
  const hit = stickerById(stickerId);
  if (!hit) return { ok: false, status: 404, error: '没有找到这张表情包' };
  const store = configStoreOf(ctx);
  await store.update((current) => {
    const existing = normalizePinnedIds(current?.pinnedIds, readMeta()).pinnedIds;
    const next = pinned
      ? [...existing, hit.sticker.id]
      : existing.filter((id) => id !== hit.sticker.id);
    current.version = 2;
    current.pinnedIds = normalizePinnedIds(next, readMeta()).pinnedIds;
    current.variant = normalizeBallVariant(current.variant);
    if (!Object.prototype.hasOwnProperty.call(current, 'pinnedTarget')) current.pinnedTarget = null;
  });
  return { ok: true, ...normalizedConfig(ctx) };
}

function isPublicSessionItem(item) {
  if (!item || typeof item !== 'object' || item.ownerPluginId) return false;
  // v0.34.5 - Hana 0.737+ 的普通会话列表省略 visibility；列表本身已是公开范围。
  const visibility = String(item.visibility ?? '').trim().toLowerCase();
  return visibility === '' || visibility === 'public';
}

function sessionIdOfListItem(item, sessionPath = item?.path || item?.sessionPath) {
  return normalizeSessionId(
    item?.sessionId
      || item?.sessionRef?.id
      || item?.sessionRef?.sessionId
      || item?.id
      || (typeof sessionPath === 'string' && sessionPath ? readSessionIdFromFile(sessionPath) : ''),
  );
}

function manifestSessionIdOf(item) {
  const candidates = [
    item?.sessionId,
    item?.session_id,
    item?.sessionRef?.sessionId,
    item?.sessionRef?.id,
    item?.id,
  ];
  for (const candidate of candidates) {
    const id = normalizeSessionId(candidate);
    // session.id 可能是会话文件的内部 UUID，只有 sess_ 才是反馈账本使用的宿主会话 ID。
    if (id.startsWith('sess_')) return id;
  }
  return '';
}

function withTimeout(promise, timeoutMs, label = '请求') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function publicSessionSnapshot(ctx) {
  if (!ctx?.bus || typeof ctx.bus.request !== 'function') return null;
  try {
    const result = await withTimeout(
      ctx.bus.request('session:list', {}, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
      SESSION_LIST_TIMEOUT_MS,
      'session:list',
    );
    const sessions = Array.isArray(result) ? result : result?.sessions;
    if (!Array.isArray(sessions)) return null;
    const paths = new Set();
    const modifiedByPath = new Map();
    const publicItems = [];
    for (const item of sessions) {
      if (!isPublicSessionItem(item)) continue;
      publicItems.push(item);
      const sessionPath = item.path || item.sessionPath;
      if (typeof sessionPath !== 'string' || !sessionPath) continue;
      const normalizedPath = path.normalize(sessionPath);
      paths.add(normalizedPath);
      const modifiedAt = parseTimestamp(item.modified ?? item.modifiedAt);
      if (modifiedAt > 0) modifiedByPath.set(normalizedPath, modifiedAt);
    }
    return { items: publicItems, paths, modifiedByPath };
  } catch {
    return null;
  }
}

async function publicSessionPaths(ctx) {
  const snapshot = await publicSessionSnapshot(ctx);
  return snapshot?.paths instanceof Set ? snapshot.paths : null;
}

async function currentTarget(ctx) {
  // session:list 是私密会话过滤的第一道门；总线不可用时宁可不发，不回退到可能包含 plugin-private 的盲扫。
  const snapshot = await publicSessionSnapshot(ctx);
  if (!(snapshot?.paths instanceof Set)) return null;
  const target = findMostActiveSession({
    hanaHome: HANA_HOME,
    allowedPaths: snapshot.paths,
    activityByPath: snapshot.modifiedByPath,
  });
  if (!target || !isDesktopSessionPath(target.sessionPath, { hanaHome: HANA_HOME })) return null;
  try {
    const stat = fs.statSync(target.sessionPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return {
    agentId: target.agentId,
    sessionPath: target.sessionPath,
  };
}

// ─── 固定目标会话（null = 跟随最近活跃窗口） ───
function readPinnedTarget(ctx) {
  const config = configStoreOf(ctx).read();
  const p = config?.pinnedTarget;
  if (p && typeof p === 'object' && typeof p.sessionPath === 'string' && p.sessionPath) {
    return {
      agentId: String(p.agentId || ''),
      sessionPath: p.sessionPath,
      title: String(p.title || ''),
    };
  }
  return null;
}

async function setPinnedTarget(ctx, pinned) {
  const store = configStoreOf(ctx);
  await store.update((current) => {
    if (pinned) {
      current.pinnedTarget = {
        agentId: String(pinned.agentId || ''),
        sessionPath: String(pinned.sessionPath || ''),
        title: String(pinned.title || ''),
      };
    } else {
      current.pinnedTarget = null;
    }
  });
}

// 固定优先；固定文件失效或不在公开会话白名单时自动清除并回落自动监测。
async function resolveTarget(ctx) {
  const pinned = readPinnedTarget(ctx);
  if (pinned) {
    const allowedPaths = await publicSessionPaths(ctx);
    if (allowedPaths instanceof Set && allowedPaths.has(path.normalize(pinned.sessionPath))) {
      try {
        if (fs.existsSync(pinned.sessionPath) && fs.statSync(pinned.sessionPath).isFile()) {
          return { agentId: pinned.agentId, sessionPath: pinned.sessionPath, title: pinned.title || '', pinned: true };
        }
      } catch {}
      await setPinnedTarget(ctx, null);
    } else if (allowedPaths instanceof Set) {
      // 总线明确返回了公开列表，但固定目标已不再公开，不能继续推送。
      await setPinnedTarget(ctx, null);
    } else {
      // session:list 暂时不可用时保留固定配置，但本轮不发送。
      return null;
    }
  }
  return currentTarget(ctx);
}

// session:list 标题缓存（短 TTL，避免每次 target 查询都全量拉列表）
let sessionTitlesCache = null;
let sessionTitlesCacheAt = 0;
let sessionTitlesCacheSource = null;
const SESSION_TITLES_CACHE_MS = 5000;

async function sessionTitleMaps(ctx) {
  const now = Date.now();
  const source = ctx?.bus || null;
  if (sessionTitlesCache && sessionTitlesCacheSource === source && now - sessionTitlesCacheAt < SESSION_TITLES_CACHE_MS) return sessionTitlesCache;
  const byPath = new Map();
  const byId = new Map();
  const publicIds = new Set();
  try {
    if (ctx?.bus && typeof ctx.bus.request === 'function') {
      const result = await withTimeout(
        ctx.bus.request('session:list', {}, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
        SESSION_LIST_TIMEOUT_MS,
        'session:list',
      );
      const sessions = Array.isArray(result) ? result : result?.sessions;
      if (Array.isArray(sessions)) {
        for (const item of sessions) {
          if (!isPublicSessionItem(item)) continue;
          const sessionPath = item.path || item.sessionPath;
          const title = String(item.title || item.firstMessage || '').replace(/\s+/g, ' ').trim();
          const sessionId = sessionIdOfListItem(item, sessionPath);
          if (sessionId) publicIds.add(sessionId);
          if (title && typeof sessionPath === 'string' && sessionPath) byPath.set(path.normalize(sessionPath), title);
          if (title && sessionId) byId.set(sessionId, title);
        }
      }
    }
  } catch { /* 总线不可用时回退到本地扫描标题 */ }
  sessionTitlesCache = { byPath, byId, publicIds };
  sessionTitlesCacheSource = source;
  sessionTitlesCacheAt = now;
  return sessionTitlesCache;
}

// v0.33.47 - 当前对话标题优先 Hana session:list 的真实标题（title/firstMessage），
// 不再显示最后一条消息；总线拿不到才回退本地扫描
// v0.34.13 - Hana 0.817+ 的 session:list 投影不再返回 sessionId；
// 反馈卡同时带着发图时的 sessionPath，按 session:get 做一次权威归属/公开性校验，
// 旧宿主仍优先沿用带 sessionId 的 session:list 结果，避免破坏历史手帐反馈。
async function sessionForFeedback(ctx, { sessionId = '', sessionPath = '' } = {}) {
  const requestedId = normalizeSessionId(sessionId);
  const requestedPath = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!requestedId && !requestedPath) return null;

  // 旧宿主的 session:list 会直接返回 sessionId；没有路径时可直接使用这份公开白名单。
  if (requestedId && !requestedPath) {
    const titles = await sessionTitleMaps(ctx);
    if (titles.publicIds.has(requestedId)) return { sessionId: requestedId, sessionPath: '' };
  }

  if (requestedPath) {
    if (!isDesktopSessionPath(requestedPath, { hanaHome: HANA_HOME })) return null;
    try {
      if (!fs.statSync(requestedPath).isFile()) return null;
    } catch {
      return null;
    }
  }
  if (!ctx?.bus || typeof ctx.bus.request !== 'function') return null;

  try {
    const query = {
      ...(requestedPath ? { sessionPath: requestedPath } : {}),
      ...(requestedId ? { sessionId: requestedId } : {}),
    };
    const result = await withTimeout(
      ctx.bus.request('session:get', query, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
      SESSION_LIST_TIMEOUT_MS,
      'session:get',
    );
    const session = result?.session;
    if (!session || !isPublicSessionItem(session)) return null;
    const resolvedPath = typeof (session.path || session.sessionPath) === 'string'
      ? (session.path || session.sessionPath)
      : '';
    const resolvedId = manifestSessionIdOf(session);
    // 两个定位值都在时必须指向同一段对话，避免把卡片中的图片反馈写进别的会话。
    if (requestedId && resolvedId && requestedId !== resolvedId) return null;
    if (requestedPath && resolvedPath && path.normalize(requestedPath) !== path.normalize(resolvedPath)) return null;
    const finalId = requestedId || resolvedId || sessionIdFromPath(resolvedPath || requestedPath);
    if (!finalId) return null;
    return { sessionId: finalId, sessionPath: resolvedPath || requestedPath };
  } catch {
    return null;
  }
}

async function sessionTitleOf(ctx, sessionPath) {
  if (typeof sessionPath !== 'string' || !sessionPath) return '';
  try {
    const stat = fs.statSync(sessionPath);
    if (!stat.isFile()) return '';
  } catch {
    return '';
  }
  try {
    const titles = await sessionTitleMaps(ctx);
    const t = titles.byPath.get(path.normalize(sessionPath));
    if (t) return t.slice(0, 40);
  } catch {}
  return lastUserMessageText(sessionPath, 20);
}

export function recentSessionTitle(record, titleById) {
  const title = titleById?.get?.(normalizeSessionId(record?.sessionId));
  return String(title || '（无标题对话）').slice(0, 40);
}

export function filterRecentMatchesForPublicSessions(matches, publicIds) {
  if (!(publicIds instanceof Set)) return [];
  return (Array.isArray(matches) ? matches : []).filter((match) =>
    publicIds.has(normalizeSessionId(match?.sessionId)),
  );
}

// 最近对话列表（自动监测候选 + 手动固定候选），带标题；私密会话过滤与 target 同一道门
async function listSessions(ctx, limit = 5) {
  const snapshot = await publicSessionSnapshot(ctx);
  if (!(snapshot?.paths instanceof Set)) return [];
  const scanned = listRecentSessions({
    hanaHome: HANA_HOME,
    allowedPaths: snapshot.paths,
    limit: Math.max(limit * 3, 24),
  });
  const byPath = new Map(scanned.map((item) => [path.normalize(item.sessionPath), item]));
  const named = snapshot.items
    .filter((item) => item && typeof (item.path || item.sessionPath) === 'string')
    .map((item) => {
      const sessionPath = item.path || item.sessionPath;
      const matched = byPath.get(path.normalize(sessionPath));
      if (!isPublicSessionItem(item)) return null;
      const hostModifiedAt = parseTimestamp(item.modified ?? item.modifiedAt);
      const lastUserTime = Math.max(matched?.lastUserAt || 0, hostModifiedAt || 0);
      const agentId = String(matched?.agentId || item.agentId || '');
      return {
        agentId,
        agentName: String(item.agentName || readAgentName(agentId)),
        sessionPath,
        title: String(item.title || item.firstMessage || matched?.title || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        lastUserTime,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lastUserTime - a.lastUserTime || String(a.sessionPath).localeCompare(String(b.sessionPath)));
  return named.length ? named.slice(0, limit) : scanned.slice(0, limit);
}

function readAgentName(agentId) {
  if (!agentId) return '';
  const agentDir = path.join(HANA_HOME, 'agents', agentId);
  try {
    const cardPath = path.join(agentDir, 'card.json');
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    if (card?.name) return String(card.name).trim();
  } catch {}
  try {
    const config = fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf8');
    const match = config.match(/^agent:\s*\n([\s\S]*?)(?=^\S|$)/m);
    const name = match?.[1]?.match(/^\s{2}name:\s*['"]?([^'"\n#]+)['"]?\s*$/m);
    if (name?.[1]) return name[1].trim();
  } catch {}
  return agentId;
}

async function targetPayload(ctx) {
  const pinned = readPinnedTarget(ctx);
  const target = await resolveTarget(ctx);
  return {
    ok: true,
    mode: pinned ? 'pinned' : 'auto',
    pinned: pinned ? { sessionPath: pinned.sessionPath, title: pinned.title || '' } : null,
    target: target
      ? {
          agentId: target.agentId,
          name: readAgentName(target.agentId),
          title: target.pinned ? (target.title || '') : await sessionTitleOf(ctx, target.sessionPath),
          sessionPath: target.sessionPath,
        }
      : null,
  };
}

async function recentSessionPath(ctx, requestedPath = '') {
  const candidate = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (candidate) {
    if (!isDesktopSessionPath(candidate, { hanaHome: HANA_HOME })) return null;
    // v0.34.3 - 不再强制等于悬浮球当前目标：卡片自带的 sessionPath 就是发图时的会话，
    // 反馈/取最近配图直接信它（悬浮球可能 pin 了别的会话或未 pin，强匹配会把
    // 「当前对话里点反馈」误杀成 409——2026-08-27 实机：卡片 route 缺 sessionId 时反馈必败）。
    try {
      if (!fs.statSync(candidate).isFile()) return null;
    } catch {
      return null;
    }
    return candidate;
  }
  const target = await resolveTarget(ctx);
  return target?.sessionPath || null;
}

export async function getRecentBallMatch(ctx, requestedPath = '', { exposeSessionPath = true } = {}) {
  const sessionPath = await recentSessionPath(ctx, requestedPath);
  if (!sessionPath) {
    return exposeSessionPath
      ? { ok: true, sessionPath: null, sessionId: null, match: null }
      : { ok: true, sessionId: null, match: null };
  }
  const data = readRecentMatchForPath({ dataDir: dataDirOf(ctx), sessionPath });
  const result = { ok: true, sessionId: data.sessionId || null, match: data.match || null };
  if (exposeSessionPath) result.sessionPath = sessionPath;
  return result;
}

const POSITIVE_FEEDBACK_KINDS = new Set(['image', 'context', 'both']);

function normalizePositiveFeedbackKind(rawFeedback, rawKind) {
  const raw = String(rawFeedback || '').trim();
  if (raw === 'positive_context') return 'context';
  if (raw === 'positive_both') return 'both';
  if (raw === 'positive_image') return 'image';
  const kind = String(rawKind || '').trim();
  return POSITIVE_FEEDBACK_KINDS.has(kind) ? kind : 'image';
}

function normalizeFeedbackBase(base) {
  if (!base || typeof base !== 'object') return { preference: null, context: null };
  // v0.33.53 之前 feedbackBase 直接就是 applyPreferenceFeedback 的 snapshot。
  if (Object.prototype.hasOwnProperty.call(base, 'hadMapping')) {
    return { preference: base, context: null };
  }
  return {
    preference: base.preference || null,
    context: base.context || null,
  };
}

async function restoreBallFeedbackEffects({ dataDir, stickerId, record, agentId }) {
  const parts = normalizeFeedbackBase(record?.feedbackBase);
  const emotion = record?.emotion || '';
  if (parts.preference) {
    const restored = await applyPreferenceFeedback({
      dataDir,
      stickerId,
      feedbackType: 'clear',
      agentId,
      contextEmotion: emotion,
      contextKeywords: '',
      restoreSnapshot: parts.preference,
      originalFeedbackType: record?.feedback || parts.preference.feedbackType || '',
    });
    if (!restored.ok) return restored;
  }
  if (parts.context) {
    const restored = await applyContextFit({
      dataDir,
      stickerId,
      agentId,
      contextEmotion: emotion,
      action: 'restore',
      restoreSnapshot: parts.context,
    });
    if (!restored.ok) return restored;
  }
  return { ok: true };
}

async function applyBallFeedbackEffects({ dataDir, stickerId, agentId, emotion, feedback, feedbackKind }) {
  const isPositive = feedback === 'positive';
  const kind = isPositive ? normalizePositiveFeedbackKind(feedback, feedbackKind) : 'image';
  let preference = null;
  let context = null;

  if (!isPositive || kind === 'image' || kind === 'both') {
    preference = await applyPreferenceFeedback({
      dataDir,
      stickerId,
      feedbackType: isPositive ? 'positive' : 'negative',
      agentId,
      contextEmotion: emotion,
      contextKeywords: '',
    });
    if (!preference.ok) return preference;
  }

  if (isPositive && (kind === 'context' || kind === 'both')) {
    context = await applyContextFit({
      dataDir,
      stickerId,
      agentId,
      contextEmotion: emotion,
      action: 'add',
    });
    if (!context.ok) {
      if (preference?.snapshot) {
        await applyPreferenceFeedback({
          dataDir,
          stickerId,
          feedbackType: 'clear',
          agentId,
          contextEmotion: emotion,
          contextKeywords: '',
          restoreSnapshot: preference.snapshot,
          originalFeedbackType: 'positive',
        }).catch(() => {});
      }
      return context;
    }
  }

  return {
    ok: true,
    feedback: isPositive ? 'positive' : 'negative',
    feedbackKind: isPositive ? kind : null,
    dislike_count: Number(preference?.dislike_count || 0),
    feedbackBase: {
      preference: preference?.snapshot || null,
      context: context?.snapshot || null,
    },
  };
}

function feedbackMessage(feedback, feedbackKind) {
  if (feedback === 'clear') return '已撤销这次反馈';
  if (feedback === 'negative') return '已记下：不喜欢';
  if (feedbackKind === 'context') return '已记下：这次很应景';
  if (feedbackKind === 'both') return '已记下：喜欢这张图，也很应景';
  return '已记下：喜欢这张图';
}

async function submitBallFeedbackInternal(ctx, body = {}) {
  const stickerId = typeof body.stickerId === 'string' ? body.stickerId.trim() : '';
  const rawFeedback = body.feedback ?? body.feedback_type;
  let feedback = rawFeedback === null || rawFeedback === 'clear' ? 'clear' : String(rawFeedback || '').trim();
  let feedbackKind = normalizePositiveFeedbackKind(feedback, body.feedbackKind ?? body.feedback_kind);
  if (feedback === 'positive_context' || feedback === 'positive_both' || feedback === 'positive_image') feedback = 'positive';
  if (!stickerId) return { ok: false, status: 400, error: '缺少 stickerId' };
  if (!['positive', 'negative', 'clear'].includes(feedback)) {
    return { ok: false, status: 400, error: 'feedback 必须是 positive、negative 或 clear' };
  }
  if (feedback !== 'positive') feedbackKind = null;

  // v0.33.48 - 支持配图手帐按 sessionId + expectedTs 精确定位历史记录；
  // 没有显式 sessionId 时沿用旧逻辑（当前对话的最近配图）
  let sessionId;
  if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
    sessionId = normalizeSessionId(body.sessionId.trim());
    if (!sessionId) return { ok: false, status: 400, error: 'sessionId 无效' };
    const resolved = await sessionForFeedback(ctx, {
      sessionId,
      sessionPath: body.sessionPath || '',
    });
    if (!resolved) {
      return { ok: false, status: 409, error: '这段对话当前不可用于配图反馈' };
    }
    sessionId = resolved.sessionId;
  } else {
    const sessionPath = await recentSessionPath(ctx, body.sessionPath || '');
    if (!sessionPath) return { ok: false, status: 409, error: '当前没有可反馈的对话' };
    const resolved = await sessionForFeedback(ctx, { sessionPath });
    sessionId = resolved?.sessionId || '';
    if (!sessionId) return { ok: false, status: 409, error: '当前对话不可用于配图反馈' };
  }
  const dataDir = dataDirOf(ctx);
  const records = readRecentRecord({ dataDir, sessionId }) || [];
  const expectedTs = Number(body.expectedTs) || undefined;
  const record = records.find((r) =>
    r?.stickerId === stickerId
    && (expectedTs === undefined || Number(r.ts) === expectedTs)
  );
  if (!record) return { ok: false, status: 404, error: '没有找到对应的配图记录' };
  if (feedback === 'clear' && !record.feedbackBase) {
    return { ok: false, status: 409, error: '这次反馈没有可撤销的记录' };
  }
  let stickerExists = false;
  try {
    const stickers = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    stickerExists = Array.isArray(stickers) && stickers.some((item) => item?.id === stickerId);
  } catch {}
  if (!stickerExists) return { ok: false, status: 404, error: '表情包不存在: ' + stickerId };

  const agentId = record.agentId || body.agentId || 'default';
  const emotion = record.emotion || '';
  const previousRecord = record.feedback
    ? { ...record, feedbackBase: record.feedbackBase, feedbackKind: record.feedbackKind }
    : null;

  // 更换正反馈类型时，先恢复当前这条反馈的旧状态，再写入新的语义，避免 context 账本叠加。
  if (previousRecord) {
    const restored = await restoreBallFeedbackEffects({ dataDir, stickerId, record: previousRecord, agentId });
    if (!restored.ok) return restored;
  }

  let applied;
  if (feedback === 'clear') {
    applied = { ok: true, feedback: null, feedbackKind: null, dislike_count: 0, feedbackBase: null };
  } else {
    applied = await applyBallFeedbackEffects({
      dataDir,
      stickerId,
      agentId,
      emotion,
      feedback,
      feedbackKind,
    });
    if (!applied.ok) {
      if (previousRecord) {
        await applyBallFeedbackEffects({
          dataDir,
          stickerId,
          agentId,
          emotion,
          feedback: previousRecord.feedback,
          feedbackKind: previousRecord.feedbackKind,
        }).catch(() => {});
      }
      return applied;
    }
  }

  const nextFeedback = feedback === 'clear' ? null : feedback;
  const nextKind = nextFeedback === 'positive' ? feedbackKind : null;
  const nextBase = nextFeedback ? applied.feedbackBase : null;
  const updated = await updateRecentFeedback({
    dataDir,
    sessionId,
    stickerId,
    feedback: nextFeedback,
    feedbackKind: nextKind,
    feedbackBase: nextBase,
    expectedTs: record.ts,
    expectedFeedback: record.feedback,
  });
  if (!updated.ok) {
    // 最近记录更新失败：撤掉新效果，再尽量恢复原反馈，避免偏好账本与纸飞机状态分叉。
    try {
      if (nextFeedback) await restoreBallFeedbackEffects({
        dataDir,
        stickerId,
        record: { ...record, feedback: nextFeedback, feedbackKind: nextKind, feedbackBase: nextBase },
        agentId,
      });
      if (previousRecord) await applyBallFeedbackEffects({
        dataDir,
        stickerId,
        agentId,
        emotion,
        feedback: previousRecord.feedback,
        feedbackKind: previousRecord.feedbackKind,
      });
    } catch (error) {
      ctx?.log?.warn?.('[biaoqingbao] feedback 补偿失败:', error?.message || error);
    }
    return updated;
  }
  return {
    ok: true,
    feedback: nextFeedback,
    feedback_kind: nextKind,
    dislike_count: applied.dislike_count,
    match: updated.match,
    message: feedbackMessage(feedback, nextKind),
  };
}

export function submitBallFeedback(ctx, body = {}) {
  return serializeFeedbackOperation(() => submitBallFeedbackInternal(ctx, body));
}

async function proxyPluginApi(ctx, route, body = {}) {
  const info = readServerInfo(HANA_HOME);
  const fetcher = ctx?.network?.fetch || globalThis.fetch;
  if (!info || typeof fetcher !== 'function') {
    return { ok: false, status: 503, error: 'Hana 本地接口暂时不可用' };
  }
  try {
    const response = await fetcher(`http://127.0.0.1:${info.port}/api/plugins/biaoqingbao${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${info.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok && result.ok !== false) result.ok = false;
    if (!response.ok) result.status = response.status;
    return result;
  } catch (error) {
    return { ok: false, status: 503, error: error?.message || 'Hana 本地接口请求失败' };
  }
}

async function buildBallRecognition(ctx, body = {}) {
  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : '';
  if (!imageBase64) return { ok: false, status: 400, error: '缺少图片数据' };
  const fileName = typeof body?.fileName === 'string' && body.fileName.trim()
    ? body.fileName.trim().slice(0, 120)
    : `ball_${Date.now()}.png`;
  // 直接调用 shared 层识图，和网页 /api/auto-tag 同一条链路
  try {
    const groupStore = readGroupStore();
    const recognitionHints = isGroupStoreReadable(groupStore) ? buildRecognitionGroupHints(groupStore) : '';
    const result = await tagImage(imageBase64, fileName, { recognitionHints });
    if (!result.ok) return { ok: false, status: 500, error: result.error || '识图失败' };
    // 字段白名单 + 清洗，避免前端传什么就收什么
    const d = result.data || {};
    return {
      ok: true,
      data: {
        description: Array.isArray(d.description) ? d.description.join(',') : String(d.description || '').slice(0, 100),
        semantic_description: String(d.semantic_description || '').slice(0, 300),
        emotion: Array.isArray(d.emotion) ? d.emotion.map((s) => String(s).slice(0, 30)).filter(Boolean) : [],
        scene: Array.isArray(d.scene) ? d.scene.map((s) => String(s).slice(0, 10)).filter(Boolean) : [],
        keywords: Array.isArray(d.keywords) ? d.keywords.map((s) => String(s).slice(0, 30)).filter(Boolean) : [],
        atmosphere: Array.isArray(d.atmosphere) ? d.atmosphere.map((s) => String(s).slice(0, 30)).filter(Boolean) : [],
        group_suggestions: suggestGroupsForTags(d, groupStore),
      },
    };
  } catch (error) {
    return { ok: false, status: 500, error: error?.message || '识图失败' };
  }
}

function sanitizeTagList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((s) => String(s).trim().slice(0, limit)).filter(Boolean).slice(0, 20);
}

// 纸飞机识图确认入库后，这张图已经完成识图；added_at 与 tagged_at 使用同一时间，避免图库误判为“未识图”。
export function buildBallStickerEntry({ id, file, tags = {}, groupIds = [], now = new Date().toISOString() }) {
  const desc = String(tags.description || '').trim().slice(0, 100) || file.replace(/\.[^.]+$/, '');
  const entry = {
    id,
    file,
    description: desc,
    semantic_description: String(tags.semantic_description || '').trim().slice(0, 300),
    tags: {
      emotion: sanitizeTagList(tags.emotion, 30),
      scene: sanitizeTagList(tags.scene, 10),
      keywords: sanitizeTagList(tags.keywords, 30),
    },
    added_at: now,
    tagged_at: now,
  };
  const normalizedGroupIds = normalizeGroupIds(groupIds);
  if (normalizedGroupIds.length) entry.groupIds = normalizedGroupIds;
  return entry;
}

async function writeBallStickerToLibrary(ctx, { imageBase64, fileName, tags = {}, groupIds = [] }) {
  if (!imageBase64 || !fileName) return { ok: false, error: '图片数据或文件名缺失' };
  let buffer;
  try {
    buffer = Buffer.from(imageBase64, 'base64');
  } catch {
    return { ok: false, error: '图片数据格式非法' };
  }
  if (!buffer.length) return { ok: false, error: '图片数据为空' };
  const extMatch = fileName.match(/\.([a-zA-Z0-9]{1,5})$/);
  const safeExt = extMatch ? extMatch[1].toLowerCase() : 'png';
  const allowed = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
  const ext = allowed.has(safeExt) ? safeExt : 'png';

  return await enqueueToolWrite(async () => {
    let stickers = readMeta();
    if (!Array.isArray(stickers)) stickers = [];
    const id = genId();
    const file = `${id}.${ext}`;
    const dest = safeStickerPath(STICKERS_DIR, file);
    if (!dest) return { ok: false, error: '图库目录路径不安全，无法写入图片' };
    try {
      await fs.promises.writeFile(dest, buffer);
    } catch (error) {
      return { ok: false, error: `写图片文件失败: ${error.message}` };
    }
    const groupStore = readGroupStore();
    const requestedGroupIds = Array.isArray(groupIds) ? groupIds : [];
    let normalizedGroupIds = [];
    if (requestedGroupIds.length > 0) {
      if (!isGroupStoreReadable(groupStore)) {
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, error: '分组配置文件损坏或无法读取，暂时不能把图片加入分组' };
      }
      normalizedGroupIds = normalizeGroupIds(requestedGroupIds, getKnownGroupIds(groupStore));
      if (normalizedGroupIds.length !== new Set(requestedGroupIds.map((value) => String(value || '').trim()).filter(Boolean)).size) {
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, error: '识图建议里的分组已失效，请刷新分组后重试' };
      }
    }
    const entry = buildBallStickerEntry({ id, file, tags, groupIds: normalizedGroupIds });
    stickers.push(entry);
    writeMeta(stickers);
    ctx?.log?.info?.(`[biaoqingbao-ball] 识图入库: ${id} (${file})`);
    return { ok: true, entry };
  });
}

async function writeBallStickerVector(ctx, entry) {
  const semantic = (entry?.semantic_description || '').trim();
  if (!semantic) return { ok: true, skipped: 'no-semantic' };
  const { model: currentModel, dimensions: currentDims } = resolveEmbeddingApi();
  try {
    const embResult = await generateEmbeddings(semantic);
    if (!embResult.ok || !Array.isArray(embResult.data) || !embResult.data[0]) {
      return { ok: false, skipped: 'embedding-failed', error: embResult.error || '向量生成失败' };
    }
    const vectorsData = readVectors();
    if (!vectorsData.vectors) vectorsData.vectors = {};
    // 模型变更保护：旧库已有不同 model 时不混写，避免维度冲突（与单图重算逻辑一致）
    if (vectorsData.model && currentModel && vectorsData.model !== currentModel) {
      return { ok: false, skipped: 'model-changed', error: `向量模型已更换（${vectorsData.model} → ${currentModel}），请到图库页「图库语义索引」里整体重算` };
    }
    vectorsData.vectors[entry.id] = embResult.data[0];
    vectorsData.generated_at = new Date().toISOString();
    if (!vectorsData.model) vectorsData.model = currentModel || '';
    if (!vectorsData.dimensions) vectorsData.dimensions = currentDims || 0;
    writeVectors(vectorsData);
    return { ok: true };
  } catch (error) {
    return { ok: false, skipped: 'embedding-error', error: error?.message || '向量生成失败' };
  }
}

// v0.33.29 - 分享版开关：悬浮球识图确认入库时是否自动生成向量（默认关，避免隐性消耗付费模型 token）
export function shouldAutoVectorOnSave(cfg) {
  if (cfg && typeof cfg === 'object') {
    return cfg.autoVectorOnSave === true;
  }
  return readEmbeddingConfig().autoVectorOnSave === true;
}

async function confirmBallRecognition(ctx, body = {}) {
  const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64.trim() : '';
  const fileName = typeof body?.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 120) : `ball_${Date.now()}.png`;
  const tags = body?.tags && typeof body.tags === 'object' ? body.tags : {};
  const groupIds = Array.isArray(body?.groupIds) ? body.groupIds : [];
  const addToBall = body?.addToBall !== false;
  const teaching = body?.teaching === true;
  if (!imageBase64) return { ok: false, status: 400, error: '缺少图片数据' };

  const written = await writeBallStickerToLibrary(ctx, { imageBase64, fileName, tags, groupIds });
  if (!written.ok) return { ok: false, status: 500, error: written.error || '入库失败' };
  const entry = written.entry;

  // v0.26.0 教学机制：悬浮球确认入库时，用户手动改过标签（前端带 teaching=true）才记教学样本；
  // 未改（AI 自动结果直接入库）不算教学，避免把模型自己的识别错误固化成教学。
  let teachingSaved = false;
  if (teaching) {
    try {
      const t = await upsertTeachingSample(entry.id, {
        description: String(tags.description || '').trim().slice(0, 100),
        keywords: Array.isArray(tags.keywords) ? tags.keywords.map((s) => String(s).trim().slice(0, 30)).filter(Boolean) : [],
        semanticDescription: String(tags.semantic_description || '').trim().slice(0, 300),
      });
      teachingSaved = t?.ok === true;
    } catch {
      teachingSaved = false;
    }
  }

  let vector = { ok: true, skipped: 'not-run' };
  // v0.33.29 - 分享版开关：默认关（避免隐性消耗付费模型 token），开关开才在入库时自动生成向量
  if (shouldAutoVectorOnSave()) {
    try {
      vector = await writeBallStickerVector(ctx, entry);
    } catch (error) {
      vector = { ok: false, skipped: 'embedding-error', error: error?.message };
    }
  }

  let pinned = { ok: true, skipped: false };
  if (addToBall) {
    try {
      pinned = await updatePinned(ctx, entry.id, true);
      if (!pinned.ok) pinned = { ok: true, skipped: 'pin-failed' };
      else pinned = { ok: true };
    } catch {
      pinned = { ok: true, skipped: 'pin-failed' };
    }
  }

  return {
    ok: true,
    data: {
      sticker: entry,
      vector: vector.ok ? 'ok' : (vector.skipped || 'failed'),
      vector_error: vector.ok ? null : (vector.error || ''),
      pinned: addToBall ? 'ok' : 'skipped',
      teaching_saved: teachingSaved,
    },
    message: '已入库' + (addToBall ? '并加入悬浮球' : ''),
  };
}

async function regenerateBallVector(ctx, body = {}) {
  const stickerId = typeof body?.stickerId === 'string' ? body.stickerId.trim() : '';
  if (!stickerId) return { ok: false, status: 400, error: '缺少 sticker id' };
  const sticker = readMeta().find((item) => item?.id === stickerId);
  if (!sticker) return { ok: false, status: 404, error: '表情包不存在' };
  const vec = await writeBallStickerVector(ctx, sticker);
  return {
    ok: true,
    data: {
      sticker_id: stickerId,
      vector: vec.ok ? 'ok' : (vec.skipped || 'failed'),
      vector_error: vec.ok ? null : (vec.error || ''),
    },
  };
}

function extractStageFile(sf) {
  return {
    fileId: sf?.file?.fileId || sf?.mediaItem?.fileId || sf?.fileId || '',
    stagedPath: sf?.file?.filePath || sf?.mediaItem?.filePath || sf?.file?.realPath || '',
    sessionId: sf?.file?.sessionId || sf?.mediaItem?.sessionId || sf?.sessionId || '',
  };
}

async function sendToSession(runtimeState, target, body, requestId) {
  const hit = stickerById(body.stickerId);
  if (!hit) return { ok: false, status: 404, error: '没有找到这张表情包', requestId };
  if (!runtimeState.ctx?.bus || typeof runtimeState.ctx.bus.request !== 'function') {
    return { ok: false, status: 500, error: '当前 Hana 消息通道不可用', requestId };
  }
  const userText = sanitizeBallText(body.text, MAX_TEXT_LENGTH);

  // Hana 的 session:send 直通 images 会让聊天历史退化成「图片已省略」占位符。
  // 先登记附件并把 [SessionFile]/[attached_image] 放进消息，前端才能按用户发图链路还原原图；
  // images 只保留为登记失败时的最后兜底，不让正常路径再触发辅助视觉限额或可见警告。
  let images = [];
  try {
    const buf = fs.readFileSync(hit.filePath);
    const ext = path.extname(hit.filePath).slice(1).toLowerCase();
    const mimeType = MIME_MAP[ext] || 'image/png';
    if (buf.length > 0 && buf.length <= 20 * 1024 * 1024) {
      images = [{ type: 'image', data: buf.toString('base64'), mimeType }];
    }
  } catch (imageError) {
    runtimeState.ctx?.log?.warn?.('[biaoqingbao-ball] 读取表情包图片失败，改走附件登记: ' + (imageError?.message || imageError));
  }

  let staged = await uploadStickerAsUser({
    ctx: runtimeState.ctx,
    hanaHome: HANA_HOME,
    sessionPath: target.sessionPath,
    srcPath: hit.filePath,
    fileName: hit.sticker.file,
  }).catch(() => null);

  if (!staged && runtimeState.ctx?.stageFile && typeof runtimeState.ctx.stageFile === 'function') {
    const sessionIdOfTarget = readSessionIdFromFile(target.sessionPath);
    const managedPath = sessionIdOfTarget
      ? materializeStickerCopy({
          hanaHome: HANA_HOME,
          sessionId: sessionIdOfTarget,
          srcPath: hit.filePath,
          fileName: hit.sticker.file,
        })
      : null;
    const stageSource = managedPath || hit.filePath;
    try {
      staged = extractStageFile(await runtimeState.ctx.stageFile({
        filePath: stageSource,
        sessionPath: target.sessionPath,
        label: hit.sticker.file,
      }));
    } catch (error) {
      runtimeState.ctx?.log?.warn?.('[biaoqingbao-ball] 附件登记失败，保留原图兜底: ' + (error?.message || error));
    }
  }
  if (staged && !staged.sessionId) {
    staged.sessionId = readSessionIdFromFile(target.sessionPath) || '';
  }
  let payload;
  try {
    payload = buildBallSendPayload({
      sessionPath: target.sessionPath,
      sticker: hit.sticker,
      text: userText,
      staged,
      images,
    });
  } catch (error) {
    return { ok: false, status: 500, error: error?.message || '消息组装失败', requestId };
  }

  let lastError = '';
  for (let attempt = 0; attempt <= TARGET_RETRY_DELAYS.length; attempt += 1) {
    try {
      const result = await runtimeState.ctx.bus.request(
        'session:send',
        payload,
        { timeoutMs: 8000 },
      );
      if (result?.ok === false) {
        return { ok: false, status: 500, error: result.error || 'Hana 拒绝了发送', requestId };
      }
      await recordSuccessfulExposure({
        dataDir: dataDirOf(runtimeState.ctx),
        agentId: target.agentId || 'default',
        stickerId: hit.sticker.id,
      }).catch((error) => runtimeState.ctx?.log?.warn?.('[biaoqingbao-ball] 手动发送曝光记账失败: ' + (error?.message || error)));
      return {
        ok: true,
        requestId,
        target: { agentId: target.agentId, name: readAgentName(target.agentId) },
      };
    } catch (error) {
      lastError = error?.message || String(error);
      if (!/busy/i.test(lastError) || attempt >= TARGET_RETRY_DELAYS.length) break;
      await new Promise((resolve) => setTimeout(resolve, TARGET_RETRY_DELAYS[attempt]));
    }
  }
  if (/timeout|timed out|aborted/i.test(lastError)) {
    return { ok: false, status: 504, error: 'Hana 响应超时，消息可能已经送达，请先看一下对话', requestId };
  }
  return { ok: false, status: 500, error: '发送失败：' + lastError, requestId };
}

async function sendSticker(runtimeState, body = {}) {
  const requestId = typeof body.requestId === 'string' && body.requestId.trim()
    ? body.requestId.trim().slice(0, MAX_REQUEST_ID_LENGTH)
    : createRequestId();
  const cached = sendCache.get(requestId);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (sendInFlight.has(requestId)) return sendInFlight.get(requestId);

  const task = (async () => {
    const target = await resolveTarget(runtimeState.ctx);
    if (!target || !isDesktopSessionPath(target.sessionPath, { hanaHome: HANA_HOME })) {
      return { ok: false, status: 409, error: '还没找到正在聊天的窗口', requestId };
    }
    try {
      const stat = fs.statSync(target.sessionPath);
      if (!stat.isFile()) return { ok: false, status: 409, error: '当前聊天窗口已经不存在', requestId };
    } catch {
      return { ok: false, status: 409, error: '当前聊天窗口已经不存在', requestId };
    }
    return sendToSession(runtimeState, target, body, requestId);
  })();

  sendInFlight.set(requestId, task);
  try {
    const result = await task;
    sendCache.set(requestId, { result, expiresAt: Date.now() + SEND_CACHE_MS });
    for (const [key, value] of sendCache) {
      if (value.expiresAt <= Date.now()) sendCache.delete(key);
    }
    return result;
  } finally {
    if (sendInFlight.get(requestId) === task) sendInFlight.delete(requestId);
  }
}

function ipcResult(result) {
  return result?.ok === false && result?.status
    ? { status: result.status, body: result }
    : result;
}

function registerProxyRoutes(runtimeState) {
  const ipc = runtimeState.ipc;
  ipc.route('GET', '/health', () => ({
    ok: true,
    running: !!runtimeState.process?.status().running,
    connected: runtimeState.connected,
    heartbeat: runtimeState.heartbeat ? { lastHeartbeat: runtimeState.heartbeat.lastHeartbeat, stale: runtimeState.heartbeat.isStale() } : null,
  }));
  ipc.route('POST', '/heartbeat', () => {
    runtimeState.heartbeat?.beat();
    runtimeState.connected = true;
    return { ok: true };
  });
  ipc.route('POST', '/ready', () => {
    runtimeState.connected = true;
    return { ok: true };
  });
  ipc.route('GET', '/variant', () => ({ ok: true, variant: readBallVariant(runtimeState.ctx) }));
  ipc.route('POST', '/variant', async ({ body }) => {
    const result = await setBallVariant(runtimeState.ctx, body?.variant);
    if (result.ok) runtimeState.variant = result.variant;
    return result.ok ? result : { status: result.status || 400, body: result };
  });
  ipc.route('GET', '/target', () => targetPayload(runtimeState.ctx));
  ipc.route('GET', '/sessions', async () => {
    const pinned = readPinnedTarget(runtimeState.ctx);
    return {
      ok: true,
      sessions: await listSessions(runtimeState.ctx, 5),
      mode: pinned ? 'pinned' : 'auto',
      pinned: pinned ? { sessionPath: pinned.sessionPath, title: pinned.title || '' } : null,
    };
  });
  ipc.route('POST', '/target', async ({ body }) => {
    const sessionPath = typeof body?.sessionPath === 'string' && body.sessionPath.trim() ? body.sessionPath.trim() : '';
    if (!sessionPath) {
      await setPinnedTarget(runtimeState.ctx, null);
      return { ok: true, mode: 'auto' };
    }
    if (!isDesktopSessionPath(sessionPath, { hanaHome: HANA_HOME })) {
      return { status: 400, body: { ok: false, error: '无效的会话路径' } };
    }
    try {
      if (!fs.statSync(sessionPath).isFile()) {
        return { status: 400, body: { ok: false, error: '这段对话已经不存在了' } };
      }
    } catch {
      return { status: 400, body: { ok: false, error: '这段对话已经不存在了' } };
    }
    await setPinnedTarget(runtimeState.ctx, {
      agentId: typeof body?.agentId === 'string' ? body.agentId : '',
      sessionPath,
      title: typeof body?.title === 'string' ? body.title : '',
    });
    return { ok: true, mode: 'pinned' };
  });
  ipc.route('GET', '/recent-match', async () => ipcResult(await getRecentBallMatch(runtimeState.ctx)));
  // v0.33.48 - 配图手帐：最近 N 条配图记录（跨会话），带 sticker 元数据供列表渲染
  ipc.route('GET', '/recent-matches', async ({ query }) => {
    const limit = Math.max(1, Math.min(Number(query?.limit) || 10, 30));
    const matches = readRecentMatches({ dataDir: dataDirOf(runtimeState.ctx), limit });
    const meta = readMeta();
    const titles = await sessionTitleMaps(runtimeState.ctx);
    const visibleMatches = filterRecentMatchesForPublicSessions(matches, titles.publicIds);
    return {
      ok: true,
      matches: visibleMatches.map((m) => {
        const sticker = meta.find((s) => s?.id === m.stickerId);
        return {
          sessionId: m.sessionId,
          sessionTitle: recentSessionTitle(m, titles.byId),
          stickerId: m.stickerId,
          file: sticker?.file || '',
          description: String(sticker?.description || m.description || '').slice(0, 120),
          emotion: m.emotion || '',
          agentId: m.agentId || '',
          ts: Number(m.ts) || 0,
          delivery: m.delivery || '',
          feedback: m.feedback || null,
          feedbackKind: m.feedbackKind || null,
        };
      }),
    };
  });
  ipc.route('POST', '/feedback', async ({ body }) => ipcResult(await submitBallFeedback(runtimeState.ctx, body)));
  ipc.route('POST', '/chat', async ({ body }) => ipcResult(await proxyPluginApi(runtimeState.ctx, '/api/sticker/chat', body)));
  ipc.route('POST', '/chat/confirm', async ({ body }) => ipcResult(await proxyPluginApi(runtimeState.ctx, '/api/sticker/chat/confirm', body)));
  ipc.route('POST', '/chat/close', async ({ body }) => ipcResult(await proxyPluginApi(runtimeState.ctx, '/api/sticker/chat/close', body)));
  ipc.route('POST', '/recognition', async ({ body }) => ipcResult(await buildBallRecognition(runtimeState.ctx, body)));
  ipc.route('POST', '/recognition-confirm', async ({ body }) => ipcResult(await confirmBallRecognition(runtimeState.ctx, body)));
  ipc.route('POST', '/recognition-vector', async ({ body }) => ipcResult(await regenerateBallVector(runtimeState.ctx, body)));
  ipc.route('GET', '/stickers', () => ({
    ok: true,
    stickers: readMeta().map(serializedSticker).filter(Boolean),
  }));
  ipc.route('GET', '/pinned', () => {
    const config = normalizedConfig(runtimeState.ctx);
    const stickers = config.pinnedIds.map((id) => serializedSticker(readMeta().find((item) => item?.id === id))).filter(Boolean);
    return { ok: true, ...config, stickers };
  });
  // 悬浮球图集拖拽排序：只调序，不增删；校验通过后整体写回 pinnedIds
  ipc.route('POST', '/pinned/reorder', async ({ body }) => {
    const newIds = Array.isArray(body?.ids) ? body.ids : null;
    if (!newIds) return { status: 400, body: { ok: false, error: '参数不完整：需要 ids 数组' } };
    const current = normalizedConfig(runtimeState.ctx).pinnedIds;
    const checked = validatePinnedReorder(newIds, current);
    if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } };
    const store = configStoreOf(runtimeState.ctx);
    await store.update((config) => {
      config.version = 2;
      config.pinnedIds = checked.pinnedIds;
      config.variant = normalizeBallVariant(config.variant);
      if (!Object.prototype.hasOwnProperty.call(config, 'pinnedTarget')) config.pinnedTarget = null;
    });
    return { ok: true, ...normalizedConfig(runtimeState.ctx) };
  });
  ipc.route('GET', '/image', ({ url }) => {
    const query = new URL(url, 'http://127.0.0.1').searchParams;
    const hit = stickerById(query.get('id') || '');
    if (!hit) return { status: 404, body: { ok: false, error: '图片不存在' } };
    try {
      const ext = path.extname(hit.filePath).slice(1).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      return { ok: true, mime, data: fs.readFileSync(hit.filePath).toString('base64') };
    } catch {
      return { status: 404, body: { ok: false, error: '图片读取失败' } };
    }
  });
  ipc.route('POST', '/pin', async ({ body }) => {
    if (typeof body?.stickerId !== 'string' || typeof body?.pinned !== 'boolean') {
      return { status: 400, body: { ok: false, error: '参数不完整' } };
    }
    return updatePinned(runtimeState.ctx, body.stickerId, body.pinned);
  });
  // 整个删除：先调后端 /api 删图库（含偏好/向量/教学），再清悬浮球列表，避免孤儿 pinned
  ipc.route('POST', '/sticker-delete', async ({ body }) => {
    const stickerId = typeof body?.stickerId === 'string' ? body.stickerId.trim() : '';
    if (!stickerId) return { status: 400, body: { ok: false, error: '缺少 sticker id' } };
    const deleted = await proxyPluginApi(runtimeState.ctx, '/api', { action: 'delete', id: stickerId });
    const unpinned = await updatePinned(runtimeState.ctx, stickerId, false).catch((e) => ({ ok: false, error: e?.message }));
    return {
      ok: deleted.ok !== false,
      error: deleted.ok === false ? (deleted.error || '删除失败') : (unpinned?.ok === false ? (unpinned.error || '清理悬浮球列表失败') : null),
      deleted: deleted.ok !== false,
    };
  });
  ipc.route('POST', '/send', async ({ body }) => sendSticker(runtimeState, body));
}

async function waitForReady(runtimeState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!runtimeState.process?.status().running) return false;
    try {
      const response = await fetch(`${runtimeState.ipc.url}/health`, {
        headers: { Authorization: `Bearer ${runtimeState.ipc.token}` },
        signal: AbortSignal.timeout(500),
      });
      const data = await response.json();
      if (data?.ok && data.connected) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stopRuntime(runtimeState) {
  if (!runtimeState) return;
  runtimeState.stopping = true;
  stopHeartbeatCheck();
  try { await runtimeState.process?.stop({ timeoutMs: 5000 }); } catch {}
  try { await runtimeState.ipc?.stop(); } catch {}
  runtimeState.connected = false;
  runtimeState.heartbeat?.reset();
}

async function startBallInternal(ctx) {
  if (runtime?.process?.status().running) return { ok: true, message: '已在运行' };
  const deps = await checkBallDeps();
  if (!deps.ok) return { ok: false, error: deps.error || '缺少 PyQt6' };
  if (!fs.existsSync(BALL_SCRIPT)) return { ok: false, error: 'ball_app.py 不存在' };

  const dataDir = dataDirOf(ctx);
  const ipc = new LocalIpcServer({
    port: PROXY_PORT,
    host: '127.0.0.1',
    cors: false,
    // 识图需要把 base64 图片经 IPC 传给 Node；2MB 对 QQ 群大图仍可能不够（base64 膨胀 1/3），
    // Python 端已做压缩兜底，这里再抬到 8MB 防极端大图/GIF。仅影响本代理。
    maxBodyBytes: 8 * 1024 * 1024,
    log: (line) => ctx?.log?.warn?.('[biaoqingbao-ball] ' + line),
  });
  const runtimeState = {
    ctx,
    dataDir,
    ipc,
    process: null,
    connected: false,
    stopping: false,
    lastProcessLine: '',
    variant: readBallVariant(ctx),
    heartbeat: createHeartbeatTracker({ staleAfterMs: HEARTBEAT_STALE_AFTER_MS }),
  };
  registerProxyRoutes(runtimeState);
  const listen = await ipc.start();
  if (!listen.ok) {
    lastState = { ...lastState, running: false, connected: false, error: listen.error };
    return { ok: false, error: listen.error };
  }

  const process = new PythonProcess({
    name: '表情包球',
    script: BALL_SCRIPT,
    cwd: PY_DIR,
    env: {
      BIAOQINGBAO_BALL_API: ipc.url,
      BIAOQINGBAO_BALL_TOKEN: ipc.token,
      BIAOQINGBAO_BALL_STATE_PATH: path.join(dataDir, 'ball-state.json'),
      BIAOQINGBAO_BALL_VARIANT: runtimeState.variant,
      HANA_HOME,
    },
    log: (line) => {
      runtimeState.lastProcessLine = String(line || '').slice(-500);
      ctx?.log?.info?.(line);
    },
  });
  runtimeState.process = process;
  runtime = runtimeState;
  process.onExit(({ exitCode, error }) => {
    stopHeartbeatCheck();
    runtimeState.heartbeat?.reset();
    lastState = {
      running: false,
      connected: false,
      startedAt: lastState.startedAt,
      exitCode,
      error: error || (exitCode === 0 ? null : runtimeState.lastProcessLine || '悬浮球进程已退出'),
    };
    runtimeState.connected = false;
    // 进程退出（右键关闭/崩溃/被用户停）：视为用户已关闭，本次运行期间不再自动弹
    dismissedByUser = true;
    if (!runtimeState.stopping && runtime === runtimeState) {
      runtime = null;
      ipc.stop().catch(() => {});
    }
    // v0.33.42 - 非正常退出（崩溃/被杀，exitCode 非 0）自动重启；
    // 用户主动停（stopBall/右键关闭，stopping=true）不重启
    const crashed = exitCode !== 0 && !runtimeState.stopping;
    if (crashed) {
      ctx?.log?.warn?.(`[biaoqingbao-ball] 悬浮球异常退出(exitCode=${exitCode})，${AUTO_RESTART_DELAY_MS / 1000}s 后自动重启 (${autoRestartCount + 1}/${MAX_AUTO_RESTARTS})`);
      scheduleAutoRestart(runtimeState);
    } else {
      autoRestartCount = 0;
    }
  });

  const started = await process.start();
  if (!started.ok) {
    await stopRuntime(runtimeState);
    runtime = null;
    lastState = { ...lastState, running: false, connected: false, error: started.error };
    return started;
  }
  lastState = {
    running: true,
    connected: false,
    startedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
  };
  if (!await waitForReady(runtimeState)) {
    await stopRuntime(runtimeState);
    runtime = null;
    lastState = {
      ...lastState,
      running: false,
      connected: false,
      error: runtimeState.lastProcessLine || '悬浮球进程启动后没有回应',
    };
    return { ok: false, error: lastState.error };
  }
  runtimeState.connected = true;
  runtimeState.heartbeat?.reset();
  lastState.connected = true;
  dismissedByUser = false; // 用户重新要球了，下次打开页面恢复自动
  startHeartbeatCheck(runtimeState);
  return { ok: true, message: '已启动' };
}

// 运行期心跳检查：每 HEARTBEAT_CHECK_MS 看一次 Python 是否失联。
// 失联且进程已死 → 走自动重启；进程还活着 → 只标记 disconnected（不误杀，渲染崩了也不怕）。
function startHeartbeatCheck(runtimeState) {
  stopHeartbeatCheck();
  heartbeatCheckTimer = setInterval(() => {
    if (!runtimeState || runtimeState.stopping) return;
    const processState = runtimeState.process?.status?.();
    if (!processState?.running) return; // 进程退出路径由 onExit 管
    if (!runtimeState.heartbeat?.isStale()) return;
    // 进程还活着但心跳超时：渲染/事件循环可能卡死，标记失联不误杀（保持已知，不重启循环）
    runtimeState.connected = false;
    const lastBeat = runtimeState.heartbeat?.lastHeartbeat
      ? new Date(runtimeState.heartbeat.lastHeartbeat).toISOString()
      : '从未';
    ctxLogWarn(runtimeState, `[biaoqingbao-ball] 悬浮球心跳失联（${HEARTBEAT_STALE_AFTER_MS / 1000}s 无上报，最后心跳 ${lastBeat}），进程仍在，保持标记失联不误杀`);
  }, HEARTBEAT_CHECK_MS);
  heartbeatCheckTimer.unref?.();
}

function stopHeartbeatCheck() {
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
}

function ctxLogWarn(runtimeState, message) {
  try { runtimeState?.ctx?.log?.warn?.(message); } catch {}
}

export function startBall(ctx) {
  return serializeOperation(() => startBallInternal(ctx));
}

export function stopBall() {
  return serializeOperation(async () => {
    // 用户主动停止：取消待执行的自动重启并清零计数
    if (autoRestartTimer) { clearTimeout(autoRestartTimer); autoRestartTimer = null; }
    autoRestartCount = 0;
    if (!runtime) return { ok: true, message: '未在运行' };
    dismissedByUser = true; // 用户手动收起：本次打开页面不再自动弹，下次再弹
    const current = runtime;
    await stopRuntime(current);
    if (runtime === current) runtime = null;
    lastState = {
      ...lastState,
      running: false,
      connected: false,
      exitCode: null,
      error: null,
    };
    return { ok: true, message: '已停止' };
  });
}

export function getBallState() {
  const processState = runtime?.process?.status();
  return {
    ok: true,
    running: !!processState?.running,
    connected: !!runtime?.connected,
    startedAt: processState?.startedAt ? new Date(processState.startedAt).toISOString() : lastState.startedAt,
    exitCode: processState?.exitCode ?? lastState.exitCode,
    error: processState?.error || lastState.error,
    port: PROXY_PORT,
  };
}

// v0.33.42 - 非正常退出自动重启：延迟拉起，成功清计数；连续 MAX_AUTO_RESTARTS 次失败放弃
function scheduleAutoRestart(runtimeState) {
  const ctx = runtimeState.ctx;
  if (autoRestartCount >= MAX_AUTO_RESTARTS) {
    ctx?.log?.warn?.(`[biaoqingbao-ball] 悬浮球连续异常退出 ${MAX_AUTO_RESTARTS} 次，停止自动重启`);
    return;
  }
  autoRestartCount += 1;
  if (autoRestartTimer) clearTimeout(autoRestartTimer);
  autoRestartTimer = setTimeout(async () => {
    autoRestartTimer = null;
    if (runtime?.process?.status().running) { autoRestartCount = 0; return; } // 用户已手动拉起来了
    ctx?.log?.warn?.(`[biaoqingbao-ball] 自动重启悬浮球 (${autoRestartCount}/${MAX_AUTO_RESTARTS})`);
    const started = await startBallInternal(ctx);
    if (started.ok) autoRestartCount = 0;
  }, AUTO_RESTART_DELAY_MS);
}

let depsCache = null;
let depsCacheAt = 0;
export async function checkBallDeps() {
  if (depsCache && Date.now() - depsCacheAt < 30_000) return depsCache;
  const checked = await checkDeps({
    probeCode: 'import PyQt6; import PyQt6.QtSvg',
    timeoutMs: 15_000,
    cacheMs: 30_000,
  });
  depsCache = {
    ...checked,
    pyQtOk: !!checked.ok,
    error: checked.ok ? null : '悬浮球需要 Python + PyQt6，当前环境还不能加载它',
  };
  depsCacheAt = Date.now();
  return depsCache;
}

export function readBallConfig(ctx) {
  return normalizedConfig(ctx);
}

export function setBallPinned(ctx, stickerId, pinned) {
  return updatePinned(ctx, stickerId, pinned);
}

export {
  PROXY_PORT,
  BALL_VARIANTS,
  normalizeBallVariant,
  readBallVariant,
  setBallVariant,
  sendSticker,
  stickerById,
  readPinnedTarget,
  setPinnedTarget,
  resolveTarget,
  listSessions,
  currentTarget,
  sessionTitleOf,
};
