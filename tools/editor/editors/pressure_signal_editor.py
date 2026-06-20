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
from ..shared.action_editor import ActionEditor
from ..shared.form_layout import compact_form
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

    def __init__(self, model: ProjectModel, data: dict, on_delete, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        root = QVBoxLayout(self)
        root.setContentsMargins(6, 6, 6, 6)
        head = QHBoxLayout()
        head.addWidget(QLabel("atRatio"))
        self.at_ratio = _ratio_spin(float(data.get("atRatio") or 0.5))
        head.addWidget(self.at_ratio)
        head.addWidget(QLabel("resetToRatio"))
        self.reset_to = _ratio_spin(float(data.get("resetToRatio") or 0.0))
        head.addWidget(self.reset_to)
        self.abort = QCheckBox("abort（到此打断整次长按）")
        self.abort.setChecked(bool(data.get("abort")))
        head.addWidget(self.abort)
        head.addStretch(1)
        btn_del = QPushButton("删除中断")
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
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)
        f = compact_form(QFormLayout())
        self._f_id = QLineEdit()
        f.addRow("id", self._f_id)
        self._f_prompt = RichTextLineEdit(self._model)
        self._f_prompt.setMinimumWidth(240)
        f.addRow("prompt（引导文案）", self._f_prompt)
        self._f_release = RichTextLineEdit(self._model)
        self._f_release.setMinimumWidth(240)
        f.addRow("releaseHint（松手闪现）", self._f_release)
        self._f_fill = QDoubleSpinBox()
        self._f_fill.setRange(0.1, 120.0)
        self._f_fill.setDecimals(2)
        self._f_fill.setSingleStep(0.5)
        f.addRow("fillSeconds（充满秒数）", self._f_fill)
        self._f_decay = QDoubleSpinBox()
        self._f_decay.setRange(0.0, 10.0)
        self._f_decay.setDecimals(2)
        self._f_decay.setSingleStep(0.1)
        f.addRow("decayPerSecond（回落/秒）", self._f_decay)
        self._f_sfx = QLineEdit()
        f.addRow("holdSfx（音效 id，可空）", self._f_sfx)
        self._f_color = QLineEdit()
        self._f_color.setPlaceholderText("#rrggbb，可空")
        f.addRow("barColor", self._f_color)
        rl.addLayout(f)

        rl.addWidget(QLabel("<b>中断（按 atRatio 严格递增）</b>"))
        self._interrupts_box = QVBoxLayout()
        rl.addLayout(self._interrupts_box)
        btn_add_int = QPushButton("+ 中断")
        btn_add_int.clicked.connect(self._add_interrupt)
        rl.addWidget(btn_add_int)

        self._on_complete = ActionEditor("进度满时执行 (onComplete)")
        rl.addWidget(self._on_complete)

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
        row = _InterruptRow(self._model, data, self._delete_interrupt)
        self._interrupt_rows.append(row)
        self._interrupts_box.addWidget(row)

    def _delete_interrupt(self, row: _InterruptRow) -> None:
        if row in self._interrupt_rows:
            self._interrupt_rows.remove(row)
            self._interrupts_box.removeWidget(row)
            row.deleteLater()

    def _add_interrupt(self) -> None:
        self._add_interrupt_row({"atRatio": 0.5, "resetToRatio": 0.0, "actions": []})

    # ---- list ops ----------------------------------------------------------

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.pressure_holds):
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
        self._f_sfx.setText(h.get("holdSfx", "") or "")
        self._f_color.setText(h.get("barColor", "") or "")
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
        sfx = self._f_sfx.text().strip()
        if sfx:
            h["holdSfx"] = sfx
        else:
            h.pop("holdSfx", None)
        color = self._f_color.text().strip()
        if color:
            h["barColor"] = color
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
        self._model.pressure_holds.append({
            "id": f"hold_{len(self._model.pressure_holds)}",
            "prompt": "",
            "fillSeconds": 3.0,
            "decayPerSecond": 0.6,
        })
        self._model.mark_dirty("pressure_holds")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
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
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)
        f = compact_form(QFormLayout())
        self._f_id = QLineEdit()
        f.addRow("id", self._f_id)
        self._f_desc = QLineEdit()
        self._f_desc.setMinimumWidth(240)
        f.addRow("description（策划备注）", self._f_desc)
        rl.addLayout(f)
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
        self._model.signal_cues.append({
            "id": f"cue_{len(self._model.signal_cues)}",
            "actions": [],
        })
        self._model.mark_dirty("signal_cues")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.signal_cues.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("signal_cues")
            self._refresh()
