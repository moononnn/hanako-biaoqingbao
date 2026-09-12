// 表情包自定义分组：图库归属、伙伴白名单与分组偏爱
// 分组是用户资产，独立存放在 plugin-data/biaoqingbao/sticker-groups.json。

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const GROUPS_FILE_NAME = 'sticker-groups.json';
export const GROUP_STORE_VERSION = 1;
export const UNGROUPED_GROUP_ID = '__ungrouped__';
// 分组权重档位（1~3 星）：每档对应的加权分值。分值锚在语义分的量级上，只做小幅推举，不压过真实匹配。
export const GROUP_WEIGHT_BONUS = Object.freeze({ 1: 2, 2: 4, 3: 7 });
export const GROUP_WEIGHT_MIN = 1;
export const GROUP_WEIGHT_MAX = 3;
// 旧版二值星标迁移到 2 档，力度与改造前基本持平。
export const LEGACY_FAVORITE_WEIGHT = 2;
export const MAX_GROUPS = 200;
export const MAX_GROUP_NAME_LENGTH = 80;
export const MAX_RECOGNITION_ALIASES = 20;
export const MAX_RECOGNITION_ALIAS_LENGTH = 80;
export const NAME_MIGRATIONS_FILE_NAME = 'sticker-group-name-migrations.json';
export const NAME_MIGRATION_STORE_VERSION = 1;
export const MAX_NAME_MIGRATIONS = 20;
export const MAX_NAME_MIGRATION_ITEMS = 20000;
export const MAX_GROUP_IDS_PER_STICKER = 50;
// 分组总数上限本身就是伙伴白名单/导出筛选的上限，不能复用单张图片的 50 组限制。
export const MAX_GROUP_IDS_PER_AGENT = MAX_GROUPS;
// 图片描述上限与编辑接口保持一致（routes/api.js 写描述时 slice(0, 100)）。
export const MAX_NAMING_DESCRIPTION_LENGTH = 100;
// 组名写进描述时用的连接符。
export const NAMING_SEPARATOR = '，';

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

const RESERVED_OBJECT_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype).concat('prototype'));

function safeId(value) {
  const id = cleanText(value, 120);
  if (RESERVED_OBJECT_KEYS.has(id)) return '';
  return /^[A-Za-z0-9_-]+$/.test(id) && id !== UNGROUPED_GROUP_ID ? id : '';
}

function safeAgentId(value) {
  return safeId(value);
}

function safeTimestamp(value) {
  const text = cleanText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function unique(values, max = MAX_GROUP_IDS_PER_STICKER) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = safeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeRecognitionAliases(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[，,、\n]/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const alias = cleanText(item, MAX_RECOGNITION_ALIAS_LENGTH);
    const key = alias.toLocaleLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
    if (result.length >= MAX_RECOGNITION_ALIASES) break;
  }
  return result;
}

export function groupStorePath(dataDir = DATA_DIR) {
  return path.join(dataDir, GROUPS_FILE_NAME);
}

export function nameMigrationStorePath(dataDir = DATA_DIR) {
  return path.join(dataDir, NAME_MIGRATIONS_FILE_NAME);
}

const GROUP_STORE_STATUS = Symbol('group-store-status');

function markGroupStoreStatus(store, status) {
  Object.defineProperty(store, GROUP_STORE_STATUS, {
    value: status,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

export function emptyGroupStore() {
  return { version: GROUP_STORE_VERSION, groups: [], agents: {} };
}

export function isGroupStoreReadable(store) {
  return store?.[GROUP_STORE_STATUS]?.ok !== false;
}

export function getGroupStoreError(store) {
  return isGroupStoreReadable(store) ? '' : String(store?.[GROUP_STORE_STATUS]?.error || '分组文件读取失败');
}

function corruptGroupStore(error) {
  return markGroupStoreStatus(emptyGroupStore(), {
    ok: false,
    error: error?.message || String(error || '分组文件格式无效'),
  });
}

function normalizeGroups(rawGroups) {
  const groups = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawGroups) ? rawGroups.slice(0, MAX_GROUPS * 2) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = safeId(raw.id);
    const name = cleanText(raw.name, MAX_GROUP_NAME_LENGTH);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const createdAt = safeTimestamp(raw.created_at || raw.createdAt);
    const updatedAt = safeTimestamp(raw.updated_at || raw.updatedAt);
    const rawAliases = raw.recognitionAliases ?? raw.recognition_aliases ?? raw.aliases;
    const aliases = normalizeRecognitionAliases(rawAliases)
      .filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
    const enabled = raw.recognitionEnabled ?? raw.recognition_enabled;
    const naming = raw.namingEnabled ?? raw.naming_enabled;
    groups.push({
      id,
      name,
      recognitionEnabled: enabled === true,
      namingEnabled: naming === true,
      recognitionAliases: aliases,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    });
    if (groups.length >= MAX_GROUPS) break;
  }
  return groups;
}

export function normalizeGroupIds(value, knownGroupIds = null, max = MAX_GROUP_IDS_PER_STICKER) {
  const ids = unique(value, max);
  if (!(knownGroupIds instanceof Set)) return ids;
  return ids.filter((id) => knownGroupIds.has(id));
}

// 分组权重表：{ groupId: 1|2|3 }，只能挂在已勾选的分组上，越界值收敛到 1~3。
function normalizeAgentGroupWeights(raw, groupIds) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [rawId, rawWeight] of Object.entries(raw)) {
    const id = safeId(rawId);
    if (!id || !groupIds.includes(id)) continue;
    const weight = Math.round(Number(rawWeight));
    if (!Number.isFinite(weight) || weight < GROUP_WEIGHT_MIN) continue;
    result[id] = Math.min(weight, GROUP_WEIGHT_MAX);
  }
  return result;
}

