// 总冠名（分组命名）：把组名写进组内图片描述开头，供识图教学名单学习叫法。
// 覆盖：写入 / 幂等 / 冲突跳过 / 非组内不动 / 撤销 / 改名同步 / 截断 / 标记持久化。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NAMING_DESCRIPTION_LENGTH,
  applyGroupNaming,
  clearGroupNaming,
  createGroup,
  emptyGroupStore,
  isGroupNamingEnabled,
  normalizeGroupStore,
  planGroupNaming,
  renameGroupNaming,
  revertGroupNaming,
} from '../lib/sticker-groups.js';

function makeStore() {
  let store = emptyGroupStore();
  const whale = createGroup(store, '鲸鱼娘');
  store = whale.store;
  const cute = createGroup(store, '可爱');
  store = cute.store;
  return { store, whale: whale.group.id, cute: cute.group.id };
}

test('冠名把组名写在描述开头，并记录原描述', () => {
  const { store, whale } = makeStore();
  const stickers = [
    { id: 's1', description: '戴着蝴蝶结的胖鱼', groupIds: [whale] },
    { id: 's2', description: '', groupIds: [whale] },
  ];
  const result = applyGroupNaming(stickers, store, whale, '大肥鱼');
  assert.equal(result.updated, 2);
  assert.equal(stickers[0].description, '大肥鱼，戴着蝴蝶结的胖鱼');
  assert.equal(stickers[1].description, '大肥鱼');
  assert.equal(stickers[0].namingGroupId, whale);
  assert.equal(stickers[0].namingBaseDescription, '戴着蝴蝶结的胖鱼');
});

test('重复冠名是幂等的，不会叠加前缀', () => {
  const { store, whale } = makeStore();
  const stickers = [{ id: 's1', description: '胖鱼', groupIds: [whale] }];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  const second = applyGroupNaming(stickers, store, whale, '大肥鱼');
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 1);
  assert.equal(stickers[0].description, '大肥鱼，胖鱼');
});

test('已被其他分组冠名的图片不覆盖', () => {
  const { store, whale, cute } = makeStore();
  const stickers = [{ id: 's1', description: '胖鱼', groupIds: [whale, cute] }];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  const result = applyGroupNaming(stickers, store, cute, '可爱');
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(stickers[0].description, '大肥鱼，胖鱼');
  assert.equal(stickers[0].namingGroupId, whale);
});

test('不在组里的图片完全不受影响', () => {
  const { store, whale } = makeStore();
  const stickers = [
    { id: 's1', description: '别的图', groupIds: [] },
    { id: 's2', description: '别人家的', groupIds: ['grp_other'] },
  ];
  const result = applyGroupNaming(stickers, store, whale, '大肥鱼');
  assert.equal(result.updated, 0);
  assert.equal(stickers[0].description, '别的图');
  assert.equal(stickers[1].description, '别人家的');
});

test('关掉冠名把描述还原成冠名前的内容', () => {
  const { store, whale } = makeStore();
  const stickers = [{ id: 's1', description: '戴着蝴蝶结的胖鱼', groupIds: [whale] }];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  const back = revertGroupNaming(stickers, whale);
  assert.equal(back.updated, 1);
  assert.equal(stickers[0].description, '戴着蝴蝶结的胖鱼');
  assert.equal(stickers[0].namingGroupId, undefined);
  assert.equal(stickers[0].namingBaseDescription, undefined);
});

test('撤销只还原本组冠名的图片，不动别的组', () => {
  const { store, whale, cute } = makeStore();
  const stickers = [
    { id: 's1', description: '胖鱼', groupIds: [whale] },
    { id: 's2', description: '小猫', groupIds: [cute] },
  ];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  applyGroupNaming(stickers, store, cute, '可爱');
  const back = revertGroupNaming(stickers, whale);
  assert.equal(back.updated, 1);
  assert.equal(stickers[0].description, '胖鱼');
  assert.equal(stickers[1].description, '可爱，小猫');
});

test('分组改名后，冠名前缀跟着换成新名字且原描述保留', () => {
  const { store, whale } = makeStore();
  const stickers = [{ id: 's1', description: '戴着蝴蝶结的胖鱼', groupIds: [whale] }];
  applyGroupNaming(stickers, store, whale, '鲸鱼娘');
  assert.equal(stickers[0].description, '鲸鱼娘，戴着蝴蝶结的胖鱼');
  const renamed = renameGroupNaming(stickers, whale, '大肥鱼');
  assert.equal(renamed.updated, 1);
  assert.equal(stickers[0].description, '大肥鱼，戴着蝴蝶结的胖鱼');
  assert.equal(stickers[0].namingBaseDescription, '戴着蝴蝶结的胖鱼');
});

test('planGroupNaming 分别统计可冠名、冲突和已冠名的图片', () => {
  const { store, whale, cute } = makeStore();
  const stickers = [
    { id: 's1', description: 'a', groupIds: [whale] },
    { id: 's2', description: 'b', groupIds: [whale, cute] },
    { id: 's3', description: 'c', groupIds: [cute] },
  ];
  applyGroupNaming(stickers, store, cute, '可爱');
  const plan = planGroupNaming(stickers, store, whale);
  assert.deepEqual(plan.candidates, ['s1']);
  assert.equal(plan.conflict, 1);
  assert.equal(plan.already, 0);
  assert.equal(plan.total, 2);
});

test('组名加原描述超过长度上限时按上限截断', () => {
  const { store, whale } = makeStore();
  const longBase = '鱼'.repeat(200);
  const stickers = [{ id: 's1', description: longBase, groupIds: [whale] }];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  assert.equal(stickers[0].description.length, MAX_NAMING_DESCRIPTION_LENGTH);
  assert.ok(stickers[0].description.startsWith('大肥鱼，'));
  assert.equal(stickers[0].namingBaseDescription.length, MAX_NAMING_DESCRIPTION_LENGTH);
});

test('空组名不执行冠名', () => {
  const { store, whale } = makeStore();
  const stickers = [{ id: 's1', description: '胖鱼', groupIds: [whale] }];
  const result = applyGroupNaming(stickers, store, whale, '   ');
  assert.equal(result.updated, 0);
  assert.equal(stickers[0].description, '胖鱼');
});

test('分组命名开关经过 normalize 后保留', () => {
  let store = emptyGroupStore();
  const created = createGroup(store, '大肥鱼', { namingEnabled: true });
  assert.equal(created.group.namingEnabled, true);
  assert.equal(isGroupNamingEnabled(created.group), true);
  const normalized = normalizeGroupStore(created.store);
  assert.equal(normalized.groups[0].namingEnabled, true);
  assert.equal(isGroupNamingEnabled({}), false);
});

test('删除分组用 clearGroupNaming 清掉描述里的残留名字', () => {
  const { store, whale } = makeStore();
  const stickers = [{ id: 's1', description: '胖鱼', groupIds: [whale] }];
  applyGroupNaming(stickers, store, whale, '大肥鱼');
  const cleared = clearGroupNaming(stickers, whale);
  assert.equal(cleared.updated, 1);
  assert.equal(stickers[0].description, '胖鱼');
  assert.equal(stickers[0].namingGroupId, undefined);
});
