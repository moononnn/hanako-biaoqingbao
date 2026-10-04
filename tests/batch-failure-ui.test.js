import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/sticker-manager.js', import.meta.url), 'utf8');
function functionSource(name) {
  const code = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n  }'))?.[0];
  assert.ok(code, name + ' exists');
  return code;
}
function runFunction(name, globals) {
  const ctx = vm.createContext(globals);
  vm.runInContext(functionSource(name), ctx);
  return ctx;
}

test('失败角标按去重后的当前失败计数，不累加各批次历史失败', () => {
  const badge = { hidden: true, style: {} };
  const ctx = runFunction('renderBatchTasksBadge', { $: () => badge });
  ctx.renderBatchTasksBadge([
    { id: 'new', status: 'completed', completed: 0, applied: 0, failed: 2 },
    { id: 'old', status: 'completed', completed: 0, applied: 0, failed: 1 },
  ], { total: 2, items: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(badge.innerHTML, '2 张识别失败');
});

test('点击失败角标打开全局失败列表，不再打开第一批混合结果', () => {
  const calls = [];
  const ctx = runFunction('openBatchTasksModal', {
    batchTasksData: [{ id: 'latest', status: 'completed', completed: 5, applied: 5, failed: 16 }],
    batchFailuresData: { total: 34, items: [] },
    openBatchTaskDetail: id => calls.push(['task', id]),
    openBatchFailures: () => calls.push(['failures']), toast: () => {},
  });
  ctx.openBatchTasksModal();
  assert.deepEqual(calls, [['failures']]);
});

test('全局失败视图只渲染失败缩略图，全部重试固定操作区按同一名单计数', () => {
  const elements = Object.fromEntries(['batch-summary', 'batch-list', 'batch-failure-actions', 'batch-retry-all-failures'].map(id => [id, {}]));
  const rendered = [];
  const ctx = runFunction('renderBatchFailures', {
    $: id => elements[id], currentResultTask: {}, batchFailureRetryBusy: false,
    renderBatchGridItem: (id, result, status) => { rendered.push([id, status]); return '<figure>' + id + '</figure>'; },
    bindBatchGridActions: () => {},
  });
  ctx.renderBatchFailures({ total: 2, items: [{ id: 'a', error: '超时' }, { id: 'b', error: '网络错误' }] });
  assert.deepEqual(rendered, [['a', 'failed'], ['b', 'failed']]);
  assert.equal(elements['batch-retry-all-failures'].textContent, '全部重新识图 (2)');
  assert.equal(elements['batch-failure-actions'].hidden, false);
  assert.equal(ctx.currentResultTask, null);
});

test('旧任务轮询晚回包不能覆盖已经打开的全局失败列表', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const ctx = runFunction('pollBatchTask', {
    batchViewGeneration: 1, batchFailureView: false, currentBatchTaskId: 'old',
    apiFetch: async () => pending, withAuth: v => v, API: '',
    renderBatchProgress: () => calls.push('progress'), loadFullBatchResult: () => calls.push('results'),
    stopBatchPolling: () => {}, $: () => { throw new Error('stale DOM write'); }, console,
  });
  const run = ctx.pollBatchTask('old');
  ctx.batchViewGeneration++;
  ctx.batchFailureView = true;
  release({ json: async () => ({ ok: true, data: { status: 'running', total: 10, completed_count: 1, failed_count: 1 } }) });
  await run;
  assert.deepEqual(calls, []);
});

test('重试HTTP失败保留失败名单与可重试按钮，重复点击不发第二个请求', async () => {
  const ids = ['a'];
  const button = {};
  const data = { total: 1, items: [{ id: 'a' }] };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const rendered = [];
  const ctx = runFunction('retryBatchFailures', {
    batchFailureRetryBusy: false, batchViewGeneration: 1, batchFailureView: true, batchFailuresData: data,
    $: id => id === 'batch-list' ? { querySelectorAll: () => [] } : button,
    apiFetch: async () => { requests++; return pending; }, withAuth: v => v, API: '',
    toast: () => {}, checkBatchTasks: async () => {}, renderBatchFailures: snapshot => rendered.push(snapshot),
  });
  const first = ctx.retryBatchFailures(ids);
  await ctx.retryBatchFailures(ids);
  assert.equal(requests, 1);
  assert.equal(button.disabled, true);
  release({ ok: false, json: async () => ({ ok: false, error: '模拟网络失败' }) });
  await first;
  assert.equal(ctx.batchFailureRetryBusy, false);
  assert.equal(rendered[0], data);
  assert.equal(ctx.batchFailureView, true);
});

test('手动刷新落定后，在飞的自动轮询不能用旧名单覆盖', async () => {
  let releaseA, releaseB;
  const a = new Promise(resolve => { releaseA = resolve; });
  const b = new Promise(resolve => { releaseB = resolve; });
  const elements = Object.fromEntries(['batch-modal', 'batch-summary', 'batch-list', 'batch-failure-actions'].map(id => [id, { style: {} }]));
  const rendered = [];
  const ctx = runFunction('openBatchFailures', {
    batchTasksRequestGeneration: 0, batchViewGeneration: 0, batchFailureView: false, batchFailureRetryBusy: false,
    batchTasksData: [], batchFailuresData: { total: 0, items: [] }, batchTaskNotified: {},
    stopBatchPolling: () => {}, currentBatchTaskId: null, currentResultTask: null,
    $: id => elements[id], API: '', withAuth: v => v,
    apiFetch: async url => url.includes('batch-failures') ? a : b,
    renderBatchTasksBadge: () => {}, renderBatchFailures: data => rendered.push(data.total), toast: () => {}, console,
  });
  vm.runInContext(functionSource('checkBatchTasks'), ctx);
  const refresh = ctx.openBatchFailures();
  const check = ctx.checkBatchTasks();
  releaseA({ ok: true, json: async () => ({ ok: true, data: { total: 2, items: [{ id: 'a' }, { id: 'b' }] } }) });
  await refresh;
  releaseB({ ok: true, json: async () => ({ ok: true, data: [], failures: { total: 1, items: [{ id: 'a' }] } }) });
  await check;
  assert.deepEqual(rendered, [2]);
  assert.equal(ctx.batchFailuresData.total, 2);
});
