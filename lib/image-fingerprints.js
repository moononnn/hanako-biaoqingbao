// 表情包插件 v0.34.35 - 图片内容指纹索引
// 用途：导入时按图片内容（SHA-256）判断这张图是不是已经在库里，
// 重复的图直接跳过，不再入库、也不会进识图任务，避免图库重复和识图 token 白烧。
//
// 定位：索引是 stickers.json 的派生缓存，图库元数据始终是唯一事实源。
// - 只在导入 / 删除时增量维护；新增图才读文件算哈希，已建过索引的图不重复读盘。
// - 查重时再核对一次 id 是否还在图库里，漏清理的脏记录当场清掉，不会把新图误判成重复。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, STICKERS_DIR, readMeta, atomicWriteJson } from './shared.js';
import { hashBuffer } from './sticker-transfer.js';
import { safeStickerPath } from './ball-core.js';

export const FINGERPRINT_INDEX_FILE = path.join(DATA_DIR, 'image-fingerprints.json');
const INDEX_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;

// 索引按文件路径分桶缓存：测试会传入临时索引文件，不能互相串数据。
const caches = new Map();

function loadIndex(indexFile) {
  const cached = caches.get(indexFile);
  if (cached) return cached;

  const byId = new Map();
  const byHash = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (raw && raw.version === INDEX_VERSION && raw.byId && typeof raw.byId === 'object') {
      for (const [id, hash] of Object.entries(raw.byId)) {
        const value = String(hash || '').toLowerCase();
        if (!id || !HASH_RE.test(value)) continue;
        byId.set(id, value);
        if (!byHash.has(value)) byHash.set(value, new Set());
        byHash.get(value).add(id);
      }
    }
  } catch {}

  const cache = { byId, byHash };
  caches.set(indexFile, cache);
  return cache;
}

function persist(indexFile) {
  const cache = loadIndex(indexFile);
  const byId = {};
  for (const [id, hash] of cache.byId) byId[id] = hash;
  atomicWriteJson(indexFile, {
    version: INDEX_VERSION,
    updated_at: new Date().toISOString(),
    byId,
  });
}

function dropId(cache, id) {
  const hash = cache.byId.get(id);
  if (!hash) return;
  cache.byId.delete(id);
  const bucket = cache.byHash.get(hash);
  if (!bucket) return;
  bucket.delete(id);
  if (bucket.size === 0) cache.byHash.delete(hash);
}

function setId(cache, id, hash) {
  const prev = cache.byId.get(id);
  if (prev === hash) return;
  if (prev) dropId(cache, id);
  cache.byId.set(id, hash);
  if (!cache.byHash.has(hash)) cache.byHash.set(hash, new Set());
  cache.byHash.get(hash).add(id);
}

function fingerprintOfFile(stickersDir, file) {
  try {
    const filePath = safeStickerPath(stickersDir, file);
    if (!filePath || !fs.existsSync(filePath)) return '';
    return hashBuffer(fs.readFileSync(filePath));
  } catch {
    return '';
  }
}

export function fingerprintOfBuffer(data) {
  return hashBuffer(data);
}

// 用当前图库补齐索引：新增的图补算指纹，已删除的图清掉。
// 幂等，可在每次导入前调用；没有变化时不写盘。
export function syncFingerprintIndex({
  meta = readMeta(),
  stickersDir = STICKERS_DIR,
  indexFile = FINGERPRINT_INDEX_FILE,
} = {}) {
  const cache = loadIndex(indexFile);
  const aliveIds = new Set(meta.map((sticker) => sticker?.id).filter(Boolean));
  let added = 0;
  let removed = 0;
  let failed = 0;

  for (const id of Array.from(cache.byId.keys())) {
    if (aliveIds.has(id)) continue;
    dropId(cache, id);
    removed++;
  }

  for (const sticker of meta) {
    const id = sticker?.id;
    if (!id || cache.byId.has(id)) continue;
    const hash = fingerprintOfFile(stickersDir, sticker.file);
    if (!hash) {
      failed++;
      continue;
    }
    setId(cache, id, hash);
    added++;
  }

  if (added || removed) persist(indexFile);
  return { added, removed, failed, total: cache.byId.size };
}

// 查这张图的指纹是不是已经在库里。命中返回库里的那张表情包，否则 null。
// meta 里已经找不到的 id（删除时漏清理）会被就地清掉。
export function findDuplicateSticker(hash, meta = readMeta(), { indexFile = FINGERPRINT_INDEX_FILE } = {}) {
  const value = String(hash || '').toLowerCase();
  if (!HASH_RE.test(value)) return null;
  const cache = loadIndex(indexFile);
  const bucket = cache.byHash.get(value);
  if (!bucket || bucket.size === 0) return null;

  const byId = new Map(meta.map((sticker) => [sticker?.id, sticker]));
  let hit = null;
  let dirty = false;
  for (const id of Array.from(bucket)) {
    const sticker = byId.get(id);
    if (!sticker) {
      dropId(cache, id);
      dirty = true;
      continue;
    }
    if (!hit) hit = sticker;
  }
  if (dirty) persist(indexFile);
  return hit;
}

// 登记一张新入库的图。批量导入时先传 persistNow=false，最后 flush 一次即可。
export function registerFingerprint(id, hash, { indexFile = FINGERPRINT_INDEX_FILE, persistNow = true } = {}) {
  const value = String(hash || '').toLowerCase();
  if (!id || !HASH_RE.test(value)) return false;
  const cache = loadIndex(indexFile);
  setId(cache, id, value);
  if (persistNow) persist(indexFile);
  return true;
}

export function unregisterFingerprint(id, { indexFile = FINGERPRINT_INDEX_FILE, persistNow = true } = {}) {
  const cache = loadIndex(indexFile);
  if (!cache.byId.has(id)) return false;
  dropId(cache, id);
  if (persistNow) persist(indexFile);
  return true;
}

export function flushFingerprintIndex({ indexFile = FINGERPRINT_INDEX_FILE } = {}) {
  persist(indexFile);
}

// 供 ZIP 导入构造「hash → 库里已有 id」查重表，避免每次导入重算全库哈希。
export function fingerprintPairs({ indexFile = FINGERPRINT_INDEX_FILE } = {}) {
  const cache = loadIndex(indexFile);
  const pairs = [];
  for (const [hash, bucket] of cache.byHash) {
    for (const id of bucket) pairs.push([hash, id]);
  }
  return pairs;
}

// 只为测试与「重建索引」准备：丢掉内存缓存（可选删掉索引文件）。
export function resetFingerprintIndex({ indexFile = FINGERPRINT_INDEX_FILE, deleteFile = false } = {}) {
  caches.delete(indexFile);
  if (deleteFile) {
    try {
      if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);
    } catch {}
  }
}
