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
import math
import re
from copy import deepcopy
from typing import Callable

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QSpinBox, QDoubleSpinBox, QCheckBox, QFormLayout, QFrame, QGroupBox,
    QTextEdit, QApplication, QToolButton, QDialog, QListWidget, QListWidgetItem,
    QDialogButtonBox, QSizePolicy, QInputDialog, QAbstractSpinBox, QMessageBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QAbstractItemView,
)

from PySide6.QtCore import Qt, QTimer, Signal, QSize
from PySide6.QtGui import QWheelEvent

from .rich_text_field import RichTextLineEdit, RichTextTextEdit

# Qt6: ItemDataRole.UserRole
_USER_ROLE = Qt.ItemDataRole.UserRole

_ANIM_MANIFEST_RE = re.compile(r"^/resources/runtime/animation/([^/]+)/anim\.json$")


def _hide_combo_popups_under(widget: QWidget) -> None:
    for cb in widget.findChildren(QComboBox):
        cb.hidePopup()


# 以下四个函数为历史兜底（曾用于手动清理偶发残留的 QComboBoxPrivateContainer）。
# 按 Qt 官方立场（https://forum.qt.io/topic/132029），QComboBoxPrivateContainer 是 editable QComboBox
# 的内部顶层容器，应该「just ignore it」；主动 close/deleteLater 反而会增加顶层小窗闪烁风险。
# 任何新代码禁止在 rebuild 路径中调用这些函数。
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
from .portrait_catalog import load_portrait_sets
from .id_ref_selector import IdRefSelector
from .audio_preview_selector import AudioIdPreviewSelector
from .blend_overlay_preview import BlendOverlayPreviewWidget
from .collapsible_section import CollapsibleSection
from .dialog_geometry import remember_dialog_geometry
from .form_layout import compact_form
from .image_path_picker import CutsceneImagePathRow
from .cutscene_dialogue_speaker_row import npc_items_for_dialogue_picker
from .scripted_lines_editor import ScriptedLinesEditor
from .runtime_field_schema import entity_kind_choices, field_meta
from .numeric_roundtrip import preserve_numeric_repr

# 这些参数在 schema 里恒会被写出，但语义上"缺省即未设"。当某键原本不在数据里、且当前值
# 等于其中性默认时，剔除它——避免编辑器"打开即保存"凭空添加 direction:""/anchorOffset:0。
# 仅作用于"原本就没有该键"的情形；用户显式设过（原数据里有）的一律保留。
_OMIT_WHEN_ABSENT_AND_DEFAULT: dict[str, object] = {
    "direction": "",
    "anchorOffsetX": 0.0,
    "anchorOffsetY": 0.0,
    # emitNarrativeSignal 的 sourceType/sourceId 为可选；schema 总会建出空控件，
    # 原数据没有且仍为空时剔除，避免「打开即注入空 sourceId/sourceType」。
    "sourceType": "",
    "sourceId": "",
    # 以下均为"缺省即未设"的可选键：原本没有且仍为中性默认时不写出
    #（chooseAction prompt/allowCancel、waitClickContinue text、faceEntity faceTarget、
    #  pickup isCurrency、blendOverlayImage delayMs）。
    "prompt": "",
    "allowCancel": False,
    "text": "",
    "faceTarget": "",
    "isCurrency": False,
    "delayMs": 0.0,
    # switchScene/changeScene 缺省出生点 = 默认 spawn；缺省 key（setFlag/addFlagValue 未填）同理
    "targetSpawnPoint": "",
    "key": "",
    "itemName": "",
    # setSmell 的方位/明灭为可选：原数据没有且仍为中性默认时不写出
    #（否则含 setSmell 的条目"打开即注入" dir:0.0/flicker:false）
    "dir": 0.0,
    "flicker": False,
    # giveItem critical（关键给予绕过槽上限）为可选：原本没有且未勾选时不写出
    "critical": False,
    # playNpcAnimation 可选播放参数（reverse 倒放 / thenState 播完自动切换）：
    # 原本没有且仍为中性默认时不写出（speed/holdFrame 走 _ACTION_PARAM_RUNTIME_DEFAULTS）
    "reverse": False,
    "thenState": "",
    # enableRuleOffers.slots / chooseAction.options：原本没有该键且列表仍为空时不写出，
    # 配合"载入空列表不再自动注入空行"，保证 slots:[] / options:[] 与缺键两种旧形状均往返不漂移。
    "slots": [],
    "options": [],
}

def _coerce_bool_param(val: object) -> bool:
    """bool 参数控件初始化：字符串 "false"/"0"/"no"/"off"（大小写不敏感）解析为 False，
    与运行时字符串语义一致；绝不能 bool("false")→True 造成保存后行为静默翻转。"""
    if isinstance(val, str):
        return val.strip().lower() not in ("", "false", "0", "no", "off")
    return bool(val)


# 这些 action 的 int 参数运行时有**非零**默认（见 src/core/ActionRegistry.ts 的 `?? N`），但编辑器
# 泛型 int 控件一律默认 0。若不处理，缺该键的数据"打开即保存"会被写成 0——不只是格式漂移，更会
# **改变行为**（giveItem count:0=不给物品、fadeMs:0=瞬切、durationMs:0=瞬变）。
# 修法（与 present 默认值一致）：按运行时默认 seed 控件 + 原本缺该键且仍为该默认时不回写。
# 键为 (action_type, param)，因同名 fadeMs 在不同 action 默认值不同（1000 vs 500）。
# 注：blendOverlayImage.durationMs 由其专属构造器自行 seed 600，这里仅登记以便往返剔除。
_ACTION_PARAM_RUNTIME_DEFAULTS: dict[tuple[str, str], int] = {
    ("giveItem", "count"): 1,
    ("removeItem", "count"): 1,
    ("pickup", "count"): 1,
    ("playBgm", "fadeMs"): 1000,
    ("stopBgm", "fadeMs"): 1000,
    ("stopSceneAmbient", "fadeMs"): 500,
    ("fadingZoom", "durationMs"): 600,
    ("fadingRestoreSceneCameraZoom", "durationMs"): 600,
    ("fadeWorldToBlack", "durationMs"): 600,
    ("fadeWorldFromBlack", "durationMs"): 600,
    ("waitMs", "durationMs"): 600,
    ("blendOverlayImage", "durationMs"): 600,
    # showEmote/showSpeechBubble(AndWait) duration ?? 1500（ActionRegistry.ts:635/668）
    ("showEmote", "duration"): 1500,
    ("showEmoteAndWait", "duration"): 1500,
    ("showSpeechBubble", "duration"): 1500,
    ("showSpeechBubbleAndWait", "duration"): 1500,
    # moveEntityTo speed ?? 80
    ("moveEntityTo", "speed"): 80,
    # moveGroupBy speed 缺省=0（瞬移分支）；登记后"未填 speed"打开保存不注入键（审查 P1-1）
    ("moveGroupBy", "speed"): 0,
    # sugarWheelShowSpeech durationMs 缺省=实例 speechDurationMs（兜底 3000）：
    # seed 3000 防"打开即写 0→被 Math.max 钳成 500ms"；缺键且仍 3000 时不写出。
    ("sugarWheelShowSpeech", "durationMs"): 3000,
    # setSmell intensity 缺省 60（SmellSystem.ts:23）
    ("setSmell", "intensity"): 60,
    # playNpcAnimation 可选播放参数：speed 倍率缺省 1（原速）；holdFrame 定格帧缺省 -1
    #（-1=不定格，0 是合法帧号所以不能用 0 当哨兵）。缺键且仍为缺省时不回写。
    # 注：speed 是 float 控件（seed 在 float 分支特判硬编码 1.0），此处登记只用于往返剔除
    #（1.0 == 1 成立）；holdFrame 的 seed 与剔除都由本表驱动。
    ("playNpcAnimation", "speed"): 1,
    ("playNpcAnimation", "holdFrame"): -1,
}

ACTION_TYPES = [
    "runActions", "chooseAction", "randomBranch",
    "setFlag", "setScenarioPhase", "startScenario", "activateScenario", "completeScenario", "emitNarrativeSignal", "setNarrativeState",
    "startNarrativeRun", "resetNarrativeRun", "revertNarrativeRun", "activateNarrativeRun",
    "appendFlag", "giveItem", "removeItem", "giveCurrency", "removeCurrency",
    "giveRule", "grantRuleLayer", "giveFragment", "updateQuest", "startEncounter",
    "playBgm", "stopBgm", "playSfx", "stopSceneAmbient", "endDay", "addDelayedEvent",
    "addArchiveEntry", "startCutscene", "startWaterMinigame", "startSugarWheelMinigame", "startPaperCraftMinigame",
    "startPressureHold", "playSignalCue", "addFlagValue",
    "damagePlayer", "healPlayer", "resetHealth", "setHealth", "incHealth", "decHealth", "triggerDeathTether",
    "setSmell", "clearSmell", "sniff",
    "activatePlane", "deactivatePlane",
    "sugarWheelShowSpeech", "sugarWheelDismissSpeech", "sugarWheelDismissAllSpeech",
    "sugarWheelResetPointer",
    "debugAlertActionParams",
    "showEmote", "showSpeechBubble", "playNpcAnimation", "setEntityEnabled", "openShop",
    "pickup", "switchScene", "changeScene", "showNotification", "stopNpcPatrol",
    "persistNpcDisablePatrol", "persistNpcEnablePatrol", "persistNpcEntityEnabled",
    "persistHotspotEnabled", "setZoneEnabled", "persistZoneEnabled", "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation",
    "shopPurchase", "inventoryDiscard",
    "setPlayerAvatar", "resetPlayerAvatar",
    "setSceneDepthFloorOffset", "resetSceneDepthFloorOffset",
    "setCameraZoom", "restoreSceneCameraZoom",
    "fadingZoom", "fadingRestoreSceneCameraZoom",
    "fadeWorldToBlack", "fadeWorldFromBlack",
    "hideOverlayImage", "playScriptedDialogue", "showOverlayImage", "setHotspotDisplayImage",
    "tempSetHotspotDisplayFacing", "setEntityField", "setSceneEntityPosition", "blendOverlayImage",
    "revealDocument", "startDialogueGraph",
    "waitClickContinue",
    "waitMs",
    "enableRuleOffers", "disableRuleOffers",
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor", "showEmoteAndWait", "showSpeechBubbleAndWait",
    "setGroupEnabled", "moveGroupBy",
]

DEBUG_ONLY_ACTION_TYPES = {"setNarrativeState"}
# Legacy：旧扣血/回血。新内容统一用 decHealth/incHealth（编排控值）+ triggerDeathTether（系绳）。
# 仍保留在 ACTION_TYPES（兼容历史数据、校验通过、运行时可用），但从编辑器内容下拉中移除。
LEGACY_ACTION_TYPES = {"damagePlayer", "healPlayer"}
CONTENT_ACTION_TYPES = [t for t in ACTION_TYPES if t not in DEBUG_ONLY_ACTION_TYPES and t not in LEGACY_ACTION_TYPES]

# _make_selector 的 kind → schema_build.CONTENT_ID_PARAMS 宇宙名。
# 用途：为每个 id 引用参数所建的选择器打上"这是哪个内容宇宙的选择器"标记
# （widget._content_id_universe），供 test_shared_widget_selectors 做「宇宙级」parity——
# 断言 giveItem.id 建出的确是 items 选择器，而不仅仅是"某个非裸 QLineEdit 选择器"。
# 新增 _make_selector kind 且用于某内容 id 参数时，必须在此登记对应宇宙（parity 测试会拦）。
_SELECTOR_KIND_UNIVERSE: dict[str, str] = {
    "item": "items",
    "rule": "rules",
    "fragment": "fragments",
    "quest": "quests",
    "encounter": "encounters",
    "cutscene": "cutscenes",
    "shop": "shops",
    "audio_bgm": "bgm",
    "audio_sfx": "sfx",
    "audio_ambient": "ambient",
    "smell": "smells",
    "plane": "planes",
    "water_minigame": "water_minigames",
    "sugar_wheel_minigame": "sugar_wheel_minigames",
    "paper_craft_minigame": "paper_craft_minigames",
    "pressure_hold": "pressure_holds",
    "signal_cue": "signal_cues",
    # 叙事活计生命周期（S1）：候选=声明 run 的活计图，宇宙沿用 narrative 条件叶的图 id 集合
    "narrative_run_archetype": "narrative_graph_ids",
}


def _tag_content_universe(widget, universe: str | None) -> None:
    """给 id 引用选择器打上其服务的内容宇宙标记（宇宙级 parity 用，见 _SELECTOR_KIND_UNIVERSE）。"""
    try:
        widget._content_id_universe = universe
    except (AttributeError, TypeError):
        pass

# 编辑器用：会改动存档/可持久化数据 vs 以运行时演出与瞬时状态为主（与实现细节若有出入以策划理解为准，见文档注释）。
# "save" = 常关联存档、任务、背包、flag、持久化 override 等；"memory" = 多为镜头、UI、过场、等待、切场景、音效等
ACTION_PERSISTENCE: dict[str, str] = {
    "runActions": "save",
    "chooseAction": "save",
    "randomBranch": "save",
    "setFlag": "save",
    "setScenarioPhase": "save",
    "startScenario": "save",
    "activateScenario": "save",
    "completeScenario": "save",
    "emitNarrativeSignal": "save",
    "setNarrativeState": "save",
    "startNarrativeRun": "save",
    "resetNarrativeRun": "save",
    "revertNarrativeRun": "save",
    "activateNarrativeRun": "save",
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
    "stopSceneAmbient": "memory",
    "endDay": "save",
    "addDelayedEvent": "save",
    "addArchiveEntry": "save",
    "startCutscene": "memory",
    "addFlagValue": "save",
    "startPressureHold": "memory",
    "playSignalCue": "memory",
    "damagePlayer": "save",
    "healPlayer": "save",
    "resetHealth": "save",
    "setHealth": "save",
    "incHealth": "save",
    "decHealth": "save",
    "triggerDeathTether": "save",
    "setSmell": "save",
    "clearSmell": "save",
    "sniff": "save",
    # 位面：激活位面从叙事状态重派生（PlaneReconciler 零持久化），不入存档
    "activatePlane": "memory",
    "deactivatePlane": "memory",
    "startWaterMinigame": "memory",
    "startSugarWheelMinigame": "memory",
    "startPaperCraftMinigame": "memory",
    "sugarWheelShowSpeech": "memory",
    "sugarWheelDismissSpeech": "memory",
    "sugarWheelDismissAllSpeech": "memory",
    "sugarWheelResetPointer": "memory",
    "debugAlertActionParams": "memory",
    "showEmote": "memory",
    "showSpeechBubble": "memory",
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
    "persistHotspotEnabled": "save",
    "setZoneEnabled": "memory",
    "persistZoneEnabled": "save",
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
    "tempSetHotspotDisplayFacing": "memory",
    "setEntityField": "save",
    "setSceneEntityPosition": "save",
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
    "showSpeechBubbleAndWait": "memory",
    "setGroupEnabled": "memory",
    "moveGroupBy": "memory",
}

ACTION_SAVE_DOT_TOOLTIP = (
    "该 Action 会修改或影响已持久化数据（如 flag、任务、背包、档案、可存档实体覆盖等）。"
    "与「仅演出/过场/瞬时显隐」类动作相区分，具体以运行与数据校验为准。"
)


def action_type_writes_save(type_id: str) -> bool:
    return ACTION_PERSISTENCE.get(type_id) == "save"


