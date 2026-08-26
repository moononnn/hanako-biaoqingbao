#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""表情包悬浮球的纸飞机主体与连续动效。

窗口、拖拽、面板和发送逻辑留在 ball_app.py；本模块只处理 72px 画布内的
纸飞机、气体尾流与背景流星。纸飞机素材严格沿用参考图，不在绘制层补线改造。
"""

import ctypes
import math
import os
import sys

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QImage, QPainter, QPainterPath, QPen, QRadialGradient

VARIANT_PLANE = "plane"
VARIANT_LABELS = {VARIANT_PLANE: "纸飞机"}
VARIANTS = (VARIANT_PLANE,)
DEFAULT_VARIANT = VARIANT_PLANE
CLICK_DURATIONS = {VARIANT_PLANE: 0.74}

# 纸飞机素材本身已经按参考图朝右上方绘制，不能再用旋转角度重设计方向。
PLANE_BASE_ANGLE = 0.0
PLANE_ASSET_FILENAME = "plane_reference.png"
_PLANE_ASSET = None

INK = "#52635a"
MINT_DEEP = "#65a98d"
PINK_DEEP = "#b86f84"
TRAIL_APRICOT = "#e3b36c"
# 纸飞机主体和尾流共用一套缩放，再收小一点，但仍保留 72px 点击热区。
PLANE_MOTIF_SCALE = 0.74
# 以下是整体缩放前的局部坐标：首道波纹收低到尾巴尖尖附近，仍留出独立间距。
TRAIL_BAND_ORIGIN_Y = 23.5
TRAIL_PARTICLE_ORIGIN_Y = 25.0
# 点击冲刺接近水平飞出，只保留很轻微的上扬（避免斜上方飞走显得奇怪）。
PLANE_FLIGHT_SLOPE = -0.10
PLANE_FLIGHT_DISTANCE = 96.0
METEOR_MINT = "#a8d5bd"
METEOR_PINK = "#e7a8ba"
METEOR_CORE = "#fff8eb"

# 背景流星走固定轨道和周期，不用随机数，方便动画稳定、可复现、可测试。
IDLE_METEOR_TRACKS = (
    ((-14.0, -8.0, 68.0, 56.0), 0.72, 6.40, 0.72, 0.58),
    ((78.0, 2.0, 14.0, 62.0), 3.76, 7.20, 0.64, 0.48),
)
HOVER_METEOR_TRACK = (3.0, -10.0, 66.0, 48.0)
# 点击流星跟随接近水平的冲刺前进轴，作为尾流后面的轻量手帐笔触。
CLICK_METEOR_TRACKS = (
    (-28.0, 32.0, 104.0, 18.8),
    (-20.0, 49.0, 96.0, 37.4),
)


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, float(value)))


def lerp(start, end, amount):
    return start + (end - start) * amount


def ease_out_cubic(value):
    t = clamp(value)
    return 1.0 - (1.0 - t) ** 3


def ease_in_out_cubic(value):
    t = clamp(value)
    return 4.0 * t ** 3 if t < 0.5 else 1.0 - ((-2.0 * t + 2.0) ** 3) / 2.0


def system_animations_enabled():
    override = os.environ.get("BIAOQINGBAO_REDUCED_MOTION", "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return False
    if override in {"0", "false", "no", "off"}:
        return True
    if sys.platform != "win32":
        return True
    try:
        enabled = ctypes.c_int(1)
        # SPI_GETCLIENTAREAANIMATION：跟随 Windows“在 Windows 中显示动画”设置。
        ok = ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(enabled), 0)
        return bool(enabled.value) if ok else True
    except Exception:
        return True


def _color(value, alpha=255):
    color = QColor(value)
    color.setAlpha(max(0, min(255, int(alpha))))
    return color


def _pen(value, width=2.0, alpha=255):
    pen = QPen(_color(value, alpha))
    pen.setWidthF(float(width))
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    return pen


def normalize_variant(value):
    # 兼容旧配置读取；样式已经收束为纸飞机，旧值统一回落到唯一主体。
    return DEFAULT_VARIANT


def _plane_asset():
    """读取按参考图清理出的透明纸飞机；绘制层不自行补线或改造造型。"""
    global _PLANE_ASSET
    if _PLANE_ASSET is None:
        asset_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PLANE_ASSET_FILENAME)
        image = QImage(asset_path)
        if image.isNull():
            raise RuntimeError(f"纸飞机参考素材加载失败: {asset_path}")
        _PLANE_ASSET = image
    return _PLANE_ASSET


def _draw_plane_shape(painter):
    """严格绘制参考图资产，禁止在这里增加参考图之外的线条和装饰。"""
    image = _plane_asset()
    width = 58.0
    height = width * image.height() / image.width()
    target = QRectF(-width / 2.0, -height / 2.0, width, height)
    painter.drawImage(target, image)


def _periodic_progress(elapsed, start, period, duration):
    age = (elapsed - start) % period
    if age > duration:
        return None
    return ease_in_out_cubic(age / duration)


def _draw_meteor(painter, track, progress, strength=1.0):
    if progress is None or strength <= 0.01:
        return
    x0, y0, x1, y1 = track
    head_x = lerp(x0, x1, progress)
    head_y = lerp(y0, y1, progress)
    dx = x1 - x0
    dy = y1 - y0
    length = max(1.0, math.hypot(dx, dy))
    ux, uy = dx / length, dy / length
    tail_length = 5.0 + 9.0 * clamp(strength, 0.0, 1.8)
    tail_x = head_x - ux * tail_length
    tail_y = head_y - uy * tail_length
    alpha = int(48 + 88 * clamp(strength, 0.0, 1.8))
    color = METEOR_PINK if strength > 0.95 else METEOR_MINT

    painter.save()
    painter.setPen(_pen(color, 0.85 + 0.55 * clamp(strength, 0.0, 1.8), alpha))
    painter.drawLine(QPointF(tail_x, tail_y), QPointF(head_x, head_y))

    radius = 1.0 + 0.85 * clamp(strength, 0.0, 1.8)
    glow = QRadialGradient(head_x, head_y, radius * 3.8)
    glow.setColorAt(0.0, _color(METEOR_CORE, min(245, alpha + 70)))
    glow.setColorAt(0.35, _color(color, min(190, alpha + 25)))
    glow.setColorAt(1.0, _color(color, 0))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(glow)
    painter.drawEllipse(QRectF(head_x - radius * 3.8, head_y - radius * 3.8, radius * 7.6, radius * 7.6))
    painter.setBrush(_color(METEOR_CORE, min(255, alpha + 50)))
    painter.drawEllipse(QRectF(head_x - radius * 0.55, head_y - radius * 0.55, radius * 1.1, radius * 1.1))
    painter.restore()


def _draw_meteors(animator, painter):
    """画在纸飞机后面的周期流星，以及悬停/点击触发的即时流星。"""
    for track, start, period, duration, strength in IDLE_METEOR_TRACKS:
        progress = _periodic_progress(animator.elapsed, start, period, duration)
        _draw_meteor(painter, track, progress, strength)

    # 悬停只触发一次短促划过；鼠标停留时不把流星钉在背景中持续晃。
    hover_strength = clamp(max(animator.hover_amount * 0.72, animator.hover_burst))
    if animator.hover_burst > 0.03:
        progress = 0.5 if not animator.animations_enabled else 1.0 - clamp(animator.hover_burst)
        fade = 0.55 + 0.45 * clamp(animator.hover_burst)
        _draw_meteor(painter, HOVER_METEOR_TRACK, progress, (0.62 + 0.48 * hover_strength) * fade)

    click_strength = clamp(max(animator.click_progress, animator.click_burst))
    if click_strength > 0.03:
        if animator.click_burst > 0.01:
            progress = 1.0 - clamp(animator.click_burst)
        else:
            progress = animator.click_progress
        burst_strength = 1.05 + 0.75 * click_strength
        _draw_meteor(painter, CLICK_METEOR_TRACKS[0], progress, burst_strength)
        if click_strength > 0.35:
            _draw_meteor(painter, CLICK_METEOR_TRACKS[1], clamp(progress + 0.28), burst_strength * 0.82)


def _build_particle_table(seed=20260821, count=26):
    """用固定种子的确定性伪随机生成粒子参数表，动画可复现、可测试。"""
    state = seed

    def rand():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        return state / 0x7FFFFFFF

    table = []
    for _ in range(count):
        offset = rand()
        spread = (rand() - 0.5) * 21.0
        speed = 0.72 + 0.56 * rand()
        size = 0.8 + 0.6 * rand()
        color_index = int(rand() * 3)
        wobble_phase = rand() * 6.283185307179586
        table.append((offset, spread, speed, size, color_index, wobble_phase))
    return tuple(table)


# 尾流粒子表：offset 决定出生相位（均匀散布），其余决定漂移、大小、颜色与波动。
_TRAIL_PARTICLES = _build_particle_table()


def _trail_axis(click_boost):
    """气流主方向：巡航时从机尾向左下散开（比机身更陡向下，避免贴着重合），冲刺时拉平近水平。"""
    t = clamp((click_boost - 0.10) / 0.55)
    dx = lerp(-0.62, -0.97, t)
    dy = lerp(0.78, 0.26, t)
    length = max(1e-6, math.hypot(dx, dy))
    return dx / length, dy / length


def _draw_gas_trail(animator, painter, strength):
    """动态气体尾流：波纹带提供体积感，粒子流提供喷出→飘散→淡出的流动感。

    平时强度低：粒子稀疏、整体随呼吸包络时隐时现，像慢飞巡航；
    悬停强度上升：粒子变密、波纹变清晰；
    点击冲刺：气流方向拉平、粒子拉长成小段，像高速喷出的气流束。
    """
    strength = max(0.0, min(2.0, float(strength)))
    if strength <= 0.025:
        return
    phase = animator.elapsed
    click_boost = clamp(animator.click_burst + animator.click_progress)
    intensity = min(1.8, strength)
    # 流动速率：强度越高气流喷得越快。
    flow = 0.5 + 0.9 * intensity + 1.5 * click_boost
    # 呼吸包络：平时随正弦起伏若隐若现，悬停/点击时趋向稳定饱满。
    breathe = 0.45 + 0.55 * math.sin(phase * 1.6 + 1.3)
    breathe = lerp(breathe, 1.0, clamp(intensity * 0.85 + click_boost * 1.6))
    axis_x, axis_y = _trail_axis(click_boost)
    spread_t = clamp((click_boost - 0.10) / 0.55)
    colors = (MINT_DEEP, PINK_DEEP, TRAIL_APRICOT)
    alpha_base = max(0, min(255, int((140.0 + 55.0 * intensity) * breathe)))
    # 垂直气流方向的横向单位向量，用于粒子散布。
    side_x, side_y = -axis_y, axis_x

    painter.save()

    # —— 波纹带：从机尾下方留一点距离后散开的扇形气流，控制点随相位摆动形成流动感 ——
    # 起点逐级下移、方向逐条更陡，三条带子互相拉开，形成发散扇面。
    bands = (
        (-18.0, TRAIL_BAND_ORIGIN_Y, 24.0, 2.3, 0),
        (-19.6, TRAIL_BAND_ORIGIN_Y + 3.0, 32.0, 2.1, 1),
        (-21.2, TRAIL_BAND_ORIGIN_Y + 6.0, 40.0, 1.9, 2),
    )
    band_dirs = ((-0.72, 0.70), (-0.62, 0.78), (-0.52, 0.85))
    stretch = 1.0 + 0.14 * intensity
    for index, (sx, sy, base_len, base_w, color_index) in enumerate(bands):
        length = base_len * stretch
        wobble = math.sin(phase * (2.1 + index * 0.4) + index * 1.2) * (1.2 + 0.8 * intensity)
        bdx = lerp(band_dirs[index][0], -0.97, spread_t)
        bdy = lerp(band_dirs[index][1], 0.26, spread_t)
        blen = max(1e-6, math.hypot(bdx, bdy))
        bdx, bdy = bdx / blen, bdy / blen
        ex = sx + bdx * length
        ey = sy + bdy * length + wobble * 0.65
        c1x = sx + bdx * length * 0.35
        c1y = sy + bdy * length * 0.35 + wobble * 0.45
        c2x = sx + bdx * length * 0.72
        c2y = sy + bdy * length * 0.72 + wobble * 0.9
        path = QPainterPath()
        path.moveTo(QPointF(sx, sy))
        path.cubicTo(QPointF(c1x, c1y), QPointF(c2x, c2y), QPointF(ex, ey))
        painter.setPen(_pen(colors[color_index], base_w, int(alpha_base * 0.55)))
        painter.drawPath(path)

    # —— 粒子流：从机尾下缘喷出、向四周发散飘散、逐渐淡出；冲刺时拉长成短线 ——
    reach = 32.0 + 9.0 * intensity
    for (offset, spread, speed, size, color_index, wobble_phase) in _TRAIL_PARTICLES:
        age = (phase * flow * speed + offset) % 1.0
        if age < 0.10:
            fade = age / 0.10
        elif age > 0.70:
            fade = max(0.0, (1.0 - age) / 0.30)
        else:
            fade = 1.0
        if fade <= 0.02:
            continue
        along = age * reach
        sway = spread + math.sin(phase * 3.2 + wobble_phase) * (1.1 + 0.7 * intensity)
        x = -19.0 + axis_x * along + side_x * sway
        y = TRAIL_PARTICLE_ORIGIN_Y + axis_y * along + side_y * sway
        alpha = int(alpha_base * fade)
        if alpha <= 4:
            continue
        color = colors[color_index]
        if click_boost > 0.12:
            # 高速冲刺：粒子被气流拉成顺流向的小段，形成密集喷射感。
            streak = 2.4 + 3.6 * click_boost
            painter.setPen(_pen(color, max(0.8, size * 1.05), alpha))
            painter.drawLine(
                QPointF(x - axis_x * streak * 0.5, y - axis_y * streak * 0.5),
                QPointF(x + axis_x * streak * 0.5, y + axis_y * streak * 0.5),
            )
        else:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(_color(color, alpha))
            painter.drawEllipse(QRectF(x - size * 0.5, y - size * 0.5, size, size))
    painter.restore()


def _plane_click_pose(progress):
    """返回点击阶段的 x/y/角度/缩放；前进只带轻微右上倾角和颠簸。"""
    click = clamp(progress)
    if click < 0.16:
        prep = ease_out_cubic(click / 0.16)
        return -3.5 * prep, 0.7 * prep, 2.4 * prep, 1.0 - 0.035 * prep
    if click < 0.64:
        launch = ease_in_out_cubic((click - 0.16) / 0.48)
        travel = PLANE_FLIGHT_DISTANCE * launch
        bob = math.sin(launch * math.pi * 2.0)
        bob_detail = math.sin(launch * math.pi * 4.0 + 0.35)
        return (
            -3.5 + travel,
            0.7 + PLANE_FLIGHT_SLOPE * travel + 1.7 * bob + 0.3 * bob_detail,
            2.8 * math.sin(launch * math.pi * 2.0),
            0.97 + 0.05 * launch,
        )
    returning = ease_out_cubic((click - 0.64) / 0.36)
    bob = math.sin(returning * math.pi * 2.0)
    return (
        -72.0 + 72.0 * returning,
        -26.0 * (1.0 - returning) + 0.7 + 1.25 * bob,
        3.2 * (1.0 - returning) + 1.0 * bob,
        0.96 + 0.04 * returning,
    )


def _draw_plane(animator, painter, bounds):
    center = bounds.center()
    hover = animator.hover_amount * (1.0 if animator.animations_enabled else 0.30)
    raw_click = animator.click_progress
    click = raw_click if animator.animations_enabled else 0.0
    reduced_press = math.sin(raw_click * math.pi) * 0.045 if not animator.animations_enabled else 0.0
    phase = animator.elapsed
    pointer_x, pointer_y = animator.pointer
    drag_strength = animator.drag_amount
    drag_x = animator.drag_vector[0] * drag_strength
    drag_y = animator.drag_vector[1] * drag_strength
    active_pose = click > 0.0 or drag_strength > 0.0
    pose_hover = 0.0 if click > 0.0 else hover

    idle_x = 0.0 if active_pose else math.sin(phase * 1.15) * (2.1 + pose_hover * 1.4)
    idle_y = 0.0 if active_pose else math.sin(phase * 2.05 + 0.75) * (1.55 + pose_hover * 0.65) - pose_hover * 2.2
    # 待机时让机头随慢气流轻轻俯仰；进入悬停、拖拽或冲刺后由对应姿态接管。
    idle_angle = 0.0 if active_pose else math.sin(phase * 1.18 + 0.22) * 3.4 + pose_hover * math.sin(phase * 2.4) * 3.5
    angle = PLANE_BASE_ANGLE + idle_angle + pose_hover * pointer_y * 2.0
    if drag_strength > 0.0:
        angle += drag_x * 14.0 + drag_y * 4.0
    scale = 0.985 if drag_strength > 0.0 else 1.0 + pose_hover * 0.035 + reduced_press
    click_x = click_y = click_angle = 0.0

    if click > 0.0:
        # 在切换到左侧回航前，整机必须已经离开右边界，避免可见状态瞬移。
        click_x, click_y, click_angle, click_scale = _plane_click_pose(click)
        scale *= click_scale

    hover_strength = 0.10 + hover * 0.78 + animator.hover_burst * 0.72
    click_strength = animator.click_burst * 1.20 + click * 0.90
    arrival_strength = animator.arrival_burst * (1.15 if animator.animations_enabled else 0.85)
    trail_strength = min(2.0, hover_strength + click_strength + arrival_strength)
    if click > 0.56:
        # 进入右上离屏段时收掉尾流，避免飞机已离开后曲线还挂在画布边缘。
        trail_strength *= clamp((0.60 - click) / 0.04)

    _draw_meteors(animator, painter)
    painter.save()
    painter.translate(center.x() + idle_x + click_x, center.y() + idle_y + click_y)
    painter.rotate(angle + click_angle)
    painter.scale(scale * PLANE_MOTIF_SCALE, scale * PLANE_MOTIF_SCALE)
    _draw_gas_trail(animator, painter, trail_strength)
    _draw_plane_shape(painter)
    painter.restore()


class MotifAnimator:
    """纸飞机共用的一份可中断动画状态机。"""

    def __init__(self, variant=DEFAULT_VARIANT, animations_enabled=None):
        self.variant = normalize_variant(variant)
        self.animations_enabled = system_animations_enabled() if animations_enabled is None else bool(animations_enabled)
        self.elapsed = 0.0
        self.hover_amount = 0.0
        self.hover_target = 0.0
        self.hover_burst = 0.0
        self.click_burst = 0.0
        self.arrival_burst = 0.0
        self._click_elapsed = None
        self.pointer = (0.0, 0.0)
        self.dragging = False
        self.drag_vector = (0.0, 0.0)
        self.drag_release = 0.0

    @property
    def is_activating(self):
        return self._click_elapsed is not None

    @property
    def drag_amount(self):
        return 1.0 if self.dragging else clamp(self.drag_release)

    @property
    def click_duration(self):
        return 0.12 if not self.animations_enabled else CLICK_DURATIONS[self.variant]

    @property
    def click_progress(self):
        if self._click_elapsed is None:
            return 0.0
        return clamp(self._click_elapsed / max(0.001, self.click_duration))

    def set_variant(self, value):
        self.variant = normalize_variant(value)
        self.cancel_activation()
        self.dragging = False
        self.drag_vector = (0.0, 0.0)
        self.drag_release = 0.0
        self.arrival_burst = 0.0
        self.elapsed = 0.0

    def set_hovered(self, hovered):
        next_hovered = bool(hovered)
        if next_hovered and self.hover_target <= 0.0:
            self.hover_burst = 1.0
        self.hover_target = 1.0 if next_hovered else 0.0

    def set_pointer(self, x, y):
        self.pointer = (clamp(x, -1.0, 1.0), clamp(y, -1.0, 1.0))

    def set_dragging(self, dragging, x=0.0, y=0.0):
        next_dragging = bool(dragging)
        if next_dragging:
            self.dragging = True
            self.drag_vector = (clamp(x, -1.0, 1.0), clamp(y, -1.0, 1.0))
            self.drag_release = 1.0
            self.hover_target = 0.0
            self.cancel_activation()
            return
        if self.dragging and (abs(self.drag_vector[0]) > 0.001 or abs(self.drag_vector[1]) > 0.001):
            self.drag_release = 1.0
        self.dragging = False

    def trigger_arrival(self):
        """配图送达信号：只让尾流短暂变亮，不弹窗、不改变飞机姿态。"""
        self.arrival_burst = 1.0

    def trigger_activation(self):
        if self._click_elapsed is not None:
            return False
        self.drag_release = 0.0
        self.drag_vector = (0.0, 0.0)
        self.click_burst = 1.0
        self._click_elapsed = 0.0
        return True

    def cancel_activation(self):
        self._click_elapsed = None

    def tick(self, dt):
        dt = clamp(dt, 0.0, 0.05)
        if not self.dragging and self.drag_release > 0.0:
            self.drag_release = max(0.0, self.drag_release - dt / 0.12)
            if self.drag_release <= 0.0:
                self.drag_vector = (0.0, 0.0)
        self.hover_burst = max(0.0, self.hover_burst - dt / 1.15)
        self.click_burst = max(0.0, self.click_burst - dt / 0.95)
        arrival_duration = 0.16 if not self.animations_enabled else 1.05
        self.arrival_burst = max(0.0, self.arrival_burst - dt / arrival_duration)
        effective_hover_target = 0.0 if self.dragging else self.hover_target
        response = 14.0 if effective_hover_target > self.hover_amount else 9.0
        self.hover_amount += (effective_hover_target - self.hover_amount) * (1.0 - math.exp(-response * dt))
        motion_speed = 0.0 if not self.animations_enabled else 1.0 + 1.65 * self.hover_amount
        self.elapsed += dt * motion_speed
        if self._click_elapsed is None:
            return False
        self._click_elapsed += dt
        if self._click_elapsed + 1e-9 < self.click_duration:
            return False
        self._click_elapsed = None
        return True

    def paint(self, painter, bounds):
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        _draw_plane(self, painter, QRectF(bounds))