function normalizeAgentConfig(raw, knownGroupIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawGroupIds = raw.groupIds ?? raw.group_ids;
  const groupIds = normalizeGroupIds(rawGroupIds, knownGroupIds, MAX_GROUP_IDS_PER_AGENT);
  const groupWeights = normalizeAgentGroupWeights(raw.groupWeights ?? raw.group_weights, groupIds);
  // 兼容旧版二值「星标偏爱」：只写了 favoriteGroupIds 的老数据按默认档位迁移，不改变原有力度。
  const rawFavoriteIds = raw.favoriteGroupIds ?? raw.favorite_group_ids;
  const legacyFavorites = normalizeGroupIds(rawFavoriteIds, knownGroupIds, MAX_GROUP_IDS_PER_AGENT)
    .filter((id) => groupIds.includes(id));
  for (const id of legacyFavorites) {
    if (groupWeights[id] === undefined) groupWeights[id] = LEGACY_FAVORITE_WEIGHT;
  }
  const hasConfiguredFlag = typeof raw.configured === 'boolean';
  const configured = hasConfiguredFlag
    ? raw.configured
    : groupIds.length > 0 || Object.keys(groupWeights).length > 0 || raw.includeUngrouped === false || raw.include_ungrouped === false;
  const includeUngrouped = raw.includeUngrouped ?? raw.include_ungrouped;
  return {
    configured,
    groupIds,
    groupWeights,
    includeUngrouped: includeUngrouped !== false,
  };
}

export function normalizeGroupStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const groups = normalizeGroups(source.groups);
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const agents = {};
  const rawAgents = source.agents && typeof source.agents === 'object' && !Array.isArray(source.agents)
    ? source.agents : {};
  for (const [rawAgentId, rawConfig] of Object.entries(rawAgents)) {
    const agentId = safeAgentId(rawAgentId);
    const config = normalizeAgentConfig(rawConfig, knownGroupIds);
    if (!agentId || !config) continue;
    agents[agentId] = config;
  }
  const normalized = { version: GROUP_STORE_VERSION, groups, agents };
  const status = raw?.[GROUP_STORE_STATUS];
  if (status) markGroupStoreStatus(normalized, status);
  return normalized;
}

export function readGroupStore(dataDir = DATA_DIR) {
  const filePath = groupStorePath(dataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return corruptGroupStore(new Error('分组文件格式无效'));
    }
    return normalizeGroupStore(raw);
  } catch (error) {
    // 缺失文件代表尚未创建分组，属于正常空库；解析失败、权限失败等必须显式标记，
    // 不能让选图链路把“原本有限制但文件损坏”误判成“未配置限制”而放开全图库。
    if (error?.code === 'ENOENT') return emptyGroupStore();
    return corruptGroupStore(error);
  }
}

const NAME_MIGRATION_STATUS = Symbol('name-migration-status');

function markNameMigrationStatus(store, status) {
  Object.defineProperty(store, NAME_MIGRATION_STATUS, {
    value: status,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

export function emptyNameMigrationStore() {
  return { version: NAME_MIGRATION_STORE_VERSION, migrations: [] };
}

export function isNameMigrationStoreReadable(store) {
  return store?.[NAME_MIGRATION_STATUS]?.ok !== false;
}

export function getNameMigrationStoreError(store) {
  return isNameMigrationStoreReadable(store)
    ? ''
    : String(store?.[NAME_MIGRATION_STATUS]?.error || '批量改名撤销记录读取失败');
}

function normalizeMigrationChanges(value) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value.slice(0, MAX_NAME_MIGRATION_ITEMS) : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = cleanText(raw.id, 120);
    const from = cleanText(raw.from, MAX_GROUP_NAME_LENGTH);
    const to = cleanText(raw.to, MAX_GROUP_NAME_LENGTH);
    if (!id || !from || !to || from === to || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, from, to });
  }
  return result;
}

