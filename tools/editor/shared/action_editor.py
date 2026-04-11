"""Reusable ActionDef[] editor with dynamic params forms.

与 `src/core/ActionRegistry.ts` 成对维护：在 Registry 里新 register 的 type，
必须在本文件的 ACTION_TYPES 中出现，并补齐 _PARAM_SCHEMAS或自定义 _rebuild_params 分支，
否则策划无法在场景/任务/遭遇等编辑器里添加该动作；校验器也会对未登记 type 报错。
"""
from __future__ import annotations

import re

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QDoubleSpinBox, QCheckBox, QFormLayout, QFrame,
    QTextEdit, QApplication,
)

from PySide6.QtCore import QEvent, QEventLoop, Qt, Signal

_ANIM_MANIFEST_RE = re.compile(r"^/assets/animation/([^/]+)/anim\.json$")


def _hide_combo_popups_under(widget: QWidget) -> None:
    for cb in widget.findChildren(QComboBox):
        cb.hidePopup()

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit
from .id_ref_selector import IdRefSelector

ACTION_TYPES = [
    "setFlag", "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "giveFragment", "updateQuest", "startEncounter",
    "playBgm", "stopBgm", "playSfx", "endDay", "addDelayedEvent",
    "addArchiveEntry", "startCutscene", "showEmote", "openShop",
    "pickup", "switchScene", "changeScene", "showNotification",
    "shopPurchase", "inventoryDiscard",
    "setPlayerAvatar", "resetPlayerAvatar",
    "setSceneDepthFloorOffset", "resetSceneDepthFloorOffset",
    "enableRuleOffers", "disableRuleOffers",
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
    "switchScene": [("targetScene", "str"), ("targetSpawnPoint", "str")],
    "changeScene": [("targetScene", "str"), ("targetSpawnPoint", "str")],
    "showNotification": [("text", "str"), ("type", "str")],
    "shopPurchase": [("itemId", "str"), ("price", "int")],
    "inventoryDiscard": [("itemId", "str")],
    "pickup": [("itemId", "str"), ("itemName", "str"), ("count", "int"), ("isCurrency", "bool")],
    "addDelayedEvent": [("targetDay", "int")],
    "disableRuleOffers": [],
    "resetPlayerAvatar": [],
    "setSceneDepthFloorOffset": [("floor_offset", "float")],
    "resetSceneDepthFloorOffset": [],
}

_NOTIFICATION_TYPES = ("info", "warning", "quest", "rule", "item")
_ARCHIVE_BOOK_TYPES = ("character", "lore", "document", "book")


class RuleSlotsParamEditor(QWidget):
    """enableRuleOffers.params.slots：多槽，每槽 ruleId + resultText + resultActions。"""

    changed = Signal()

    def __init__(
        self,
        slots: list | None = None,
        model=None,
        scene_id: str | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        self._rows: list[dict] = []
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(
            "slots（须在 Zone 的 onEnter/onExit 中配合 disableRuleOffers 使用）",
        ))
        self._list_layout = QVBoxLayout()
        root.addLayout(self._list_layout)
        btn_add = QPushButton("+ 规矩槽位")
        btn_add.clicked.connect(self._add_empty_slot)
        root.addWidget(btn_add)
        raw = slots if isinstance(slots, list) else []
        if raw:
            for s in raw:
                if isinstance(s, dict):
                    self._append_slot_ui(s)
        else:
            self._append_slot_ui({})

    def _add_empty_slot(self) -> None:
        self._append_slot_ui({})
        self.changed.emit()

    def _remove_row(self, rec: dict) -> None:
        if rec in self._rows:
            self._rows.remove(rec)
        box = rec["box"]
        _hide_combo_popups_under(box)
        self._list_layout.removeWidget(box)
        box.deleteLater()
        self.changed.emit()

    def _append_slot_ui(self, data: dict) -> None:
        box = QFrame()
        box.setFrameStyle(QFrame.Shape.StyledPanel)
        bl = QVBoxLayout(box)
        hdr = QHBoxLayout()
        hdr.addWidget(QLabel("ruleId"), stretch=0)
        rid = IdRefSelector(box, allow_empty=True)
        rid.setMinimumWidth(200)
        rid.set_items(self._model.all_rule_ids() if self._model else [])
        rid.set_current(str(data.get("ruleId", "")))
        rid.value_changed.connect(lambda _v: self.changed.emit())
        hdr.addWidget(rid, stretch=1)
        rm = QPushButton("\u2212")
        rm.setFixedWidth(24)
        bl.addWidget(QLabel("resultText"))
        tx = QTextEdit()
        tx.setMaximumHeight(80)
        tx.setPlainText(str(data.get("resultText", "")))
        tx.textChanged.connect(self.changed.emit)
        bl.addWidget(tx)
        bl.addWidget(QLabel("resultActions"))
        ae = ActionEditor("resultActions", box)
        ae.set_project_context(self._model, self._scene_id)
        ra = data.get("resultActions", [])
        ae.set_data(list(ra) if isinstance(ra, list) else [])
        ae.changed.connect(self.changed.emit)
        bl.addWidget(ae)
        rec = {"box": box, "rid": rid, "text": tx, "ae": ae}
        rm.clicked.connect(lambda: self._remove_row(rec))
        hdr.addWidget(rm)
        bl.insertLayout(0, hdr)
        self._rows.append(rec)
        self._list_layout.addWidget(box)

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for r in self._rows:
            out.append({
                "ruleId": r["rid"].current_id(),
                "resultText": r["text"].toPlainText(),
                "resultActions": r["ae"].to_list(),
            })
        return out


class ActionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(
        self,
        data: dict | None = None,
        parent: QWidget | None = None,
        model=None,
        scene_id: str | None = None,
        show_delete_button: bool = True,
    ):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        self._delayed_editor = None

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)
        self._outer_layout = outer

        top = QHBoxLayout()
        self.type_combo = QComboBox()
        self.type_combo.addItems(ACTION_TYPES)
        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))
        self.del_btn.setVisible(show_delete_button)
        top.addWidget(self.type_combo, stretch=1)
        top.addWidget(self.del_btn)
        outer.addLayout(top)

        self._rule_slots_editor: RuleSlotsParamEditor | None = None

        self._params_frame = QFrame()
        self._params_layout = QFormLayout(self._params_frame)
        self._params_layout.setContentsMargins(20, 0, 0, 0)
        outer.addWidget(self._params_frame)

        raw = data or {"type": "setFlag", "params": {}}
        self._data = {
            "type": raw.get("type", "setFlag"),
            "params": dict(raw.get("params", {})),
        }
        self._normalize_action_params(self._data["type"], self._data["params"])
        self.type_combo.setCurrentText(self._data.get("type", "setFlag"))
        self._rebuild_params()

        self.type_combo.currentTextChanged.connect(self._on_type_changed)

    @staticmethod
    def _normalize_action_params(act_type: str, params: dict) -> None:
        if act_type in ("switchScene", "changeScene"):
            if "sceneId" in params and "targetScene" not in params:
                params["targetScene"] = params.pop("sceneId")
            if "spawnPoint" in params and "targetSpawnPoint" not in params:
                params["targetSpawnPoint"] = params.pop("spawnPoint")
        if act_type == "pickup":
            if "id" in params and "itemId" not in params:
                params["itemId"] = params.pop("id")
            if "name" in params and "itemName" not in params:
                params["itemName"] = params.pop("name")

    def set_project_context(self, model, scene_id: str | None) -> None:
        self._data = self.to_dict()
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        self._rebuild_params()

    def _on_type_changed(self, _text: str) -> None:
        self._data["params"] = {}
        self._rebuild_params()
        self.changed.emit()

    def _connect_scene_spawn_pickers(self) -> None:
        ts_w = self._param_widgets.get("targetScene")
        sp_w = self._param_widgets.get("targetSpawnPoint")
        if not isinstance(ts_w, IdRefSelector) or not isinstance(sp_w, IdRefSelector):
            return

        def refresh_spawn(_: str = "") -> None:
            sid = ts_w.current_id()
            keys = (
                self._ctx_model.spawn_point_keys_for_scene(sid)
                if self._ctx_model
                else [""]
            )
            items: list[tuple[str, str]] = [(k, k if k else "(default)") for k in keys]
            cur = sp_w.current_id()
            sp_w.set_items(items)
            if cur in keys:
                sp_w.set_current(cur)
            elif keys:
                sp_w.set_current(keys[0])

        ts_w.value_changed.connect(refresh_spawn)
        refresh_spawn()

    def _connect_archive_pickers(self) -> None:
        bt_w = self._param_widgets.get("bookType")
        en_w = self._param_widgets.get("entryId")
        if not isinstance(bt_w, QComboBox) or not isinstance(en_w, IdRefSelector):
            return

        def refresh_entry(_: str = "") -> None:
            bt = bt_w.currentText()
            items = (
                self._ctx_model.archive_entry_ids_for_book_type(bt)
                if self._ctx_model
                else []
            )
            cur = en_w.current_id()
            en_w.set_items(items)
            ids = [p[0] for p in items]
            if cur in ids:
                en_w.set_current(cur)
            elif ids:
                en_w.set_current(ids[0])

        bt_w.currentTextChanged.connect(refresh_entry)
        refresh_entry()

    def _make_selector(
        self,
        kind: str,
        val: str,
    ) -> QWidget:
        m = self._ctx_model
        w = IdRefSelector(self, allow_empty=True)
        w.setMinimumWidth(200)
        if kind == "scene":
            w.set_items([(s, s) for s in (m.all_scene_ids() if m else [])])
        elif kind == "item":
            w.set_items(m.all_item_ids() if m else [])
        elif kind == "quest":
            w.set_items(m.all_quest_ids() if m else [])
        elif kind == "encounter":
            w.set_items(m.all_encounter_ids() if m else [])
        elif kind == "rule":
            w.set_items(m.all_rule_ids() if m else [])
        elif kind == "fragment":
            w.set_items(m.all_fragment_ids() if m else [])
        elif kind == "cutscene":
            w.set_items(m.all_cutscene_ids() if m else [])
        elif kind == "shop":
            w.set_items(m.all_shop_ids() if m else [])
        elif kind == "audio_bgm":
            w.set_items([(a, a) for a in (m.all_audio_ids("bgm") if m else [])])
        elif kind == "audio_sfx":
            w.set_items([(a, a) for a in (m.all_audio_ids("sfx") if m else [])])
        elif kind == "spawn":
            w.set_items([("", "(default)")])
        elif kind == "emote_target":
            extra = m.npc_ids_for_scene(self._ctx_scene_id) if m else []
            w.set_items(extra)
        else:
            w.set_items([])
        w.set_current(str(val) if val is not None else "")
        w.value_changed.connect(self.changed)
        return w

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._param_widgets.clear()
        if self._delayed_editor is not None:
            self._outer_layout.removeWidget(self._delayed_editor)
            self._delayed_editor.deleteLater()
            self._delayed_editor = None
        if self._rule_slots_editor is not None:
            self._outer_layout.removeWidget(self._rule_slots_editor)
            self._rule_slots_editor.deleteLater()
            self._rule_slots_editor = None

        act_type = self.type_combo.currentText()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params = self._data.get("params", {})

        if act_type == "enableRuleOffers":
            self._params_frame.setVisible(False)
            slots_raw = params.get("slots", [])
            ed = RuleSlotsParamEditor(
                slots_raw if isinstance(slots_raw, list) else [],
                self._ctx_model,
                self._ctx_scene_id,
                self,
            )
            ed.changed.connect(self.changed)
            self._rule_slots_editor = ed
            self._outer_layout.addWidget(ed)
            return

        if act_type == "setPlayerAvatar":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            sm_raw = params.get("stateMap")
            sm: dict = sm_raw if isinstance(sm_raw, dict) else {}
            tip = QLabel(
                "填写 <b>animManifest</b> 或 <b>bundleId</b> 其一（若都填则优先使用 animManifest）。"
                "下方为逻辑状态 idle / walk / run 对应的 clip（states 键）；留空表示与逻辑名同名。"
            )
            tip.setWordWrap(True)
            tip.setTextFormat(Qt.TextFormat.RichText)
            self._params_layout.addRow(tip)

            bid = IdRefSelector(self, allow_empty=True)
            bid.setMinimumWidth(220)
            bundles = (
                [(k, k) for k in sorted(self._ctx_model.animations.keys())]
                if self._ctx_model
                else []
            )
            bid.set_items(bundles)
            b_from_p = str(params.get("bundleId", "") or "").strip()
            am = str(params.get("animManifest", "") or "").strip()
            if not b_from_p and am:
                m = _ANIM_MANIFEST_RE.match(am)
                if m:
                    b_from_p = m.group(1)
            bid.set_current(b_from_p)
            bid.value_changed.connect(self.changed)
            self._param_widgets["bundleId"] = bid
            self._params_layout.addRow("bundleId", bid)

            man = QLineEdit(am)
            man.setPlaceholderText("/assets/animation/player_anim/anim.json")
            man.textChanged.connect(self.changed)
            self._param_widgets["animManifest"] = man
            self._params_layout.addRow("animManifest", man)

            for logical in ("idle", "walk", "run"):
                le = QLineEdit(str(sm.get(logical, "") or ""))
                le.setPlaceholderText("留空 = 与逻辑名相同")
                le.textChanged.connect(self.changed)
                self._param_widgets[logical] = le
                self._params_layout.addRow(f"clip:{logical}", le)
            return

        if not schema:
            self._params_frame.setVisible(False)
            return
        self._params_frame.setVisible(True)

        for pname, ptype in schema:
            val = params.get(pname, "")
            w: QWidget
            if ptype == "int":
                w = QSpinBox()
                w.setRange(-999999, 999999)
                w.setValue(int(val) if val != "" else 0)
                w.valueChanged.connect(self.changed)
            elif ptype == "float":
                w = QDoubleSpinBox()
                w.setRange(-50.0, 50.0)
                w.setDecimals(4)
                w.setSingleStep(0.05)
                try:
                    w.setValue(float(val))
                except (TypeError, ValueError):
                    w.setValue(0.0)
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
            elif act_type in ("switchScene", "changeScene") and pname == "targetScene":
                w = self._make_selector("scene", str(val) if val is not None else "")
            elif act_type in ("switchScene", "changeScene") and pname == "targetSpawnPoint":
                w = self._make_selector("spawn", str(val) if val is not None else "")
            elif act_type == "giveItem" and pname == "id":
                w = self._make_selector("item", str(val) if val is not None else "")
            elif act_type == "removeItem" and pname == "id":
                w = self._make_selector("item", str(val) if val is not None else "")
            elif act_type == "giveRule" and pname == "id":
                w = self._make_selector("rule", str(val) if val is not None else "")
            elif act_type == "giveFragment" and pname == "id":
                w = self._make_selector("fragment", str(val) if val is not None else "")
            elif act_type == "updateQuest" and pname == "id":
                w = self._make_selector("quest", str(val) if val is not None else "")
            elif act_type == "startEncounter" and pname == "id":
                w = self._make_selector("encounter", str(val) if val is not None else "")
            elif act_type == "playBgm" and pname == "id":
                w = self._make_selector("audio_bgm", str(val) if val is not None else "")
            elif act_type == "playSfx" and pname == "id":
                w = self._make_selector("audio_sfx", str(val) if val is not None else "")
            elif act_type == "startCutscene" and pname == "id":
                w = self._make_selector("cutscene", str(val) if val is not None else "")
            elif act_type == "openShop" and pname == "shopId":
                w = self._make_selector("shop", str(val) if val is not None else "")
            elif act_type == "shopPurchase" and pname == "itemId":
                w = self._make_selector("item", str(val) if val is not None else "")
            elif act_type == "inventoryDiscard" and pname == "itemId":
                w = self._make_selector("item", str(val) if val is not None else "")
            elif act_type == "pickup" and pname == "itemId":
                w = self._make_selector("item", str(val) if val is not None else "")
            elif act_type == "addArchiveEntry" and pname == "bookType":
                w = QComboBox()
                w.addItems(list(_ARCHIVE_BOOK_TYPES))
                tv = str(val) if val else "character"
                i = w.findText(tv)
                if i >= 0:
                    w.setCurrentIndex(i)
                w.currentTextChanged.connect(self.changed)
            elif act_type == "addArchiveEntry" and pname == "entryId":
                w = IdRefSelector(self, allow_empty=True)
                w.setMinimumWidth(200)
                bt = str(params.get("bookType", "character"))
                items = (
                    self._ctx_model.archive_entry_ids_for_book_type(bt)
                    if self._ctx_model
                    else []
                )
                w.set_items(items)
                w.set_current(str(val) if val is not None else "")
                w.value_changed.connect(self.changed)
            elif act_type == "showNotification" and pname == "type":
                w = QComboBox()
                w.setEditable(True)
                w.addItems(list(_NOTIFICATION_TYPES))
                tv = str(val) if val is not None else "info"
                i = w.findText(tv)
                if i >= 0:
                    w.setCurrentIndex(i)
                else:
                    w.setEditText(tv)
                w.currentTextChanged.connect(self.changed)
            elif act_type == "showEmote" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
            else:
                w = QLineEdit(str(val))
                w.textChanged.connect(self.changed)
            self._param_widgets[pname] = w
            self._params_layout.addRow(pname, w)

        if act_type in ("switchScene", "changeScene"):
            self._connect_scene_spawn_pickers()
        if act_type == "addArchiveEntry":
            self._connect_archive_pickers()

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

        if act_type == "addDelayedEvent":
            ed = ActionEditor("delayed actions", self)
            ed.set_project_context(self._ctx_model, self._ctx_scene_id)
            raw_actions = params.get("actions", [])
            ed.set_data(list(raw_actions) if isinstance(raw_actions, list) else [])
            ed.changed.connect(self.changed)
            self._delayed_editor = ed
            self._outer_layout.addWidget(ed)

    def _to_dict_set_player_avatar(self) -> dict:
        man_w = self._param_widgets.get("animManifest")
        bid_w = self._param_widgets.get("bundleId")
        man = man_w.text().strip() if isinstance(man_w, QLineEdit) else ""
        bid = bid_w.current_id().strip() if isinstance(bid_w, IdRefSelector) else ""
        params: dict = {}
        if man:
            params["animManifest"] = man
        elif bid:
            params["bundleId"] = bid
        sm: dict = {}
        for logical in ("idle", "walk", "run"):
            w = self._param_widgets.get(logical)
            if not isinstance(w, QLineEdit):
                continue
            t = w.text().strip()
            if t:
                sm[logical] = t
        if sm:
            params["stateMap"] = sm
        return {"type": "setPlayerAvatar", "params": params}

    def to_dict(self) -> dict:
        act_type = self.type_combo.currentText()
        if act_type == "setPlayerAvatar":
            return self._to_dict_set_player_avatar()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params: dict = {}
        for pname, ptype in schema:
            w = self._param_widgets.get(pname)
            if w is None:
                continue
            if ptype == "int":
                params[pname] = w.value()
            elif ptype == "float":
                params[pname] = float(w.value())
            elif ptype == "bool":
                params[pname] = w.isChecked()
            elif ptype == "flag_val" and isinstance(w, FlagValueEdit):
                v = w.get_value()
                params[pname] = v if isinstance(v, bool) else float(v)
            elif act_type == "setFlag" and pname == "key" and isinstance(w, FlagKeyPickField):
                params[pname] = w.key()
            elif isinstance(w, IdRefSelector):
                params[pname] = w.current_id()
            elif isinstance(w, QComboBox):
                params[pname] = w.currentText()
            else:
                params[pname] = w.text()
        if act_type == "enableRuleOffers" and self._rule_slots_editor is not None:
            params["slots"] = self._rule_slots_editor.to_list()
        if act_type == "addDelayedEvent" and self._delayed_editor is not None:
            params["actions"] = self._delayed_editor.to_list()
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
            _hide_combo_popups_under(r)
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()
        QApplication.processEvents(QEventLoop.ProcessEventsFlag.ExcludeUserInputEvents)
        QApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)

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
            _hide_combo_popups_under(row)
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()