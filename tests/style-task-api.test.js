// tests/style-task-api.test.js - 学我说话任务恢复 API 契约
// 覆盖：确认状态不丢失、最新失败任务可被页面识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('GET /api/style-template：保留 confirmed，并返回最新失败状态', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-style-api-'));
  const childCode = String.raw`
    import fs from 'node:fs';
    import path from 'node:path';

    const home = process.env.HANA_HOME;
    const dataDir = path.join(home, 'plugin-data', 'biaoqingbao');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'style-template.json'), JSON.stringify({
      version: 1, current: '', history: [], source_agents: [], excluded_agents: [],
    }));
    fs.writeFileSync(path.join(dataDir, 'style-tasks.json'), JSON.stringify([
      {
        id: 'old-confirmed', status: 'completed', confirmed: true, level: 'deep', agent_id: 'all',
        phase: 'drafting', total_messages: 10, sampled_count: 10, draft: '旧模板',
        created_at: '2026-08-26T08:00:00.000Z', updated_at: '2026-08-26T08:01:00.000Z', error: null,
      },
      {
        id: 'new-failed', status: 'failed', confirmed: false, level: 'deep', agent_id: 'all',
        phase: 'merging', total_messages: 20, sampled_count: 20, draft: '',
        created_at: '2026-08-26T09:00:00.000Z', updated_at: '2026-08-26T09:01:00.000Z', error: '模型未回复正文',
      },
    ]));

    const { default: registerRoutes } = await import('./routes/api.js');
    const routes = {};
    const app = {
      get: (route, handler) => { routes['GET ' + route] = handler; },
      post: (route, handler) => { routes['POST ' + route] = handler; },
      delete: (route, handler) => { routes['DELETE ' + route] = handler; },
    };
    await registerRoutes(app, {});
    const response = routes['GET /api/style-template']({ req: {} });
    const payload = await response.json();
    console.log(JSON.stringify({
      state: payload.data.task_state,
      tasks: payload.data.tasks.map((task) => ({ id: task.id, confirmed: task.confirmed })),
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
    assert.deepEqual(result.state, {
      status: 'failed', task_id: 'new-failed', draft_task_id: '', error: '模型未回复正文',
    });
    assert.deepEqual(result.tasks, [
      { id: 'new-failed', confirmed: false },
      { id: 'old-confirmed', confirmed: true },
    ]);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
