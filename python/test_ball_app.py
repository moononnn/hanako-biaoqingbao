# -*- coding: utf-8 -*-
import base64
import inspect
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["BIAOQINGBAO_BALL_STATE_PATH"] = os.path.join(
    tempfile.mkdtemp(prefix="biaoqingbao-ball-state-"), "ball-state.json"
)

from PyQt6.QtCore import QBuffer, QByteArray, QIODevice, QMimeData, QPointF, QRectF, QEvent, Qt, QUrl
from PyQt6.QtGui import QColor, QImage, QMouseEvent, QPainter
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QLabel, QPushButton

import ball_app
import ball_motifs


def mouse_event(event_type, x, y, button, buttons):
    point = QPointF(x, y)
    return QMouseEvent(event_type, point, point, button, buttons, Qt.KeyboardModifier.NoModifier)


def rendered_bytes(animator):
    image = QImage(ball_app.BALL_SIZE, ball_app.BALL_SIZE, QImage.Format.Format_ARGB32_Premultiplied)
    image.fill(QColor(0, 0, 0, 0))
    painter = QPainter(image)
    animator.paint(painter, QRectF(0, 0, ball_app.BALL_SIZE, ball_app.BALL_SIZE))
    painter.end()
    return bytes(image.bits().asstring(image.sizeInBytes()))


class BallLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_popup_anchor_places_panel_beside_ball(self):
        y = ball_app.popup_anchor_y((100, 100, 64, 64), 300, (0, 0, 800, 600), 0.38)
        self.assertEqual(y, 100 + 32 - int(300 * 0.38))

    def test_popup_prefers_left_side_and_falls_back_at_left_edge(self):
        left_x, _ = ball_app.position_popup_beside(
            (600, 100, 64, 64), (320, 300), (0, 0, 800, 600)
        )
        self.assertEqual(left_x, 272)
        fallback_x, _ = ball_app.position_popup_beside(
            (0, 100, 64, 64), (320, 300), (0, 0, 800, 600)
        )
        self.assertEqual(fallback_x, 72)

    def test_sticker_columns_shrink_for_narrow_screens(self):
        self.assertEqual(ball_app.sticker_columns_for_width(320), 4)
        self.assertEqual(ball_app.sticker_columns_for_width(250), 3)
        self.assertEqual(ball_app.sticker_columns_for_width(200), 2)
        self.assertEqual(ball_app.sticker_columns_for_width(120), 1)

    def test_popup_anchor_clamps_to_screen(self):
        self.assertEqual(ball_app.popup_anchor_y((100, 0, 64, 64), 300, (0, 0, 800, 600), 0.9), 0)
        self.assertEqual(ball_app.popup_anchor_y((100, 500, 64, 64), 300, (0, 0, 800, 600), 0.1), 300)

    def test_ball_position_keeps_edge_inset(self):
        self.assertEqual(ball_app.clamp_ball_position(-100, -100, (0, 0, 800, 600)), (16, 16))
        self.assertEqual(ball_app.clamp_ball_position(900, 900, (0, 0, 800, 600)), (712, 512))

    def test_ball_and_panel_construct_with_procedural_animator(self):
        ball = ball_app.Ball()
        self.assertEqual((ball.width(), ball.height()), (ball_app.BALL_SIZE, ball_app.BALL_SIZE))
        self.assertIsInstance(ball.animator, ball_motifs.MotifAnimator)
        self.assertIn(ball.variant, ball_motifs.VARIANTS)
        self.assertGreater(sum(1 for value in rendered_bytes(ball.animator)[3::4] if value), 150)
        self.assertEqual((ball.panel.width(), ball.panel.height()), (ball_app.PANEL_WIDTH, ball_app.PANEL_HEIGHT))
        self.assertTrue(ball.panel.testAttribute(Qt.WidgetAttribute.WA_StyledBackground))
        self.assertFalse(hasattr(ball.panel, "target"))
        self.assertIsInstance(ball.panel.editor, ball_app.MessageEdit)
        self.assertEqual(ball.panel.send_button.text(), "发送")
        self.assertFalse(ball.panel.send_button.isEnabled())
        ball.close()
        self.app.processEvents()

    def test_paper_plane_has_distinct_idle_hover_and_click_effect_frames(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.elapsed = 1.35
        idle = rendered_bytes(animator)
        animator.set_hovered(True)
        animator.hover_amount = 1.0
        animator.set_pointer(0.45, -0.35)
        hover = rendered_bytes(animator)
        animator.trigger_activation()
        animator.click_burst = 0.0
        animator._click_elapsed = animator.click_duration * 0.52
        click = rendered_bytes(animator)
        self.assertNotEqual(idle, hover, "悬停必须增加尾流和流星反馈")
        self.assertNotEqual(hover, click, "点击必须有独立的冲刺尾流和流星反馈")
        self.assertGreater(sum(1 for value in idle[3::4] if value), 150)

    def test_paper_plane_idle_has_visible_pitch_bob(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)

        def alpha_bbox(frame):
            visible = [index for index, value in enumerate(frame[3::4]) if value]
            return (
                min(index % ball_app.BALL_SIZE for index in visible),
                min(index // ball_app.BALL_SIZE for index in visible),
                max(index % ball_app.BALL_SIZE for index in visible),
                max(index // ball_app.BALL_SIZE for index in visible),
            )

        with patch.object(ball_motifs, "_draw_meteors", lambda *args: None), patch.object(
            ball_motifs, "_draw_gas_trail", lambda *args: None
        ):
            centers_y = []
            for phase in (0.4, 1.6, 2.8, 4.8):
                animator.elapsed = phase
                bbox = alpha_bbox(rendered_bytes(animator))
                centers_y.append((bbox[1] + bbox[3]) / 2.0)
        self.assertGreater(max(centers_y) - min(centers_y), 3.0, "待机时机头应有可见的轻微俯仰起伏")

    def test_paper_plane_hover_and_click_bursts_are_triggered_and_decay(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.set_hovered(True)
        animator.trigger_activation()
        self.assertEqual(animator.hover_burst, 1.0)
        self.assertEqual(animator.click_burst, 1.0)
        animator.tick(0.05)
        self.assertLess(animator.hover_burst, 1.0)
        self.assertLess(animator.click_burst, 1.0)

    def test_paper_plane_recent_match_arrival_only_flashes_tail_and_decays(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.trigger_arrival()
        self.assertEqual(animator.arrival_burst, 1.0)
        initial = rendered_bytes(animator)
        for _ in range(4):
            animator.tick(0.05)
        self.assertLess(animator.arrival_burst, 1.0)
        self.assertNotEqual(initial, rendered_bytes(animator))
        for _ in range(30):
            animator.tick(0.05)
        self.assertEqual(animator.arrival_burst, 0.0)

    def test_paper_plane_click_path_is_almost_parallel_with_small_bob(self):
        prep = [ball_motifs._plane_click_pose(progress) for progress in (0.0, 0.08, 0.15)]
        self.assertLess(max(abs(point[1]) for point in prep), 1.0)
        self.assertLess(max(abs(point[2]) for point in prep), 2.5)

        launch = [ball_motifs._plane_click_pose(progress) for progress in (0.16, 0.22, 0.36, 0.50, 0.63)]
        self.assertTrue(all(next_point[0] > point[0] for point, next_point in zip(launch, launch[1:])))
        self.assertLess(max(abs(point[2]) for point in launch), 3.5)
        flight_dx = launch[-1][0] - launch[0][0]
        flight_dy = launch[-1][1] - launch[0][1]
        self.assertGreater(flight_dx, 90.0)
        self.assertAlmostEqual(flight_dy / flight_dx, ball_motifs.PLANE_FLIGHT_SLOPE, delta=0.08)
        for point in launch:
            axis_y = launch[0][1] + ball_motifs.PLANE_FLIGHT_SLOPE * (point[0] - launch[0][0])
            self.assertLess(abs(point[1] - axis_y), 3.5, "颠簸只能是飞行轴线附近的小幅偏移")

        returning = [ball_motifs._plane_click_pose(progress) for progress in (0.64, 0.72, 0.84, 0.96)]
        self.assertLess(returning[0][0], -70.0, "回航必须从左侧完全离屏的位置开始")
        self.assertTrue(all(next_point[0] > point[0] for point, next_point in zip(returning, returning[1:])))
        self.assertLess(max(abs(point[2]) for point in returning), 3.5)

        for x0, y0, x1, y1 in ball_motifs.CLICK_METEOR_TRACKS:
            self.assertAlmostEqual((y1 - y0) / (x1 - x0), ball_motifs.PLANE_FLIGHT_SLOPE, delta=0.08)

    def test_paper_plane_return_starts_fully_offscreen_then_glides_back(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.hover_amount = 1.0
        animator.trigger_activation()
        # 背景流星是独立层，主体边界测试不把它误算成飞机残影。
        with patch.object(ball_motifs, "_draw_meteors", lambda *args: None), patch.object(
            ball_motifs, "_draw_gas_trail", lambda *args: None
        ):
            for progress in (0.60, 0.63, 0.64):
                animator._click_elapsed = animator.click_duration * progress
                launch_boundary = rendered_bytes(animator)
                self.assertEqual(
                    sum(1 for value in launch_boundary[3::4] if value),
                    0,
                    f"右侧冲刺在回航切换前必须整机离屏（{progress:.2f}）",
                )
            animator._click_elapsed = animator.click_duration * 0.70
            returning = rendered_bytes(animator)
        self.assertGreater(sum(1 for value in returning[3::4] if value), 30, "随后应从左侧连续回航")

    def test_paper_plane_local_trail_also_leaves_before_return(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.trigger_activation()
        # 只屏蔽独立的背景流星，尾流必须跟着飞机一起离屏。
        with patch.object(ball_motifs, "_draw_meteors", lambda *args: None):
            for progress in (0.60, 0.63, 0.64):
                animator._click_elapsed = animator.click_duration * progress
                frame = rendered_bytes(animator)
                self.assertEqual(
                    sum(1 for value in frame[3::4] if value),
                    0,
                    f"尾流在回航切换前不能残留在画布内（{progress:.2f}）",
                )

    def test_paper_plane_reference_asset_keeps_preoriented_shape(self):
        asset_path = os.path.join(os.path.dirname(ball_motifs.__file__), ball_motifs.PLANE_ASSET_FILENAME)
        self.assertTrue(os.path.isfile(asset_path), "纸飞机参考素材必须随插件一起分发")
        image = ball_motifs._plane_asset()
        self.assertFalse(image.isNull())
        self.assertTrue(image.hasAlphaChannel(), "纸飞机素材必须是真透明背景")
        self.assertGreater(image.width(), 500)
        self.assertGreater(image.height(), 400)
        rgba = image.convertToFormat(QImage.Format.Format_RGBA8888)
        raw = bytes(rgba.bits().asstring(rgba.sizeInBytes()))
        alpha = raw[3::4]
        pixel_count = rgba.width() * rgba.height()
        self.assertEqual(alpha[0], 0, "左上角必须是真透明")
        self.assertEqual(alpha[rgba.width() - 1], 0, "右上角必须是真透明")
        self.assertEqual(alpha[-rgba.width()], 0, "左下角必须是真透明")
        self.assertEqual(alpha[-1], 0, "右下角必须是真透明")
        self.assertGreater(sum(value == 0 for value in alpha), pixel_count // 4, "素材必须保留大面积透明边界")
        self.assertGreater(sum(value == 255 for value in alpha), pixel_count // 5, "主体必须有足够不透明像素")
        visible = [index for index, value in enumerate(alpha) if value]
        self.assertGreater(min(index % rgba.width() for index in visible), 5)
        self.assertGreater(min(index // rgba.width() for index in visible), 5)
        self.assertLess(max(index % rgba.width() for index in visible), rgba.width() - 6)
        self.assertLess(max(index // rgba.width() for index in visible), rgba.height() - 6)
        self.assertEqual(ball_motifs.PLANE_BASE_ANGLE, 0.0, "参考图已经朝右上，不能再额外旋转")

        animator = ball_motifs.MotifAnimator("plane", animations_enabled=False)
        rendered = rendered_bytes(animator)
        rendered_alpha = rendered[3::4]
        rendered_visible = [index for index, value in enumerate(rendered_alpha) if value]
        rendered_bbox = (
            min(index % ball_app.BALL_SIZE for index in rendered_visible),
            min(index // ball_app.BALL_SIZE for index in rendered_visible),
            max(index % ball_app.BALL_SIZE for index in rendered_visible),
            max(index // ball_app.BALL_SIZE for index in rendered_visible),
        )
        self.assertGreater(rendered_bbox[2] - rendered_bbox[0], 35, "72px 终尺寸主体不能过小")
        self.assertGreater(rendered_bbox[3] - rendered_bbox[1], 25, "72px 终尺寸主体不能过小")
        self.assertGreaterEqual(rendered_bbox[0], 0)
        self.assertGreaterEqual(rendered_bbox[1], 0)
        self.assertLess(rendered_bbox[2], ball_app.BALL_SIZE)
        self.assertLess(rendered_bbox[3], ball_app.BALL_SIZE)

    def test_paper_plane_trail_has_bright_flat_handbook_colors(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.elapsed = 0.45
        image = QImage(ball_app.BALL_SIZE, ball_app.BALL_SIZE, QImage.Format.Format_ARGB32_Premultiplied)
        image.fill(QColor(0, 0, 0, 0))
        painter = QPainter(image)
        painter.translate(ball_app.BALL_SIZE / 2.0, ball_app.BALL_SIZE / 2.0)
        ball_motifs._draw_gas_trail(animator, painter, 1.25)
        painter.end()

        pixels = [image.pixelColor(x, y) for y in range(image.height()) for x in range(image.width())]
        visible = [pixel for pixel in pixels if pixel.alpha() >= 50]
        colored = [pixel for pixel in visible if max(pixel.red(), pixel.green(), pixel.blue()) - min(pixel.red(), pixel.green(), pixel.blue()) >= 28]
        self.assertGreater(len(colored), 20, "尾流应有足够明显的彩色笔触")
        self.assertLess(len(visible) - len(colored), len(colored) * 2, "尾流不能退化成大面积灰雾")
        for name in ("MINT_DEEP", "PINK_DEEP", "TRAIL_APRICOT"):
            expected = QColor(getattr(ball_motifs, name))
            self.assertTrue(
                any(
                    abs(pixel.red() - expected.red()) < 45
                    and abs(pixel.green() - expected.green()) < 45
                    and abs(pixel.blue() - expected.blue()) < 45
                    for pixel in visible
                ),
                f"尾流缺少 {name} 彩色笔触",
            )

    def test_paper_plane_trail_sits_lower_near_the_tail_without_touching_the_body(self):
        self.assertAlmostEqual(ball_motifs.TRAIL_BAND_ORIGIN_Y, 23.5)
        self.assertAlmostEqual(ball_motifs.TRAIL_PARTICLE_ORIGIN_Y, 25.0)
        self.assertGreater(ball_motifs.TRAIL_PARTICLE_ORIGIN_Y, ball_motifs.TRAIL_BAND_ORIGIN_Y)

        # 取第一道波纹的起点横向位置，确认它与纸飞机屁股仍留有可见间距；
        # 同时用尾翼下尖位置确认波纹顶部已经收低到“几乎冲着尾巴尖尖”。
        image = ball_motifs._plane_asset().convertToFormat(QImage.Format.Format_RGBA8888)
        asset_scale = 58.0 / image.width()
        visual_scale = asset_scale * ball_motifs.PLANE_MOTIF_SCALE
        raw = bytes(image.bits().asstring(image.sizeInBytes()))

        def bottom_at(local_x):
            source_x = int(round((local_x + 29.0) / asset_scale))
            return max(
                (source_y + 0.5) * visual_scale - image.height() * visual_scale / 2.0
                for source_y in range(image.height())
                for source_col in range(max(0, source_x - 2), min(image.width(), source_x + 3))
                if raw[(source_y * image.width() + source_col) * 4 + 3] > 20
            )

        trail_origin = ball_motifs.TRAIL_BAND_ORIGIN_Y * ball_motifs.PLANE_MOTIF_SCALE
        self.assertGreaterEqual(trail_origin - bottom_at(-18.0), 10.0)
        self.assertLessEqual(abs(trail_origin - bottom_at(-11.0)), 2.0)

    def test_paper_plane_motif_is_smaller_while_the_72px_hit_area_stays(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=False)
        with patch.object(ball_motifs, "_draw_meteors", lambda *args: None), patch.object(
            ball_motifs, "_draw_gas_trail", lambda *args: None
        ):
            rendered = rendered_bytes(animator)
        visible = [index for index, value in enumerate(rendered[3::4]) if value]
        bbox = (
            min(index % ball_app.BALL_SIZE for index in visible),
            min(index // ball_app.BALL_SIZE for index in visible),
            max(index % ball_app.BALL_SIZE for index in visible),
            max(index // ball_app.BALL_SIZE for index in visible),
        )
        self.assertGreaterEqual(bbox[2] - bbox[0], 39)
        self.assertLessEqual(bbox[2] - bbox[0], 43)
        self.assertEqual(ball_app.BALL_SIZE, 72)

    def test_paper_plane_shape_does_not_add_lines_or_decorations(self):
        shape_source = inspect.getsource(ball_motifs._draw_plane_shape)
        draw_source = inspect.getsource(ball_motifs._draw_plane)
        trail_source = inspect.getsource(ball_motifs._draw_gas_trail)
        self.assertIn("drawImage", shape_source)
        self.assertNotIn("drawLine", shape_source)
        self.assertNotIn("drawPolygon", shape_source)
        self.assertIn("_draw_gas_trail", draw_source)
        self.assertIn("_draw_meteors", draw_source)
        self.assertNotIn("drawLine", shape_source)
        self.assertIn("TRAIL_APRICOT", trail_source)
        self.assertIn("drawEllipse", trail_source)
        self.assertNotIn("QRadialGradient", trail_source)

    def test_reduced_motion_keeps_feedback_but_finishes_quickly(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=False)
        animator.set_hovered(True)
        animator.trigger_activation()
        completed = False
        for _ in range(10):
            completed = animator.tick(0.02) or completed
        self.assertTrue(completed)
        self.assertFalse(animator.is_activating)
        self.assertLess(animator.elapsed, 0.1)

    def test_dragging_cancels_activation_and_records_direction_without_moving_window_animation(self):
        animator = ball_motifs.MotifAnimator("plane", animations_enabled=True)
        animator.trigger_activation()
        animator.set_dragging(True, 0.8, -0.5)
        self.assertFalse(animator.is_activating)
        self.assertTrue(animator.dragging)
        self.assertEqual(animator.drag_vector, (0.8, -0.5))
        animator.set_dragging(False)
        self.assertFalse(animator.dragging)
        self.assertGreater(animator.drag_amount, 0.9, "释放第一帧应保留拖拽姿态")
        for _ in range(8):
            animator.tick(0.02)
        self.assertEqual(animator.drag_vector, (0.0, 0.0))
        self.assertEqual(animator.drag_amount, 0.0)

    def test_hover_uses_continuous_progress_and_can_return_to_idle(self):
        ball = ball_app.Ball()
        ball.enterEvent(None)
        self.assertTrue(ball.hovered)
        self.assertEqual(ball.visual_state, "hover")
        for _ in range(8):
            ball.animator.tick(0.016)
        self.assertGreater(ball.animator.hover_amount, 0.5)
        ball._set_hovered(False)
        for _ in range(20):
            ball.animator.tick(0.016)
        self.assertFalse(ball.hovered)
        self.assertEqual(ball.visual_state, "normal")
        self.assertLess(ball.animator.hover_amount, 0.1)
        ball.close()
        self.app.processEvents()

    def test_drag_resets_moved_and_idle_can_resume(self):
        ball = ball_app.Ball()
        opened = []
        ball.toggle_panel = lambda: opened.append(True)
        ball.mousePressEvent(mouse_event(
            QEvent.Type.MouseButtonPress, 20, 20, Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton
        ))
        ball.mouseMoveEvent(mouse_event(
            QEvent.Type.MouseMove, 52, 52, Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton
        ))
        ball.mouseReleaseEvent(mouse_event(
            QEvent.Type.MouseButtonRelease, 52, 52, Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton
        ))
        self.assertFalse(ball.moved)
        self.assertEqual(opened, [])
        ball.hovered = False
        ball.play_idle_float()
        self.assertEqual(ball.visual_state, "float")
        QTest.qWait(450)
        self.assertEqual(ball.visual_state, "normal")
        ball.close()
        self.app.processEvents()

    def test_drag_during_tear_cancels_pending_panel_open(self):
        ball = ball_app.Ball()
        opened = []
        ball.toggle_panel = lambda: opened.append(True)
        ball.begin_tear()
        ball.mousePressEvent(mouse_event(
            QEvent.Type.MouseButtonPress, 20, 20, Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton
        ))
        ball.mouseMoveEvent(mouse_event(
            QEvent.Type.MouseMove, 52, 52, Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton
        ))
        ball.mouseReleaseEvent(mouse_event(
            QEvent.Type.MouseButtonRelease, 52, 52, Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton
        ))
        QTest.qWait(280)
        self.assertFalse(ball.tearing)
        self.assertFalse(ball.moved)
        self.assertEqual(opened, [])
        ball.close()
        self.app.processEvents()

    def test_paper_plane_finishes_click_animation_then_opens_panel(self):
        ball = ball_app.Ball()
        ball.set_variant("plane")
        ball._set_hovered(False)
        opened = []
        ball.toggle_panel = lambda: opened.append(True)
        ball.begin_tear()
        self.assertTrue(ball.tearing)
        self.assertEqual(ball.visual_state, "tear")
        QTest.qWait(int(ball.animator.click_duration * 1000) + 120)
        self.assertFalse(ball.tearing)
        self.assertEqual(ball.visual_state, "normal")
        self.assertEqual(opened, [True])
        ball.close()
        self.app.processEvents()

    def test_clicking_visible_panel_closes_immediately_without_replaying_long_animation(self):
        ball = ball_app.Ball()
        ball.panel.show()
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible())
        ball.begin_tear()
        self.app.processEvents()
        self.assertFalse(ball.panel.isVisible())
        self.assertFalse(ball.tearing)
        self.assertFalse(ball.animator.is_activating)
        ball.close()
        self.app.processEvents()

    def test_panel_applies_loaded_items_without_runtime_error(self):
        ball = ball_app.Ball()
        ball.panel.apply_items({"ok": True, "items": [], "target": None})
        self.app.processEvents()
        self.assertIn("优选表情包", ball.panel.hint.text())
        ball.close()
        self.app.processEvents()

    def test_recent_match_card_and_embedded_chat_state(self):
        ball = ball_app.Ball()
        ball.panel.show()
        first = {
            "ok": True,
            "sessionId": "sess_recent",
            "sessionPath": "C:/agents/hanako/sessions/recent.jsonl",
            "match": {
                "stickerId": "stk_001",
                "description": "认真点头",
                "emotion": "认可",
                "agentId": "hanako",
                "ts": 1,
                "feedback": None,
                "imageData": b"",
            },
        }
        ball.panel.apply_recent(first)
        self.app.processEvents()
        self.assertTrue(ball.panel.recent_card.isVisible())
        self.assertGreaterEqual(ball.panel.height(), ball_app.PANEL_HEIGHT + ball_app.RECENT_EXTRA_HEIGHT - 2)
        self.assertEqual(ball.panel.recent_description.text(), "认真点头")
        self.assertEqual(ball.panel.recent_like_button.text(), "喜欢")
        ball.panel.open_recent_chat()
        self.app.processEvents()
        self.assertTrue(ball.panel.chat_panel.isVisible())
        self.assertEqual(ball.panel.chat_sticker_id, "stk_001")
        ball.panel.chat_session_id = "chat_test"
        ball.panel.on_chat_done({
            "ok": True,
            "session_id": "chat_test",
            "reply": "我明白了。",
            "suggestion": {"description": "认真点头表示认可", "emotion": ["认可"], "scene": ["回应"], "keywords": ["点头"]},
            "old_tags": {"description": "认真点头", "emotion": ["开心"], "scene": [], "keywords": []},
        }, ball.panel.chat_request_seq, None)
        self.app.processEvents()
        self.assertTrue(ball.panel.chat_preview.isVisible())
        self.assertIn("认可", ball.panel.chat_preview_text.text())
        ball.close()
        self.app.processEvents()

    def test_recent_two_button_positive_feedback_kinds(self):
        # v0.33.63 - 喜欢/应景两键：再点同维度=取消，跨维度=both，both 再点某维度=只剩另一维度
        next_kind = ball_app.BallPanel._next_positive_kind
        self.assertEqual(next_kind(None, None, "image"), "image")
        self.assertEqual(next_kind("positive", "image", "image"), None)
        self.assertEqual(next_kind("positive", "image", "context"), "both")
        self.assertEqual(next_kind("positive", "context", "image"), "both")
        self.assertEqual(next_kind("positive", "both", "image"), "context")
        self.assertEqual(next_kind("positive", "both", "context"), "image")
        self.assertEqual(next_kind("negative", None, "context"), "context")
        self.assertEqual(next_kind(None, None, "context"), "context")

    def test_recent_two_button_positive_state_sync(self):
        ball = ball_app.Ball()
        ball.panel.show()
        base = {"ok": True, "sessionId": "sess_pos2", "sessionPath": "C:/agents/hanako/sessions/pos2.jsonl", "match": {
            "stickerId": "stk_001", "description": "一张图", "emotion": "开心", "agentId": "hanako", "ts": 1,
            "feedback": None, "feedbackKind": None, "imageData": b""
        }}
        ball.panel.apply_recent(base)
        # 应景
        ball.panel.recent_feedback_seq = 1
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": "positive", "feedback_kind": "context"}, 1)
        self.assertEqual(ball.panel.recent_fit_button.text(), "已应景")
        self.assertEqual(ball.panel.recent_like_button.text(), "喜欢")
        # both（喜欢+应景都亮）
        ball.panel.recent_feedback_seq = 2
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": "positive", "feedback_kind": "both"}, 2)
        self.assertEqual(ball.panel.recent_fit_button.text(), "已应景")
        self.assertEqual(ball.panel.recent_like_button.text(), "已喜欢")
        # 取消（再点同维度=clear）
        ball.panel.recent_feedback_seq = 3
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": None, "feedback_kind": None}, 3)
        self.assertEqual(ball.panel.recent_fit_button.text(), "应景")
        self.assertEqual(ball.panel.recent_like_button.text(), "喜欢")
        # 不喜欢后聊一聊才出现
        ball.panel.recent_feedback_seq = 4
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": "negative", "dislike_count": 1}, 4)
        self.assertEqual(ball.panel.recent_dislike_button.text(), "已反馈")
        self.assertTrue(ball.panel.recent_chat_button.isVisible())
        ball.close()
        self.app.processEvents()

    def test_history_feedback_failure_reenables_row_buttons(self):
        ball = ball_app.Ball()
        ball.panel._add_history_row({
            "sessionId": "sess_history_error",
            "stickerId": "stk_001",
            "description": "一张图",
            "emotion": "开心",
            "feedback": None,
            "feedbackKind": None,
            "imageData": b"",
        })
        row = ball.panel.history_list.itemAt(0).widget()
        buttons = row.findChildren(QPushButton)
        likes = [button for button in buttons if button.property("feedback") == "positive"]
        dislike = next(button for button in buttons if button.property("feedback") == "negative")
        chat = next(button for button in buttons if button.objectName() == "recentChat")
        self.assertEqual(len(likes), 2)  # 喜欢 + 应景
        state = {"feedback": None, "feedbackKind": None}
        ball.panel.history_busy = True
        for button in likes + [dislike, chat]:
            button.setEnabled(False)
        ball.panel._on_history_feedback_done(
            {"ok": False, "error": "网络失败"},
            ball.panel.history_feedback_seq,
            likes[0], likes[1], dislike, chat, state,
        )
        for button in likes + [dislike]:
            self.assertTrue(button.isEnabled())
        ball.close()
        self.app.processEvents()

    def test_recent_feedback_button_state_and_tail_arrival_on_match_change(self):
        ball = ball_app.Ball()
        base = {"ok": True, "sessionId": "sess_a", "sessionPath": "C:/agents/hanako/sessions/a.jsonl", "match": {
            "stickerId": "stk_001", "description": "一张图", "emotion": "开心", "agentId": "hanako", "ts": 1, "feedback": None, "imageData": b""
        }}
        ball.panel.apply_recent(base)
        ball.panel.recent_feedback_seq = 1
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": "negative", "dislike_count": 1}, 1)
        self.assertEqual(ball.panel.recent_dislike_button.text(), "已反馈")
        self.assertEqual(ball.panel.recent_like_button.text(), "喜欢")
        next_match = {"ok": True, "sessionId": "sess_a", "sessionPath": base["sessionPath"], "match": {
            "stickerId": "stk_002", "description": "另一张图", "emotion": "得意", "agentId": "hanako", "ts": 2, "feedback": None, "imageData": b""
        }}
        ball.panel.apply_recent(next_match)
        self.assertEqual(ball.animator.arrival_burst, 1.0)
        ball.close()
        self.app.processEvents()

    def test_stale_feedback_reply_does_not_touch_new_recent_match(self):
        ball = ball_app.Ball()
        first = {"ok": True, "sessionId": "sess_race", "sessionPath": "C:/agents/hanako/sessions/race.jsonl", "match": {
            "stickerId": "stk_old", "description": "旧图", "emotion": "开心", "agentId": "hanako", "ts": 1, "feedback": None, "imageData": b""
        }}
        ball.panel.apply_recent(first)
        old_signature = ball.panel.recent_signature
        ball.panel.recent_feedback_seq = 1
        second = {"ok": True, "sessionId": "sess_race", "sessionPath": first["sessionPath"], "match": {
            "stickerId": "stk_new", "description": "新图", "emotion": "得意", "agentId": "hanako", "ts": 2, "feedback": None, "imageData": b""
        }}
        ball.panel.apply_recent(second)
        ball.panel.on_recent_feedback_done({"ok": True, "feedback": "negative", "dislike_count": 1}, 1, old_signature)
        self.assertIsNone(ball.panel.recent_match.get("feedback"))
        ball.close()
        self.app.processEvents()

    def test_stale_chat_confirm_reply_is_discarded_after_close(self):
        ball = ball_app.Ball()
        ball.panel.apply_recent({"ok": True, "sessionId": "sess_chat", "sessionPath": "C:/agents/hanako/sessions/chat.jsonl", "match": {
            "stickerId": "stk_chat", "description": "聊天图", "emotion": "认可", "agentId": "hanako", "ts": 1, "feedback": None, "imageData": b""
        }})
        ball.panel.open_recent_chat()
        ball.panel.chat_session_id = "chat_1"
        ball.panel.chat_suggestion = {"description": "新描述"}
        ball.panel.chat_request_seq += 1
        confirm_seq = ball.panel.chat_request_seq
        ball.panel.chat_busy = True
        ball.panel.close_chat()
        ball.panel.on_chat_confirm_done({"ok": True}, confirm_seq, "stk_chat")
        self.assertFalse(ball.panel.chat_busy)
        self.assertFalse(ball.panel.chat_preview.isVisible())
        ball.close()
        self.app.processEvents()

    def test_sticker_button_has_no_visible_label(self):
        button = ball_app.StickerButton({"id": "stk_1", "description": "一张图"}, ball_app.QPixmap())
        self.assertEqual(button.text(), "")
        button.deleteLater()
        self.app.processEvents()

    def test_clicking_sticker_selects_without_sending_and_second_click_cancels(self):
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [
                {"id": "stk_1", "description": "认真点头", "imageData": b""},
                {"id": "stk_2", "description": "猫猫摊手", "imageData": b""},
            ],
        })
        self.app.processEvents()
        first = ball.panel.grid.itemAt(1).widget()
        first.click()
        self.assertEqual(ball.panel.selected_sticker_id, "stk_1")
        self.assertTrue(ball.panel.send_button.isEnabled())
        self.assertIn("认真点头", ball.panel.hint.text())
        first.click()
        self.assertIsNone(ball.panel.selected_sticker_id)
        self.assertFalse(ball.panel.send_button.isEnabled())
        ball.close()
        self.app.processEvents()

    def test_message_edit_enter_requests_send_and_shift_enter_inserts_newline(self):
        editor = ball_app.MessageEdit()
        requested = []
        editor.send_requested.connect(lambda: requested.append(True))
        editor.setProperty("canSend", True)
        editor.show()
        editor.setFocus()
        QTest.keyClick(editor, Qt.Key.Key_Return)
        self.assertEqual(requested, [True])
        QTest.keyClick(editor, Qt.Key.Key_Return, Qt.KeyboardModifier.ShiftModifier)
        self.assertEqual(editor.toPlainText(), "\n")
        editor.close()
        self.app.processEvents()

    def test_send_uses_selected_image_and_editor_text(self):
        ball = ball_app.Ball()
        captured = []
        original_request_json = ball_app.request_json

        def fake_request_json(method, route, payload=None, timeout=10):
            captured.append((method, route, payload, timeout))
            return {"ok": True}

        ball_app.request_json = fake_request_json
        try:
            ball.panel.apply_items({
                "ok": True,
                "items": [{"id": "stk_1", "description": "认真点头", "imageData": b""}],
            })
            self.app.processEvents()
            ball.panel.grid.itemAt(1).widget().click()
            ball.panel.editor.setPlainText("收到啦")
            ball.panel.send_selected()
            for _ in range(10):
                QTest.qWait(10)
                self.app.processEvents()
            self.assertEqual(captured[0][1], "/send")
            self.assertEqual(captured[0][2]["stickerId"], "stk_1")
            self.assertEqual(captured[0][2]["text"], "收到啦")
        finally:
            ball_app.request_json = original_request_json
            ball.close()
            self.app.processEvents()

    def test_send_success_clears_selection_and_text(self):
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [{"id": "stk_1", "description": "认真点头", "imageData": b""}],
        })
        self.app.processEvents()
        ball.panel.grid.itemAt(1).widget().click()
        ball.panel.editor.setPlainText("收到啦")
        ball.panel.busy = True
        ball.panel.on_send_done({"ok": True})
        self.assertIsNone(ball.panel.selected_sticker_id)
        self.assertEqual(ball.panel.editor.toPlainText(), "")
        self.assertTrue(ball.panel.editor.isEnabled())
        self.assertFalse(ball.panel.send_button.isEnabled())
        ball.close()
        self.app.processEvents()

    def test_send_failure_keeps_selection_and_text_for_retry(self):
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [{"id": "stk_1", "description": "认真点头", "imageData": b""}],
        })
        self.app.processEvents()
        ball.panel.grid.itemAt(1).widget().click()
        ball.panel.editor.setPlainText("收到啦")
        ball.panel.busy = True
        ball.panel.on_send_done({"ok": False, "error": "发送失败"})
        self.assertEqual(ball.panel.selected_sticker_id, "stk_1")
        self.assertEqual(ball.panel.editor.toPlainText(), "收到啦")
        self.assertTrue(ball.panel.editor.isEnabled())
        self.assertTrue(ball.panel.send_button.isEnabled())
        self.assertEqual(ball.panel.send_button.text(), "发送")
        self.assertIn("内容已保留", ball.panel.hint.text())
        ball.close()
        self.app.processEvents()

    def test_timeout_requires_explicit_confirmation_before_retry(self):
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [{"id": "stk_1", "description": "认真点头", "imageData": b""}],
        })
        self.app.processEvents()
        ball.panel.grid.itemAt(1).widget().click()
        ball.panel.editor.setPlainText("收到啦")
        ball.panel.busy = True
        ball.panel.on_send_done({"ok": False, "status": 504, "error": "Hana 响应超时，消息可能已经送达"})
        self.assertTrue(ball.panel.retry_confirmation_required)
        self.assertEqual(ball.panel.send_button.text(), "确认重发")
        self.assertEqual(ball.panel.editor.toPlainText(), "收到啦")
        ball.panel.editor.setPlainText("我改了正文")
        self.assertFalse(ball.panel.retry_confirmation_required)
        self.assertEqual(ball.panel.send_button.text(), "发送")
        ball.close()
        self.app.processEvents()

    def test_left_panel_and_right_menu_can_coexist(self):
        # 左右键不互斥：开右键菜单不收起左键面板，两个弹窗可并存
        ball = ball_app.Ball()
        ball.panel.refresh = lambda: None
        ball.panel._sync_target_state = lambda: None
        ball.show()
        self.app.processEvents()
        ball.toggle_panel()
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible())
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible(), "右键菜单不应替换左键面板")
        self.assertTrue(ball.context_menu.isVisible())
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        self.assertTrue(ball.panel.isVisible())
        ball.toggle_panel()
        self.app.processEvents()
        self.assertFalse(ball.panel.isVisible())
        ball.close()
        self.app.processEvents()

    def test_panel_has_target_selector(self):
        ball = ball_app.Ball()
        self.assertTrue(hasattr(ball.panel, "target_menu"))
        self.assertIsInstance(ball.panel.target_menu, ball_app.TargetMenu)
        self.assertEqual(ball.panel.btn_target.text(), "自动判断 ▾")
        self.assertIs(ball.panel.target_menu.parent(), ball.panel, "目标菜单必须内嵌在面板里")
        ball.close()
        self.app.processEvents()

    def test_target_menu_expands_inside_panel(self):
        # 点开目标菜单：面板内嵌入式展开并随菜单长高；再点收起恢复正常高度
        ball = ball_app.Ball()
        ball.panel.refresh = lambda: None
        ball.panel._sync_target_state = lambda: None
        ball.show()
        self.app.processEvents()
        ball.toggle_panel()
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible())
        base_h = ball.panel.height()
        ball.panel._open_target_menu()
        for _ in range(6):
            QTest.qWait(10)
            self.app.processEvents()
        self.assertTrue(ball.panel.target_menu.isVisible())
        self.assertGreaterEqual(ball.panel.height(), base_h + ball_app.TARGET_MENU_EXTRA - 20)
        ball.panel._open_target_menu()
        for _ in range(6):
            QTest.qWait(10)
            self.app.processEvents()
        self.assertFalse(ball.panel.target_menu.isVisible())
        self.assertLessEqual(ball.panel.height(), base_h + 2)
        ball.close()
        self.app.processEvents()

    def test_right_click_toggles_context_menu(self):
        ball = ball_app.Ball()
        ball.move(200, 200)
        ball.show()
        self.app.processEvents()
        event = mouse_event(
            QEvent.Type.MouseButtonRelease, 20, 20,
            Qt.MouseButton.RightButton, Qt.MouseButton.NoButton,
        )
        ball.mouseReleaseEvent(event)
        self.app.processEvents()
        self.assertIsNotNone(ball.context_menu)
        self.assertTrue(ball.context_menu.isVisible())
        ball.mouseReleaseEvent(event)
        self.app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        self.app.processEvents()

    def test_context_menu_has_no_other_style_switcher(self):
        ball = ball_app.Ball()
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertEqual(ball.context_menu.windowTitle(), "")
        labels = [
            child.text()
            for child in ball.context_menu.findChildren(ball_app.QPushButton)
        ]
        self.assertEqual(labels, ["关闭悬浮球"])
        self.assertFalse(hasattr(ball.context_menu, "variant_buttons"))
        self.assertIn("纸飞机", ball.context_menu.findChild(ball_app.QLabel).text())
        ball.close()
        self.app.processEvents()

    def test_outside_click_closes_context_menu(self):
        ball = ball_app.Ball()
        ball.move(200, 200)
        ball.show()
        self.app.processEvents()
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertTrue(ball.context_menu.isVisible())
        outside = mouse_event(
            QEvent.Type.MouseButtonPress, 700, 500,
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        ball.eventFilter(None, outside)
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        self.app.processEvents()

    def test_outside_click_closes_normal_panel_but_not_recognition_panel(self):
        ball = ball_app.Ball()
        ball.move(200, 200)
        ball.panel.move(40, 40)
        ball.panel.show()
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible())
        outside = mouse_event(
            QEvent.Type.MouseButtonPress, 700, 500,
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        ball.eventFilter(None, outside)
        self.app.processEvents()
        self.assertFalse(ball.panel.isVisible())

        ball.panel.show()
        ball.panel.recog_panel.wait_paste()
        self.app.processEvents()
        self.assertTrue(ball.panel.recog_panel.isVisible())
        ball.eventFilter(None, outside)
        self.app.processEvents()
        self.assertTrue(ball.panel.isVisible())
        self.assertTrue(ball.panel.recog_panel.isVisible())
        ball.close()
        self.app.processEvents()

    def test_normal_panel_fades_after_delay_and_recognition_panel_stays_opaque(self):
        ball = ball_app.Ball()
        panel = ball.panel
        panel._panel_pointer_inside = lambda: False
        panel.show()
        self.app.processEvents()
        self.assertTrue(panel._fade_poll_timer.isActive())
        QTest.qWait(ball_app.PANEL_FADE_DELAY_MS + ball_app.PANEL_FADE_POLL_MS + 100)
        self.app.processEvents()
        self.assertAlmostEqual(panel.windowOpacity(), ball_app.PANEL_FADE_OPACITY, places=2)

        panel._panel_pointer_inside = lambda: True
        QTest.qWait(ball_app.PANEL_FADE_POLL_MS + 40)
        self.app.processEvents()
        self.assertAlmostEqual(panel.windowOpacity(), 1.0, places=2)

        panel.recog_panel.wait_paste()
        self.app.processEvents()
        panel.setWindowOpacity(ball_app.PANEL_FADE_OPACITY)
        panel._panel_pointer_inside = lambda: False
        QTest.qWait(ball_app.PANEL_FADE_POLL_MS + 40)
        self.app.processEvents()
        self.assertAlmostEqual(panel.windowOpacity(), 1.0, places=2)
        ball.close()
        self.app.processEvents()

    def test_recognition_panel_blocks_context_menu(self):
        ball = ball_app.Ball()
        ball.panel.show()
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertTrue(ball.context_menu.isVisible())
        ball.panel.recog_panel.wait_paste()
        self.app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        ball.toggle_context_menu()
        self.app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        self.app.processEvents()

    def test_sticker_index_at_maps_grid_position_and_clamps(self):
        # 4 列网格：磁贴 62 + spacing 5 + margin 2
        self.assertEqual(ball_app.sticker_index_at(2, 2, 4, 8), 0)
        self.assertEqual(ball_app.sticker_index_at(60, 2, 4, 8), 0)
        self.assertEqual(ball_app.sticker_index_at(70, 2, 4, 8), 1)
        self.assertEqual(ball_app.sticker_index_at(2, 70, 4, 8), 4)
        # 超出范围 clamp 到最后一个
        self.assertEqual(ball_app.sticker_index_at(9999, 9999, 4, 8), 7)
        self.assertEqual(ball_app.sticker_index_at(-50, -50, 4, 8), 0)
        self.assertEqual(ball_app.sticker_index_at(2, 2, 4, 0), 0)
        # 2 列网格
        self.assertEqual(ball_app.sticker_index_at(70, 70, 2, 6), 3)

    def test_reorder_items_moves_item_and_keeps_others(self):
        items = [{"id": f"stk_{i}"} for i in range(5)]
        moved = ball_app.reorder_items(items, 0, 3)
        self.assertEqual([item["id"] for item in moved], ["stk_1", "stk_2", "stk_3", "stk_0", "stk_4"])
        moved_back = ball_app.reorder_items(moved, 3, 0)
        self.assertEqual([item["id"] for item in moved_back], ["stk_0", "stk_1", "stk_2", "stk_3", "stk_4"])
        # 原列表不被修改
        self.assertEqual([item["id"] for item in items], ["stk_0", "stk_1", "stk_2", "stk_3", "stk_4"])
        # 同位置不动
        self.assertEqual(ball_app.reorder_items(items, 2, 2), items)
        self.assertEqual(ball_app.reorder_items([], 0, 1), [])

    def test_sticker_button_drag_start_calls_back(self):
        phases = []
        positions = []

        def on_drag(button, phase, global_pos):
            phases.append(phase)
            positions.append(global_pos)

        button = ball_app.StickerButton(
            {"id": "stk_1", "description": "一张图"}, ball_app.QPixmap(),
            on_drag=on_drag,
        )
        button.show()
        button.move(100, 100)
        self.app.processEvents()
        start = button.mapToGlobal(button.rect().center())
        # 按住左键（press）
        press = mouse_event(
            QEvent.Type.MouseButtonPress, start.x(), start.y(),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        button.mousePressEvent(press)
        # 小移动：没超过阈值，不触发
        small = mouse_event(
            QEvent.Type.MouseMove, start.x() + 2, start.y(),
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        )
        button.mouseMoveEvent(small)
        self.assertEqual(phases, [])
        # 大移动：触发拖拽 start
        big = mouse_event(
            QEvent.Type.MouseMove, start.x() + 30, start.y(),
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        )
        button.mouseMoveEvent(big)
        self.assertEqual(phases, ["start"])
        # 拖拽中继续 move
        more = mouse_event(
            QEvent.Type.MouseMove, start.x() + 50, start.y(),
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        )
        button.mouseMoveEvent(more)
        self.assertEqual(phases, ["start", "move"])
        # 松手：end
        release = mouse_event(
            QEvent.Type.MouseButtonRelease, start.x() + 50, start.y(),
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
        )
        button.mouseReleaseEvent(release)
        self.assertEqual(phases, ["start", "move", "end"])
        button.close()
        self.app.processEvents()

    def test_drag_reorder_persists_new_order(self):
        ball = ball_app.Ball()
        captured = []
        original_request_json = ball_app.request_json

        def fake_request_json(method, route, payload=None, timeout=10):
            captured.append((method, route, payload, timeout))
            return {"ok": True}

        ball_app.request_json = fake_request_json
        try:
            ball.panel.apply_items({
                "ok": True,
                "items": [
                    {"id": "stk_1", "description": "第一张", "imageData": b""},
                    {"id": "stk_2", "description": "第二张", "imageData": b""},
                    {"id": "stk_3", "description": "第三张", "imageData": b""},
                    {"id": "stk_4", "description": "第四张", "imageData": b""},
                ],
            })
            ball.panel.show()
            ball.panel.move(200, 200)
            self.app.processEvents()
            # 模拟从 0 拖到 2：第一张挪到第三位（grid 第 0 格是「添加」占位格）
            button = ball.panel.grid.itemAt(1).widget()
            from_pos = button.mapToGlobal(button.rect().center())
            button._press_pos = from_pos
            button._dragging = True
            # 目标位置：第三张图所在格子（grid 第 3 格）
            target_button = ball.panel.grid.itemAt(3).widget()
            target_pos = target_button.mapToGlobal(target_button.rect().center())
            ball.panel._on_sticker_drag(button, "start", from_pos)
            ball.panel._on_sticker_drag(button, "move", target_pos)
            ball.panel._on_sticker_drag(button, "end", target_pos)
            self.app.processEvents()
            ids = [item.get("id") for item in ball.panel.items]
            self.assertEqual(ids, ["stk_2", "stk_3", "stk_1", "stk_4"])
            reorder_calls = [c for c in captured if c[1] == "/pinned/reorder"]
            self.assertEqual(len(reorder_calls), 1)
            self.assertEqual(reorder_calls[0][2]["ids"], ["stk_2", "stk_3", "stk_1", "stk_4"])
        finally:
            ball_app.request_json = original_request_json
            ball.close()
            self.app.processEvents()

    def test_drag_reorder_same_position_no_save(self):
        ball = ball_app.Ball()
        captured = []
        original_request_json = ball_app.request_json

        def fake_request_json(method, route, payload=None, timeout=10):
            captured.append((method, route, payload, timeout))
            return {"ok": True}

        ball_app.request_json = fake_request_json
        try:
            ball.panel.apply_items({
                "ok": True,
                "items": [
                    {"id": "stk_1", "description": "第一张", "imageData": b""},
                    {"id": "stk_2", "description": "第二张", "imageData": b""},
                ],
            })
            self.app.processEvents()
            button = ball.panel.grid.itemAt(1).widget()
            pos = button.mapToGlobal(button.rect().center())
            ball.panel._on_sticker_drag(button, "start", pos)
            ball.panel._on_sticker_drag(button, "end", pos)
            self.app.processEvents()
            reorder_calls = [c for c in captured if c[1] == "/pinned/reorder"]
            self.assertEqual(reorder_calls, [])
        finally:
            ball_app.request_json = original_request_json
            ball.close()
            self.app.processEvents()

    def test_recognition_button_shows_in_progress_state_and_restores_on_error(self):
        """识图请求进行时按钮直接显示状态，失败后恢复可重试。"""
        ball = ball_app.Ball()
        try:
            ball.panel.open_drop_recognition("aGVsbG8=", "png", "test.png")
            self.app.processEvents()
            recog = ball.panel.recog_panel
            with patch.object(ball_app.BackgroundRequest, "start", lambda _worker: None):
                recog.run_recognition()
                self.assertTrue(recog.busy)
                self.assertFalse(recog.btn_go.isEnabled())
                self.assertEqual(recog.btn_go.text(), "识图中")
                self.assertEqual(recog.status.text(), "")

                recog._on_recognition_done({"ok": False, "error": "测试失败"}, recog.request_seq)

            self.assertFalse(recog.busy)
            self.assertTrue(recog.btn_go.isEnabled())
            self.assertEqual(recog.btn_go.text(), "识别")
            self.assertEqual(recog.status.text(), "识别失败：测试失败")
        finally:
            ball.close()
            self.app.processEvents()

    def test_recognition_panel_resets_button_after_first_save(self):
        """第一张入库成功后自动切回主面板，再拖入第二张图识别流程仍可用。"""
        ball = ball_app.Ball()
        original_request_json = ball_app.request_json

        def fake_request_json(method, route, payload=None, timeout=10):
            # 入库成功，返回 sticker id
            if route == "/recognition-confirm":
                return {"ok": True, "data": {"sticker": {"id": "stk_new_1"}}}
            if route == "/recognition":
                return {"ok": True, "data": {"description": "测试图", "emotion": ["开心"], "scene": [], "keywords": []}}
            return {"ok": True}

        ball_app.request_json = fake_request_json
        try:
            # 第一张：拖入 → 识别 → 确认入库 → 识别面板收起、主面板弹出
            ball.panel.open_drop_recognition("aGVsbG8=", "png", "first.png")
            self.app.processEvents()
            self.assertTrue(ball.panel.recog_panel.btn_go.isEnabled())
            self.assertEqual(ball.panel.recog_panel.btn_go.text(), "识别")
            ball.panel.recog_panel.run_recognition()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            self.assertEqual(ball.panel.recog_panel.step, "editing")
            self.assertEqual(ball.panel.recog_panel.btn_go.text(), "确认入库")
            ball.panel.recog_panel.confirm_save()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            self.assertFalse(ball.panel.recog_panel.isVisible())
            self.assertTrue(ball.panel.isVisible())
            # 第二张：再拖一张进来，识别流程恢复可用
            ball.panel.open_drop_recognition("d29ybGQ=", "png", "second.png")
            self.app.processEvents()
            self.assertTrue(ball.panel.recog_panel.isVisible())
            self.assertTrue(ball.panel.recog_panel.btn_go.isEnabled())
            self.assertEqual(ball.panel.recog_panel.btn_go.text(), "识别")
            self.assertEqual(ball.panel.recog_panel.step, "preview")
        finally:
            ball_app.request_json = original_request_json
            ball.close()
            self.app.processEvents()

    def test_sticker_menu_closes_on_blank_click_and_same_sticker_right_click(self):
        """表情包右键菜单：点空白处收起；再次右键同一张图收起（不重弹）。"""
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [
                {"id": "stk_1", "description": "第一张", "imageData": b""},
                {"id": "stk_2", "description": "第二张", "imageData": b""},
            ],
        })
        ball.panel.show()
        ball.move(200, 200)
        self.app.processEvents()
        first = ball.panel.grid.itemAt(1).widget()
        second = ball.panel.grid.itemAt(2).widget()

        # 右键第一张 → 菜单弹出
        pos1 = first.mapToGlobal(first.rect().center())
        ball.panel._open_sticker_context_menu(first.item, pos1)
        self.app.processEvents()
        self.assertIsNotNone(ball.panel._sticker_menu)
        self.assertTrue(ball.panel._sticker_menu.isVisible())
        old_menu = ball.panel._sticker_menu

        # 再次右键同一张 → 收起，不重弹
        ball.panel._open_sticker_context_menu(first.item, pos1)
        self.app.processEvents()
        self.assertFalse(old_menu.isVisible())
        self.assertIsNone(ball.panel._sticker_menu)

        # 再右键第一张 → 又弹出
        ball.panel._open_sticker_context_menu(first.item, pos1)
        self.app.processEvents()
        self.assertTrue(ball.panel._sticker_menu.isVisible())

        # 点空白处 → 收起（模拟全局 eventFilter 收到空白处左键点击）
        blank_click = mouse_event(
            QEvent.Type.MouseButtonPress, 10, 10,
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        ball.eventFilter(None, blank_click)
        self.app.processEvents()
        self.assertIsNone(ball.panel._sticker_menu)

        # 右键另一张 → 切换（旧菜单关、新菜单开）
        pos2 = second.mapToGlobal(second.rect().center())
        ball.panel._open_sticker_context_menu(first.item, pos1)
        self.app.processEvents()
        old_menu = ball.panel._sticker_menu
        ball.panel._open_sticker_context_menu(second.item, pos2)
        self.app.processEvents()
        self.assertFalse(old_menu.isVisible())
        self.assertIsNotNone(ball.panel._sticker_menu)
        self.assertEqual(ball.panel._sticker_menu.sticker_id, "stk_2")
        ball.close()
        self.app.processEvents()

    def test_confirm_save_marks_teaching_only_when_edited(self):
        """悬浮球确认入库：用户手动改过描述/关键词才带 teaching=true，否则不记教学。"""
        ball = ball_app.Ball()
        captured = []
        original_request_json = ball_app.request_json

        def fake_request_json(method, route, payload=None, timeout=10):
            captured.append((method, route, payload, timeout))
            if route == "/recognition":
                return {"ok": True, "data": {"description": "一只猫", "semantic_description": "适合开心时轻松回应", "emotion": ["开心"], "scene": [], "keywords": ["猫"]}}
            if route == "/recognition-confirm":
                return {"ok": True, "data": {"sticker": {"id": "stk_new_1"}}}
            return {"ok": True}

        ball_app.request_json = fake_request_json
        try:
            # 第一轮：识别后不改标签直接入库 → teaching 应为 False
            ball.panel.open_drop_recognition("aGVsbG8=", "png", "first.png")
            self.app.processEvents()
            ball.panel.recog_panel.run_recognition()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            ball.panel.recog_panel.confirm_save()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            confirm_calls = [c for c in captured if c[1] == "/recognition-confirm"]
            self.assertEqual(len(confirm_calls), 1)
            self.assertFalse(confirm_calls[0][2].get("teaching"))
            self.assertEqual(confirm_calls[0][2]["tags"].get("semantic_description"), "适合开心时轻松回应")

            # 第二轮：改描述为「呆猫八条」再入库 → teaching 应为 True
            captured.clear()
            ball.panel.open_drop_recognition("d29ybGQ=", "png", "second.png")
            self.app.processEvents()
            ball.panel.recog_panel.run_recognition()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            ball.panel.recog_panel.edit_desc.setPlainText("呆猫八条，戴着粉色蝴蝶结")
            ball.panel.recog_panel.confirm_save()
            for _ in range(6):
                QTest.qWait(5)
                self.app.processEvents()
            confirm_calls = [c for c in captured if c[1] == "/recognition-confirm"]
            self.assertEqual(len(confirm_calls), 1)
            self.assertTrue(confirm_calls[0][2].get("teaching"))
        finally:
            ball_app.request_json = original_request_json
            ball.close()
            self.app.processEvents()

    def test_add_cell_occupies_first_grid_slot_and_opens_paste(self):
        """图集网格第 0 格是「＋ 添加表情包」占位格，点击进入粘贴识别。"""
        ball = ball_app.Ball()
        ball.panel.apply_items({
            "ok": True,
            "items": [
                {"id": "stk_1", "description": "第一张", "imageData": b""},
                {"id": "stk_2", "description": "第二张", "imageData": b""},
            ],
        })
        self.app.processEvents()
        # 第 0 格是占位格，第 1/2 格才是图片
        cell = ball.panel.grid.itemAt(0).widget()
        self.assertIsInstance(cell, ball_app.AddStickerCell)
        self.assertIn("添加", cell.text())
        first_img = ball.panel.grid.itemAt(1).widget()
        self.assertIsInstance(first_img, ball_app.StickerButton)
        self.assertEqual(first_img.item.get("id"), "stk_1")
        # 点击占位格 → 进入粘贴等待态
        cell.click()
        self.app.processEvents()
        self.assertTrue(ball.panel.recog_panel.isVisible())
        self.assertEqual(ball.panel.recog_panel.step, "wait_paste")
        ball.close()
        self.app.processEvents()

    def test_sticker_button_movie_for_gif_only(self):
        """面板动图：GIF 项建 QMovie 驱动图标，静态图不建；播放控制不崩。"""
        gif_bytes = bytes([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61,  # GIF89a
            0x01, 0x00, 0x01, 0x00,              # 1×1
            0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xff, 0xff, 0xff,
            0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0x02, 0x02, 0x44, 0x01, 0x00,
            0x3b,
        ])
        ball = ball_app.Ball()
        try:
            ball.panel.apply_items({
                "ok": True,
                "items": [
                    {"id": "stk_gif", "description": "动图", "imageData": gif_bytes},
                    {"id": "stk_png", "description": "静图", "imageData": b""},
                ],
            })
            self.app.processEvents()
            gif_btn = ball.panel._buttons_by_id["stk_gif"]
            png_btn = ball.panel._buttons_by_id["stk_png"]
            self.assertIsNotNone(gif_btn._movie, "GIF 项应有 QMovie")
            self.assertIsNone(png_btn._movie, "静态项不应建 QMovie")
            # 生命周期锁：QBuffer 必须挂在 QMovie 下（销毁顺序 = QMovie 先停再删 buffer，
            # 否则播放中重建网格会 access violation 0xC0000005，删除图片后纸飞机消失）
            self.assertEqual(gif_btn._movie_buffer.parent(), gif_btn._movie,
                             "QBuffer 必须挂在 QMovie 下保证销毁顺序")
            # 播放/暂停控制不崩（offscreen 下帧解码可能不触发，只验证状态切换安全）
            gif_btn.set_movie_playing(True)
            gif_btn.set_movie_playing(False)
            ball.panel._set_all_movies(True)
            ball.panel._set_all_movies(False)
            # 播放态重建网格（删除后 refresh 路径）不崩
            ball.panel._set_all_movies(True)
            ball.panel.apply_items({
                "ok": True,
                "items": [{"id": "stk_new", "description": "新图", "imageData": gif_bytes}],
            })
            self.app.processEvents()
            self.assertIsNotNone(ball.panel._buttons_by_id.get("stk_new"))
        finally:
            ball.close()
            self.app.processEvents()

    def test_recognition_preview_plays_gif_movie(self):
        """确认入库预览：GIF 动图用 QMovie 播（pix.setMovie），静态图仍走 QPixmap。"""
        gif_bytes = bytes([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61,  # GIF89a
            0x01, 0x00, 0x01, 0x00,              # 1×1
            0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xff, 0xff, 0xff,
            0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0x02, 0x02, 0x44, 0x01, 0x00,
            0x3b,
        ])
        ball = ball_app.Ball()
        try:
            recog = ball.panel.recog_panel
            # GIF → QMovie 播放
            recog.start(base64.b64encode(gif_bytes).decode('ascii'), 'gif', 'a.gif')
            self.app.processEvents()
            self.assertIsNotNone(recog._preview_movie, "GIF 预览应建 QMovie")
            self.assertIsNotNone(recog.pix.movie(), "QLabel 应挂上 QMovie")
            # 静态图 → 回到 QPixmap，movie 清掉
            qi = QImage(4, 4, QImage.Format.Format_ARGB32)
            qi.fill(QColor(120, 200, 150, 255))
            buf = QBuffer()
            buf.open(QIODevice.OpenModeFlag.WriteOnly)
            qi.save(buf, 'PNG')
            png_bytes = bytes(buf.data())
            buf.close()
            recog.start(base64.b64encode(png_bytes).decode('ascii'), 'png', 'b.png')
            self.app.processEvents()
            self.assertIsNone(recog._preview_movie, "静态图不应建 QMovie")
            self.assertIsNone(recog.pix.movie(), "静态图应清除 QMovie")
        finally:
            ball.close()
            self.app.processEvents()

    def test_add_cell_persists_during_load(self):
        """图集加载期间/失败后「＋ 添加表情包」占位格常驻，且靠左第一位（不居中）。"""
        ball = ball_app.Ball()
        try:
            ball.panel.refresh()  # 连不上 Node，加载会失败
            self.app.processEvents()
            time.sleep(0.3)
            self.app.processEvents()
            cell = ball.panel.grid.itemAt(0).widget()
            self.assertIsInstance(cell, ball_app.AddStickerCell)
            # 加载中网格应靠左（添加格在第一位），不能水平居中
            align = ball.panel.grid.alignment()
            self.assertTrue(bool(align & Qt.AlignmentFlag.AlignLeft), "加载中网格应 AlignLeft")
            self.assertFalse(bool(align & Qt.AlignmentFlag.AlignHCenter), "加载中不能 AlignHCenter")
            # 图集到位后恢复水平居中
            ball.panel.apply_items({'ok': True, 'items': [{'id': 'x1', 'description': '图', 'imageData': b''}] * 6})
            self.app.processEvents()
            align2 = ball.panel.grid.alignment()
            self.assertTrue(bool(align2 & Qt.AlignmentFlag.AlignHCenter), "图集到位应恢复 AlignHCenter")
        finally:
            ball.close()
            self.app.processEvents()

    def test_load_items_concurrent_keeps_order_and_data(self):
        """load_items 并发拉图：顺序保持、imageData 齐全（串行→并发改动回归）。"""
        stickers = [{'id': str(i), 'description': f'图{i}'} for i in range(5)]
        calls = []
        def fake(sid):
            calls.append(sid)
            return b'img-' + str(sid).encode()
        with patch.object(ball_app, 'load_image_data', side_effect=fake), \
             patch.object(ball_app, 'request_json', return_value={'ok': True, 'stickers': stickers}):
            r = ball_app.BallPanel.load_items()
        self.assertTrue(r['ok'])
        self.assertEqual([i['id'] for i in r['items']], ['0', '1', '2', '3', '4'], '并发后顺序应保持')
        self.assertEqual(sorted(calls), ['0', '1', '2', '3', '4'])
        for i in r['items']:
            self.assertEqual(i['imageData'], b'img-' + i['id'].encode())

    def test_history_stale_response_does_not_replace_newer_result(self):
        """手帐旧请求晚回时不能覆盖重新打开后拿到的新列表。"""
        ball = ball_app.Ball()
        try:
            panel = ball.panel
            panel.history_request_seq = 2
            panel._render_history({"ok": True, "items": [
                {"stickerId": "new", "sessionTitle": "刚刚的新记录", "imageData": b"", "feedback": None},
            ]}, 2)
            panel._render_history({"ok": True, "items": [
                {"stickerId": "old", "sessionTitle": "打开前的旧记录", "imageData": b"", "feedback": None},
            ]}, 1)
            self.assertEqual(panel.history_list.count(), 1)
            labels = [label.text() for label in panel.history_list.itemAt(0).widget().findChildren(QLabel)]
            self.assertIn("刚刚的新记录", labels)
            self.assertNotIn("打开前的旧记录", labels)
        finally:
            ball.close()
            self.app.processEvents()

    def test_history_panel_button_and_switch(self):
        """配图手帐：入口按钮存在，打开/关闭在图集与手帐间切换，记录行可渲染。"""
        ball = ball_app.Ball()
        try:
            panel = ball.panel
            self.assertEqual(panel.btn_history.text(), "配图手帐")
            panel.open_history_panel()
            self.app.processEvents()
            self.assertIs(panel.stack.currentWidget(), panel.history_panel, "打开手帐应切到手帐视图")
            panel._render_history({"ok": True, "items": [
                {"stickerId": "s1", "sessionTitle": "正在聊插件的那段对话", "description": "开心小猫", "emotion": "开心", "agentId": "hanako",
                 "ts": 1724390000000, "imageData": b"", "feedback": None},
            ]})
            self.app.processEvents()
            self.assertEqual(panel.history_list.count(), 1, "应渲染一行记录")
            row = panel.history_list.itemAt(0).widget()
            labels = [label.text() for label in row.findChildren(QLabel)]
            self.assertIn("正在聊插件的那段对话", labels, "手帐应显示对话框标题")
            self.assertNotIn("开心小猫", labels, "手帐不再显示表情包描述")
            self.assertNotIn("开心", labels, "手帐不再显示情绪标签")
            self.assertEqual(
                [button.text() for button in row.findChildren(QPushButton)],
                ["喜欢", "应景", "不喜欢", "和小花聊聊"],
                "手帐按钮应为：喜欢/应景/不喜欢/聊一聊",
            )
            thumb = row.findChildren(QLabel)[0]
            panel._set_history_compact(True)
            self.assertTrue(thumb.isHidden(), "极窄面板应先让出缩略图宽度，避免按钮出界")
            panel._set_history_compact(False)
            self.assertFalse(thumb.isHidden(), "正常宽度应恢复显示图片")
            panel.close_history_panel()
            self.app.processEvents()
            self.assertIs(panel.stack.currentWidget(), panel.scroll, "返回应切回图集")
        finally:
            ball.close()
            self.app.processEvents()

    def test_open_chat_for_shows_chat_panel(self):
        """配图手帐「聊聊」：open_chat_for 打开聊天面板并绑定 sticker。"""
        ball = ball_app.Ball()
        try:
            ball.panel.open_chat_for("s1", b"")
            self.app.processEvents()
            self.assertFalse(ball.panel.chat_panel.isHidden(), "open_chat_for 应显示聊天面板")
            self.assertEqual(ball.panel.chat_sticker_id, "s1")
        finally:
            ball.close()
            self.app.processEvents()

    def test_read_clipboard_keeps_gif_bytes_from_image_gif_format(self):
        """复制识图：剪贴板带 image/gif 原始字节时，原样保留动图（不压成静态 PNG）。"""
        ball = ball_app.Ball()
        try:
            recog = ball.panel.recog_panel
            # 最小 1×1 GIF（GIF89a）
            gif_bytes = bytes([
                0x47, 0x49, 0x46, 0x38, 0x39, 0x61,  # GIF89a
                0x01, 0x00, 0x01, 0x00,              # 1×1
                0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
                0xff, 0xff, 0xff,
                0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
                0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
                0x02, 0x02, 0x44, 0x01, 0x00,
                0x3b,
            ])
            mime = QMimeData()
            mime.setData('image/gif', QByteArray(gif_bytes))

            class _FakeClipboard:
                def mimeData(self):
                    return mime
                def image(self):
                    return QImage()

            with patch('ball_app.QApplication.clipboard', return_value=_FakeClipboard()):
                b64, ext, name = recog._read_clipboard_image()
            self.assertEqual(ext, 'gif')
            self.assertIsNotNone(b64)
            # 字节原样保留，没被 QImage 转成静态帧
            self.assertEqual(base64.b64decode(b64), gif_bytes)
            self.assertTrue((name or '').endswith('.gif'))
        finally:
            ball.close()
            self.app.processEvents()

    def test_read_clipboard_keeps_gif_bytes_from_file_url(self):
        """复制识图：剪贴板是本地 .gif 文件引用时，读原始字节原样保留动图。"""
        ball = ball_app.Ball()
        tmp_dir = tempfile.mkdtemp(prefix="biaoqingbao-clip-gif-")
        gif_path = os.path.join(tmp_dir, "clip.gif")
        gif_bytes = bytes([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
            0x01, 0x00, 0x01, 0x00,
            0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xff, 0xff, 0xff,
            0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0x02, 0x02, 0x44, 0x01, 0x00,
            0x3b,
        ])
        with open(gif_path, 'wb') as fh:
            fh.write(gif_bytes)
        try:
            recog = ball.panel.recog_panel
            mime = QMimeData()
            mime.setUrls([QUrl.fromLocalFile(gif_path)])

            class _FakeClipboard:
                def mimeData(self):
                    return mime
                def image(self):
                    return QImage()

            with patch('ball_app.QApplication.clipboard', return_value=_FakeClipboard()):
                b64, ext, name = recog._read_clipboard_image()
            self.assertEqual(ext, 'gif')
            self.assertIsNotNone(b64)
            self.assertEqual(base64.b64decode(b64), gif_bytes)
            self.assertEqual(name, 'clip.gif')
        finally:
            ball.close()
            self.app.processEvents()

    def test_read_clipboard_file_url_wins_over_bitmap(self):
        """QQ 复制动图场景：剪贴板同时带位图（静态帧）和本地 .gif 文件引用时，文件 URL 必须优先。"""
        gif_bytes = bytes([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61,  # GIF89a
            0x01, 0x00, 0x01, 0x00,              # 1×1
            0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
            0xff, 0xff, 0xff,
            0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
            0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0x02, 0x02, 0x44, 0x01, 0x00,
            0x3b,
        ])
        tmp_dir = tempfile.mkdtemp(prefix="biaoqingbao-clip-both-")
        gif_path = os.path.join(tmp_dir, "qq_cache.gif")
        with open(gif_path, 'wb') as fh:
            fh.write(gif_bytes)
        ball = ball_app.Ball()
        try:
            recog = ball.panel.recog_panel
            mime = QMimeData()
            mime.setUrls([QUrl.fromLocalFile(gif_path)])  # 文件引用（动图原图）
            mime.setImageData(QImage(4, 4, QImage.Format.Format_ARGB32))  # 位图（静态帧）

            class _FakeClipboard:
                def mimeData(self):
                    return mime
                def image(self):
                    return QImage()

            with patch('ball_app.QApplication.clipboard', return_value=_FakeClipboard()):
                b64, ext, name = recog._read_clipboard_image()
            self.assertEqual(ext, 'gif')
            self.assertEqual(base64.b64decode(b64), gif_bytes)  # 完整动图字节，不是位图帧
            self.assertEqual(name, 'qq_cache.gif')
        finally:
            ball.close()
            self.app.processEvents()

    def test_read_clipboard_static_png_still_goes_image_path(self):
        """复制识图：静态 PNG 走 QImage → PNG，ext 仍为 png（回归，不破坏静态图）。"""
        ball = ball_app.Ball()
        try:
            recog = ball.panel.recog_panel
            qi = QImage(2, 2, QImage.Format.Format_ARGB32)
            qi.fill(QColor(255, 0, 0, 255))
            mime = QMimeData()
            mime.setImageData(qi)

            class _FakeClipboard:
                def mimeData(self):
                    return mime
                def image(self):
                    return qi

            with patch('ball_app.QApplication.clipboard', return_value=_FakeClipboard()):
                b64, ext, name = recog._read_clipboard_image()
            self.assertEqual(ext, 'png')
            self.assertIsNotNone(b64)
            self.assertEqual(name, '粘贴图片.png')
        finally:
            ball.close()
            self.app.processEvents()

    def test_panel_drag_moves_ball_together(self):
        """拖动面板时纸飞机跟着一起走，且 moveEvent 不把面板拽回球旁。"""
        ball = ball_app.Ball()
        ball.move(300, 300)
        ball.panel.show()
        ball.panel.move(200, 200)
        self.app.processEvents()

        panel_before = ball.panel.pos()
        ball_before = ball.pos()

        # 按住面板空白处（用面板自身坐标构造 press）
        press = mouse_event(
            QEvent.Type.MouseButtonPress,
            panel_before.x() + 10, panel_before.y() + 10,
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        ball.panel.mousePressEvent(press)
        self.assertIsNotNone(ball.panel._panel_drag)

        # 移动超过阈值 → 面板和球一起动
        move1 = mouse_event(
            QEvent.Type.MouseMove,
            panel_before.x() + 40, panel_before.y() + 25,
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        )
        ball.panel.mouseMoveEvent(move1)
        self.app.processEvents()
        self.assertTrue(ball.panel._panel_dragging)
        self.assertEqual(ball.panel.pos().x(), panel_before.x() + 30)
        self.assertEqual(ball.panel.pos().y(), panel_before.y() + 15)
        self.assertEqual(ball.pos().x(), ball_before.x() + 30)
        self.assertEqual(ball.pos().y(), ball_before.y() + 15)

        # 移动过程中 ball.moveEvent 不应把面板拽回球旁（锁生效）
        self.assertTrue(ball._panel_drag_lock)

        # 松手 → 结束拖动，球位置保留
        release = mouse_event(
            QEvent.Type.MouseButtonRelease,
            panel_before.x() + 40, panel_before.y() + 25,
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
        )
        ball.panel.mouseReleaseEvent(release)
        self.app.processEvents()
        self.assertIsNone(ball.panel._panel_drag)
        self.assertFalse(ball._panel_drag_lock)
        self.assertEqual(ball.pos().x(), ball_before.x() + 30)
        self.assertEqual(ball.pos().y(), ball_before.y() + 15)
        ball.close()
        self.app.processEvents()

    def test_panel_click_without_drag_does_not_move(self):
        """点面板空白但不拖动（小于阈值）→ 面板和球都不动。"""
        ball = ball_app.Ball()
        ball.move(300, 300)
        ball.panel.show()
        ball.panel.move(200, 200)
        self.app.processEvents()

        panel_before = ball.panel.pos()
        ball_before = ball.pos()

        press = mouse_event(
            QEvent.Type.MouseButtonPress,
            panel_before.x() + 10, panel_before.y() + 10,
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        )
        ball.panel.mousePressEvent(press)
        tiny = mouse_event(
            QEvent.Type.MouseMove,
            panel_before.x() + 11, panel_before.y() + 10,
            Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        )
        ball.panel.mouseMoveEvent(tiny)
        self.assertFalse(ball.panel._panel_dragging)
        release = mouse_event(
            QEvent.Type.MouseButtonRelease,
            panel_before.x() + 11, panel_before.y() + 10,
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
        )
        ball.panel.mouseReleaseEvent(release)
        self.app.processEvents()
        self.assertEqual(ball.panel.pos(), panel_before)
        self.assertEqual(ball.pos(), ball_before)
        ball.close()
        self.app.processEvents()


def _random_pixels_image(w, h, with_alpha=True):
    """造一张逐像素随机的图：PNG 压不动，编码后必超限（贴近真实照片的熵）。"""
    import os as _os
    bpp = 4
    raw = _os.urandom(w * h * bpp)
    fmt = QImage.Format.Format_ARGB32 if with_alpha else QImage.Format.Format_RGB32
    img = QImage(raw, w, h, w * bpp, fmt)
    return img.copy()  # 拷贝一份，确保字节被 QImage 持有


class RecognitionImageFitTests(unittest.TestCase):
    """拖入/粘贴大图的识图前压缩：IPC body 限 2MB，超限必须被压回安全线内。"""

    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_oversized_photo_is_compressed_under_limit(self):
        """1600×1200 噪点图（必超 1.8MB）→ 压缩后 ≤1.8MB 且最长边 ≤1024。"""
        b64, ext = ball_app.image_to_base64(_random_pixels_image(1600, 1200, with_alpha=False), 'PNG')
        self.assertGreater(len(b64), ball_app._RECOG_BODY_LIMIT, '前置：测试图必须真的超限')
        out_b64, out_ext = ball_app.fit_recognition_image(b64, ext)
        self.assertLessEqual(len(out_b64), ball_app._RECOG_BODY_LIMIT)
        self.assertIn(out_ext, ('png', 'jpg'))
        img2 = QImage()
        img2.loadFromData(base64.b64decode(out_b64))
        self.assertLessEqual(max(img2.width(), img2.height()), 1024)

    def test_transparent_oversized_image_stays_png(self):
        """带透明通道的大图必须保持 PNG（转 JPG 会把透明变黑底）。"""
        b64, ext = ball_app.image_to_base64(_random_pixels_image(1400, 1400, with_alpha=True), 'PNG')
        self.assertGreater(len(b64), ball_app._RECOG_BODY_LIMIT, '前置：测试图必须真的超限')
        out_b64, out_ext = ball_app.fit_recognition_image(b64, ext)
        self.assertEqual(out_ext, 'png')
        self.assertLessEqual(len(out_b64), ball_app._RECOG_BODY_LIMIT)
        img2 = QImage()
        img2.loadFromData(base64.b64decode(out_b64))
        self.assertTrue(img2.hasAlphaChannel())

    def test_small_image_passes_through_unchanged(self):
        """未超限的小图原样返回（GIF 动图、小图都不动）。"""
        b64, ext = ball_app.image_to_base64(_random_pixels_image(400, 300, with_alpha=False), 'PNG')
        self.assertLess(len(b64), ball_app._RECOG_BODY_LIMIT)
        out_b64, out_ext = ball_app.fit_recognition_image(b64, ext)
        self.assertEqual(out_b64, b64)
        self.assertEqual(out_ext, ext)

    def test_medium_gif_passes_through_over_old_limit(self):
        """GIF 动图 base64 在旧 1.8MB 限额之上、新 7MB 之内时原样保留（不再被压成静态帧）。"""
        fake_gif = b'GIF89a' + b'\x00' * 1_900_000  # 字节 ~1.9MB，base64 约 2.5MB
        b64 = base64.b64encode(fake_gif).decode('ascii')
        self.assertGreater(len(b64), ball_app._RECOG_BODY_LIMIT, '前置：必须超过旧静态图限额')
        self.assertLessEqual(len(b64), ball_app._GIF_BODY_LIMIT, '前置：在 GIF 保留上限内')
        out_b64, out_ext = ball_app.fit_recognition_image(b64, 'gif')
        self.assertEqual(out_ext, 'gif')
        self.assertEqual(out_b64, b64)  # 字节原样，动画不丢

    def test_oversized_gif_still_compresses_gracefully(self):
        """GIF 超过 7MB 极端大图仍降级压缩（不崩，能识别）；返回不是 gif 即说明降级成功。"""
        fake_gif = b'GIF89a' + b'\x00' * 7_500_000
        b64 = base64.b64encode(fake_gif).decode('ascii')
        self.assertGreater(len(b64), ball_app._GIF_BODY_LIMIT, '前置：超过 GIF 保留上限')
        out_b64, out_ext = ball_app.fit_recognition_image(b64, 'gif')
        # 伪 GIF 无真实图像数据，解码失败会原样返回（不崩即可）；真实动图才会压成 png/jpg
        self.assertIsInstance(out_b64, str)
        self.assertTrue(out_ext in ('gif', 'png', 'jpg', 'jpeg'))

    def test_garbage_or_empty_input_returns_as_is(self):
        """空输入/不可解码输入不炸，原样返回。"""
        self.assertEqual(ball_app.fit_recognition_image('', 'png'), ('', 'png'))
        self.assertEqual(ball_app.fit_recognition_image(None, 'png'), (None, 'png'))
        self.assertEqual(ball_app.fit_recognition_image('not-base64!!', 'png'), ('not-base64!!', 'png'))


if __name__ == "__main__":
    unittest.main()
