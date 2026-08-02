import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genId, atomicWriteJson } from '../lib/shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const metaPath = join(__dirname, '..', 'data', 'stickers.json');
const stickersDir = join(__dirname, '..', 'stickers');

const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "add_sticker";
export const description = "添加新表情包到库中。传入本地图片路径和标签信息，插件会复制图片到库目录并记录元数据";
export const parameters = {
  type: "object",
  properties: {
    sourcePath: { type: "string", description: "图片文件的本地绝对路径" },
    emotion: { type: "string", description: "情绪标签，多个用逗号分隔，如 '开心,感动,可爱'" },
    scene: { type: "string", description: "场景标签，多个用逗号分隔，如 '早安,恭喜,打气'" },
    keywords: { type: "string", description: "关键词，多个用逗号分隔" },
    description: { type: "string", description: "一句话描述这张表情包的感觉" }
  },
  required: ["sourcePath"]
};

export async function execute(input, ctx) {
  const { sourcePath, emotion = '', scene = '', keywords = '', description = '' } = input || {};

  if (!sourcePath) return reply({ ok: false, error: '请提供图片路径' });

  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const originalFile = parts[parts.length - 1];
  const ext = originalFile.split('.').pop().toLowerCase();

  if (!ALLOWED_EXTS.includes(ext)) {
    return reply({ ok: false, error: `不支持的文件格式: .${ext}，支持: ${ALLOWED_EXTS.join(', ')}` });
  }

  const id = genId();
  const fileName = `${id}.${ext}`;
  const destPath = join(stickersDir, fileName);

  try {
    await copyFile(sourcePath, destPath);
  } catch (e) {
    return reply({ ok: false, error: `复制文件失败: ${e.message}` });
  }

  let stickers = [];
  try {
    const raw = await readFile(metaPath, 'utf-8');
    stickers = JSON.parse(raw);
  } catch { /* 新库 */ }

  const entry = {
    id,
    file: fileName,
    description: description || originalFile.replace(`.${ext}`, ''),
    tags: {
      emotion: emotion ? emotion.split(',').map(s => s.trim()).filter(Boolean) : [],
      scene: scene ? scene.split(',').map(s => s.trim()).filter(Boolean) : [],
      keywords: keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : []
    },
    added_at: new Date().toISOString()
  };

  stickers.push(entry);
  // v0.19.5 - 原子写，避免崩溃留下半截图库文件
  atomicWriteJson(metaPath, stickers);

  return reply({
    ok: true,
    data: {
      id: entry.id,
      file: fileName,
      description: entry.description,
      tags: entry.tags
    },
    message: `表情包「${entry.description}」已入库`
  });
}
