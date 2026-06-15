"""多边形地面标定（试验功能，独立窗口）。

工作流：在背景图上画一个**地面多边形** → 多边形内自动拟合**完整地面深度**：
可见地面照抄 AI 深度、被遮挡处(自动识别的"突起"连通区)用地面趋势补全 → 可视化。

仅测试/可视化：不写场景、不写导出、不碰运行时、不碰原有任何数据。
"""

from __future__ import annotations

import numpy as np
from PIL import Image
from PySide6.QtCore import Qt, QPoint
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QRadioButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from .reconstruction import fit_floor_depth_in_polygon, polygon_mask


def _pil_to_qpix(img: Image.Image) -> QPixmap:
    rgba = img.convert("RGBA")
    qim = QImage(rgba.tobytes("raw", "RGBA"), rgba.width, rgba.height,
                 QImage.Format.Format_RGBA8888)
    return QPixmap.fromImage(qim.copy())


class _Canvas(QWidget):
    """显示背景图 + 画多边形(左键加点、右键闭合) + 叠加结果。"""

    def __init__(self, pil_img: Image.Image) -> None:
        super().__init__()
        self._img = pil_img.convert("RGB")
        self._iw, self._ih = self._img.size
        self._base = _pil_to_qpix(self._img)
        self._overlay: QPixmap | None = None
        self.points: list[tuple[float, float]] = []
        self.finished = False
        self.setMinimumSize(640, 420)
        self.setMouseTracking(True)

    def reset_polygon(self) -> None:
        self.points = []
        self.finished = False
        self._overlay = None
        self.update()

    def set_overlay(self, pil_overlay: Image.Image | None) -> None:
        self._overlay = _pil_to_qpix(pil_overlay) if pil_overlay is not None else None
        self.update()

    def _fit(self) -> tuple[float, float, float]:
        s = min(self.width() / self._iw, self.height() / self._ih)
        ox = (self.width() - self._iw * s) / 2.0
        oy = (self.height() - self._ih * s) / 2.0
        return s, ox, oy

    def _to_img(self, p: QPoint) -> tuple[float, float]:
        s, ox, oy = self._fit()
        return ((p.x() - ox) / s, (p.y() - oy) / s)

    def mousePressEvent(self, e) -> None:  # noqa: N802
        if e.button() == Qt.MouseButton.LeftButton and not self.finished:
            x, y = self._to_img(e.position().toPoint())
            if 0 <= x < self._iw and 0 <= y < self._ih:
                self.points.append((x, y))
                self.update()
        elif e.button() == Qt.MouseButton.RightButton:
            if len(self.points) >= 3:
                self.finished = True
                self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        s, ox, oy = self._fit()
        qp = QPainter(self)
        tw, th = int(self._iw * s), int(self._ih * s)
        qp.drawPixmap(int(ox), int(oy), tw, th, self._base)
        if self._overlay is not None:
            qp.setOpacity(0.55)
            qp.drawPixmap(int(ox), int(oy), tw, th, self._overlay)
            qp.setOpacity(1.0)
        if self.points:
            qp.setPen(QPen(QColor(60, 200, 255), 2))
            pts = [QPoint(int(ox + x * s), int(oy + y * s)) for x, y in self.points]
            for i in range(len(pts) - 1):
                qp.drawLine(pts[i], pts[i + 1])
            if self.finished and len(pts) >= 3:
                qp.drawLine(pts[-1], pts[0])
            for pt in pts:
                qp.drawEllipse(pt, 4, 4)


