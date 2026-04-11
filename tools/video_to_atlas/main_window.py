"""Main workspace window: single scrollable workflow."""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Set

import cv2
import numpy as np
from PySide6.QtCore import QModelIndex, QSize, Qt, QSettings, QTimer, QAbstractListModel
from PySide6.QtGui import (
    QAction,
    QColor,
    QIcon,
    QImage,
    QKeySequence,
    QPixmap,
)
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListView,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QMenuBar,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QSpinBox,
    QSplitter,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QVBoxLayout,
    QWidget,
)

from workspace_model import (
    AnimationClip,
    ExportJob,
    FrameItem,
    SlotRef,
    VideoSource,
    Workspace,
    make_animation_clip,
    new_id,
)
from frame_sequence_player import FrameSequencePlayer
from frame_viewer import FrameViewerDialog
from import_dialog import ImportDialog
from export_panel import ExportPanel

_THUMB = 64
_SETTINGS_ORG = "GameDraft"
_SETTINGS_APP = "VideoToAtlas"
_SETTINGS_LAST_WS = "lastWorkspacePath"


# ---------------------------------------------------------------------------
# Frame grid model + delegate (virtual, no per-widget overhead)
# ---------------------------------------------------------------------------

class _FrameListModel(QAbstractListModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._ids: List[str] = []
        self._ws: Optional[Workspace] = None
        self._head: int = -1
        self._tail: int = -1

    def set_data(self, ws: Workspace, ids: List[str],
                 head: int = -1, tail: int = -1) -> None:
        self.beginResetModel()
        self._ws = ws
        self._ids = list(ids)
        self._head = head
        self._tail = tail
        self.endResetModel()

    def update_range(self, head: int, tail: int) -> None:
        old_h, old_t = self._head, self._tail
        self._head = head
        self._tail = tail
        lo = min(old_h, old_t, head, tail, 0)
        hi = max(old_h, old_t, head, tail, len(self._ids) - 1)
        lo = max(0, lo)
        hi = min(len(self._ids) - 1, hi)
        if lo <= hi:
            self.dataChanged.emit(self.index(lo), self.index(hi))

    def rowCount(self, parent=None) -> int:
        return len(self._ids)

    def data(self, index: QModelIndex, role: int = Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        i = index.row()
        if role == Qt.ItemDataRole.DecorationRole:
            return self._get_thumb(i)
        if role == Qt.ItemDataRole.ToolTipRole:
            fid = self._ids[i]
            item = self._ws.frame_by_id(fid) if self._ws else None
            t = f"t={item.t_sec:.3f}s" if item else "[missing]"
            return f"#{i}  {fid[:8]}  {t}"
        if role == Qt.ItemDataRole.UserRole:
            return self._ids[i] if i < len(self._ids) else None
        return None

    def _get_thumb(self, i: int) -> Optional[QPixmap]:
        if self._ws is None or i >= len(self._ids):
            return None
        fid = self._ids[i]
        if self._ws.dir_path:
            tp = self._ws.dir_path / "thumbnails" / f"{fid}.png"
            if tp.exists():
                pix = QPixmap(str(tp))
                if not pix.isNull():
                    return pix.scaled(_THUMB, _THUMB,
                                      Qt.AspectRatioMode.KeepAspectRatio,
                                      Qt.TransformationMode.SmoothTransformation)
        item = self._ws.frame_by_id(fid)
        if item is None:
            pm = QPixmap(_THUMB, _THUMB)
            pm.fill(QColor(80, 20, 20))
            return pm
        from atlas_core import bgra_to_bgr_preview
        bgr = bgra_to_bgr_preview(item.rgba)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        rgb = np.ascontiguousarray(rgb)
        h, w = rgb.shape[:2]
        qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
        pix = QPixmap.fromImage(qimg)
        return pix.scaled(_THUMB, _THUMB,
                          Qt.AspectRatioMode.KeepAspectRatio,
                          Qt.TransformationMode.SmoothTransformation)


class _FrameDelegate(QStyledItemDelegate):
    def __init__(self, model: _FrameListModel, parent=None):
        super().__init__(parent)
        self._model = model

    def paint(self, painter, option: QStyleOptionViewItem, index: QModelIndex):
        super().paint(painter, option, index)
        i = index.row()
        head = self._model._head
        tail = self._model._tail
        lo = min(head, tail) if head >= 0 and tail >= 0 else -1
        hi = max(head, tail) if head >= 0 and tail >= 0 else -1
        if lo <= i <= hi and lo >= 0:
            if i == head:
                color = QColor(68, 136, 255, 180)
            elif i == tail:
                color = QColor(204, 119, 34, 180)
            else:
                color = QColor(51, 153, 51, 120)
            painter.save()
            pen = painter.pen()
            pen.setColor(color)
            pen.setWidth(3)
            painter.setPen(pen)
            painter.drawRect(option.rect.adjusted(1, 1, -2, -2))
            painter.restore()

    def sizeHint(self, option, index) -> QSize:
        return QSize(_THUMB + 8, _THUMB + 8)


# ---------------------------------------------------------------------------
# MainWindow
# ---------------------------------------------------------------------------

class MainWindow(QWidget):
    def __init__(self, initial_workspace: Optional[Path] = None) -> None:
        super().__init__()
        self.setWindowTitle("Video-to-Atlas Workspace")
        self.resize(1200, 900)

        self._ws = Workspace()
        self._head_idx: int = -1
        self._tail_idx: int = -1
        self._active_clip_id: Optional[str] = None

        self._range_player = FrameSequencePlayer(self)
        self._clip_player = FrameSequencePlayer(self)

        self._build_ui()
        loaded = False
        if initial_workspace is not None:
            p = Path(initial_workspace)
            if p.is_dir() and (p / "project.json").is_file():
                try:
                    self._ws = Workspace.load_workspace(p)
                    self._export_panel.set_workspace(self._ws)
                    self._head_idx = -1
                    self._tail_idx = -1
                    self._active_clip_id = None
                    self._refresh_all()
                    self._remember_workspace_path(p)
                    self.lbl_status.setText(f"已打开工作区：{p}")
                    loaded = True
                except Exception as e:
                    self.lbl_status.setText(f"无法加载指定工作区（{p}）：{e}")
        if not loaded:
            if not self._try_restore_last_workspace():
                self._refresh_all()

    def _workspace_settings(self) -> QSettings:
        return QSettings(_SETTINGS_ORG, _SETTINGS_APP)

    def _remember_workspace_path(self, path: Path) -> None:
        try:
            resolved = str(path.resolve())
        except OSError:
            resolved = str(path)
        s = self._workspace_settings()
        s.setValue(_SETTINGS_LAST_WS, resolved)
        s.sync()

    def _try_restore_last_workspace(self) -> bool:
        s = self._workspace_settings()
        raw = s.value(_SETTINGS_LAST_WS)
        if not raw:
            return False
        p = Path(str(raw))
        if not p.is_dir() or not (p / "project.json").is_file():
            s.remove(_SETTINGS_LAST_WS)
            s.sync()
            return False
        try:
            self._ws = Workspace.load_workspace(p)
        except Exception as e:
            self.lbl_status.setText(f"无法加载上次工作区（{p}）：{e}")
            return False
        self._head_idx = -1
        self._tail_idx = -1
        self._active_clip_id = None
        self._export_panel.set_workspace(self._ws)
        self._refresh_all()
        self.lbl_status.setText(f"已自动打开上次工作区：{p}")
        return True

    # -----------------------------------------------------------------------
    # UI construction
    # -----------------------------------------------------------------------

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)

        menubar = QMenuBar()
        root.setMenuBar(menubar)

        m_file = menubar.addMenu("文件")
        m_file.addAction("新建工作区", self._new_workspace, QKeySequence("Ctrl+N"))
        m_file.addAction("打开工作区...", self._open_workspace, QKeySequence("Ctrl+O"))
        m_file.addAction("保存工作区", self._save_workspace, QKeySequence("Ctrl+S"))
        m_file.addAction("另存为...", self._save_workspace_as, QKeySequence("Ctrl+Shift+S"))

        m_import = menubar.addMenu("导入")
        m_import.addAction("新建导入...", self._import_new)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        panel = QWidget()
        flow = QVBoxLayout(panel)
        flow.setContentsMargins(6, 6, 6, 6)
        scroll.setWidget(panel)
        root.addWidget(scroll, 1)

        # == Section 1: Material library ==
        gb_lib = QGroupBox("素材库")
        v_lib = QVBoxLayout(gb_lib)

        hl_vid = QHBoxLayout()
        hl_vid.addWidget(QLabel("视频列表:"))
        self.list_videos = QListWidget()
        self.list_videos.setMaximumHeight(120)
        self.list_videos.currentItemChanged.connect(self._on_video_selected)
        hl_vid.addWidget(self.list_videos, 1)
        vbl = QVBoxLayout()
        btn_vid_import = QPushButton("继续导入...")
        btn_vid_import.clicked.connect(self._import_continue)
        vbl.addWidget(btn_vid_import)
        btn_vid_del = QPushButton("删除视频源")
        btn_vid_del.clicked.connect(self._delete_video_source)
        vbl.addWidget(btn_vid_del)
        vbl.addStretch()
        hl_vid.addLayout(vbl)
        v_lib.addLayout(hl_vid)

        self.lbl_lib_info = QLabel("无激活子库")
        v_lib.addWidget(self.lbl_lib_info)

        self._frame_model = _FrameListModel(self)
        self._frame_delegate = _FrameDelegate(self._frame_model, self)
        self.frame_view = QListView()
        self.frame_view.setModel(self._frame_model)
        self.frame_view.setItemDelegate(self._frame_delegate)
        self.frame_view.setViewMode(QListView.ViewMode.IconMode)
        self.frame_view.setUniformItemSizes(True)
        self.frame_view.setIconSize(QSize(_THUMB, _THUMB))
        self.frame_view.setGridSize(QSize(_THUMB + 10, _THUMB + 10))
        self.frame_view.setMovement(QListView.Movement.Static)
        self.frame_view.setResizeMode(QListView.ResizeMode.Adjust)
        self.frame_view.setWrapping(True)
        self.frame_view.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.frame_view.setMinimumHeight(180)
        self.frame_view.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.frame_view.customContextMenuRequested.connect(self._frame_context_menu)
        self.frame_view.clicked.connect(self._on_frame_clicked)
        v_lib.addWidget(self.frame_view)

        lbl_shortcuts = QLabel(
            "Ctrl+左键：设首帧   Alt+左键：设尾帧   "
            "多选后右键：可批量删除所选帧")
        lbl_shortcuts.setStyleSheet("color:#888;font-size:11px;")
        v_lib.addWidget(lbl_shortcuts)
        flow.addWidget(gb_lib)

        # == Section 2: Head/Tail workspace ==
        gb_ht = QGroupBox("首尾帧工作区")
        v_ht = QVBoxLayout(gb_ht)
        hl_range = QHBoxLayout()
        hl_range.addWidget(QLabel("首帧 #"))
        self.sp_head = QSpinBox()
        self.sp_head.setRange(0, 0)
        self.sp_head.valueChanged.connect(self._on_range_spin)
        hl_range.addWidget(self.sp_head)
        hl_range.addWidget(QLabel("尾帧 #"))
        self.sp_tail = QSpinBox()
        self.sp_tail.setRange(0, 0)
        self.sp_tail.valueChanged.connect(self._on_range_spin)
        hl_range.addWidget(self.sp_tail)
        hl_range.addStretch()
        v_ht.addLayout(hl_range)

        hl_onion = QHBoxLayout()
        self.lbl_onion = QLabel()
        self.lbl_onion.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_onion.setStyleSheet("background:#111;border:1px solid #333;")
        self.lbl_onion.setFixedSize(320, 240)
        hl_onion.addWidget(self.lbl_onion)
        self.lbl_range_preview = QLabel()
        self.lbl_range_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_range_preview.setStyleSheet("background:#222;border:1px solid #444;")
        self.lbl_range_preview.setFixedSize(320, 240)
        hl_onion.addWidget(self.lbl_range_preview)
        hl_onion.addStretch()
        v_ht.addLayout(hl_onion)

        hl_pctrl = QHBoxLayout()
        self.btn_range_play = QPushButton("播放范围预览")
        self.btn_range_play.setCheckable(True)
        self.btn_range_play.toggled.connect(self._toggle_range_preview)
        hl_pctrl.addWidget(self.btn_range_play)
        hl_pctrl.addWidget(QLabel("速度"))
        self.slider_speed = QSlider(Qt.Orientation.Horizontal)
        self.slider_speed.setRange(1, 60)
        self.slider_speed.setValue(12)
        self.slider_speed.setMaximumWidth(200)
        hl_pctrl.addWidget(self.slider_speed)
        self.sp_onion_alpha = QDoubleSpinBox()
        self.sp_onion_alpha.setRange(0.1, 0.95)
        self.sp_onion_alpha.setValue(0.45)
        self.sp_onion_alpha.setDecimals(2)
        self.sp_onion_alpha.valueChanged.connect(self._refresh_onion)
        hl_pctrl.addWidget(QLabel("首帧权重"))
        hl_pctrl.addWidget(self.sp_onion_alpha)
        hl_pctrl.addStretch()
        v_ht.addLayout(hl_pctrl)
        flow.addWidget(gb_ht)

        self._range_player.frame_changed.connect(
            lambda pm, _: self.lbl_range_preview.setPixmap(pm))

        # == Section 3: Animation clips ==
        gb_anim = QGroupBox("动画序列")
        v_an = QVBoxLayout(gb_anim)
        hl_ac = QHBoxLayout()
        self.btn_clip_new = QPushButton("新建动画...")
        self.btn_clip_new.clicked.connect(self._clip_new)
        hl_ac.addWidget(self.btn_clip_new)
        self.btn_clip_del = QPushButton("删除当前动画")
        self.btn_clip_del.clicked.connect(self._clip_delete)
        hl_ac.addWidget(self.btn_clip_del)
        hl_ac.addStretch()
        v_an.addLayout(hl_ac)

        self.list_clips = QListWidget()
        self.list_clips.setMaximumHeight(160)
        self.list_clips.currentItemChanged.connect(self._on_clip_selected)
        v_an.addWidget(self.list_clips)

        form_clip = QFormLayout()
        self.sp_clip_fps = QDoubleSpinBox()
        self.sp_clip_fps.setRange(0.5, 120)
        self.sp_clip_fps.setValue(12)
        self.sp_clip_fps.valueChanged.connect(self._on_clip_props)
        form_clip.addRow("帧率", self.sp_clip_fps)
        self.cb_clip_loop = QCheckBox("循环")
        self.cb_clip_loop.setChecked(True)
        self.cb_clip_loop.toggled.connect(self._on_clip_props)
        form_clip.addRow(self.cb_clip_loop)
        v_an.addLayout(form_clip)

        hl_add = QHBoxLayout()
        btn_add_range = QPushButton("将库范围加入当前动画")
        btn_add_range.clicked.connect(self._clip_add_range)
        hl_add.addWidget(btn_add_range)
        btn_new_from = QPushButton("用库范围新建动画")
        btn_new_from.clicked.connect(self._clip_new_from_range)
        hl_add.addWidget(btn_new_from)
        hl_add.addStretch()
        v_an.addLayout(hl_add)

        v_an.addWidget(QLabel("当前动画帧列表:"))
        self.list_clip_frames = QListWidget()
        self.list_clip_frames.setMinimumHeight(100)
        self.list_clip_frames.setMaximumHeight(220)
        self.list_clip_frames.setSelectionMode(
            QAbstractItemView.SelectionMode.ExtendedSelection)
        self.list_clip_frames.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.list_clip_frames.customContextMenuRequested.connect(self._clip_frame_context)
        v_an.addWidget(self.list_clip_frames)

        hl_cf = QHBoxLayout()
        btn_rm = QPushButton("删除所选槽位")
        btn_rm.clicked.connect(self._clip_remove_slots)
        hl_cf.addWidget(btn_rm)
        btn_up = QPushButton("上移")
        btn_up.clicked.connect(lambda: self._clip_move(-1))
        hl_cf.addWidget(btn_up)
        btn_dn = QPushButton("下移")
        btn_dn.clicked.connect(lambda: self._clip_move(1))
        hl_cf.addWidget(btn_dn)
        btn_flip_all = QPushButton("全部翻转")
        btn_flip_all.clicked.connect(self._clip_toggle_flip_all)
        hl_cf.addWidget(btn_flip_all)
        hl_cf.addStretch()
        v_an.addLayout(hl_cf)

        hl_cprev = QHBoxLayout()
        self.lbl_clip_preview = QLabel("动画预览")
        self.lbl_clip_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_clip_preview.setStyleSheet("background:#222;border:1px solid #444;")
        self.lbl_clip_preview.setFixedSize(320, 240)
        hl_cprev.addWidget(self.lbl_clip_preview)
        hl_cprev.addStretch()
        v_an.addLayout(hl_cprev)

        hl_cpb = QHBoxLayout()
        self.btn_clip_play = QPushButton("播放预览")
        self.btn_clip_play.setCheckable(True)
        self.btn_clip_play.toggled.connect(self._toggle_clip_preview)
        hl_cpb.addWidget(self.btn_clip_play)
        hl_cpb.addStretch()
        v_an.addLayout(hl_cpb)
        flow.addWidget(gb_anim)

        self._clip_player.frame_changed.connect(
            lambda pm, _: self.lbl_clip_preview.setPixmap(pm))

        # == Section 4: Export workbench ==
        gb_export = QGroupBox("导出工作台")
        v_ex = QVBoxLayout(gb_export)
        self._export_panel = ExportPanel(self._ws, self)
        self._export_panel.set_autosave_callback(self._autosave_export_panel)
        v_ex.addWidget(self._export_panel)
        flow.addWidget(gb_export)

        flow.addStretch(1)

        self.lbl_status = QLabel("")
        self.lbl_status.setWordWrap(True)
        root.addWidget(self.lbl_status)

    # -----------------------------------------------------------------------
    # Workspace file operations
    # -----------------------------------------------------------------------

    def _new_workspace(self) -> None:
        self._ws = Workspace()
        self._head_idx = -1
        self._tail_idx = -1
        self._active_clip_id = None
        self._export_panel.set_workspace(self._ws)
        self._refresh_all()
        self.lbl_status.setText("已创建新工作区")

    def _open_workspace(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "打开工作区目录")
        if not d:
            return
        try:
            self._ws = Workspace.load_workspace(Path(d))
        except Exception as e:
            QMessageBox.critical(self, "加载失败", str(e))
            return
        self._head_idx = -1
        self._tail_idx = -1
        self._active_clip_id = None
        self._export_panel.set_workspace(self._ws)
        self._refresh_all()
        self._remember_workspace_path(Path(d))
        self.lbl_status.setText(f"已加载工作区：{d}")

    def _autosave_export_panel(self) -> None:
        if self._ws.dir_path is None:
            return
        try:
            self._ws.save_workspace()
        except Exception:
            pass

    def _save_workspace(self) -> None:
        if self._ws.dir_path is None:
            self._save_workspace_as()
            return
        try:
            self._ws.save_workspace()
        except Exception as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return
        if self._ws.dir_path is not None:
            self._remember_workspace_path(self._ws.dir_path)
        self.lbl_status.setText(f"已保存：{self._ws.dir_path}")

    def _save_workspace_as(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "选择保存目录")
        if not d:
            return
        try:
            self._ws.save_workspace(Path(d))
        except Exception as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return
        self._remember_workspace_path(Path(d))
        self.lbl_status.setText(f"已保存：{d}")

    # -----------------------------------------------------------------------
    # Import
    # -----------------------------------------------------------------------

    def _import_new(self) -> None:
        dlg = ImportDialog(self._ws, video_source=None, parent=self)
        dlg.frames_imported.connect(self._on_import_done)
        dlg.exec()

    def _import_continue(self) -> None:
        vs = self._current_video_source()
        if vs is None:
            QMessageBox.information(self, "提示", "请先选中一个视频源")
            return
        dlg = ImportDialog(self._ws, video_source=vs, parent=self)
        dlg.frames_imported.connect(self._on_import_done)
        dlg.exec()

    def _on_import_done(self, video_id: str) -> None:
        if self._ws.active_video_id is None:
            self._ws.active_video_id = video_id
        self._refresh_all()

    # -----------------------------------------------------------------------
    # Video source list
    # -----------------------------------------------------------------------

    def _refresh_video_list(self) -> None:
        self.list_videos.blockSignals(True)
        self.list_videos.clear()
        for vs in self._ws.video_sources:
            n = len(vs.frame_ids)
            it = QListWidgetItem(f"{vs.display_name}  ({n} 帧)")
            it.setData(Qt.ItemDataRole.UserRole, vs.video_id)
            if vs.video_id == self._ws.active_video_id:
                # 与「当前项」系统高亮区分：仅表示激活子库；切换后须刷新列表否则会残留在旧行
                it.setBackground(QColor(55, 72, 95))
            self.list_videos.addItem(it)
        for i in range(self.list_videos.count()):
            it = self.list_videos.item(i)
            if it and it.data(Qt.ItemDataRole.UserRole) == self._ws.active_video_id:
                self.list_videos.setCurrentItem(it)
                break
        self.list_videos.blockSignals(False)

    def _current_video_source(self) -> Optional[VideoSource]:
        it = self.list_videos.currentItem()
        if it is None:
            return None
        vid = it.data(Qt.ItemDataRole.UserRole)
        return self._ws.video_by_id(vid) if vid else None

    def _on_video_selected(self, cur: Optional[QListWidgetItem], _prev) -> None:
        if cur is None:
            return
        vid = cur.data(Qt.ItemDataRole.UserRole)
        if vid:
            self._ws.active_video_id = str(vid)
        self._head_idx = -1
        self._tail_idx = -1
        self._refresh_frame_grid()
        self._refresh_onion()
        self._refresh_video_list()

    def _delete_video_source(self) -> None:
        vs = self._current_video_source()
        if vs is None:
            return
        refs = self._ws.delete_video_source(vs.video_id)
        if refs:
            lines = []
            by_clip: dict = {}
            for cid, cname, si in refs:
                by_clip.setdefault(cname, []).append(si)
            for cname, slots in by_clip.items():
                lines.append(f"- {cname}: 槽位 {', '.join(f'#{s}' for s in slots)}")
            msg = (f"以下动画序列引用了该视频源的帧：\n" +
                   "\n".join(lines) +
                   "\n\n删除后这些槽位将标记为缺失。确定删除？")
            if QMessageBox.question(self, "确认删除", msg) != QMessageBox.StandardButton.Yes:
                return
        self._ws.commit_video_source_deletion(vs.video_id)
        self._head_idx = -1
        self._tail_idx = -1
        self._refresh_all()

    # -----------------------------------------------------------------------
    # Frame grid
    # -----------------------------------------------------------------------

    def _refresh_frame_grid(self) -> None:
        vs = self._ws.active_video()
        if vs is None:
            self._frame_model.set_data(self._ws, [])
            self.lbl_lib_info.setText("无激活子库")
            self.sp_head.setRange(0, 0)
            self.sp_tail.setRange(0, 0)
            return
        n = len(vs.frame_ids)
        self._frame_model.set_data(self._ws, vs.frame_ids,
                                   self._head_idx, self._tail_idx)
        self.lbl_lib_info.setText(
            f"激活: {vs.display_name}  共 {n} 帧  路径: {vs.source_path}")
        self.sp_head.setRange(0, max(0, n - 1))
        self.sp_tail.setRange(0, max(0, n - 1))
        if n > 0 and self._tail_idx < 0:
            self.sp_tail.setValue(n - 1)
            self._tail_idx = n - 1

    def _on_frame_clicked(self, index: QModelIndex) -> None:
        mods = QApplication.keyboardModifiers()
        i = index.row()
        if mods & Qt.KeyboardModifier.ControlModifier:
            self._set_head(i)
        elif mods & Qt.KeyboardModifier.AltModifier:
            self._set_tail(i)

    def _set_head(self, i: int) -> None:
        self._head_idx = i
        if self._tail_idx < i:
            self._tail_idx = i
        self._sync_range_spins()
        self._frame_model.update_range(self._head_idx, self._tail_idx)
        self._refresh_onion()

    def _set_tail(self, i: int) -> None:
        if i < self._head_idx:
            self.lbl_status.setText("尾帧须在首帧之后")
            return
        self._tail_idx = i
        self._sync_range_spins()
        self._frame_model.update_range(self._head_idx, self._tail_idx)
        self._refresh_onion()

    def _sync_range_spins(self) -> None:
        self.sp_head.blockSignals(True)
        self.sp_tail.blockSignals(True)
        if self._head_idx >= 0:
            self.sp_head.setValue(self._head_idx)
        if self._tail_idx >= 0:
            self.sp_tail.setValue(self._tail_idx)
        self.sp_head.blockSignals(False)
        self.sp_tail.blockSignals(False)

    def _on_range_spin(self) -> None:
        self._head_idx = self.sp_head.value()
        self._tail_idx = self.sp_tail.value()
        if self._tail_idx < self._head_idx:
            self._tail_idx = self._head_idx
            self.sp_tail.blockSignals(True)
            self.sp_tail.setValue(self._tail_idx)
            self.sp_tail.blockSignals(False)
        self._frame_model.update_range(self._head_idx, self._tail_idx)
        self._refresh_onion()

    def _selected_library_indices(self) -> List[int]:
        sm = self.frame_view.selectionModel()
        if sm is None:
            return []
        rows = {idx.row() for idx in sm.selectedIndexes()}
        return sorted(rows)

    def _frame_context_menu(self, pos) -> None:
        index = self.frame_view.indexAt(pos)
        selected = self._selected_library_indices()
        if index.isValid():
            row = index.row()
            if selected and row in selected and len(selected) > 1:
                rows = selected
            else:
                rows = [row]
        else:
            if not selected:
                return
            rows = selected

        menu = QMenu(self)
        if len(rows) == 1:
            i0 = rows[0]
            menu.addAction("设为首帧", lambda: self._set_head(i0))
            menu.addAction("设为尾帧", lambda: self._set_tail(i0))
            menu.addSeparator()
        menu.addAction(
            f"删除所选帧 ({len(rows)})",
            lambda r=list(rows): self._delete_frames_at_indices(r),
        )
        if len(rows) == 1:
            menu.addAction("查看大图...", lambda: self._view_frame(rows[0]))
        menu.exec(self.frame_view.viewport().mapToGlobal(pos))

    def _adjust_head_tail_after_delete(self, deleted: Set[int]) -> None:
        vs = self._ws.active_video()
        new_len = len(vs.frame_ids) if vs else 0
        if new_len == 0:
            self._head_idx = self._tail_idx = -1
            return

        def map_idx(old: int) -> int:
            if old < 0:
                return old
            ni = old - sum(1 for d in deleted if d < old)
            return max(0, min(ni, new_len - 1))

        if self._head_idx >= 0:
            self._head_idx = map_idx(self._head_idx)
        if self._tail_idx >= 0:
            self._tail_idx = map_idx(self._tail_idx)
        if self._head_idx >= 0 and self._tail_idx >= 0 and self._tail_idx < self._head_idx:
            self._tail_idx = self._head_idx

    def _delete_frames_at_indices(self, indices: List[int]) -> None:
        vs = self._ws.active_video()
        if vs is None:
            return
        n = len(vs.frame_ids)
        valid = sorted({i for i in indices if 0 <= i < n})
        if not valid:
            return
        ids = {vs.frame_ids[i] for i in valid}
        deleted_idx_set = set(valid)
        refs = self._ws.delete_frames_scan(ids)
        if refs:
            by_clip: dict = {}
            for _cid, cname, si in refs:
                by_clip.setdefault(cname, []).append(si)
            lines = [f"- {n}: 槽位 {', '.join(f'#{s}' for s in sorted(sl))}"
                     for n, sl in by_clip.items()]
            msg = ("以下动画序列引用了待删帧：\n" + "\n".join(lines) +
                   "\n\n删除后这些槽位将标记为缺失。确定删除？")
            if QMessageBox.question(self, "确认删除", msg) != QMessageBox.StandardButton.Yes:
                return
        self._ws.commit_frame_deletion(ids)
        self._adjust_head_tail_after_delete(deleted_idx_set)
        self._refresh_frame_grid()
        self._refresh_clip_frames_list()

    def _delete_frame_at(self, i: int) -> None:
        self._delete_frames_at_indices([i])

    def _view_frame(self, i: int) -> None:
        vs = self._ws.active_video()
        if vs is None or i >= len(vs.frame_ids):
            return
        item = self._ws.frame_by_id(vs.frame_ids[i])
        if item is None:
            return
        dlg = FrameViewerDialog(item.rgba, f"帧 #{i}  {item.id[:8]}", self)
        dlg.exec()

    # -----------------------------------------------------------------------
    # Onion skin + range preview
    # -----------------------------------------------------------------------

    def _refresh_onion(self) -> None:
        vs = self._ws.active_video()
        if vs is None or self._head_idx < 0 or self._tail_idx < 0:
            self.lbl_onion.clear()
            self.lbl_onion.setText("洋葱皮")
            return
        ids = vs.frame_ids
        if self._head_idx >= len(ids) or self._tail_idx >= len(ids):
            return
        h_item = self._ws.frame_by_id(ids[self._head_idx])
        t_item = self._ws.frame_by_id(ids[self._tail_idx])
        if h_item is None or t_item is None:
            return
        from atlas_core import bgra_to_bgr_preview
        head_bgr = bgra_to_bgr_preview(h_item.rgba)
        tail_bgr = bgra_to_bgr_preview(t_item.rgba)
        if tail_bgr.shape[:2] != head_bgr.shape[:2]:
            tail_bgr = cv2.resize(tail_bgr,
                                  (head_bgr.shape[1], head_bgr.shape[0]))
        a = float(self.sp_onion_alpha.value())
        blend = cv2.addWeighted(head_bgr, a, tail_bgr, 1.0 - a, 0.0)
        rgb = np.ascontiguousarray(cv2.cvtColor(blend, cv2.COLOR_BGR2RGB))
        qimg = QImage(rgb.data, rgb.shape[1], rgb.shape[0],
                      rgb.shape[1] * 3, QImage.Format.Format_RGB888)
        pix = QPixmap.fromImage(qimg.copy())
        scaled = pix.scaled(320, 240, Qt.AspectRatioMode.KeepAspectRatio,
                            Qt.TransformationMode.SmoothTransformation)
        self.lbl_onion.setPixmap(scaled)

    def _toggle_range_preview(self, on: bool) -> None:
        if on:
            vs = self._ws.active_video()
            if vs is None or self._head_idx < 0 or self._tail_idx < 0:
                self.btn_range_play.setChecked(False)
                return
            ids = vs.frame_ids[self._head_idx:self._tail_idx + 1]
            slots = [SlotRef(frame_id=fid) for fid in ids]
            fps = float(self.slider_speed.value())
            self._range_player.set_source(self._ws, slots, fps, loop=True)
            self._range_player.set_display_size(320, 240)
            self._range_player.play()
        else:
            self._range_player.stop()

    # -----------------------------------------------------------------------
    # Animation clips
    # -----------------------------------------------------------------------

    def _refresh_clips_list(self) -> None:
        self.list_clips.blockSignals(True)
        self.list_clips.clear()
        for c in self._ws.clips:
            n = len(c.slots)
            missing = len(self._ws.validate_clip(c))
            suffix = f"  [{missing} 缺失]" if missing else ""
            it = QListWidgetItem(f"{c.name}  ({n} 帧){suffix}")
            it.setData(Qt.ItemDataRole.UserRole, c.id)
            if missing:
                it.setForeground(QColor(220, 80, 80))
            self.list_clips.addItem(it)
        if self._active_clip_id:
            for i in range(self.list_clips.count()):
                it = self.list_clips.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == self._active_clip_id:
                    self.list_clips.setCurrentItem(it)
                    break
        self.list_clips.blockSignals(False)

    def _current_clip(self) -> Optional[AnimationClip]:
        if self._active_clip_id:
            return self._ws.clip_by_id(self._active_clip_id)
        return None

    def _on_clip_selected(self, cur: Optional[QListWidgetItem], _prev) -> None:
        if cur is None:
            self._active_clip_id = None
            return
        self._active_clip_id = str(cur.data(Qt.ItemDataRole.UserRole) or "")
        clip = self._current_clip()
        if clip:
            self.sp_clip_fps.blockSignals(True)
            self.cb_clip_loop.blockSignals(True)
            self.sp_clip_fps.setValue(clip.frame_rate)
            self.cb_clip_loop.setChecked(clip.loop)
            self.sp_clip_fps.blockSignals(False)
            self.cb_clip_loop.blockSignals(False)
        self._refresh_clip_frames_list()

    def _on_clip_props(self) -> None:
        clip = self._current_clip()
        if clip:
            clip.frame_rate = float(self.sp_clip_fps.value())
            clip.loop = self.cb_clip_loop.isChecked()
            if self._clip_player.is_playing():
                self._clip_player.apply_fps_loop(clip.frame_rate, clip.loop)

    def _clip_new(self) -> None:
        name, ok = QInputDialog.getText(self, "新建动画", "动画名称:")
        if not ok or not name.strip():
            return
        clip = make_animation_clip(name.strip(),
                                   self.sp_clip_fps.value(),
                                   self.cb_clip_loop.isChecked())
        self._ws.add_clip(clip)
        self._active_clip_id = clip.id
        self._refresh_clips_list()

    def _clip_delete(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        self._ws.delete_clip(clip.id)
        self._active_clip_id = None
        self._refresh_clips_list()
        self.list_clip_frames.clear()
        self._export_panel.refresh()

    def _clip_add_range(self) -> None:
        clip = self._current_clip()
        if not clip:
            QMessageBox.information(self, "提示", "请先选中一个动画")
            return
        if self._head_idx < 0 or self._tail_idx < 0:
            QMessageBox.information(self, "提示", "请先选择首尾帧范围")
            return
        new_slots = self._ws.clip_range_from_active(self._head_idx, self._tail_idx)
        skipped = self._ws.add_slots_to_clip(clip.id, new_slots)
        if skipped:
            self.lbl_status.setText(f"跳过了 {len(skipped)} 个已存在的帧")
        self._refresh_clip_frames_list()
        self._refresh_clips_list()

    def _clip_new_from_range(self) -> None:
        if self._head_idx < 0 or self._tail_idx < 0:
            QMessageBox.information(self, "提示", "请先选择首尾帧范围")
            return
        name, ok = QInputDialog.getText(self, "新建动画", "动画名称:")
        if not ok or not name.strip():
            return
        clip = make_animation_clip(name.strip(),
                                   self.sp_clip_fps.value(),
                                   self.cb_clip_loop.isChecked())
        new_slots = self._ws.clip_range_from_active(self._head_idx, self._tail_idx)
        clip.slots = new_slots
        self._ws.add_clip(clip)
        self._active_clip_id = clip.id
        self._refresh_clips_list()
        self._refresh_clip_frames_list()

    def _refresh_clip_frames_list(self) -> None:
        self.list_clip_frames.clear()
        clip = self._current_clip()
        if not clip:
            return
        for i, slot in enumerate(clip.slots):
            item = self._ws.frame_by_id(slot.frame_id)
            flip = " [H翻转]" if slot.flip_h else ""
            if item is None:
                label = f"{i}: [缺失] {slot.frame_id[:8]}{flip}"
                it = QListWidgetItem(label)
                it.setForeground(QColor(220, 80, 80))
            else:
                loc = self._ws.id_to_local_index(slot.frame_id)
                loc_str = f"#{loc[1]}" if loc else "?"
                label = f"{i}: {loc_str}  t={item.t_sec:.2f}s{flip}"
                it = QListWidgetItem(label)
            it.setData(Qt.ItemDataRole.UserRole, slot.frame_id)
            self.list_clip_frames.addItem(it)

    def _clip_frame_context(self, pos) -> None:
        it = self.list_clip_frames.itemAt(pos)
        if it is None:
            return
        row = self.list_clip_frames.row(it)
        clip = self._current_clip()
        if clip is None or row >= len(clip.slots):
            return
        slot = clip.slots[row]
        menu = QMenu(self)
        menu.addAction("删除此槽位", lambda: self._clip_remove_at(row))
        is_missing = slot.frame_id not in self._ws.frame_map()
        if is_missing:
            menu.addAction("替换帧...", lambda: self._clip_replace_slot(row))
        flip_label = "取消翻转" if slot.flip_h else "翻转此帧"
        menu.addAction(flip_label, lambda: self._clip_toggle_flip(row))
        menu.exec(self.list_clip_frames.viewport().mapToGlobal(pos))

    def _clip_remove_at(self, row: int) -> None:
        clip = self._current_clip()
        if clip and 0 <= row < len(clip.slots):
            del clip.slots[row]
            self._refresh_clip_frames_list()
            self._refresh_clips_list()

    def _clip_replace_slot(self, row: int) -> None:
        clip = self._current_clip()
        if clip is None or row >= len(clip.slots):
            return
        vs = self._ws.active_video()
        if vs is None or not vs.frame_ids:
            QMessageBox.information(self, "提示", "激活子库为空")
            return
        idx, ok = QInputDialog.getInt(self, "替换帧",
                                      f"输入激活子库中的帧索引 (0-{len(vs.frame_ids)-1}):",
                                      0, 0, len(vs.frame_ids) - 1)
        if not ok:
            return
        new_fid = vs.frame_ids[idx]
        existing = {s.frame_id for s in clip.slots}
        if new_fid in existing:
            QMessageBox.warning(self, "重复", "该帧已在序列中")
            return
        clip.slots[row] = SlotRef(frame_id=new_fid, flip_h=clip.slots[row].flip_h)
        self._refresh_clip_frames_list()
        self._refresh_clips_list()

    def _clip_toggle_flip(self, row: int) -> None:
        clip = self._current_clip()
        if clip and 0 <= row < len(clip.slots):
            clip.slots[row].flip_h = not clip.slots[row].flip_h
            self._refresh_clip_frames_list()

    def _clip_toggle_flip_all(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        for slot in clip.slots:
            slot.flip_h = not slot.flip_h
        self._refresh_clip_frames_list()

    def _clip_remove_slots(self) -> None:
        clip = self._current_clip()
        if not clip:
            return
        rows = sorted({self.list_clip_frames.row(it)
                       for it in self.list_clip_frames.selectedItems()},
                      reverse=True)
        for r in rows:
            if 0 <= r < len(clip.slots):
                del clip.slots[r]
        self._refresh_clip_frames_list()
        self._refresh_clips_list()

    def _clip_move(self, delta: int) -> None:
        clip = self._current_clip()
        if not clip:
            return
        row = self.list_clip_frames.currentRow()
        if row < 0:
            return
        j = row + delta
        if j < 0 or j >= len(clip.slots):
            return
        clip.slots[row], clip.slots[j] = clip.slots[j], clip.slots[row]
        self._refresh_clip_frames_list()
        self.list_clip_frames.setCurrentRow(j)

    def _toggle_clip_preview(self, on: bool) -> None:
        clip = self._current_clip()
        if on:
            if not clip or not clip.slots:
                self.btn_clip_play.setChecked(False)
                return
            self._clip_player.set_source(
                self._ws, clip.slots, clip.frame_rate, clip.loop)
            self._clip_player.set_display_size(320, 240)
            self._clip_player.play()
        else:
            self._clip_player.stop()

    # -----------------------------------------------------------------------
    # Refresh all
    # -----------------------------------------------------------------------

    def _refresh_all(self) -> None:
        self._refresh_video_list()
        self._refresh_frame_grid()
        self._refresh_clips_list()
        self._refresh_clip_frames_list()
        self._refresh_onion()
        self._export_panel.refresh()

    def closeEvent(self, event) -> None:
        self._range_player.stop()
        self._clip_player.stop()
        super().closeEvent(event)
