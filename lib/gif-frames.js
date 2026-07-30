import { deflate } from 'node:zlib';
import omggif from './vendor/omggif.cjs';

const { GifReader } = omggif;
const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};
const MAX_GIF_PIXELS = 4_000_000;
const MAX_VISION_FRAMES = 5;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function deflateAsync(buffer) {
  return new Promise((resolve, reject) => {
    deflate(buffer, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = await deflateAsync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function selectedFrameIndexes(total, maxFrames = MAX_VISION_FRAMES) {
  if (total <= maxFrames) return Array.from({ length: total }, (_, index) => index);
  const indexes = [];
  for (let i = 0; i < maxFrames; i++) {
    indexes.push(Math.round(i * (total - 1) / (maxFrames - 1)));
  }
  return [...new Set(indexes)];
}

function clearFrameRect(canvas, canvasWidth, info) {
  for (let y = info.y; y < info.y + info.height; y++) {
    const start = (y * canvasWidth + info.x) * 4;
    canvas.fill(0, start, start + info.width * 4);
  }
}

export async function extractGifFrames(buffer, maxFrames = MAX_VISION_FRAMES) {
  const reader = new GifReader(buffer);
  const width = reader.width;
  const height = reader.height;
  const totalFrames = reader.numFrames();
  if (!width || !height || !totalFrames) throw new Error('GIF 中没有可读取的画面');
  if (width * height > MAX_GIF_PIXELS) throw new Error('GIF 画面尺寸过大，暂不支持识图');

  const wanted = new Set(selectedFrameIndexes(totalFrames, maxFrames));
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let previousInfo = null;
  let restoreSnapshot = null;

  for (let index = 0; index < totalFrames; index++) {
    if (previousInfo?.disposal === 2) clearFrameRect(canvas, width, previousInfo);
    else if (previousInfo?.disposal === 3 && restoreSnapshot) canvas.set(restoreSnapshot);

    const info = reader.frameInfo(index);
    restoreSnapshot = info.disposal === 3 ? canvas.slice() : null;
    reader.decodeAndBlitFrameRGBA(index, canvas);

    if (wanted.has(index)) {
      const png = await encodePng(width, height, canvas);
      frames.push(`data:image/png;base64,${png.toString('base64')}`);
    }
    previousInfo = info;
    if (index % 8 === 7) await new Promise(resolve => setImmediate(resolve));
  }

  return { frames, totalFrames, width, height };
}

export async function prepareVisionImages(imageBase64, fileName) {
  const ext = (fileName || 'image.jpg').split('.').pop().toLowerCase();
  const rawBase64 = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!rawBase64) throw new Error('图片数据为空');

  if (ext !== 'gif') {
    const mime = MIME_MAP[ext] || 'image/jpeg';
    return { images: [`data:${mime};base64,${rawBase64}`], animated: false, totalFrames: 1 };
  }

  const result = await extractGifFrames(Buffer.from(rawBase64, 'base64'));
  return { images: result.frames, animated: result.totalFrames > 1, totalFrames: result.totalFrames };
}
