// 表情包插件 v0.34.37 - 批量识图结果的落盘逻辑 + 批量识图配置
//
// 背景：批量识图是「先识别、再应用」两拍。识别结果先存在任务里，只有点了「全部应用」
// 才会写进图库（description / emotion / scene / keywords / tagged_at）。
// 这个模块把「应用」这段逻辑抽出来共享：
//   - routes/api.js 的 batch_update（用户手动应用）
//   - routes/_batch-tasks.js 的任务完成自动应用
// 两边必须是同一套写入规则，否则手动和自动落到图库的结果会不一致。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const BATCH_CONFIG_FILE = path.join(DATA_DIR, 'batch-config.json');

// 默认开启自动应用（用户 2026-09-11 拍板）：识别完直接写库，省掉容易漏点的一步。
// 关掉后回到「先预览、再点全部应用」的稳妥打法。
export const DEFAULT_BATCH_CONFIG = Object.freeze({ autoApply: true });

export function readBatchConfig(file = BATCH_CONFIG_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BATCH_CONFIG };
    return { ...DEFAULT_BATCH_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_BATCH_CONFIG };
  }
}

export function writeBatchConfig(patch, file = BATCH_CONFIG_FILE) {
  const next = { ...readBatchConfig(file), ...(patch || {}) };
  if (typeof next.autoApply !== 'boolean') next.autoApply = DEFAULT_BATCH_CONFIG.autoApply;
  atomicWriteJson(file, next);
  return next;
}

export function isAutoApplyEnabled(config = readBatchConfig()) {
  return config?.autoApply !== false;
}

// 纯函数：任务里识别成功但还没写进图库的 id。自动应用与手动「全部应用」都按它挑。
export function selectPendingApplyIds(task) {
  const applied = new Set(Array.isArray(task?.applied) ? task.applied : []);
  return (Array.isArray(task?.completed) ? task.completed : []).filter((id) => !applied.has(id));
}

// 把识别结果转成写库用的条目。只收识别成功的项，失败/缺失的直接跳过。
export function buildApplyItems(task, ids) {
  const results = task?.results || {};
  const items = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const result = results[id];
    if (!result || !result.ok || !result.data) continue;
    const data = result.data;
    items.push({
      id,
      description: data.description || '',
      semantic_description: data.semantic_description || '',
      emotion: data.emotion || [],
      scene: data.scene || [],
      keywords: data.keywords || [],
    });
  }
  return items;
}

// 纯函数：把条目写进 meta 数组（原地修改），返回实际更新条数。
// 字段口径与单张「更新」保持一致（空值不覆盖、写入 tagged_at 标记识图时间）。
export function applyItemsToMeta(meta, items, now = new Date().toISOString()) {
  if (!Array.isArray(meta)) return 0;
  let updated = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id) continue;
    const idx = meta.findIndex((sticker) => sticker?.id === item.id);
    if (idx === -1) continue;
    if (!meta[idx].tags || typeof meta[idx].tags !== 'object') meta[idx].tags = {};
    const toList = (value) => Array.isArray(value)
      ? value.map((v) => String(v).trim()).filter(Boolean)
      : String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (item.emotion !== undefined) meta[idx].tags.emotion = toList(item.emotion);
    if (item.scene !== undefined) meta[idx].tags.scene = toList(item.scene);
    if (item.keywords !== undefined) meta[idx].tags.keywords = toList(item.keywords);
    if (item.description !== undefined) meta[idx].description = item.description;
    if (item.semantic_description !== undefined) meta[idx].semantic_description = item.semantic_description;
    meta[idx].tagged_at = now;
    updated++;
  }
  return updated;
}
