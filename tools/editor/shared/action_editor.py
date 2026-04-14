"""Reusable ActionDef[] editor with dynamic params forms.

与 `src/core/ActionRegistry.ts` 成对维护：在 Registry 里新 register 的 type，
必须在本文件的 ACTION_TYPES 中出现，并补齐 _PARAM_SCHEMAS或自定义 _rebuild_params 分支，
否则策划无法在场景/任务/遭遇等编辑器里添加该动作；校验器也会对未登记 type 报错。
"""
from __future__ import annotations

import re
from typing import Callable

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QDoubleSpinBox, QCheckBox, QFormLayout, QFrame,
    QTextEdit, QApplication, QToolButton,
)

from PySide6.QtCore import QEvent, QEventLoop, Qt, Signal
from PySide6.QtGui import QWheelEvent

# Qt6: ItemDataRole.UserRole
_USER_ROLE = Qt.ItemDataRole.UserRole

_ANIM_MANIFEST_RE = re.compile(r"^/assets/animation/([^/]+)/anim\.json$")


def _hide_combo_popups_under(widget: QWidget) -> None:
    for cb in widget.findChildren(QComboBox):
        cb.hidePopup()


def _hide_active_application_popups(max_rounds: int = 8) -> None:
    """仅收起 QApplication.activePopupWidget 链，不销毁 QComboBoxPrivateContainer（避免误删仍绑定到新控件的弹层）。"""
    app = QApplication.instance()
    if app is None:
        return
    for _ in range(max(1, max_rounds)):
        pop = app.activePopupWidget()
        if pop is None:
            break
        pop.hide()


def _dismiss_active_popup_stack(max_rounds: int = 8) -> None:
    """收起 application 级 Popup，再清理孤儿 QComboBoxPrivateContainer。Windows 上若在 clear()/deleteLater 前不关，会残留带标题栏的小窗并抢焦点。"""
    _hide_active_application_popups(max_rounds)
    _purge_qcombobox_private_containers()


def _protected_combobox_popup_widget_ids(widget: QWidget | None) -> set[int]:
    """当前子树内 QComboBox 下拉 view 的父链 widget id（含 QComboBoxPrivateContainer），用于避免误删仍有效的弹层。"""
    protected: set[int] = set()
    if widget is None:
        return protected
    for cb in widget.findChildren(QComboBox):
        try:
            v = cb.view()
        except Exception:
            v = None
        if v is None:
            continue
        p: QWidget | None = v.parentWidget()
        while p is not None:
            protected.add(id(p))
            p = p.parentWidget()
    return protected


def _purge_qcombobox_private_containers(*, protected_ids: set[int] | None = None) -> None:
    """销毁孤儿顶级 QComboBoxPrivateContainer；删树后 Qt 会留下此类窗口并抢焦点。protected_ids 非空时跳过其中 id。"""
    app = QApplication.instance()
    if app is None:
        return
    for w in list(app.topLevelWidgets()):
        try:
            if w.metaObject().className() != "QComboBoxPrivateContainer":
                continue
            if protected_ids is not None and id(w) in protected_ids:
                continue
            w.hide()
            w.close()
            w.deleteLater()
        except Exception:
            pass


from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit
from .id_ref_selector import IdRefSelector
from .image_path_picker import CutsceneImagePathRow
from .scripted_lines_editor import ScriptedLinesEditor

