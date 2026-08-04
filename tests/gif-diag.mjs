// 诊断：扫描所有 GIF 的结构（循环扩展、帧数、尺寸），找出 stk_315 与正常 GIF 的差异
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import omggif from '../lib/vendor/omggif.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stickersDir = path.join(here, '..', 'stickers');

function parseStructure(buf) {
  // 基础头
  const header = buf.toString('ascii', 0, 6);
  // 逻辑屏幕描述符
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = gctFlag ? 2 ** ((packed & 0x07) + 1) : 0;
  let pos = 13 + (gctFlag ? gctSize * 3 : 0);
  // 遍历块
  let netscape = null;      // 循环扩展
  let appExts = [];
  let frameCount = 0;
  let blockTypes = [];
  let lastBlock = '';
  const end = buf.length;
  while (pos < end) {
    const b = buf[pos];
    if (b === 0x3B) { lastBlock = 'trailer'; pos++; break; }   // 结束
    if (b === 0x21) { // 扩展
      const label = buf[pos + 1];
      if (label === 0xF9) { blockTypes.push('GCE'); pos += 2; const sz = buf[pos]; pos += 1 + sz + 1; }
      else if (label === 0xFF) { // 应用扩展
        pos += 2;
        const sz = buf[pos];
        const appData = buf.toString('ascii', pos + 1, pos + 1 + Math.min(sz, 11));
        if (appData.startsWith('NETSCAPE')) {
          // NETSCAPE2.0: 之后是块大小 + 子块 (loop count)
          let p2 = pos + 1 + sz;
          const subSize = buf[p2];
          const loop = subSize >= 3 ? buf.readUInt16LE(p2 + 2) : null;
          netscape = { loop, blockSize: sz };
          blockTypes.push('NETSCAPE(loop=' + loop + ')');
        } else {
          blockTypes.push('APP:' + appData.slice(0, 8));
        }
        pos += 1 + sz;
        // 跳过子块
        while (pos < end) {
          const sz2 = buf[pos];
          pos += 1 + sz2;
          if (sz2 === 0) break;
        }
      }
      else if (label === 0xFE) { blockTypes.push('COMMENT'); pos += 2; while (pos < end) { const sz2 = buf[pos]; pos += 1 + sz2; if (sz2 === 0) break; } }
      else { blockTypes.push('EXT:' + label.toString(16)); pos += 2; while (pos < end) { const sz2 = buf[pos]; pos += 1 + sz2; if (sz2 === 0) break; } }
      continue;
    }
    if (b === 0x2C) { // 图像描述符
      frameCount++;
      blockTypes.push('IMG' + frameCount);
      pos += 10; // 描述符 9 字节 + 1 字节 LZW 最小码
      // 跳过 LZW 数据
      while (pos < end) {
        const sz2 = buf[pos];
        pos += 1 + sz2;
        if (sz2 === 0) break;
      }
      continue;
    }
    blockTypes.push('UNKNOWN:' + b.toString(16));
    pos++;
  }
  return { header, width, height, gctFlag, netscape, frameCount, blockTypes, lastBlock, fileEnd: buf.length };
}

const files = fs.readdirSync(stickersDir).filter(f => f.endsWith('.gif'));
const results = [];
for (const f of files) {
  try {
    const buf = fs.readFileSync(path.join(stickersDir, f));
    const info = parseStructure(buf);
    // 用 omggif 读帧数
    let omgFrames = 0;
    try { omgFrames = new omggif.GifReader(buf).numFrames(); } catch { omgFrames = -1; }
    results.push({ file: f, size: buf.length, ...info, omgFrames });
  } catch (e) {
    results.push({ file: f, error: e.message });
  }
}

// 输出概要
for (const r of results) {
  if (r.error) { console.log(`${r.file}: ERROR ${r.error}`); continue; }
  const netscape = r.netscape ? `loop=${r.netscape.loop}` : 'NO-NETSCAPE';
  console.log(`${r.file}: size=${r.size} ${r.header} ${r.width}x${r.height} frames=${r.omgFrames} ${netscape} last=${r.lastBlock}`);
}
