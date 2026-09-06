import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HANA_HOME } from './shared.js';
import { safeStickerPath } from './ball-core.js';
import { MAX_ENTRIES, writeStoredZip } from './zip-images.js';

export const TRANSFER_FORMAT = 'hana-biaoqingbao';
export const TRANSFER_VERSION = 2;
export const MIGRATION_DATA_FILE_NAME = 'migration.json';
export const MIGRATION_DATA_VERSION = 1;
export const EXPORT_CONFIG_FILE_NAME = 'export-config.json';

export function validateTransferManifest(manifest, { found = false } = {}) {
  if (!found && (manifest === null || manifest === undefined)) return { ok: true, legacy: true, version: 1 };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'manifest.json 格式无效' };
  }
  if (manifest.format !== undefined && manifest.format !== TRANSFER_FORMAT) {
    return { ok: false, error: '这不是表情包插件的迁移 ZIP' };
  }
  const version = manifest.formatVersion === undefined ? 1 : Number(manifest.formatVersion);
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: '迁移 ZIP 版本号无效' };
  }
  if (version > TRANSFER_VERSION) {
    return { ok: false, error: `迁移 ZIP 需要更新版插件（当前支持 v${TRANSFER_VERSION}，包为 v${version}）` };
  }
  if (manifest.dataVersion !== undefined) {
    const dataVersion = Number(manifest.dataVersion);
    if (!Number.isInteger(dataVersion) || dataVersion < 1) {
      return { ok: false, error: '迁移数据版本号无效' };
    }
    if (dataVersion > MIGRATION_DATA_VERSION) {
      return { ok: false, error: `迁移 ZIP 数据需要更新版插件（当前支持 v${MIGRATION_DATA_VERSION}，包为 v${dataVersion}）` };
    }
  }
  return { ok: true, legacy: version < 2, version };
}

// 迁移包只带用户资产与可重建配置；模型凭据、会话、日志、批量任务和机器状态永不进入包。
export const MIGRATABLE_DATA_KEYS = Object.freeze([
  'preferences', 'teaching', 'contextFeedback', 'exposure',
  'styleTemplate', 'styleProfile', 'styleFeedback',
  'dialectConfig', 'agentFreq', 'displayConfig', 'ballConfig',
]);

// 导出内容分组：弹窗里按组勾选，前端只传组 id，后端解析成具体数据键。
// 图库本体（图片 + 名称/描述/标签 + 语义描述）永远导出，不参与分组。
export const EXPORT_DATA_GROUPS = Object.freeze({
  // 偏好培养：谁喜欢/不喜欢哪张图、识图教学样本、应景反馈、曝光统计
  preference: Object.freeze(['preferences', 'teaching', 'contextFeedback', 'exposure']),
  // 学我说话：风格模板 / 风格画像 / 正反例反馈
  style: Object.freeze(['styleTemplate', 'styleProfile', 'styleFeedback']),
  // 方言配置：各助手方言开关与浓度
  dialect: Object.freeze(['dialectConfig']),
  // 界面与悬浮球：发图频率、展示设置、悬浮球置顶
  interface: Object.freeze(['agentFreq', 'displayConfig', 'ballConfig']),
});

export const EXPORT_DATA_GROUP_IDS = Object.freeze(Object.keys(EXPORT_DATA_GROUPS));

// 把前端勾选的组 id 列表解析成具体数据键（按分组定义顺序去重；未知组忽略）。
export function resolveExportDataKeys(groups) {
  const keys = [];
  const seen = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    const groupKeys = EXPORT_DATA_GROUPS[String(group || '')];
    if (!groupKeys) continue;
    for (const key of groupKeys) {
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
  }
  return keys;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const TAG_KEYS = ['emotion', 'scene', 'keywords', 'atmosphere'];
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SEMANTIC_LENGTH = 2000;
const MAX_TAG_LENGTH = 60;
const MAX_TAGS_PER_FIELD = 100;
const MAX_METADATA_ENTRIES = MAX_ENTRIES;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function cleanId(value) {
  return cleanText(value, 120).replace(/[\\/]/g, '');
}

function cleanTagValues(value) {
  const values = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return values
    .map((item) => cleanText(item, MAX_TAG_LENGTH))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, MAX_TAGS_PER_FIELD);
}

function normalizeTags(item) {
  const source = item?.tags && typeof item.tags === 'object' && !Array.isArray(item.tags) ? item.tags : {};
  const tags = {};
  for (const key of TAG_KEYS) {
    const values = cleanTagValues(source[key] ?? item?.[key]);
    if (values.length > 0) tags[key] = values;
  }
  return tags;
}

function hasTagValues(tags) {
  return Object.values(tags || {}).some((values) => Array.isArray(values) && values.length > 0);
}

function normalizeArchivePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return '';
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '..')) return '';
  return parts.filter((part) => part !== '.').join('/');
}

function pathVariants(value) {
  const normalized = normalizeArchivePath(value);
  if (!normalized) return [];
  const base = path.posix.basename(normalized);
  return [...new Set([normalized, `stickers/${base}`, base])];
}

function addIndex(index, key, record) {
  const normalized = String(key || '').toLowerCase();
  if (!normalized) return;
  if (!index.has(normalized)) index.set(normalized, record);
  else if (index.get(normalized) !== record) index.set(normalized, null);
}

export function hashBuffer(data) {
  return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(data || '')).digest('hex');
}

