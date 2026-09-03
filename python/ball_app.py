#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""表情包 · 纸飞机桌面悬浮球。

纸飞机共用完整的桌面窗口与发送面板；Python 负责交互和绘制，图库读取、目标会话选择、
图片登记和发送都在 Node 代理完成。
"""

import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

from PyQt6.QtCore import QEvent, QObject, QRectF, Qt, QPoint, QSize, QTimer, QBuffer, QByteArray, QIODevice, pyqtSignal
from PyQt6.QtGui import QColor, QCursor, QIcon, QImage, QKeySequence, QMovie, QPainter, QPixmap, QKeyEvent, QShortcut
from PyQt6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsOpacityEffect,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QMenu,
    QScrollArea,
    QSizePolicy,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ball_motifs import DEFAULT_VARIANT, VARIANT_LABELS, MotifAnimator, normalize_variant

API_BASE = os.environ.get("BIAOQINGBAO_BALL_API", "http://127.0.0.1:18904").rstrip("/")
API_TOKEN = os.environ.get("BIAOQINGBAO_BALL_TOKEN", "")
STATE_PATH = os.environ.get(
    "BIAOQINGBAO_BALL_STATE_PATH",
    os.path.join(os.path.expanduser("~"), ".hanako", "plugin-data", "biaoqingbao", "ball-state.json"),
)
INITIAL_VARIANT = normalize_variant(os.environ.get("BIAOQINGBAO_BALL_VARIANT", DEFAULT_VARIANT))
BALL_SIZE = 72
PANEL_WIDTH = 320
PANEL_HEIGHT = 430
PANEL_ANCHOR_RATIO = 0.38
# 目标菜单内嵌时面板额外长高的量（标题 + 模式按钮 + 提示 + 5 项会话列表）
TARGET_MENU_EXTRA = 296
SEND_TIMEOUT = 60
STICKER_COLUMNS = 4
STICKER_TILE_SIZE = 62
STICKER_ICON_SIZE = 52
MENU_WIDTH = 180
EDGE_INSET = 16
RECENT_POLL_MS = 1500
RECENT_EXTRA_HEIGHT = 112
CHAT_EXTRA_HEIGHT = 292
PANEL_FADE_DELAY_MS = 1200
PANEL_FADE_OPACITY = 0.78
PANEL_FADE_POLL_MS = 80


def sticker_columns_for_width(width):
    available = max(0, int(width) - 42)
    for columns in (4, 3, 2, 1):
        required = columns * STICKER_TILE_SIZE + (columns - 1) * 5 + 4
        if required <= available:
            return columns
    return 1


def sticker_index_at(local_x, local_y, columns, count):
    """把 grid_host 内的局部坐标换算成表情包序号（clamp 到合法范围）。
    网格 margins 2、spacing 5、磁贴 62。
    """
    if count <= 0:
        return 0
    columns = max(1, int(columns))
    tile = STICKER_TILE_SIZE + 5
    col = (int(local_x) - 2) // tile
    row = (int(local_y) - 2) // tile
    index = row * columns + col
    return max(0, min(index, count - 1))


def reorder_items(items, from_index, to_index):
    """把 items[from_index] 移动到 to_index 位置，返回新列表（不改原列表）。"""
    if from_index == to_index or not items:
        return list(items)
    next_items = list(items)
    item = next_items.pop(from_index)
    next_items.insert(to_index, item)
    return next_items


def request_json(method, route, payload=None, timeout=10):
    data = None
    headers = {"Authorization": f"Bearer {API_TOKEN}"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(API_BASE + route, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            result = json.loads(raw or "{}")
            if response.status >= 400:
                result.setdefault("ok", False)
            return result
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8") or "{}")
        except Exception:
            result = {"ok": False, "error": f"HTTP {error.code}"}
        result.setdefault("ok", False)
        return result
    except Exception as error:
        return {"ok": False, "error": str(error)}


def load_image_data(sticker_id):
    result = request_json("GET", "/image?id=" + urllib.parse.quote(str(sticker_id)), timeout=15)
    if not result.get("ok") or not result.get("data"):
        return None
    try:
        return base64.b64decode(result["data"])
    except Exception:
        return None


def _looks_like_gif(data):
    """GIF 签名检测：GIF87a / GIF89a。动图识别前先保原始字节，别让 QImage 压成静态帧。"""
    return bool(data) and len(data) >= 6 and data[:3] == b'GIF' and data[3:6] in (b'87a', b'89a')


def _detect_image_ext(raw):
    """按真实字节签名识别图片格式。QQ 缓存文件名扩展名不可信（.gif 内容可能是 PNG/WebP），
    传错格式会让 Node 端拆帧报 Invalid GIF header。"""
    if not raw:
        return 'png'
    if raw[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if raw[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if len(raw) >= 12 and raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'webp'
    if raw[:2] == b'BM':
        return 'bmp'
    return 'png'


def image_to_base64(img, fmt="PNG"):
    """把 QImage/QPixmap 编码成 base64 字符串，返回 (b64, 扩展名)。"""
    if img is None or img.isNull():
        return None, None
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    ok = img.save(buffer, fmt)
    buffer.close()
    if not ok or buffer.data().isEmpty():
        return None, None
    data = bytes(buffer.data())
    return base64.b64encode(data).decode("ascii"), fmt.lower()


# 识图 IPC body 限额：Node 端 lib/ball.js maxBodyBytes 已抬到 8MB（防极端大图/GIF）
# 静态图 1.8MB 阈值够用（识图不需要太大，压缩无害）；GIF 动图单独放宽，别把中等动图压成静态帧
_RECOG_BODY_LIMIT = 1_800_000
_GIF_BODY_LIMIT = 7_000_000  # 8MB IPC 留 JSON 包装余量；QQ 动图 1~5MB 基本全覆盖
_RECOG_MAX_EDGE = 1024


def fit_recognition_image(image_b64, ext="png"):
    """拖入/粘贴的大图在识图前压缩，避免 IPC body 超限（413「body 太大」）。

    QQ 群表情包原图常达 1~5MB，base64 再膨胀 1/3。Node 端 IPC 现为 8MB：
      - GIF 动图：≤7MB 原样保留（Node 端拆帧识别完整动作）；只有超 7MB 的极端动图才降级压缩
      - 静态图：保持 1.8MB 渐进压缩（识别不需要那么大）
    渐进压缩，尽量保留质量：
      1. 未超限 → 原样保留（含 GIF 动图，保留 Node 端拆帧识别能力）
      2. 最长边 >1024 → 先缩到 1024
      3. PNG 编码 ≤1.8MB → 用 PNG（透明图优先保 PNG，只降分辨率）
      4. 无透明 → JPG 85；仍超 → 768/512 + JPG 80
    返回 (b64, 新扩展名)；解码失败或压缩失败时原样返回。
    """
    limit = _GIF_BODY_LIMIT if (ext or "").lower() == "gif" else _RECOG_BODY_LIMIT
    if not image_b64 or len(image_b64) <= limit:
        return image_b64, ext or "png"
    try:
        raw = base64.b64decode(image_b64)
    except Exception:
        return image_b64, ext or "png"
    img = QImage()
    img.loadFromData(raw)
    if img.isNull():
        return image_b64, ext or "png"

    def _b64(qi, qfmt, quality=None):
        buf = QBuffer()
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        ok = qi.save(buf, qfmt, quality) if quality is not None else qi.save(buf, qfmt)
        buf.close()
        if not ok or buf.data().isEmpty():
            return None
        return base64.b64encode(bytes(buf.data())).decode("ascii")

    def _scaled(qi, edge):
        w, h = qi.width(), qi.height()
        if w <= edge and h <= edge:
            return qi
        if w >= h:
            return qi.scaled(edge, max(1, round(h * edge / w)),
                             Qt.AspectRatioMode.KeepAspectRatio,
                             Qt.TransformationMode.SmoothTransformation)
        return qi.scaled(max(1, round(w * edge / h)), edge,
                         Qt.AspectRatioMode.KeepAspectRatio,
                         Qt.TransformationMode.SmoothTransformation)

    img = _scaled(img, _RECOG_MAX_EDGE)
    b64 = _b64(img, "PNG")
    if b64 and len(b64) <= _RECOG_BODY_LIMIT:
        return b64, "png"
    if img.hasAlphaChannel():
        # 透明图转 JPG 会黑底，优先只降分辨率保 PNG
        for edge in (768, 512):
            b64 = _b64(_scaled(img, edge), "PNG")
            if b64 and len(b64) <= _RECOG_BODY_LIMIT:
                return b64, "png"
        return image_b64, ext or "png"
    b64 = _b64(img, "JPG", 85)
    if b64 and len(b64) <= _RECOG_BODY_LIMIT:
        return b64, "jpg"
    for edge in (768, 512):
        b64 = _b64(_scaled(img, edge), "JPG", 80)
        if b64 and len(b64) <= _RECOG_BODY_LIMIT:
            return b64, "jpg"
    return image_b64, ext or "png"


def pixmap_to_base64(pixmap):
    """把 QPixmap 转 base64（优先 PNG，保留透明）。"""
    if pixmap is None or pixmap.isNull():
        return None, None
    return image_to_base64(pixmap.toImage(), "PNG")


def read_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        if isinstance(value, dict) and isinstance(value.get("x"), int) and isinstance(value.get("y"), int):
            return value
    except Exception:
        pass
    return {}


def write_state(x, y):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "x": int(x), "y": int(y)}, handle)
        os.replace(tmp, STATE_PATH)
    except Exception:
        pass


def popup_anchor_y(anchor_rect, popup_height, bounds, anchor_ratio):
    _, ay, _, ah = anchor_rect
    _, top, _, bottom = bounds
    y = ay + ah // 2 - int(popup_height * anchor_ratio)
    return max(top, min(y, bottom - popup_height))


def position_popup_beside(anchor_rect, popup_size, bounds, gap=8, anchor_ratio=PANEL_ANCHOR_RATIO, prefer_side="left"):
    """优先把面板放在悬浮球一侧，放不下时翻到另一侧。prefer_side 决定首选哪边。"""
    ax, ay, aw, ah = anchor_rect
    pw, ph = popup_size
    left, top, right, bottom = bounds
    left_x = ax - pw - gap
    right_x = ax + aw + gap
    if prefer_side == "right":
        x = right_x if right_x + pw <= right else left_x
    else:
        x = left_x if left_x >= left else right_x
    x = max(left, min(x, right - pw))
    y = popup_anchor_y(anchor_rect, ph, bounds, anchor_ratio)
    return x, y


def screen_bounds(widget):
    center = widget.geometry().center()
    screen = QApplication.screenAt(center) or QApplication.primaryScreen()
    if screen is None:
        return 0, 0, 1920, 1080
    geometry = screen.availableGeometry()
    return geometry.left(), geometry.top(), geometry.right() + 1, geometry.bottom() + 1


def clamp_ball_position(x, y, bounds):
    left, top, right, bottom = bounds
    return (
        max(left + EDGE_INSET, min(int(x), right - BALL_SIZE - EDGE_INSET)),
        max(top + EDGE_INSET, min(int(y), bottom - BALL_SIZE - EDGE_INSET)),
    )


class BackgroundRequest(QObject):
    """长时间网络请求使用 daemon 线程，关闭纸飞机时不拖着 Qt QThread 一起退出。"""

    done = pyqtSignal(object)
    finished = pyqtSignal()

    def __init__(self, fn, parent=None, name="biaoqingbao-request"):
        super().__init__(parent)
        self.fn = fn
        self.name = name
        self.cancelled = threading.Event()

    def start(self):
        threading.Thread(target=self._run, daemon=True, name=self.name).start()

    def cancel(self):
        self.cancelled.set()

    def _run(self):
        try:
            result = self.fn()
        except Exception as error:
            result = {"ok": False, "error": str(error)}
        if self.cancelled.is_set():
            return
        try:
            self.done.emit(result)
            self.finished.emit()
        except RuntimeError:
            pass


class MessageEdit(QTextEdit):
    send_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("messageEdit")
        self.setProperty("canSend", False)
        self.setAcceptRichText(False)
        self.setFixedHeight(64)
        self.setPlaceholderText("给这张表情包配一句话…")

    def keyPressEvent(self, event):
        if self.property("canSend") is True and event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and not (
            event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self.send_requested.emit()
            event.accept()
            return
        super().keyPressEvent(event)


class StickerButton(QPushButton):
    def __init__(self, item, pixmap, parent=None, on_context=None, on_drag=None):
        super().__init__(parent)
        self.item = item
        self.on_context = on_context
        self.on_drag = on_drag
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedSize(STICKER_TILE_SIZE, STICKER_TILE_SIZE)
        self.setIcon(QIcon(pixmap) if pixmap and not pixmap.isNull() else QIcon())
        self.setIconSize(QSize(STICKER_ICON_SIZE, STICKER_ICON_SIZE))
        # v0.33.38 - 面板上的 GIF 动图：QMovie 逐帧驱动图标，静止图不受影响；
        # 图标 QIcon 绘制时自动等比缩到 iconSize，不用手动算缩放
        self._movie = None
        self._movie_buffer = None
        self._movie_data = None
        raw_data = (item or {}).get("imageData")
        if raw_data and _looks_like_gif(bytes(raw_data)):
            # 坑：QBuffer(QByteArray(...), parent) 一行构造会持有临时 QByteArray 的悬垂指针，
            # 之后 QMovie.setDevice 读数据直接 access violation；QByteArray 必须存成员保活
            self._movie_data = QByteArray(bytes(raw_data))
            # 坑：QMovie(device, format, parent) 三参构造在 PyQt6 也 access violation，
            # 必须 setFormat/setDevice 分开调（实测踩坑）
            self._movie = QMovie(self)
            self._movie.setFormat(b"gif")
            # 生命周期坑：QBuffer 挂按钮（先销毁）时，播放中的 QMovie 会访问已销毁的
            # device → access violation（删除图片后 refresh 重建网格实测崩溃，exitCode 0xC0000005）。
            # 把 QBuffer 挂在 QMovie 下：销毁顺序 = QMovie 先停 → 再删 QBuffer，无悬垂窗口期
            self._movie_buffer = QBuffer(self._movie_data, self._movie)
            self._movie_buffer.open(QIODevice.OpenModeFlag.ReadOnly)
            self._movie.setDevice(self._movie_buffer)
            self._movie.frameChanged.connect(self._on_movie_frame)
            self._movie.start()
            self._movie.setPaused(True)  # 先停在首帧，面板显示时再播
        title = str(item.get("description") or item.get("file") or item.get("id") or "表情包")
        self.setAccessibleName(title)
        self.setProperty("selected", False)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_context)
        self.setStyleSheet(
            "QPushButton { background:transparent; border:1px solid transparent; border-radius:12px; padding:4px; }"
            "QPushButton:hover { border-color:#b6d1c4; background:#eef8f2; }"
            "QPushButton:pressed { border-color:#e89bb0; background:#fff0f4; }"
            "QPushButton[selected=\"true\"] { border-color:#e89bb0; background:#fff0f4; }"
            "QPushButton:disabled { background:transparent; border-color:transparent; }"
            "QPushButton[dragTarget=\"true\"] { border:2px solid #e89bb0; background:#fdf0f4; }"
        )
        self._press_pos = None
        self._dragging = False

    def _show_context(self, pos):
        if callable(self.on_context):
            global_pos = self.mapToGlobal(pos)
            self.on_context(self.item, global_pos)

    def _on_movie_frame(self, _frame):
        if self._movie is not None:
            pm = self._movie.currentPixmap()
            if pm and not pm.isNull():
                self.setIcon(QIcon(pm))

    def set_movie_playing(self, playing):
        """面板可见时播放动图，隐藏时暂停（省 CPU）。"""
        if self._movie is not None:
            self._movie.setPaused(not playing)

    def set_selected(self, selected):
        self.setProperty("selected", bool(selected))
        self.style().unpolish(self)
        self.style().polish(self)
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.globalPosition().toPoint()
            self._dragging = False
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._press_pos is not None and event.buttons() & Qt.MouseButton.LeftButton:
            if not self._dragging:
                delta = (event.globalPosition().toPoint() - self._press_pos).manhattanLength()
                if delta >= QApplication.startDragDistance():
                    self._dragging = True
                    self.setDown(False)
                    if callable(self.on_drag):
                        self.on_drag(self, "start", event.globalPosition().toPoint())
            elif callable(self.on_drag):
                self.on_drag(self, "move", event.globalPosition().toPoint())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._dragging and event.button() == Qt.MouseButton.LeftButton:
            was_dragging = self._dragging
            self._press_pos = None
            self._dragging = False
            if was_dragging and callable(self.on_drag):
                self.on_drag(self, "end", event.globalPosition().toPoint())
            event.accept()
            return
        self._press_pos = None
        self._dragging = False
        super().mouseReleaseEvent(event)


class AddStickerCell(QPushButton):
    """图集网格开头的「＋ 添加表情包」占位格：点击打开粘贴识别面板。"""

    def __init__(self, parent=None, on_add=None):
        super().__init__(parent)
        self.on_add = on_add
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedSize(STICKER_TILE_SIZE, STICKER_TILE_SIZE)
        self.setText('＋\n添加')
        self.setAccessibleName('添加表情包')
        self.setToolTip('粘贴或拖入图片，识图入库')
        self.setStyleSheet(
            'QPushButton { color:#84978d; background:#f4faf7; border:1px solid #d7e5dc; '
            'border-radius:12px; font-family:"Microsoft YaHei UI"; font-size:12px; }'
            'QPushButton:hover { color:#4a9277; border-color:#5dae8e; background:#eef8f2; }'
            'QPushButton:pressed { color:#437a65; border-color:#5dae8e; background:#e2f0e9; }'
            'QPushButton:disabled { color:#aabbb2; background:#f1f5f2; border-color:#d7e5dc; }'
        )
        if callable(on_add):
            self.clicked.connect(on_add)


class BallContextMenu(QFrame):
    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("contextMenu")
        self.setFixedWidth(MENU_WIDTH)

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(7)

        title = QLabel("纸飞机悬浮球")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        close = QPushButton("关闭悬浮球")
        close.setCursor(Qt.CursorShape.PointingHandCursor)
        close.clicked.connect(self.close_ball)
        root.addWidget(close)

        self.setStyleSheet(
            "QFrame#contextMenu { background:transparent; border:none; }"
            "QLabel#menuTitle { color:#437a65; background:transparent; font-family:'Microsoft YaHei UI'; font-size:12px; font-weight:700; }"
            "QLabel#menuHint { color:#84978d; background:transparent; font-family:'Microsoft YaHei UI'; font-size:9px; }"
            "QPushButton { min-height:32px; padding:0 12px; color:#46574f; background:#fffdf7; "
            "border:1px solid #d7e5dc; border-radius:10px; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QPushButton:hover { color:#437a65; border-color:#5dae8e; background:#eef8f2; }"
        )

    def close_ball(self):
        self.close()
        self.ball.close()
        QApplication.instance().quit()

    def show_at(self):
        bounds = screen_bounds(self.ball)
        rect = (self.ball.x(), self.ball.y(), self.ball.width(), self.ball.height())
        self.adjustSize()
        # 右键菜单与左键面板分侧：面板优先左侧，这里优先右侧，两个开着也不叠
        self.move(*position_popup_beside(rect, (self.width(), self.height()), bounds, anchor_ratio=0.33, prefer_side="right"))
        self.show()
        self.raise_()

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        shadow = QColor("#c7c0b4")
        shadow.setAlpha(45)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(QRectF(self.rect().adjusted(6, 7, -4, -2)), 16, 16)
        painter.setPen(QColor("#b6d1c4"))
        painter.setBrush(QColor("#fbf8ef"))
        painter.drawRoundedRect(QRectF(self.rect().adjusted(2, 2, -2, -5)), 16, 16)
        painter.end()


class StickerContextMenu(QFrame):
    """表情包右键菜单：从列表删除（只移出悬浮球）/ 整个删除（从图库彻底删）。
    「整个删除」带二次确认层，防止误删图库原图。
    """

    def __init__(self, panel, item, anchor_global):
        super().__init__(None)
        self.panel = panel
        self.item = item
        self.anchor_global = anchor_global
        self.sticker_id = str(item.get('id') or '')
        title = str(item.get('description') or item.get('file') or self.sticker_id or '表情包')
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName('stickerContextMenu')
        self.setFixedWidth(MENU_WIDTH)

        self.root = QVBoxLayout(self)
        self.root.setContentsMargins(12, 12, 12, 12)
        self.root.setSpacing(7)

        # 标题
        self.title = QLabel(title[:22])
        self.title.setObjectName('menuTitle')
        self.title.setWordWrap(True)
        self.root.addWidget(self.title)
        self.hint = QLabel('悬浮球里的表情包操作')
        self.hint.setObjectName('menuHint')
        self.root.addWidget(self.hint)

        # 主态：两个删除按钮
        self.btn_remove = QPushButton('从列表删除')
        self.btn_remove.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_remove.clicked.connect(self._remove_from_list)
        self.root.addWidget(self.btn_remove)
        self.btn_delete = QPushButton('整个删除')
        self.btn_delete.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_delete.setObjectName('deleteBtn')
        self.btn_delete.clicked.connect(self._enter_confirm)
        self.root.addWidget(self.btn_delete)

        # 确认层（默认隐藏）
        self.confirm_box = QFrame()
        self.confirm_box.setObjectName('confirmBox')
        c_root = QVBoxLayout(self.confirm_box)
        c_root.setContentsMargins(0, 2, 0, 2)
        c_root.setSpacing(7)
        self.confirm_tip = QLabel('从图库彻底删掉这张图\n（连同偏好、向量，不可恢复）')
        self.confirm_tip.setObjectName('confirmTip')
        self.confirm_tip.setWordWrap(True)
        c_root.addWidget(self.confirm_tip)
        confirm_row = QHBoxLayout()
        confirm_row.setSpacing(7)
        self.btn_confirm_cancel = QPushButton('取消')
        self.btn_confirm_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_confirm_cancel.clicked.connect(self._exit_confirm)
        confirm_row.addWidget(self.btn_confirm_cancel)
        self.btn_confirm_ok = QPushButton('确认删除')
        self.btn_confirm_ok.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_confirm_ok.setObjectName('confirmDeleteBtn')
        self.btn_confirm_ok.clicked.connect(self._confirm_delete)
        confirm_row.addWidget(self.btn_confirm_ok)
        c_root.addLayout(confirm_row)
        self.root.addWidget(self.confirm_box)
        self.confirm_box.hide()

        self.setStyleSheet(
            'QFrame#stickerContextMenu { background:transparent; border:none; }'
            'QLabel#menuTitle { color:#437a65; background:transparent; font-family:"Microsoft YaHei UI"; font-size:12px; font-weight:700; }'
            'QLabel#menuHint { color:#84978d; background:transparent; font-family:"Microsoft YaHei UI"; font-size:9px; }'
            'QPushButton { min-height:32px; padding:0 12px; color:#46574f; background:#fffdf7; '
            'border:1px solid #d7e5dc; border-radius:10px; font-family:"Microsoft YaHei UI"; font-size:12px; }'
            'QPushButton:hover { color:#437a65; border-color:#5dae8e; background:#eef8f2; }'
            'QPushButton#deleteBtn { color:#a05e72; border-color:#e8b7c8; }'
            'QPushButton#deleteBtn:hover { color:#d95f7f; border-color:#e89bb0; background:#fdf0f4; }'
            'QFrame#confirmBox { background:#fff7f9; border:1px solid #e8b7c8; border-radius:10px; }'
            'QLabel#confirmTip { color:#a05e72; font-size:11px; }'
            'QPushButton#confirmDeleteBtn { color:#fffdf7; background:#e89bb0; border:1px solid #e89bb0; }'
            'QPushButton#confirmDeleteBtn:hover { background:#d95f7f; }'
        )
        self.adjustSize()

    def _enter_confirm(self):
        self.btn_remove.hide()
        self.btn_delete.hide()
        self.confirm_box.show()
        self.adjustSize()
        self._reposition()

    def _exit_confirm(self):
        self.confirm_box.hide()
        self.btn_remove.show()
        self.btn_delete.show()
        self.adjustSize()
        self._reposition()

    def _remove_from_list(self):
        if not self.sticker_id:
            return
        worker = BackgroundRequest(
            lambda: request_json('POST', '/pin', {'stickerId': self.sticker_id, 'pinned': False}, timeout=8),
            self, 'biaoqingbao-sticker-unpin')
        self._worker = worker
        worker.done.connect(self._on_remove_done)
        worker.finished.connect(lambda: self._finish_worker(worker))
        worker.start()

    def _on_remove_done(self, result):
        ok = bool(result and result.get('ok'))
        if ok:
            self.panel.refresh()
            self.close()
        else:
            self.hint.setText(((result or {}).get('error') or '移出失败，再试一下') + '，右键重开菜单')

    def _confirm_delete(self):
        if not self.sticker_id:
            return
        worker = BackgroundRequest(
            lambda: request_json('POST', '/sticker-delete', {'stickerId': self.sticker_id}, timeout=15),
            self, 'biaoqingbao-sticker-delete')
        self._worker = worker
        worker.done.connect(self._on_delete_done)
        worker.finished.connect(lambda: self._finish_worker(worker))
        worker.start()

    def _on_delete_done(self, result):
        ok = bool(result and (result.get('ok') or result.get('deleted')))
        if ok:
            self.panel.refresh()
            self.close()
        else:
            self.confirm_tip.setText(((result or {}).get('error') or '删除失败，再试一下'))

    def _finish_worker(self, worker):
        # 菜单 worker 自行管辖（daemon 线程），无需从 panel 列表移除
        pass

    def _reposition(self):
        # 重新定位：确认层高度变化后仍贴近触发点
        rect = (self.anchor_global.x(), self.anchor_global.y(), 1, 1)
        bounds = screen_bounds(self.panel.ball)
        left, top, right, bottom = bounds
        x = self.anchor_global.x()
        y = self.anchor_global.y() + 4
        x = max(left, min(x, right - self.width()))
        y = max(top, min(y, bottom - self.height()))
        self.move(x, y)

    def show_at(self):
        self._reposition()
        self.show()
        self.raise_()

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        shadow = QColor('#c7c0b4')
        shadow.setAlpha(45)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(QRectF(self.rect().adjusted(6, 7, -4, -2)), 16, 16)
        painter.setPen(QColor('#b6d1c4'))
        painter.setBrush(QColor('#fbf8ef'))
        painter.drawRoundedRect(QRectF(self.rect().adjusted(2, 2, -2, -5)), 16, 16)
        painter.end()


class TargetMenu(QFrame):
    """对话目标选择：自动判断（跟随最近活跃窗口）/ 自己选择（固定某个会话）。
    数据来自代理 /sessions；选择通过 POST /target 写入，重启后仍保持。"""

    sessions_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.sessions = []
        self.loading_sessions = False
        self.sessions_error = ""
        self._request_seq = 0
        self.workers = []
        self.view_mode = "auto"
        self.sessions_ready.connect(self._apply_sessions)
        self.setObjectName("targetMenu")
        self._build()
        self.setStyleSheet(
            "QFrame#targetMenu { background:transparent; border:none; font-family:'Microsoft YaHei UI'; }"
            "QLabel { background:transparent; color:#46574f; }"
            "QLabel#menuTitle { font-size:13px; font-weight:700; color:#437a65; }"
            "QLabel#menuSub { font-size:10px; color:#84978d; padding-bottom:2px; }"
            "QPushButton#modeChoice { min-height:32px; padding:0 10px; color:#84978d; background:#fffdf7; "
            "border:1px solid #d7e5dc; border-radius:10px; font-size:12px; }"
            "QPushButton#modeChoice:hover { color:#437a65; background:#eef8f2; border-color:#5dae8e; }"
            "QPushButton#modeChoice[active=\"true\"] { color:#fffdf7; background:#5dae8e; border-color:#5dae8e; font-weight:600; }"
            "QWidget#targetListHost { background:transparent; border:none; }"
            "QPushButton#sessionItem { min-height:30px; max-height:30px; text-align:left; padding:0 9px; "
            "color:#46574f; background:#fffdf7; border:1px solid #d7e5dc; border-radius:10px; font-size:11px; }"
            "QPushButton#sessionItem:hover { background:#eef8f2; border-color:#5dae8e; }"
            "QPushButton#sessionItem[active=\"true\"] { color:#437a65; border-color:#5dae8e; background:#eef8f2; }"
        )
        self._sync_ui()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 11, 12, 11)
        root.setSpacing(6)

        title = QLabel("发到哪段对话？")
        title.setObjectName("menuTitle")
        root.addWidget(title)

        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.btn_auto = QPushButton("自动判断")
        self.btn_auto.setObjectName("modeChoice")
        self.btn_auto.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_auto.clicked.connect(self._pick_auto)
        mode_row.addWidget(self.btn_auto)
        self.btn_fixed = QPushButton("自己选择")
        self.btn_fixed.setObjectName("modeChoice")
        self.btn_fixed.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_fixed.clicked.connect(self._show_fixed)
        mode_row.addWidget(self.btn_fixed)
        root.addLayout(mode_row)

        self.lbl_mode_hint = QLabel("")
        self.lbl_mode_hint.setObjectName("menuSub")
        self.lbl_mode_hint.setWordWrap(True)
        root.addWidget(self.lbl_mode_hint)

        self.list_host = QWidget(self)
        self.list_host.setObjectName("targetListHost")
        self.list_host.setFixedHeight(185)  # 固定容纳 5 项会话的高度，面板展开高度不跳
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)

    # ── 状态 ──
    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _sync_ui(self):
        auto_on = self.view_mode == "auto"
        self.btn_auto.setProperty("active", "true" if auto_on else "false")
        self.btn_fixed.setProperty("active", "false" if auto_on else "true")
        self.btn_auto.style().unpolish(self.btn_auto)
        self.btn_auto.style().polish(self.btn_auto)
        self.btn_fixed.style().unpolish(self.btn_fixed)
        self.btn_fixed.style().polish(self.btn_fixed)
        self.lbl_mode_hint.setText(
            "刷新时自动判断最近活跃的对话" if auto_on else "从下面最近活跃的 5 个对话里固定一个"
        )
        self.list_host.setVisible(not auto_on)
        self._clear_list()
        if self.loading_sessions:
            lbl = QLabel("正在读取对话列表…")
            lbl.setObjectName("menuSub")
            self.list_box.addWidget(lbl)
            return
        if self.sessions_error:
            lbl = QLabel(self.sessions_error)
            lbl.setObjectName("menuSub")
            lbl.setWordWrap(True)
            self.list_box.addWidget(lbl)
            return
        if not self.sessions:
            lbl = QLabel("还没读取到可选对话")
            lbl.setObjectName("menuSub")
            self.list_box.addWidget(lbl)
            return
        for s in self.sessions:
            name = s.get("agentName") or s.get("agentId") or "未命名助手"
            title = (s.get("title") or "未命名对话").strip()
            btn = QPushButton()
            btn.setObjectName("sessionItem")
            btn.setText(btn.fontMetrics().elidedText(title, Qt.TextElideMode.ElideRight, 200))
            btn.setToolTip(f"{title}\n{name}")
            btn.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setProperty(
                "active",
                "true" if (self.ball.pinned_target and self.ball.pinned_target.get("sessionPath") == s.get("sessionPath")) else "false",
            )
            btn.clicked.connect(lambda checked=False, s=s: self._pick(s))
            self.list_box.addWidget(btn)
        self.list_box.addStretch(1)

    # ── 模式切换 ──
    def _show_fixed(self):
        if self.view_mode == "pinned":
            return
        self.view_mode = "pinned"
        self._sync_ui()

    def _pick_auto(self):
        self._request_seq += 1
        request_seq = self._request_seq
        worker = BackgroundRequest(lambda: request_json("POST", "/target", {}, timeout=5), self, "biaoqingbao-target")
        self.workers.append(worker)
        worker.done.connect(lambda result: self._on_pick_result(result, "auto", None, request_seq))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _pick(self, session):
        self._request_seq += 1
        request_seq = self._request_seq
        payload = {
            "sessionPath": session.get("sessionPath") or "",
            "agentId": session.get("agentId") or "",
            "title": session.get("title") or "",
        }
        worker = BackgroundRequest(lambda: request_json("POST", "/target", payload, timeout=5), self, "biaoqingbao-target")
        self.workers.append(worker)
        worker.done.connect(lambda result: self._on_pick_result(result, "pinned", session, request_seq))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _on_pick_result(self, result, mode, session, request_seq=None):
        if request_seq is not None and request_seq != self._request_seq:
            return
        if not result.get("ok"):
            self.lbl_mode_hint.setText("切换失败，原来的选择没有改变")
            return
        if mode == "auto":
            self.view_mode = "auto"
            self.ball.target_mode = "auto"
            self.ball.pinned_target = None
            self.ball.target_name = ""
            self.ball.target_title = ""
            self.ball.target_session_path = ""
        elif session:
            self.view_mode = "pinned"
            self.ball.target_mode = "pinned"
            self.ball.pinned_target = {
                "sessionPath": session.get("sessionPath") or "",
                "title": session.get("title") or "",
            }
            self.ball.target_name = session.get("agentName") or session.get("agentId") or ""
            self.ball.target_title = session.get("title") or ""
            self.ball.target_session_path = session.get("sessionPath") or ""
        self.panel._update_target()
        self.panel.invalidate_recent_requests()
        self.panel.refresh_recent_async()
        self.close()
        self.panel._sync_target_state()

    # ── 会话列表 ──
    def cancel_workers(self):
        self._request_seq += 1
        for worker in list(self.workers):
            cancel = getattr(worker, "cancel", None)
            if callable(cancel):
                cancel()
        self.workers.clear()

    def refresh_sessions_async(self):
        self._request_seq += 1
        request_seq = self._request_seq
        self.loading_sessions = True
        self.sessions_error = ""
        self._sync_ui()

        def worker():
            payload = {"seq": request_seq, "sessions": [], "mode": self.ball.target_mode, "pinned": self.ball.pinned_target, "error": "读取失败，关闭后重开再试"}
            try:
                data = request_json("GET", "/sessions", timeout=5)
                if data.get("ok"):
                    payload = {
                        "seq": request_seq,
                        "sessions": data.get("sessions") or [],
                        "mode": data.get("mode") or "auto",
                        "pinned": data.get("pinned"),
                        "error": "",
                    }
            except Exception:
                pass
            try:
                self.sessions_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="biaoqingbao-targetlist").start()

    def _apply_sessions(self, payload):
        if payload.get("seq") != self._request_seq:
            return
        self.loading_sessions = False
        self.sessions_error = payload.get("error") or ""
        self.sessions = (payload.get("sessions") or [])[:5]
        self.ball.target_mode = "pinned" if payload.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = payload.get("pinned")
        self.ball.target_session_path = (payload.get("pinned") or {}).get("sessionPath") or self.ball.target_session_path
        self.view_mode = "pinned" if self.ball.target_mode == "pinned" else self.view_mode
        self._sync_ui()
        self.panel._update_target()

    def apply_target_state(self):
        self.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
        self._sync_ui()

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor("#b6d1c4"))
        painter.setBrush(QColor("#fbf8ef"))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)
        painter.end()


class RecognizePanel(QFrame):
    """识图确认子面板：拖拽/粘贴一条表情包图进来，完成两步确认流程。

    状态 flow：
      preview  ->  [识别]  ->  editing（标签可编辑）
      editing  ->  [确认入库] -> 入库 + 自动加入悬浮球 + 向量 -> 完成关闭
      any      ->  [放弃]  -> 关闭
    """

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.image_b64 = None
        self.image_ext = 'png'
        self.source_name = None
        self.step = 'idle'
        self.busy = False
        self.request_seq = 0
        self.sticker_id = None
        self.setObjectName('recognizePanel')
        # 等待粘贴态捕获 Ctrl+V；WidgetWithChildrenShortcut 保证焦点在子控件时也能收到
        self._paste_shortcut = QShortcut(QKeySequence.StandardKey.Paste, self)
        self._paste_shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        self._paste_shortcut.activated.connect(self._on_paste_shortcut)
        self._paste_shortcut.setEnabled(False)
        self.setStyleSheet(
            'QFrame#recognizePanel { background:#f8fcf9; border:1px solid #d7e5dc; border-radius:13px; }'
            'QLabel { font-family:"Microsoft YaHei UI"; }'
            'QLabel#recogTitle { color:#437a65; font-size:12px; font-weight:700; }'
            'QLabel#recogStatus { color:#84978d; font-size:10px; }'
            'QLabel#recogPix { background:#f4faf7; border:1px solid #d7e5dc; border-radius:9px; }'
            'QLabel#recogLbl { color:#46574f; font-size:11px; font-weight:600; }'
            'QTextEdit { background:#fffdf7; border:1px solid #d7e5dc; border-radius:7px; color:#46574f; font-family:"Microsoft YaHei UI"; font-size:11px; padding:4px 6px; }'
            'QTextEdit:focus { border-color:#5dae8e; }'
            'QPushButton { min-height:26px; padding:0 10px; border-radius:9px; font-family:"Microsoft YaHei UI"; font-size:11px; }'
            'QPushButton#recogGo { color:#fffdf7; background:#5dae8e; border:1px solid #5dae8e; }'
            'QPushButton#recogGo:hover { background:#4f9d7e; }'
            'QPushButton#recogCancel { color:#84978d; background:#f4f7f5; border:1px solid #d7e5dc; }'
            'QPushButton#recogCancel:hover { border-color:#84978d; }'
        )
        self.build_ui()
        # v0.33.43 - 确认预览区动图：GIF 原样字节用 QMovie 播放（QLabel.setMovie），静态图走 QPixmap
        self._preview_movie = None
        self._preview_movie_buffer = None
        self._preview_movie_data = None
        self._pending_movie = None
        self._pending_pixmap = None
        self.hide()

    def build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 10, 12, 12)
        root.setSpacing(6)

        head = QHBoxLayout()
        head.setSpacing(7)
        self.title = QLabel('识别这张表情包')
        self.title.setObjectName('recogTitle')
        head.addWidget(self.title)
        head.addStretch(1)
        self.status = QLabel('')
        self.status.setObjectName('recogStatus')
        head.addWidget(self.status)
        root.addLayout(head)

        self.pix = QLabel('')
        self.pix.setObjectName('recogPix')
        self.pix.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.pix.setMinimumHeight(120)
        self.pix.setMaximumHeight(200)
        root.addWidget(self.pix, 1)

        self.lbl_desc = QLabel('描述')
        self.lbl_desc.setObjectName('recogLbl')
        root.addWidget(self.lbl_desc)
        self.edit_desc = QTextEdit(self)
        self.edit_desc.setMaximumHeight(54)
        root.addWidget(self.edit_desc)

        emo_row = QHBoxLayout()
        emo_row.setSpacing(8)
        self.lbl_emo = QLabel('情绪')
        self.lbl_emo.setObjectName('recogLbl')
        emo_row.addWidget(self.lbl_emo)
        self.edit_emo = QTextEdit(self)
        self.edit_emo.setMaximumHeight(48)
        self.edit_emo.setPlaceholderText('逗号分隔')
        emo_row.addWidget(self.edit_emo, 1)
        root.addLayout(emo_row)

        scene_row = QHBoxLayout()
        scene_row.setSpacing(8)
        self.lbl_scene = QLabel('场景')
        self.lbl_scene.setObjectName('recogLbl')
        scene_row.addWidget(self.lbl_scene)
        self.edit_scene = QTextEdit(self)
        self.edit_scene.setMaximumHeight(48)
        self.edit_scene.setPlaceholderText('逗号分隔')
        scene_row.addWidget(self.edit_scene, 1)
        root.addLayout(scene_row)

        kw_row = QHBoxLayout()
        kw_row.setSpacing(8)
        self.lbl_kw = QLabel('关键词')
        self.lbl_kw.setObjectName('recogLbl')
        kw_row.addWidget(self.lbl_kw)
        self.edit_kw = QTextEdit(self)
        self.edit_kw.setMaximumHeight(48)
        self.edit_kw.setPlaceholderText('逗号分隔')
        kw_row.addWidget(self.edit_kw, 1)
        root.addLayout(kw_row)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self.btn_cancel = QPushButton('放弃')
        self.btn_cancel.setObjectName('recogCancel')
        self.btn_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_cancel.clicked.connect(self.cancel)
        btn_row.addWidget(self.btn_cancel)
        self.btn_go = QPushButton('识别')
        self.btn_go.setObjectName('recogGo')
        self.btn_go.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_go.clicked.connect(self.on_primary)
        btn_row.addWidget(self.btn_go)
        root.addLayout(btn_row)

    # ── 定位：覆盖到父面板的几何区域之上 ──
    def cover(self):
        self.setGeometry(self.panel.rect())
        self.raise_()

    def wait_paste(self):
        """打开等待粘贴态：用户自己按 Ctrl+V 后才读取剪贴板图片。"""
        self.ball.close_auxiliary_menus()
        self.request_seq += 1
        self.busy = False
        self.sticker_id = None
        self.image_b64 = None
        self.step = 'wait_paste'
        self.title.setText('粘贴识别图片')
        self.status.setText('等待粘贴…')
        self.pix.setPixmap(QPixmap())
        self.pix.setText('请先复制一张表情包图片\n然后按 Ctrl+V 粘贴到此处')
        self._set_tag_editors_visible(False)
        self._paste_shortcut.setEnabled(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.show()
        self.cover()
        self.ball.raise_()
        self.activateWindow()
        self.setFocus()

    def _set_tag_editors_visible(self, visible):
        for w in (self.lbl_desc, self.edit_desc, self.lbl_emo, self.edit_emo,
                  self.lbl_scene, self.edit_scene, self.lbl_kw, self.edit_kw,
                  self.btn_go):
            w.setVisible(visible)

    def _read_clipboard_image(self):
        """读剪贴板图片：优先保留原始字节（动图不丢帧），其次本地图片文件 URL，位图 image 兜底。

        返回 (b64, ext, source_name)。GIF 动图原样保留字节并标 .gif，
        Node 端识图时会拆帧理解完整动作；静态图退化为 QImage → PNG。
        """
        clipboard = QApplication.clipboard()
        mime = clipboard.mimeData()
        img = None
        raw_gif = None
        raw_static = None
        source_name = None
        if mime:
            # ① 剪贴板直接带 GIF 原始字节（浏览器粘贴能拿原始动图就是靠 image/gif 格式）
            if mime.hasFormat('image/gif'):
                data = bytes(mime.data('image/gif')) if mime.data('image/gif') else b''
                if _looks_like_gif(data):
                    raw_gif = data
                    source_name = '粘贴图片.gif'
            # ② 本地图片文件 URL：QQ 等聊天软件复制动图时剪贴板带缓存原图文件引用
            #    （位图只是静态帧），必须优先读原始字节，不能先被位图分支吃掉
            if raw_gif is None and mime.hasUrls():
                for url in mime.urls():
                    if not url.isLocalFile():
                        continue
                    fp = url.toLocalFile()
                    lower = (fp or '').lower()
                    if lower.endswith('.png') or lower.endswith('.jpg') or lower.endswith('.jpeg') or lower.endswith('.gif') or lower.endswith('.webp') or lower.endswith('.bmp'):
                        try:
                            with open(fp, 'rb') as fh:
                                raw = fh.read()
                            if _looks_like_gif(raw):
                                raw_gif = raw
                                source_name = fp.rsplit('/', 1)[-1]
                            else:
                                raw_static = raw
                                source_name = fp.rsplit('/', 1)[-1]
                        except Exception:
                            raw_static = None
                        break
            # ③ 位图 image（兜底：没有文件引用时；此时动图只剩当前帧，属平台限制）
            if raw_gif is None and raw_static is None and mime.hasImage():
                img = clipboard.image()
                source_name = '粘贴图片.png'
        if raw_gif is not None:
            return base64.b64encode(raw_gif).decode('ascii'), 'gif', source_name
        if raw_static is not None:
            b64 = base64.b64encode(raw_static).decode('ascii')
            # 按真实字节签名给格式，不信文件扩展名（QQ 缓存 .gif 内容可能是 PNG/WebP）
            ext = _detect_image_ext(raw_static)
            if source_name and not source_name.lower().endswith('.' + ext):
                _base, _old_ext = os.path.splitext(source_name)
                source_name = _base + '.' + ext
            return b64, ext, source_name
        b64, ext = image_to_base64(img, 'PNG') if (img is not None and not img.isNull()) else (None, None)
        if not b64:
            return None, None, None
        return b64, ext or 'png', source_name

    def _on_paste_shortcut(self):
        if self.step != 'wait_paste':
            return
        b64, ext, source_name = self._read_clipboard_image()
        if not b64:
            self.status.setText('剪贴板里没有图片，先复制一张再试')
            return
        self.start(b64, ext, source_name)

    def start(self, image_b64, ext='png', source_name=None):
        self.ball.close_auxiliary_menus()
        self._paste_shortcut.setEnabled(False)
        self._set_tag_editors_visible(True)
        # 拖入/粘贴的大图先压缩，避免 IPC body 超限（413 body 太大）；GIF 动图未超限时原样保留
        image_b64, ext = fit_recognition_image(image_b64, ext)
        if source_name:
            _base, _old_ext = os.path.splitext(source_name)
            if _old_ext.lower().lstrip('.') != ext:
                source_name = _base + '.' + ext
        self.image_b64 = image_b64
        self.image_ext = ext or 'png'
        self.source_name = source_name
        self.busy = False
        self.request_seq += 1
        self.sticker_id = None
        self.set_step('preview')
        self.status.setText('确认识别这张图吗？')
        self.clear_tags()
        raw = base64.b64decode(image_b64) if image_b64 else b''
        # v0.33.43 - GIF 动图：确认预览直接播；静态图保持 QPixmap 路径
        self._stop_preview_movie()
        if raw and _looks_like_gif(raw):
            self._preview_movie_data = QByteArray(raw)
            self._preview_movie = QMovie(self)
            self._preview_movie.setFormat(b"gif")
            # 生命周期：QBuffer 挂 QMovie 下，销毁顺序 = QMovie 先停再删 buffer（面板/按钮销毁不崩）
            self._preview_movie_buffer = QBuffer(self._preview_movie_data, self._preview_movie)
            self._preview_movie_buffer.open(QIODevice.OpenModeFlag.ReadOnly)
            self._preview_movie.setDevice(self._preview_movie_buffer)
            self._pending_movie = self._preview_movie
            self._pending_pixmap = None
        else:
            pixmap = QPixmap()
            try:
                pixmap.loadFromData(raw)
            except Exception:
                pixmap = QPixmap()
            if pixmap.isNull():
                self.pix.setText('图片加载失败')
            else:
                self._pending_pixmap = pixmap
                self.pix.setText('图片加载中...')
        self.show()
        # 等父面板布局稳定后再定位 + 贴图，避免 px.width() 未初始化
        QTimer.singleShot(0, lambda: self._deferred_start())

    def _stop_preview_movie(self):
        """停掉当前预览动图（切图/取消时调用；QMovie 生命周期已安全，stop 只为省 CPU）。"""
        movie = getattr(self, '_preview_movie', None)
        if movie is not None:
            movie.stop()
        self._preview_movie = None
        self._preview_movie_buffer = None
        self._preview_movie_data = None
        self._pending_movie = None

    def _deferred_start(self):
        self.cover()
        self.ball.raise_()
        # 动图：QLabel.setMovie 直接播放，按预览区等比缩放
        if getattr(self, '_pending_movie', None) is not None:
            movie = self._pending_movie
            self._pending_movie = None
            avail_w = max(40, self.pix.width() - 8)
            avail_h = max(40, self.pix.height() - 8)
            try:
                # 拿原始尺寸用 QImage 解码第一帧（QBuffer/QImageReader 临时对象在 PyQt6 会堆损坏）
                probe = QImage()
                probe.loadFromData(bytes(self._preview_movie_data))
                if not probe.isNull() and probe.width() > 0 and probe.height() > 0:
                    movie.setScaledSize(probe.size().scaled(avail_w, avail_h, Qt.AspectRatioMode.KeepAspectRatio))
            except Exception:
                pass
            self.pix.setMovie(movie)
            movie.start()
            self.pix.setText('')
            return
        if getattr(self, '_pending_pixmap', None) is not None:
            pixmap = self._pending_pixmap
            self._pending_pixmap = None
            avail_w = max(40, self.pix.width() - 8)
            avail_h = max(40, self.pix.height() - 8)
            self.pix.setPixmap(pixmap.scaled(avail_w, avail_h, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
            self.pix.setText('')

    def set_step(self, step):
        self.step = step
        if step == 'preview':
            self.title.setText('识别这张表情包')
            self.btn_go.setText('识别')
            self.btn_go.setEnabled(True)  # 上一张入库后按钮被置灰，这里要恢复可用
        else:
            self.title.setText('确认入库')
            self.btn_go.setText('确认入库')
            self.btn_go.setEnabled(True)


    def clear_tags(self):
        self.edit_desc.setPlainText('')
        self.edit_emo.setPlainText('')
        self.edit_scene.setPlainText('')
        self.edit_kw.setPlainText('')

    def fill_tags(self, data):
        self.edit_desc.setPlainText(data.get('description') or '')
        self.edit_emo.setPlainText('，'.join(data.get('emotion') or []))
        self.edit_scene.setPlainText('，'.join(data.get('scene') or []))
        self.edit_kw.setPlainText('，'.join(data.get('keywords') or []))

    def collect_tags(self):
        def spl(t):
            return [x for x in (x.strip() for x in t.replace('，', ',').split(',')) if x]
        return {
            'description': self.edit_desc.toPlainText().strip(),
            'semantic_description': self.edit_desc.toPlainText().strip(),
            'emotion': spl(self.edit_emo.toPlainText()),
            'scene': spl(self.edit_scene.toPlainText()),
            'keywords': spl(self.edit_kw.toPlainText()),
        }

    def on_primary(self):
        if self.step == 'preview':
            self.run_recognition()
        else:
            self.confirm_save()

    def run_recognition(self):
        if self.busy:
            return
        self.busy = True
        self.status.setText('')
        self.btn_go.setText('识图中')
        self.btn_go.setEnabled(False)
        seq = self.request_seq
        payload = {'imageBase64': self.image_b64, 'fileName': self.source_name or f'ball_{int(time.time())}.{self.image_ext}'}
        worker = BackgroundRequest(lambda: request_json('POST', '/recognition', payload, timeout=90), self, 'biaoqingbao-recog')
        self._worker = worker
        worker.done.connect(lambda result, s=seq: self._on_recognition_done(result, s))
        worker.finished.connect(lambda: self._finish_worker(worker))
        worker.start()

    def _on_recognition_done(self, result, seq):
        if seq != self.request_seq:
            return
        self.busy = False
        if not result or not result.get('ok'):
            self.btn_go.setText('识别')
            self.btn_go.setEnabled(True)
            self.status.setText('识别失败：' + ((result or {}).get('error') or '未知错误'))
            return
        d = result.get('data') or {}
        # 记住 AI 自动识别的原始标签：确认入库时对比，用户改过才记教学样本
        self._auto_tags = {
            'description': str(d.get('description') or '').strip(),
            'keywords': sorted(str(x).strip() for x in (d.get('keywords') or []) if str(x).strip()),
        }
        self.fill_tags(d)
        self.set_step('editing')
        self.status.setText('识别完成，可编辑标签')
        self.cover()

    def confirm_save(self):
        if self.busy:
            return
        self.busy = True
        self.status.setText('入库中...')
        self.btn_go.setEnabled(False)
        seq = self.request_seq
        tags = self.collect_tags()
        # v0.26.0 教学机制：用户手动改过描述/关键词才记教学样本（AI 自动结果不算教学）
        auto = getattr(self, '_auto_tags', None)
        edited = False
        if auto:
            edited = (
                str(tags.get('description') or '').strip() != auto.get('description')
                or sorted(str(x).strip() for x in (tags.get('keywords') or []) if str(x).strip()) != auto.get('keywords')
            )
        payload = {'imageBase64': self.image_b64, 'fileName': self.source_name or f'ball_{int(time.time())}.{self.image_ext}', 'tags': tags, 'addToBall': True, 'teaching': edited}
        worker = BackgroundRequest(lambda: request_json('POST', '/recognition-confirm', payload, timeout=90), self, 'biaoqingbao-recog-confirm')
        self._worker = worker
        worker.done.connect(lambda result, s=seq: self._on_confirm_done(result, s))
        worker.finished.connect(lambda: self._finish_worker(worker))
        worker.start()

    def _on_confirm_done(self, result, seq):
        if seq != self.request_seq:
            return
        self.busy = False
        if not result or not result.get('ok'):
            self.status.setText('入库失败：' + ((result or {}).get('error') or '未知错误'))
            self.btn_go.setEnabled(True)
            return
        d = (result.get('data') or {})
        # 入库成功：保存 id → 刷新悬浮球图集 + 清最近配图缓存
        self.sticker_id = ((d.get('sticker') or {}) or {}).get('id') or self.sticker_id
        self.panel.invalidate_recent_requests()
        # 收起识别面板，自动切回主面板（图片网格），让用户看到完整图集
        self.cancel()
        self.panel.prepare_for_show()
        self.panel.show()
        self.panel.raise_()
        self.panel.activateWindow()

    def cancel(self):
        self.request_seq += 1
        self.busy = False
        self._paste_shortcut.setEnabled(False)
        self._stop_preview_movie()
        self.hide()

    def _finish_worker(self, worker):
        if worker in self.panel.workers:
            self.panel.workers.remove(worker)


class BallPanel(QFrame):
    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.items = []
        self.selected_sticker_id = None
        self.retry_confirmation_required = False
        self.sticker_columns = STICKER_COLUMNS
        self.busy = False
        self.workers = []
        self._drag_state = None
        self._buttons_by_id = {}
        # 面板自身拖动：拖动时纸飞机一起跟着走（保持相对位置）
        self._panel_drag = None
        self._panel_dragging = False
        self.target_menu = None
        self._target_seq = 0
        self.recent_match = None
        self.recent_signature = None
        self.recent_initialized = False
        self.recent_loading = False
        self.recent_request_seq = 0
        self.recent_busy = False
        self.recent_feedback_seq = 0
        # v0.33.48 - 配图手帐：独立忙碌/序号，不跟最近配图互锁
        self.history_busy = False
        self.history_feedback_seq = 0
        # 手帐读取走后台线程；独立代次防旧请求晚回时覆盖新列表
        self.history_request_seq = 0
        self.history_thumbs = []
        self.recent_timer = QTimer(self)
        self.recent_timer.setInterval(RECENT_POLL_MS)
        self.recent_timer.timeout.connect(self.refresh_recent_async)
        self._panel_outside_since = None
        self._fade_poll_timer = QTimer(self)
        self._fade_poll_timer.setInterval(PANEL_FADE_POLL_MS)
        self._fade_poll_timer.timeout.connect(self._refresh_panel_opacity)
        self.chat_sticker_id = None
        self.chat_session_id = None
        self.chat_suggestion = None
        self.chat_busy = False
        self.chat_request_seq = 0
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setFixedSize(PANEL_WIDTH, PANEL_HEIGHT)
        self.build_ui()

    def build_ui(self):
        self.setObjectName("panel")
        self.setStyleSheet(
            "QFrame#panel { background:transparent; border:none; }"
            "QScrollArea#stickerScroll { background:transparent; border:none; }"
            "QWidget#gridHost { background:transparent; }"
            "QLabel#hint { color:#84978d; background:transparent; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QPushButton#targetBtn { min-height:26px; padding:0 10px; text-align:left; color:#46574f; background:#fffdf7; "
            "border:1px solid #d7e5dc; border-radius:9px; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QPushButton#targetBtn:hover { color:#437a65; border-color:#5dae8e; background:#eef8f2; }"
            "QLabel#targetLabel { color:#84978d; background:transparent; font-family:'Microsoft YaHei UI'; font-size:10px; padding-bottom:1px; }"
            "QPushButton#targetSel { min-height:24px; padding:0 9px; color:#4a9277; background:#f4faf7; "
            "border:1px solid #d7e5dc; border-radius:8px; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            "QPushButton#targetSel:hover { color:#437a65; border-color:#5dae8e; background:#eef8f2; }"
            "QLabel#targetInfo { color:#84978d; background:transparent; font-family:'Microsoft YaHei UI'; font-size:10px; padding-left:2px; }"
            "QTextEdit#messageEdit { color:#46574f; background:#fffdf7; border:1px solid #d7e5dc; "
            "border-radius:10px; padding:7px 9px; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QTextEdit#messageEdit:focus { border-color:#5dae8e; }"
            "QPushButton#sendButton { min-height:32px; padding:0 14px; color:#fffdf7; background:#5dae8e; "
            "border:1px solid #5dae8e; border-radius:10px; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QPushButton#sendButton:hover { background:#4f9d7e; border-color:#4f9d7e; }"
            "QPushButton#sendButton:disabled { color:#aabbb2; background:#e6eee9; border-color:#d7e5dc; }"
            "QFrame#recentCard { background:#fffdf7; border:1px solid #d7e5dc; border-radius:13px; }"
            "QLabel#recentThumb { background:#f4faf7; border:1px solid #d7e5dc; border-radius:9px; }"
            "QLabel#recentTitle { color:#437a65; font-family:'Microsoft YaHei UI'; font-size:11px; font-weight:700; }"
            "QLabel#recentDescription { color:#46574f; font-family:'Microsoft YaHei UI'; font-size:12px; }"
            "QLabel#recentMeta { color:#84978d; font-family:'Microsoft YaHei UI'; font-size:10px; }"
            "QPushButton#recentFeedback { min-height:26px; padding:0 8px; color:#4a9277; background:#fffdf7; border:1px solid #c9ded2; border-radius:9px; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            "QPushButton#recentFeedback:hover { background:#eef8f2; border-color:#5dae8e; }"
            "QPushButton#recentFeedback[feedback='positive'][active='true'] { color:#fffdf7; background:#5dae8e; border-color:#5dae8e; }"
            "QPushButton#recentFeedback[feedback='negative'][active='true'] { color:#fffdf7; background:#e89bb0; border-color:#e89bb0; }"
            "QPushButton#recentChat { min-height:26px; padding:0 8px; color:#a05e72; background:#fff7f9; border:1px solid #e8b7c8; border-radius:9px; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            "QPushButton#recentChat:hover { background:#fdf0f4; border-color:#e89bb0; }"
            "QPushButton#recentFeedback:disabled, QPushButton#recentChat:disabled { color:#aabbb2; background:#f1f5f2; border-color:#d7e5dc; }"
            "QMenu#positiveFeedbackMenu { background:#fffdf7; border:1px solid #d7e5dc; border-radius:10px; padding:5px; }"
            "QMenu#positiveFeedbackMenu::item { color:#46574f; background:transparent; padding:7px 14px; border-radius:7px; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            "QMenu#positiveFeedbackMenu::item:selected { color:#437a65; background:#eef8f2; }"
            "QFrame#chatPanel { background:#f8fcf9; border:1px solid #d7e5dc; border-radius:13px; }"
            "QFrame#historyPanel { background:transparent; border:none; }"
            "QLabel#historyEmpty { color:#84978d; font-family:'Microsoft YaHei UI'; font-size:11px; padding:28px 0; }"
            "QLabel#chatTitle { color:#437a65; font-family:'Microsoft YaHei UI'; font-size:12px; font-weight:700; }"
            "QLabel#chatStatus { color:#84978d; font-family:'Microsoft YaHei UI'; font-size:10px; }"
            "QPushButton#chatClose, QPushButton#chatChoice { min-height:26px; padding:0 9px; color:#4a9277; background:#fffdf7; border:1px solid #c9ded2; border-radius:9px; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            "QPushButton#chatClose:hover, QPushButton#chatChoice:hover { background:#eef8f2; border-color:#5dae8e; }"
            "QScrollArea#chatScroll { background:#f4faf7; border:1px solid #e2eee8; border-radius:9px; }"
            "QWidget#chatMessagesHost { background:transparent; }"
            "QFrame#chatPreview { background:#fff7f9; border:1px solid #e8b7c8; border-radius:9px; }"
            "QLabel#chatPreviewTitle { color:#a05e72; font-family:'Microsoft YaHei UI'; font-size:11px; font-weight:700; }"
            "QLabel#chatPreviewText { color:#46574f; font-family:'Microsoft YaHei UI'; font-size:10px; line-height:1.5; }"
            # 滚动条统一：细薄荷圆条（与网页端同规范，2026-08-26）
            "QScrollBar:vertical { background:transparent; width:8px; margin:0; }"
            "QScrollBar::handle:vertical { background:#c9dfd3; border-radius:4px; min-height:28px; }"
            "QScrollBar::handle:vertical:hover { background:#5dae8e; }"
            "QScrollBar:horizontal { background:transparent; height:8px; margin:0; }"
            "QScrollBar::handle:horizontal { background:#c9dfd3; border-radius:4px; min-width:28px; }"
            "QScrollBar::handle:horizontal:hover { background:#5dae8e; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical, QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { height:0; width:0; }"
            "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical, QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background:transparent; }"
        )
        root = QVBoxLayout(self)
        root.setContentsMargins(14, 12, 14, 14)
        root.setSpacing(6)

        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("当前对话")
        self.lbl_target_label.setObjectName("targetLabel")
        target_row.addWidget(self.lbl_target_label)
        self.btn_target = QPushButton("自动判断 ▾")
        self.btn_target.setObjectName("targetSel")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.setToolTip("选择要把表情包发到哪段对话")
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.btn_target)
        target_row.addStretch(1)
        # v0.33.48 - 配图手帐：查看最近配过的图，可以喜欢/不喜欢或找小花聊聊
        self.btn_history = QPushButton("配图手帐")
        self.btn_history.setObjectName("targetSel")
        self.btn_history.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_history.setToolTip("看看最近配过哪些表情包，喜欢/不喜欢或找小花聊聊")
        self.btn_history.clicked.connect(self.open_history_panel)
        target_row.addWidget(self.btn_history)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("正在定位对话…")
        self.lbl_target_info.setObjectName("targetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        self._build_recent_card()
        root.addWidget(self.recent_card)

        self._build_chat_panel()
        root.addWidget(self.chat_panel)

        self.scroll = QScrollArea()
        self.scroll.setObjectName("stickerScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.scroll.setAutoFillBackground(False)
        self.scroll.viewport().setAutoFillBackground(False)
        self.grid_host = QWidget()
        self.grid_host.setObjectName("gridHost")
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(2, 2, 2, 2)
        self.grid.setSpacing(5)
        self.grid.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter)
        self.scroll.setWidget(self.grid_host)

        self._build_history_panel()

        # v0.33.48 - 图集网格 / 配图手帐同位置切换（QStackedWidget，无跳动）
        self.stack = QStackedWidget()
        self.stack.addWidget(self.scroll)
        self.stack.addWidget(self.history_panel)
        root.addWidget(self.stack, 1)

        self.hint = QLabel("去管理页添加你的优选表情包")
        self.hint.setObjectName("hint")
        self.hint.setWordWrap(True)
        self.hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(self.hint)

        self.editor = MessageEdit(self)
        self.editor.send_requested.connect(self.send_selected)
        self.editor.textChanged.connect(self.reset_retry_confirmation)
        root.addWidget(self.editor)

        self.send_button = QPushButton("发送")
        self.send_button.setObjectName("sendButton")
        self.send_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.send_button.clicked.connect(self.send_selected)
        root.addWidget(self.send_button)
        self.update_button_states()
        self.recog_panel = RecognizePanel(self)

    def paste_from_clipboard(self):
        """打开粘贴识别面板：用户自己 Ctrl+V 后才读取剪贴板图片，不再自动读。"""
        if not self.isVisible():
            self.prepare_for_show()
            self.show()
            self.raise_()
            self.activateWindow()
        self.recog_panel.wait_paste()

    def open_drop_recognition(self, image_b64, ext='png', source_name=None):
        """拖拽/粘贴进来的图片，打开识图确认弹窗。"""
        if not self.isVisible():
            self.prepare_for_show()
            self.show()
            self.raise_()
            self.activateWindow()
        self.recog_panel.start(image_b64, ext, source_name)

    def _open_sticker_context_menu(self, item, global_pos):
        """表情包按钮右键弹出操作菜单。再次右键同一张图 = 收起（不重弹）。"""
        menu = getattr(self, '_sticker_menu', None)
        if menu is not None and menu.isVisible():
            if str(menu.sticker_id) == str(item.get('id') or ''):
                # 再次右键同一张图：收起
                menu.close()
                self._sticker_menu = None
                return
            # 右键另一张图：先关旧的，避免叠几个菜单
            menu.close()
        menu = StickerContextMenu(self, item, global_pos)
        self._sticker_menu = menu
        menu.show_at()

    def _build_recent_card(self):
        self.recent_card = QFrame(self)
        self.recent_card.setObjectName("recentCard")
        self.recent_card.setMinimumHeight(102)
        root = QHBoxLayout(self.recent_card)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(8)

        self.recent_thumb = QLabel(self.recent_card)
        self.recent_thumb.setObjectName("recentThumb")
        self.recent_thumb.setFixedSize(62, 62)
        self.recent_thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(self.recent_thumb, 0, Qt.AlignmentFlag.AlignTop)

        info = QVBoxLayout()
        info.setContentsMargins(0, 0, 0, 0)
        info.setSpacing(2)
        self.recent_title = QLabel("最近配图")
        self.recent_title.setObjectName("recentTitle")
        info.addWidget(self.recent_title)
        self.recent_description = QLabel("")
        self.recent_description.setObjectName("recentDescription")
        self.recent_description.setWordWrap(True)
        self.recent_description.setMaximumHeight(34)
        info.addWidget(self.recent_description)
        self.recent_meta = QLabel("")
        self.recent_meta.setObjectName("recentMeta")
        info.addWidget(self.recent_meta)

        self.recent_button_host = QWidget(self.recent_card)
        self.recent_button_layout = QGridLayout(self.recent_button_host)
        self.recent_button_layout.setContentsMargins(0, 2, 0, 0)
        self.recent_button_layout.setSpacing(5)
        self.recent_like_button = QPushButton("喜欢", self.recent_button_host)
        self.recent_like_button.setObjectName("recentFeedback")
        self.recent_like_button.setProperty("feedback", "positive")
        # v0.33.63 - 正反馈拆两键：喜欢（图本身）/ 应景（这次配得贴），不再弹下拉
        self.recent_like_button.clicked.connect(lambda: self.feedback_recent("positive", "image"))
        self.recent_fit_button = QPushButton("应景", self.recent_button_host)
        self.recent_fit_button.setObjectName("recentFeedback")
        self.recent_fit_button.setProperty("feedback", "positive")
        self.recent_fit_button.clicked.connect(lambda: self.feedback_recent("positive", "context"))
        self.recent_dislike_button = QPushButton("不喜欢", self.recent_button_host)
        self.recent_dislike_button.setObjectName("recentFeedback")
        self.recent_dislike_button.setProperty("feedback", "negative")
        self.recent_dislike_button.clicked.connect(lambda: self.feedback_recent("negative"))
        self.recent_chat_button = QPushButton("和小花聊一聊", self.recent_button_host)
        self.recent_chat_button.setObjectName("recentChat")
        self.recent_chat_button.clicked.connect(self.open_recent_chat)
        self.recent_buttons = [self.recent_like_button, self.recent_fit_button, self.recent_dislike_button, self.recent_chat_button]
        info.addWidget(self.recent_button_host)
        root.addLayout(info, 1)
        self.recent_card.hide()
        self._layout_recent_buttons()

    # ─── 配图手帐（v0.33.48）：最近配图历史，喜欢/不喜欢/聊聊 ───
    def _build_history_panel(self):
        self.history_panel = QFrame(self)
        self.history_panel.setObjectName("historyPanel")
        root = QVBoxLayout(self.history_panel)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(6)

        head = QHBoxLayout()
        head.setSpacing(7)
        title = QLabel("配图手帐")
        title.setObjectName("recentTitle")
        head.addWidget(title)
        head.addStretch(1)
        self.history_close_btn = QPushButton("返回")
        self.history_close_btn.setObjectName("chatClose")
        self.history_close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.history_close_btn.clicked.connect(self.close_history_panel)
        head.addWidget(self.history_close_btn)
        root.addLayout(head)

        self.history_scroll = QScrollArea()
        self.history_scroll.setObjectName("stickerScroll")
        self.history_scroll.setWidgetResizable(True)
        self.history_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.history_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.history_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.history_scroll.setAutoFillBackground(False)
        self.history_scroll.viewport().setAutoFillBackground(False)
        self.history_host = QWidget()
        self.history_host.setObjectName("gridHost")
        self.history_list = QVBoxLayout(self.history_host)
        self.history_list.setContentsMargins(0, 0, 0, 0)
        self.history_list.setSpacing(6)
        self.history_scroll.setWidget(self.history_host)
        root.addWidget(self.history_scroll, 1)

        self.history_empty = QLabel("还没有配过表情包，去给小花发一张吧")
        self.history_empty.setObjectName("historyEmpty")
        self.history_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(self.history_empty)
        self.history_panel.hide()

    def open_history_panel(self):
        self.history_panel.show()
        self.stack.setCurrentWidget(self.history_panel)
        self.hint.hide()
        self.editor.hide()
        self._load_history()
        self.move_to_ball()

    def close_history_panel(self):
        self.stack.setCurrentWidget(self.scroll)
        self.history_panel.hide()
        self.hint.show()
        self.editor.show()
        self.move_to_ball()

    def _load_history(self):
        self.history_request_seq += 1
        request_seq = self.history_request_seq
        self.history_thumbs.clear()
        while self.history_list.count():
            item = self.history_list.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        self.history_empty.hide()
        self.history_empty.setText("正在翻手帐…")
        self.history_empty.show()
        worker = BackgroundRequest(self._fetch_history, self, "biaoqingbao-history")
        self.workers.append(worker)
        worker.done.connect(lambda result, seq=request_seq: self._render_history(result, seq))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _fetch_history(self):
        result = request_json("GET", "/recent-matches?limit=10", timeout=15)
        if not result.get("ok"):
            return {"ok": False, "error": result.get("error") or "读取配图记录失败"}
        matches = result.get("matches") or []
        if not matches:
            return {"ok": True, "items": []}
        def _load(m):
            copy = dict(m)
            copy["imageData"] = load_image_data(m.get("stickerId"))
            return copy
        with ThreadPoolExecutor(max_workers=min(6, max(1, len(matches)))) as ex:
            items = list(ex.map(_load, matches))
        return {"ok": True, "items": items}

    def _render_history(self, result, request_seq=None):
        if request_seq is not None and request_seq != self.history_request_seq:
            return
        if not result.get("ok"):
            self.history_empty.setText(str(result.get("error") or "读取失败，再试一下"))
            self.history_empty.show()
            return
        items = result.get("items") or []
        if not items:
            self.history_empty.setText("还没有配过表情包，去给小花发一张吧")
            self.history_empty.show()
            return
        self.history_empty.hide()
        for m in items:
            self._add_history_row(m)
        self.move_to_ball()

    def _add_history_row(self, m):
        row = QFrame(self.history_host)
        row.setObjectName("recentCard")
        lay = QHBoxLayout(row)
        lay.setContentsMargins(8, 8, 8, 8)
        lay.setSpacing(8)

        thumb = QLabel(row)
        thumb.setObjectName("recentThumb")
        thumb.setFixedSize(52, 52)
        thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        if m.get("imageData"):
            img = QPixmap()
            img.loadFromData(m["imageData"])
            if not img.isNull():
                thumb.setPixmap(img.scaled(48, 48, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        self.history_thumbs.append(thumb)
        lay.addWidget(thumb, 0, Qt.AlignmentFlag.AlignTop)

        info = QVBoxLayout()
        info.setContentsMargins(0, 0, 0, 0)
        info.setSpacing(5)
        title_text = str(m.get("sessionTitle") or "（无标题对话）")
        title = QLabel(title_text)
        title.setObjectName("recentTitle")
        title.setWordWrap(True)
        title.setToolTip(title_text)
        info.addWidget(title)

        buttons = QGridLayout()
        buttons.setContentsMargins(0, 0, 0, 0)
        buttons.setHorizontalSpacing(4)
        buttons.setVerticalSpacing(4)
        like_btn = QPushButton("喜欢")
        like_btn.setObjectName("recentFeedback")
        like_btn.setProperty("feedback", "positive")
        like_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        # v0.33.63 - 正反馈拆两键：喜欢（图本身）/ 应景（这次配得贴）
        fit_btn = QPushButton("应景")
        fit_btn.setObjectName("recentFeedback")
        fit_btn.setProperty("feedback", "positive")
        fit_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        dislike_btn = QPushButton("不喜欢")
        dislike_btn.setObjectName("recentFeedback")
        dislike_btn.setProperty("feedback", "negative")
        dislike_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        chat_btn = QPushButton("和小花聊聊")
        chat_btn.setObjectName("recentChat")
        chat_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        buttons.addWidget(like_btn, 0, 0)
        buttons.addWidget(fit_btn, 0, 1)
        buttons.addWidget(dislike_btn, 0, 2)
        buttons.addWidget(chat_btn, 1, 0, 1, 3)
        buttons.setColumnStretch(0, 1)
        buttons.setColumnStretch(1, 1)
        buttons.setColumnStretch(2, 1)
        info.addLayout(buttons)
        lay.addLayout(info, 1)

        state = {
            "sessionId": m.get("sessionId") or "",
            "stickerId": m.get("stickerId") or "",
            "ts": m.get("ts") or 0,
            "feedback": m.get("feedback") or None,
            "feedbackKind": m.get("feedbackKind") or None,
        }
        self._sync_history_buttons(like_btn, fit_btn, dislike_btn, chat_btn, state["feedback"], state["feedbackKind"])
        like_btn.clicked.connect(lambda checked=False, b=like_btn, f=fit_btn, d=dislike_btn, c=chat_btn, s=state: self._toggle_history_feedback(b, f, d, c, s, "positive", "image"))
        fit_btn.clicked.connect(lambda checked=False, b=like_btn, f=fit_btn, d=dislike_btn, c=chat_btn, s=state: self._toggle_history_feedback(b, f, d, c, s, "positive", "context"))
        dislike_btn.clicked.connect(lambda checked=False, b=like_btn, f=fit_btn, d=dislike_btn, c=chat_btn, s=state: self._toggle_history_feedback(b, f, d, c, s, "negative"))
        chat_btn.clicked.connect(lambda checked=False, m=m: self.open_chat_for(m.get("stickerId"), m.get("imageData")))
        self.history_list.addWidget(row)

    def _set_history_compact(self, compact):
        # 极窄屏优先保住标题和按钮，避免固定缩略图把整行撑出滚动区域；正常宽度仍显示图片。
        for thumb in self.history_thumbs:
            thumb.setVisible(not compact)

    def _sync_history_buttons(self, like_btn, fit_btn, dislike_btn, chat_btn, feedback, feedback_kind=None):
        # v0.33.63 - 三键独立状态：喜欢=image、应景=context，两个都点=both；聊一聊只在点过不喜欢后出现
        like_active = feedback == "positive" and feedback_kind in ("image", "both")
        fit_active = feedback == "positive" and feedback_kind in ("context", "both")
        dislike_active = feedback == "negative"
        like_btn.setProperty("active", "true" if like_active else "false")
        like_btn.setText("已喜欢" if like_active else "喜欢")
        fit_btn.setProperty("active", "true" if fit_active else "false")
        fit_btn.setText("已应景" if fit_active else "应景")
        dislike_btn.setProperty("active", "true" if dislike_active else "false")
        dislike_btn.setText("已反馈" if dislike_active else "不喜欢")
        for btn in (like_btn, fit_btn, dislike_btn):
            btn.setEnabled(not self.history_busy)
            btn.style().unpolish(btn)
            btn.style().polish(btn)
        if chat_btn is not None:
            chat_btn.setVisible(dislike_active)
            chat_btn.setEnabled(not self.history_busy)

    def _toggle_history_feedback(self, like_btn, fit_btn, dislike_btn, chat_btn, state, kind, feedback_kind=None):
        if self.history_busy:
            return
        current = state.get("feedback")
        current_kind = state.get("feedbackKind")
        if kind == "positive":
            next_kind = self._next_positive_kind(current, current_kind, feedback_kind)
            if next_kind is None:
                feedback = "clear"
                feedback_kind = None
            else:
                feedback = "positive"
                feedback_kind = next_kind
        elif kind == "negative":
            feedback = "clear" if current == "negative" else "negative"
            feedback_kind = None
        else:
            feedback = "clear"
            feedback_kind = None
        self.history_busy = True
        self._sync_history_buttons(like_btn, fit_btn, dislike_btn, chat_btn, state.get("feedback"), state.get("feedbackKind"))
        payload = {
            "stickerId": state["stickerId"],
            "feedback": feedback,
            "feedbackKind": feedback_kind,
            "sessionId": state["sessionId"],
            "expectedTs": state["ts"],
        }
        seq = self.history_feedback_seq + 1
        self.history_feedback_seq = seq
        worker = BackgroundRequest(lambda: request_json("POST", "/feedback", payload, timeout=12), self, "biaoqingbao-history-feedback")
        self.workers.append(worker)
        worker.done.connect(lambda result, s=seq: self._on_history_feedback_done(result, s, like_btn, fit_btn, dislike_btn, chat_btn, state))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _on_history_feedback_done(self, result, seq, like_btn, fit_btn, dislike_btn, chat_btn, state):
        if seq != self.history_feedback_seq:
            return
        self.history_busy = False
        if result and result.get("ok"):
            state["feedback"] = result.get("feedback") or None
            state["feedbackKind"] = result.get("feedback_kind") or None
            self._sync_history_buttons(like_btn, fit_btn, dislike_btn, chat_btn, state["feedback"], state["feedbackKind"])
        else:
            self.history_empty.setText("反馈失败：" + str((result or {}).get("error") or "再试一下"))
            self.history_empty.show()
            self._sync_history_buttons(like_btn, fit_btn, dislike_btn, chat_btn, state.get("feedback"), state.get("feedbackKind"))

    # ── 聊天（配图手帐/最近配图共用） ──
    def open_chat_for(self, sticker_id, image_data=None, pixmap=None):
        if self.chat_busy or not sticker_id:
            return
        self.chat_request_seq += 1
        self.chat_sticker_id = str(sticker_id)
        self.chat_session_id = None
        self.chat_suggestion = None
        self.chat_busy = False
        if pixmap is not None and not pixmap.isNull():
            self.chat_thumb.setPixmap(pixmap.scaled(30, 30, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        elif image_data:
            img = QPixmap()
            img.loadFromData(image_data)
            if not img.isNull():
                self.chat_thumb.setPixmap(img.scaled(30, 30, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        self.chat_status.setText("告诉我哪里不对、该怎么调")
        self._clear_chat_messages()
        self._append_chat_bubble("assistant", "告诉我哪里不对、该怎么调。\n比如：这张图表达的是撒娇，不是开心")
        self.chat_preview.hide()
        self.chat_preview_discard.setEnabled(True)
        self.chat_preview_confirm.setEnabled(True)
        self.chat_editor.clear()
        self.chat_panel.show()
        self.update_chat_button_state()
        self.move_to_ball()
        self.chat_editor.setFocus()

    def _layout_recent_buttons(self):
        if not hasattr(self, "recent_button_layout"):
            return
        while self.recent_button_layout.count():
            self.recent_button_layout.takeAt(0)
        compact = self.width() < 230
        # v0.33.63 - 聊一聊只在点过不喜欢的这条配图上出现（不露面就不占位）
        chat_visible = self.recent_chat_button.isVisible()
        if compact:
            self.recent_button_layout.addWidget(self.recent_like_button, 0, 0, 1, 2)
            self.recent_button_layout.addWidget(self.recent_fit_button, 1, 0, 1, 2)
            self.recent_button_layout.addWidget(self.recent_dislike_button, 2, 0, 1, 2)
            if chat_visible:
                self.recent_button_layout.addWidget(self.recent_chat_button, 3, 0, 1, 2)
        else:
            self.recent_button_layout.addWidget(self.recent_like_button, 0, 0)
            self.recent_button_layout.addWidget(self.recent_fit_button, 0, 1)
            self.recent_button_layout.addWidget(self.recent_dislike_button, 0, 2)
            if chat_visible:
                self.recent_button_layout.addWidget(self.recent_chat_button, 1, 0, 1, 3)
        for column in range(3):
            self.recent_button_layout.setColumnStretch(column, 1)

    def _build_chat_panel(self):
        self.chat_panel = QFrame(self)
        self.chat_panel.setObjectName("chatPanel")
        root = QVBoxLayout(self.chat_panel)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(6)

        head = QHBoxLayout()
        head.setSpacing(7)
        self.chat_thumb = QLabel(self.chat_panel)
        self.chat_thumb.setObjectName("recentThumb")
        self.chat_thumb.setFixedSize(34, 34)
        self.chat_thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        head.addWidget(self.chat_thumb)
        title_box = QVBoxLayout()
        title_box.setContentsMargins(0, 0, 0, 0)
        title_box.setSpacing(0)
        self.chat_title = QLabel("和小花聊聊这张图")
        self.chat_title.setObjectName("chatTitle")
        title_box.addWidget(self.chat_title)
        self.chat_status = QLabel("告诉我哪里不对、该怎么调")
        self.chat_status.setObjectName("chatStatus")
        title_box.addWidget(self.chat_status)
        head.addLayout(title_box, 1)
        self.chat_close_button = QPushButton("收起", self.chat_panel)
        self.chat_close_button.setObjectName("chatClose")
        self.chat_close_button.clicked.connect(self.close_chat)
        head.addWidget(self.chat_close_button)
        root.addLayout(head)

        self.chat_scroll = QScrollArea(self.chat_panel)
        self.chat_scroll.setObjectName("chatScroll")
        self.chat_scroll.setWidgetResizable(True)
        self.chat_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.chat_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.chat_scroll.setFixedHeight(150)
        self.chat_messages_host = QWidget(self.chat_scroll)
        self.chat_messages_host.setObjectName("chatMessagesHost")
        self.chat_messages_layout = QVBoxLayout(self.chat_messages_host)
        self.chat_messages_layout.setContentsMargins(7, 7, 7, 7)
        self.chat_messages_layout.setSpacing(6)
        self.chat_messages_layout.addStretch(1)
        self.chat_scroll.setWidget(self.chat_messages_host)
        root.addWidget(self.chat_scroll)

        self.chat_preview = QFrame(self.chat_panel)
        self.chat_preview.setObjectName("chatPreview")
        preview_root = QVBoxLayout(self.chat_preview)
        preview_root.setContentsMargins(8, 7, 8, 7)
        preview_root.setSpacing(5)
        self.chat_preview_title = QLabel("小花建议这样调整标签")
        self.chat_preview_title.setObjectName("chatPreviewTitle")
        preview_root.addWidget(self.chat_preview_title)
        self.chat_preview_text = QLabel("")
        self.chat_preview_text.setObjectName("chatPreviewText")
        self.chat_preview_text.setWordWrap(True)
        preview_root.addWidget(self.chat_preview_text)
        preview_buttons = QHBoxLayout()
        preview_buttons.addStretch(1)
        self.chat_preview_discard = QPushButton("再看看", self.chat_preview)
        self.chat_preview_discard.setObjectName("chatChoice")
        self.chat_preview_discard.clicked.connect(self.discard_chat_preview)
        preview_buttons.addWidget(self.chat_preview_discard)
        self.chat_preview_confirm = QPushButton("确认应用", self.chat_preview)
        self.chat_preview_confirm.setObjectName("recentChat")
        self.chat_preview_confirm.clicked.connect(self.confirm_chat_change)
        preview_buttons.addWidget(self.chat_preview_confirm)
        preview_root.addLayout(preview_buttons)
        self.chat_preview.hide()
        root.addWidget(self.chat_preview)

        self.chat_editor = MessageEdit(self.chat_panel)
        self.chat_editor.setPlaceholderText("说说哪里不对…（Enter 发送）")
        self.chat_editor.setFixedHeight(52)
        self.chat_editor.send_requested.connect(self.send_chat_message)
        self.chat_editor.textChanged.connect(self.update_chat_button_state)
        root.addWidget(self.chat_editor)
        self.chat_send_button = QPushButton("发送", self.chat_panel)
        self.chat_send_button.setObjectName("sendButton")
        self.chat_send_button.clicked.connect(self.send_chat_message)
        root.addWidget(self.chat_send_button)
        self.chat_panel.hide()
        self.update_chat_button_state()

    def _append_chat_bubble(self, role, text):
        label = QLabel(str(text or ""), self.chat_messages_host)
        label.setWordWrap(True)
        label.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        label.setStyleSheet(
            "QLabel { padding:6px 9px; border-radius:10px; font-family:'Microsoft YaHei UI'; font-size:11px; line-height:1.5; }"
            if role == "user" else
            "QLabel { padding:6px 9px; border-radius:10px; background:#fffdf7; border:1px solid #d7e5dc; color:#46574f; font-family:'Microsoft YaHei UI'; font-size:11px; }"
        )
        if role == "user":
            label.setStyleSheet(
                "QLabel { padding:6px 9px; border-radius:10px; background:#5dae8e; color:#fffdf7; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            )
        elif role == "thinking":
            label.setStyleSheet(
                "QLabel { padding:6px 9px; border-radius:10px; background:#fffdf7; border:1px dashed #d7e5dc; color:#84978d; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            )
        elif role == "error":
            label.setStyleSheet(
                "QLabel { padding:6px 9px; border-radius:10px; background:#fdf0f3; border:1px solid #e8b7c8; color:#a05e72; font-family:'Microsoft YaHei UI'; font-size:11px; }"
            )
        label.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self.chat_messages_layout.insertWidget(max(0, self.chat_messages_layout.count() - 1), label, 0, Qt.AlignmentFlag.AlignRight if role == "user" else Qt.AlignmentFlag.AlignLeft)
        scrollbar = self.chat_scroll.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())
        return label

    def _clear_chat_messages(self):
        while self.chat_messages_layout.count() > 1:
            item = self.chat_messages_layout.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

    def update_chat_button_state(self):
        can_send = bool(self.chat_sticker_id and self.chat_editor.toPlainText().strip()) and not self.chat_busy
        self.chat_editor.setProperty("canSend", can_send)
        self.chat_editor.setEnabled(not self.chat_busy)
        self.chat_send_button.setEnabled(can_send)
        self.chat_send_button.setText("思考中…" if self.chat_busy else "发送")

    def prepare_for_show(self):
        self.restore_panel_opacity()
        self.move_to_ball()
        self.refresh()
        self.refresh_recent_async()
        self._sync_target_state()

    def move_to_ball(self):
        if not self.ball:
            return
        bounds = screen_bounds(self.ball)
        available_width = max(96, bounds[2] - bounds[0] - 20)
        available_height = max(180, bounds[3] - bounds[1] - 20)
        next_width = min(PANEL_WIDTH, available_width)
        next_columns = sticker_columns_for_width(next_width)
        columns_changed = next_columns != self.sticker_columns
        self.setFixedWidth(next_width)
        compact = next_width < 230
        self.recent_thumb.setVisible(not compact)
        self.chat_thumb.setVisible(not compact)
        self._set_history_compact(compact)
        self.recent_card.setMinimumHeight(150 if compact else 102)
        extra = TARGET_MENU_EXTRA if self.target_menu is not None and self.target_menu.isVisible() else 0
        if not self.recent_card.isHidden():
            extra += RECENT_EXTRA_HEIGHT
        if not self.chat_panel.isHidden():
            extra += CHAT_EXTRA_HEIGHT
            if not self.chat_preview.isHidden():
                extra += 78
        self.setFixedHeight(min(PANEL_HEIGHT + extra, available_height))
        self.sticker_columns = next_columns
        self._layout_recent_buttons()
        if columns_changed and self.items:
            self.apply_items({"ok": True, "items": self.items})
        rect = (self.ball.x(), self.ball.y(), self.ball.width(), self.ball.height())
        self.move(*position_popup_beside(rect, (self.width(), self.height()), bounds))

    def _panel_pointer_inside(self):
        return self.rect().contains(self.mapFromGlobal(QCursor.pos()))

    def _panel_fade_blocked(self):
        if self._panel_dragging:
            return True
        if getattr(getattr(self, "recog_panel", None), "isVisible", lambda: False)():
            return True
        sticker_menu = getattr(self, "_sticker_menu", None)
        if sticker_menu is not None and sticker_menu.isVisible():
            return True
        context_menu = getattr(self.ball, "context_menu", None)
        return context_menu is not None and context_menu.isVisible()

    def restore_panel_opacity(self):
        self._panel_outside_since = None
        if self.windowOpacity() < 0.999:
            self.setWindowOpacity(1.0)

    def _refresh_panel_opacity(self):
        if not self.isVisible():
            return
        if self._panel_fade_blocked() or self._panel_pointer_inside():
            self.restore_panel_opacity()
            return
        now = time.monotonic()
        if self._panel_outside_since is None:
            self._panel_outside_since = now
            return
        if now - self._panel_outside_since >= PANEL_FADE_DELAY_MS / 1000.0:
            self.setWindowOpacity(PANEL_FADE_OPACITY)

    def clear_grid(self):
        while self.grid.count():
            item = self.grid.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

    def refresh(self):
        # v0.33.45 - 先放「＋ 添加表情包」占位格，图集加载期间添加入口常驻，不空等
        self._ensure_add_cell_visible()
        if not self.items:
            self.hint.setText("正在读取优选表情包…")
            self.hint.show()
        worker = BackgroundRequest(self.load_items, self, "biaoqingbao-items")
        self.workers.append(worker)
        worker.done.connect(self.apply_items)
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _ensure_add_cell_visible(self):
        """加载图集前先把「＋ 添加表情包」占位格放上（添加入口常驻，加载失败也可添加）。"""
        if getattr(self, '_add_cell', None) is not None and self._add_cell.parent() is self.grid_host:
            return
        self.clear_grid()
        self._add_cell = AddStickerCell(self.grid_host, on_add=self.paste_from_clipboard)
        self.grid.addWidget(self._add_cell, 0, 0)
        # v0.33.46 - 加载中只有添加格时靠左（第一位），别被网格水平居中顶到中间；
        # 图集到位后 apply_items 恢复 AlignHCenter（图多满行时添加格自然在左上，视觉一致）
        self.grid.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self._buttons_by_id = {}

    def start_recent_polling(self):
        if not self.recent_timer.isActive():
            self.recent_timer.start()
        self.refresh_recent_async()

    def stop_recent_polling(self):
        self.recent_timer.stop()

    @staticmethod
    def load_recent():
        result = request_json("GET", "/recent-match", timeout=8)
        if not result.get("ok"):
            return result
        match = result.get("match")
        if match:
            match = dict(match)
            match["imageData"] = load_image_data(match.get("stickerId"))
        return {
            "ok": True,
            "match": match,
            "sessionPath": result.get("sessionPath") or "",
            "sessionId": result.get("sessionId") or "",
        }

    def invalidate_recent_requests(self):
        self.recent_request_seq += 1

    def refresh_recent_async(self):
        if self.recent_loading:
            return
        self.recent_loading = True
        self.recent_request_seq += 1
        request_seq = self.recent_request_seq
        worker = BackgroundRequest(self.load_recent, self, "biaoqingbao-recent")
        self.workers.append(worker)
        worker.done.connect(lambda result, seq=request_seq: self.apply_recent(result, seq))
        worker.finished.connect(lambda: self._finish_recent_worker(worker))
        worker.start()

    def _finish_recent_worker(self, worker):
        self.recent_loading = False
        if worker in self.workers:
            self.workers.remove(worker)

    def apply_recent(self, result, request_seq=None):
        if request_seq is not None and request_seq != self.recent_request_seq:
            return
        if not result.get("ok"):
            return
        if result.get("sessionPath"):
            self.ball.target_session_path = result.get("sessionPath")
        match = result.get("match")
        signature = None
        if match:
            signature = "|".join([
                str(result.get("sessionId") or ""),
                str(match.get("stickerId") or ""),
                str(match.get("ts") or ""),
            ])
        changed = signature != self.recent_signature
        if changed:
            if self.recent_initialized and signature:
                self.ball.trigger_recent_arrival()
            if self.chat_panel.isVisible():
                self.close_chat()
            self.recent_signature = signature
        self.recent_initialized = True
        self.recent_match = match
        self.recent_card.setVisible(bool(match))
        if match:
            image = QPixmap()
            if match.get("imageData"):
                image.loadFromData(match["imageData"])
            if image.isNull():
                self.recent_thumb.clear()
                self.chat_thumb.clear()
            else:
                scaled = image.scaled(56, 56, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
                self.recent_thumb.setPixmap(scaled)
                self.chat_thumb.setPixmap(image.scaled(30, 30, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
            self.recent_description.setText(str(match.get("description") or "（无描述）"))
            meta = [str(value) for value in (match.get("emotion"), match.get("agentId")) if value]
            self.recent_meta.setText(" · ".join(meta) if meta else "刚刚配图")
            self.update_recent_feedback_buttons()
        elif self.chat_panel.isVisible():
            self.close_chat()
        self.move_to_ball()

    @staticmethod
    def _next_positive_kind(current, current_kind, tapped):
        """喜欢/应景两键：再点同维度 = 取消；点另一维度 = 叠成 both；both 再点某维度 = 只剩另一维度。"""
        if current != "positive":
            return tapped
        if current_kind == tapped:
            return None  # 取消这次反馈
        if current_kind == "both":
            return "context" if tapped == "image" else "image"
        return "both"

    def update_recent_feedback_buttons(self):
        current = self.recent_match.get("feedback") if self.recent_match else None
        current_kind = self.recent_match.get("feedbackKind") if self.recent_match else None
        like_active = current == "positive" and current_kind in ("image", "both")
        fit_active = current == "positive" and current_kind in ("context", "both")
        dislike_active = current == "negative"
        for button, active, normal_text, active_text in (
            (self.recent_like_button, like_active, "喜欢", "已喜欢"),
            (self.recent_fit_button, fit_active, "应景", "已应景"),
            (self.recent_dislike_button, dislike_active, "不喜欢", "已反馈"),
        ):
            button.setProperty("active", "true" if active else "false")
            button.setText(active_text if active else normal_text)
            button.setEnabled(not self.recent_busy)
            button.style().unpolish(button)
            button.style().polish(button)
            button.update()
        # v0.33.63 - 聊一聊只在点过不喜欢后出现
        self.recent_chat_button.setVisible(dislike_active)
        self.recent_chat_button.setEnabled(not self.chat_busy and not self.recent_busy)
        self._layout_recent_buttons()

    def feedback_recent(self, feedback_type, feedback_kind=None):
        if not self.recent_match or self.recent_busy:
            return
        current = self.recent_match.get("feedback")
        current_kind = self.recent_match.get("feedbackKind")
        if feedback_type == "positive":
            if feedback_kind not in ("image", "context"):
                return
            next_kind = self._next_positive_kind(current, current_kind, feedback_kind)
            if next_kind is None:
                feedback = "clear"
                feedback_kind = None
            else:
                feedback = "positive"
                feedback_kind = next_kind
        elif feedback_type == "clear":
            feedback = "clear"
            feedback_kind = None
        else:
            feedback = "clear" if current == "negative" else "negative"
            feedback_kind = None
        self.recent_busy = True
        self.recent_feedback_seq += 1
        seq = self.recent_feedback_seq
        self.update_recent_feedback_buttons()
        payload = {
            "stickerId": self.recent_match.get("stickerId") or "",
            "feedback": feedback,
            "feedbackKind": feedback_kind,
            "sessionPath": self.ball.target_session_path or "",
            "agentId": self.recent_match.get("agentId") or "",
        }
        signature = self.recent_signature
        worker = BackgroundRequest(lambda: request_json("POST", "/feedback", payload, timeout=12), self, "biaoqingbao-feedback")
        self.workers.append(worker)
        worker.done.connect(lambda result: self.on_recent_feedback_done(result, seq, signature))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def on_recent_feedback_done(self, result, seq, signature=None):
        if seq != self.recent_feedback_seq:
            return
        self.recent_busy = False
        if signature is not None and signature != self.recent_signature:
            self.update_recent_feedback_buttons()
            return
        if result.get("ok"):
            if self.recent_match:
                self.recent_match["feedback"] = result.get("feedback")
                self.recent_match["feedbackKind"] = result.get("feedback_kind")
            if result.get("feedback") is None:
                self.hint.setText("已撤销这次反馈")
            elif result.get("feedback") == "positive":
                kind = result.get("feedback_kind")
                self.hint.setText({
                    "image": "已记下喜欢这张图",
                    "context": "已记下这次很应景",
                    "both": "已记下喜欢这张图，也很应景",
                }.get(kind, "已记下喜欢这张图"))
            else:
                count = result.get("dislike_count") or 1
                self.hint.setText(f"已记下不喜欢（累计 {count} 次）")
            self.hint.show()
        else:
            self.hint.setText("反馈没记上：" + str(result.get("error") or "请稍后再试"))
            self.hint.show()
        self.update_recent_feedback_buttons()

    @staticmethod
    def _diff_text(old_tags, suggestion):
        old_tags = old_tags or {}
        suggestion = suggestion or {}
        rows = []
        values = (
            ("描述", old_tags.get("description") or "（无）", suggestion.get("description") or "（无）"),
            ("情绪", "、".join(old_tags.get("emotion") or []) or "（无）", "、".join(suggestion.get("emotion") or []) or "（无）"),
            ("场景", "、".join(old_tags.get("scene") or []) or "（无）", "、".join(suggestion.get("scene") or []) or "（无）"),
            ("关键词", "、".join(old_tags.get("keywords") or []) or "（无）", "、".join(suggestion.get("keywords") or []) or "（无）"),
        )
        for label, old, new in values:
            if old != new:
                rows.append(f"{label}：{old}  →  {new}")
        return "\\n".join(rows) if rows else "小花暂时没看出要改的，你再说说哪里不对？"

    def open_recent_chat(self):
        if not self.recent_match or self.recent_busy:
            return
        self.chat_request_seq += 1
        self.chat_sticker_id = self.recent_match.get("stickerId") or ""
        self.chat_session_id = None
        self.chat_suggestion = None
        self.chat_busy = False
        image = self.recent_thumb.pixmap()
        if image and not image.isNull():
            self.chat_thumb.setPixmap(image.scaled(30, 30, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        self.chat_status.setText("告诉我哪里不对、该怎么调")
        self._clear_chat_messages()
        self._append_chat_bubble("assistant", "告诉我哪里不对、该怎么调。\\n比如：这张图表达的是撒娇，不是开心")
        self.chat_preview.hide()
        self.chat_preview_discard.setEnabled(True)
        self.chat_preview_confirm.setEnabled(True)
        self.chat_editor.clear()
        self.chat_panel.show()
        self.update_chat_button_state()
        self.move_to_ball()
        self.chat_editor.setFocus()

    def discard_chat_preview(self):
        self.chat_suggestion = None
        self.chat_preview.hide()
        self._append_chat_bubble("assistant", "好的，那我不动这张图。你要是想继续聊就再说。")
        self.move_to_ball()

    def send_chat_message(self):
        if self.chat_busy or not self.chat_sticker_id:
            return
        message = self.chat_editor.toPlainText().strip()
        if not message:
            return
        self.chat_request_seq += 1
        seq = self.chat_request_seq
        self._append_chat_bubble("user", message)
        self.chat_editor.clear()
        self.chat_suggestion = None
        self.chat_preview.hide()
        self.chat_busy = True
        self.update_chat_button_state()
        thinking = self._append_chat_bubble("thinking", "小花正在思考…")
        payload = {
            "sticker_id": self.chat_sticker_id,
            "message": message,
            "session_id": self.chat_session_id,
        }
        worker = BackgroundRequest(lambda: request_json("POST", "/chat", payload, timeout=120), self, "biaoqingbao-chat")
        self.workers.append(worker)
        worker.done.connect(lambda result: self.on_chat_done(result, seq, thinking))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def on_chat_done(self, result, seq, thinking):
        if seq != self.chat_request_seq:
            if thinking:
                thinking.deleteLater()
            return
        if thinking:
            thinking.deleteLater()
        self.chat_busy = False
        if result.get("ok"):
            self.chat_session_id = result.get("session_id") or self.chat_session_id
            self._append_chat_bubble("assistant", result.get("reply") or "（小花没有返回文字）")
            if result.get("suggestion"):
                self.chat_suggestion = result.get("suggestion")
                self.chat_preview_text.setText(self._diff_text(result.get("old_tags"), self.chat_suggestion))
                self.chat_preview.show()
                self.chat_status.setText("有一份修改建议，确认后才会应用")
            else:
                self.chat_status.setText("还可以继续说")
        else:
            self._append_chat_bubble("error", "出错：" + str(result.get("error") or "请稍后再试"))
            self.chat_status.setText("这轮没有送达，可以再试一次")
        self.update_chat_button_state()
        self.move_to_ball()
        self.chat_editor.setFocus()

    def confirm_chat_change(self):
        if self.chat_busy or not self.chat_session_id or not self.chat_suggestion:
            return
        self.chat_request_seq += 1
        confirm_seq = self.chat_request_seq
        confirm_sticker_id = self.chat_sticker_id
        self.chat_busy = True
        self.chat_preview_discard.setEnabled(False)
        self.chat_preview_confirm.setEnabled(False)
        self.chat_preview_confirm.setText("应用中…")
        self.update_chat_button_state()
        payload = {
            "session_id": self.chat_session_id,
            "sticker_id": self.chat_sticker_id,
            "new_tags": self.chat_suggestion,
        }
        worker = BackgroundRequest(lambda: request_json("POST", "/chat/confirm", payload, timeout=120), self, "biaoqingbao-chat-confirm")
        self.workers.append(worker)
        worker.done.connect(lambda result, seq=confirm_seq, sticker_id=confirm_sticker_id: self.on_chat_confirm_done(result, seq, sticker_id))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def on_chat_confirm_done(self, result, seq=None, sticker_id=None):
        if seq is not None and seq != self.chat_request_seq:
            return
        if sticker_id is not None and sticker_id != self.chat_sticker_id:
            return
        self.chat_busy = False
        self.chat_preview_confirm.setEnabled(True)
        self.chat_preview_discard.setEnabled(True)
        self.chat_preview_confirm.setText("确认应用")
        if result.get("ok"):
            self.chat_suggestion = None
            self.chat_preview.hide()
            self._append_chat_bubble("assistant", result.get("message") or "已应用这份修改。")
            self.chat_status.setText("已应用，向量会按新标签更新")
            self.refresh_recent_async()
            self.hint.setText("这张图的标签已更新")
            self.hint.show()
        else:
            self._append_chat_bubble("error", "保存失败：" + str(result.get("error") or "请稍后再试"))
        self.update_chat_button_state()
        self.move_to_ball()

    def close_chat(self):
        sid = self.chat_session_id
        self.chat_request_seq += 1
        self.chat_sticker_id = None
        self.chat_session_id = None
        self.chat_suggestion = None
        self.chat_busy = False
        self.chat_preview.hide()
        self.chat_panel.hide()
        self.update_chat_button_state()
        if sid and API_TOKEN:
            threading.Thread(
                target=lambda: request_json("POST", "/chat/close", {"session_id": sid}, timeout=5),
                daemon=True,
                name="biaoqingbao-chat-close",
            ).start()
        self.move_to_ball()

    @staticmethod
    def load_items():
        pinned = request_json("GET", "/pinned")
        if not pinned.get("ok"):
            return {"ok": False, "error": pinned.get("error") or "读取表情包失败"}
        stickers = pinned.get("stickers") or []
        if not stickers:
            return {"ok": True, "items": []}
        # v0.33.45 - 并发拉图：串行 IPC 往返是首次打开慢的根因，8 并发明显提速（本地 HTTP 安全）
        def _load(item):
            copy = dict(item)
            copy["imageData"] = load_image_data(item.get("id"))
            return copy
        with ThreadPoolExecutor(max_workers=min(8, len(stickers))) as ex:
            items = list(ex.map(_load, stickers))
        return {"ok": True, "items": items}

    def apply_items(self, result):
        if not result.get("ok"):
            self.hint.setText(result.get("error") or "读取失败，再试一次哈")
            self.hint.show()
            return
        self.items = result.get("items") or []
        available_ids = {str(item.get("id")) for item in self.items if item.get("id")}
        if self.selected_sticker_id not in available_ids:
            self.selected_sticker_id = None
        state = self._drag_state
        self._drag_state = None
        if state:
            self._destroy_drag_ghost(state.get("ghost"))
        self._buttons_by_id = {}
        self.clear_grid()
        # 图集网格第 0 格固定为「＋ 添加表情包」占位格，图片从第 1 格开始排
        self._add_cell = AddStickerCell(self.grid_host, on_add=self.paste_from_clipboard)
        self.grid.addWidget(self._add_cell, 0, 0)
        for index, item in enumerate(self.items):
            pixmap = QPixmap()
            if item.get("imageData"):
                pixmap.loadFromData(item["imageData"])
            button = StickerButton(item, pixmap, self.grid_host, on_context=self._open_sticker_context_menu, on_drag=self._on_sticker_drag)
            button.clicked.connect(lambda checked=False, sid=item.get("id"): self.select_sticker(sid))
            self._buttons_by_id[str(item.get("id"))] = button
            cell = index + 1  # 占位格占第 0 格
            self.grid.addWidget(button, cell // self.sticker_columns, cell % self.sticker_columns)
        if self.items:
            self.hint.setText(self.selection_hint())
            self.hint.show()
        else:
            self.hint.setText("去管理页添加你的优选表情包")
            self.hint.show()
        self.update_button_states()
        self.move_to_ball()
        # v0.33.38 - 刷新后按面板可见性恢复动图播放（不可见的新按钮保持暂停）
        self._set_all_movies(self.isVisible())
        # v0.33.46 - 图集到位恢复网格水平居中（加载中临时靠左，见 _ensure_add_cell_visible）
        self.grid.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter)

    # v0.33.38 - 面板显示时播动图、隐藏时全部暂停（省 CPU）
    def showEvent(self, event):
        super().showEvent(event)
        self.restore_panel_opacity()
        self._fade_poll_timer.start()
        self._set_all_movies(True)

    def hideEvent(self, event):
        self._fade_poll_timer.stop()
        self.restore_panel_opacity()
        super().hideEvent(event)
        self._set_all_movies(False)

    def _set_all_movies(self, playing):
        for button in getattr(self, "_buttons_by_id", {}).values():
            set_movie = getattr(button, "set_movie_playing", None)
            if set_movie:
                set_movie(playing)

    # ─── 拖拽排序 ───
    def _on_sticker_drag(self, button, phase, global_pos):
        if phase == "start":
            self._drag_start(button, global_pos)
        elif phase == "move":
            self._drag_move(global_pos)
        else:
            self._drag_end(global_pos)

    def _drag_start(self, button, global_pos):
        if self.busy or len(self.items) < 2:
            return
        from_index = None
        for index, item in enumerate(self.items):
            if str(item.get("id")) == str(button.item.get("id")):
                from_index = index
                break
        if from_index is None:
            return
        pixmap = QPixmap()
        if button.item.get("imageData"):
            pixmap.loadFromData(button.item["imageData"])
        ghost = QLabel(None)
        ghost.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        ghost.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        ghost.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        ghost.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        ghost.setFixedSize(STICKER_TILE_SIZE, STICKER_TILE_SIZE)
        ghost.setAlignment(Qt.AlignmentFlag.AlignCenter)
        if not pixmap.isNull():
            ghost.setPixmap(pixmap.scaled(
                STICKER_ICON_SIZE, STICKER_ICON_SIZE,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            ))
        ghost.setStyleSheet("background:rgba(232,155,176,0.16); border:2px solid #e89bb0; border-radius:12px;")
        ghost.adjustSize()
        ghost.move(global_pos.x() - STICKER_TILE_SIZE // 2, global_pos.y() - STICKER_TILE_SIZE // 2)
        ghost.show()
        self._drag_state = {
            "button": button,
            "from_index": from_index,
            "hover_index": from_index,
            "ghost": ghost,
        }
        button.setProperty("dragTarget", False)
        # 被拖按钮半透明，避免和浮动预览重叠成两个实图
        self._drag_opacity = QGraphicsOpacityEffect(button)
        self._drag_opacity.setOpacity(0.35)
        button.setGraphicsEffect(self._drag_opacity)
        self._set_drag_highlight(from_index)

    def _drag_move(self, global_pos):
        state = self._drag_state
        if not state:
            return
        ghost = state.get("ghost")
        if ghost:
            ghost.move(global_pos.x() - STICKER_TILE_SIZE // 2, global_pos.y() - STICKER_TILE_SIZE // 2)
        local = self.grid_host.mapFromGlobal(global_pos)
        # 网格第 0 格是「添加」占位格，目标序号 = 格子序号 - 1（clamp 到合法范围）
        grid_cell = sticker_index_at(local.x(), local.y(), self.sticker_columns, len(self.items) + 1)
        target = max(0, min(grid_cell - 1, len(self.items) - 1))
        if target != state.get("hover_index"):
            state["hover_index"] = target
            self._set_drag_highlight(target)

    def _drag_end(self, global_pos):
        state = self._drag_state
        if not state:
            return
        self._drag_state = None
        # 采用 move 阶段最后算好的目标序号；没移动过就保持原位
        target = state.get("hover_index", state["from_index"])
        from_index = state["from_index"]
        button = state["button"]
        button.setProperty("dragTarget", False)
        button.setGraphicsEffect(None)
        self._clear_drag_highlight()
        self._destroy_drag_ghost(state.get("ghost"))
        if target == from_index:
            return
        new_items = reorder_items(self.items, from_index, target)
        self.items = new_items
        self.apply_items({"ok": True, "items": new_items})
        ids = [str(item.get("id")) for item in new_items]
        worker = BackgroundRequest(
            lambda: request_json("POST", "/pinned/reorder", {"ids": ids}, timeout=8),
            self,
            "biaoqingbao-reorder",
        )
        self.workers.append(worker)
        worker.done.connect(self._on_reorder_saved)
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _on_reorder_saved(self, result):
        if result.get("ok"):
            self.hint.setText("顺序已保存 ✓")
            self.hint.show()
            QTimer.singleShot(900, lambda: self.hint.setText(self.selection_hint()))
            return
        self.hint.setText("排序保存失败，已恢复原顺序：" + str(result.get("error") or "未知错误"))
        self.hint.show()
        self.refresh()

    def _set_drag_highlight(self, index):
        for button in self._buttons_by_id.values():
            if str(button.item.get("id")) == str(self.items[index].get("id")):
                button.setProperty("dragTarget", True)
                button.style().unpolish(button)
                button.style().polish(button)
                button.update()

    def _clear_drag_highlight(self):
        for button in self._buttons_by_id.values():
            if button.property("dragTarget"):
                button.setProperty("dragTarget", False)
                button.style().unpolish(button)
                button.style().polish(button)
                button.update()

    def _destroy_drag_ghost(self, ghost=None):
        if ghost is not None:
            ghost.hide()
            ghost.deleteLater()

    def selection_hint(self):
        if not self.selected_sticker_id:
            return "选择一张图，配一句话再发送"
        item = next((entry for entry in self.items if str(entry.get("id")) == self.selected_sticker_id), None)
        title = str(item.get("description") or "表情包") if item else "表情包"
        return "已选中「" + title + "」，输入正文后发送"

    def reset_retry_confirmation(self):
        if self.retry_confirmation_required:
            self.retry_confirmation_required = False
            self.send_button.setText("发送")

    def select_sticker(self, sticker_id):
        if self.busy or not sticker_id:
            return
        self.reset_retry_confirmation()
        sticker_id = str(sticker_id)
        self.selected_sticker_id = None if self.selected_sticker_id == sticker_id else sticker_id
        self.hint.setText("已取消选择" if not self.selected_sticker_id else self.selection_hint())
        self.hint.show()
        self.update_button_states()
        self.editor.setFocus()

    def update_button_states(self):
        for index in range(self.grid.count()):
            widget = self.grid.itemAt(index).widget()
            if isinstance(widget, StickerButton):
                widget.setEnabled(not self.busy)
                widget.set_selected(str(widget.item.get("id")) == self.selected_sticker_id)
            elif isinstance(widget, AddStickerCell):
                widget.setEnabled(not self.busy)
        can_send = bool(self.selected_sticker_id) and not self.busy
        self.editor.setProperty("canSend", can_send)
        self.editor.setEnabled(not self.busy)
        self.send_button.setEnabled(can_send)

    def send_selected(self):
        if self.busy or not self.selected_sticker_id:
            return
        self.retry_confirmation_required = False
        self.busy = True
        self.send_button.setText("发送中…")
        self.update_button_states()
        payload = {
            "stickerId": self.selected_sticker_id,
            "text": self.editor.toPlainText(),
            "requestId": "ui-" + uuid.uuid4().hex,
        }
        worker = BackgroundRequest(lambda: request_json("POST", "/send", payload, timeout=SEND_TIMEOUT), self, "biaoqingbao-send")
        self.workers.append(worker)
        worker.done.connect(self.on_send_done)
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def on_send_done(self, result):
        self.busy = False
        if result.get("ok"):
            self.editor.clear()
            self.selected_sticker_id = None
            self.send_button.setText("发送")
            self.hint.setText("已发送 ✓")
            self.hint.show()
            self.update_button_states()
            QTimer.singleShot(420, self.close)
            return
        error = result.get("error") or "未知错误"
        if result.get("status") == 504 or "可能已送达" in error:
            self.retry_confirmation_required = True
            self.send_button.setText("确认重发")
            self.hint.setText("消息可能已经送达，请先查看对话；再次点击「确认重发」才会重试")
        else:
            self.retry_confirmation_required = False
            self.send_button.setText("发送")
            self.hint.setText("发送失败，内容已保留，可点击发送重试：" + error)
        self.hint.show()
        self.update_button_states()

    def _sync_target_state(self):
        self._target_seq += 1
        target_seq = self._target_seq
        worker = BackgroundRequest(lambda: request_json("GET", "/target", timeout=4), self, "biaoqingbao-target-state")
        self.workers.append(worker)
        worker.done.connect(lambda result: self._apply_target_state(result, target_seq))
        worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)
        worker.start()

    def _apply_target_state(self, result, seq):
        if seq != self._target_seq or not result.get("ok"):
            return
        t = result.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if result.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = result.get("pinned")
        self.ball.target_session_path = (result.get("target") or {}).get("sessionPath") or ""
        self._update_target()

    def _update_target(self):
        arrow = "▴" if self.target_menu is not None and self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = ("固定 · " + title[:6]) if title else "固定"
        else:
            label = "自动判断"
        self.btn_target.setText(label + " " + arrow)
        self._update_target_info()

    def _update_target_info(self):
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "自动"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "自动 · 正在定位对话…"
        self.lbl_target_info.setText(text)

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.apply_target_state()
            self.target_menu.refresh_sessions_async()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        # 面板高度随菜单展开/收起变化；等两轮布局稳定后按便签重新锚定，避免跳位
        def settle():
            self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def cancel_workers(self):
        for worker in list(self.workers):
            cancel = getattr(worker, "cancel", None)
            if callable(cancel):
                cancel()
        self.workers.clear()
        if self.target_menu is not None:
            self.target_menu.cancel_workers()

    def shutdown(self):
        self.recent_timer.stop()
        self._fade_poll_timer.stop()
        self.restore_panel_opacity()
        self.recent_request_seq += 1
        self.recent_feedback_seq += 1
        self.chat_request_seq += 1
        self.cancel_workers()
        if self.chat_panel.isVisible():
            self.close_chat()

    def closeEvent(self, event):
        if self.target_menu is not None:
            self.target_menu.hide()
        if self.chat_panel.isVisible():
            self.close_chat()
        self.hide()
        event.ignore()

    # ─── 面板自身拖动：拖动时纸飞机一起跟着走（保持相对位置）───
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and not self.busy:
            self._panel_drag = {
                "press": event.globalPosition().toPoint(),
                "panel_start": self.pos(),
                "ball_start": self.ball.pos(),
            }
            self._panel_dragging = False
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        drag = self._panel_drag
        if drag is not None and (event.buttons() & Qt.MouseButton.LeftButton):
            delta = event.globalPosition().toPoint() - drag["press"]
            if not self._panel_dragging:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._panel_dragging = True
                # 拖动期间禁止 Ball.moveEvent 把面板拽回球旁
                self.ball._panel_drag_lock = True
            self.move(drag["panel_start"] + delta)
            self.ball.move(drag["ball_start"] + delta)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._panel_drag is not None and event.button() == Qt.MouseButton.LeftButton:
            was_dragging = self._panel_dragging
            self._panel_drag = None
            self._panel_dragging = False
            self.ball._panel_drag_lock = False
            if was_dragging:
                # 保存纸飞机新位置：只 clamp 不出屏，不吸附中间位置
                bounds = screen_bounds(self.ball)
                x, y = clamp_ball_position(self.ball.x(), self.ball.y(), bounds)
                self.ball.move(x, y)
                write_state(x, y)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        shadow = QColor("#c7c0b4")
        shadow.setAlpha(42)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(QRectF(self.rect().adjusted(7, 8, -5, -2)), 20, 20)
        painter.setPen(QColor("#b6d1c4"))
        painter.setBrush(QColor("#fbf8ef"))
        painter.drawRoundedRect(QRectF(self.rect().adjusted(2, 2, -2, -5)), 20, 20)
        painter.end()


class Ball(QWidget):
    def __init__(self):
        super().__init__(None)
        self.setFixedSize(BALL_SIZE, BALL_SIZE)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setMouseTracking(True)
        self.setAcceptDrops(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.variant = INITIAL_VARIANT
        self.animator = MotifAnimator(self.variant)
        self.visual_state = "normal"
        self.panel = BallPanel(self)
        self.context_menu = None
        self.target_mode = "auto"
        self.pinned_target = None
        self.target_name = ""
        self.target_title = ""
        self.target_session_path = ""
        QApplication.instance().installEventFilter(self)
        self.press_pos = QPoint()
        self.start_pos = QPoint()
        self.moved = False
        self.hovered = False
        self.tearing = False
        self._hover_exit_started = None
        self._last_frame_at = time.perf_counter()
        self.frame_timer = QTimer(self)
        self.frame_timer.setInterval(16)
        self.frame_timer.timeout.connect(self._tick_frame)
        self.frame_timer.start()
        # 运行期心跳：每 15s 向 Node 上报一次，Node 45s 没收到判失联（渲染崩/事件循环卡死）
        self._heartbeat_timer = QTimer(self)
        self._heartbeat_timer.setInterval(15000)
        self._heartbeat_timer.timeout.connect(self._send_heartbeat)
        self._heartbeat_timer.start()
        self.set_variant(self.variant)
        self.restore_position()

    def _send_heartbeat(self):
        # daemon 线程，避免请求卡住事件循环；失败静默（Node 会按超时判失联）
        def worker():
            try:
                request_json("POST", "/heartbeat", {}, timeout=5)
            except Exception:
                pass
        threading.Thread(target=worker, daemon=True, name="biaoqingbao-heartbeat").start()

    def set_variant(self, variant):
        self.variant = normalize_variant(variant)
        self.animator.set_variant(self.variant)
        self.tearing = False
        self.visual_state = "hover" if self.hovered else "normal"
        label = VARIANT_LABELS[self.variant]
        self.setAccessibleName(label + "悬浮球")
        self.setAccessibleDescription("点击打开表情包面板，拖动可以移动，右键关闭悬浮球")
        self.update()

    def set_visual_state(self, state):
        # 保留旧符号给现有调用方；真实画面由连续动效参数绘制。
        next_state = state if state in {"normal", "float", "hover", "tear"} else "normal"
        self.visual_state = next_state
        if next_state == "hover":
            self._set_hovered(True)
        elif next_state == "normal":
            self._set_hovered(False)
        self.update()

    def trigger_recent_arrival(self):
        self.animator.trigger_arrival()
        self.update()

    def start_recent_polling(self):
        self.panel.start_recent_polling()

    def stop_recent_polling(self):
        self.panel.stop_recent_polling()

    def play_idle_float(self):
        if self.hovered or self.tearing or self.moved:
            return
        self.visual_state = "float"
        self.animator.elapsed += 0.18
        self.update()
        QTimer.singleShot(180, self.finish_idle_float)

    def finish_idle_float(self):
        if not self.tearing and not self.moved:
            self.visual_state = "hover" if self.hovered else "normal"
            self.update()

    def _set_hovered(self, hovered):
        hovered = bool(hovered) and not self.moved
        self.hovered = hovered
        self.animator.set_hovered(hovered)
        if not self.tearing:
            self.visual_state = "hover" if hovered else "normal"

    def _refresh_pointer_and_hover(self, now):
        local = self.mapFromGlobal(QCursor.pos())
        half_w = max(1.0, self.width() / 2.0)
        half_h = max(1.0, self.height() / 2.0)
        self.animator.set_pointer((local.x() - half_w) / half_w, (local.y() - half_h) / half_h)
        if self.moved or self.animator.dragging:
            self._hover_exit_started = None
            return
        if self.hovered:
            exit_rect = self.rect().adjusted(-18, -18, 18, 18)
            if exit_rect.contains(local):
                self._hover_exit_started = None
            elif self._hover_exit_started is None:
                self._hover_exit_started = now
            elif now - self._hover_exit_started >= 0.22:
                self._hover_exit_started = None
                self._set_hovered(False)
            return
        enter_rect = self.rect().adjusted(8, 8, -8, -8)
        if enter_rect.contains(local):
            self._hover_exit_started = None
            self._set_hovered(True)

    def _tick_frame(self):
        now = time.perf_counter()
        dt = min(0.05, max(0.0, now - self._last_frame_at))
        self._last_frame_at = now
        self._refresh_pointer_and_hover(now)
        activation_done = self.animator.tick(dt)
        if activation_done and self.tearing:
            self.tearing = False
            self.visual_state = "hover" if self.hovered else "normal"
            self.toggle_panel()
        self.update()

    def begin_tear(self):
        if self.tearing or self.moved:
            return
        if self.panel.isVisible():
            self.toggle_panel()
            return
        if self.animator.trigger_activation():
            self.tearing = True
            self.visual_state = "tear"
            self.update()

    def cancel_tear(self):
        if not self.tearing and not self.animator.is_activating:
            return
        self.animator.cancel_activation()
        self.tearing = False
        self.visual_state = "hover" if self.hovered else "normal"
        self.update()

    def finish_tear(self):
        if not self.tearing:
            return
        self.animator.cancel_activation()
        self.tearing = False
        self.visual_state = "hover" if self.hovered else "normal"
        self.toggle_panel()

    def restore_position(self):
        state = read_state()
        if state:
            x, y = clamp_ball_position(state["x"], state["y"], screen_bounds(self))
            self.move(x, y)
            return
        bounds = screen_bounds(self)
        self.move(bounds[2] - BALL_SIZE - EDGE_INSET, bounds[3] - BALL_SIZE - 120)

    def snap_and_save(self):
        left, top, right, bottom = screen_bounds(self)
        x, y = self.x(), self.y()
        if x - left <= 26:
            x = left + EDGE_INSET
        elif right - (x + BALL_SIZE) <= 26:
            x = right - BALL_SIZE - EDGE_INSET
        x, y = clamp_ball_position(x, y, (left, top, right, bottom))
        self.move(x, y)
        write_state(x, y)

    def toggle_panel(self):
        # 左右键不互斥：开左键面板不收起右键菜单，两个弹窗可并存
        if self.panel.isVisible():
            self.panel.close()
            return
        self.panel.prepare_for_show()
        self.panel.show()
        self.panel.raise_()
        self.panel.activateWindow()

    def close_auxiliary_menus(self):
        menu = self.context_menu
        if menu is not None:
            menu.close()
        sticker_menu = getattr(self.panel, "_sticker_menu", None)
        if sticker_menu is not None:
            sticker_menu.close()
            self.panel._sticker_menu = None

    def toggle_context_menu(self):
        # 识图确认是独立流程，期间不再打开纸飞机右键菜单，避免覆盖编辑面板。
        if self.panel.recog_panel.isVisible():
            return
        # 左右键不互斥：开右键菜单不收起左键面板，两个弹窗可并存
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close()
            return
        if self.context_menu is None:
            self.context_menu = BallContextMenu(self)
        self.context_menu.show_at()

    def moveEvent(self, event):
        super().moveEvent(event)
        # 面板自身拖动时（面板带着球走），不再把面板拽回球旁，避免互相拉扯
        if self.panel.isVisible() and not getattr(self, '_panel_drag_lock', False):
            self.panel.move_to_ball()

    def enterEvent(self, event):
        if not self.moved:
            self._hover_exit_started = None
            self._set_hovered(True)
        super().enterEvent(event)

    def leaveEvent(self, event):
        # 不立刻撤掉 hover；持续摆动的小主体在边缘需要退出滞回，避免反复触发。
        if self._hover_exit_started is None:
            self._hover_exit_started = time.perf_counter()
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.cancel_tear()
            self.press_pos = event.globalPosition().toPoint()
            self.start_pos = self.pos()
            self.moved = False
            self.animator.set_dragging(False)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if event.buttons() & Qt.MouseButton.LeftButton:
            self.cancel_tear()
            delta = event.globalPosition().toPoint() - self.press_pos
            if delta.manhattanLength() >= QApplication.startDragDistance():
                self.moved = True
            if self.moved:
                self.animator.set_dragging(True, delta.x() / 48.0, delta.y() / 48.0)
                self.move(self.start_pos + delta)
                self.update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            if self.moved:
                self.snap_and_save()
                self.animator.set_dragging(False)
                self.moved = False
                self._last_frame_at = time.perf_counter()
                self._set_hovered(self.rect().contains(self.mapFromGlobal(QCursor.pos())))
            else:
                self.begin_tear()
            event.accept()
            return
        if event.button() == Qt.MouseButton.RightButton:
            self.toggle_context_menu()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
            self.begin_tear()
            event.accept()
            return
        super().keyPressEvent(event)

    def dragEnterEvent(self, event):
        mime = event.mimeData()
        if mime and (mime.hasUrls() or mime.hasImage()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        mime = event.mimeData()
        if mime and (mime.hasUrls() or mime.hasImage()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event):
        mime = event.mimeData()
        b64, ext, source_name = None, None, None
        if mime and mime.hasUrls():
            for url in mime.urls():
                if not url.isLocalFile():
                    continue
                fp = url.toLocalFile()
                if not fp:
                    continue
                lower = fp.lower()
                if not (lower.endswith('.png') or lower.endswith('.jpg') or lower.endswith('.jpeg')
                        or lower.endswith('.gif') or lower.endswith('.webp') or lower.endswith('.bmp')):
                    continue
                try:
                    with open(fp, 'rb') as fh:
                        raw = fh.read()
                    b64 = base64.b64encode(raw).decode('ascii')
                    ext = fp.rsplit('.', 1)[-1].lower()
                    source_name = os.path.basename(fp)
                except Exception:
                    b64, ext, source_name = None, None, None
                break
        if b64 is None and mime and mime.hasImage():
            img = mime.imageData()
            qimg = img if isinstance(img, QImage) else None
            if qimg is None and img is not None:
                try:
                    qimg = QImage(img)
                except Exception:
                    qimg = None
            if qimg is not None and not qimg.isNull():
                b64, ext = image_to_base64(qimg, 'PNG')
                source_name = '拖放图片.png'
        if b64:
            event.acceptProposedAction()
            self.panel.open_drop_recognition(b64, ext or 'png', source_name)
        else:
            event.ignore()

    def eventFilter(self, obj, event):
        if event.type() == QEvent.Type.MouseButtonPress:
            pos = event.globalPosition().toPoint()
            if self.panel.recog_panel.isVisible():
                # 识图流程独占纸飞机，外部点击与右键菜单均不介入。
                return super().eventFilter(obj, event)
            # 表情包右键菜单：点菜单外（空白/别处）收起
            sticker_menu = getattr(self.panel, '_sticker_menu', None)
            if sticker_menu is not None and sticker_menu.isVisible():
                if sticker_menu.geometry().contains(pos):
                    return super().eventFilter(obj, event)
                if event.button() == Qt.MouseButton.RightButton and isinstance(obj, StickerButton):
                    # 右键点在表情包上：交给 _open_sticker_context_menu（同图收起/异图切换）
                    return super().eventFilter(obj, event)
                sticker_menu.close()
                self.panel._sticker_menu = None
            menu = self.context_menu
            if menu is not None and menu.isVisible():
                if menu.geometry().contains(pos):
                    return super().eventFilter(obj, event)
                if event.button() == Qt.MouseButton.RightButton and self.geometry().contains(pos):
                    return super().eventFilter(obj, event)
                menu.close()
            if event.button() == Qt.MouseButton.LeftButton and self.panel.isVisible():
                # 识图确认是独立流程：保持可见、可编辑，不受普通面板的外部点击规则影响。
                if self.panel.recog_panel.isVisible():
                    return super().eventFilter(obj, event)
                in_ball = self.rect().contains(self.mapFromGlobal(pos))
                in_panel = self.panel.rect().contains(self.panel.mapFromGlobal(pos))
                in_popup = False
                for popup in (sticker_menu, menu):
                    if popup is not None and popup.isVisible() and popup.rect().contains(popup.mapFromGlobal(pos)):
                        in_popup = True
                        break
                if in_ball or in_panel or in_popup:
                    self.panel.restore_panel_opacity()
                else:
                    self.panel.close()
        return super().eventFilter(obj, event)

    def paintEvent(self, event):
        painter = QPainter(self)
        self.animator.paint(painter, self.rect())
        painter.end()

    def closeEvent(self, event):
        self.frame_timer.stop()
        self.stop_recent_polling()
        self.panel.shutdown()
        self.animator.cancel_activation()
        self.animator.set_dragging(False)
        self.tearing = False
        QApplication.instance().removeEventFilter(self)
        self.panel.close()
        if self.context_menu is not None:
            self.context_menu.close()
        write_state(self.x(), self.y())
        event.accept()


def main():
    if not API_TOKEN:
        print("缺少本地代理令牌", file=sys.stderr)
        return 2
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    ball = Ball()
    ball.show()
    ready = request_json("POST", "/ready", {}, timeout=3)
    if not ready.get("ok"):
        ball.close()
        return 3
    ball.start_recent_polling()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
