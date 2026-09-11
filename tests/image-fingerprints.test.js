// 图片内容指纹索引测试（v0.34.35）
// 覆盖导入去重的核心路径：补建索引、删除清理、查重命中、脏记录自愈。
// 全部在临时目录里跑，只传参不碰真实图库数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  syncFingerprintIndex,
  findDuplicateSticker,
  registerFingerprint,
  unregisterFingerprint,
  fingerprintPairs,
  fingerprintOfBuffer,
  resetFingerprintIndex,
} from '../lib/image-fingerprints.js';

let sandboxSeq = 0;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bqb-fp-${process.pid}-${sandboxSeq++}-`));
  const stickersDir = path.join(root, 'stickers');
  fs.mkdirSync(stickersDir, { recursive: true });
  return { root, stickersDir, indexFile: path.join(root, 'image-fingerprints.json') };
}

function writeImage(dir, file, content) {
  fs.writeFileSync(path.join(dir, file), Buffer.from(content));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

test('首次同步为图库补齐指纹，重复内容的图能被查出来', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    writeImage(stickersDir, 'a.png', 'AAAA');
    writeImage(stickersDir, 'b.png', 'BBBB');
    const meta = [
      { id: 'stk_001', file: 'a.png' },
      { id: 'stk_002', file: 'b.png' },
    ];

    const report = syncFingerprintIndex({ meta, stickersDir, indexFile });
    assert.equal(report.added, 2);
    assert.equal(report.removed, 0);
    assert.equal(report.failed, 0);
    assert.equal(report.total, 2);

    const hashA = fingerprintOfBuffer(Buffer.from('AAAA'));
    assert.equal(findDuplicateSticker(hashA, meta, { indexFile })?.id, 'stk_001');

    // 没在库里的内容不误判
    assert.equal(findDuplicateSticker(fingerprintOfBuffer(Buffer.from('CCCC')), meta, { indexFile }), null);
  } finally {
    cleanup(root);
  }
});

test('二次同步不重复读盘：已有指纹的图不再算一遍', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    writeImage(stickersDir, 'a.png', 'AAAA');
    const meta = [{ id: 'stk_001', file: 'a.png' }];

    assert.equal(syncFingerprintIndex({ meta, stickersDir, indexFile }).added, 1);
    const again = syncFingerprintIndex({ meta, stickersDir, indexFile });
    assert.equal(again.added, 0);
    assert.equal(again.removed, 0);
    assert.equal(again.total, 1);
  } finally {
    cleanup(root);
  }
});

test('图被删掉后再次同步会清掉它的指纹，不会把新图误判成重复', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    writeImage(stickersDir, 'a.png', 'AAAA');
    writeImage(stickersDir, 'b.png', 'BBBB');
    const full = [
      { id: 'stk_001', file: 'a.png' },
      { id: 'stk_002', file: 'b.png' },
    ];
    syncFingerprintIndex({ meta: full, stickersDir, indexFile });
    const hashB = fingerprintOfBuffer(Buffer.from('BBBB'));

    const afterDelete = [{ id: 'stk_001', file: 'a.png' }];
    const report = syncFingerprintIndex({ meta: afterDelete, stickersDir, indexFile });
    assert.equal(report.removed, 1);
    assert.equal(report.total, 1);
    assert.equal(findDuplicateSticker(hashB, afterDelete, { indexFile }), null);
  } finally {
    cleanup(root);
  }
});

test('删除图时显式注销指纹，同一张图删掉后可以重新导入', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    writeImage(stickersDir, 'a.png', 'AAAA');
    const meta = [{ id: 'stk_001', file: 'a.png' }];
    syncFingerprintIndex({ meta, stickersDir, indexFile });
    const hashA = fingerprintOfBuffer(Buffer.from('AAAA'));

    assert.equal(findDuplicateSticker(hashA, meta, { indexFile })?.id, 'stk_001');
    unregisterFingerprint('stk_001', { indexFile });
    assert.equal(findDuplicateSticker(hashA, meta, { indexFile }), null);
  } finally {
    cleanup(root);
  }
});

test('查重会自愈脏记录：索引里指向已不存在的图时清掉并继续判定', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    const hash = fingerprintOfBuffer(Buffer.from('GHOST'));
    registerFingerprint('stk_ghost', hash, { indexFile });

    // meta 里已经没有 stk_ghost：不能拿它当成"重复"，并且要顺手清掉
    assert.equal(findDuplicateSticker(hash, [], { indexFile }), null);
    assert.deepEqual(fingerprintPairs({ indexFile }), []);
  } finally {
    cleanup(root);
  }
});

test('非法参数被拒绝：空 id、格式不对的哈希都不进索引', () => {
  const { root, indexFile } = makeSandbox();
  try {
    assert.equal(registerFingerprint('', fingerprintOfBuffer(Buffer.from('X')), { indexFile }), false);
    assert.equal(registerFingerprint('stk_x', 'not-a-hash', { indexFile }), false);
    assert.equal(findDuplicateSticker('not-a-hash', [], { indexFile }), null);
    assert.equal(findDuplicateSticker('', [], { indexFile }), null);
    assert.deepEqual(fingerprintPairs({ indexFile }), []);
  } finally {
    cleanup(root);
  }
});

test('索引文件损坏时退化成空索引，不抛错', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    fs.writeFileSync(indexFile, '{ 这不是 JSON', 'utf8');
    writeImage(stickersDir, 'a.png', 'AAAA');
    const meta = [{ id: 'stk_001', file: 'a.png' }];

    const report = syncFingerprintIndex({ meta, stickersDir, indexFile });
    assert.equal(report.added, 1);
    assert.equal(findDuplicateSticker(fingerprintOfBuffer(Buffer.from('AAAA')), meta, { indexFile })?.id, 'stk_001');
  } finally {
    resetFingerprintIndex({ indexFile });
    cleanup(root);
  }
});

test('重建索引（reset）后可重新构建，结果与首次一致', () => {
  const { root, stickersDir, indexFile } = makeSandbox();
  try {
    writeImage(stickersDir, 'a.png', 'AAAA');
    const meta = [{ id: 'stk_001', file: 'a.png' }];
    syncFingerprintIndex({ meta, stickersDir, indexFile });

    resetFingerprintIndex({ indexFile, deleteFile: true });
    assert.equal(fs.existsSync(indexFile), false);

    const rebuilt = syncFingerprintIndex({ meta, stickersDir, indexFile });
    assert.equal(rebuilt.added, 1);
    assert.equal(findDuplicateSticker(fingerprintOfBuffer(Buffer.from('AAAA')), meta, { indexFile })?.id, 'stk_001');
  } finally {
    cleanup(root);
  }
});
