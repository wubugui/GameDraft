"""Reusable ActionDef[] editor with dynamic params forms.

与 `src/core/ActionRegistry.ts` 成对维护：在 Registry 里新 register 的 type，
必须在本文件的 ACTION_TYPES 中出现，并补齐 _PARAM_SCHEMAS或自定义 _rebuild_params 分支，
否则策划无法在场景/任务/遭遇等编辑器里添加该动作；校验器也会对未登记 type 报错。

Action 主类型在 ``ActionTypePickerField`` 中通过红圆点标记「会改存档」类动作（悬停有说明）；
参数区内大量枚举仍用 ``FilterableTypeCombo``。过场 present 子类型使用
``FilterableTypeCombo(select_only=True)``。改 Action 主类型会触发参数区重建。
"""
from __future__ import annotations

import json
import re
from typing import Callable

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QDoubleSpinBox, QCheckBox, QFormLayout, QFrame,
    QTextEdit, QApplication, QToolButton, QDialog, QListWidget, QListWidgetItem,
    QDialogButtonBox, QSizePolicy, QInputDialog,
)

from PySide6.QtCore import Qt, QTimer, Signal, QSize
from PySide6.QtGui import QWheelEvent

# Qt6: ItemDataRole.UserRole
_USER_ROLE = Qt.ItemDataRole.UserRole

_ANIM_MANIFEST_RE = re.compile(r"^/assets/animation/([^/]+)/anim\.json$")


def _hide_combo_popups_under(widget: QWidget) -> None:
    for cb in widget.findChildren(QComboBox):
        cb.hidePopup()


# 以下四个函数为历史兜底（曾用于手动清理 Windows 上偶发残留的 QComboBoxPrivateContainer）。
# 按 Qt 官方立场（https://forum.qt.io/topic/132029），QComboBoxPrivateContainer 是 editable QComboBox
# 的内部顶层容器，应该「just ignore it」；主动 close/deleteLater 反而会让 HWND 被 DWM 采样到，
# 表现为任务栏叠图标 + 顶层小窗闪烁。任何新代码禁止在 rebuild 路径中调用这些函数。
def _hide_active_application_popups(max_rounds: int = 8) -> None:
    """[已弃用] 仅收起 QApplication.activePopupWidget 链。勿在重建路径中调用，保留仅为潜在兜底。"""
    app = QApplication.instance()
    if app is None:
        return
    for _ in range(max(1, max_rounds)):
        pop = app.activePopupWidget()
        if pop is None:
            break
        pop.hide()


def _dismiss_active_popup_stack(max_rounds: int = 8) -> None:
    """[已弃用] 勿在重建路径中调用。保留仅为潜在兜底。"""
    _hide_active_application_popups(max_rounds)
    _purge_qcombobox_private_containers()


def _protected_combobox_popup_widget_ids(widget: QWidget | None) -> set[int]:
    """[已弃用] 勿在重建路径中调用。保留仅为潜在兜底。"""
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
    """[已弃用] 按 Qt 官方建议，不应主动清理 QComboBoxPrivateContainer；勿在重建路径中调用。保留仅为潜在兜底。"""
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
from .blend_overlay_preview import BlendOverlayPreviewWidget
from .image_path_picker import CutsceneImagePathRow
from .cutscene_dialogue_speaker_row import npc_items_for_dialogue_picker
from .scripted_lines_editor import ScriptedLinesEditor
from .runtime_field_schema import entity_kind_choices, field_meta

ACTION_TYPES = [
    "setFlag", "setScenarioPhase", "startScenario", "appendFlag", "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "grantRuleLayer", "giveFragment", "updateQuest", "startEncounter",
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
    "hideOverlayImage", "playScriptedDialogue", "showOverlayImage", "setHotspotDisplayImage", "setEntityField", "blendOverlayImage",
    "revealDocument", "startDialogueGraph",
    "waitClickContinue",
    "waitMs",
    "enableRuleOffers", "disableRuleOffers",
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor", "showEmoteAndWait",
]

# 编辑器用：会改动存档/可持久化数据 vs 以运行时演出与瞬时状态为主（与实现细节若有出入以策划理解为准，见文档注释）。
# "save" = 常关联存档、任务、背包、flag、持久化 override 等；"memory" = 多为镜头、UI、过场、等待、切场景、音效等
ACTION_PERSISTENCE: dict[str, str] = {
    "setFlag": "save",
    "setScenarioPhase": "save",
    "startScenario": "save",
    "appendFlag": "save",
    "giveItem": "save",
    "removeItem": "save",
    "giveCurrency": "save",
    "removeCurrency": "save",
    "giveRule": "save",
    "grantRuleLayer": "save",
    "giveFragment": "save",
    "updateQuest": "save",
    "startEncounter": "save",
    "playBgm": "memory",
    "stopBgm": "memory",
    "playSfx": "memory",
    "endDay": "save",
    "addDelayedEvent": "save",
    "addArchiveEntry": "save",
    "startCutscene": "memory",
    "showEmote": "memory",
    "playNpcAnimation": "memory",
    "setEntityEnabled": "memory",
    "openShop": "memory",
    "pickup": "save",
    "switchScene": "memory",
    "changeScene": "memory",
    "showNotification": "memory",
    "stopNpcPatrol": "memory",
    "persistNpcDisablePatrol": "save",
    "persistNpcEnablePatrol": "save",
    "persistNpcEntityEnabled": "save",
    "persistNpcAt": "save",
    "persistNpcAnimState": "save",
    "persistPlayNpcAnimation": "save",
    "shopPurchase": "save",
    "inventoryDiscard": "save",
    "setPlayerAvatar": "save",
    "resetPlayerAvatar": "save",
    "setSceneDepthFloorOffset": "save",
    "resetSceneDepthFloorOffset": "save",
    "setCameraZoom": "memory",
    "restoreSceneCameraZoom": "memory",
    "fadingZoom": "memory",
    "fadingRestoreSceneCameraZoom": "memory",
    "fadeWorldToBlack": "memory",
    "fadeWorldFromBlack": "memory",
    "hideOverlayImage": "memory",
    "playScriptedDialogue": "memory",
    "showOverlayImage": "memory",
    "setHotspotDisplayImage": "save",
    "setEntityField": "save",
    "blendOverlayImage": "memory",
    "revealDocument": "save",
    "startDialogueGraph": "memory",
    "waitClickContinue": "memory",
    "waitMs": "memory",
    "enableRuleOffers": "save",
    "disableRuleOffers": "save",
    "moveEntityTo": "memory",
    "faceEntity": "memory",
    "cutsceneSpawnActor": "memory",
    "cutsceneRemoveActor": "memory",
    "showEmoteAndWait": "memory",
}

ACTION_SAVE_DOT_TOOLTIP = (
    "该 Action 会修改或影响已持久化数据（如 flag、任务、背包、档案、可存档实体覆盖等）。"
    "与「仅演出/过场/瞬时显隐」类动作相区分，具体以运行与数据校验为准。"
)


def action_type_writes_save(type_id: str) -> bool:
    return ACTION_PERSISTENCE.get(type_id) == "save"


def _assert_action_persistence_covers_types() -> None:
    tset = set(ACTION_TYPES)
    for a in tset:
        if a not in ACTION_PERSISTENCE:
            raise RuntimeError(
                f"action_editor: ACTION_PERSISTENCE 缺少动作 {a!r}，"
                "新增 ACTION_TYPES 时必须同步写持久化分类",
            )
    extra = set(ACTION_PERSISTENCE.keys()) - tset
    if extra:
        raise RuntimeError(
            f"action_editor: ACTION_PERSISTENCE 存在多余项 {sorted(extra)}",
        )


_assert_action_persistence_covers_types()

_PARAM_SCHEMAS: dict[str, list[tuple[str, str]]] = {
    "setFlag": [("key", "str"), ("value", "flag_val")],
    "appendFlag": [("key", "str"), ("text", "str")],
    "giveItem": [("id", "str"), ("count", "int")],
    "removeItem": [("id", "str"), ("count", "int")],
    "giveCurrency": [("amount", "int")],
    "removeCurrency": [("amount", "int")],
    "giveRule": [("id", "str")],
    "grantRuleLayer": [("ruleId", "str"), ("layer", "str")],
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
    "moveEntityTo": [("target", "str"), ("x", "float"), ("y", "float"), ("speed", "float")],
    "faceEntity": [("target", "str"), ("direction", "str"), ("faceTarget", "str")],
    "cutsceneSpawnActor": [("id", "str"), ("name", "str"), ("x", "float"), ("y", "float")],
    "cutsceneRemoveActor": [("id", "str")],
    "showEmoteAndWait": [("target", "str"), ("emote", "str"), ("duration", "float")],
}

_NOTIFICATION_TYPES = ("info", "warning", "quest", "rule", "item")
_ARCHIVE_BOOK_TYPES = ("character", "lore", "document", "book", "bookEntry")

_FACE_DIRECTIONS = ("left", "right", "up", "down")

# showEmote / showEmoteAndWait：运行时仅为气泡 Text；编辑器侧提供常用占位 + 工程扫描去重。
_EMOTE_QUICK_PRESETS = ("?", "!", "!!", "...", "…")


def _build_emote_action_combo_entries(
    model,
    committed: str,
) -> list[tuple[str, str]]:
    merged: list[str] = []
    ord_seen: set[str] = set()
    for s in list(_EMOTE_QUICK_PRESETS):
        if s not in ord_seen:
            ord_seen.add(s)
            merged.append(s)
    if model:
        for s in model.collect_emote_strings_used_in_project():
            if s not in ord_seen:
                ord_seen.add(s)
                merged.append(s)
    cur = (committed or "").strip()
    if cur:
        if cur not in ord_seen:
            merged.insert(0, cur)
        else:
            # 当前值置顶便于编辑
            merged.remove(cur)
            merged.insert(0, cur)
    if not merged:
        merged.append("?")
    return [(x, x) for x in merged]


def _id_ref_rows_with_orphan(
    pairs: list[tuple[str, str]],
    committed_raw: str,
) -> list[tuple[str, str]]:
    """IdRefSelector 用：数据里已有 id 但不在当前工程候选项时追加一行，避免只能手打。"""
    c = (committed_raw or "").strip()
    if not c:
        return list(pairs)
    keys = {a for a, _ in pairs}
    if c in keys:
        return list(pairs)
    out = list(pairs)
    out.append((c, f"{c} · 仅数据引用"))
    return out


