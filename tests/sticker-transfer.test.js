import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MAX_ENTRIES, extractStickerArchive, writeStoredZip } from '../lib/zip-images.js';
import {
  buildStickerExportPlan,
  buildMigrationPayload,
  buildAgentMapping,
  exportStickerArchive,
  findTransferMetadata,
  hashBuffer,
  normalizeMigrationPayload,
  normalizeTransferMetadata,
  planStickerIdMapping,
  remapMigrationData,
  validateTransferManifest,
  readLastExportDir,
  writeLastExportDir,
} from '../lib/sticker-transfer.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fakePng(seed) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from([seed, seed + 1, seed + 2])]);
}

async function withTempDir(run) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'biaoqingbao-transfer-'));
  try {
    return await run(directory);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

test('普通旧 ZIP 仍能导入，且不会误判为迁移包', async () => {
  await withTempDir(async (directory) => {
    const zipPath = path.join(directory, 'old.zip');
    await writeStoredZip(zipPath, [{ name: 'old.png', data: fakePng(1) }]);
    const archive = await extractStickerArchive(await fsp.readFile(zipPath));
    assert.equal(archive.images.length, 1);
    assert.equal(archive.images[0].entryName, 'old.png');
    assert.equal(archive.metadataFound, false);
    assert.equal(archive.metadata, null);
  });
});

test('迁移 manifest 校验兼容旧 ZIP，并拒绝未知格式与未来版本', () => {
  assert.deepEqual(validateTransferManifest(null), { ok: true, legacy: true, version: 1 });
  assert.equal(validateTransferManifest({ format: 'hana-biaoqingbao', formatVersion: 2 }, { found: true }).ok, true);
  assert.match(validateTransferManifest({ format: 'other-plugin', formatVersion: 2 }, { found: true }).error, /不是表情包插件/);
  assert.match(validateTransferManifest({ format: 'hana-biaoqingbao', formatVersion: 3 }, { found: true }).error, /更新版插件/);
  assert.match(validateTransferManifest({ format: 'hana-biaoqingbao', formatVersion: 'oops' }, { found: true }).error, /版本号无效/);
  assert.match(validateTransferManifest({ format: 'hana-biaoqingbao', formatVersion: 2, dataVersion: 2 }, { found: true }).error, /数据需要更新版插件/);
});

test('ZIP 图片按真实签名归一化扩展名，错扩展名也能迁移', async () => {
  await withTempDir(async (directory) => {
    const zipPath = path.join(directory, 'wrong-ext.zip');
    await writeStoredZip(zipPath, [{ name: 'wrong.jpg', data: fakePng(2) }]);
    const archive = await extractStickerArchive(await fsp.readFile(zipPath));
    assert.equal(archive.images.length, 1);
    assert.equal(archive.images[0].ext, 'png');
    assert.equal(archive.images[0].sourceExt, 'jpg');
  });
});

test('导出 ZIP 后可解析出图片、名称和标签，缺失图片会被跳过', async () => {
  await withTempDir(async (directory) => {
    const stickersDir = path.join(directory, 'stickers');
    await fsp.mkdir(stickersDir);
    await fsp.writeFile(path.join(stickersDir, 'cat.png'), fakePng(10));
    const outputPath = path.join(directory, 'export.zip');
    const result = await exportStickerArchive({
      stickersDir,
      outputPath,
      exportedAt: new Date('2026-08-26T01:02:03.000Z'),
      pluginVersion: '0.33.75',
      meta: [
        { id: 'stk_001', file: 'cat.png', name: '开心猫', description: '开心猫', tags: { emotion: ['开心'], scene: ['日常'], keywords: ['猫猫'] } },
        { id: 'stk_002', file: 'missing.gif', description: '丢失图片', tags: { emotion: ['难过'] } },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.exported, 1);
    assert.equal(result.skipped.length, 1);

    const archive = await extractStickerArchive(await fsp.readFile(outputPath));
    assert.equal(archive.images.length, 1);
    assert.equal(archive.images[0].entryName, 'stickers/cat.png');
    assert.equal(archive.metadataFound, true);
    assert.equal(archive.metadata.length, 1);
    assert.equal(archive.metadata[0].name, '开心猫');
    assert.equal('id' in archive.metadata[0], false);
    assert.deepEqual(archive.metadata[0].tags, { emotion: ['开心'], scene: ['日常'], keywords: ['猫猫'] });
    assert.equal(archive.manifest.format, 'hana-biaoqingbao');
    assert.equal(archive.manifest.pluginVersion, '0.33.75');
  });
});

test('迁移元数据优先按相对路径匹配，重名文件不会错误套用标签', () => {
  const index = normalizeTransferMetadata([
    { file: 'stickers/a/cat.png', name: 'A猫', tags: { emotion: ['开心'] } },
    { file: 'stickers/b/cat.png', name: 'B猫', tags: { emotion: ['难过'] } },
    { file: 'stickers/unique.png', description: '唯一图', keywords: ['唯一'] },
    { file: '../outside.png', name: '不应导入' },
  ]);

  assert.equal(index.ok, true);
  assert.equal(findTransferMetadata(index, { entryName: 'stickers/a/cat.png' }).description, 'A猫');
  assert.equal(findTransferMetadata(index, { entryName: 'stickers/b/cat.png' }).description, 'B猫');
  assert.equal(findTransferMetadata(index, { entryName: 'other/cat.png' }), null);
  assert.equal(findTransferMetadata(index, { entryName: 'folder/unique.png' }).description, '唯一图');
  assert.equal(index.ignored, 1);
});

test('导出计划拒绝越界路径，并只读取普通图片文件', () => {
  const plan = buildStickerExportPlan({
    stickersDir: 'C:\\图库\\stickers',
    meta: [
      { file: '../secret.png', description: '越界' },
      { file: 'C:\\secret.png', description: '绝对路径' },
    ],
  });
  assert.equal(plan.files.length, 0);
  assert.equal(plan.skipped.length, 2);
});

test('导出目录配置只保存最近一次目录', async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, 'export-config.json');
    assert.equal(readLastExportDir(configPath, '默认'), '默认');
    writeLastExportDir(configPath, 'L:\\表情包导出');
    assert.equal(readLastExportDir(configPath, '默认'), 'L:\\表情包导出');
    writeLastExportDir(configPath, 'L:\\表情包导出\\第二份');
    assert.equal(readLastExportDir(configPath, '默认'), 'L:\\表情包导出\\第二份');
  });
});

