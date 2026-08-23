// lib/image-size.js - 零依赖图片尺寸解析（仅读文件头）
//
// v0.32.3 - 配图卡片要按图片实际尺寸动态算 aspectRatio（宿主槽位尺寸只认 aspectRatio，
// 不响应 iframe 内 resize 上报）。读图库文件头拿宽高：PKG 常用 png/jpg/gif/webp，
// 全部只解析包头，绝不读整图。
//
// 导出：
//   imageSizeFromBuffer(buf) -> { width, height } | null  同步，buffer 已在内存（express 发图路径）
//   readImageSize(filePath)  -> Promise<{ width, height } | null>  按路径读（其它路径备用）
import { readFile } from 'node:fs/promises';

/**
 * 从图片字节流解析宽高。支持 PNG / JPEG / GIF / WebP / BMP。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function imageSizeFromBuffer(buf) {
  if (!buf || buf.length < 10) return null;
  try {
    // PNG: 签名 8B + IHDR 块（type 在偏移 12，数据起始 16：width BE32 / height BE32），至少 24B
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return sane(width, height);
    }
    // GIF: 'GIF87a' / 'GIF89a'，逻辑屏幕宽高 LE16（10B 即可）
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF' && buf[3] === 0x38) {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      return sane(width, height);
    }
    // JPEG: 扫到 SOF0/1/2（C0/C1/C2）取 height/width（BE16）
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        // 独立标记（无长度段）
        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
          off += 2;
          continue;
        }
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) return null;
        // SOF（非差分哈夫曼 SOF4=0xC4 排除；C0-C3/C5-C7 是 SOF；C4=DHT, C8=JPG, C9-CC 也算 SOF）
        const sof = (marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB);
        if (sof) {
          const height = buf.readUInt16BE(off + 5);
          const width = buf.readUInt16BE(off + 7);
          return sane(width, height);
        }
        off += 2 + segLen;
      }
      return null;
    }
    // WebP: 'RIFF' + size + 'WEBP'（先嗅探，再按容器查各自长度）
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8X' && buf.length >= 30) {
        // 24 起 canvas width LE24 +1，27 起 canvas height LE24 +1
        const width = buf.readUIntLE(24, 3) + 1;
        const height = buf.readUIntLE(27, 3) + 1;
        return sane(width, height);
      }
      if (fourCC === 'VP8L' && buf.length >= 25 && buf[20] === 0x2F) {
        // 21 起 4B：宽 14bit / 高 14bit（均 -1 存储）
        const width = 1 + (((buf[22] & 0x3F) << 8) | buf[21]);
        const height = 1 + (((buf[24] & 0x0F) << 10) | (buf[23] << 2) | ((buf[22] & 0xC0) >> 6));
        return sane(width, height);
      }
      if (fourCC === 'VP8 ' && buf.length >= 30) {
        // 26 起 width LE16 & 0x3FFF（14bit），28 起 height LE16 & 0x3FFF
        const width = buf.readUInt16LE(26) & 0x3FFF;
        const height = buf.readUInt16LE(28) & 0x3FFF;
        return sane(width, height);
      }
      return null;
    }
    // BMP: 18 宽 LE32，22 高 LE32（高度可为负，取绝对值），至少 26B
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      const width = buf.readUInt32LE(18);
      const height = Math.abs(buf.readInt32LE(22));
      return sane(width, height);
    }
    return null;
  } catch {
    return null;
  }
}

function sane(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return null;
  return { width, height };
}

/** 按路径读文件头解析尺寸；文件缺失/损坏/不支持均返回 null（调用方回退默认值）。 */
export async function readImageSize(filePath) {
  try {
    const buf = await readFile(filePath);
    return imageSizeFromBuffer(buf);
  } catch {
    return null;
  }
}