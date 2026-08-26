import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRaw } from 'node:zlib';

export const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
export const MAX_ENTRIES = 2000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_METADATA_BYTES = 4 * 1024 * 1024;

const TRANSFER_METADATA_NAMES = new Set(['stickers.json', 'manifest.json', 'migration.json']);

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readArchiveInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 文件无效或已损坏');

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('找不到 ZIP 目录信息');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || centralDisk !== 0) throw new Error('暂不支持分卷 ZIP');
  if (entryCount > MAX_ENTRIES) throw new Error(`ZIP 内文件过多，最多支持 ${MAX_ENTRIES} 个`);
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP 目录范围异常');

  return { entryCount, centralSize, centralOffset };
}

function normalizeArchiveEntryName(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => part === '..') || parts.slice(0, -1).some((part) => !part)) return null;
  const name = parts.filter((part) => part && part !== '.').join('/');
  return name || null;
}

export function hasImageSignature(buffer, ext) {
  if (ext === 'png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === 'jpg' || ext === 'jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === 'gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  if (ext === 'webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (ext === 'bmp') return buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM';
  return false;
}

// v0.25.0 - 按真实文件签名识别格式（扩展名不可信时兜底：从群/聊天软件复制的动图常被存成 .jpg）
export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  return null;
}

function inflateRawLimited(buffer, maxOutputLength) {
  return new Promise((resolve, reject) => {
    inflateRaw(buffer, { maxOutputLength }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function readEntryData(buffer, entry, maxOutputLength) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error('本地文件头损坏');
  }
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error('压缩数据不完整');

  const compressed = buffer.subarray(dataStart, dataEnd);
  const data = entry.method === 0
    ? Buffer.from(compressed)
    : await inflateRawLimited(compressed, maxOutputLength);
  if (data.length !== entry.uncompressedSize) throw new Error('解压后大小与 ZIP 目录不符');
  if (entry.crc !== undefined && crc32(data) !== entry.crc) throw new Error('CRC 校验失败');
  return data;
}

async function extractArchiveEntries(buffer, wantedNames = new Set()) {
  const { entryCount, centralOffset } = readArchiveInfo(buffer);
  const images = [];
  const files = [];
  const skipped = [];
  let offset = centralOffset;
  let totalBytes = 0;

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('ZIP 目录条目损坏');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error('ZIP 文件名信息损坏');

    const encoding = (flags & 0x0800) ? 'utf8' : 'latin1';
    const rawName = buffer.toString(encoding, offset + 46, nameEnd).replace(/\\/g, '/');
    const entryName = normalizeArchiveEntryName(rawName);
    const fileName = entryName ? path.posix.basename(entryName) : path.posix.basename(rawName);
    const isDirectory = rawName.endsWith('/');
    offset = nameEnd + extraLength + commentLength;

    if (!entryName) {
      skipped.push({ file: fileName || '(未命名文件)', reason: '文件名路径异常' });
      continue;
    }
    if (isDirectory || !fileName) continue;

    const isMetadata = wantedNames.has(entryName);
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    if (!isMetadata && !SUPPORTED_EXTENSIONS.has(ext)) {
      skipped.push({ file: fileName, reason: '不是支持的图片格式' });
      continue;
    }
    if (flags & 0x0001) {
      skipped.push({ file: fileName, reason: '加密文件无法读取' });
      continue;
    }
    if (![0, 8].includes(method)) {
      skipped.push({ file: fileName, reason: '不支持的压缩方式' });
      continue;
    }

    const maxBytes = isMetadata ? MAX_METADATA_BYTES : MAX_IMAGE_BYTES;
    if (uncompressedSize > maxBytes) {
      skipped.push({ file: fileName, reason: isMetadata ? '标签文件超过 4MB' : '单张图片超过 20MB' });
      continue;
    }
    if (!isMetadata) {
      totalBytes += uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('ZIP 解压后的图片总大小超过 200MB');
    }

    try {
      const data = await readEntryData(buffer, {
        localOffset,
        compressedSize,
        uncompressedSize,
        method,
        crc,
      }, maxBytes);
      if (isMetadata) {
        files.push({ entryName, fileName, data });
        continue;
      }
      // ZIP 文件名的扩展名也不可信：表情包缓存里常见“内容是 PNG、文件名却是 JPG”的情况。
      // 入库时按真实签名选新扩展名，迁移包因此不会把原图库里的错扩展名继续带过去。
      const detectedExt = detectImageFormat(data);
      if (!detectedExt) {
        skipped.push({ file: fileName, reason: '图片内容与格式不符' });
        continue;
      }
      images.push({ fileName, entryName, ext: detectedExt, sourceExt: ext, data });
    } catch {
      skipped.push({ file: fileName, reason: isMetadata ? '标签文件解压失败' : '解压失败' });
    }
  }

  return { images, files, skipped };
}

export async function extractImagesFromZip(buffer) {
  const result = await extractArchiveEntries(buffer);
  return { images: result.images, skipped: result.skipped };
}

// 表情包迁移包：在普通图片 ZIP 的基础上，额外读取根目录 stickers.json / manifest.json。
export async function extractStickerArchive(buffer) {
  const result = await extractArchiveEntries(buffer, TRANSFER_METADATA_NAMES);
  let metadata = null;
  let metadataFound = false;
  let manifest = null;
  let manifestFound = false;
  let manifestError = '';
  let migration = null;
  let migrationFound = false;
  let metadataError = '';
  let migrationError = '';

  for (const file of result.files) {
    if (file.entryName === 'stickers.json' && !metadataFound) {
      metadataFound = true;
      try {
        metadata = JSON.parse(file.data.toString('utf8'));
      } catch {
        metadataError = '标签文件格式无效';
        result.skipped.push({ file: 'stickers.json', reason: metadataError });
      }
    }
    if (file.entryName === 'manifest.json' && !manifestFound) {
      manifestFound = true;
      try { manifest = JSON.parse(file.data.toString('utf8')); }
      catch { manifestError = 'manifest.json 格式无效'; result.skipped.push({ file: 'manifest.json', reason: manifestError }); }
    }
    if (file.entryName === 'migration.json' && !migrationFound) {
      migrationFound = true;
      try { migration = JSON.parse(file.data.toString('utf8')); }
      catch { migrationError = '迁移数据格式无效'; result.skipped.push({ file: 'migration.json', reason: migrationError }); }
    }
  }

  if (!manifestFound && result.skipped.some((item) => item.file === 'manifest.json' && item.reason === '标签文件解压失败')) {
    manifestFound = true;
    manifestError = 'manifest.json 无法读取';
  }

  return {
    images: result.images,
    skipped: result.skipped,
    metadata,
    metadataFound,
    manifest,
    manifestFound,
    manifestError,
    metadataError,
    migration,
    migrationFound,
    migrationError,
  };
}

// ── 零依赖 ZIP 写入：图片本身已压缩，使用 stored 条目避免重复压缩 ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, safeDate.getFullYear()));
  const dosTime = (safeDate.getHours() << 11) | (safeDate.getMinutes() << 5) | Math.floor(safeDate.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((safeDate.getMonth() + 1) << 5) | safeDate.getDate();
  return { dosTime, dosDate };
}

function normalizeZipPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`ZIP 条目路径无效: ${value}`);
  }
  return normalized;
}