export function buildStickerExportPlan({ meta, stickersDir, exportedAt = new Date() } = {}) {
  const files = [];
  const stickers = [];
  const transferStickers = [];
  const skipped = [];
  const usedArchiveNames = new Set();
  const list = Array.isArray(meta) ? meta : [];
  const exportedIso = exportedAt instanceof Date && Number.isFinite(exportedAt.getTime())
    ? exportedAt.toISOString()
    : new Date().toISOString();

  for (const sticker of list) {
    const sourceName = typeof sticker?.file === 'string' ? sticker.file.trim() : '';
    const sourcePath = safeStickerPath(stickersDir, sourceName);
    const fileName = sourcePath ? path.basename(sourcePath) : '';
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    if (!sourcePath || !fileName || !IMAGE_EXTENSIONS.has(ext)) {
      skipped.push({ file: sourceName || '(未命名文件)', reason: '图片路径或格式无效' });
      continue;
    }

    try {
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不是普通图片文件');
    } catch {
      skipped.push({ file: sourceName, reason: '图片文件不存在或不可读取' });
      continue;
    }

    const archiveName = `stickers/${fileName}`;
    const archiveKey = archiveName.toLowerCase();
    if (usedArchiveNames.has(archiveKey)) {
      skipped.push({ file: sourceName, reason: '导出文件名重复' });
      continue;
    }
    usedArchiveNames.add(archiveKey);

    const name = cleanText(sticker?.name, MAX_DESCRIPTION_LENGTH);
    const description = cleanText(
      sticker?.description || name || path.parse(fileName).name,
      MAX_DESCRIPTION_LENGTH,
    ) || path.parse(fileName).name;
    const record = {
      file: archiveName,
      name: name || description,
      description,
      tags: normalizeTags(sticker),
    };
    const semantic = cleanText(sticker?.semantic_description, MAX_SEMANTIC_LENGTH);
    if (semantic) record.semantic_description = semantic;

    let imageHash = '';
    try { imageHash = hashBuffer(fs.readFileSync(sourcePath)); } catch {
      skipped.push({ file: sourceName, reason: '图片文件读取失败' });
      continue;
    }
    const sourceId = cleanId(sticker?.id);
    const addedAt = cleanText(sticker?.added_at, 80);
    const taggedAt = cleanText(sticker?.tagged_at, 80);
    const transferRecord = {
      sourceId,
      hash: imageHash,
      ...record,
      ...(addedAt ? { added_at: addedAt } : {}),
      ...(taggedAt ? { tagged_at: taggedAt } : {}),
    };

    files.push({ name: archiveName, filePath: sourcePath, hash: imageHash });
    stickers.push(record);
    transferStickers.push(transferRecord);
  }

  return { files, stickers, transferStickers, skipped, exportedAt: exportedIso };
}

export async function exportStickerArchive({
  meta,
  stickersDir,
  outputPath,
  pluginVersion = '',
  exportedAt = new Date(),
  migrationPayload = null,
  dataDir = '',
  agentCatalog = [],
  includeDataKeys = null,
} = {}) {
  const plan = buildStickerExportPlan({ meta, stickersDir, exportedAt });
  if (plan.files.length === 0) {
    return { ok: false, error: '图库里没有可导出的图片', exported: 0, skipped: plan.skipped };
  }

  // includeDataKeys：null=全部数据（老行为）；空数组=只要图库（v1 轻量包）；非空数组=按组过滤。
  // 只有调用方明确传入 dataDir 或 migrationPayload 时才生成 v2 数据，
  // 这样旧的“只导图片”调用仍会产出兼容的 v1 包。
  const wantsData = includeDataKeys === null || includeDataKeys === undefined
    ? true
    : includeDataKeys.length > 0;
  const payload = migrationPayload || (dataDir && wantsData
    ? buildMigrationPayload({ dataDir, meta, stickersDir, agentCatalog, exportedAt: plan.exportedAt, plan, includeDataKeys })
    : null);
  const entryCount = plan.files.length + (payload ? 3 : 2);
  if (entryCount > MAX_ENTRIES) {
    const imageLimit = MAX_ENTRIES - (payload ? 3 : 2);
    return {
      ok: false,
      error: `图库太大，迁移 ZIP 最多支持 ${imageLimit} 张图片`,
      exported: 0,
      skipped: plan.skipped,
    };
  }

  const manifest = {
    format: TRANSFER_FORMAT,
    formatVersion: payload ? TRANSFER_VERSION : 1,
    exportedAt: plan.exportedAt,
    stickerCount: plan.stickers.length,
    ...(payload ? { dataFile: MIGRATION_DATA_FILE_NAME, dataVersion: MIGRATION_DATA_VERSION } : {}),
  };
  if (pluginVersion) manifest.pluginVersion = cleanText(pluginVersion, 40);

  const entries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'stickers.json', data: JSON.stringify(plan.stickers, null, 2) },
    ...(payload ? [{ name: MIGRATION_DATA_FILE_NAME, data: JSON.stringify(payload, null, 2) }] : []),
    ...plan.files,
  ];
  await writeStoredZip(outputPath, entries, { date: new Date(plan.exportedAt) });

  return {
    ok: true,
    exported: plan.stickers.length,
    skipped: plan.skipped,
    manifest,
    migration: payload ? {
      dataFile: MIGRATION_DATA_FILE_NAME,
      keys: Object.keys(payload.data || {}),
    } : null,
  };
}

