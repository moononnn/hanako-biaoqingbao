import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLIC_INDEX_SCHEMA_VERSION,
  __cancelScheduledPublicIndex,
  buildPublicIndex,
  collectPreferences,
  collectRecent,
  publicIndexPath,
  writePublicIndex,
} from '../lib/public-index.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-public-index-'));
}

const META = [
  { id: 'stk_a', file: 'a.jpg', tags: { emotion: ['开心'], scene: ['一起玩'], keywords: ['猫'] }, description: '开心的猫', groupIds: ['g1'] },
  { id: 'stk_b', file: 'b.jpg', tags: { emotion: ['委屈'], scene: [], keywords: [] }, description: '委屈的猫', groupIds: ['g2'] },
  { id: 'stk_c', file: 'c.jpg', tags: { emotion: ['无语'], scene: [], keywords: [] }, description: '无语的猫' },
];

const GROUP_STORE = {
  version: 1,
  groups: [{ id: 'g1', name: '甲' }, { id: 'g2', name: '乙' }],
  agents: {
    hanako: { configured: true, groupIds: ['g1'], groupWeights: {}, includeUngrouped: false },
  },
};

test('摊平图库：只带消费方需要的事实，file 带 stickers/ 前缀', () => {
  const index = buildPublicIndex({ meta: META, groupStore: GROUP_STORE });
  assert.equal(index.schemaVersion, PUBLIC_INDEX_SCHEMA_VERSION);
  assert.equal(index.stickerCount, 3);
  assert.deepEqual(index.stickers[0], {
    id: 'stk_a',
    file: 'stickers/a.jpg',
    emotion: ['开心'],
    scene: ['一起玩'],
    keywords: ['猫'],
    description: '开心的猫',
  });
});

test('分组白名单生效：配过白名单的伙伴只拿到白名单组内的图，未分组按 includeUngrouped 算', () => {
  const index = buildPublicIndex({ meta: META, groupStore: GROUP_STORE, agentIds: ['hanako'] });
  assert.equal(index.partners.hanako.configured, true);
  assert.deepEqual(index.partners.hanako.allowed, ['stk_a']);
});

test('未配过白名单的伙伴拿到全集', () => {
  const index = buildPublicIndex({ meta: META, groupStore: GROUP_STORE, agentIds: ['yumi'] });
  assert.equal(index.partners.yumi.configured, false);
  assert.deepEqual(index.partners.yumi.allowed, ['stk_a', 'stk_b', 'stk_c']);
});

test('偏好摊平：否掉的图从偏心里剔除（否决算数）', () => {
  const prefs = {
    version: 1,
    users: {
      yumi: { mappings: [{ preferred_ids: ['stk_a', 'stk_b'], vetoed_ids: ['stk_b'] }] },
    },
  };
  const collected = collectPreferences(prefs);
  assert.deepEqual(collected.yumi.preferred, ['stk_a']);
  assert.deepEqual(collected.yumi.vetoed, ['stk_b']);
});

test('偏好跨多条 mapping 合并，且不在可用集合里的偏爱会被剔除', () => {
  const prefs = {
    version: 1,
    users: {
      hanako: {
        mappings: [
          { preferred_ids: ['stk_a', 'stk_b'], vetoed_ids: [] },
          { preferred_ids: ['stk_a', 'stk_c'], vetoed_ids: ['stk_d'] },
        ],
      },
    },
  };
  const index = buildPublicIndex({ meta: META, groupStore: GROUP_STORE, preferences: prefs, agentIds: ['hanako'] });
  // hanako 只允许 stk_a，所以偏心里只剩 stk_a
  assert.deepEqual(index.partners.hanako.preferred, ['stk_a']);
  assert.deepEqual(index.partners.hanako.vetoed, ['stk_d']);
});

test('最近发送：跨会话合并、按时间倒序、同图去重、按伙伴分组', () => {
  const recent = {
    version: 2,
    bySession: {
      s1: [{ stickerId: 'stk_b', agentId: 'hanako', ts: 100 }],
      s2: [
        { stickerId: 'stk_a', agentId: 'hanako', ts: 300 },
        { stickerId: 'stk_b', agentId: 'hanako', ts: 200 },
      ],
      s3: [{ stickerId: 'stk_c', agentId: 'yumi', ts: 50 }],
    },
  };
  const collected = collectRecent(recent);
  assert.deepEqual(collected.hanako, ['stk_a', 'stk_b']);
  assert.deepEqual(collected.yumi, ['stk_c']);

  const limited = collectRecent(recent, 1);
  assert.deepEqual(limited.hanako, ['stk_a']);
});

test('伙伴清单来自三处数据的并集加上显式传入的 agentIds', () => {
  const index = buildPublicIndex({
    meta: META,
    groupStore: GROUP_STORE,
    preferences: { users: { yumi: { mappings: [] } } },
    recentMatches: { bySession: { s1: [{ stickerId: 'stk_a', agentId: 'feiyue', ts: 1 }] } },
    agentIds: ['hanako'],
  });
  assert.deepEqual(Object.keys(index.partners).sort(), ['feiyue', 'hanako', 'yumi']);
});

test('坏数据不炸：缺字段、非数组、空对象都退化成空结构', () => {
  const index = buildPublicIndex({ meta: null, groupStore: null, preferences: null, recentMatches: null });
  assert.deepEqual(index.stickers, []);
  assert.deepEqual(index.partners, {});
  const messy = buildPublicIndex({
    meta: [{ id: 'x' }, {}, null, { id: 'y', file: 'y.png', tags: 'oops' }, { id: 'z', tags: { emotion: ['开心', '', null] } }],
  });
  assert.deepEqual(messy.stickers.map((s) => s.id), ['x', 'y', 'z']);
  assert.deepEqual(messy.stickers[2].emotion, ['开心']);
});

test('writePublicIndex 落盘，路径为 dataDir/public-index.json', () => {
  const dataDir = tempDir();
  try {
    fs.writeFileSync(path.join(dataDir, 'stickers.json'), JSON.stringify(META), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'sticker-groups.json'), JSON.stringify(GROUP_STORE), 'utf8');
    const index = writePublicIndex({ dataDir, agentIds: ['hanako'] });
    assert.equal(index.stickerCount, 3);
    const file = publicIndexPath(dataDir);
    assert.equal(fs.existsSync(file), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.schemaVersion, PUBLIC_INDEX_SCHEMA_VERSION);
    assert.equal(onDisk.stickers.length, 3);
    assert.deepEqual(onDisk.partners.hanako.allowed, ['stk_a']);
  } finally {
    __cancelScheduledPublicIndex();
  }
});
