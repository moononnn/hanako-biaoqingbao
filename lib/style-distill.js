// lib/style-distill.js - 学我说话 v2：分通道提炼流水线
//
// 方向：程序算数，模型写话。
//   统计基线由纯程序精确计算（唯一事实源），模型只负责把数字翻译成人格文案。
//   每条模型特征带断言 claim（自报依据指标+区间）→ 程序对基线核对 → 不过带反馈局部重试。
//
// 本文件只做提炼逻辑（纯函数 + 模型调用编排），不碰存储/任务状态机；
// 数据读写与任务状态机仍在 style-template.js，单向依赖本文件。
//
// v2 设计文档：学我说话-v2-设计.md（2026-08-25）
// 现有 v1 逻辑见 lib/style-template.js 的 runStyleTask / buildStylePrompt。

// ════════════════════════════════════════════════════════════════
// 阶段① 统计基线（纯程序，唯一事实源）
// ════════════════════════════════════════════════════════════════

// 短消息界定（字符数）
export const SHORT_MSG_CHARS = 20;

// 句尾语气词候选（首发版本从方言调研数据收敛的基础语料；可按地区扩展，补进数组即可参与统计）
export const SENTENCE_END_TONE_WORDS = [
  '嘛的', '哦豁', '嘛', '噻', '哈', '咯', '吧', '呢', '啊', '哦', '呀', '诶', '唉', '吗', '呗', '哟', '嚯', '啰', '喽',
];

const SENTENCE_SPLIT_RE = /[。！？!?…~～；;]/;
const WAVE_RE = /[~～]/;
const ELLIPSIS_RE = /…|。{2,}|\.{3,}/;
const EXCLAIM_RE = /[！!]/;
const QUESTION_RE = /[？?]/;
const LAST_PUNCT_RE = /[。！？!?…~～；;，,、]/;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
const KAOMOJI_WORDS = ['QAQ', 'Orz', 'TAT', 'OvO', 'qwq', 'QWQ', 'TvT', '0v0', 'ovo', '(=', '(>_<)', '_(:з', '233', 'hhh', 'hhhh', '哈哈哈哈哈'];

// 是否是常见 emoji / 颜文字（消息级粗判）
export function hasEmojiOrKaomoji(text) {
  if (!text) return false;
  if (EMOJI_RE.test(text)) return true;
  const upper = text.toUpperCase();
  return KAOMOJI_WORDS.some((k) => upper.includes(k));
}

// 消息以哪个候选语气词结尾（返回命中的词，可能多个；最长优先）
export function endsWithToneWord(text) {
  if (!text) return null;
  const t = text.trim();
  for (const w of SENTENCE_END_TONE_WORDS) {
    if (t.endsWith(w)) return w;
  }
  return null;
}

