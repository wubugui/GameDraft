"""Standalone non-destructive image resizing and mirroring tool."""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import Qt, QSize, QSignalBlocker, Signal, QEvent, QMimeData
from PySide6.QtGui import QImage, QImageReader, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QStyle,
    QVBoxLayout,
    QWidget,
)

from tools.editor.shared.qt_combo_wheel_guard import install_global_combo_wheel_block


IMAGE_FILTER = "Images (*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff)"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def aspect_size(original_w: int, original_h: int, *, width: int | None = None, height: int | None = None) -> tuple[int, int]:
    if original_w <= 0 or original_h <= 0:
        return 1, 1
    if width is not None and width > 0:
        return max(1, int(width)), max(1, round(int(width) * original_h / original_w))
    if height is not None and height > 0:
        return max(1, round(int(height) * original_w / original_h)), max(1, int(height))
    return original_w, original_h


def image_path_from_mime(mime: QMimeData) -> Path | None:
    for url in mime.urls():
        if not url.isLocalFile():
            continue
        path = Path(url.toLocalFile())
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES:
            return path
    return None


class PreviewLabel(QLabel):
    def __init__(self) -> None:
        super().__init__()
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(240, 180)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        self.setStyleSheet("background:#191919;color:#888;border:1px solid #333;")

    def sizeHint(self) -> QSize:  # noqa: N802
        return QSize(720, 480)


class PreviewScrollArea(QScrollArea):
    zoom_requested = Signal(int)

    def __init__(self) -> None:
        super().__init__()
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setWidgetResizable(False)
        self.setStyleSheet("QScrollArea{background:#111;border:0;}")

    def wheelEvent(self, event) -> None:  # type: ignore[override]
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            delta = event.angleDelta().y()
            if delta:
                self.zoom_requested.emit(1 if delta > 0 else -1)
                event.accept()
                return
        super().wheelEvent(event)