export function normalizeNameMigrationStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const migrations = [];
  for (const item of Array.isArray(source.migrations) ? source.migrations.slice(0, MAX_NAME_MIGRATIONS) : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = safeId(item.id);
    const groupId = safeId(item.groupId || item.group_id);
    const fromName = cleanText(item.fromName || item.from_name, MAX_GROUP_NAME_LENGTH);
    const toName = cleanText(item.toName || item.to_name, MAX_GROUP_NAME_LENGTH);
    const createdAt = safeTimestamp(item.created_at || item.createdAt);
    const status = item.status === 'undone' ? 'undone' : 'active';
    const changes = normalizeMigrationChanges(item.changes);
    if (!id || !groupId || !fromName || !toName || fromName === toName || !changes.length) continue;
    migrations.push({
      id,
      groupId,
      fromName,
      toName,
      created_at: createdAt || new Date(0).toISOString(),
      status,
      ...(status === 'undone' && safeTimestamp(item.undone_at || item.undoneAt)
        ? { undone_at: safeTimestamp(item.undone_at || item.undoneAt) }
        : {}),
      changes,
    });
  }
  const normalized = { version: NAME_MIGRATION_STORE_VERSION, migrations };
  const status = raw?.[NAME_MIGRATION_STATUS];
  if (status) markNameMigrationStatus(normalized, status);
  return normalized;
}

function corruptNameMigrationStore(error) {
  return markNameMigrationStatus(emptyNameMigrationStore(), {
    ok: false,
    error: error?.message || String(error || '批量改名撤销记录格式无效'),
  });
}

export function readNameMigrationStore(dataDir = DATA_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(nameMigrationStorePath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return corruptNameMigrationStore(new Error('批量改名撤销记录格式无效'));
    }
    return normalizeNameMigrationStore(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyNameMigrationStore();
    return corruptNameMigrationStore(error);
  }
}

export function writeNameMigrationStore(store, dataDir = DATA_DIR) {
  const normalized = normalizeNameMigrationStore(store);
  atomicWriteJson(nameMigrationStorePath(dataDir), normalized);
  return normalized;
}

export function createNameMigrationRecord({ groupId, fromName, toName, changes, now = new Date().toISOString() } = {}) {
  const normalizedChanges = normalizeMigrationChanges(changes);
  const id = safeId(`gmig_${crypto.randomUUID()}`);
  const from = cleanText(fromName, MAX_GROUP_NAME_LENGTH);
  const to = cleanText(toName, MAX_GROUP_NAME_LENGTH);
  if (!id || !safeId(groupId) || !from || !to || from === to || !normalizedChanges.length) return null;
  return {
    id,
    groupId: safeId(groupId),
    fromName: from,
    toName: to,
    created_at: safeTimestamp(now) || new Date().toISOString(),
    status: 'active',
    changes: normalizedChanges,
  };
}

export function planGroupNameMigration(stickers, groupId, fromName, toName, store) {
  const list = Array.isArray(stickers) ? stickers : [];
  const normalized = normalizeGroupStore(store);
  const known = new Set(normalized.groups.map((group) => group.id));
  const id = safeId(groupId);
  const from = cleanText(fromName, MAX_GROUP_NAME_LENGTH);
  const to = cleanText(toName, MAX_GROUP_NAME_LENGTH);
  const changes = [];
  let count = 0;
  if (!id || !from || !to || from === to) return { changes, count };
  for (const sticker of list) {
    if (!sticker || String(sticker.description || '').trim() !== from) continue;
    if (!getStickerGroupIds(sticker, known).includes(id)) continue;
    const stickerId = cleanText(sticker.id, 120);
    if (!stickerId) continue;
    count += 1;
    if (changes.length < MAX_NAME_MIGRATION_ITEMS) changes.push({ id: stickerId, from, to });
  }
  return { changes, count };
}

export function applyNameMigration(stickers, migration, direction = 'forward') {
  const list = Array.isArray(stickers) ? stickers : [];
  const changes = Array.isArray(migration?.changes) ? migration.changes : [];
  const reverse = direction === 'reverse';
  const expectedKey = reverse ? 'to' : 'from';
  const nextKey = reverse ? 'from' : 'to';
  const byId = new Map(list.map((sticker) => [String(sticker?.id || ''), sticker]));
  let updated = 0;
  let skipped = 0;
  for (const change of changes) {
    const sticker = byId.get(String(change?.id || ''));
    if (!sticker || String(sticker.description || '').trim() !== String(change?.[expectedKey] || '')) {
      skipped += 1;
      continue;
    }
    sticker.description = String(change[nextKey] || '').trim();
    updated += 1;
  }
  return { stickers: list, updated, skipped };
}

export function getRecognitionGroupTerms(group) {
  const name = cleanText(group?.name, MAX_GROUP_NAME_LENGTH);
  const aliases = normalizeRecognitionAliases(group?.recognitionAliases ?? group?.recognition_aliases ?? group?.aliases)
    .filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
  return [name, ...aliases].filter(Boolean);
}

