// 表情包插件 v0.12.0 - 批量识图任务系统（异步 + 持久化 + 断点续跑）
// v0.17.4-share: 公共函数从 lib/shared.js 导入
import fs from 'node:fs';
import path from 'node:path';
import {
  STICKERS_DIR, DATA_DIR, META_FILE,
  readMeta, tagImage, json as jsonResp, atomicWriteJson,
} from '../lib/shared.js';

const BATCH_TASKS_FILE = path.join(DATA_DIR, 'batch-tasks.json');

let moduleCtx = null;  // 在 registerBatchTasksRoutes 里注入

function readBatchTasks() {
  try {
    const data = JSON.parse(fs.readFileSync(BATCH_TASKS_FILE, 'utf-8'));
    if (!data.tasks || typeof data.tasks !== 'object') data.tasks = {};
    if (!Array.isArray(data.order)) data.order = [];
    return data;
  } catch {
    return { version: 1, tasks: {}, order: [] };
  }
}

// v0.19.5 - 统一走 shared 的原子写（临时文件+rename），消除重复实现
function writeBatchTasks(d) {
  atomicWriteJson(BATCH_TASKS_FILE, d);
}

function saveTask(task) {
  const all = readBatchTasks();
  all.tasks[task.id] = task;
  if (!all.order.includes(task.id)) all.order.unshift(task.id);
  // 只保留最近 50 个任务，避免文件无限增长
  if (all.order.length > 50) {
    const removed = all.order.slice(50);
    for (const id of removed) delete all.tasks[id];
    all.order = all.order.slice(0, 50);
  }
  writeBatchTasks(all);
}

// v0.19.5 - 串行写回队列：多个 worker 同时完成后各自读改写，后写会覆盖前写的更新；
// 用 promise 链把「重新读取 → 变更 → 保存」串行化，避免丢更新
let taskWriteChain = Promise.resolve();
function queuedSave(taskId, mutator) {
  taskWriteChain = taskWriteChain.then(() => {
    const t = getTask(taskId);
    if (!t) return;
    mutator(t);
    saveTask(t);
  }).catch(e => {
    moduleCtx?.log?.error?.(`[batch] 任务 ${taskId} 写回失败:`, e.message);
  });
  return taskWriteChain;
}

function migrateAppliedState() {
  const all = readBatchTasks();
  const taggedAtById = new Map(readMeta().map(sticker => [sticker.id, Date.parse(sticker.tagged_at || '') || 0]));
  let changed = false;
  for (const id of all.order) {
    const task = all.tasks[id];
    if (!task || Array.isArray(task.applied)) continue;
    const createdAt = Date.parse(task.created_at || '') || 0;
    task.applied = (task.completed || []).filter(stickerId => taggedAtById.get(stickerId) >= createdAt);
    changed = true;
  }
  if (changed) writeBatchTasks(all);
}

function getTask(id) {
  const task = readBatchTasks().tasks[id] || null;
  if (task && !Array.isArray(task.applied)) task.applied = [];
  return task;
}

