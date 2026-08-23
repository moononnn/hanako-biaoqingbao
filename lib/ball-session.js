import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
const BACKWARD_CHUNK_SIZE = 64 * 1024;

// 从文件尾按完整 JSONL 行向前扫描。不能固定只读最后一段字节：
// 长会话里一条助手回复/工具结果就可能把最新用户消息推到窗口之外，
// 纸飞机随后会误选旧会话或读到空上下文（与解语花同源问题）。
function decodeLineParts(parts) {
  const nonEmpty = parts.filter((part) => part && part.length > 0);
  if (!nonEmpty.length) return '';
  if (nonEmpty.length === 1) return nonEmpty[0].toString('utf-8');
  return Buffer.concat(nonEmpty).toString('utf-8');
}

function forEachLineFromEnd(filePath, callback) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    let position = stat.size;
    // 保存“较旧前缀 + 已读到的较新部分”，只在真正找到换行时拼一次。
    // 不能每读 64KB 都 Buffer.concat(carry)，否则超长单行会退化成 O(n²) 拷贝。
    let carryParts = [];
    while (position > 0) {
      const readSize = Math.min(BACKWARD_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);

      let lineEnd = chunk.length;
      let foundNewline = false;
      const newerParts = carryParts;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        const line = decodeLineParts([
          chunk.subarray(i + 1, lineEnd),
          ...(!foundNewline ? newerParts : []),
        ]);
        if (line.trim() && callback(line)) return true;
        lineEnd = i;
        foundNewline = true;
      }

      const olderPrefix = chunk.subarray(0, lineEnd);
      carryParts = olderPrefix.length
        ? (foundNewline ? [olderPrefix] : [olderPrefix, ...newerParts])
        : [];
    }
    const finalLine = decodeLineParts(carryParts);
    return finalLine.length > 0 && callback(finalLine);
  } finally {
    fs.closeSync(fd);
  }
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric > 0 && numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function messageOf(entry) {
  return entry?.message && typeof entry.message === 'object' ? entry.message : entry;
}

const INVISIBLE_TEXT = /[\u200B-\u200D\uFEFF]/g;

function cleanUserText(value) {
  return String(value ?? '').replace(INVISIBLE_TEXT, '');
}

function hasUserMedia(message) {
  return Array.isArray(message?.content)
    && message.content.some((part) => ['image', 'video', 'audio'].includes(part?.type));
}

function hasUserText(message) {
  if (typeof message?.content === 'string') return cleanUserText(message.content).trim().length > 0;
  if (Array.isArray(message?.content)) {
    return hasUserMedia(message) || message.content.some(
      (part) => part?.type === 'text' && typeof part.text === 'string' && cleanUserText(part.text).trim(),
    );
  }
  return false;
}

function lastUserMessageTime(filePath) {
  try {
    let found = 0;
    forEachLineFromEnd(filePath, (line) => {
      try {
        const entry = JSON.parse(line);
        const message = messageOf(entry);
        if (message?.role !== 'user' || !hasUserText(message)) return false;
        found = parseTimestamp(entry.timestamp ?? entry.ts ?? message.timestamp);
        return true;
      } catch {
        // A truncated or malformed line must not block older valid messages.
        return false;
      }
    });
    return found;
  } catch {
    // The session may disappear while Hana rotates or archives it.
  }
  return 0;
}

function userMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

export function lastUserMessageText(filePath, maxLength = 120) {
  try {
    let result = '';
    forEachLineFromEnd(filePath, (line) => {
      try {
        const entry = JSON.parse(line);
        const message = messageOf(entry);
        if (message?.role !== 'user' || !hasUserText(message)) return false;
        const text = cleanUserText(userMessageText(message)).replace(/\s+/g, ' ').trim();
        if (text) {
          result = text.length > maxLength ? text.slice(0, maxLength) : text;
        } else if (hasUserMedia(message)) {
          result = '图片消息';
        }
        return true;
      } catch {
        // A truncated or malformed line must not block older valid messages.
        return false;
      }
    });
    return result;
  } catch {
    // The session may disappear while Hana rotates or archives it.
  }
  return '';
}

