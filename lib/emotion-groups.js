// lib/emotion-groups.js - 情绪词 → 6 大类的语义分组（公共模块）
//
// v0.27.0 从 tools/search-stickers.js 抽出，express 也共用：
// 方言表情气质联动需要把「具体情绪词」归到 6 大类才能查气质系数，
// 两份工具各留一份拷贝迟早会改岔，抽成公共模块。
//
// 6 大类：搞笑 / 开心 / 难过 / 无语 / 感谢 / 鼓励（与识图 prompt 一致）

export const EMOTION_SYNONYMS = {
  开心: ['开心', '高兴', '雀跃', '快乐', '得意', '偷着乐', '暗爽', '乐开花', '找到同类', '兴奋', '感动', '心动', '治愈', '心有灵犀', '恍然大悟', '得意洋洋', '喘息', '摸鱼得意', '渔翁得意'],
  难过: ['难过', '委屈', '委屈巴巴', '心碎', '受伤', '心疼', '丧', '丧到极点', 'emo', '崩溃', '崩溃边缘', '想哭', '心累', '破防'],
  无语: ['无语', '无奈', '嫌弃', '吐槽', '社死瞬间', '被噜住', '嫌弃脸', '阴阳怪气', '酸了', '柠檬精', '尴尬苦笑', '被逼到无语', '无语到极致'],
  搞笑: ['搞笑', '戏谵', '调侃', '整活', '扮酷', '戏精上身', '卖萌耍宝', '奶凶', '装酷', '装傻', '装懂', '装傻充狠', '撩人', '暧昧', '撒娇', '傲娇', '嘴硬', '心虚', '假装生气', '假装生气实则撒娇', '撒锅', '质问', '骚话'],
  感谢: ['感谢', '感动', '被理解的感动', '被治愈', '心有灵犀', '找到同类', '心怀感激', '撒娇式感谢', '找到同类的欣慰', '小众幽默共鸣', '自我认同'],
  鼓励: ['鼓励', '打气', '假装坚强', '自我安慰', '释然', '心有灵犀', '感动', '被理解的感动', '心怀感激', '找到同类'],
};

// 预计算反向索引：标签 → 所属语义组
export const TAG_TO_GROUP = {};
for (const [group, tags] of Object.entries(EMOTION_SYNONYMS)) {
  for (const tag of tags) {
    if (!TAG_TO_GROUP[tag]) TAG_TO_GROUP[tag] = [];
    TAG_TO_GROUP[tag].push(group);
  }
}

// 方言气质系数解析：给一组命中的情绪标签，算出方言气质系数（命中大类的系数平均）。
// 命中的标签可能跨大类（如「撒娇」属搞笑组），取平均避免单一标签带偏。
// 没命中任何大类或没开方言 bias 时返回 1（不影响原打分）。
export function resolveEmotionFactor(hitTags, bias) {
  if (!bias || !bias.emotion) return 1;
  const groups = new Set();
  for (const tag of hitTags) {
    for (const g of TAG_TO_GROUP[tag] || []) groups.add(g);
  }
  if (groups.size === 0) return 1;
  let sum = 0;
  for (const g of groups) sum += bias.emotion[g] ?? 1;
  return sum / groups.size;
}
