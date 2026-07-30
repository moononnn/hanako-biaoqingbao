import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME_MAP } from '../lib/shared.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const metaPath = join(__dirname, '..', 'data', 'stickers.json');
const stickersDir = join(__dirname, '..', 'stickers');

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// v0.11.0 — pick_sticker 重命名为 peek_sticker_for_render（内部工具）
// 原因：返回 base64 误导助手以为可以拿来发图，实际助手应该直接调 express
// 助手调用路径：search_stickers → express（不用 peek_sticker_for_render）

export const name = "peek_sticker_for_render";
export const description = "⚠️ 内部工具 - 仅供渲染层使用。获取指定表情包的图片数据（base64 data URL）。助手请直接调 express 工具发表情包，不要调这个。";
export const parameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "表情包ID" }
  },
  required: ["id"]
};

export async function execute(input, ctx) {
  const { id } = input || {};
  if (!id) return reply({ ok: false, error: '请提供表情包ID' });

  let stickers = [];
  try {
    const raw = await readFile(metaPath, 'utf-8');
    stickers = JSON.parse(raw);
  } catch {
    return reply({ ok: false, error: '表情包库为空' });
  }

  const sticker = stickers.find(s => s.id === id);
  if (!sticker) return reply({ ok: false, error: `未找到ID为 "${id}" 的表情包` });

  const filePath = join(stickersDir, sticker.file);
  let buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return reply({ ok: false, error: `图片文件 ${sticker.file} 不存在或无法读取` });
  }

  const ext = sticker.file.split('.').pop().toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const base64 = buffer.toString('base64');
  const url = `data:${mime};base64,${base64}`;
  return reply({
    ok: true,
    data: {
      id: sticker.id,
      file: sticker.file,
      url,
      filePath,
      description: sticker.description,
      mime
    }
  });
}
