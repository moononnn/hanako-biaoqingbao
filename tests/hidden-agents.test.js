import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeHiddenAgents,
  readHiddenAgents,
  writeHiddenAgents,
  hideAgent,
  unhideAgent,
  isAgentHidden,
  filterHiddenAgents,
  HIDDEN_AGENTS_FILE_NAME,
} from '../lib/hidden-agents.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bqb-hidden-'));
}

test('隐藏名单：去重、去空、坏数据当空', () => {
  assert.deepEqual(normalizeHiddenAgents(['a', 'a', ' b ', '', null, undefined, 'b']), ['a', 'b']);
  assert.deepEqual(normalizeHiddenAgents(null), []);
  assert.deepEqual(normalizeHiddenAgents('a'), [], '非数组一律当空名单');
});

test('隐藏名单读写往返', () => {
  const dir = tempDir();
  assert.deepEqual(readHiddenAgents({ dataDir: dir }), [], '没写过就是空');
  writeHiddenAgents(['x', 'y', 'x'], { dataDir: dir });
  assert.deepEqual(readHiddenAgents({ dataDir: dir }), ['x', 'y']);
});

test('隐藏名单文件损坏时不炸，当空名单', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, HIDDEN_AGENTS_FILE_NAME), '{ not json');
  assert.deepEqual(readHiddenAgents({ dataDir: dir }), []);
});

test('hideAgent / unhideAgent 幂等往返', () => {
  const dir = tempDir();
  hideAgent('probe', { dataDir: dir });
  hideAgent('probe', { dataDir: dir });
  assert.deepEqual(readHiddenAgents({ dataDir: dir }), ['probe'], '重复隐藏不产生重复项');
  unhideAgent('probe', { dataDir: dir });
  unhideAgent('probe', { dataDir: dir });
  assert.deepEqual(readHiddenAgents({ dataDir: dir }), [], '重复恢复不报错');
  assert.deepEqual(hideAgent('', { dataDir: dir }), [], '空 id 不动名单');
});

test('列表过滤：隐藏的伙伴不进清单', () => {
  const agents = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c' }];
  assert.deepEqual(filterHiddenAgents(agents, ['b']).map((a) => a.id), ['a', 'c']);
  assert.deepEqual(filterHiddenAgents(agents, []).map((a) => a.id), ['a', 'b', 'c']);
  assert.deepEqual(filterHiddenAgents(null, ['b']), []);
  assert.equal(isAgentHidden('b', ['b']), true);
  assert.equal(isAgentHidden('a', ['b']), false);
  assert.equal(isAgentHidden('', ['b']), false);
});

test('移除伙伴改为真隐藏：接口与界面都接上隐藏名单', () => {
  const root = process.cwd();
  const api = fs.readFileSync(path.join(root, 'routes', 'api.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'routes', 'ui.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'assets', 'sticker-manager.js'), 'utf8');
  // 后端：列表过滤 + 名单回传 + 移除写名单 + 恢复接口
  assert.match(api, /filterHiddenAgents\(agents, hidden\)/);
  assert.match(api, /hidden: agents\.filter\(\(a\) => hiddenSet\.has\(a\.id\)\)/);
  assert.match(api, /hideAgent\(agentId\)/);
  assert.match(api, /app\.post\('\/api\/agents\/unhide'/);
  assert.match(api, /unhideAgent\(agentId\)/);
  assert.doesNotMatch(api, /刷新列表后会重新出现/, '「刷新后重新出现」的旧说明必须清掉');
  // 前端：入口按钮 + 弹窗 + 恢复链路
  assert.match(ui, /id="agent-hidden-btn"/);
  assert.match(ui, /id="agent-hidden-modal"/);
  assert.match(ui, /id="agent-hidden-list"/);
  assert.match(client, /hiddenAgentsData = Array\.isArray\(agentsResult\.hidden\)/);
  assert.match(client, /function syncAgentHiddenEntry\(\)/);
  assert.match(client, /\/api\/agents\/unhide/);
  assert.match(client, /btn\.hidden = count === 0/, '没移除过就不显示入口');
});
