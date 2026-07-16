"""对话叠图短 id：overlay_images.json，供 showOverlayImage / blendOverlayImage 等动作的 image 参数使用。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

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


def _rows_to_dict(
    rows: list[tuple[str, str]], *, tolerant: bool = False,
) -> tuple[dict[str, str] | None, str | None]:
    """从表格行生成 dict；若短 id 重复或为空则返回 (None, 错误说明)。

    - 短 id 与路径均为空的行始终忽略（未填完的占位行）。
    - tolerant=True（保存全工程时）：短 id 为空的行（即便填了路径）也忽略，视为
      未填完的草稿——不报错、不阻断别处的保存，且不算数据丢失（无短 id 的条目无法被引用）。
    - tolerant=False（用户在本页 Apply 时）：短 id 为空但填了路径的行报错，给在场反馈。
    - 两种模式都对「短 id 重复」报错——重复会静默覆盖丢数据，必须拦。"""
    seen: set[str] = set()
    out: dict[str, str] = {}
    logical_i = 0
    for kid, pth in rows:
        k = (kid or "").strip()
        pt = (pth or "").strip()
        if not k and not pt:
            continue
        if not k:
            if tolerant:
                continue
            logical_i += 1
            return None, f"第 {logical_i} 行（非空行）：短 id 不能为空"
        logical_i += 1
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
        self._id_edit.setMinimumWidth(110)
        self._id_edit.setToolTip(
            "图片的短名字，自己起、全表唯一。\n"
            "在动作里用它的地方是 showOverlayImage 的 image、blendOverlayImage 的 "
            "fromImage/toImage——填这个短 id 即可，运行时自动换成右边的路径。\n"
            "注意：不是动作的 id 参数（那个是图层句柄、用来事后 hideOverlayImage，跟这里无关）。",
        )
        lay.addWidget(self._id_edit)
        lay.addWidget(QLabel("图片"), alignment=Qt.AlignmentFlag.AlignRight)
        self._path_row = CutsceneImagePathRow(
            model,
            path,
            external_copy_subdir="illustrations",
            external_copy_hint="项目外图片会复制到 resources/runtime/images/illustrations/",
        )
        self._path_row.setToolTip(
            "这个短 id 对应的真实图片。点 Browse 选图；项目外的图会自动拷进 "
            "resources/runtime/images/illustrations/。\n"
            "路径以 / 开头（/assets/… 或 /resources/…）；改完别忘 Apply + Ctrl+S。",
        )
        lay.addWidget(self._path_row, stretch=1)
        self._del = QPushButton("删除")
        self._del.setFixedWidth(56)
        self._del.setToolTip("删除此条短 id 映射")
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
        hint = QLabel("登记「短 id → /assets/... 路径」，供动作的 image 参数引用。")
        hint.setTextFormat(Qt.TextFormat.RichText)
        hint.setOpenExternalLinks(False)
        hint.setToolTip(
            "这是一张「图片短名字」登记表，本身不会让图上屏——它只是给图起个好记的名字。\n"
            "用法：在「图对话 runActions / 过场」里加 showOverlayImage（image 填短 id）"
            "把图叠上屏，再用 hideOverlayImage 关掉；要做一次性「模糊→清晰」用 blendOverlayImage。\n"
            "若是「告示/线索看清」这类有揭示语义、还要记进存档的，优先用「文档揭示」页 + revealDocument，"
            "不要在对话里手写 from/to。",
        )
        root.addWidget(hint)

        self._status = QLabel("")
        self._status.setStyleSheet("color:#c44;")
        self._status.setWordWrap(True)
        root.addWidget(self._status)

        # 非字符串值条目（agent 手写/未来 schema）：本页不显示、不 str() 摧毁，
        # Apply / 保存时按原键序原样透传。
        self._passthrough_values: dict[str, Any] = {}
        self._model_key_order: list[str] = []
        self._passthrough_note = QLabel("")
        self._passthrough_note.setStyleSheet("color:#888;")
        self._passthrough_note.setWordWrap(True)
        self._passthrough_note.setVisible(False)
        root.addWidget(self._passthrough_note)

        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索…")
        self._search.setClearButtonEnabled(True)
        self._search.setToolTip("按短 id 过滤下方行（仅隐藏不匹配的行，不改动数据）")
        self._search.textChanged.connect(self._apply_filter)
        root.addWidget(self._search)

        self._empty_hint = QLabel("暂无条目，点击「添加一行」新增「短 id → 图片路径」映射。")
        self._empty_hint.setStyleSheet("color:#888;")
        self._empty_hint.setWordWrap(True)
        self._empty_hint.setVisible(False)
        root.addWidget(self._empty_hint)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._rows_host = QWidget()
        self._rows_layout = QVBoxLayout(self._rows_host)
        self._rows_layout.addStretch()
        scroll.setWidget(self._rows_host)
        self._scroll = scroll
        root.addWidget(scroll, stretch=1)

        btn_row = QHBoxLayout()
        add_btn = QPushButton("添加一行")
        add_btn.setToolTip("新增一条空白的「短 id → 图片路径」映射")
        add_btn.clicked.connect(self._add_empty_row)
        reload_btn = QPushButton("从内存重载")
        reload_btn.setToolTip("丢弃本页未 Apply 的改动，按 ProjectModel.overlay_images 重新铺行")
        reload_btn.clicked.connect(self._reload_from_model)
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("写入内存并标脏：写入 ProjectModel.overlay_images；保存工程时写入 overlay_images.json")
        apply_btn.clicked.connect(self._apply)
        btn_row.addWidget(add_btn)
        btn_row.addWidget(reload_btn)
        btn_row.addWidget(apply_btn)
        btn_row.addStretch()
        root.addLayout(btn_row)

        self._row_widgets: list[_OneRow] = []
        self._reload_from_model()

    def select_by_id(self, short_id: str, _scene_id: str = "") -> None:
        """全局搜索/跳转落点：滚动到指定短 id 的行并聚焦其 id 输入框。"""
        target = (short_id or "").strip()
        if not target:
            return
        if self._search.text():
            self._search.clear()  # 过滤可能把目标行隐藏
        for row in self._row_widgets:
            edit = getattr(row, "_id_edit", None)
            if edit is not None and edit.text().strip() == target:
                self._scroll.ensureWidgetVisible(row)
                edit.setFocus()
                return

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
        # 保留模型(=磁盘文件)的既有键序，避免「打开即重排」改动导出 JSON 的键顺序。
        # 非字符串值不铺行（str() 会把 dict/list/数值/null 摧毁成字符串再写回），
        # 记入透传表，Apply / flush 时按原键序原样并回。
        self._passthrough_values = {}
        self._model_key_order = []
        for k in ov.keys():
            v = ov.get(k)
            self._model_key_order.append(str(k))
            if isinstance(v, str):
                self._append_row(str(k), v)
            else:
                self._passthrough_values[str(k)] = deepcopy(v)
        if self._passthrough_values:
            names = "、".join(list(self._passthrough_values)[:8])
            more = "…" if len(self._passthrough_values) > 8 else ""
            self._passthrough_note.setText(
                f"{len(self._passthrough_values)} 条非字符串值条目未在本页显示"
                f"（{names}{more}），Apply / 保存时按原样保留。")
            self._passthrough_note.setVisible(True)
        else:
            self._passthrough_note.setVisible(False)
        self._check_duplicate_hint()
        self._apply_filter()
        self._update_empty_hint()

    def _update_empty_hint(self) -> None:
        """无任何行时显示引导提示，否则隐藏。"""
        if hasattr(self, "_empty_hint"):
            self._empty_hint.setVisible(not self._row_widgets)

    def _apply_filter(self) -> None:
        """按短 id 文本过滤：仅 setHidden，不改动任何数据。"""
        if not hasattr(self, "_search"):
            return
        q = self._search.text().strip().lower()
        for w in self._row_widgets:
            if not q:
                w.setHidden(False)
            else:
                w.setHidden(q not in (w.id_text() or "").lower())

    def _append_row(self, short_id: str, path: str) -> None:
        row = _OneRow(self._model, short_id, path)
        insert_at = self._rows_layout.count() - 1
        self._rows_layout.insertWidget(insert_at, row)
        self._row_widgets.append(row)
        idx = len(self._row_widgets) - 1
        row.set_delete_handler(lambda _checked=False, i=idx: self._remove_row_at(i))
        row._id_edit.textChanged.connect(self._check_duplicate_hint)
        row._id_edit.textChanged.connect(self._apply_filter)

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
        self._apply_filter()
        self._update_empty_hint()

    def _add_empty_row(self) -> None:
        self._append_row("", "")
        self._check_duplicate_hint()
        self._apply_filter()
        self._update_empty_hint()

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
        pt_keys = set(getattr(self, "_passthrough_values", None) or {})
        dup_ids = sorted(
            {x for x in non_empty if non_empty.count(x) > 1}
            | (set(non_empty) & pt_keys)  # 与本页未显示的透传条目撞 id 也算重复
        )
        if dup_ids:
            self._status.setStyleSheet("color:#c44;")
            self._status.setText("短 id 重复：" + "、".join(dup_ids) + "（无法 Apply）")
            return
        self._status.setText("")

    def _merged_with_passthrough(self, data: dict[str, str]) -> dict:
        """把非字符串值条目按模型原键序原样并回（本页只编辑字符串条目）。"""
        if not self._passthrough_values:
            return data
        rest = dict(data)
        out: dict = {}
        for k in self._model_key_order:
            if k in self._passthrough_values:
                out[k] = deepcopy(self._passthrough_values[k])
            elif k in rest:
                out[k] = rest.pop(k)
        out.update(rest)  # 新增/改名的行按行序补在末尾
        return out

    def _passthrough_clash(self, data: dict[str, str]) -> list[str]:
        return sorted(set(data) & set(self._passthrough_values))

    def _apply(self) -> None:
        rows = self._collect_rows()
        data, err = _rows_to_dict(rows)
        if err:
            QMessageBox.warning(self, "overlay_images", err)
            return
        clash = self._passthrough_clash(data)
        if clash:
            QMessageBox.warning(
                self, "overlay_images",
                "短 id 与本页未显示的非字符串条目重复：" + "、".join(clash))
            return
        self._model.overlay_images = self._merged_with_passthrough(data)
        self._model.mark_dirty("overlay_images")
        self._status.setStyleSheet("color:#484;")
        self._status.setText("已写入内存；请 Ctrl+S 保存工程写入磁盘。")

    def flush_to_model(self) -> None:
        """保存工程前：跳过未填短 id 的草稿行（不阻断保存），重复短 id 仍抛错中止整次保存。
        仅在内容确有变化时标脏，避免每次 Save All 都重写未改动的 overlay_images.json。"""
        rows = self._collect_rows()
        data, err = _rows_to_dict(rows, tolerant=True)
        if err:
            raise ValueError(f"overlay_images: {err}")
        clash = self._passthrough_clash(data)
        if clash:
            raise ValueError(
                "overlay_images: 短 id 与非字符串条目重复：" + "、".join(clash))
        merged = self._merged_with_passthrough(data)
        if merged != (self._model.overlay_images or {}):
            self._model.overlay_images = merged
            self._model.mark_dirty("overlay_images")