test('ZIP 写入拒绝危险条目路径', async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(
      writeStoredZip(path.join(directory, 'bad.zip'), [{ name: '../outside.txt', data: 'x' }]),
      /ZIP 条目路径无效/,
    );
  });
});

test('ZIP 条目上限与迁移包上限一致，超限包直接拒绝', async () => {
  await withTempDir(async (directory) => {
    const zipPath = path.join(directory, 'too-many.zip');
    const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({
      name: `file-${index}.txt`,
      data: 'x',
    }));
    await writeStoredZip(zipPath, entries);
    await assert.rejects(extractStickerArchive(await fsp.readFile(zipPath)), /最多支持 2000 个/);
  });
});

test('v2 搬家包只导出用户资产，排除凭据、日志和直接向量', async () => {
  await withTempDir(async (directory) => {
    const dataDir = path.join(directory, 'data');
    const stickersDir = path.join(dataDir, 'stickers');
    await fsp.mkdir(stickersDir, { recursive: true });
    const image = fakePng(31);
    await fsp.writeFile(path.join(stickersDir, 'cat.png'), image);
    const meta = [{
      id: 'stk_old', file: 'cat.png', name: '开心猫', description: '开心猫',
      tags: { emotion: ['开心'], scene: ['日常'], keywords: ['猫'] },
      added_at: '2026-08-01T00:00:00.000Z', tagged_at: '2026-08-02T00:00:00.000Z',
    }];
    const files = {
      'preferences.json': { version: 1, users: { 'old-agent': { mappings: [{ context: { emotion: '开心' }, preferred_ids: ['stk_old'] }] } } },
      'teaching-samples.json': { version: 1, model: 'secret-model-name', samples: { stk_old: { description: '开心猫', keywords: ['猫'], vector: [1, 2, 3] } } },
      'context-feedback.json': { version: 1, byAgent: { 'old-agent': { 开心: { stk_old: { count: 2, lastAt: '2026-08-03T00:00:00.000Z' } } } } },
      'exposure-stats.json': { version: 2, byAgent: { 'old-agent': { stk_old: { exposureCount: 3, firstExposedAt: '2026-08-03T00:00:00.000Z', lastExposedAt: '2026-08-04T00:00:00.000Z' } } } },
      'style-template.json': { current: '你说话很口语', history: [], source_agents: ['old-agent'], excluded_agents: [] },
      'style-profile.json': { level: 'balanced', source_agents: ['old-agent'], model: 'secret-model', providerId: 'secret-provider', baseUrl: 'https://secret.invalid', customApiKey: 'DO_NOT_EXPORT', embeddingModel: 'secret-embedding', filePath: 'C:\\secret\\profile.json' },
      'dialect-config.json': { version: 3, agents: { 'old-agent': { dialect: 'sichuan', enabled: true } } },
      'agent-freq.json': { version: 2, default_daily: 50, default_task: 20, agents: { 'old-agent': { enabled: true, daily: 50, task: 20 } } },
      'display-config.json': { smallImageFit: true, smallImageThreshold: 200, showFeedbackButtons: true },
      'ball-config.json': { version: 2, pinnedIds: ['stk_old'], variant: 'plane', pinnedTarget: 'machine-only' },
    };
    for (const [name, value] of Object.entries(files)) await fsp.writeFile(path.join(dataDir, name), JSON.stringify(value));
    await fsp.writeFile(path.join(dataDir, 'vision-config.json'), JSON.stringify({ customApiKey: 'DO_NOT_EXPORT' }));
    await fsp.writeFile(path.join(dataDir, 'decision-log.json'), JSON.stringify({ entries: ['DO_NOT_EXPORT'] }));

    const payload = buildMigrationPayload({
      dataDir, stickersDir, meta,
      agentCatalog: [{ id: 'old-agent', name: '旧助手' }],
      exportedAt: new Date('2026-08-26T01:02:03.000Z'),
    });
    assert.equal(payload.format, 'hana-biaoqingbao');
    assert.equal(payload.version, 1);
    assert.equal(payload.stickers[0].sourceId, 'stk_old');
    assert.equal(payload.stickers[0].hash, hashBuffer(image));
    assert.deepEqual(payload.data.ballConfig.pinnedIds, ['stk_old']);
    assert.equal('pinnedTarget' in payload.data.ballConfig, false);
    assert.equal('vector' in payload.data.teaching.samples.stk_old, false);
    assert.equal('model' in payload.data.teaching, false);
    assert.equal('visionConfig' in payload.data, false);
    assert.equal('decisionLog' in payload.data, false);
    assert.equal('model' in payload.data.styleProfile, false);
    assert.equal('providerId' in payload.data.styleProfile, false);
    assert.equal('baseUrl' in payload.data.styleProfile, false);
    assert.equal('customApiKey' in payload.data.styleProfile, false);
    assert.equal('embeddingModel' in payload.data.styleProfile, false);
    assert.equal('filePath' in payload.data.styleProfile, false);
    assert.deepEqual(payload.data.styleProfile.source_agents, ['old-agent']);
    assert.equal(JSON.stringify(payload).includes('customApiKey'), false);
  });
});

