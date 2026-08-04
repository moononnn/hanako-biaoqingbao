// 修复 GIF：给缺少 NETSCAPE 2.0 循环扩展的 GIF 插入无限循环标记（loop=0）
// 用法：node fix-gif-loop.mjs <file> [--check]
import fs from 'node:fs';
import omggif from '../lib/vendor/omggif.cjs';

const file = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!file) { console.error('usage: node fix-gif-loop.mjs <file> [--check]'); process.exit(1); }

const buf = fs.readFileSync(file);

// 校验基础头
const header = buf.toString('ascii', 0, 6);
if (header !== 'GIF87a' && header !== 'GIF89a') { console.error('NOT A GIF:', header); process.exit(1); }

const packed = buf[10];
const gctFlag = (packed & 0x80) !== 0;
const gctSize = gctFlag ? 2 ** ((packed & 0x07) + 1) : 0;
let pos = 13 + (gctFlag ? gctSize * 3 : 0);

// 扫描已有扩展块，找 NETSCAPE
let hasNetscape = false;
let scan = pos;
while (scan < buf.length) {
  const b = buf[scan];
  if (b === 0x2C || b === 0x3B) break; // 遇到图像或结尾，扩展区结束
  if (b === 0x21) {
    const label = buf[scan + 1];
    if (label === 0xFF) {
      const sz = buf[scan + 2];
      const appData = buf.toString('ascii', scan + 3, scan + 3 + Math.min(sz, 11));
      if (appData.startsWith('NETSCAPE')) hasNetscape = true;
      scan += 2 + sz + 1;
      while (scan < buf.length) { const s2 = buf[scan]; scan += 1 + s2; if (s2 === 0) break; }
    } else {
      scan += 2;
      while (scan < buf.length) { const s2 = buf[scan]; scan += 1 + s2; if (s2 === 0) break; }
    }
  } else break;
}

// 用 omggif 验证帧数
let frames = 0;
try { frames = new omggif.GifReader(buf).numFrames(); } catch (e) { console.error('omggif parse failed:', e.message); process.exit(1); }

if (hasNetscape) {
  console.log(`OK: ${file} 已有 NETSCAPE 循环扩展，无需修复（frames=${frames}）`);
  process.exit(0);
}
if (checkOnly) {
  console.log(`MISSING: ${file} 缺少 NETSCAPE 循环扩展（frames=${frames}）`);
  process.exit(1);
}
if (frames <= 1) {
  console.log(`SKIP: ${file} 只有 ${frames} 帧，不是动画，无需循环扩展`);
  process.exit(0);
}

// 插入 NETSCAPE2.0 无限循环扩展（标准字节序列）
// 21 FF 0B "NETSCAPE2.0" 03 01 00 00 00
const loopExt = Buffer.concat([
  Buffer.from([0x21, 0xFF, 0x0B]),
  Buffer.from('NETSCAPE2.0', 'ascii'),
  Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
]);
const fixed = Buffer.concat([buf.subarray(0, pos), loopExt, buf.subarray(pos)]);
fs.writeFileSync(file, fixed);
console.log(`FIXED: ${file} 已插入无限循环扩展（原 ${buf.length} 字节 → 新 ${fixed.length} 字节, frames=${frames}）`);