class ImageResizerWindow(QMainWindow):
    def __init__(self, image_path: Path | None = None) -> None:
        super().__init__()
        self.setWindowTitle("图片缩放与对称")
        self.resize(1080, 720)

        self._source_path: Path | None = None
        self._source_image = QImage()
        self._preview_image = QImage()
        self._preview_zoom = 1.0
        self._fit_preview = True
        self._updating_controls = False
        self._updating_zoom = False

        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        controls = QWidget()
        controls.setMaximumWidth(360)
        controls.setMinimumWidth(300)
        controls_layout = QVBoxLayout(controls)

        open_row = QHBoxLayout()
        self._path_edit = QLineEdit()
        self._path_edit.setReadOnly(True)
        self._path_edit.setPlaceholderText("未选择图片")
        btn_open = QPushButton("打开")
        btn_open.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_DialogOpenButton))
        btn_open.clicked.connect(self._choose_image)
        open_row.addWidget(self._path_edit, 1)
        open_row.addWidget(btn_open)
        controls_layout.addLayout(open_row)

        self._info = QLabel("-")
        self._info.setWordWrap(True)
        self._info.setStyleSheet("color:#8d98a8;")
        controls_layout.addWidget(self._info)

        form = QFormLayout()
        self._percent = QSpinBox()
        self._percent.setRange(1, 1000)
        self._percent.setSuffix("%")
        self._percent.setValue(100)
        self._percent.valueChanged.connect(self._on_percent_changed)
        form.addRow("比例", self._percent)

        self._width = QSpinBox()
        self._width.setRange(1, 100000)
        self._width.valueChanged.connect(self._on_width_changed)
        form.addRow("宽", self._width)

        self._height = QSpinBox()
        self._height.setRange(1, 100000)
        self._height.valueChanged.connect(self._on_height_changed)
        form.addRow("高", self._height)
        controls_layout.addLayout(form)

        self._mirror_h = QCheckBox("水平对称")
        self._mirror_h.toggled.connect(self._refresh_preview)
        self._mirror_v = QCheckBox("垂直对称")
        self._mirror_v.toggled.connect(self._refresh_preview)
        controls_layout.addWidget(self._mirror_h)
        controls_layout.addWidget(self._mirror_v)

        self._target_info = QLabel("-")
        self._target_info.setWordWrap(True)
        self._target_info.setStyleSheet("color:#8d98a8;")
        controls_layout.addWidget(self._target_info)

        zoom_form = QFormLayout()
        zoom_row = QHBoxLayout()
        btn_zoom_out = QPushButton("-")
        btn_zoom_out.clicked.connect(lambda: self._zoom_by_steps(-1))
        btn_zoom_out.setToolTip("缩小预览视口")
        self._zoom_percent = QSpinBox()
        self._zoom_percent.setRange(1, 800)
        self._zoom_percent.setSuffix("%")
        self._zoom_percent.setValue(100)
        self._zoom_percent.valueChanged.connect(self._on_zoom_percent_changed)
        btn_zoom_in = QPushButton("+")
        btn_zoom_in.clicked.connect(lambda: self._zoom_by_steps(1))
        btn_zoom_in.setToolTip("放大预览视口")
        zoom_row.addWidget(btn_zoom_out)
        zoom_row.addWidget(self._zoom_percent, 1)
        zoom_row.addWidget(btn_zoom_in)
        zoom_form.addRow("视口", zoom_row)

        zoom_action_row = QHBoxLayout()
        btn_zoom_100 = QPushButton("1:1")
        btn_zoom_100.clicked.connect(self._set_actual_size_zoom)
        btn_zoom_100.setToolTip("按输出图片实际像素查看")
        btn_zoom_fit = QPushButton("适应")
        btn_zoom_fit.clicked.connect(self._fit_preview_to_view)
        btn_zoom_fit.setToolTip("让输出图片完整适应预览区")
        zoom_action_row.addWidget(btn_zoom_100)
        zoom_action_row.addWidget(btn_zoom_fit)
        zoom_form.addRow("", zoom_action_row)
        controls_layout.addLayout(zoom_form)

        btn_export = QPushButton("导出")
        btn_export.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_DialogSaveButton))
        btn_export.clicked.connect(self._export_image)
        controls_layout.addWidget(btn_export)
        controls_layout.addStretch(1)

        self._preview = PreviewLabel()
        self._scroll = PreviewScrollArea()
        self._scroll.setWidget(self._preview)
        self._scroll.zoom_requested.connect(self._zoom_by_steps)

        root.addWidget(controls, 0)
        root.addWidget(self._scroll, 1)

        self._install_drop_target(self)
        self._install_drop_target(central)
        self._install_drop_target(controls)
        self._install_drop_target(self._scroll)
        self._install_drop_target(self._scroll.viewport())
        self._install_drop_target(self._preview)

        self._set_controls_enabled(False)
        if image_path is not None:
            self.load_image(image_path)
        else:
            self._refresh_preview()

    def _install_drop_target(self, widget: QWidget) -> None:
        widget.setAcceptDrops(True)
        widget.installEventFilter(self)

    def eventFilter(self, watched, event) -> bool:  # type: ignore[override]
        event_type = event.type()
        if event_type in (QEvent.Type.DragEnter, QEvent.Type.DragMove):
            path = image_path_from_mime(event.mimeData())
            if path is not None:
                event.acceptProposedAction()
                return True
        elif event_type == QEvent.Type.Drop:
            path = image_path_from_mime(event.mimeData())
            if path is not None:
                self.load_image(path)
                event.acceptProposedAction()
                return True
        return super().eventFilter(watched, event)

    def _set_controls_enabled(self, enabled: bool) -> None:
        for w in (
            self._percent,
            self._width,
            self._height,
            self._mirror_h,
            self._mirror_v,
            self._zoom_percent,
        ):
            w.setEnabled(enabled)

    def _choose_image(self) -> None:
        start = str(self._source_path.parent if self._source_path else Path.cwd())
        path, _ = QFileDialog.getOpenFileName(self, "打开图片", start, IMAGE_FILTER)
        if path:
            self.load_image(Path(path))

    def load_image(self, path: Path) -> None:
        path = path.resolve()
        reader = QImageReader(str(path))
        reader.setAutoTransform(True)
        image = reader.read()
        if image.isNull():
            QMessageBox.warning(self, "图片缩放", f"无法读取图片:\n{path}\n\n{reader.errorString()}")
            return
        self._source_path = path
        self._source_image = image
        self._path_edit.setText(str(path))
        self._info.setText(f"原图: {image.width()} x {image.height()}  {path.suffix.lower().lstrip('.') or 'image'}")
        self._set_controls_enabled(True)
        self._reset_controls_to_source()
        self._fit_preview = True
        self._refresh_preview()

    def _reset_controls_to_source(self) -> None:
        if self._source_image.isNull():
            return
        self._updating_controls = True
        try:
            with QSignalBlocker(self._percent), QSignalBlocker(self._width), QSignalBlocker(self._height):
                self._percent.setValue(100)
                self._width.setValue(self._source_image.width())
                self._height.setValue(self._source_image.height())
        finally:
            self._updating_controls = False

    def _on_percent_changed(self, value: int) -> None:
        if self._updating_controls or self._source_image.isNull():
            return
        w = max(1, round(self._source_image.width() * value / 100))
        h = max(1, round(self._source_image.height() * value / 100))
        self._sync_size_controls(w, h)
        self._refresh_preview()

    def _on_width_changed(self, value: int) -> None:
        if self._updating_controls or self._source_image.isNull():
            return
        w, h = aspect_size(self._source_image.width(), self._source_image.height(), width=value)
        self._sync_size_controls(w, h, update_percent=True)
        self._refresh_preview()

    def _on_height_changed(self, value: int) -> None:
        if self._updating_controls or self._source_image.isNull():
            return
        w, h = aspect_size(self._source_image.width(), self._source_image.height(), height=value)
        self._sync_size_controls(w, h, update_percent=True)
        self._refresh_preview()

    def _sync_size_controls(self, width: int, height: int, *, update_percent: bool = False) -> None:
        self._updating_controls = True
        try:
            with QSignalBlocker(self._width), QSignalBlocker(self._height), QSignalBlocker(self._percent):
                self._width.setValue(width)
                self._height.setValue(height)
                if update_percent and self._source_image.width() > 0:
                    self._percent.setValue(max(1, round(width * 100 / self._source_image.width())))
        finally:
            self._updating_controls = False

    def _target_size(self) -> tuple[int, int]:
        if self._source_image.isNull():
            return 1, 1
        return max(1, int(self._width.value())), max(1, int(self._height.value()))

    def _transformed_image(self) -> QImage:
        width, height = self._target_size()
        image = self._source_image.mirrored(self._mirror_h.isChecked(), self._mirror_v.isChecked())
        return image.scaled(width, height, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)

    def _refresh_preview(self) -> None:
        if self._source_image.isNull():
            self._preview.clear()
            self._preview.setText("拖入图片或点击打开")
            self._preview.setFixedSize(480, 320)
            self._target_info.setText("-")
            return
        self._preview_image = self._transformed_image()
        if self._fit_preview:
            self._set_preview_zoom(self._fit_zoom_for_current_image(), fit=True, render=False)
        self._render_preview()
        self._update_target_info()

    def _update_target_info(self) -> None:
        if self._preview_image.isNull():
            self._target_info.setText("-")
            return
        ops = []
        if self._mirror_h.isChecked():
            ops.append("水平对称")
        if self._mirror_v.isChecked():
            ops.append("垂直对称")
        op_text = " + ".join(ops) if ops else "无对称"
        self._target_info.setText(
            f"输出: {self._preview_image.width()} x {self._preview_image.height()}  "
            f"{op_text}  视口: {round(self._preview_zoom * 100)}%"
        )

    def _render_preview(self) -> None:
        if self._preview_image.isNull():
            return
        width = max(1, round(self._preview_image.width() * self._preview_zoom))
        height = max(1, round(self._preview_image.height() * self._preview_zoom))
        pixmap = QPixmap.fromImage(self._preview_image)
        if width != pixmap.width() or height != pixmap.height():
            mode = (
                Qt.TransformationMode.FastTransformation
                if self._preview_zoom >= 1.0
                else Qt.TransformationMode.SmoothTransformation
            )
            pixmap = pixmap.scaled(
                width,
                height,
                Qt.AspectRatioMode.IgnoreAspectRatio,
                mode,
            )
        self._preview.setText("")
        self._preview.setPixmap(pixmap)
        self._preview.setFixedSize(pixmap.size())

    def _fit_zoom_for_current_image(self) -> float:
        if self._preview_image.isNull():
            return 1.0
        viewport = self._scroll.viewport().size()
        available_w = max(1, viewport.width() - 24)
        available_h = max(1, viewport.height() - 24)
        zoom = min(
            available_w / max(1, self._preview_image.width()),
            available_h / max(1, self._preview_image.height()),
        )
        return min(1.0, max(0.01, zoom))

    def _set_preview_zoom(self, zoom: float, *, fit: bool = False, render: bool = True) -> None:
        self._preview_zoom = min(8.0, max(0.01, zoom))
        self._fit_preview = fit
        self._updating_zoom = True
        try:
            with QSignalBlocker(self._zoom_percent):
                self._zoom_percent.setValue(round(self._preview_zoom * 100))
        finally:
            self._updating_zoom = False
        if render:
            self._render_preview()
            self._update_target_info()

    def _on_zoom_percent_changed(self, value: int) -> None:
        if self._updating_zoom or self._preview_image.isNull():
            return
        self._set_preview_zoom(value / 100, fit=False)

    def _zoom_by_steps(self, steps: int) -> None:
        if self._preview_image.isNull():
            return
        factor = 1.25 ** steps
        self._set_preview_zoom(self._preview_zoom * factor, fit=False)

    def _set_actual_size_zoom(self) -> None:
        self._set_preview_zoom(1.0, fit=False)

    def _fit_preview_to_view(self) -> None:
        if self._preview_image.isNull():
            return
        self._set_preview_zoom(self._fit_zoom_for_current_image(), fit=True)

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        super().resizeEvent(event)
        if self._fit_preview and not self._preview_image.isNull():
            self._set_preview_zoom(self._fit_zoom_for_current_image(), fit=True)

    def _export_image(self) -> None:
        if self._source_path is None or self._source_image.isNull():
            QMessageBox.information(self, "图片缩放", "请先打开图片。")
            return
        suffix = "_scaled"
        if self._mirror_h.isChecked() or self._mirror_v.isChecked():
            suffix += "_mirrored"
        default = self._source_path.with_name(f"{self._source_path.stem}{suffix}{self._source_path.suffix}")
        path, _ = QFileDialog.getSaveFileName(
            self,
            "导出图片",
            str(default),
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;WebP (*.webp);;BMP (*.bmp)",
        )
        if not path:
            return
        out_path = Path(path).resolve()
        if out_path == self._source_path:
            QMessageBox.warning(self, "图片缩放", "不能覆盖原始图片，请选择新的输出文件。")
            return
        out = self._transformed_image()
        if out_path.suffix.lower() in {".jpg", ".jpeg"}:
            out = out.convertToFormat(QImage.Format.Format_RGB888)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if not out.save(str(out_path)):
            QMessageBox.warning(self, "图片缩放", f"导出失败:\n{out_path}")
            return
        self.statusBar().showMessage(f"已导出: {out_path}", 5000)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    image_path = Path(args[0]) if args else None
    app = QApplication(sys.argv[:1] + args)
    install_global_combo_wheel_block(app)
    app.setApplicationName("GameDraft Image Resizer")
    w = ImageResizerWindow(image_path)
    w.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
