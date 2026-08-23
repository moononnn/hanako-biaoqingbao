// 表情包配图卡片：自适应二分化（v0.33.1）
//
// 规则定稿（2026-08-20）：废弃 v0.32.1 的四档智能封顶（160/280/480/640），
// 回到「自适应 = 卡片跟着图走」的直觉语义：
//   - 图片短边 < 400px：保持原尺寸、卡片贴原图（不放大，防糊）
//   - 图片短边 ≥ 400px：统一放大填满卡片（宿主槽位宽上限 400）
// 一句话：目标显示宽 = min(图片短边, 400)，卡片与内容同宽，所见即所得。
//
// 宿主（HanaAgent ≥0.447.x）槽位宽恒 400，响应 ui.resize 的宽度收窄（50~400 有效），
// 所以 <400 的图会整卡收缩贴图，≥400 的图撑满 400。
//
// 关闭「智能自适应」开关时回退 v0.24 旧行为（阈值 200：≥200 放大填满、<200 原尺寸），
// 保证用户手动关开关后的行为可预期、可逆。
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
  return minSide >= AUTO_FIT_MAX ? { fit: true, cap: AUTO_FIT_MAX } : { fit: false, cap: null };
}