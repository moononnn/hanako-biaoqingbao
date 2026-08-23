import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServerInfo, uploadStickerAsUser } from '../lib/hana-upload.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-upload-'));
}

test('readServerInfo 从 server-info.json 读出 port 与 token', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'server-info.json'), JSON.stringify({ port: 14500, token: 'abc123' }), 'utf8');
  assert.deepEqual(readServerInfo(root), { port: 14500, token: 'abc123' });
});

test('readServerInfo 文件缺失或字段不全时返回 null', () => {
  const root = tempDir();
  assert.equal(readServerInfo(root), null);
  fs.writeFileSync(path.join(root, 'server-info.json'), JSON.stringify({ port: 14500 }), 'utf8');
  assert.equal(readServerInfo(path.join(root)), null);
  fs.writeFileSync(path.join(root, 'server-info.json'), 'not json', 'utf8');
  assert.equal(readServerInfo(root), null);
});

test('uploadStickerAsUser 调 /api/upload 并返回 user_upload 身份（顺带验证 temp 中转与清理）', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'server-info.json'), JSON.stringify({ port: 15000, token: 'tok' }), 'utf8');
  const stickers = path.join(root, 'stickers');
  fs.mkdirSync(stickers, { recursive: true });
  const srcPath = path.join(stickers, 'stk_001.png');
  fs.writeFileSync(srcPath, 'png-bytes');
  const sessionPath = path.join(root, 'sessions', 'x.jsonl');

  let captured;
  const ctx = {
    network: {
      async fetch(url, options) {
        captured = { url, options };
        return {
          async json() {
            return {
              uploads: [{
                src: JSON.parse(options.body).paths[0],
                fileId: 'sf_123456',
                filePath: 'C:/hanako/session-files/hash/1010_stk_001.png',
                origin: 'user_upload',
                storageKind: 'managed_cache',
                sessionId: 'sess_sid',
              }],
            };
          },
        };
      },
    },
  };

  const result = await uploadStickerAsUser({ ctx, hanaHome: root, sessionPath, srcPath, fileName: 'stk_001.png' });
  assert.deepEqual(result, {
    fileId: 'sf_123456',
    stagedPath: 'C:/hanako/session-files/hash/1010_stk_001.png',
    sessionId: 'sess_sid',
  });
  // 请求 URL 与鉴权头
  assert.equal(captured.url, 'http://127.0.0.1:15000/api/upload');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer tok');
  // body 里的 paths 指向临时目录（在 os.tmpdir 下）
  const body = JSON.parse(captured.options.body);
  assert.equal(path.dirname(body.paths[0]), os.tmpdir());
  assert.match(path.basename(body.paths[0]), /^bb_upload_\d+/);
  // 临时文件已清理
  assert.equal(fs.existsSync(body.paths[0]), false);
});

test('uploadStickerAsUser 失败分支返回 null（网络错误/返回 error/缺 fileId/无 network）', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'server-info.json'), JSON.stringify({ port: 15000, token: 'tok' }), 'utf8');
  const srcPath = path.join(root, 'a.png');
  fs.writeFileSync(srcPath, 'x');
  const sessionPath = path.join(root, 's.jsonl');

  // 无 ctx.network
  assert.equal(await uploadStickerAsUser({ ctx: {}, hanaHome: root, sessionPath, srcPath, fileName: 'a.png' }), null);

  // fetch 抛错
  const errCtx = { network: { async fetch() { throw new Error('boom'); } } };
  assert.equal(await uploadStickerAsUser({ ctx: errCtx, hanaHome: root, sessionPath, srcPath, fileName: 'a.png' }), null);

  // 返回 uploads[0].error
  const errU = {
    network: {
      async fetch() {
        return { async json() { return { uploads: [{ src: srcPath, error: 'sensitive path blocked' }] }; } };
      },
    },
  };
  assert.equal(await uploadStickerAsUser({ ctx: errU, hanaHome: root, sessionPath, srcPath, fileName: 'a.png' }), null);

  // 缺 fileId
  const noId = {
    network: {
      async fetch() {
        return { async json() { return { uploads: [{ filePath: 'C:/x.png' }] }; } };
      },
    },
  };
  assert.equal(await uploadStickerAsUser({ ctx: noId, hanaHome: root, sessionPath, srcPath, fileName: 'a.png' }), null);

  // server-info 不存在
  assert.equal(await uploadStickerAsUser({ ctx: errCtx, hanaHome: path.join(root, 'nope'), sessionPath, srcPath, fileName: 'a.png' }), null);
});
