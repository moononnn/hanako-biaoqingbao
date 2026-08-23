import test from 'node:test';
import assert from 'node:assert/strict';

import { imageSizeFromBuffer, readImageSize } from '../lib/image-size.js';

// 构造各格式的最小合法文件头（仅供尺寸解析测试，不校验完整文件）
function png(w, h) {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function gif(w, h) {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function jpeg(w, h) {
  // FF D8 + SOF0 段
  const b = Buffer.alloc(21);
  b[0] = 0xFF; b[1] = 0xD8;
  b[2] = 0xFF; b[3] = 0xC0;      // SOF0
  b.writeUInt16BE(17, 4);        // 段长度
  b[6] = 8;                      // 精度
  b.writeUInt16BE(h, 7);         // 高度
  b.writeUInt16BE(w, 9);         // 宽度
  return b;
}
function webpVp8x(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(26, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
function webpVp8L(w, h) {
  const b = Buffer.alloc(25);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(21, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii'); b.writeUInt32LE(9, 16);
  b[20] = 0x2F;
  const wm1 = w - 1, hm1 = h - 1;
  b[21] = wm1 & 0xFF;
  b[22] = ((wm1 >> 8) & 0x3F) | ((hm1 & 0x03) << 6);
  b[23] = (hm1 >> 2) & 0xFF;
  b[24] = (hm1 >> 10) & 0x0F;
  return b;
}
function webpVp8(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(26, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii'); b.writeUInt32LE(10, 16);
  b.writeUInt16LE(w & 0x3FFF, 26);
  b.writeUInt16LE(h & 0x3FFF, 28);
  return b;
}

test('PNG 尺寸解析', () => {
  assert.deepEqual(imageSizeFromBuffer(png(512, 384)), { width: 512, height: 384 });
  assert.deepEqual(imageSizeFromBuffer(png(1, 1)), { width: 1, height: 1 });
});

test('GIF 尺寸解析（逻辑屏幕宽高）', () => {
  assert.deepEqual(imageSizeFromBuffer(gif(120, 90)), { width: 120, height: 90 });
});

test('JPEG 尺寸解析（扫描 SOF0 段）', () => {
  assert.deepEqual(imageSizeFromBuffer(jpeg(640, 480)), { width: 640, height: 480 });
});

test('WebP 三种容器尺寸解析（VP8X/VP8L/VP8）', () => {
  assert.deepEqual(imageSizeFromBuffer(webpVp8x(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(imageSizeFromBuffer(webpVp8L(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageSizeFromBuffer(webpVp8(250, 180)), { width: 250, height: 180 });
});

test('非法输入返回 null 不抛异常', () => {
  assert.equal(imageSizeFromBuffer(null), null);
  assert.equal(imageSizeFromBuffer(Buffer.alloc(3)), null);
  assert.equal(imageSizeFromBuffer(Buffer.from('not an image')), null);
  assert.equal(imageSizeFromBuffer(png(0, 0)), null);
  assert.equal(imageSizeFromBuffer(png(999999, 999999)), null);
});

test('readImageSize 读取不存在文件返回 null', async () => {
  const r = await readImageSize('C:/definitely/not/exist.png');
  assert.equal(r, null);
});