"""对话叠图短 id：overlay_images.json，供 showOverlayImage / blendOverlayImage 等动作的 image 参数使用。"""
from __future__ import annotations

from typing import Callable

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QScrollArea,
    QLineEdit,
    QPushButton,
    QLabel,
    QMessageBox,
)

from ..project_model import ProjectModel
from ..shared.image_path_picker import CutsceneImagePathRow


def _rows_to_dict(rows: list[tuple[str, str]]) -> tuple[dict[str, str] | None, str | None]:
    """从表格行生成 dict；若短 id 重复或为空则返回 (None, 错误说明)。
    短 id 与路径均为空的行会被忽略（未填完的占位行）。"""
    seen: set[str] = set()
    out: dict[str, str] = {}
    logical_i = 0
    for kid, pth in rows:
        k = (kid or "").strip()
        pt = (pth or "").strip()
        if not k and not pt:
            continue
        logical_i += 1
        if not k:
            return None, f"第 {logical_i} 行（非空行）：短 id 不能为空"
        if k in seen:
            return None, f"短 id 重复：「{k}」（每一行的短 id 必须唯一）"
        seen.add(k)
        out[k] = pt
    return out, None


class _OneRow(QWidget):
    """单行：短 id + 图片路径 + 删除。"""

    def __init__(
        self,
        model: ProjectModel,
        short_id: str,
        path: str,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 4, 0, 4)
        lay.addWidget(QLabel("短 id"))
        self._id_edit = QLineEdit(short_id)
        self._id_edit.setPlaceholderText("如：码头告示")
        self._id_edit.setMinimumWidth(160)
        lay.addWidget(self._id_edit)
        lay.addWidget(QLabel("图片"), alignment=Qt.AlignmentFlag.AlignRight)
        self._path_row = CutsceneImagePathRow(
            model,
            path,
            external_copy_subdir="illustrations",
            external_copy_hint="项目外图片会复制到 assets/images/illustrations/",
        )
        lay.addWidget(self._path_row, stretch=1)
        self._del = QPushButton("删除")
        self._del.setFixedWidth(56)
        lay.addWidget(self._del)
        self._delete_handler: Callable[[], None] | None = None
        self._del.clicked.connect(self._on_delete_clicked)

    def _on_delete_clicked(self) -> None:
        if self._delete_handler is not None:
            self._delete_handler()

    def id_text(self) -> str:
        return self._id_edit.text()

    def path_text(self) -> str:
        return self._path_row.path()

    def set_delete_handler(self, fn: Callable[[], None]) -> None:
        self._delete_handler = fn


class OverlayImagesEditor(QWidget):
    """维护 public/assets/data/overlay_images.json。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model

        root = QVBoxLayout(self)
        hint = QLabel(
            "此处登记「短 id → /assets/... 路径」。"
            "图对话 <code>runActions</code> 里 <code>showOverlayImage</code> 的 <code>image</code> 可填短 id；"
            "第二段为短 id 时由运行时解析；若以 <code>/</code> 开头则当作完整路径。",
        )
        hint.setWordWrap(True)
        hint.setTextFormat(Qt.TextFormat.RichText)
        hint.setOpenExternalLinks(False)
        root.addWidget(hint)

        self._status = QLabel("")
        self._status.setStyleSheet("color:#c44;")
        self._status.setWordWrap(True)
        root.addWidget(self._status)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._rows_host = QWidget()
        self._rows_layout = QVBoxLayout(self._rows_host)
        self._rows_layout.addStretch()
        scroll.setWidget(self._rows_host)
        root.addWidget(scroll, stretch=1)

        btn_row = QHBoxLayout()
        add_btn = QPushButton("添加一行")
        add_btn.clicked.connect(self._add_empty_row)
        apply_btn = QPushButton("Apply（写入内存并标脏）")
        apply_btn.setToolTip("写入 ProjectModel.overlay_images；保存工程时写入 overlay_images.json")
        apply_btn.clicked.connect(self._apply)
        btn_row.addWidget(add_btn)
        btn_row.addWidget(apply_btn)
        btn_row.addStretch()
        root.addLayout(btn_row)

        self._row_widgets: list[_OneRow] = []
        self._reload_from_model()

    def _clear_rows(self) -> None:
        for w in list(self._row_widgets):
            self._rows_layout.removeWidget(w)
            w.setParent(None)
            w.deleteLater()
        self._row_widgets.clear()

    def _reload_from_model(self) -> None:
        self._clear_rows()
        ov = getattr(self._model, "overlay_images", None) or {}
        if not isinstance(ov, dict):
            ov = {}
        # 稳定顺序：按 id 排序
        for k in sorted(ov.keys(), key=lambda x: str(x)):
            v = ov.get(k)
            self._append_row(str(k), str(v) if v is not None else "")
        self._check_duplicate_hint()

    def _append_row(self, short_id: str, path: str) -> None:
        row = _OneRow(self._model, short_id, path)
        insert_at = self._rows_layout.count() - 1
        self._rows_layout.insertWidget(insert_at, row)
        self._row_widgets.append(row)
        idx = len(self._row_widgets) - 1
        row.set_delete_handler(lambda _checked=False, i=idx: self._remove_row_at(i))
        row._id_edit.textChanged.connect(self._check_duplicate_hint)

    def _remove_row_at(self, index: int) -> None:
        if index < 0 or index >= len(self._row_widgets):
            return
        w = self._row_widgets.pop(index)
        w.setParent(None)
        w.deleteLater()
        self._rows_layout.removeWidget(w)
        # 重建删除回调索引
        for i, rw in enumerate(self._row_widgets):
            rw.set_delete_handler(lambda _c=False, ii=i: self._remove_row_at(ii))
        self._check_duplicate_hint()

    def _add_empty_row(self) -> None:
        self._append_row("", "")
        self._check_duplicate_hint()

    def _collect_rows(self) -> list[tuple[str, str]]:
        return [(w.id_text(), w.path_text()) for w in self._row_widgets]

    def _check_duplicate_hint(self) -> None:
        ids = []
        for w in self._row_widgets:
            a = (w.id_text() or "").strip()
            b = (w.path_text() or "").strip()
            if not a and not b:
                continue
            ids.append(a)
        non_empty = [x for x in ids if x]
        if len(non_empty) != len(set(non_empty)):
            dup_ids = sorted({x for x in non_empty if non_empty.count(x) > 1})
            self._status.setStyleSheet("color:#c44;")
            self._status.setText("短 id 重复：" + "、".join(dup_ids) + "（无法 Apply）")
            return
        self._status.setStyleSheet("color:#c44;")
        self._status.setText("")

    def _apply(self) -> None:
        rows = self._collect_rows()
        data, err = _rows_to_dict(rows)
        if err:
            QMessageBox.warning(self, "overlay_images", err)
            return
        self._model.overlay_images = data
        self._model.mark_dirty("overlay_images")
        self._status.setStyleSheet("color:#484;")
        self._status.setText("已写入内存；请 Ctrl+S 保存工程写入磁盘。")

    def flush_to_model(self) -> None:
        """保存工程前：校验通过后写入 model；失败则抛错以中止整次保存。"""
        rows = self._collect_rows()
        data, err = _rows_to_dict(rows)
        if err:
            raise ValueError(f"overlay_images: {err}")
        self._model.overlay_images = data
        self._model.mark_dirty("overlay_images")
