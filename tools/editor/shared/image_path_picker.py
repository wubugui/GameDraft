"""图片资源路径选择 + 预览：统一映射到 ``/resources/runtime/...``。

迁移后媒体只允许落在 ``public/resources/runtime`` 下，所有解析与文件对话框默认目录
都通过 :class:`tools.editor.shared.project_paths.ProjectPaths` 获取。
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from PySide6.QtCore import Qt, Signal
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
from .project_paths import (
    DIR_KIND_RUNTIME_IMAGES,
    URL_KIND_MEDIA,
)

_IMAGE_FILTER = "Images (*.png *.jpg *.jpeg *.webp *.bmp *.gif);;All (*.*)"

# 缩略预览边长上限（勿用 label.width() 等会随 pixmap 变化的量作为 scaled 目标）
_CUTSCENE_PREVIEW_BOX = 100

_SAFE_IMAGES_SUBDIR = re.compile(r"^[a-zA-Z0-9_-]+$")


def sanitize_images_subdir(name: str) -> str:
    """``public/resources/runtime/images/<subdir>/`` 下仅允许单层安全目录名。"""
    s = (name or "cutscene").strip()
    if not _SAFE_IMAGES_SUBDIR.match(s):
        return "cutscene"
    return s


def disk_path_for_runtime_url(model: ProjectModel | None, url: str) -> Path | None:
    """把媒体 URL（``/resources/runtime/...``、短名等）解析为本地存在的文件路径。

    迁移后媒体不再允许落在 ``/assets/...``。本机绝对路径若已存在也接受。
    所有解析委托给 :class:`ProjectPaths`，并以 ``is_file()`` 把关。
    """
    if not model or not model.project_path or not url:
        return None
    p = model.paths.url_to_disk(url, kind=URL_KIND_MEDIA)
    if p is None:
        return None
    try:
        resolved = p.resolve()
    except OSError:
        return None
    return resolved if resolved.is_file() else None


def import_or_resolve_image_path(
    model: ProjectModel,
    source: Path,
    *,
    external_copy_subdir: str = "cutscene",
) -> str | None:
    """选中的源文件 → 工程内媒体 URL：

    * 已在 runtime 树下：直接生成 ``/resources/runtime/...`` URL。
    * 误选 ``public/assets`` 下的文件：弹窗拒绝（媒体不允许落 assets）。
    * 工程外文件：复制到 ``public/resources/runtime/images/<subdir>/`` 再生成 URL。
    """
    paths = model.paths
    try:
        source = source.resolve()
    except OSError:
        QMessageBox.warning(None, "Image import", f"无法解析路径:\n{source}")
        return None

    if paths.is_under_runtime(source):
        return paths.disk_to_runtime_url(source)

    if paths.is_under_assets(source):
        QMessageBox.warning(
            None,
            "Image import",
            "迁移后 public/assets 不再承载媒体，请放到 public/resources/runtime 下，"
            "或选择「Browse」让我自动复制。",
        )
        return None

    sub = sanitize_images_subdir(external_copy_subdir)
    dest_dir = paths.runtime_images_dir / sub
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
    return paths.disk_to_runtime_url(dest)


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

    changed = Signal()

    def __init__(
        self,
        model: ProjectModel | None,
        initial: str,
        parent: QWidget | None = None,
        *,
        external_copy_subdir: str = "cutscene",
        external_copy_hint: str | None = None,
        path_edit_read_only: bool = False,
    ):
        super().__init__(parent)
        self._model = model
        self._external_copy_subdir = sanitize_images_subdir(external_copy_subdir)

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
        self._edit.setReadOnly(path_edit_read_only)
        self._edit.setPlaceholderText(
            "/resources/runtime/... 或点 Browse 从任意位置选择（自动复制到 runtime）",
        )
        self._edit.textChanged.connect(lambda *_: self.changed.emit())
        btn = QPushButton("Browse…")
        btn.setToolTip("打开文件对话框（任意文件夹），选中后预览并写入游戏内路径")
        btn.clicked.connect(self._on_browse)
        row.addWidget(self._edit, stretch=1)
        row.addWidget(btn)
        right.addLayout(row)
        hint_text = external_copy_hint or (
            f"项目外文件会复制到 resources/runtime/images/{self._external_copy_subdir}/"
        )
        hint = QLabel(hint_text)
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
                start = str(
                    self._model.paths.default_dir_existing_or_root(DIR_KIND_RUNTIME_IMAGES),
                )
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
            url = import_or_resolve_image_path(
                self._model, src, external_copy_subdir=self._external_copy_subdir,
            )
            if url:
                self._edit.setText(url)
                _set_preview_label(self._preview, src)
                self.changed.emit()
        else:
            self._edit.setText(str(src))
            _set_preview_label(self._preview, src)
            self.changed.emit()

    def _refresh_preview_from_text(self) -> None:
        t = self._edit.text().strip()
        p = disk_path_for_runtime_url(self._model, t) if self._model else None
        if p is None and t:
            cand = Path(t)
            if cand.is_file():
                p = cand
        _set_preview_label(self._preview, p)

    def set_path(self, path: str) -> None:
        self._edit.blockSignals(True)
        self._edit.setText(path)
        self._edit.blockSignals(False)
        self._refresh_preview_from_text()

    def path(self) -> str:
        return self._edit.text().strip()
