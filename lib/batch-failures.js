// 当前失败清单：按图片去重，只保留最后一次识别的失败；不改历史任务。
export function collectBatchFailures(store, meta) {
  const tasks = (store?.order || []).map(id => store.tasks?.[id]).filter(Boolean);
  const stickers = new Map((meta || []).map(s => [s.id, s]));
  const busy = new Set();
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    for (const id of [...(task.pending || []), ...(task.current_ids || []), task.current].filter(Boolean)) busy.add(id);
  }
  const latest = new Map();
  for (const task of tasks) {
    const failed = new Map((task.failed || []).map(f => [typeof f === 'string' ? f : f?.id, f]));
    const ids = new Set([...(task.completed || []), ...failed.keys()]);
    for (const id of ids) {
      if (!id || !stickers.has(id)) continue;
      const result = task.results?.[id];
      const success = result?.ok === true || (task.completed || []).includes(id);
      const at = Date.parse(result?.attempted_at || task.created_at || '') || 0;
      const previous = latest.get(id);
      // order 由新到旧；相同时间不让旧任务覆盖新任务。
      if (previous && previous.at >= at) continue;
      const failure = failed.get(id);
      latest.set(id, {
        id, at, success, taskId: task.id,
        error: result?.error || (typeof failure === 'object' ? failure?.error : '') || '识图失败',
      });
    }
  }
  const items = [];
  for (const item of latest.values()) {
    if (item.success || busy.has(item.id)) continue;
    const sticker = stickers.get(item.id);
    // tagged_at 也会由人工编辑写入，不能冒充 AI 成功；旧批次成功由上面的事件判定。
    const succeededAt = Date.parse(sticker.vision_succeeded_at || '') || 0;
    if (succeededAt > 0 && succeededAt >= item.at) continue;
    items.push({ id: item.id, taskId: item.taskId, description: sticker.description || item.id, error: item.error });
  }
  return { total: items.length, items };
}
