"""Reusable ActionDef[] editor with dynamic params forms."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QCheckBox, QFormLayout, QFrame,
)

from PySide6.QtCore import Signal

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit

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

    def __init__(
        self,
        data: dict | None = None,
        parent: QWidget | None = None,
        model=None,
        scene_id: str | None = None,
    ):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._ctx_model = model
        self._ctx_scene_id = scene_id

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

    def set_project_context(self, model, scene_id: str | None) -> None:
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        w = self._param_widgets.get("key")
        if isinstance(w, FlagKeyPickField):
            w.set_context(model, scene_id)
        vw = self._param_widgets.get("value")
        if isinstance(vw, FlagValueEdit):
            vw.set_registry(model.flag_registry if model else {})
            if isinstance(w, FlagKeyPickField):
                vw.set_flag_key(w.key())

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
                w = FlagValueEdit(self, self._ctx_model.flag_registry if self._ctx_model else {})
                if act_type != "setFlag":
                    w.set_value(val if val != "" else True)
                w.valueChanged.connect(self.changed)
            elif act_type == "setFlag" and pname == "key":
                cur = str(val) if val is not None else ""
                w = FlagKeyPickField(self._ctx_model, self._ctx_scene_id, cur, self)
                w.setMinimumWidth(200)
            else:
                w = QLineEdit(str(val))
                w.textChanged.connect(self.changed)
            self._param_widgets[pname] = w
            self._params_layout.addRow(pname, w)

        if act_type == "setFlag":
            kw = self._param_widgets.get("key")
            vw = self._param_widgets.get("value")
            if isinstance(kw, FlagKeyPickField) and isinstance(vw, FlagValueEdit):
                reg = self._ctx_model.flag_registry if self._ctx_model else {}
                vw.set_registry(reg)

                def on_key() -> None:
                    vw.set_flag_key(kw.key())
                    self.changed.emit()

                kw.valueChanged.connect(on_key)
                on_key()
                pval = params.get("value", "")
                vw.set_value(pval if pval != "" else True)

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
            elif ptype == "flag_val" and isinstance(w, FlagValueEdit):
                v = w.get_value()
                params[pname] = v if isinstance(v, bool) else float(v)
            elif act_type == "setFlag" and pname == "key" and isinstance(w, FlagKeyPickField):
                params[pname] = w.key()
            else:
                params[pname] = w.text()
        return {"type": act_type, "params": params}


class ActionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Actions", parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[ActionRow] = []
        self._ctx_model = None
        self._ctx_scene_id: str | None = None
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(4)
        root.addLayout(self._rows_layout)
        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

    def set_project_context(self, model, scene_id: str | None = None) -> None:
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        for r in self._rows:
            r.set_project_context(model, scene_id)

    def set_flag_completions(self, _keys: list[str]) -> None:
        """Deprecated: pass set_project_context instead."""
        del _keys

    def set_flag_keys(self, _keys: list[str]) -> None:
        del _keys

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
        row = ActionRow(data, model=self._ctx_model, scene_id=self._ctx_scene_id)
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