export function getRecognitionGroups(store) {
  const normalized = normalizeGroupStore(store);
  if (!isGroupStoreReadable(normalized)) return [];
  return normalized.groups.filter((group) => group.recognitionEnabled === true);
}

export function buildRecognitionGroupHints(store) {
  const groups = getRecognitionGroups(store);
  if (!groups.length) return '';
  const lines = groups.map((group) => {
    const terms = getRecognitionGroupTerms(group);
    const aliases = terms.slice(1);
    return `- 主名称：${group.name}${aliases.length ? `；识图别名：${aliases.join('、')}` : ''}`;
  });
  return [
    '用户维护的识图分组参考：以下名称只是候选标签，不代表图片一定属于该组。请先根据画面核对，只有确实符合时，才把对应主名称或识图别名写入 keywords；拿不准就不要写。',
    ...lines,
  ].join('\n');
}

export function suggestGroupsForTags(tags, store) {
  const text = [
    tags?.description,
    tags?.semantic_description,
    ...(Array.isArray(tags?.keywords) ? tags.keywords : []),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  if (!text) return [];
  return getRecognitionGroups(store).map((group) => {
    const matched = getRecognitionGroupTerms(group).find((term) => term.length >= 2 && text.includes(term.toLocaleLowerCase()));
    if (!matched) return null;
    return {
      groupId: group.id,
      groupName: group.name,
      matchedTerm: matched,
      aliases: group.recognitionAliases.slice(),
    };
  }).filter(Boolean);
}

export function updateGroupRecognition(store, groupId, { recognitionEnabled, recognitionAliases } = {}, now = new Date().toISOString()) {
  const current = normalizeGroupStore(store);
  const id = safeId(groupId);
  const group = current.groups.find((item) => item.id === id);
  if (!group) return { ok: false, error: '分组不存在' };
  if (typeof recognitionEnabled === 'boolean') group.recognitionEnabled = recognitionEnabled;
  if (recognitionAliases !== undefined) {
    group.recognitionAliases = normalizeRecognitionAliases(recognitionAliases)
      .filter((alias) => alias.toLocaleLowerCase() !== group.name.toLocaleLowerCase());
  }
  group.updated_at = safeTimestamp(now) || new Date().toISOString();
  return { ok: true, store: normalizeGroupStore(current), group };
}

export function writeGroupStore(store, dataDir = DATA_DIR) {
  const normalized = normalizeGroupStore(store);
  atomicWriteJson(groupStorePath(dataDir), normalized);
  return normalized;
}

export function getKnownGroupIds(store) {
  return new Set(normalizeGroupStore(store).groups.map((group) => group.id));
}

export function createGroup(store, name, { id = '', now = new Date().toISOString(), recognitionEnabled = false, namingEnabled = false, recognitionAliases = [] } = {}) {
  const current = normalizeGroupStore(store);
  const label = cleanText(name, MAX_GROUP_NAME_LENGTH);
  if (!label) return { ok: false, error: '分组名称不能为空' };
  if (current.groups.length >= MAX_GROUPS) return { ok: false, error: `最多只能创建 ${MAX_GROUPS} 个分组` };
  const groupId = safeId(id) || `grp_${crypto.randomUUID()}`;
  if (current.groups.some((group) => group.id === groupId)) return { ok: false, error: '分组 ID 已存在' };
  const timestamp = safeTimestamp(now) || new Date().toISOString();
  const aliases = normalizeRecognitionAliases(recognitionAliases)
    .filter((alias) => alias.toLocaleLowerCase() !== label.toLocaleLowerCase());
  const group = {
    id: groupId,
    name: label,
    recognitionEnabled: recognitionEnabled === true,
    namingEnabled: namingEnabled === true,
    recognitionAliases: aliases,
    created_at: timestamp,
    updated_at: timestamp,
  };
  current.groups.push(group);
  return { ok: true, store: normalizeGroupStore(current), group };
}

export function renameGroup(store, groupId, name, nowOrOptions = new Date().toISOString()) {
  const current = normalizeGroupStore(store);
  const id = safeId(groupId);
  const label = cleanText(name, MAX_GROUP_NAME_LENGTH);
  const group = current.groups.find((item) => item.id === id);
  if (!group) return { ok: false, error: '分组不存在' };
  if (!label) return { ok: false, error: '分组名称不能为空' };
  const options = nowOrOptions && typeof nowOrOptions === 'object'
    ? nowOrOptions
    : { now: nowOrOptions };
  const previousName = group.name;
  if (previousName !== label) {
    group.recognitionAliases = normalizeRecognitionAliases([
      ...(group.recognitionAliases || []),
      previousName,
    ]).filter((alias) => alias.toLocaleLowerCase() !== label.toLocaleLowerCase());
  }
  group.name = label;
  if (typeof options.recognitionEnabled === 'boolean') group.recognitionEnabled = options.recognitionEnabled;
  if (typeof options.namingEnabled === 'boolean') group.namingEnabled = options.namingEnabled;
  if (options.recognitionAliases !== undefined) {
    group.recognitionAliases = normalizeRecognitionAliases(options.recognitionAliases)
      .filter((alias) => alias.toLocaleLowerCase() !== label.toLocaleLowerCase());
  }
  group.updated_at = safeTimestamp(options.now) || new Date().toISOString();
  return { ok: true, store: normalizeGroupStore(current), group, previousName };
}

// ── 总冠名（分组命名）─────────────────────────────────────────────
// 冠名 = 把组名写进组内每张图片的描述开头，让识图教学名单记住这个叫法。
// 规则：一张图同时只认一个冠名组；描述前缀由 namingGroupId 显式标记，不靠字符串猜测。
// namingBaseDescription 保存冠名前的原描述，用于关掉冠名时还原。

export function isGroupNamingEnabled(group) {
  return group?.namingEnabled === true;
}

function readNamingOwner(sticker) {
  return safeId(sticker?.namingGroupId ?? sticker?.naming_group_id);
}

function readNamingBase(sticker) {
  const raw = sticker?.namingBaseDescription ?? sticker?.naming_base_description;
  return raw === undefined || raw === null ? null : cleanText(raw, MAX_NAMING_DESCRIPTION_LENGTH);
}

function buildNamedDescription(groupName, base) {
  const name = cleanText(groupName, MAX_GROUP_NAME_LENGTH);
  if (!name) return '';
  const text = base ? `${name}${NAMING_SEPARATOR}${base}` : name;
  return text.slice(0, MAX_NAMING_DESCRIPTION_LENGTH);
}

// 计划：统计组内图片的冠名去向，不修改任何数据。
// candidates = 可以冠名的图片 id；conflict = 已被其他分组冠名、本次跳过的图片数；already = 已由本组冠名。
export function planGroupNaming(stickers, store, groupId) {
  const list = Array.isArray(stickers) ? stickers : [];
  const normalized = normalizeGroupStore(store);
  const known = new Set(normalized.groups.map((group) => group.id));
  const id = safeId(groupId);
  const candidates = [];
  let conflict = 0;
  let already = 0;
  if (!id) return { candidates, conflict, already, total: 0 };
  for (const sticker of list) {
    if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) continue;
    if (!getStickerGroupIds(sticker, known).includes(id)) continue;
    const owner = readNamingOwner(sticker);
    if (owner === id) {
      already += 1;
      continue;
    }
    if (owner) {
      conflict += 1;
      continue;
    }
    const stickerId = cleanText(sticker.id, 120);
    if (!stickerId) continue;
    candidates.push(stickerId);
  }
  return { candidates, conflict, already, total: candidates.length + conflict + already };
}

