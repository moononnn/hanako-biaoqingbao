import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyContextFit,
  contextFitBonus,
  readContextFits,
  removeStickerContextFeedback,
  removeContextFitEntry,
} from '../lib/context-feedback.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-context-feedback-'));
}

test('场景正反馈独立于全局偏好，按助手和情绪隔离', async () => {
  const dataDir = tempDir();
  const first = await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  assert.equal(first.ok, true);
  assert.equal(first.snapshot.hadEntry, false);
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), { stk_001: 1 });
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '无语' }), {});
  assert.deepEqual(readContextFits({ dataDir, agentId: 'yumi', contextEmotion: '开心' }), {});
  assert.equal(contextFitBonus(99), 3);
});

test('场景正反馈有上限，恢复快照可以撤销当前这一次', async () => {
  const dataDir = tempDir();
  const first = await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), { stk_001: 3 });

  const restored = await applyContextFit({
    dataDir,
    agentId: 'hanako',
    contextEmotion: '开心',
    stickerId: 'stk_001',
    action: 'restore',
    restoreSnapshot: first.snapshot,
  });
  assert.equal(restored.ok, true);
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), {});
});

test('clear 只撤销一次场景正反馈，不会抹掉同图其他会话的应景次数', async () => {
  const dataDir = tempDir();
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  const clearedOnce = await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001', action: 'clear' });
  assert.equal(clearedOnce.ok, true);
  assert.equal(clearedOnce.count, 1);
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), { stk_001: 1 });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001', action: 'clear' });
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), {});
});

test('删除图片时清理所有助手和场景的正反馈引用', async () => {
  const dataDir = tempDir();
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'yumi', contextEmotion: '无语', stickerId: 'stk_001' });
  const result = await removeStickerContextFeedback({ dataDir, stickerId: 'stk_001' });
  assert.equal(result.ok, true);
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), {});
  assert.deepEqual(readContextFits({ dataDir, agentId: 'yumi', contextEmotion: '无语' }), {});
});

test('removeContextFitEntry 只删指定助手+场景的单条应景记录', async () => {
  const dataDir = tempDir();
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_002' });
  await applyContextFit({ dataDir, agentId: 'hanako', contextEmotion: '无语', stickerId: 'stk_001' });
  const removed = await removeContextFitEntry({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '开心' }), { stk_002: 1 });
  assert.deepEqual(readContextFits({ dataDir, agentId: 'hanako', contextEmotion: '无语' }), { stk_001: 1 });
  // 再次删除同一位置的记录：幂等，返回 removed=false 且不报错
  const again = await removeContextFitEntry({ dataDir, agentId: 'hanako', contextEmotion: '开心', stickerId: 'stk_001' });
  assert.equal(again.ok, true);
  assert.equal(again.removed, false);
  // 缺少参数：拒绝
  const bad = await removeContextFitEntry({ dataDir, agentId: 'hanako', contextEmotion: '开心' });
  assert.equal(bad.ok, false);
});
