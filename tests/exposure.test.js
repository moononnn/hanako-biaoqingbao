import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXPOSURE_VERSION,
  FRESH_WINDOW_MS,
  explorationInfo,
  getExposureRecord,
  readExposureStats,
  recordSuccessfulExposure,
  rerankWithExploration,
} from '../lib/exposure.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-exposure-'));
}

const NOW = Date.parse('2026-08-24T00:00:00.000Z');

function sticker(id, addedAt) {
  return { id, added_at: addedAt, tags: { emotion: ['开心'] }, description: '开心图' };
}

test('探索加成优先级：新图高于未曝光旧图，已曝光图会衰减', () => {
  const fresh = explorationInfo(sticker('fresh', '2026-08-23T23:00:00.000Z'), null, NOW);
  const unseenOld = explorationInfo(sticker('old', '2026-07-01T00:00:00.000Z'), null, NOW);
  const exposedFresh = explorationInfo(sticker('seen', '2026-08-23T23:00:00.000Z'), { exposureCount: 3 }, NOW);

  assert.equal(fresh.kind, 'fresh');
  assert.ok(fresh.bonus > unseenOld.bonus, '刚收录的新图应高于未曝光旧图');
  assert.equal(unseenOld.kind, 'unseen');
  assert.equal(unseenOld.bonus, 1);
  assert.ok(exposedFresh.bonus < fresh.bonus, '成功曝光后新图加成应下降');
});

test('探索重排只在固定探索机会触发，且语义接近时新图优先', () => {
  const stickers = [
    sticker('old', '2026-07-01T00:00:00.000Z'),
    sticker('fresh', '2026-08-23T23:00:00.000Z'),
    sticker('ordinary', '2026-08-01T00:00:00.000Z'),
  ];
  const scored = [
    { ...stickers[0], _score: 10 },
    { ...stickers[1], _score: 9.2 },
    { ...stickers[2], _score: 8 },
  ];
  const stats = { version: 1, byAgent: { hanako: { ordinary: { exposureCount: 4 } } } };

  const explored = rerankWithExploration(scored, stickers, {
    stats,
    agentId: 'hanako',
    random: () => 0,
    now: NOW,
  });
  assert.equal(explored.explored, true);
  assert.equal(explored.scored[0].id, 'fresh');

  const normal = rerankWithExploration(scored, stickers, {
    stats,
    agentId: 'hanako',
    random: () => 0.99,
    now: NOW,
  });
  assert.equal(normal.explored, false);
  assert.equal(normal.scored[0].id, 'old');
});

test('曝光账本按助手隔离并在成功送达后累加', async () => {
  const dataDir = tempDir();
  const first = await recordSuccessfulExposure({ dataDir, agentId: 'hanako', stickerId: 'stk_001', now: NOW });
  assert.equal(first.ok, true);
  await recordSuccessfulExposure({ dataDir, agentId: 'hanako', stickerId: 'stk_001', now: NOW + 1000 });
  await recordSuccessfulExposure({ dataDir, agentId: 'yumi', stickerId: 'stk_001', now: NOW + 2000 });
  const stats = readExposureStats({ dataDir });
  assert.equal(getExposureRecord(stats, 'hanako', 'stk_001').exposureCount, 2);
  assert.equal(getExposureRecord(stats, 'yumi', 'stk_001').exposureCount, 1);
  assert.equal(getExposureRecord(stats, 'hanako', 'missing'), null);
});

test('首次读取曝光账本会迁移历史，并跨 decision-log/recent-match 去重', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'decision-log.json'), JSON.stringify({ entries: [
    { type: 'express', decision: 'accepted', agent: 'hanako', sticker_id: 'stk_001', session_id: 'sess_001', ts: '2026-08-20T00:00:00.000Z' },
    { type: 'express', decision: 'accepted', agent: 'hanako', sticker_id: 'stk_001', session_id: 'sess_002', ts: '2026-08-21T00:00:00.000Z' },
    { type: 'express', decision: 'rejected', agent: 'hanako', sticker_id: 'stk_002', ts: '2026-08-21T00:00:00.000Z' },
  ] }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'recent-match.json'), JSON.stringify({ version: 2, bySession: {
    sess_001: [{ agentId: 'hanako', stickerId: 'stk_001', ts: Date.parse('2026-08-20T00:00:00.040Z') }],
    sess_003: [{ agentId: 'hanako', stickerId: 'stk_003', ts: Date.parse('2026-08-22T00:00:00.000Z') }],
  } }), 'utf8');

  const stats = readExposureStats({ dataDir });
  assert.equal(stats.version, EXPOSURE_VERSION);
  assert.equal(getExposureRecord(stats, 'hanako', 'stk_001').exposureCount, 2, '同一事件的 recent 记录不能再加一遍');
  assert.equal(getExposureRecord(stats, 'hanako', 'stk_003').exposureCount, 1, '没有对应 decision 的 recent 记录要保留');
  assert.equal(getExposureRecord(stats, 'hanako', 'stk_002'), null);
  assert.ok(fs.existsSync(path.join(dataDir, 'exposure-stats.json')));
  assert.equal(FRESH_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('旧版 v1 曝光账本会扣除历史双计数且只修复一次', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'decision-log.json'), JSON.stringify({ entries: [
    { type: 'express', decision: 'accepted', agent: 'hanako', sticker_id: 'stk_001', session_id: 'sess_001', ts: '2026-08-20T00:00:00.000Z' },
  ] }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'recent-match.json'), JSON.stringify({ version: 2, bySession: {
    sess_001: [{ agentId: 'hanako', stickerId: 'stk_001', ts: Date.parse('2026-08-20T00:00:00.050Z') }],
  } }), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'exposure-stats.json'), JSON.stringify({ version: 1, byAgent: {
    hanako: { stk_001: { exposureCount: 3, firstExposedAt: '2026-08-20T00:00:00.000Z', lastExposedAt: '2026-08-20T00:00:00.050Z' } },
  } }), 'utf8');

  const repaired = readExposureStats({ dataDir });
  assert.equal(repaired.version, EXPOSURE_VERSION);
  assert.equal(getExposureRecord(repaired, 'hanako', 'stk_001').exposureCount, 2);
  const again = readExposureStats({ dataDir });
  assert.equal(getExposureRecord(again, 'hanako', 'stk_001').exposureCount, 2, '修复不能每次读取都重复扣减');
});
