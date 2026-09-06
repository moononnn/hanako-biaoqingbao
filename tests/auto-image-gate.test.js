import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('自动配图关闭时 observer 不请求情绪模型，express 不读取图库也不发图', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-auto-image-gate-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'agent-freq.json'), JSON.stringify({
      version: 2,
      global_enabled: false,
      default_daily: 70,
      default_task: 30,
      agents: { partner: { enabled: true, daily: 90, task: 90 } },
    }));

    const observerModule = await import('./extensions/observer.js');
    const handlers = {};
    observerModule.default({ on(type, handler) { handlers[type] = handler; } });
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('should not fetch'); };
    const event = { messages: [{ role: 'user', content: '我今天心情很好' }] };
    const before = JSON.stringify(event.messages);
    await handlers.context(event, { agentId: 'partner' });

    const expressModule = await import('./tools/express.js');
    const expressResult = await expressModule.execute(
      { emotion: '开心' },
      { agentId: 'partner', log: { info() {} } },
    );
    const expressPayload = JSON.parse(expressResult.content[0].text);
    console.log(JSON.stringify({
      messagesUnchanged: JSON.stringify(event.messages) === before,
      fetchCalls,
      expressOk: expressPayload.ok,
      expressError: expressPayload.error,
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
    assert.equal(result.messagesUnchanged, true);
    assert.equal(result.fetchCalls, 0, '关闭总闸时 observer 不得请求情绪模型');
    assert.equal(result.expressOk, false);
    assert.match(result.expressError, /自动配图已关闭/);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
