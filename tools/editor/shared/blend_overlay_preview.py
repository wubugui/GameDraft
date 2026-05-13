"""blendOverlayImage 编辑：Qt 场景近似预览（双图叠化，与游戏 mix 语义一致，过滤链可能略有差异）。"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from PySide6.QtCore import QEasingCurve, QRectF, Qt, QTimer, QVariantAnimation
from PySide6.QtGui import QBrush, QColor, QPainter, QPixmap
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from .image_path_picker import disk_path_for_runtime_url

# 参考「屏」比例 16:9；宽度占表单一列，高度随比例
PREVIEW_W = 420
PREVIEW_H = int(round(PREVIEW_W * 9 / 16))
DEBOUNCE_MS = 220
MAX_PREVIEW_DELAY_MS = 6000
MAX_PREVIEW_BLEND_MS = 12000


def _resolve_disk_path(model: ProjectModel | None, url: str) -> Path | None:
    t = (url or "").strip()
    if not t:
        return None
    if model:
        p = disk_path_for_runtime_url(model, t)
        if p is not None:
            return p
    cand = Path(t)
    return cand if cand.is_file() else None


class BlendOverlayPreviewWidget(QWidget):
    """
    双 QGraphicsPixmapItem：底 from、顶 to；顶不透明度 0→1 模拟 shader 的 mix（不透明区域等价）。
    布局：虚拟屏 PREVIEW_W×PREVIEW_H，widthPercent / 中心百分比与运行时一致；高度按 **to** 图比例。
    """

    def __init__(
        self,
        model: ProjectModel | None,
        get_params: Callable[[], dict],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._get_params = get_params
        self._scene = QGraphicsScene(self)
        self._scene.setSceneRect(QRectF(0, 0, PREVIEW_W, PREVIEW_H))
        self._view = QGraphicsView(self._scene)
        self._view.setFixedSize(PREVIEW_W, PREVIEW_H)
        self._view.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._view.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._view.setFrameShape(QFrame.Shape.StyledPanel)
        self._view.setRenderHints(
            self._view.renderHints() | QPainter.RenderHint.Antialiasing
        )

        self._item_from: QGraphicsPixmapItem | None = None
        self._item_to: QGraphicsPixmapItem | None = None
        self._opacity_anim: QVariantAnimation | None = None
        self._delay_timer = QTimer(self)
        self._delay_timer.setSingleShot(True)
        self._delay_timer.timeout.connect(self._start_blend_after_delay)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.timeout.connect(self._reload_scene)
        self._pending_blend_ms = 1000
        self._cap_note = ""

        self._status = QLabel("调整参数后自动刷新构图；「播放过渡」按 delay/duration 预览（过长已截断）。")
        self._status.setWordWrap(True)
        self._status.setStyleSheet("color:#888;font-size:11px;")

        btn_row = QHBoxLayout()
        self._btn_play = QPushButton("播放过渡")
        self._btn_play.clicked.connect(self._on_play)
        self._btn_stop = QPushButton("停止")
        self._btn_stop.clicked.connect(self._stop_all)
        btn_row.addWidget(self._btn_play)
        btn_row.addWidget(self._btn_stop)
        btn_row.addStretch(1)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(self._view)
        root.addLayout(btn_row)
        root.addWidget(self._status)

        self._reload_scene()

    def schedule_refresh(self) -> None:
        self._stop_all()
        self._debounce.start(DEBOUNCE_MS)

    def schedule_refresh_immediate(self) -> None:
        self._stop_all()
        self._debounce.stop()
        self._reload_scene()

    def _read_params(self) -> dict:
        try:
            return self._get_params()
        except Exception:
            return {}

    def _reload_scene(self) -> None:
        self._cap_note = ""
        self._scene.clear()
        bg = QGraphicsRectItem(0, 0, PREVIEW_W, PREVIEW_H)
        bg.setBrush(QBrush(QColor(0x1A, 0x1A, 0x2E)))
        bg.setPen(Qt.PenStyle.NoPen)
        self._scene.addItem(bg)

        p = self._read_params()
        from_url = str(p.get("from_url", "") or "")
        to_url = str(p.get("to_url", "") or "")
        try:
            x_pct = float(p.get("x_pct", 50.0))
            y_pct = float(p.get("y_pct", 50.0))
            w_pct = float(p.get("width_pct", 40.0))
        except (TypeError, ValueError):
            x_pct, y_pct, w_pct = 50.0, 50.0, 40.0
        w_pct = max(0.01, min(100.0, w_pct))
        x_pct = max(0.0, min(100.0, x_pct))
        y_pct = max(0.0, min(100.0, y_pct))

        path_from = _resolve_disk_path(self._model, from_url)
        path_to = _resolve_disk_path(self._model, to_url)
        self._item_from = None
        self._item_to = None

        if path_from is None and path_to is None:
            self._status.setText("无法预览：请填写有效 fromImage / toImage 路径（需能解析到磁盘文件）。")
            return

        pm_from = QPixmap(str(path_from)) if path_from else QPixmap()
        pm_to = QPixmap(str(path_to)) if path_to else QPixmap()
        if not pm_from.isNull() and pm_to.isNull():
            pm_to = pm_from.copy()
        if not pm_to.isNull() and pm_from.isNull():
            pm_from = pm_to.copy()
        if pm_from.isNull() or pm_to.isNull():
            self._status.setText("无法预览：图片加载失败。")
            return

        disp_w = PREVIEW_W * (w_pct / 100.0)
        iw_t = max(1, pm_to.width())
        ih_t = max(1, pm_to.height())
        disp_h = disp_w * (ih_t / iw_t)

        sw = int(max(1, round(disp_w)))
        sh = int(max(1, round(disp_h)))
        scaled_from = pm_from.scaled(
            sw, sh,
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        scaled_to = pm_to.scaled(
            sw, sh,
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )

        cx = PREVIEW_W * (x_pct / 100.0)
        cy = PREVIEW_H * (y_pct / 100.0)
        x0 = cx - disp_w / 2.0
        y0 = cy - disp_h / 2.0

        self._item_from = QGraphicsPixmapItem(scaled_from)
        self._item_from.setPos(x0, y0)
        self._scene.addItem(self._item_from)

        self._item_to = QGraphicsPixmapItem(scaled_to)
        self._item_to.setPos(x0, y0)
        self._item_to.setOpacity(0.0)
        self._scene.addItem(self._item_to)

        note = self._cap_note or (
            "构图已更新。播放时若 delay/duration 超过上限，预览会自动截断（见状态行）。"
        )
        self._status.setText(note)

    def _effective_timing(self, delay_ms: int, blend_ms: int) -> tuple[int, int, str]:
        raw_d = max(0, delay_ms)
        raw_b = max(0, blend_ms)
        d, b = raw_d, raw_b
        note = ""
        if d > MAX_PREVIEW_DELAY_MS:
            note = f"预览 delay 已截断为 {MAX_PREVIEW_DELAY_MS} ms（原 {raw_d}）。"
            d = MAX_PREVIEW_DELAY_MS
        if b > MAX_PREVIEW_BLEND_MS:
            extra = f"预览 duration 已截断为 {MAX_PREVIEW_BLEND_MS} ms（原 {raw_b}）。"
            note = f"{note} {extra}".strip()
            b = MAX_PREVIEW_BLEND_MS
        return d, b, note

    def _on_play(self) -> None:
        self._stop_all()
        self._reload_scene()
        if self._item_to is None:
            return
        p = self._read_params()
        try:
            delay_ms = int(p.get("delay_ms", 0))
        except (TypeError, ValueError):
            delay_ms = 0
        try:
            blend_ms = int(p.get("duration_ms", 600))
        except (TypeError, ValueError):
            blend_ms = 600
        eff_d, eff_b, cap_note = self._effective_timing(delay_ms, blend_ms)
        self._cap_note = cap_note
        if cap_note:
            self._status.setText(cap_note)

        self._item_to.setOpacity(0.0)
        self._pending_blend_ms = max(0, eff_b)

        if eff_d > 0:
            self._delay_timer.start(eff_d)
        else:
            self._start_blend_after_delay()

    def _start_blend_after_delay(self) -> None:
        if self._item_to is None:
            return
        ms = self._pending_blend_ms
        if ms <= 0:
            self._item_to.setOpacity(1.0)
            self._status.setText((self._cap_note + " duration 为 0，已直接显示目标图。").strip())
            return

        self._opacity_anim = QVariantAnimation(self)
        self._opacity_anim.setStartValue(0.0)
        self._opacity_anim.setEndValue(1.0)
        self._opacity_anim.setDuration(ms)
        self._opacity_anim.setEasingCurve(QEasingCurve.Type.Linear)

        def _apply(v) -> None:
            if self._item_to is not None:
                self._item_to.setOpacity(float(v))

        self._opacity_anim.valueChanged.connect(_apply)
        self._opacity_anim.finished.connect(
            lambda: self._status.setText((self._cap_note + " 预览播放完成。").strip() or "预览播放完成。")
        )
        self._opacity_anim.start()

    def _stop_all(self) -> None:
        self._delay_timer.stop()
        if self._opacity_anim is not None:
            self._opacity_anim.stop()
            self._opacity_anim.deleteLater()
            self._opacity_anim = None
        if self._item_to is not None:
            self._item_to.setOpacity(0.0)
