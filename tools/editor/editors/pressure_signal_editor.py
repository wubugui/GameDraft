"""临场长按（pressure_holds.json）与信号 Cue（signal_cues.json）编辑器。

与运行时约定见 `src/systems/pressureHold/types.ts` 与 `src/systems/SignalCueManager.ts`：
- 临场长按：长按充能 + 可中断（interrupts，按 atRatio 严格递增触发），中断可 abort；
  进度满走 onComplete。所有 Action 列表与对话/遭遇共用同一套类型。
- 信号 Cue：具名可复用的表现 Action 序列（如 Axiu「香粉味＋小调」三档）。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDoubleSpinBox,
    QGroupBox,
    QMessageBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.list_affordances import wire_list_affordances
from ..shared.action_editor import ActionEditor
from ..shared.audio_preview_selector import AudioIdPreviewSelector
from ..shared.hex_color_pick_row import HexColorPickRow
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection
from ..shared.rich_text_field import RichTextLineEdit


def _ratio_spin(value: float = 0.0) -> QDoubleSpinBox:
    sp = QDoubleSpinBox()
    sp.setRange(0.0, 1.0)
    sp.setSingleStep(0.05)
    sp.setDecimals(2)
    sp.setValue(value)
    return sp


class _InterruptRow(QWidget):
    """单个 interrupt：atRatio / resetToRatio / abort + Action 列表。"""

    def __init__(self, model: ProjectModel, data: dict, on_delete,
                 on_move_up=None, on_move_down=None, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        root = QVBoxLayout(self)
        root.setContentsMargins(6, 6, 6, 6)
        head = QHBoxLayout()
        head.addWidget(QLabel("atRatio"))
        self.at_ratio = _ratio_spin(float(data.get("atRatio") or 0.5))
        self.at_ratio.setToolTip("触发该中断的充能比例（0–1，须严格递增）")
        head.addWidget(self.at_ratio)
        head.addWidget(QLabel("resetToRatio"))
        self.reset_to = _ratio_spin(float(data.get("resetToRatio") or 0.0))
        self.reset_to.setToolTip("中断后回落到的充能比例（abort 勾选时忽略）")
        head.addWidget(self.reset_to)
        self.abort = QCheckBox("abort")
        self.abort.setChecked(bool(data.get("abort")))
        self.abort.setToolTip("勾选则到此直接打断整次长按（忽略 resetToRatio）")
        head.addWidget(self.abort)
        head.addStretch(1)
        if on_move_up is not None:
            btn_up = QPushButton("↑")
            btn_up.setToolTip("上移该中断")
            btn_up.setFixedWidth(28)
            btn_up.clicked.connect(lambda: on_move_up(self))
            head.addWidget(btn_up)
        if on_move_down is not None:
            btn_down = QPushButton("↓")
            btn_down.setToolTip("下移该中断")
            btn_down.setFixedWidth(28)
            btn_down.clicked.connect(lambda: on_move_down(self))
            head.addWidget(btn_down)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除该中断")
        btn_del.clicked.connect(lambda: on_delete(self))
        head.addWidget(btn_del)
        root.addLayout(head)
        self.actions = ActionEditor("中断时执行")
        self.actions.set_project_context(model, None)
        self.actions.set_data(data.get("actions", []) or [])
        root.addWidget(self.actions)

    def to_dict(self) -> dict:
        out: dict = {
            "atRatio": round(self.at_ratio.value(), 4),
            "actions": self.actions.to_list(),
        }
        if self.abort.isChecked():
            out["abort"] = True
        else:
            out["resetToRatio"] = round(self.reset_to.value(), 4)
        return out


class PressureHoldEditor(QWidget):
    """pressure_holds.json 编辑器（数据类型 'pressure_holds'）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        self._interrupt_rows: list[_InterruptRow] = []

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 长按")
        btn_add.setToolTip("新增一条临场长按")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中的临场长按（Delete 键 / 右键菜单亦可）")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除临场长按")
        ll.addWidget(self._list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)

        basic_box = QGroupBox("基本")
        f = compact_form(QFormLayout())
        basic_box.setLayout(f)
        self._f_id = QLineEdit()
        self._f_id.setToolTip("长按 id，全表唯一")
        f.addRow("id", self._f_id)
        self._f_prompt = RichTextLineEdit(self._model)
        self._f_prompt.setMinimumWidth(240)
        self._f_prompt.setToolTip("长按时屏幕显示的引导文案")
        f.addRow("prompt", self._f_prompt)
        self._f_release = RichTextLineEdit(self._model)
        self._f_release.setMinimumWidth(240)
        self._f_release.setToolTip("松手时闪现的提示（可空）")
        f.addRow("releaseHint", self._f_release)
        rl.addWidget(basic_box)

        tuning_box = QGroupBox("充能参数")
        ft = compact_form(QFormLayout())
        tuning_box.setLayout(ft)
        self._f_fill = QDoubleSpinBox()
        self._f_fill.setRange(0.1, 120.0)
        self._f_fill.setDecimals(2)
        self._f_fill.setSingleStep(0.5)
        self._f_fill.setToolTip("从 0 充满进度条所需的秒数")
        ft.addRow("fillSeconds", self._f_fill)
        self._f_decay = QDoubleSpinBox()
        self._f_decay.setRange(0.0, 10.0)
        self._f_decay.setDecimals(2)
        self._f_decay.setSingleStep(0.1)
        self._f_decay.setToolTip("松手后每秒回落的进度量")
        ft.addRow("decayPerSecond", self._f_decay)
        self._f_sfx = AudioIdPreviewSelector(self._model, "sfx", allow_empty=True, editable=True)
        self._f_sfx.setToolTip("长按时循环的音效 id（可空）；右侧按钮可试听当前选择。")
        ft.addRow("holdSfx", self._f_sfx)
        self._f_color_chk = QCheckBox("自定义")
        self._f_color_chk.setToolTip("勾选则覆盖进度条默认颜色")
        self._f_color = HexColorPickRow("#888888", title="barColor")
        self._f_color.setEnabled(False)
        self._f_color_chk.toggled.connect(self._f_color.setEnabled)
        _color_row = QWidget()
        _crl = QHBoxLayout(_color_row)
        _crl.setContentsMargins(0, 0, 0, 0)
        _crl.addWidget(self._f_color_chk)
        _crl.addWidget(self._f_color)
        _crl.addStretch()
        ft.addRow("barColor", _color_row)
        rl.addWidget(tuning_box)

        int_box = QGroupBox("中断（按 atRatio 严格递增）")
        int_box.setToolTip("充能到 atRatio 时触发的中断；列表顺序须按 atRatio 递增")
        int_lay = QVBoxLayout(int_box)
        self._interrupts_box = QVBoxLayout()
        int_lay.addLayout(self._interrupts_box)
        btn_add_int = QPushButton("+ 中断")
        btn_add_int.setToolTip("在末尾添加一个中断")
        btn_add_int.clicked.connect(self._add_interrupt)
        int_lay.addWidget(btn_add_int)
        rl.addWidget(int_box)

        self._on_complete = ActionEditor("进度满时执行 (onComplete)")
        oc_sec = CollapsibleSection("进度满时执行 (onComplete)", start_open=False)
        oc_sec.set_header_tool_tip("充能进度满时执行的动作；默认折叠。")
        oc_sec.add_body(self._on_complete)
        rl.addWidget(oc_sec)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)
        rl.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right_host)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 640])
        root.addWidget(splitter)
        self._refresh()

    # ---- helpers -----------------------------------------------------------

    def _refresh(self) -> None:
        self._list.clear()
        for h in self._model.pressure_holds:
            self._list.addItem(f"{h.get('id', '?')}  [{h.get('prompt', '')[:18]}]")

    def _clear_interrupt_rows(self) -> None:
        for row in self._interrupt_rows:
            self._interrupts_box.removeWidget(row)
            row.deleteLater()
        self._interrupt_rows = []

    def _add_interrupt_row(self, data: dict) -> None:
        row = _InterruptRow(
            self._model, data, self._delete_interrupt,
            on_move_up=self._move_interrupt_up,
            on_move_down=self._move_interrupt_down,
        )
        self._interrupt_rows.append(row)
        self._interrupts_box.addWidget(row)

    def _delete_interrupt(self, row: _InterruptRow) -> None:
        if row in self._interrupt_rows:
            self._interrupt_rows.remove(row)
            self._interrupts_box.removeWidget(row)
            row.deleteLater()

    def _reorder_interrupts(self, a: int, b: int) -> None:
        """Swap two interrupt rows in the live list and re-lay-out (UI only)."""
        rows = self._interrupt_rows
        if not (0 <= a < len(rows) and 0 <= b < len(rows)):
            return
        rows[a], rows[b] = rows[b], rows[a]
        for row in rows:
            self._interrupts_box.removeWidget(row)
        for row in rows:
            self._interrupts_box.addWidget(row)

    def _move_interrupt_up(self, row: _InterruptRow) -> None:
        if row not in self._interrupt_rows:
            return
        i = self._interrupt_rows.index(row)
        if i > 0:
            self._reorder_interrupts(i, i - 1)

    def _move_interrupt_down(self, row: _InterruptRow) -> None:
        if row not in self._interrupt_rows:
            return
        i = self._interrupt_rows.index(row)
        if i < len(self._interrupt_rows) - 1:
            self._reorder_interrupts(i, i + 1)

    def _add_interrupt(self) -> None:
        self._add_interrupt_row({"atRatio": 0.5, "resetToRatio": 0.0, "actions": []})

    # ---- list ops ----------------------------------------------------------

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.pressure_holds):
            self._current_idx = -1  # 清选中即清索引，杜绝"删除删旧项"（审查 P2-30）
            return
        # commit-on-leave：切到别的条目前提交上一项未应用编辑，避免静默丢弃。
        if 0 <= self._current_idx < len(self._model.pressure_holds) \
                and self._current_idx != row and self._is_dirty():
            self._apply()
        self._current_idx = row
        h = self._model.pressure_holds[row]
        self._f_id.setText(h.get("id", ""))
        self._f_prompt.setText(h.get("prompt", ""))
        self._f_release.setText(h.get("releaseHint", ""))
        self._f_fill.setValue(float(h.get("fillSeconds") or 3.0))
        self._f_decay.setValue(float(h.get("decayPerSecond") or 0.6))
        _sfx_cur = h.get("holdSfx", "") or ""
        _sfx_ids = list(self._model.all_audio_ids("sfx"))
        if _sfx_cur and _sfx_cur not in _sfx_ids:
            _sfx_ids = [_sfx_cur] + _sfx_ids
        self._f_sfx.set_items(_sfx_ids)
        self._f_sfx.set_current(_sfx_cur)
        _bc = str(h.get("barColor", "") or "")
        self._f_color_chk.setChecked(bool(_bc))
        self._f_color.setEnabled(bool(_bc))
        if _bc:
            self._f_color.set_hex(_bc)
        self._clear_interrupt_rows()
        for it in h.get("interrupts", []) or []:
            if isinstance(it, dict):
                self._add_interrupt_row(it)
        self._on_complete.set_project_context(self._model, None)
        self._on_complete.set_data(h.get("onComplete", []) or [])

    def _is_dirty(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._model.pressure_holds):
            return False
        h = self._model.pressure_holds[self._current_idx]
        test = copy.deepcopy(h)
        self._write_hold_into(test)
        return test != h

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交，避免静默丢弃。"""
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前临场长按有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        return True

    def _write_hold_into(self, h: dict) -> None:
        """把当前 UI 值就地写入 h（不 mark_dirty / 不刷新列表）。_apply 与脏判断共用。"""
        h["id"] = self._f_id.text().strip()
        h["prompt"] = self._f_prompt.text()
        release = self._f_release.text().strip()
        if release:
            h["releaseHint"] = release
        else:
            h.pop("releaseHint", None)
        h["fillSeconds"] = round(self._f_fill.value(), 4)
        h["decayPerSecond"] = round(self._f_decay.value(), 4)
        sfx = self._f_sfx.current_id().strip()
        if sfx:
            h["holdSfx"] = sfx
        else:
            h.pop("holdSfx", None)
        if self._f_color_chk.isChecked():
            h["barColor"] = self._f_color.hex().strip()
        else:
            h.pop("barColor", None)
        interrupts = [row.to_dict() for row in self._interrupt_rows]
        if interrupts:
            h["interrupts"] = interrupts
        else:
            h.pop("interrupts", None)
        on_complete = self._on_complete.to_list()
        if on_complete:
            h["onComplete"] = on_complete
        else:
            h.pop("onComplete", None)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        h = self._model.pressure_holds[self._current_idx]
        self._write_hold_into(h)
        self._model.mark_dirty("pressure_holds")
        lw = self._list.item(self._current_idx)
        if lw is not None:
            lw.setText(f"{h.get('id', '?')}  [{h.get('prompt', '')[:18]}]")

    def _add(self) -> None:
        taken = {str(h.get("id", "")) for h in self._model.pressure_holds}
        n = 0
        while f"hold_{n}" in taken:
            n += 1
        self._model.pressure_holds.append({
            "id": f"hold_{n}",
            "prompt": "",
            "fillSeconds": 3.0,
            "decayPerSecond": 0.6,
        })
        self._model.mark_dirty("pressure_holds")
        self._refresh()
        self._list.setCurrentRow(len(self._model.pressure_holds) - 1)

    def _delete(self) -> None:
        if self._current_idx >= 0:
            h = self._model.pressure_holds[self._current_idx]
            if not confirm.confirm_delete(self, f"临场长按「{h.get('id', '')}」"):
                return
            self._model.pressure_holds.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("pressure_holds")
            self._refresh()


class SignalCueEditor(QWidget):
    """signal_cues.json 编辑器（数据类型 'signal_cues'）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Cue")
        btn_add.setToolTip("新增一条信号 Cue")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中的信号 Cue（Delete 键 / 右键菜单亦可）")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除信号 Cue")
        ll.addWidget(self._list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)
        basic_box = QGroupBox("基本")
        f = compact_form(QFormLayout())
        basic_box.setLayout(f)
        self._f_id = QLineEdit()
        self._f_id.setToolTip("信号 Cue id，全表唯一")
        f.addRow("id", self._f_id)
        self._f_desc = QLineEdit()
        self._f_desc.setMinimumWidth(240)
        self._f_desc.setToolTip("策划备注（不影响运行时，可空）")
        f.addRow("description", self._f_desc)
        rl.addWidget(basic_box)
        self._actions = ActionEditor("Cue 表现序列 (actions)")
        rl.addWidget(self._actions)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)
        rl.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right_host)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 640])
        root.addWidget(splitter)
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for c in self._model.signal_cues:
            self._list.addItem(f"{c.get('id', '?')}  [{c.get('description', '')[:22]}]")

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.signal_cues):
            self._current_idx = -1  # 清选中即清索引，杜绝"删除删旧项"（审查 P2-30）
            return
        # commit-on-leave：切到别的信号 Cue 前提交上一项未应用编辑。
        if 0 <= self._current_idx < len(self._model.signal_cues) \
                and self._current_idx != row and self._is_dirty():
            self._apply()
        self._current_idx = row
        c = self._model.signal_cues[row]
        self._f_id.setText(c.get("id", ""))
        self._f_desc.setText(c.get("description", "") or "")
        self._actions.set_project_context(self._model, None)
        self._actions.set_data(c.get("actions", []) or [])

    def _write_cue_into(self, c: dict) -> None:
        c["id"] = self._f_id.text().strip()
        desc = self._f_desc.text().strip()
        if desc:
            c["description"] = desc
        else:
            c.pop("description", None)
        c["actions"] = self._actions.to_list()

    def _is_dirty(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._model.signal_cues):
            return False
        c = self._model.signal_cues[self._current_idx]
        test = copy.deepcopy(c)
        self._write_cue_into(test)
        return test != c

    def flush_to_model(self) -> bool:
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前信号 Cue 有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        return True

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        c = self._model.signal_cues[self._current_idx]
        self._write_cue_into(c)
        self._model.mark_dirty("signal_cues")
        lw = self._list.item(self._current_idx)
        if lw is not None:
            lw.setText(f"{c.get('id', '?')}  [{c.get('description', '')[:22]}]")

    def _add(self) -> None:
        taken = {str(c.get("id", "")) for c in self._model.signal_cues}
        n = 0
        while f"cue_{n}" in taken:
            n += 1
        self._model.signal_cues.append({
            "id": f"cue_{n}",
            "actions": [],
        })
        self._model.mark_dirty("signal_cues")
        self._refresh()
        self._list.setCurrentRow(len(self._model.signal_cues) - 1)

    def _delete(self) -> None:
        if self._current_idx >= 0:
            c = self._model.signal_cues[self._current_idx]
            if not confirm.confirm_delete(self, f"信号 Cue「{c.get('id', '')}」"):
                return
            self._model.signal_cues.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("signal_cues")
            self._refresh()
