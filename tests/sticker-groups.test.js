import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PREFERRED_GROUP_BONUS,
  MAX_GROUPS,
  MAX_GROUP_IDS_PER_STICKER,
  UNGROUPED_GROUP_ID,
  createGroup,
  renameGroup,
  updateGroupRecognition,
  normalizeRecognitionAliases,
  buildRecognitionGroupHints,
  suggestGroupsForTags,
  planGroupNameMigration,
  createNameMigrationRecord,
  applyNameMigration,
  normalizeNameMigrationStore,
  filterGroupStoreForExport,
  filterStickersForAgent,
  getAgentGroupConfig,
  getGroupPreferenceBonus,
  getKnownGroupIds,
  getStickerGroupIds,
  normalizeStickerGroupMemberships,
  readGroupStore,
  isGroupStoreReadable,
  getGroupStoreError,
  groupStorePath,
  mergeGroupStores,
  normalizeGroupStore,
  setStickerGroupIds,
  updateStickerGroupMembership,
} from '../lib/sticker-groups.js';
import {
  buildStickerExportPlan,
  buildMigrationPayload,
  normalizeMigrationPayload,
  resolveExportDataKeys,
  remapMigrationData,
} from '../lib/sticker-transfer.js';
import { scoreStickers } from '../tools/express.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fakePng(seed) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from([seed, seed + 1, seed + 2])]);
}

async function withTempDir(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-groups-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('分组数据归一化：未分组是虚拟状态，旧图没有 groupIds 也能正常读取', () => {
  const store = normalizeGroupStore({
    version: 99,
    groups: [
      { id: 'people', name: '伙伴' },
      { id: 'people', name: '重复' },
      { id: '__ungrouped__', name: '不允许覆盖虚拟分组' },
      { id: 'bad/id', name: '越界' },
    ],
    agents: {
      hanako: {
        configured: true,
        groupIds: ['people', 'missing'],
        favoriteGroupIds: ['people', 'missing'],
      },
    },
  });
  assert.deepEqual(store.groups.map((group) => group.id), ['people']);
  assert.deepEqual(store.agents.hanako.groupIds, ['people']);
  assert.deepEqual(store.agents.hanako.favoriteGroupIds, ['people']);
  assert.deepEqual(getStickerGroupIds({ id: 'old' }, getKnownGroupIds(store)), []);
  assert.equal(UNGROUPED_GROUP_ID, '__ungrouped__');
  const stickers = [
    { id: 'legacy', group_ids: ['people', 'missing', 'people'] },
    { id: 'empty', groupIds: [] },
    { id: 'bad', groupIds: ['missing'] },
  ];
  const cleaned = normalizeStickerGroupMemberships(stickers, store);
  assert.equal(cleaned.changed, 3);
  assert.deepEqual(stickers[0].groupIds, ['people']);
  assert.equal('group_ids' in stickers[0], false);
  assert.equal('groupIds' in stickers[1], false);
  assert.equal('groupIds' in stickers[2], false);
});

test('识图分组：组织分组默认关闭，别名归一化，启用后才提供提示和候选', () => {
  const created = createGroup({ groups: [] }, '大肥鱼', {
    id: 'fish',
    recognitionAliases: '鲸鱼娘，肥鱼，鲸鱼娘',
  });
  assert.equal(created.ok, true);
  assert.equal(created.group.recognitionEnabled, false);
  assert.deepEqual(created.group.recognitionAliases, ['鲸鱼娘', '肥鱼']);
  const renamed = renameGroup(created.store, 'fish', '大肥鱼图');
  assert.deepEqual(renamed.group.recognitionAliases, ['鲸鱼娘', '肥鱼', '大肥鱼']);
  const enabled = updateGroupRecognition(renamed.store, 'fish', { recognitionEnabled: true });
  const hints = buildRecognitionGroupHints(enabled.store);
  assert.match(hints, /大肥鱼图/);
  assert.match(hints, /鲸鱼娘/);
  const suggestions = suggestGroupsForTags({
    description: '一只鲸鱼娘开心地挥手',
    semantic_description: '适合卖萌',
    keywords: ['鲸鱼娘'],
  }, enabled.store);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].groupId, 'fish');
  assert.equal(suggestions[0].matchedTerm, '鲸鱼娘');
  assert.deepEqual(normalizeRecognitionAliases('A, a，B'), ['A', 'B']);
  assert.equal(buildRecognitionGroupHints(renamed.store), '');
});