// 执行冠名：只处理组内还没有冠名主的图片。幂等，重复调用不会叠加前缀。
export function applyGroupNaming(stickers, store, groupId, groupName) {
  const list = Array.isArray(stickers) ? stickers : [];
  const normalized = normalizeGroupStore(store);
  const known = new Set(normalized.groups.map((group) => group.id));
  const id = safeId(groupId);
  const result = { stickers: list, updated: 0, skipped: 0, changedIds: [] };
  if (!id || !cleanText(groupName, MAX_GROUP_NAME_LENGTH)) return result;
  for (const sticker of list) {
    if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) continue;
    if (!getStickerGroupIds(sticker, known).includes(id)) continue;
    if (readNamingOwner(sticker)) {
      result.skipped += 1;
      continue;
    }
    const base = cleanText(sticker.description, MAX_NAMING_DESCRIPTION_LENGTH);
    sticker.description = buildNamedDescription(groupName, base);
    sticker.namingGroupId = id;
    sticker.namingBaseDescription = base;
    delete sticker.naming_group_id;
    delete sticker.naming_base_description;
    result.updated += 1;
    const stickerId = cleanText(sticker.id, 120);
    if (stickerId) result.changedIds.push(stickerId);
  }
  return result;
}

// 撤销冠名：把本组冠名的图片描述还原成冠名前的内容。
export function revertGroupNaming(stickers, groupId) {
  const list = Array.isArray(stickers) ? stickers : [];
  const id = safeId(groupId);
  const result = { stickers: list, updated: 0, changedIds: [] };
  if (!id) return result;
  for (const sticker of list) {
    if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) continue;
    if (readNamingOwner(sticker) !== id) continue;
    const base = readNamingBase(sticker);
    sticker.description = base === null ? cleanText(sticker.description, MAX_NAMING_DESCRIPTION_LENGTH) : base;
    delete sticker.namingGroupId;
    delete sticker.naming_group_id;
    delete sticker.namingBaseDescription;
    delete sticker.naming_base_description;
    result.updated += 1;
    const stickerId = cleanText(sticker.id, 120);
    if (stickerId) result.changedIds.push(stickerId);
  }
  return result;
}