function readOptionalJson(dataDir, fileName) {
  try {
    const filePath = path.join(path.resolve(dataDir), fileName);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeAgentId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function safeStickerId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function safeTimestamp(value) {
  const text = cleanText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function safeFiniteNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeStringList(value, maxItems = 100, maxLength = MAX_TAG_LENGTH) {
  return cleanTagValues(value).slice(0, maxItems).map((item) => cleanText(item, maxLength)).filter(Boolean);
}

function safeObjectKey(value) {
  const key = String(value || '').trim();
  return key && !['__proto__', 'prototype', 'constructor'].includes(key) ? key : '';
}

// 风格画像目前没有凭据字段，但对未知未来字段也按“默认不外带模型/机器状态”处理。
const SENSITIVE_MIGRATION_KEY_RE = /(?:api[_-]?key|base[_-]?url|provider|model|token|session|machine|file[_-]?path|absolute[_-]?path)/i;

function safeJsonValue(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return cleanText(value, 12000);
  if (Array.isArray(value)) return value.slice(0, 300).map((item) => safeJsonValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 300)) {
    const safeKey = safeObjectKey(key);
    if (!safeKey || SENSITIVE_MIGRATION_KEY_RE.test(safeKey)) continue;
    out[safeKey] = safeJsonValue(item, depth + 1);
  }
  return out;
}

function normalizeAgentCatalog(agents) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(agents) ? agents : []) {
    const id = safeAgentId(item?.id ?? item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = cleanText(item?.name || id, 120) || id;
    out.push({ id, name });
  }
  return out;
}

export function readAgentCatalog(agentsRoot = path.join(HANA_HOME, 'agents')) {
  const root = path.resolve(agentsRoot);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries) {
    const id = safeAgentId(entry.name);
    if (!id || !entry.isDirectory()) continue;
    let name = id;
    try {
      const yaml = fs.readFileSync(path.join(root, id, 'config.yaml'), 'utf8');
      const section = yaml.match(/^agent:\s*$/m);
      const source = section ? yaml.slice(section.index) : yaml;
      const match = source.match(/^\s{2}name:\s*['"]?([^'"\r\n#]+)['"]?\s*$/m);
      if (match?.[1]?.trim()) name = match[1].trim();
    } catch { /* 名字读不到时保留 id */ }
    result.push({ id, name: cleanText(name, 120) || id });
  }
  return normalizeAgentCatalog(result);
}

function sanitizePreferences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { version: Number(raw.version) || 1, users: {} };
  for (const [rawAgent, rawUser] of Object.entries(raw.users || {})) {
    const agent = safeAgentId(rawAgent);
    if (!agent || !rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) continue;
    const user = { mappings: [] };
    if (safeTimestamp(rawUser.updated_at)) user.updated_at = safeTimestamp(rawUser.updated_at);
    for (const rawMapping of (Array.isArray(rawUser.mappings) ? rawUser.mappings : []).slice(0, 1000)) {
      if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) continue;
      const context = rawMapping.context && typeof rawMapping.context === 'object' && !Array.isArray(rawMapping.context)
        ? rawMapping.context : {};
      const mapping = {
        context: {
          emotion: cleanText(context.emotion, 120),
          keywords: safeStringList(context.keywords, 30, MAX_TAG_LENGTH),
        },
        preferred_ids: [],
        vetoed_ids: [],
        dislike_counts: {},
        weight: safeFiniteNumber(rawMapping.weight, 1, 0, 10),
      };
      const id = cleanText(rawMapping.id, 120);
      const updatedAt = safeTimestamp(rawMapping.updated_at);
      if (id) mapping.id = id;
      if (updatedAt) mapping.updated_at = updatedAt;
      mapping.preferred_ids = [...new Set((Array.isArray(rawMapping.preferred_ids) ? rawMapping.preferred_ids : [])
        .map(safeStickerId).filter(Boolean))].slice(0, MAX_METADATA_ENTRIES);
      mapping.vetoed_ids = [...new Set((Array.isArray(rawMapping.vetoed_ids) ? rawMapping.vetoed_ids : [])
        .map(safeStickerId).filter(Boolean))].slice(0, MAX_METADATA_ENTRIES);
      for (const [rawId, count] of Object.entries(rawMapping.dislike_counts || {})) {
        const stickerId = safeStickerId(rawId);
        if (!stickerId) continue;
        const numeric = Math.floor(safeFiniteNumber(count, 0, 0, 100000));
        if (numeric > 0) mapping.dislike_counts[stickerId] = numeric;
      }
      user.mappings.push(mapping);
    }
    out.users[agent] = user;
  }
  return out;
}

function sanitizeTeaching(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // embedding 模型属于当前环境配置，不随搬家包携带；导入后按目标环境重建。
  const out = { version: 1, samples: {} };
  for (const [rawId, rawSample] of Object.entries(raw.samples || {})) {
    const stickerId = safeStickerId(rawId);
    if (!stickerId || !rawSample || typeof rawSample !== 'object' || Array.isArray(rawSample)) continue;
    const sample = {
      description: cleanText(rawSample.description, MAX_DESCRIPTION_LENGTH),
      semanticDescription: cleanText(rawSample.semanticDescription ?? rawSample.semantic_description, MAX_SEMANTIC_LENGTH),
      keywords: safeStringList(rawSample.keywords, 30, MAX_TAG_LENGTH),
    };
    const updatedAt = safeTimestamp(rawSample.updatedAt ?? rawSample.updated_at);
    if (updatedAt) sample.updatedAt = updatedAt;
    // 向量不作为迁移事实；目标环境按当前 embedding 模型重建，避免跨模型污染语义空间。
    out.samples[stickerId] = sample;
  }
  return out;
}

