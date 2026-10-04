import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 路由与 worker 在子进程里使用隔离图库；setImmediate 只记录，不真正启动识图。
test('全局失败API：同源计数、仅失败重试、并发防重复、坏账本明确报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-failure-api-'));
  const code = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';
    const dir = path.join(process.env.HANA_HOME, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(dir, { recursive: true });
    const meta = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    fs.writeFileSync(path.join(dir, 'stickers.json'), JSON.stringify(meta));
    const store = { order: ['new', 'old'], tasks: {
      new: { id: 'new', created_at: '2026-10-02T01:00:00Z', status: 'completed', total: 2,
        failed: [{ id: 'a', error: '超时' }], completed: ['b'], pending: [], applied: ['b'], results: { b: { ok: true } } },
      old: { id: 'old', created_at: '2026-10-01T01:00:00Z', status: 'completed', total: 3,
        failed: ['a', 'b', 'c', 'deleted'], completed: [], pending: [], applied: [], results: {} },
    } };
    const file = path.join(dir, 'batch-tasks.json');
    fs.writeFileSync(file, JSON.stringify(store));
    let scheduled = 0;
    globalThis.setImmediate = () => { scheduled++; };
    globalThis.fetch = () => { throw new Error('禁止真实模型请求'); };
    const routes = {};
    const app = { get: (p,h) => routes['GET '+p] = h, post: (p,h) => routes['POST '+p] = h, delete: (p,h) => routes['DELETE '+p] = h };
    const { registerBatchTasksRoutes } = await import('./routes/_batch-tasks.js');
    registerBatchTasksRoutes(app, { log: { info() {}, error() {} } });
    const listResp = await routes['GET /api/batch-tasks']({ req: { query: () => '' } });
    const list = await listResp.json();
    const failResp = await routes['GET /api/batch-failures']();
    const failures = await failResp.json();
    const call = ids => routes['POST /api/batch-failures/retry']({ req: { json: async () => ({ sticker_ids: ids }) } });
    const first = await call(['a', 'a', 'b', 'c', 'deleted']);
    const retry = await first.json();
    const duplicate = await call(['a', 'c']);
    const duplicateBody = await duplicate.json();
    const after = await (await routes['GET /api/batch-failures']()).json();
    const saved = JSON.parse(fs.readFileSync(file));
    const queued = saved.tasks[retry.data.taskId];
    fs.writeFileSync(file, '{broken');
    const broken = await routes['GET /api/batch-failures']();
    const brokenBody = await broken.json();
    const brokenRetry = await call(['a']);
    fs.writeFileSync(file, JSON.stringify({ tasks: {} }));
    const malformed = await routes['GET /api/batch-failures']();
    fs.writeFileSync(file, JSON.stringify(saved));
    fs.writeFileSync(path.join(dir, 'stickers.json'), '{broken');
    const badMeta = await routes['GET /api/batch-failures']();
    fs.writeFileSync(path.join(dir, 'stickers.json'), JSON.stringify(meta));
    const { default: registerUi } = await import('./routes/ui.js');
    await registerUi(app, { log: { info() {} } });
    const html = routes['GET /page']({ html: value => value });
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    for (const match of scripts) new Function(match[1]);
    const footerPresent = html.includes('id="batch-failure-actions" hidden') && html.includes('id="batch-retry-all-failures"');
    console.log(JSON.stringify({ list, failures, retry, status: first.status, duplicateStatus: duplicate.status,
      duplicateBody, after, scheduled, queued, oldFailed: saved.tasks.old.failed, brokenStatus: broken.status,
      brokenBody, brokenRetryStatus: brokenRetry.status, malformedStatus: malformed.status, badMetaStatus: badMeta.status, scriptCount: scripts.length, footerPresent }));
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(), env: { ...process.env, HANA_HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(result.list.failures, result.failures.data);
    assert.deepEqual(result.failures.data.items.map(i => i.id), ['a', 'c']);
    assert.equal(result.failures.data.total, 2);
    assert.equal(result.status, 200);
    assert.equal(result.retry.data.total, 2);
    assert.deepEqual(result.queued.pending, ['a', 'c']);
    assert.equal(result.queued.concurrency, 2, '重试沿用模型，采用较低并发避免突发请求');
    assert.equal(result.scheduled, 1, '重复提交不能创建第二个 worker 池');
    assert.equal(result.duplicateStatus, 409);
    assert.equal(result.duplicateBody.ok, false);
    assert.equal(result.after.data.total, 0, '已经在重试的图不再计入失败名单');
    assert.deepEqual(result.oldFailed, ['a', 'b', 'c', 'deleted'], '历史账本不因排队而被擦除');
    assert.equal(result.brokenStatus, 500);
    assert.equal(result.brokenBody.ok, false);
    assert.equal(result.brokenRetryStatus, 500);
    assert.equal(result.malformedStatus, 500);
    assert.equal(result.badMetaStatus, 500);
    assert.ok(result.scriptCount > 0, '实际HTML中必须有可编译的脚本');
    assert.equal(result.footerPresent, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