function genTaskId() {
  return 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ═══ 任务创建 ═══

function createBatchTask(stickerIds, concurrency = 3) {
  // 去重
  const uniqueIds = Array.from(new Set(stickerIds));
  const task = {
    id: genTaskId(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'running',
    concurrency: Math.min(Math.max(concurrency || 5, 1), 8),
    total: uniqueIds.length,
    sticker_ids: uniqueIds,
    pending: uniqueIds,
    completed: [],
    failed: [],
    applied: [],
    results: {},
    current: null,
    current_ids: [],
  };
  saveTask(task);
  startWorkerPool(task.id);
  emitBus('biaoqingbao:batch-task-created', { taskId: task.id, total: task.total });
  return task;
}

// ═══ Worker 池 ═══

function startWorkerPool(taskId) {
  // fire-and-forget：setImmediate 让出当前事件循环，后台异步跑
  setImmediate(async () => {
    try {
      await runWorkerPool(taskId);
    } catch (e) {
      moduleCtx?.log?.error?.(`[batch worker pool ${taskId}] 未捕获错误:`, e);
      const task = getTask(taskId);
      if (task && task.status === 'running') {
        task.status = 'failed';
        task.error = e.message;
        task.updated_at = new Date().toISOString();
        saveTask(task);
        emitBus('biaoqingbao:batch-task-failed', { taskId, error: e.message });
      }
    }
  });
}

async function runWorkerPool(taskId) {
  const task = getTask(taskId);
  if (!task || task.status !== 'running') return;

  // 启动 concurrency 个 worker 并发跑
  const concurrency = Math.min(task.concurrency, task.pending.length || 1);
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(workerLoop(taskId, i));
  }
  await Promise.allSettled(workers);

  // 全部 worker 退出后，检查是否真的完成
  const finalTask = getTask(taskId);
  if (finalTask && finalTask.status === 'running' && finalTask.pending.length === 0) {
    finalTask.status = 'completed';
    finalTask.completed_at = new Date().toISOString();
    finalTask.updated_at = finalTask.completed_at;
    saveTask(finalTask);
    emitBus('biaoqingbao:batch-task-completed', {
      taskId,
      summary: {
        total: finalTask.total,
        success: finalTask.completed.length,
        failed: finalTask.failed.length,
      },
    });
  }
}

async function workerLoop(taskId, workerIdx) {
  moduleCtx?.log?.info?.(`[batch worker ${taskId}/${workerIdx}] 启动`);
  while (true) {
    if (!moduleCtx) {
      moduleCtx?.log?.warn?.(`[batch worker ${taskId}/${workerIdx}] ctx 已卸载，停止`);
      return;
    }
    const task = getTask(taskId);
    if (!task) return;
    if (task.status !== 'running') return;
    if (task.pending.length === 0) return;

    // 取下一个 sticker_id
    const stickerId = task.pending.shift();
    // v0.15.1 - current 改为数组，支持多 worker 并发显示
    if (!Array.isArray(task.current_ids)) task.current_ids = [];
    task.current_ids.push(stickerId);
    task.updated_at = new Date().toISOString();
    saveTask(task);

    // 识图
    let result;
    try {
      const sticker = readMeta().find(s => s.id === stickerId);
      if (!sticker) throw new Error('sticker 不存在');
      const filePath = path.join(STICKERS_DIR, sticker.file);
      if (!fs.existsSync(filePath)) throw new Error('图片文件不存在');
      const buf = fs.readFileSync(filePath);
      // 由 tagImage 根据真实扩展名设置 MIME；动态 GIF 会先抽取关键帧。
      const tagResult = await tagImage(buf.toString('base64'), sticker.file);
      if (tagResult.ok) {
        result = { ok: true, data: tagResult.data };
      } else {
        result = { ok: false, error: tagResult.error || '未知错误' };
      }
    } catch (e) {
      moduleCtx?.log?.error?.(`[batch worker ${taskId}/${workerIdx}] 处理 ${stickerId} 异常:`, e.message);
      result = { ok: false, error: e.message };
    }

    // 写回结果（v0.19.5 - 走串行队列，mutator 执行前重新读最新任务，避免多 worker 覆盖彼此更新）
    await queuedSave(taskId, (t) => {
      if (t.status !== 'running') return; // 任务已取消/完成，不再写回
      t.results[stickerId] = result;
      if (result.ok) {
        t.completed.push(stickerId);
      } else {
        t.failed.push({ id: stickerId, error: result.error, raw: result.raw || null });
      }
      // v0.15.1 - 从 current_ids 数组移除
      if (Array.isArray(t.current_ids)) {
        t.current_ids = t.current_ids.filter(id => id !== stickerId);
      } else {
        t.current = null; // 兼容旧数据
      }
      t.updated_at = new Date().toISOString();
    });

    // 实时推送进度（写回后重新读取，拿最新计数）
    const latest = getTask(taskId);
    emitBus('biaoqingbao:batch-task-progress', {
      taskId,
      stickerId,
      completed: latest?.completed?.length || 0,
      failed: latest?.failed?.length || 0,
      total: latest?.total || 0,
      result,
    });
  }
}

// ═══ 任务控制 ═══

function cancelTask(taskId) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status !== 'running') return { ok: false, error: `任务状态为 ${task.status}，无需取消` };
  task.status = 'cancelled';
  task.cancelled_at = new Date().toISOString();
  task.updated_at = task.cancelled_at;
  saveTask(task);
  emitBus('biaoqingbao:batch-task-cancelled', { taskId });
  return { ok: true };
}

function deleteTask(taskId) {
  const all = readBatchTasks();
  if (!all.tasks[taskId]) return { ok: false, error: '任务不存在' };
  delete all.tasks[taskId];
  all.order = all.order.filter(id => id !== taskId);
  writeBatchTasks(all);
  return { ok: true };
}

function markTaskApplied(taskId, stickerIds) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  const completed = new Set(task.completed || []);
  const validIds = Array.from(new Set(stickerIds || [])).filter(id => completed.has(id));
  if (validIds.length === 0) return { ok: false, error: '没有可标记的 sticker_id' };
  task.applied = Array.from(new Set([...(task.applied || []), ...validIds]));
  task.updated_at = new Date().toISOString();
  saveTask(task);
  return { ok: true, applied: task.applied.length };
}

