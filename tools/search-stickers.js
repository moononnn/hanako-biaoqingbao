import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREFERENCES_FILE,
  collectPrefsForEmotion,
  resolveAgentId,
  META_FILE,
} from '../lib/shared.js';
import { scoreStickers } from './express.js';
import { getAgentExpressionBias } from '../lib/dialect.js';
import {
  readGroupStore,
  filterStickersForAgent,
  getAgentGroupConfig,
  getKnownGroupIds,
  getStickerGroupIds,
} from '../lib/sticker-groups.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const metaPath = META_FILE;

// ── emotion 语义相近组（v0.10.1）──
// 解决「express 只认 6 大类，但识图提示词输出的是具体情绪」这个设计缺口
// 例：搜「搞笑」能命中戏谵/调侃/整活/扮酷（AI 输出的具体词）
//     搜「难过」能命中委屈/emo/崩溃/丧（AI 输出的具体词）
//     搜「感谢」能命中感动/被治愈/心怀感激（AI 输出的具体词）
// v0.27.0：数据迁至 lib/emotion-groups.js（express 共用），此处仅保留说明

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "search_stickers";
export const description = "搜索表情包，返回最匹配的候选列表（不含图片数据）。建议直接调 express 工具发表情包。keywords 精确匹配得分最高，是区分不同表情包的关键。emotion 传大类即可（搞笑/开心/难过/无语/感谢/鼓励）。当前伙伴的分组白名单和分组偏爱会自动参与筛选与排序。";
export const parameters = {
  type: "object",
  properties: {
    emotion: { type: "string", description: "情绪大类，逗号分隔。可选值: 搞笑, 开心, 难过, 无语, 感谢, 鼓励。可填多个" },
    keywords: { type: "string", description: "具体关键词，逗号分隔，如 '加班,累,打工人,摸鱼'。keywords 是区分度最高的字段，尽量传跟当前对话内容直接相关的词" },
    scene: { type: "string", description: "场景标签，逗号分隔，如 '早安,晚安,催回复,等回复'。可选" },
    tone: { type: "string", description: "可选：表达姿态，如自嘲、调侃；只有图库有明确语气证据时才加分" },
    intensity: { type: "string", enum: ["light", "medium", "strong"], description: "可选：期望表情强度；未标注强度的图不受影响" },
    exclude_ids: { type: "array", items: { type: "string" }, description: "要排除的表情包ID列表（避免重复使用）。把最近用过的 id 传进来" },
    limit: { type: "number", description: "返回数量上限，默认5", default: 5 }
  }
};

export async function execute(input, ctx) {
  const { emotion = '', keywords = '', scene = '', tone = '', intensity = '', exclude_ids = [], limit = 5 } = input || {};

  let stickers = [];
  try {
    const raw = await readFile(metaPath, 'utf-8');
    stickers = JSON.parse(raw);
  } catch {
    return reply({ ok: true, data: [], message: '表情包库为空，请先添加表情包' });
  }

  if (stickers.length === 0) {
    return reply({ ok: true, data: [], message: '表情包库为空，请先添加表情包' });
  }

  const emotions = emotion ? emotion.split(',').map(s => s.trim()).filter(Boolean) : [];
  const kwList = keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : [];
  const scenes = scene ? scene.split(',').map(s => s.trim()).filter(Boolean) : [];

  // v0.25.2 - 候选列表也吃偏好惩罚：vetoed/累计不喜欢的图不排前面（与 express 选图口径一致，避免「先 search 再 express」链路里不喜欢的图以最高分出现误导助手）
  let prefs = { preferred: [], vetoed: [], dislikes: {} };
  let expressionBias = null;
  const agentId = resolveAgentId(null, ctx);
  const groupStore = readGroupStore();
  const groupConfig = getAgentGroupConfig(groupStore, agentId);
  const knownGroupIds = getKnownGroupIds(groupStore);
  stickers = filterStickersForAgent(stickers, agentId, groupStore);
  try {
    expressionBias = getAgentExpressionBias(agentId);
    const pRaw = await readFile(PREFERENCES_FILE, 'utf-8');
    const pData = JSON.parse(pRaw);
    const users = pData.users || {};
    const target = (agentId && users[agentId]) || users.default || (Array.isArray(pData.mappings) ? { mappings: pData.mappings } : null);
    if (target) prefs = collectPrefsForEmotion(target.mappings, emotions.join(','));
  } catch {}

  const hasQuery = emotions.length > 0 || kwList.length > 0 || scenes.length > 0;
  // 搜图与自动发送共用一套语义、偏好、分组打分；无查询时仍展示随机图库。
  const scored = hasQuery
    ? scoreStickers(stickers, emotions, exclude_ids || [], prefs, expressionBias, groupConfig, knownGroupIds, kwList, { scene: scenes, tone: String(tone).slice(0, 12), intensity: ['light', 'medium', 'strong'].includes(intensity) ? intensity : '' })
    : stickers.filter(s => !(exclude_ids || []).includes(s.id) && !prefs.vetoed?.includes(s.id)).sort(() => Math.random() - 0.5);
  const filtered = scored.map(sticker => {
    const tags = sticker.tags || {};
    const matchDetails = [
      ...emotions.filter(em => (tags.emotion || []).some(t => t.includes(em) || em.includes(t))).map(em => `emotion:${em}`),
      ...kwList.filter(kw => (tags.keywords || []).includes(kw) || (kw.length > 1 && ((sticker.description || '').includes(kw) || (sticker.semantic_description || '').includes(kw)))).map(kw => `keyword:${kw}`),
      ...scenes.filter(sc => (tags.scene || []).some(t => t === sc || (sc.length > 1 && t.length > 1 && (t.includes(sc) || sc.includes(t))))).map(sc => `scene:${sc}`),
      ...(tone && ((tags.atmosphere || []).includes(tone) || (sticker.semantic_description || '').includes(tone)) ? [`tone:${tone}`] : []),
      ...(intensity && sticker._source?.intensity ? [`intensity:${sticker._source.intensity}`] : []),
    ];
    return { sticker, score: sticker._score || 0, matchDetails };
  });

  const result = filtered.slice(0, limit).map(s => ({
    id: s.sticker.id,
    file: s.sticker.file,
    description: s.sticker.description,
    tags: s.sticker.tags,
    group_ids: getStickerGroupIds(s.sticker, knownGroupIds),
    intensity: s.sticker._source?.intensity || 'medium',
    reply_mode: s.sticker._source?.reply_mode || 'either',
    score: Math.round(s.score * 100) / 100,
    matched: s.matchDetails
  }));

  if (hasQuery && result.length === 0) {
    return reply({
      ok: true,
      data: [],
      total: 0,
      message: `没有找到匹配的表情包。你传了 emotion="${emotion}", keywords="${keywords}", scene="${scene}"。试试换一组关键词。`
    });
  }

  return reply({
    ok: true,
    data: result,
    total: result.length,
    hint: result.length > 0
      ? `按标签与偏好评分，当前第一张「${result[0].description}」${result[0].matched.length ? `（线索：${result[0].matched.join(', ')}）` : ''}。实际发送还会考虑向量与探索，未必发第一张。intensity=${result[0].intensity}, reply_mode=${result[0].reply_mode}。强度 light=轻微情绪/日常, medium=普通情绪, strong/high=强烈情绪。reply_mode solo=适合单独甩图, either=都可, with_text=适合配文字。`
      : null
  });
}