function sanitizeContextFeedback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { version: 1, byAgent: {} };
  for (const [rawAgent, rawContexts] of Object.entries(raw.byAgent || {})) {
    const agent = safeAgentId(rawAgent);
    if (!agent || !rawContexts || typeof rawContexts !== 'object' || Array.isArray(rawContexts)) continue;
    const contexts = {};
    for (const [rawContext, rawEntries] of Object.entries(rawContexts)) {
      const context = cleanText(rawContext, 80);
      if (!context || !rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) continue;
      const entries = {};
      for (const [rawId, rawEntry] of Object.entries(rawEntries)) {
        const stickerId = safeStickerId(rawId);
        if (!stickerId) continue;
        const count = Math.floor(safeFiniteNumber(rawEntry?.count, 0, 0, 3));
        if (count <= 0) continue;
        entries[stickerId] = { count, lastAt: safeTimestamp(rawEntry?.lastAt) };
      }
      if (Object.keys(entries).length) contexts[context] = entries;
    }
    if (Object.keys(contexts).length) out.byAgent[agent] = contexts;
  }
  return out;
}

function sanitizeExposure(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { version: 2, byAgent: {} };
  for (const [rawAgent, rawEntries] of Object.entries(raw.byAgent || {})) {
    const agent = safeAgentId(rawAgent);
    if (!agent || !rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) continue;
    const entries = {};
    for (const [rawId, rawEntry] of Object.entries(rawEntries)) {
      const stickerId = safeStickerId(rawId);
      if (!stickerId || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      entries[stickerId] = {
        exposureCount: Math.floor(safeFiniteNumber(rawEntry.exposureCount, 0, 0, 100000000)),
        firstExposedAt: safeTimestamp(rawEntry.firstExposedAt),
        lastExposedAt: safeTimestamp(rawEntry.lastExposedAt),
      };
    }
    if (Object.keys(entries).length) out.byAgent[agent] = entries;
  }
  return out;
}

function sanitizeStyleTemplate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    current: cleanText(raw.current, 600),
    history: [],
    source_agents: safeStringList(raw.source_agents, 100, 100),
    excluded_agents: safeStringList(raw.excluded_agents, 100, 100),
    last_summarized_at: safeTimestamp(raw.last_summarized_at) || null,
  };
  const currentSource = cleanText(raw.source_agent_of_current, 100);
  const currentLevel = cleanText(raw.level_of_current, 40);
  if (currentSource) out.source_agent_of_current = currentSource;
  if (currentLevel) out.level_of_current = currentLevel;
  for (const item of (Array.isArray(raw.history) ? raw.history : []).slice(-1)) {
    if (!item || typeof item !== 'object') continue;
    const content = cleanText(item.content, 600);
    if (!content) continue;
    out.history.push({
      version: Math.max(1, Math.floor(safeFiniteNumber(item.version, 1, 1, 100000))),
      content,
      saved_at: safeTimestamp(item.saved_at) || null,
      source_agent: cleanText(item.source_agent, 100),
      level: cleanText(item.level, 40),
    });
  }
  return out;
}

function sanitizeStyleProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = safeJsonValue(raw);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  out.built_at = safeTimestamp(raw.built_at) || null;
  out.level = cleanText(raw.level, 40);
  out.source_agents = safeStringList(raw.source_agents, 100, 100);
  return out;
}

function sanitizeStyleFeedback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cleanEntries = (value, field) => (Array.isArray(value) ? value : []).slice(-40).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const out = field === 'counterexamples'
      ? { feature: cleanText(item.feature, 600) }
      : { content: cleanText(item.content, 600) };
    if (!Object.values(out)[0]) return null;
    const reason = cleanText(item.reason, 300);
    const source = cleanText(item.source, 120);
    const at = safeTimestamp(item.at);
    if (reason) out.reason = reason;
    if (source) out.source = source;
    if (at) out.at = at;
    return out;
  }).filter(Boolean);
  return {
    counterexamples: cleanEntries(raw.counterexamples, 'counterexamples'),
    locked: cleanEntries(raw.locked, 'locked'),
  };
}

function sanitizeDialectConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { version: 3, agents: {} };
  for (const [rawAgent, rawSetting] of Object.entries(raw.agents || {})) {
    const agent = safeAgentId(rawAgent);
    if (!agent || !rawSetting || typeof rawSetting !== 'object' || Array.isArray(rawSetting)) continue;
    const dialect = cleanText(rawSetting.dialect, 60);
    if (!dialect) continue;
    const setting = { dialect, enabled: rawSetting.enabled === true };
    if (rawSetting.boost === true || rawSetting.mode === 'advanced') setting.boost = true;
    // 关闭的设置不需要写入，但保留 enabled=false 由目标归一化层决定是否丢弃。
    if (setting.enabled) out.agents[agent] = setting;
  }
  return out;
}

