"""npc_schedules.json 编辑器（数据类型 'npc_schedules'）。

一张日程表 = 一个角色一天的行踪：几点到几点、在哪个场景、在哪个位置。
运行时语义见 `src/systems/NpcScheduleSystem.ts`——这里只负责让策划能安全地写出它。

骨架照 plane_editor：主从列表 + commit-on-leave + flush/confirm_close 钩子。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import Qt, QTime
from PySide6.QtWidgets import (
    QCheckBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTimeEdit,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared.collapsible_section import CollapsibleSection
from ..shared.condition_expr_tree import ConditionExprTreeRootWidget
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.list_affordances import wire_list_affordances
from ..shared.numeric_roundtrip import preserve_numeric_repr

#: 短字段宽度上限（布局纪律：禁 setMinimumWidth 地板堆叠顶爆小屏）
_TIME_W = 92
_COORD_W = 110


def _parse_clock(raw: object) -> tuple[int, int]:
    """`HH:MM` → (时, 分)；非法回落 00:00（保值由调用方另行处理）。"""
    s = str(raw or "").strip()
    if ":" not in s:
        return (0, 0)
    h, _, m = s.partition(":")
    try:
        hh = int(h)
        mm = int(m)
    except ValueError:
        return (0, 0)
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return (0, 0)
    return (hh, mm)


def _fmt_clock(t: QTime) -> str:
    return f"{t.hour():02d}:{t.minute():02d}"


def _conds_to_expr(conds: list) -> object | None:
    """`ConditionExpr[]`（组内 AND）→ 条件树控件吃的单个表达式。"""
    if not conds:
        return None
    if len(conds) == 1:
        return conds[0]
    return {"all": list(conds)}


def _expr_to_conds(expr: object) -> list:
    """反向：单表达式 → 数组。`{all:[…]}` 摊平回数组，其余包成单元素。"""
    if not expr:
        return []
    if isinstance(expr, dict) and set(expr.keys()) == {"all"} and isinstance(expr["all"], list):
        return list(expr["all"])
    return [expr]


def _read_conds(widget, original: list) -> list:
    """读条件控件；**语义未变时原样回写 original**，避免等价改写让字节漂移。"""
    expr = widget.get_expr()
    if expr == _conds_to_expr(original):
        return list(original)
    return _expr_to_conds(expr)


class NpcScheduleEditor(QWidget):
    """NPC 日程表编辑器。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        self._entry_idx = -1
        self._loading = False
        # 条件的原始值：用于「语义未变则原样回写」的字节保真（见 _read_conds）
        self._cond_original: list = []
        self._entry_cond_original: list = []

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- 左：角色日程列表 ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 日程")
        btn_add.setToolTip("给一个角色新建日程表。一个角色至多一张表。")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中角色的整张日程表（该角色随即回落为普通常驻 NPC）。")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除日程表")
        ll.addWidget(self._list)

        # ---- 右 ----
        right = QWidget()
        rl = QVBoxLayout(right)

        basic = QGroupBox("基本")
        bf = compact_form(QFormLayout())
        basic.setLayout(bf)
        self._f_character = IdRefSelector(allow_empty=False, click_opens_popup=True)
        self._f_character.setToolTip(
            "受这张表管的角色（character_registry.json）。\n"
            "场景里 characterId 指向它的 NPC 实例都按这张表走行踪。",
        )
        bf.addRow("角色", self._f_character)
        self._f_exit_line = QLineEdit()
        self._f_exit_line.setToolTip(
            "离场前说的一句话（走之前播头顶气泡）。留空＝默默走。\n"
            "只在玩家在场、且推进方式是「无缝」时才会说。",
        )
        bf.addRow("离场台词", self._f_exit_line)
        self._f_preferred_exit = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._f_preferred_exit.setToolTip(
            "优先从哪个出口离场／入场。留空＝取离他最近的出口；\n"
            "场景一个出口都没配时，自动走到场景边界外（绝不原地消失）。",
        )
        bf.addRow("优先出口", self._f_preferred_exit)
        rl.addWidget(basic)

        # 重块默认折叠（布局纪律）：多数日程表不配条件。
        self._cond_section = CollapsibleSection(
            "整张表的生效条件（留空＝始终按表走）", start_open=False,
        )
        self._cond = ConditionExprTreeRootWidget(model_getter=lambda: self._model)
        self._cond_section.add_body(self._cond)
        rl.addWidget(self._cond_section)

        # ---- 条目 ----
        entries_box = QGroupBox("日程条目（按顺序取第一条时间命中且条件满足的）")
        eb = QVBoxLayout(entries_box)
        hint = QLabel(
            "结束时刻早于开始时刻＝跨零点（如 19:00→06:00 表示夜里那一段）。\n"
            "「所在场景」留空＝这段时间不在任何场景（回家/下工）。",
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888;")
        eb.addWidget(hint)

        e_btns = QHBoxLayout()
        e_add = QPushButton("+ 条目")
        e_add.clicked.connect(self._add_entry)
        e_del = QPushButton("删除条目")
        e_del.clicked.connect(self._delete_entry)
        e_up = QPushButton("上移")
        e_up.setToolTip("顺序决定优先级：同一时刻命中多条时取靠前的。")
        e_up.clicked.connect(lambda: self._move_entry(-1))
        e_down = QPushButton("下移")
        e_down.clicked.connect(lambda: self._move_entry(1))
        for b in (e_add, e_del, e_up, e_down):
            e_btns.addWidget(b)
        e_btns.addStretch(1)
        eb.addLayout(e_btns)

        self._entry_list = QListWidget()
        self._entry_list.currentRowChanged.connect(self._on_entry_select)
        wire_list_affordances(self._entry_list, self._delete_entry, delete_label="删除条目")
        eb.addWidget(self._entry_list)

        ef = compact_form(QFormLayout())
        self._f_from = QTimeEdit()
        self._f_from.setDisplayFormat("HH:mm")
        self._f_from.setMaximumWidth(_TIME_W)
        self._f_from.timeChanged.connect(self._on_entry_field_changed)
        self._f_to = QTimeEdit()
        self._f_to.setDisplayFormat("HH:mm")
        self._f_to.setMaximumWidth(_TIME_W)
        self._f_to.timeChanged.connect(self._on_entry_field_changed)
        time_row = QWidget()
        tr = QHBoxLayout(time_row)
        tr.setContentsMargins(0, 0, 0, 0)
        tr.addWidget(self._f_from)
        tr.addWidget(QLabel("→"))
        tr.addWidget(self._f_to)
        tr.addStretch(1)
        ef.addRow("时间段", time_row)

        self._f_scene = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._f_scene.setToolTip("这段时间他在哪个场景。留空＝不在任何场景（离场）。")
        self._f_scene.value_changed.connect(lambda *_: self._on_entry_field_changed())
        ef.addRow("所在场景", self._f_scene)

        # 坐标是「可选覆盖」：不勾＝用场景 JSON 里这个 NPC 自己的原始坐标（绝大多数条目如此）。
        # 用闸门复选框表达"未设"，与位面编辑器的槽闸门同范式——不勾就不落键。
        self._f_spot_on = QCheckBox("指定驻留坐标")
        self._f_spot_on.setToolTip(
            "不勾＝用场景里这个 NPC 自己的原始坐标（多数情况不必勾）。\n"
            "勾上＝这段时间他站在指定坐标。",
        )
        self._f_spot_on.toggled.connect(self._on_spot_gate)
        self._f_x = QDoubleSpinBox()
        self._f_x.setRange(-100000, 100000)
        self._f_x.setDecimals(2)
        self._f_x.setMaximumWidth(_COORD_W)
        self._f_x.valueChanged.connect(self._on_entry_field_changed)
        self._f_y = QDoubleSpinBox()
        self._f_y.setRange(-100000, 100000)
        self._f_y.setDecimals(2)
        self._f_y.setMaximumWidth(_COORD_W)
        self._f_y.valueChanged.connect(self._on_entry_field_changed)
        spot_row = QWidget()
        sr = QHBoxLayout(spot_row)
        sr.setContentsMargins(0, 0, 0, 0)
        sr.addWidget(self._f_spot_on)
        sr.addWidget(QLabel("x"))
        sr.addWidget(self._f_x)
        sr.addWidget(QLabel("y"))
        sr.addWidget(self._f_y)
        sr.addStretch(1)
        ef.addRow("驻留坐标", spot_row)

        self._f_activity = QLineEdit()
        self._f_activity.setMaximumWidth(200)
        self._f_activity.setToolTip(
            "到位后播放的动画状态名（该角色 anim.json 里的状态，如 sit / idle）。\n"
            "留空＝不改动画。",
        )
        self._f_activity.textEdited.connect(self._on_entry_field_changed)
        ef.addRow("到位后动作", self._f_activity)

        ef_host = QWidget()
        ef_host.setLayout(ef)
        eb.addWidget(ef_host)

        self._entry_cond_section = CollapsibleSection(
            "本条目的额外条件（留空＝不限）", start_open=False,
        )
        self._entry_cond = ConditionExprTreeRootWidget(model_getter=lambda: self._model)
        self._entry_cond.changed.connect(self._on_entry_field_changed)
        self._entry_cond_section.add_body(self._entry_cond)
        eb.addWidget(self._entry_cond_section)

        rl.addWidget(entries_box)

        apply_row = QHBoxLayout()
        apply_row.addStretch(1)
        apply_btn = QPushButton("应用")
        apply_btn.setToolTip("把当前日程表提交到模型（切换/保存时也会自动提交）。")
        apply_btn.clicked.connect(self._apply)
        apply_row.addWidget(apply_btn)
        rl.addLayout(apply_row)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([220, 640])
        root.addWidget(splitter)

        self._refresh()

    # ---- 数据存取 ----

    @property
    def _rows(self) -> list[dict]:
        rows = self._model.npc_schedules.get("schedules")
        if not isinstance(rows, list):
            rows = []
            self._model.npc_schedules["schedules"] = rows
        return rows

    def _row_text(self, row: dict) -> str:
        cid = str(row.get("characterId", "") or "(未选角色)")
        n = len(row.get("entries") or [])
        return f"{cid}  · {n} 条"

    def _entry_text(self, e: dict) -> str:
        scene = str(e.get("scene") or "").strip()
        where = scene or "（离场）"
        act = str(e.get("activity") or "").strip()
        tail = f" · {act}" if act else ""
        return f"{e.get('from', '??:??')} → {e.get('to', '??:??')}  {where}{tail}"

    def _refresh(self) -> None:
        self._list.clear()
        for row in self._rows:
            self._list.addItem(self._row_text(row))

    def select_by_id(self, character_id: str, _scene_id: str = "") -> bool:
        want = (character_id or "").strip()
        for i, row in enumerate(self._rows):
            if str(row.get("characterId", "") or "").strip() == want:
                self._list.setCurrentRow(i)
                return True
        return False

    def reload_refs_from_model(self) -> None:
        """跨面板刷新约定：切回本页时从模型重载候选（角色/场景/出口可能刚被改过）。"""
        if self._current_idx < 0 or self._current_idx >= len(self._rows):
            self._refresh()
            return
        idx = self._current_idx
        self._refresh()
        self._list.setCurrentRow(idx)
        self._on_select(idx)

    # ---- 选中 / 载入 ----

    def _on_select(self, row: int) -> None:
        rows = self._rows
        if row < 0 or row >= len(rows):
            self._current_idx = -1
            return
        # commit-on-leave：切走前提交上一张表，避免静默丢弃。
        if 0 <= self._current_idx < len(rows) and self._current_idx != row and self._is_dirty():
            if not self._apply():
                old = self._current_idx
                self._list.blockSignals(True)
                try:
                    self._list.setCurrentRow(old)
                finally:
                    self._list.blockSignals(False)
                return
        self._current_idx = row
        data = rows[row]
        self._loading = True
        try:
            self._f_character.set_items(self._model.all_character_ids())
            self._f_character.set_current(str(data.get("characterId", "") or ""))
            self._f_exit_line.setText(str(data.get("exitLine", "") or ""))
            self._f_preferred_exit.set_items(self._model.all_exit_anchor_ids())
            self._f_preferred_exit.set_current(str(data.get("preferredExit", "") or ""))
            self._cond_original = list(data.get("conditions") or [])
            self._cond.set_expr(_conds_to_expr(self._cond_original))
            self._reload_entry_list()
        finally:
            self._loading = False

    def _reload_entry_list(self) -> None:
        self._entry_list.blockSignals(True)
        try:
            self._entry_list.clear()
            for e in self._entries():
                self._entry_list.addItem(self._entry_text(e))
        finally:
            self._entry_list.blockSignals(False)
        self._entry_idx = -1
        if self._entry_list.count():
            self._entry_list.setCurrentRow(0)
        else:
            self._set_entry_form_enabled(False)

    def _entries(self) -> list[dict]:
        if self._current_idx < 0 or self._current_idx >= len(self._rows):
            return []
        data = self._rows[self._current_idx]
        entries = data.get("entries")
        if not isinstance(entries, list):
            entries = []
            data["entries"] = entries
        return entries

    def _set_entry_form_enabled(self, on: bool) -> None:
        for w in (
            self._f_from, self._f_to, self._f_scene, self._f_spot_on,
            self._f_activity, self._entry_cond,
        ):
            w.setEnabled(on)
        self._f_x.setEnabled(on and self._f_spot_on.isChecked())
        self._f_y.setEnabled(on and self._f_spot_on.isChecked())

    def _on_entry_select(self, row: int) -> None:
        entries = self._entries()
        if row < 0 or row >= len(entries):
            self._entry_idx = -1
            self._set_entry_form_enabled(False)
            return
        self._entry_idx = row
        e = entries[row]
        self._loading = True
        try:
            self._set_entry_form_enabled(True)
            fh, fm = _parse_clock(e.get("from"))
            th, tm = _parse_clock(e.get("to"))
            self._f_from.setTime(QTime(fh, fm))
            self._f_to.setTime(QTime(th, tm))
            self._f_scene.set_items([(s, s) for s in self._model.all_scene_ids()])
            self._f_scene.set_current(str(e.get("scene") or ""))
            spot = e.get("spot")
            has_spot = isinstance(spot, dict)
            self._f_spot_on.setChecked(has_spot)
            if has_spot:
                self._f_x.setValue(float(spot.get("x", 0) or 0))
                self._f_y.setValue(float(spot.get("y", 0) or 0))
            self._f_x.setEnabled(has_spot)
            self._f_y.setEnabled(has_spot)
            self._f_activity.setText(str(e.get("activity", "") or ""))
            self._entry_cond_original = list(e.get("conditions") or [])
            self._entry_cond.set_expr(_conds_to_expr(self._entry_cond_original))
        finally:
            self._loading = False

    # ---- 条目编辑 ----

    def _on_spot_gate(self, on: bool) -> None:
        self._f_x.setEnabled(on)
        self._f_y.setEnabled(on)
        self._on_entry_field_changed()

    def _on_entry_field_changed(self, *_args) -> None:
        """条目表单即时写回内存（条目没有独立的「应用」，与角色级字段一起在 _apply 落脏）。"""
        if self._loading or self._entry_idx < 0:
            return
        entries = self._entries()
        if self._entry_idx >= len(entries):
            return
        e = entries[self._entry_idx]
        self._write_entry_into(e)
        item = self._entry_list.item(self._entry_idx)
        if item is not None:
            item.setText(self._entry_text(e))

    def _write_entry_into(self, e: dict) -> None:
        e["from"] = _fmt_clock(self._f_from.time())
        e["to"] = _fmt_clock(self._f_to.time())
        scene = self._f_scene.current_id().strip()
        if scene:
            e["scene"] = scene
        else:
            # 不落键＝不在任何场景（与运行时 `scene` 缺省语义一致）。
            e.pop("scene", None)
        if self._f_spot_on.isChecked():
            old = e.get("spot") if isinstance(e.get("spot"), dict) else None
            # 未改动的数值按原始表示回写（int 不得漂成 float）。
            e["spot"] = preserve_numeric_repr(
                {"x": self._f_x.value(), "y": self._f_y.value()}, old,
            )
        else:
            e.pop("spot", None)
        act = self._f_activity.text().strip()
        if act:
            e["activity"] = act
        else:
            e.pop("activity", None)
        conds = _read_conds(self._entry_cond, getattr(self, "_entry_cond_original", []))
        if conds:
            e["conditions"] = conds
        else:
            e.pop("conditions", None)

    def _add_entry(self) -> None:
        if self._current_idx < 0:
            return
        self._entries().append({"from": "08:00", "to": "18:00"})
        self._model.mark_dirty("npc_schedules")
        self._reload_entry_list()
        self._entry_list.setCurrentRow(len(self._entries()) - 1)

    def _delete_entry(self) -> None:
        entries = self._entries()
        if self._entry_idx < 0 or self._entry_idx >= len(entries):
            return
        del entries[self._entry_idx]
        self._model.mark_dirty("npc_schedules")
        self._reload_entry_list()

    def _move_entry(self, delta: int) -> None:
        entries = self._entries()
        i = self._entry_idx
        j = i + delta
        if i < 0 or j < 0 or i >= len(entries) or j >= len(entries):
            return
        entries[i], entries[j] = entries[j], entries[i]
        self._model.mark_dirty("npc_schedules")
        self._reload_entry_list()
        self._entry_list.setCurrentRow(j)

    # ---- 提交 ----

    def _write_row_into(self, data: dict) -> None:
        """把角色级 UI 值就地写入 data（条目已由 _on_entry_field_changed 即时写回）。"""
        data["characterId"] = self._f_character.current_id().strip()
        line = self._f_exit_line.text().strip()
        if line:
            data["exitLine"] = line
        else:
            data.pop("exitLine", None)
        pref = self._f_preferred_exit.current_id().strip()
        if pref:
            data["preferredExit"] = pref
        else:
            data.pop("preferredExit", None)
        conds = _read_conds(self._cond, getattr(self, "_cond_original", []))
        if conds:
            data["conditions"] = conds
        else:
            data.pop("conditions", None)

    def _is_dirty(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._rows):
            return False
        data = self._rows[self._current_idx]
        test = copy.deepcopy(data)
        self._write_row_into(test)
        return test != data

    def _apply(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._rows):
            return True
        data = self._rows[self._current_idx]
        new_id = self._f_character.current_id().strip()
        old_id = str(data.get("characterId", "") or "")
        if not new_id:
            QMessageBox.warning(self, "角色未选", "日程表必须绑定一个角色，已还原。")
            self._f_character.set_current(old_id)
            return False
        if new_id != old_id:
            taken = {
                str(r.get("characterId", "") or "")
                for i, r in enumerate(self._rows)
                if i != self._current_idx and isinstance(r, dict)
            }
            if new_id in taken:
                QMessageBox.warning(
                    self, "角色重复",
                    f"角色 {new_id!r} 已经有一张日程表了（一个角色至多一张），已还原。",
                )
                self._f_character.set_current(old_id)
                return False
        self._write_row_into(data)
        self._model.mark_dirty("npc_schedules")
        item = self._list.item(self._current_idx)
        if item is not None:
            item.setText(self._row_text(data))
        return True

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交；被拒时阻断保存。"""
        if self._current_idx >= 0 and self._is_dirty():
            return self._apply()
        return True

    def pop_flush_error(self) -> str:
        return "日程表的未应用编辑校验未通过（角色为空/重复），请先在「NPC 日程」页修正。"

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前日程表有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            return self._apply()
        # Discard 必须中和：把表单回滚到模型值，否则关闭路径的统一 flush 会把
        # 刚被放弃的编辑重新提交。
        self._on_select(self._current_idx)
        return True

    # ---- 增删 ----

    def _add(self) -> None:
        if self._current_idx >= 0 and self._is_dirty() and not self._apply():
            return
        self._rows.append({"characterId": "", "entries": []})
        self._model.mark_dirty("npc_schedules")
        self._refresh()
        self._list.setCurrentRow(len(self._rows) - 1)

    def _delete(self) -> None:
        row = self._list.currentRow()
        rows = self._rows
        if row < 0 or row >= len(rows):
            return
        cid = str(rows[row].get("characterId", "") or "(未选角色)")
        r = QMessageBox.question(
            self, "删除日程表",
            f"删除角色「{cid}」的整张日程表？\n"
            "删除后该角色回落为普通常驻 NPC（不再随时段走动）。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        del rows[row]
        self._current_idx = -1
        self._entry_idx = -1
        self._model.mark_dirty("npc_schedules")
        self._refresh()
