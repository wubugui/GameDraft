"""Single-node form editor for DialogueGraphNodeDef."""
from __future__ import annotations

import json
from typing import Any, Callable

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel, QLineEdit,
    QPlainTextEdit, QComboBox, QTableWidget, QTableWidgetItem, QPushButton,
    QHeaderView, QMessageBox, QCheckBox, QGroupBox, QInputDialog,
)
from PySide6.QtCore import Qt


SpeakerKinds = ("player", "npc", "literal", "sceneNpc")


def _speaker_to_ui(sp: dict[str, Any]) -> tuple[str, str]:
    k = sp.get("kind", "player")
    if k == "literal":
        return "literal", str(sp.get("name", ""))
    if k == "sceneNpc":
        return "sceneNpc", str(sp.get("npcId", ""))
    return k if k in ("player", "npc") else "player", ""


def _ui_to_speaker(kind: str, extra: str) -> dict[str, Any]:
    if kind == "literal":
        return {"kind": "literal", "name": extra or "旁白"}
    if kind == "sceneNpc":
        return {"kind": "sceneNpc", "npcId": extra or "npc"}
    if kind == "npc":
        return {"kind": "npc"}
    return {"kind": "player"}


class NodeInspector(QWidget):
    """Emits content_changed when user edits."""

    def __init__(
        self,
        list_node_ids: Callable[[], list[str]],
        parent=None,
    ):
        super().__init__(parent)
        self._list_node_ids = list_node_ids
        self._node_id = ""
        self._root_layout = QVBoxLayout(self)

        self._type_label = QLabel()
        self._root_layout.addWidget(self._type_label)

        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._root_layout.addWidget(self._body)

        self._clear_body()

    def _clear_body(self):
        while self._body_layout.count():
            item = self._body_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _emit_changed(self):
        # Parent connects to slot that reads get_node()
        if hasattr(self, "_change_cb") and self._change_cb:
            self._change_cb()

    def set_change_callback(self, cb):
        self._change_cb = cb

    def set_node(self, node_id: str, data: dict[str, Any]):
        self._node_id = node_id
        self._clear_body()
        t = data.get("type", "?")
        self._type_label.setText(f"节点 id：<b>{node_id}</b>　　类型：<b>{t}</b>")

        if t == "line":
            self._build_line(data)
        elif t == "runActions":
            self._build_run_actions(data)
        elif t == "choice":
            self._build_choice(data)
        elif t == "switch":
            self._build_switch(data)
        elif t == "end":
            self._body_layout.addWidget(QLabel("结束节点，无额外字段。"))
            self._getter = lambda: {"type": "end"}
        else:
            self._body_layout.addWidget(QLabel(f"未知类型 {t!r}，请用「原始 JSON」在后续版本编辑。"))

    def get_node(self) -> dict[str, Any]:
        """Return current node dict from form state."""
        getter = getattr(self, "_getter", None)
        if getter:
            return getter()
        return {"type": "end"}

    # --- line ---
    def _build_line(self, data: dict[str, Any]):
        sp = data.get("speaker") or {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)

        kind_cb = QComboBox()
        for k in SpeakerKinds:
            kind_cb.addItem(k, k)
        idx = kind_cb.findData(kind)
        kind_cb.setCurrentIndex(max(0, idx))
        extra_edit = QLineEdit(extra)
        text_edit = QPlainTextEdit()
        text_edit.setPlaceholderText("对白正文")
        text_edit.setPlainText(str(data.get("text", "")))
        text_key = QLineEdit(str(data.get("textKey", "")))
        text_key.setPlaceholderText("可选：strings 键，与 text 二选一")
        next_edit = QLineEdit(str(data.get("next", "")))
        next_edit.setPlaceholderText("下一节点 id")
        pick = QPushButton("选…")
        pick.clicked.connect(lambda: self._pick_target(next_edit))

        def upd_extra_label():
            k = kind_cb.currentData()
            extra_edit.setVisible(k in ("literal", "sceneNpc"))
            extra_edit.setPlaceholderText("显示名" if k == "literal" else "npcId")

        kind_cb.currentIndexChanged.connect(lambda _: (upd_extra_label(), self._emit_changed()))
        for w in (extra_edit, text_edit, text_key, next_edit):
            if isinstance(w, QPlainTextEdit):
                w.textChanged.connect(self._emit_changed)
            else:
                w.textChanged.connect(self._emit_changed)
        upd_extra_label()

        fl = QFormLayout()
        fl.addRow("说话人 kind", kind_cb)
        fl.addRow("名字 / npcId", extra_edit)
        fl.addRow("text", text_edit)
        fl.addRow("textKey（可选）", text_key)
        row = QHBoxLayout()
        row.addWidget(next_edit)
        row.addWidget(pick)
        fl.addRow("next", row)
        self._body_layout.addLayout(fl)

        def getter():
            k = kind_cb.currentData()
            ex = extra_edit.text().strip()
            out: dict[str, Any] = {
                "type": "line",
                "speaker": _ui_to_speaker(k, ex),
                "next": next_edit.text().strip(),
            }
            tx = text_edit.toPlainText()
            if tx.strip():
                out["text"] = tx
            tk = text_key.text().strip()
            if tk:
                out["textKey"] = tk
            return out

        self._getter = getter

    # --- runActions ---
    def _build_run_actions(self, data: dict[str, Any]):
        acts = data.get("actions")
        if not isinstance(acts, list):
            acts = []
        js = json.dumps(acts, ensure_ascii=False, indent=2)
        edit = QPlainTextEdit()
        edit.setPlainText(js)
        edit.setPlaceholderText('[\n  { "type": "setFlag", "params": { ... } }\n]')
        next_edit = QLineEdit(str(data.get("next", "")))
        pick = QPushButton("选…")
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        edit.textChanged.connect(self._emit_changed)
        next_edit.textChanged.connect(self._emit_changed)

        fl = QFormLayout()
        row = QHBoxLayout()
        row.addWidget(next_edit)
        row.addWidget(pick)
        fl.addRow("next", row)
        self._body_layout.addLayout(fl)
        self._body_layout.addWidget(QLabel("actions（JSON 数组）"))
        self._body_layout.addWidget(edit)

        def getter():
            try:
                parsed = json.loads(edit.toPlainText() or "[]")
            except json.JSONDecodeError as e:
                raise ValueError(f"actions JSON 无效: {e}") from e
            if not isinstance(parsed, list):
                raise ValueError("actions 必须是数组")
            return {"type": "runActions", "actions": parsed, "next": next_edit.text().strip()}

        self._getter = getter

    # --- choice ---
    def _build_choice(self, data: dict[str, Any]):
        # promptLine optional
        pl = data.get("promptLine")
        has_pl = isinstance(pl, dict) and pl
        cb_pl = QCheckBox("有 promptLine（选项前多播一行）")
        cb_pl.setChecked(bool(has_pl))

        sp = (pl or {}).get("speaker") if has_pl else {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)
        pl_kind = QComboBox()
        for k in SpeakerKinds:
            pl_kind.addItem(k, k)
        pl_kind.setCurrentIndex(max(0, pl_kind.findData(kind)))
        pl_extra = QLineEdit(extra)
        pl_text = QPlainTextEdit()
        pl_text.setPlainText(str((pl or {}).get("text", "")))

        prompt_box = QGroupBox("promptLine")
        pfl = QFormLayout()
        pfl.addRow("kind", pl_kind)
        pfl.addRow("名字/npcId", pl_extra)
        pfl.addRow("text", pl_text)
        prompt_box.setLayout(pfl)
        prompt_box.setVisible(has_pl)

        def toggle_pl():
            prompt_box.setVisible(cb_pl.isChecked())
            self._emit_changed()

        cb_pl.toggled.connect(toggle_pl)
        for w in (pl_kind, pl_extra, pl_text):
            if isinstance(w, QPlainTextEdit):
                w.textChanged.connect(self._emit_changed)
            else:
                w.textChanged.connect(self._emit_changed)

        self._body_layout.addWidget(cb_pl)
        self._body_layout.addWidget(prompt_box)

        opts = data.get("options")
        if not isinstance(opts, list):
            opts = []
        table = QTableWidget(0, 6)
        table.setHorizontalHeaderLabels(
            ["id", "text", "next", "requireFlag", "costCoins", "ruleHintId"]
        )
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)

        def add_row(od: dict[str, Any]):
            r = table.rowCount()
            table.insertRow(r)
            for c, key in enumerate(
                ["id", "text", "next", "requireFlag", "costCoins", "ruleHintId"]
            ):
                val = od.get(key, "")
                if key == "costCoins" and val != "" and val is not None:
                    val = str(val)
                it = QTableWidgetItem(str(val) if val is not None else "")
                table.setItem(r, c, it)

        for od in opts:
            if isinstance(od, dict):
                add_row(od)

        def mk_btns():
            h = QHBoxLayout()
            b_add = QPushButton("添加选项")
            b_del = QPushButton("删除所选行")

            def do_add():
                r = table.rowCount()
                table.insertRow(r)
                for c in range(6):
                    table.setItem(r, c, QTableWidgetItem(""))

            def do_del():
                r = table.currentRow()
                if r >= 0:
                    table.removeRow(r)
                self._emit_changed()

            b_add.clicked.connect(do_add)
            b_add.clicked.connect(self._emit_changed)
            b_del.clicked.connect(do_del)
            h.addWidget(b_add)
            h.addWidget(b_del)
            return h

        self._body_layout.addWidget(table)
        self._body_layout.addLayout(mk_btns())

        table.itemChanged.connect(lambda _: self._emit_changed())

        def getter():
            options: list[dict[str, Any]] = []
            for r in range(table.rowCount()):
                row: dict[str, Any] = {}
                for c, key in enumerate(
                    ["id", "text", "next", "requireFlag", "costCoins", "ruleHintId"]
                ):
                    it = table.item(r, c)
                    s = (it.text().strip() if it else "") if it else ""
                    if key == "costCoins":
                        if s:
                            try:
                                row[key] = int(s)
                            except ValueError:
                                row[key] = s
                    elif s:
                        row[key] = s
                if row.get("id") and row.get("text") and "next" in row:
                    options.append(row)
            out: dict[str, Any] = {"type": "choice", "options": options}
            if cb_pl.isChecked():
                k = pl_kind.currentData()
                ex = pl_extra.text().strip()
                out["promptLine"] = {
                    "speaker": _ui_to_speaker(k, ex),
                    "text": pl_text.toPlainText(),
                }
            return out

        self._getter = getter

    # --- switch ---
    def _build_switch(self, data: dict[str, Any]):
        cases = data.get("cases")
        if not isinstance(cases, list):
            cases = []
        table = QTableWidget(0, 2)
        table.setHorizontalHeaderLabels(["conditions（JSON 数组）", "next"])
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)

        for c in cases:
            if not isinstance(c, dict):
                continue
            r = table.rowCount()
            table.insertRow(r)
            conds = c.get("conditions", [])
            try:
                cj = json.dumps(conds, ensure_ascii=False)
            except TypeError:
                cj = "[]"
            table.setItem(r, 0, QTableWidgetItem(cj))
            table.setItem(r, 1, QTableWidgetItem(str(c.get("next", ""))))

        def add_row():
            table.insertRow(table.rowCount())
            table.setItem(table.rowCount() - 1, 0, QTableWidgetItem("[]"))
            table.setItem(table.rowCount() - 1, 1, QTableWidgetItem(""))
            self._emit_changed()

        def del_row():
            r = table.currentRow()
            if r >= 0:
                table.removeRow(r)
            self._emit_changed()

        hb = QHBoxLayout()
        b1, b2 = QPushButton("添加分支"), QPushButton("删除所选行")
        b1.clicked.connect(add_row)
        b2.clicked.connect(del_row)
        hb.addWidget(b1)
        hb.addWidget(b2)

        dn = QLineEdit(str(data.get("defaultNext", "")))
        pick = QPushButton("选…")
        pick.clicked.connect(lambda: self._pick_target(dn))
        dn.textChanged.connect(self._emit_changed)
        table.itemChanged.connect(lambda _: self._emit_changed())

        fl = QFormLayout()
        row = QHBoxLayout()
        row.addWidget(dn)
        row.addWidget(pick)
        fl.addRow("defaultNext", row)
        self._body_layout.addLayout(fl)
        self._body_layout.addWidget(QLabel("cases：自上而下命中第一条"))
        self._body_layout.addWidget(table)
        self._body_layout.addLayout(hb)

        def getter():
            cs: list[dict[str, Any]] = []
            for r in range(table.rowCount()):
                it0 = table.item(r, 0)
                it1 = table.item(r, 1)
                js = (it0.text().strip() if it0 else "") or "[]"
                try:
                    conds = json.loads(js)
                except json.JSONDecodeError as e:
                    raise ValueError(f"第 {r} 行 conditions JSON 无效: {e}") from e
                if not isinstance(conds, list):
                    raise ValueError(f"第 {r} 行 conditions 必须是数组")
                nx = (it1.text().strip() if it1 else "")
                cs.append({"conditions": conds, "next": nx})
            return {"type": "switch", "cases": cs, "defaultNext": dn.text().strip()}

        self._getter = getter

    def _pick_target(self, line_edit: QLineEdit):
        ids = self._list_node_ids()
        if not ids:
            QMessageBox.information(self, "选择 next", "图中还没有其它节点 id。")
            return
        choice, ok = QInputDialog.getItem(
            self, "选择目标节点", "next", ids, 0, False
        )
        if ok and choice:
            line_edit.setText(choice)