// 按句末标点切句（返回句子数组，不含标点）
export function splitSentences(text) {
  return String(text || '')
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 高频短语候选：只统计由标点/空白分开的连续汉字短段（2~12 字）；同一条消息里的同一短段最多计一次。
// 这样不会把拼音/英文/数字拆成字符碎片，也不会跨空格、标点或链接拼接出伪短语。
// 常见结构词、话题词和元信息词不代表个人口吻，宁可留白，也不把「这个」「模型」冒充口头禅。
const CATCHPHRASE_STOPWORDS = new Set([
  '这个', '那个', '就是', '然后', '我想', '我们', '你们', '他们', '自己', '现在', '当前', '时间',
  '可以', '因为', '所以', '还有', '已经', '如果', '但是', '还是', '什么', '怎么', '真的', '觉得',
  '知道', '一下', '不是', '没有', '时候', '比较', '应该', '需要', '可能', '的话', '一个', '一些',
  '有点', '这样', '那样', '这里', '那里', '今天', '明天', '问题', '事情', '东西', '内容', '直接',
  '感觉', '我的', '或者', '好的', '不会', '不能', '我不', '你看', '那种', '是我', '啥的', '是不',
  '咱们', '看看', '小花', '小花小花', '我觉', '前时', '帮我', '对话', '功能', '模型', '这边', '之前',
  '个插', '我这', '是那', '的是', '继续', '助手', '显示', '回复', '生成', '打开', '请你', '给你',
  '讨论', '其他', '话框', '开始', '加入', '重启', '出来', '不行', '能不', '角色', '不住', '工作',
  '类的', '就行', '更新', '希望', '看下', '我看', '闲不', '的东', '一样', '设计', '修改', '花酿',
  '文件', '你说', '每次', '效果', '是在', '说的', '窗口', '不太', '版本', '选择', '有没', '我希',
  '自动', '要的', '有啥', '都是', '是你', '为啥', '我在', '提示', '界面', '设置', '做的', '我是',
  '根据', '一直', '那些', '记忆', '后台', '只是', '里的', '是啥', '你帮', '想你', '别的', '不过',
  '好像', '别人', '聊天', '们的', '们来', '附件', '软件', '方案', '脚本', '目录', '先生', '主人', '等下', '对了', '另外', '开始吧',
]);
const CATCHPHRASE_EXCLUDE_PARTS = ['插件', '工作台', '酒馆', '模型', '对话', '功能', '助手', '附件', '表情包', '花酿', '闲不住', '重启', '小花'];

export function extractCatchphrases(messages, opts = {}) {
  const minCount = opts.minCount ?? 3;
  const topN = opts.topN ?? 5;
  const maxChars = opts.maxChars ?? 12;
  const phrases = new Map();
  const hanRunRe = /[\p{Script=Han}]+/gu;
  for (const m of Array.isArray(messages) ? messages : []) {
    const runs = String(m?.text || '').match(hanRunRe) || [];
    const seenInMessage = new Set();
    for (const phrase of runs) {
      const length = [...phrase].length;
      if (length < 2 || length > maxChars) continue;
      if (CATCHPHRASE_STOPWORDS.has(phrase)) continue;
      if (CATCHPHRASE_EXCLUDE_PARTS.some((part) => phrase.includes(part))) continue;
      // 消息开头紧接逗号/空格的短段更像在叫人；保留“嘿嘿，”这类明显情绪词，
      // 其余称呼不进入口吻候选，避免把助手名字当成用户习惯。
      const trimmed = String(m?.text || '').trimStart();
      const next = trimmed.slice(phrase.length, phrase.length + 1);
      const looksLikeAddress = trimmed.startsWith(phrase)
        && trimmed.length > phrase.length
        && /^[，,：:、\s]$/u.test(next)
        && !/^(?:哈|嘿|啊|哎|哦|嗯|哇|哈哈|嘿嘿)/u.test(phrase);
      if (looksLikeAddress) continue;
      seenInMessage.add(phrase);
    }
    for (const phrase of seenInMessage) phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
  }
  return [...phrases.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase, count]) => ({ phrase, count }));
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 计算统计基线
// 输入：sampled [{ text, ts }]（与喂模型的一致，保证验收对齐）
// 输出 baseline（结构见 JSDoc 下方代码；所有"占比"都按消息/句子占比计，0~1 之间的浮点）
export function computeBaseline(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sampled = list.length;
  const base = {
    sampled,
    total_chars: 0,
    avg_sentence_len: 0,
    msg_len_median: 0,
    short_ratio: 0,
    punct: { wave: 0, ellipsis: 0, exclaim: 0, question: 0, end_clean: 0, end_tone: 0 },
    tone_words: {},
    end_tone_top: [],
    catchphrases: [],
    emoji_ratio: 0,
  };
  if (sampled === 0) return base;

  let totalChars = 0;
  let shortCount = 0;
  let waveCount = 0, ellipsisCount = 0, exclaimCount = 0, questionCount = 0;
  let endCleanCount = 0, endToneCount = 0;
  let emojiCount = 0;
  let sentenceChars = 0, sentenceCount = 0;
  const msgLens = [];
  const toneCounts = new Map(SENTENCE_END_TONE_WORDS.map((w) => [w, 0]));

  for (const m of list) {
    const text = String(m.text || '').trim();
    if (!text) continue;
    const len = [...text].length;
    totalChars += len;
    msgLens.push(len);
    if (len < SHORT_MSG_CHARS) shortCount++;

    if (WAVE_RE.test(text)) waveCount++;
    if (ELLIPSIS_RE.test(text)) ellipsisCount++;
    if (EXCLAIM_RE.test(text)) exclaimCount++;
    if (QUESTION_RE.test(text)) questionCount++;
    if (hasEmojiOrKaomoji(text)) emojiCount++;

    const parts = splitSentences(text);
    if (parts.length > 0) {
      sentenceCount += parts.length;
      for (const p of parts) sentenceChars += [...p].length;
    }

    const last = [...text][text.length - 1];
    const tone = endsWithToneWord(text);
    if (tone) {
      endToneCount++;
      toneCounts.set(tone, (toneCounts.get(tone) || 0) + 1);
    }
    const endIsPunct = last != null && LAST_PUNCT_RE.test(last);
    // 句末无标点无语气词 → 光溜溜结束（"句末啥都不加"）
    if (!endIsPunct && !tone) endCleanCount++;
  }

  const n = list.length;
  base.total_chars = totalChars;
  base.avg_sentence_len = sentenceCount ? Math.round((sentenceChars / sentenceCount) * 10) / 10 : 0;
  base.msg_len_median = median(msgLens);
  base.short_ratio = Math.round((shortCount / n) * 1000) / 1000;
  base.punct = {
    wave: Math.round((waveCount / n) * 1000) / 1000,
    ellipsis: Math.round((ellipsisCount / n) * 1000) / 1000,
    exclaim: Math.round((exclaimCount / n) * 1000) / 1000,
    question: Math.round((questionCount / n) * 1000) / 1000,
    end_clean: Math.round((endCleanCount / n) * 1000) / 1000,
    end_tone: Math.round((endToneCount / n) * 1000) / 1000,
  };
  for (const [w, c] of toneCounts) {
    if (c > 0) base.tone_words[w] = Math.round((c / n) * 1000) / 1000;
  }
  base.end_tone_top = [...toneCounts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([w, c]) => ({ word: w, count: c, ratio: Math.round((c / n) * 1000) / 1000 }));
  base.catchphrases = extractCatchphrases(list);
  base.emoji_ratio = Math.round((emojiCount / n) * 1000) / 1000;
  return base;
}

