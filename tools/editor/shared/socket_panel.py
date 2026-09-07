"""挂点 / 落脚帧标注面板：挂点列表 + 帧条 + 标注画布 + 省力工具，落盘到 sockets.json sidecar。

挂在 anim 编辑器里。**只写 sidecar，不碰 anim.json**——挂点是人工逐帧标的，
anim.json 是产线产物，两者生命周期不同（见 animation_sockets 模块头）。

落脚帧（``contactSlots``）与挂点同一个面板、同一份文件、同一个脏态与保存门：
帧条里选中一格 → 勾「落脚帧」→ 这一格在帧条里带标记、画布脚线变橙条。
运行时走到这一格就播一声脚步；声音本身在「脚步集」页配，这里只管**哪一帧响**。

逐帧标注的现实：全库 46 个包、3176 个图集槽位。所以省力手段是可行性前提而不是锦上添花：
- 按 state 过帧（只标这个动作用到的那些槽位）
- 复制上一帧（`[`）、复制到本 state 全部空帧
- 两端标好后中间线性插值
- 洋葱皮显示上一帧位置
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
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

from .animation_sockets import (
    contact_slots_of,
    copy_pose_between_slots,
    empty_socket_set,
    fingerprint_matches,
    fingerprint_of_anim,
    interpolate_poses,
    load_socket_set,
    sanitize_socket_set,
    save_socket_set,
    set_contact_slot,
    sockets_path_for_bundle,
)
from .anim_atlas_preview import crop_atlas_cell, frame_slots_of_state
from .collapsible_section import CollapsibleSection
from .form_layout import compact_form
from .socket_canvas import SocketCanvas

#: 帧条里落脚帧那一行的底色：不靠 emoji 字形（离屏 / 缺字体会成方块），靠颜色也能一眼看见
_CONTACT_BRUSH = QBrush(QColor(255, 150, 40, 70))


class SocketPanel(QWidget):
    """一个动画包的挂点标注面板。宿主（anim 编辑器）负责在切包时调 `set_bundle`。"""

    dirtyChanged = Signal(bool)

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._bundle: str = ""
        self._anim: dict[str, Any] = {}
        self._atlas: QPixmap | None = None
        self._data: dict[str, Any] = {}
        self._original: dict[str, Any] = {}
        self._stale = False
        self._loading = False
        self._slots: list[int] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        self._banner = QLabel()
        self._banner.setWordWrap(True)
        self._banner.setVisible(False)
        self._banner.setStyleSheet("color:#ffb86b; padding:4px;")
        root.addWidget(self._banner)

        body = QHBoxLayout()
        root.addLayout(body)

        # -- 左：挂点列表 --------------------------------------------------
        left = QVBoxLayout()
        left.addWidget(QLabel("挂点"))
        self._socket_list = QListWidget()
        self._socket_list.setMaximumWidth(180)
        self._socket_list.currentItemChanged.connect(lambda *_: self._refresh_canvas())
        left.addWidget(self._socket_list, 1)
        btns = QHBoxLayout()
        add = QPushButton("+")
        add.setToolTip("新建挂点（右手 / 头顶 / 腰…名字跨动画包通用，挂件按名字找）")
        add.clicked.connect(self._add_socket)
        rm = QPushButton("−")
        rm.setToolTip("删除挂点（连同它所有帧的标注）")
        rm.clicked.connect(self._del_socket)
        btns.addWidget(add)
        btns.addWidget(rm)
        btns.addStretch(1)
        left.addLayout(btns)
        body.addLayout(left)

        # -- 中：画布 ------------------------------------------------------
        mid = QVBoxLayout()
        self._canvas = SocketCanvas()
        self._canvas.posMoved.connect(self._on_pos_moved)
        self._canvas.angleMoved.connect(self._on_angle_moved)
        self._canvas.clickedAt.connect(self._on_pos_moved)
        mid.addWidget(self._canvas)
        hint = QLabel("点/拖 = 挪位置；拖橙色手柄 = 转角度；实心圈 = 身前，空心 = 身后")
        hint.setStyleSheet("color:#888;")
        hint.setWordWrap(True)
        mid.addWidget(hint)
        # 例行反馈走状态行、不弹模态：模态 exec() 在无人值守环境（测试/无头）会永久阻塞，
        # 本仓库已经有一条测试因此挂死，不再制造第二条。
        self._status = QLabel("")
        self._status.setStyleSheet("color:#8fb98f;")
        self._status.setWordWrap(True)
        mid.addWidget(self._status)
        body.addLayout(mid)

        # -- 右：帧与参数 --------------------------------------------------
        right = QVBoxLayout()
        f = compact_form(QFormLayout())
        fw = QWidget()
        fw.setLayout(f)
        self._state_combo = QComboBox()
        self._state_combo.setMaximumWidth(200)
        self._state_combo.setToolTip("只列这个动作用到的图集槽位——按动作标比对着 89 个槽位标现实得多")
        self._state_combo.currentIndexChanged.connect(lambda *_: self._rebuild_frames())
        f.addRow("动作", self._state_combo)
        self._frame_list = QListWidget()
        self._frame_list.setMaximumWidth(200)
        self._frame_list.setMaximumHeight(180)
        self._frame_list.currentItemChanged.connect(lambda *_: self._refresh_canvas())
        f.addRow("帧（图集槽位）", self._frame_list)

        # -- 落脚帧：与挂点无关的逐帧布尔标注，放在挂点参数上面、自成一组 --
        contact_box = QGroupBox("脚步 · 落脚帧")
        contact_box.setToolTip(
            "勾上 = 这一格画的是脚触地的瞬间，运行时走到这一格就播一声脚步。\n"
            "按图集槽位标：同一格在几个动作里复用时只标一次。\n"
            "没标过的动作一律不响（不按帧数猜）。声音本身在「脚步集」页配。")
        cl = QVBoxLayout(contact_box)
        cl.setContentsMargins(6, 4, 6, 4)
        self._contact = QCheckBox("本帧落脚（脚触地 → 播脚步声）")
        self._contact.toggled.connect(self._on_contact_toggled)
        cl.addWidget(self._contact)
        self._contact_summary = QLabel("")
        self._contact_summary.setStyleSheet("color:#888;")
        self._contact_summary.setWordWrap(True)
        cl.addWidget(self._contact_summary)
        f.addRow(contact_box)

        self._front = QCheckBox("画在身前")
        self._front.setToolTip("勾 = 挂件排在角色之后（身前）；不勾 = 插到最前（身后）。转身时可以逐帧翻")
        self._front.stateChanged.connect(lambda *_: self._write_current(front=self._front.isChecked()))
        f.addRow(self._front)

        self._angle = QDoubleSpinBox()
        self._angle.setRange(-180.0, 180.0)
        self._angle.setDecimals(1)
        self._angle.setMaximumWidth(110)
        self._angle.setToolTip("角度（度，顺时针为正）；角色朝左时游戏里自动取反")
        self._angle.valueChanged.connect(lambda v: self._write_current(angle=float(v)))
        f.addRow("角度", self._angle)

        self._frame_no = QSpinBox()
        self._frame_no.setRange(-1, 999)
        self._frame_no.setMaximumWidth(110)
        self._frame_no.setToolTip(
            "挂点驱动帧号（第二档）：挂件自己是一张小序列图时用它选第几帧。\n"
            "-1 = 不指定（纯静态图）。不引入第二个时钟，所以没有锁相问题。")
        self._frame_no.valueChanged.connect(
            lambda v: self._write_current(frame=(None if int(v) < 0 else int(v))))
        f.addRow("挂件帧号", self._frame_no)
        right.addWidget(fw)

        tools = CollapsibleSection("省力工具", start_open=True)
        tw = QWidget()
        tl = QVBoxLayout(tw)
        tl.setContentsMargins(0, 0, 0, 0)
        b_copy = QPushButton("复制上一帧到本帧")
        b_copy.setToolTip("逐帧标注最高频的操作：手位基本没动时直接抄上一帧")
        b_copy.clicked.connect(self._copy_prev)
        tl.addWidget(b_copy)
        b_fill = QPushButton("本帧填到本动作所有空帧")
        b_fill.setToolTip("整段动作手位不变时一次铺满（已标注的帧不覆盖）")
        b_fill.clicked.connect(self._fill_empty)
        tl.addWidget(b_fill)
        b_interp = QPushButton("在本动作内线性插值")
        b_interp.setToolTip("两端标好、中间空着的帧按比例补（已标注的不覆盖）")
        b_interp.clicked.connect(self._interpolate)
        tl.addWidget(b_interp)
        b_clear = QPushButton("清除本帧标注")
        b_clear.setToolTip("清掉后这一帧挂件会隐藏——「刀在鞘里那几帧手上没东西」就这么表达")
        b_clear.clicked.connect(self._clear_current)
        tl.addWidget(b_clear)
        tools.add_body(tw)
        right.addWidget(tools)
        right.addStretch(1)
        body.addLayout(right)

    # ---- 宿主接口 ------------------------------------------------------

    def set_bundle(self, bundle_id: str, anim: dict, atlas: QPixmap | None) -> None:
        """切到某个动画包（宿主在选包/重载时调）。会丢弃未保存编辑，宿主须先 flush。"""
        self._loading = True
        try:
            self._bundle = str(bundle_id or "")
            self._anim = anim or {}
            self._atlas = atlas
            raw = None
            if self._bundle and self._model.project_path:
                raw = load_socket_set(
                    sockets_path_for_bundle(self._model.animation_bundles_path, self._bundle))
            if isinstance(raw, dict):
                self._stale = not fingerprint_matches(raw.get("atlas"), fingerprint_of_anim(self._anim))
                self._data = copy.deepcopy(raw)
            else:
                self._stale = False
                self._data = empty_socket_set(self._anim)
            self._original = copy.deepcopy(self._data)
            self._sync_banner()
            self._rebuild_sockets()
            self._rebuild_states()
        finally:
            self._loading = False
        self.dirtyChanged.emit(False)

    def set_atlas(self, atlas: QPixmap | None) -> None:
        """只换图集像素，**不碰数据**。

        图集 PNG 是异步解码的，解码完要补给画布——但那条路径绝不能走 set_bundle：
        它会从磁盘重读并整份覆盖内存态，等于把用户没保存的标注静默丢掉（审查 #3）。
        """
        self._atlas = atlas
        self._refresh_canvas()

    def is_dirty(self) -> bool:
        if not self._bundle:
            return False
        return sanitize_socket_set(self._data, self._anim) != sanitize_socket_set(self._original, self._anim)

    def save(self) -> str | None:
        """写盘；成功返回 None，失败返回错误文案。"""
        if not self._bundle:
            return None
        if not self._model.project_path:
            return "工程未加载"
        data = sanitize_socket_set(self._data, self._anim)
        try:
            save_socket_set(
                sockets_path_for_bundle(self._model.animation_bundles_path, self._bundle), data)
        except OSError as e:
            return str(e)
        self._data = copy.deepcopy(data)
        self._original = copy.deepcopy(data)
        self._stale = False
        self._sync_banner()
        self.dirtyChanged.emit(False)
        return None

    def discard(self) -> None:
        """Discard 路径：把 UI 回滚到磁盘值（否则统一 flush 会把放弃的编辑写回）。"""
        self._loading = True
        try:
            self._data = copy.deepcopy(self._original)
            self._rebuild_sockets()
            self._rebuild_states()
        finally:
            self._loading = False
        self.dirtyChanged.emit(False)

    # ---- 内部 ----------------------------------------------------------

    def _say(self, text: str) -> None:
        """例行反馈（非阻塞）。破坏性确认才用 QMessageBox。"""
        self._status.setText(text)

    def _sync_banner(self) -> None:
        if not self._stale:
            self._banner.setVisible(False)
            return
        self._banner.setText(
            "⚠ 这份挂点 / 落脚帧标注与当前图集对不上（重导出过？）。游戏里会**整份忽略**——"
            "挂件不挂、脚步不响，宁可没有也不照漂移的槽位号出错。请重标后保存，保存即刷新指纹。")
        self._banner.setVisible(True)

    def _sockets(self) -> dict[str, Any]:
        s = self._data.setdefault("sockets", {})
        return s if isinstance(s, dict) else {}

    def _current_socket(self) -> str:
        it = self._socket_list.currentItem()
        return it.text() if it else ""

    def _current_slot(self) -> int | None:
        it = self._frame_list.currentItem()
        if it is None:
            return None
        return int(it.data(Qt.ItemDataRole.UserRole))

    # ---- 落脚帧 --------------------------------------------------------

    def is_contact_slot(self, slot: int) -> bool:
        """某图集槽位是否已标为落脚帧（宿主的播放预览也靠它标「这一帧会响」）。"""
        return int(slot) in contact_slots_of(self._data)

    def contact_slots(self) -> list[int]:
        return contact_slots_of(self._data)

    def _on_contact_toggled(self, on: bool) -> None:
        if self._loading:
            return
        slot = self._current_slot()
        if slot is None:
            return
        if set_contact_slot(self._data, slot, bool(on)):
            self._decorate_frame_items()
            self._refresh_canvas()
            self.dirtyChanged.emit(self.is_dirty())

    def _decorate_frame_items(self) -> None:
        """帧条每一行：落脚帧带「落脚」后缀 + 橙底，一眼看出这个动作在哪几帧响。"""
        for i in range(self._frame_list.count()):
            it = self._frame_list.item(i)
            if it is None:
                continue
            slot = int(it.data(Qt.ItemDataRole.UserRole))
            order = it.data(Qt.ItemDataRole.UserRole + 1)
            base = f"#{order}  槽位 {slot}"
            if self.is_contact_slot(slot):
                it.setText(f"{base}   ● 落脚")
                it.setBackground(_CONTACT_BRUSH)
                it.setToolTip("落脚帧：运行时走到这一格播一声脚步")
            else:
                it.setText(base)
                it.setBackground(QBrush())
                it.setToolTip("")
        marked = [s for s in dict.fromkeys(self._slots) if self.is_contact_slot(s)]
        if not self._slots:
            self._contact_summary.setText("")
        elif marked:
            self._contact_summary.setText(
                f"本动作 {len(marked)} 个落脚帧：槽位 {', '.join(str(s) for s in marked)}")
        else:
            self._contact_summary.setText("本动作还没标落脚帧——走它的时候**不会**响脚步")

    def _rebuild_sockets(self) -> None:
        keep = self._current_socket()
        self._socket_list.blockSignals(True)
        self._socket_list.clear()
        for name in sorted(self._sockets().keys()):
            self._socket_list.addItem(QListWidgetItem(name))
        self._socket_list.blockSignals(False)
        if keep:
            hits = self._socket_list.findItems(keep, Qt.MatchFlag.MatchExactly)
            if hits:
                self._socket_list.setCurrentItem(hits[0])
        if self._socket_list.currentItem() is None and self._socket_list.count():
            self._socket_list.setCurrentRow(0)
        self._refresh_canvas()

    def _rebuild_states(self) -> None:
        self._state_combo.blockSignals(True)
        self._state_combo.clear()
        states = self._anim.get("states")
        for name in (sorted(states.keys()) if isinstance(states, dict) else []):
            self._state_combo.addItem(name, name)
        self._state_combo.blockSignals(False)
        self._rebuild_frames()

    def _rebuild_frames(self) -> None:
        state = str(self._state_combo.currentData() or "")
        self._slots = frame_slots_of_state(self._anim, state) if state else []
        keep = self._current_slot()
        self._frame_list.blockSignals(True)
        self._frame_list.clear()
        seen: set[int] = set()
        for order, slot in enumerate(self._slots):
            # 同一槽位在一个动作里会重复出现（往返播放），只列一次——它们是同一张图
            if slot in seen:
                continue
            seen.add(slot)
            it = QListWidgetItem(f"#{order}  槽位 {slot}")
            it.setData(Qt.ItemDataRole.UserRole, slot)
            it.setData(Qt.ItemDataRole.UserRole + 1, order)
            self._frame_list.addItem(it)
        self._decorate_frame_items()
        self._frame_list.blockSignals(False)
        if keep is not None:
            for i in range(self._frame_list.count()):
                if int(self._frame_list.item(i).data(Qt.ItemDataRole.UserRole)) == keep:
                    self._frame_list.setCurrentRow(i)
                    break
        if self._frame_list.currentItem() is None and self._frame_list.count():
            self._frame_list.setCurrentRow(0)
        self._refresh_canvas()

    def _poses(self, socket: str) -> dict[str, Any]:
        sock = self._sockets().get(socket)
        if not isinstance(sock, dict):
            return {}
        poses = sock.setdefault("poses", {})
        return poses if isinstance(poses, dict) else {}

    def _refresh_canvas(self) -> None:
        slot = self._current_slot()
        cell = None
        if self._atlas is not None and slot is not None:
            cell = crop_atlas_cell(
                self._atlas,
                int(self._anim.get("cols", 1) or 1),
                int(self._anim.get("rows", 1) or 1),
                int(slot),
                cell_w=int(self._anim.get("cellWidth") or 0) or None,
                cell_h=int(self._anim.get("cellHeight") or 0) or None,
            )
        self._canvas.set_cell(cell)

        marks: dict[str, tuple[float, float, float, bool]] = {}
        for name in self._sockets():
            pose = self._poses(name).get(str(slot)) if slot is not None else None
            if isinstance(pose, dict):
                marks[name] = (
                    float(pose.get("x", 0.5)),
                    float(pose.get("y", 0.5)),
                    float(pose.get("angle", 0.0) or 0.0),
                    pose.get("front") is True,
                )
        cur = self._current_socket()
        self._canvas.set_marks(marks, cur)
        self._canvas.set_ghost(self._prev_pose_xy(cur, slot))
        self._canvas.set_contact(slot is not None and self.is_contact_slot(slot))
        self._sync_contact_field(slot)
        self._sync_fields(marks.get(cur))

    def _sync_contact_field(self, slot: int | None) -> None:
        was = self._loading
        self._loading = True
        try:
            self._contact.setEnabled(slot is not None)
            self._contact.setChecked(slot is not None and self.is_contact_slot(slot))
        finally:
            self._loading = was

    def _prev_pose_xy(self, socket: str, slot: int | None) -> tuple[float, float] | None:
        """洋葱皮：本动作里上一个已标注帧的位置。"""
        if not socket or slot is None or slot not in self._slots:
            return None
        idx = self._slots.index(slot)
        poses = self._poses(socket)
        for j in range(idx - 1, -1, -1):
            pose = poses.get(str(self._slots[j]))
            if isinstance(pose, dict):
                return float(pose.get("x", 0.5)), float(pose.get("y", 0.5))
        return None

    def _sync_fields(self, mark: tuple[float, float, float, bool] | None) -> None:
        was = self._loading
        self._loading = True
        try:
            has = mark is not None
            for w in (self._front, self._angle, self._frame_no):
                w.setEnabled(has)
            self._front.setChecked(bool(mark[3]) if has else False)
            self._angle.setValue(float(mark[2]) if has else 0.0)
            slot = self._current_slot()
            pose = self._poses(self._current_socket()).get(str(slot)) if has and slot is not None else None
            fr = pose.get("frame") if isinstance(pose, dict) else None
            self._frame_no.setValue(int(fr) if isinstance(fr, int) else -1)
        finally:
            self._loading = was

    def _write_current(self, **fields) -> None:
        """把一个字段写进当前挂点当前帧的 pose（没有就地新建）。"""
        if self._loading:
            return
        socket = self._current_socket()
        slot = self._current_slot()
        if not socket or slot is None:
            return
        poses = self._poses(socket)
        pose = poses.get(str(slot))
        if not isinstance(pose, dict):
            pose = {"x": 0.5, "y": 0.5}
            poses[str(slot)] = pose
        for k, v in fields.items():
            if v is None:
                pose.pop(k, None)
            else:
                pose[k] = v
        self._refresh_canvas()
        self.dirtyChanged.emit(self.is_dirty())

    def _on_pos_moved(self, nx: float, ny: float) -> None:
        self._write_current(x=round(float(nx), 5), y=round(float(ny), 5))

    def _on_angle_moved(self, angle: float) -> None:
        self._write_current(angle=round(float(angle), 1))

    def _add_socket(self) -> None:
        if not self._bundle:
            return
        name, ok = QInputDialog.getText(self, "新建挂点", "挂点名（如 right_hand / head_top）：")
        name = (name or "").strip()
        if not ok or not name:
            return
        if name in self._sockets():
            self._say(f"挂点 {name!r} 已经有了")
            return
        self._sockets()[name] = {"poses": {}}
        self._rebuild_sockets()
        hits = self._socket_list.findItems(name, Qt.MatchFlag.MatchExactly)
        if hits:
            self._socket_list.setCurrentItem(hits[0])
        self.dirtyChanged.emit(self.is_dirty())

    def _del_socket(self) -> None:
        name = self._current_socket()
        if not name:
            return
        n = len(self._poses(name))
        if n and QMessageBox.question(
            self, "删除挂点", f"挂点 {name!r} 上有 {n} 帧标注，一并删除？",
        ) != QMessageBox.StandardButton.Yes:
            return
        self._sockets().pop(name, None)
        self._rebuild_sockets()
        self.dirtyChanged.emit(self.is_dirty())

    def _copy_prev(self) -> None:
        socket = self._current_socket()
        slot = self._current_slot()
        if not socket or slot is None or slot not in self._slots:
            return
        idx = self._slots.index(slot)
        poses = self._poses(socket)
        for j in range(idx - 1, -1, -1):
            if isinstance(poses.get(str(self._slots[j])), dict):
                copy_pose_between_slots(self._data, socket, self._slots[j], slot)
                self._refresh_canvas()
                self.dirtyChanged.emit(self.is_dirty())
                return

    def _fill_empty(self) -> None:
        socket = self._current_socket()
        slot = self._current_slot()
        if not socket or slot is None:
            return
        src = self._poses(socket).get(str(slot))
        if not isinstance(src, dict):
            return
        filled = 0
        for s in dict.fromkeys(self._slots):
            if isinstance(self._poses(socket).get(str(s)), dict):
                continue
            self._poses(socket)[str(s)] = copy.deepcopy(src)
            filled += 1
        self._refresh_canvas()
        self.dirtyChanged.emit(self.is_dirty())
        self._say(f"铺满：补了 {filled} 帧（已标注的没动）")

    def _interpolate(self) -> None:
        socket = self._current_socket()
        if not socket:
            return
        filled = interpolate_poses(self._data, socket, list(dict.fromkeys(self._slots)))
        self._refresh_canvas()
        self.dirtyChanged.emit(self.is_dirty())
        self._say(f"插值：补了 {filled} 帧（已标注的没动）")

    def _clear_current(self) -> None:
        socket = self._current_socket()
        slot = self._current_slot()
        if not socket or slot is None:
            return
        self._poses(socket).pop(str(slot), None)
        self._refresh_canvas()
        self.dirtyChanged.emit(self.is_dirty())
