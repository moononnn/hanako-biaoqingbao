import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordRecentMatch,
  readRecentMatchForPath,
  readRecentMatches,
  readRecentRecord,
  removeStickerRecentMatches,
  updateRecentFeedback,
} from '../lib/recent-match.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-recent-'));
}

function sessionFile(root, id, sessionId) {
  const file = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ sessionId, type: 'session' }) + '\n', 'utf8');
  return file;
}

test('最近配图按 session 隔离，覆盖时只保留该会话最后一张', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const firstPath = sessionFile(root, 'first', 'sess_first');
  const secondPath = sessionFile(root, 'second', 'sess_second');

  await recordRecentMatch({
    dataDir,
    ctx: { sessionPath: firstPath },
    stickerId: 'stk_001',
    description: '第一张',
    emotion: '开心',
    agentId: 'hanako',
    delivery: 'deferred',
  });
  await recordRecentMatch({
    dataDir,
    ctx: { sessionPath: firstPath },
    stickerId: 'stk_002',
    description: '第二张',
    emotion: '得意',
    agentId: 'hanako',
    delivery: 'media',
  });
  await recordRecentMatch({
    dataDir,
    ctx: { sessionPath: secondPath },
    stickerId: 'stk_003',
    description: '另一段对话',
    emotion: '安慰',
    agentId: 'yumi',
    delivery: 'card',
  });

  const first = readRecentMatchForPath({ dataDir, sessionPath: firstPath });
  const second = readRecentMatchForPath({ dataDir, sessionPath: secondPath });
  assert.equal(first.sessionId, 'sess_first');
  assert.equal(first.match.stickerId, 'stk_002');
  assert.equal(second.match.stickerId, 'stk_003');
  assert.equal(readRecentRecord({ dataDir, sessionId: 'missing' }).length, 0);
});

test('删除图片时清理所有会话里的最近配图记录', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const firstPath = sessionFile(root, 'one', 'sess_first');
  const secondPath = sessionFile(root, 'two', 'sess_second');
  await recordRecentMatch({ dataDir, ctx: { sessionPath: firstPath }, stickerId: 'stk_delete', description: '待删', emotion: '开心' });
  await recordRecentMatch({ dataDir, ctx: { sessionPath: secondPath }, stickerId: 'stk_delete', description: '待删', emotion: '无语' });
  await recordRecentMatch({ dataDir, ctx: { sessionPath: secondPath }, stickerId: 'stk_keep', description: '保留', emotion: '开心' });

  const result = await removeStickerRecentMatches({ dataDir, stickerId: 'stk_delete' });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.equal(readRecentRecord({ dataDir, sessionId: 'sess_first' }).length, 0);
  assert.deepEqual(readRecentRecord({ dataDir, sessionId: 'sess_second' }).map((item) => item.stickerId), ['stk_keep']);
});

test('最近配图记录只公开允许字段，不写绝对路径，反馈状态可更新', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const sessionPath = sessionFile(root, 'one', 'sess_one');
  await recordRecentMatch({
    dataDir,
    ctx: { sessionId: 'sess_one', sessionPath },
    stickerId: 'stk_001',
    description: '一张图',
    emotion: '开心',
    agentId: 'hanako',
    delivery: 'deferred',
  });
  const base = {
    hadMapping: false,
    mappingIndex: 0,
    emotion: '开心',
    contextKeywords: [],
    preferred: false,
    vetoed: false,
    dislikeCount: 0,
    weight: 1,
  };
  const current = readRecentRecord({ dataDir, sessionId: 'sess_one' });
  assert.ok(Array.isArray(current), 'readRecentRecord 返回数组');
  const stale = await updateRecentFeedback({
    dataDir,
    sessionId: 'sess_one',
    stickerId: 'stk_001',
    feedback: 'negative',
    feedbackBase: base,
    expectedTs: current[0].ts + 1,
    expectedFeedback: null,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 404);

  const updated = await updateRecentFeedback({
    dataDir,
    sessionId: 'sess_one',
    stickerId: 'stk_001',
    feedback: 'negative',
    feedbackBase: base,
    expectedTs: current[0].ts,
    expectedFeedback: null,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.match.feedback, 'negative');
  const positive = await updateRecentFeedback({
    dataDir,
    sessionId: 'sess_one',
    stickerId: 'stk_001',
    feedback: 'positive',
    feedbackKind: 'context',
    feedbackBase: { preference: null, context: { hadEntry: false, count: 0, contextEmotion: '开心', stickerId: 'stk_001' } },
    expectedTs: current[0].ts,
    expectedFeedback: 'negative',
  });
  assert.equal(positive.ok, true);
  assert.equal(positive.match.feedback, 'positive');
  assert.equal(positive.match.feedbackKind, 'context');
  const raw = fs.readFileSync(path.join(dataDir, 'recent-match.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readRecentRecord({ dataDir, sessionId: 'sess_one' })[0].feedback, 'positive');
  assert.equal(readRecentRecord({ dataDir, sessionId: 'sess_one' })[0].feedbackKind, 'context');
});

test('配图手帐：每会话保留多条记录，readRecentMatches 按时间倒序返回', async () => {
  const dataDir = tempDir();
  const root = tempDir();
  const firstPath = sessionFile(root, 'one', 'sess_first');
  const secondPath = sessionFile(root, 'two', 'sess_two');
  // 同一会话配两张 + 另一会话配一张
  await recordRecentMatch({ dataDir, ctx: { sessionPath: firstPath }, stickerId: 'stk_001', description: '第一张', emotion: '开心', agentId: 'hanako', delivery: 'deferred', ts: 1000 });
  await recordRecentMatch({ dataDir, ctx: { sessionPath: firstPath }, stickerId: 'stk_002', description: '第二张', emotion: '得意', agentId: 'hanako', delivery: 'deferred', ts: 3000 });
  await recordRecentMatch({ dataDir, ctx: { sessionPath: secondPath }, stickerId: 'stk_003', description: '另一对话', emotion: '安慰', agentId: 'yumi', delivery: 'card', ts: 2000 });

  const records = readRecentRecord({ dataDir, sessionId: 'sess_first' });
  assert.equal(records.length, 2, '同会话应保留两条');
  assert.equal(records[0].stickerId, 'stk_002', '新的在前');
  assert.equal(records[1].stickerId, 'stk_001');

  const matches = readRecentMatches({ dataDir, limit: 10 });
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((m) => m.stickerId), ['stk_002', 'stk_003', 'stk_001'], '按 ts 倒序');
  assert.equal(matches[0].sessionId, 'sess_first');
  assert.equal(matches[1].sessionId, 'sess_two');
  // 最近配图仍是最新一条
  assert.equal(readRecentMatchForPath({ dataDir, sessionPath: firstPath }).match.stickerId, 'stk_002');
});