// ── 验收断言：模型特征自报 claim → 程序对基线核对 ──
// claim: { metric: 'punct.wave' | 'tone_words.嘛' | 'avg_sentence_len' | ..., min?, max? }
// 返回 { ok, actual }；ok=true 表示实际值落在 [min,max]（缺省边界为 ±∞）
export function verifyClaim(baseline, claim) {
  if (!claim || typeof claim !== 'object') return { ok: false, reason: 'no-claim', actual: null };
  const { metric, min, max } = claim;
  if (typeof metric !== 'string') return { ok: false, reason: 'no-metric', actual: null };
  let v = baseline;
  for (const k of metric.split('.')) {
    if (v == null) return { ok: false, reason: 'unknown-metric:' + metric, actual: null };
    v = v[k];
  }
  if (typeof v !== 'number') return { ok: false, reason: 'unknown-metric:' + metric, actual: null };
  const lo = typeof min === 'number' ? min : -Infinity;
  const hi = typeof max === 'number' ? max : Infinity;
  // 提示词把比例显示成整数百分比，而基线保留三位小数；例如实际 0.249
  // 会显示为 25%，模型回填 0.25。给比例指标留半个百分点的显示舍入误差，
  // 否则“照着程序给的 25% 填”会被程序自己误判为失败。
  const roundedRatio = /^(?:punct\.|tone_words\.|short_ratio$|emoji_ratio$)/.test(metric);
  const tolerance = roundedRatio ? 0.006 : 0;
  return { ok: v >= lo - tolerance && v <= hi + tolerance, actual: v };
}