test('分组重命名迁移：只匹配分组内的完全同名描述，撤销跳过后来手动改过的图片', () => {
  const store = normalizeGroupStore({ groups: [{ id: 'fish', name: '鲸鱼娘' }] });
  const stickers = [
    { id: 'exact', description: '鲸鱼娘', groupIds: ['fish'] },
    { id: 'suffix', description: '鲸鱼娘生气', groupIds: ['fish'] },
    { id: 'other-group', description: '鲸鱼娘', groupIds: ['other'] },
    { id: 'ungrouped', description: '鲸鱼娘' },
  ];
  const plan = planGroupNameMigration(stickers, 'fish', '鲸鱼娘', '大肥鱼', store);
  assert.equal(plan.count, 1);
  const record = createNameMigrationRecord({ groupId: 'fish', fromName: '鲸鱼娘', toName: '大肥鱼', changes: plan.changes, now: '2026-09-11T00:00:00.000Z' });
  assert.ok(record && record.id);
  const applied = applyNameMigration(stickers, record);
  assert.equal(applied.updated, 1);
  assert.equal(stickers[0].description, '大肥鱼');
  stickers[0].description = '用户后来手动改的名称';
  const undone = applyNameMigration(stickers, record, 'reverse');
  assert.equal(undone.updated, 0);
  assert.equal(undone.skipped, 1);
  assert.equal(stickers[0].description, '用户后来手动改的名称');
  const normalized = normalizeNameMigrationStore({ migrations: [record] });
  assert.equal(normalized.migrations[0].changes.length, 1);
});

test('分组文件损坏时选图 fail-closed，不会把伙伴限制放开成全图库', async () => {
  await withTempDir(async (directory) => {
    await fs.writeFile(groupStorePath(directory), '{ not-json');
    const store = readGroupStore(directory);
    assert.equal(isGroupStoreReadable(store), false);
    assert.match(getGroupStoreError(store), /Unexpected|JSON|token/i);
    const config = getAgentGroupConfig(store, 'hanako');
    assert.equal(config.configured, true);
    assert.equal(config.includeUngrouped, false);
    assert.deepEqual(filterStickersForAgent([
      { id: 'a' },
      { id: 'b', groupIds: ['known'] },
    ], 'hanako', store), []);
  });
});