function sanitizeAgentFreq(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    version: 2,
    global_enabled: raw.global_enabled !== false,
    default_daily: Math.round(safeFiniteNumber(raw.default_daily ?? raw.default_freq, 50, 0, 100)),
    default_task: Math.round(safeFiniteNumber(raw.default_task, 20, 0, 100)),
    agents: {},
  };
  for (const [rawAgent, rawSetting] of Object.entries(raw.agents || {})) {
    const agent = safeAgentId(rawAgent);
    if (!agent) continue;
    if (typeof rawSetting === 'number') {
      out.agents[agent] = {
        enabled: rawSetting !== 0,
        daily: Math.round(safeFiniteNumber(rawSetting, out.default_daily, 0, 100)),
        task: out.default_task,
      };
      continue;
    }
    if (!rawSetting || typeof rawSetting !== 'object' || Array.isArray(rawSetting)) continue;
    out.agents[agent] = {
      enabled: rawSetting.enabled !== false,
      daily: Math.round(safeFiniteNumber(rawSetting.daily ?? rawSetting.overall, out.default_daily, 0, 100)),
      task: Math.round(safeFiniteNumber(rawSetting.task, out.default_task, 0, 100)),
    };
  }
  return out;
}

function sanitizeDisplayConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    smallImageFit: raw.smallImageFit !== false,
    smallImageThreshold: Math.round(safeFiniteNumber(raw.smallImageThreshold, 200, 50, 500)),
    showFeedbackButtons: raw.showFeedbackButtons !== false,
    sizeMode: ['auto', 'small', 'medium', 'large'].includes(raw.sizeMode) ? raw.sizeMode : 'auto',
  };
}

function sanitizeBallConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    version: 2,
    pinnedIds: [...new Set((Array.isArray(raw.pinnedIds) ? raw.pinnedIds : []).map(safeStickerId).filter(Boolean))].slice(0, MAX_METADATA_ENTRIES),
    variant: raw.variant === 'plane' ? 'plane' : 'plane',
  };
}

const DATA_SANITIZERS = {
  preferences: sanitizePreferences,
  teaching: sanitizeTeaching,
  contextFeedback: sanitizeContextFeedback,
  exposure: sanitizeExposure,
  styleTemplate: sanitizeStyleTemplate,
  styleProfile: sanitizeStyleProfile,
  styleFeedback: sanitizeStyleFeedback,
  dialectConfig: sanitizeDialectConfig,
  agentFreq: sanitizeAgentFreq,
  displayConfig: sanitizeDisplayConfig,
  ballConfig: sanitizeBallConfig,
};

function sanitizeMigrationData(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of MIGRATABLE_DATA_KEYS) {
    const sanitizer = DATA_SANITIZERS[key];
    if (!sanitizer || raw[key] == null) continue;
    const cleaned = sanitizer(raw[key]);
    if (cleaned) out[key] = cleaned;
  }
  return out;
}

function referencedAgents(data) {
  const ids = new Set();
  const add = (value) => { const id = safeAgentId(value); if (id) ids.add(id); };
  for (const id of Object.keys(data?.preferences?.users || {})) add(id);
  for (const id of Object.keys(data?.contextFeedback?.byAgent || {})) add(id);
  for (const id of Object.keys(data?.exposure?.byAgent || {})) add(id);
  for (const id of Object.keys(data?.dialectConfig?.agents || {})) add(id);
  for (const id of Object.keys(data?.agentFreq?.agents || {})) add(id);
  for (const id of data?.styleTemplate?.source_agents || []) add(id);
  for (const id of data?.styleTemplate?.excluded_agents || []) add(id);
  for (const id of data?.styleProfile?.source_agents || []) add(id);
  return ids;
}

export function buildMigrationPayload({
  dataDir,
  meta,
  stickersDir,
  agentCatalog,
  exportedAt = new Date(),
  plan = null,
  includeDataKeys = null,
} = {}) {
  const exportPlan = plan || buildStickerExportPlan({ meta, stickersDir, exportedAt });
  // includeDataKeys：null/undefined=全部；数组=只带列表里的键（用于按组导出）。
  const keyFilter = includeDataKeys === null || includeDataKeys === undefined
    ? null
    : new Set(includeDataKeys);
  const data = {};
  for (const [key, fileName] of Object.entries({
    preferences: 'preferences.json',
    teaching: 'teaching-samples.json',
    contextFeedback: 'context-feedback.json',
    exposure: 'exposure-stats.json',
    styleTemplate: 'style-template.json',
    styleProfile: 'style-profile.json',
    styleFeedback: 'style-feedback.json',
    dialectConfig: 'dialect-config.json',
    agentFreq: 'agent-freq.json',
    displayConfig: 'display-config.json',
    ballConfig: 'ball-config.json',
  })) {
    if (keyFilter && !keyFilter.has(key)) continue;
    const raw = readOptionalJson(dataDir, fileName);
    if (raw !== null) data[key] = DATA_SANITIZERS[key](raw);
  }
  const refs = referencedAgents(data);
  const knownAgents = Array.isArray(agentCatalog) ? agentCatalog : readAgentCatalog();
  const catalog = normalizeAgentCatalog([
    ...knownAgents,
    ...[...refs].map((id) => ({ id, name: id })),
    ...(refs.has('default') ? [{ id: 'default', name: '默认助手' }] : []),
  ]);
  const exportedIso = exportedAt instanceof Date && Number.isFinite(exportedAt.getTime())
    ? exportedAt.toISOString()
    : (safeTimestamp(exportedAt) || new Date().toISOString());
  return {
    format: TRANSFER_FORMAT,
    version: MIGRATION_DATA_VERSION,
    exportedAt: exportedIso,
    agents: catalog,
    stickers: Array.isArray(exportPlan.transferStickers) ? exportPlan.transferStickers : [],
    data,
  };
}

