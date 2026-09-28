import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHAHUAHUI_USAGE_SCHEMA_VERSION,
  chahuahuiUsagePath,
  readChahuahuiUsage,
  summarizeChahuahuiUsage,
} from '../lib/chahuahui-usage.js';

function tempHana() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-chahuahui-usage-'));
}

test('读取路径遵守 v2 App 的 app-data 契约', () => {
  const hana = tempHana();
  assert.equal(
    chahuahuiUsagePath(hana),
    path.join(hana, 'app-data', 'chahuahui', 'v2', 'sticker-usage.json'),
  );
});

test('可选读取茶话会公开账本，坏文件安静降级', () => {
  const hana = tempHana();
  assert.deepEqual(readChahuahuiUsage({ hanaHome: hana }), []);
  const file = chahuahuiUsagePath(hana);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, events: [{ stickerId: 'stk_1' }] }));
  assert.deepEqual(readChahuahuiUsage({ hanaHome: hana }), []);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: CHAHUAHUI_USAGE_SCHEMA_VERSION,
    events: [
      { stickerId: 'stk_1', partnerId: 'hanako', sentAt: '2026-09-20T08:00:00.000Z' },
      { stickerId: 'stk_1', partnerId: 'hanako', sentAt: '2026-09-20T08:01:00.000Z' },
      { stickerId: 'stk_2', partnerId: 'yumi', sentAt: '2026-09-20T08:02:00.000Z' },
    ],
  }));
  assert.equal(readChahuahuiUsage({ hanaHome: hana }).length, 3);
});

test('按表情包去重展示，保留最新时间和发送次数', () => {
  const summary = summarizeChahuahuiUsage([
    { stickerId: 'stk_1', partnerId: 'hanako', sentAt: '2026-09-20T08:00:00.000Z' },
    { stickerId: 'stk_2', partnerId: 'hanako', sentAt: '2026-09-20T08:02:00.000Z' },
    { stickerId: 'stk_1', partnerId: 'hanako', sentAt: '2026-09-20T08:03:00.000Z' },
  ]);
  assert.deepEqual(summary, [
    { stickerId: 'stk_1', partnerId: 'hanako', lastSentAt: '2026-09-20T08:03:00.000Z', count: 2 },
    { stickerId: 'stk_2', partnerId: 'hanako', lastSentAt: '2026-09-20T08:02:00.000Z', count: 1 },
  ]);
});
