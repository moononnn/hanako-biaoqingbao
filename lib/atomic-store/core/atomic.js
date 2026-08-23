// atomic-store · 原子写入工具
// 零依赖：只用 node:fs / node:path / node:crypto

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 去掉 UTF-8 BOM（\uFEFF）。
 * PowerShell 和部分编辑器写文件会自带 BOM，直接 JSON.parse 会炸（坑 40）。
 */
export function stripBOM(text) {
  if (typeof text !== "string") return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 把字符串原子写入文件：
 * 1. 先写同目录临时文件（写完整 + fsync 落盘）
 * 2. rename 覆盖目标（同卷 rename 是原子操作，不会出现半截文件）
 * 3. 失败时清理临时文件再抛错，不留垃圾
 */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // 目标目录可能不存在（首次启动 / 测试用全新 dataDir），自动建
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, content, null, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
