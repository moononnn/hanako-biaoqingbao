import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateDataDir } from '../lib/shared.js';

// ── 迁移测试：migrateDataDir 是纯函数，路径全部注入临时目录，绝不碰真实数据 ──
const tempDirs = [];
function useTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-migrate-'));
  const home = path.join(root, 'hanako-home');
  const pluginRoot = path.join(root, 'plugin-root');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  tempDirs.push(root);
  return {
    // 新位置（Hana 官方数据目录）
    dataDir: path.join(home, 'plugin-data', 'biaoqingbao'),
    stickersDir: path.join(home, 'plugin-data', 'biaoqingbao', 'stickers'),
    // 旧位置（插件目录内）
    legacyDataDir: path.join(pluginRoot, 'data'),
    legacyStickersDir: path.join(pluginRoot, 'stickers'),
    // Hana 安装备份
    backupRoot: path.join(home, 'plugin-backups', 'biaoqingbao'),
  };
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function writeFakeData(dir, metaCount = 3) {
  const meta = [];
  fs.mkdirSync(path.join(dir, 'stickers'), { recursive: true });
  for (let i = 1; i <= metaCount; i++) {
    const id = 'stk_' + String(i).padStart(3, '0');
    meta.push({ id, file: id + '.png', description: '测试图' + i, tags: { emotion: [], scene: [], keywords: [] } });
    fs.writeFileSync(path.join(dir, 'stickers', id + '.png'), 'fake-png-' + i);
  }
  fs.writeFileSync(path.join(dir, 'stickers.json'), JSON.stringify(meta), 'utf-8');
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ version: 1 }), 'utf-8');
}

// 模拟 Hana 安装备份：备份 = 旧插件目录的完整快照（data/ 与 stickers/ 平级）
function writeFakeBackup(backupDir, metaCount) {
  const bData = path.join(backupDir, 'data');
  writeFakeData(bData, metaCount);
  const bStickers = path.join(backupDir, 'stickers');
  fs.mkdirSync(bStickers, { recursive: true });
  for (let i = 1; i <= metaCount; i++) {
    const id = 'stk_' + String(i).padStart(3, '0');
    fs.copyFileSync(path.join(bData, 'stickers', id + '.png'), path.join(bStickers, id + '.png'));
  }
}

test('迁移：全新环境只创建目录，返回 fresh', () => {
  const t = useTempDirs();
  const res = migrateDataDir(t);
  assert.equal(res.ok, true);
  assert.equal(res.source, 'fresh');
  assert.ok(fs.existsSync(path.join(t.dataDir, 'stickers')), '应创建 stickers 目录');
});

test('迁移：新位置已有数据时不动，返回 existing', () => {
  const t = useTempDirs();
  writeFakeData(t.dataDir, 5);
  const res = migrateDataDir(t);
  assert.equal(res.source, 'existing');
  const meta = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'stickers.json'), 'utf-8'));
  assert.equal(meta.length, 5, '已有数据不应被覆盖');
});

test('迁移：插件目录旧位置有数据 → 复制到新位置', () => {
  const t = useTempDirs();
  writeFakeData(t.legacyDataDir, 3);
  const res = migrateDataDir(t);
  assert.equal(res.source, 'legacy-plugin-dir');
  const meta = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'stickers.json'), 'utf-8'));
  assert.equal(meta.length, 3);
  assert.ok(fs.existsSync(path.join(t.dataDir, 'stickers', 'stk_003.png')), '图片文件应复制');
  assert.ok(fs.existsSync(path.join(t.dataDir, 'preferences.json')), '数据文件应复制');
  // 旧位置保留（不删用户数据）
  assert.ok(fs.existsSync(path.join(t.legacyDataDir, 'stickers.json')), '旧位置应保留');
});

test('迁移：安装备份里有旧数据 → 从最新备份恢复', () => {
  const t = useTempDirs();
  // 构造两个备份（模拟多次更新），最新的是 02
  writeFakeBackup(path.join(t.backupRoot, '2026-08-04T10-00-00-000Z-v0-25-0'), 2);
  writeFakeBackup(path.join(t.backupRoot, '2026-08-04T11-00-00-000Z-v0-26-0'), 4);
  const res = migrateDataDir(t);
  assert.equal(res.ok, true);
  assert.ok(res.source.includes('install-backup'), '应从备份恢复，实际: ' + res.source);
  const meta = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'stickers.json'), 'utf-8'));
  assert.equal(meta.length, 4, '应取最新备份（4 张）');
  assert.ok(fs.existsSync(path.join(t.stickersDir, 'stk_004.png')), '图片文件也应恢复');
  assert.ok(fs.existsSync(path.join(t.dataDir, 'preferences.json')), '数据文件应恢复');
});

test('迁移：备份里没有 stickers.json 的目录跳过（旧版结构或无数据）', () => {
  const t = useTempDirs();
  // 空备份目录（旧版插件目录没有 data 子目录的备份）
  fs.mkdirSync(path.join(t.backupRoot, '2026-08-04T10-00-00-000Z-v0-23-0'), { recursive: true });
  const res = migrateDataDir(t);
  assert.equal(res.source, 'fresh', '无效备份应跳过，按全新处理');
});

test('迁移：备份恢复后再次调用幂等（不重复覆盖）', () => {
  const t = useTempDirs();
  writeFakeBackup(path.join(t.backupRoot, '2026-08-04T11-00-00-000Z-v0-26-0'), 4);
  const res1 = migrateDataDir(t);
  assert.equal(res1.source.includes('install-backup'), true);
  // 用户在新位置又加了图
  const meta = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'stickers.json'), 'utf-8'));
  meta.push({ id: 'stk_999', file: 'stk_999.png', description: '新加的', tags: { emotion: [], scene: [], keywords: [] } });
  fs.writeFileSync(path.join(t.dataDir, 'stickers.json'), JSON.stringify(meta), 'utf-8');
  // 再次迁移：新位置已有数据，不动
  const res2 = migrateDataDir(t);
  assert.equal(res2.source, 'existing', '恢复后不应重复覆盖');
  const meta2 = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'stickers.json'), 'utf-8'));
  assert.equal(meta2.length, 5, '用户新加的数据应保留');
});