class EmoteBubbleParamWidget(QWidget):
    """气泡 emote：必选下拉 + 快捷「插入」占位 +「其他…」对话框；禁止当纯手输框用。"""

    def __init__(
        self,
        parent: QWidget | None,
        model,
        committed: str,
        on_change: Callable[[], None],
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._on_change = on_change

        cur = str(committed if committed is not None else "")
        rows = _build_emote_action_combo_entries(model, cur)
        pick = cur.strip() or (rows[0][1] if rows else "?")
        self._combo = FilterableTypeCombo(rows, self, select_only=True)
        self._combo.set_committed_type(pick)
        self._combo.typeCommitted.connect(lambda _t: on_change())

        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.addWidget(self._combo, 1)
        ins = QLabel("插入")
        ins.setToolTip("点按钮将气泡文案设为该占位（可再在「其他…」里改）")
        row.addWidget(ins)
        for seg in _EMOTE_QUICK_PRESETS:
            b = QPushButton(seg)
            b.setFixedWidth(32)
            b.setToolTip(f"设为 {seg!r}")
            b.clicked.connect(lambda _=False, s=seg: self._apply_quick(s))
            row.addWidget(b)
        btn = QPushButton("其他…")
        btn.setToolTip("输入任意气泡内文字")
        btn.clicked.connect(self._on_custom_text)
        row.addWidget(btn)

    def _apply_quick(self, segment: str) -> None:
        rows = _build_emote_action_combo_entries(self._model, segment)
        self._combo.set_entries(rows)
        self._combo.set_committed_type(segment)
        self._on_change()

    def _on_custom_text(self) -> None:
        cur = self._combo.committed_type().strip()
        txt, ok = QInputDialog.getText(self, "气泡文案", "输入气泡内显示文字：", text=cur)
        if not ok:
            return
        t = txt.strip()
        if not t:
            return
        rows = _build_emote_action_combo_entries(self._model, t)
        self._combo.set_entries(rows)
        self._combo.set_committed_type(t)
        self._on_change()

    def emote_text(self) -> str:
        return self._combo.committed_type().strip()


def _read_overlay_id_value(w: object) -> str:
    """show/hide/blend overlay id 控件兼容读取（FilterableTypeCombo 新式 + QLineEdit 历史兜底）。"""
    if isinstance(w, FilterableTypeCombo):
        return w.committed_type().strip()
    if isinstance(w, QLineEdit):
        return w.text().strip()
    return ""


def _cutscene_spawn_id_choices(
    model,
    cutscene_id: str | None = None,
) -> list[tuple[str, str]]:
    """cutsceneSpawnActor / cutsceneRemoveActor 的 id：

    - 有 cutscene_id 时：仅列本过场内已用 _cut_ id + 预留槽位（避免跨过场污染）。
    - 无 cutscene_id 时（非过场场景调用，一般不应发生）：全工程 _cut_ id + 预留槽位。
    """
    seen: set[str] = set()
    rows: list[tuple[str, str]] = []
    if model:
        cid = (cutscene_id or "").strip()
        if cid:
            for tid in model.cutscene_temp_actor_ids_in_cutscene(cid):
                if tid not in seen:
                    seen.add(tid)
                    rows.append((tid, tid))
        else:
            for tid, disp in model.collect_cutscene_temp_actor_ids():
                if tid not in seen:
                    seen.add(tid)
                    rows.append((disp, tid))
        for i in range(1, 48):
            tid = f"_cut_actor_{i}"
            if tid not in seen:
                seen.add(tid)
                rows.append((tid, tid))
    return rows


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
        select_only: bool = False,
    ):
        super().__init__(parent)
        self._entries: list[tuple[str, str]] = list(entries)
        self._orphan_label = orphan_label
        self._select_only = select_only
        self._canonical_values: list[str] = []
        self._value_set: set[str] = set()
        self._lower_value: dict[str, str] = {}
        self._rebuild_value_index()
        self._committed: str = self._entries[0][1] if self._entries else ""
        self._programmatic = False
        self._suppress_editing_finish = False

        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        if select_only:
            self.setEditable(False)
            self.currentIndexChanged.connect(self._on_select_only_index_changed)
            self.setToolTip(
                "从下拉列表选择（与运行时登记一致）；不可手写未登记项。",
            )
        else:
            self.setEditable(True)
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
    def from_flat_strings(
        cls,
        types: list[str],
        parent: QWidget | None = None,
        *,
        select_only: bool = False,
    ) -> FilterableTypeCombo:
        return cls([(t, t) for t in types], parent=parent, select_only=select_only)

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
        for i in range(self.count()):
            if str(self.itemData(i, _USER_ROLE) or "") == committed_value:
                self.setCurrentIndex(i)
                break
        if self.isEditable():
            le = self.lineEdit()
            if le is not None:
                disp_show = self._display_for_value(self._committed)
                le.setText(disp_show)
        self.blockSignals(False)

    def _on_select_only_index_changed(self, index: int) -> None:
        if not self._select_only or self._programmatic:
            return
        if index < 0:
            return
        v = self._value_at(index)
        if v == self._committed:
            return
        self._apply_committed(v)

    def _pool_rows(self) -> list[tuple[str, str]]:
        return self._entries_with_orphan(self._committed)

    def _on_text_edited(self, text: str) -> None:
        if self._select_only or self._programmatic:
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
        self.hidePopup()

        def _deferred_apply() -> None:
            try:
                self._apply_committed(v)
            finally:
                self._suppress_editing_finish = False

        # 若在 activated 栈内立刻 clear()，部分平台/主题下弹出层尚未完全卸载，会闪退
        QTimer.singleShot(0, _deferred_apply)

    def _apply_committed(self, value: str) -> None:
        prev = self._committed
        self._committed = value
        self._programmatic = True
        self._refill_all_items(value)
        self._programmatic = False
        if prev != value:
            self.typeCommitted.emit(value)

    def _on_editing_finished(self) -> None:
        if self._select_only or self._programmatic or self._suppress_editing_finish:
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

    def set_entries(self, entries: list[tuple[str, str]]) -> None:
        """【首选 API】运行时更新下拉条目，保留当前 committed 值（不在列表则作为孤儿项显示）。

        所有新代码应调用本方法。`set_items` 是兼容别名，仅用于可能同时改 orphan_label 的老调用点。
        """
        prev = self._committed
        self._entries = list(entries)
        self._rebuild_value_index()
        self._programmatic = True
        try:
            self._refill_all_items(prev)
        finally:
            self._programmatic = False

    def set_items(
        self,
        items: list[tuple[str, str]],
        *,
        orphan_label: Callable[[str], str] | None = None,
    ) -> None:
        """【兼容别名】等同于 set_entries，并允许一并更新孤儿项展示文案。

        新代码请使用 `set_entries`；保留本方法以兼容 timeline_editor 等历史调用点。
        """
        if orphan_label is not None:
            self._orphan_label = orphan_label
        self.set_entries(items)


def _type_entry_matches(disp: str, value: str, q: str) -> bool:
    return FilterableTypeCombo._matches(disp, q) or FilterableTypeCombo._matches(value, q)


class _InlineSaveDot(QFrame):
    """行内/列表：仅红圆 + 悬停说明（无点击逻辑）。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("actionSavePersistDot")
        self.setFixedSize(10, 10)
        self.setStyleSheet(
            "QFrame#actionSavePersistDot {"
            " background-color: #c62828; border: none; border-radius: 5px; }",
        )
        self.setToolTip(ACTION_SAVE_DOT_TOOLTIP)
        self.setCursor(Qt.CursorShape.PointingHandCursor)


class _ListSaveDot(QFrame):
    """列表行内红圆：点击即选中本行，双击会驱动对话框确定。"""

    def __init__(
        self,
        on_select: Callable[[], None],
        on_double: Callable[[], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("actionSavePersistDot")
        self.setFixedSize(10, 10)
        self.setStyleSheet(
            "QFrame#actionSavePersistDot {"
            " background-color: #c62828; border: none; border-radius: 5px; }",
        )
        self.setToolTip(ACTION_SAVE_DOT_TOOLTIP)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._on_select = on_select
        self._on_double = on_double

    def mousePressEvent(self, e) -> None:
        self._on_select()
        e.accept()

    def mouseDoubleClickEvent(self, e) -> None:
        self._on_select()
        self._on_double()
        e.accept()


class _ActionTypeListRow(QWidget):
    """带可选红圆、支持点击/双击整行的列表项。"""

    def __init__(
        self,
        list_widget: QListWidget,
        list_item: QListWidgetItem,
        dialog: "ActionTypePickerDialog",
        text: str,
        value: str,
    ) -> None:
        super().__init__(list_widget)
        self._list_widget = list_widget
        self._item = list_item
        self._dialog = dialog
        lay = QHBoxLayout(self)
        lay.setContentsMargins(6, 3, 6, 3)
        lay.setSpacing(8)
        name = QLabel(text, self)
        name.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        name.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        lay.addWidget(name, 1)
        if action_type_writes_save(value):
            lay.addWidget(
                _ListSaveDot(
                    on_select=lambda: self._list_widget.setCurrentItem(self._item),
                    on_double=self._dialog._on_row_double_confirm,
                    parent=self,
                ),
                0,
                Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
            )
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred,
        )

    def mousePressEvent(self, e) -> None:
        self._list_widget.setCurrentItem(self._item)
        e.accept()

    def mouseDoubleClickEvent(self, e) -> None:
        self._list_widget.setCurrentItem(self._item)
        self._dialog._on_row_double_confirm()
        e.accept()


class ActionTypePickerDialog(QDialog):
    """在独立窗口中可搜索的 (展示名, 取值) 选择器，给 Action 主类型等长列表用。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("选择 Action 类型")
        self.setMinimumSize(760, 560)
        self.resize(760, 560)
        self._all_rows: list[tuple[str, str]] = []
        self._selected: str = ""

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        legend = QLabel(
            "红圆点仅标「会改存档/可持久化数据」的动作，悬停圆点查看说明；无圆点为偏演出/瞬时/流程类。",
            self,
        )
        legend.setWordWrap(True)
        legend.setStyleSheet("color: palette(mid);")
        root.addWidget(legend)
        self._search = QLineEdit(self)
        self._search.setPlaceholderText("输入以筛选…")
        self._search.setClearButtonEnabled(True)
        self._search.textChanged.connect(self._apply_filter)
        root.addWidget(self._search)

        self._list = QListWidget(self)
        self._list.setAlternatingRowColors(True)
        self._list.setMinimumHeight(400)
        root.addWidget(self._list, stretch=1)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        btns.accepted.connect(self._on_accept)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)

    def set_rows(
        self,
        rows: list[tuple[str, str]],
        *,
        current: str,
    ) -> None:
        self._all_rows = list(rows)
        self._search.blockSignals(True)
        self._search.setText("")
        self._search.blockSignals(False)
        self._apply_filter("")
        self._select_value_or_first(current)
        self._search.setFocus()

    def selected_value(self) -> str:
        return self._selected

    def _apply_filter(self, q: str) -> None:
        self._list.clear()
        query = (q or "").strip()
        for disp, val in self._all_rows:
            if not query or _type_entry_matches(disp, val, query):
                it = QListWidgetItem()
                it.setData(_USER_ROLE, val)
                self._list.addItem(it)
                row = _ActionTypeListRow(self._list, it, self, disp, val)
                self._list.setItemWidget(it, row)
                sh = row.sizeHint()
                it.setSizeHint(
                    QSize(max(200, sh.width()), max(sh.height() + 2, 26)),
                )
        if self._list.count() > 0:
            self._list.setCurrentRow(0)

    def _on_row_double_confirm(self) -> None:
        self._on_accept()

    def _select_value_or_first(self, value: str) -> None:
        want = (value or "").strip()
        for i in range(self._list.count()):
            it = self._list.item(i)
            if it and str(it.data(_USER_ROLE) or "") == want:
                self._list.setCurrentRow(i)
                self._list.scrollToItem(it)
                return
        if self._list.count() > 0:
            self._list.setCurrentRow(0)

    def _on_accept(self) -> None:
        it = self._list.currentItem()
        if it is not None:
            self._selected = str(it.data(_USER_ROLE) or "")
        elif self._list.count() > 0:
            it0 = self._list.item(0)
            self._selected = str(it0.data(_USER_ROLE) or "") if it0 else ""
        self.accept()


