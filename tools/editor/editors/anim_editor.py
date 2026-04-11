"""动画包只读浏览：数据来自 public/assets/animation/<id>/anim.json，编辑请用 video_to_atlas 导出。"""
from __future__ import annotations

import json
import sys
from pathlib import Path, PurePosixPath

from PySide6.QtCore import QProcess
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QSpinBox, QPushButton, QLabel, QComboBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QScrollArea,
    QAbstractItemView,
    QCheckBox,
    QSizePolicy,
    QMessageBox,
)
from PySide6.QtGui import QPixmap
from PySide6.QtCore import Qt, QRect, QElapsedTimer, QTimer

# 与游戏 tick、FrameSequencePlayer 一致：累加 dt，每 1/frameRate 秒换帧；限制 dt 避免卡死后一次跳多格
_PREVIEW_MAX_DT_SEC = 0.1


def _preview_poll_interval_ms(fps: float) -> int:
    fps = max(1e-6, float(fps))
    ideal = 1000.0 / fps / 3.0
    return max(4, min(16, int(round(ideal))))

from ..project_model import ProjectModel

_ATLAS_VIEW_MAX_W = 580
_ATLAS_VIEW_MAX_H = 300
_ATLAS_VIEW_MIN_W = 240
_ATLAS_VIEW_RESERVE_RIGHT_COL = 280
_FRAME_PREV_MAX_W = 220
_FRAME_PREV_MAX_H = 200
_FRAME_PREV_PLACEHOLDER_W = 160
_FRAME_PREV_PLACEHOLDER_H = 120


