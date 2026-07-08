"""文档揭示「模糊图」涂抹生成器：在编辑器里对清晰图手绘水墨乱涂遮糊，烘焙出 blurredImagePath。

运行时不变（[DocumentRevealManager] 仍是 blurred→clear 两张 PNG 叠化）；本工具只是把以前
在 PS 里做的「涂抹」搬进编辑器——画一层墨迹涂鸦盖住要遮的字/物 + 可选整体压暗，导出**同尺寸**
PNG 写回 blurredImagePath。涂鸦图层(ink layer)另存到 editor_projects 作可复编 sidecar（编辑器
专用、不随游戏发布、不入素材审计）。

涂鸦走「短墨迹乱涂」而非马赛克/高斯模糊，贴合本作水墨告示的风格。
"""
from __future__ import annotations

import math
import random
import re
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from .hex_color_pick_row import HexColorPickRow

_SAFE_NAME = re.compile(r"[^0-9A-Za-z_一-鿿-]+")
_MAX_VEIL_ALPHA = 150  # baseline=100% 时整体压暗的最大 alpha


def _safe_stem(text: str, fallback: str = "doc") -> str:
    s = _SAFE_NAME.sub("_", (text or "").strip()).strip("_")
    return s or fallback


def sidecar_path_for(model: ProjectModel, doc_id: str) -> Path | None:
    """涂鸦图层 sidecar（编辑器专用，可复编）：editor_data/document_reveals/<id>.png。"""
    try:
        root = model.editor_data_path
    except Exception:
        return None
    if root is None:
        return None
    return Path(root) / "document_reveals" / f"{_safe_stem(doc_id)}.png"