ACTION_TYPES = [
    "setFlag", "appendFlag", "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "giveFragment", "updateQuest", "startEncounter",
    "playBgm", "stopBgm", "playSfx", "endDay", "addDelayedEvent",
    "addArchiveEntry", "startCutscene", "showEmote", "playNpcAnimation", "setEntityEnabled", "openShop",
    "pickup", "switchScene", "changeScene", "showNotification", "stopNpcPatrol",
    "persistNpcDisablePatrol", "persistNpcEnablePatrol", "persistNpcEntityEnabled", "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation",
    "shopPurchase", "inventoryDiscard",
    "setPlayerAvatar", "resetPlayerAvatar",
    "setSceneDepthFloorOffset", "resetSceneDepthFloorOffset",
    "setCameraZoom", "restoreSceneCameraZoom",
    "fadingZoom", "fadingRestoreSceneCameraZoom",
    "fadeWorldToBlack", "fadeWorldFromBlack",
    "hideOverlayImage", "playScriptedDialogue", "showOverlayImage", "blendOverlayImage", "startDialogueGraph",
    "waitClickContinue",
    "waitMs",
    "enableRuleOffers", "disableRuleOffers",
]

_PARAM_SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "setFlag": [("key", "str"), ("value", "flag_val")],
    "appendFlag": [("key", "str"), ("text", "str")],
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
    "playNpcAnimation": [("target", "str"), ("state", "str")],
    "setEntityEnabled": [("target", "str"), ("enabled", "bool")],
    "openShop": [("shopId", "str")],
    "switchScene": [("targetScene", "str"), ("targetSpawnPoint", "str")],
    "changeScene": [("targetScene", "str"), ("targetSpawnPoint", "str")],
    "showNotification": [("text", "str"), ("type", "str")],
    "stopNpcPatrol": [("npcId", "str")],
    "persistNpcDisablePatrol": [("npcId", "str")],
    "persistNpcEnablePatrol": [("npcId", "str")],
    "persistNpcEntityEnabled": [("target", "str"), ("enabled", "bool")],
    "persistNpcAt": [("target", "str"), ("x", "float"), ("y", "float")],
    "persistNpcAnimState": [("target", "str"), ("state", "str")],
    "persistPlayNpcAnimation": [("target", "str"), ("state", "str")],
    "shopPurchase": [("itemId", "str"), ("price", "int")],
    "inventoryDiscard": [("itemId", "str")],
    "pickup": [("itemId", "str"), ("itemName", "str"), ("count", "int"), ("isCurrency", "bool")],
    "addDelayedEvent": [("targetDay", "int")],
    "disableRuleOffers": [],
    "resetPlayerAvatar": [],
    "setSceneDepthFloorOffset": [("floor_offset", "float")],
    "resetSceneDepthFloorOffset": [],
    "setCameraZoom": [("zoom", "float")],
    "restoreSceneCameraZoom": [],
    "fadingZoom": [("zoom", "float"), ("durationMs", "int")],
    "fadingRestoreSceneCameraZoom": [("durationMs", "int")],
    "fadeWorldToBlack": [("durationMs", "int")],
    "fadeWorldFromBlack": [("durationMs", "int")],
    "hideOverlayImage": [("id", "str")],
    "waitClickContinue": [("text", "str")],
    "waitMs": [("durationMs", "int")],
}

_NOTIFICATION_TYPES = ("info", "warning", "quest", "rule", "item")
_ARCHIVE_BOOK_TYPES = ("character", "lore", "document", "book", "bookEntry")


