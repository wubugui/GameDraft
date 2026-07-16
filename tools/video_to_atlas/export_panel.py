"""Export workbench: per-job parameters, single/merged export."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .atlas_core import (
    build_atlas_native_equal_cells,
    export_gamedraft_anim,
    export_gamedraft_anim_multi,
    save_outputs,
    scale_bgra_uniform,
)
from .workspace_model import AnimationClip, ExportJob, Workspace, new_id

_SAFE_DIR_RE = re.compile(r'[<>:"/\\|?*]')

# 与动画包约定一致，写入 anim.json
_SPRITESHEET_REL = "atlas.png"


def _safe_bundle_dir(name: str) -> str:
    s = (name or "clip").strip()
    s = _SAFE_DIR_RE.sub("_", s)
    s = s.strip(" .")
    return s or "clip"


def _game_public_animation_dir() -> Path:
    """GameDraft 仓库内 ``public/resources/runtime/animation``（统一从 :class:`ProjectPaths` 拿）。"""
    from tools.editor.shared.project_paths import ProjectPaths
    return ProjectPaths(Path(__file__).resolve().parents[2]).runtime_animation_dir


def _fmt_world(v: Optional[float]) -> str:
    if v is None or v <= 0:
        return "自动"
    return str(int(round(v)))


def _export_world_wh_for_job(job: ExportJob) -> tuple[Optional[float], Optional[float]]:
    """按该行 WW/WH：仅宽、仅高、两者或皆自动（皆空则交给 apply_anim_json 默认）。"""
    ww = job.world_w
    wh = job.world_h
    has_w = ww is not None and ww > 0
    has_h = wh is not None and wh > 0
    if has_w and has_h:
        return ww, wh
    if has_w:
        return ww, None
    if has_h:
        return None, wh
    return None, None


class ExportPanel(QWidget):
    """Export workbench widget for the main window."""

    def __init__(self, workspace: Workspace, parent=None) -> None:
        super().__init__(parent)
        self._ws = workspace
        self._autosave_cb: Optional[Callable[[], None]] = None
        self._build_ui()

    def set_autosave_callback(self, cb: Optional[Callable[[], None]]) -> None:
        """工作区已打开目录时，列表/参数变更后写回 project.json。"""
        self._autosave_cb = cb

    def set_workspace(self, ws: Workspace) -> None:
        self._ws = ws
        self.refresh()

    def _touch_persist(self) -> None:
        if self._autosave_cb:
            self._autosave_cb()

    def _on_global_export_changed(self) -> None:
        self._sync_settings_to_ws()
        self._touch_persist()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        hl_top = QHBoxLayout()
        self.btn_add = QPushButton("添加动画到导出列表...")
        self.btn_add.clicked.connect(self._add_jobs)
        hl_top.addWidget(self.btn_add)
        self.btn_remove = QPushButton("移除选中行")
        self.btn_remove.clicked.connect(self._remove_selected)
        hl_top.addWidget(self.btn_remove)
        hl_top.addStretch()
        root.addLayout(hl_top)

        root.addWidget(QLabel(
            "列表左侧勾选 = 参与「合并导出」；参数变更在已打开工作区时会自动保存到 project.json。"
        ))
        self.job_list = QListWidget()
        self.job_list.setMinimumHeight(120)
        self.job_list.setMaximumHeight(260)
        self.job_list.currentItemChanged.connect(self._on_job_selected)
        self.job_list.itemChanged.connect(self._on_job_item_changed)
        root.addWidget(self.job_list)

        self._detail_group = QGroupBox("导出参数（选中行）")
        form = QFormLayout(self._detail_group)
        self.sp_scale = QDoubleSpinBox()
        self.sp_scale.setRange(0.05, 4.0)
        self.sp_scale.setDecimals(3)
        self.sp_scale.setValue(1.0)
        self.sp_scale.valueChanged.connect(self._sync_job_params)
        form.addRow("分辨率缩放", self.sp_scale)
        self.sp_padding = QSpinBox()
        self.sp_padding.setRange(0, 128)
        self.sp_padding.setValue(4)
        self.sp_padding.valueChanged.connect(self._sync_job_params)
        form.addRow("单元格内边距", self.sp_padding)
        self.sp_feather = QSpinBox()
        self.sp_feather.setRange(0, 64)
        self.sp_feather.setValue(0)
        self.sp_feather.valueChanged.connect(self._sync_job_params)
        form.addRow("feather ignore px", self.sp_feather)
        self.sp_world_w = QSpinBox()
        self.sp_world_w.setRange(0, 9999)
        self.sp_world_w.setValue(100)
        self.sp_world_w.setSpecialValueText("自动")
        self.sp_world_w.valueChanged.connect(self._sync_job_params)
        form.addRow("worldWidth（0=自动）", self.sp_world_w)
        self.sp_world_h = QSpinBox()
        self.sp_world_h.setRange(0, 9999)
        self.sp_world_h.setValue(80)
        self.sp_world_h.setSpecialValueText("自动")
        self.sp_world_h.valueChanged.connect(self._sync_job_params)
        form.addRow("worldHeight（0=自动）", self.sp_world_h)
        root.addWidget(self._detail_group)

        gb_global = QGroupBox("工作区级导出设置")
        fg = QFormLayout(gb_global)
        # 帧编号固定从 0 开始：运行时 SpriteEntity 直接以 frames[i] 作为图集线性槽位
        # （col=idx%cols, row=idx//cols）且按同一索引取 atlasFrames，从不减基准；
        # 1 基会整体错位一格（丢首帧、尾部多空帧），故不再暴露该选项。
        lbl_base = QLabel("帧编号从 0 开始（与运行时一致，固定）")
        lbl_base.setStyleSheet("color:#888;")
        fg.addRow("帧索引基准", lbl_base)
        self.cb_meta = QCheckBox("同时写出 .meta.json")
        self.cb_meta.setChecked(True)
        self.cb_meta.toggled.connect(self._on_global_export_changed)
        fg.addRow(self.cb_meta)
        self.cb_dedup = QCheckBox("合并导出时复用相同帧")
        self.cb_dedup.setChecked(True)
        self.cb_dedup.toggled.connect(self._on_global_export_changed)
        fg.addRow(self.cb_dedup)
        root.addWidget(gb_global)

        hl_btn = QHBoxLayout()
        self.btn_export_single = QPushButton("分别导出...")
        self.btn_export_single.clicked.connect(self._export_single)
        hl_btn.addWidget(self.btn_export_single)
        self.btn_export_merge = QPushButton("合并导出（仅已勾选行）...")
        self.btn_export_merge.clicked.connect(self._export_merge)
        hl_btn.addWidget(self.btn_export_merge)
        hl_btn.addStretch()
        root.addLayout(hl_btn)

        self.lbl_status = QLabel("")
        self.lbl_status.setWordWrap(True)
        root.addWidget(self.lbl_status)

    def refresh(self) -> None:
        self._sync_settings_from_ws()
        self._refresh_list()

    def _sync_settings_from_ws(self) -> None:
        s = self._ws.settings
        self.cb_meta.setChecked(s.save_meta)
        self.cb_dedup.setChecked(s.dedup_merge)

    def _sync_settings_to_ws(self) -> None:
        s = self._ws.settings
        # frame_index_base 不再由 UI 控制；保留 project.json 中既有值（导出固定用 0）
        s.save_meta = self.cb_meta.isChecked()
        s.dedup_merge = self.cb_dedup.isChecked()

    def _job_label(self, job: ExportJob, clip: AnimationClip | None) -> str:
        name = clip.name if clip else f"[missing {job.clip_id[:8]}]"
        n = len(clip.slots) if clip else 0
        return (
            f"{name}  ·  {n}帧  ·  scale={job.scale:g}  ·  pad={job.padding}  ·  "
            f"fthr={job.feather_ignore_px}  ·  W={_fmt_world(job.world_w)}  ·  "
            f"H={_fmt_world(job.world_h)}"
        )

    def _refresh_list(self) -> None:
        self.job_list.blockSignals(True)
        self.job_list.clear()
        for job in self._ws.export_jobs:
            clip = self._ws.clip_by_id(job.clip_id)
            it = QListWidgetItem(self._job_label(job, clip))
            it.setFlags(
                it.flags()
                | Qt.ItemFlag.ItemIsUserCheckable
                | Qt.ItemFlag.ItemIsEnabled
                | Qt.ItemFlag.ItemIsSelectable
            )
            it.setCheckState(
                Qt.CheckState.Checked
                if job.include_in_merge
                else Qt.CheckState.Unchecked
            )
            it.setData(Qt.ItemDataRole.UserRole, job.id)
            self.job_list.addItem(it)
        self.job_list.blockSignals(False)

    def _refresh_list_preserving_selection(self) -> None:
        cur_jid: Optional[str] = None
        row_it = self.job_list.currentItem()
        if row_it is not None:
            cur_jid = row_it.data(Qt.ItemDataRole.UserRole)
        self._refresh_list()
        if cur_jid:
            for i in range(self.job_list.count()):
                it = self.job_list.item(i)
                if it is not None and it.data(Qt.ItemDataRole.UserRole) == cur_jid:
                    self.job_list.setCurrentRow(i)
                    break

    def _on_job_item_changed(self, item: QListWidgetItem) -> None:
        jid = item.data(Qt.ItemDataRole.UserRole)
        for j in self._ws.export_jobs:
            if j.id == jid:
                j.include_in_merge = item.checkState() == Qt.CheckState.Checked
                self._touch_persist()
                break

    def _current_job(self) -> Optional[ExportJob]:
        it = self.job_list.currentItem()
        if it is None:
            return None
        jid = it.data(Qt.ItemDataRole.UserRole)
        for j in self._ws.export_jobs:
            if j.id == jid:
                return j
        return None

    def _on_job_selected(self) -> None:
        job = self._current_job()
        if job is None:
            return
        self.sp_scale.blockSignals(True)
        self.sp_padding.blockSignals(True)
        self.sp_feather.blockSignals(True)
        self.sp_world_w.blockSignals(True)
        self.sp_world_h.blockSignals(True)
        self.sp_scale.setValue(job.scale)
        self.sp_padding.setValue(job.padding)
        self.sp_feather.setValue(job.feather_ignore_px)
        self.sp_world_w.setValue(int(job.world_w) if job.world_w else 0)
        self.sp_world_h.setValue(int(job.world_h) if job.world_h else 0)
        self.sp_scale.blockSignals(False)
        self.sp_padding.blockSignals(False)
        self.sp_feather.blockSignals(False)
        self.sp_world_w.blockSignals(False)
        self.sp_world_h.blockSignals(False)

    def _sync_job_params(self) -> None:
        job = self._current_job()
        if job is None:
            return
        job.scale = float(self.sp_scale.value())
        job.padding = int(self.sp_padding.value())
        job.feather_ignore_px = int(self.sp_feather.value())
        ww = int(self.sp_world_w.value())
        wh = int(self.sp_world_h.value())
        job.world_w = float(ww) if ww > 0 else None
        job.world_h = float(wh) if wh > 0 else None
        self._refresh_list_preserving_selection()
        self._touch_persist()

    def _add_jobs(self) -> None:
        if not self._ws.clips:
            QMessageBox.information(self, "提示", "没有动画序列可添加")
            return
        existing_clip_ids = {j.clip_id for j in self._ws.export_jobs}
        added = 0
        for clip in self._ws.clips:
            if clip.id not in existing_clip_ids:
                job = ExportJob(id=new_id(), clip_id=clip.id)
                self._ws.add_export_job(job)
                added += 1
        if added == 0:
            QMessageBox.information(self, "提示", "所有动画已在导出列表中")
        self._refresh_list()
        self._touch_persist()

    def _remove_selected(self) -> None:
        job = self._current_job()
        if job:
            self._ws.remove_export_job(job.id)
            self._refresh_list()
            self._touch_persist()

    def _default_out_dir(self) -> str:
        p = _game_public_animation_dir()
        p.mkdir(parents=True, exist_ok=True)
        return str(p)

    def _existing_bundle_ids(self) -> List[str]:
        """已存在的动画包目录名（public/resources/runtime/animation/<id>/）。"""
        root = _game_public_animation_dir()
        if not root.is_dir():
            return []
        return sorted(p.name for p in root.iterdir() if p.is_dir())

    def _ask_merge_bundle_id(self) -> Optional[str]:
        """选/输入合并导出的动画包 ID。返回规整后的 id；取消/空则 None。

        免去手动找目录：固定写到 public/resources/runtime/animation/<id>/，
        既不会导到工程外成孤儿，也方便选已有包直接更新。
        """
        existing = self._existing_bundle_ids()
        label = (
            "动画包 ID（目录名）——固定写到 public/resources/runtime/animation/<id>/。\n"
            "命名约定 <角色>_anim（如 npc_foo_anim）：\n"
            "· 选已有 = 更新该角色（覆盖其图集与 anim.json）\n"
            "· 直接输入新名 = 新建动画包"
        )
        if existing:
            text, ok = QInputDialog.getItem(
                self, "合并导出 — 动画包 ID", label, existing, 0, True)
        else:
            text, ok = QInputDialog.getText(
                self, "合并导出 — 动画包 ID", label)
        if not ok:
            return None
        raw = (text or "").strip()
        if not raw:
            QMessageBox.warning(self, "提示", "动画包 ID 不能为空。")
            return None
        safe = _safe_bundle_dir(raw)
        if safe != raw:
            if QMessageBox.question(
                self, "名称已规整",
                f"动画包 ID 含目录非法字符，已规整为「{safe}」。继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            ) != QMessageBox.StandardButton.Yes:
                return None
        return safe

    def _export_single(self) -> None:
        self._sync_settings_to_ws()
        if not self._ws.export_jobs:
            QMessageBox.warning(self, "提示", "导出列表为空")
            return
        base_dir = QFileDialog.getExistingDirectory(
            self, "选择导出根目录", self._default_out_dir())
        if not base_dir:
            return
        base = 0  # 运行时按 0 基线性槽位解释 frames；不再可配
        exported = 0
        errors: List[str] = []
        for job in self._ws.export_jobs:
            clip = self._ws.clip_by_id(job.clip_id)
            if clip is None:
                errors.append(f"[missing clip {job.clip_id[:8]}]")
                continue
            missing = self._ws.validate_clip(clip)
            if missing:
                errors.append(f"{clip.name}: {len(missing)} 个缺失帧")
                continue
            try:
                rgba_list = self._ws.resolve_for_export(clip.slots)
            except KeyError as e:
                errors.append(f"{clip.name}: {e}")
                continue
            if abs(job.scale - 1.0) > 1e-6:
                rgba_list = [scale_bgra_uniform(r, job.scale) for r in rgba_list]
            times = [self._ws.frame_by_id(s.frame_id).t_sec
                     for s in clip.slots
                     if self._ws.frame_by_id(s.frame_id) is not None]
            atlas, meta = build_atlas_native_equal_cells(
                rgba_list, padding=job.padding,
                feather_ignore_px=job.feather_ignore_px,
                frame_index_base=base,
                export_fps=clip.frame_rate,
                frame_times=times or [0.0] * len(rgba_list))
            ew, eh = _export_world_wh_for_job(job)
            anim = export_gamedraft_anim(
                meta, _SPRITESHEET_REL, ew, eh, clip.name, clip.loop,
                frame_rate=clip.frame_rate)
            out_dir = Path(base_dir) / _safe_bundle_dir(clip.name)
            out_dir.mkdir(parents=True, exist_ok=True)
            out_png = out_dir / "atlas.png"
            out_meta = out_dir / "atlas.meta.json"
            out_anim = out_dir / "anim.json"
            save_outputs(atlas, meta, out_png,
                         out_meta if self.cb_meta.isChecked() else None,
                         anim, out_anim)
            exported += 1
        msg = f"已导出 {exported} 个动画到 {base_dir}"
        if errors:
            msg += f"\n跳过：\n" + "\n".join(errors)
        self.lbl_status.setText(msg)

    def _export_merge(self) -> None:
        self._sync_settings_to_ws()
        merge_jobs = [j for j in self._ws.export_jobs if j.include_in_merge]
        if not merge_jobs:
            QMessageBox.warning(
                self, "提示", "没有勾选任何导出行：请在列表左侧勾选要合并的动画。")
            return
        bundle_id = self._ask_merge_bundle_id()
        if bundle_id is None:
            return
        out_dir = _game_public_animation_dir() / bundle_id
        if out_dir.exists():
            overwrite_meta = "（及 atlas.meta.json）" if self.cb_meta.isChecked() else ""
            if QMessageBox.question(
                self, "覆盖确认",
                f"动画包「{bundle_id}」已存在，将覆盖其 atlas.png / anim.json"
                f"{overwrite_meta}。继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            ) != QMessageBox.StandardButton.Yes:
                return
        base = 0  # 运行时按 0 基线性槽位解释 frames；不再可配
        dedup = self.cb_dedup.isChecked()

        all_cells: List[np.ndarray] = []
        id_to_cell: Dict[str, int] = {}
        states_spec: Dict[str, Dict[str, Any]] = {}

        first_job = merge_jobs[0]
        merge_padding = first_job.padding
        merge_feather = first_job.feather_ignore_px

        for job in merge_jobs:
            clip = self._ws.clip_by_id(job.clip_id)
            if clip is None:
                continue
            missing = self._ws.validate_clip(clip)
            if missing:
                QMessageBox.warning(self, "校验失败",
                                    f"{clip.name} 有 {len(missing)} 个缺失帧")
                return
            try:
                rgba_list = self._ws.resolve_for_export(clip.slots)
            except KeyError as e:
                QMessageBox.critical(self, "错误", str(e))
                return
            if abs(job.scale - 1.0) > 1e-6:
                rgba_list = [scale_bgra_uniform(r, job.scale) for r in rgba_list]

            indices: List[int] = []
            for i, slot in enumerate(clip.slots):
                fid = slot.frame_id
                if dedup and fid in id_to_cell:
                    indices.append(base + id_to_cell[fid])
                else:
                    cell_i = len(all_cells)
                    all_cells.append(rgba_list[i])
                    if dedup:
                        id_to_cell[fid] = cell_i
                    indices.append(base + cell_i)
            states_spec[clip.name] = {
                "frames": indices,
                "frameRate": clip.frame_rate,
                "loop": clip.loop,
            }

        if not all_cells:
            QMessageBox.warning(self, "提示", "没有可导出的帧")
            return

        atlas, meta = build_atlas_native_equal_cells(
            all_cells, padding=merge_padding, feather_ignore_px=merge_feather,
            frame_index_base=base, export_fps=12.0,
            frame_times=[0.0] * len(all_cells))

        ew, eh = _export_world_wh_for_job(first_job)
        anim = export_gamedraft_anim_multi(
            meta, _SPRITESHEET_REL, ew, eh, states_spec)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_png = out_dir / "atlas.png"
        out_meta = out_dir / "atlas.meta.json"
        out_anim = out_dir / "anim.json"
        save_outputs(atlas, meta, out_png,
                     out_meta if self.cb_meta.isChecked() else None,
                     anim, out_anim)
        self.lbl_status.setText(
            f"已合并导出（{len(merge_jobs)} 个动画）→ 动画包「{bundle_id}」\n"
            f"{out_dir}\n图集边距取首条勾选：pad={merge_padding} fthr={merge_feather}\n"
            f"回主编辑器点「重载动画」同步。")