// v0.25.1 - 重试成功后清除旧任务的失败记录：失败项已被新任务接管，
// 旧任务不再显示这些失败（如果它没有其他待处理项，就会从列表里自然消失）
function markTaskRetried(taskId, stickerIds) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  const idSet = new Set(stickerIds || []);
  if (idSet.size === 0) return { ok: false, error: '缺少 sticker_ids' };
  const before = (task.failed || []).length;
  task.failed = (task.failed || []).filter(f => !idSet.has(typeof f === 'string' ? f : f?.id));
  if (task.failed.length === before) return { ok: false, error: '没有可清除的失败项' };
  task.updated_at = new Date().toISOString();
  saveTask(task);
  return { ok: true, cleared: before - task.failed.length };
}

function listTasks(filter = {}) {
  const all = readBatchTasks();
  let tasks = all.order.map(id => all.tasks[id]).filter(Boolean);
  if (filter.status) {
    tasks = tasks.filter(t => t.status === filter.status);
  }
  // 返回精简版（不含 results，节省带宽）
  return tasks.map(t => ({
    id: t.id,
    created_at: t.created_at,
    updated_at: t.updated_at,
    status: t.status,
    total: t.total,
    completed: t.completed.length,
    failed: t.failed.length,
    applied: Array.isArray(t.applied) ? t.applied.length : 0,
    pending: t.pending.length,
    current: t.current,
    current_ids: t.current_ids || [],
  }));
}

export function recoverInterruptedItems(task) {
  if (!task || task.status !== 'running') return [];

  const completed = new Set(task.completed || []);
  const failed = new Set((task.failed || [])
    .map(item => typeof item === 'string' ? item : item?.id)
    .filter(Boolean));
  const interrupted = [
    ...(Array.isArray(task.current_ids) ? task.current_ids : []),
    task.current,
  ].filter(Boolean);

  const recovered = [];
  const seen = new Set([...completed, ...failed]);
  const pending = [];
  for (const id of [...interrupted, ...(Array.isArray(task.pending) ? task.pending : [])]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pending.push(id);
    if (interrupted.includes(id)) recovered.push(id);
  }

  task.pending = pending;
  task.current = null;
  task.current_ids = [];
  return recovered;
}

function resumeAllTasks() {
  const all = readBatchTasks();
  let resumed = 0;
  let changed = false;

  for (const id of all.order) {
    const task = all.tasks[id];
    if (!task || task.status !== 'running') continue;

    const hadInterruptedMarkers = Boolean(task.current)
      || (Array.isArray(task.current_ids) && task.current_ids.length > 0);
    const recovered = recoverInterruptedItems(task);
    if (hadInterruptedMarkers) {
      task.updated_at = new Date().toISOString();
      changed = true;
    }
    if (recovered.length > 0) {
      moduleCtx?.log?.info?.(`[batch] 任务 ${id} 回收 ${recovered.length} 张中断图片`);
    }

    if (task.pending.length > 0) {
      moduleCtx?.log?.info?.(`[batch] 恢复任务 ${id}（剩余 ${task.pending.length} 张）`);
      startWorkerPool(id);
      resumed++;
    } else {
      // v0.19.5 - 死状态兜底：最后一张写完后没来得及标 completed 就退出的任务，直接标记完成
      task.status = 'completed';
      task.completed_at = new Date().toISOString();
      task.updated_at = task.completed_at;
      changed = true;
      moduleCtx?.log?.info?.(`[batch] 任务 ${id} 无待处理项目，直接标记为完成`);
      emitBus('biaoqingbao:batch-task-completed', {
        taskId: id,
        summary: {
          total: task.total,
          success: (task.completed || []).length,
          failed: (task.failed || []).length,
        },
      });
    }
  }

  if (changed) writeBatchTasks(all);
  if (resumed > 0) {
    moduleCtx?.log?.info?.(`[batch] 共恢复 ${resumed} 个任务`);
  }
  return resumed;
}

function emitBus(topic, data) {
  try {
    moduleCtx?.bus?.emit?.(topic, data);
  } catch (e) {
    moduleCtx?.log?.warn?.(`[batch] EventBus 推送失败 ${topic}:`, e.message);
  }
}

// ═══ API 注册 ═══
// jsonResp 已从 lib/shared.js 导入（json as jsonResp）

