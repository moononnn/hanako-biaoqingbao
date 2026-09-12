import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('分组 API 实链路：创建/重命名、图片归类、伙伴配置和删除清理', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-groups-api-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(path.join(dataDir, 'stickers'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([
      { id: 'a', file: 'a.png', description: '角色', tags: {} },
      { id: 'b', file: 'b.png', description: 'B', tags: {}, group_ids: ['orphan'] },
    ]));

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    await registerRoutes(app, {});
    const request = (body) => ({ req: { json: async () => body } });
    const call = async (method, route, body) => {
      const response = await routes[method + ' ' + route](request(body));
      return { status: response.status, data: await response.json() };
    };

    const created = await call('POST', '/api/groups', { action: 'create', name: '角色', recognitionEnabled: true, recognitionAliases: '鲸鱼娘' });
    if (!created.data.ok) throw new Error(JSON.stringify(created));
    const groupId = created.data.group.id;
    const invalidMembership = await call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: ['missing'] });
    const membership = await call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: [groupId] });
    const renamed = await call('POST', '/api/groups', { action: 'rename', groupId, name: '角色图', migrateNames: true });
    const undone = await call('POST', '/api/groups', { action: 'undo-name-migration', migrationId: renamed.data.migration?.id });
    const concurrent = await Promise.all([
      call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: [groupId] }),
      call('POST', '/api', { action: 'update', id: 'b', description: 'B updated' }),
    ]);
    const concurrentMeta = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    const grouped = await call('GET', '/api/groups');
    const agentSave = await call('POST', '/api/agent-groups', {
      agents: { hanako: { configured: true, groupIds: [groupId], groupWeights: { [groupId]: 3 }, includeUngrouped: false } },
    });
    const agentGet = await call('GET', '/api/agent-groups');
    const deleted = await call('POST', '/api/groups', { action: 'delete', groupId });
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'sticker-groups.json'), 'utf8'));
    console.log(JSON.stringify({
      created: created.data.ok,
      renamed: renamed.data.group?.name,
      aliasPreserved: renamed.data.group?.recognitionAliases?.includes('角色'),
      migrationCount: renamed.data.migration?.count,
      undoRestored: undone.data.data?.restored,
      invalidStatus: invalidMembership.status,
      membershipUpdated: membership.data.updated,
      concurrentGroupPreserved: concurrentMeta[0].groupIds?.includes(groupId),
      concurrentDescriptionPreserved: concurrentMeta[1].description === 'B updated',
      concurrentStatuses: concurrent.map((item) => item.status),
      groupedCount: grouped.data.data.groups[0].stickerCount,
      ungroupedCount: grouped.data.data.ungroupedCount,
      agentSaved: agentSave.data.ok,
      agentConfigured: agentGet.data.data.agents.hanako.configured,
      agentWeight: agentGet.data.data.agents.hanako.groupWeights[groupId] === 3,
      deleted: deleted.data.ok,
      metaHasGroup: meta.some((item) => Array.isArray(item.groupIds) && item.groupIds.includes(groupId)),
      legacyClean: !Object.prototype.hasOwnProperty.call(meta[1], 'group_ids'),
      remainingGroups: store.groups.length,
      remainingAgentGroups: store.agents.hanako.groupIds.length,
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
    assert.equal(result.created, true);
    assert.equal(result.renamed, '角色图');
    assert.equal(result.aliasPreserved, true);
    assert.equal(result.migrationCount, 1);
    assert.equal(result.undoRestored, 1);
    assert.equal(result.invalidStatus, 400);
    assert.equal(result.membershipUpdated, 1);
    assert.equal(result.concurrentGroupPreserved, true);
    assert.equal(result.concurrentDescriptionPreserved, true);
    assert.deepEqual(result.concurrentStatuses, [200, 200]);
    assert.equal(result.groupedCount, 1);
    assert.equal(result.ungroupedCount, 1);
    assert.equal(result.agentSaved, true);
    assert.equal(result.agentConfigured, true);
    assert.equal(result.agentWeight, true);
    assert.equal(result.deleted, true);
    assert.equal(result.metaHasGroup, false);
    assert.equal(result.legacyClean, true);
    assert.equal(result.remainingGroups, 0);
    assert.equal(result.remainingAgentGroups, 0);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
