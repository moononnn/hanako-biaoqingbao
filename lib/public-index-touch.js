// 表情包 · 对外索引的轻量触发口
//
// 为什么单独一层：图库 / 分组 / 反馈 / 最近发送这几个模块都要在数据变动后喊一声，
// 但它们各自被 shared.js 串在一起，直接静态 import public-index.js 会形成循环。
// 这里用动态 import 把加载推迟到真正第一次有变动时，失败一律吞掉——
// 对外索引刷新失败绝不能反噬表情包自己的主流程。

let loader = null;

export function touchPublicIndex({ dataDir, agentIds } = {}) {
  if (!loader) loader = import('./public-index.js');
  loader
    .then((mod) => {
      mod.schedulePublicIndex({ dataDir, agentIds });
    })
    .catch(() => {});
}