def _effective_cell_stride(
    cols: int,
    rows: int,
    pm: QPixmap | None,
    cell_w_override: int,
    cell_h_override: int,
) -> tuple[int, int]:
    c = max(1, cols)
    r = max(1, rows)
    if pm is None or pm.isNull():
        return max(1, cell_w_override or 32), max(1, cell_h_override or 32)
    pw, ph = pm.width(), pm.height()
    sw = cell_w_override if cell_w_override > 0 else max(1, pw // c)
    sh = cell_h_override if cell_h_override > 0 else max(1, ph // r)
    return sw, sh


def _spritesheet_disk(project_path: Path, anim_manifest_url: str, spritesheet: str) -> Path | None:
    pub = project_path / "public"
    sh = str(spritesheet or "").strip()
    if not sh:
        return None
    if sh.startswith("/assets/"):
        return pub / sh.lstrip("/")
    base = PurePosixPath(anim_manifest_url.strip().lstrip("/")).parent
    part = sh[2:] if sh.startswith("./") else sh
    return pub / (base / PurePosixPath(part))


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
        hint = QLabel(
            "动画包目录：public/assets/animation/<id>/\n"
            "（anim.json + 图集；由 video_to_atlas 导出）"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #888;")
        ll.addWidget(hint)
        row_tools = QHBoxLayout()
        btn_vta = QPushButton("打开视频动画工具（新进程）…")
        btn_vta.setToolTip(
            "启动 tools/video_to_atlas，独立窗口；若存在 editor_data/animation/project.json 将自动打开该工作区。"
        )
        btn_vta.clicked.connect(self._open_video_atlas_detached)
        row_tools.addWidget(btn_vta)
        btn_reload = QPushButton("从磁盘重载全部动画")
        btn_reload.setToolTip(
            "重新扫描 public/assets/animation/*/anim.json 并更新内存；在视频工具导出后点此同步主编辑器。"
        )
        btn_reload.clicked.connect(self._reload_all_animations_from_disk)
        row_tools.addWidget(btn_reload)
        row_tools.addStretch()
        ll.addLayout(row_tools)
        self._list = QListWidget()
        self._list.currentTextChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setMinimumHeight(480)
        detail = QWidget()
        self._anim_detail_panel = detail
        dl = QVBoxLayout(detail)
        self._lbl_disk = QLabel("")
        self._lbl_disk.setWordWrap(True)
        self._lbl_disk.setStyleSheet("color: #6af;")
        dl.addWidget(self._lbl_disk)
        f = QFormLayout()
        self._a_stem = QLineEdit()
        self._a_stem.setReadOnly(True)
        f.addRow("包 ID（目录名）", self._a_stem)

        self._a_sheet = QLineEdit()
        self._a_sheet.setReadOnly(True)
        f.addRow("spritesheet（manifest 内）", self._a_sheet)

        self._a_cols = QSpinBox()
        self._a_cols.setRange(1, 99)
        self._a_cols.setReadOnly(True)
        self._a_cols.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cols", self._a_cols)
        self._a_rows = QSpinBox()
        self._a_rows.setRange(1, 99)
        self._a_rows.setReadOnly(True)
        self._a_rows.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("rows", self._a_rows)
        self._a_cell_w = QSpinBox()
        self._a_cell_w.setRange(0, 4096)
        self._a_cell_w.setReadOnly(True)
        self._a_cell_w.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cellWidth px（0=自动）", self._a_cell_w)
        self._a_cell_h = QSpinBox()
        self._a_cell_h.setRange(0, 4096)
        self._a_cell_h.setReadOnly(True)
        self._a_cell_h.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("cellHeight px（0=自动）", self._a_cell_h)
        self._a_world_mode = QComboBox()
        self._a_world_mode.addItem("按宽度（只写 worldWidth）", 0)
        self._a_world_mode.addItem("按高度（只写 worldHeight）", 1)
        self._a_world_mode.addItem("同时写宽高（高级）", 2)
        self._a_world_mode.setEnabled(False)
        f.addRow("世界尺寸", self._a_world_mode)
        self._a_ww = QSpinBox()
        self._a_ww.setRange(1, 9999)
        self._a_ww.setReadOnly(True)
        self._a_ww.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("worldWidth", self._a_ww)
        self._a_wh = QSpinBox()
        self._a_wh.setRange(1, 9999)
        self._a_wh.setReadOnly(True)
        self._a_wh.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        f.addRow("worldHeight", self._a_wh)
        dl.addLayout(f)

        dl.addWidget(QLabel("<b>States（只读）</b>"))
        self._state_table = QTableWidget(0, 4)
        self._state_table.setHorizontalHeaderLabels(
            ["name", "frames", "frameRate", "loop"])
        self._state_table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self._state_table.verticalHeader().setDefaultSectionSize(32)
        self._state_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._state_table.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        dl.addWidget(self._state_table)

        self._state_table.itemSelectionChanged.connect(self._on_state_selection_changed)

        dl.addWidget(
            QLabel("<b>状态动画预览</b>（选中表格行即播该 state）")
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
        self._preview_timer.setTimerType(Qt.TimerType.CoarseTimer)
        self._preview_timer.timeout.connect(self._advance_preview_frame)
        self._preview_elapsed = QElapsedTimer()
        self._preview_accum: float = 0.0
        self._sheet_pixmap: QPixmap | None = None
        self._sheet_cache_key: str = ""
        self._preview_seq_i: int = 0
        self._preview_frames: list[int] = []

        prev_btn = QPushButton("刷新当前包图集预览")
        prev_btn.setToolTip(
            "仅从磁盘重载当前包目录下的图集 PNG；若 anim.json 有变请先点「从磁盘重载全部动画」。"
        )
        prev_btn.clicked.connect(self._refresh_preview)
        dl.addWidget(prev_btn)
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([260, 760])
        root.addWidget(splitter)
        self._model.data_changed.connect(self._on_model_data_changed)
        self._refresh()

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "animation":
            return
        keep = self._current_key
        self._list.blockSignals(True)
        self._list.clear()
        for k in sorted(self._model.animations.keys()):
            self._list.addItem(k)
        self._list.blockSignals(False)
        if keep and keep in self._model.animations:
            self._select_stem(keep)
            self._on_select(keep)
        elif self._list.count() > 0:
            self._list.setCurrentRow(0)
        else:
            self._clear_detail()

    def _open_video_atlas_detached(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "提示", "请先通过「打开工程」加载游戏项目目录。")
            return
        root = self._model.project_path.resolve()
        vta_dir = (root / "tools" / "video_to_atlas").resolve()
        main_py = vta_dir / "main.py"
        if not main_py.is_file():
            QMessageBox.warning(
                self, "未找到工具",
                f"未找到视频动画工具入口：\n{main_py}",
            )
            return
        argv = [str(main_py)]
        ws = (root / "editor_data" / "animation").resolve()
        if ws.is_dir() and (ws / "project.json").is_file():
            argv.append(str(ws))
        ok = QProcess.startDetached(
            sys.executable,
            argv,
            str(vta_dir),
        )
        if not ok:
            QMessageBox.warning(
                self, "启动失败",
                "无法以独立进程启动视频动画工具（请检查 Python 与路径）。",
            )

    def _reload_all_animations_from_disk(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "提示", "请先打开工程。")
            return
        self._model.reload_animations_from_disk()

    def _manifest_url(self, bundle_id: str) -> str:
        return f"/assets/animation/{bundle_id}/anim.json"

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
        self._lbl_disk.clear()
        self._a_stem.clear()
        self._a_sheet.clear()
        self._a_cols.setValue(1)
        self._a_rows.setValue(1)
        self._a_cell_w.setValue(0)
        self._a_cell_h.setValue(0)
        self._a_world_mode.setCurrentIndex(0)
        self._a_ww.setValue(100)
        self._a_wh.setValue(160)
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
        man = self._manifest_url(key)
        if self._model.project_path:
            rel = Path("public") / PurePosixPath(man.strip().lstrip("/"))
            self._lbl_disk.setText(str(self._model.project_path / rel))
        else:
            self._lbl_disk.setText(man)
        self._a_stem.setText(key)
        self._a_sheet.setText(str(a.get("spritesheet", "")))
        self._a_cols.setValue(int(a.get("cols", 1)))
        self._a_rows.setValue(int(a.get("rows", 1)))
        cw0 = int(a.get("cellWidth", 0) or 0)
        ch0 = int(a.get("cellHeight", 0) or 0)
        self._a_cell_w.setValue(cw0 if cw0 > 0 else 0)
        self._a_cell_h.setValue(ch0 if ch0 > 0 else 0)
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

        self._clear_state_rows()
        states = a.get("states", {})
        if not isinstance(states, dict):
            states = {}
        for sname, sdef in states.items():
            if not isinstance(sdef, dict):
                sdef = {}
            r = self._state_table.rowCount()
            self._state_table.insertRow(r)
            frames = sdef.get("frames", [0])
            ft = self._frames_to_cell_text(frames)
            rate = int(sdef.get("frameRate", 8))
            loop = bool(sdef.get("loop", True))
            self._state_table.setItem(r, 0, QTableWidgetItem(str(sname)))
            self._state_table.setItem(r, 1, QTableWidgetItem(ft))
            self._state_table.setItem(r, 2, QTableWidgetItem(str(max(1, rate))))
            self._state_table.setItem(
                r, 3, QTableWidgetItem("是" if loop else "否"))
        if self._state_table.rowCount() > 0:
            self._state_table.selectRow(0)
        self._refresh_preview()

    def _frames_to_cell_text(self, frames: object) -> str:
        if isinstance(frames, list):
            return ",".join(str(int(x)) for x in frames)
        return "0"

    def _parse_frames_from_cell(
        self, item: QTableWidgetItem | None, *, quiet: bool = True
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
                return [] if quiet else [0]
        return out if out else [0]

    def _refresh_preview(self) -> None:
        self._sheet_pixmap = None
        self._sheet_cache_key = ""
        if self._model.project_path is None or not self._current_key:
            self._update_atlas_full_label()
            return
        sheet_path = self._a_sheet.text().strip()
        if not sheet_path:
            self._set_atlas_full_placeholder("(未设置 spritesheet)")
            self._lbl_atlas_meta.setText("")
            self._set_frame_preview_placeholder("(未设置 spritesheet)")
            self._restart_preview_animation()
            return
        man = self._manifest_url(self._current_key)
        full = _spritesheet_disk(self._model.project_path, man, sheet_path)
        if full and full.is_file():
            pm = QPixmap(str(full))
            if not pm.isNull():
                self._sheet_pixmap = pm
                self._sheet_cache_key = sheet_path
                self._update_atlas_full_label()
                self._restart_preview_animation()
                return
        self._set_atlas_full_placeholder(
            f"无法加载: {sheet_path}\n解析路径: {full}")
        self._lbl_atlas_meta.setText("")
        self._set_frame_preview_placeholder(f"无法加载图集")
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
        stride_w, stride_h = _effective_cell_stride(
            cols, rows, self._sheet_pixmap,
            self._a_cell_w.value(), self._a_cell_h.value(),
        )
        af_n = 0
        if self._current_key and self._current_key in self._model.animations:
            af = self._model.animations[self._current_key].get("atlasFrames")
            if isinstance(af, list):
                af_n = len(af)
        af_hint = f"  ·  atlasFrames {af_n} 项" if af_n else ""
        self._lbl_atlas_meta.setText(
            f"原图 {w}×{h} px  ·网格 {cols}×{rows}  ·  单格步进 {stride_w}×{stride_h} px{af_hint}"
        )

    def _stop_preview_timer(self) -> None:
        self._preview_timer.stop()

    def _on_state_selection_changed(self) -> None:
        self._restart_preview_animation()

    def _gather_row_preview(self, row: int) -> tuple[str, list[int], float, bool] | None:
        if row < 0 or row >= self._state_table.rowCount():
            return None
        name_item = self._state_table.item(row, 0)
        frames_item = self._state_table.item(row, 1)
        name = name_item.text().strip() if name_item else ""
        frames = self._parse_frames_from_cell(frames_item, quiet=True)
        if not frames:
            frames = [0]
        rate_item = self._state_table.item(row, 2)
        try:
            raw = (rate_item.text() if rate_item else "").strip()
            rate = float(raw) if raw else 8.0
        except ValueError:
            rate = 8.0
        rate = max(1e-6, float(rate))
        loop_item = self._state_table.item(row, 3)
        loop_b = True
        if loop_item:
            t = loop_item.text().strip()
            loop_b = t in ("是", "true", "True", "1", "yes", "Yes")
        return (name or f"row{row}", frames, float(rate), loop_b)

    def _atlas_crop(self, atlas_index: int) -> QPixmap | None:
        if self._sheet_pixmap is None or self._sheet_pixmap.isNull():
            return None
        cols = max(1, self._a_cols.value())
        rows = max(1, self._a_rows.value())
        pw = self._sheet_pixmap.width()
        ph = self._sheet_pixmap.height()
        stride_w, stride_h = _effective_cell_stride(
            cols, rows, self._sheet_pixmap,
            self._a_cell_w.value(), self._a_cell_h.value(),
        )
        sw, sh = stride_w, stride_h
        if self._current_key and self._current_key in self._model.animations:
            af = self._model.animations[self._current_key].get("atlasFrames")
            if isinstance(af, list) and 0 <= atlas_index < len(af):
                b = af[atlas_index]
                if isinstance(b, dict):
                    bw = int(b.get("width", 0) or 0)
                    bh = int(b.get("height", 0) or 0)
                    if bw > 0:
                        sw = bw
                    if bh > 0:
                        sh = bh
        col = atlas_index % cols
        row = atlas_index // cols
        if col >= cols or row >= rows:
            return None
        x = col * stride_w
        y = row * stride_h
        if x + sw > pw or y + sh > ph:
            return None
        rect = QRect(x, y, sw, sh)
        return self._sheet_pixmap.copy(rect)

    def _show_cropped_scaled(
        self, cropped: QPixmap | None, *, fast_scale: bool = False
    ) -> None:
        if cropped is None or cropped.isNull():
            self._set_frame_preview_placeholder("(无法切帧：检查 cols/rows 与帧索引)")
            return
        mode = (
            Qt.TransformationMode.FastTransformation
            if fast_scale
            else Qt.TransformationMode.SmoothTransformation
        )
        scaled = cropped.scaled(
            _FRAME_PREV_MAX_W,
            _FRAME_PREV_MAX_H,
            Qt.AspectRatioMode.KeepAspectRatio,
            mode,
        )
        self._preview.setPixmap(scaled)
        self._preview.setFixedSize(scaled.size())
        self._preview.setText("")

    def _restart_preview_animation(self) -> None:
        self._stop_preview_timer()
        self._preview_accum = 0.0
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
        theory_ms = max(1, int(round(1000.0 / float(rate))))
        if not self._chk_preview_play.isChecked() or len(frames) <= 1:
            self._update_preview_info(name, len(frames), 0)
            return
        self._update_preview_info(name, len(frames), theory_ms)
        self._preview_elapsed.start()
        self._preview_timer.start(_preview_poll_interval_ms(float(rate)))

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
        dt = self._preview_elapsed.restart() / 1000.0
        if dt < 0:
            dt = 0.0
        dt = min(dt, _PREVIEW_MAX_DT_SEC)
        self._preview_accum += dt
        step = 1.0 / float(max(1e-6, rate))
        theory_ms = max(1, int(round(1000.0 / float(rate))))
        changed = False
        while self._preview_accum >= step:
            self._preview_accum -= step
            self._preview_seq_i += 1
            if self._preview_seq_i >= len(frames):
                if loop:
                    self._preview_seq_i = 0
                else:
                    self._preview_seq_i = len(frames) - 1
                    self._stop_preview_timer()
                    crop = self._atlas_crop(frames[self._preview_seq_i])
                    self._show_cropped_scaled(crop, fast_scale=False)
                    self._update_preview_info(name, len(frames), 0)
                    return
            changed = True
        if changed:
            crop = self._atlas_crop(frames[self._preview_seq_i])
            self._show_cropped_scaled(crop, fast_scale=True)
            self._update_preview_info(name, len(frames), theory_ms)
