import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBatchFailures } from '../lib/batch-failures.js';

function task(id, date, failed = [], completed = [], extra = {}) {
  return { id, created_at: date, status: 'completed', failed, completed, ...extra };
}
function collect(tasks, meta = ['a', 'b', 'c'].map(id => ({ id }))) {
  return collectBatchFailures({ order: tasks.map(t => t.id), tasks: Object.fromEntries(tasks.map(t => [t.id, t])) }, meta);
}
const old = '2026-10-01T01:00:00Z', newer = '2026-10-02T01:00:00Z';

test('跨批次失败去重，返回最新错误且数字与清单一致', () => {
  const result = collect([task('new', newer, [{ id: 'a', error: '新错误' }, 'b']), task('old', old, ['a', 'c'])]);
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map(i => i.id), ['a', 'b', 'c']);
  assert.equal(result.items[0].error, '新错误');
  assert.equal(result.items[0].taskId, 'new');
});

test('后来识图成功不再显示旧失败，不管结果是否已应用', () => {
  assert.deepEqual(collect([task('new', newer, [], ['a']), task('old', old, ['a'])]), { total: 0, items: [] });
});

test('后来重识图失败仍列出，即使图片曾成功识别', () => {
  const result = collect([task('new', newer, ['a']), task('old', old, [], ['a'])], [{ id: 'a', tagged_at: old }]);
  assert.equal(result.total, 1);
});

test('明确单图成功时间晚于批次失败时清除旧失败，删图也不再列出', () => {
  const result = collect([task('old', old, ['a', 'b', 'deleted'])], [{ id: 'a', vision_succeeded_at: newer }, { id: 'b' }]);
  assert.deepEqual(result.items.map(i => i.id), ['b']);
});

test('重试正在排队和识别时不重复列出，重试失败后重新出现', () => {
  const running = task('retry', newer, [], [], { status: 'running', pending: ['a'], current_ids: ['b'], current: 'c' });
  assert.equal(collect([running, task('old', old, ['a', 'b', 'c'])]).total, 0);
  const failed = task('retry', newer, ['a'], [], { status: 'completed' });
  assert.equal(collect([failed, task('old', old, ['a'])]).total, 1);
});

test('手动编辑的 tagged_at 不能把识图失败伪装成成功', () => {
  assert.equal(collect([task('old', old, ['a'])], [{ id: 'a', tagged_at: newer }]).total, 1);
});

test('取消批次保留已发生的失败，未执行的 pending 不算失败', () => {
  const result = collect([task('cancelled', newer, ['a'], [], { status: 'cancelled', pending: ['b'] })]);
  assert.deepEqual(result.items.map(i => i.id), ['a']);
});

test('成功与失败脏记录重叠时成功优先，空数据兼容', () => {
  assert.equal(collect([task('t', newer, ['a'], ['a'])]).total, 0);
  assert.deepEqual(collectBatchFailures(null, []), { total: 0, items: [] });
});

test('重试旧任务的精确结果时间优先于任务创建时间，不被更晚创建的旧错误覆盖', () => {
  const result = collect([
    task('newer-task', newer, ['a']),
    task('old-task', old, [], ['a'], { results: { a: { ok: true, attempted_at: '2026-10-02T02:00:00Z' } } }),
  ]);
  assert.equal(result.total, 0);
});