export function normalizeMigrationPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '迁移数据不是有效对象' };
  }
  if (raw.format && raw.format !== TRANSFER_FORMAT) {
    return { ok: false, error: '迁移数据来源不是表情包插件' };
  }
  const version = Number(raw.version ?? raw.dataVersion ?? 0);
  if (!Number.isInteger(version) || version < 1 || version > MIGRATION_DATA_VERSION) {
    return { ok: false, error: '迁移数据版本不受支持' };
  }
  const stickers = [];
  const byPath = new Map();
  const byHash = new Map();
  let ignored = 0;
  for (const item of (Array.isArray(raw.stickers) ? raw.stickers : []).slice(0, MAX_METADATA_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { ignored++; continue; }
    const file = normalizeArchivePath(item.file || item.path || item.filename);
    const sourceId = safeStickerId(item.sourceId ?? item.id);
    const hash = String(item.hash || '').trim().toLowerCase();
    if (!file || !/^[a-f0-9]{64}$/.test(hash)) { ignored++; continue; }
    const name = cleanText(item.name, MAX_DESCRIPTION_LENGTH);
    const description = cleanText(item.description || name, MAX_DESCRIPTION_LENGTH);
    const tags = normalizeTags(item);
    const semantic = cleanText(item.semantic_description, MAX_SEMANTIC_LENGTH);
    const record = {
      sourceId,
      hash,
      file,
      name,
      description,
      tags,
      ...(semantic ? { semantic_description: semantic } : {}),
      ...(safeTimestamp(item.added_at) ? { added_at: safeTimestamp(item.added_at) } : {}),
      ...(safeTimestamp(item.tagged_at) ? { tagged_at: safeTimestamp(item.tagged_at) } : {}),
      hasMetadata: Boolean(name || description || hasTagValues(tags) || semantic),
    };
    stickers.push(record);
    for (const variant of pathVariants(file)) addIndex(byPath, variant, record);
    addIndex(byHash, hash, record);
  }
  const data = sanitizeMigrationData(raw.data);
  return {
    ok: true,
    version,
    exportedAt: safeTimestamp(raw.exportedAt) || '',
    agents: normalizeAgentCatalog(raw.agents),
    stickers,
    byPath,
    byHash,
    data,
    ignored,
  };
}

function normalizedAgentName(value) {
  return cleanText(value, 120).toLocaleLowerCase().replace(/[\s_-]+/g, '');
}

export function buildAgentMapping(sourceAgents, targetAgents) {
  const sources = normalizeAgentCatalog(sourceAgents);
  const targets = normalizeAgentCatalog(targetAgents);
  const byId = new Map(targets.map((item) => [item.id, item]));
  const byName = new Map();
  for (const target of targets) {
    const key = normalizedAgentName(target.name);
    if (!key) continue;
    const list = byName.get(key) || [];
    list.push(target);
    byName.set(key, list);
  }
  const map = new Map();
  const unmatched = [];
  const ambiguous = [];
  for (const source of sources) {
    if (source.id === 'default') { map.set(source.id, 'default'); continue; }
    if (byId.has(source.id)) { map.set(source.id, source.id); continue; }
    const matches = byName.get(normalizedAgentName(source.name)) || [];
    if (matches.length === 1) map.set(source.id, matches[0].id);
    else if (matches.length > 1) ambiguous.push({ source: source.id, name: source.name });
    else unmatched.push({ source: source.id, name: source.name });
  }
  return { map, unmatched, ambiguous };
}

function mapStickerId(value, stickerIdMap, report, field) {
  const sourceId = safeStickerId(value);
  const targetId = sourceId && stickerIdMap instanceof Map ? stickerIdMap.get(sourceId) : '';
  if (!targetId) {
    report.missingStickerReferences += 1;
    if (field) report.unmatchedReferences.push({ field, sourceId });
    return '';
  }
  return targetId;
}

function mapAgentId(value, agentIdMap, report, field) {
  const sourceId = safeAgentId(value);
  const targetId = sourceId && agentIdMap instanceof Map ? agentIdMap.get(sourceId) : '';
  if (!targetId) {
    report.unmatchedAgents.push({ field, sourceId });
    return '';
  }
  return targetId;
}

