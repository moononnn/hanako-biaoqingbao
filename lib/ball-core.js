import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeBallText(value, maxLength = 1000) {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
  return text.slice(0, Math.max(0, Number(maxLength) || 0));
}

export function normalizePinnedIds(ids, meta) {
  const available = new Set(
    (Array.isArray(meta) ? meta : [])
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean),
  );
  const pinnedIds = [];
  for (const value of Array.isArray(ids) ? ids : []) {
    const id = String(value || '').trim();
    if (!id || !available.has(id) || pinnedIds.includes(id)) continue;
    pinnedIds.push(id);
  }
  return { version: 1, pinnedIds };
}

// 悬浮球图集重排校验：newIds 必须是 currentIds 的同一集合（只调序，不增删），返回规范化后的顺序或错误信息。
export function validatePinnedReorder(newIds, currentIds) {
  const current = (Array.isArray(currentIds) ? currentIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const incoming = (Array.isArray(newIds) ? newIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!current.length) return { ok: false, error: '悬浮球图集是空的，没得排' };
  if (!incoming.length) return { ok: false, error: '新的顺序是空的，不能保存' };
  if (incoming.length !== current.length) {
    return { ok: false, error: `顺序数量不对：当前 ${current.length} 张，收到 ${incoming.length} 张` };
  }
  const seen = new Set();
  for (const id of incoming) {
    if (seen.has(id)) return { ok: false, error: '顺序里有重复的表情包' };
    seen.add(id);
  }
  const currentSet = new Set(current);
  for (const id of incoming) {
    if (!currentSet.has(id)) return { ok: false, error: '顺序里混进了不在图集里的表情包' };
  }
  return { ok: true, pinnedIds: incoming };
}

export function safeStickerPath(stickersRoot, fileName) {
  if (!stickersRoot || typeof fileName !== 'string' || !fileName.trim()) return null;
  const raw = fileName.trim();
  // 在 Linux CI 上也要识别 Windows 盘符/UNC 绝对路径，不能让它被当成普通文件名拼进 stickers 目录。
  if (raw.includes(String.fromCharCode(0))
    || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
  const root = path.resolve(stickersRoot);
  // 统一两种分隔符，跨平台拦住 `..\\secret` 这类 Windows 写法。
  const candidate = path.resolve(root, raw.split(String.fromCharCode(92)).join('/'));
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;

  // 词法路径只能挡住 `..`，挡不住图库内部的 junction/symlink。根目录本身也必须是
  // 真实目录，避免把一个指向图库外的 junction 当成可信边界；不存在的根目录允许写入时创建。
  const realpath = (value) => {
    const resolver = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
    return resolver(value);
  };
  const samePath = (left, right) => {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return path.relative(a, b) === '' && path.relative(b, a) === '';
  };
  let rootReal = root;
  if (fs.existsSync(root)) {
    try {
      rootReal = realpath(root);
      if (!samePath(root, rootReal)) return null;
    } catch {
      return null;
    }
  }

  // 目标已存在时解析目标本身；写入新文件时解析最近的已存在祖先，
  // 这样父目录中的 junction/symlink 也会被纳入真实路径边界检查。
  let candidateReal;
  try {
    if (fs.existsSync(candidate)) {
      candidateReal = realpath(candidate);
    } else {
      let ancestor = path.dirname(candidate);
      while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
      }
      candidateReal = path.resolve(realpath(ancestor), path.relative(ancestor, candidate));
    }
  } catch {
    return null;
  }
  const realRelative = path.relative(rootReal, candidateReal);
  if (realRelative === ''
    || realRelative.startsWith('..' + path.sep)
    || realRelative === '..'
    || path.isAbsolute(realRelative)) return null;
  return candidate;
}

function cleanMetaText(value, maxLength) {
  return sanitizeBallText(value, maxLength).replace(/[【】\[\]]/g, '');
}

// 语义块：人工标签的权威描述，永远跟着消息走（不依赖模型能力）。
function makeSemantic(sticker) {
  const description = cleanMetaText(sticker?.description || sticker?.file || '表情包', 120);
  const tags = sticker?.tags || {};
  const emotions = (Array.isArray(tags.emotion) ? tags.emotion : []).map((item) => cleanMetaText(item, 30)).filter(Boolean);
  const scenes = (Array.isArray(tags.scene) ? tags.scene : []).map((item) => cleanMetaText(item, 30)).filter(Boolean);
  const keywords = (Array.isArray(tags.keywords) ? tags.keywords : []).map((item) => cleanMetaText(item, 30)).filter(Boolean);
  const tagText = [...emotions, ...scenes, ...keywords].join('/') || '无额外标签';
  return `【表情包「${description}」：${tagText}】`;
}

// 只放进 session:send 的 context，不进入可见消息或会话历史。
export function buildSemanticContext({ sticker }) {
  return [
    '这是表情包插件附带的图片。下面是已经确认的标题和标签，只用于本轮理解，不显示给用户。',
    makeSemantic(sticker),
    '请直接结合这些语义理解用户消息，不要在回复中复述这段内部标签，也不要再次读取或识别图片文件。',
  ].join('\n');
}

// 附件显示暗号：带 [SessionFile] + [attached_image] 标记，前端会把它还原成用户侧原图。
// 语义改由 buildSemanticContext 注入，避免标题/标签落进用户可见正文。
export function buildAttachmentMessage({ fileId, sessionPath, sessionId, stagedPath, sticker, text }) {
  if (!fileId || !sessionPath || !sessionId || !stagedPath) {
    throw new Error('图片登记信息不完整');
  }
  const body = sanitizeBallText(text, 2000);
  const attachment = `[SessionFile] ${JSON.stringify({
    fileId: String(fileId),
    sessionPath: String(sessionPath),
    sessionId: String(sessionId),
    label: String(sticker?.file || 'sticker'),
    kind: 'attachment',
  })}`;
  const image = `[attached_image: ${String(stagedPath)}]`;
  return [attachment, image, body].filter(Boolean).join('\n\n');
}

// 组合悬浮球发送 payload：附件暗号负责用户侧原图，images 只做登记失败时的最后兜底。
export function buildBallSendPayload({ sessionPath, sticker, text, staged, images }) {
  const usableImages = Array.isArray(images) ? images.filter((item) => item?.type === 'image' && item?.data) : [];
  const hasDisplayAttachment = Boolean(staged?.fileId && staged?.sessionId && staged?.stagedPath);
  if (!hasDisplayAttachment && !usableImages.length) throw new Error('图片读取和登记都失败');
  return {
    text: hasDisplayAttachment
      ? buildAttachmentMessage({
          fileId: staged.fileId,
          sessionPath,
          sessionId: staged.sessionId,
          stagedPath: staged.stagedPath,
          sticker,
          text,
        })
      : (sanitizeBallText(text, 2000) || '\u200B'),
    sessionPath,
    context: {
      afterUser: [{
        label: 'biaoqingbao-sticker-semantic',
        text: buildSemanticContext({ sticker }),
      }],
    },
    ...(!hasDisplayAttachment && usableImages.length ? { images: usableImages } : {}),
  };
}

export function createRequestId() {
  return `ball-${crypto.randomUUID()}`;
}

// 会话文件登记目录：与 Hana 托管目录命名一致（sha256("id:" + sessionId) 前 24 位）
export function sessionFileDirFor({ hanaHome, sessionId }) {
  if (!hanaHome || typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const hash = crypto.createHash('sha256').update(`id:${sessionId.trim()}`).digest('hex').slice(0, 24);
  // 测试和部分宿主配置可能在非 Windows 环境中携带 Windows 风格的 Hana 路径。
  const joiner = /^[A-Za-z]:[\\\\/]/.test(String(hanaHome)) || String(hanaHome).startsWith('\\\\')
    ? path.win32
    : path;
  return joiner.join(hanaHome, 'session-files', hash);
}

// 把表情包复制到会话的 session-files 托管目录，返回托管路径；失败返回 null（调用方退化原路径）
export function materializeStickerCopy({ hanaHome, sessionId, srcPath, fileName }) {
  const dir = sessionFileDirFor({ hanaHome, sessionId });
  if (!dir || !srcPath) return null;
  try {
    const safeSrc = path.resolve(String(srcPath));
    if (!fs.existsSync(safeSrc) || !fs.statSync(safeSrc).isFile()) return null;
    fs.mkdirSync(dir, { recursive: true });
    const base = String(fileName || path.basename(safeSrc) || 'sticker').replace(/[^A-Za-z0-9._-]/g, '_');
    const name = `${Date.now()}_${base}`;
    const dest = path.join(dir, name);
    fs.copyFileSync(safeSrc, dest);
    return dest;
  } catch {
    return null;
  }
}

// 从会话文件头部读出 sessionId（jsonl 消息里带）
// v0.33.81 - 加固：优先匹配 sess_ 前缀的会话 ID（媒体项/消息里），避免正则碰巧命中其他字段；
// 再兑底从文件名（Hana 会话文件名含时间戳_UUID，UUID 非 sess_ 格式）提取不到时返回 null。
// ── 悬浮球运行期心跳（Python 上报 → Node 判活）──
// 纯逻辑：不依赖真实进程/网络，可单测。
// 判活规则：
//   - 收到心跳 → 记 lastHeartbeat，connected = true
//   - 距上次心跳超过 staleAfterMs → 判定失联（不再区分进程活着与否，统一标记 connected=false）
//   - reset() 重置（重启/主动停止时调用）
export function createHeartbeatTracker({ staleAfterMs = 45000 } = {}) {
  return {
    staleAfterMs,
    lastHeartbeat: null,
    connected: false,
    beat() {
      this.lastHeartbeat = Date.now();
      this.connected = true;
    },
    isStale(now = Date.now()) {
      if (!this.lastHeartbeat) return false; // 从未心跳，不判失联（可能还没启动完）
      return now - this.lastHeartbeat > this.staleAfterMs;
    },
    sync(now = Date.now()) {
      if (this.isStale(now)) this.connected = false;
      return this.connected;
    },
    reset() {
      this.lastHeartbeat = null;
      this.connected = false;
    },
  };
}

export function readSessionIdFromFile(sessionPath) {
  try {
    const fd = fs.openSync(sessionPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytesRead).toString('utf8');
    // 会话 ID 统一是 sess_ 前缀（recent-match 也按此存储）；
    // 同时兼容无媒体消息的会话：文件名形如 <时间戳>_<UUID>.jsonl，UUID 不是 sess_，
    // 此时返回 null，调用方应改用权威 sessionId（前端显式传）。
    const m = head.match(/"sessionId"\s*:\s*"(sess_[^"]+)"/);
    if (m && m[1]) return m[1];
  } catch {
    // 忽略：调用方会退化
  }
  return null;
}
