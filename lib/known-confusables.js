// lib/known-confusables.js - 易混淆角色对照表（v0.26.0）
//
// 背景：识图 prompt 的「报名字」规则上线后，模型开始认角色了，但高相似度角色会认错
// （如千早爱音被认成后藤一里：都是粉毛+面无表情+校服）。空泛的「核对两个特征」拦不住，
// 因为模型会「自以为核对了」。解法：把高频混淆的角色对写成具体辨别要点，识别时让模型对照。
//
// 用法：识图 prompt 动态拼接 buildConfusableSection() 的输出。
// 以后玥儿反馈「模型又认错 XX 了」，往这里加一组即可，prompt 模板不用动。
// 原则：
//   ① 只收「高频混淆」的角色/系列，不收百科全书
//   ② 特征只写稳定、可肉眼核对的（发型、瞳色、服装、标志物），不写主观描述
//   ③ 拿不准的细节不写（宁可少写不可写错）

export const KNOWN_CONFUSABLES = [
  {
    topic: '粉发少女',
    hint: '粉发少女容易混淆，报名字前先对照发型和服装：',
    entries: [
      { name: '千早爱音', traits: '粉金色短发、蓝眼睛、羽丘校服（粉衬衫+深绿领带）、无呆毛' },
      { name: '后藤一里', traits: '淡粉长发、头顶有呆毛、常穿运动服（孤独摇滚）' },
    ],
  },
];

// 生成识图 prompt 里的对照段落（零指令词不适用于此处，这是识图任务说明，直接陈述）
export function buildConfusableSection() {
  if (!KNOWN_CONFUSABLES.length) return '';
  const groups = KNOWN_CONFUSABLES.map((g) => {
    const items = g.entries.map((e) => `${e.name}：${e.traits}`).join('；');
    return `${g.topic}：${items}`;
  }).join('\n');
  return `高相似度角色容易认错，报名字前先对照以下辨别要点，对不上就只写外观描述：\n${groups}`;
}