class ActionTypePickerField(QWidget):
    """
    替代 ``FilterableTypeCombo(select_only=True)`` 用于 Action 主类型等长列表：
    行内不展开超长下拉，点击按钮在独立可搜索窗口中选择。
    """

    typeCommitted = Signal(str)

    def __init__(
        self,
        entries: list[tuple[str, str]],
        parent: QWidget | None = None,
        *,
        orphan_label: Callable[[str], str] | None = None,
    ) -> None:
        super().__init__(parent)
        self._entries: list[tuple[str, str]] = list(entries)
        self._orphan_label = orphan_label
        self._value_set: set[str] = set()
        self._lower_value: dict[str, str] = {}
        self._rebuild_value_index()
        self._committed: str = self._entries[0][1] if self._entries else ""
        self._programmatic = False

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._line = QLineEdit(self)
        self._line.setReadOnly(True)
        self._line.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self._line.setToolTip(
            "当前 Action 类型。红圆点表示会改存档/持久化，悬停圆点查看；"
            "无圆点多为演出/流程类。点「选择…」在独立窗口中搜索。",
        )
        self._save_dot = _InlineSaveDot(self)
        self._save_dot.setVisible(False)
        pick = QPushButton("选择…", self)
        pick.setToolTip("打开可搜索的 Action 类型选择窗口；红圆点与窗口内含义一致。")
        pick.setFixedWidth(64)
        pick.clicked.connect(self._open_dialog)
        lay.addWidget(self._line, stretch=1)
        lay.addWidget(self._save_dot, stretch=0)
        lay.addWidget(pick, stretch=0)
        self._refill_line()

    @classmethod
    def from_flat_strings(
        cls,
        types: list[str],
        parent: QWidget | None = None,
    ) -> ActionTypePickerField:
        return cls([(t, t) for t in types], parent=parent)

    def _rebuild_value_index(self) -> None:
        self._value_set = set()
        self._lower_value = {}
        for _d, v in self._entries:
            if v not in self._value_set:
                self._value_set.add(v)
                self._lower_value.setdefault(v.lower(), v)

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

    def _display_for_value(self, value: str) -> str:
        for d, v in self._entries:
            if v == value:
                return d
        if value and value not in self._value_set:
            if self._orphan_label:
                return self._orphan_label(value)
        return value

    def _refill_line(self) -> None:
        self._line.setText(self._display_for_value(self._committed))
        if hasattr(self, "_save_dot") and self._save_dot is not None:
            self._save_dot.setVisible(
                bool(self._committed) and action_type_writes_save(self._committed),
            )

    def committed_type(self) -> str:
        return self._committed

    def set_committed_type(self, value: str, *, emit: bool = False) -> None:
        self._programmatic = True
        try:
            self._committed = value if value else (self._entries[0][1] if self._entries else "")
            self._refill_line()
        finally:
            self._programmatic = False
        if emit:
            self.typeCommitted.emit(self._committed)

    def _apply_committed(self, value: str) -> None:
        prev = self._committed
        self._committed = value
        self._refill_line()
        if prev != value and not self._programmatic:
            self.typeCommitted.emit(value)

    def set_entries(self, entries: list[tuple[str, str]]) -> None:
        prev = self._committed
        self._entries = list(entries)
        self._rebuild_value_index()
        self._programmatic = True
        try:
            self._committed = prev
            if not self._committed and self._entries:
                self._committed = self._entries[0][1]
            self._refill_line()
        finally:
            self._programmatic = False

    def set_items(
        self,
        items: list[tuple[str, str]],
        *,
        orphan_label: Callable[[str], str] | None = None,
    ) -> None:
        if orphan_label is not None:
            self._orphan_label = orphan_label
        self.set_entries(items)

    def _open_dialog(self) -> None:
        rows = self._entries_with_orphan(self._committed)
        dlg = ActionTypePickerDialog(self)
        dlg.set_rows(rows, current=self._committed)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            val = dlg.selected_value()
            if val != self._committed:
                self._apply_committed(val)

    def wheelEvent(self, ev: QWheelEvent) -> None:
        ev.ignore()


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
        self._refresh_reorder_buttons()
        self.changed.emit()

    def _move_row(self, rec: dict, delta: int) -> None:
        if rec not in self._rows:
            return
        i = self._rows.index(rec)
        j = i + delta
        if j < 0 or j >= len(self._rows):
            return
        _hide_combo_popups_under(self)
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        for r in self._rows:
            self._list_layout.removeWidget(r["box"])
        for r in self._rows:
            self._list_layout.addWidget(r["box"])
        self._refresh_reorder_buttons()
        self.changed.emit()

    def _refresh_reorder_buttons(self) -> None:
        n = len(self._rows)
        for i, r in enumerate(self._rows):
            r["btn_up"].setEnabled(i > 0)
            r["btn_down"].setEnabled(i < n - 1)

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
        up = QPushButton("\u2191")
        up.setFixedWidth(24)
        up.setToolTip("上移")
        dn = QPushButton("\u2193")
        dn.setFixedWidth(24)
        dn.setToolTip("下移")
        rm = QPushButton("\u2212")
        rm.setFixedWidth(24)
        rm.setToolTip("删除")
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
        rec = {
            "box": box, "rid": rid, "text": tx, "ae": ae,
            "btn_up": up, "btn_down": dn,
        }
        rm.clicked.connect(lambda: self._remove_row(rec))
        up.clicked.connect(lambda: self._move_row(rec, -1))
        dn.clicked.connect(lambda: self._move_row(rec, 1))
        hdr.addWidget(up)
        hdr.addWidget(dn)
        hdr.addWidget(rm)
        bl.insertLayout(0, hdr)
        layer_row = QWidget()
        ll = QHBoxLayout(layer_row)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.addWidget(QLabel("requiredLayers"), stretch=0)
        cb_xiang = QCheckBox("象")
        cb_li = QCheckBox("理")
        cb_shu = QCheckBox("术")
        rl_raw = data.get("requiredLayers") or []
        rl_set = set(rl_raw) if isinstance(rl_raw, list) else set()
        cb_xiang.setChecked("xiang" in rl_set)
        cb_li.setChecked("li" in rl_set)
        cb_shu.setChecked("shu" in rl_set)
        for cb in (cb_xiang, cb_li, cb_shu):
            cb.toggled.connect(lambda _v: self.changed.emit())
        ll.addWidget(cb_xiang)
        ll.addWidget(cb_li)
        ll.addWidget(cb_shu)
        ll.addStretch(1)
        bl.addWidget(layer_row)
        rec["cb_xiang"] = cb_xiang
        rec["cb_li"] = cb_li
        rec["cb_shu"] = cb_shu
        self._rows.append(rec)
        self._list_layout.addWidget(box)
        self._refresh_reorder_buttons()

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for r in self._rows:
            req: list[str] = []
            if r.get("cb_xiang") is not None and r["cb_xiang"].isChecked():
                req.append("xiang")
            if r.get("cb_li") is not None and r["cb_li"].isChecked():
                req.append("li")
            if r.get("cb_shu") is not None and r["cb_shu"].isChecked():
                req.append("shu")
            slot: dict = {
                "ruleId": r["rid"].current_id(),
                "resultText": r["text"].toPlainText(),
                "resultActions": r["ae"].to_list(),
            }
            if req:
                slot["requiredLayers"] = req
            out.append(slot)
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
        *,
        cutscene_id: str | None = None,
    ):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        self._ctx_cutscene_id = (cutscene_id or "") or None
        self._delayed_editor = None
        self._collapsed = True

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)
        self._outer_layout = outer

        # 所有子 widget 均显式传 parent=self：避免任何 QWidget 子类（尤其 QComboBox）在构造时
        # 以"无 parent"短暂成为 top-level HWND，Windows 上会被 DWM 采样表现为任务栏闪现小窗。
        top = QHBoxLayout()
        self._fold_toggle = QToolButton(self)
        self._fold_toggle.setAutoRaise(True)
        self._fold_toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._fold_toggle.setToolTip("折叠 / 展开参数区")
        self._fold_toggle.clicked.connect(self._on_fold_clicked)
        top.addWidget(self._fold_toggle)
        self.type_combo = ActionTypePickerField.from_flat_strings(
            ACTION_TYPES, parent=self,
        )
        self._btn_up = QPushButton("\u2191", self)
        self._btn_up.setFixedWidth(24)
        self._btn_up.setToolTip("上移")
        self._btn_up.clicked.connect(self.move_up.emit)
        self._btn_down = QPushButton("\u2193", self)
        self._btn_down.setFixedWidth(24)
        self._btn_down.setToolTip("下移")
        self._btn_down.clicked.connect(self.move_down.emit)
        self._btn_up.setVisible(show_reorder_buttons)
        self._btn_down.setVisible(show_reorder_buttons)
        self.del_btn = QPushButton("\u2212", self)
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))
        self.del_btn.setVisible(show_delete_button)
        top.addWidget(self.type_combo, stretch=1)
        top.addWidget(self._btn_up)
        top.addWidget(self._btn_down)
        top.addWidget(self.del_btn)
        outer.addLayout(top)

        self._rule_slots_editor: RuleSlotsParamEditor | None = None

        self._foldable_body = QWidget(self)
        self._foldable_layout = QVBoxLayout(self._foldable_body)
        self._foldable_layout.setContentsMargins(0, 0, 0, 0)
        self._foldable_layout.setSpacing(2)

        self._params_frame = QFrame(self._foldable_body)
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

    def _blend_preview_params(self) -> dict:
        """供 BlendOverlayPreviewWidget 读取当前表单（仅 blendOverlayImage 展开时有效）。"""
        from_w = self._param_widgets.get("fromImage")
        to_w = self._param_widgets.get("toImage")
        x_w = self._param_widgets.get("xPercent")
        y_w = self._param_widgets.get("yPercent")
        w_w = self._param_widgets.get("widthPercent")
        dur_w = self._param_widgets.get("durationMs")
        del_w = self._param_widgets.get("delayMs")
        fu = from_w.path() if isinstance(from_w, CutsceneImagePathRow) else ""
        tu = to_w.path() if isinstance(to_w, CutsceneImagePathRow) else ""
        return {
            "from_url": fu,
            "to_url": tu,
            "x_pct": float(x_w.value()) if isinstance(x_w, QDoubleSpinBox) else 50.0,
            "y_pct": float(y_w.value()) if isinstance(y_w, QDoubleSpinBox) else 50.0,
            "width_pct": float(w_w.value()) if isinstance(w_w, QDoubleSpinBox) else 40.0,
            "delay_ms": int(del_w.value()) if isinstance(del_w, QSpinBox) else 0,
            "duration_ms": int(dur_w.value()) if isinstance(dur_w, QSpinBox) else 600,
        }

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

    def set_project_context(
        self,
        model,
        scene_id: str | None,
        *,
        cutscene_id: str | None = None,
    ) -> None:
        self._data = self.to_dict()
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        if cutscene_id is not None:
            self._ctx_cutscene_id = cutscene_id or None
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

    def _connect_play_npc_animation_pickers(self, *, initial_state: str) -> None:
        tgt_w = self._param_widgets.get("target")
        st_w = self._param_widgets.get("state")
        if not isinstance(tgt_w, IdRefSelector) or not isinstance(st_w, FilterableTypeCombo):
            return
        init_st = (initial_state or "").strip()
        _refresh_calls = 0

        def refresh_state(_: str = "") -> None:
            nonlocal _refresh_calls
            _refresh_calls += 1
            aid = tgt_w.current_id().strip()
            m = self._ctx_model
            states = (
                m.animation_state_names_for_actor(self._ctx_scene_id, aid)
                if m
                else []
            )
            rows: list[tuple[str, str]] = [("", "（选 state）")]
            rows.extend((s, s) for s in states)
            cur = st_w.committed_type().strip()
            if _refresh_calls == 1 and not cur and init_st:
                cur = init_st
            st_w.set_entries(rows)
            if cur in states or cur == "":
                st_w.set_committed_type(cur)
            elif cur:
                st_w.set_entries([(f"(数据) {cur}", cur)] + rows[1:])
                st_w.set_committed_type(cur)
            else:
                st_w.set_committed_type("")

        tgt_w.value_changed.connect(refresh_state)
        refresh_state()

    def _connect_persist_npc_anim_state_pickers(self, *, initial_state: str) -> None:
        tgt_w = self._param_widgets.get("target")
        st_w = self._param_widgets.get("state")
        if not isinstance(tgt_w, IdRefSelector) or not isinstance(st_w, FilterableTypeCombo):
            return
        init_st = (initial_state or "").strip()
        _refresh_calls = 0

        def refresh_state(_: str = "") -> None:
            nonlocal _refresh_calls
            _refresh_calls += 1
            aid = tgt_w.current_id().strip()
            m = self._ctx_model
            states = (
                m.animation_state_names_for_actor(self._ctx_scene_id, aid)
                if m
                else []
            )
            rows: list[tuple[str, str]] = [("", "（选 state）")]
            rows.extend((s, s) for s in states)
            cur = st_w.committed_type().strip()
            if _refresh_calls == 1 and not cur and init_st:
                cur = init_st
            st_w.set_entries(rows)
            if cur in states or cur == "":
                st_w.set_committed_type(cur)
            elif cur:
                st_w.set_entries([(f"(数据) {cur}", cur)] + rows[1:])
                st_w.set_committed_type(cur)
            else:
                st_w.set_committed_type("")

        tgt_w.value_changed.connect(refresh_state)
        refresh_state()

    def _build_overlay_id_combo(self, value: str) -> FilterableTypeCombo:
        """show/hide/blend 叠图 id：overlay_images.json 短 id + 自由输入（非 select_only）。"""
        m = self._ctx_model
        entries = m.overlay_short_id_entries() if m else []
        w = FilterableTypeCombo(entries, self, select_only=False)
        w.setToolTip(
            "与 hideOverlayImage / blendOverlayImage 共用的标记；"
            "下拉为 overlay_images.json 的短 id，也可输入任意新 id。",
        )
        cur = (value or "").strip()
        w.set_committed_type(cur)
        w.typeCommitted.connect(lambda _t: self.changed.emit())
        return w

    def _make_selector(
        self,
        kind: str,
        val: str,
    ) -> IdRefSelector:
        """下拉选 id；actor / emote_target / npc_only 仅允许点选并合并数据孤儿 id。"""
        m = self._ctx_model
        committed = str(val if val is not None else "").strip()
        strict_pick = kind in ("actor", "emote_target", "npc_only")

        pairs: list[tuple[str, str]] = []
        if kind == "scene":
            pairs = [(s, s) for s in (m.all_scene_ids() if m else [])]
        elif kind == "item":
            pairs = m.all_item_ids() if m else []
        elif kind == "quest":
            pairs = m.all_quest_ids() if m else []
        elif kind == "encounter":
            pairs = m.all_encounter_ids() if m else []
        elif kind == "rule":
            pairs = m.all_rule_ids() if m else []
        elif kind == "fragment":
            pairs = m.all_fragment_ids() if m else []
        elif kind == "cutscene":
            pairs = m.all_cutscene_ids() if m else []
        elif kind == "shop":
            pairs = m.all_shop_ids() if m else []
        elif kind == "audio_bgm":
            pairs = [(a, a) for a in (m.all_audio_ids("bgm") if m else [])]
        elif kind == "audio_sfx":
            pairs = [(a, a) for a in (m.all_audio_ids("sfx") if m else [])]
        elif kind == "spawn":
            pairs = [("", "(default)")]
        elif kind == "emote_target":
            if m:
                pairs.extend(m.npc_ids_for_scene(self._ctx_scene_id))
            pairs.append(("player", "player"))
        elif kind == "actor":
            pairs = m.actor_id_items_for_scene(self._ctx_scene_id) if m else []
        elif kind == "npc_only":
            pairs = m.npc_actor_items_for_scene(self._ctx_scene_id) if m else []
        else:
            pairs = []

        if strict_pick:
            pairs = _id_ref_rows_with_orphan(pairs, committed)

        w = IdRefSelector(self, allow_empty=True, editable=not strict_pick)
        w.setMinimumWidth(96)
        if pairs:
            w.set_items(pairs)
        else:
            w.set_items([])
        w.set_current(committed)
        w.value_changed.connect(self.changed)
        tip = {
            "actor": "仅下拉选择；无场景上下文时列表可能不全，请先设置过场 targetScene。",
            "emote_target": "仅下拉选择；列表为当前场景 NPC + player。",
            "npc_only": "仅下拉选择；列表为当前场景 NPC。",
        }.get(kind)
        if tip:
            w.setToolTip(tip)
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

        if act_type == "setEntityField":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "按 Save.* 字段 schema 写入可存档运行时覆盖；目标实体未加载时也会在进入场景后生效。",
                self,
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            m = self._ctx_model
            scene_entries = [(s, s) for s in (m.all_scene_ids() if m else [])] or [("（无场景）", "")]
            scene_combo = FilterableTypeCombo(scene_entries, self, select_only=True)
            cur_scene = str(params.get("sceneId") or self._ctx_scene_id or "").strip()
            if cur_scene:
                scene_combo.set_committed_type(cur_scene)
            elif scene_entries and scene_entries[0][1]:
                scene_combo.set_committed_type(scene_entries[0][1])
            self._param_widgets["sceneId"] = scene_combo
            self._params_layout.addRow("sceneId", scene_combo)

            kind_combo = FilterableTypeCombo(entity_kind_choices(), self, select_only=True)
            cur_kind = str(params.get("entityKind") or "npc").strip()
            if cur_kind in ("npc", "hotspot"):
                kind_combo.set_committed_type(cur_kind)
            self._param_widgets["entityKind"] = kind_combo
            self._params_layout.addRow("entityKind", kind_combo)

            entity_combo = FilterableTypeCombo([], self, select_only=True)
            self._param_widgets["entityId"] = entity_combo
            self._params_layout.addRow("entityId", entity_combo)

            field_combo = FilterableTypeCombo([], self, select_only=True)
            self._param_widgets["fieldName"] = field_combo
            self._params_layout.addRow("fieldName", field_combo)

            value_frame = QFrame(self)
            value_layout = QFormLayout(value_frame)
            value_layout.setContentsMargins(0, 0, 0, 0)
            self._param_widgets["_valueFrame"] = value_frame
            self._params_layout.addRow("value", value_frame)

            def _clear_value_widgets() -> None:
                while value_layout.rowCount() > 0:
                    value_layout.removeRow(0)
                for key in list(self._param_widgets.keys()):
                    if key.startswith("value.") or key == "value":
                        self._param_widgets.pop(key, None)

            def _anim_manifest_entries() -> list[tuple[str, str]]:
                ids = m.all_anim_files() if m else []
                return [(f"{aid} (/assets/animation/{aid}/anim.json)", f"/assets/animation/{aid}/anim.json") for aid in ids]

            def _refill_entities(*, keep_saved: bool) -> None:
                sid = scene_combo.committed_type()
                kind = kind_combo.committed_type()
                raw_rows = m.entity_ids_for_scene(sid, kind) if m else []
                rows = [(f"{eid} ({label})", eid) for eid, label in raw_rows]
                if not rows:
                    rows = [("（当前场景无实体）", "")]
                saved = str(params.get("entityId") or "").strip()
                prev = entity_combo.committed_type()
                prefer = saved if keep_saved else prev
                entity_combo.set_entries(rows)
                values = {v for _d, v in rows}
                if prefer in values:
                    entity_combo.set_committed_type(prefer)
                elif rows:
                    entity_combo.set_committed_type(rows[0][1])

            def _refill_fields(*, keep_saved: bool) -> None:
                kind = kind_combo.committed_type()
                rows = m.runtime_entity_field_choices(kind) if m else []
                if not rows:
                    rows = [("（无可存档字段）", "")]
                saved = str(params.get("fieldName") or "").strip()
                prev = field_combo.committed_type()
                prefer = saved if keep_saved else prev
                field_combo.set_entries(rows)
                values = {v for _d, v in rows}
                if prefer in values:
                    field_combo.set_committed_type(prefer)
                elif rows:
                    field_combo.set_committed_type(rows[0][1])

            def _rebuild_value(*, keep_saved: bool) -> None:
                _clear_value_widgets()
                kind = kind_combo.committed_type()
                field = field_combo.committed_type()
                meta = m.runtime_entity_field_meta(kind, field) if m else None
                raw_value = params.get("value") if keep_saved else None
                if not meta:
                    return
                fkind = meta.get("kind")
                picker = meta.get("picker")
                if fkind == "number":
                    sp = QDoubleSpinBox(self)
                    sp.setRange(-9999999, 9999999)
                    sp.setDecimals(3)
                    try:
                        sp.setValue(float(raw_value if raw_value is not None else 0))
                    except (TypeError, ValueError):
                        sp.setValue(0)
                    sp.valueChanged.connect(self.changed)
                    self._param_widgets["value"] = sp
                    value_layout.addRow(field, sp)
                elif fkind == "boolean":
                    cb = QCheckBox(self)
                    cb.setChecked(bool(raw_value) if isinstance(raw_value, bool) else False)
                    cb.toggled.connect(self.changed)
                    self._param_widgets["value"] = cb
                    value_layout.addRow(field, cb)
                elif fkind == "string" and picker == "animationManifest":
                    rows = _anim_manifest_entries() or [("（无动画包）", "")]
                    w = FilterableTypeCombo(rows, self, select_only=True)
                    cur = str(raw_value or "").strip()
                    if cur:
                        w.set_committed_type(cur)
                    elif rows:
                        w.set_committed_type(rows[0][1])
                    w.typeCommitted.connect(lambda _t: self.changed.emit())
                    self._param_widgets["value"] = w
                    value_layout.addRow(field, w)
                elif fkind == "string" and picker == "animationState":
                    sid = scene_combo.committed_type()
                    eid = entity_combo.committed_type()
                    states = m.animation_state_names_for_actor(sid, eid) if m and eid else []
                    rows = [(s, s) for s in states] or [("（无动画 state）", "")]
                    w = FilterableTypeCombo(rows, self, select_only=True)
                    cur = str(raw_value or "").strip()
                    if cur:
                        w.set_committed_type(cur)
                    elif rows:
                        w.set_committed_type(rows[0][1])
                    w.typeCommitted.connect(lambda _t: self.changed.emit())
                    self._param_widgets["value"] = w
                    value_layout.addRow(field, w)
                elif fkind == "object" and picker == "hotspotDisplayImage":
                    raw = raw_value if isinstance(raw_value, dict) else {}
                    img = CutsceneImagePathRow(self._ctx_model, str(raw.get("image") or ""), self)
                    img.changed.connect(self.changed)
                    self._param_widgets["value.image"] = img
                    value_layout.addRow("image", img)
                    for k, label in (("worldWidth", "worldWidth"), ("worldHeight", "worldHeight")):
                        sp = QDoubleSpinBox(self)
                        sp.setRange(0.1, 9999999)
                        sp.setDecimals(2)
                        try:
                            sp.setValue(float(raw.get(k, 100)))
                        except (TypeError, ValueError):
                            sp.setValue(100)
                        sp.valueChanged.connect(self.changed)
                        self._param_widgets[f"value.{k}"] = sp
                        value_layout.addRow(label, sp)
                    facing = FilterableTypeCombo([("(默认 right)", ""), ("left", "left"), ("right", "right")], self, select_only=True)
                    facing.set_committed_type(str(raw.get("facing") or ""))
                    facing.typeCommitted.connect(lambda _t: self.changed.emit())
                    self._param_widgets["value.facing"] = facing
                    value_layout.addRow("facing", facing)
                    sort = FilterableTypeCombo([("(按 Y 排序)", ""), ("back", "back"), ("front", "front")], self, select_only=True)
                    sort.set_committed_type(str(raw.get("spriteSort") or ""))
                    sort.typeCommitted.connect(lambda _t: self.changed.emit())
                    self._param_widgets["value.spriteSort"] = sort
                    value_layout.addRow("spriteSort", sort)
                else:
                    w = QLineEdit(str(raw_value or ""), self)
                    w.textChanged.connect(self.changed)
                    self._param_widgets["value"] = w
                    value_layout.addRow(field, w)

            def _on_scene_or_kind(_t: str = "") -> None:
                _refill_entities(keep_saved=False)
                _refill_fields(keep_saved=False)
                _rebuild_value(keep_saved=False)
                self.changed.emit()

            def _on_field(_t: str = "") -> None:
                _rebuild_value(keep_saved=False)
                self.changed.emit()

            def _on_entity(_t: str = "") -> None:
                if (m.runtime_entity_field_meta(kind_combo.committed_type(), field_combo.committed_type()) or {}).get("picker") == "animationState":
                    _rebuild_value(keep_saved=False)
                self.changed.emit()

            scene_combo.typeCommitted.connect(_on_scene_or_kind)
            kind_combo.typeCommitted.connect(_on_scene_or_kind)
            entity_combo.typeCommitted.connect(_on_entity)
            field_combo.typeCommitted.connect(_on_field)
            _refill_entities(keep_saved=True)
            _refill_fields(keep_saved=True)
            _rebuild_value(keep_saved=True)
            self._sync_foldable_visibility()
            return

        if act_type == "setHotspotDisplayImage":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "写入 Hotspot displayImage 的 Save 字段覆盖；目标场景未加载时也会在进入场景后生效。",
                self,
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            m = self._ctx_model
            scene_entries = [(s, s) for s in (m.all_scene_ids() if m else [])] or [("（无场景）", "")]
            scene_combo = FilterableTypeCombo(scene_entries, self, select_only=True)
            cur_scene = str(params.get("sceneId") or self._ctx_scene_id or "").strip()
            if cur_scene:
                scene_combo.set_committed_type(cur_scene)
            elif scene_entries and scene_entries[0][1]:
                scene_combo.set_committed_type(scene_entries[0][1])
            self._param_widgets["sceneId"] = scene_combo
            self._params_layout.addRow("sceneId", scene_combo)
            hs_raw = m.hotspot_ids_for_scene(scene_combo.committed_type()) if m else []
            hs_rows = [(f"{hid} ({label})", hid) for hid, label in hs_raw]
            if not hs_rows:
                hs_rows = [("（当前场景无热点）", "")]
            id_combo = FilterableTypeCombo(hs_rows, self, select_only=True)
            cur_id = str(params.get("hotspotId", "") or "").strip()
            if cur_id:
                id_combo.set_committed_type(cur_id)
            elif hs_rows and hs_rows[0][0]:
                id_combo.set_committed_type(hs_rows[0][1])

            def _refill_hotspots(_t: str = "") -> None:
                raw_rows = m.hotspot_ids_for_scene(scene_combo.committed_type()) if m else []
                rows = [(f"{hid} ({label})", hid) for hid, label in raw_rows]
                if not rows:
                    rows = [("（当前场景无热点）", "")]
                cur = id_combo.committed_type()
                id_combo.set_entries(rows)
                values = {v for _d, v in rows}
                id_combo.set_committed_type(cur if cur in values else rows[0][1])
                self.changed.emit()

            scene_combo.typeCommitted.connect(_refill_hotspots)
            id_combo.typeCommitted.connect(lambda _v: self.changed.emit())
            self._param_widgets["hotspotId"] = id_combo
            self._params_layout.addRow("hotspotId", id_combo)
            img_row = CutsceneImagePathRow(self._ctx_model, str(params.get("image", "") or ""), self)
            img_row.changed.connect(self.changed)
            self._param_widgets["image"] = img_row
            self._params_layout.addRow("image", img_row)
            opt_tip = QLabel(
                "worldWidth / worldHeight / facing 可选：宽高均不填则仅换图、保留原世界尺寸；"
                "只填宽或高则另一维按新图素比计算。朝向不选则保留原 displayImage 的 facing。",
                self,
            )
            opt_tip.setWordWrap(True)
            self._params_layout.addRow(opt_tip)
            w_ww = QDoubleSpinBox()
            w_ww.setRange(0, 999999)
            w_ww.setDecimals(1)
            w_ww.setSingleStep(1.0)
            w_ww.setSpecialValueText("不指定")
            try:
                _raw_ww = params.get("worldWidth", 0)
                wv = float(_raw_ww) if _raw_ww is not None and _raw_ww != "" else 0.0
            except (TypeError, ValueError):
                wv = 0.0
            w_ww.setValue(0.0 if wv <= 0 else wv)
            w_ww.setToolTip("为 0（不指定）则不在本动作中设置该维；>0 时按合并规则写入")
            w_ww.valueChanged.connect(self.changed.emit)
            self._param_widgets["worldWidth"] = w_ww
            self._params_layout.addRow("worldWidth（可选）", w_ww)
            w_hh = QDoubleSpinBox()
            w_hh.setRange(0, 999999)
            w_hh.setDecimals(1)
            w_hh.setSingleStep(1.0)
            w_hh.setSpecialValueText("不指定")
            try:
                _raw_hh = params.get("worldHeight", 0)
                hv = float(_raw_hh) if _raw_hh is not None and _raw_hh != "" else 0.0
            except (TypeError, ValueError):
                hv = 0.0
            w_hh.setValue(0.0 if hv <= 0 else hv)
            w_hh.setToolTip("为 0（不指定）则不在本动作中设置该维；>0 时按合并规则写入")
            w_hh.valueChanged.connect(self.changed.emit)
            self._param_widgets["worldHeight"] = w_hh
            self._params_layout.addRow("worldHeight（可选）", w_hh)
            fac_raw = str(params.get("facing", "") or "").strip().lower()
            fac_v = fac_raw if fac_raw in ("left", "right") else ""
            fac_rows = [
                ("不指定（保留原朝向）", ""),
                ("朝右（默认）", "right"),
                ("朝左", "left"),
            ]
            fac_combo = FilterableTypeCombo(fac_rows, self, select_only=True)
            if fac_v:
                fac_combo.set_committed_type(fac_v)
            else:
                fac_combo.set_committed_type("")
            fac_combo.typeCommitted.connect(lambda _v: self.changed.emit())
            self._param_widgets["facing"] = fac_combo
            self._params_layout.addRow("facing（可选）", fac_combo)
            self._sync_foldable_visibility()
            return

        if act_type == "showOverlayImage":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "id：与 hideOverlayImage 共用的标记；x/y/width 为 0–100 的屏幕百分比；"
                "图像中心在 (x,y)，高度由原图宽高比自动计算。",
                self,
            )
            tip.setWordWrap(True)
            tip.setToolTip("id 须与 hideOverlayImage 共用；可与 overlay_images.json 短 id 对齐。")
            self._params_layout.addRow(tip)
            id_combo = self._build_overlay_id_combo(str(params.get("id", "") or ""))
            self._param_widgets["id"] = id_combo
            self._params_layout.addRow("id", id_combo)
            img_row = CutsceneImagePathRow(self._ctx_model, str(params.get("image", "") or ""), self)
            img_row.changed.connect(self.changed)
            self._param_widgets["image"] = img_row
            self._params_layout.addRow("image", img_row)

            def _pct_spin(key: str, default: float) -> QDoubleSpinBox:
                sp = QDoubleSpinBox(self)
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

        if act_type == "setScenarioPhase":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel("叙事阶段（scenario / phase / status / outcome）", self)
            tip.setToolTip("数据来自 scenarios.json；切换 scenario 会刷新 phase。")
            self._params_layout.addRow(tip)
            m = self._ctx_model
            scen_ids = m.scenario_ids_ordered() if m else []
            scen_entries = [(s, s) for s in scen_ids] or [
                ("（请在 data/scenarios.json 添加 scenario）", ""),
            ]
            sid_combo = FilterableTypeCombo(scen_entries, self, select_only=True)
            cur_sid = str(params.get("scenarioId") or "").strip()
            if cur_sid:
                sid_combo.set_committed_type(cur_sid)
            elif scen_ids:
                sid_combo.set_committed_type(scen_ids[0])
            self._param_widgets["scenarioId"] = sid_combo
            self._params_layout.addRow("scenarioId", sid_combo)

            phase_combo = QComboBox(self)
            # 非 editable：避免构造时创建 QComboBoxPrivateContainer 顶层 HWND 闪烁；
            # 未知 phase（旧数据）会以 "(缺失) xxx" 条目形式保留。
            phase_combo.setEditable(False)

            def refill_phases(*, use_saved_phase: bool) -> None:
                sid = sid_combo.committed_type()
                ph_list = m.phases_for_scenario(sid) if m and sid else []
                saved = str(params.get("phase") or "").strip()
                prev = phase_combo.currentText().strip()
                prefer = saved if use_saved_phase else prev
                phase_combo.blockSignals(True)
                phase_combo.clear()
                for p in ph_list:
                    phase_combo.addItem(p)
                if prefer in ph_list:
                    pick = prefer
                elif ph_list:
                    pick = ph_list[0]
                else:
                    pick = prefer
                if pick and phase_combo.findText(pick) < 0:
                    phase_combo.addItem(pick)
                if pick:
                    i = phase_combo.findText(pick)
                    if i >= 0:
                        phase_combo.setCurrentIndex(i)
                    else:
                        phase_combo.setEditText(pick)
                phase_combo.blockSignals(False)

            refill_phases(use_saved_phase=True)

            def on_scenario_changed(_t: str = "") -> None:
                refill_phases(use_saved_phase=False)
                self.changed.emit()

            sid_combo.typeCommitted.connect(on_scenario_changed)
            phase_combo.currentIndexChanged.connect(lambda _i: self.changed.emit())
            self._param_widgets["phase"] = phase_combo
            self._params_layout.addRow("phase", phase_combo)

            status_combo = QComboBox(self)
            status_combo.setEditable(False)
            for st in ("pending", "active", "done", "locked"):
                status_combo.addItem(st)
            st_val = str(params.get("status") or "pending").strip() or "pending"
            i = status_combo.findText(st_val)
            if i >= 0:
                status_combo.setCurrentIndex(i)
            else:
                status_combo.addItem(f"(非枚举) {st_val}")
                status_combo.setCurrentIndex(status_combo.count() - 1)
            status_combo.currentIndexChanged.connect(lambda _i: self.changed.emit())
            self._param_widgets["status"] = status_combo
            self._params_layout.addRow("status", status_combo)

            out_ed = QLineEdit(str(params.get("outcome") or ""), self)
            out_ed.setPlaceholderText("可选")
            out_ed.textChanged.connect(self.changed)
            self._param_widgets["outcome"] = out_ed
            self._params_layout.addRow("outcome", out_ed)
            self._sync_foldable_visibility()
            return

        if act_type == "startScenario":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "仅校验 scenarios.json 中本条线的进线 requires；不写入 phase。"
                "未满足时与首次 setScenarioPhase 相同：抛出 ScenarioLineEntryRequiresError。"
                "可放在图入口的 runActions 最前。",
                self,
            )
            tip.setToolTip("与 setScenarioPhase 的进线检查一致，用于显式表达剧情起点。")
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            m = self._ctx_model
            scen_ids = m.scenario_ids_ordered() if m else []
            scen_entries = [(s, s) for s in scen_ids] or [
                ("（请在 data/scenarios.json 添加 scenario）", ""),
            ]
            sid_combo = FilterableTypeCombo(scen_entries, self, select_only=True)
            cur_sid = str(params.get("scenarioId") or "").strip()
            if cur_sid:
                sid_combo.set_committed_type(cur_sid)
            elif scen_ids:
                sid_combo.set_committed_type(scen_ids[0])
            sid_combo.typeCommitted.connect(lambda _t: self.changed.emit())
            self._param_widgets["scenarioId"] = sid_combo
            self._params_layout.addRow("scenarioId", sid_combo)
            self._sync_foldable_visibility()
            return

        if act_type == "revealDocument":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "documentId 须在 document_reveals.json 中注册；"
                "由 DocumentRevealManager 按 revealCondition 与叠图参数播放揭示。",
                self,
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            m = self._ctx_model
            doc_ids = m.document_reveal_ids() if m else []
            entries = [(i, i) for i in doc_ids] or [
                ("（请在 data/document_reveals.json 添加条目）", ""),
            ]
            doc_combo = FilterableTypeCombo(entries, self, select_only=True)
            cur_doc = str(params.get("documentId") or "").strip()
            if cur_doc:
                doc_combo.set_committed_type(cur_doc)
            elif doc_ids:
                doc_combo.set_committed_type(doc_ids[0])
            doc_combo.typeCommitted.connect(lambda _t: self.changed.emit())
            self._param_widgets["documentId"] = doc_combo
            self._params_layout.addRow("documentId", doc_combo)
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
                "delayMs 内 t=0；之后 durationMs 内 t 由 0 线性到 1；结束保留目标图。\n"
                "<b>迁移</b>：告示类清晰化优先用 revealDocument + document_reveals.json，"
                "避免在对话里手写 from/to 路径。",
                self,
            )
            tip.setWordWrap(True)
            tip.setTextFormat(Qt.TextFormat.RichText)
            self._params_layout.addRow(tip)
            id_combo = self._build_overlay_id_combo(str(params.get("id", "") or ""))
            self._param_widgets["id"] = id_combo
            self._params_layout.addRow("id", id_combo)
            from_row = CutsceneImagePathRow(self._ctx_model, str(params.get("fromImage", "") or ""), self)
            from_row.changed.connect(self.changed)
            self._param_widgets["fromImage"] = from_row
            self._params_layout.addRow("fromImage（起始图）", from_row)
            to_row = CutsceneImagePathRow(self._ctx_model, str(params.get("toImage", "") or ""), self)
            to_row.changed.connect(self.changed)
            self._param_widgets["toImage"] = to_row
            self._params_layout.addRow("toImage（目标图）", to_row)
            dur = QSpinBox(self)
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
            del_sp = QSpinBox(self)
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
                sp = QDoubleSpinBox(self)
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

            bprev = BlendOverlayPreviewWidget(self._ctx_model, self._blend_preview_params, self)
            self._params_layout.addRow("过渡预览（Qt 近似）", bprev)
            from_row.changed.connect(bprev.schedule_refresh)
            to_row.changed.connect(bprev.schedule_refresh)
            dur.valueChanged.connect(bprev.schedule_refresh)
            del_sp.valueChanged.connect(bprev.schedule_refresh)
            self._param_widgets["xPercent"].valueChanged.connect(bprev.schedule_refresh)
            self._param_widgets["yPercent"].valueChanged.connect(bprev.schedule_refresh)
            self._param_widgets["widthPercent"].valueChanged.connect(bprev.schedule_refresh)
            bprev.schedule_refresh_immediate()

            self._sync_foldable_visibility()
            return

        if act_type == "startDialogueGraph":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel("对话图入口", self)
            tip.setToolTip(
                "graphId 对应 dialogues/graphs 下 .json；entry 选节点 id；npcId 可选，用于说话人显示名。",
            )
            self._params_layout.addRow(tip)
            m = self._ctx_model
            gids = m.all_dialogue_graph_ids() if m else []
            g_entries = [(g, g) for g in gids] or [("（请添加对话图 JSON）", "")]
            gid_combo = FilterableTypeCombo(g_entries, self, select_only=True)
            cur_gid = str(params.get("graphId", "") or "").strip()
            if cur_gid:
                gid_combo.set_committed_type(cur_gid)
            elif gids:
                gid_combo.set_committed_type(gids[0])
            gid_combo.typeCommitted.connect(lambda _t: self.changed.emit())
            self._param_widgets["graphId"] = gid_combo
            self._params_layout.addRow("graphId", gid_combo)

            ent_combo = FilterableTypeCombo([], self, select_only=True)
            ent_combo.setToolTip("选图中 nodes 的键；留「（默认图 entry）」不写 params.entry。")

            def refill_entry_nodes(*, keep_saved: bool) -> None:
                gid = gid_combo.committed_type()
                nodes = m.dialogue_graph_node_ids(gid) if m and gid else []
                saved = str(params.get("entry", "") or "").strip()
                prev = ent_combo.committed_type()
                prefer = saved if keep_saved else prev
                rows: list[tuple[str, str]] = [("（默认图 entry）", "")]
                for nid in nodes:
                    rows.append((nid, nid))
                ent_combo.set_entries(rows)
                if prefer and prefer in nodes:
                    ent_combo.set_committed_type(prefer)
                elif prefer:
                    ent_combo.set_entries(
                        [(f"(数据) {prefer}", prefer)] + [x for x in rows if x[1] != prefer],
                    )
                    ent_combo.set_committed_type(prefer)
                else:
                    ent_combo.set_committed_type("")

            refill_entry_nodes(keep_saved=True)
            gid_combo.typeCommitted.connect(
                lambda _t: (refill_entry_nodes(keep_saved=False), self.changed.emit()),
            )
            ent_combo.typeCommitted.connect(lambda _t: self.changed.emit())
            self._param_widgets["entry"] = ent_combo
            self._params_layout.addRow("entry", ent_combo)

            nid = IdRefSelector(self, allow_empty=True)
            nid.setMinimumWidth(160)
            nid.set_items(npc_items_for_dialogue_picker(self._ctx_model, self._ctx_scene_id))
            nid.set_current(str(params.get("npcId", "") or ""))
            nid.value_changed.connect(self.changed)
            nid.setToolTip(
                "解析 {{npc}} 显示名用；有场景上下文时优先场景 NPC，否则列出全局 NPC。",
            )
            self._param_widgets["npcId"] = nid
            self._params_layout.addRow("npcId（可选）", nid)
            self._sync_foldable_visibility()
            return

        if act_type == "playScriptedDialogue":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel("台词上下文", self)
            tip.setToolTip(
                "speaker 支持在文本中插入 {{player}}、{{npc}}（用下方「台词用 NPC」作默认）、"
                "{{npc:某id}}；运行时解析为显示名。",
            )
            self._params_layout.addRow(tip)
            snpc = IdRefSelector(self, allow_empty=True)
            snpc.setMinimumWidth(160)
            snpc.set_items(npc_items_for_dialogue_picker(self._ctx_model, self._ctx_scene_id))
            snpc.set_current(str(params.get("scriptedNpcId", "") or ""))
            snpc.value_changed.connect(self.changed)
            snpc.setToolTip("供 speaker 中 {{npc}} 使用；图对话 runActions 时也可用图内 npcId。")
            self._param_widgets["scriptedNpcId"] = snpc
            self._params_layout.addRow("scriptedNpcId（{{npc}} 默认）", snpc)

            raw_lines = params.get("lines", [])
            ed = ScriptedLinesEditor(
                list(raw_lines) if isinstance(raw_lines, list) else [],
                self,
                model=self._ctx_model,
                scene_id=self._ctx_scene_id,
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
            tip = QLabel("玩家外观（资源）", self)
            tip.setToolTip(
                "animManifest 与 bundleId 二选一写入磁盘；保存时若 manifest 非空则优先 manifest。"
                "clip 映射从所选动画包 states 键选。",
            )
            self._params_layout.addRow(tip)

            m = self._ctx_model
            bid = IdRefSelector(self, allow_empty=True)
            bid.setMinimumWidth(112)
            bundles = (
                [(k, k) for k in sorted(m.animations.keys())]
                if m
                else []
            )
            bid.set_items(bundles)
            b_from_p = str(params.get("bundleId", "") or "").strip()
            am = str(params.get("animManifest", "") or "").strip()
            if not b_from_p and am:
                mm = _ANIM_MANIFEST_RE.match(am)
                if mm:
                    b_from_p = mm.group(1)
            bid.set_current(b_from_p)
            self._param_widgets["bundleId"] = bid
            self._params_layout.addRow("bundleId", bid)

            man_entries = m.anim_asset_path_choices() if m else []
            man_rows: list[tuple[str, str]] = [
                ("", "（留空：仅用 bundleId）"),
            ] + list(man_entries)
            man_combo = FilterableTypeCombo(man_rows, self, select_only=True)
            if am:
                man_combo.set_committed_type(am)
            else:
                man_combo.set_committed_type("")
            self._param_widgets["animManifest"] = man_combo
            self._params_layout.addRow("animManifest", man_combo)

            def _state_items_for_bundle(stem: str) -> list[tuple[str, str]]:
                rows: list[tuple[str, str]] = [("", "（留空=逻辑名）")]
                if not m or not stem:
                    return rows
                names = m.animation_state_names_for_manifest(f"/assets/animation/{stem}/anim.json")
                for s in names:
                    rows.append((s, s))
                return rows

            def _current_bundle_stem() -> str:
                b = bid.current_id().strip()
                if b:
                    return b
                mp = man_combo.committed_type().strip()
                mm = _ANIM_MANIFEST_RE.match(mp)
                return mm.group(1) if mm else ""

            clip_widgets: dict[str, FilterableTypeCombo] = {}

            def refill_clip_selectors(*, preserve: bool) -> None:
                stem = _current_bundle_stem()
                items = _state_items_for_bundle(stem)
                for logical in ("idle", "walk", "run"):
                    cw = clip_widgets.get(logical)
                    if not isinstance(cw, FilterableTypeCombo):
                        continue
                    prev = cw.committed_type() if preserve else str(sm.get(logical, "") or "").strip()
                    cw.set_entries(items)
                    if prev and prev in [x[1] for x in items]:
                        cw.set_committed_type(prev)
                    elif prev:
                        cw.set_entries([(f"(数据) {prev}", prev)] + [x for x in items if x[1] != prev])
                        cw.set_committed_type(prev)
                    else:
                        cw.set_committed_type("")

            for logical in ("idle", "walk", "run"):
                cw = FilterableTypeCombo([], self, select_only=True)
                clip_widgets[logical] = cw
                self._param_widgets[logical] = cw
                self._params_layout.addRow(f"clip:{logical}", cw)

            def on_bundle_changed(_v: str = "") -> None:
                stem = bid.current_id().strip()
                if stem and m:
                    path = f"/assets/animation/{stem}/anim.json"
                    man_combo.blockSignals(True)
                    man_combo.set_committed_type(path)
                    man_combo.blockSignals(False)
                refill_clip_selectors(preserve=True)
                self.changed.emit()

            def on_manifest_changed(_t: str = "") -> None:
                mp = man_combo.committed_type().strip()
                mm = _ANIM_MANIFEST_RE.match(mp)
                if mm and m:
                    stem = mm.group(1)
                    bid.blockSignals(True)
                    bid.set_current(stem)
                    bid.blockSignals(False)
                refill_clip_selectors(preserve=True)
                self.changed.emit()

            bid.value_changed.connect(on_bundle_changed)
            man_combo.typeCommitted.connect(on_manifest_changed)
            for logical in ("idle", "walk", "run"):
                clip_widgets[logical].typeCommitted.connect(lambda _t: self.changed.emit())

            refill_clip_selectors(preserve=False)
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
                w = QSpinBox(self)
                w.setRange(-999999, 999999)
                w.setValue(int(val) if val != "" else 0)
                w.valueChanged.connect(self.changed)
            elif ptype == "float":
                w = QDoubleSpinBox(self)
                w.setRange(-50.0, 50.0)
                w.setDecimals(4)
                w.setSingleStep(0.05)
                try:
                    w.setValue(float(val))
                except (TypeError, ValueError):
                    w.setValue(0.0)
                w.valueChanged.connect(self.changed)
            elif ptype == "bool":
                w = QCheckBox(self)
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
            elif act_type == "grantRuleLayer" and pname == "ruleId":
                w = self._make_selector("rule", str(val) if val is not None else "")
            elif act_type == "grantRuleLayer" and pname == "layer":
                w = QComboBox(self)
                w.addItems(["xiang", "li", "shu"])
                tv = str(val) if val else "xiang"
                i = w.findText(tv)
                w.setCurrentIndex(i if i >= 0 else 0)
                w.currentTextChanged.connect(self.changed)
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
                w = QComboBox(self)
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
                w = QComboBox(self)
                # 非 editable：notification type 是固定枚举，不需要手写；同时避免 HWND 闪烁。
                w.setEditable(False)
                w.addItems(list(_NOTIFICATION_TYPES))
                tv = str(val) if val is not None else "info"
                i = w.findText(tv)
                if i >= 0:
                    w.setCurrentIndex(i)
                else:
                    w.addItem(f"(非枚举) {tv}")
                    w.setCurrentIndex(w.count() - 1)
                w.currentIndexChanged.connect(lambda _i: self.changed.emit())
            elif act_type == "showEmote" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
                w.setToolTip(
                    "选 NPC id 或 player；列表来自当前 Action 场景上下文，过场请先绑 targetScene。",
                )
            elif act_type == "showEmote" and pname == "emote":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "showEmoteAndWait" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
                w.setToolTip(
                    "选 NPC、player 或过场 _cut_*；依赖过场 targetScene 与_spawn 列表。",
                )
            elif act_type == "showEmoteAndWait" and pname == "emote":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "playNpcAnimation" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "playNpcAnimation" and pname == "state":
                w = FilterableTypeCombo([("", "（选 state）")], self, select_only=True)
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "setEntityEnabled" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type in ("stopNpcPatrol", "persistNpcDisablePatrol", "persistNpcEnablePatrol") and pname == "npcId":
                w = self._make_selector("npc_only", str(val) if val is not None else "")
            elif act_type in (
                "persistNpcEntityEnabled", "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation",
            ) and pname == "target":
                w = self._make_selector("npc_only", str(val) if val is not None else "")
            elif act_type in ("persistNpcAnimState", "persistPlayNpcAnimation") and pname == "state":
                w = FilterableTypeCombo([("", "（选 state）")], self, select_only=True)
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "hideOverlayImage" and pname == "id":
                w = self._build_overlay_id_combo(str(val) if val is not None else "")
            elif act_type == "moveEntityTo" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "faceEntity" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "faceEntity" and pname == "direction":
                dir_rows = [("", "（用 faceTarget）")] + [(d, d) for d in _FACE_DIRECTIONS]
                curd = str(val) if val is not None else ""
                w = FilterableTypeCombo(dir_rows, self, select_only=True)
                if curd in _FACE_DIRECTIONS:
                    w.set_committed_type(curd)
                elif curd:
                    w.set_entries([(f"(数据) {curd}", curd)] + dir_rows)
                    w.set_committed_type(curd)
                else:
                    w.set_committed_type("")
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "faceEntity" and pname == "faceTarget":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "cutsceneSpawnActor" and pname == "id":
                m = self._ctx_model
                rows = _cutscene_spawn_id_choices(m, self._ctx_cutscene_id)
                cur = str(val) if val is not None else ""
                w = FilterableTypeCombo(rows, self, select_only=True)
                if cur:
                    w.set_committed_type(cur)
                elif rows:
                    w.set_committed_type(rows[0][1])
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "cutsceneSpawnActor" and pname == "name":
                w = QLineEdit(str(val), self)
                w.setPlaceholderText("显示名，如 ???")
                w.textChanged.connect(self.changed)
            elif act_type == "cutsceneRemoveActor" and pname == "id":
                m = self._ctx_model
                rows = _cutscene_spawn_id_choices(m, self._ctx_cutscene_id)
                cur = str(val) if val is not None else ""
                w = FilterableTypeCombo(rows, self, select_only=True)
                if cur:
                    w.set_committed_type(cur)
                elif rows:
                    w.set_committed_type(rows[0][1])
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "waitClickContinue" and pname == "text":
                w = QLineEdit(str(val), self)
                w.setPlaceholderText("留空= strings actions.clickToContinue（默认「点击继续」）")
                w.textChanged.connect(lambda _t: self.changed.emit())
            else:
                w = QLineEdit(str(val), self)
                w.textChanged.connect(self.changed)
            self._param_widgets[pname] = w
            self._params_layout.addRow(pname, w)

        if act_type in ("switchScene", "changeScene"):
            self._connect_scene_spawn_pickers()
        if act_type == "addArchiveEntry":
            self._connect_archive_pickers()
        if act_type == "playNpcAnimation":
            self._connect_play_npc_animation_pickers(
                initial_state=str(params.get("state", "") or ""),
            )
        if act_type in ("persistNpcAnimState", "persistPlayNpcAnimation"):
            self._connect_persist_npc_anim_state_pickers(
                initial_state=str(params.get("state", "") or ""),
            )

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

    def _to_dict_set_hotspot_display_image(self) -> dict:
        scene_w = self._param_widgets.get("sceneId")
        id_w = self._param_widgets.get("hotspotId")
        img_w = self._param_widgets.get("image")
        sid = scene_w.committed_type().strip() if isinstance(scene_w, FilterableTypeCombo) else ""
        hid = id_w.committed_type().strip() if isinstance(id_w, FilterableTypeCombo) else ""
        pimg = img_w.path() if isinstance(img_w, CutsceneImagePathRow) else ""
        pr: dict = {"sceneId": sid, "hotspotId": hid, "image": pimg}
        ww = self._param_widgets.get("worldWidth")
        hh = self._param_widgets.get("worldHeight")
        if isinstance(ww, QDoubleSpinBox) and float(ww.value()) > 0:
            pr["worldWidth"] = float(ww.value())
        if isinstance(hh, QDoubleSpinBox) and float(hh.value()) > 0:
            pr["worldHeight"] = float(hh.value())
        fac_w = self._param_widgets.get("facing")
        if isinstance(fac_w, FilterableTypeCombo):
            fv = fac_w.committed_type().strip().lower()
            if fv in ("left", "right"):
                pr["facing"] = fv
        return {
            "type": "setHotspotDisplayImage",
            "params": pr,
        }

    def _to_dict_set_entity_field(self) -> dict:
        scene_w = self._param_widgets.get("sceneId")
        kind_w = self._param_widgets.get("entityKind")
        ent_w = self._param_widgets.get("entityId")
        field_w = self._param_widgets.get("fieldName")
        scene_id = scene_w.committed_type().strip() if isinstance(scene_w, FilterableTypeCombo) else ""
        kind = kind_w.committed_type().strip() if isinstance(kind_w, FilterableTypeCombo) else ""
        entity_id = ent_w.committed_type().strip() if isinstance(ent_w, FilterableTypeCombo) else ""
        field = field_w.committed_type().strip() if isinstance(field_w, FilterableTypeCombo) else ""
        meta = self._ctx_model.runtime_entity_field_meta(kind, field) if self._ctx_model else None
        value = None
        if meta and meta.get("kind") == "number":
            w = self._param_widgets.get("value")
            value = float(w.value()) if isinstance(w, QDoubleSpinBox) else 0.0
        elif meta and meta.get("kind") == "boolean":
            w = self._param_widgets.get("value")
            value = bool(w.isChecked()) if isinstance(w, QCheckBox) else False
        elif meta and meta.get("kind") == "object" and field == "displayImage":
            img = self._param_widgets.get("value.image")
            ww = self._param_widgets.get("value.worldWidth")
            hh = self._param_widgets.get("value.worldHeight")
            facing = self._param_widgets.get("value.facing")
            sort = self._param_widgets.get("value.spriteSort")
            value = {
                "image": img.path() if isinstance(img, CutsceneImagePathRow) else "",
                "worldWidth": float(ww.value()) if isinstance(ww, QDoubleSpinBox) else 100.0,
                "worldHeight": float(hh.value()) if isinstance(hh, QDoubleSpinBox) else 100.0,
            }
            fv = facing.committed_type().strip() if isinstance(facing, FilterableTypeCombo) else ""
            sv = sort.committed_type().strip() if isinstance(sort, FilterableTypeCombo) else ""
            if fv:
                value["facing"] = fv
            if sv:
                value["spriteSort"] = sv
        else:
            w = self._param_widgets.get("value")
            if isinstance(w, FilterableTypeCombo):
                value = w.committed_type().strip()
            elif isinstance(w, QLineEdit):
                value = w.text().strip()
            else:
                value = ""
        return {
            "type": "setEntityField",
            "params": {
                "sceneId": scene_id,
                "entityKind": kind,
                "entityId": entity_id,
                "fieldName": field,
                "value": value,
            },
        }

    def _to_dict_show_overlay_image(self) -> dict:
        id_w = self._param_widgets.get("id")
        img_w = self._param_widgets.get("image")
        x_w = self._param_widgets.get("xPercent")
        y_w = self._param_widgets.get("yPercent")
        w_w = self._param_widgets.get("widthPercent")
        pid = _read_overlay_id_value(id_w)
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
        pid = _read_overlay_id_value(id_w)
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
        graph_id = (
            gid_w.committed_type().strip()
            if isinstance(gid_w, FilterableTypeCombo)
            else ""
        )
        prm: dict = {"graphId": graph_id}
        ent = (
            ent_w.committed_type().strip()
            if isinstance(ent_w, FilterableTypeCombo)
            else ""
        )
        if ent:
            prm["entry"] = ent
        nid = nid_w.current_id().strip() if isinstance(nid_w, IdRefSelector) else ""
        if nid:
            prm["npcId"] = nid
        return {"type": "startDialogueGraph", "params": prm}

    def _to_dict_play_scripted_dialogue(self) -> dict:
        ed = self._delayed_editor
        lines = ed.to_list() if isinstance(ed, ScriptedLinesEditor) else []
        snpc_w = self._param_widgets.get("scriptedNpcId")
        sid = snpc_w.current_id().strip() if isinstance(snpc_w, IdRefSelector) else ""
        prm: dict = {"lines": lines}
        if sid:
            prm["scriptedNpcId"] = sid
        return {"type": "playScriptedDialogue", "params": prm}

    def _to_dict_set_player_avatar(self) -> dict:
        man_w = self._param_widgets.get("animManifest")
        bid_w = self._param_widgets.get("bundleId")
        man = (
            man_w.committed_type().strip()
            if isinstance(man_w, FilterableTypeCombo)
            else ""
        )
        bid = bid_w.current_id().strip() if isinstance(bid_w, IdRefSelector) else ""
        params: dict = {}
        if man:
            params["animManifest"] = man
        elif bid:
            params["bundleId"] = bid
        sm: dict = {}
        for logical in ("idle", "walk", "run"):
            w = self._param_widgets.get(logical)
            if isinstance(w, FilterableTypeCombo):
                t = w.committed_type().strip()
            elif isinstance(w, QLineEdit):
                t = w.text().strip()
            else:
                continue
            if t:
                sm[logical] = t
        if sm:
            params["stateMap"] = sm
        return {"type": "setPlayerAvatar", "params": params}

    def _to_dict_set_scenario_phase(self) -> dict:
        sid_w = self._param_widgets.get("scenarioId")
        ph_w = self._param_widgets.get("phase")
        st_w = self._param_widgets.get("status")
        out_w = self._param_widgets.get("outcome")
        sid = sid_w.committed_type() if isinstance(sid_w, FilterableTypeCombo) else ""
        ph = ph_w.currentText().strip() if isinstance(ph_w, QComboBox) else ""
        st = st_w.currentText().strip() if isinstance(st_w, QComboBox) else ""
        out_raw = out_w.text().strip() if isinstance(out_w, QLineEdit) else ""
        pr: dict = {"scenarioId": sid, "phase": ph, "status": st}
        if out_raw:
            try:
                pr["outcome"] = json.loads(out_raw)
            except json.JSONDecodeError:
                try:
                    pr["outcome"] = int(out_raw)
                except ValueError:
                    low = out_raw.lower()
                    if low == "true":
                        pr["outcome"] = True
                    elif low == "false":
                        pr["outcome"] = False
                    else:
                        try:
                            pr["outcome"] = float(out_raw)
                        except ValueError:
                            pr["outcome"] = out_raw
        return {"type": "setScenarioPhase", "params": pr}

    def _to_dict_reveal_document(self) -> dict:
        w = self._param_widgets.get("documentId")
        did = w.committed_type() if isinstance(w, FilterableTypeCombo) else ""
        return {"type": "revealDocument", "params": {"documentId": did}}

    def to_dict(self) -> dict:
        act_type = self.type_combo.committed_type()
        if act_type == "setEntityField":
            return self._to_dict_set_entity_field()
        if act_type == "setHotspotDisplayImage":
            return self._to_dict_set_hotspot_display_image()
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
        if act_type == "setScenarioPhase":
            return self._to_dict_set_scenario_phase()
        if act_type == "startScenario":
            sid_w = self._param_widgets.get("scenarioId")
            sid0 = sid_w.committed_type() if isinstance(sid_w, FilterableTypeCombo) else ""
            return {"type": "startScenario", "params": {"scenarioId": sid0}}
        if act_type == "revealDocument":
            return self._to_dict_reveal_document()
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
            elif isinstance(w, EmoteBubbleParamWidget):
                params[pname] = w.emote_text()
            elif isinstance(w, FilterableTypeCombo):
                params[pname] = w.committed_type()
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
        self._ctx_cutscene_id: str | None = None
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

    def set_project_context(
        self,
        model,
        scene_id: str | None = None,
        *,
        cutscene_id: str | None = None,
    ) -> None:
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        if cutscene_id is not None:
            self._ctx_cutscene_id = cutscene_id or None
        for r in self._rows:
            r.set_project_context(model, scene_id, cutscene_id=self._ctx_cutscene_id)

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
        # 禁止主动 _dismiss_active_popup_stack / processEvents / sendPostedEvents：
        # 这些组合会显式化 QComboBoxPrivateContainer 的 HWND 生命周期，在 Windows 上造成闪烁。

    def _add_row(self, data: dict | None = None) -> None:
        # parent=self：让 ActionRow 从构造的第一刻起就不是无 parent 的 top-level，
        # 避免 Windows 上 QWidget 作为 top-level 短暂 create HWND 引发任务栏闪现。
        row = ActionRow(
            data,
            parent=self,
            model=self._ctx_model,
            scene_id=self._ctx_scene_id,
            show_reorder_buttons=self._show_reorder_buttons,
            cutscene_id=self._ctx_cutscene_id,
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