def _action_type_orphan_label(type_id: str) -> str:
    if type_id in DEBUG_ONLY_ACTION_TYPES:
        return f"{type_id}  [仅调试/修复：普通内容不可新建]"
    return type_id


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
    "runActions": [],
    "chooseAction": [("prompt", "str"), ("allowCancel", "bool")],
    "randomBranch": [],
    "setFlag": [("key", "str"), ("value", "flag_val")],
    "emitNarrativeSignal": [("signal", "str"), ("sourceType", "str"), ("sourceId", "str")],
    "setNarrativeState": [("graphId", "str"), ("stateId", "str")],
    # 叙事活计生命周期（S1）：graphId=活计图；revert 的 stateId=回退目标状态（S2 升级为该图状态选择器）。
    "startNarrativeRun": [("graphId", "str")],
    "resetNarrativeRun": [("graphId", "str")],
    "revertNarrativeRun": [("graphId", "str"), ("stateId", "str")],
    "activateNarrativeRun": [("graphId", "str")],
    "appendFlag": [("key", "str"), ("text", "str")],
    "addFlagValue": [("key", "str"), ("delta", "float")],
    "startPressureHold": [("id", "str")],
    "playSignalCue": [("id", "str")],
    "damagePlayer": [("amount", "int")],
    "healPlayer": [("amount", "int")],
    "resetHealth": [],
    "setHealth": [("amount", "int")],
    "incHealth": [("amount", "int")],
    "decHealth": [("amount", "int")],
    "triggerDeathTether": [],
    "setSmell": [("scent", "str"), ("intensity", "int"), ("dir", "float"), ("flicker", "bool")],
    "clearSmell": [],
    "sniff": [],
    "activatePlane": [("id", "str")],
    "deactivatePlane": [],
    "giveItem": [("id", "str"), ("count", "int"), ("critical", "bool")],
    "removeItem": [("id", "str"), ("count", "int")],
    "giveCurrency": [("amount", "int")],
    "removeCurrency": [("amount", "str")],
    "giveRule": [("id", "str")],
    "grantRuleLayer": [("ruleId", "str"), ("layer", "str")],
    "giveFragment": [("id", "str")],
    "updateQuest": [("id", "str")],
    "startEncounter": [("id", "str")],
    "playBgm": [("id", "str"), ("fadeMs", "int")],
    "stopBgm": [("fadeMs", "int")],
    "playSfx": [("id", "str")],
    "stopSceneAmbient": [("id", "str"), ("fadeMs", "int")],
    "endDay": [],
    "addArchiveEntry": [("bookType", "str"), ("entryId", "str")],
    "startCutscene": [("id", "str")],
    "startWaterMinigame": [("id", "str")],
    "startSugarWheelMinigame": [("id", "str")],
    "startPaperCraftMinigame": [("id", "str")],
    "sugarWheelShowSpeech": [("role", "str"), ("text", "str"), ("durationMs", "int")],
    "sugarWheelDismissSpeech": [("role", "str")],
    "sugarWheelDismissAllSpeech": [],
    "sugarWheelResetPointer": [("angleDeg", "float")],
    "debugAlertActionParams": [("title", "str")],
    "showEmote": [
        ("target", "str"),
        ("emote", "str"),
        ("duration", "float"),
        ("anchorOffsetX", "float"),
        ("anchorOffsetY", "float"),
    ],
    "showSpeechBubble": [
        ("target", "str"),
        ("text", "str"),
        ("duration", "float"),
        ("anchorOffsetX", "float"),
        ("anchorOffsetY", "float"),
    ],
    "playNpcAnimation": [
        ("target", "str"),
        ("state", "str"),
        ("speed", "float"),
        ("reverse", "bool"),
        ("holdFrame", "int"),
        ("thenState", "str"),
    ],
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
    "moveEntityTo": [
        ("target", "str"),
        ("sceneId", "str"),
        ("x", "float"),
        ("y", "float"),
        ("speed", "float"),
        ("moveAnimState", "str"),
        ("faceTowardMovement", "bool"),
    ],
    "faceEntity": [("target", "str"), ("direction", "str"), ("faceTarget", "str")],
    "cutsceneSpawnActor": [("id", "str"), ("name", "str"), ("x", "float"), ("y", "float")],
    "cutsceneRemoveActor": [("id", "str")],
    "showEmoteAndWait": [
        ("target", "str"),
        ("emote", "str"),
        ("duration", "float"),
        ("anchorOffsetX", "float"),
        ("anchorOffsetY", "float"),
    ],
    "showSpeechBubbleAndWait": [
        ("target", "str"),
        ("text", "str"),
        ("duration", "float"),
        ("anchorOffsetX", "float"),
        ("anchorOffsetY", "float"),
    ],
    # 分组批量：group 是纯标签（非实体 id 引用，勿登记 ENTITY_REF_PARAMS）；
    # 组存在性 validator 检查暂缺（已知限制，见设计稿第八节 4），主创作路径是实体树指派。
    "setGroupEnabled": [("group", "str"), ("enabled", "bool")],
    "moveGroupBy": [
        ("group", "str"),
        ("dx", "float"),
        ("dy", "float"),
        ("speed", "float"),
    ],
}

_NOTIFICATION_TYPES = ("info", "warning", "quest", "rule", "item")
_ARCHIVE_BOOK_TYPES = ("character", "lore", "document", "book", "bookEntry")

_FACE_DIRECTIONS = ("left", "right", "up", "down")

# showEmote / showEmoteAndWait / showSpeechBubble*：运行时仅为气泡 Text；编辑器侧对白类用 text 字段与快捷占位。
_EMOTE_QUICK_PRESETS = ("?", "!", "!!", "...", "…")
# 可选字幕旁表情：下拉「(无)」条目的内部取值（勿用作真实气泡文案）。
_EMOTE_OPTION_NONE = "__subtitle_emote_none__"


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


def _refill_scoped_combo_preserve(
    combo: "FilterableTypeCombo",
    rows: list[tuple[str, str]],
) -> None:
    """按父项刷新 select_only 子选择器候选，且**保留当前值**：

    旧 hotspotId/zoneId 不在新场景候选时以「(数据) 」前缀注入保留，绝不静默顶替第一项。
    当前值为空时交由 FilterableTypeCombo 落到首个候选（占位或首项，与首帧构造一致）。
    """
    cur = combo.committed_type()
    values = {v for _d, v in rows}
    if cur and cur not in values:
        rows = [(f"(数据) {cur}", cur), *rows]
    combo.set_entries(rows)
    combo.set_committed_type(cur)