// 把 baseline 统计数字转成给模型的中文说明（提示槽插入用）
// 只挑能支撑断言的关键数字，不全部堆给模型
export function describeBaselineForPrompt(baseline, channel) {
  const b = baseline || {};
  const p = b.punct || {};
  const lines = [];
  if (channel === 'punct') {
    lines.push(`句尾带波浪号占 ${pct(p.wave)}`);
    lines.push(`用省略号的占 ${pct(p.ellipsis)}`);
    lines.push(`句尾感叹号占 ${pct(p.exclaim)}`);
    lines.push(`问句占 ${pct(p.question)}`);
    lines.push(`光溜溜结束（无标点无语气词）占 ${pct(p.end_clean)}`);
    lines.push(`以语气词收尾的占 ${pct(p.end_tone)}`);
    if ((b.end_tone_top || []).length) lines.push('喊得最多的句尾语气词：' + b.end_tone_top.slice(0, 4).map((e) => `「${e.word}」${pct(e.ratio)}`).join('、'));
  } else if (channel === 'lexicon') {
    if ((b.end_tone_top || []).length) lines.push('句尾语气词排行：' + b.end_tone_top.slice(0, 5).map((e) => `「${e.word}」${pct(e.ratio)}`).join('、'));
    if ((b.catchphrases || []).length) lines.push('高频短语候选：' + b.catchphrases.map((e) => `「${e.phrase}」×${e.count}`).join('、'));
    lines.push(`使用 emoji/颜文字的占 ${pct(b.emoji_ratio)}`);
  } else if (channel === 'syntax') {
    lines.push(`平均句长 ${b.avg_sentence_len} 字`);
    lines.push(`消息中位数 ${b.msg_len_median} 字`);
    lines.push(`短消息（<${SHORT_MSG_CHARS} 字）占 ${pct(b.short_ratio)}`);
  } else if (channel === 'emotion') {
    lines.push(`使用 emoji/颜文字的占 ${pct(b.emoji_ratio)}`);
    lines.push(`含感叹号的占 ${pct(p.exclaim)}`);
    lines.push(`含省略号的占 ${pct(p.ellipsis)}`);
    lines.push(`以语气词收尾的占 ${pct(p.end_tone)}`);
  } else if (channel === 'formal') {
    // formal 目前没有可靠的“正事消息”分类器，先给整体语言基线，
    // 避免模型在必须填写 claim 时完全失去统计锚点；不能冒充正事专属比例。
    lines.push(`整体平均句长 ${b.avg_sentence_len} 字`);
    lines.push(`整体消息中位数 ${b.msg_len_median} 字`);
    lines.push(`整体短消息（<${SHORT_MSG_CHARS} 字）占 ${pct(b.short_ratio)}`);
    lines.push(`整体光溜溜结束占 ${pct(p.end_clean)}`);
  }
  const head = channel === 'formal'
    ? '程序已对全部样本做精确统计，这些是整体语言基线；正事场景的差异仍以样本表现为准，不要把整体比例写成正事专属比例：'
    : '程序已对你的发言做精确统计，请以此为准，不要超出或压低这些数字：';
  return lines.length ? head + '\n' + lines.map((l) => '· ' + l).join('\n') : '';
}

function pct(n) {
  if (typeof n !== 'number') return '0%';
  return Math.round(n * 100) + '%';
}

// ════════════════════════════════════════════════════════════════
// 阶段② 分通道提炼（模型写）＋ 阶段③ 程序化验收（局部重试）
// ════════════════════════════════════════════════════════════════

// 五路正交通道定义；具体哪个档位跑哪些通道由 style-template.js 的 STYLE_LEVELS 决定
export const CHANNELS = {
  lexicon: { label: '词汇', desc: '高频词、短语、起头词、句尾语气词', maxFeatures: 6 },
  syntax: { label: '句法', desc: '句式偏好、倒装、长短句节奏、断句', maxFeatures: 6 },
  punct: { label: '标点', desc: '句末标点、波浪号省略号、停顿习惯', maxFeatures: 5 },
  emotion: { label: '情绪', desc: '开心/无语/着急/撒娇时怎么表达', maxFeatures: 8 },
  formal: { label: '正事', desc: '聊正事、给意见时的平实状态（反差样本）', maxFeatures: 4 },
};
export const CHANNEL_KEYS = Object.keys(CHANNELS);

// 措辞档位：与提示词要求、合并阶段共用同一套（单一口径）
export function ratioPhrase(ratio) {
  if (typeof ratio !== 'number') return '偶尔';
  if (ratio < 0.1) return '偶尔';
  if (ratio <= 0.4) return '有时候';
  return '常';
}

function fbPct(n) {
  if (typeof n !== 'number') return '';
  return Math.round(n * 100) + '%';
}