export function registerBatchTasksRoutes(app, ctx) {
  moduleCtx = ctx;
  migrateAppliedState();
  moduleCtx?.log?.info?.('[biaoqingbao] 注册 batch-tasks 路由');

  // POST /api/batch-auto-tag — 创建异步批量识图任务（新版）
  app.post('/api/batch-auto-tag', async (c) => {
    try {
      // v0.14.12 决定性日志：验证走的真的是异步 handler（不是被旧的同步 handler 截获）
      moduleCtx?.log?.info?.('[batch-create] async handler entered', { method: c.req.method, url: c.req.url });
      const body = await c.req.json();
      moduleCtx?.log?.info?.('[batch-create] body parsed', { count: Array.isArray(body?.sticker_ids) ? body.sticker_ids.length : 0 });
      const stickerIds = Array.isArray(body?.sticker_ids) ? body.sticker_ids : [];
      if (stickerIds.length === 0) {
        return jsonResp({ ok: false, error: '缺少 sticker_ids' }, 400);
      }
      // v0.25.1 - 上限放宽到 1000：任务本身是流式队列，单任务几百张毫无压力，
      // 用户不再需要手动分批；超过 1000 的极端图库前端会拆两次创建。
      if (stickerIds.length > 1000) {
        return jsonResp({ ok: false, error: '单次最多 1000 张' }, 400);
      }
      // 验证 sticker 存在
      const meta = readMeta();
      const idSet = new Set(meta.map(s => s.id));
      const validIds = stickerIds.filter(id => idSet.has(id));
      if (validIds.length === 0) {
        return jsonResp({ ok: false, error: '没有有效的 sticker_id' }, 400);
      }
      const skipped = stickerIds.length - validIds.length;

      const concurrency = body.concurrency || 3;
      const task = createBatchTask(validIds, concurrency);
      moduleCtx?.log?.info?.('[batch-create] task created', { taskId: task.id, total: task.total });

      return jsonResp({
        ok: true,
        data: {
          taskId: task.id,
          total: task.total,
          concurrency: task.concurrency,
          status: task.status,
        },
        message: `已创建异步任务，${task.total} 张图将在后台识别${skipped > 0 ? `（已跳过 ${skipped} 张无效 ID）` : ''}`,
      });
    } catch (e) {
      ctx?.log?.error?.('[batch] 创建任务失败:', e.message);
      return jsonResp({ ok: false, error: e.message }, 500);
    }
  });

  // GET /api/batch-tasks — 列出所有任务
  app.get('/api/batch-tasks', async (c) => {
    const status = c.req.query('status') || '';
    const tasks = listTasks(status ? { status } : {});
    return jsonResp({ ok: true, data: tasks });
  });

  // GET /api/batch-task/:id — 查任务详情
  // 默认返回精简版（只有计数 + 正在处理项，不含 results / 明细数组），
  // 供进度轮询使用：几百张的任务每 1.5s 拉一次也不会卡带宽。
  // 传 full=1 才返回完整任务（results / completed / failed / applied），供结果视图使用。
  app.get('/api/batch-task/:id', async (c) => {
    const id = c.req.param('id');
    const task = getTask(id);
    if (!task) return jsonResp({ ok: false, error: '任务不存在' }, 404);
    if (c.req.query('full') === '1') {
      return jsonResp({ ok: true, data: task });
    }
    return jsonResp({ ok: true, data: {
      id: task.id,
      created_at: task.created_at,
      updated_at: task.updated_at,
      status: task.status,
      total: task.total,
      completed_count: (task.completed || []).length,
      failed_count: (task.failed || []).length,
      pending_count: (task.pending || []).length,
      applied_count: Array.isArray(task.applied) ? task.applied.length : 0,
      current_ids: task.current_ids || [],
      error: task.error || null,
    } });
  });

  // POST /api/batch-task/:id/cancel — 取消运行中的任务
  app.post('/api/batch-task/:id/cancel', async (c) => {
    const id = c.req.param('id');
    return jsonResp(cancelTask(id));
  });

  // POST /api/batch-task/:id/applied — 持久记录用户已确认应用的识图结果
  app.post('/api/batch-task/:id/applied', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const stickerIds = Array.isArray(body.sticker_ids) ? body.sticker_ids : [];
    if (stickerIds.length === 0) return jsonResp({ ok: false, error: '缺少 sticker_ids' }, 400);
    return jsonResp(markTaskApplied(id, stickerIds));
  });

  // POST /api/batch-task/:id/retried — 重试成功后清除旧任务的失败记录
  app.post('/api/batch-task/:id/retried', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const stickerIds = Array.isArray(body.sticker_ids) ? body.sticker_ids : [];
    return jsonResp(markTaskRetried(id, stickerIds));
  });

  // DELETE /api/batch-task/:id — 删除任务记录
  app.delete('/api/batch-task/:id', async (c) => {
    const id = c.req.param('id');
    return jsonResp(deleteTask(id));
  });

  ctx?.log?.info?.('[biaoqingbao] Batch tasks 路由注册完成');
}

// 供 index.js onload 时调用
export function resumeBatchTasks(ctx) {
  moduleCtx = ctx;
  return resumeAllTasks();
}
