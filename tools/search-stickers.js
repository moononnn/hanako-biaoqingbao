import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREFERENCES_FILE,
  collectPrefsForEmotion,
  prefsScoreBonus,
  resolveAgentId,
  META_FILE,
} from '../lib/shared.js';
import { TAG_TO_GROUP, resolveEmotionFactor } from '../lib/emotion-groups.js';
import { getAgentExpressionBias } from '../lib/dialect.js';

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
export const description = "搜索表情包，返回最匹配的候选列表（不含图片数据）。建议直接调 express 工具发表情包。keywords 精确匹配得分最高，是区分不同表情包的关键。emotion 传大类即可（搞笑/开心/难过/无语/感谢/鼓励）";
export const parameters = {
  type: "object",
  properties: {
    emotion: { type: "string", description: "情绪大类，逗号分隔。可选值: 搞笑, 开心, 难过, 无语, 感谢, 鼓励。可填多个" },
    keywords: { type: "string", description: "具体关键词，逗号分隔，如 '加班,累,打工人,摸鱼'。keywords 是区分度最高的字段，尽量传跟当前对话内容直接相关的词" },
    scene: { type: "string", description: "场景标签，逗号分隔，如 '早安,晚安,催回复,等回复'。可选" },
    exclude_ids: { type: "array", items: { type: "string" }, description: "要排除的表情包ID列表（避免重复使用）。把最近用过的 id 传进来" },
    limit: { type: "number", description: "返回数量上限，默认5", default: 5 }
  }
};

export async function execute(input, ctx) {
  const { emotion = '', keywords = '', scene = '', exclude_ids = [], limit = 5 } = input || {};

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
  const excludeSet = new Set(exclude_ids || []);

  // v0.25.2 - 候选列表也吃偏好惩罚：vetoed/累计不喜欢的图不排前面（与 express 选图口径一致，避免「先 search 再 express」链路里不喜欢的图以最高分出现误导助手）
  let prefs = { preferred: [], vetoed: [], dislikes: {} };
  let expressionBias = null;
  let agentId = null;
  try {
    agentId = resolveAgentId(null, ctx);
    expressionBias = getAgentExpressionBias(agentId);
    const pRaw = await readFile(PREFERENCES_FILE, 'utf-8');
    const pData = JSON.parse(pRaw);
    const users = pData.users || {};
    const target = (agentId && users[agentId]) || users.default || (Array.isArray(pData.mappings) ? { mappings: pData.mappings } : null);
    if (target) prefs = collectPrefsForEmotion(target.mappings, emotions.join(','));
  } catch {}

  const scored = stickers
    .filter(s => !excludeSet.has(s.id))
    .map(sticker => {
      let score = 0;
      let matchDetails = [];
      const tags = sticker.tags || {};

      // keywords 精确匹配 → 最高分（区分度最大）
      for (const kw of kwList) {
        for (const tag of (tags.keywords || [])) {
          if (tag === kw) {
            score += 5;
            matchDetails.push(`keyword精确:${tag}`);
          } else if (tag.includes(kw) || kw.includes(tag)) {
            score += 2;
            matchDetails.push(`keyword近似:${tag}`);
          }
        }
        if (sticker.description && sticker.description.includes(kw)) {
          score += 2;
          matchDetails.push(`描述命中:${kw}`);
        }
      }

      // scene 精确匹配 → 次高分
      for (const sc of scenes) {
        for (const tag of (tags.scene || [])) {
          if (tag === sc) {
            score += 4;
            matchDetails.push(`scene精确:${tag}`);
          } else if (tag.includes(sc) || sc.includes(tag)) {
            score += 1;
          }
        }
      }

      // emotion 精确匹配 → 中等分（区分度低，只做粗筛）
      // v0.27.0：情绪分单独累计，方言气质系数与强度偏移统一作用在情绪分上
      let emotionScore = 0;
      const emotionHitTags = [];
      for (const em of emotions) {
        for (const tag of (tags.emotion || [])) {
          if (tag === em) {
            emotionScore += 3;
            emotionHitTags.push(tag);
            matchDetails.push(`emotion精确:${tag}`);
          } else if (TAG_TO_GROUP[em] && TAG_TO_GROUP[tag] && TAG_TO_GROUP[em].some(g => TAG_TO_GROUP[tag].includes(g))) {
            // 语义相近（在同一个语义组里）→ 比纯子串包含更准
            emotionScore += 2;
            emotionHitTags.push(tag);
            matchDetails.push(`emotion语义:${em}≈${tag}`);
          } else if (tag.includes(em) || em.includes(tag)) {
            emotionScore += 1;
            emotionHitTags.push(tag);
          }
        }
      }
      // v0.27.0 方言×表情包联动：只影响情绪匹配分（有情绪查询且命中了情绪标签才参与）
      if (emotionScore > 0 && expressionBias) {
        emotionScore *= resolveEmotionFactor(emotionHitTags, expressionBias);
        const intensity = sticker._source?.intensity;
        if (intensity && expressionBias.intensity && expressionBias.intensity[intensity] !== undefined) {
          emotionScore += expressionBias.intensity[intensity];
        }
      }
      score += emotionScore;

      // 没有任何查询条件时，随机展示
      if (emotions.length === 0 && kwList.length === 0 && scenes.length === 0) {
        score = Math.random() * 0.99;
      }

      // v0.25.2 - 偏好加权：不喜欢的图降权（与 express 的 prefsScoreBonus 同一系数）
      score += prefsScoreBonus(sticker.id, prefs);

      return { sticker, score, matchDetails };
    });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.sticker.added_at || '').localeCompare(a.sticker.added_at || '');
  });

  const hasQuery = emotions.length > 0 || kwList.length > 0 || scenes.length > 0;
  const filtered = hasQuery ? scored.filter(s => s.score > 0) : scored;

  const result = filtered.slice(0, limit).map(s => ({
    id: s.sticker.id,
    file: s.sticker.file,
    description: s.sticker.description,
    tags: s.sticker.tags,
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
      ? `匹配到 ${result.length} 张，第一张「${result[0].description}」匹配度最高（${result[0].matched.join(', ')}）。intensity=${result[0].intensity}, reply_mode=${result[0].reply_mode}。强度 light=轻微情绪/日常, medium=普通情绪, strong/high=强烈情绪。reply_mode solo=适合单独甩图, either=都可, with_text=适合配文字。`
      : null
  });
}