export function remapMigrationData(data, { stickerIdMap = new Map(), agentIdMap = new Map() } = {}) {
  const report = { missingStickerReferences: 0, unmatchedReferences: [], unmatchedAgents: [], restored: {} };
  const out = {};
  if (data?.preferences) {
    const preferences = { version: Number(data.preferences.version) || 1, users: {} };
    for (const [sourceAgent, sourceUser] of Object.entries(data.preferences.users || {})) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'preferences.users');
      if (!agent) continue;
      const user = { mappings: [] };
      if (sourceUser.updated_at) user.updated_at = sourceUser.updated_at;
      for (const sourceMapping of (Array.isArray(sourceUser.mappings) ? sourceUser.mappings : [])) {
        const mapping = {
          ...sourceMapping,
          context: {
            emotion: cleanText(sourceMapping.context?.emotion, 120),
            keywords: safeStringList(sourceMapping.context?.keywords, 30, MAX_TAG_LENGTH),
          },
          preferred_ids: [],
          vetoed_ids: [],
          dislike_counts: {},
        };
        for (const id of sourceMapping.preferred_ids || []) {
          const mapped = mapStickerId(id, stickerIdMap, report, 'preferences.preferred_ids');
          if (mapped && !mapping.preferred_ids.includes(mapped)) mapping.preferred_ids.push(mapped);
        }
        for (const id of sourceMapping.vetoed_ids || []) {
          const mapped = mapStickerId(id, stickerIdMap, report, 'preferences.vetoed_ids');
          if (mapped && !mapping.vetoed_ids.includes(mapped)) mapping.vetoed_ids.push(mapped);
        }
        for (const [id, count] of Object.entries(sourceMapping.dislike_counts || {})) {
          const mapped = mapStickerId(id, stickerIdMap, report, 'preferences.dislike_counts');
          if (mapped) mapping.dislike_counts[mapped] = Math.floor(safeFiniteNumber(count, 0, 0, 100000));
        }
        user.mappings.push(mapping);
      }
      preferences.users[agent] = user;
    }
    out.preferences = preferences;
    report.restored.preferences = Object.keys(preferences.users).length;
  }
  if (data?.teaching) {
    const teaching = { version: 1, samples: {} };
    for (const [sourceId, sourceSample] of Object.entries(data.teaching.samples || {})) {
      const targetId = mapStickerId(sourceId, stickerIdMap, report, 'teaching.samples');
      if (!targetId) continue;
      teaching.samples[targetId] = { ...sourceSample, vector: undefined };
      delete teaching.samples[targetId].vector;
    }
    out.teaching = teaching;
    report.restored.teaching = Object.keys(teaching.samples).length;
  }
  if (data?.contextFeedback) {
    const contextFeedback = { version: 1, byAgent: {} };
    for (const [sourceAgent, sourceContexts] of Object.entries(data.contextFeedback.byAgent || {})) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'contextFeedback.byAgent');
      if (!agent) continue;
      const contexts = {};
      for (const [context, sourceEntries] of Object.entries(sourceContexts || {})) {
        const entries = {};
        for (const [sourceId, sourceEntry] of Object.entries(sourceEntries || {})) {
          const targetId = mapStickerId(sourceId, stickerIdMap, report, 'contextFeedback');
          if (targetId) entries[targetId] = { ...sourceEntry };
        }
        if (Object.keys(entries).length) contexts[context] = entries;
      }
      if (Object.keys(contexts).length) contextFeedback.byAgent[agent] = contexts;
    }
    out.contextFeedback = contextFeedback;
    report.restored.contextFeedback = Object.values(contextFeedback.byAgent).reduce((n, item) => n + Object.values(item).reduce((m, entries) => m + Object.keys(entries).length, 0), 0);
  }
  if (data?.exposure) {
    const exposure = { version: 2, byAgent: {} };
    for (const [sourceAgent, sourceEntries] of Object.entries(data.exposure.byAgent || {})) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'exposure.byAgent');
      if (!agent) continue;
      const entries = {};
      for (const [sourceId, sourceEntry] of Object.entries(sourceEntries || {})) {
        const targetId = mapStickerId(sourceId, stickerIdMap, report, 'exposure');
        if (targetId) entries[targetId] = { ...sourceEntry };
      }
      if (Object.keys(entries).length) exposure.byAgent[agent] = entries;
    }
    out.exposure = exposure;
    report.restored.exposure = Object.values(exposure.byAgent).reduce((n, item) => n + Object.keys(item).length, 0);
  }
  if (data?.styleTemplate) {
    const styleTemplate = { ...data.styleTemplate, source_agents: [], excluded_agents: [] };
    for (const sourceAgent of data.styleTemplate.source_agents || []) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'styleTemplate.source_agents');
      if (agent && !styleTemplate.source_agents.includes(agent)) styleTemplate.source_agents.push(agent);
    }
    for (const sourceAgent of data.styleTemplate.excluded_agents || []) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'styleTemplate.excluded_agents');
      if (agent && !styleTemplate.excluded_agents.includes(agent)) styleTemplate.excluded_agents.push(agent);
    }
    const currentSource = data.styleTemplate.source_agent_of_current
      ? mapAgentId(data.styleTemplate.source_agent_of_current, agentIdMap, report, 'styleTemplate.source_agent_of_current')
      : '';
    if (data.styleTemplate.source_agent_of_current && currentSource) styleTemplate.source_agent_of_current = currentSource;
    out.styleTemplate = styleTemplate;
    report.restored.styleTemplate = 1;
  }
  if (data?.styleProfile) {
    const styleProfile = { ...data.styleProfile, source_agents: [] };
    for (const sourceAgent of data.styleProfile.source_agents || []) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'styleProfile.source_agents');
      if (agent && !styleProfile.source_agents.includes(agent)) styleProfile.source_agents.push(agent);
    }
    out.styleProfile = styleProfile;
    report.restored.styleProfile = 1;
  }
  if (data?.styleFeedback) {
    out.styleFeedback = data.styleFeedback;
    report.restored.styleFeedback = 1;
  }
  if (data?.dialectConfig) {
    const dialectConfig = { version: 3, agents: {} };
    for (const [sourceAgent, setting] of Object.entries(data.dialectConfig.agents || {})) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'dialectConfig.agents');
      if (agent) dialectConfig.agents[agent] = { ...setting };
    }
    out.dialectConfig = dialectConfig;
    report.restored.dialectConfig = Object.keys(dialectConfig.agents).length;
  }
  if (data?.agentFreq) {
    const agentFreq = { ...data.agentFreq, agents: {} };
    for (const [sourceAgent, setting] of Object.entries(data.agentFreq.agents || {})) {
      const agent = mapAgentId(sourceAgent, agentIdMap, report, 'agentFreq.agents');
      if (agent) agentFreq.agents[agent] = { ...setting };
    }
    out.agentFreq = agentFreq;
    report.restored.agentFreq = Object.keys(agentFreq.agents).length;
  }
  if (data?.displayConfig) { out.displayConfig = { ...data.displayConfig }; report.restored.displayConfig = 1; }
  if (data?.ballConfig) {
    const ballConfig = { ...data.ballConfig, pinnedIds: [] };
    for (const sourceId of data.ballConfig.pinnedIds || []) {
      const targetId = mapStickerId(sourceId, stickerIdMap, report, 'ballConfig.pinnedIds');
      if (targetId && !ballConfig.pinnedIds.includes(targetId)) ballConfig.pinnedIds.push(targetId);
    }
    out.ballConfig = ballConfig;
    report.restored.ballConfig = ballConfig.pinnedIds.length;
  }
  return { data: out, report };
}