test('伙伴分组白名单：未配置沿用全库，配置后默认保留未分组且按多对多归属过滤', () => {
  const store = {
    groups: [{ id: 'role', name: '角色' }, { id: 'mood', name: '情绪' }],
    agents: {
      limited: { configured: true, groupIds: ['role'], favoriteGroupIds: [], includeUngrouped: true },
    },
  };
  const stickers = [
    { id: 'a', groupIds: ['role', 'mood'] },
    { id: 'b', groupIds: ['mood'] },
    { id: 'c' },
  ];
  assert.deepEqual(filterStickersForAgent(stickers, 'unknown', store).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(filterStickersForAgent(stickers, 'limited', store).map((item) => item.id), ['a', 'c']);
  assert.deepEqual(filterStickersForAgent(stickers, 'limited', {
    ...store,
    agents: { limited: { ...store.agents.limited, includeUngrouped: false } },
  }).map((item) => item.id), ['a']);
  assert.doesNotThrow(() => filterStickersForAgent(stickers, 'toString', {
    groups: [{ id: 'allowed', name: '允许' }],
    agents: { toString: { configured: true, groupIds: ['allowed'] } },
  }));
});

test('分组偏爱只有小幅加分，不会让无匹配图片凭空进入候选', () => {
  const store = { groups: [{ id: 'fav', name: '偏爱' }], agents: {
    hanako: { configured: true, groupIds: ['fav'], favoriteGroupIds: ['fav'], includeUngrouped: true },
  } };
  const config = getAgentGroupConfig(store, 'hanako');
  const known = getKnownGroupIds(store);
  assert.equal(getGroupPreferenceBonus({ groupIds: ['fav'] }, config, known), PREFERRED_GROUP_BONUS);
  assert.equal(getGroupPreferenceBonus({ groupIds: [] }, config, known), 0);
  assert.equal(getGroupPreferenceBonus({ groupIds: ['missing'] }, config, known), 0);
  const ranked = scoreStickers([
    { id: 'fav', description: '猫', tags: { emotion: ['开心'] }, groupIds: ['fav'] },
    { id: 'plain', description: '狗', tags: { emotion: ['开心'] } },
    { id: 'irrelevant', description: '难过', tags: { emotion: ['难过'] }, groupIds: ['fav'] },
  ], '开心', [], { preferred: [], vetoed: [], dislikes: {} }, null, config, known);
  assert.deepEqual(ranked.map((item) => item.id), ['fav', 'plain']);
  assert.equal(ranked[0]._score, 11);
  const preferredOnly = scoreStickers([
    { id: 'fav', description: '猫', tags: { emotion: ['难过'] }, groupIds: ['fav'] },
  ], '开心', [], { preferred: ['fav'], vetoed: [], dislikes: {} }, null, config, known);
  assert.equal(preferredOnly[0]._score, 10, '全局偏爱本身不应再触发分组偏爱加分');
});

test('图片分组支持统一设置和混合批量增删，空集合回到未分组', () => {
  const store = { groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  const stickers = [{ id: '1', groupIds: ['a'] }, { id: '2', groupIds: ['b'] }, { id: '3' }];
  const added = updateStickerGroupMembership(stickers, ['1', '2'], { addGroupIds: ['b'] }, store);
  assert.equal(added.updated, 1);
  assert.deepEqual(stickers[0].groupIds, ['a', 'b']);
  assert.deepEqual(stickers[1].groupIds, ['b']);
  const removed = updateStickerGroupMembership(stickers, ['1', '2', '3'], { removeGroupIds: ['a', 'b'] }, store);
  assert.equal(removed.updated, 2);
  assert.equal('groupIds' in stickers[0], false);
  assert.equal('groupIds' in stickers[1], false);
  assert.equal('groupIds' in stickers[2], false);
  const set = setStickerGroupIds(stickers, ['1'], ['a', 'b'], store);
  assert.equal(set.updated, 1);
  assert.deepEqual(stickers[0].groupIds, ['a', 'b']);
  const legacy = [{ id: 'legacy', group_ids: ['a'] }];
  updateStickerGroupMembership(legacy, ['legacy'], { removeGroupIds: ['a'] }, store);
  assert.equal('groupIds' in legacy[0], false);
  assert.equal('group_ids' in legacy[0], false);
  const manyGroups = { groups: Array.from({ length: MAX_GROUP_IDS_PER_STICKER + 1 }, (_, index) => ({ id: 'g' + index, name: 'G' + index })) };
  const tooMany = [{ id: 'too-many' }];
  const rejected = updateStickerGroupMembership(tooMany, ['too-many'], {
    addGroupIds: manyGroups.groups.map((group) => group.id),
  }, manyGroups);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.updated, 0);
  assert.equal('groupIds' in tooMany[0], false, '超过上限时不应部分保存');
  const sixty = Array.from({ length: 60 }, (_, index) => ({ id: 'agent-group-' + index, name: '伙伴组' + index }));
  const wideStore = normalizeGroupStore({ groups: sixty, agents: {
    wide: { configured: true, groupIds: sixty.map((group) => group.id), favoriteGroupIds: sixty.slice(0, 2).map((group) => group.id) },
  } });
  assert.equal(wideStore.agents.wide.groupIds.length, 60, '伙伴白名单不应复用单图 50 组上限');
  assert.equal(filterGroupStoreForExport(wideStore, { selectedGroupIds: sixty.map((group) => group.id) }).groups.length, 60, '导出筛选不应静默截断到 50 组');
});

test('分组 ID 冲突时自动拆出新 ID，伙伴配置和图片关系可沿映射迁移', () => {
  const current = { groups: [{ id: 'same', name: '本机分组' }], agents: {} };
  const incoming = { groups: [{ id: 'same', name: '来源分组' }], agents: {
    agent: { configured: true, groupIds: ['same'], favoriteGroupIds: ['same'], includeUngrouped: true },
  } };
  const merged = mergeGroupStores(current, incoming, { idFactory: () => 'imported' });
  assert.equal(merged.groupIdMap.get('same'), 'imported');
  assert.deepEqual(merged.store.groups.map((group) => group.id), ['same', 'imported']);
  assert.deepEqual(merged.store.agents.agent.groupIds, ['imported']);
  assert.deepEqual(merged.store.agents.agent.favoriteGroupIds, ['imported']);
  const full = { groups: Array.from({ length: MAX_GROUPS }, (_, index) => ({ id: 'existing' + index, name: '现有' + index })) };
  const overflow = mergeGroupStores(full, { groups: [{ id: 'new-group', name: '新分组' }] });
  assert.deepEqual(overflow.skippedGroupIds, ['new-group']);
});

test('迁移重映射会同步改写分组 ID 和伙伴分组配置', () => {
  const incoming = normalizeGroupStore({
    groups: [{ id: 'same', name: '来源分组' }],
    agents: { source: { configured: true, groupIds: ['same'], favoriteGroupIds: ['same'], includeUngrouped: true } },
  });
  const remapped = remapMigrationData({ stickerGroups: incoming }, {
    agentIdMap: new Map([['source', 'target']]),
    groupIdMap: new Map([['same', 'imported']]),
  });
  assert.equal(remapped.data.stickerGroups.groups[0].id, 'imported');
  assert.deepEqual(remapped.data.stickerGroups.agents.target.groupIds, ['imported']);
  assert.deepEqual(remapped.data.stickerGroups.agents.target.favoriteGroupIds, ['imported']);
  const tooManyIncoming = normalizeMigrationPayload({
    version: 1,
    data: { stickerGroups: { groups: Array.from({ length: MAX_GROUPS + 1 }, (_, index) => ({ id: 'g' + index, name: 'G' + index })) } },
  });
  assert.equal(tooManyIncoming.ok, false);
  assert.equal(tooManyIncoming.fatal, true);
});

test('按多个分组导出取并集去重，并保留图片的全部分组关系与对应定义', async () => {
  await withTempDir(async (directory) => {
    const stickersDir = path.join(directory, 'stickers');
    await fs.mkdir(stickersDir, { recursive: true });
    await fs.writeFile(path.join(stickersDir, 'a.png'), fakePng(1));
    await fs.writeFile(path.join(stickersDir, 'b.png'), fakePng(2));
    await fs.writeFile(path.join(stickersDir, 'c.png'), fakePng(3));
    await fs.writeFile(path.join(stickersDir, 'd.png'), fakePng(4));
    const meta = [
      { id: 'a', file: 'a.png', description: 'A', groupIds: ['role', 'mood'] },
      { id: 'b', file: 'b.png', description: 'B', groupIds: ['mood'] },
      { id: 'c', file: 'c.png', description: 'C' },
    ];
    await fs.writeFile(path.join(directory, 'sticker-groups.json'), JSON.stringify({
      version: 1,
      groups: [{ id: 'role', name: '角色' }, { id: 'mood', name: '情绪' }, { id: 'empty', name: '空组' }],
      agents: {
        hanako: { configured: true, groupIds: ['role', 'mood'], favoriteGroupIds: ['role'], includeUngrouped: true },
        other: { configured: true, groupIds: ['empty'], favoriteGroupIds: ['empty'], includeUngrouped: false },
      },
    }));
    const plan = buildStickerExportPlan({
      meta,
      stickersDir,
      groupFilter: { groupIds: ['role', 'mood'], includeUngrouped: false },
      knownGroupIds: new Set(['role', 'mood', 'empty']),
    });
    assert.deepEqual(plan.transferStickers.map((item) => item.sourceId), ['a', 'b']);
    assert.deepEqual(plan.transferStickers[0].groupIds, ['role', 'mood']);
    const ungroupedPlan = buildStickerExportPlan({
      meta: [...meta, { id: 'd', file: 'd.png', description: '失效归属', groupIds: ['deleted'] }],
      stickersDir,
      groupFilter: { groupIds: [], includeUngrouped: true },
      knownGroupIds: new Set(['role', 'mood', 'empty']),
    });
    assert.deepEqual(ungroupedPlan.transferStickers.map((item) => item.sourceId), ['c', 'd']);
    const payload = buildMigrationPayload({
      dataDir: directory,
      stickersDir,
      meta,
      plan,
      includeDataKeys: ['stickerGroups'],
      groupFilter: { groupIds: ['role', 'mood'], includeUngrouped: false },
    });
    assert.deepEqual(payload.data.stickerGroups.groups.map((group) => group.id), ['role', 'mood']);
    assert.deepEqual(payload.data.stickerGroups.agents.hanako.groupIds, ['role', 'mood']);
    assert.equal(payload.data.stickerGroups.agents.other, undefined);
    const fullStore = filterGroupStoreForExport(JSON.parse(await fs.readFile(path.join(directory, 'sticker-groups.json'), 'utf8')), { all: true });
    assert.deepEqual(fullStore.agents.other.groupIds, ['empty']);
    const directPayload = buildMigrationPayload({
      dataDir: directory,
      stickersDir,
      meta,
      includeDataKeys: ['stickerGroups'],
      groupFilter: { groupIds: ['role'], includeUngrouped: false },
    });
    assert.deepEqual(directPayload.stickers.map((item) => item.sourceId), ['a']);
    assert.equal(resolveExportDataKeys(['groups'])[0], 'stickerGroups');
    const normalized = normalizeMigrationPayload(payload);
    assert.equal(normalized.ok, true);
    assert.deepEqual(normalized.stickers[0].groupIds, ['role', 'mood']);
  });
});

test('分组管理 UI 与选图链路都接入同一套分组契约', () => {
  const root = process.cwd();
  const ui = fsSync.readFileSync(path.join(root, 'routes', 'ui.js'), 'utf8');
  const client = fsSync.readFileSync(path.join(root, 'assets', 'sticker-manager.js'), 'utf8');
  const api = fsSync.readFileSync(path.join(root, 'routes', 'api.js'), 'utf8');
  const express = fsSync.readFileSync(path.join(root, 'tools', 'express.js'), 'utf8');
  const search = fsSync.readFileSync(path.join(root, 'tools', 'search-stickers.js'), 'utf8');
  const list = fsSync.readFileSync(path.join(root, 'tools', 'list-stickers.js'), 'utf8');
  const peek = fsSync.readFileSync(path.join(root, 'tools', 'pick-sticker.js'), 'utf8');
  const ballPy = fsSync.readFileSync(path.join(root, 'python', 'ball_app.py'), 'utf8');
  assert.match(ui, /id="btn-group-manager"/);
  assert.match(ui, /id="group-membership-modal"/);
  assert.match(ui, /id="create-membership-group-btn"/);
  assert.match(ui, /id="group-recognition-modal"/);
  assert.match(ui, /id="filter-group"/);
  assert.match(ui, /id="export-scope-groups"/);
  assert.match(ui, /id="export-group-groups"/);
  assert.match(ui, /id="agent-library-modal"/);
  assert.match(ui, /id="agent-library-list"/);
  assert.match(client, /\/api\/groups\/membership/);
  assert.match(client, /createGroupFromMembership/);
  assert.match(client, /undo-name-migration/);
  assert.match(ballPy, /group_suggestions/);
  assert.match(client, /groupFilter: groupFilter/);
  assert.match(client, /withAuth\(API \+ '\/api\/image\?id='/);
  assert.match(client, /dataGroups: getCheckedExportGroups\(\)/);
  assert.match(client, /refreshStickersAndGroups/);
  assert.match(client, /function groupFingerprint\(data\)/);
  assert.match(client, /apiFetch\(withAuth\(API \+ '\/api\/groups'\)\)/);
  assert.match(client, /exportRangePicker\.addEventListener\('change', updateExportSummary\)/);
  assert.doesNotMatch(client, /groupData = result\.data \|\| groupData/);
  assert.match(api, /app\.get\('\/api\/groups'/);
  assert.match(api, /app\.post\('\/api\/groups\/membership'/);
  assert.match(api, /update-recognition/);
  assert.match(api, /undo-name-migration/);
  assert.match(api, /buildRecognitionGroupHints/);
  assert.match(api, /app\.post\('\/api\/agent-groups'/);
  assert.match(api, /filterStickersForAgent\(readMeta\(\), agentId, groupStore\)/);
  assert.match(api, /app\.post\('\/api\/smart-pick'/);
  assert.match(api, /return await enqueueUploadWrite\(async \(\) => \{/);
  assert.match(api, /isAutoImageEnabled\(readAgentFreqConfig\(\)\)/);
  assert.match(api, /safeStickerPath\(STICKERS_DIR/);
  assert.match(api, /const submittedAgents = Object\.fromEntries/);
  assert.match(express, /filterStickersForAgent\(stickers, agentId, groupStore\)/);
  assert.match(search, /filterStickersForAgent\(stickers, agentId, groupStore\)/);
  assert.match(list, /filterStickersForAgent\(stickers, agentId, groupStore\)/);
  assert.match(peek, /filterStickersForAgent\(stickers, agentId, readGroupStore\(\)\)/);
});

test('迁移包未勾选图库分组时，分组数据键可单独排除', async () => {
  await withTempDir(async (directory) => {
    const stickersDir = path.join(directory, 'stickers');
    await fs.mkdir(stickersDir, { recursive: true });
    await fs.writeFile(path.join(stickersDir, 'a.png'), fakePng(4));
    await fs.writeFile(path.join(directory, 'sticker-groups.json'), JSON.stringify({ groups: [{ id: 'x', name: 'X' }] }));
    const meta = [{ id: 'a', file: 'a.png', description: 'A', groupIds: ['x'] }];
    const filteredPlan = buildStickerExportPlan({
      meta,
      stickersDir,
      groupFilter: { groupIds: ['x'], includeUngrouped: false },
      includeGroupMetadata: false,
    });
    assert.equal(filteredPlan.transferStickers[0].groupIds, undefined);
    const payload = buildMigrationPayload({
      dataDir: directory,
      stickersDir,
      meta,
      includeDataKeys: ['dialectConfig'],
      plan: filteredPlan,
      groupFilter: { groupIds: ['x'], includeUngrouped: false },
    });
    assert.equal('stickerGroups' in payload.data, false);
    assert.equal(payload.stickers[0].groupIds, undefined);
  });
});

test('伙伴可用图库：一个开关控制不限 / 按分组挑', () => {
  const root = process.cwd();
  const ui = fsSync.readFileSync(path.join(root, 'routes', 'ui.js'), 'utf8');
  const client = fsSync.readFileSync(path.join(root, 'assets', 'sticker-manager.js'), 'utf8');
  // v0.34.31 - 「全部图库 / 指定分组」左右两栏按钮太反直觉，拆掉
  assert.doesNotMatch(ui, /agent-lib-scope/, '模式切换按钮必须移除');
  assert.match(ui, /id="agent-library-list"/);
  assert.match(ui, /id="agent-library-hint"/);
  // v0.34.32 - 顶部一个「全部图库」开关：打开=不限（新分组也自动算进来），关掉=按勾选分组
  assert.match(ui, /id="agent-lib-all-toggle"[^>]*role="switch"/);
  assert.match(ui, /id="agent-lib-all-note"/);
  assert.match(client, /var unlimited = config\.configured !== true;/);
  assert.match(client, /toggle\.classList\.toggle\('on', unlimited\)/);
  assert.match(client, /list\.classList\.toggle\('is-locked', unlimited\)/);
  // 开关关掉时，一个都没勾过就默认全勾，不让她从空白开始
  assert.match(client, /if \(config\.groupIds\.length === 0 && config\.includeUngrouped !== true\) \{/);
  // 不限图库时「优先」按钮置灰（本来就谁都能用，加权没意义）
  assert.match(client, /\(enabled && !unlimited \? '' : ' disabled'\)/);
  // 移除伙伴入口改成看得懂的文字，不再是不知道怎么用的「⋯」
  assert.match(client, /class="agent-card-remove"[^>]*>移除</);
  assert.doesNotMatch(client, /class="agent-card-more"/, '⋯ 入口必须换掉');
});
