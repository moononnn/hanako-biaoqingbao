import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareVisionImages } from '../lib/gif-frames.js';

// v0.33.44 - 扩展名 .gif 但内容不是真 GIF（QQ 缓存文件名不可信）→ 按真实签名降级静态图
test('prepareVisionImages：扩展名 .gif 但内容是 PNG → 降级静态图，不抛 Invalid GIF header', async () => {
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const r = await prepareVisionImages(pngHead.toString('base64'), 'qq_cache.gif');
  assert.equal(r.animated, false);
  assert.equal(r.totalFrames, 1);
  assert.equal(r.images.length, 1);
  assert.match(r.images[0], /^data:image\/png;base64,/);
});

test('prepareVisionImages：扩展名 .gif 但内容是 JPEG → 降级 jpg 静态图', async () => {
  const jpgHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const r = await prepareVisionImages(jpgHead.toString('base64'), 'cache.gif');
  assert.equal(r.animated, false);
  assert.match(r.images[0], /^data:image\/jpeg;base64,/);
});

test('prepareVisionImages：真 GIF 拆帧成功返回 PNG 帧', async () => {
  // 优先用图库里的真实动图（多帧）；测试环境没有则用手工最小 GIF（1 帧）
  let gif;
  const real = path.join(os.homedir(), '.hanako', 'plugin-data', 'biaoqingbao', 'stickers', 'stk_317.gif');
  try {
    gif = fs.readFileSync(real);
  } catch {
    gif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x01, 0x00, 0x01, 0x00,
      0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0xff, 0xff,
      0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00,
      0x3b,
    ]);
  }
  const r = await prepareVisionImages(gif.toString('base64'), 'real.gif');
  assert.ok(r.images.length >= 1);
  assert.match(r.images[0], /^data:image\/png;base64,/);
  assert.ok(r.totalFrames >= 1);
});
