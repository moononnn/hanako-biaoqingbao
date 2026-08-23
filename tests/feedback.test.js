import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPreferenceFeedback } from '../lib/feedback.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-feedback-'));
}

function prepareDataDir() {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([{ id: 'stk_001' }, { id: 'stk_002' }]), 'utf8');
  return dataDir;
}

function readPrefs(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
}

test('公共反馈逻辑统一写喜欢、不喜欢，并能撤销当前纸飞机反馈', async () => {
  const dataDir = prepareDataDir();
  const positive = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'positive',
    agentId: 'hanako',
    contextEmotion: '开心',
  });
  assert.equal(positive.ok, true);
  assert.equal(positive.dislike_count, 0);
  assert.equal(positive.snapshot.hadMapping, false);

  let mapping = readPrefs(dataDir).users.hanako.mappings[0];
  assert.deepEqual(mapping.preferred_ids, ['stk_001']);
  assert.deepEqual(mapping.dislike_counts, {});

  const negative = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'negative',
    agentId: 'hanako',
    contextEmotion: '开心',
    restoreSnapshot: positive.snapshot,
  });
  assert.equal(negative.ok, true);
  assert.equal(negative.dislike_count, 1);
  mapping = readPrefs(dataDir).users.hanako.mappings[0];
  assert.deepEqual(mapping.preferred_ids, []);
  assert.equal(mapping.dislike_counts.stk_001, 1);

  const cleared = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'clear',
    agentId: 'hanako',
    contextEmotion: '开心',
    restoreSnapshot: negative.snapshot,
  });
  assert.equal(cleared.ok, true);
  const afterClear = readPrefs(dataDir);
  assert.deepEqual(afterClear.users.hanako.mappings, [], '撤销首次反馈后不应留下空 mapping');
});

test('撤销按稳定 mapping id 定位，不因手动插入同情绪 mapping 误删', async () => {
  const dataDir = prepareDataDir();
  const positive = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'positive',
    agentId: 'hanako',
    contextEmotion: '开心',
  });
  const prefs = readPrefs(dataDir);
  prefs.users.hanako.mappings.unshift({
    id: 'manually-added',
    context: { emotion: '开心', keywords: [] },
    preferred_ids: [],
    vetoed_ids: [],
    dislike_counts: {},
    weight: 1,
  });
  fs.writeFileSync(path.join(dataDir, 'preferences.json'), JSON.stringify(prefs), 'utf8');
  const cleared = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'clear',
    agentId: 'hanako',
    contextEmotion: '开心',
    restoreSnapshot: positive.snapshot,
  });
  assert.equal(cleared.ok, true);
  const mappings = readPrefs(dataDir).users.hanako.mappings;
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].id, 'manually-added');
});

test('撤销当前反馈不会抹掉同一 mapping 下其他图片的偏好', async () => {
  const dataDir = prepareDataDir();
  await applyPreferenceFeedback({ dataDir, stickerId: 'stk_002', feedbackType: 'positive', agentId: 'hanako', contextEmotion: '开心' });
  const current = await applyPreferenceFeedback({ dataDir, stickerId: 'stk_001', feedbackType: 'negative', agentId: 'hanako', contextEmotion: '开心' });
  const cleared = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'clear',
    agentId: 'hanako',
    contextEmotion: '开心',
    restoreSnapshot: current.snapshot,
  });
  assert.equal(cleared.ok, true);
  const mapping = readPrefs(dataDir).users.hanako.mappings[0];
  assert.deepEqual(mapping.preferred_ids, ['stk_002']);
  assert.deepEqual(mapping.dislike_counts, {});
});

test('公共反馈逻辑按助手和情绪隔离，并拒绝不存在的图片', async () => {
  const dataDir = prepareDataDir();
  const first = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'negative',
    agentId: 'hanako',
    contextEmotion: '开心',
  });
  assert.equal(first.ok, true);

  const otherAgent = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'positive',
    agentId: 'yumi',
    contextEmotion: '开心',
  });
  assert.equal(otherAgent.ok, true);
  const otherEmotion = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'stk_001',
    feedbackType: 'positive',
    agentId: 'hanako',
    contextEmotion: '难过',
  });
  assert.equal(otherEmotion.ok, true);

  const prefs = readPrefs(dataDir);
  assert.equal(prefs.users.hanako.mappings.length, 2);
  assert.equal(prefs.users.yumi.mappings.length, 1);
  const missing = await applyPreferenceFeedback({
    dataDir,
    stickerId: 'missing',
    feedbackType: 'negative',
    agentId: 'hanako',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
});