// 构造单路通道提示词（提示槽：程序统计数字插入；反馈：上一次验收清单）
export function buildChannelPrompt(channel, corpusText, baselineText, userName, feedback = []) {
  const conf = CHANNELS[channel];
  if (!conf) throw new Error('未知通道: ' + channel);
  const name = userName || '用户';
  const stat = baselineText
    ? '<程序统计（这是精确事实，只能照此写，禁止超出或压低）>\n' + baselineText + '\n</程序统计>\n\n'
    : '';
  const fb = feedback.length
    ? '\n\n上次输出被程序否决，原因：\n' + feedback.slice(-6).map((f) => '· ' + f).join('\n') + '\n请修正后重新输出（只输出 JSON）。'
    : '';
  return `你是语言风格分析师。下面是一位用户（自称${name}）的发言样本（按时间顺序编号，消息间空行分隔）：

<发言样本>
${corpusText}
</发言样本>

请提炼 ta 在【${conf.label}】方面的打字习惯（${conf.desc}）。

输出要求：只输出一段 JSON（不要任何额外文字、不要 markdown 代码块包裹、不要注释）：
{
  "features": [
    {
      "feature": "身份化的一句描述（比如「句尾偶尔带波浪号撒娇」「聊正事时句子明显变短平快」）",
      "claim": { "metric": "punct.wave", "min": 0.05, "max": 0.35 }
    }
  ]
}

规则：
1. 最多输出 ${conf.maxFeatures} 条特征；feature 用身份化描述（将来直接进人格文案），禁止指令词（注意/不要/请/必须/应该/记住/尽量），不提具体话题、人名、事件
2. claim.metric 只能用这些指标：punct.wave / punct.ellipsis / punct.exclaim / punct.question / punct.end_clean / punct.end_tone / tone_words.某字 / avg_sentence_len / msg_len_median / short_ratio / emoji_ratio / catchphrases.length；区间只能落在上面「程序统计」给出的数字附近，禁止编造程序没给的数字
3. 措辞严格对应档位：比值<10% 只能写「偶尔」；10%~40% 写「有时候/习惯在XX时」；>40% 才写「常」；不要自行换算成“每几句/十句里几句/百分之几”
4. 拿不准或样本不足的特征不要写，别硬凑
5. 只提炼说话方式，不提炼具体内容

${stat}${fb}`;
}

// 健壮解析模型输出的 JSON（容忍代码块包裹 / 外围杂字）
export function parseChannelJSON(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: '模型输出为空' };
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.features)) return { ok: true, features: j.features };
    return { ok: false, error: 'JSON 缺少 features 数组' };
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && Array.isArray(j.features)) return { ok: true, features: j.features };
    } catch {}
  }
  return { ok: false, error: '输出不是合法 JSON' };
}

function rangeText(claim) {
  if (!claim) return '无 claim';
  const lo = typeof claim.min === 'number' ? fbPct(claim.min) : '无下限';
  const hi = typeof claim.max === 'number' ? fbPct(claim.max) : '无上限';
  return `[${lo} ~ ${hi}]`;
}

// 批量验收：逐特征对基线核对；返回通过的特征 + 问题清单
export function verifyFeatures(baseline, features) {
  const problems = [];
  const good = [];
  for (const f of features || []) {
    if (!f || typeof f !== 'object' || !String(f.feature || '').trim()) {
      problems.push('存在缺少 feature 描述的空条目');
      continue;
    }
    const claim = f.claim && typeof f.claim === 'object' ? f.claim : null;
    if (!claim || typeof claim.metric !== 'string') {
      problems.push(`「${f.feature}」缺少 claim（指标凭据）`);
      continue;
    }
    const res = verifyClaim(baseline, claim);
    if (!res.ok) {
      problems.push(`「${f.feature}」自报 ${claim.metric} 不在区间（期望 ${rangeText(claim)}，实际 ${res.actual == null ? '该指标不存在' : fbPct(res.actual)}）`);
    } else {
      good.push(f);
    }
  }
  return { ok: problems.length === 0, problems, features: good };
}

// 去重 + 限条数（按 feature 文本）
export function clipFeatures(features, max) {
  const seen = new Set();
  const out = [];
  for (const f of features || []) {
    const key = String(f.feature || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ feature: key, claim: f.claim && typeof f.claim === 'object' ? { metric: f.claim.metric, min: f.claim.min, max: f.claim.max } : undefined });
    if (out.length >= max) break;
  }
  return out;
}

