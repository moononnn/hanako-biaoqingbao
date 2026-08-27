// 表情包配图卡片：calcCardAspectRatio 图片尺寸档位（v0.33.77/0.33.78/0.33.102）
// 覆盖：
//   - sizeMode 四档（auto/small/medium/large）与后端默认分支
//   - 固定档 + 小图自适应开：原图小于档位宽按原尺寸（不放大防糊）
//   - 固定档 + 小图自适应关：所有图一律按档位宽
//   - auto 档：智能开一律放大填满 400；关智能回退旧阈值行为
//   - v0.33.102 clamp：横图宽度 > 400（含超宽扁图）时 dispW 收敛到 400，不再撑出留白
//   - 尺寸缺失/非法回退默认 '400:430'（异常不炸）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 与 routes/ui.js 服务端渲染的内联脚本同一份档位定义（前后端口径同源）
const SIZE_MODE_WIDTH = { small: 160, medium: 260, large: 400 };
const BTN_RESERVE = 50; // 底部反馈按钮排预留：8(gap) + 30(按钮区) + 12(body padding)
const HOST_SLOT_MAX = 400;

// 复刻 tools/express.js 的 calcCardAspectRatio（v0.33.102 后）
function calcCardAspectRatio(size, smart, sizeMode) {
  if (!size || !size.width || !size.height) return '400:430';
  const ratio = size.height / size.width;
  let dispW;
  if (sizeMode && SIZE_MODE_WIDTH[sizeMode]) {
    const capW = SIZE_MODE_WIDTH[sizeMode];
    const minSide = Math.min(size.width, size.height);
    if (smart !== false && minSide < capW) {
      dispW = size.width; // 固定档 + 小图自适应开 + 原图小于档位宽 → 按原尺寸，不放大防糊
    } else {
      dispW = capW;
    }
  } else if (smart !== false) {
    dispW = HOST_SLOT_MAX; // 智能开：一律放大填满 400
  } else {
    const minSide = Math.min(size.width, size.height);
    dispW = minSide >= 200 ? 400 : size.width; // 关智能：回退旧行为
  }
  // v0.33.102 - 原尺寸分支的宽度收敛到宿主槽位 [50, 400]，与前端 fitCard 同口径
  dispW = Math.max(50, Math.min(400, Math.round(dispW)));
  const imgH = Math.round(dispW * ratio);
  const totalH = Math.min(600, imgH + BTN_RESERVE);
  return `400:${Math.round(totalH)}`;
}

function sizeOf(w, h) {
  return { width: w, height: h };
}

// 后端（tools/express.js）导出的真实实现必须与这里复刻的口径一致
// 用源码断言防止两边漂移（前端 inline 的 fitDecision 由 ui.js 的 SIZE_MODE_WIDTH 注入，同源）
test('express 源码的 calcCardAspectRatio 包含 v0.33.102 槽位 clamp（横图不再留白）', () => {
  const source = readFileSync(new URL('../tools/express.js', import.meta.url), 'utf8');
  assert.ok(source.includes('Math.min(400, Math.round(dispW))'), 'dispW 必须 clamp 到宿主 400 上限');
});

test('档位：固定小/中/大 + 小图自适应开，小图按原尺寸不放大', () => {
  // 80×80 小图，档位 small(160)：原图小于档位 → 按原尺寸 80，高 80 + 按钮
  assert.equal(calcCardAspectRatio(sizeOf(80, 80), true, 'small'), '400:130');
  // 180×180 图，档位 small(160)：原图大于档位 → 按档位 160
  assert.equal(calcCardAspectRatio(sizeOf(180, 180), true, 'small'), '400:210');
  // 180×180 图，档位 medium(260)：原图小于档位 → 按原尺寸 180
  assert.equal(calcCardAspectRatio(sizeOf(180, 180), true, 'medium'), '400:230');
  // 300×300 图，档位 medium(260)：原图大于档位 → 按档位 260
  assert.equal(calcCardAspectRatio(sizeOf(300, 300), true, 'medium'), '400:310');
  // 300×300 图，档位 large(400)：原图小于档位 → 按原尺寸 300
  assert.equal(calcCardAspectRatio(sizeOf(300, 300), true, 'large'), '400:350');
});

test('档位：固定档 + 小图自适应关，所有图一律按档位宽', () => {
  // 80×80 小图，档位 small(160)，关自适应 → 按档位 160（强制统一）
  assert.equal(calcCardAspectRatio(sizeOf(80, 80), false, 'small'), '400:210');
  // 300×300 图，档位 medium(260)，关自适应 → 按档位 260
  assert.equal(calcCardAspectRatio(sizeOf(300, 300), false, 'medium'), '400:310');
  // 600×600 图，档位 large(400)，关自适应 → 按档位 400
  assert.equal(calcCardAspectRatio(sizeOf(600, 600), false, 'large'), '400:450');
});

test('auto 档：智能开一律放大填满 400（新旧宿主同口径）', () => {
  assert.equal(calcCardAspectRatio(sizeOf(80, 80), true, 'auto'), '400:450');
  assert.equal(calcCardAspectRatio(sizeOf(400, 400), true, 'auto'), '400:450');
  assert.equal(calcCardAspectRatio(sizeOf(2000, 2000), true, 'auto'), '400:450');
});

test('auto 档：关智能回退旧阈值行为（≥200 放大填满、<200 原尺寸防糊）', () => {
  assert.equal(calcCardAspectRatio(sizeOf(100, 100), false, 'auto'), '400:150');
  assert.equal(calcCardAspectRatio(sizeOf(400, 200), false, 'auto'), '400:250');
});

test('v0.33.102 clamp：横图宽度超 400 不再撑出留白（与前端 min(400, naturalWidth) 同口径）', () => {
  // 横图 500×300，档位 large(400)，自适应开：原图宽 500 > 400 → 按档位 400，高 = 300*400/500 = 240 + 按钮
  assert.equal(calcCardAspectRatio(sizeOf(500, 300), true, 'large'), '400:290');
  // 横图 500×300，档位 large(400)，自适应关：同样按档位 400
  assert.equal(calcCardAspectRatio(sizeOf(500, 300), false, 'large'), '400:290');
  // 关智能 + 超宽扁图 1200×200（原尺寸分支，宽 > 400）：clamp 后按 400，高 = 200*400/1200 = 67 + 按钮
  assert.equal(calcCardAspectRatio(sizeOf(1200, 200), false, 'auto'), '400:117');
  // 关智能 + 小于阈值的窄横图 300×150（<200 原尺寸分支）：宽 300 < 400，原尺寸，高 = 150*300/300 = 150
  assert.equal(calcCardAspectRatio(sizeOf(300, 150), false, 'auto'), '400:200');
});

test('尺寸缺失/非法回退默认宽高比（异常不炸）', () => {
  assert.equal(calcCardAspectRatio(undefined, true, 'auto'), '400:430');
  assert.equal(calcCardAspectRatio(null, true, 'auto'), '400:430');
  assert.equal(calcCardAspectRatio({}, true, 'auto'), '400:430');
  assert.equal(calcCardAspectRatio({ width: 0, height: 0 }, true, 'auto'), '400:430');
  assert.equal(calcCardAspectRatio({ width: -1, height: 0 }, true, 'auto'), '400:430');
  assert.equal(calcCardAspectRatio({ width: Number.NaN, height: 100 }, true, 'auto'), '400:430');
});
