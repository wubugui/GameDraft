"""World color filter defs: 与 tools/filter_tool 共用 data/filters 目录。"""
from __future__ import annotations

import json
import sys

from PySide6.QtCore import QProcess, Qt
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QLabel, QDoubleSpinBox, QMessageBox,
    QComboBox,
)

from ..project_model import ProjectModel
from ..shared.form_layout import compact_form
from ..shared.list_affordances import make_list_search_box
from .. import theme as app_theme

try:
    from tools.filter_tool.paths import filters_json_dir
    from tools.filter_tool.presets import BUILTIN_PRESETS
except ImportError:
    def filters_json_dir(project_root):  # type: ignore[misc]
        return project_root / "public" / "assets" / "data" / "filters"

    BUILTIN_PRESETS = {}  # type: ignore[misc,assignment]

_IDENTITY_MATRIX = [
    1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
]


class FilterEditor(QWidget):
    """列表与数值编辑；视觉调色请用「滤镜工具」写入同一目录 JSON。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_stem: str | None = None
        self._filter_tool_proc: QProcess | None = None

        root = QHBoxLayout(self)
        split = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        link_row = QHBoxLayout()
        self._btn_tool = QPushButton("打开滤镜工具…")
        self._btn_tool.setToolTip("启动 tools.filter_tool（tk），与游戏相同目录保存 JSON")
        self._btn_tool.clicked.connect(self._launch_filter_tool)
        self._btn_reload = QPushButton("从磁盘重载")
        self._btn_reload.setToolTip("用磁盘上 data/filters 覆盖当前内存列表")
        self._btn_reload.clicked.connect(self._reload_from_disk)
        link_row.addWidget(self._btn_tool)
        link_row.addWidget(self._btn_reload)
        ll.addLayout(link_row)

        row = QHBoxLayout()
        add_btn = QPushButton("+ Filter")
        add_btn.clicked.connect(self._add)
        del_btn = QPushButton("Delete")
        del_btn.clicked.connect(self._delete)
        row.addWidget(add_btn)
        row.addWidget(del_btn)
        ll.addLayout(row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        self._search = make_list_search_box(
            self._list,
            tooltip="按滤镜 id 过滤下方列表（仅隐藏不匹配项，不改动数据）。")
        ll.addWidget(self._search)
        ll.addWidget(self._list)
        self._empty_hint = QLabel("暂无滤镜，点击「+ Filter」新增")
        self._empty_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_hint.setWordWrap(True)
        self._empty_hint.setStyleSheet("color: gray; padding: 12px;")
        self._empty_hint.hide()
        ll.addWidget(self._empty_hint)

        right = QWidget()
        rl = QVBoxLayout(right)
        self._path_lbl = QLabel()
        self._path_lbl.setWordWrap(True)
        self._path_lbl.setStyleSheet(
            app_theme.secondary_label_stylesheet(app_theme.current_theme_id()))
        rl.addWidget(self._path_lbl)

        if BUILTIN_PRESETS:
            preset_row = QHBoxLayout()
            preset_row.addWidget(QLabel("内置预制（与 filter_tool 相同）"))
            self._preset_combo = QComboBox()
            for key, (label, _) in sorted(
                BUILTIN_PRESETS.items(), key=lambda x: x[0],
            ):
                self._preset_combo.addItem(f"{label} ({key})", key)
            preset_row.addWidget(self._preset_combo, 1)
            btn_fill = QPushButton("填入 matrix")
            btn_fill.setToolTip("仅填充下方编辑框，需再点 Apply 写入内存")
            btn_fill.clicked.connect(self._fill_builtin_preset)
            preset_row.addWidget(btn_fill)
            rl.addLayout(preset_row)

        preset_hint = QLabel(
            "内置预制：上方下拉选择后「填入 matrix」"
            if BUILTIN_PRESETS
            else "（未能导入 tools.filter_tool.presets）"
        )
        if BUILTIN_PRESETS:
            preset_hint.setToolTip(
                "内置 id：" + ", ".join(sorted(BUILTIN_PRESETS.keys())))
            if hasattr(self, "_preset_combo"):
                self._preset_combo.setToolTip(
                    "内置预制（与 filter_tool 相同）。内置 id："
                    + ", ".join(sorted(BUILTIN_PRESETS.keys())))
        self._preset_hint = preset_hint
        self._preset_hint.setStyleSheet(
            app_theme.secondary_label_stylesheet(app_theme.current_theme_id()))
        rl.addWidget(self._preset_hint)

        form = compact_form(QFormLayout())
        self._lbl_stem = QLabel("-")
        form.addRow("id（文件名）", self._lbl_stem)
        self._matrix_edit = QLineEdit()
        self._matrix_edit.setPlaceholderText("1, 0, 0, 0, 0, 0, 1, 0, ...")
        self._matrix_edit.setMinimumWidth(240)
        self._matrix_edit.setToolTip(
            "matrix：20 个浮点（逗号/空格分隔或 JSON 数组），"
            "与 Pixi ColorMatrixFilter、filter_tool 导出格式一致。"
        )
        form.addRow("matrix", self._matrix_edit)
        self._alpha = QDoubleSpinBox()
        self._alpha.setRange(0, 1)
        self._alpha.setSingleStep(0.05)
        self._alpha.setDecimals(3)
        form.addRow("alpha", self._alpha)
        rl.addLayout(form)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)
        rl.addStretch()

        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([220, 560])
        root.addWidget(split)

        self._filter_model_changed_deferred: bool = False
        self._model.data_changed.connect(self._on_model_data_changed)
        self._refresh_list()
        self._update_path_label()

    def _update_path_label(self) -> None:
        if self._model.project_path is None:
            self._path_lbl.setText("未打开工程")
            self._btn_tool.setEnabled(False)
            self._btn_reload.setEnabled(False)
            return
        self._btn_tool.setEnabled(True)
        self._btn_reload.setEnabled(True)
        p = filters_json_dir(self._model.project_path)
        self._path_lbl.setText(f"目录（与 filter_tool 一致）：{p}")

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "filter":
            return
        self._filter_model_changed_deferred = True
        if self.isVisible():
            self._flush_filter_model_changed()

    def _flush_filter_model_changed(self) -> None:
        if not self._filter_model_changed_deferred:
            return
        self._filter_model_changed_deferred = False
        prev = self._current_stem
        self._refresh_list()
        if prev and prev in self._model.filter_defs:
            for i in range(self._list.count()):
                it = self._list.item(i)
                if it is not None and it.text() == prev:
                    self._list.setCurrentRow(i)
                    break
            self._load_stem_into_form(prev)
        else:
            self._list.clearSelection()
            self._current_stem = None
            self._lbl_stem.setText("-")
            self._matrix_edit.clear()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        self._flush_filter_model_changed()

    def _launch_filter_tool(self) -> None:
        if self._model.project_path is None:
            return
        proc = QProcess(self)
        proc.setWorkingDirectory(str(self._model.project_path))
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.finished.connect(self._on_filter_tool_finished)
        proc.start(sys.executable, ["-m", "tools.filter_tool"])
        if not proc.waitForStarted(4000):
            QMessageBox.warning(
                self,
                "滤镜工具",
                "无法启动。请在仓库根目录确认已安装依赖"
                "（./dev.sh install-deps），并执行：\n"
                "./dev.sh filter-tool",
            )
            proc.deleteLater()
            return
        self._filter_tool_proc = proc

    def _on_filter_tool_finished(self, _code: int, _status: QProcess.ExitStatus) -> None:
        self._filter_tool_proc = None
        self._model.reload_filters_from_disk()

    def _reload_from_disk(self) -> None:
        self._model.reload_filters_from_disk()

    def _is_dirty(self) -> bool:
        """表单与模型比对；matrix 文本不可解析也算脏（有未落库的输入）。"""
        stem = self._current_stem
        if not stem:
            return False
        data = self._model.filter_defs.get(stem, {})
        mat = self._parse_matrix()
        if mat is None:
            return bool(self._matrix_edit.text().strip())
        if mat != data.get("matrix", _IDENTITY_MATRIX):
            return True
        old_alpha = data.get("alpha", 1)
        try:
            return float(old_alpha) != float(self._alpha.value())
        except (TypeError, ValueError):
            return True

    def flush_to_model(self) -> None:
        if self._current_stem and self._is_dirty():
            self._apply(show_errors=False)

    def confirm_close(self, parent=None) -> bool:
        if not self._current_stem or not self._is_dirty():
            return True
        from PySide6.QtWidgets import QMessageBox as _MB
        r = _MB.question(
            self, "未应用的修改", "当前滤镜有未应用的修改。保存到模型？",
            _MB.StandardButton.Save | _MB.StandardButton.Discard | _MB.StandardButton.Cancel,
        )
        if r == _MB.StandardButton.Cancel:
            return False
        if r == _MB.StandardButton.Save:
            self._apply(show_errors=True)
            if self._is_dirty():
                return False  # matrix 非法等原因没保成，留在编辑器里改
        else:
            # Discard：把表单回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._load_stem_into_form(self._current_stem)
        return True

    def _refresh_list(self) -> None:
        self._list.blockSignals(True)
        self._list.clear()
        for stem in sorted(self._model.filter_defs.keys()):
            self._list.addItem(stem)
        self._list.blockSignals(False)
        # 重新套用搜索过滤，使 setHidden 与新内容一致
        self._search.textChanged.emit(self._search.text())
        self._empty_hint.setVisible(self._list.count() == 0)

    def _on_select(self, row: int) -> None:
        # commit-on-leave：切走前提交上一条的未应用编辑（与其它表单编辑器一致）
        if self._current_stem and self._is_dirty():
            self._apply(show_errors=False)
        if row < 0:
            self._current_stem = None
            self._lbl_stem.setText("-")
            self._matrix_edit.clear()
            return
        item = self._list.item(row)
        if item is None:
            return
        self._load_stem_into_form(item.text())

    def _load_stem_into_form(self, stem: str) -> None:
        self._current_stem = stem
        data = self._model.filter_defs.get(stem, {})
        self._lbl_stem.setText(stem)
        m = data.get("matrix", _IDENTITY_MATRIX)
        if isinstance(m, list) and len(m) == 20:
            # 保留原始 int/float 表示（1 显示 "1" 而非 "1.0"），配合 _parse_matrix 的
            # int 保真解析，"仅点选+Save All" 不再把整数矩阵重写成 float。
            self._matrix_edit.setText(", ".join(str(x) for x in m))
        else:
            self._matrix_edit.setText("")
        self._alpha.setValue(float(data.get("alpha", 1)))

    def _fill_builtin_preset(self) -> None:
        key = self._preset_combo.currentData()
        if not key or key not in BUILTIN_PRESETS:
            return
        _, m = BUILTIN_PRESETS[key]
        self._matrix_edit.setText(", ".join(str(float(x)) for x in m))
        self._alpha.setValue(1.0)

    def _parse_matrix(self) -> list[float] | None:
        raw = self._matrix_edit.text().strip()
        if not raw:
            return None
        def _num(tok: str):
            try:
                return json.loads(tok)  # "1"->int 1、"0.5"->float 0.5
            except (json.JSONDecodeError, ValueError):
                return float(tok)  # 容忍 "1." 等非严格 JSON 数字

        if raw.startswith("["):
            try:
                arr = json.loads(raw)
            except json.JSONDecodeError:
                return None
            if isinstance(arr, list) and len(arr) == 20:
                out: list = []
                for x in arr:
                    if isinstance(x, bool) or not isinstance(x, (int, float)):
                        return None
                    out.append(x)
                return out
            return None
        parts = raw.replace(",", " ").split()
        if len(parts) != 20:
            return None
        try:
            vals = [_num(t) for t in parts]
        except (TypeError, ValueError):
            return None
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in vals):
            return None
        return vals

    def _apply(self, *, show_errors: bool = True) -> None:
        if not self._current_stem:
            return
        mat = self._parse_matrix()
        if mat is None:
            if show_errors:
                QMessageBox.warning(
                    self,
                    "滤镜",
                    "matrix 必须是恰好 20 个数字（逗号/空格分隔，或 JSON 数组）。",
                )
            return
        stem = self._current_stem
        old = self._model.filter_defs.get(stem)
        cand: dict = dict(old) if isinstance(old, dict) else {"id": stem}
        cand.setdefault("id", stem)
        cand["matrix"] = mat
        alpha_v: object = float(self._alpha.value())
        old_alpha = (old or {}).get("alpha") if isinstance(old, dict) else None
        if (
            isinstance(old_alpha, (int, float))
            and not isinstance(old_alpha, bool)
            and float(old_alpha) == alpha_v
        ):
            alpha_v = old_alpha  # 未改动按原始 int/float 表示回写
        cand["alpha"] = alpha_v
        if cand == old:
            return  # 无实质变化：不写不标脏
        self._model.filter_defs[stem] = cand
        self._model.mark_dirty("filter")

    def _add(self) -> None:
        n = 1
        while f"filter_{n}" in self._model.filter_defs:
            n += 1
        stem = f"filter_{n}"
        self._model.filter_defs[stem] = {
            "id": stem,
            "matrix": list(_IDENTITY_MATRIX),
            "alpha": 1.0,
        }
        self._model.mark_dirty("filter")
        self._refresh_list()
        for i in range(self._list.count()):
            it = self._list.item(i)
            if it is not None and it.text() == stem:
                self._list.setCurrentRow(i)
                break

    def _delete(self) -> None:
        if not self._current_stem:
            return
        stem = self._current_stem
        btn = QMessageBox.question(
            self,
            "删除滤镜",
            f"确定从工程中移除滤镜「{stem}」？需「保存全部」后才会删除磁盘上的 json。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if btn != QMessageBox.StandardButton.Yes:
            return
        self._model.filter_defs.pop(stem, None)
        self._model.mark_dirty("filter")
        self._current_stem = None
        self._lbl_stem.setText("-")
        self._matrix_edit.clear()
        self._refresh_list()

    def on_editor_theme_changed(self, theme_id: str) -> None:
        ss = app_theme.secondary_label_stylesheet(theme_id)
        self._path_lbl.setStyleSheet(ss)
        self._preset_hint.setStyleSheet(ss)