// 单路提炼：调模型 → 解析 → 验收 → 不过带反馈局部重试（最多 maxTries 次）
// 返回 { channel, status: 'ok'|'weak'|'failed', tries, features, problems }
//   ok     = 验收全过
//   weak   = 重试耗尽，保留最后一次验收里通过的特征（不阻断整体）
//   failed = 模型调用全失败且无任何通过特征
export async function distilChannel(channel, corpusText, baseline, userName, callModel, opts = {}) {
  const maxRetries = opts.maxTries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const baselineText = describeBaselineForPrompt(baseline, channel);
  const feedback = [];
  let lastVerdict = { ok: false, problems: [], features: [] };
  let sawModelFailure = false;
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    const prompt = buildChannelPrompt(channel, corpusText, baselineText, userName, feedback);
    // 每路要返回带 claim 的 JSON；500 在模型把思考或结构开销算进总预算时
    // 太容易刚好截断，800 给正文留出可验证的余量。
    const res = await callModel([{ role: 'user', content: prompt }], { maxTokens: 800, temperature: 0.4, timeoutMs: 90000 });
    if (!res.ok) {
      sawModelFailure = true;
      feedback.push('上次模型调用失败：' + (res.error || '未知错误'));
      continue;
    }
    const parsed = parseChannelJSON(String(res.data || '').trim());
    if (!parsed.ok) {
      feedback.push('上次输出不是合法 JSON：' + (parsed.error || '无法解析'));
      continue;
    }
    const verdict = verifyFeatures(baseline, parsed.features);
    lastVerdict = verdict;
    if (verdict.ok) {
      return { channel, status: 'ok', tries: i + 1, features: clipFeatures(verdict.features, CHANNELS[channel].maxFeatures), problems: [] };
    }
    feedback.push(...verdict.problems.map((p) => '· ' + p));
  }
  if (sawModelFailure && lastVerdict.features.length === 0) {
    return { channel, status: 'failed', tries: maxRetries + 1, features: [], problems: feedback };
  }
  return { channel, status: 'weak', tries: maxRetries + 1, features: clipFeatures(lastVerdict.features, CHANNELS[channel].maxFeatures), problems: lastVerdict.problems };
}

