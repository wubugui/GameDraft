"""Animation config editor with sprite preview."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QSpinBox, QPushButton, QLabel, QComboBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QScrollArea,
    QFileDialog, QMessageBox, QInputDialog, QCheckBox,
    QSizePolicy,
)
from PySide6.QtGui import QPixmap
from PySide6.QtCore import Qt, QRect, QTimer

from ..project_model import ProjectModel

_STEM_RE = re.compile(r"^[a-zA-Z0-9_]+$")

# QLabel + setPixmap：须配合固定上限与 setFixedSize，避免随布局/尺寸提示越撑越大
_ATLAS_VIEW_MAX_W = 580
_ATLAS_VIEW_MAX_H = 300
_ATLAS_VIEW_MIN_W = 240
_ATLAS_VIEW_RESERVE_RIGHT_COL = 280
_FRAME_PREV_MAX_W = 220
_FRAME_PREV_MAX_H = 200
_FRAME_PREV_PLACEHOLDER_W = 160
_FRAME_PREV_PLACEHOLDER_H = 120


def _default_anim_template() -> dict:
    return {
        "spritesheet": "",
        "cols": 1,
        "rows": 1,
        "worldWidth": 100,
        "states": {
            "idle": {
                "frames": [0],
                "frameRate": 8,
                "loop": True,
            }
        },
    }


class AnimEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_key: str | None = None

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_new = QPushButton("+ 新建")
        btn_new.clicked.connect(self._new_anim)
        btn_dup = QPushButton("复制")
        btn_dup.clicked.connect(self._dup_anim)
        btn_del = QPushButton("删除")
        btn_del.clicked.connect(self._delete_anim)
        btn_row.addWidget(btn_new)
        btn_row.addWidget(btn_dup)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentTextChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setMinimumHeight(420)
        detail = QWidget()
        self._anim_detail_panel = detail
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._a_stem = QLineEdit()
        self._a_stem.setPlaceholderText("须以 _anim 结尾")
        f.addRow("资产 ID", self._a_stem)

        sheet_row = QWidget()
        sr = QHBoxLayout(sheet_row)
        sr.setContentsMargins(0, 0, 0, 0)
        self._a_sheet = QLineEdit()
        btn_browse = QPushButton("浏览…")
        btn_browse.clicked.connect(self._browse_sheet)
        sr.addWidget(self._a_sheet, 1)
        sr.addWidget(btn_browse)
        f.addRow("spritesheet", sheet_row)

        self._a_cols = QSpinBox()
        self._a_cols.setRange(1, 99)
        f.addRow("cols", self._a_cols)
        self._a_rows = QSpinBox()
        self._a_rows.setRange(1, 99)
        f.addRow("rows", self._a_rows)
        self._a_world_mode = QComboBox()
        self._a_world_mode.addItem("按宽度（只写 worldWidth）", 0)
        self._a_world_mode.addItem("按高度（只写 worldHeight）", 1)
        self._a_world_mode.addItem("同时写宽高（高级）", 2)
        self._a_world_mode.setCurrentIndex(0)
        self._a_world_mode.currentIndexChanged.connect(self._on_anim_world_mode_changed)
        f.addRow("世界尺寸", self._a_world_mode)
        self._a_ww = QSpinBox()
        self._a_ww.setRange(1, 9999)
        f.addRow("worldWidth", self._a_ww)
        self._a_wh = QSpinBox()
        self._a_wh.setRange(1, 9999)
        f.addRow("worldHeight", self._a_wh)
        self._on_anim_world_mode_changed(0)
        dl.addLayout(f)

        self._a_sheet.editingFinished.connect(self._refresh_preview)
        self._a_cols.editingFinished.connect(self._refresh_preview)
        self._a_rows.editingFinished.connect(self._refresh_preview)
        self._a_cols.valueChanged.connect(self._on_sheet_grid_changed)
        self._a_rows.valueChanged.connect(self._on_sheet_grid_changed)

        dl.addWidget(QLabel("<b>States</b>"))
        self._state_table = QTableWidget(0, 4)
        self._state_table.setHorizontalHeaderLabels(["name", "frames", "frameRate", "loop"])
        self._state_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._state_table.verticalHeader().setDefaultSectionSize(32)
        dl.addWidget(self._state_table)
        state_btns = QHBoxLayout()
        add_st = QPushButton("+ State")
        add_st.clicked.connect(self._add_state)
        del_st = QPushButton("- State")
        del_st.clicked.connect(self._del_state)
        state_btns.addWidget(add_st)
        state_btns.addWidget(del_st)
        dl.addLayout(state_btns)

        self._state_table.itemSelectionChanged.connect(self._on_state_selection_changed)
        self._state_table.itemChanged.connect(self._on_state_cell_edited)

        dl.addWidget(
            QLabel("<b>状态动画预览</b>（选中表格行即播该 state；与游戏切帧一致）")
        )
        pv_bar = QHBoxLayout()
        self._chk_preview_play = QCheckBox("播放")
        self._chk_preview_play.setChecked(True)
        self._chk_preview_play.toggled.connect(self._restart_preview_animation)
        pv_bar.addWidget(self._chk_preview_play)
        self._lbl_preview_info = QLabel("")
        self._lbl_preview_info.setStyleSheet("color: #aaa;")
        self._lbl_preview_info.setWordWrap(True)
        pv_bar.addWidget(self._lbl_preview_info, 1)
        dl.addLayout(pv_bar)

        # 并排：左侧整张 Atlas（主视觉），右侧小窗当前帧（不占竖向空间）
        atlas_frame_row = QHBoxLayout()
        atlas_col = QVBoxLayout()
        atlas_col.addWidget(QLabel("<b>雪碧图 Atlas（完整原图）</b>"))
        self._lbl_atlas_meta = QLabel("")
        self._lbl_atlas_meta.setStyleSheet("color: #888;")
        self._lbl_atlas_meta.setWordWrap(True)
        atlas_col.addWidget(self._lbl_atlas_meta)
        self._atlas_full = QLabel()
        self._atlas_full.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._atlas_full.setSizePolicy(
            QSizePolicy.Policy.Maximum,
            QSizePolicy.Policy.Fixed,
        )
        self._atlas_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)
        self._atlas_full.setStyleSheet("background: #1a1a1a;")
        atlas_col.addWidget(self._atlas_full, 1)
        frame_col = QVBoxLayout()
        frame_col.addWidget(QLabel("<b>当前帧</b>"))
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._preview.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Fixed,
        )
        self._preview.setFixedSize(_FRAME_PREV_PLACEHOLDER_W, _FRAME_PREV_PLACEHOLDER_H)
        self._preview.setStyleSheet("background: #2a2a2a;")
        frame_col.addWidget(self._preview)
        frame_col.addStretch(1)
        atlas_frame_row.addLayout(atlas_col, 1)
        atlas_frame_row.addLayout(frame_col, 0)
        dl.addLayout(atlas_frame_row)

        self._preview_timer = QTimer(self)
        self._preview_timer.timeout.connect(self._advance_preview_frame)
        self._sheet_pixmap: QPixmap | None = None
        self._sheet_cache_key: str = ""
        self._preview_seq_i: int = 0
        self._preview_frames: list[int] = []

        prev_btn = QPushButton("重载雪碧图")
        prev_btn.setToolTip("从磁盘重新加载当前 spritesheet，并刷新预览")
        prev_btn.clicked.connect(self._refresh_preview)
        dl.addWidget(prev_btn)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        dl.addWidget(apply_btn)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([240, 720])
        root.addWidget(splitter)
        self._refresh()

    @staticmethod
    def _valid_stem(s: str) -> bool:
        s = s.strip()
        if not s.endswith("_anim"):
            return False
        return bool(_STEM_RE.fullmatch(s))

    def _atlas_target_view_width(self) -> int:
        dw = self._anim_detail_panel.width()
        if dw > _ATLAS_VIEW_RESERVE_RIGHT_COL + _ATLAS_VIEW_MIN_W:
            return max(
                _ATLAS_VIEW_MIN_W,
                min(_ATLAS_VIEW_MAX_W, dw - _ATLAS_VIEW_RESERVE_RIGHT_COL),
            )
        return _ATLAS_VIEW_MAX_W

    def _set_atlas_full_placeholder(self, message: str) -> None:
        self._atlas_full.clear()
        self._atlas_full.setText(message)
        self._atlas_full.setFixedSize(_ATLAS_VIEW_MIN_W, 120)

    def _set_frame_preview_placeholder(self, message: str) -> None:
        self._preview.clear()
        self._preview.setText(message)
        self._preview.setFixedSize(_FRAME_PREV_PLACEHOLDER_W, _FRAME_PREV_PLACEHOLDER_H)

    def _refresh(self) -> None:
        sel = self._list.currentItem()
        keep = sel.text() if sel else self._current_key
        self._list.clear()
        for k in sorted(self._model.animations.keys()):
            self._list.addItem(k)
        if keep and keep in self._model.animations:
            self._select_stem(keep)

    def _select_stem(self, stem: str) -> None:
        for i in range(self._list.count()):
            it = self._list.item(i)
            if it and it.text() == stem:
                self._list.setCurrentRow(i)
                return

    def _clear_detail(self) -> None:
        self._stop_preview_timer()
        self._sheet_pixmap = None
        self._sheet_cache_key = ""
        self._preview_frames = []
        self._preview_seq_i = 0
        self._lbl_preview_info.setText("")
        self._current_key = None
        self._a_stem.clear()
        self._a_sheet.clear()
        self._a_cols.setValue(1)
        self._a_rows.setValue(1)
        self._a_world_mode.setCurrentIndex(0)
        self._a_ww.setValue(100)
        self._a_wh.setValue(160)
        self._on_anim_world_mode_changed(0)
        self._clear_state_rows()
        self._set_atlas_full_placeholder("")
        self._lbl_atlas_meta.setText("")
        self._set_frame_preview_placeholder("(未选择动画)")

    def _clear_state_rows(self) -> None:
        while self._state_table.rowCount() > 0:
            self._state_table.removeRow(0)

    def _on_select(self, key: str) -> None:
        if not key or key not in self._model.animations:
            self._clear_detail()
            return
        self._current_key = key
        a = self._model.animations[key]
        self._a_stem.setText(key)
        self._a_sheet.setText(a.get("spritesheet", ""))
        self._a_cols.setValue(int(a.get("cols", 1)))
        self._a_rows.setValue(int(a.get("rows", 1)))
        ww = int(a.get("worldWidth", 0) or 0)
        wh = int(a.get("worldHeight", 0) or 0)
        if ww > 0 and wh > 0:
            self._a_world_mode.setCurrentIndex(2)
        elif wh > 0:
            self._a_world_mode.setCurrentIndex(1)
        else:
            self._a_world_mode.setCurrentIndex(0)
        self._a_ww.setValue(ww if ww > 0 else 100)
        self._a_wh.setValue(wh if wh > 0 else 160)
        self._on_anim_world_mode_changed(self._a_world_mode.currentIndex())

        self._state_table.blockSignals(True)
        self._clear_state_rows()
        states = a.get("states", {})
        if not isinstance(states, dict):
            states = {}
        for sname, sdef in states.items():
            if not isinstance(sdef, dict):
                sdef = {}
            r = self._state_table.rowCount()
            self._state_table.insertRow(r)
            self._set_state_row(
                r,
                str(sname),
                sdef.get("frames", [0]),
                int(sdef.get("frameRate", 8)),
                bool(sdef.get("loop", True)),
            )
        self._state_table.blockSignals(False)
        if self._state_table.rowCount() > 0:
            self._state_table.selectRow(0)
        self._refresh_preview()

    def _frames_to_cell_text(self, frames: object) -> str:
        if isinstance(frames, list):
            return ",".join(str(int(x)) for x in frames)
        return "0"

    def _set_state_row(self, row: int, name: str, frames: object, rate: int, loop: bool) -> None:
        self._state_table.blockSignals(True)
        self._state_table.setItem(row, 0, QTableWidgetItem(name))
        if isinstance(frames, list):
            ft = ",".join(str(int(x)) for x in frames)
        else:
            ft = "0"
        self._state_table.setItem(row, 1, QTableWidgetItem(ft))
        sb = QSpinBox()
        sb.setRange(1, 999)
        sb.setValue(max(1, rate))
        self._state_table.setCellWidget(row, 2, sb)
        cb = QCheckBox()
        cb.setChecked(loop)
        self._state_table.setCellWidget(row, 3, cb)
        sb.valueChanged.connect(self._restart_preview_animation)
        cb.toggled.connect(self._restart_preview_animation)
        self._state_table.blockSignals(False)

    def _on_state_cell_edited(self, _item: QTableWidgetItem) -> None:
        self._restart_preview_animation()

    def _parse_frames_from_cell(
        self, item: QTableWidgetItem | None, *, quiet: bool = False
    ) -> list[int]:
        if item is None:
            return [0]
        text = item.text().strip()
        if not text:
            return [0]
        if text.startswith("["):
            try:
                raw = json.loads(text)
                if isinstance(raw, list):
                    if not raw:
                        return [0]
                    return [int(x) for x in raw]
            except (json.JSONDecodeError, ValueError, TypeError):
                pass
        parts = [p.strip() for p in text.split(",") if p.strip()]
        out: list[int] = []
        for p in parts:
            try:
                out.append(int(p))
            except ValueError:
                if not quiet:
                    QMessageBox.warning(
                        self,
                        "frames",
                        f"无法解析帧列表: {text!r}\n请使用逗号分隔整数，如 0,1,2",
                    )
                return []
        return out if out else [0]

    def _browse_sheet(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "浏览", "请先打开项目。")
            return
        start = self._model.project_path / "public"
        path_str, _ = QFileDialog.getOpenFileName(
            self,
            "选择雪碧图",
            str(start),
            "Images (*.png *.jpg *.jpeg *.webp);;All (*.*)",
        )
        if not path_str:
            return
        pub = self._model.project_path / "public"
        try:
            rel = Path(path_str).resolve().relative_to(pub.resolve())
        except ValueError:
            QMessageBox.warning(self, "路径", "请选择项目 public 目录下的文件。")
            return
        self._a_sheet.setText("/" + rel.as_posix())
        self._refresh_preview()

    def _refresh_preview(self) -> None:
        self._sheet_pixmap = None
        self._sheet_cache_key = ""
        if self._model.project_path is None:
            self._update_atlas_full_label()
            return
        sheet_path = self._a_sheet.text().strip()
        if not sheet_path:
            self._set_atlas_full_placeholder("(未设置 spritesheet)")
            self._lbl_atlas_meta.setText("")
            self._set_frame_preview_placeholder("(未设置 spritesheet)")
            self._restart_preview_animation()
            return
        full = self._model.project_path / "public" / sheet_path.lstrip("/")
        if full.exists():
            pm = QPixmap(str(full))
            if not pm.isNull():
                self._sheet_pixmap = pm
                self._sheet_cache_key = sheet_path
                self._update_atlas_full_label()
                self._restart_preview_animation()
                return
        self._set_atlas_full_placeholder(f"无法加载: {sheet_path}")
        self._lbl_atlas_meta.setText("")
        self._set_frame_preview_placeholder(f"无法加载: {sheet_path}")
        self._stop_preview_timer()

    def _update_atlas_full_label(self) -> None:
        if self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            self._set_atlas_full_placeholder("(无雪碧图)")
            self._lbl_atlas_meta.setText("")
            return
        cols = max(1, self._a_cols.value())
        rows = max(1, self._a_rows.value())
        w = self._sheet_pixmap.width()
        h = self._sheet_pixmap.height()
        avail_w = self._atlas_target_view_width()
        scaled = self._sheet_pixmap.scaled(
            avail_w,
            _ATLAS_VIEW_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._atlas_full.setPixmap(scaled)
        self._atlas_full.setFixedSize(scaled.size())
        self._atlas_full.setText("")
        fw = max(1, w // cols)
        fh = max(1, h // rows)
        self._lbl_atlas_meta.setText(
            f"原图 {w}×{h} px  ·  网格 cols×rows = {cols}×{rows}  ·  单格约 {fw}×{fh} px"
        )

    def _on_sheet_grid_changed(self, _v: int) -> None:
        self._update_atlas_full_label()
        self._restart_preview_animation()

    def _on_anim_world_mode_changed(self, _idx: int) -> None:
        mode = int(self._a_world_mode.currentData())
        self._a_ww.setEnabled(mode in (0, 2))
        self._a_wh.setEnabled(mode in (1, 2))

    def _stop_preview_timer(self) -> None:
        self._preview_timer.stop()

    def _on_state_selection_changed(self) -> None:
        self._restart_preview_animation()

    def _gather_row_preview(self, row: int) -> tuple[str, list[int], int, bool] | None:
        if row < 0 or row >= self._state_table.rowCount():
            return None
        name_item = self._state_table.item(row, 0)
        frames_item = self._state_table.item(row, 1)
        name = name_item.text().strip() if name_item else ""
        frames = self._parse_frames_from_cell(frames_item, quiet=True)
        if not frames:
            frames = [0]
        rate_w = self._state_table.cellWidget(row, 2)
        loop_w = self._state_table.cellWidget(row, 3)
        rate = rate_w.value() if isinstance(rate_w, QSpinBox) else 8
        loop_b = loop_w.isChecked() if isinstance(loop_w, QCheckBox) else True
        return (name or f"row{row}", frames, max(1, int(rate)), loop_b)

    def _atlas_crop(self, atlas_index: int) -> QPixmap | None:
        if self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            return None
        cols = max(1, self._a_cols.value())
        rows = max(1, self._a_rows.value())
        pw = self._sheet_pixmap.width()
        ph = self._sheet_pixmap.height()
        fw = max(1, pw // cols)
        fh = max(1, ph // rows)
        col = atlas_index % cols
        row = atlas_index // cols
        if col >= cols or row >= rows:
            return None
        x = col * fw
        y = row * fh
        if x + fw > pw or y + fh > ph:
            return None
        rect = QRect(x, y, fw, fh)
        return self._sheet_pixmap.copy(rect)

    def _show_cropped_scaled(self, cropped: QPixmap | None) -> None:
        if cropped is None or cropped.isNull():
            self._set_frame_preview_placeholder("(无法切帧：检查 cols/rows 与帧索引)")
            return
        scaled = cropped.scaled(
            _FRAME_PREV_MAX_W,
            _FRAME_PREV_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._preview.setPixmap(scaled)
        self._preview.setFixedSize(scaled.size())
        self._preview.setText("")

    def _restart_preview_animation(self) -> None:
        self._stop_preview_timer()
        self._preview_frames = []
        self._preview_seq_i = 0
        row = self._state_table.currentRow()
        if row < 0:
            self._lbl_preview_info.setText("")
            if self._sheet_pixmap is not None and not self._sheet_pixmap.isNull():
                self._show_cropped_scaled(self._atlas_crop(0))
                self._lbl_preview_info.setText("（请选中一行 state）")
            elif not self._a_sheet.text().strip():
                self._set_frame_preview_placeholder("(未设置 spritesheet)")
                return
        data = self._gather_row_preview(row)
        if not data:
            return
        name, frames, rate, _loop = data
        self._preview_frames = frames
        self._preview_seq_i = 0
        if not self._sheet_pixmap or self._sheet_pixmap.isNull():
            self._set_frame_preview_placeholder("(无法加载雪碧图)")
            self._lbl_preview_info.setText("")
            return
        first = self._atlas_crop(frames[0])
        self._show_cropped_scaled(first)
        ms = max(16, int(round(1000.0 / float(rate))))
        if not self._chk_preview_play.isChecked() or len(frames) <= 1:
            self._update_preview_info(name, len(frames), 0)
            return
        self._update_preview_info(name, len(frames), ms)
        self._preview_timer.start(ms)

    def _update_preview_info(self, state_name: str, n_frames: int, interval_ms: int) -> None:
        pos = self._preview_seq_i + 1
        base = f"{state_name}  第 {pos}/{max(1, n_frames)} 帧"
        if interval_ms > 0:
            self._lbl_preview_info.setText(f"{base}  ·  {interval_ms}ms/帧")
        else:
            self._lbl_preview_info.setText(base)

    def _advance_preview_frame(self) -> None:
        row = self._state_table.currentRow()
        if row < 0:
            self._stop_preview_timer()
            return
        data = self._gather_row_preview(row)
        if not data:
            self._stop_preview_timer()
            return
        name, frames, rate, loop = data
        self._preview_frames = frames
        if len(frames) <= 1:
            self._stop_preview_timer()
            return
        self._preview_seq_i += 1
        if self._preview_seq_i >= len(frames):
            if loop:
                self._preview_seq_i = 0
            else:
                self._preview_seq_i = len(frames) - 1
                self._stop_preview_timer()
                crop = self._atlas_crop(frames[self._preview_seq_i])
                self._show_cropped_scaled(crop)
                self._update_preview_info(name, len(frames), 0)
                return
        crop = self._atlas_crop(frames[self._preview_seq_i])
        self._show_cropped_scaled(crop)
        ms = max(16, int(round(1000.0 / float(max(1, rate)))))
        self._update_preview_info(name, len(frames), ms)
        if self._preview_timer.isActive():
            self._preview_timer.setInterval(ms)

    def _add_state(self) -> None:
        r = self._state_table.rowCount()
        self._state_table.insertRow(r)
        self._set_state_row(r, "new_state", [0], 8, True)
        self._state_table.selectRow(r)
        self._restart_preview_animation()

    def _del_state(self) -> None:
        row = self._state_table.currentRow()
        if row >= 0:
            self._state_table.removeRow(row)
            self._restart_preview_animation()

    def _new_anim(self) -> None:
        text, ok = QInputDialog.getText(
            self,
            "新建动画",
            "资源 ID（须以 _anim 结尾，例如 npc_foo_anim）:",
        )
        if not ok:
            return
        stem = text.strip()
        if not self._valid_stem(stem):
            QMessageBox.warning(
                self,
                "无效 ID",
                "ID 须匹配 [a-zA-Z0-9_]+ 且以 _anim 结尾。",
            )
            return
        if stem in self._model.animations:
            QMessageBox.warning(self, "重复", f"已存在: {stem}")
            return
        self._model.animations[stem] = copy.deepcopy(_default_anim_template())
        self._model.mark_dirty("animation")
        self._refresh()
        self._select_stem(stem)

    def _dup_anim(self) -> None:
        if not self._current_key or self._current_key not in self._model.animations:
            QMessageBox.information(self, "复制", "请先在列表中选择一项动画。")
            return
        text, ok = QInputDialog.getText(
            self,
            "复制动画",
            "新资源 ID（须以 _anim 结尾）:",
        )
        if not ok:
            return
        stem = text.strip()
        if not self._valid_stem(stem):
            QMessageBox.warning(self, "无效 ID", "ID 须匹配 [a-zA-Z0-9_]+ 且以 _anim 结尾。")
            return
        if stem in self._model.animations:
            QMessageBox.warning(self, "重复", f"已存在: {stem}")
            return
        self._model.animations[stem] = copy.deepcopy(self._model.animations[self._current_key])
        self._model.mark_dirty("animation")
        self._refresh()
        self._select_stem(stem)

    def _delete_anim(self) -> None:
        item = self._list.currentItem()
        if not item:
            return
        stem = item.text()
        if stem not in self._model.animations:
            return
        r = QMessageBox.question(
            self,
            "删除动画",
            f"确定删除 {stem}？保存后将删除对应 JSON 文件。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        del self._model.animations[stem]
        self._model.mark_dirty("animation")
        self._current_key = None
        self._clear_detail()
        self._refresh()
        rest = sorted(self._model.animations.keys())
        if rest:
            self._select_stem(rest[0])

    def _apply(self) -> None:
        if self._current_key is None or self._current_key not in self._model.animations:
            QMessageBox.information(self, "Apply", "请先在列表中选择一项动画。")
            return
        new_stem = self._a_stem.text().strip()
        if not self._valid_stem(new_stem):
            QMessageBox.warning(self, "无效 ID", "资产 ID 须匹配 [a-zA-Z0-9_]+ 且以 _anim 结尾。")
            return
        if new_stem != self._current_key:
            if new_stem in self._model.animations:
                QMessageBox.warning(self, "重复", f"ID 已存在: {new_stem}")
                return
            data = self._model.animations.pop(self._current_key)
            self._model.animations[new_stem] = data
            self._current_key = new_stem

        a = self._model.animations[self._current_key]
        a["spritesheet"] = self._a_sheet.text().strip()
        a["cols"] = self._a_cols.value()
        a["rows"] = self._a_rows.value()
        a.pop("worldWidth", None)
        a.pop("worldHeight", None)
        mode = int(self._a_world_mode.currentData())
        ww_v = self._a_ww.value()
        wh_v = self._a_wh.value()
        if mode == 0:
            a["worldWidth"] = max(1, ww_v)
        elif mode == 1:
            a["worldHeight"] = max(1, wh_v)
        else:
            a["worldWidth"] = max(1, ww_v)
            a["worldHeight"] = max(1, wh_v)

        states: dict = {}
        for i in range(self._state_table.rowCount()):
            name_item = self._state_table.item(i, 0)
            frames_item = self._state_table.item(i, 1)
            if not name_item or not name_item.text().strip():
                continue
            frames = self._parse_frames_from_cell(frames_item)
            if frames == []:
                return
            rate_w = self._state_table.cellWidget(i, 2)
            loop_w = self._state_table.cellWidget(i, 3)
            rate = rate_w.value() if isinstance(rate_w, QSpinBox) else 8
            loop_b = loop_w.isChecked() if isinstance(loop_w, QCheckBox) else True
            states[name_item.text().strip()] = {
                "frames": frames,
                "frameRate": int(rate),
                "loop": loop_b,
            }
        if not states:
            QMessageBox.warning(self, "States", "至少保留一个状态。")
            return
        a["states"] = states
        self._model.mark_dirty("animation")
        keep = self._current_key
        self._refresh()
        self._select_stem(keep)
        self._on_select(keep)