test('v2 ZIP 可解析，已有同图按哈希复用新 ID并重建全部图片关联', async () => {
  await withTempDir(async (directory) => {
    const dataDir = path.join(directory, 'data');
    const stickersDir = path.join(dataDir, 'stickers');
    await fsp.mkdir(stickersDir, { recursive: true });
    const imageA = fakePng(41);
    const imageB = fakePng(51);
    await fsp.writeFile(path.join(stickersDir, 'a.png'), imageA);
    await fsp.writeFile(path.join(stickersDir, 'b.png'), imageB);
    const meta = [
      { id: 'stk_old_a', file: 'a.png', description: 'A图', tags: { emotion: ['开心'] } },
      { id: 'stk_old_b', file: 'b.png', description: 'B图', tags: { emotion: ['难过'] } },
    ];
    await fsp.writeFile(path.join(dataDir, 'preferences.json'), JSON.stringify({ version: 1, users: {
      'old-agent': { mappings: [{ context: { emotion: '开心' }, preferred_ids: ['stk_old_a'], vetoed_ids: ['stk_old_b'], dislike_counts: { stk_old_b: 2 } }] },
    } }));
    await fsp.writeFile(path.join(dataDir, 'context-feedback.json'), JSON.stringify({ byAgent: { 'old-agent': { 开心: { stk_old_a: { count: 1, lastAt: '2026-08-01T00:00:00.000Z' } } } } }));
    await fsp.writeFile(path.join(dataDir, 'teaching-samples.json'), JSON.stringify({ samples: { stk_old_a: { description: 'A图', keywords: ['A'], vector: [1] } } }));

    const zipPath = path.join(directory, 'move.zip');
    const exported = await exportStickerArchive({
      meta, stickersDir, dataDir, outputPath: zipPath,
      agentCatalog: [{ id: 'old-agent', name: '旧助手' }],
      pluginVersion: '0.33.77',
      exportedAt: new Date('2026-08-26T01:02:03.000Z'),
    });
    assert.equal(exported.ok, true);
    assert.equal(exported.manifest.formatVersion, 2);
    const archive = await extractStickerArchive(await fsp.readFile(zipPath));
    assert.equal(archive.migrationFound, true);
    const migration = normalizeMigrationPayload(archive.migration);
    assert.equal(migration.ok, true);

    const existing = [{ id: 'stk_900', file: 'stk_900.png' }];
    const idPlan = planStickerIdMapping({
      images: [
        { fileName: 'a.png', entryName: 'stickers/a.png', data: imageA },
        { fileName: 'b.png', entryName: 'stickers/b.png', data: imageB },
      ],
      migrationPayload: migration,
      existingMeta: existing,
      existingHashes: new Map([[hashBuffer(imageA), 'stk_900']]),
      nextId: () => 'stk_901',
    });
    assert.equal(idPlan.items.length, 1);
    assert.equal(idPlan.items[0].targetId, 'stk_901');
    assert.equal(idPlan.stickerIdMap.get('stk_old_a'), 'stk_900');
    assert.equal(idPlan.stickerIdMap.get('stk_old_b'), 'stk_901');

    const agents = buildAgentMapping(migration.agents, [{ id: 'new-agent', name: '旧助手' }]);
    assert.equal(agents.map.get('old-agent'), 'new-agent');
    const remapped = remapMigrationData(migration.data, {
      stickerIdMap: idPlan.stickerIdMap,
      agentIdMap: agents.map,
    });
    const mapping = remapped.data.preferences.users['new-agent'].mappings[0];
    assert.deepEqual(mapping.preferred_ids, ['stk_900']);
    assert.deepEqual(mapping.vetoed_ids, ['stk_901']);
    assert.equal(mapping.dislike_counts.stk_901, 2);
    assert.equal(remapped.data.contextFeedback.byAgent['new-agent'].开心.stk_900.count, 1);
    assert.equal(Object.hasOwn(remapped.data.teaching.samples, 'stk_900'), true);
    assert.equal('vector' in remapped.data.teaching.samples.stk_900, false);
  });
});