async function writeBuffer(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!result.bytesWritten) throw new Error('ZIP 写入失败');
    offset += result.bytesWritten;
  }
}

export async function writeStoredZip(outputPath, entries, { date = new Date() } = {}) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('缺少 ZIP 输出路径');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP 没有可写入的内容');
  if (entries.length > 0xffff) throw new Error('ZIP 文件条目过多');

  const normalizedEntries = [];
  const names = new Set();
  for (const item of entries) {
    const name = normalizeZipPath(item?.name);
    const nameKey = name.toLowerCase();
    if (names.has(nameKey)) throw new Error(`ZIP 条目重复: ${name}`);
    names.add(nameKey);
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > 0xffff) throw new Error(`ZIP 条目名称过长: ${name}`);
    let data;
    if (item?.data !== undefined) data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    else if (item?.filePath) data = await fs.readFile(item.filePath);
    else throw new Error(`ZIP 条目缺少内容: ${name}`);
    if (data.length > 0xffffffff) throw new Error(`ZIP 条目过大: ${name}`);
    normalizedEntries.push({ name, nameBuffer, data, mtime: item?.mtime });
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const handle = await fs.open(outputPath, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const item of normalizedEntries) {
      const { dosTime, dosDate } = dosDateTime(item.mtime ? new Date(item.mtime) : date);
      const crc = crc32(item.data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(item.data.length, 18);
      local.writeUInt32LE(item.data.length, 22);
      local.writeUInt16LE(item.nameBuffer.length, 26);
      local.writeUInt16LE(0, 28);
      await writeBuffer(handle, local);
      await writeBuffer(handle, item.nameBuffer);
      await writeBuffer(handle, item.data);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(dosTime, 12);
      header.writeUInt16LE(dosDate, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(item.data.length, 20);
      header.writeUInt32LE(item.data.length, 24);
      header.writeUInt16LE(item.nameBuffer.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, item.nameBuffer);

      offset += local.length + item.nameBuffer.length + item.data.length;
      if (offset > 0xffffffff) throw new Error('ZIP 文件超过 4GB，暂不支持');
    }

    const centralOffset = offset;
    const centralBuffer = Buffer.concat(central);
    if (centralBuffer.length > 0xffffffff) throw new Error('ZIP 目录超过 4GB，暂不支持');
    await writeBuffer(handle, centralBuffer);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(normalizedEntries.length, 8);
    end.writeUInt16LE(normalizedEntries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeBuffer(handle, end);
  } finally {
    await handle.close();
  }
}
