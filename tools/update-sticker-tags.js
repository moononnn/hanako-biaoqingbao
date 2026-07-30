import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const metaPath = join(__dirname, '..', 'data', 'stickers.json');

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "update_sticker_tags";
export const description = "修改已有表情包的标签信息";
export const parameters = {
  type: "object",
  properties: {
    id: { type: "string", description: "表情包ID" },
    emotion: { type: "string", description: "情绪标签，多个用逗号分隔" },
    scene: { type: "string", description: "场景标签，多个用逗号分隔" },
    keywords: { type: "string", description: "关键词，多个用逗号分隔" },
    description: { type: "string", description: "新描述" }
  },
  required: ["id"]
};

export async function execute(input, ctx) {
  const { id, emotion, scene, keywords, description } = input || {};
  if (!id) return reply({ ok: false, error: '请提供表情包ID' });

  let stickers = [];
  try {
    const raw = await readFile(metaPath, 'utf-8');
    stickers = JSON.parse(raw);
  } catch {
    return reply({ ok: false, error: '表情包库为空' });
  }

  const idx = stickers.findIndex(s => s.id === id);
  if (idx === -1) return reply({ ok: false, error: `未找到ID为 "${id}" 的表情包` });

  const sticker = stickers[idx];

  if (emotion !== undefined) {
    sticker.tags.emotion = emotion ? emotion.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  if (scene !== undefined) {
    sticker.tags.scene = scene ? scene.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  if (keywords !== undefined) {
    sticker.tags.keywords = keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  if (description !== undefined) {
    sticker.description = description;
  }

  await writeFile(metaPath, JSON.stringify(stickers, null, 2), 'utf-8');

  return reply({ ok: true, data: sticker, message: `表情包「${sticker.description}」标签已更新` });
}