// 读取基线指标（点分路径）
export function readMetric(baseline, metric) {
  if (typeof metric !== 'string') return undefined;
  let v = baseline;
  for (const k of metric.split('.')) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

// ── 最终文案格式自检（从 style-template.js checkStyleDraft 迁移并强化）──
const INSTRUCTION_WORDS = ['注意', '不要', '请', '必须', '应该', '记住', '尽量'];
// 绝对化词：文案里出现太多次说明又在向外推（回归：全时段卖萌）
const ABSOLUTE_WORDS = ['总是', '永远', '每句话', '每次都', '全都', '一律'];
// 合并阶段只有消息级统计，不能让模型把它擅自换算成“十句里几句/百分之几”。
const UNVERIFIED_RATIO_RE = /(?:每[一二两三四五六七八九十百千万\d]+(?:到[一二两三四五六七八九十百千万\d]+)?(?:句|条|次|回)|[一二两三四五六七八九十百千万\d]+(?:句|条|次|回)(?:里|中)|百分之[一二两三四五六七八九十百千万\d]+|\d+(?:\.\d+)?%)/;
export function checkStyleDraft(draft, opts = {}) {
  const problems = [];
  const text = String(draft || '').trim();
  if (!text) { problems.push('内容为空'); return problems; }
  if (text.length > (opts.maxChars ?? 600)) problems.push(`超过 ${opts.maxChars ?? 600} 字（当前 ${text.length} 字）`);
  if (!text.includes('你是一个')) problems.push('缺少身份化开头（「你是一个……」）');
  if (/^你是一个(?:文字)?(?:编辑|校对员)/.test(text)) problems.push('身份化开头误把用户写成编辑角色');
  for (const w of INSTRUCTION_WORDS) {
    if (text.includes(w)) problems.push(`含指令词「${w}」`);
  }
  if (/^#{1,6}\s/m.test(text) || text.includes('**') || /^[-*]\s/m.test(text)) problems.push('含 markdown 格式（标题/加粗/列表）');
  const absoluteCount = ABSOLUTE_WORDS.reduce((n, w) => n + (text.split(w).length - 1), 0);
  if (absoluteCount > 2) problems.push(`绝对化表述过多（${absoluteCount} 处「总是/永远/每次…」），风格模板容易失真`);
  if (UNVERIFIED_RATIO_RE.test(text)) problems.push('含未经程序统计的具体次数/百分比，请改用「偶尔/有时候/常」表达');
  if ((text.match(/“/g) || []).length !== (text.match(/”/g) || []).length) {
    problems.push('中文引号未成对闭合');
  }
  // locked 内容必须拼入（用户手动加的不能丢）
  for (const locked of opts.locked || []) {
    if (locked && !text.includes(locked)) problems.push(`缺少用户锁定内容「${String(locked).slice(0, 20)}…」`);
  }
  return problems;
}

// ════════════════════════════════════════════════════════════════
// 阶段④ 分层合并成稿（程序定骨架，模型润色）＋ 阶段⑤ 修正回流
// ════════════════════════════════════════════════════════════════

// 把模板切成句段（用于用户修订 diff）
export function splitTemplateSentences(text) {
  return (String(text || '').match(/[^。！？!?\n]+[。！？!?]?/g) || [])
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// 用户修订 diff：旧模板 vs 新草稿 → 删掉的句子（→反例）、新增的句子（→锁定）
export function diffTemplateFeedback(oldText, newText) {
  const o = new Set(splitTemplateSentences(oldText));
  const n = new Set(splitTemplateSentences(newText));
  const removed = [...o].filter((s) => !n.has(s));
  const added = [...n].filter((s) => !o.has(s));
  return { removed, added };
}

// 把反例库/锁定特征格式化成合并提示词的约束块
export function formatFeedbackBlock(fb) {
  const parts = [];
  const c = fb && Array.isArray(fb.counterexamples) ? fb.counterexamples.filter((x) => x && x.feature) : [];
  if (c.length) {
    parts.push('<禁止写的特征（用户明确删过，不要再出现同类话术）>\n' + c.map((x) => '· ' + x.feature).join('\n'));
  }
  const l = fb && Array.isArray(fb.locked) ? fb.locked.filter((x) => x && x.content) : [];
  if (l.length) {
    parts.push('<必须保留的内容（用户手动加的，请原样嵌入文案）>\n' + l.map((x) => '· ' + x.content).join('\n'));
  }
  return parts.join('\n\n');
}

// 构造合并润色提示词：特征清单（带实测占比）+ 反例约束 + 锁定内容
export function buildMergePrompt(channels, baseline, feedback, userName) {
  const name = userName || '用户';
  const blocks = [];
  for (const key of CHANNEL_KEYS) {
    const ch = channels[key];
    if (!ch || !ch.features || !ch.features.length) continue;
    const feats = ch.features.map((f) => {
      const ratio = f.claim ? readMetric(baseline, f.claim.metric) : undefined;
      return `· ${f.feature}${typeof ratio === 'number' ? '（实测 ' + pct(ratio) + '）' : ''}`;
    }).join('\n');
    blocks.push(`[${CHANNELS[key].label}]
${feats}`);
  }
  if (blocks.length === 0) return '';
  const constraints = formatFeedbackBlock(feedback);
  return `请把下面用程序精确统计提炼出的用户（自称${name}）说话风格特征清单（括号内是实测占比）整理成一段 450-550 字的连贯人格文案：

<特征清单>
${blocks.join('\n\n')}
</特征清单>

要求：
1. 身份化开头「你是一个……，打字也带着……习惯」
2. 严格按实测占比遣词：<10% 说「偶尔」、10%~40% 说「有时候」、>40% 才说「常/总是」；不得夸大，也不要把占比自行换算成“每几句/十句里几句/百分之几”等具体次数
3. 给 3-5 个场景示例（约饭/聊正事/搞砸了/夸东西），至少 1-2 句是平实自然聊正事的状态（反差，别全堆特征）
4. 末尾加「正事闲聊都一个样，不刻意表现，也不刻意收敛。这只是你的措辞，正事照样讲得明白」
5. 不提具体话题/人名/事件，零指令词（注意/不要/请/必须/应该/记住/尽量），一段连贯的话，不用 markdown 标题/列表/加粗
6. 总长 450-550 字，绝对不能超过 600 字（超了会被系统拒绝保存，写长等于白写）

${constraints ? constraints + '\n\n' : ''}只输出最终文案本身。`;
}

function mergeRetryFeedback(issues, previousDraft = '') {
  const hints = [];
  if (issues.some((x) => x.startsWith('含指令词'))) hints.push('把带命令口吻的措辞改成自然的身份化陈述');
  if (issues.some((x) => x.startsWith('超过'))) hints.push('压缩重复内容，控制在保存上限以内');
  if (issues.some((x) => x.includes('缺少身份化开头'))) hints.push('补上身份化开头');
  if (issues.some((x) => x.includes('编辑角色'))) hints.push('把开头改成描述用户说话习惯的身份化句子');
  if (issues.some((x) => x.includes('markdown'))) hints.push('去掉标题、列表和加粗格式');
  if (issues.some((x) => x.includes('绝对化表述'))) hints.push('把过强的绝对化说法收敛为符合实测比例的表达');
  if (issues.some((x) => x.includes('未经程序统计'))) hints.push('删掉自行换算的具体次数和百分比，只保留符合实测的模糊频率词');
  if (issues.some((x) => x.includes('引号未成对'))) hints.push('修正成对引号和标点，不保留孤立引号');
  if (issues.some((x) => x.includes('缺少用户锁定内容'))) hints.push('保留用户锁定的原文内容');
  if (hints.length === 0) hints.push('修正程序检查指出的问题');
  const flagged = [...new Set(issues.flatMap((x) => [...String(x).matchAll(/「([^」]+)」/g)].map((m) => m[1])))];
  const flaggedText = flagged.length ? `机器标记的词语：${flagged.join('、')}；把它们从正文中删掉或换成自然陈述。` : '';
  const draftText = previousDraft
    ? `\n<上一版草稿>\n${previousDraft}\n</上一版草稿>`
    : '';
  return `请做一次文字校对：在不改变上一版风格事实的前提下做最小改写，保留身份化开头、场景示例和固定结尾。上一版草稿未通过程序检查：${hints.join('；')}。${flaggedText}${draftText}\n输出 450-550 字的一段连贯文案，不带标题、列表、加粗或解释，只输出修正后的完整文案。`;
}

// 执行合并润色（可重试 2 次）；lockedTexts 参与终检
export async function mergeTemplate(channels, baseline, feedback, userName, callModel, opts = {}) {
  const prompt = buildMergePrompt(channels, baseline, feedback, userName);
  if (!prompt) return { ok: false, error: '所有通道都没有特征，无内容可合并' };
  const maxRetries = opts.maxRetries ?? 2;
  const lockedTexts = (feedback && Array.isArray(feedback.locked) ? feedback.locked : []).map((x) => x.content).filter(Boolean);
  let lastError = null;
  let lastIssues = [];
  let lastDraft = '';
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1500));
    // 重试切到独立校对提示，只带终检原因和上一版草稿；继续复读原始长提示
    // 容易把“请/注意”等被禁词再次喂回正文，也会让模型重新自由生成。
    const attemptPrompt = lastIssues.length
      ? mergeRetryFeedback(lastIssues, lastDraft)
      : prompt;
    // 450-550 字正文还要容纳场景示例和格式，900 对思考型兼容模型偏紧。
    const res = await callModel([{ role: 'user', content: attemptPrompt }], { maxTokens: 1400, temperature: 0.5, timeoutMs: 120000 });
    if (!res.ok) {
      lastError = res.error || '模型调用失败';
      lastIssues = ['模型调用失败'];
      continue;
    }
    const draft = String(res.data || '').trim();
    const maxChars = opts.maxChars ?? 600;
    const issues = checkStyleDraft(draft, { maxChars, locked: lockedTexts });
    if (issues.length === 0) return { ok: true, draft, tries: i + 1 };
    lastIssues = issues;
    lastDraft = draft;
    lastError = issues.join('；');
  }
  return { ok: false, error: lastError || '合并未通过质量检查' };
}