class GroundCalibDialog(QDialog):
    """多边形地面标定试验对话框。"""

    def __init__(self, pil_img: Image.Image, calibrated_depth, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("多边形地面标定 — 试验（仅可视化，不改任何数据）")
        self.resize(1100, 760)

        self._depth = np.asarray(calibrated_depth, dtype=np.float64)
        dspan = float(self._depth.max() - self._depth.min()) or 1.0
        self._thr_max = max(0.05, 0.5 * dspan)
        self._F = None
        self._occ = None
        self._floor = None

        self.canvas = _Canvas(pil_img)

        root = QVBoxLayout(self)
        root.addWidget(self.canvas, 1)

        hint = QLabel("左键点击加多边形顶点，右键闭合；再点「计算」。"
                      "拖阈值即时重算。红=识别出的遮挡(突起)。")
        hint.setStyleSheet("color:#888;")
        root.addWidget(hint)

        row = QHBoxLayout()
        root.addLayout(row)

        row.addWidget(QLabel("阈值"))
        self.thr = QSlider(Qt.Orientation.Horizontal)
        self.thr.setRange(2, 100)
        self.thr.setValue(18)
        self.thr.valueChanged.connect(self._on_thr)
        row.addWidget(self.thr, 1)
        self.thr_lbl = QLabel("")
        row.addWidget(self.thr_lbl)

        self.rb_occ = QRadioButton("遮挡")
        self.rb_F = QRadioButton("完整地面深度")
        self.rb_occ.setChecked(True)
        self.rb_occ.toggled.connect(self._show)
        row.addWidget(self.rb_occ)
        row.addWidget(self.rb_F)

        btn_reset = QPushButton("重设多边形")
        btn_reset.clicked.connect(self._reset)
        row.addWidget(btn_reset)
        btn_calc = QPushButton("计算")
        btn_calc.clicked.connect(self._compute)
        row.addWidget(btn_calc)

        self.status = QLabel("画地面多边形…")
        self.status.setStyleSheet("color:#888;")
        root.addWidget(self.status)
        self._update_thr_lbl()

    def _threshold(self) -> float:
        return self.thr.value() / 100.0 * self._thr_max

    def _update_thr_lbl(self) -> None:
        self.thr_lbl.setText(f"{self._threshold():.3f}")

    def _on_thr(self) -> None:
        self._update_thr_lbl()
        if self.canvas.finished:
            self._compute()

    def _reset(self) -> None:
        self.canvas.reset_polygon()
        self._F = self._occ = self._floor = None
        self.status.setText("画地面多边形…")

    def _compute(self) -> None:
        if not self.canvas.finished or len(self.canvas.points) < 3:
            self.status.setText("先画好多边形并右键闭合。")
            return
        H, W = self._depth.shape
        mask = polygon_mask(self.canvas.points, H, W)
        if int(mask.sum()) < 16:
            self.status.setText("多边形太小。")
            return
        F, occ, floor = fit_floor_depth_in_polygon(self._depth, mask, self._threshold())
        self._F, self._occ, self._floor, self._mask = F, occ, floor, mask
        occ_pct = float(occ.sum()) / max(int(mask.sum()), 1) * 100.0
        self.status.setText(
            f"完成：遮挡占地面 {occ_pct:.0f}%（阈值 {self._threshold():.3f}）。"
            "可见地面=AI深度、遮挡处=补全。切换查看；很大/局部占多数的遮挡需手动兜底。")
        self._show()

    def _show(self) -> None:
        if self._occ is None:
            return
        H, W = self._depth.shape
        if self.rb_occ.isChecked():
            ov = np.zeros((H, W, 4), np.uint8)
            ov[self._occ, 0] = 235
            ov[self._occ, 3] = 200
            edge = self._mask & ~self._occ
            ov[edge, 1] = 200
            ov[edge, 3] = 60  # 可见地面淡绿
            self.canvas.set_overlay(Image.fromarray(ov, "RGBA"))
        else:
            f = self._F.copy()
            fm = self._mask
            lo, hi = float(f[fm].min()), float(f[fm].max())
            g = np.clip((f - lo) / max(hi - lo, 1e-6), 0, 1)
            ov = np.zeros((H, W, 4), np.uint8)
            ov[..., 0] = (g * 255).astype(np.uint8)
            ov[..., 1] = (g * 255).astype(np.uint8)
            ov[..., 2] = (g * 255).astype(np.uint8)
            ov[fm, 3] = 230
            self.canvas.set_overlay(Image.fromarray(ov, "RGBA"))