class _ScribbleCanvas(QWidget):
    """清晰底图 + 可涂抹墨迹层；所见即所得预览（底图 → 整体压暗 → 墨迹）。

    画布坐标按「等比适应」映射到图像像素；笔刷半径以**图像像素**计，缩放无关。
    """

    def __init__(self, clear: QImage, ink: QImage | None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._clear = clear
        w, h = max(1, clear.width()), max(1, clear.height())
        if ink is not None and ink.size() == clear.size():
            self._ink = ink.convertToFormat(QImage.Format.Format_ARGB32_Premultiplied)
        else:
            self._ink = QImage(w, h, QImage.Format.Format_ARGB32_Premultiplied)
            self._ink.fill(Qt.GlobalColor.transparent)
        self._brush_radius = 28.0
        self._density = 6
        self._ink_color = QColor(20, 16, 12)
        self._eraser = False
        self._baseline = 0.0  # 0..1 整体压暗
        self._last_pt: QPointF | None = None
        self.setMinimumSize(360, 360)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)

    # ---- 外部设置 ----
    def set_brush_radius(self, r: float) -> None:
        self._brush_radius = max(1.0, float(r))

    def set_density(self, d: int) -> None:
        self._density = max(1, int(d))

    def set_ink_color(self, c: QColor) -> None:
        if c.isValid():
            self._ink_color = QColor(c.red(), c.green(), c.blue())

    def set_eraser(self, on: bool) -> None:
        self._eraser = bool(on)

    def set_baseline(self, v: float) -> None:
        self._baseline = min(1.0, max(0.0, float(v)))
        self.update()

    def clear_ink(self) -> None:
        self._ink.fill(Qt.GlobalColor.transparent)
        self.update()

    def ink_image(self) -> QImage:
        return self._ink

    def baseline(self) -> float:
        return self._baseline

    def bake(self) -> QImage:
        """合成最终模糊图：清晰底 → 整体压暗 → 墨迹涂鸦，尺寸同清晰图。"""
        out = QImage(self._clear.size(), QImage.Format.Format_ARGB32)
        out.fill(Qt.GlobalColor.transparent)
        p = QPainter(out)
        p.drawImage(0, 0, self._clear)
        if self._baseline > 0:
            a = int(self._baseline * _MAX_VEIL_ALPHA)
            p.fillRect(out.rect(), QColor(15, 12, 10, a))
        p.drawImage(0, 0, self._ink)
        p.end()
        return out

    # ---- 坐标映射 ----
    def _fit_rect(self) -> QRectF:
        cw, ch = self._clear.width(), self._clear.height()
        if cw <= 0 or ch <= 0:
            return QRectF(0, 0, self.width(), self.height())
        scale = min(self.width() / cw, self.height() / ch)
        dw, dh = cw * scale, ch * scale
        return QRectF((self.width() - dw) / 2.0, (self.height() - dh) / 2.0, dw, dh)

    def _widget_to_image(self, x: float, y: float) -> QPointF | None:
        r = self._fit_rect()
        if r.width() <= 0 or r.height() <= 0 or not r.contains(x, y):
            return None
        ix = (x - r.left()) / r.width() * self._clear.width()
        iy = (y - r.top()) / r.height() * self._clear.height()
        return QPointF(ix, iy)

    # ---- 绘制 ----
    def paintEvent(self, _event) -> None:  # noqa: ANN001
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(40, 40, 44))
        r = self._fit_rect()
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        p.drawImage(r, self._clear, QRectF(self._clear.rect()))
        if self._baseline > 0:
            p.fillRect(r, QColor(15, 12, 10, int(self._baseline * _MAX_VEIL_ALPHA)))
        p.drawImage(r, self._ink, QRectF(self._ink.rect()))
        p.setPen(QPen(QColor(255, 255, 255, 90), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(r)
        p.end()

    def mousePressEvent(self, event) -> None:  # noqa: ANN001
        if event.button() != Qt.MouseButton.LeftButton:
            return
        pt = self._widget_to_image(event.position().x(), event.position().y())
        self._last_pt = pt
        if pt is not None:
            self._apply(pt, pt)
            self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: ANN001
        if not (event.buttons() & Qt.MouseButton.LeftButton):
            return
        pt = self._widget_to_image(event.position().x(), event.position().y())
        if pt is None:
            self._last_pt = None
            return
        self._apply(self._last_pt or pt, pt)
        self._last_pt = pt
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: ANN001
        self._last_pt = None

    def _apply(self, p0: QPointF, p1: QPointF) -> None:
        if self._eraser:
            self._erase(p1)
        else:
            self._scribble(p0, p1)

    def _erase(self, c: QPointF) -> None:
        p = QPainter(self._ink)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Clear)
        rad = self._brush_radius
        p.fillRect(QRectF(c.x() - rad, c.y() - rad, rad * 2, rad * 2), Qt.GlobalColor.transparent)
        p.end()

    def _scribble(self, p0: QPointF, p1: QPointF) -> None:
        """沿 p0→p1 撒一簇短墨迹（随机角度/长度/抖动），叠加成手绘乱涂质感。"""
        rad = self._brush_radius
        dx, dy = p1.x() - p0.x(), p1.y() - p0.y()
        dist = math.hypot(dx, dy)
        steps = max(1, int(dist / max(2.0, rad * 0.4)))
        p = QPainter(self._ink)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        for s in range(steps + 1):
            t = s / steps if steps else 0.0
            cx, cy = p0.x() + dx * t, p0.y() + dy * t
            for _ in range(self._density):
                ox = random.uniform(-rad, rad)
                oy = random.uniform(-rad, rad)
                if ox * ox + oy * oy > rad * rad:
                    continue
                length = random.uniform(rad * 0.35, rad * 1.0)
                ang = random.uniform(0, math.tau)
                ex = cx + ox + math.cos(ang) * length
                ey = cy + oy + math.sin(ang) * length
                # 中点加垂直抖动，让短线带点弯，更像手绘
                mx = (cx + ox + ex) / 2 + random.uniform(-rad * 0.2, rad * 0.2)
                my = (cy + oy + ey) / 2 + random.uniform(-rad * 0.2, rad * 0.2)
                col = QColor(self._ink_color)
                col.setAlpha(random.randint(45, 110))
                pen = QPen(col, max(1.0, rad * random.uniform(0.06, 0.16)))
                pen.setCapStyle(Qt.PenCapStyle.RoundCap)
                pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
                p.setPen(pen)
                path = QPainterPath(QPointF(cx + ox, cy + oy))
                path.quadTo(QPointF(mx, my), QPointF(ex, ey))
                p.drawPath(path)
        p.end()


class DocumentScribblePainterDialog(QDialog):
    """涂抹生成模糊图：左画布 + 右笔刷/整体压暗控制；确定后烘焙写盘并暴露 result_url()。"""

    def __init__(
        self,
        model: ProjectModel,
        clear_disk_path: Path,
        *,
        doc_id: str,
        existing_blur_url: str | None = None,
        external_copy_subdir: str = "illustrations",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._doc_id = doc_id
        self._existing_blur_url = (existing_blur_url or "").strip()
        self._subdir = external_copy_subdir
        self._result_url: str | None = None
        self.setWindowTitle("涂抹生成模糊图")

        clear = QImage(str(clear_disk_path))
        if clear.isNull():
            raise ValueError(f"无法加载清晰图：{clear_disk_path}")
        clear = clear.convertToFormat(QImage.Format.Format_ARGB32)
        ink = self._load_sidecar(clear.size())

        self._canvas = _ScribbleCanvas(clear, ink)

        root = QHBoxLayout(self)
        root.addWidget(self._canvas, stretch=1)

        side = QVBoxLayout()
        side.addWidget(QLabel("墨迹乱涂遮糊（盖住要遮的字/物）"))

        self._brush = self._slider(4, 200, 28, side, "笔刷大小", self._on_brush)
        self._dens = self._slider(1, 20, 6, side, "浓密度", self._on_dens)
        self._base = self._slider(0, 100, 0, side, "整体压暗", self._on_base)

        self._ink_color = HexColorPickRow("#14100c", title="墨色")
        self._ink_color.changed.connect(self._on_color)
        side.addWidget(self._ink_color)

        self._eraser = QCheckBox("橡皮擦（擦回清晰）")
        self._eraser.toggled.connect(self._canvas.set_eraser)
        side.addWidget(self._eraser)

        btn_clear = QPushButton("清空涂抹")
        btn_clear.clicked.connect(self._canvas.clear_ink)
        side.addWidget(btn_clear)
        side.addStretch(1)

        tip = QLabel("确定后烘焙同尺寸 PNG 写回 blurredImagePath；涂抹图层另存可复编。")
        tip.setWordWrap(True)
        tip.setStyleSheet("color:#888;")
        side.addWidget(tip)

        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        box.button(QDialogButtonBox.StandardButton.Ok).setText("确定生成")
        box.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        box.accepted.connect(self._on_accept)
        box.rejected.connect(self.reject)
        side.addWidget(box)

        side_w = QWidget()
        side_w.setLayout(side)
        side_w.setMaximumWidth(260)
        root.addWidget(side_w)
        self.resize(900, 680)

        self._canvas.set_ink_color(QColor("#14100c"))

    # ---- sidecar ----
    def _load_sidecar(self, size) -> QImage | None:  # noqa: ANN001
        sp = sidecar_path_for(self._model, self._doc_id)
        if sp and sp.is_file():
            im = QImage(str(sp))
            if not im.isNull() and im.size() == size:
                return im
        return None

    def _save_sidecar(self) -> None:
        sp = sidecar_path_for(self._model, self._doc_id)
        if sp is None:
            return
        try:
            sp.parent.mkdir(parents=True, exist_ok=True)
            self._canvas.ink_image().save(str(sp), "PNG")
        except OSError:
            pass  # sidecar 仅为便利，失败不阻断烘焙

    # ---- 控件 ----
    def _slider(self, lo, hi, val, layout, label, cb):  # noqa: ANN001
        row = QHBoxLayout()
        cap = QLabel(label)
        cap.setMinimumWidth(64)
        s = QSlider(Qt.Orientation.Horizontal)
        s.setRange(lo, hi)
        s.setValue(val)
        s.valueChanged.connect(cb)
        row.addWidget(cap)
        row.addWidget(s, stretch=1)
        w = QWidget()
        w.setLayout(row)
        layout.addWidget(w)
        return s

    def _on_brush(self, v: int) -> None:
        self._canvas.set_brush_radius(v)

    def _on_dens(self, v: int) -> None:
        self._canvas.set_density(v)

    def _on_base(self, v: int) -> None:
        self._canvas.set_baseline(v / 100.0)

    def _on_color(self) -> None:
        self._canvas.set_ink_color(QColor(self._ink_color.hex()))

    # ---- 烘焙写盘 ----
    def _output_disk_path(self, clear_size) -> Path | None:  # noqa: ANN001
        paths = self._model.paths
        # 已设模糊图且落在 runtime 下 → 原地覆盖（保持同一 URL）
        if self._existing_blur_url:
            disk = paths.url_to_disk(self._existing_blur_url, kind="media")
            if disk is not None and paths.is_under_runtime(disk):
                return disk
        dest_dir = paths.runtime_images_dir / self._subdir
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return None
        stem = _safe_stem(self._doc_id)
        dest = dest_dir / f"{stem}_blur.png"
        n = 1
        while dest.exists() and dest != (paths.url_to_disk(self._existing_blur_url, kind="media") if self._existing_blur_url else None):
            dest = dest_dir / f"{stem}_blur_{n}.png"
            n += 1
        return dest

    def _on_accept(self) -> None:
        out = self._canvas.bake()
        dest = self._output_disk_path(out.size())
        if dest is None:
            QMessageBox.warning(self, "涂抹生成模糊图", "无法确定输出路径")
            return
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not out.save(str(dest), "PNG"):
                raise OSError("QImage.save 返回 False")
        except OSError as e:
            QMessageBox.warning(self, "涂抹生成模糊图", f"写入失败：\n{e}")
            return
        url = self._model.paths.disk_to_runtime_url(dest)
        if not url:
            QMessageBox.warning(self, "涂抹生成模糊图", "无法生成 runtime URL")
            return
        self._save_sidecar()
        self._result_url = url
        self.accept()

    def result_url(self) -> str | None:
        return self._result_url
