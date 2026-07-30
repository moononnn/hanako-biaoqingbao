import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const metaPath = join(__dirname, '..', 'data', 'stickers.json');

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "list_stickers";
export const description = "浏览表情包库中的所有表情包，可按情绪或场景筛选";
export const parameters = {
  type: "object",
  properties: {
    emotion: { type: "string", description: "可选，按情绪筛选，如 '开心,无奈'" },
    scene: { type: "string", description: "可选，按场景筛选，如 '早安,恭喜'" }
  }
};

export async function execute(input, ctx) {
  const { emotion, scene } = input || {};

  let stickers = [];
  try {
    const raw = await readFile(metaPath, 'utf-8');
    stickers = JSON.parse(raw);
  } catch {
    return reply({ ok: true, data: [], total: 0, message: '表情包库为空' });
  }

  let filtered = stickers;

  if (emotion) {
    const emList = emotion.split(',').map(s => s.trim());
    filtered = filtered.filter(s =>
      emList.some(em => (s.tags?.emotion || []).some(tag => tag.includes(em) || em.includes(tag)))
    );
  }

  if (scene) {
    const scList = scene.split(',').map(s => s.trim());
    filtered = filtered.filter(s =>
      scList.some(sc => (s.tags?.scene || []).some(tag => tag.includes(sc) || sc.includes(tag)))
    );
  }

  const result = filtered.map(s => ({
    id: s.id,
    file: s.file,
    description: s.description,
    tags: s.tags,
    added_at: s.added_at
  }));

  return reply({ ok: true, data: result, total: result.length });
}