export function findMigrationSticker(payload, image, imageHash = '') {
  if (!payload?.ok) return null;
  const hash = String(imageHash || '').toLowerCase();
  const pathRecord = pathVariants(image?.entryName || image?.fileName)
    .map((key) => payload.byPath?.get(key.toLowerCase()))
    .find(Boolean);
  if (pathRecord && (!pathRecord.hash || !hash || pathRecord.hash === hash)) return pathRecord;
  if (hash) return payload.byHash?.get(hash) || null;
  return null;
}

export function planStickerIdMapping({ images = [], migrationPayload = null, existingMeta = [], existingHashes = new Map(), nextId = null } = {}) {
  const meta = Array.isArray(existingMeta) ? existingMeta : [];
  const hashToTarget = new Map();
  if (existingHashes instanceof Map) {
    for (const [hash, id] of existingHashes) if (hash && id) hashToTarget.set(String(hash).toLowerCase(), String(id));
  } else if (existingHashes instanceof Set) {
    for (const hash of existingHashes) hashToTarget.set(String(hash).toLowerCase(), '');
  }
  const usedIds = new Set(meta.map((item) => item?.id).filter(Boolean));
  const makeId = typeof nextId === 'function' ? nextId : (() => {
    let max = 0;
    for (const id of usedIds) {
      const number = parseInt(String(id).replace(/^stk_/, '').replace(/^sticker_/, ''), 10);
      if (Number.isFinite(number)) max = Math.max(max, number);
    }
    return `stk_${String(++max).padStart(3, '0')}`;
  });
  const stickerIdMap = new Map();
  const items = [];
  const skipped = [];
  const sourceIdToRecord = new Map();
  for (const record of migrationPayload?.stickers || []) {
    if (record.sourceId) sourceIdToRecord.set(record.sourceId, record);
  }

  for (const image of Array.isArray(images) ? images : []) {
    const hash = hashBuffer(image.data);
    const transfer = findMigrationSticker(migrationPayload, image, hash);
    const sourceId = transfer?.sourceId || '';
    let targetId = hashToTarget.get(hash);
    let duplicate = Boolean(targetId);
    if (!targetId) {
      targetId = makeId();
      while (!targetId || usedIds.has(targetId)) targetId = makeId();
      usedIds.add(targetId);
      hashToTarget.set(hash, targetId);
    }
    if (sourceId) stickerIdMap.set(sourceId, targetId);
    if (duplicate) {
      skipped.push({ file: image.fileName, reason: '图片内容重复', targetId });
      continue;
    }
    items.push({ image, hash, transfer, targetId });
  }
  // migration.json 里可能有记录，但图片条目在 ZIP 中损坏/缺失；这里只记录可审计的缺口，
  // 由调用方在报告里提示，关联数据会因没有 id 映射而被安全跳过。
  for (const [sourceId] of sourceIdToRecord) {
    if (!stickerIdMap.has(sourceId)) skipped.push({ file: sourceId, reason: '迁移包缺少对应图片' });
  }
  return { stickerIdMap, items, skipped, hashToTarget };
}

export function normalizeTransferMetadata(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.stickers) ? raw.stickers : null);
  if (!list) return { ok: false, error: '标签文件不是有效的表情包列表' };

  const byPath = new Map();
  const records = [];
  for (const item of list.slice(0, MAX_METADATA_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const file = normalizeArchivePath(item.file || item.path || item.filename);
    if (!file) continue;

    const name = cleanText(item.name, MAX_DESCRIPTION_LENGTH);
    const description = cleanText(item.description || name, MAX_DESCRIPTION_LENGTH);
    const tags = normalizeTags(item);
    const semantic = cleanText(item.semantic_description, MAX_SEMANTIC_LENGTH);
    const record = {
      id: cleanId(item.id),
      file,
      name,
      description,
      tags,
      ...(semantic ? { semantic_description: semantic } : {}),
      hasMetadata: Boolean(name || description || hasTagValues(tags) || semantic),
    };
    records.push(record);
    for (const variant of pathVariants(file)) addIndex(byPath, variant, record);
  }

  return {
    ok: true,
    records,
    byPath,
    ignored: Math.max(0, list.length - records.length),
  };
}

export function findTransferMetadata(index, image) {
  if (!index?.ok) return null;
  for (const variant of pathVariants(image?.entryName || image?.fileName)) {
    const record = index.byPath.get(variant.toLowerCase());
    if (record) return record;
  }
  return null;
}

export function readLastExportDir(configPath, fallback = '') {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof data?.lastExportDir === 'string' && data.lastExportDir.trim()
      ? data.lastExportDir.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

export function writeLastExportDir(configPath, directory) {
  const dir = String(directory || '').trim();
  if (!dir) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // 这里只存一个可重建的最近目录；直接覆盖比 Windows 上 rename 覆盖旧文件更稳。
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, lastExportDir: dir }, null, 2), 'utf8');
}
