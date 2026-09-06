import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('自动配图总闸 API：关闭保留伙伴设置，频率旧写入被拒，恢复后可继续保存', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-agent-freq-api-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'agent-freq.json');
    const original = {
      version: 2,
      default_daily: 70,
      default_task: 30,
      agents: { partner: { enabled: false, daily: 15, task: 90 } },
    };
    fs.writeFileSync(file, JSON.stringify(original));

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    await registerRoutes(app, {});
    const context = (body) => ({ req: { json: async () => body } });
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const call = async (method, route, body) => routes[method + ' ' + route](context(body));

    const initial = await (await call('GET', '/api/agent-freq/global')).json();
    const offResponse = await call('POST', '/api/agent-freq/global', { enabled: false });
    const off = await offResponse.json();
    const afterOff = read();

    const blockedResponse = await call('POST', '/api/agent-freq', {
      version: 2,
      default_daily: 1,
      default_task: 2,
      agents: { partner: { enabled: true, daily: 0, task: 0 } },
    });
    const blocked = await blockedResponse.json();
    const unchanged = read();

    const onResponse = await call('POST', '/api/agent-freq/global', { enabled: true });
    const on = await onResponse.json();
    const savedResponse = await call('POST', '/api/agent-freq', {
      version: 2,
      default_daily: 60,
      default_task: 25,
      agents: { partner: { enabled: true, daily: 50, task: 20 } },
    });
    const saved = await savedResponse.json();
    console.log(JSON.stringify({
      initialEnabled: initial.enabled,
      offStatus: offResponse.status,
      offEnabled: off.enabled,
      preserved: JSON.stringify(afterOff.agents) === JSON.stringify(original.agents)
        && afterOff.default_daily === original.default_daily
        && afterOff.default_task === original.default_task,
      blockedStatus: blockedResponse.status,
      blockedOk: blocked.ok,
      unchanged: JSON.stringify(unchanged) === JSON.stringify(afterOff),
      onStatus: onResponse.status,
      onEnabled: on.enabled,
      savedStatus: savedResponse.status,
      savedDaily: saved.data?.agents?.partner?.daily,
      savedGlobal: saved.data?.global_enabled,
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
    assert.equal(result.initialEnabled, true, '旧配置没有总闸字段时默认开启');
    assert.equal(result.offStatus, 200);
    assert.equal(result.offEnabled, false);
    assert.equal(result.preserved, true, '关闭总闸不得改写伙伴配置');
    assert.equal(result.blockedStatus, 409);
    assert.equal(result.blockedOk, false);
    assert.equal(result.unchanged, true, '关闭期间的旧频率写入不得落盘');
    assert.equal(result.onStatus, 200);
    assert.equal(result.onEnabled, true);
    assert.equal(result.savedStatus, 200);
    assert.equal(result.savedDaily, 50);
    assert.equal(result.savedGlobal, true);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