// 改名同步：组改名时，把被本组冠名的图片描述前缀一并换成新名字。
export function renameGroupNaming(stickers, groupId, newName) {
  const list = Array.isArray(stickers) ? stickers : [];
  const id = safeId(groupId);
  const result = { stickers: list, updated: 0, changedIds: [] };
  if (!id || !cleanText(newName, MAX_GROUP_NAME_LENGTH)) return result;
  for (const sticker of list) {
    if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) continue;
    if (readNamingOwner(sticker) !== id) continue;
    const base = readNamingBase(sticker);
    const next = buildNamedDescription(newName, base === null ? '' : base);
    if (sticker.description !== next) {
      sticker.description = next;
      result.updated += 1;
    }
    const stickerId = cleanText(sticker.id, 120);
    if (stickerId) result.changedIds.push(stickerId);
  }
  return result;
}

// 删除分组时清掉它留下的冠名痕迹，避免描述里挂着已经不存在的名字。
export function clearGroupNaming(stickers, groupId) {
  return revertGroupNaming(stickers, groupId);
}

export function deleteGroup(store, groupId) {
  const current = normalizeGroupStore(store);
  const id = safeId(groupId);
  const index = current.groups.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: '分组不存在' };
  current.groups.splice(index, 1);
  for (const config of Object.values(current.agents)) {
    config.groupIds = config.groupIds.filter((value) => value !== id);
    delete config.groupWeights[id];
  }
  return { ok: true, store: normalizeGroupStore(current), groupId: id };
}

export function getStickerGroupIds(sticker, knownGroupIds = null) {
  const value = sticker?.groupIds ?? sticker?.group_ids;
  return normalizeGroupIds(value, knownGroupIds);
}

// 清理旧版别名、重复项和已经不存在的分组引用；返回原数组，方便调用方原子落盘。
export function normalizeStickerGroupMemberships(stickers, store) {
  const list = Array.isArray(stickers) ? stickers : [];
  const normalized = normalizeGroupStore(store);
  const knownGroupIds = new Set(normalized.groups.map((group) => group.id));
  let changed = 0;
  for (const sticker of list) {
    if (!sticker || typeof sticker !== 'object' || Array.isArray(sticker)) continue;
    const next = getStickerGroupIds(sticker, knownGroupIds);
    const hasCurrent = Object.prototype.hasOwnProperty.call(sticker, 'groupIds');
    const hasLegacy = Object.prototype.hasOwnProperty.call(sticker, 'group_ids');
    const current = Array.isArray(sticker.groupIds) ? sticker.groupIds : null;
    const canonical = next.length > 0
      ? Array.isArray(current) && JSON.stringify(current) === JSON.stringify(next) && !hasLegacy
      : !hasCurrent && !hasLegacy;
    if (canonical) continue;
    if (next.length) sticker.groupIds = next;
    else delete sticker.groupIds;
    delete sticker.group_ids;
    changed += 1;
  }
  return { stickers: list, changed };
}

export function isStickerUngrouped(sticker, knownGroupIds = null) {
  return getStickerGroupIds(sticker, knownGroupIds).length === 0;
}

export function isStickerInGroup(sticker, groupId, knownGroupIds = null) {
  const id = safeId(groupId);
  if (!id) return false;
  return getStickerGroupIds(sticker, knownGroupIds).includes(id);
}

export function getAgentGroupConfig(store, agentId) {
  const normalized = normalizeGroupStore(store);
  if (!isGroupStoreReadable(normalized)) {
    return {
      configured: true,
      groupIds: [],
      groupWeights: {},
      includeUngrouped: false,
      unavailable: true,
    };
  }
  const id = safeAgentId(agentId);
  const config = id && Object.prototype.hasOwnProperty.call(normalized.agents, id)
    ? normalized.agents[id]
    : null;
  if (!config) {
    return { configured: false, groupIds: [], groupWeights: {}, includeUngrouped: true };
  }
  return {
    configured: config.configured === true,
    groupIds: config.groupIds.slice(),
    groupWeights: { ...config.groupWeights },
    includeUngrouped: config.includeUngrouped !== false,
  };
}

export function isStickerAllowedForAgent(sticker, agentConfig, knownGroupIds = null) {
  const config = agentConfig && typeof agentConfig === 'object'
    ? agentConfig : { configured: false, groupIds: [], includeUngrouped: true };
  if (config.configured !== true) return true;
  const stickerGroups = getStickerGroupIds(sticker, knownGroupIds);
  if (stickerGroups.length === 0) return config.includeUngrouped !== false;
  return stickerGroups.some((id) => (config.groupIds || []).includes(id));
}

