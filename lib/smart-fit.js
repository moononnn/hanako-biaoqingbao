// 表情包配图卡片：自适应二分化（v0.33.1）→ v0.33.72 修正
//
// v0.33.1 规则（2026-08-20 定稿）：卡片跟着图走，短边 <400 贴原图小卡。
// 该规则依赖宿主响应 iframe 的 ui.resize 收缩宽度；0.686+（devkit 1.0 迁移）
// 聊天流内联插件卡片的 frame 是 width:100% + aspect-ratio 定高，ui.resize 不再生效，
// 小图会永远留在 400 宽的大白卡里撑不满（实测 0.686.15）。
//
// v0.33.72 规则（0.686+ 实机校准）：宿主宽度锁死后，自适应语义改为「小图放大填满」：
//   - 智能开（默认）：无论图多小，一律放大填满卡片宽度（回到 v0.24 直觉：所见即所得、无白边）
//   - 智能关：回退旧阈值行为（短边 ≥200 放大填满、<200 原尺寸防糊）
// 一句话：目标显示宽 = 卡片宽（放大填满），卡片高度按图比例 + 按钮区预留。
//
// 宿主（HanaAgent ≥0.447.x）槽位宽恒 400（聊天流容器基准），响应 ui.resize 的宽度收窄
// 只对 Chalkboard 卡片生效；聊天流内联卡片固定 aspectRatio。
export const AUTO_FIT_MAX = 400; // 卡片槽位宽上限（宿主恒定值）

/**
 * 返回自适应决策。
 * @param {number} minSide 图片短边（px）
 * @param {boolean} smart 是否启用自适应二分（默认 true）
 * @param {number} threshold 关闭智能时的旧阈值（默认 200，兼容 v0.24.0）
 * @returns {{ fit: boolean, cap: number|null }} fit=是否放大填满；cap=目标显示宽度上限（null=不放大/原尺寸）
 */
export function fitDecision(minSide, smart = true, threshold = 200) {
  if (!Number.isFinite(minSide) || minSide <= 0) return { fit: false, cap: null };
  if (!smart) return minSide >= threshold ? { fit: true, cap: null } : { fit: false, cap: null };
  // v0.33.72 - 智能开时一律放大填满（0.686+ 宽度锁死，<400 不再贴原尺寸）
  return { fit: true, cap: AUTO_FIT_MAX };
}