class EmoteBubbleParamWidget(QWidget):
    """气泡 emote：必选下拉 + 快捷「插入」占位 +「其他…」对话框；禁止当纯手输框用。"""

    def __init__(
        self,
        parent: QWidget | None,
        model,
        committed: str,
        on_change: Callable[[], None],
        *,
        include_empty_choice: bool = False,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._on_change = on_change
        self._include_empty_choice = include_empty_choice

        cur = str(committed if committed is not None else "").strip()
        scan = cur if cur else "?"
        rows = self._full_entry_rows(scan)
        if self._include_empty_choice and not cur:
            pick = _EMOTE_OPTION_NONE
        else:
            pick = cur or (rows[0][1] if rows else "?")
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

    def _full_entry_rows(self, scan_hint: str) -> list[tuple[str, str]]:
        base = _build_emote_action_combo_entries(self._model, scan_hint)
        if self._include_empty_choice:
            return [("(无)", _EMOTE_OPTION_NONE)] + base
        return base

    def _apply_quick(self, segment: str) -> None:
        rows = self._full_entry_rows(segment)
        self._combo.set_entries(rows)
        self._combo.set_committed_type(segment)
        self._on_change()

    def _on_custom_text(self) -> None:
        cur = self._combo.committed_type().strip()
        if cur == _EMOTE_OPTION_NONE:
            cur = ""
        txt, ok = QInputDialog.getText(self, "气泡文案", "输入气泡内显示文字：", text=cur)
        if not ok:
            return
        t = txt.strip()
        if not t:
            return
        rows = self._full_entry_rows(t)
        self._combo.set_entries(rows)
        self._combo.set_committed_type(t)
        self._on_change()

    def emote_text(self) -> str:
        v = self._combo.committed_type().strip()
        if self._include_empty_choice and v == _EMOTE_OPTION_NONE:
            return ""
        return v


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


def _narrative_signal_rows_with_orphan(model, committed: str) -> list[tuple[str, str]]:
    """Registered narrative signals plus the saved value if it is currently orphaned."""
    cur = (committed or "").strip()
    rows = model.narrative_signal_rows() if model else []
    if not rows:
        rows = [("（narrative_graphs.signals 为空）", "")]
    if cur and all(v != cur for _, v in rows):
        return [(f"{cur} · 未在 signals 注册表登记", cur)] + rows
    return rows


def _iter_narrative_graphs_for_signals(data: dict):
    comps = data.get("compositions") if isinstance(data, dict) else []
    if not isinstance(comps, list):
        return
    for comp in comps:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id") or "").strip():
            yield main
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            graph = el.get("graph")
            if isinstance(graph, dict) and str(graph.get("id") or "").strip():
                yield graph


def _narrative_derived_signal_ids(data: dict) -> set[str]:
    out: set[str] = set()
    for graph in _iter_narrative_graphs_for_signals(data) or []:
        gid = str(graph.get("id") or "").strip()
        states = graph.get("states")
        if not gid or not isinstance(states, dict):
            continue
        for sid, raw in states.items():
            if isinstance(raw, dict) and bool(raw.get("broadcastOnEnter")):
                out.add(f"state:{gid}:{sid}")
    return out


def _narrative_listener_counts(data: dict) -> dict[str, int]:
    counts: dict[str, int] = {}
    for graph in _iter_narrative_graphs_for_signals(data) or []:
        for tr in graph.get("transitions") or []:
            if not isinstance(tr, dict):
                continue
            sig = str(tr.get("signal") or "").strip()
            if sig:
                counts[sig] = counts.get(sig, 0) + 1
    return counts


def _rename_narrative_signal_refs(data: dict, old_id: str, new_id: str) -> None:
    old = (old_id or "").strip()
    new = (new_id or "").strip()
    if not old or not new or old == new:
        return
    for graph in _iter_narrative_graphs_for_signals(data) or []:
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip() == old:
                tr["signal"] = new
    for comp in data.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            meta = el.get("meta")
            if not isinstance(meta, dict) or not isinstance(meta.get("emits"), list):
                continue
            meta["emits"] = [new if str(sig) == old else sig for sig in meta["emits"]]


def _validate_narrative_signals_for_manager(data: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    registered: set[str] = set()
    seen: set[str] = set()
    for idx, row in enumerate(data.get("signals") or []):
        if not isinstance(row, dict):
            warnings.append(f"signals[{idx}] 不是对象，将被保存流程规范化处理")
            continue
        sid = str(row.get("id") or "").strip()
        if not sid:
            errors.append(f"signals[{idx}].id 不能为空")
            continue
        if sid in seen:
            errors.append(f"信号 id 重复: {sid}")
        seen.add(sid)
        if sid == "__draft__" or sid.startswith("state:"):
            errors.append(f"作者信号 id 使用了保留/派生命名: {sid}")
        registered.add(sid)

    derived = _narrative_derived_signal_ids(data)
    listeners = _narrative_listener_counts(data)
    for graph in _iter_narrative_graphs_for_signals(data) or []:
        gid = str(graph.get("id") or "").strip()
        for tr in graph.get("transitions") or []:
            if not isinstance(tr, dict):
                continue
            trigger = str(tr.get("trigger") or "").strip()
            if trigger in ("reactive", "reactiveAll", "reactiveAny"):
                continue
            tid = str(tr.get("id") or "?")
            sig = str(tr.get("signal") or "").strip()
            if not sig:
                errors.append(f"Transition {gid}.{tid} 缺少 signal")
            elif sig == "__draft__":
                warnings.append(f"Transition {gid}.{tid} 仍在使用草稿信号 __draft__")
            elif sig.startswith("state:"):
                if sig not in derived:
                    errors.append(f"Transition {gid}.{tid} 监听了不存在或未广播的派生信号: {sig}")
            elif sig not in registered:
                errors.append(f"Transition {gid}.{tid} 监听了未登记信号: {sig}")

    for sid in sorted(registered):
        if listeners.get(sid, 0) == 0:
            warnings.append(f"信号 {sid} 当前没有 Transition 监听")
    return errors, warnings


class NarrativeSignalManagerDialog(QDialog):
    """Manage narrative author signals and select one for emitNarrativeSignal."""

    def __init__(self, model, current: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("叙事信号管理器")
        self.setMinimumSize(900, 620)
        self.resize(980, 680)
        self._model = model
        src = model.narrative_graphs if model and isinstance(model.narrative_graphs, dict) else {}
        self._data = json.loads(json.dumps(src, ensure_ascii=False))
        self._data.setdefault("signals", [])
        if not isinstance(self._data["signals"], list):
            self._data["signals"] = []
        self._selected = (current or "").strip()
        self._populating = False
        self._row_to_signal_index: dict[int, int] = {}

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)

        self._search = QLineEdit(self)
        self._search.setPlaceholderText("搜索信号 id / label / notes...")
        self._search.setClearButtonEnabled(True)
        self._search.textChanged.connect(lambda _t: self._rebuild_table())
        root.addWidget(self._search)

        self._table = QTableWidget(0, 4, self)
        self._table.setHorizontalHeaderLabels(["id", "label", "notes", "监听"])
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setAlternatingRowColors(True)
        hh = self._table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        hh.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        hh.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self._table.itemChanged.connect(self._on_item_changed)
        self._table.itemSelectionChanged.connect(self._on_selection_changed)
        self._table.itemDoubleClicked.connect(lambda _it: self._select_current())
        root.addWidget(self._table, 1)

        tools = QHBoxLayout()
        add_btn = QPushButton("新增", self)
        del_btn = QPushButton("删除", self)
        undo_btn = QPushButton("撤销重构", self)
        undo_btn.setToolTip(
            "撤销最近一次叙事重构（改 id / 删除的全项目级联）。\n"
            "与叙事编辑器共用同一撤销日志；只动暂存不落盘。"
        )
        self._select_btn = QPushButton("选用当前信号", self)
        validate_btn = QPushButton("校验", self)
        add_btn.clicked.connect(self._add_signal)
        del_btn.clicked.connect(self._delete_signal)
        undo_btn.clicked.connect(self._undo_refactor)
        self._select_btn.clicked.connect(self._select_current)
        validate_btn.clicked.connect(self._refresh_validation)
        tools.addWidget(add_btn)
        tools.addWidget(del_btn)
        tools.addWidget(undo_btn)
        tools.addStretch(1)
        tools.addWidget(validate_btn)
        tools.addWidget(self._select_btn)
        root.addLayout(tools)

        self._validation = QTextEdit(self)
        self._validation.setReadOnly(True)
        self._validation.setMinimumHeight(120)
        root.addWidget(self._validation)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        btns.accepted.connect(self._accept_without_select)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)

        self._rebuild_table()
        self._refresh_validation()

    def selected_signal(self) -> str:
        return self._selected

    def _signals(self) -> list[dict]:
        raw = self._data.setdefault("signals", [])
        if not isinstance(raw, list):
            raw = []
            self._data["signals"] = raw
        return raw

    def _current_signal_index(self) -> int | None:
        row = self._table.currentRow()
        if row < 0:
            return None
        return self._row_to_signal_index.get(row)

    def _matches_query(self, row: dict, query: str) -> bool:
        if not query:
            return True
        text = " ".join(
            str(row.get(k) or "")
            for k in ("id", "label", "notes", "description")
        ).lower()
        return query.lower() in text

    def _rebuild_table(self) -> None:
        query = self._search.text().strip()
        counts = _narrative_listener_counts(self._data)
        self._populating = True
        try:
            self._row_to_signal_index.clear()
            self._table.setRowCount(0)
            for sig_index, sig in enumerate(self._signals()):
                if not isinstance(sig, dict):
                    continue
                if not self._matches_query(sig, query):
                    continue
                r = self._table.rowCount()
                self._table.insertRow(r)
                self._row_to_signal_index[r] = sig_index
                sid = str(sig.get("id") or "")
                vals = [
                    sid,
                    str(sig.get("label") or ""),
                    str(sig.get("notes") or sig.get("description") or ""),
                    str(counts.get(sid.strip(), 0)),
                ]
                for c, val in enumerate(vals):
                    item = QTableWidgetItem(val)
                    if c == 3:
                        item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                    self._table.setItem(r, c, item)
                if sid.strip() == self._selected:
                    self._table.selectRow(r)
            if self._table.currentRow() < 0 and self._table.rowCount() > 0:
                self._table.selectRow(0)
        finally:
            self._populating = False
        self._on_selection_changed()

    def _on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._populating:
            return
        sig_index = self._row_to_signal_index.get(item.row())
        if sig_index is None:
            return
        signals = self._signals()
        if sig_index < 0 or sig_index >= len(signals) or not isinstance(signals[sig_index], dict):
            return
        row = signals[sig_index]
        old_id = str(row.get("id") or "").strip()
        text = item.text().strip()
        if item.column() == 0:
            if old_id and text and old_id != text:
                # 改 id 走全项目重构引擎（与叙事编辑器同一引擎/同一撤销日志），
                # 拒绝或失败时表格重建即还原显示（本地拷贝与模型均未变）。
                if not self._refactor_rename(old_id, text):
                    self._rebuild_table()
                    self._refresh_validation()
                    return
                if self._selected == old_id:
                    self._selected = text
            else:
                row["id"] = text
        elif item.column() == 1:
            if text:
                row["label"] = text
            else:
                row.pop("label", None)
        elif item.column() == 2:
            row.pop("description", None)
            if text:
                row["notes"] = text
            else:
                row.pop("notes", None)
        self._refresh_validation()
        if item.column() == 0:
            self._rebuild_table()

    def _on_selection_changed(self) -> None:
        idx = self._current_signal_index()
        self._select_btn.setEnabled(idx is not None)

    def _new_unique_signal_id(self) -> str:
        existing = {
            str(row.get("id") or "").strip()
            for row in self._signals()
            if isinstance(row, dict)
        }
        base = "new_signal"
        if base not in existing:
            return base
        i = 2
        while f"{base}_{i}" in existing:
            i += 1
        return f"{base}_{i}"

    def _add_signal(self) -> None:
        sid = self._new_unique_signal_id()
        self._signals().append({"id": sid, "label": sid})
        self._selected = sid
        self._search.setText("")
        self._rebuild_table()
        self._refresh_validation()

    def _delete_signal(self) -> None:
        idx = self._current_signal_index()
        if idx is None:
            return
        signals = self._signals()
        if idx < 0 or idx >= len(signals):
            return
        sid = str(signals[idx].get("id") or "").strip() if isinstance(signals[idx], dict) else ""
        if self._model is None or not sid:
            # 脱机/空 id 兜底：保持旧的本地拷贝行为
            if sid and _narrative_listener_counts(self._data).get(sid, 0) > 0:
                ok = QMessageBox.question(
                    self,
                    "删除信号",
                    f"信号 {sid!r} 正被 Transition 监听。删除后校验会报错，确定删除？",
                )
                if ok != QMessageBox.StandardButton.Yes:
                    return
            del signals[idx]
        else:
            # 走全项目重构引擎：有引用先列数目并确认强制清理（监听置草稿、发射动作移除）
            from .signal_refactor import SignalRefactorError, delete_signal, push_journal, scan_signal_usages

            if not self._stage_copy_to_model():
                return
            usages = scan_signal_usages(self._model, sid)
            refs = usages["totalRefs"]
            prompt = (
                f"删除信号 {sid!r}？共 {refs} 处引用将被强制清理：\n"
                f"监听 transition 置为草稿（__draft__），发射动作从对话/场景/资产中移除\n"
                f"（对话图 {len(usages['dialogues'])} 个、场景/资产 {len(usages['assets'])} 个条目）。\n\n"
                "改动只进暂存、不落盘（Save All 才写文件）；可经「撤销重构」精确复原，"
                "不随本对话框取消而回滚。"
                if refs
                else f"删除信号 {sid!r}（无引用，仅移除注册表行）？可经「撤销重构」复原。"
            )
            ok = QMessageBox.question(self, "重构删除", prompt)
            if ok != QMessageBox.StandardButton.Yes:
                return
            try:
                summary, reverse_ops = delete_signal(self._model, sid, force=bool(refs))
            except SignalRefactorError as exc:
                QMessageBox.warning(self, "重构删除失败", str(exc))
                return
            push_journal(self._model, {"op": "delete", "signalId": sid, "summary": summary, "reverseOps": reverse_ops})
            self._resync_from_model()
        if self._selected == sid:
            self._selected = ""
        self._rebuild_table()
        self._refresh_validation()

    def _stage_copy_to_model(self) -> bool:
        """把本对话框的当前拷贝（含 label/notes 编辑）暂存进模型——重构必须作用在最新数据上。
        校验错误时拒绝（与 OK 提交同一道闸），不产生任何修改。"""
        errors, _warnings = self._refresh_validation()
        if errors:
            QMessageBox.warning(self, "信号校验未通过", "请先修复错误，再执行重构。")
            return False
        self._model.narrative_graphs = self._data
        self._model.mark_dirty("narrative_graphs")
        return True

    def _resync_from_model(self) -> None:
        """重构后从模型取回最新数据（引擎直接改模型，本地拷贝必须跟上）。"""
        src = self._model.narrative_graphs if isinstance(self._model.narrative_graphs, dict) else {}
        self._data = json.loads(json.dumps(src, ensure_ascii=False))
        self._data.setdefault("signals", [])
        if not isinstance(self._data["signals"], list):
            self._data["signals"] = []

    def _refactor_rename(self, old_id: str, new_id: str) -> bool:
        """信号改 id 的全项目级联（共享引擎）。脱机（无模型）退回旧的拷贝内级联。"""
        if self._model is None:
            for row in self._signals():
                if isinstance(row, dict) and str(row.get("id") or "").strip() == old_id:
                    row["id"] = new_id
            _rename_narrative_signal_refs(self._data, old_id, new_id)
            return True
        from .signal_refactor import SignalRefactorError, push_journal, rename_signal, scan_signal_usages

        if not self._stage_copy_to_model():
            return False
        usages = scan_signal_usages(self._model, old_id)
        ok = QMessageBox.question(
            self,
            "重构改名",
            f"把信号 {old_id!r} 全项目改名为 {new_id!r}？\n\n"
            f"共 {usages['totalRefs']} 处引用将级联更新"
            f"（对话图 {len(usages['dialogues'])} 个、场景/资产 {len(usages['assets'])} 个条目、"
            f"监听 transition {len(usages['listeners'])} 条）。\n\n"
            "改动只进暂存、不落盘（Save All 才写文件）；可经「撤销重构」回退，"
            "不随本对话框取消而回滚。",
        )
        if ok != QMessageBox.StandardButton.Yes:
            return False
        try:
            summary = rename_signal(self._model, old_id, new_id)
        except SignalRefactorError as exc:
            QMessageBox.warning(self, "重构改名失败", str(exc))
            return False
        push_journal(self._model, {"op": "rename", "oldId": old_id, "newId": new_id, "summary": summary})
        self._resync_from_model()
        return True

    def _undo_refactor(self) -> None:
        if self._model is None:
            QMessageBox.information(self, "撤销重构", "脱机模式没有重构日志。")
            return
        from .signal_refactor import undo_last

        result = undo_last(self._model)
        if not result.get("ok"):
            QMessageBox.information(self, "撤销重构", str(result.get("reason") or "没有可撤销的重构操作"))
            return
        self._resync_from_model()
        self._rebuild_table()
        self._refresh_validation()
        QMessageBox.information(self, "撤销重构", f"{result.get('description')}（仍未落盘）")

    def _refresh_validation(self) -> tuple[list[str], list[str]]:
        errors, warnings = _validate_narrative_signals_for_manager(self._data)
        lines: list[str] = []
        if not errors and not warnings:
            lines.append("校验通过")
        else:
            lines.extend(f"错误: {msg}" for msg in errors)
            lines.extend(f"警告: {msg}" for msg in warnings)
        self._validation.setPlainText("\n".join(lines))
        return errors, warnings

    def _commit_if_valid(self) -> bool:
        errors, _warnings = self._refresh_validation()
        if errors:
            QMessageBox.warning(self, "信号校验未通过", "请先修复错误，再保存信号管理器。")
            return False
        if self._model is not None:
            self._model.narrative_graphs = self._data
            self._model.mark_dirty("narrative_graphs")
        return True

    def _select_current(self) -> None:
        idx = self._current_signal_index()
        if idx is None:
            return
        signals = self._signals()
        if idx < 0 or idx >= len(signals) or not isinstance(signals[idx], dict):
            return
        sid = str(signals[idx].get("id") or "").strip()
        if not sid:
            return
        self._selected = sid
        if self._commit_if_valid():
            self.accept()

    def _accept_without_select(self) -> None:
        if self._commit_if_valid():
            self.accept()


class NarrativeSignalPickerField(QWidget):
    """Read-only signal field; all edits go through NarrativeSignalManagerDialog."""

    valueChanged = Signal(str)

    def __init__(self, model, committed: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._value = (committed or "").strip()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._line = QLineEdit(self)
        self._line.setReadOnly(True)
        self._line.setPlaceholderText("通过信号管理器选择")
        self._line.setToolTip("不可手写；点「信号管理器…」选择或维护 narrative_graphs.signals。")
        btn = QPushButton("信号管理器…", self)
        btn.clicked.connect(self._open_manager)
        lay.addWidget(self._line, 1)
        lay.addWidget(btn)
        self._refresh_line()

    def current_signal(self) -> str:
        return self._value

    def _display_for_value(self, value: str) -> str:
        val = (value or "").strip()
        if not val:
            return ""
        for display, sid in _narrative_signal_rows_with_orphan(self._model, val):
            if sid == val:
                return display
        return val

    def _refresh_line(self) -> None:
        self._line.setText(self._display_for_value(self._value))

    def _open_manager(self) -> None:
        if self._model is None:
            QMessageBox.warning(self, "信号管理器", "当前没有工程上下文，无法管理 narrative_graphs.signals。")
            return
        dlg = NarrativeSignalManagerDialog(self._model, self._value, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            self._refresh_line()
            return
        new_value = dlg.selected_signal().strip()
        if new_value != self._value:
            self._value = new_value
            self._refresh_line()
            self.valueChanged.emit(self._value)
        else:
            self._refresh_line()


class FilterableTypeCombo(QComboBox):
    """
    可编辑下拉：每项为 (展示名, 取值)。筛选同时对展示名、取值做匹配（非前缀限定）：
    - 子串：查询串在字符串任意位置出现（不区分大小写）
    - 模糊：查询串每个字符在字符串中按先后顺序出现即可
    含「未选/留空」占位时须 (展示文案, "")，禁止 ("", 展示文案)，否则 committed_type 会落成展示串而非空。
    """

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


def _default_wheel_speech_role_combo_rows() -> list[tuple[str, str]]:
    """转盘气泡 role：未绑定 SugarWheelEditor getter 时的内置列表（与运行时默认锚点 role 对齐）。"""
    return [
        ("（选转盘气泡角色）", ""),
        ("protagonist · 叙述/玩家侧", "protagonist"),
        ("stall_owner · 摊主", "stall_owner"),
        ("child_a · 小孩", "child_a"),
        ("child_b · 小孩", "child_b"),
        ("child_c · 小孩", "child_c"),
        ("child_d · 小孩", "child_d"),
    ]


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
        display_text = text
        if value == "setNarrativeState":
            display_text = f"{text}  [危险：绕过 Transition，仅调试/修复]"
        name = QLabel(display_text, self)
        if value == "setNarrativeState":
            name.setStyleSheet("color: #c62828; font-weight: 600;")
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
        # 解除"最小=初始"的死锁：保留较小下限让 13" 上可缩，初始仍 760×560，并记忆几何
        self.setMinimumSize(560, 360)
        self.resize(760, 560)
        self._all_rows: list[tuple[str, str]] = []
        self._selected: str = ""

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        legend = QLabel(
            "红圆点仅标「会改存档/可持久化数据」的动作，悬停圆点查看说明；"
            "无圆点为偏演出/瞬时/流程类。仅调试/修复动作不会出现在普通新建列表里。",
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
        self._list.setMinimumHeight(240)  # 下限降低，让弹窗在 13" 上能压缩
        root.addWidget(self._list, stretch=1)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        btns.accepted.connect(self._on_accept)
        btns.rejected.connect(self.reject)
        root.addWidget(btns)
        remember_dialog_geometry(self, "action_type_picker")

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
        # 空列表不自动注入空槽：载入 slots:[] 保存仍是 slots:[]（往返不漂移），
        # 需要新槽时用「+ 规矩槽位」按钮显式添加。
        for s in raw:
            if isinstance(s, dict):
                self._append_slot_ui(s)

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
        rid = IdRefSelector(box, allow_empty=True, editable=True)
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
        tx = RichTextTextEdit(self._model)
        tx.setMinimumHeight(56)
        tx.setMaximumHeight(140)
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


class ActionChoiceOptionsEditor(QWidget):
    """chooseAction.params.options：每个选项有显示文本与一组子 Action。"""

    changed = Signal()

    def __init__(
        self,
        model,
        scene_id: str | None,
        cutscene_id: str | None,
        options: list,
        parent: QWidget | None = None,
        *,
        wheel_speech_role_rows_getter: Callable[[], list[tuple[str, str]]] | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        self._cutscene_id = cutscene_id
        self._wheel_speech_role_rows_getter = wheel_speech_role_rows_getter
        self._rows: list[dict] = []
        self._root = QVBoxLayout(self)
        self._root.setContentsMargins(20, 0, 0, 0)
        self._root.setSpacing(6)
        top = QHBoxLayout()
        title = QLabel("<b>options</b>")
        title.setToolTip("玩家看到的选项；选择后顺序执行该选项内的 actions。")
        top.addWidget(title)
        top.addStretch(1)
        add_btn = QPushButton("+ 选项")
        add_btn.setToolTip("添加一个玩家可选分支")
        add_btn.clicked.connect(lambda: self._add_option({}))
        top.addWidget(add_btn)
        self._root.addLayout(top)
        # 空列表不自动注入空选项：载入 options:[] 保存仍是 options:[]（往返不漂移），
        # 需要新选项时用「+ 选项」按钮显式添加。
        for opt in options if isinstance(options, list) else []:
            self._add_option(opt if isinstance(opt, dict) else {})

    def set_wheel_speech_role_rows_getter(
        self,
        fn: Callable[[], list[tuple[str, str]]] | None,
    ) -> None:
        self._wheel_speech_role_rows_getter = fn
        for row in self._rows:
            ae = row.get("ae")
            if isinstance(ae, ActionEditor):
                ae.set_wheel_speech_role_rows_getter(fn)

    def _add_option(self, data: dict) -> None:
        box = QGroupBox(self)
        bl = QVBoxLayout(box)
        bl.setContentsMargins(8, 6, 8, 8)
        head = QHBoxLayout()
        if self._model is not None:
            text_w = RichTextLineEdit(self._model, box)
            text_w.setText(str(data.get("text", "") or ""))
            text_w.setPlaceholderText("选项文本")
            text_w.textChanged.connect(lambda _s: self.changed.emit())
        else:
            text_w = QLineEdit(str(data.get("text", "") or ""), box)
            text_w.setPlaceholderText("选项文本")
            text_w.textChanged.connect(self.changed.emit)
        text = text_w
        tl = QLabel("text", box)
        tl.setToolTip("选项展示文案；工程打开时可点「引用」插入 [tag:…]，运行时经 resolveDisplayText。")
        head.addWidget(tl)
        head.addWidget(text, 1)
        up_btn = QPushButton("↑", box)
        up_btn.setFixedWidth(24)
        down_btn = QPushButton("↓", box)
        down_btn.setFixedWidth(24)
        del_btn = QPushButton("−", box)
        del_btn.setFixedWidth(24)
        head.addWidget(up_btn)
        head.addWidget(down_btn)
        head.addWidget(del_btn)
        bl.addLayout(head)
        ae = ActionEditor("option actions", box)
        ae.set_project_context(self._model, self._scene_id, cutscene_id=self._cutscene_id)
        if self._wheel_speech_role_rows_getter is not None:
            ae.set_wheel_speech_role_rows_getter(self._wheel_speech_role_rows_getter)
        raw_actions = data.get("actions", [])
        ae.set_data(list(raw_actions) if isinstance(raw_actions, list) else [])
        ae.changed.connect(self.changed.emit)
        bl.addWidget(ae)
        row = {"box": box, "text": text, "ae": ae, "up": up_btn, "down": down_btn}
        up_btn.clicked.connect(lambda _=False, r=row: self._move_row(r, -1))
        down_btn.clicked.connect(lambda _=False, r=row: self._move_row(r, 1))
        del_btn.clicked.connect(lambda _=False, r=row: self._remove_row(r))
        self._rows.append(row)
        self._root.addWidget(box)
        self._refresh_titles_and_buttons()
        self.changed.emit()

    def _refresh_titles_and_buttons(self) -> None:
        for i, row in enumerate(self._rows):
            box = row["box"]
            if isinstance(box, QGroupBox):
                box.setTitle(f"选项 {i + 1}")
            up = row.get("up")
            down = row.get("down")
            if isinstance(up, QPushButton):
                up.setEnabled(i > 0)
            if isinstance(down, QPushButton):
                down.setEnabled(i < len(self._rows) - 1)

    def _move_row(self, row: dict, delta: int) -> None:
        if row not in self._rows:
            return
        i = self._rows.index(row)
        j = i + delta
        if j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        for r in self._rows:
            self._root.removeWidget(r["box"])
        for r in self._rows:
            self._root.addWidget(r["box"])
        self._refresh_titles_and_buttons()
        self.changed.emit()

    def _remove_row(self, row: dict) -> None:
        if row not in self._rows:
            return
        self._rows.remove(row)
        box = row["box"]
        self._root.removeWidget(box)
        box.deleteLater()
        self._refresh_titles_and_buttons()
        self.changed.emit()

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for row in self._rows:
            text = row["text"].text().strip()
            ae = row["ae"]
            out.append({
                "text": text,
                "actions": ae.to_list() if isinstance(ae, ActionEditor) else [],
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
        *,
        cutscene_id: str | None = None,
        wheel_speech_role_rows_getter: Callable[[], list[tuple[str, str]]] | None = None,
    ):
        super().__init__(parent)
        self._param_widgets: dict[str, QWidget] = {}
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        self._ctx_cutscene_id = (cutscene_id or "") or None
        self._wheel_speech_role_rows_getter = wheel_speech_role_rows_getter
        self._delayed_editor = None
        self._run_actions_editor = None
        self._choice_options_editor = None
        self._random_above_editor = None
        self._random_below_editor = None
        self._collapsed = True

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(2)
        self._outer_layout = outer

        # 所有子 widget 均显式传 parent=self，避免任何 QWidget 子类在构造时短暂成为 top-level。
        top = QHBoxLayout()
        self._fold_toggle = QToolButton(self)
        self._fold_toggle.setAutoRaise(True)
        self._fold_toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._fold_toggle.setToolTip("折叠 / 展开参数区")
        self._fold_toggle.clicked.connect(self._on_fold_clicked)
        top.addWidget(self._fold_toggle)
        self.type_combo = ActionTypePickerField(
            [(t, t) for t in CONTENT_ACTION_TYPES],
            parent=self,
            orphan_label=_action_type_orphan_label,
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
        # 字段按内容宽度排布：短参数（数字/枚举/复选框）不再被拉满整行。
        self._params_layout.setFieldGrowthPolicy(
            QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint,
        )
        self._params_layout.setContentsMargins(12, 0, 0, 0)
        self._foldable_layout.addWidget(self._params_frame)
        outer.addWidget(self._foldable_body)
        self._foldable_body.setVisible(False)

        raw = data or {"type": "setFlag", "params": {}}
        self._data = {
            "type": raw.get("type", "setFlag"),
            "params": dict(raw.get("params", {})),
        }
        self._normalize_action_params(self._data["type"], self._data["params"])
        # 原始参数快照：to_dict 据此把未改动的数值恢复 int/float 原始表示、并剔除原本就没有的
        # 空/默认占位键，避免"打开即保存"漂移（1000->1000.0、新增 direction:""/anchorOffset:0 等）。
        self._original_params = deepcopy(self._data["params"])
        self.type_combo.set_committed_type(self._data.get("type", "setFlag"))
        # 记录当前类型：用户切换类型时据此弹确认/回退（程序性 set 不经 typeCommitted，不受影响）
        self._last_committed_type: str = self.type_combo.committed_type()
        self._rebuild_params()

        self.type_combo.typeCommitted.connect(self._on_type_committed)
        # 折叠时也能一眼看出该动作的关键参数（M6）：摘要做成只读 tooltip，
        # 走既有 to_dict()（纯读，不改数据），随编辑/换类型刷新。
        self.changed.connect(self._update_summary_tooltip)
        self.type_combo.typeCommitted.connect(
            lambda *_: self._update_summary_tooltip())
        self._update_summary_tooltip()

    def _update_summary_tooltip(self) -> None:
        try:
            d = self.to_dict()
        except Exception:
            return
        params = d.get("params", {}) or {}

        def _short(v: object) -> str:
            s = str(v)
            return s if len(s) <= 24 else s[:23] + "…"

        parts = [f"{k}={_short(v)}" for k, v in params.items()
                 if not isinstance(v, (list, dict))]
        typ = str(d.get("type", "") or "")
        summary = "  ·  ".join(parts)
        self.setToolTip(f"{typ}\n{summary}" if summary else typ)

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

    def set_wheel_speech_role_rows_getter(
        self,
        fn: Callable[[], list[tuple[str, str]]] | None,
    ) -> None:
        """转盘编辑器传入：下拉项与实例 speechAnchors（含预设）一致；其它页面保持 None 则用内置六项。"""
        if self._wheel_speech_role_rows_getter == fn:
            return
        self._wheel_speech_role_rows_getter = fn
        self._data = self.to_dict()
        self._rebuild_params()
        if self._delayed_editor is not None:
            self._delayed_editor.set_wheel_speech_role_rows_getter(fn)
        if self._run_actions_editor is not None:
            self._run_actions_editor.set_wheel_speech_role_rows_getter(fn)
        if self._choice_options_editor is not None:
            self._choice_options_editor.set_wheel_speech_role_rows_getter(fn)
        if self._random_above_editor is not None:
            self._random_above_editor.set_wheel_speech_role_rows_getter(fn)
        if self._random_below_editor is not None:
            self._random_below_editor.set_wheel_speech_role_rows_getter(fn)

    def refresh_wheel_speech_role_combo_if_any(self) -> None:
        act = self.type_combo.committed_type()
        if act not in ("sugarWheelShowSpeech", "sugarWheelDismissSpeech"):
            return
        w = self._param_widgets.get("role")
        if not isinstance(w, FilterableTypeCombo):
            return
        w.set_entries(self._compose_wheel_speech_role_rows())

    def _compose_wheel_speech_role_rows(self) -> list[tuple[str, str]]:
        if self._wheel_speech_role_rows_getter is not None:
            try:
                out = self._wheel_speech_role_rows_getter()
            except Exception:
                out = []
            if isinstance(out, list) and out:
                return out
        return _default_wheel_speech_role_combo_rows()

    def set_project_context(
        self,
        model,
        scene_id: str | None,
        *,
        cutscene_id: str | None = None,
    ) -> None:
        from ..editor_perf import PerfClock, maybe_stamp, perf_log_enabled

        _pct = PerfClock(label="ActionRow.set_project_ctx") if perf_log_enabled() else None
        new_cut = (
            (cutscene_id or None)
            if cutscene_id is not None
            else self._ctx_cutscene_id
        )
        if (
            model is self._ctx_model
            and scene_id == self._ctx_scene_id
            and new_cut == self._ctx_cutscene_id
        ):
            maybe_stamp(_pct, "skip (上下文未变)")
            return
        self._data = self.to_dict()
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        if cutscene_id is not None:
            self._ctx_cutscene_id = cutscene_id or None
        self._rebuild_params()
        maybe_stamp(_pct, f'rebuild done type={self.type_combo.committed_type()!s}')

    @staticmethod
    def _meaningful_param_count(params: dict) -> int:
        """"已配置"参数计数：非空字符串 / 非空列表 / 非空 dict 才算。

        bool / 数字不计——它们多为控件自动默认（fresh 行的 value:true、seed 的时长等），
        计入会让"新加一行随手换类型"也弹确认。真正会被蒸发且难以重建的是
        id/文本与嵌套 action 列表，这里全都覆盖。
        """
        n = 0
        for v in (params or {}).values():
            if isinstance(v, str):
                if v.strip():
                    n += 1
            elif isinstance(v, (list, dict)):
                if v:
                    n += 1
        return n

    def _confirm_type_switch_clear(self, prev_type: str, new_type: str, count: int) -> bool:
        """切换类型将清空已配置参数时的确认；测试可 monkeypatch。默认 No（不清空）。"""
        ret = QMessageBox.question(
            self,
            "切换 Action 类型",
            f"从 {prev_type} 切换到 {new_type} 将清空已配置的 {count} 项参数"
            "（含嵌套子动作，切回不会还原）。确定切换？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return ret == QMessageBox.StandardButton.Yes

    def _on_type_committed(self, _text: str) -> None:
        new_type = self.type_combo.committed_type()
        prev_type = getattr(self, "_last_committed_type", "")
        if prev_type and new_type != prev_type:
            # typeCommitted 时 committed 已是新类型；临时回位用旧类型序列化旧控件，
            # 得到"即将被清空"的真实参数（含嵌套 action 列表）。set_committed_type 程序性不发信号。
            self.type_combo.set_committed_type(prev_type)
            try:
                old_params = (self.to_dict() or {}).get("params") or {}
            except Exception:
                old_params = {}
            finally:
                self.type_combo.set_committed_type(new_type)
            n = self._meaningful_param_count(old_params)
            if n > 0 and not self._confirm_type_switch_clear(prev_type, new_type, n):
                # 用户放弃：类型回退，控件与参数原样保留
                self.type_combo.set_committed_type(prev_type)
                return
        self._last_committed_type = new_type
        self._data["params"] = {}
        # 切换 action 类型即换了一套参数语义：旧类型的原始快照不再适用，清空以免误保真/误剔除。
        self._original_params = {}
        self._rebuild_params()
        self.changed.emit()

    def _connect_scene_spawn_pickers(self) -> None:
        ts_w = self._param_widgets.get("targetScene")
        sp_w = self._param_widgets.get("targetSpawnPoint")
        if not isinstance(ts_w, IdRefSelector) or not isinstance(sp_w, IdRefSelector):
            return

        # 首帧 sp_w 候选项还没填，已加载的 targetSpawnPoint 在初始 set_current 时会落空被吞；
        # 用当前参数值作首帧目标（中途重建时以 self._data 为准，别用磁盘原值回滚本次会话的修改），
        # 避免「打开 switchScene 节点即丢出生点」。
        _cur_params = {}
        try:
            _cur_params = dict((self._data or {}).get("params") or {})
        except (AttributeError, TypeError):
            _cur_params = {}
        _init_v = _cur_params.get(
            "targetSpawnPoint",
            (self._original_params or {}).get("targetSpawnPoint", ""),
        )
        initial = {"v": str(_init_v or "")}

        def refresh_spawn(_: str = "") -> None:
            sid = ts_w.current_id()
            keys = (
                self._ctx_model.spawn_point_keys_for_scene(sid)
                if self._ctx_model
                else [""]
            )
            # 空键不入候选：allow_empty 的 "(none)" 行已是唯一空值（语义 = 不写该键，进场用默认
            # 出生点）。此前 "(none)" 与 "(default)" 双空值同列，语义重复且易误解。
            items: list[tuple[str, str]] = [(k, k) for k in keys if k]
            if initial["v"] is not None:
                cur = initial["v"]
                initial["v"] = None
            else:
                cur = sp_w.current_id()
            sp_w.set_items(items)
            # 悬垂出生点保值（IdRefSelector 孤儿行），绝不静默改指第一项
            sp_w.set_current(cur)

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
            # 悬垂/空 entryId 保值展示（孤儿行/占位），绝不静默改指第一条档案
            en_w.set_current(cur)

        bt_w.currentTextChanged.connect(refresh_entry)
        refresh_entry()

    def _connect_play_npc_animation_pickers(self, *, initial_state: str, initial_then: str = "") -> None:
        tgt_w = self._param_widgets.get("target")
        st_w = self._param_widgets.get("state")
        then_w = self._param_widgets.get("thenState")
        if not isinstance(tgt_w, IdRefSelector) or not isinstance(st_w, FilterableTypeCombo):
            return
        init_st = (initial_state or "").strip()
        init_then = (initial_then or "").strip()
        _refresh_calls = 0

        def _apply_states(
            combo: FilterableTypeCombo, placeholder: str, states: list[str], cur: str,
        ) -> None:
            rows: list[tuple[str, str]] = [(placeholder, "")]
            rows.extend((s, s) for s in states)
            combo.set_entries(rows)
            if cur in states or cur == "":
                combo.set_committed_type(cur)
            else:
                # 悬垂值保值展示（共享控件保值契约），绝不静默清空/顶替
                combo.set_entries([(f"(数据) {cur}", cur)] + rows[1:])
                combo.set_committed_type(cur)

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
            cur = st_w.committed_type().strip()
            if _refresh_calls == 1 and not cur and init_st:
                cur = init_st
            _apply_states(st_w, "（选 state）", states, cur)
            # thenState 与 state 共享同一目标的候选集，一并随 target 刷新
            if isinstance(then_w, FilterableTypeCombo):
                cur_then = then_w.committed_type().strip()
                if _refresh_calls == 1 and not cur_then and init_then:
                    cur_then = init_then
                _apply_states(then_w, "（播完不切换）", states, cur_then)

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
            rows: list[tuple[str, str]] = [("（选 state）", "")]
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

    def _rebuild_move_entity_to_params(self, params: dict) -> None:
        from ..shared.move_entity_map_picker import MoveEntityToMapPickerDialog, normalize_move_entity_waypoints

        self._params_frame.setVisible(True)
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._param_widgets.clear()

        m = self._ctx_model
        tip = QLabel(
            "在「地图 sceneId」上用弹窗必选终点坐标；可选用途经点勾勒出世界坐标下的折线路径。\n"
            "x/y 只读禁止手输；速度与 moveAnimState 在此编辑。sceneId 仅存档供编辑器复现地图。"
        )
        tip.setWordWrap(True)
        self._params_layout.addRow(tip)

        tgt_w = self._make_selector("actor", str(params.get("target", "") or ""))
        self._param_widgets["target"] = tgt_w
        self._params_layout.addRow("target", tgt_w)

        scene_rows = [(s, s) for s in (m.all_scene_ids() if m else [])] or [("（无场景）", "")]

        def _default_map_sid() -> str:
            ms = str(params.get("sceneId") or "").strip()
            if ms:
                return ms
            if self._ctx_scene_id:
                return str(self._ctx_scene_id).strip()
            cid = self._ctx_cutscene_id
            if m and cid:
                for cv in m.cutscenes or []:
                    if isinstance(cv, dict) and str(cv.get("id", "")).strip() == str(cid).strip():
                        return str(cv.get("targetScene") or "").strip()
            return ""

        sid0 = _default_map_sid()
        map_scene_combo = FilterableTypeCombo(scene_rows, self, select_only=True)
        vals = {v for _d, v in scene_rows if v}
        if sid0 and sid0 in vals:
            map_scene_combo.set_committed_type(sid0)
        elif scene_rows and scene_rows[0][1]:
            map_scene_combo.set_committed_type(scene_rows[0][1])
        map_scene_combo.setToolTip("选点弹窗使用该场景的背景与尺寸。")
        map_scene_combo.typeCommitted.connect(lambda _t: self.changed.emit())
        self._param_widgets["sceneId"] = map_scene_combo
        self._params_layout.addRow("地图 sceneId（仅编辑）", map_scene_combo)

        try:
            ix = float(params.get("x"))
            iy = float(params.get("y"))
        except (TypeError, ValueError):
            ix, iy = 0.0, 0.0
        if not (math.isfinite(ix) and math.isfinite(iy)):
            ix, iy = 0.0, 0.0

        sx_v = QDoubleSpinBox(self)
        sx_v.setRange(-1e9, 1e9)
        sx_v.setDecimals(2)
        sx_v.setReadOnly(True)
        sx_v.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        sx_v.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        sx_v.setValue(ix)
        sy_v = QDoubleSpinBox(self)
        sy_v.setRange(-1e9, 1e9)
        sy_v.setDecimals(2)
        sy_v.setReadOnly(True)
        sy_v.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        sy_v.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        sy_v.setValue(iy)
        self._param_widgets["x"] = sx_v
        self._param_widgets["y"] = sy_v
        self._params_layout.addRow("终点 x", sx_v)
        self._params_layout.addRow("终点 y", sy_v)

        wps_store: list[list[tuple[float, float]]] = [normalize_move_entity_waypoints(params.get("waypoints"))]
        wp_lbl = QLabel(f"途经点: {len(wps_store[0])} 个", self)

        pick_btn = QPushButton("地图选终点与路径…", self)

        def _open_move_pick() -> None:
            sid = map_scene_combo.committed_type().strip()
            if not m:
                QMessageBox.warning(self, "选点", "未加载工程。")
                return
            if not sid or sid not in m.scenes:
                QMessageBox.information(self, "选点", "请选择有效的地图场景 sceneId。")
                return
            dlg = MoveEntityToMapPickerDialog(
                m,
                sid,
                float(sx_v.value()),
                float(sy_v.value()),
                list(wps_store[0]),
                self,
            )
            if dlg.exec() != QDialog.DialogCode.Accepted:
                return
            px, py = dlg.result_destination()
            sx_v.setValue(float(px))
            sy_v.setValue(float(py))
            wobjs = dlg.result_waypoints_objects()
            wps_store[0] = [(round(float(o["x"]), 2), round(float(o["y"]), 2)) for o in wobjs]
            wp_lbl.setText(f"途经点: {len(wps_store[0])} 个")
            self.changed.emit()

        pick_btn.clicked.connect(_open_move_pick)

        row_pick = QWidget(self)
        rlx = QHBoxLayout(row_pick)
        rlx.setContentsMargins(0, 0, 0, 0)
        rlx.addWidget(pick_btn)
        rlx.addWidget(wp_lbl, 1)
        self._params_layout.addRow("", row_pick)
        self._move_entity_waypoints_store = wps_store

        try:
            sp_v = float(params.get("speed", 80))
        except (TypeError, ValueError):
            sp_v = 80.0
        if not math.isfinite(sp_v) or sp_v <= 0:
            sp_v = 80.0
        speed_sb = QDoubleSpinBox(self)
        speed_sb.setRange(1, 9999)
        speed_sb.setDecimals(2)
        speed_sb.setValue(sp_v)
        speed_sb.valueChanged.connect(lambda _v: self.changed.emit())
        self._param_widgets["speed"] = speed_sb
        self._params_layout.addRow("speed", speed_sb)

        ma_init = str(params.get("moveAnimState", "") or "").strip()
        st_combo = FilterableTypeCombo([("（不播放移动动画）", "")], self, select_only=True)
        if ma_init:
            st_combo.set_committed_type(ma_init)
        st_combo.typeCommitted.connect(lambda _t: self.changed.emit())
        self._param_widgets["moveAnimState"] = st_combo
        self._params_layout.addRow("moveAnimState", st_combo)

        face_cb = QCheckBox("自动调节朝向（沿路运动方向更新朝向）", self)
        face_raw = params.get("faceTowardMovement")
        face_cb.setChecked(face_raw is True or str(face_raw).strip().lower() in ("true", "1", "yes"))
        face_cb.toggled.connect(lambda _c: self.changed.emit())
        self._param_widgets["faceTowardMovement"] = face_cb
        self._params_layout.addRow("朝向", face_cb)

        self._sync_foldable_visibility()
        self._connect_move_entity_animation_pickers(initial_state=ma_init)

    def _connect_move_entity_animation_pickers(self, *, initial_state: str) -> None:
        tgt_w = self._param_widgets.get("target")
        st_w = self._param_widgets.get("moveAnimState")
        sc_w = self._param_widgets.get("sceneId")
        if (
            not isinstance(tgt_w, IdRefSelector)
            or not isinstance(st_w, FilterableTypeCombo)
            or not isinstance(sc_w, FilterableTypeCombo)
        ):
            return
        init_st = (initial_state or "").strip()
        calls = [0]

        def refresh_state(_: str = "") -> None:
            calls[0] += 1
            aid = tgt_w.current_id().strip()
            sid = sc_w.committed_type().strip()
            mm = self._ctx_model
            states = mm.animation_state_names_for_actor(sid, aid) if mm and sid else []
            rows: list[tuple[str, str]] = [("（不播放移动动画）", "")]
            rows.extend((s, s) for s in states)
            cur = st_w.committed_type().strip()
            if calls[0] == 1 and not cur and init_st:
                cur = init_st
            st_w.set_entries(rows)
            allowed = {""} | set(states)
            if cur in allowed:
                st_w.set_committed_type(cur)
            elif cur:
                st_w.set_entries([(f"(数据) {cur}", cur)] + rows[1:])
                st_w.set_committed_type(cur)
            else:
                st_w.set_committed_type("")

        tgt_w.value_changed.connect(refresh_state)
        sc_w.typeCommitted.connect(lambda _t: refresh_state())
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
    ) -> QWidget:
        """下拉选 id；若干 kind 禁止手输未知值，并从数据追加「孤儿」行。"""
        m = self._ctx_model
        committed = str(val if val is not None else "").strip()
        strict_pick = kind in (
            "actor", "emote_target", "npc_only",
            "water_minigame", "sugar_wheel_minigame", "paper_craft_minigame",
            "smell", "plane", "pressure_hold", "signal_cue",
        )

        pairs: list[tuple[str, str]] = []
        if kind == "scene":
            pairs = [(s, s) for s in (m.all_scene_ids() if m else [])]
        elif kind == "narrative_run_archetype":
            pairs = [(g, g) for g in (m.narrative_instanced_graph_ids_ordered() if m else [])]
        elif kind == "item":
            pairs = m.all_item_ids() if m else []
        elif kind == "quest":
            # updateQuest 等状态机目标：排除 repeatable（无状态机可推）
            pairs = m.quest_status_target_ids() if m else []
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
        elif kind == "audio_ambient":
            pairs = [(a, a) for a in (m.all_audio_ids("ambient") if m else [])]
        elif kind == "spawn":
            # 空值只保留 allow_empty 的 "(none)" 行（= 不写该键，默认出生点），
            # 不再注入 ("", "(default)") 同义空值行。
            pairs = []
        elif kind == "emote_target":
            if m:
                # 与 actor kind 的候选源对齐（project_model.actor_id_items_for_scene）：
                # 运行时 resolveEmoteTarget 支持过场临时演员 _cut_*，strict 下拉必须给得出。
                pairs.extend(m.collect_cutscene_temp_actor_ids())
                pairs.extend(m.npc_ids_for_scene(self._ctx_scene_id))
                pairs.extend(m.hotspot_ids_for_scene(self._ctx_scene_id))
            pairs.append(("player", "player"))
        elif kind == "actor":
            pairs = m.actor_id_items_for_scene(self._ctx_scene_id) if m else []
        elif kind == "npc_only":
            pairs = m.npc_actor_items_for_scene(self._ctx_scene_id) if m else []
        elif kind == "water_minigame":
            pairs = m.all_water_minigame_ids() if m else []
        elif kind == "sugar_wheel_minigame":
            pairs = m.all_sugar_wheel_minigame_ids() if m else []
        elif kind == "paper_craft_minigame":
            pairs = m.all_paper_craft_minigame_ids() if m else []
        elif kind == "smell":
            pairs = m.all_smell_profile_ids() if m else []
        elif kind == "plane":
            pairs = m.all_plane_ids() if m else []
        elif kind == "pressure_hold":
            # project_model 暂无专用 id-provider，这里只读其 pressure_holds 列表（数据同源）
            pairs = [
                (str(p.get("id", "")).strip(), str(p.get("prompt") or p.get("id", "")).strip()[:32])
                for p in ((m.pressure_holds if m else None) or [])
                if isinstance(p, dict) and str(p.get("id", "")).strip()
            ]
        elif kind == "signal_cue":
            # project_model 暂无专用 id-provider，这里只读其 signal_cues 列表（数据同源）
            pairs = [
                (str(c.get("id", "")).strip(), str(c.get("description") or c.get("id", "")).strip()[:32])
                for c in ((m.signal_cues if m else None) or [])
                if isinstance(c, dict) and str(c.get("id", "")).strip()
            ]
        else:
            pairs = []

        if strict_pick:
            pairs = _id_ref_rows_with_orphan(pairs, committed)

        if kind in ("audio_bgm", "audio_sfx", "audio_ambient") and m is not None:
            channel = {"audio_bgm": "bgm", "audio_sfx": "sfx", "audio_ambient": "ambient"}[kind]
            w_audio = AudioIdPreviewSelector(
                m,
                channel,
                self,
                allow_empty=True,
                editable=True,
            )
            w_audio.setMinimumWidth(160)
            w_audio.set_items(pairs)
            w_audio.set_current(committed)
            w_audio.value_changed.connect(self.changed)
            w_audio.setToolTip("选择 audio_config 中的音频 id；右侧按钮可直接试听当前选择。")
            _tag_content_universe(w_audio, _SELECTOR_KIND_UNIVERSE.get(kind))
            return w_audio

        w = IdRefSelector(
            self, allow_empty=True, editable=not strict_pick,
            click_opens_popup=bool(strict_pick),
        )
        w.setMinimumWidth(96)
        if pairs:
            w.set_items(pairs)
        else:
            w.set_items([])
        w.set_current(committed)
        w.value_changed.connect(self.changed)
        tip = {
            "actor": "仅下拉选择；无场景上下文时列表可能不全，请先设置过场 targetScene。",
            "emote_target": "仅下拉选择；列表为当前场景 NPC + 热点 + player。",
            "npc_only": "仅下拉选择；列表为当前场景 NPC。",
            "water_minigame": "仅下拉选择；列表来自 water_minigames/index.json。",
            "sugar_wheel_minigame": "仅下拉选择；列表来自 sugar_wheel/index.json。",
            "paper_craft_minigame": "仅下拉选择；列表来自 paper_craft/index.json。",
            "smell": "仅下拉选择；列表来自 smell_profiles.json 的 profiles（香火/阴腥/尸臭/血腥/霉/香粉…）。留空=回落正常态。",
            "plane": "仅下拉选择；列表来自 planes.json（位面面板维护）。\n"
                     "activatePlane 作用域：过场内激活随过场结束自动清除；"
                     "过场外持续至 deactivatePlane / 读档，且压过叙事点名。",
            "spawn": "选目标场景的出生点；(none) = 不指定（进场用默认出生点）。",
            "pressure_hold": "仅下拉选择；列表来自 pressure_holds.json（按压蓄力配置）。",
            "signal_cue": "仅下拉选择；列表来自 signal_cues.json（信号演出配置）。",
        }.get(kind)
        if tip:
            w.setToolTip(tip)
        _tag_content_universe(w, _SELECTOR_KIND_UNIVERSE.get(kind))
        return w

    def _rebuild_params(self) -> None:
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._param_widgets.clear()
        if self._delayed_editor is not None:
            self._foldable_layout.removeWidget(self._delayed_editor)
            self._delayed_editor.deleteLater()
            self._delayed_editor = None
        if self._run_actions_editor is not None:
            self._foldable_layout.removeWidget(self._run_actions_editor)
            self._run_actions_editor.deleteLater()
            self._run_actions_editor = None
        if self._choice_options_editor is not None:
            self._foldable_layout.removeWidget(self._choice_options_editor)
            self._choice_options_editor.deleteLater()
            self._choice_options_editor = None
        if self._random_above_editor is not None:
            self._foldable_layout.removeWidget(self._random_above_editor)
            self._random_above_editor.deleteLater()
            self._random_above_editor = None
        if self._random_below_editor is not None:
            self._foldable_layout.removeWidget(self._random_below_editor)
            self._random_below_editor.deleteLater()
            self._random_below_editor = None
        if self._rule_slots_editor is not None:
            self._foldable_layout.removeWidget(self._rule_slots_editor)
            self._rule_slots_editor.deleteLater()
            self._rule_slots_editor = None

        act_type = self.type_combo.committed_type()
        schema = _PARAM_SCHEMAS.get(act_type, [])
        params = self._data.get("params", {})

        if act_type == "setNarrativeState":
            warn = QLabel("危险：绕过 Transition/conditions，仅用于调试或修复。", self)
            warn.setWordWrap(True)
            warn.setStyleSheet("color: #c62828; font-weight: 600;")
            self._params_layout.addRow(warn)

        if act_type == "moveEntityTo":
            self._rebuild_move_entity_to_params(params)
            return

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
            value_layout = compact_form(QFormLayout(value_frame))
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
                return [(f"{aid} (/resources/runtime/animation/{aid}/anim.json)", f"/resources/runtime/animation/{aid}/anim.json") for aid in ids]

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
                values = {v for _d, v in rows}
                if prefer and prefer not in values:
                    # 悬垂实体保值：追加「缺失」行，绝不静默改指第一个实体
                    rows = rows + [(f"{prefer}（缺失）", prefer)]
                    values.add(prefer)
                entity_combo.set_entries(rows)
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
                values = {v for _d, v in rows}
                if prefer and prefer not in values:
                    # 未知字段名保值（同实体悬垂处理），绝不静默改指第一个字段
                    rows = rows + [(f"{prefer}（缺失）", prefer)]
                    values.add(prefer)
                field_combo.set_entries(rows)
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
                elif fkind == "string" and picker == "portraitSlug":
                    rows = (
                        [(s, s) for s in load_portrait_sets(m.project_path)]
                        if m and m.project_path is not None
                        else []
                    ) or [("（无立绘集）", "")]
                    cur = str(raw_value or "").strip()
                    if cur and cur not in [x[1] for x in rows]:
                        rows = [(f"(数据) {cur}", cur)] + rows
                    w = FilterableTypeCombo(rows, self, select_only=True)
                    if cur:
                        w.set_committed_type(cur)
                    elif rows:
                        w.set_committed_type(rows[0][1])
                    w.typeCommitted.connect(lambda _t: self.changed.emit())
                    self._param_widgets["value"] = w
                    value_layout.addRow(field, w)
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

        if act_type == "setSceneEntityPosition":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            from ..editors.scene_editor import (
                SceneEntityPositionPickerDialog,
                scene_entity_xy_for_action,
            )
            tip = QLabel(
                "坐标 x/y 仅允许通过「在场景地图上选取」写入（与过场 cameraMove 同源点选），禁止手改。"
                "sceneId 默认与当前过场绑定的 targetScene 一致。",
                self,
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            m = self._ctx_model
            pr_sid = str(params.get("sceneId") or "").strip()
            pr_eid = str(params.get("entityId") or "").strip()
            pr_x = params.get("x")
            pr_y = params.get("y")
            has_pr_xy = False
            try:
                fx = float(pr_x)
                fy = float(pr_y)
                has_pr_xy = math.isfinite(fx) and math.isfinite(fy)
            except (TypeError, ValueError):
                pass

            sid0 = pr_sid
            if not sid0 and self._ctx_scene_id:
                sid0 = str(self._ctx_scene_id).strip()
            sc_w = self._make_selector("scene", sid0)
            sc_w.setToolTip("须为包含该 NPC/Hotspot 的场景；过场内默认与 targetScene 一致。")
            self._param_widgets["sceneId"] = sc_w
            self._params_layout.addRow("sceneId", sc_w)

            kind_combo = QComboBox(self)
            kind_combo.setEditable(False)
            kind_combo.addItems(["npc", "hotspot"])
            ek = str(params.get("entityKind") or "npc").strip().lower()
            kind_combo.setCurrentIndex(1 if ek == "hotspot" else 0)
            kind_combo.currentTextChanged.connect(lambda _t: self.changed.emit())
            self._param_widgets["entityKind"] = kind_combo
            self._params_layout.addRow("entityKind", kind_combo)

            ent_w = FilterableTypeCombo([], self, select_only=True)
            self._param_widgets["entityId"] = ent_w
            self._params_layout.addRow("entityId", ent_w)

            sx = QDoubleSpinBox(self)
            sx.setRange(-1e9, 1e9)
            sx.setDecimals(2)
            sx.setReadOnly(True)
            sx.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
            sx.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            sy = QDoubleSpinBox(self)
            sy.setRange(-1e9, 1e9)
            sy.setDecimals(2)
            sy.setReadOnly(True)
            sy.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
            sy.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            self._param_widgets["x"] = sx
            self._param_widgets["y"] = sy
            self._params_layout.addRow("x（点选写入）", sx)
            self._params_layout.addRow("y（点选写入）", sy)

            pick_btn = QPushButton("在场景地图上选取坐标…", self)

            def _apply_xy_for_selection() -> None:
                sid = sc_w.current_id().strip()
                kind = kind_combo.currentText().strip()
                eid = ent_w.committed_type().strip()
                if (
                    has_pr_xy
                    and pr_sid
                    and pr_eid
                    and sid == pr_sid
                    and eid == pr_eid
                ):
                    try:
                        sx.setValue(float(pr_x))
                        sy.setValue(float(pr_y))
                    except (TypeError, ValueError):
                        pass
                else:
                    nx, ny = scene_entity_xy_for_action(m, sid, kind, eid)
                    sx.setValue(nx)
                    sy.setValue(ny)

            def _refill_entities_sep(_: str = "") -> None:
                sid = sc_w.current_id().strip()
                kind = kind_combo.currentText().strip()
                raw_rows = m.entity_ids_for_scene(sid, kind) if m else []
                rows = [(f"{eid} ({label})", eid) for eid, label in raw_rows]
                if not rows:
                    rows = [("（当前场景无实体）", "")]
                cur = ent_w.committed_type().strip()
                vals = {v for _d, v in rows}
                keep = cur if cur in vals else (pr_eid if pr_eid and pr_eid in vals else "")
                if not keep:
                    dangling = cur or pr_eid
                    if dangling:
                        # 悬垂实体保值：追加「缺失」行；_apply_xy_for_selection 因 eid==pr_eid
                        # 会还原原存 x/y，不再用别的实体坐标覆盖
                        rows = rows + [(f"{dangling}（缺失）", dangling)]
                        vals.add(dangling)
                        keep = dangling
                ent_w.set_entries(rows)
                ent_w.set_committed_type(keep if keep else rows[0][1])
                _apply_xy_for_selection()
                self.changed.emit()

            def on_pick() -> None:
                sid = sc_w.current_id().strip()
                if not sid:
                    QMessageBox.warning(self, "选取坐标", "请先选择 sceneId。")
                    return
                kind = kind_combo.currentText().strip()
                eid = ent_w.committed_type().strip()
                if not eid:
                    QMessageBox.warning(self, "选取坐标", "请先选择 entityId。")
                    return
                dlg = SceneEntityPositionPickerDialog(
                    m, sid, kind, eid, sx.value(), sy.value(), self,
                )
                if dlg.exec() == QDialog.DialogCode.Accepted:
                    px, py = dlg.picked_xy()
                    sx.setValue(px)
                    sy.setValue(py)
                    self.changed.emit()

            pick_btn.clicked.connect(on_pick)
            self._params_layout.addRow("", pick_btn)

            sc_w.value_changed.connect(_refill_entities_sep)
            kind_combo.currentTextChanged.connect(_refill_entities_sep)
            ent_w.typeCommitted.connect(_refill_entities_sep)
            _refill_entities_sep()
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
                _refill_scoped_combo_preserve(id_combo, rows)
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

        if act_type == "tempSetHotspotDisplayFacing":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "仅运行时：临时覆盖热点展示朝向，不改场景 JSON/Save/displayImage。"
                " 离开场景或重新加载后失效；朝向 restore 时恢复为数据中 facing。",
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
            elif hs_rows and hs_rows[0][1]:
                id_combo.set_committed_type(hs_rows[0][1])

            def _refill_hotspots_fac(_t: str = "") -> None:
                raw_rows = m.hotspot_ids_for_scene(scene_combo.committed_type()) if m else []
                rows = [(f"{hid} ({label})", hid) for hid, label in raw_rows]
                if not rows:
                    rows = [("（当前场景无热点）", "")]
                _refill_scoped_combo_preserve(id_combo, rows)
                self.changed.emit()

            scene_combo.typeCommitted.connect(_refill_hotspots_fac)
            id_combo.typeCommitted.connect(lambda _v: self.changed.emit())
            self._param_widgets["hotspotId"] = id_combo
            self._params_layout.addRow("hotspotId", id_combo)
            fac_raw = str(params.get("facing") or "").strip().lower()
            fac_v = fac_raw if fac_raw in ("left", "right", "restore") else "restore"
            fac_rows = [
                ("恢复到数据朝向（restore）", "restore"),
                ("朝左（临时）", "left"),
                ("朝右（临时）", "right"),
            ]
            fac_combo = FilterableTypeCombo(fac_rows, self, select_only=True)
            fac_combo.set_committed_type(fac_v if fac_v in ("left", "right", "restore") else "restore")
            fac_combo.typeCommitted.connect(lambda _v: self.changed.emit())
            self._param_widgets["facing"] = fac_combo
            self._params_layout.addRow("facing", fac_combo)
            self._sync_foldable_visibility()
            return

        if act_type == "persistHotspotEnabled":
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            tip = QLabel(
                "写入 Hotspot enabled 的 Save 字段覆盖；与其他 persist* 一样随 sceneMemory 存盘；"
                "目标场景未加载时进入该场景后也会合并。",
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
            elif hs_rows and hs_rows[0][1]:
                id_combo.set_committed_type(hs_rows[0][1])

            def _refill_hotspots_pe(_t: str = "") -> None:
                raw_rows = m.hotspot_ids_for_scene(scene_combo.committed_type()) if m else []
                rows = [(f"{hid} ({label})", hid) for hid, label in raw_rows]
                if not rows:
                    rows = [("（当前场景无热点）", "")]
                _refill_scoped_combo_preserve(id_combo, rows)
                self.changed.emit()

            scene_combo.typeCommitted.connect(_refill_hotspots_pe)
            id_combo.typeCommitted.connect(lambda _v: self.changed.emit())
            self._param_widgets["hotspotId"] = id_combo
            self._params_layout.addRow("hotspotId", id_combo)
            en_cb = QCheckBox("enabled（显示/可交互）", self)
            en_raw = params.get("enabled", True)
            if isinstance(en_raw, bool):
                en_cb.setChecked(en_raw)
            elif isinstance(en_raw, (int, float)):
                en_cb.setChecked(en_raw != 0)
            else:
                sv = str(en_raw).strip().lower()
                en_cb.setChecked(sv not in ("false", "0", ""))
            en_cb.stateChanged.connect(lambda _s: self.changed.emit())
            self._param_widgets["enabled"] = en_cb
            self._params_layout.addRow("enabled", en_cb)
            self._sync_foldable_visibility()
            return

        if act_type in ("setZoneEnabled", "persistZoneEnabled"):
            self._rebuild_zone_enable_params(params, persist=(act_type == "persistZoneEnabled"))
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
            _tag_content_universe(sid_combo, "scenarios")
            self._param_widgets["scenarioId"] = sid_combo
            self._params_layout.addRow("scenarioId", sid_combo)

            phase_combo = QComboBox(self)
            # 非 editable：避免构造时创建 QComboBoxPrivateContainer 顶层弹窗；
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
                status_combo.addItem(st, st)
            st_val = str(params.get("status") or "pending").strip() or "pending"
            i = status_combo.findData(st_val)
            if i >= 0:
                status_combo.setCurrentIndex(i)
            else:
                # userData 存真实值：展示带"(非枚举)"前缀，写盘取 currentData 原值不污染
                status_combo.addItem(f"(非枚举) {st_val}", st_val)
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

        if act_type in ("startScenario", "activateScenario", "completeScenario"):
            self._params_frame.setVisible(True)
            while self._params_layout.rowCount() > 0:
                self._params_layout.removeRow(0)
            self._param_widgets.clear()
            if act_type == "startScenario":
                tip = QLabel(
                    "仅校验 scenarios.json 中本条线的进线 requires；不写入 phase。"
                    "未满足时与首次 setScenarioPhase 相同：抛出 ScenarioLineEntryRequiresError。"
                    "可放在图入口的 runActions 最前。",
                    self,
                )
                tip.setToolTip("与 setScenarioPhase 的进线检查一致，用于显式表达剧情起点。")
            elif act_type == "activateScenario":
                tip = QLabel(
                    "若该 scenario 在 scenarios.json 中勾选了整条线手动生命周期："
                    "校验进线 requires 并将线标记为「进行」，之后方可 setScenarioPhase；"
                    "未勾选时本条 Action 在运行时为 no-op。",
                    self,
                )
                tip.setToolTip(
                    "与 startScenario 一样会校验 catalog.requires；另行写入线生命周期状态并进档。",
                )
            else:
                tip = QLabel(
                    "将整条线标记为「已完成」，之后禁止对该 scenario 再 setScenarioPhase；"
                    "仅对勾选手动生命周期的 scenario 生效，否则运行时 no-op。",
                    self,
                )
                tip.setToolTip("通常放在该 narrative 线段收尾剧情之后。")
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
            _tag_content_universe(sid_combo, "scenarios")
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
            _tag_content_universe(doc_combo, "documents")
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
            # 预览是辅助查看面板，默认折叠，避免常驻占大块固定区域。
            _bprev_sec = CollapsibleSection("过渡预览（Qt 近似）", start_open=False)
            _bprev_sec.add_body(bprev)
            self._params_layout.addRow(_bprev_sec)
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
                "graphId 对应 dialogues/graphs 下 .json；entry 选节点 id；npcId 用于说话人显示名。"
                "ownerType/ownerId 供 OwnerStateNode 解析实体 wrapper（仅 npcId 时默认 ownerType=npc）。",
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
            _tag_content_universe(gid_combo, "dialogue_graphs")
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

            nid = IdRefSelector(self, allow_empty=True, editable=True)
            nid.setMinimumWidth(160)
            nid.set_items(npc_items_for_dialogue_picker(self._ctx_model, self._ctx_scene_id))
            nid.set_current(str(params.get("npcId", "") or ""))
            nid.value_changed.connect(self.changed)
            nid.setToolTip(
                "解析 {{npc}} 显示名用；有场景上下文时优先场景 NPC，否则列出全局 NPC。",
            )
            self._param_widgets["npcId"] = nid
            self._params_layout.addRow("npcId（可选）", nid)

            owner_type = QLineEdit(str(params.get("ownerType", "") or ""), self)
            owner_type.setPlaceholderText("npc / hotspot / zone …")
            owner_type.textChanged.connect(self.changed)
            self._param_widgets["ownerType"] = owner_type
            self._params_layout.addRow("ownerType（可选）", owner_type)

            owner_id = QLineEdit(str(params.get("ownerId", "") or ""), self)
            owner_id.setPlaceholderText("实体 id；缺省同 npcId")
            owner_id.textChanged.connect(self.changed)
            self._param_widgets["ownerId"] = owner_id
            self._params_layout.addRow("ownerId（可选）", owner_id)

            dim_cb = QCheckBox("对话期间压暗场景背景", self)
            dim_cb.setChecked(params.get("dimBackground") is True)
            dim_cb.setToolTip("勾选后本次对话全程压一层 25% 暗幕托出立绘与面板；默认不压。")
            dim_cb.toggled.connect(self.changed)
            self._param_widgets["dimBackground"] = dim_cb
            self._params_layout.addRow("dimBackground", dim_cb)
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
            snpc = IdRefSelector(self, allow_empty=True, editable=True)
            snpc.setMinimumWidth(160)
            snpc.set_items(npc_items_for_dialogue_picker(self._ctx_model, self._ctx_scene_id))
            snpc.set_current(str(params.get("scriptedNpcId", "") or ""))
            snpc.value_changed.connect(self.changed)
            snpc.setToolTip("供 speaker 中 {{npc}} 使用；图对话 runActions 时也可用图内 npcId。")
            self._param_widgets["scriptedNpcId"] = snpc
            self._params_layout.addRow("scriptedNpcId（{{npc}} 默认）", snpc)

            dim_cb = QCheckBox("对话期间压暗场景背景", self)
            dim_cb.setChecked(params.get("dimBackground") is True)
            dim_cb.setToolTip("勾选后本段脚本台词全程压一层 25% 暗幕托出立绘与面板；默认不压。")
            dim_cb.toggled.connect(self.changed)
            self._param_widgets["dimBackground"] = dim_cb
            self._params_layout.addRow("dimBackground", dim_cb)

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

        if act_type == "runActions":
            self._params_frame.setVisible(False)
            ed = ActionEditor("actions", self)
            ed.set_project_context(
                self._ctx_model,
                self._ctx_scene_id,
                cutscene_id=self._ctx_cutscene_id,
            )
            if self._wheel_speech_role_rows_getter:
                ed.set_wheel_speech_role_rows_getter(self._wheel_speech_role_rows_getter)
            raw_actions = params.get("actions", [])
            ed.set_data(list(raw_actions) if isinstance(raw_actions, list) else [])
            ed.changed.connect(self.changed)
            self._run_actions_editor = ed
            self._foldable_layout.addWidget(ed)
            self._sync_foldable_visibility()
            return

        if act_type == "chooseAction":
            self._params_frame.setVisible(True)
            tip = QLabel("玩家选项；选择某项后执行该项内的 actions。", self)
            tip.setWordWrap(True)
            tip.setToolTip(
                "prompt 可为空；工程打开时在 prompt 一行点「引用」可插入 [tag:…]，"
                "与 options 条目中的 text 相同，运行时均经 resolveDisplayText。"
                "Esc 取消仅在 allowCancel=true 时生效，取消后不执行任何选项。",
            )
            self._params_layout.addRow(tip)
            pr = params.get("prompt", "")
            ps = str(pr) if pr is not None else ""
            if self._ctx_model is not None:
                prompt_edit = RichTextLineEdit(self._ctx_model, self)
                prompt_edit.setText(ps)
                prompt_edit.setPlaceholderText("选项提示（可留空，可插入项目引用）")
                prompt_edit.textChanged.connect(lambda _s: self.changed.emit())
            else:
                prompt_edit = QLineEdit(ps, self)
                prompt_edit.setPlaceholderText("选项提示（可留空；打开工程后可插入引用）")
                prompt_edit.textChanged.connect(self.changed)
            self._param_widgets["prompt"] = prompt_edit
            self._params_layout.addRow("prompt", prompt_edit)

            allow_raw = params.get("allowCancel", False)
            if isinstance(allow_raw, bool):
                allow_cancel = allow_raw
            elif isinstance(allow_raw, (int, float)):
                allow_cancel = allow_raw != 0
            else:
                sv = str(allow_raw).strip().lower()
                allow_cancel = sv not in ("false", "0", "")
            allow_cb = QCheckBox("允许 Esc / 关闭取消（无选项执行）", self)
            allow_cb.setChecked(bool(allow_cancel))
            allow_cb.stateChanged.connect(self.changed)
            self._param_widgets["allowCancel"] = allow_cb
            self._params_layout.addRow("allowCancel", allow_cb)
            opts_raw = params.get("options", [])
            ed = ActionChoiceOptionsEditor(
                self._ctx_model,
                self._ctx_scene_id,
                self._ctx_cutscene_id,
                opts_raw if isinstance(opts_raw, list) else [],
                self,
                wheel_speech_role_rows_getter=self._wheel_speech_role_rows_getter,
            )
            ed.changed.connect(self.changed)
            self._choice_options_editor = ed
            self._foldable_layout.addWidget(ed)
            self._sync_foldable_visibility()
            return

        if act_type == "randomBranch":
            self._params_frame.setVisible(True)
            tip = QLabel(
                "均匀采样 r∈[0,1)。若 r > probability 执行分支 A，否则执行分支 B。"
                "probability 为阈值（0～1），运行时会把非法值按 0.5 再夹到 0～1。",
                self,
            )
            tip.setWordWrap(True)
            self._params_layout.addRow(tip)
            prob_spin = QDoubleSpinBox(self)
            prob_spin.setRange(0.0, 1.0)
            prob_spin.setDecimals(4)
            prob_spin.setSingleStep(0.05)
            pv = params.get("probability", 0.5)
            try:
                pvf = float(pv)
                if not math.isfinite(pvf):
                    pvf = 0.5
            except (TypeError, ValueError):
                pvf = 0.5
            prob_spin.setValue(min(1.0, max(0.0, pvf)))
            prob_spin.valueChanged.connect(self.changed)
            self._param_widgets["probability"] = prob_spin
            self._params_layout.addRow("probability（阈值）", prob_spin)

            ed_a = ActionEditor("分支 A（r > probability）", self)
            ed_a.set_project_context(
                self._ctx_model,
                self._ctx_scene_id,
                cutscene_id=self._ctx_cutscene_id,
            )
            if self._wheel_speech_role_rows_getter:
                ed_a.set_wheel_speech_role_rows_getter(self._wheel_speech_role_rows_getter)
            raw_a = params.get("aboveActions", [])
            ed_a.set_data(list(raw_a) if isinstance(raw_a, list) else [])
            ed_a.changed.connect(self.changed)
            self._random_above_editor = ed_a
            self._foldable_layout.addWidget(ed_a)

            ed_b = ActionEditor("分支 B（r ≤ probability）", self)
            ed_b.set_project_context(
                self._ctx_model,
                self._ctx_scene_id,
                cutscene_id=self._ctx_cutscene_id,
            )
            if self._wheel_speech_role_rows_getter:
                ed_b.set_wheel_speech_role_rows_getter(self._wheel_speech_role_rows_getter)
            raw_b = params.get("belowActions", [])
            ed_b.set_data(list(raw_b) if isinstance(raw_b, list) else [])
            ed_b.changed.connect(self.changed)
            self._random_below_editor = ed_b
            self._foldable_layout.addWidget(ed_b)
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
            bid = IdRefSelector(self, allow_empty=True, editable=True)
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
                ("（留空：仅用 bundleId）", ""),
            ] + list(man_entries)
            man_combo = FilterableTypeCombo(man_rows, self, select_only=True)
            if am:
                man_combo.set_committed_type(am)
            else:
                man_combo.set_committed_type("")
            self._param_widgets["animManifest"] = man_combo
            self._params_layout.addRow("animManifest", man_combo)

            def _state_items_for_bundle(stem: str) -> list[tuple[str, str]]:
                rows: list[tuple[str, str]] = [("（留空=逻辑名）", "")]
                if not m or not stem:
                    return rows
                names = m.animation_state_names_for_manifest(f"/resources/runtime/animation/{stem}/anim.json")
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

            # 装扮配置的对话头像立绘集：留空=按动画包目录名同名推导（主角头像跟配置走）
            por_rows: list[tuple[str, str]] = [("（按动画包同名推导）", "")]
            if m and m.project_path is not None:
                por_rows += [(s, s) for s in load_portrait_sets(m.project_path)]
            por0 = str(params.get("portraitSlug", "") or "").strip()
            if por0 and por0 not in [x[1] for x in por_rows]:
                por_rows = [(f"(数据) {por0}", por0)] + por_rows
            por_combo = FilterableTypeCombo(por_rows, self, select_only=True)
            por_combo.set_committed_type(por0)
            por_combo.setToolTip(
                "本套装扮配置的对话头像立绘集（dialogue_portraits/<slug>/）。\n"
                "留空 = 按动画包目录名同名推导（如 player_taoist_anim）。"
            )
            self._param_widgets["portraitSlug"] = por_combo
            self._params_layout.addRow("portraitSlug", por_combo)
            por_combo.typeCommitted.connect(lambda _t: self.changed.emit())

            def on_bundle_changed(_v: str = "") -> None:
                stem = bid.current_id().strip()
                if stem and m:
                    path = f"/resources/runtime/animation/{stem}/anim.json"
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
            if act_type == "removeCurrency" and pname == "amount":
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    fv = float(val)
                    ps = str(int(fv)) if fv.is_integer() else str(val)
                else:
                    ps = str(val) if val is not None else ""
                if self._ctx_model is not None:
                    w = RichTextLineEdit(self._ctx_model, self)
                    w.setText(ps)
                    w.setPlaceholderText("扣除数量：纯数字或「引用」插入 [tag:…]（运行时解析后取整）")
                    w.setToolTip(
                        "保存为字符串；运行时先 resolveDisplayText 再 Number 解析并 trunc。"
                        "空串、非数字、负数将跳过扣除并打印 warn。",
                    )
                    w.textChanged.connect(lambda _s: self.changed.emit())
                else:
                    w = QLineEdit(ps, self)
                    w.setPlaceholderText("打开工程后可用「引用」插 [tag:…]")
                    w.textChanged.connect(self.changed)
            elif ptype == "int":
                w = QSpinBox(self)
                w.setRange(-999999, 999999)
                seed = _ACTION_PARAM_RUNTIME_DEFAULTS.get((act_type, pname), 0)
                try:
                    # float-first：脏数据 "3.5" 不再崩（展开即抛 ValueError），按截断显示
                    w.setValue(int(float(val)) if val != "" else int(seed))
                except (TypeError, ValueError):
                    w.setValue(int(seed))
                if act_type == "playNpcAnimation" and pname == "holdFrame":
                    w.setToolTip(
                        "定格帧：≥0 时切到该状态并停在此帧（0 基，越界按帧数取模），不推进播放——\n"
                        "把片段任意一帧当 pose 用。-1=不定格（缺省，不写键）。\n"
                        "定格时 speed/reverse/thenState 不生效。",
                    )
                w.valueChanged.connect(self.changed)
            elif ptype == "float":
                w = QDoubleSpinBox(self)
                if act_type in (
                    "showEmote",
                    "showEmoteAndWait",
                    "showSpeechBubble",
                    "showSpeechBubbleAndWait",
                ) and pname == "duration":
                    w.setRange(0, 9999999)
                    w.setDecimals(0)
                    w.setSingleStep(50)
                    try:
                        w.setValue(float(val) if val != "" else 1500)
                    except (TypeError, ValueError):
                        w.setValue(1500.0)
                elif act_type in (
                    "showEmote",
                    "showEmoteAndWait",
                    "showSpeechBubble",
                    "showSpeechBubbleAndWait",
                ) and pname in (
                    "anchorOffsetX",
                    "anchorOffsetY",
                ):
                    w.setRange(-500.0, 500.0)
                    w.setDecimals(2)
                    w.setSingleStep(1)
                    try:
                        w.setValue(float(val))
                    except (TypeError, ValueError):
                        w.setValue(0.0)
                elif act_type == "sugarWheelResetPointer" and pname == "angleDeg":
                    w.setRange(-10000.0, 10000.0)
                    w.setDecimals(2)
                    w.setSingleStep(1)
                    try:
                        w.setValue(float(val) if val != "" else 0.0)
                    except (TypeError, ValueError):
                        w.setValue(0.0)
                elif act_type == "cutsceneSpawnActor" and pname in ("x", "y"):
                    # 出生点是世界坐标（可达数千），不能用下面 ±50 的偏移量程，否则会被 clamp 成
                    # 50 造成坐标丢失。给足世界坐标量程，小数位与既有数据一致。
                    w.setRange(-1000000.0, 1000000.0)
                    w.setDecimals(2)
                    w.setSingleStep(10)
                    try:
                        w.setValue(float(val) if val != "" else 0.0)
                    except (TypeError, ValueError):
                        w.setValue(0.0)
                elif act_type == "playNpcAnimation" and pname == "speed":
                    # 播放倍率：seed 1.0（运行时默认原速），量程与 SpriteEntity 夹取一致
                    w.setRange(0.1, 10.0)
                    w.setDecimals(2)
                    w.setSingleStep(0.1)
                    try:
                        w.setValue(float(val) if val != "" else 1.0)
                    except (TypeError, ValueError):
                        w.setValue(1.0)
                    w.setToolTip(
                        "播放速度倍率（乘在该状态 frameRate 上）：1=原速、2=两倍速、0.5=半速。\n"
                        "保持 1 不写键（沿用运行时默认）。",
                    )
                else:
                    # 泛型 float 量程必须容纳世界坐标/大数值（persistNpcAt x/y、addFlagValue delta、
                    # setSceneDepthFloorOffset 等曾被旧 ±50 量程 clamp 毁值）——一律给足量程。
                    w.setRange(-1000000.0, 1000000.0)
                    w.setDecimals(4)
                    w.setSingleStep(0.05)
                    try:
                        w.setValue(float(val))
                    except (TypeError, ValueError):
                        w.setValue(0.0)
                w.valueChanged.connect(self.changed)
            elif ptype == "bool":
                w = QCheckBox(self)
                # 字符串 "false"/"0" 必须解析为 False（运行时同语义），不能 bool("false")→True
                w.setChecked(_coerce_bool_param(val))
                if act_type == "giveItem" and pname == "critical":
                    w.setToolTip(
                        "关键给予：背包满时绕过 12 槽上限也要给到手。\n"
                        "剧情必得道具（分支按 flag 推进、不可再入）勾这个，防止满包时道具永久丢失。"
                    )
                if act_type == "playNpcAnimation" and pname == "reverse":
                    w.setToolTip(
                        "倒放：从末帧向首帧播放；非循环片段在首帧完成（停在首帧）。\n"
                        "可把开门/起身等动画当关门/坐下复用。缺省不写键。"
                    )
                w.stateChanged.connect(self.changed)
            elif ptype == "flag_val":
                w = FlagValueEdit(self, self._ctx_model.flag_registry if self._ctx_model else {})
                if act_type not in ("setFlag",):
                    w.set_value(val if val != "" else True)
                w.valueChanged.connect(self.changed)
            elif act_type in ("setFlag", "appendFlag", "addFlagValue") and pname == "key":
                # addFlagValue.key 与 setFlag/appendFlag 同为 flag 键引用（CONTENT_ID_PARAMS 登记）：
                # 手打错=运行时静默在错误 flag 上加数值，validator 抓不到。统一走登记表选择器。
                cur = str(val) if val is not None else ""
                w = FlagKeyPickField(self._ctx_model, self._ctx_scene_id, cur, self)
                w.setMinimumWidth(96)
                _tag_content_universe(w, "__flag__")
            elif act_type in ("startNarrativeRun", "resetNarrativeRun", "revertNarrativeRun", "activateNarrativeRun") and pname == "graphId":
                # 活计图引用（选择器铁律；候选=声明了 run 的图，保值展示未知值）
                w = self._make_selector("narrative_run_archetype", str(val) if val is not None else "")
            elif act_type == "startPressureHold" and pname == "id":
                w = self._make_selector("pressure_hold", str(val) if val is not None else "")
            elif act_type == "playSignalCue" and pname == "id":
                w = self._make_selector("signal_cue", str(val) if val is not None else "")
            elif act_type in ("switchScene", "changeScene") and pname == "targetScene":
                w = self._make_selector("scene", str(val) if val is not None else "")
            elif act_type in ("switchScene", "changeScene") and pname == "targetSpawnPoint":
                w = self._make_selector("spawn", str(val) if val is not None else "")
            elif act_type == "setSmell" and pname == "scent":
                w = self._make_selector("smell", str(val) if val is not None else "")
            elif act_type == "activatePlane" and pname == "id":
                w = self._make_selector("plane", str(val) if val is not None else "")
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
            elif act_type == "stopSceneAmbient" and pname == "id":
                w = self._make_selector("audio_ambient", str(val) if val is not None else "")
                w.setToolTip(
                    "可选：留空 = 清掉全部场景环境音层；选 id = 只停该层。"
                    "列表来自 audio_config.ambient，右侧按钮可试听。",
                )
            elif act_type == "startCutscene" and pname == "id":
                w = self._make_selector("cutscene", str(val) if val is not None else "")
            elif act_type == "startWaterMinigame" and pname == "id":
                w = self._make_selector("water_minigame", str(val) if val is not None else "")
            elif act_type == "startSugarWheelMinigame" and pname == "id":
                w = self._make_selector(
                    "sugar_wheel_minigame", str(val) if val is not None else "",
                )
            elif act_type == "startPaperCraftMinigame" and pname == "id":
                w = self._make_selector(
                    "paper_craft_minigame", str(val) if val is not None else "",
                )
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
                w = IdRefSelector(self, allow_empty=True, editable=True)
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
                _tag_content_universe(w, "archive_entries")
            elif act_type == "showNotification" and pname == "type":
                w = QComboBox(self)
                # 非 editable：notification type 是固定枚举，不需要手写；同时避免顶层弹窗闪烁。
                w.setEditable(False)
                for _nt in _NOTIFICATION_TYPES:
                    w.addItem(_nt, _nt)
                tv = str(val) if val is not None else "info"
                i = w.findData(tv)
                if i >= 0:
                    w.setCurrentIndex(i)
                else:
                    # userData 存真实值：展示带前缀，写盘取 currentData 原值不污染
                    w.addItem(f"(非枚举) {tv}", tv)
                    w.setCurrentIndex(w.count() - 1)
                w.currentIndexChanged.connect(lambda _i: self.changed.emit())
            elif act_type == "emitNarrativeSignal" and pname == "signal":
                cur = str(val) if val is not None else ""
                w = NarrativeSignalPickerField(self._ctx_model, cur, self)
                w.setToolTip(
                    "只能通过信号管理器填写；管理器直接维护 narrative_graphs.signals。"
                )
                w.valueChanged.connect(lambda _t: self.changed.emit())
                _tag_content_universe(w, "narrative_signals")
            elif act_type == "showEmote" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
                w.setToolTip(
                    "选 NPC、热点 id 或 player；热点气泡锚在展示 sprite 四边形顶边（与 NPC 语义一致），"
                    "可用 anchorOffset 微调。列表依赖当前 Action 场景上下文。",
                )
            elif act_type == "showEmote" and pname == "emote":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "showEmoteAndWait" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
                w.setToolTip(
                    "选 NPC、热点、player 或过场 _cut_*；热点锚在展示贴图顶边，可用 anchorOffset 微调。",
                )
            elif act_type == "showEmoteAndWait" and pname == "emote":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "showSpeechBubble" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
                w.setToolTip(
                    "与 showEmote 相同：NPC、热点 id 或 player；对白气泡锚在展示图上沿。",
                )
            elif act_type == "showSpeechBubble" and pname == "text":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "showSpeechBubbleAndWait" and pname == "target":
                w = self._make_selector("emote_target", str(val) if val is not None else "")
                w.setToolTip(
                    "与 showEmoteAndWait 相同：NPC、热点、player、过场 _cut_*。",
                )
            elif act_type == "showSpeechBubbleAndWait" and pname == "text":
                w = EmoteBubbleParamWidget(
                    self,
                    self._ctx_model,
                    str(val) if val is not None else "",
                    lambda: self.changed.emit(),
                )
            elif act_type == "playNpcAnimation" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "playNpcAnimation" and pname == "state":
                w = FilterableTypeCombo([("（选 state）", "")], self, select_only=True)
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "playNpcAnimation" and pname == "thenState":
                w = FilterableTypeCombo([("（播完不切换）", "")], self, select_only=True)
                w.setToolTip(
                    "非循环片段播完后自动切换到的状态（如一次性动作播完自动回 idle）。\n"
                    "循环片段与定格（holdFrame≥0）时不生效；留空不写键。",
                )
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
                w = FilterableTypeCombo([("（选 state）", "")], self, select_only=True)
                w.typeCommitted.connect(lambda _t: self.changed.emit())
            elif act_type == "hideOverlayImage" and pname == "id":
                w = self._build_overlay_id_combo(str(val) if val is not None else "")
            elif act_type == "faceEntity" and pname == "target":
                w = self._make_selector("actor", str(val) if val is not None else "")
            elif act_type == "faceEntity" and pname == "direction":
                dir_rows = [("（用 faceTarget）", "")] + [(d, d) for d in _FACE_DIRECTIONS]
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
                w.textChanged.connect(lambda *_: self.changed.emit())
            elif act_type in ("sugarWheelShowSpeech", "sugarWheelDismissSpeech") and pname == "role":
                rows = self._compose_wheel_speech_role_rows()
                cur = str(val if val is not None else "").strip()
                w = FilterableTypeCombo(rows, self, select_only=True)
                w.setToolTip(
                    "与转盘 speechAnchors 合并预设后的 role（在「转盘小游戏」编辑器中）"
                    "；其余页面仅显示六项内置 role。"
                )
                w.set_committed_type(cur)
                w.typeCommitted.connect(lambda _t: self.changed.emit())
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
                initial_then=str(params.get("thenState", "") or ""),
            )
        if act_type in ("persistNpcAnimState", "persistPlayNpcAnimation"):
            self._connect_persist_npc_anim_state_pickers(
                initial_state=str(params.get("state", "") or ""),
            )

        if act_type == "playSfx":
            # 可选音量：1=素材原始；<1 调小；>1 调大（顶到系统满幅上限，浏览器音频封顶 1.0，
            # 默认全局 SFX=0.8 时约有 +25% 余量）。设为 1 不写键，保持数据干净。
            orig_vol = params.get("volume")
            self._playsfx_volume_orig = orig_vol
            try:
                vol_init = float(orig_vol) if orig_vol is not None else 1.0
            except (TypeError, ValueError):
                vol_init = 1.0
            vol_init = max(0.0, min(4.0, vol_init))
            vw = QDoubleSpinBox(self)
            vw.setRange(0.0, 4.0)
            vw.setDecimals(2)
            vw.setSingleStep(0.05)
            vw.setValue(vol_init)
            vw.setMaximumWidth(96)
            vw.setToolTip(
                "音效音量：1=素材原始音量（会再乘全局 SFX 音量）；<1 调小、>1 调大。"
                "调大只能顶到系统满幅（浏览器封顶 1.0）——默认全局 SFX 0.8 时约有 +25% 余量，"
                "若素材本身偏轻需另行放大音频文件。设为 1 时不写入 volume 键。"
            )
            vw.valueChanged.connect(self.changed)
            self._param_widgets["volume"] = vw
            self._params_layout.addRow("音量", vw)
            # volume 由本 GUI 全权管理：从透传集合摘除，避免 to_dict 末尾按原值把它塞回。
            if isinstance(self._original_params, dict):
                self._original_params.pop("volume", None)

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
            if self._wheel_speech_role_rows_getter:
                ed.set_wheel_speech_role_rows_getter(self._wheel_speech_role_rows_getter)
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

    def _to_dict_temp_set_hotspot_display_facing(self) -> dict:
        scene_w = self._param_widgets.get("sceneId")
        id_w = self._param_widgets.get("hotspotId")
        fac_w = self._param_widgets.get("facing")
        sid = scene_w.committed_type().strip() if isinstance(scene_w, FilterableTypeCombo) else ""
        hid = id_w.committed_type().strip() if isinstance(id_w, FilterableTypeCombo) else ""
        fv = fac_w.committed_type().strip().lower() if isinstance(fac_w, FilterableTypeCombo) else "restore"
        if fv not in ("left", "right", "restore"):
            fv = "restore"
        return {
            "type": "tempSetHotspotDisplayFacing",
            "params": {"sceneId": sid, "hotspotId": hid, "facing": fv},
        }

    def _rebuild_zone_enable_params(self, params: dict, *, persist: bool) -> None:
        self._params_frame.setVisible(True)
        while self._params_layout.rowCount() > 0:
            self._params_layout.removeRow(0)
        self._param_widgets.clear()
        tip_txt = (
            "写入 standard Zone 的启用状态到 sceneMemory（随存档）；"
            "禁用后该区不进入 ZoneSystem；depth_floor 不受影响且不可被本动作关闭。"
            if persist
            else
            "仅当前游戏进程内开关 standard Zone（不写档）；读档或重启后按存档与 JSON 恢复；"
            "depth_floor 不受影响。"
        )
        tip = QLabel(tip_txt, self)
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
        zn_raw = m.standard_zone_ids_for_scene(scene_combo.committed_type()) if m else []
        zn_rows = [(f"{zid}（zone）", zid) for zid, _ in zn_raw]
        if not zn_rows:
            zn_rows = [("（当前场景无普通 Zone）", "")]
        id_combo = FilterableTypeCombo(zn_rows, self, select_only=True)
        cur_z = str(params.get("zoneId", "") or "").strip()
        if cur_z:
            id_combo.set_committed_type(cur_z)
        elif zn_rows and zn_rows[0][1]:
            id_combo.set_committed_type(zn_rows[0][1])

        def _refill_zones_ze(_t: str = "") -> None:
            raw_rows = m.standard_zone_ids_for_scene(scene_combo.committed_type()) if m else []
            rows = [(f"{zid}（zone）", zid) for zid, _ in raw_rows]
            if not rows:
                rows = [("（当前场景无普通 Zone）", "")]
            _refill_scoped_combo_preserve(id_combo, rows)
            self.changed.emit()

        scene_combo.typeCommitted.connect(_refill_zones_ze)
        id_combo.typeCommitted.connect(lambda _v: self.changed.emit())
        self._param_widgets["zoneId"] = id_combo
        self._params_layout.addRow("zoneId", id_combo)
        en_cb = QCheckBox("enabled（参与 ZoneSystem 进出与回调）", self)
        en_raw = params.get("enabled", True)
        if isinstance(en_raw, bool):
            en_cb.setChecked(en_raw)
        elif isinstance(en_raw, (int, float)):
            en_cb.setChecked(en_raw != 0)
        else:
            sv = str(en_raw).strip().lower()
            en_cb.setChecked(sv not in ("false", "0", ""))
        en_cb.stateChanged.connect(lambda _s: self.changed.emit())
        self._param_widgets["enabled"] = en_cb
        self._params_layout.addRow("enabled", en_cb)
        self._sync_foldable_visibility()

    def _to_dict_zone_enabled(self, *, persist: bool) -> dict:
        scene_w = self._param_widgets.get("sceneId")
        id_w = self._param_widgets.get("zoneId")
        en_w = self._param_widgets.get("enabled")
        sid = scene_w.committed_type().strip() if isinstance(scene_w, FilterableTypeCombo) else ""
        zid = id_w.committed_type().strip() if isinstance(id_w, FilterableTypeCombo) else ""
        en = bool(en_w.isChecked()) if isinstance(en_w, QCheckBox) else True
        typ = "persistZoneEnabled" if persist else "setZoneEnabled"
        return {"type": typ, "params": {"sceneId": sid, "zoneId": zid, "enabled": en}}

    def _to_dict_persist_hotspot_enabled(self) -> dict:
        scene_w = self._param_widgets.get("sceneId")
        id_w = self._param_widgets.get("hotspotId")
        en_w = self._param_widgets.get("enabled")
        sid = scene_w.committed_type().strip() if isinstance(scene_w, FilterableTypeCombo) else ""
        hid = id_w.committed_type().strip() if isinstance(id_w, FilterableTypeCombo) else ""
        en = bool(en_w.isChecked()) if isinstance(en_w, QCheckBox) else True
        return {
            "type": "persistHotspotEnabled",
            "params": {"sceneId": sid, "hotspotId": hid, "enabled": en},
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
        ot_w = self._param_widgets.get("ownerType")
        oi_w = self._param_widgets.get("ownerId")
        if isinstance(ot_w, QLineEdit):
            ot = ot_w.text().strip()
            if ot:
                prm["ownerType"] = ot
        if isinstance(oi_w, QLineEdit):
            oi = oi_w.text().strip()
            if oi:
                prm["ownerId"] = oi
        dim_w = self._param_widgets.get("dimBackground")
        if isinstance(dim_w, QCheckBox) and dim_w.isChecked():
            prm["dimBackground"] = True
        return {"type": "startDialogueGraph", "params": prm}

    def _to_dict_play_scripted_dialogue(self) -> dict:
        ed = self._delayed_editor
        lines = ed.to_list() if isinstance(ed, ScriptedLinesEditor) else []
        snpc_w = self._param_widgets.get("scriptedNpcId")
        sid = snpc_w.current_id().strip() if isinstance(snpc_w, IdRefSelector) else ""
        prm: dict = {"lines": lines}
        if sid:
            prm["scriptedNpcId"] = sid
        dim_w = self._param_widgets.get("dimBackground")
        if isinstance(dim_w, QCheckBox) and dim_w.isChecked():
            prm["dimBackground"] = True
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
        pw = self._param_widgets.get("portraitSlug")
        if isinstance(pw, FilterableTypeCombo):
            ps = pw.committed_type().strip()
            if ps:
                params["portraitSlug"] = ps
        return {"type": "setPlayerAvatar", "params": params}

    def _to_dict_set_scenario_phase(self) -> dict:
        sid_w = self._param_widgets.get("scenarioId")
        ph_w = self._param_widgets.get("phase")
        st_w = self._param_widgets.get("status")
        out_w = self._param_widgets.get("outcome")
        sid = sid_w.committed_type() if isinstance(sid_w, FilterableTypeCombo) else ""
        ph = ph_w.currentText().strip() if isinstance(ph_w, QComboBox) else ""
        if isinstance(st_w, QComboBox):
            st_d = st_w.currentData()
            st = str(st_d) if isinstance(st_d, str) else st_w.currentText().strip()
        else:
            st = ""
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

    def _to_dict_move_entity_to(self) -> dict:
        tgt_w = self._param_widgets.get("target")
        sc_w = self._param_widgets.get("sceneId")
        sx_v = self._param_widgets.get("x")
        sy_v = self._param_widgets.get("y")
        sp_sb = self._param_widgets.get("speed")
        st_w = self._param_widgets.get("moveAnimState")
        tgt = tgt_w.current_id().strip() if isinstance(tgt_w, IdRefSelector) else ""
        sid = sc_w.committed_type().strip() if isinstance(sc_w, FilterableTypeCombo) else ""
        xv = float(sx_v.value()) if isinstance(sx_v, QDoubleSpinBox) else 0.0
        yv = float(sy_v.value()) if isinstance(sy_v, QDoubleSpinBox) else 0.0
        spd = float(sp_sb.value()) if isinstance(sp_sb, QDoubleSpinBox) else 80.0
        if not math.isfinite(spd) or spd <= 0:
            spd = 80.0
        spd_final = round(min(spd, 9999.0), 2)
        ma = st_w.committed_type().strip() if isinstance(st_w, FilterableTypeCombo) else ""
        wp_src = getattr(self, "_move_entity_waypoints_store", None)
        wp_tuples = list(wp_src[0]) if isinstance(wp_src, list) and wp_src else []
        out_wp = [{"x": round(float(px), 2), "y": round(float(py), 2)} for px, py in wp_tuples]
        # sceneId 仅供编辑器复现地图，运行时不读（见 ActionRegistry moveEntityTo）。无场景上下文时
        # 该下拉会自动落到工程第一个场景（任意值），写出去即凭空漂移；故仅当原数据本就带 sceneId
        # 才回写（重开时 _default_map_sid 会据上下文重算）。key 顺序维持 target,[sceneId],x,y,speed。
        prm = {"target": tgt}
        if sid and "sceneId" in self._original_params:
            prm["sceneId"] = sid
        prm["x"] = round(xv, 2)
        prm["y"] = round(yv, 2)
        prm["speed"] = spd_final
        if ma:
            prm["moveAnimState"] = ma
        if out_wp:
            prm["waypoints"] = out_wp
        face_w = self._param_widgets.get("faceTowardMovement")
        if isinstance(face_w, QCheckBox) and face_w.isChecked():
            prm["faceTowardMovement"] = True
        return {"type": "moveEntityTo", "params": prm}

    def _to_dict_set_scene_entity_position(self) -> dict:
        sc_w = self._param_widgets.get("sceneId")
        k_w = self._param_widgets.get("entityKind")
        e_w = self._param_widgets.get("entityId")
        x_w = self._param_widgets.get("x")
        y_w = self._param_widgets.get("y")
        sid = sc_w.current_id().strip() if isinstance(sc_w, IdRefSelector) else ""
        kind = k_w.currentText().strip().lower() if isinstance(k_w, QComboBox) else "npc"
        if kind != "hotspot":
            kind = "npc"
        eid = e_w.committed_type().strip() if isinstance(e_w, FilterableTypeCombo) else ""
        xv = float(x_w.value()) if isinstance(x_w, QDoubleSpinBox) else 0.0
        yv = float(y_w.value()) if isinstance(y_w, QDoubleSpinBox) else 0.0
        return {
            "type": "setSceneEntityPosition",
            "params": {
                "sceneId": sid,
                "entityKind": kind,
                "entityId": eid,
                "x": round(xv, 2),
                "y": round(yv, 2),
            },
        }

    def to_dict(self) -> dict:
        result = self._to_dict_raw()
        params = result.get("params") if isinstance(result, dict) else None
        if isinstance(params, dict):
            # 1) 未改动的数值参数恢复原始 int/float 表示（1000.0 -> 1000）。
            preserve_numeric_repr(params, self._original_params)
            # 2) 剔除"原本没有、且为中性默认"的占位键（direction:""/anchorOffsetX/Y:0/allowCancel:false…）。
            for k, default in _OMIT_WHEN_ABSENT_AND_DEFAULT.items():
                if k in params and k not in self._original_params and params[k] == default:
                    cur_is_bool = isinstance(params[k], bool)
                    def_is_bool = isinstance(default, bool)
                    if cur_is_bool != def_is_bool:
                        continue  # 0==False 之类的跨类型巧合不剔
                    del params[k]
            # 3) 运行时非零默认的 int 参数（fadeMs/count/durationMs…）：原本缺该键且仍为运行时默认时
            #    不回写——既保持往返不漂移，又让运行时沿用其默认行为（用户显式设的非默认值仍保留）。
            act_type = result.get("type", "")
            for (at, pk), dv in _ACTION_PARAM_RUNTIME_DEFAULTS.items():
                if at == act_type and pk in params and pk not in self._original_params \
                        and not isinstance(params[pk], bool) and params[pk] == dv:
                    del params[pk]
        return result

    def _to_dict_raw(self) -> dict:
        act_type = self.type_combo.committed_type()
        if act_type == "setSceneEntityPosition":
            return self._to_dict_set_scene_entity_position()
        if act_type == "setEntityField":
            return self._to_dict_set_entity_field()
        if act_type == "setHotspotDisplayImage":
            return self._to_dict_set_hotspot_display_image()
        if act_type == "tempSetHotspotDisplayFacing":
            return self._to_dict_temp_set_hotspot_display_facing()
        if act_type == "persistHotspotEnabled":
            return self._to_dict_persist_hotspot_enabled()
        if act_type == "setZoneEnabled":
            return self._to_dict_zone_enabled(persist=False)
        if act_type == "persistZoneEnabled":
            return self._to_dict_zone_enabled(persist=True)
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
        if act_type in ("startScenario", "activateScenario", "completeScenario"):
            sid_w = self._param_widgets.get("scenarioId")
            sid0 = sid_w.committed_type() if isinstance(sid_w, FilterableTypeCombo) else ""
            return {"type": act_type, "params": {"scenarioId": sid0}}
        if act_type == "revealDocument":
            return self._to_dict_reveal_document()
        if act_type == "moveEntityTo":
            return self._to_dict_move_entity_to()
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
                # 不做 float() 强转：FlagValueEdit 原值保留（int 保 int、raw 保原类型）
                params[pname] = w.get_value()
            elif act_type in ("setFlag", "appendFlag", "addFlagValue") and pname == "key" and isinstance(w, FlagKeyPickField):
                params[pname] = w.key()
            elif isinstance(w, EmoteBubbleParamWidget):
                params[pname] = w.emote_text()
            elif isinstance(w, FilterableTypeCombo):
                params[pname] = w.committed_type()
            elif isinstance(w, NarrativeSignalPickerField):
                params[pname] = w.current_signal()
            elif isinstance(w, AudioIdPreviewSelector):
                params[pname] = w.current_id()
            elif isinstance(w, IdRefSelector):
                params[pname] = w.current_id()
            elif isinstance(w, QComboBox):
                # userData 优先：'(非枚举) xxx' 等展示文案不得写回 JSON
                _d = w.currentData()
                params[pname] = _d if isinstance(_d, str) else w.currentText()
            elif isinstance(w, RichTextLineEdit):
                params[pname] = w.text()
            else:
                params[pname] = w.text()
        if act_type == "enableRuleOffers" and self._rule_slots_editor is not None:
            params["slots"] = self._rule_slots_editor.to_list()
        if act_type == "addDelayedEvent" and self._delayed_editor is not None:
            params["actions"] = self._delayed_editor.to_list()
        if act_type == "runActions" and self._run_actions_editor is not None:
            params["actions"] = self._run_actions_editor.to_list()
        if act_type == "chooseAction" and self._choice_options_editor is not None:
            params["options"] = self._choice_options_editor.to_list()
        if act_type == "randomBranch":
            pw = self._param_widgets.get("probability")
            if isinstance(pw, QDoubleSpinBox):
                params["probability"] = float(pw.value())
            else:
                params["probability"] = 0.5
            params["aboveActions"] = (
                self._random_above_editor.to_list() if self._random_above_editor else []
            )
            params["belowActions"] = (
                self._random_below_editor.to_list() if self._random_below_editor else []
            )
        if act_type == "playSfx":
            vw = self._param_widgets.get("volume")
            if isinstance(vw, QDoubleSpinBox):
                v = float(vw.value())
                # 仅在偏离 1.0（原始音量）时写键；等于 1.0 → 省略，回到"素材原始音量"。
                if abs(v - 1.0) > 1e-9:
                    out = {"volume": v}
                    preserve_numeric_repr(out, {"volume": getattr(self, "_playsfx_volume_orig", None)})
                    params["volume"] = out["volume"]
        if act_type == "stopSceneAmbient":
            # id 可选："" 与缺键同义（清全部环境层）。原本没有该键且仍为空时不写出，
            # 避免旧数据"打开即注入 id:\"\""破坏往返。
            if not params.get("id") and "id" not in (self._original_params or {}):
                params.pop("id", None)

        # 运行时认识但 schema 未登记的参数（changeScene.cameraX/cameraY、legacy duration 别名、
        # sugarWheelResetPointer.angle…）：GUI 改不到它们，按原值透传——绝不"保存即删"。
        # _original_params 在类型切换时已被清空，故不会把旧类型的参数带进新类型。
        for _k, _v in (self._original_params or {}).items():
            if _k not in params:
                params[_k] = deepcopy(_v)
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
        self._wheel_speech_role_rows_getter: Callable[[], list[tuple[str, str]]] | None = None
        self._show_reorder_buttons = show_reorder_buttons
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(4)
        root.addLayout(self._rows_layout)
        # Keep action rows top-aligned even when dialog has extra height.
        self._rows_layout.addStretch(1)
        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

    def _rows_insert_index(self) -> int:
        # Last layout item is the stretch spacer added in __init__.
        return max(0, self._rows_layout.count() - 1)

    def set_project_context(
        self,
        model,
        scene_id: str | None = None,
        *,
        cutscene_id: str | None = None,
    ) -> None:
        new_cut = (
            (cutscene_id or None)
            if cutscene_id is not None
            else self._ctx_cutscene_id
        )
        if (
            model is self._ctx_model
            and scene_id == self._ctx_scene_id
            and new_cut == self._ctx_cutscene_id
        ):
            return
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        if cutscene_id is not None:
            self._ctx_cutscene_id = cutscene_id or None
        cid = self._ctx_cutscene_id
        for r in self._rows:
            r.set_project_context(model, scene_id, cutscene_id=cid)
        wg = self._wheel_speech_role_rows_getter
        if wg is not None:
            for r in self._rows:
                r.set_wheel_speech_role_rows_getter(wg)

    def set_wheel_speech_role_rows_getter(
        self,
        fn: Callable[[], list[tuple[str, str]]] | None,
    ) -> None:
        """由转盘编辑器传入；子 Action 列表、addDelayedEvent 嵌套编辑器会递归继承。"""
        self._wheel_speech_role_rows_getter = fn
        for r in self._rows:
            r.set_wheel_speech_role_rows_getter(fn)

    def refresh_wheel_speech_role_combos(self) -> None:
        for r in self._rows:
            r.refresh_wheel_speech_role_combo_if_any()
            for attr in ("_delayed_editor", "_run_actions_editor", "_random_above_editor", "_random_below_editor"):
                nested = getattr(r, attr, None)
                if isinstance(nested, ActionEditor):
                    nested.refresh_wheel_speech_role_combos()
            choice_ed = getattr(r, "_choice_options_editor", None)
            if isinstance(choice_ed, ActionChoiceOptionsEditor):
                for row in choice_ed._rows:
                    nested = row.get("ae")
                    if isinstance(nested, ActionEditor):
                        nested.refresh_wheel_speech_role_combos()

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
        # 这些组合会显式化 QComboBoxPrivateContainer 的生命周期，增加弹窗闪烁风险。

    def _add_row(self, data: dict | None = None) -> None:
        # parent=self：让 ActionRow 从构造的第一刻起就不是无 parent 的 top-level。
        row = ActionRow(
            data,
            parent=self,
            model=self._ctx_model,
            scene_id=self._ctx_scene_id,
            show_reorder_buttons=self._show_reorder_buttons,
            cutscene_id=self._ctx_cutscene_id,
            wheel_speech_role_rows_getter=self._wheel_speech_role_rows_getter,
        )
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        row.move_up.connect(lambda: self._move_row(row, -1))
        row.move_down.connect(lambda: self._move_row(row, 1))
        self._rows.append(row)
        self._rows_layout.insertWidget(self._rows_insert_index(), row)
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
            self._rows_layout.insertWidget(self._rows_insert_index(), r)
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