export function filterStickersForAgent(stickers, agentId, store) {
  const list = Array.isArray(stickers) ? stickers : [];
  const normalized = normalizeGroupStore(store);
  const config = getAgentGroupConfig(normalized, agentId);
  if (!config.configured) return list.slice();
  const knownGroupIds = new Set(normalized.groups.map((group) => group.id));
  return list.filter((sticker) => isStickerAllowedForAgent(sticker, config, knownGroupIds));
}

// 分组权重加权：一张图同时挂在多个分组时取其中最重的一档，不叠加，避免多组命中把分数堆成霸屏。
export function getGroupPreferenceBonus(sticker, agentConfig, knownGroupIds = null, bonusTable = GROUP_WEIGHT_BONUS) {
  if (!agentConfig || agentConfig.configured !== true) return 0;
  const weights = agentConfig.groupWeights;
  if (!weights || typeof weights !== 'object') return 0;
  const stickerGroups = getStickerGroupIds(sticker, knownGroupIds);
  let best = 0;
  for (const id of stickerGroups) {
    const weight = Math.round(Number(weights[id]));
    if (!Number.isFinite(weight) || weight < GROUP_WEIGHT_MIN) continue;
    const bonus = Number(bonusTable[Math.min(weight, GROUP_WEIGHT_MAX)]) || 0;
    if (bonus > best) best = bonus;
  }
  return best;
}

export function setStickerGroupIds(stickers, stickerIds, groupIds, store) {
  const list = Array.isArray(stickers) ? stickers : [];
  const ids = new Set(unique(stickerIds, 1000));
  const normalized = normalizeGroupStore(store);
  const knownGroupIds = new Set(normalized.groups.map((group) => group.id));
  const nextGroupIds = normalizeGroupIds(groupIds, knownGroupIds);
  let updated = 0;
  for (const sticker of list) {
    if (!sticker || !ids.has(String(sticker.id || ''))) continue;
    const before = getStickerGroupIds(sticker, knownGroupIds);
    if (JSON.stringify(before) === JSON.stringify(nextGroupIds)) continue;
    if (nextGroupIds.length) {
      sticker.groupIds = nextGroupIds.slice();
      delete sticker.group_ids;
    } else {
      delete sticker.groupIds;
      delete sticker.group_ids;
    }
    updated += 1;
  }
  return { stickers: list, updated, groupIds: nextGroupIds };
}

export function updateStickerGroupMembership(stickers, stickerIds, { addGroupIds = [], removeGroupIds = [] } = {}, store) {
  const list = Array.isArray(stickers) ? stickers : [];
  const ids = new Set(unique(stickerIds, 1000));
  const normalized = normalizeGroupStore(store);
  const knownGroupIds = new Set(normalized.groups.map((group) => group.id));
  // 这里先保留完整请求（最多 MAX_GROUPS），再按每张图片的最终归属检查 50 上限，
  // 不能让 normalizeGroupIds 提前静默截掉用户后面的勾选。
  const additions = new Set(normalizeGroupIds(addGroupIds, knownGroupIds, MAX_GROUPS));
  const removals = new Set(normalizeGroupIds(removeGroupIds, knownGroupIds));
  const planned = [];
  for (const sticker of list) {
    if (!sticker || !ids.has(String(sticker.id || ''))) continue;
    const before = getStickerGroupIds(sticker, knownGroupIds);
    const next = before.filter((id) => !removals.has(id));
    for (const id of additions) if (!next.includes(id)) next.push(id);
    if (next.length > MAX_GROUP_IDS_PER_STICKER) {
      return {
        ok: false,
        stickers: list,
        updated: 0,
        addGroupIds: [...additions],
        removeGroupIds: [...removals],
        error: `一张图片最多只能加入 ${MAX_GROUP_IDS_PER_STICKER} 个分组，请减少勾选后重试`,
      };
    }
    planned.push({ sticker, before, next });
  }
  let updated = 0;
  for (const { sticker, before, next } of planned) {
    if (JSON.stringify(before) === JSON.stringify(next)) continue;
    if (next.length) {
      sticker.groupIds = next;
      delete sticker.group_ids;
    } else {
      delete sticker.groupIds;
      delete sticker.group_ids;
    }
    updated += 1;
  }
  return { ok: true, stickers: list, updated, addGroupIds: [...additions], removeGroupIds: [...removals] };
}

