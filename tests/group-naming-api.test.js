// 分组冠名 API 实链路：写入描述、冲突跳过、关掉还原、移出分组自动撤冠名。
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('冠名 API 实链路：开启写入描述、冲突跳过、关掉还原、移出分组自动撤销', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-naming-api-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(path.join(dataDir, 'stickers'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([
      { id: 'a', file: 'a.png', description: '戴着蝴蝶结的胖鱼', tags: { keywords: ['胖鱼'] } },
      { id: 'b', file: 'b.png', description: '', tags: {} },
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
    const readMeta = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    const byId = (list, id) => list.find((item) => item.id === id);

    const g1 = (await call('POST', '/api/groups', { action: 'create', name: '大肥鱼' })).data.group.id;
    const g2 = (await call('POST', '/api/groups', { action: 'create', name: '可爱' })).data.group.id;
    await call('POST', '/api/groups/membership', { stickerIds: ['a', 'b'], addGroupIds: [g1] });

    const on = await call('POST', '/api/groups', { action: 'set-naming', groupId: g1, enabled: true });
    const metaOn = readMeta();
    const storeOn = JSON.parse(fs.readFileSync(path.join(dataDir, 'sticker-groups.json'), 'utf8'));

    await call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: [g2] });
    const conflict = await call('POST', '/api/groups', { action: 'set-naming', groupId: g2, enabled: true });
    const metaConflict = readMeta();

    const off = await call('POST', '/api/groups', { action: 'set-naming', groupId: g1, enabled: false });
    const metaOff = readMeta();

    // 移出分组：先重新开 g1 冠名，再把 a 移出 g1
    await call('POST', '/api/groups', { action: 'set-naming', groupId: g1, enabled: true });
    const beforeRemove = readMeta();
    await call('POST', '/api/groups/membership', { stickerIds: ['a'], addGroupIds: [], removeGroupIds: [g1] });
    const afterRemove = readMeta();

    console.log(JSON.stringify({
      onOk: on.data.ok,
      onUpdated: on.data.naming?.updated,
      descA: byId(metaOn, 'a').description,
      descB: byId(metaOn, 'b').description,
      namingId: byId(metaOn, 'a').namingGroupId,
      namingBase: byId(metaOn, 'a').namingBaseDescription,
      flagOn: storeOn.groups.find((g) => g.id === g1).namingEnabled,
      conflictUpdated: conflict.data.naming?.updated,
      conflictSkipped: conflict.data.naming?.skipped,
      descAAfterConflict: byId(metaConflict, 'a').description,
      ownerAfterConflict: byId(metaConflict, 'a').namingGroupId,
      offUpdated: off.data.naming?.updated,
      descARestored: byId(metaOff, 'a').description,
      ownerCleared: byId(metaOff, 'a').namingGroupId === undefined,
      baseCleared: byId(metaOff, 'a').namingBaseDescription === undefined,
      descBeforeRemove: byId(beforeRemove, 'a').description,
      descAfterRemove: byId(afterRemove, 'a').description,
      ownerAfterRemove: byId(afterRemove, 'a').namingGroupId === undefined,
      stillInG2: Array.isArray(byId(afterRemove, 'a').groupIds) && byId(afterRemove, 'a').groupIds.includes(g2),
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: process.cwd(),
    env: { ...process.env, HANA_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout.trim().split('\n').pop());

  assert.equal(out.onOk, true);
  assert.equal(out.onUpdated, 2);
  assert.equal(out.descA, '大肥鱼，戴着蝴蝶结的胖鱼');
  assert.equal(out.descB, '大肥鱼');
  assert.equal(out.namingId, out.namingId);
  assert.ok(out.namingId);
  assert.equal(out.namingBase, '戴着蝴蝶结的胖鱼');
  assert.equal(out.flagOn, true);

  // 冲突：a 已被「大肥鱼」冠名，「可爱」组不该覆盖
  assert.equal(out.conflictUpdated, 0);
  assert.equal(out.conflictSkipped, 1);
  assert.equal(out.descAAfterConflict, '大肥鱼，戴着蝴蝶结的胖鱼');
  assert.equal(out.ownerAfterConflict, out.namingId);

  // 关掉冠名：描述还原、字段清干净
  assert.equal(out.offUpdated, 2);
  assert.equal(out.descARestored, '戴着蝴蝶结的胖鱼');
  assert.equal(out.ownerCleared, true);
  assert.equal(out.baseCleared, true);

  // 移出分组：描述里的名字跟着撤掉，但图片仍留在另一个组
  assert.equal(out.descBeforeRemove, '大肥鱼，戴着蝴蝶结的胖鱼');
  assert.equal(out.descAfterRemove, '戴着蝴蝶结的胖鱼');
  assert.equal(out.ownerAfterRemove, true);
  assert.equal(out.stillInG2, true);
});