class FilterableTypeCombo(QComboBox):
    """
    可编辑下拉：每项为 (展示名, 取值)。筛选同时对展示名、取值做匹配（非前缀限定）：
    - 子串：查询串在字符串任意位置出现（不区分大小写）
    - 模糊：查询串每个字符在字符串中按先后顺序出现即可    """

    typeCommitted = Signal(str)

    def __init__(
        self,
        entries: list[tuple[str, str]],
        parent: QWidget | None = None,
        *,
        orphan_label: Callable[[str], str] | None = None,
    ):
        super().__init__(parent)
        self._entries: list[tuple[str, str]] = list(entries)
        self._orphan_label = orphan_label
        self._canonical_values: list[str] = []
        self._value_set: set[str] = set()
        self._lower_value: dict[str, str] = {}
        self._rebuild_value_index()
        self._committed: str = self._entries[0][1] if self._entries else ""
        self._programmatic = False
        self._suppress_editing_finish = False

        self.setEditable(True)
        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        le = self.lineEdit()
        le.setPlaceholderText("输入以筛选…")
        le.textEdited.connect(self._on_text_edited)
        le.editingFinished.connect(self._on_editing_finished)
        self.activated.connect(self._on_activated)
        self.setToolTip(
            "输入关键字筛选（非仅前缀）：展示名与内部取值任一在任意位置含子串即匹配；"
            "否则按字符顺序模糊匹配。点选列表或输入唯一匹配后失焦确定。",
        )

    @classmethod
    def from_flat_strings(cls, types: list[str], parent: QWidget | None = None) -> FilterableTypeCombo:
        return cls([(t, t) for t in types], parent=parent)

    def _rebuild_value_index(self) -> None:
        self._canonical_values = []
        self._value_set = set()
        self._lower_value = {}
        for _d, v in self._entries:
            if v not in self._value_set:
                self._value_set.add(v)
                self._canonical_values.append(v)
                self._lower_value.setdefault(v.lower(), v)

    def committed_type(self) -> str:
        """当前选中的取值（与 Action type 等业务字段一致）。"""
        return self._committed

    def set_committed_type(self, value: str, *, emit: bool = False) -> None:
        self._programmatic = True
        try:
            self._committed = value if value else (
                self._entries[0][1] if self._entries else "")
            self._refill_all_items(self._committed)
        finally:
            self._programmatic = False
        if emit:
            self.typeCommitted.emit(self._committed)

    def wheelEvent(self, ev: QWheelEvent) -> None:
        ev.ignore()

    @staticmethod
    def _matches(text: str, q: str) -> bool:
        q = q.strip().lower()
        if not q:
            return True
        tl = text.lower()
        if q in tl:
            return True
        i = 0
        for ch in q:
            j = tl.find(ch, i)
            if j < 0:
                return False
            i = j + 1
        return True

    def _matches_entry(self, display: str, value: str, q: str) -> bool:
        return self._matches(display, q) or self._matches(value, q)

    def _display_for_value(self, value: str) -> str:
        for d, v in self._entries:
            if v == value:
                return d
        return value

    def _entries_with_orphan(self, committed_value: str) -> list[tuple[str, str]]:
        out = list(self._entries)
        if committed_value and committed_value not in self._value_set:
            if all(v != committed_value for _, v in out):
                disp = (
                    self._orphan_label(committed_value)
                    if self._orphan_label
                    else committed_value
                )
                out.insert(0, (disp, committed_value))
        return out

    def _refill_all_items(self, committed_value: str) -> None:
        self.blockSignals(True)
        self.hidePopup()
        self.clear()
        self._committed = committed_value
        rows = self._entries_with_orphan(committed_value)
        for disp, val in rows:
            idx = self.count()
            self.addItem(disp)
            self.setItemData(idx, val, _USER_ROLE)
        disp_show = self._display_for_value(committed_value)
        self.lineEdit().setText(disp_show)
        for i in range(self.count()):
            if str(self.itemData(i, _USER_ROLE) or "") == committed_value:
                self.setCurrentIndex(i)
                break
        self.blockSignals(False)

    def _pool_rows(self) -> list[tuple[str, str]]:
        return self._entries_with_orphan(self._committed)

    def _on_text_edited(self, text: str) -> None:
        if self._programmatic:
            return
        pool = self._pool_rows()
        matches = [(d, v) for d, v in pool if self._matches_entry(d, v, text)]
        if not matches:
            matches = pool
        self.blockSignals(True)
        self.hidePopup()
        self.clear()
        for disp, val in matches:
            idx = self.count()
            self.addItem(disp)
            self.setItemData(idx, val, _USER_ROLE)
        self.lineEdit().setText(text)
        self.blockSignals(False)

    def _value_at(self, index: int) -> str:
        if index < 0:
            return ""
        raw = self.itemData(index, _USER_ROLE)
        if raw is not None:
            return str(raw)
        return self.itemText(index)

    def _on_activated(self, index: int) -> None:
        if index < 0:
            return
        v = self._value_at(index)
        self._suppress_editing_finish = True
        self._apply_committed(v)
        self._suppress_editing_finish = False

    def _apply_committed(self, value: str) -> None:
        prev = self._committed
        self._committed = value
        self._programmatic = True
        self._refill_all_items(value)
        self._programmatic = False
        if prev != value:
            self.typeCommitted.emit(value)

    def _on_editing_finished(self) -> None:
        if self._programmatic or self._suppress_editing_finish:
            self._suppress_editing_finish = False
            return
        raw = self.lineEdit().text().strip()
        if not raw:
            self._programmatic = True
            self._refill_all_items(self._committed)
            self._programmatic = False
            return
        if raw in self._value_set:
            self._apply_committed(raw)
            return
        for d, v in self._entries_with_orphan(self._committed):
            if raw == d:
                self._apply_committed(v)
                return
        low = raw.lower()
        if low in self._lower_value:
            self._apply_committed(self._lower_value[low])
            return
        if raw == self._committed and raw not in self._value_set:
            return
        cand: list[str] = []
        seen: set[str] = set()
        for d, v in self._pool_rows():
            if self._matches_entry(d, v, raw) and v not in seen:
                seen.add(v)
                cand.append(v)
        if len(cand) == 1:
            self._apply_committed(cand[0])
            return
        self._programmatic = True
        self._refill_all_items(self._committed)
        self._programmatic = False


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
        rid.setMinimumWidth(96)
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
        tx.textChanged.connect(lambda: self.changed.emit())
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
    move_up = Signal()
    move_down = Signal()

    def __init__(
        self,
        data: dict | None = None,
        parent: QWidget | None = None,
        model=None,
        scene_id: str | None = None,
        show_delete_button: bool = True,
        show_reorder_buttons: bool = True,
    ):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        self._delayed_editor = None
        self._collapsed = True

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)
        self._outer_layout = outer

        top = QHBoxLayout()
        self._fold_toggle = QToolButton()
        self._fold_toggle.setAutoRaise(True)
        self._fold_toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._fold_toggle.setToolTip("折叠 / 展开参数区")
        self._fold_toggle.clicked.connect(self._on_fold_clicked)
        top.addWidget(self._fold_toggle)
        self.type_combo = FilterableTypeCombo.from_flat_strings(ACTION_TYPES)
        self._btn_up = QPushButton("\u2191")
        self._btn_up.setFixedWidth(24)
        self._btn_up.setToolTip("上移")
        self._btn_up.clicked.connect(self.move_up.emit)
        self._btn_down = QPushButton("\u2193")
        self._btn_down.setFixedWidth(24)
        self._btn_down.setToolTip("下移")
        self._btn_down.clicked.connect(self.move_down.emit)
        self._btn_up.setVisible(show_reorder_buttons)
        self._btn_down.setVisible(show_reorder_buttons)
        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))
        self.del_btn.setVisible(show_delete_button)
        top.addWidget(self.type_combo, stretch=1)
        top.addWidget(self._btn_up)
        top.addWidget(self._btn_down)
        top.addWidget(self.del_btn)
        outer.addLayout(top)

        self._rule_slots_editor: RuleSlotsParamEditor | None = None

        self._foldable_body = QWidget()
        self._foldable_layout = QVBoxLayout(self._foldable_body)
        self._foldable_layout.setContentsMargins(0, 0, 0, 0)
        self._foldable_layout.setSpacing(2)

        self._params_frame = QFrame()
        self._params_layout = QFormLayout(self._params_frame)
        self._params_layout.setContentsMargins(20, 0, 0, 0)
        self._foldable_layout.addWidget(self._params_frame)
        outer.addWidget(self._foldable_body)
        self._foldable_body.setVisible(False)

        raw = data or {"type": "setFlag", "params": {}}
        self._data = {
            "type": raw.get("type", "setFlag"),
            "params": dict(raw.get("params", {})),
        }
        self._normalize_action_params(self._data["type"], self._data["params"])
        self.type_combo.set_committed_type(self._data.get("type", "setFlag"))
        self._rebuild_params()

        self.type_combo.typeCommitted.connect(self._on_type_committed)

    def _on_fold_clicked(self) -> None:
        self._collapsed = not self._collapsed
        self._foldable_body.setVisible(not self._collapsed)
        self._fold_toggle.setArrowType(
            Qt.ArrowType.RightArrow if self._collapsed else Qt.ArrowType.DownArrow
        )

    def _sync_foldable_visibility(self) -> None:
        self._foldable_body.setVisible(not self._collapsed)

    def apply_fold_policy(self, single_row: bool) -> None:
        """仅一行时展开并隐藏折叠钮；多行时默认折叠参数区。"""
        if single_row:
            self._fold_toggle.setVisible(False)
            self._collapsed = False
            self._foldable_body.setVisible(True)
            self._fold_toggle.setArrowType(Qt.ArrowType.DownArrow)
        else:
            self._fold_toggle.setVisible(True)
            self._collapsed = True
            self._foldable_body.setVisible(False)
            self._fold_toggle.setArrowType(Qt.ArrowType.RightArrow)

    def set_reorder_enabled(self, up: bool, down: bool) -> None:
        self._btn_up.setEnabled(up)
        self._btn_down.setEnabled(down)

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

    def _on_type_committed(self, _text: str) -> None:
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
        w.setMinimumWidth(96)
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
            self._foldable_layout.removeWidget(self._delayed_editor)
            self._delayed_editor.deleteLater()
            self._delayed_editor = None
        if self._rule_slots_editor is not None:
            self._foldable_layout.removeWidget(self._rule_slots_editor)
            self._rule_slots_editor.deleteLater()
            self._rule_slots_editor = None

        act_type = self.type_combo.committed_type()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params = self._data.get("params", {})

        if act_type == "showOverlayImage":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "id：与 hideOverlayImage 共用的标记；x/y/width 为 0–100 的屏幕百分比；"
                "图像中心在 (x,y)，高度由原图宽高比自动计算。",
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            id_ed = QLineEdit(str(params.get("id", "") or ""))
            id_ed.setPlaceholderText("如 notice_a")
            id_ed.textChanged.connect(self.changed)
            self._param_widgets["id"] = id_ed
            self._params_layout.addRow("id", id_ed)
            img_row = CutsceneImagePathRow(self._ctx_model, str(params.get("image", "") or ""), self)
            img_row.changed.connect(self.changed)
            self._param_widgets["image"] = img_row
            self._params_layout.addRow("image", img_row)

            def _pct_spin(key: str, default: float) -> QDoubleSpinBox:
                sp = QDoubleSpinBox()
                sp.setRange(0, 100)
                sp.setDecimals(2)
                sp.setSingleStep(0.5)
                val = params.get(key, default)
                try:
                    sp.setValue(float(val))
                except (TypeError, ValueError):
                    sp.setValue(float(default))
                sp.valueChanged.connect(self.changed)
                return sp

            self._param_widgets["xPercent"] = _pct_spin("xPercent", 50.0)
            self._params_layout.addRow("xPercent（水平中心）", self._param_widgets["xPercent"])
            self._param_widgets["yPercent"] = _pct_spin("yPercent", 50.0)
            self._params_layout.addRow("yPercent（垂直中心）", self._param_widgets["yPercent"])
            self._param_widgets["widthPercent"] = _pct_spin("widthPercent", 40.0)
            self._params_layout.addRow("widthPercent（占屏宽）", self._param_widgets["widthPercent"])
            self._sync_foldable_visibility()
            return

        if act_type == "blendOverlayImage":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "id：与 hideOverlayImage 共用；片元 shader 内 mix(from,to,t)。"
                "宽度为 widthPercent（占屏宽），高度按 toImage 宽高比自动算。"
                "delayMs 内 t=0；之后 durationMs 内 t 由 0 线性到 1；结束保留目标图。",
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            id_ed = QLineEdit(str(params.get("id", "") or ""))
            id_ed.setPlaceholderText("如 portrait_blend")
            id_ed.textChanged.connect(self.changed)
            self._param_widgets["id"] = id_ed
            self._params_layout.addRow("id", id_ed)
            from_row = CutsceneImagePathRow(self._ctx_model, str(params.get("fromImage", "") or ""), self)
            from_row.changed.connect(self.changed)
            self._param_widgets["fromImage"] = from_row
            self._params_layout.addRow("fromImage（起始图）", from_row)
            to_row = CutsceneImagePathRow(self._ctx_model, str(params.get("toImage", "") or ""), self)
            to_row.changed.connect(self.changed)
            self._param_widgets["toImage"] = to_row
            self._params_layout.addRow("toImage（目标图）", to_row)
            dur = QSpinBox()
            dur.setRange(0, 9999999)
            dur.setSingleStep(100)
            dval = params.get("durationMs", 600)
            try:
                dur.setValue(int(dval))
            except (TypeError, ValueError):
                dur.setValue(600)
            dur.valueChanged.connect(self.changed)
            self._param_widgets["durationMs"] = dur
            self._params_layout.addRow("durationMs（t 从 0→1，毫秒）", dur)
            del_sp = QSpinBox()
            del_sp.setRange(0, 9999999)
            del_sp.setSingleStep(50)
            del_val = params.get("delayMs", 0)
            try:
                del_sp.setValue(int(del_val))
            except (TypeError, ValueError):
                del_sp.setValue(0)
            del_sp.valueChanged.connect(self.changed)
            self._param_widgets["delayMs"] = del_sp
            self._params_layout.addRow("delayMs（t 保持 0 的等待，毫秒）", del_sp)

            def _pct_spin(key: str, default: float) -> QDoubleSpinBox:
                sp = QDoubleSpinBox()
                sp.setRange(0, 100)
                sp.setDecimals(2)
                sp.setSingleStep(0.5)
                val = params.get(key, default)
                try:
                    sp.setValue(float(val))
                except (TypeError, ValueError):
                    sp.setValue(float(default))
                sp.valueChanged.connect(self.changed)
                return sp

            self._param_widgets["xPercent"] = _pct_spin("xPercent", 50.0)
            self._params_layout.addRow("xPercent（水平中心）", self._param_widgets["xPercent"])
            self._param_widgets["yPercent"] = _pct_spin("yPercent", 50.0)
            self._params_layout.addRow("yPercent（垂直中心）", self._param_widgets["yPercent"])
            self._param_widgets["widthPercent"] = _pct_spin("widthPercent", 40.0)
            self._params_layout.addRow("widthPercent（占屏宽）", self._param_widgets["widthPercent"])
            self._sync_foldable_visibility()
            return

        if act_type == "startDialogueGraph":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "graphId：不含路径，与 assets/dialogues/graphs 下同名 .json 对应；"
                "entry 覆盖图内入口节点；npcId 用于解析说话人显示名（可选）。",
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            gid = QLineEdit(str(params.get("graphId", "") or ""))
            gid.setPlaceholderText("如 码头看板官差")
            gid.textChanged.connect(self.changed)
            self._param_widgets["graphId"] = gid
            self._params_layout.addRow("graphId", gid)
            ent = QLineEdit(str(params.get("entry", "") or ""))
            ent.setPlaceholderText("可选，覆盖图 JSON 的 entry")
            ent.textChanged.connect(self.changed)
            self._param_widgets["entry"] = ent
            self._params_layout.addRow("entry", ent)
            nid = QLineEdit(str(params.get("npcId", "") or ""))
            nid.setPlaceholderText("可选，场景内 NPC id")
            nid.textChanged.connect(self.changed)
            self._param_widgets["npcId"] = nid
            self._params_layout.addRow("npcId", nid)
            self._sync_foldable_visibility()
            return

        if act_type == "playScriptedDialogue":
            self._params_frame.setVisible(False)
            raw_lines = params.get("lines", [])
            ed = ScriptedLinesEditor(
                list(raw_lines) if isinstance(raw_lines, list) else [],
                self,
            )
            ed.changed.connect(self.changed)
            self._delayed_editor = ed
            self._foldable_layout.addWidget(ed)
            self._sync_foldable_visibility()
            return

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
            self._foldable_layout.addWidget(ed)
            self._sync_foldable_visibility()
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
            bid.setMinimumWidth(112)
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
            self._sync_foldable_visibility()
            return

        if not schema:
            self._params_frame.setVisible(False)
            self._sync_foldable_visibility()
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
                if act_type not in ("setFlag",):
                    w.set_value(val if val != "" else True)
                w.valueChanged.connect(self.changed)
            elif act_type in ("setFlag", "appendFlag") and pname == "key":
                cur = str(val) if val is not None else ""
                w = FlagKeyPickField(self._ctx_model, self._ctx_scene_id, cur, self)
                w.setMinimumWidth(96)
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
                w.setMinimumWidth(96)
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
            elif act_type == "waitClickContinue" and pname == "text":
                w = QLineEdit(str(val))
                w.setPlaceholderText("留空= strings actions.clickToContinue（默认「点击继续」）")
                w.textChanged.connect(lambda _t: self.changed.emit())
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
            self._foldable_layout.addWidget(ed)

        self._sync_foldable_visibility()

    def _to_dict_show_overlay_image(self) -> dict:
        id_w = self._param_widgets.get("id")
        img_w = self._param_widgets.get("image")
        x_w = self._param_widgets.get("xPercent")
        y_w = self._param_widgets.get("yPercent")
        w_w = self._param_widgets.get("widthPercent")
        pid = id_w.text().strip() if isinstance(id_w, QLineEdit) else ""
        pimg = img_w.path() if isinstance(img_w, CutsceneImagePathRow) else ""
        return {
            "type": "showOverlayImage",
            "params": {
                "id": pid,
                "image": pimg,
                "xPercent": float(x_w.value()) if isinstance(x_w, QDoubleSpinBox) else 0.0,
                "yPercent": float(y_w.value()) if isinstance(y_w, QDoubleSpinBox) else 0.0,
                "widthPercent": float(w_w.value()) if isinstance(w_w, QDoubleSpinBox) else 0.0,
            },
        }

    def _to_dict_blend_overlay_image(self) -> dict:
        id_w = self._param_widgets.get("id")
        from_w = self._param_widgets.get("fromImage")
        to_w = self._param_widgets.get("toImage")
        dur_w = self._param_widgets.get("durationMs")
        del_w = self._param_widgets.get("delayMs")
        x_w = self._param_widgets.get("xPercent")
        y_w = self._param_widgets.get("yPercent")
        w_w = self._param_widgets.get("widthPercent")
        pid = id_w.text().strip() if isinstance(id_w, QLineEdit) else ""
        pfrom = from_w.path() if isinstance(from_w, CutsceneImagePathRow) else ""
        pto = to_w.path() if isinstance(to_w, CutsceneImagePathRow) else ""
        dms = int(dur_w.value()) if isinstance(dur_w, QSpinBox) else 600
        ddelay = int(del_w.value()) if isinstance(del_w, QSpinBox) else 0
        return {
            "type": "blendOverlayImage",
            "params": {
                "id": pid,
                "fromImage": pfrom,
                "toImage": pto,
                "durationMs": dms,
                "delayMs": ddelay,
                "xPercent": float(x_w.value()) if isinstance(x_w, QDoubleSpinBox) else 0.0,
                "yPercent": float(y_w.value()) if isinstance(y_w, QDoubleSpinBox) else 0.0,
                "widthPercent": float(w_w.value()) if isinstance(w_w, QDoubleSpinBox) else 0.0,
            },
        }

    def _to_dict_start_dialogue_graph(self) -> dict:
        gid_w = self._param_widgets.get("graphId")
        ent_w = self._param_widgets.get("entry")
        nid_w = self._param_widgets.get("npcId")
        graph_id = gid_w.text().strip() if isinstance(gid_w, QLineEdit) else ""
        prm: dict = {"graphId": graph_id}
        ent = ent_w.text().strip() if isinstance(ent_w, QLineEdit) else ""
        if ent:
            prm["entry"] = ent
        nid = nid_w.text().strip() if isinstance(nid_w, QLineEdit) else ""
        if nid:
            prm["npcId"] = nid
        return {"type": "startDialogueGraph", "params": prm}

    def _to_dict_play_scripted_dialogue(self) -> dict:
        ed = self._delayed_editor
        lines = ed.to_list() if isinstance(ed, ScriptedLinesEditor) else []
        return {"type": "playScriptedDialogue", "params": {"lines": lines}}

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
        act_type = self.type_combo.committed_type()
        if act_type == "showOverlayImage":
            return self._to_dict_show_overlay_image()
        if act_type == "blendOverlayImage":
            return self._to_dict_blend_overlay_image()
        if act_type == "startDialogueGraph":
            return self._to_dict_start_dialogue_graph()
        if act_type == "playScriptedDialogue":
            return self._to_dict_play_scripted_dialogue()
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
                params[pname] = v if isinstance(v, (bool, str)) else float(v)
            elif act_type in ("setFlag", "appendFlag") and pname == "key" and isinstance(w, FlagKeyPickField):
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

    def __init__(
        self,
        label: str = "Actions",
        parent: QWidget | None = None,
        *,
        show_reorder_buttons: bool = True,
    ):
        super().__init__(parent)
        self._rows: list[ActionRow] = []
        self._ctx_model = None
        self._ctx_scene_id: str | None = None
        self._show_reorder_buttons = show_reorder_buttons
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
        _dismiss_active_popup_stack()
        QApplication.processEvents(QEventLoop.ProcessEventsFlag.ExcludeUserInputEvents)
        QApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def _add_row(self, data: dict | None = None) -> None:
        row = ActionRow(
            data,
            model=self._ctx_model,
            scene_id=self._ctx_scene_id,
            show_reorder_buttons=self._show_reorder_buttons,
        )
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        row.move_up.connect(lambda: self._move_row(row, -1))
        row.move_down.connect(lambda: self._move_row(row, 1))
        self._rows.append(row)
        self._rows_layout.addWidget(row)
        self._refresh_reorder_buttons()
        self._refresh_fold_policy()

    def _add_empty(self) -> None:
        self._add_row({"type": "setFlag", "params": {}})
        self.changed.emit()

    def _refresh_reorder_buttons(self) -> None:
        if not self._show_reorder_buttons:
            return
        n = len(self._rows)
        for i, r in enumerate(self._rows):
            r.set_reorder_enabled(i > 0, i < n - 1)

    def _move_row(self, row: ActionRow, delta: int) -> None:
        i = self._rows.index(row)
        j = i + delta
        if j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        _hide_combo_popups_under(self)
        for r in self._rows:
            self._rows_layout.removeWidget(r)
        for r in self._rows:
            self._rows_layout.addWidget(r)
        self._refresh_reorder_buttons()
        self.changed.emit()

    def _remove_row(self, row: ActionRow) -> None:
        if row in self._rows:
            _hide_combo_popups_under(row)
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self._refresh_reorder_buttons()
            self._refresh_fold_policy()
            self.changed.emit()

    def _refresh_fold_policy(self) -> None:
        n = len(self._rows)
        single = n <= 1
        for r in self._rows:
            r.apply_fold_policy(single)