export function isDesktopSessionPath(sessionPath, { hanaHome = DEFAULT_HANA_HOME } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath.toLowerCase().endsWith('.jsonl')) return false;
  const root = path.resolve(hanaHome, 'agents');
  const candidate = path.resolve(sessionPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  return parts.length === 3 && parts[1] === 'sessions' && /^[A-Za-z0-9_-]+$/.test(parts[0]);
}

// ─── 粗筛：返回 sessionsDir 下按 mtime 降序的前 maxScan 个 jsonl 候选 ───
// 不读文件内容，只 stat 拿 mtime。最后一条用户消息必然发生在最近读写过的文件里，
// 所以只对候选读尾部找最后用户消息，不必扫全部会话文件（对几百文件的助手省 90%+ IO）。
function recentSessionCandidates(sessionsDir, maxScan = 60) {
  let entries = [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const de of files) {
    if (!de.isFile() || !de.name.toLowerCase().endsWith('.jsonl')) continue;
    const full = path.join(sessionsDir, de.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({ full, mtime: st.mtimeMs, size: st.size });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, maxScan);
}

const MAX_SCAN_CANDIDATES = 60;

export function listRecentSessions({ hanaHome = DEFAULT_HANA_HOME, allowedPaths = null, limit = 5 } = {}) {
  const agentsRoot = path.join(hanaHome, 'agents');
  const list = [];
  try {
    const agents = fs.readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name));
    for (const agent of agents) {
      const sessionsDir = path.join(agentsRoot, agent.name, 'sessions');
      const candidates = recentSessionCandidates(sessionsDir, MAX_SCAN_CANDIDATES);
      for (const { full: sessionPath, mtime: modifiedAt, size } of candidates) {
        try {
          if (size === 0) continue;
          if (allowedPaths instanceof Set && !allowedPaths.has(path.normalize(sessionPath))) continue;
          const lastUserAt = lastUserMessageTime(sessionPath);
          list.push({
            agentId: agent.name,
            sessionPath,
            lastUserAt,
            modifiedAt,
            title: lastUserMessageText(sessionPath, 20),
          });
        } catch {
          // The file can vanish between readdir and stat.
        }
      }
    }
  } catch {
    return [];
  }
  list.sort((a, b) => {
    const activeA = a.lastUserAt || a.modifiedAt;
    const activeB = b.lastUserAt || b.modifiedAt;
    if (activeB !== activeA) return activeB - activeA;
    return `${a.agentId}/${a.sessionPath}`.localeCompare(`${b.agentId}/${b.sessionPath}`);
  });
  return list.slice(0, limit);
}

export function findMostActiveSession({ hanaHome = DEFAULT_HANA_HOME, allowedPaths = null } = {}) {
  const agentsRoot = path.join(hanaHome, 'agents');
  const userCandidates = [];
  const fallbackCandidates = [];
  try {
    const agents = fs.readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name));
    for (const agent of agents) {
      const sessionsDir = path.join(agentsRoot, agent.name, 'sessions');
      const candidates = recentSessionCandidates(sessionsDir, MAX_SCAN_CANDIDATES);
      for (const { full: sessionPath, mtime: modifiedAt } of candidates) {
        try {
          if (allowedPaths instanceof Set && !allowedPaths.has(path.normalize(sessionPath))) continue;
          const lastUserAt = lastUserMessageTime(sessionPath);
          const item = {
            agentId: agent.name,
            sessionPath,
            lastUserAt,
            modifiedAt,
          };
          if (lastUserAt > 0) userCandidates.push(item);
          else fallbackCandidates.push(item);
        } catch {
          // The file can vanish between readdir and stat.
        }
      }
    }
  } catch {
    return null;
  }

  const candidates = userCandidates.length ? userCandidates : fallbackCandidates;
  candidates.sort((a, b) => {
    const primary = userCandidates.length ? b.lastUserAt - a.lastUserAt : b.modifiedAt - a.modifiedAt;
    if (primary !== 0) return primary;
    return `${a.agentId}/${a.sessionPath}`.localeCompare(`${b.agentId}/${b.sessionPath}`);
  });
  return candidates[0] || null;
}

export { parseTimestamp, lastUserMessageTime };