export function mergeGroupStores(currentStore, incomingStore, { idFactory, now = new Date().toISOString() } = {}) {
  const current = normalizeGroupStore(currentStore);
  const incoming = normalizeGroupStore(incomingStore);
  const usedIds = new Set(current.groups.map((group) => group.id));
  const groupIdMap = new Map();
  const skippedGroupIds = [];
  const makeId = typeof idFactory === 'function'
    ? idFactory
    : () => `grp_${crypto.randomUUID()}`;
  const timestamp = safeTimestamp(now) || new Date().toISOString();

  for (const sourceGroup of incoming.groups) {
    if (usedIds.has(sourceGroup.id)) {
      const target = current.groups.find((group) => group.id === sourceGroup.id);
      if (target && target.name === sourceGroup.name) {
        target.recognitionEnabled = target.recognitionEnabled === true || sourceGroup.recognitionEnabled === true;
        target.recognitionAliases = normalizeRecognitionAliases([
          ...(target.recognitionAliases || []),
          ...(sourceGroup.recognitionAliases || []),
        ]).filter((alias) => alias.toLocaleLowerCase() !== target.name.toLocaleLowerCase());
        groupIdMap.set(sourceGroup.id, sourceGroup.id);
        continue;
      }
      let replacement = safeId(makeId());
      while (!replacement || usedIds.has(replacement)) replacement = safeId(makeId());
      groupIdMap.set(sourceGroup.id, replacement);
      if (current.groups.length < MAX_GROUPS) {
        current.groups.push({ ...sourceGroup, id: replacement, updated_at: sourceGroup.updated_at || timestamp });
        usedIds.add(replacement);
      } else {
        skippedGroupIds.push(sourceGroup.id);
      }
      continue;
    }
    if (current.groups.length >= MAX_GROUPS) {
      skippedGroupIds.push(sourceGroup.id);
      continue;
    }
    groupIdMap.set(sourceGroup.id, sourceGroup.id);
    current.groups.push({ ...sourceGroup });
    usedIds.add(sourceGroup.id);
  }

  for (const [agentId, sourceConfig] of Object.entries(incoming.agents || {})) {
    const mapIds = (values) => [...new Set((Array.isArray(values) ? values : [])
      .map((id) => groupIdMap.has(id) ? groupIdMap.get(id) : id).filter(Boolean))];
    const groupWeights = {};
    for (const [sourceId, weight] of Object.entries(sourceConfig.groupWeights || {})) {
      const mapped = groupIdMap.has(sourceId) ? groupIdMap.get(sourceId) : sourceId;
      if (mapped) groupWeights[mapped] = weight;
    }
    current.agents[agentId] = {
      configured: sourceConfig.configured === true,
      groupIds: mapIds(sourceConfig.groupIds),
      groupWeights,
      includeUngrouped: sourceConfig.includeUngrouped !== false,
    };
  }
  const store = normalizeGroupStore(current);
  for (const group of incoming.groups) {
    if (!groupIdMap.has(group.id) && store.groups.some((item) => item.id === group.id)) {
      groupIdMap.set(group.id, group.id);
    }
  }
  return { store, groupIdMap, skippedGroupIds: [...new Set(skippedGroupIds)] };
}

export function filterGroupStoreForExport(store, { selectedGroupIds = [], includeUngrouped = false, relatedGroupIds = [], all = false } = {}) {
  const normalized = normalizeGroupStore(store);
  const known = new Set(normalized.groups.map((group) => group.id));
  const selected = new Set(normalizeGroupIds(selectedGroupIds, known, MAX_GROUPS));
  const related = new Set(normalizeGroupIds(relatedGroupIds, known, MAX_GROUPS));
  const relevant = new Set([...selected, ...related]);
  // 没有范围筛选时，调用方是在导出完整图库，保留全部分组定义。
  const preserveAll = all || (selected.size === 0 && related.size === 0 && !includeUngrouped);
  if (preserveAll) {
    for (const id of known) relevant.add(id);
  }
  const groups = normalized.groups.filter((group) => relevant.has(group.id));
  const agents = {};
  for (const [agentId, config] of Object.entries(normalized.agents)) {
    const groupIds = config.groupIds.filter((id) => relevant.has(id));
    const groupWeights = {};
    for (const [id, weight] of Object.entries(config.groupWeights || {})) {
      if (relevant.has(id)) groupWeights[id] = weight;
    }
    // 分组范围导出只保留与导出内容有关的限制配置，避免一个只选了 B 组的伙伴
    // 因导出 A 组而被导入到目标环境后变成“一个分组都不能用”。完整导出保留原配置。
    const includeExportedUngrouped = preserveAll ? config.includeUngrouped : config.includeUngrouped && includeUngrouped;
    // 未配置白名单的伙伴没有分组偏好，分组范围导出时不必把它的“全库”快照
    // 带到目标环境覆盖那里已有的限制；完整搬家才保留这类显式配置。
    if (!preserveAll && config.configured !== true) continue;
    if (!preserveAll && groupIds.length === 0 && !includeExportedUngrouped) continue;
    agents[agentId] = {
      configured: config.configured,
      groupIds,
      groupWeights,
      includeUngrouped: includeExportedUngrouped,
    };
  }
  return { version: GROUP_STORE_VERSION, groups, agents };
}
