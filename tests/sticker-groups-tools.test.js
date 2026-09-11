import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('四条选图工具链实际遵守伙伴分组白名单与安全图片读取', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-groups-tools-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    const stickersDir = path.join(dataDir, 'stickers');
    fs.mkdirSync(stickersDir, { recursive: true });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    fs.writeFileSync(path.join(stickersDir, 'allowed.png'), png);
    fs.writeFileSync(path.join(stickersDir, 'legacy.png'), png);
    fs.writeFileSync(path.join(stickersDir, 'blocked.png'), png);
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify([
      { id: 'allowed', file: 'allowed.png', description: '允许开心图', tags: { emotion: ['开心'] }, groupIds: ['allowed-group'] },
      { id: 'legacy', file: 'legacy.png', description: '旧字段开心图', tags: { emotion: ['开心'] }, group_ids: ['allowed-group'] },
      { id: 'blocked', file: 'blocked.png', description: '禁止开心图', tags: { emotion: ['开心'] }, groupIds: ['blocked-group'] },
    ]));
    fs.writeFileSync(path.join(dataDir, 'sticker-groups.json'), JSON.stringify({
      version: 1,
      groups: [
        { id: 'allowed-group', name: '允许' },
        { id: 'blocked-group', name: '禁止' },
      ],
      agents: {
        limited: { configured: true, groupIds: ['allowed-group'], favoriteGroupIds: [], includeUngrouped: false },
      },
    }));
    fs.writeFileSync(path.join(dataDir, 'agent-freq.json'), JSON.stringify({
      version: 2, global_enabled: true, default_daily: 50, default_task: 20,
      agents: { limited: { enabled: true, daily: 50, task: 20 } },
    }));

    const [{ execute: search }, { execute: list }, { execute: peek }, { execute: express }] = await Promise.all([
      import('./tools/search-stickers.js'),
      import('./tools/list-stickers.js'),
      import('./tools/pick-sticker.js'),
      import('./tools/express.js'),
    ]);
    const ctx = {
      agentId: 'limited',
      log: { info() {}, warn() {}, debug() {} },
    };
    const parse = (value) => JSON.parse(value.content[0].text);
    const searchResult = parse(await search({ emotion: '开心' }, ctx));
    const listResult = parse(await list({ emotion: '开心' }, ctx));
    const peekAllowed = parse(await peek({ id: 'allowed' }, ctx));
    const peekBlocked = parse(await peek({ id: 'blocked' }, ctx));
    const expressResult = parse(await express({ emotion: '开心' }, ctx));
    console.log(JSON.stringify({
      searchIds: searchResult.data.map((item) => item.id),
      listIds: listResult.data.map((item) => item.id),
      peekAllowed: peekAllowed.ok,
      peekBlocked: peekBlocked.ok,
      expressAction: expressResult.data?.action,
      expressId: expressResult.data?.sticker?.id,
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
    assert.deepEqual(result.searchIds, ['allowed', 'legacy']);
    assert.deepEqual(result.listIds, ['allowed', 'legacy']);
    assert.equal(result.peekAllowed, true);
    assert.equal(result.peekBlocked, false);
    assert.equal(result.expressAction, 'selected');
    assert.notEqual(result.expressId, 'blocked');
    assert.ok(['allowed', 'legacy'].includes(result.expressId));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