test('助手映射遇到同名歧义时不擅自绑定', () => {
  const result = buildAgentMapping(
    [{ id: 'source', name: '同名助手' }],
    [{ id: 'a', name: '同名助手' }, { id: 'b', name: '同名助手' }],
  );
  assert.equal(result.map.has('source'), false);
  assert.equal(result.ambiguous[0].source, 'source');
});

test('管理页把完整搬家包放在数据与迁移页，图库保留普通导入', () => {
  const ui = fs.readFileSync(path.join(process.cwd(), 'routes', 'ui.js'), 'utf8');
  const client = fs.readFileSync(path.join(process.cwd(), 'assets', 'sticker-manager.js'), 'utf8');
  const api = fs.readFileSync(path.join(process.cwd(), 'routes', 'api.js'), 'utf8');
  assert.match(ui, /id="view-data-migration"/);
  assert.match(ui, /id="data-migration-export-btn"/);
  assert.match(ui, /id="data-migration-import-file"/);
  assert.doesNotMatch(ui, /id="export-all-btn"/);
  assert.match(client, /action: 'export_zip'/);
  assert.match(client, /handleMigrationImportZip/);
  assert.match(client, /migrationMode: true/);
  assert.match(client, /needsTagIds/);
  assert.match(api, /action === 'export_zip'/);
  assert.match(api, /normalizeMigrationPayload/);
  assert.match(api, /migrationReport/);
});
