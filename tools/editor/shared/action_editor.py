"""Reusable ActionDef[] editor with dynamic params forms."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QCheckBox, QFormLayout, QFrame,
)

from PySide6.QtCore import Signal

from .flag_key_selector import populate_flag_key_combo

ACTION_TYPES = [
    "setFlag", "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "giveFragment", "updateQuest", "startEncounter",
    "playBgm", "stopBgm", "playSfx", "endDay", "addDelayedEvent",
    "addArchiveEntry", "startCutscene", "showEmote", "openShop",
    "pickup", "switchScene", "changeScene", "showNotification",
    "shopPurchase", "inventoryDiscard",
]

_PARAM_SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "setFlag": [("key", "str"), ("value", "flag_val")],
    "giveItem": [("id", "str"), ("count", "int")],
    "removeItem": [("id", "str"), ("count", "int")],
    "giveCurrency": [("amount", "int")],
    "removeCurrency": [("amount", "int")],
    "giveRule": [("id", "str")],
    "giveFragment": [("id", "str")],
    "updateQuest": [("id", "str")],
    "startEncounter": [("id", "str")],
    "playBgm": [("id", "str"), ("fadeMs", "int")],
    "stopBgm": [("fadeMs", "int")],
    "playSfx": [("id", "str")],
    "endDay": [],
    "addArchiveEntry": [("bookType", "str"), ("entryId", "str")],
    "startCutscene": [("id", "str")],
    "showEmote": [("target", "str"), ("emote", "str")],
    "openShop": [("shopId", "str")],
    "switchScene": [("sceneId", "str"), ("spawnPoint", "str")],
    "changeScene": [("sceneId", "str"), ("spawnPoint", "str")],
    "showNotification": [("text", "str"), ("type", "str")],
    "shopPurchase": [("itemId", "str"), ("price", "int")],
    "inventoryDiscard": [("itemId", "str")],
    "pickup": [("id", "str"), ("name", "str"), ("count", "int"), ("isCurrency", "bool")],
}


class ActionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(self, data: dict | None = None, parent: QWidget | None = None,
                 shared_flag_keys: list[str] | None = None):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._shared_flag_keys = shared_flag_keys or []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)

        top = QHBoxLayout()
        self.type_combo = QComboBox()
        self.type_combo.addItems(ACTION_TYPES)
        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))
        top.addWidget(self.type_combo, stretch=1)
        top.addWidget(self.del_btn)
        outer.addLayout(top)

        self._params_frame = QFrame()
        self._params_layout = QFormLayout(self._params_frame)
        self._params_layout.setContentsMargins(20, 0, 0, 0)
        outer.addWidget(self._params_frame)

        self._data = data or {"type": "setFlag", "params": {}}
        self.type_combo.setCurrentText(self._data.get("type", "setFlag"))
        self._rebuild_params()

        self.type_combo.currentTextChanged.connect(self._on_type_changed)

    def _on_type_changed(self, _text: str) -> None:
        self._data["params"] = {}
        self._rebuild_params()
        self.changed.emit()

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._param_widgets.clear()

        act_type = self.type_combo.currentText()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params = self._data.get("params", {})

        if not schema:
            self._params_frame.setVisible(False)
            return
        self._params_frame.setVisible(True)

        for pname, ptype in schema:
            val = params.get(pname, "")
            if ptype == "int":
                w = QSpinBox()
                w.setRange(-999999, 999999)
                w.setValue(int(val) if val != "" else 0)
                w.valueChanged.connect(self.changed)
            elif ptype == "bool":
                w = QCheckBox()
                w.setChecked(bool(val))
                w.stateChanged.connect(self.changed)
            elif ptype == "flag_val":
                w = QLineEdit(str(val) if val != "" else "true")
                w.setPlaceholderText("true / false / number")
                w.textChanged.connect(self.changed)
            elif act_type == "setFlag" and pname == "key":
                w = QComboBox()
                w.setEditable(False)
                w.setMinimumWidth(180)
                cur = str(val) if val is not None else ""
                populate_flag_key_combo(w, self._shared_flag_keys, cur)
                w.currentIndexChanged.connect(self.changed)
            else:
                w = QLineEdit(str(val))
                w.textChanged.connect(self.changed)
            self._param_widgets[pname] = w
            self._params_layout.addRow(pname, w)

    def to_dict(self) -> dict:
        act_type = self.type_combo.currentText()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params: dict = {}
        for pname, ptype in schema:
            w = self._param_widgets.get(pname)
            if w is None:
                continue
            if ptype == "int":
                params[pname] = w.value()
            elif ptype == "bool":
                params[pname] = w.isChecked()
            elif ptype == "flag_val":
                raw = w.text().strip()
                if raw == "true":
                    params[pname] = True
                elif raw == "false":
                    params[pname] = False
                else:
                    try:
                        params[pname] = int(raw)
                    except ValueError:
                        params[pname] = raw
            elif act_type == "setFlag" and pname == "key" and isinstance(w, QComboBox):
                raw_k = w.currentData()
                params[pname] = raw_k if isinstance(raw_k, str) else (str(raw_k) if raw_k else "")
            else:
                params[pname] = w.text()
        return {"type": act_type, "params": params}

    def refresh_setflag_key_combo(self) -> None:
        w = self._param_widgets.get("key")
        if w is None or self.type_combo.currentText() != "setFlag":
            return
        if isinstance(w, QComboBox):
            cur = w.currentData()
            cur_s = str(cur) if cur else ""
            populate_flag_key_combo(w, self._shared_flag_keys, cur_s)


class ActionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Actions", parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[ActionRow] = []
        self._shared_flag_keys: list[str] = []
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(4)
        root.addLayout(self._rows_layout)
        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

    def set_flag_keys(self, keys: list[str]) -> None:
        """Allowed flag keys from registry only (expanded)."""
        self._shared_flag_keys.clear()
        self._shared_flag_keys.extend(keys)
        for r in self._rows:
            r._shared_flag_keys = self._shared_flag_keys
            r.refresh_setflag_key_combo()

    def set_flag_completions(self, keys: list[str]) -> None:
        """Backward-compatible name; keys must be registry-expanded list."""
        self.set_flag_keys(keys)

    def set_data(self, actions: list[dict]) -> None:
        self._clear()
        for a in actions:
            self._add_row(a)

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self._rows]

    def _clear(self) -> None:
        for r in self._rows:
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()

    def _add_row(self, data: dict | None = None) -> None:
        row = ActionRow(data, shared_flag_keys=self._shared_flag_keys)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty(self) -> None:
        self._add_row({"type": "setFlag", "params": {}})
        self.changed.emit()

    def _remove_row(self, row: ActionRow) -> None:
        if row in self._rows:
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()
