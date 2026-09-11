import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('分组真实烟测：伙伴选图白名单、分组导出/导入、全量替换和总闸保护', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-groups-smoke-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    const stickersDir = path.join(dataDir, 'stickers');
    fs.mkdirSync(stickersDir, { recursive: true });
    fs.mkdirSync(path.join(home, 'agents', 'hanako'), { recursive: true });
    fs.writeFileSync(path.join(home, 'agents', 'hanako', 'config.yaml'), 'agent:\n  name: 测试伙伴\n');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    fs.writeFileSync(path.join(stickersDir, 'a.png'), png);
    fs.writeFileSync(path.join(stickersDir, 'b.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]));
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([
      { id: 'a', file: 'a.png', description: '开心图', tags: { emotion: ['开心'] } },
      { id: 'b', file: 'b.png', description: '失效归属图', tags: {}, group_ids: ['orphan'] },
    ]));

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    const ctx = {
      bus: { request: async () => JSON.stringify({ should_use: true, emotion: '开心', keywords: [], intensity: 'light', reason: '测试' }) },
      log: { info() {}, warn() {}, error() {} },
    };
    await registerRoutes(app, ctx);
    const request = (body) => ({ req: { json: async () => body } });
    const call = async (method, route, body) => {
      const response = await routes[method + ' ' + route](request(body));
      return { status: response.status, data: await response.json() };
    };

    const created = await call('POST', '/api/groups', { action: 'create', name: '角色图' });
    const groupId = created.data.group.id;
    const membership = await call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: [groupId] });
    const agentSave = await call('POST', '/api/agent-groups', {
      agents: { hanako: { configured: true, groupIds: [groupId], favoriteGroupIds: [groupId], includeUngrouped: false } },
    });
    const smart = await call('POST', '/api/smart-pick', { context: '请选一张开心图', agentId: 'hanako' });
    const exported = await call('POST', '/api', {
      action: 'export_zip',
      outputDir: path.join(home, 'exports'),
      dataGroups: ['groups'],
      groupFilter: { mode: 'groups', groupIds: [groupId], includeUngrouped: false },
    });
    const zipBase64 = fs.readFileSync(exported.data.data.outputPath).toString('base64');
    const deletedGroup = await call('POST', '/api/groups', { action: 'delete', groupId });
    const imported = await call('POST', '/api', {
      action: 'import_zip', zipBase64, fileName: 'groups.zip', migrationMode: true,
    });
    const restored = await call('GET', '/api/groups');

    const replaced = await call('POST', '/api/agent-groups', {
      agents: { other: { configured: true, groupIds: [groupId], favoriteGroupIds: [], includeUngrouped: false } },
    });
    const afterReplace = await call('GET', '/api/agent-groups');
    const restoredAgent = await call('POST', '/api/agent-groups', {
      agents: { hanako: { configured: true, groupIds: [groupId], favoriteGroupIds: [groupId], includeUngrouped: false } },
    });
    fs.writeFileSync(path.join(dataDir, 'agent-freq.json'), JSON.stringify({ version: 2, global_enabled: false, agents: {} }));
    const blockedSave = await call('POST', '/api/agent-groups', { agents: {} });
    const blockedSmart = await call('POST', '/api/smart-pick', { context: '请选一张开心图', agentId: 'hanako' });
    const blockedImport = await call('POST', '/api', {
      action: 'import_zip', zipBase64, fileName: 'groups.zip', migrationMode: true,
    });
    const blockedRemove = await call('POST', '/api/agents/remove', { agentId: 'hanako' });
    fs.writeFileSync(path.join(dataDir, 'agent-freq.json'), JSON.stringify({ version: 2, global_enabled: true, agents: {} }));
    const removed = await call('POST', '/api/agents/remove', { agentId: 'hanako' });
    const finalStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'sticker-groups.json'), 'utf8'));
    console.log(JSON.stringify({
      created: created.data.ok,
      membership: membership.data.updated,
      agentSave: agentSave.data.ok,
      smartId: smart.data.data?.sticker?.id,
      exportOk: exported.data.ok,
      deletedGroup: deletedGroup.data.ok,
      imported: imported.data.ok,
      restoredCount: restored.data.data.groups[0].stickerCount,
      restoredAgent: restoredAgent.data.ok,
      replaced: replaced.data.ok,
      omittedAgentRemoved: !Object.prototype.hasOwnProperty.call(afterReplace.data.data.agents, 'hanako'),
      blockedSaveStatus: blockedSave.status,
      blockedSmartStatus: blockedSmart.status,
      blockedImportStatus: blockedImport.status,
      blockedRemoveStatus: blockedRemove.status,
      removed: removed.data.ok,
      finalAgentRemoved: !Object.prototype.hasOwnProperty.call(finalStore.agents, 'hanako'),
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
        timeout: 60000,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const output = child.stdout.trim().split(/\r?\n/).at(-1);
    const result = JSON.parse(output);
    assert.equal(result.created, true);
    assert.equal(result.membership, 1);
    assert.equal(result.agentSave, true);
    assert.equal(result.smartId, 'a');
    assert.equal(result.exportOk, true);
    assert.equal(result.deletedGroup, true);
    assert.equal(result.imported, true);
    assert.equal(result.restoredCount, 1);
    assert.equal(result.restoredAgent, true);
    assert.equal(result.replaced, true);
    assert.equal(result.omittedAgentRemoved, true);
    assert.equal(result.blockedSaveStatus, 409);
    assert.equal(result.blockedSmartStatus, 409, '总闸关闭时旧 smart-pick 也不得返回发图结果');
    assert.equal(result.blockedImportStatus, 409, '总闸关闭时搬家包不得绕过伙伴配置保护');
    assert.equal(result.blockedRemoveStatus, 200, '总闸关闭时仍应允许清理伙伴残留配置');
    assert.equal(result.removed, true);
    assert.equal(result.finalAgentRemoved, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
