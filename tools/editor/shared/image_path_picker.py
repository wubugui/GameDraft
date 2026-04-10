"""Pick image from anywhere with preview; map to /assets/... for runtime."""
from __future__ import annotations

import shutil
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel

_IMAGE_FILTER = "Images (*.png *.jpg *.jpeg *.webp *.bmp *.gif);;All (*.*)"

# 缩略预览边长上限（勿用 label.width() 等会随 pixmap 变化的量作为 scaled 目标）
_CUTSCENE_PREVIEW_BOX = 100


def disk_path_for_runtime_url(model: ProjectModel | None, url: str) -> Path | None:
    """Resolve /assets/... URL to file under public/assets/."""
    if not model or not model.project_path or not url:
        return None
    u = url.strip()
    if not u.startswith("/assets/"):
        return None
    rel = u[len("/assets/") :].lstrip("/")
    if not rel or ".." in rel:
        return None
    p = model.assets_path / rel
    return p if p.is_file() else None


def import_or_resolve_image_path(model: ProjectModel, source: Path) -> str | None:
    """
    If source is under project public/, return /assets/... URL.
    Otherwise copy into public/assets/images/cutscene/ and return new URL.
    """
    source = source.resolve()
    public = model.project_path.resolve() / "public"
    try:
        rel = source.relative_to(public)
        return "/" + rel.as_posix()
    except ValueError:
        pass

    dest_dir = model.assets_path / "images" / "cutscene"
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        QMessageBox.warning(
            None,
            "Image import",
            f"无法创建目录:\n{dest_dir}\n{e}",
        )
        return None

    dest = dest_dir / source.name
    n = 1
    while dest.exists():
        dest = dest_dir / f"{source.stem}_{n}{source.suffix}"
        n += 1
    try:
        shutil.copy2(source, dest)
    except OSError as e:
        QMessageBox.warning(
            None,
            "Image import",
            f"无法复制文件:\n{e}",
        )
        return None
    rel = dest.relative_to(model.assets_path)
    return "/assets/" + rel.as_posix()


def _set_preview_label(label: QLabel, path: Path | None) -> None:
    label.clear()
    if path is None or not path.is_file():
        label.setText("(无预览)")
        return
    pm = QPixmap(str(path))
    if pm.isNull():
        label.setText("(无法加载)")
        return
    cap = min(
        _CUTSCENE_PREVIEW_BOX,
        max(16, label.maximumWidth()),
        max(16, label.maximumHeight()),
    )
    label.setPixmap(
        pm.scaled(
            cap,
            cap,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
    )


class CutsceneImagePathRow(QWidget):
    """Line edit + Browse + thumbnail preview for show_img.image."""

    def __init__(self, model: ProjectModel | None, initial: str, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        self._preview = QLabel()
        self._preview.setFixedSize(100, 100)
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview.setStyleSheet("border: 1px solid #555; color: #888;")
        self._preview.setMaximumWidth(100)
        self._preview.setMaximumHeight(100)

        right = QVBoxLayout()
        row = QHBoxLayout()
        self._edit = QLineEdit(initial)
        self._edit.setPlaceholderText("/assets/... 或点 Browse 从任意位置选择")
        btn = QPushButton("Browse…")
        btn.setToolTip("打开文件对话框（任意文件夹），选中后预览并写入游戏内路径")
        btn.clicked.connect(self._on_browse)
        row.addWidget(self._edit, stretch=1)
        row.addWidget(btn)
        right.addLayout(row)
        hint = QLabel("项目外文件会复制到 assets/images/cutscene/")
        hint.setStyleSheet("color:#888;font-size:11px;")
        right.addWidget(hint)

        root.addWidget(self._preview)
        root.addLayout(right, stretch=1)

        self._refresh_preview_from_text()

    def _on_browse(self) -> None:
        start = str(Path.home())
        if self._model and self._model.project_path:
            p = disk_path_for_runtime_url(self._model, self._edit.text().strip())
            if p:
                start = str(p.parent)
            else:
                d = self._model.assets_path / "images"
                if d.is_dir():
                    start = str(d)
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择图片",
            start,
            _IMAGE_FILTER,
        )
        if not path:
            return
        src = Path(path)
        if self._model and self._model.project_path:
            url = import_or_resolve_image_path(self._model, src)
            if url:
                self._edit.setText(url)
                _set_preview_label(self._preview, src)
        else:
            self._edit.setText(str(src))
            _set_preview_label(self._preview, src)

    def _refresh_preview_from_text(self) -> None:
        t = self._edit.text().strip()
        p = disk_path_for_runtime_url(self._model, t) if self._model else None
        if p is None and t:
            cand = Path(t)
            if cand.is_file():
                p = cand
        _set_preview_label(self._preview, p)

    def set_path(self, path: str) -> None:
        self._edit.setText(path)
        self._refresh_preview_from_text()

    def path(self) -> str:
        return self._edit.text().strip()
