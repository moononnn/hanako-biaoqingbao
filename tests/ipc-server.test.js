// ipc-server 回归测试：handler 必须收到解析后的 query 对象
// 背景：LocalIpcServer 调 handler 曾只传 body/headers/method/url，不解析 query，
//       导致 /recent-matches?limit=20 里 limit 永远失效（静默走默认值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalIpcServer } from '../lib/ipc-server/index.js';

async function withServer(fn) {
  const ipc = new LocalIpcServer({ port: 0, token: 'test-token' });
  const started = await ipc.start();
  assert.equal(started.ok, true);
  try {
    await fn(ipc);
  } finally {
    await ipc.stop();
  }
}

function get(ipc, pathname) {
  return fetch(`${ipc.url}${pathname}`, {
    headers: { Authorization: `Bearer ${ipc.token}` },
  });
}

test('GET 路由能收到解析后的 query 对象（limit 参数生效）', async () => {
  await withServer(async (ipc) => {
    let seen = null;
    ipc.route('GET', '/recent-matches', ({ query }) => {
      seen = query;
      return { ok: true };
    });
    const res = await get(ipc, '/recent-matches?limit=20');
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { limit: '20' });
  });
});

test('无 query 时 handler 收到空对象', async () => {
  await withServer(async (ipc) => {
    let seen = 'not-called';
    ipc.route('GET', '/recent-matches', ({ query }) => {
      seen = query;
      return { ok: true };
    });
    const res = await get(ipc, '/recent-matches');
    assert.equal(res.status, 200);
    assert.deepEqual(seen, {});
  });
});

test('带 query 的 URL 能匹配到对应路由', async () => {
  await withServer(async (ipc) => {
    let hit = false;
    ipc.route('GET', '/recent-matches', () => {
      hit = true;
      return { ok: true };
    });
    const res = await get(ipc, '/recent-matches?limit=30');
    assert.equal(res.status, 200);
    assert.equal(hit, true);
  });
});

test('多参数与 URL 编码正确解析', async () => {
  await withServer(async (ipc) => {
    let seen = null;
    ipc.route('GET', '/search', ({ query }) => {
      seen = query;
      return { ok: true };
    });
    const q = encodeURIComponent('表情');
    const res = await get(ipc, `/search?q=${q}&page=2`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { q: '表情', page: '2' });
  });
});

test('鉴权失败返回 401 且不执行 handler', async () => {
  await withServer(async (ipc) => {
    let hit = false;
    ipc.route('GET', '/recent-matches', () => {
      hit = true;
      return { ok: true };
    });
    const res = await fetch(`${ipc.url}/recent-matches?limit=20`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.status, 401);
    assert.equal(hit, false);
  });
});
