import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// API 路由会在模块加载时读取 HANA_HOME；用子进程隔离真实插件数据，避免污染并行测试。
test('API v2 搬家导入实链路：按名称映射助手、恢复关联，并与普通 ZIP 入口分流', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-api-migration-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    const stickersDir = path.join(dataDir, 'stickers');
    const agentDir = path.join(home, 'agents', 'new');
    fs.mkdirSync(stickersDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'agent:\n  name: 同一个\n');
    fs.writeFileSync(path.join(agentDir, 'ishiki.md'), '# 人格定义\n');
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'agent-freq.json'), JSON.stringify({
      version: 2,
      global_enabled: false,
      default_daily: 50,
      default_task: 20,
      agents: { new: { enabled: true, daily: 15, task: 90 } },
    }));

    const { writeStoredZip } = await import('./lib/zip-images.js');
    const { hashBuffer } = await import('./lib/sticker-transfer.js');
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 8, 9]);
    const migration = {
      format: 'hana-biaoqingbao',
      version: 1,
      exportedAt: '2026-08-26T01:02:03.000Z',
      agents: [{ id: 'old', name: '同一个' }],
      stickers: [{
        sourceId: 'stk_old',
        hash: hashBuffer(image),
        file: 'stickers/cat.png',
        name: '猫',
        description: '猫',
        tags: { emotion: ['开心'] },
      }],
      data: {
        preferences: {
          version: 1,
          users: {
            old: {
              mappings: [{
                context: { emotion: '开心', keywords: [] },
                preferred_ids: ['stk_old'],
                vetoed_ids: [],
                dislike_counts: {},
                weight: 1,
              }],
            },
          },
        },
        agentFreq: {
          version: 2,
          global_enabled: true,
          default_daily: 90,
          default_task: 10,
          agents: { old: { enabled: false, daily: 0, task: 10 } },
        },
      },
    };
    const zipPath = path.join(home, 'move.zip');
    await writeStoredZip(zipPath, [
      { name: 'manifest.json', data: JSON.stringify({
        format: 'hana-biaoqingbao', formatVersion: 2,
        exportedAt: migration.exportedAt, dataVersion: 1,
      }) },
      { name: 'stickers.json', data: JSON.stringify([{ file: 'stickers/cat.png', name: '猫', description: '猫', tags: { emotion: ['开心'] } }]) },
      { name: 'migration.json', data: JSON.stringify(migration) },
      { name: 'stickers/cat.png', data: image },
    ]);

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    await registerRoutes(app, {});
    const zipBase64 = (await fsp.readFile(zipPath)).toString('base64');
    const call = (body) => routes['POST /api']({ req: { json: async () => body } });

    const migrationResponse = await call({ action: 'import_zip', zipBase64, fileName: 'move.zip', migrationMode: true });
    const migrationResult = await migrationResponse.json();
    if (!migrationResult.ok) throw new Error(JSON.stringify(migrationResult));
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    const preferences = JSON.parse(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'));
    const agentFreq = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-freq.json'), 'utf8'));

    // 同一 v2 ZIP 从图库普通入口导入时只走图片/图库元数据，不偷偷恢复整套设置。
    const ordinaryResponse = await call({ action: 'import_zip', zipBase64, fileName: 'move.zip' });
    const ordinaryResult = await ordinaryResponse.json();
    console.log(JSON.stringify({
      migrationStatus: migrationResponse.status,
      migration: migrationResult.data?.migration,
      imported: migrationResult.data?.imported,
      metadataRestored: migrationResult.data?.metadataRestored,
      importedId: migrationResult.data?.importedIds?.[0],
      mappedAgent: Object.keys(preferences.users || {})[0],
      mappedPreferred: preferences.users?.new?.mappings?.[0]?.preferred_ids?.[0],
      globalEnabled: agentFreq.global_enabled,
      metaCount: meta.length,
      ordinaryStatus: ordinaryResponse.status,
      ordinaryMigration: ordinaryResult.data?.migration,
      ordinarySkippedMigration: ordinaryResult.data?.skippedItems?.some((item) => String(item.reason).includes('数据')),
    }));
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', childCode],
      {
        cwd: process.cwd(),
        env: { ...process.env, HANA_HOME: home },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = child.stdout.trim().split(/\r?\n/).at(-1);
    const result = JSON.parse(output);
    assert.equal(result.migrationStatus, 200);
    assert.equal(result.migration, true);
    assert.equal(result.imported, 1);
    assert.equal(result.metadataRestored, 1);
    assert.equal(result.importedId, 'stk_001');
    assert.equal(result.mappedAgent, 'new');
    assert.equal(result.mappedPreferred, 'stk_001');
    assert.equal(result.globalEnabled, false, '本机已关闭总闸时，迁移包不能把它悄悄重新打开');
    assert.equal(result.metaCount, 1);
    assert.equal(result.ordinaryStatus, 200);
    assert.equal(result.ordinaryMigration, false);
    assert.equal(result.ordinarySkippedMigration, true);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
