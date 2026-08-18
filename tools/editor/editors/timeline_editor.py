"""过场（Cutscene）步骤序列编辑器 — `steps` schema（present / action / parallel）。

数据为自上而下顺序执行 + parallel fork-join，非 NLE 多轨时间轴。
"""
from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import TYPE_CHECKING, Any, Mapping

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QFrame, QMessageBox,
    QDialog, QGroupBox, QToolButton, QSizePolicy, QMenu, QStyle,
    QApplication, QInputDialog, QPlainTextEdit, QDialogButtonBox,
    QListWidgetItem, QAbstractItemView,
)
from PySide6.QtCore import (
    Qt, Signal, QEvent, QObject, QSignalBlocker, QTimer, QPoint, QByteArray,
    QMimeData,
)
from PySide6.QtGui import (
    QAction, QMouseEvent, QDrag, QKeySequence, QShortcut, QCursor, QColor,
)

from ..project_model import ProjectModel
from .. import theme as app_theme
from ..shared import confirm
from ..shared.bubble_anchor_field import BubbleAnchorPickField, actor_for_emote_target
from ..shared.voice_spec_field import VoiceSpecField
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.action_editor import (
    ActionRow,
    EmoteBubbleParamWidget,
    FilterableTypeCombo,
    _id_ref_rows_with_orphan,
)
from ..shared.cutscene_dialogue_speaker_row import (
    PLAYER_ENTITY_ID,
    CutsceneShowDialogueFields,
    speaker_display_names,
    speaker_is_sole_placeholder,
    speaker_placeholder_entity,
)
from ..shared.cutscene_dialogue_run_dialog import (
    DialogueRunEditorDialog,
    new_dialogue_step,
)
from ..shared.rich_text_field import RichTextTextEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap
from ..shared.fonts import MONO_FONT_FAMILY
from ..shared.form_layout import compact_form
from ..shared.numeric_roundtrip import preserve_numeric_repr
from .scene_editor import CutsceneCameraPointPickerDialog, TargetSpawnPickerDialog

_MONO_FONT_QSS = f'"{MONO_FONT_FAMILY}", "Cascadia Code", "Consolas", monospace'

# Cutscene 步骤表头拖拽排序（TimelineEditor._dnd_cutscene_step_source 存 payload）
_CUTSCENE_STEP_DRAG_MIME = "application/x-gamedraft-cutscene-step"

# 校验消息开头的层级步号（validator 的 `step #4` / `step #4.2`）：问题清单把它拆成
# 「定位」与「正文」两栏显示，正文里就不再重复步号。
_STEP_LABEL_RE = re.compile(r"^step #([\d.]+)\s+")

# 出生点是可选的（CutsceneManager.saveAndTransitionReturningCrossScene：不跨场景且没写
# targetSpawnPoint / targetX,Y 时，玩家与镜头一动不动）。UI 过去只呈现"选一个"，
# 空值还被写成「默认 (spawnPoint)」，看着像必填 —— 这段文案就是把真实规则摆出来。
_SPAWN_FIELD_TIP = (
    "可以不指定：不挪玩家、不动镜头，就在开演那一刻的镜头位置演。\n"
    "指定了才会把玩家和镜头搬到该出生点。\n"
    "跨场景（targetScene 与玩家当前场景不同）例外：一定会落人，不指定就落目标场景的默认出生点。\n"
    "下面勾了 targetX/Y 的话，以 targetX/Y 为准（覆盖出生点）。"
)

if TYPE_CHECKING:
    pass

from ..shared.cutscene_action_allowlist_io import load_cutscene_action_allowlist_ordered

# ---------------------------------------------------------------
# Cutscene Action whitelist：与 src/data/cutscene_action_allowlist.json（及运行时 Set）同源
# ---------------------------------------------------------------
CUTSCENE_ACTION_WHITELIST = list(load_cutscene_action_allowlist_ordered())

# ---------------------------------------------------------------
# Present step types and their parameter schemas
# ---------------------------------------------------------------
PRESENT_TYPES = [
    "fadeToBlack", "fadeIn", "flashWhite", "waitTime", "waitClick",
    "showTitle", "showDialogue", "showImg", "hideImg", "animLayer",
    "showMovieBar", "hideMovieBar", "showSubtitle",
    "cameraMove", "cameraZoom", "showCharacter",
    "parallaxScene",
]

_PRESENT_PARAMS: dict[str, list[tuple[str, str]]] = {
    "fadeToBlack": [("duration", "float")],
    "fadeIn": [("duration", "float")],
    "flashWhite": [("duration", "float")],
    "waitTime": [("duration", "float")],
    "waitClick": [],
    "showTitle": [("text", "text"), ("duration", "float")],
    "showDialogue": [],
    "showImg": [("id", "str"), ("image", "image")],
    "hideImg": [("id", "str")],
    "showMovieBar": [("heightPercent", "float")],
    "hideMovieBar": [],
    "showSubtitle": [("text", "text"), ("position", "str")],
    "cameraMove": [("x", "float"), ("y", "float"), ("duration", "float")],
    "cameraZoom": [("scale", "float"), ("duration", "float")],
    "showCharacter": [("visible", "bool")],
}

_MS_KEYS = frozenset({"duration"})

#: 步骤级「禁用」标记键（运行时 CutsceneManager.isStepDisabled 认这一个键，只认真 True）
STEP_DISABLED_KEY = "disabled"


def step_is_disabled(d: object) -> bool:
    """数据侧判据：与运行时同口径——只有真 True 才算禁用。"""
    return isinstance(d, dict) and d.get(STEP_DISABLED_KEY) is True


def apply_step_disabled(d: dict, disabled: bool) -> dict:
    """把禁用态写回步骤 dict（就地改并返回）。

    启用态一律**删键**而不是写 ``false``：缺省即启用，运行时与数据面都少一份噪音；
    键位置沿用原 dict（禁用→启用→禁用不会把键挪到末尾）。
    """
    if not isinstance(d, dict):
        return d
    if disabled:
        d[STEP_DISABLED_KEY] = True
    else:
        d.pop(STEP_DISABLED_KEY, None)
    return d


def _new_step_data(kind: str) -> dict:
    """新建步骤的初始数据（与 + Present/Action/Parallel 按钮一致）。"""
    if kind == "present":
        return {"kind": "present", "type": "waitClick"}
    if kind == "action":
        return {"kind": "action", "type": CUTSCENE_ACTION_WHITELIST[0], "params": {}}
    if kind == "parallel":
        return {"kind": "parallel", "tracks": []}
    return {"kind": kind}

# 新建 present 步时各数值参数的初值，与运行时 CutsceneManager.executePresent 的 `?? 默认`
# 对齐——否则泛型 float 控件初值恒为 0，会写出 duration:0（瞬时）/ heightPercent:0（黑边不可见）
# 等"假"步骤；运行时那套默认值通过编辑器永远够不到。仅影响"原本缺该键"的新步，不动既有数据。
_PRESENT_PARAM_DEFAULTS: dict[str, dict[str, float]] = {
    "fadeToBlack": {"duration": 1000.0},
    "fadeIn": {"duration": 1000.0},
    "flashWhite": {"duration": 200.0},
    "waitTime": {"duration": 1000.0},
    "showTitle": {"duration": 2000.0},
    "showMovieBar": {"heightPercent": 0.1},
    # scale 0 = 运行时「恢复场景配置基线缩放」语义（缺键同义）；显式倍数才写正数
    "cameraZoom": {"scale": 0.0, "duration": 500.0},
    "cameraMove": {"duration": 1000.0},
}

# cameraMove / cameraZoom 可选 easing（与运行时 CutsceneRenderer.applyCameraEase、
# validator._PARALLAX_EASINGS 同源）。空值 = 不写键，运行时沿用各自历史默认曲线。
_CAMERA_EASING_ROWS: list[tuple[str, str]] = [
    ("缓入缓出（默认，不写键）", ""),
    ("匀速 · linear", "linear"),
    ("缓入 · easeIn", "easeIn"),
    ("缓出 · easeOut", "easeOut"),
    ("缓入缓出 · easeInOut", "easeInOut"),
]

# 泛型 float 控件的量程 / 小数位 / 提示覆盖（默认 range=-99999..99999, decimals=2）。
# heightPercent 是 0–1 比例、scale 是缩放倍数，原先共用 ±99999 的裸量程极易填错。
_PRESENT_FLOAT_HINTS: dict[tuple[str, str], dict[str, Any]] = {
    ("showMovieBar", "heightPercent"): {
        "min": 0.0, "max": 1.0, "decimals": 3, "step": 0.05,
        "tooltip": "电影黑边高度占屏纵向比例，0–1（运行时默认 0.1）。",
    },
    ("cameraZoom", "scale"): {
        "min": 0.0, "max": 100.0, "decimals": 3, "step": 0.1,
        "tooltip": "镜头缩放倍数：>1 放大，<1 缩小；0（或缺省）= 恢复场景配置的基线缩放（scene.camera.zoom）。",
    },
}


def _cutscene_subtitle_emote_target_rows(
    model: ProjectModel | None,
    scene_id: str,
    committed: str,
    cutscene_id: str | None = None,
) -> list[tuple[str, str]]:
    """与 ActionEditor emote_target 一致：绑定场景 NPC + 热点 + player + 本过场 _cut_ 演员。"""
    pairs: list[tuple[str, str]] = []
    sid = (scene_id or "").strip()
    if model and sid:
        pairs.extend(model.npc_ids_for_scene(sid))
        pairs.extend(model.hotspot_ids_for_scene(sid))
    pairs.append(("player", "player"))
    cid = (cutscene_id or "").strip()
    if model and cid:
        seen = {p[0] for p in pairs}
        for tid in model.cutscene_temp_actor_ids_in_cutscene(cid):
            if tid not in seen:
                seen.add(tid)
                pairs.append((tid, tid))
    return _id_ref_rows_with_orphan(pairs, (committed or "").strip())


class _CollapsibleSection(QWidget):
    """折叠区块（默认折叠），与 encounter_editor 同款。"""

    def __init__(self, title: str, inner: QWidget, parent: QWidget | None = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._toggle = QToolButton()
        self._toggle.setText(title)
        self._toggle.setCheckable(True)
        self._toggle.setChecked(False)
        self._toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self._toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._toggle.toggled.connect(self._on_toggled)
        lay.addWidget(self._toggle)
        self._inner = inner
        lay.addWidget(self._inner)
        self._inner.setVisible(False)

    def _on_toggled(self, expanded: bool) -> None:
        self._toggle.setArrowType(
            Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)
        self._inner.setVisible(expanded)

    def expand_if(self, on: bool) -> None:
        self._toggle.blockSignals(True)
        self._toggle.setChecked(on)
        self._toggle.blockSignals(False)
        self._inner.setVisible(on)
        self._toggle.setArrowType(
            Qt.ArrowType.DownArrow if on else Qt.ArrowType.RightArrow)


# 与 CutsceneManager.executePresent 默认一致（毫秒）
_GANTT_MAX_MS = 8000
_GANTT_BAR_PX = 56

def _float_ms(step: dict, key: str, default: float) -> int:
    v = step.get(key)
    if v is None or v == "":
        return int(default)
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return int(default)


#: 说话人标签在摘要里最多占几个字——摘要主体是正文，说话人只是「谁在说」这一眼
#: （取 18 是为了 snake_case 的实体 id 大多能整根显示，中文名远用不满）
_SPEAKER_LABEL_MAX = 18


def _clip(text: str, limit: int) -> str:
    return text[: limit - 1] + "…" if len(text) > limit else text


def _speaker_label(speaker: object, scripted_npc_id: object, names: Mapping | None = None) -> str:
    """一句对白在摘要里的说话人标签，走与运行时（CutsceneManager）同一条回落链：
    显式 speaker → scriptedNpcId → 两者都没设 = 旁白。

    `names` = `speaker_display_names(model)` 的 id→显示名快照（空串键 = 旁白标签）：
    摘要要露的是**玩家看到的那个名字**（`storyteller_zhang` → 说书先生），不是内部 id；
    表里查不到的 id 原样显示——那是个悬垂引用，显示 id 才找得回是哪条数据写错了。
    没给表时（纯函数用法/无工程）退化成 id + 通用兜底名。
    """
    names = names or {}
    raw = str(speaker or "").strip()
    # 字面名/混排文本就是显示名本身，直接照搬（`{{npc}}` 这种纯占位则要回落到实体）
    if raw and not speaker_is_sole_placeholder(raw):
        return _clip(raw.replace("\n", " "), _SPEAKER_LABEL_MAX)
    eid = (speaker_placeholder_entity(raw) if raw else "") or str(scripted_npc_id or "").strip()
    if not eid:
        return str(names.get("") or "旁白")
    dflt = "主角" if eid == PLAYER_ENTITY_ID else eid
    return _clip(str(names.get(eid) or dflt), _SPEAKER_LABEL_MAX)


def _dialogue_fold_text(d: dict, limit: int, names: Mapping | None = None) -> str:
    """`说话人：正文` —— showDialogue 在各处折叠摘要里的统一写法。"""
    spk = _speaker_label(d.get("speaker"), d.get("scriptedNpcId"), names)
    tx = str(d.get("text") or "").replace("\n", " ").strip()
    return f"{spk}：{_clip(tx, limit)}" if tx else spk


def _parallel_track_fold_label(tr: dict, names: Mapping | None = None) -> str:
    """并行块折叠摘要中单轨标签：台词步优先显示「谁说的 + 正文」。"""
    k = str(tr.get("kind", "?"))
    t = str(tr.get("type", "?"))
    # 折叠着也得看出哪条轨不播（展开才发现 = 白读一遍摘要）
    mark = "〔禁〕" if step_is_disabled(tr) else ""
    if k == "present" and t == "showSubtitle":
        tx = str(tr.get("text") or "").replace("\n", " ").strip()
        if tx:
            return mark + _clip(tx, 37)
        return f"{mark}showSubtitle"
    if k == "present" and t == "showDialogue":
        # 说话人不能省：并行轨里同屏几条台词，光看正文认不出谁在说
        return mark + _dialogue_fold_text(tr, 30, names)
    return f"{mark}{k}:{t}"


def parallel_tracks_summary(tracks: list, names: Mapping | None = None) -> str:
    types: list[str] = []
    for tr in tracks:
        if isinstance(tr, dict):
            types.append(_parallel_track_fold_label(tr, names))
    s = " | ".join(types[:6])
    if len(types) > 6:
        s += "…"
    if not tracks:
        return "并行 (0 轨)"
    return f"并行 ({len(tracks)} 轨) · {s}"


def _step_voice_id(d: dict) -> str:
    """本步配的配音 id（新键 voice 优先，回落旧键 subtitleVoice）；没配返回空串。"""
    raw = d.get("voice")
    if raw is None:
        raw = d.get("subtitleVoice")
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, dict):
        return str(raw.get("id") or raw.get("sfxId") or "").strip()
    return ""


def _step_auto_advance(d: dict) -> object:
    """本步的推进方式（新键 autoAdvance 优先，回落旧键 subtitleAutoAdvance）。"""
    raw = d.get("autoAdvance")
    return d.get("subtitleAutoAdvance") if raw is None else raw


def _step_typewriter_suffix(d: dict, dflt: bool) -> str:
    """逐字显示的大纲标记：**只在偏离本类型缺省时**标出来（对白框缺省逐字、字幕缺省整句），
    缺省态不占摘要位置。与运行时同口径：只认真布尔。"""
    raw = d.get("typewriter")
    if not isinstance(raw, bool) or raw == dflt:
        return ""
    return " · 逐字" if raw else " · 整句"


def _scripted_lines_summary(params: dict, names: Mapping | None = None) -> str:
    """playScriptedDialogue 的摘要：行数 + 首行「谁说什么」（+ 还有几个别的说话人）。

    这一步的 params 里躺着整个 lines 数组，按通用 action 那样 json.dumps 再截 48 字，
    截出来的全是 `{"lines": [{"speaker": "` —— 一个字的台词都看不见。
    """
    lines = [ln for ln in (params.get("lines") or []) if isinstance(ln, dict)]
    if not lines:
        return "（无台词）"
    dflt = params.get("scriptedNpcId")
    labels = [_speaker_label(ln.get("speaker"), dflt, names) for ln in lines]
    others = len({x for x in labels[1:] if x != labels[0]})
    tx = str(lines[0].get("text") or "").replace("\n", " ").strip()
    more = f" +{others}人" if others else ""
    return f"{len(lines)}行 · {labels[0]}：{_clip(tx, 33)}{more}"


def step_summary_line(d: dict, names: Mapping | None = None) -> str:
    kind = str(d.get("kind", "present"))
    if kind == "action":
        t = str(d.get("type", ""))
        p = d.get("params") or {}
        if t == "playScriptedDialogue":
            return f"{t}  {_scripted_lines_summary(p, names)}"
        ps = json.dumps(p, ensure_ascii=False) if p else ""
        if len(ps) > 48:
            ps = ps[:45] + "…"
        return f"{t}  {ps}" if ps else t
    if kind == "parallel":
        return parallel_tracks_summary(d.get("tracks") or [], names)
    if kind == "present":
        t = str(d.get("type", ""))
        if t == "showDialogue":
            vid = _step_voice_id(d)
            suf = (f" · voice:{vid}" if vid else "") + _step_typewriter_suffix(d, True)
            # 说话人排在正文前：一屏几十行台词，「谁说的」比正文更快定位，
            # 且 scriptedNpcId-only 的行（占实际数据的大头）以前在摘要里完全看不出说话人。
            return f"showDialogue {_dialogue_fold_text(d, 41, names)}" + suf
        if t == "showTitle":
            tx = str(d.get("text", ""))
            return f"showTitle: {tx[:24]}…" if len(tx) > 24 else f"showTitle: {tx}"
        if t in ("waitTime", "fadeToBlack", "fadeIn", "flashWhite", "cameraMove", "cameraZoom"):
            return f"{t}  {_float_ms(d, 'duration', 0)}ms"
        if t == "showImg":
            return f"showImg  {d.get('id', '')}"
        if t == "animLayer":
            _af = str(d.get("animFile", "") or "")
            _bundle = _af.split("/animation/")[-1].split("/")[0] if "/animation/" in _af else _af
            return f"animLayer  {d.get('id', '')} · {_bundle}"
        if t == "parallaxScene":
            _sid = str(d.get("id", "") or ("(内联)" if isinstance(d.get("scene"), dict) else ""))
            _hn = str(d.get("handle", "") or "")
            return f"parallaxScene  {_sid}" + (f" · {_hn}" if _hn else "")
        if t == "showSubtitle":
            b = str(d.get("subtitleBand", "") or "").strip()
            a = str(d.get("subtitleAlign", "") or "").strip()
            se = d.get("subtitleEmote")
            em_suf = ""
            if isinstance(se, dict):
                tg = str(se.get("target") or "").strip()
                em = str(se.get("emote") or "").strip()
                if tg and em:
                    em_suf = f" · {em}@{tg}"
            voice_id = _step_voice_id(d)
            voice_suf = (f" · voice:{voice_id}" if voice_id else "") + _step_typewriter_suffix(d, False)
            geo = ""
            if b in ("movieTop", "movieBottom") and a in ("left", "center", "right"):
                geo = f" · {b}/{a}"
            tx = str(d.get("text") or "").replace("\n", " ").strip()
            if len(tx) > 56:
                tx = tx[:53] + "…"
            # 折叠摘要优先正文；版式/表情挂件排在后面（与对白行一致的思路）
            if tx:
                return f"showSubtitle: {tx}{geo}{voice_suf}{em_suf}"
            if geo:
                return f"showSubtitle{geo}{voice_suf}{em_suf}"
            suffix = f"{voice_suf}{em_suf}"
            return f"showSubtitle{suffix}" if suffix else "showSubtitle"
        return t
    return kind


def estimate_step_duration_ms(step: dict) -> int | None:
    """与 CutsceneManager.executePresent 对齐的粗估；None = 不定。"""
    # 禁用步运行时整步跳过 → 一律 0，别把不播的时间算进节奏里（parallel 取 max 时同理）
    if step_is_disabled(step):
        return 0
    kind = str(step.get("kind", "present"))
    if kind == "action":
        return None
    if kind == "parallel":
        ts = step.get("tracks") or []
        if not ts:
            return 0
        parts: list[int | None] = []
        for s in ts:
            if isinstance(s, dict):
                parts.append(estimate_step_duration_ms(s))
            else:
                parts.append(0)
        if any(p is None for p in parts):
            return None
        return max(p for p in parts) if parts else 0
    if kind != "present":
        return None
    t = str(step.get("type", ""))
    if t in ("waitClick", "showDialogue", "showSubtitle"):
        # 固定时长自动推进 → 可估算；跟随配音 / 点击推进 → 不定（对话框与字幕同一套推进语义）
        if t == "waitClick":
            return None
        aa = _step_auto_advance(step)
        if isinstance(aa, (int, float)) and not isinstance(aa, bool) and aa > 0:
            return int(float(aa))
        return None
    if t == "showImg":
        return None
    if t in ("hideImg", "hideMovieBar", "showMovieBar", "showCharacter", "animLayer", "parallaxScene"):
        return 0
    if t == "fadeToBlack":
        return _float_ms(step, "duration", 1000)
    if t == "fadeIn":
        return _float_ms(step, "duration", 1000)
    if t == "flashWhite":
        return _float_ms(step, "duration", 200)
    if t == "waitTime":
        return _float_ms(step, "duration", 1000)
    if t == "showTitle":
        return _float_ms(step, "duration", 2000)
    if t == "cameraMove":
        return _float_ms(step, "duration", 1000)
    if t == "cameraZoom":
        return _float_ms(step, "duration", 500)
    return None


def kind_palette(kind: str, theme_id: str) -> tuple[str, str, str]:
    """步骤 kind 的三色：色条 / 徽章底 / 徽章字。

    大纲行表头与缩略时间轴共用同一处色值——两边各存一份必然漂移。
    """
    if app_theme.is_dark_theme(theme_id):
        if kind == "action":
            return "#4dabf7", "#1864ab", "#ffffff"
        if kind == "parallel":
            return "#9775fa", "#5f3dc4", "#ffffff"
        return "#51cf66", "#2f9e44", "#ffffff"
    if kind == "action":
        return "#0d6efd", "#cfe2ff", "#084298"
    if kind == "parallel":
        return "#6f42c1", "#e2d9f3", "#432874"
    return "#198754", "#d1e7dd", "#0f5132"


def format_duration_hint(ms: int | None) -> str:
    if ms is None:
        return "不定"
    if ms == 0:
        return "—"
    return f"~{ms}ms"


def gantt_style_for_ms(ms: int | None, theme_id: str) -> str:
    dark = app_theme.is_dark_theme(theme_id)
    dash = "#868e96" if dark else "#6c757d"
    zero_bg = "#495057" if dark else "#dee2e6"
    fill = "#868e96" if dark else "#6c757d"
    if ms is None:
        return (
            f"background: transparent; border: 1px dashed {dash}; "
            "min-height: 10px; max-height: 10px; border-radius: 2px;"
        )
    if ms <= 0:
        return (
            f"background: {zero_bg}; min-height: 10px; max-height: 10px; "
            "border-radius: 2px; min-width: 4px; max-width: 4px;"
        )
    w = max(4, min(_GANTT_BAR_PX, int(_GANTT_BAR_PX * min(ms, _GANTT_MAX_MS) / _GANTT_MAX_MS)))
    return (
        f"background: {fill}; min-height: 10px; max-height: 10px; "
        f"border-radius: 2px; min-width: {w}px; max-width: {w}px;"
    )


def _step_has_authored_content(d: dict) -> bool:
    """判断一步是否已有「值得保护」的作者内容——用于切换 kind / present type 前的清空确认。

    保守偏向：只在明显有内容时才 True，避免对刚新建的空步频繁弹窗；随类型自动 seed
    的默认数值（duration/scale/heightPercent 等）不算内容。
    """
    if not isinstance(d, dict):
        return False
    kind = str(d.get("kind", ""))
    if kind not in ("present", "action", "parallel"):
        # 未知 kind（agent 手写坏数据）：除 kind 外还有任何键就算内容——
        # 切走前必须确认 + 可撤销，不能因为表单画不出来就当它是空步。
        return any(k != "kind" for k in d)
    if kind == "parallel":
        return bool(d.get("tracks"))
    if kind == "action":
        return bool(d.get("params"))
    if kind == "present":
        for k in ("text", "id", "image", "from", "toImage", "animFile", "scene",
                  "handle", "voice", "subtitleVoice", "subtitleEmote"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return True
            if isinstance(v, (list, dict)) and v:
                return True
        for k in ("x", "y"):  # 被移动过的相机坐标（非 0）
            v = d.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v != 0:
                return True
        return False
    return False


# ===============================================================
# StepWidget — 单步表单（无顶栏按钮；由 StepOutlineFrame 提供大纲行）
# ===============================================================

class StepWidget(QFrame):
    """编辑一个 CutsceneStep。"""

    contentChanged = Signal()

    def __init__(
        self,
        step: dict,
        model: ProjectModel | None = None,
        editor: "TimelineEditor | None" = None,
        parent: QWidget | None = None,
        *,
        parallel_parent: StepWidget | None = None,
        cutscene_id: str | None = None,
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
        self._cutscene_id = (cutscene_id or "") or None
        self._outline_frame: StepOutlineFrame | None = None
        self._child_outlines: list[StepOutlineFrame] = []
        self._widgets: dict[str, QWidget] = {}
        self._action_row: ActionRow | None = None
        self._parallel_layout: QVBoxLayout | None = None
        self._parallel_group: QGroupBox | None = None
        # 构造期各控件程序化赋值会触发 valueChanged/typeCommitted；勿标为「未 Apply」
        self._report_editor_dirty: bool = False

        kind = str(step.get("kind", "present"))
        self._step_data = deepcopy(step)
        self._original_data = deepcopy(step)
        # 禁用态：表单本身不呈现它（开关在大纲行/批量对白行上），但必须**带着走**——
        # to_dict 会重建整份 dict，不显式续写就会在展开后被静默抹掉。
        self._disabled = step_is_disabled(step)
        # 已提交的 kind / present type，用于切换前捕获旧内容并在取消时回退控件。
        self._committed_kind = kind
        self._committed_present_type = str(step.get("type", "waitClick"))
        # 畸形 parallel（tracks 非列表 / 含非 dict 轨）：不建子轨表单，
        # to_dict 原样透传（对齐未知 present type 策略），展开不炸、Apply 不丢。
        _tr = step.get("tracks")
        self._parallel_malformed = kind == "parallel" and _tr is not None and (
            not isinstance(_tr, list)
            or any(not isinstance(t, dict) for t in _tr)
        )

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        # kind selector
        top = QHBoxLayout()
        self._kind_combo = QComboBox()
        self._kind_combo.addItem("present", "present")
        self._kind_combo.addItem("action", "action")
        self._kind_combo.addItem("parallel", "parallel")
        if kind not in ("present", "action", "parallel"):
            # 未知 kind（agent 手写坏数据）：补孤儿项如实显示，不冒充 present；
            # 旧实现停留在 present 项，to_dict 走 present 分支撞上不存在的
            # _type_combo 直接 AttributeError（展开/Apply 双崩）。
            self._kind_combo.addItem(f"[未知] {kind}", kind)
        for i in range(self._kind_combo.count()):
            if self._kind_combo.itemData(i) == kind:
                self._kind_combo.setCurrentIndex(i)
                break
        self._kind_combo.currentIndexChanged.connect(self._on_kind_changed)
        top.addWidget(QLabel("kind:"))
        top.addWidget(self._kind_combo, stretch=1)
        lay.addLayout(top)

        self._body = QVBoxLayout()
        lay.addLayout(self._body)

        self._rebuild(kind)
        self._report_editor_dirty = True

    def _on_parallel_child_changed(self) -> None:
        of = self._outline_frame
        if of is not None:
            of.refresh_header()

    def _find_owning_outlines_and_layout(self):
        if self._parallel_parent is not None:
            return self._parallel_parent._child_outlines, self._parallel_parent._parallel_layout
        if self._editor is not None:
            return self._editor._step_outlines, self._editor._steps_layout
        return None, None

    def _emit_dirty(self) -> None:
        self.contentChanged.emit()
        if self._report_editor_dirty and (
            self._editor is not None and hasattr(self._editor, "mark_pending_changes")
        ):
            self._editor.mark_pending_changes()
        if self._parallel_parent is not None:
            self._parallel_parent._on_parallel_child_changed()

    def _confirm_discard_switch(self, what: str) -> bool:
        r = QMessageBox.question(
            self, "过场",
            f"当前步骤已有内容，切换{what}会清空这些参数。\n"
            "（可用 Ctrl+Z 撤销。）是否继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return r == QMessageBox.StandardButton.Yes

    def _set_kind_combo_silent(self, kind: str) -> None:
        self._kind_combo.blockSignals(True)
        for i in range(self._kind_combo.count()):
            if self._kind_combo.itemData(i) == kind:
                self._kind_combo.setCurrentIndex(i)
                break
        self._kind_combo.blockSignals(False)

    def _on_kind_changed(self) -> None:
        new_kind = self._kind_combo.currentData()
        old_kind = getattr(self, "_committed_kind", new_kind)
        if new_kind != old_kind and _step_has_authored_content(
            self.to_dict(kind_override=old_kind)
        ):
            if not self._confirm_discard_switch("步骤类型"):
                self._set_kind_combo_silent(old_kind)
                return
            # 弹窗承诺「可用 Ctrl+Z 撤销」→ 确认清空前必须压整树快照（审查 P1-17）。
            # 此刻 combo 已指向新 kind，to_dict 会按新类型序列化空内容；先静默回退
            # 让快照捕获旧参数，压完再切回。
            if self._editor is not None and hasattr(self._editor, "push_undo_snapshot"):
                self._set_kind_combo_silent(old_kind)
                try:
                    self._editor.push_undo_snapshot()
                finally:
                    self._set_kind_combo_silent(new_kind)
        self._committed_kind = new_kind
        self._step_data = {"kind": new_kind}
        self._parallel_malformed = False  # 换类型即离开畸形透传态（新 tracks 为空列表）
        if new_kind == "present":
            self._step_data["type"] = "waitClick"
        elif new_kind == "action":
            self._step_data["type"] = CUTSCENE_ACTION_WHITELIST[0]
            self._step_data["params"] = {}
        elif new_kind == "parallel":
            self._step_data["tracks"] = []
        self._rebuild(new_kind)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def _clear_body(self) -> None:
        for ol in self._child_outlines:
            ol.deleteLater()
        self._child_outlines.clear()
        self._widgets.clear()
        self._action_row = None
        self._parallel_layout = None
        self._parallel_group = None
        while self._body.count() > 0:
            item = self._body.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
            sub = item.layout()
            if sub:
                while sub.count() > 0:
                    si = sub.takeAt(0)
                    sw = si.widget()
                    if sw:
                        sw.deleteLater()

    def _rebuild(self, kind: str) -> None:
        self._clear_body()
        if kind == "present":
            self._build_present()
        elif kind == "action":
            self._build_action()
        elif kind == "parallel":
            if self._parallel_malformed:
                self._build_raw_fallback("并行步的 tracks 含非对象项（数据异常）")
            else:
                self._build_parallel()
        else:
            # 未知 kind 兜底：不建表单也不炸，to_dict 原样透传（对齐未知 present type 策略）。
            # validator 对未知 kind 只 warning，编辑器不应比它更暴烈（审查 P2）。
            self._build_raw_fallback(f"未知步骤类型 kind={kind!r}")

    def _raw_passthrough_dict(self, kind: str) -> dict:
        """脏数据步的序列化：原样透传构造时的原始 JSON，绝不因表单缺失丢内容。"""
        od = self._original_data
        if isinstance(od, dict) and str(od.get("kind", "")) == str(kind):
            return deepcopy(od)
        d = deepcopy(self._step_data) if isinstance(self._step_data, dict) else {}
        d["kind"] = kind
        return d

    def _build_raw_fallback(self, reason: str) -> None:
        """脏数据兜底表单：说明原因 + 只读展示原始 JSON，不给可写控件。"""
        lbl = QLabel(f"{reason}：编辑器无法编辑此步，Apply 时按原始数据原样保留。")
        lbl.setWordWrap(True)
        lbl.setStyleSheet("color:#e8590c;")
        self._body.addWidget(lbl)
        raw = QPlainTextEdit(self)
        try:
            raw.setPlainText(json.dumps(
                self._raw_passthrough_dict(str(self._kind_combo.currentData())),
                ensure_ascii=False, indent=2))
        except Exception:  # noqa: BLE001 — 展示失败也不能挡住面板
            raw.setPlainText(repr(self._original_data))
        raw.setReadOnly(True)
        raw.setMaximumHeight(140)
        self._body.addWidget(raw)

    def _build_present(self) -> None:
        form = compact_form(QFormLayout())
        self._type_combo = FilterableTypeCombo(
            [(t, t) for t in PRESENT_TYPES],
            orphan_label=lambda v: f"[unknown] {v}",
            select_only=True,
        )
        cur_type = str(self._step_data.get("type", "waitClick"))
        self._type_combo.set_committed_type(cur_type)
        self._committed_present_type = cur_type
        self._type_combo.typeCommitted.connect(self._on_present_type_changed)
        form.addRow("type", self._type_combo)

        self._present_params_layout = QFormLayout()
        self._present_params_layout.setFieldGrowthPolicy(
            QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint)
        form_w = QWidget()
        form_w.setLayout(form)
        self._body.addWidget(form_w)
        params_w = QWidget()
        params_w.setLayout(self._present_params_layout)
        self._body.addWidget(params_w)

        self._rebuild_present_params(cur_type)

    def _on_present_type_changed(self) -> None:
        new_type = self._type_combo.committed_type()
        old_type = getattr(self, "_committed_present_type", new_type)
        if new_type != old_type and _step_has_authored_content(
            self.to_dict(present_type_override=old_type)
        ):
            if not self._confirm_discard_switch("present 类型"):
                self._type_combo.set_committed_type(old_type)  # emit=False，不回弹本处理器
                return
            # 同 _on_kind_changed：确认清空前压快照，兑现「可用 Ctrl+Z 撤销」（审查 P1-17）。
            # committed_type 已是新类型而旧参数控件还在，先回退让快照捕获旧内容。
            if self._editor is not None and hasattr(self._editor, "push_undo_snapshot"):
                self._type_combo.set_committed_type(old_type)
                try:
                    self._editor.push_undo_snapshot()
                finally:
                    self._type_combo.set_committed_type(new_type)
        self._committed_present_type = new_type
        self._step_data = {"kind": "present", "type": new_type}
        self._rebuild_present_params(new_type)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def _rebuild_present_params(self, ptype: str) -> None:
        while self._present_params_layout.rowCount() > 0:
            self._present_params_layout.removeRow(0)
        self._widgets.clear()

        if ptype == "showDialogue":
            cur_sid = str(self._step_data.get("scriptedNpcId", "") or "")
            # 说话人 NPC 候选限定到本过场「targetScene」（与表情锚点/action NPC 下拉一致）；
            # 未绑定 targetScene 时 bind_sid 为空 → npc_items_for_dialogue_picker 回退全工程。
            ed_sc = self._editor
            bind_sid = ""
            if ed_sc is not None and hasattr(ed_sc, "cutscene_binding_target_scene"):
                bind_sid = ed_sc.cutscene_binding_target_scene()
            wdg = CutsceneShowDialogueFields(
                self._model,
                bind_sid,
                str(self._step_data.get("speaker", "") or ""),
                str(self._step_data.get("text", "") or ""),
                cur_sid,
                self,
                on_change=self._emit_dirty,
                portrait=self._step_data.get("portrait") if isinstance(self._step_data.get("portrait"), dict) else None,
                bubble_anchor_y=self._step_data.get("bubbleAnchorY"),
                bubble_scale=self._step_data.get("bubbleScale"),
                voice=self._step_data.get("voice"),
                auto_advance=self._step_data.get("autoAdvance"),
                typewriter=self._step_data.get("typewriter"),
            )
            self._widgets["__showDialogue__"] = wdg
            self._present_params_layout.addRow(wdg)
            return

        if ptype == "cameraMove":
            self._build_camera_move_present_params()
            return

        if ptype == "showSubtitle":
            self._build_show_subtitle_present_params()
            return

        if ptype == "showImg":
            self._build_show_img_present_params()
            return

        if ptype == "animLayer":
            self._build_anim_layer_present_params()
            return

        if ptype == "parallaxScene":
            self._build_parallax_scene_present_params()
            return

        if ptype == "hideImg":
            self._build_hide_img_present_params()
            return

        schema = _PRESENT_PARAMS.get(ptype, [])
        for pname, pt in schema:
            val = self._step_data.get(pname, "")
            label = f"{pname} (ms)" if pt == "float" and pname in _MS_KEYS else pname
            if pt == "float":
                w = QDoubleSpinBox()
                hint = _PRESENT_FLOAT_HINTS.get((ptype, pname))
                if hint:
                    w.setRange(hint["min"], hint["max"])
                    w.setDecimals(hint["decimals"])
                    w.setSingleStep(hint.get("step", 1.0))
                    w.setToolTip(hint["tooltip"])
                else:
                    w.setRange(-99999, 99999)
                    w.setDecimals(2)
                w.setMaximumWidth(120)
                default = _PRESENT_PARAM_DEFAULTS.get(ptype, {}).get(pname, 0.0)
                w.setValue(float(val) if val != "" else default)
                w.valueChanged.connect(self._emit_dirty)
            elif pt == "bool":
                w = QCheckBox()
                w.setChecked(bool(val) if val != "" else True)
                w.toggled.connect(self._emit_dirty)
            elif pt == "text":
                w = QTextEdit(str(val))
                w.setMinimumHeight(60)
                w.setMaximumHeight(96)
                w.textChanged.connect(self._emit_dirty)
            elif pt == "image":
                w = CutsceneImagePathRow(self._model, str(val) if val else "", self)
                w.setMinimumWidth(240)
                w._edit.textChanged.connect(self._emit_dirty)
            else:
                w = QLineEdit(str(val) if val else "")
                w.textChanged.connect(self._emit_dirty)
            self._widgets[pname] = w
            self._present_params_layout.addRow(label, w)

        if ptype in ("cameraMove", "cameraZoom"):
            self._add_camera_easing_row()

    def _add_camera_easing_row(self) -> None:
        """cameraMove / cameraZoom 可选 easing 下拉（空 = 不写键，运行时沿用各自默认曲线）。"""
        cur = str(self._step_data.get("easing", "") or "").strip()
        rows = list(_CAMERA_EASING_ROWS)
        if cur and cur not in {v for _, v in rows}:
            rows.append((f"{cur}（未登记值）", cur))
        combo = FilterableTypeCombo(rows, self, select_only=True)
        combo.set_committed_type(cur)
        combo.typeCommitted.connect(self._emit_dirty)
        combo.setToolTip(
            "镜头插值缓动。默认（不写键）= 运行时历史曲线：cameraMove 为缓入缓出 cubic、"
            "cameraZoom 为缓入缓出 quad；linear = 匀速；easeIn / easeOut / easeInOut 为 cubic 家族。"
        )
        self._widgets["_camera_easing"] = combo
        self._present_params_layout.addRow("easing（缓动）", combo)

    def _merge_camera_easing_optional(self, d: dict) -> None:
        """easing 空 = 不写键；非空原样写回（未登记值也保留，交由 validator 报 error）。"""
        w = self._widgets.get("_camera_easing")
        if not isinstance(w, FilterableTypeCombo):
            return
        ez = w.committed_type().strip()
        if ez:
            d["easing"] = ez

    def _build_camera_move_present_params(self) -> None:
        """cameraMove：x/y 可手输，也可用绑定场景地图点选。"""
        val_x = self._step_data.get("x", "")
        val_y = self._step_data.get("y", "")
        val_dur = self._step_data.get("duration", "")
        sx = QDoubleSpinBox()
        sx.setRange(-99999, 99999)
        sx.setDecimals(2)
        sx.setValue(float(val_x) if val_x != "" else 0.0)
        sx.valueChanged.connect(self._emit_dirty)
        sy = QDoubleSpinBox()
        sy.setRange(-99999, 99999)
        sy.setDecimals(2)
        sy.setValue(float(val_y) if val_y != "" else 0.0)
        sy.valueChanged.connect(self._emit_dirty)
        sd = QDoubleSpinBox()
        sd.setRange(0, 999999)
        sd.setDecimals(2)
        sd.setValue(float(val_dur) if val_dur != "" else 1000.0)
        sd.valueChanged.connect(self._emit_dirty)

        row = QWidget()
        hl = QHBoxLayout(row)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.addWidget(QLabel("x"))
        hl.addWidget(sx, 1)
        hl.addWidget(QLabel("y"))
        hl.addWidget(sy, 1)
        pick = QPushButton("地图选点…")
        pick.setToolTip(
            "在过场顶部「targetScene」绑定的场景背景上点击，写入 x / y 世界坐标。"
        )
        pick.clicked.connect(self._on_pick_camera_move_point)
        hl.addWidget(pick)
        self._widgets["x"] = sx
        self._widgets["y"] = sy
        self._widgets["duration"] = sd
        self._present_params_layout.addRow("目标位置（世界坐标）", row)
        self._present_params_layout.addRow("duration (ms)", sd)
        self._add_camera_easing_row()

    def _on_pick_camera_move_point(self) -> None:
        ed = self._editor
        model = self._model
        if ed is None or model is None:
            QMessageBox.warning(self, "选点", "未绑定编辑器或工程模型。")
            return
        sid = ""
        if hasattr(ed, "cutscene_binding_target_scene"):
            sid = ed.cutscene_binding_target_scene()
        sid = str(sid or "").strip()
        if not sid:
            QMessageBox.information(
                self,
                "过场",
                "请先在过场表单中设置「targetScene」，再在地图上选取镜头目标点。",
            )
            return
        if sid not in model.scenes:
            QMessageBox.warning(
                self,
                "选点",
                f"场景「{sid}」未载入工程，无法打开预览。请检查 ID 或过场绑定。",
            )
            return
        wx_w = self._widgets.get("x")
        wy_w = self._widgets.get("y")
        if not isinstance(wx_w, QDoubleSpinBox) or not isinstance(wy_w, QDoubleSpinBox):
            return
        dlg = CutsceneCameraPointPickerDialog(
            model, sid, float(wx_w.value()), float(wy_w.value()), self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            px, py = dlg.picked_xy()
            wx_w.setValue(float(px))
            wy_w.setValue(float(py))
            self._emit_dirty()

    def refresh_subtitle_emote_target_items(self) -> None:
        """过场 targetScene 变更时刷新 showSubtitle 表情锚点下拉候选项。"""
        if self._kind_combo.currentData() != "present":
            return
        if self._type_combo.committed_type() != "showSubtitle":
            return
        sel = self._widgets.get("_subtitle_emote_target")
        if not isinstance(sel, IdRefSelector):
            return
        ed = self._editor
        sid = ""
        if ed is not None and hasattr(ed, "cutscene_binding_target_scene"):
            sid = ed.cutscene_binding_target_scene()
        cur = sel.current_id().strip()
        rows = _cutscene_subtitle_emote_target_rows(
            self._model, sid, cur, cutscene_id=self._cutscene_id)
        sel.blockSignals(True)
        try:
            sel.set_items(rows)
            sel.set_current(cur)
        finally:
            sel.blockSignals(False)

    def refresh_show_dialogue_scene_scope(self) -> None:
        """过场 targetScene 变更时刷新 showDialogue 说话人 NPC 候选（与表情锚点刷新一致）。"""
        if self._kind_combo.currentData() != "present":
            return
        if self._type_combo.committed_type() != "showDialogue":
            return
        wdg = self._widgets.get("__showDialogue__")
        if not isinstance(wdg, CutsceneShowDialogueFields):
            return
        ed = self._editor
        sid = ""
        if ed is not None and hasattr(ed, "cutscene_binding_target_scene"):
            sid = ed.cutscene_binding_target_scene()
        wdg.refresh_scene_scope(sid or None)

    def _subtitle_on_present_mode_changed(self) -> None:
        combo = self._widgets.get("_subtitle_mode")
        spin = self._widgets.get("_subtitle_frac")
        if isinstance(combo, FilterableTypeCombo) and isinstance(spin, QDoubleSpinBox):
            spin.setVisible(combo.committed_type().strip() == "__num__")
        self._emit_dirty()

    def _subtitle_on_layout_mode_changed(self) -> None:
        lm = self._widgets.get("_subtitle_layout_mode")
        classic = self._widgets.get("_subtitle_classic_wrap")
        movie = self._widgets.get("_subtitle_movie_wrap")
        if isinstance(lm, FilterableTypeCombo):
            is_classic = lm.committed_type().strip() == "__classic__"
            if isinstance(classic, QWidget):
                classic.setVisible(is_classic)
            if isinstance(movie, QWidget):
                movie.setVisible(not is_classic)
        self._subtitle_on_present_mode_changed()

    def _show_subtitle_merge_emote_optional(self, d: dict) -> None:
        """target+emote 均非空时写入 subtitleEmote，与 CutsceneManager.parseSubtitleEmoteSpec 对齐。"""
        tgt_w = self._widgets.get("_subtitle_emote_target")
        emo_w = self._widgets.get("_subtitle_emote_emote")
        tt = ""
        if isinstance(tgt_w, IdRefSelector):
            tt = tgt_w.current_id().strip()
        elif isinstance(tgt_w, QLineEdit):
            tt = tgt_w.text().strip()
        ee = ""
        if isinstance(emo_w, EmoteBubbleParamWidget):
            ee = emo_w.emote_text().strip()
        elif isinstance(emo_w, QLineEdit):
            ee = emo_w.text().strip()
        if not tt or not ee:
            return
        dur_w = self._widgets.get("_subtitle_emote_duration")
        dur = 1500.0
        if isinstance(dur_w, QDoubleSpinBox):
            dur = max(1.0, float(dur_w.value()))
        ox_w = self._widgets.get("_subtitle_emote_ox")
        oy_w = self._widgets.get("_subtitle_emote_oy")
        ox, oy = 0.0, 0.0
        if isinstance(ox_w, QDoubleSpinBox):
            ox = float(ox_w.value())
        if isinstance(oy_w, QDoubleSpinBox):
            oy = float(oy_w.value())
        spec: dict = {
            "target": tt,
            "emote": ee,
            "duration": dur,
            "anchorOffsetX": ox,
            "anchorOffsetY": oy,
        }
        # 位置/大小：不勾覆盖就不写键（继承实体自算 / 全局 emoteBubbleScale）
        bub_w = self._widgets.get("_subtitle_emote_bubble")
        if isinstance(bub_w, BubbleAnchorPickField):
            bay = bub_w.value()
            if bay is not None:
                spec["bubbleAnchorY"] = bay
            bsc = bub_w.scale_value()
            if bsc is not None:
                spec["bubbleScale"] = bsc
        d["subtitleEmote"] = spec

    def _subtitle_voice_raw(self) -> object:
        """配音原值：新键 `voice` 优先，回落旧键 `subtitleVoice`（本能力铺到全部台词面前的名字）。"""
        raw = self._step_data.get("voice")
        return self._step_data.get("subtitleVoice") if raw is None else raw

    def _subtitle_advance_raw(self) -> object:
        raw = self._step_data.get("autoAdvance")
        return self._step_data.get("subtitleAutoAdvance") if raw is None else raw

    def _show_subtitle_merge_voice_optional(self, d: dict) -> None:
        """配音 + 推进方式一并写出（统一键名 voice / autoAdvance；旧键名保存时自然消失）。"""
        w = self._widgets.get("_subtitle_voice")
        if isinstance(w, VoiceSpecField):
            w.apply_to(d)

    def _show_subtitle_merge_typewriter(self, d: dict) -> None:
        """逐字显示：**字幕缺省整句上屏**，只有勾上才写 `typewriter: true`。
        与缺省一致就不落键（同 `disabled` 的「只写偏离值」口径，免得 254 拍平白多一行噪声）。"""
        w = self._widgets.get("_subtitle_typewriter")
        if isinstance(w, QCheckBox) and w.isChecked():
            d["typewriter"] = True

    def _build_show_subtitle_present_params(self) -> None:
        raw_txt = self._step_data.get("text", "")
        raw_pos = self._step_data.get("position", "bottom")
        rb = str(self._step_data.get("subtitleBand", "") or "").strip()
        ra = str(self._step_data.get("subtitleAlign", "") or "").strip()
        use_movie = rb in ("movieTop", "movieBottom") and ra in ("left", "center", "right")

        if self._model is not None:
            tw = RichTextTextEdit(self._model, self)
            tw.setPlainText(str(raw_txt))
            tw.textChanged.connect(self._emit_dirty)
            tw.setPlaceholderText("字幕文案…")
            tw.setToolTip(
                "字幕文案；请用右侧「插入引用」添加 [tag:…]，勿手打。"
            )
            # 字幕多为一两行：压矮省纵向空间、加宽争取横向（超出仍可滚动）。
            tw.core_text_edit().setMinimumHeight(40)
            tw.setMaximumHeight(72)
            tw.setMinimumWidth(460)
        else:
            tw = QTextEdit(str(raw_txt))
            tw.setMinimumHeight(40)
            tw.setMaximumHeight(64)
            tw.setMinimumWidth(460)
            tw.textChanged.connect(self._emit_dirty)
            tw.setPlaceholderText("载入工程后可使用完整引用插入能力。")

        layout_mode_rows = [
            ("经典 position（top/center/bottom 或比例）", "__classic__"),
            ("相对黑边（上/下区 × 左/中/右）", "__movie__"),
        ]
        layout_combo = FilterableTypeCombo(layout_mode_rows, self, select_only=True)
        layout_combo.set_committed_type("__classic__" if not use_movie else "__movie__")
        layout_combo.typeCommitted.connect(self._subtitle_on_layout_mode_changed)

        mode_rows = [
            ("顶部 · top", "top"),
            ("居中 · center", "center"),
            ("底部 · bottom", "bottom"),
            ("纵向 0–1 比例 …", "__num__"),
        ]
        cw = FilterableTypeCombo(mode_rows, self, select_only=True)

        frac = QDoubleSpinBox(self)
        frac.setRange(0.0, 1.0)
        frac.setDecimals(4)
        frac.setSingleStep(0.05)
        frac.setToolTip(
            "与运行时 CutsceneRenderer 一致：0–1 映射到屏上纵向位置。"
        )

        rp = raw_pos
        if isinstance(rp, bool):
            cw.set_committed_type("bottom")
            frac.setValue(0.5)
        elif isinstance(rp, (int, float)):
            cw.set_committed_type("__num__")
            fv = float(rp)
            frac.setValue(max(0.0, min(1.0, fv)))
        else:
            s = str(rp).strip().lower()
            if s in ("top", "center", "bottom"):
                cw.set_committed_type(s)
                frac.setValue(0.5)
            else:
                try:
                    fv = float(s)
                    cw.set_committed_type("__num__")
                    frac.setValue(max(0.0, min(1.0, fv)))
                except (TypeError, ValueError):
                    cw.set_committed_type("bottom")
                    frac.setValue(0.5)

        frac.valueChanged.connect(self._emit_dirty)
        cw.typeCommitted.connect(self._subtitle_on_present_mode_changed)

        classic_row = QWidget(self)
        classic_lay = QHBoxLayout(classic_row)
        classic_lay.setContentsMargins(0, 0, 0, 0)
        classic_lay.addWidget(cw, 1)
        classic_lay.addWidget(frac)
        classic_row.setToolTip("预设三档或屏幕纵向数值；与运行时 showSubtitle(position) 对齐。")

        classic_wrap = QWidget(self)
        classic_wrap_l = QVBoxLayout(classic_wrap)
        classic_wrap_l.setContentsMargins(0, 0, 0, 0)
        classic_wrap_l.addWidget(classic_row)

        band_rows = [
            ("上黑边区 · movieTop", "movieTop"),
            ("下黑边区 · movieBottom", "movieBottom"),
        ]
        band_c = FilterableTypeCombo(band_rows, self, select_only=True)
        if rb == "movieBottom":
            band_c.set_committed_type("movieBottom")
        else:
            band_c.set_committed_type("movieTop")

        align_rows = [
            ("居左 · left", "left"),
            ("居中 · center", "center"),
            ("居右 · right", "right"),
        ]
        align_c = FilterableTypeCombo(align_rows, self, select_only=True)
        if ra == "left":
            align_c.set_committed_type("left")
        elif ra == "right":
            align_c.set_committed_type("right")
        else:
            align_c.set_committed_type("center")

        band_c.typeCommitted.connect(self._emit_dirty)
        align_c.typeCommitted.connect(self._emit_dirty)

        movie_row = QWidget(self)
        movie_lay = QHBoxLayout(movie_row)
        movie_lay.setContentsMargins(0, 0, 0, 0)
        movie_lay.addWidget(QLabel("条带"))
        movie_lay.addWidget(band_c, 1)
        movie_lay.addWidget(QLabel("水平"))
        movie_lay.addWidget(align_c, 1)
        movie_row.setToolTip(
            "须先在同过场中 showMovieBar；仅写入 subtitleBand + subtitleAlign，不写 position。"
        )

        movie_wrap = QWidget(self)
        movie_wrap_l = QVBoxLayout(movie_wrap)
        movie_wrap_l.setContentsMargins(0, 0, 0, 0)
        movie_wrap_l.addWidget(movie_row)

        # 配音 + 推进方式：与过场对话框、图对话拍、脚本台词行、气泡 action 同一个控件。
        voice_field = VoiceSpecField(
            self,
            model=self._model,
            voice_raw=self._subtitle_voice_raw(),
            advance_raw=self._subtitle_advance_raw(),
        )
        voice_field.changed.connect(self._emit_dirty)
        voice_body = QWidget(self)
        voice_body_l = QVBoxLayout(voice_body)
        voice_body_l.setContentsMargins(8, 4, 8, 4)
        voice_body_l.addWidget(voice_field)
        voice_section = _CollapsibleSection("配音 / 推进方式（可选）", voice_body, self)
        voice_section.setToolTip(
            "写入 voice / autoAdvance 两个键。\n"
            "默认：无配音、等玩家点击。\n"
            "一条配音要盖住后面几条字幕时，起头那条勾「播完不停」，"
            "由后面某条选「跟随配音结束」来收尾。"
        )
        if voice_field.has_content():
            voice_section.expand_if(True)

        se_raw = self._step_data.get("subtitleEmote")
        se_t, se_e, se_d, se_ox, se_oy = "", "", 1500.0, 0.0, 0.0
        se_ay: object = None
        se_sc: object = None
        if isinstance(se_raw, dict):
            se_t = str(se_raw.get("target") or "").strip()
            se_e = str(se_raw.get("emote") or "").strip()
            try:
                se_d = float(se_raw.get("duration", 1500))
            except (TypeError, ValueError):
                se_d = 1500.0
            if not (se_d > 0 and se_d == se_d):
                se_d = 1500.0
            try:
                se_ox = float(se_raw.get("anchorOffsetX", 0))
            except (TypeError, ValueError):
                se_ox = 0.0
            try:
                se_oy = float(se_raw.get("anchorOffsetY", 0))
            except (TypeError, ValueError):
                se_oy = 0.0
            se_ay = se_raw.get("bubbleAnchorY")
            se_sc = se_raw.get("bubbleScale")

        emote_body = QWidget(self)
        emote_form = compact_form(QFormLayout(emote_body))
        emote_form.setContentsMargins(8, 4, 8, 4)
        ed_sc = self._editor
        bind_sid = ""
        if ed_sc is not None and hasattr(ed_sc, "cutscene_binding_target_scene"):
            bind_sid = ed_sc.cutscene_binding_target_scene()
        emote_tgt = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        emote_tgt.setMinimumWidth(160)
        emote_tgt.set_items(_cutscene_subtitle_emote_target_rows(
            self._model,
            bind_sid,
            se_t,
            cutscene_id=self._cutscene_id,
        ))
        emote_tgt.set_current(se_t)
        emote_tgt.value_changed.connect(self._emit_dirty)
        emote_tgt.setToolTip(
            "仅下拉选择；候选项为本过场「targetScene」中 NPC、热点、player，"
            "及本过场步骤树中已用的 _cut_ 临时演员（与 showEmoteAndWait 一致）。"
        )
        emote_txt = EmoteBubbleParamWidget(
            self,
            self._model,
            se_e,
            self._emit_dirty,
            include_empty_choice=True,
        )
        emote_txt.setMinimumWidth(240)
        emote_dur = QDoubleSpinBox()
        emote_dur.setRange(1.0, 999999.0)
        emote_dur.setDecimals(0)
        emote_dur.setValue(max(1.0, se_d))
        emote_dur.setToolTip("毫秒，与 showEmoteAndWait 一致；字幕仍为点击关闭。")
        emote_dur.valueChanged.connect(self._emit_dirty)
        emote_ox = QDoubleSpinBox()
        emote_ox.setRange(-9999.0, 9999.0)
        emote_ox.setDecimals(1)
        emote_ox.setValue(se_ox)
        emote_ox.valueChanged.connect(self._emit_dirty)
        emote_oy = QDoubleSpinBox()
        emote_oy.setRange(-9999.0, 9999.0)
        emote_oy.setDecimals(1)
        emote_oy.setValue(se_oy)
        emote_oy.valueChanged.connect(self._emit_dirty)
        emote_form.addRow("target", emote_tgt)
        emote_form.addRow("emote", emote_txt)
        emote_form.addRow("duration (ms)", emote_dur)
        emote_form.addRow("anchorOffsetX", emote_ox)
        emote_form.addRow("anchorOffsetY", emote_oy)
        emote_bubble = BubbleAnchorPickField(
            self,
            self._model,
            se_ay,
            lambda: actor_for_emote_target(self._model, bind_sid, emote_tgt.current_id()),
            bubble_text_provider=emote_txt.emote_text,
            committed_scale=se_sc,
        )
        emote_bubble.changed.connect(self._emit_dirty)
        emote_tgt.value_changed.connect(lambda _v: emote_bubble.refresh_actor())
        self._widgets["_subtitle_emote_bubble"] = emote_bubble
        emote_form.addRow("位置/大小", emote_bubble)

        emote_section = _CollapsibleSection("字幕旁表情（可选）", emote_body, self)
        emote_section.setToolTip(
            "目标仅能从绑定场景实体下拉；气泡文案用下拉与「插入」快捷键，也可用「其他…」。"
            "选定目标且气泡非「(无)」时写入 subtitleEmote。"
        )
        if se_t and se_e:
            emote_section.expand_if(True)

        # 逐字显示：字幕缺省整句上屏（旁白/画外音多是短句，逐字反而拖节奏），勾上才逐字。
        tw_chk = QCheckBox("逐字显示（打字机）", self)
        tw_chk.setChecked(self._step_data.get("typewriter") is True)
        tw_chk.setToolTip(
            "缺省不勾 = 整句上屏（字幕的缺省，与过场对白框相反）。\n"
            "勾上 = 这条字幕逐字打出来；打字期间玩家点一下先补完，再点才过这一拍。\n"
            "玩家在设置里关掉「逐字显示」时一律整句——玩家偏好压过编排。\n"
            "配了定时/配音自动推进的拍要留意：字太长可能没打完就被推走。"
        )
        tw_chk.toggled.connect(lambda _v: self._emit_dirty())

        self._widgets["text"] = tw
        self._widgets["_subtitle_typewriter"] = tw_chk
        self._widgets["_subtitle_layout_mode"] = layout_combo
        self._widgets["_subtitle_mode"] = cw
        self._widgets["_subtitle_frac"] = frac
        self._widgets["_subtitle_classic_wrap"] = classic_wrap
        self._widgets["_subtitle_movie_band"] = band_c
        self._widgets["_subtitle_movie_align"] = align_c
        self._widgets["_subtitle_movie_wrap"] = movie_wrap
        self._widgets["_subtitle_voice"] = voice_field
        self._widgets["_subtitle_emote_target"] = emote_tgt
        self._widgets["_subtitle_emote_emote"] = emote_txt
        self._widgets["_subtitle_emote_duration"] = emote_dur
        self._widgets["_subtitle_emote_ox"] = emote_ox
        self._widgets["_subtitle_emote_oy"] = emote_oy

        self._present_params_layout.addRow("text", tw)
        self._present_params_layout.addRow("", tw_chk)
        self._present_params_layout.addRow("布局模式", layout_combo)
        self._present_params_layout.addRow("", classic_wrap)
        self._present_params_layout.addRow("", movie_wrap)
        self._present_params_layout.addRow("", voice_section)
        self._present_params_layout.addRow("", emote_section)
        self._subtitle_on_layout_mode_changed()

    def _build_show_img_present_params(self) -> None:
        pool_s: set[str] = set()
        pool_h: set[str] = set()
        ed = self._editor
        if ed is not None and hasattr(ed, "_outline_overlay_show_and_hide_sets"):
            pool_s, pool_h = ed._outline_overlay_show_and_hide_sets()

        uni = sorted(pool_s | pool_h, key=lambda x: (x.lower(), x))
        committed = str(self._step_data.get("id", "") or "").strip()
        orphan = (f"{committed} · 仅此数据引用") if committed else "未命名"
        sel = IdRefSelector(self, allow_empty=True, editable=True)
        sel.setMinimumWidth(160)
        if ed is not None and hasattr(ed, "_merged_overlay_rows"):
            rows_u = ed._merged_overlay_rows(uni, committed, orphan)
        else:
            rows_u = [(x, x) for x in uni]
            if committed and committed not in {x[0] for x in rows_u}:
                rows_u.append((committed, orphan))
        if not rows_u:
            rows_u = [("img", "img")]
        sel.set_items(rows_u)
        sel.set_current(committed)
        sel.value_changed.connect(self._emit_dirty)
        sel.setToolTip(
            "与 hideImg 配对；下拉为步骤树中出现的 id（可再行内输入）。"
        )

        img = CutsceneImagePathRow(self._model, str(self._step_data.get("image") or ""), self)
        img.setMinimumWidth(240)
        img._edit.textChanged.connect(self._emit_dirty)

        # 叠层顺序 zIndex：多层视差合成时用（背景小、前景大）；0=默认底层，写 0 不入键。
        zi_raw = self._step_data.get("zIndex")
        try:
            zi_init = float(zi_raw) if zi_raw is not None else 0.0
        except (TypeError, ValueError):
            zi_init = 0.0
        zw = QDoubleSpinBox(self)
        zw.setRange(0, 9999)
        zw.setDecimals(0)
        zw.setSingleStep(10)
        zw.setValue(zi_init)
        zw.setMaximumWidth(96)
        zw.setToolTip(
            "叠层顺序：越大越靠前（多层视差合成用，背景层小、前景层大）；"
            "电影黑边恒 10000 在最上，正常填 0–999。0=默认底层，不写入该键。"
        )
        zw.valueChanged.connect(self._emit_dirty)
        self._widgets["zIndex"] = zw
        self._playsimg_zindex_orig = zi_raw

        self._widgets["id"] = sel
        self._widgets["image"] = img
        self._present_params_layout.addRow("id", sel)
        self._present_params_layout.addRow("image", img)
        self._present_params_layout.addRow("zIndex 叠层", zw)
        self._build_show_img_ken_burns_section()

    def _build_show_img_ken_burns_section(self) -> None:
        """showImg 可选 kenBurns 缓推缓移；默认折叠，未启用不写键。"""
        kb_raw = self._step_data.get("kenBurns")
        kb = kb_raw if isinstance(kb_raw, dict) else None

        def _kbf(key: str, dv: float) -> float:
            if kb is None:
                return dv
            try:
                return float(kb.get(key, dv))
            except (TypeError, ValueError):
                return dv

        kb_on = QCheckBox("启用")
        kb_on.setChecked(kb is not None)
        kb_on.setToolTip(
            "勾选后写入 kenBurns：图片显示后开始匀速缓推缓移，不阻塞后续步骤；"
            "hideImg / 同 id 换图 / 跳过过场即停。"
        )
        kb_on.toggled.connect(self._emit_dirty)

        def _kb_spin(lo: float, hi: float, dec: int, step: float, val: float, tip: str) -> QDoubleSpinBox:
            w = QDoubleSpinBox()
            w.setRange(lo, hi)
            w.setDecimals(dec)
            w.setSingleStep(step)
            w.setValue(val)
            w.setMaximumWidth(96)
            w.setToolTip(tip)
            w.valueChanged.connect(self._emit_dirty)
            return w

        kb_fs = _kb_spin(1.0, 3.0, 3, 0.01, _kbf("fromScale", 1.0),
                         "起始缩放（cover 铺满=1.0；运行时低于 1 会被夹到 1，保证不露底）")
        kb_ts = _kb_spin(1.0, 3.0, 3, 0.01, _kbf("toScale", 1.08),
                         "结束缩放；缓推 1.0→1.05~1.12 最自然")
        kb_fx = _kb_spin(-20.0, 20.0, 2, 0.5, _kbf("fromX", 0.0),
                         "起点水平偏移（屏宽%；右正左负，超出缩放余量每帧自动夹紧）")
        kb_fy = _kb_spin(-20.0, 20.0, 2, 0.5, _kbf("fromY", 0.0),
                         "起点垂直偏移（屏高%；下正上负）")
        kb_tx = _kb_spin(-20.0, 20.0, 2, 0.5, _kbf("toX", 0.0), "终点水平偏移（屏宽%）")
        kb_ty = _kb_spin(-20.0, 20.0, 2, 0.5, _kbf("toY", 0.0), "终点垂直偏移（屏高%）")
        kb_dur = _kb_spin(1.0, 600000.0, 0, 500.0, _kbf("durationMs", 12000.0),
                          "漂移时长 ms，到时停在终点（运行时缺省 12000）")

        def _kb_pair(label_a: str, wa: QWidget, label_b: str, wb: QWidget) -> QWidget:
            roww = QWidget()
            hl = QHBoxLayout(roww)
            hl.setContentsMargins(0, 0, 0, 0)
            hl.addWidget(QLabel(label_a))
            hl.addWidget(wa)
            hl.addWidget(QLabel(label_b))
            hl.addWidget(wb)
            hl.addStretch(1)
            return roww

        kb_body = QWidget(self)
        kb_form = compact_form(QFormLayout(kb_body))
        kb_form.setContentsMargins(8, 4, 8, 4)
        kb_form.addRow(kb_on)
        kb_form.addRow("缩放", _kb_pair("from", kb_fs, "→ to", kb_ts))
        kb_form.addRow("起点偏移 %", _kb_pair("x", kb_fx, "y", kb_fy))
        kb_form.addRow("终点偏移 %", _kb_pair("x", kb_tx, "y", kb_ty))
        kb_form.addRow("durationMs", kb_dur)
        kb_sec = _CollapsibleSection("Ken Burns 缓推缓移（可选）", kb_body, self)
        kb_sec.expand_if(kb is not None)

        self._widgets["_kb_enable"] = kb_on
        self._widgets["_kb_fromScale"] = kb_fs
        self._widgets["_kb_toScale"] = kb_ts
        self._widgets["_kb_fromX"] = kb_fx
        self._widgets["_kb_fromY"] = kb_fy
        self._widgets["_kb_toX"] = kb_tx
        self._widgets["_kb_toY"] = kb_ty
        self._widgets["_kb_durationMs"] = kb_dur
        self._present_params_layout.addRow(kb_sec)

    def _show_img_merge_ken_burns_optional(self, d: dict) -> None:
        """启用才写 kenBurns；只写偏离运行时默认或原数据已有的键，未改动数值按原始表示回写。"""
        kb_on = self._widgets.get("_kb_enable")
        if not isinstance(kb_on, QCheckBox) or not kb_on.isChecked():
            return
        orig_raw = self._original_data.get("kenBurns")
        orig = orig_raw if isinstance(orig_raw, dict) else {}
        # (键, 运行时缺省)：等于缺省且原数据没有该键 → 不写，保持 JSON 紧凑
        runtime_defaults = [
            ("fromScale", 1.0), ("toScale", 1.0),
            ("fromX", 0.0), ("fromY", 0.0), ("toX", 0.0), ("toY", 0.0),
            ("durationMs", 12000.0),
        ]
        out: dict[str, Any] = {}
        for key, dv in runtime_defaults:
            w = self._widgets.get(f"_kb_{key}")
            if not isinstance(w, QDoubleSpinBox):
                continue
            val = float(w.value())
            if key in orig or abs(val - dv) > 1e-9:
                out[key] = val
        preserve_numeric_repr(out, orig)
        d["kenBurns"] = out

    def _show_img_merge_zindex_optional(self, d: dict) -> None:
        """zIndex：0=默认底层不写键；非 0 写整数；未改动按原始表示回写（避免 10→10.0 漂移）。"""
        w = self._widgets.get("zIndex")
        if not isinstance(w, QDoubleSpinBox):
            return
        v = int(round(w.value()))
        orig = getattr(self, "_playsimg_zindex_orig", None)
        if v == 0 and orig is None:
            return
        if v == 0 and orig is not None:
            # 原有 zIndex 被清回 0 → 显式移除该键（回默认底层）
            d.pop("zIndex", None)
            return
        out = {"zIndex": v}
        preserve_numeric_repr(out, {"zIndex": orig})
        d["zIndex"] = out["zIndex"]

    def _build_anim_layer_present_params(self) -> None:
        """animLayer：网格图集循环动画叠层。animFile 走 anim 包下拉；定位/透明/zIndex 可选，未设不写。"""
        model = self._model
        bundles = sorted(model.all_anim_files()) if model is not None and hasattr(model, "all_anim_files") else []
        cur_file = str(self._step_data.get("animFile", "") or "").strip()
        rows = [(b, f"/resources/runtime/animation/{b}/anim.json") for b in bundles]
        # fx_ 特效包排前
        rows.sort(key=lambda r: (not r[0].startswith("fx_"), r[0]))
        fsel = FilterableTypeCombo(rows or [("(无动画包)", "")], self, select_only=True)
        if cur_file:
            if cur_file not in {r[1] for r in rows}:
                fsel.set_entries([(f"(数据) {cur_file}", cur_file)] + (rows or []))
            fsel.set_committed_type(cur_file)
        elif rows:
            fsel.set_committed_type(rows[0][1])
        fsel.typeCommitted.connect(lambda _t: self._emit_dirty())
        fsel.setToolTip("选 anim 包（fx_* 为特效包）→ 写 animFile=…/animation/<包>/anim.json")

        idw = QLineEdit(str(self._step_data.get("id", "") or ""), self)
        idw.setPlaceholderText("叠层句柄 id（与 hideImg 配对，如 fog）")
        idw.textChanged.connect(self._emit_dirty)

        # state：从所选 anim 包的 states 枚举（选择器，禁手打；已存的未知值注入保留）。
        def _state_rows(manifest_path: str) -> list[tuple[str, str]]:
            states: list[str] = []
            if model is not None and hasattr(model, "animation_state_names_for_manifest"):
                states = list(model.animation_state_names_for_manifest(manifest_path))
            return [("（缺省 idle）", "")] + [(s, s) for s in states]

        cur_state = str(self._step_data.get("state", "") or "").strip()
        state_rows = _state_rows(cur_file)
        if cur_state and all(x[1] != cur_state for x in state_rows):
            state_rows = [(f"(数据) {cur_state}", cur_state)] + state_rows
        statew = FilterableTypeCombo(state_rows, self, select_only=True)
        statew.set_committed_type(cur_state)
        statew.setToolTip("动画状态名（取自所选 anim 包 anim.json 的 states）；留缺省即 idle。")
        statew.typeCommitted.connect(lambda _t: self._emit_dirty())

        def _refresh_state_choices(new_file: str) -> None:
            cur = statew.committed_type().strip()
            rows2 = _state_rows(new_file.strip())
            if cur and all(x[1] != cur for x in rows2):
                rows2 = [(f"(数据) {cur}", cur)] + rows2
            statew.blockSignals(True)
            try:
                statew.set_entries(rows2)
                statew.set_committed_type(cur)
            finally:
                statew.blockSignals(False)

        fsel.typeCommitted.connect(_refresh_state_choices)

        def _opt_spin(key: str, lo: float, hi: float, dec: int, step: float, dv: float, tip: str) -> QDoubleSpinBox:
            v = self._step_data.get(key)
            try:
                init = float(v) if v is not None else dv
            except (TypeError, ValueError):
                init = dv
            w = QDoubleSpinBox(self)
            w.setRange(lo, hi)
            w.setDecimals(dec)
            w.setSingleStep(step)
            w.setValue(init)
            w.setMaximumWidth(96)
            w.setToolTip(tip)
            w.valueChanged.connect(self._emit_dirty)
            return w

        ww = _opt_spin("widthPercent", 0.0, 400.0, 1, 5.0, 0.0, "宽度（屏宽%）；0=cover 铺满全屏，>0=按百分比定位。默认 0")
        xw = _opt_spin("xPercent", 0.0, 100.0, 1, 1.0, 50.0, "中心 X（屏宽%）；仅百分比布局用。默认 50")
        yw = _opt_spin("yPercent", 0.0, 100.0, 1, 1.0, 50.0, "中心 Y（屏高%）；仅百分比布局用。默认 50")
        aw = _opt_spin("alpha", 0.0, 1.0, 2, 0.05, 1.0, "整体透明度 0–1，默认 1")
        zw = _opt_spin("zIndex", 0.0, 9999.0, 0, 10.0, 0.0, "叠层顺序，越大越靠前（FX 常压在插画上，如 100）。默认 0")

        self._widgets["_al_file"] = fsel
        self._widgets["_al_id"] = idw
        self._widgets["_al_state"] = statew
        self._widgets["_al_widthPercent"] = ww
        self._widgets["_al_xPercent"] = xw
        self._widgets["_al_yPercent"] = yw
        self._widgets["_al_alpha"] = aw
        self._widgets["_al_zIndex"] = zw

        self._present_params_layout.addRow("animFile", fsel)
        self._present_params_layout.addRow("id", idw)
        self._present_params_layout.addRow("state", statew)
        body = QWidget(self)
        form = compact_form(QFormLayout(body))
        form.setContentsMargins(8, 4, 8, 4)
        xy = QWidget()
        xyl = QHBoxLayout(xy)
        xyl.setContentsMargins(0, 0, 0, 0)
        xyl.addWidget(QLabel("x"))
        xyl.addWidget(xw)
        xyl.addWidget(QLabel("y"))
        xyl.addWidget(yw)
        xyl.addStretch(1)
        form.addRow("宽度 %(0=铺满)", ww)
        form.addRow("中心 x/y %", xy)
        form.addRow("alpha", aw)
        form.addRow("zIndex", zw)
        sec = _CollapsibleSection("定位 / 透明 / 叠层（可选）", body, self)
        sec.expand_if(any(k in self._step_data for k in ("xPercent", "yPercent", "widthPercent", "alpha", "zIndex")))
        self._present_params_layout.addRow(sec)

    def _anim_layer_to_dict(self) -> dict:
        d: dict = {"kind": "present", "type": "animLayer"}
        fsel = self._widgets.get("_al_file")
        d["animFile"] = fsel.committed_type().strip() if isinstance(fsel, FilterableTypeCombo) else ""
        idw = self._widgets.get("_al_id")
        idv = idw.text().strip() if isinstance(idw, QLineEdit) else ""
        if idv:
            d["id"] = idv
        statew = self._widgets.get("_al_state")
        st = statew.committed_type().strip() if isinstance(statew, FilterableTypeCombo) else ""
        if st:
            d["state"] = st
        defaults = {"xPercent": 50.0, "yPercent": 50.0, "widthPercent": 0.0, "alpha": 1.0, "zIndex": 0.0}
        orig = self._original_data if isinstance(self._original_data, dict) else {}
        out_nums: dict[str, Any] = {}
        for key, dv in defaults.items():
            w = self._widgets.get(f"_al_{key}")
            if not isinstance(w, QDoubleSpinBox):
                continue
            val = float(w.value())
            if key in orig or abs(val - dv) > 1e-9:
                out_nums[key] = int(round(val)) if key == "zIndex" else val
        preserve_numeric_repr(out_nums, orig)
        d.update(out_nums)
        return d

    def _build_parallax_scene_present_params(self) -> None:
        """parallaxScene：播放 parallax_scenes.json 里的多层视差场景。

        场景本体（图层/关键帧/轨迹）由独立的 parallax Web 编辑器维护；这里只让人
        选「播哪个场景」+ 可选叠层句柄 handle。id 是引用他者，按 §3 必须走选择器。
        内联 scene / 未来字段在 to_dict 里 deepcopy 原样透传，不丢。
        """
        model = self._model
        rows = model.all_parallax_scene_ids() if (model is not None and hasattr(model, "all_parallax_scene_ids")) else []
        committed = str(self._step_data.get("id", "") or "").strip()
        has_inline = isinstance(self._step_data.get("scene"), dict)

        sel = IdRefSelector(self, allow_empty=True, editable=True)
        sel.setMinimumWidth(220)
        rows_u = list(rows)
        if committed and committed not in {r[0] for r in rows_u}:
            rows_u.append((committed, f"{committed} · 不在 parallax_scenes.json"))
        if not rows_u:
            rows_u = [("", "（parallax_scenes.json 暂无场景，去 parallax 编辑器新建）")]
        sel.set_items(rows_u)
        sel.set_current(committed)
        sel.value_changed.connect(self._emit_dirty)
        sel.setToolTip(
            "选要播放的 parallax 场景（候选来自 parallax_scenes.json）。\n"
            "图层与关键帧轨迹在独立的 parallax Web 编辑器里配置。"
        )
        self._widgets["_px_id"] = sel

        handle = QLineEdit(str(self._step_data.get("handle", "") or ""), self)
        handle.setPlaceholderText("叠层句柄（可选；缺省=匿名自动托管，下一幕自动顶掉；写了则需手动 hideImg）")
        handle.textChanged.connect(self._emit_dirty)
        self._widgets["_px_handle"] = handle

        self._present_params_layout.addRow("场景 id", sel)
        self._present_params_layout.addRow("handle", handle)

        open_btn = QPushButton("在 Parallax 编辑器里配置轨迹…", self)
        open_btn.setToolTip(
            "打开独立的 Parallax 视差编辑器（Web，端口 5205）配置图层/关键帧/轨迹；\n"
            "已选场景 id 会自动带入。图层与关键帧只在那里维护，这里只选播哪个场景。"
        )
        open_btn.clicked.connect(self._on_open_parallax_editor)
        self._present_params_layout.addRow(open_btn)

        if has_inline:
            note = QLabel("① 本步内联了 scene 对象（不走注册表）；保存时原样保留。", self)
            note.setWordWrap(True)
            note.setStyleSheet("color: #c98;")
            app_theme.set_editor_font_role(note, app_theme.FONT_ROLE_HINT)
            self._present_params_layout.addRow(note)

    def _on_open_parallax_editor(self) -> None:
        """另起 Parallax 视差编辑器（tools.parallax_editor 内部起 Vite dev + 开浏览器，
        已在跑则复用），并把当前场景 id 作 ?scene= 深链带过去。"""
        import subprocess
        import sys
        from pathlib import Path

        sel = self._widgets.get("_px_id")
        scene_id = sel.current_id().strip() if isinstance(sel, IdRefSelector) else ""
        repo_root = Path(__file__).resolve().parents[3]
        cmd = [sys.executable, "-m", "tools.parallax_editor"]
        if scene_id:
            cmd += ["--scene", scene_id]
        try:
            subprocess.Popen(cmd, cwd=str(repo_root))
        except OSError as e:
            QMessageBox.critical(self, "Parallax 编辑器", f"启动失败：\n{e}")

    def _parallax_scene_to_dict(self) -> dict:
        # 保留-再覆盖：以构造快照为底（含内联 scene / 未来字段），只覆盖 id / handle 两个可编辑项。
        base = self._step_data if isinstance(self._step_data, dict) else {}
        d: dict = deepcopy(base)
        d["kind"] = "present"
        d["type"] = "parallaxScene"
        sel = self._widgets.get("_px_id")
        sid = sel.current_id().strip() if isinstance(sel, IdRefSelector) else ""
        if sid:
            d["id"] = sid
        else:
            d.pop("id", None)
        hw = self._widgets.get("_px_handle")
        hv = hw.text().strip() if isinstance(hw, QLineEdit) else ""
        if hv:
            d["handle"] = hv
        else:
            d.pop("handle", None)
        return d

    def _build_hide_img_present_params(self) -> None:
        pool_s: set[str] = set()
        ed = self._editor
        if ed is not None and hasattr(ed, "_outline_overlay_show_and_hide_sets"):
            pool_s, _ = ed._outline_overlay_show_and_hide_sets()

        uni_show = sorted(pool_s, key=lambda x: (x.lower(), x))
        committed = str(self._step_data.get("id", "") or "").strip()
        orphan = (f"{committed} · 先于 showImg") if committed else "未命名"
        sel = IdRefSelector(self, allow_empty=True, editable=True)
        sel.setMinimumWidth(160)
        if ed is not None and hasattr(ed, "_merged_overlay_rows"):
            rows_u = ed._merged_overlay_rows(uni_show, committed, orphan)
        else:
            rows_u = [(x, x) for x in uni_show]
            if committed and committed not in {x[0] for x in rows_u}:
                rows_u.append((committed, orphan))
        if not rows_u:
            rows_u = [("main", "main")]
        sel.set_items(rows_u)
        sel.set_current(committed)
        sel.value_changed.connect(self._emit_dirty)
        sel.setToolTip("选需隐藏的叠图 id（候选项为本步骤树内 showImg id）")

        self._widgets["id"] = sel
        self._present_params_layout.addRow("id", sel)

    def _ctx_scene_for_cutscene_actions(self) -> str | None:
        ed = self._editor
        if ed is None or not hasattr(ed, "cutscene_binding_target_scene"):
            return None
        s = ed.cutscene_binding_target_scene().strip()
        return s if s else None

    def _build_action(self) -> None:
        ad = {
            "type": str(self._step_data.get("type", CUTSCENE_ACTION_WHITELIST[0])),
            "params": dict(self._step_data.get("params") or {}),
        }
        self._action_row = ActionRow(
            ad,
            model=self._model,
            scene_id=self._ctx_scene_for_cutscene_actions(),
            show_delete_button=False,
            show_reorder_buttons=False,
            parent=self,
            cutscene_id=self._cutscene_id,
        )
        wl_set = set(CUTSCENE_ACTION_WHITELIST)
        self._action_row.type_combo.set_items(
            [(t, t) for t in CUTSCENE_ACTION_WHITELIST],
            orphan_label=lambda v: f"{v} · 过场白名单外",
        )
        ct = ad["type"]
        if ct in wl_set:
            self._action_row.type_combo.set_committed_type(ct)
        self._action_row.changed.connect(self._emit_dirty)
        self._body.addWidget(self._action_row)

    def _build_parallel(self) -> None:
        group = QGroupBox("并行轨（fork-join，齐后继续）")
        group.setStyleSheet("QGroupBox { font-weight: bold; }")
        self._parallel_group = group
        self._parallel_layout = QVBoxLayout(group)
        self._parallel_layout.setSpacing(4)
        tracks = self._step_data.get("tracks", []) or []
        for i, t in enumerate(tracks):
            ol = StepOutlineFrame(
                t, self._model, self._editor, group,
                indent_px=16,
                parallel_parent=self,
                zebra_alt=(i % 2 == 1),
                cutscene_id=self._cutscene_id,
            )
            self._child_outlines.append(ol)
            # 与复制/粘贴路径一致：子轨内容变化统一汇入编辑器去抖刷新
            # （序号/摘要/overlay id 候选池）；父级折叠摘要由子 StepWidget
            # ._emit_dirty 直调 _on_parallel_child_changed 刷新，保持不变。
            if self._editor is not None and hasattr(self._editor, "_on_any_outline_changed"):
                ol.contentChanged.connect(self._editor._on_any_outline_changed)
            self._parallel_layout.addWidget(ol)
        add_btn = QPushButton("+ Track")
        add_btn.clicked.connect(self._add_parallel_track)
        self._parallel_layout.addWidget(add_btn)
        self._body.addWidget(group)

    def _add_parallel_track(self) -> None:
        if self._parallel_layout is None:
            return
        if self._editor is not None:
            self._editor.push_undo_snapshot()
        data = {"kind": "present", "type": "waitTime", "duration": 1000}
        ol = StepOutlineFrame(
            data, self._model, self._editor,
            self._parallel_group,
            indent_px=16,
            parallel_parent=self,
            zebra_alt=(len(self._child_outlines) % 2 == 1),
            cutscene_id=self._cutscene_id,
        )
        self._child_outlines.append(ol)
        # 同 _build_parallel：统一连编辑器汇流；父级摘要靠 _emit_dirty 直调刷新。
        if self._editor is not None and hasattr(self._editor, "_on_any_outline_changed"):
            ol.contentChanged.connect(self._editor._on_any_outline_changed)
        self._parallel_layout.insertWidget(self._parallel_layout.count() - 1, ol)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def _preserve_present_numbers(self, d: dict) -> dict:
        """未改动的数值参数按原始 JSON 表示回写，避免 1000->1000.0 等漂移。

        仅当 kind/type 与构造时一致才比对原值；含 subtitleEmote 嵌套数值。
        """
        od = self._original_data
        if (
            not isinstance(od, dict)
            or od.get("kind") != d.get("kind")
            or od.get("type") != d.get("type")
        ):
            return d
        preserve_numeric_repr(d, od)
        se, ose = d.get("subtitleEmote"), od.get("subtitleEmote")
        if isinstance(se, dict) and isinstance(ose, dict):
            preserve_numeric_repr(se, ose)
        return d

    def is_disabled(self) -> bool:
        return self._disabled

    def set_disabled(self, on: bool) -> None:
        """由大纲行下推（唯一写入方向）；表单内不提供开关，故此处不标脏、不发信号。"""
        self._disabled = bool(on)

    def to_dict(self, *, kind_override: str | None = None,
                present_type_override: str | None = None) -> dict:
        d = self._serialize_step(
            kind_override=kind_override, present_type_override=present_type_override)
        return apply_step_disabled(d, self._disabled)

    def _serialize_step(self, *, kind_override: str | None = None,
                        present_type_override: str | None = None) -> dict:
        # override 仅供「切换前捕获旧内容」用（此刻控件仍是旧 kind/type）；正常序列化不传。
        kind = kind_override if kind_override is not None else self._kind_combo.currentData()

        if kind not in ("present", "action", "parallel"):
            # 未知 kind：原样透传原始数据（对齐未知 present type 策略）。
            return self._raw_passthrough_dict(str(kind))

        if kind == "action" and self._action_row is not None:
            ad = self._action_row.to_dict()
            return {"kind": "action", "type": ad["type"], "params": ad.get("params", {})}

        if kind == "present":
            ptype = (present_type_override if present_type_override is not None
                     else self._type_combo.committed_type())
            schema = _PRESENT_PARAMS.get(ptype, [])
            if not schema and ptype not in PRESENT_TYPES:
                base = deepcopy(self._original_data) if self._original_data.get("kind") == "present" else {}
                base["kind"] = "present"
                base["type"] = ptype
                return base
            d: dict = {"kind": "present", "type": ptype}
            if ptype == "animLayer":
                return self._anim_layer_to_dict()
            if ptype == "parallaxScene":
                return self._parallax_scene_to_dict()
            if ptype == "showDialogue":
                wdg = self._widgets.get("__showDialogue__")
                if isinstance(wdg, CutsceneShowDialogueFields):
                    d.update(wdg.to_step_dict())
                return d
            if ptype == "showSubtitle":
                wt = self._widgets.get("text")
                lm = self._widgets.get("_subtitle_layout_mode")
                txt = (
                    wt.toPlainText().strip("\ufeff") if hasattr(wt, "toPlainText") else ""
                )
                if isinstance(lm, FilterableTypeCombo) and lm.committed_type().strip() == "__movie__":
                    band_w = self._widgets.get("_subtitle_movie_band")
                    align_w = self._widgets.get("_subtitle_movie_align")
                    sb = "movieTop"
                    sa = "center"
                    if isinstance(band_w, FilterableTypeCombo):
                        sb = band_w.committed_type().strip() or "movieTop"
                        if sb not in ("movieTop", "movieBottom"):
                            sb = "movieTop"
                    if isinstance(align_w, FilterableTypeCombo):
                        sa = align_w.committed_type().strip() or "center"
                        if sa not in ("left", "center", "right"):
                            sa = "center"
                    d.update({
                        "kind": "present",
                        "type": "showSubtitle",
                        "text": txt,
                        "subtitleBand": sb,
                        "subtitleAlign": sa,
                    })
                    self._show_subtitle_merge_voice_optional(d)
                    self._show_subtitle_merge_typewriter(d)
                    self._show_subtitle_merge_emote_optional(d)
                    return self._preserve_present_numbers(d)
                cw = self._widgets.get("_subtitle_mode")
                frac = self._widgets.get("_subtitle_frac")
                po: Any = "bottom"
                if isinstance(cw, FilterableTypeCombo):
                    pv = cw.committed_type().strip()
                    if pv == "__num__" and isinstance(frac, QDoubleSpinBox):
                        po = float(frac.value())
                    else:
                        po = pv
                d.update({"kind": "present", "type": "showSubtitle", "text": txt, "position": po})
                self._show_subtitle_merge_voice_optional(d)
                self._show_subtitle_merge_typewriter(d)
                self._show_subtitle_merge_emote_optional(d)
                return self._preserve_present_numbers(d)
            for pname, pt in schema:
                w = self._widgets.get(pname)
                if w is None:
                    continue
                if pt == "float":
                    d[pname] = w.value()
                elif pt == "bool":
                    d[pname] = w.isChecked()
                elif pt == "text":
                    d[pname] = w.toPlainText()
                elif pt == "image" and isinstance(w, CutsceneImagePathRow):
                    d[pname] = w.path()
                elif isinstance(w, IdRefSelector):
                    cur = w.current_id().strip()
                    # showImg/hideImg 的 id 空且原本就无该键 → 不写空 id（运行时缺省=匿名镜头位
                    # 自动托管，写 id:"" 反而会被当成字面空键）；既有 id 原样保留。
                    if cur == "" and pname not in self._original_data:
                        continue
                    d[pname] = cur
                else:
                    d[pname] = w.text() if hasattr(w, "text") else str(w)
            if ptype == "showImg":
                self._show_img_merge_zindex_optional(d)
                self._show_img_merge_ken_burns_optional(d)
            if ptype in ("cameraMove", "cameraZoom"):
                self._merge_camera_easing_optional(d)
            return self._preserve_present_numbers(d)

        if kind == "parallel":
            if self._parallel_malformed:
                # tracks 畸形（非列表/含非 dict 轨）：未建子轨表单，原样透传防丢数据。
                return self._raw_passthrough_dict("parallel")
            return {
                "kind": "parallel",
                "tracks": [ol.to_dict() for ol in self._child_outlines],
            }

        return {"kind": kind}


# ===============================================================
# StepOutlineFrame — 大纲行 + 可折叠详情
# ===============================================================

class StepOutlineFrame(QFrame):
    """竖排大纲中的一行：色条、摘要、估算时长/甘特、折叠详情。"""

    contentChanged = Signal()

    def __init__(
        self,
        step: dict,
        model: ProjectModel | None,
        editor: "TimelineEditor",
        parent: QWidget | None = None,
        *,
        indent_px: int = 0,
        parallel_parent: StepWidget | None = None,
        zebra_alt: bool = False,
        cutscene_id: str | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
        self._indent_px = indent_px
        self._zebra_alt = zebra_alt
        self._collapsed = True
        self._focused = False
        self._issue_level: str | None = None
        self._cutscene_id = (cutscene_id or "") or None
        self._step_snapshot = deepcopy(step)
        #: 禁用态以本行为准（折叠时表单尚未建，展开时下推给 StepWidget）
        self._disabled = step_is_disabled(step)
        self._step: StepWidget | None = None
        self._cutscene_header_drag_press_local: QPoint | None = None
        self._cutscene_drag_occurred_this_press = False

        root = QVBoxLayout(self)
        root.setContentsMargins(self._indent_px, 2, 0, 2)
        root.setSpacing(0)

        self._header = QFrame()
        self._header.setObjectName("cutsceneStepHeader")
        hl = QHBoxLayout(self._header)
        hl.setContentsMargins(4, 2, 4, 2)  # 收紧纵向留白，长序列一屏多看几步
        hl.setSpacing(6)

        self._strip = QLabel()
        self._strip.setFixedWidth(6)
        hl.addWidget(self._strip)

        self._idx_lbl = QLabel("—")
        self._idx_lbl.setMinimumWidth(28)
        self._idx_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._idx_lbl.setStyleSheet(f"font-family: {_MONO_FONT_QSS};")
        hl.addWidget(self._idx_lbl)

        self._badge = QLabel()
        self._badge.setMargin(4)
        bf = self._badge.font()
        bf.setBold(True)
        self._badge.setFont(bf)
        hl.addWidget(self._badge)

        self._summary = QLabel()
        self._summary.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self._summary.setWordWrap(True)
        hl.addWidget(self._summary, stretch=1)

        # 校验标记（默认空；「校验」后对有问题的步骤显示 ⚠/✖ + 悬停详情）。非透明以支持 tooltip。
        self._issue_lbl = QLabel("")
        self._issue_lbl.setFixedWidth(18)
        self._issue_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hl.addWidget(self._issue_lbl)

        self._dur_lbl = QLabel("")
        self._dur_lbl.setFixedWidth(56)
        self._dur_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._dur_lbl.setToolTip("估算耗时（仅供参考）")
        hl.addWidget(self._dur_lbl)

        self._gantt = QLabel()
        self._gantt.setFixedSize(_GANTT_BAR_PX + 8, 14)
        self._gantt.setScaledContents(False)
        self._gantt.setToolTip("相对时长（只读，仅供参考）")
        hl.addWidget(self._gantt)

        # 禁用开关：把一步临时"注释掉"（数据留着、运行时整步跳过）。排戏时反复开关，
        # 与「从这一步播」同属主循环，故与它并排常驻，不藏进「⋯」。
        self._btn_disable = outline_row_tool_button(
            self._header, "", fallback_text="禁", fixed_width=28, fixed_height=26,
        )
        self._btn_disable.setCheckable(True)
        self._btn_disable.setChecked(self._disabled)
        self._btn_disable.toggled.connect(self._on_disable_toggled)
        hl.addWidget(self._btn_disable)

        # 从这一步排演：反复调参数的主循环，必须一键可达（藏进「⋯」菜单等于没有）
        self._btn_play = outline_row_tool_button(
            self._header, "从这一步开始播",
            std=QStyle.StandardPixmap.SP_MediaPlay,
            fixed_width=28,
            fixed_height=26,
        )
        self._btn_play.setToolTip(
            "从这一步开始播：游戏侧先把之前的步瞬时走一遍（建立底图/图层/黑边/相机/"
            "演员站位，跳过等待、对白与音效），到本步恢复常速。"
        )
        self._btn_play.clicked.connect(self._on_play_from_here)
        hl.addWidget(self._btn_play)

        self._btn_up = outline_row_tool_button(
            self._header, "上移",
            std=QStyle.StandardPixmap.SP_ArrowUp,
            fixed_width=28,
            fixed_height=26,
        )
        self._btn_down = outline_row_tool_button(
            self._header, "下移",
            std=QStyle.StandardPixmap.SP_ArrowDown,
            fixed_width=28,
            fixed_height=26,
        )
        self._btn_copy = outline_row_tool_button(
            self._header, "复制本步",
            theme_names=("edit-copy", "edit-duplicate"),
            std=QStyle.StandardPixmap.SP_FileDialogContentsView,
            fallback_text="C",
        )
        self._btn_del = outline_row_tool_button(
            self._header, "删除",
            theme_names=("edit-delete", "user-trash"),
            std=delete_standard_pixmap(),
            fallback_text="删",
        )
        hl.addWidget(self._btn_up)
        hl.addWidget(self._btn_down)
        hl.addWidget(self._btn_copy)
        hl.addWidget(self._btn_del)

        self._menu_btn = outline_row_tool_button(
            self._header, "并行移入/移出等",
            theme_names=("view-more-symbolic", "open-menu"),
            std=QStyle.StandardPixmap.SP_ToolBarHorizontalExtensionButton,
            fixed_width=28,
            fixed_height=26,
        )
        self._menu_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self._step_menu = QMenu(self._menu_btn)
        self._menu_btn.setMenu(self._step_menu)
        self._step_menu.aboutToShow.connect(self._populate_step_menu)
        hl.addWidget(self._menu_btn)

        self._expand = QToolButton(self._header)
        self._expand.setArrowType(Qt.ArrowType.RightArrow)
        self._expand.setToolTip("折叠/展开详情")
        self._expand.setAutoRaise(True)
        self._expand.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._expand.setFixedSize(28, 26)
        self._expand.clicked.connect(self._toggle_collapse)
        hl.addWidget(self._expand)

        for w in (self._strip, self._idx_lbl, self._badge, self._summary, self._dur_lbl, self._gantt):
            w.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)

        root.addWidget(self._header)
        self._header.installEventFilter(self)
        self._header.setToolTip(
            "拖动表头可调整顺序（仅限同级）；点击左侧摘要等区域可折叠/展开详情。",
        )
        self.setAcceptDrops(True)

        self._detail_wrap = QWidget()
        dl = QVBoxLayout(self._detail_wrap)
        dl.setContentsMargins(8, 4, 4, 4)
        root.addWidget(self._detail_wrap)

        self._btn_up.clicked.connect(lambda: self._do_move(-1))
        self._btn_down.clicked.connect(lambda: self._do_move(1))
        self._btn_copy.clicked.connect(self._do_copy)
        self._btn_del.clicked.connect(self._do_delete)

        self._detail_wrap.setVisible(False)
        self._sync_disable_button()
        self.refresh_header()

    # ----- 禁用（只记录、不播放） -----

    def is_step_disabled(self) -> bool:
        return self._disabled

    def set_step_disabled(self, on: bool) -> None:
        """本行是禁用态的唯一真相源：展开后下推给 StepWidget，序列化时再统一写回。"""
        on = bool(on)
        if on == self._disabled:
            self._sync_disable_button()
            return
        self._disabled = on
        if self._step is not None:
            self._step.set_disabled(on)
        self._sync_disable_button()
        self.refresh_header()
        self._emit_dirty()

    def _sync_disable_button(self) -> None:
        b = self._btn_disable
        # 程序化回填不得回打 toggled——否则「构造即标脏」。
        b.blockSignals(True)
        b.setChecked(self._disabled)
        b.blockSignals(False)
        b.setToolTip(
            "已禁用：数据留着，播放时整步跳过。点此恢复播放。"
            if self._disabled
            else "禁用本步：数据留着，播放时整步跳过（等于把这一步临时注释掉）。"
        )

    def _on_disable_toggled(self, on: bool) -> None:
        self.set_step_disabled(on)

    def _header_dict(self) -> dict:
        if self._step is not None:
            return self._step.to_dict()
        return apply_step_disabled(deepcopy(self._step_snapshot), self._disabled)

    def ensure_step_detail(self) -> None:
        self._ensure_detail_built()

    def _ensure_detail_built(self) -> None:
        if self._step is not None:
            return
        self._step = StepWidget(
            self._step_snapshot, self._model, self._editor, self._detail_wrap,
            parallel_parent=self._parallel_parent,
            cutscene_id=self._cutscene_id,
        )
        self._step._outline_frame = self
        # 折叠期间可能已被切过禁用态，快照是旧的：以本行为准回灌一次。
        self._step.set_disabled(self._disabled)
        lay = self._detail_wrap.layout()
        if isinstance(lay, QVBoxLayout):
            lay.addWidget(self._step)
        self._step.contentChanged.connect(self._on_step_content_changed)

    def step_kind(self) -> str:
        if self._step is not None:
            return str(self._step._kind_combo.currentData())
        return str(self._step_snapshot.get("kind", "present"))

    def to_dict(self) -> dict:
        if self._step is not None:
            return self._step.to_dict()
        return apply_step_disabled(deepcopy(self._step_snapshot), self._disabled)

    def set_row_index(self, idx: object) -> None:
        # idx 顶层为序号字符串（"3"），并行子轨为分层号（"3.1"）。
        text = str(idx)
        self._idx_lbl.setText(text)
        width = max(28, self._idx_lbl.fontMetrics().horizontalAdvance(text) + 8)
        self._idx_lbl.setMinimumWidth(width)
        self._idx_lbl.setMaximumWidth(width)

    def _on_play_from_here(self) -> None:
        ed = self._editor
        if ed is not None:
            ed.focus_outline(self)
            ed.play_from_outline(self)

    def issue_level(self) -> str | None:
        """最近一次校验给本行打的标记（None / "warn" / "error"）；缩略条据此打红点。"""
        return getattr(self, "_issue_level", None)

    def is_collapsed(self) -> bool:
        return self._collapsed

    def set_issue_marker(self, level: str | None, messages: list[str]) -> None:
        self._issue_level = level or None
        if not level:
            self._issue_lbl.setText("")
            self._issue_lbl.setToolTip("")
            self._issue_lbl.setStyleSheet("")
            return
        if level == "error":
            self._issue_lbl.setText("✖")
            color = app_theme.semantic_text_color("error")
        else:
            self._issue_lbl.setText("⚠")
            color = app_theme.semantic_text_color("warn")
        self._issue_lbl.setStyleSheet(f"color: {color}; font-weight: bold;")
        self._issue_lbl.setToolTip("\n".join(messages))

    def set_zebra_alt(self, alt: bool) -> None:
        self._zebra_alt = alt
        self._refresh_header_surface()

    def _editor_theme_id(self) -> str:
        tid = getattr(self._editor, "_theme_id", None)
        if tid in app_theme.ALL_THEME_IDS:
            return str(tid)
        return app_theme.current_theme_id()

    def _refresh_header_surface(self) -> None:
        tid = self._editor_theme_id()
        kind = str(self._header_dict().get("kind", "present"))
        if app_theme.is_dark_theme(tid):
            border = "#454b54"
            if kind == "action":
                even, odd = "#273040", "#2f3848"
            elif kind == "parallel":
                even, odd = "#302838", "#3a3242"
            else:
                even, odd = "#2b2f36", "#343a42"
        else:
            border = "#dee2e6"
            if kind == "action":
                even, odd = "#eef5ff", "#e3edfd"
            elif kind == "parallel":
                even, odd = "#f3edfb", "#ebe3f5"
            else:
                even, odd = "#ffffff", "#f1f3f5"
        bg = odd if self._zebra_alt else even
        if self._focused:
            # 当前焦点条：整行换底 + 左侧粗强调边。斑马纹/展开态都不够跳，
            # 长列表里「我在改哪条」必须一眼认出来（这是滚动位置回答不了的问题）。
            if app_theme.is_dark_theme(tid):
                bg, accent = "#3d4250", "#ffd43b"
            else:
                bg, accent = "#fff3bf", "#e8590c"
            self._header.setStyleSheet(
                f"QFrame#cutsceneStepHeader {{ background-color: {bg};"
                f" border-bottom: 1px solid {border};"
                f" border-left: 3px solid {accent}; }}"
            )
            return
        self._header.setStyleSheet(
            f"QFrame#cutsceneStepHeader {{ background-color: {bg};"
            f" border-bottom: 1px solid {border}; border-left: 3px solid transparent; }}"
        )

    def set_focused(self, on: bool) -> None:
        if on != self._focused:
            self._focused = on
            self._refresh_header_surface()

    def _kind_palette(self, kind: str, theme_id: str) -> tuple[str, str, str]:
        """strip, badge_bg, badge_fg"""
        return kind_palette(kind, theme_id)

    def refresh_header(self) -> None:
        tid = self._editor_theme_id()
        d = self._header_dict()
        kind = str(d.get("kind", "present"))
        self._refresh_header_surface()
        sp, bb, bf = self._kind_palette(kind, tid)
        dark = app_theme.is_dark_theme(tid)
        primary = "#dcdcdc" if dark else "#1a1a1a"
        muted = "#a0a0a0" if dark else "#666666"
        if self._disabled:
            # 禁用行整体退成灰：色条/徽章去色 + 摘要加删除线，扫一眼就知道这段不会播。
            sp = "#5c636a" if dark else "#adb5bd"
            bb, bf = ("#495057", "#adb5bd") if dark else ("#dee2e6", "#868e96")
            primary = muted
        self._strip.setStyleSheet(f"background-color: {sp}; border-radius: 2px;")
        labels = {"present": "PRESENT", "action": "ACTION", "parallel": "PARALLEL"}
        self._badge.setText(labels.get(kind, kind.upper()))
        self._badge.setStyleSheet(
            f"background-color: {bb}; color: {bf}; border-radius: 4px; padding: 2px 6px;"
        )
        self._idx_lbl.setStyleSheet(
            f"color: {muted}; font-family: {_MONO_FONT_QSS};"
        )
        self._summary.setStyleSheet(f"color: {primary};")
        self._dur_lbl.setStyleSheet(f"color: {muted};")
        names = self._editor.speaker_names()
        if kind == "parallel":
            if self._step is not None:
                tracks = [ol.to_dict() for ol in self._step._child_outlines]
                summ = parallel_tracks_summary(tracks, names)
            else:
                summ = parallel_tracks_summary(d.get("tracks") or [], names)
        else:
            summ = step_summary_line(d, names)
        f = self._summary.font()
        f.setStrikeOut(self._disabled)
        self._summary.setFont(f)
        self._summary.setText(f"〔已禁用〕{summ}" if self._disabled else summ)

        # 禁用步的估时由 estimate_step_duration_ms 直接归 0（显示「—」），此处无需特判
        est = estimate_step_duration_ms(d)
        self._dur_lbl.setText(format_duration_hint(est))
        self._gantt.setStyleSheet(gantt_style_for_ms(est, tid))

    def _on_step_content_changed(self) -> None:
        self.refresh_header()
        self.contentChanged.emit()

    def _maybe_start_cutscene_header_drag(self, me: QMouseEvent) -> None:
        if self._cutscene_header_drag_press_local is None:
            return
        if not (me.buttons() & Qt.MouseButton.LeftButton):
            return
        delta = me.position().toPoint() - self._cutscene_header_drag_press_local
        if delta.manhattanLength() < QApplication.startDragDistance():
            return
        mime = QMimeData()
        mime.setData(_CUTSCENE_STEP_DRAG_MIME, QByteArray(b"x"))
        self._editor._dnd_cutscene_step_source = self
        drag = QDrag(self._header)
        drag.setMimeData(mime)
        self._cutscene_drag_occurred_this_press = True
        try:
            drag.exec(Qt.DropAction.MoveAction)
        finally:
            self._editor._dnd_cutscene_step_source = None
            self._cutscene_header_drag_press_local = None

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is not self._header:
            return super().eventFilter(watched, event)
        et = event.type()
        if et == QEvent.Type.MouseButtonPress:
            me = event
            if isinstance(me, QMouseEvent) and me.button() == Qt.MouseButton.LeftButton:
                self._cutscene_drag_occurred_this_press = False
                self._cutscene_header_drag_press_local = me.position().toPoint()
            return False
        if et == QEvent.Type.MouseMove:
            me = event
            if isinstance(me, QMouseEvent):
                self._maybe_start_cutscene_header_drag(me)
            return False
        if et == QEvent.Type.MouseButtonRelease:
            me = event
            if isinstance(me, QMouseEvent) and me.button() == Qt.MouseButton.LeftButton:
                skip_toggle = self._cutscene_drag_occurred_this_press
                self._cutscene_header_drag_press_local = None
                self._cutscene_drag_occurred_this_press = False
                if skip_toggle:
                    return True
                self._toggle_collapse()
                return True
            return False
        return super().eventFilter(watched, event)

    def dragEnterEvent(self, event) -> None:
        src = self._editor._dnd_cutscene_step_source
        md = event.mimeData()
        if (
            src is None
            or md is None
            or not md.hasFormat(_CUTSCENE_STEP_DRAG_MIME)
            or src is self
            or src._parallel_parent is not self._parallel_parent
        ):
            event.ignore()
            return
        event.acceptProposedAction()

    def dragMoveEvent(self, event) -> None:
        self._editor._autoscroll_steps_for_drag()
        self.dragEnterEvent(event)

    def flash_highlight(self) -> None:
        """搜索命中跳转后的短暂高亮，帮助在长列表里认出当前定位到的步骤。"""
        self._header.setStyleSheet(
            "QFrame#cutsceneStepHeader { background-color: #ffe08a; "
            "border: 2px solid #f59f00; }"
        )
        # 用 self 作 context：若该行在高亮期间被删除，回调不再触发（避免访问已析构对象）。
        QTimer.singleShot(850, self, self._refresh_header_surface)

    def dropEvent(self, event) -> None:
        src = self._editor._dnd_cutscene_step_source
        md = event.mimeData()
        if (
            src is None
            or md is None
            or not md.hasFormat(_CUTSCENE_STEP_DRAG_MIME)
            or src is self
            or src._parallel_parent is not self._parallel_parent
        ):
            event.ignore()
            return
        pos_y = event.position().y()
        hh = self._header.height()
        if pos_y < hh:
            insert_before = pos_y < hh / 2
        else:
            insert_before = False
        if self._editor._reorder_outline_relative_to_target(
            src, self, insert_before=insert_before,
        ):
            event.acceptProposedAction()
        else:
            event.ignore()

    def set_collapsed(self, collapsed: bool, *, refresh: bool = True) -> None:
        if not collapsed:
            self._ensure_detail_built()
        self._collapsed = collapsed
        self._detail_wrap.setVisible(not collapsed)
        self._expand.setArrowType(
            Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
        )
        if refresh:
            self.refresh_header()

    def _toggle_collapse(self) -> None:
        # 点表头即认定「我在看这条」——展开与收起都算（收起后仍是刚动过的那条）
        if self._editor is not None:
            self._editor.focus_outline(self)
        self.set_collapsed(not self._collapsed)

    def _get_owner_list_and_layout(self):
        if self._parallel_parent is not None:
            return self._parallel_parent._child_outlines, self._parallel_parent._parallel_layout
        return self._editor._step_outlines, self._editor._steps_layout

    def _do_move(self, delta: int) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        j = i + delta
        if j < 0 or j >= len(lst):
            return
        self._editor._reorder_outline_to_index(self, j)

    def _do_copy(self) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        self._editor.push_undo_snapshot()
        data = deepcopy(self.to_dict())
        parent_host: QWidget = (
            self._parallel_parent._parallel_group
            if self._parallel_parent is not None and self._parallel_parent._parallel_group is not None
            else self._editor._steps_container
        )
        new_ol = StepOutlineFrame(
            data, self._model, self._editor,
            parent_host,
            indent_px=self._indent_px,
            parallel_parent=self._parallel_parent,
            zebra_alt=(len(lst) % 2 == 1),
            cutscene_id=self._cutscene_id,
        )
        new_ol.contentChanged.connect(self._editor._on_any_outline_changed)
        lst.insert(i + 1, new_ol)
        self._editor._relayout_outline_list(lst, layout)
        self._editor._refresh_outline_indices_and_zebra()
        self._emit_dirty()

    def _do_delete(self) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            _idx_check = lst.index(self)
        except ValueError:
            return
        self._editor.push_undo_snapshot()
        lst.remove(self)
        layout.removeWidget(self)
        self.deleteLater()
        self._editor._refresh_outline_indices_and_zebra()
        self._emit_dirty()

    def _emit_dirty(self) -> None:
        self._editor.mark_pending_changes()
        self.contentChanged.emit()

    def _insert_sibling(self, kind: str, *, after: bool) -> None:
        """在本步前/后插入同级新步（仅顶层；并行轨用其「+ Track」）。"""
        if self._parallel_parent is not None:
            return
        ed = self._editor
        lst, layout = ed._step_outlines, ed._steps_layout
        try:
            i = lst.index(self)
        except ValueError:
            return
        ed.push_undo_snapshot()
        new_ol = StepOutlineFrame(
            _new_step_data(kind), self._model, ed, ed._steps_container,
            indent_px=0,
            parallel_parent=None,
            zebra_alt=False,
            cutscene_id=self._cutscene_id,
        )
        new_ol.contentChanged.connect(ed._on_any_outline_changed)
        lst.insert(i + 1 if after else i, new_ol)
        ed._relayout_outline_list(lst, layout)
        ed._refresh_outline_indices_and_zebra()
        self._emit_dirty()
        QTimer.singleShot(0, new_ol, lambda: ed._steps_scroll.ensureWidgetVisible(new_ol))

    def _populate_step_menu(self) -> None:
        ed = self._editor
        m = self._step_menu
        m.clear()

        # 连续对白段：一次改一串台词，不必逐句展开卡片。
        run = ed.dialogue_run_bounds(self)
        if run is not None:
            lo, hi = run
            a_run = QAction(f"✎ 批量编辑这段对白（第 {lo + 1}–{hi + 1} 句）", self)
            a_run.setToolTip(
                "把与本步相邻的连续对白/字幕步摊成一列逐句改；单条可展开成"
                "与外层完全一致的完整表单。"
            )
            a_run.triggered.connect(lambda: ed.edit_dialogue_run(self))
            m.addAction(a_run)

        a_new_block = QAction("＋ 在本步后插入对话块…", self)
        a_new_block.setToolTip("开一个空对话块连着写几句，确认后一次性插到本步之后。")
        a_new_block.setEnabled(self._parallel_parent is None)
        a_new_block.triggered.connect(lambda: ed.new_dialogue_block(after_ol=self))
        m.addAction(a_new_block)
        m.addSeparator()

        if self._parallel_parent is None:
            for after, head in ((False, "在本步前插入"), (True, "在本步后插入")):
                sub = m.addMenu(head)
                for k, lbl in (("present", "Present"), ("action", "Action"), ("parallel", "Parallel")):
                    act = sub.addAction(lbl)
                    act.triggered.connect(
                        lambda _c=False, kk=k, af=after: self._insert_sibling(kk, after=af))
            m.addSeparator()

            a_split = QAction("从本步后拆分为两个新过场…", self)
            try:
                split_at = ed._step_outlines.index(self)
            except ValueError:
                split_at = -1
            a_split.setEnabled(0 <= split_at < len(ed._step_outlines) - 1)
            a_split.setToolTip("原过场保留；前后步骤分别复制到两个新 id")
            a_split.triggered.connect(lambda: ed.split_after_outline(self))
            m.addAction(a_split)
            m.addSeparator()

        a_lift = QAction("从并行移出到外层（插在该并行块之后）", self)
        a_lift.setEnabled(self._parallel_parent is not None)
        a_lift.triggered.connect(lambda: ed.lift_parallel_track_out(self))
        m.addAction(a_lift)

        m.addSeparator()

        a_adj = QAction("与下一项合并为并行（两项 fork-join）", self)
        a_adj.setEnabled(ed.can_merge_adjacent_into_parallel(self))
        a_adj.triggered.connect(lambda: ed.merge_adjacent_into_parallel(self))
        m.addAction(a_adj)

        a_prev = QAction("并入上一并行（作为最后一轨）", self)
        a_prev.setEnabled(ed.can_merge_into_prev_parallel(self))
        a_prev.triggered.connect(lambda: ed.merge_into_prev_parallel(self))
        m.addAction(a_prev)

        a_next = QAction("并入下一并行（作为第一轨）", self)
        a_next.setEnabled(ed.can_merge_into_next_parallel(self))
        a_next.triggered.connect(lambda: ed.merge_into_next_parallel(self))
        m.addAction(a_next)

        # 长序列远距离重排：一格一格点太慢，补「移到顶部/底部/指定位置」（顶层与并行轨通用）。
        lst, _lay = self._get_owner_list_and_layout()
        if lst is not None and len(lst) > 1:
            try:
                cur_i = lst.index(self)
            except ValueError:
                cur_i = -1
            last = len(lst) - 1
            m.addSeparator()
            a_top = QAction("移到顶部", self)
            a_top.setEnabled(cur_i > 0)
            a_top.triggered.connect(lambda: ed._reorder_outline_to_index(self, 0))
            m.addAction(a_top)
            a_bottom = QAction("移到底部", self)
            a_bottom.setEnabled(0 <= cur_i < last)
            a_bottom.triggered.connect(
                lambda: ed._reorder_outline_to_index(
                    self, len(self._get_owner_list_and_layout()[0]) - 1))
            m.addAction(a_bottom)
            a_pos = QAction("移动到位置…", self)
            a_pos.triggered.connect(self._prompt_move_to_position)
            m.addAction(a_pos)

        # 禁用开关（行上已有常驻按钮，这里补一条带说明的入口）。
        m.addSeparator()
        a_dis = QAction(
            "恢复播放本步" if self._disabled else "禁用本步（保留数据，不播放）", self)
        a_dis.setCheckable(True)
        a_dis.setChecked(self._disabled)
        a_dis.setToolTip("禁用的步骤仍留在数据里，运行时整步跳过（parallel 连子轨一起跳）。")
        a_dis.triggered.connect(lambda checked: self.set_step_disabled(checked))
        m.addAction(a_dis)

        # 剪贴板：复制/剪切本步（可跨过场、进出并行粘贴）。
        m.addSeparator()
        a_copy_cb = QAction("复制到剪贴板", self)
        a_copy_cb.triggered.connect(lambda: ed.copy_step_to_clipboard(self))
        m.addAction(a_copy_cb)
        a_cut = QAction("剪切", self)
        a_cut.triggered.connect(lambda: ed.cut_step(self))
        m.addAction(a_cut)
        a_paste = QAction("粘贴到本步后", self)
        a_paste.setEnabled(TimelineEditor._step_clipboard is not None)
        a_paste.triggered.connect(lambda: ed.paste_step_after(self))
        m.addAction(a_paste)

    def _prompt_move_to_position(self) -> None:
        lst, _ = self._get_owner_list_and_layout()
        if lst is None or self not in lst:
            return
        n = len(lst)
        cur = lst.index(self) + 1
        val, ok = QInputDialog.getInt(
            self, "移动到位置", f"目标位置（1–{n}，本级内）：", cur, 1, n)
        if ok:
            self._editor._reorder_outline_to_index(self, val - 1)


# ===============================================================
# 对白分组行（纯视图聚合：连续对白收成一行）
# ===============================================================

class DialogueGroupHeader(QFrame):
    """一段连续对白/字幕在列表里的组头行。

    **纯视图层**：cutscene 的 schema 是平铺 `steps` 数组，运行时也只认平铺，
    真加一层 group 会同时破坏往返契约与执行语义。所以这里只管「怎么显示」——
    折叠即把组内各行 setVisible(False)，磁盘上仍是一条条独立的 step。
    """

    def __init__(self, editor: "TimelineEditor", parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("cutsceneDialogueGroup")
        self._editor = editor
        self._collapsed = False
        self._members: list[StepOutlineFrame] = []
        self._key: str = ""

        hl = QHBoxLayout(self)
        hl.setContentsMargins(4, 2, 4, 2)
        hl.setSpacing(6)

        self._toggle = QToolButton(self)
        self._toggle.setAutoRaise(True)
        self._toggle.setFixedSize(22, 22)
        self._toggle.setArrowType(Qt.ArrowType.DownArrow)
        self._toggle.setToolTip("折叠/展开这段对白")
        self._toggle.clicked.connect(self.toggle)
        hl.addWidget(self._toggle)

        self._title = QLabel(self)
        tf = self._title.font()
        tf.setBold(True)
        self._title.setFont(tf)
        hl.addWidget(self._title)

        self._preview = QLabel(self)
        self._preview.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        hl.addWidget(self._preview, stretch=1)

        self._btn_play = outline_row_tool_button(
            self, "从这段开头开始播",
            std=QStyle.StandardPixmap.SP_MediaPlay, fixed_width=28, fixed_height=24)
        self._btn_play.clicked.connect(self._play_group)
        hl.addWidget(self._btn_play)

        self._btn_edit = outline_row_tool_button(
            self, "批量编辑这段对白",
            std=QStyle.StandardPixmap.SP_FileDialogDetailedView,
            fallback_text="✎", fixed_width=28, fixed_height=24)
        self._btn_edit.clicked.connect(self._edit_group)
        hl.addWidget(self._btn_edit)

        self._btn_add = outline_row_tool_button(
            self, "往这段末尾接写一句",
            std=QStyle.StandardPixmap.SP_FileDialogNewFolder,
            fallback_text="+", fixed_width=28, fixed_height=24)
        self._btn_add.clicked.connect(self._append_line)
        hl.addWidget(self._btn_add)

    # ---- 内容 ----

    def set_members(self, members: list["StepOutlineFrame"], key: str) -> None:
        self._members = list(members)
        self._key = key
        self.refresh_text()

    def group_key(self) -> str:
        return self._key

    def members(self) -> list["StepOutlineFrame"]:
        return list(self._members)

    def refresh_text(self) -> None:
        n = len(self._members)
        self._title.setText(f"对白 ×{n}")
        first = ""
        if self._members:
            try:
                d = self._members[0]._header_dict()
                first = str(d.get("text") or "").replace("\n", " ")
            except Exception:  # noqa: BLE001
                first = ""
        if len(first) > 42:
            first = first[:42] + "…"
        self._preview.setText(first)
        idx = ""
        ed = self._editor
        if ed is not None and self._members:
            try:
                lo = ed._step_outlines.index(self._members[0]) + 1
                hi = ed._step_outlines.index(self._members[-1]) + 1
                idx = f"第 {lo}–{hi} 步"
            except ValueError:
                idx = ""
        self.setToolTip(f"{idx}：{n} 句连续对白/字幕。点箭头或标题折叠整段。")
        self.refresh_surface()

    def refresh_surface(self) -> None:
        tid = app_theme.current_theme_id()
        ed = self._editor
        if ed is not None and getattr(ed, "_theme_id", None) in app_theme.ALL_THEME_IDS:
            tid = str(ed._theme_id)
        if app_theme.is_dark_theme(tid):
            bg, fg, border = "#2f3a33", "#8ce99a", "#454b54"
        else:
            bg, fg, border = "#e6fcf5", "#0b7285", "#dee2e6"
        self.setStyleSheet(
            f"QFrame#cutsceneDialogueGroup {{ background-color: {bg};"
            f" border-bottom: 1px solid {border}; border-left: 3px solid {fg}; }}"
        )
        self._title.setStyleSheet(f"color: {fg};")
        muted = "#a0a0a0" if app_theme.is_dark_theme(tid) else "#666666"
        self._preview.setStyleSheet(f"color: {muted};")

    # ---- 折叠 ----

    def is_collapsed(self) -> bool:
        return self._collapsed

    def set_collapsed(self, collapsed: bool) -> None:
        self._collapsed = bool(collapsed)
        self._toggle.setArrowType(
            Qt.ArrowType.RightArrow if self._collapsed else Qt.ArrowType.DownArrow)
        for m in self._members:
            try:
                m.setVisible(not self._collapsed)
            except RuntimeError:
                pass
        ed = self._editor
        if ed is not None:
            ed.remember_dialogue_group_state()

    def toggle(self) -> None:
        self.set_collapsed(not self._collapsed)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        if event.button() == Qt.MouseButton.LeftButton:
            self.toggle()
        super().mousePressEvent(event)

    # ---- 动作 ----

    def _first_member(self) -> "StepOutlineFrame | None":
        return self._members[0] if self._members else None

    def _play_group(self) -> None:
        ol = self._first_member()
        if ol is not None and self._editor is not None:
            self._editor.play_from_outline(ol)

    def _edit_group(self) -> None:
        ol = self._first_member()
        if ol is not None and self._editor is not None:
            self._editor.edit_dialogue_run(ol)

    def _append_line(self) -> None:
        if self._members and self._editor is not None:
            self._editor.append_line_to_group(self._members[-1])


# ===============================================================
# 缩略时间轴（顶层步骤的横向总览条）
# ===============================================================

class _MinimapCell:
    """缩略条上的一格 = 一个顶层步。"""

    __slots__ = ("kind", "ms", "summary", "issue", "disabled", "x", "w")

    def __init__(self, kind: str, ms: int | None, summary: str, issue: str | None,
                 disabled: bool = False):
        self.kind = kind
        self.ms = ms
        self.summary = summary
        self.issue = issue          # None / "warn" / "error"
        self.disabled = disabled    # 禁用步：不占时长、画成灰色空心格
        self.x = 0.0                # 布局后填：像素左沿
        self.w = 0.0                # 布局后填：像素宽


class StepMinimapBar(QWidget):
    """顶层步骤的横向缩略总览：一格一步、宽度按估时、颜色按 kind。

    存在理由是两个纵向列表天然给不了的东西：
    1. **我翻到哪了** —— 叠一层当前视口区间指示，滚动时实时跟随；
    2. **整段节奏什么形状** —— 宽度按估时（sqrt 压缩，免得一个 14s 的 kenBurns 吃掉整条），
       等待/对白这类"不定"时长画虚线格，一眼看出哪儿堆了慢镜、哪儿是连珠炮对白。

    点击某格 = 跳到该步（滚动 + 展开）。
    """

    cell_clicked = Signal(int)

    #: 每格最小像素宽——再密也要点得中
    _MIN_W = 5.0
    #: "不定"时长（对白/等待点击）按此毫秒参与分宽：约等于念一句话
    _INDETERMINATE_MS = 2500

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._cells: list[_MinimapCell] = []
        self._theme_id: str = app_theme.current_theme_id()
        self._current: int = -1
        self._vp_first: int = -1
        self._vp_last: int = -2
        self._hover: int = -1
        #: 游戏正在播的顶层步（轮询 __gameDevAPI.getCutscenePlayback 得来）；-1 = 没在播
        self._playhead: int = -1
        self.setFixedHeight(22)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip("")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    # ---- 数据入口 ----

    def set_cells(self, cells: list[_MinimapCell]) -> None:
        self._cells = cells
        self._relayout()
        self.update()

    def set_theme(self, theme_id: str) -> None:
        self._theme_id = theme_id
        self.update()

    def set_current(self, idx: int) -> None:
        if idx != self._current:
            self._current = idx
            self.update()

    def set_viewport(self, first: int, last: int) -> None:
        if (first, last) != (self._vp_first, self._vp_last):
            self._vp_first, self._vp_last = first, last
            self.update()

    def set_playhead(self, idx: int) -> None:
        """游戏播到第 idx 个顶层步；-1 = 没在播（清除播放头）。"""
        if idx != self._playhead:
            self._playhead = idx
            self.update()

    # ---- 布局 ----

    def _weight(self, ms: int | None) -> float:
        base = self._INDETERMINATE_MS if ms is None else max(int(ms), 0)
        # sqrt 压缩：长镜头仍然更宽，但不至于把几十个短步挤成看不见的线
        return (max(base, 120)) ** 0.5

    def _relayout(self) -> None:
        n = len(self._cells)
        if n == 0:
            return
        avail = max(self.width() - 2, n * self._MIN_W)
        weights = [self._weight(c.ms) for c in self._cells]
        total = sum(weights) or 1.0
        # 先按权重分，再抬到最小宽；抬高的部分从"富余"格里按比例扣回，保证总宽不溢出
        raw = [avail * w / total for w in weights]
        widths = [max(r, self._MIN_W) for r in raw]
        over = sum(widths) - avail
        if over > 0:
            slack = [(i, widths[i] - self._MIN_W) for i in range(n)]
            pool = sum(s for _i, s in slack) or 1.0
            for i, s in slack:
                widths[i] -= over * (s / pool)
        x = 1.0
        for c, w in zip(self._cells, widths):
            c.x, c.w = x, max(w, 1.0)
            x += c.w

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        super().resizeEvent(event)
        self._relayout()

    def _cell_at(self, px: float) -> int:
        for i, c in enumerate(self._cells):
            if c.x <= px < c.x + c.w:
                return i
        return -1

    # ---- 交互 ----

    def mousePressEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        if event.button() == Qt.MouseButton.LeftButton:
            i = self._cell_at(event.position().x())
            if i >= 0:
                self.cell_clicked.emit(i)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        i = self._cell_at(event.position().x())
        if i != self._hover:
            self._hover = i
            if 0 <= i < len(self._cells):
                c = self._cells[i]
                self.setToolTip(
                    f"#{i + 1}  {c.kind.upper()}  {format_duration_hint(c.ms)}\n{c.summary}"
                )
            else:
                self.setToolTip("")
            self.update()
        super().mouseMoveEvent(event)

    def leaveEvent(self, event) -> None:  # type: ignore[override]
        if self._hover != -1:
            self._hover = -1
            self.update()
        super().leaveEvent(event)

    # ---- 绘制 ----

    def paintEvent(self, event) -> None:  # type: ignore[override]
        from PySide6.QtGui import QPainter, QColor, QPen
        dark = app_theme.is_dark_theme(self._theme_id)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        h = self.height()

        track = QColor("#2b2f33") if dark else QColor("#e9ecef")
        p.fillRect(self.rect(), track)

        if not self._cells:
            p.setPen(QColor("#868e96"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "（无步骤）")
            p.end()
            return

        # 视口区间底色：先铺，免得盖住格子
        if 0 <= self._vp_first <= self._vp_last < len(self._cells):
            a = self._cells[self._vp_first]
            b = self._cells[self._vp_last]
            vp = QColor("#ffffff") if dark else QColor("#000000")
            vp.setAlpha(28 if dark else 18)
            p.fillRect(int(a.x) - 1, 0, int(b.x + b.w - a.x) + 2, h, vp)

        top, cell_h = 4, h - 8
        for i, c in enumerate(self._cells):
            strip, _bb, _bf = kind_palette(c.kind, self._theme_id)
            if c.disabled:
                strip = "#5c636a" if dark else "#adb5bd"
            col = QColor(strip)
            x, w = int(c.x), max(int(c.w), 1)
            if c.disabled:
                # 禁用格：低透明度实心，与"不定时长"的空心格区分开
                col.setAlpha(70)
                p.fillRect(x, top, w, cell_h, col)
            elif c.ms is None:
                # 不定时长：空心格，与固定时长的实心块区分开
                col.setAlpha(90)
                p.fillRect(x, top, w, cell_h, col)
                pen = QPen(QColor(strip))
                pen.setWidth(1)
                p.setPen(pen)
                p.drawRect(x, top, max(w - 1, 1), cell_h - 1)
            else:
                p.fillRect(x, top, w, cell_h, col)

            if c.issue:
                bad = QColor("#fa5252") if c.issue == "error" else QColor("#fab005")
                p.fillRect(x, 0, max(w, 2), 3, bad)

            if i == self._hover and w >= 2:
                hl = QColor("#ffffff") if dark else QColor("#000000")
                hl.setAlpha(60)
                p.fillRect(x, top, w, cell_h, hl)

        # 当前步：整高描边
        if 0 <= self._current < len(self._cells):
            c = self._cells[self._current]
            pen = QPen(QColor("#ffd43b") if dark else QColor("#e8590c"))
            pen.setWidth(2)
            p.setPen(pen)
            p.drawRect(int(c.x), 1, max(int(c.w) - 1, 2), h - 3)

        # 播放头：游戏此刻正在播的那一步——实心填充 + 左沿竖线，
        # 与"当前编辑步"的空心描边分得开（两者常常不是同一步）。
        if 0 <= self._playhead < len(self._cells):
            c = self._cells[self._playhead]
            glow = QColor("#ff6b6b") if dark else QColor("#c92a2a")
            fill = QColor(glow)
            fill.setAlpha(120)
            p.fillRect(int(c.x), top, max(int(c.w), 2), cell_h, fill)
            pen = QPen(glow)
            pen.setWidth(2)
            p.setPen(pen)
            p.drawLine(int(c.x), 0, int(c.x), h)

        p.end()


# ===============================================================
# 过场资产级拆分 / 组合向导
# ===============================================================


def _unique_cutscene_id(base: str, taken: set[str]) -> str:
    """为非破坏式资产操作生成稳定且不冲突的建议 id。"""
    stem = (base or "cutscene_part").strip() or "cutscene_part"
    if stem not in taken:
        return stem
    n = 2
    while f"{stem}_{n}" in taken:
        n += 1
    return f"{stem}_{n}"


class CutsceneSplitDialog(QDialog):
    """将一段过场复制拆成两个新资产；原资产始终保留。"""

    def __init__(
        self,
        source_id: str,
        *,
        first_count: int,
        second_count: int,
        taken_ids: set[str],
        bound_entity_count: int,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("拆分过场")
        self.resize(540, 300)
        self._taken_ids = set(taken_ids)

        root = QVBoxLayout(self)
        note = QLabel(
            f"将「{source_id}」复制拆成两个新过场（{first_count} 步 + "
            f"{second_count} 步）。\n原过场与它的所有引用保持不变。"
        )
        note.setWordWrap(True)
        root.addWidget(note)

        form = compact_form(QFormLayout())
        first_default = _unique_cutscene_id(f"{source_id}__part1", self._taken_ids)
        second_taken = self._taken_ids | {first_default}
        second_default = _unique_cutscene_id(f"{source_id}__part2", second_taken)
        self._first_id = QLineEdit(first_default)
        self._second_id = QLineEdit(second_default)
        form.addRow("前半段 id", self._first_id)
        form.addRow("后半段 id", self._second_id)
        root.addLayout(form)

        self._continuous = QCheckBox("前半段结束后保持现场（restoreState=false）")
        self._continuous.setChecked(True)
        self._continuous.setToolTip(
            "将两段连续播放时，前半段不应在中间恢复入场前现场；"
            "后半段继承原过场的 restoreState 语义。"
        )
        root.addWidget(self._continuous)

        self._copy_bindings = QCheckBox(
            f"把原过场绑定的 {bound_entity_count} 个 NPC/Hotspot 同步绑定到两个新段"
        )
        self._copy_bindings.setChecked(True)
        self._copy_bindings.setEnabled(bound_entity_count > 0)
        self._copy_bindings.setToolTip(
            "新过场 id 若没有同步到实体 cutsceneIds，cutsceneOnly 演员会在新段中缺席。"
        )
        root.addWidget(self._copy_bindings)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        buttons.accepted.connect(self._accept_checked)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

    def _accept_checked(self) -> None:
        first = self.first_id()
        second = self.second_id()
        if not first or not second:
            QMessageBox.warning(self, "拆分过场", "两个新过场 id 都不能为空。")
            return
        if first == second:
            QMessageBox.warning(self, "拆分过场", "前后两段必须使用不同 id。")
            return
        conflicts = [cid for cid in (first, second) if cid in self._taken_ids]
        if conflicts:
            QMessageBox.warning(
                self, "拆分过场",
                "下列 id 已存在，不会覆盖：\n" + "\n".join(conflicts),
            )
            return
        self.accept()

    def first_id(self) -> str:
        return self._first_id.text().strip()

    def second_id(self) -> str:
        return self._second_id.text().strip()

    def keep_continuity(self) -> bool:
        return self._continuous.isChecked()

    def copy_bindings(self) -> bool:
        return self._copy_bindings.isChecked()


class CutsceneCombineDialog(QDialog):
    """从多段已有过场挑选并排序，生成一个新顺序过场。"""

    def __init__(
        self,
        cutscenes: list[dict],
        *,
        initial_id: str = "",
        binding_signatures: dict[str, frozenset[tuple[str, str, str]]] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("组合过场")
        self.resize(760, 540)
        self._cutscenes = [c for c in cutscenes if isinstance(c, dict)]
        id_counts: dict[str, int] = {}
        for cutscene in self._cutscenes:
            cid = str(cutscene.get("id", "")).strip()
            if cid:
                id_counts[cid] = id_counts.get(cid, 0) + 1
        self._duplicate_ids = {cid for cid, count in id_counts.items() if count > 1}
        self._by_id = {
            str(c.get("id", "")).strip(): c for c in self._cutscenes
            if str(c.get("id", "")).strip()
        }
        self._binding_signatures = binding_signatures or {}
        self._selected_ids: list[str] = []
        if initial_id in self._by_id:
            self._selected_ids.append(initial_id)

        root = QVBoxLayout(self)
        note = QLabel(
            "按右侧顺序拼接顶层 steps，生成一个新过场；"
            "来源过场和旧引用都不会改动。只有根级场景绑定相容的过场才能组合。"
        )
        note.setWordWrap(True)
        root.addWidget(note)

        id_form = compact_form(QFormLayout())
        taken = set(self._by_id)
        base = f"{initial_id}__combined" if initial_id else "cutscene_combined"
        self._new_id = QLineEdit(_unique_cutscene_id(base, taken))
        id_form.addRow("新过场 id", self._new_id)
        root.addLayout(id_form)

        lists = QHBoxLayout()
        left = QVBoxLayout()
        left.addWidget(QLabel("可选过场（双击加入）"))
        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索 id / 场景 / 步数…")
        self._search.setClearButtonEnabled(True)
        self._search.textChanged.connect(self._refill_available)
        left.addWidget(self._search)
        self._available = QListWidget()
        self._available.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self._available.itemDoubleClicked.connect(lambda _it: self._add_selected())
        left.addWidget(self._available, 1)
        add_btn = QPushButton("添加 →")
        add_btn.clicked.connect(self._add_selected)
        left.addWidget(add_btn)
        lists.addLayout(left, 1)

        right = QVBoxLayout()
        right.addWidget(QLabel("组合顺序（双击移除）"))
        self._chosen = QListWidget()
        self._chosen.itemDoubleClicked.connect(lambda _it: self._remove_selected())
        right.addWidget(self._chosen, 1)
        order_row = QHBoxLayout()
        remove_btn = QPushButton("移除")
        remove_btn.clicked.connect(self._remove_selected)
        up_btn = QPushButton("上移")
        up_btn.clicked.connect(lambda: self._move_selected(-1))
        down_btn = QPushButton("下移")
        down_btn.clicked.connect(lambda: self._move_selected(1))
        order_row.addWidget(remove_btn)
        order_row.addWidget(up_btn)
        order_row.addWidget(down_btn)
        order_row.addStretch(1)
        right.addLayout(order_row)
        lists.addLayout(right, 1)
        root.addLayout(lists, 1)

        self._compatibility = QLabel("")
        self._compatibility.setWordWrap(True)
        root.addWidget(self._compatibility)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        buttons.accepted.connect(self._accept_checked)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

        self._refill_available("")
        self._refill_chosen()

    @staticmethod
    def _label(cutscene: dict) -> str:
        cid = str(cutscene.get("id", "") or "?")
        steps = cutscene.get("steps")
        n = len(steps) if isinstance(steps, list) else 0
        scene = str(cutscene.get("targetScene", "") or "").strip()
        return f"{cid}  ·  {n}步" + (f"  →{scene}" if scene else "")

    @staticmethod
    def _root_signature(cutscene: dict) -> dict:
        """连续拼接时必须全程一致的根级语义；restoreState 取末段。"""
        return {
            k: deepcopy(v) for k, v in cutscene.items()
            if k not in {"id", "steps", "commands", "restoreState"}
        }

    def _refill_available(self, query: str) -> None:
        q = (query or "").strip().casefold()
        self._available.clear()
        for cutscene in self._cutscenes:
            cid = str(cutscene.get("id", "") or "").strip()
            if not cid or cid in self._selected_ids:
                continue
            label = self._label(cutscene)
            if q and q not in label.casefold():
                continue
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, cid)
            self._available.addItem(item)

    def _refill_chosen(self, current_row: int | None = None) -> None:
        self._chosen.clear()
        for cid in self._selected_ids:
            cutscene = self._by_id.get(cid)
            if cutscene is None:
                continue
            item = QListWidgetItem(self._label(cutscene))
            item.setData(Qt.ItemDataRole.UserRole, cid)
            self._chosen.addItem(item)
        if self._chosen.count() > 0:
            row = self._chosen.count() - 1 if current_row is None else current_row
            self._chosen.setCurrentRow(max(0, min(row, self._chosen.count() - 1)))
        self._refill_available(self._search.text())
        self._refresh_compatibility()

    def _add_selected(self) -> None:
        ids = [
            str(it.data(Qt.ItemDataRole.UserRole) or "").strip()
            for it in self._available.selectedItems()
        ]
        if not ids and self._available.currentItem() is not None:
            ids = [str(self._available.currentItem().data(Qt.ItemDataRole.UserRole) or "").strip()]
        for cid in ids:
            if cid and cid not in self._selected_ids:
                self._selected_ids.append(cid)
        self._refill_chosen()

    def _remove_selected(self) -> None:
        row = self._chosen.currentRow()
        if not (0 <= row < len(self._selected_ids)):
            return
        self._selected_ids.pop(row)
        self._refill_chosen(max(0, row - 1))

    def _move_selected(self, delta: int) -> None:
        row = self._chosen.currentRow()
        dst = row + delta
        if not (0 <= row < len(self._selected_ids) and 0 <= dst < len(self._selected_ids)):
            return
        self._selected_ids[row], self._selected_ids[dst] = (
            self._selected_ids[dst], self._selected_ids[row]
        )
        self._refill_chosen(dst)

    def _compatibility_error(self) -> str:
        if len(self._selected_ids) < 2:
            return "请至少选择两段过场。"
        selected_duplicates = [cid for cid in self._selected_ids if cid in self._duplicate_ids]
        if selected_duplicates:
            return "来源 id 在项目中不唯一，无法确定要组合的资产：" + "、".join(
                selected_duplicates
            )
        cuts = [self._by_id[cid] for cid in self._selected_ids if cid in self._by_id]
        base = self._root_signature(cuts[0])
        bad = [str(c.get("id", "")) for c in cuts[1:] if self._root_signature(c) != base]
        if bad:
            return (
                "根级场景/出生点/位置或未知扩展字段不一致，无法无损组合："
                + "、".join(bad)
            )
        if self._binding_signatures:
            base_bindings = self._binding_signatures.get(self._selected_ids[0], frozenset())
            bad_bindings = [
                cid for cid in self._selected_ids[1:]
                if self._binding_signatures.get(cid, frozenset()) != base_bindings
            ]
            if bad_bindings:
                return (
                    "NPC/Hotspot 的 cutsceneIds 绑定集合不一致，直接组合会改变"
                    " cutsceneOnly 演员显影语义：" + "、".join(bad_bindings)
                )
        return ""

    def _refresh_compatibility(self) -> None:
        err = self._compatibility_error()
        if err:
            self._compatibility.setText("⚠ " + err)
            self._compatibility.setStyleSheet("color: #d9a441;")
        else:
            steps = sum(
                len(self._by_id[cid].get("steps") or []) for cid in self._selected_ids
            )
            self._compatibility.setText(f"✓ 可无损组合，共 {steps} 个顶层步骤。")
            self._compatibility.setStyleSheet("color: #4caf78;")

    def _accept_checked(self) -> None:
        new_id = self.new_id()
        if not new_id:
            QMessageBox.warning(self, "组合过场", "新过场 id 不能为空。")
            return
        if new_id in self._by_id:
            QMessageBox.warning(self, "组合过场", f"id「{new_id}」已存在，不会覆盖。")
            return
        err = self._compatibility_error()
        if err:
            QMessageBox.warning(self, "组合过场", err)
            return
        self.accept()

    def new_id(self) -> str:
        return self._new_id.text().strip()

    def selected_ids(self) -> list[str]:
        return list(self._selected_ids)


# ===============================================================
# TimelineEditor — 主 Tab
# ===============================================================

class TimelineEditor(QWidget):
    #: (cutscene_id, from_step)；from_step=0 整段常速播，>0 时前 N 个顶层步瞬时快进后从该步排演
    play_requested = Signal(str, int)

    # 步骤剪贴板（类级：可跨过场、跨编辑器实例粘贴一步的深拷贝）。
    _step_clipboard: dict | None = None

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1
        self._pending_changes = False
        self._loading_ui = False
        self._step_outlines: list[StepOutlineFrame] = []
        self._theme_id: str = app_theme.current_theme_id()
        self._pending_scene_refresh_need_propagate: bool = False
        self._scene_model_refresh_pending_while_hidden: bool = False
        self._scene_data_changed_debounce = QTimer(self)
        self._scene_data_changed_debounce.setSingleShot(True)
        self._scene_data_changed_debounce.timeout.connect(
            self._run_debounced_scene_model_refresh,
        )
        self._overlay_id_selectors_debounce = QTimer(self)
        self._overlay_id_selectors_debounce.setSingleShot(True)
        self._overlay_id_selectors_debounce.setInterval(48)
        self._overlay_id_selectors_debounce.timeout.connect(
            self._refresh_all_present_overlay_id_selectors,
        )
        self._overlay_selectors_fp_cache = ""
        self._overlay_selectors_fp_valid = False
        #: 摘要用的「实体 id → 显示名」表；见 speaker_names()
        self._speaker_names_cache: dict[str, str] | None = None
        self._dnd_cutscene_step_source: StepOutlineFrame | None = None
        # 对白分组组头（纯视图行，不进 _step_outlines）与当前焦点条
        self._dialogue_groups: list[DialogueGroupHeader] = []
        self._focused_outline: StepOutlineFrame | None = None
        # 内容编辑（逐键）触发的大纲序号/斑马/摘要全量刷新去抖；结构性操作仍即时刷新。
        self._index_refresh_debounce = QTimer(self)
        self._index_refresh_debounce.setSingleShot(True)
        self._index_refresh_debounce.setInterval(90)
        self._index_refresh_debounce.timeout.connect(
            self._refresh_outline_indices_and_zebra,
        )
        # 结构性编辑的撤销/重做栈（每项 = {"steps": 深快照, "expanded": 顶层展开下标,
        # "scroll": 滚动位}，恢复时连编辑现场一起还原）。
        self._undo_stack: list[dict] = []
        self._redo_stack: list[dict] = []
        # 每段过场的顶层展开态 + 滚动位置，切回时恢复「我刚在改哪一步」。
        self._view_state_by_cid: dict[str, dict] = {}

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 过场")
        btn_add.clicked.connect(self._add)
        btn_combine = QPushButton("组合…")
        btn_combine.setToolTip("筛选并排序多段相容过场，生成一个新过场；来源资产不改动")
        btn_combine.clicked.connect(self._open_combine_dialog)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中的过场（不可恢复）")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_combine)
        btn_row.addWidget(btn_del)
        btn_row.addStretch(1)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        # 过场列表搜索框（纯视图过滤，与 audio/archive/anim 一致，审查 P3-2）
        from ..shared.list_affordances import make_list_search_box
        self._list_search = make_list_search_box(
            self._list, placeholder="搜索过场 id / 摘要…")
        ll.addWidget(self._list_search)
        ll.addWidget(self._list)

        right = QWidget()
        rl = QVBoxLayout(right)

        top_row = QHBoxLayout()
        f = compact_form(QFormLayout())
        self._c_id = QLineEdit()
        f.addRow("id", self._c_id)
        top_row.addLayout(f, stretch=1)
        self._play_btn = QPushButton("Play")
        self._play_btn.setToolTip("在游戏预览中播放该过场")
        self._play_btn.clicked.connect(self._on_play)
        self._split_btn = QPushButton("拆分…")
        self._split_btn.setToolTip(
            "在当前焦点顶层步骤之后拆分，生成两个新过场；原过场不改动"
        )
        self._split_btn.clicked.connect(self._split_at_focused_outline)
        top_row.addWidget(self._split_btn)
        top_row.addWidget(self._play_btn)
        rl.addLayout(top_row)

        bind_form = compact_form(QFormLayout())
        self._target_scene = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        self._target_scene.setMinimumWidth(240)
        self._target_scene.setToolTip(
            "可留空（选 (none)）：留空 = 就在玩家当前所在场景开演，不切场景。\n"
            "填了且与玩家当前场景不同才会切场景（此时玩家会落到下面的出生点）；\n"
            "填成当前场景则不切、只是给编辑器一个上下文（NPC/说话人候选按它取）。\n"
            "若 JSON 中已有但工程未载入的场景，会显示为「未在项目场景表中」。"
        )
        self._refresh_target_scene_combo_items("")
        scene_label = QLabel("targetScene（可选）")
        scene_label.setToolTip(self._target_scene.toolTip())
        bind_form.addRow(scene_label, self._target_scene)

        self._spawn_key = ""
        self._spawn_loading = False
        spawn_row = QWidget()
        spawn_lay = QHBoxLayout(spawn_row)
        spawn_lay.setContentsMargins(0, 0, 0, 0)
        self._spawn_display = QLineEdit()
        self._spawn_display.setReadOnly(True)
        self._spawn_display.setPlaceholderText("不指定：就地开演")
        spawn_lay.addWidget(self._spawn_display, 1)
        self._spawn_pick_btn = QPushButton("选择出生点...")
        self._spawn_pick_btn.clicked.connect(self._open_spawn_picker)
        spawn_lay.addWidget(self._spawn_pick_btn)
        # 「不指定」本来就是合法值，但过去只能靠打开弹窗选第一行才回得去 → 看着像必填。
        self._spawn_clear_btn = QPushButton("清除")
        self._spawn_clear_btn.setToolTip("改回不指定：不挪玩家，就在当前镜头位置开演")
        self._spawn_clear_btn.clicked.connect(self._clear_spawn_key)
        spawn_lay.addWidget(self._spawn_clear_btn)
        spawn_label = QLabel("targetSpawnPoint（可选）")
        spawn_label.setToolTip(_SPAWN_FIELD_TIP)
        spawn_row.setToolTip(_SPAWN_FIELD_TIP)
        bind_form.addRow(spawn_label, spawn_row)
        self._target_scene.value_changed.connect(self._on_target_scene_changed)

        pos_row = QHBoxLayout()
        self._pos_chk = QCheckBox("targetX/Y")
        self._target_x = QDoubleSpinBox()
        self._target_x.setRange(-99999, 99999)
        self._target_x.setDecimals(1)
        self._target_y = QDoubleSpinBox()
        self._target_y.setRange(-99999, 99999)
        self._target_y.setDecimals(1)
        self._target_x.setEnabled(False)
        self._target_y.setEnabled(False)
        self._pos_chk.toggled.connect(self._target_x.setEnabled)
        self._pos_chk.toggled.connect(self._target_y.setEnabled)
        pos_row.addWidget(self._pos_chk)
        pos_row.addWidget(QLabel("X:"))
        pos_row.addWidget(self._target_x)
        pos_row.addWidget(QLabel("Y:"))
        pos_row.addWidget(self._target_y)
        bind_form.addRow(pos_row)

        self._restore_chk = QCheckBox("restoreState")
        self._restore_chk.setChecked(True)
        self._restore_chk.setToolTip("过场结束后是否恢复进入前的场景与玩家位置")
        bind_form.addRow(self._restore_chk)

        rl.addLayout(bind_form)

        hint_row = QHBoxLayout()
        hint = QLabel("<b>步骤序列</b>")
        hint.setToolTip(
            "竖排 = 执行顺序；PRESENT / ACTION / PARALLEL 色条区分；"
            "可拖动表头调整顺序（仅限同级）；点击表头空白或摘要可折叠/展开详情；"
            "右侧「不定/~ms」与灰条为粗估，仅供参考；"
            "「⋯」菜单：从本步后拆分过场、并行轨移出到外层、两项合并为并行、"
            "并入上/下一并行"
        )
        hint.setWordWrap(True)
        hint_row.addWidget(hint)
        self._validate_summary = QLabel("")
        self._validate_summary.setToolTip("点「校验」检查本过场的引用/类型/白名单/字幕语音等问题")
        hint_row.addWidget(self._validate_summary, stretch=1)
        btn_validate = QPushButton("校验")
        btn_validate.setToolTip(
            "检查本过场：未知类型 / 坏引用 / 非白名单动作 / 改存档动作 / 字幕语音缺失等；"
            "问题逐条列在下方清单，对应步骤同时打 ⚠/✖ 标记。",
        )
        btn_validate.clicked.connect(self._run_current_cutscene_validation)
        # 留引用：护栏测试要从这个真实入口点下去，不能只调内部方法
        self._btn_validate = btn_validate
        hint_row.addWidget(btn_validate)
        btn_collapse_all = QPushButton("全部折叠")
        btn_collapse_all.setToolTip("折叠本过场所有步骤（含并行子轨）")
        btn_collapse_all.clicked.connect(lambda: self._set_all_step_collapsed(True))
        btn_expand_all = QPushButton("全部展开")
        btn_expand_all.setToolTip("展开本过场所有步骤（含并行子轨）")
        btn_expand_all.clicked.connect(lambda: self._set_all_step_collapsed(False))
        hint_row.addWidget(btn_collapse_all)
        hint_row.addWidget(btn_expand_all)
        rl.addLayout(hint_row)

        # 校验问题清单：状态区只报「几条」，具体是什么必须直接看得见——藏进 tooltip 等于没报。
        # 无问题时整块隐藏，不占步骤列表的高度。
        self._issue_list = QListWidget()
        self._issue_list.setVisible(False)
        self._issue_list.setWordWrap(True)
        self._issue_list.setMaximumHeight(150)
        self._issue_list.setAlternatingRowColors(True)
        self._issue_list.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection)
        self._issue_list.setToolTip("校验发现的问题；点一条跳到对应步骤，右键可复制全部")
        self._issue_list.itemClicked.connect(self._on_issue_item_activated)
        self._issue_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._issue_list.customContextMenuRequested.connect(self._on_issue_list_menu)
        rl.addWidget(self._issue_list)

        # 步骤级搜索 / 定位（长过场里靠肉眼滚整列很痛）：过滤匹配的顶层步骤 + 命中间跳转。
        filter_row = QHBoxLayout()
        self._step_search = QLineEdit()
        self._step_search.setPlaceholderText("过滤步骤：正文 / 类型 / id / voice / action 参数…")
        self._step_search.setClearButtonEnabled(True)
        self._step_search.setToolTip(
            "输入关键词过滤顶层步骤（含折叠的并行内部内容一并搜索）；"
            "回车或「下一个」在命中间跳转。",
        )
        self._step_search.textChanged.connect(self._apply_step_filter)
        self._step_search.returnPressed.connect(lambda: self._goto_search_match(1))
        self._search_count = QLabel("")
        self._search_count.setToolTip("匹配数 / 当前命中")
        # 用 QStyle 标准箭头图标（"▲"文本在 modern 暗色 QSS 下渲染成空白方块）
        self._btn_prev_match = QPushButton()
        self._btn_prev_match.setIcon(
            self.style().standardIcon(QStyle.StandardPixmap.SP_ArrowUp))
        self._btn_prev_match.setFixedWidth(30)
        self._btn_prev_match.setToolTip("上一个匹配")
        self._btn_prev_match.clicked.connect(lambda: self._goto_search_match(-1))
        self._btn_next_match = QPushButton()
        self._btn_next_match.setIcon(
            self.style().standardIcon(QStyle.StandardPixmap.SP_ArrowDown))
        self._btn_next_match.setFixedWidth(30)
        self._btn_next_match.setToolTip("下一个匹配")
        self._btn_next_match.clicked.connect(lambda: self._goto_search_match(1))
        filter_row.addWidget(self._step_search, stretch=1)
        filter_row.addWidget(self._search_count)
        filter_row.addWidget(self._btn_prev_match)
        filter_row.addWidget(self._btn_next_match)
        rl.addLayout(filter_row)
        self._search_matches: list[StepOutlineFrame] = []
        self._search_match_idx: int = -1

        # 缩略时间轴：滚动区的「地图」——常驻在列表正上方，滚到哪、整段什么形状一眼可见。
        self._minimap = StepMinimapBar()
        self._minimap.setToolTip(
            "整段缩略：一格一个顶层步，宽度按估时、颜色按 kind、虚框=时长不定；"
            "浅色区间=当前可视范围，黄框=当前步，红格=游戏此刻正播到的步；"
            "格顶红/橙点=校验问题。点击跳到该步。"
        )
        self._minimap.cell_clicked.connect(self._on_minimap_cell_clicked)
        rl.addWidget(self._minimap)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._steps_scroll = scroll
        self._steps_container = QWidget()
        self._steps_layout = QVBoxLayout(self._steps_container)
        self._steps_layout.setSpacing(2)
        scroll.setWidget(self._steps_container)
        rl.addWidget(scroll, stretch=1)
        # 滚动即更新视口指示；只重绘不重算格子，54 步下无感。
        scroll.verticalScrollBar().valueChanged.connect(self._sync_minimap_viewport)

        step_btns = QHBoxLayout()
        # 常用预设放最前：新建一步的绝大多数场合都落在这几个组合里，
        # 不必再从空白 waitClick 去 16 种类型里翻。
        btn_block = QPushButton("+ 对话块")
        btn_block.setToolTip("开一个空对话块连着写几句，确认后一次性追加到末尾")
        btn_block.clicked.connect(lambda: self.new_dialogue_block(after_ol=None))
        step_btns.addWidget(btn_block)
        self._btn_preset = QToolButton()
        self._btn_preset.setText("+ 常用…")
        self._btn_preset.setToolTip("按常用组合一键插入（对白 / 字幕 / 音效 / 插画 / 黑场 / 黑边 / 推镜头）")
        self._btn_preset.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self._build_preset_menu(self._btn_preset)
        step_btns.addWidget(self._btn_preset)
        add_present = QPushButton("+ Present")
        add_present.clicked.connect(lambda: self._add_step("present"))
        add_action = QPushButton("+ Action")
        add_action.clicked.connect(lambda: self._add_step("action"))
        add_parallel = QPushButton("+ Parallel")
        add_parallel.clicked.connect(lambda: self._add_step("parallel"))
        step_btns.addWidget(add_present)
        step_btns.addWidget(add_action)
        step_btns.addWidget(add_parallel)
        step_btns.addStretch(1)
        rl.addLayout(step_btns)

        # 撤销/重做/粘贴另起一行。九枚按钮挤一行时这一行的最小宽是 902px，直接把整页
        # 顶出 13″ 预算（护栏 test_small_screen_layout）——而 Qt 的 QHBoxLayout 不会自动
        # 换行，宽度不够只会把整个面板撑出横向滚动条。按语义切一刀：上行是「加步骤」，
        # 下行是「改已有步骤」，宽屏上看起来仍是两排短工具条，不挤。
        edit_btns = QHBoxLayout()
        edit_btns.addStretch(1)
        self._btn_undo = QPushButton("↶ 撤销")
        self._btn_undo.setToolTip("撤销上一步结构编辑（增删/重排/复制粘贴/合并）  Ctrl+Z")
        self._btn_undo.clicked.connect(self.undo_last_structural)
        self._btn_redo = QPushButton("↷ 重做")
        self._btn_redo.setToolTip("重做  Ctrl+Y / Ctrl+Shift+Z")
        self._btn_redo.clicked.connect(self.redo_last_structural)
        self._btn_paste = QPushButton("粘贴")
        self._btn_paste.setToolTip("把剪贴板里的步骤追加到末尾（复制/剪切来自步骤「⋯」菜单）")
        self._btn_paste.clicked.connect(self.paste_step_append)
        edit_btns.addWidget(self._btn_undo)
        edit_btns.addWidget(self._btn_redo)
        edit_btns.addWidget(self._btn_paste)
        rl.addLayout(edit_btns)
        self._refresh_edit_buttons()

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 700])
        root.addWidget(splitter)

        self._refresh()
        self._model.data_changed.connect(self._on_model_data_changed)

        self._c_id.textChanged.connect(self.mark_pending_changes)
        self._target_scene.value_changed.connect(self.mark_pending_changes)
        self._pos_chk.toggled.connect(self.mark_pending_changes)
        self._target_x.valueChanged.connect(self.mark_pending_changes)
        self._target_y.valueChanged.connect(self.mark_pending_changes)
        self._restore_chk.toggled.connect(self.mark_pending_changes)

        # 撤销/重做快捷键（作用域限本编辑器控件树，不干扰全局）。
        for seq, slot in (
            (QKeySequence.StandardKey.Undo, self.undo_last_structural),
            (QKeySequence.StandardKey.Redo, self.redo_last_structural),
            (QKeySequence("Ctrl+Y"), self.redo_last_structural),
        ):
            sc = QShortcut(seq, self)
            sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            sc.activated.connect(slot)

    # ----- 撤销 / 重做（结构性编辑：增删 / 重排 / 复制粘贴 / 并行合并移出，
    #        以及切换 kind / present 类型前的「确认清空」——两个切换 handler 在确认后
    #        各压一次快照，兑现弹窗「可用 Ctrl+Z 撤销」的承诺；快照含步骤树 + 顶层
    #        展开态 + 滚动位，恢复时不丢编辑现场） -----

    def _capture_undo_state(self) -> dict | None:
        """当前过场的整份深快照（步骤树 + 顶层展开态 + 滚动位）；失败返回 None。"""
        try:
            steps = [ol.to_dict() for ol in self._step_outlines]
        except Exception:  # noqa: BLE001 — 快照失败绝不能打断用户操作
            return None
        return {
            "steps": deepcopy(steps),
            "expanded": [
                i for i, ol in enumerate(self._step_outlines) if not ol._collapsed
            ],
            "scroll": self._steps_scroll.verticalScrollBar().value(),
        }

    def push_undo_snapshot(self) -> None:
        """在一次结构性变更「之前」调用，捕获当前过场步骤树的整份深快照。"""
        if self._loading_ui or self._current_idx < 0:
            return
        snap = self._capture_undo_state()
        if snap is None:
            return
        self._undo_stack.append(snap)
        if len(self._undo_stack) > 80:
            self._undo_stack.pop(0)
        self._redo_stack.clear()

    def _restore_steps_snapshot(self, snap: dict | list) -> None:
        if isinstance(snap, list):  # 兼容旧 list 形态（防御）
            snap = {"steps": snap, "expanded": [], "scroll": None}
        self._rebuild_steps(
            deepcopy(snap.get("steps") or []),
            expanded_indices={int(i) for i in snap.get("expanded") or []},
        )
        sv = snap.get("scroll")
        if sv is not None:
            bar = self._steps_scroll.verticalScrollBar()
            QTimer.singleShot(0, self._steps_scroll, lambda: bar.setValue(int(sv)))
        self.mark_pending_changes()

    @staticmethod
    def _focused_text_widget():
        fw = QApplication.focusWidget()
        if isinstance(fw, (QLineEdit, QTextEdit, QPlainTextEdit)):
            return fw
        return None

    def undo_last_structural(self) -> None:
        # 焦点在文本框内时，Ctrl+Z 交回该框做文本撤销，不抢字段内编辑体验。
        tw = self._focused_text_widget()
        if tw is not None:
            tw.undo()
            return
        if not self._undo_stack:
            return
        current = self._capture_undo_state()
        if current is None:
            return
        self._redo_stack.append(current)
        snap = self._undo_stack.pop()
        self._restore_steps_snapshot(snap)

    def redo_last_structural(self) -> None:
        tw = self._focused_text_widget()
        if tw is not None:
            tw.redo()
            return
        if not self._redo_stack:
            return
        current = self._capture_undo_state()
        if current is None:
            return
        self._undo_stack.append(current)
        snap = self._redo_stack.pop()
        self._restore_steps_snapshot(snap)

    def _refresh_edit_buttons(self) -> None:
        if getattr(self, "_btn_undo", None) is not None:
            self._btn_undo.setEnabled(bool(self._undo_stack))
            self._btn_redo.setEnabled(bool(self._redo_stack))
            self._btn_paste.setEnabled(TimelineEditor._step_clipboard is not None)

    # ----- 步骤剪贴板：复制 / 剪切 / 粘贴（供 StepOutlineFrame 菜单 + 工具条调用） -----

    def copy_step_to_clipboard(self, ol: "StepOutlineFrame") -> None:
        TimelineEditor._step_clipboard = deepcopy(ol.to_dict())
        self._refresh_edit_buttons()

    def cut_step(self, ol: "StepOutlineFrame") -> None:
        TimelineEditor._step_clipboard = deepcopy(ol.to_dict())
        ol._do_delete()  # 自身已 push 撤销快照
        self._refresh_edit_buttons()

    def _new_outline_for_paste(self, data: dict, *, parallel_parent, host,
                               indent_px: int) -> "StepOutlineFrame":
        ol = StepOutlineFrame(
            deepcopy(data), self._model, self, host,
            indent_px=indent_px,
            parallel_parent=parallel_parent,
            zebra_alt=False,
            cutscene_id=self._current_cutscene_id(),
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        return ol

    def paste_step_after(self, ol: "StepOutlineFrame") -> None:
        if TimelineEditor._step_clipboard is None:
            return
        lst, layout = ol._get_owner_list_and_layout()
        if lst is None or layout is None or ol not in lst:
            return
        self.push_undo_snapshot()
        host = (ol._parallel_parent._parallel_group
                if ol._parallel_parent is not None and ol._parallel_parent._parallel_group is not None
                else self._steps_container)
        new_ol = self._new_outline_for_paste(
            TimelineEditor._step_clipboard, parallel_parent=ol._parallel_parent,
            host=host, indent_px=ol._indent_px)
        lst.insert(lst.index(ol) + 1, new_ol)
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()
        QTimer.singleShot(0, new_ol, lambda: self._steps_scroll.ensureWidgetVisible(new_ol))

    def paste_step_append(self) -> None:
        """把剪贴板步骤追加到顶层末尾（覆盖空过场 / 末尾粘贴场景）。"""
        if TimelineEditor._step_clipboard is None:
            return
        self.push_undo_snapshot()
        new_ol = self._new_outline_for_paste(
            TimelineEditor._step_clipboard, parallel_parent=None,
            host=self._steps_container, indent_px=0)
        self._step_outlines.append(new_ol)
        self._steps_layout.addWidget(new_ol)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()
        QTimer.singleShot(0, new_ol, lambda: self._steps_scroll.ensureWidgetVisible(new_ol))

    def on_editor_theme_changed(self, theme_id: str) -> None:
        self._theme_id = theme_id
        self._minimap.set_theme(theme_id)
        self._refresh_outline_indices_and_zebra()
        for h in self._dialogue_groups:
            h.refresh_surface()

    def _reorder_outline_to_index(self, outline: StepOutlineFrame, new_index: int) -> bool:
        """把 outline 移动到同级列表的最终下标 new_index。

        new_index 语义为「移动后的目标位置」。历史实现对向后移动多减了 1，导致
        「下移一格」被抵消成空操作（下移按钮点了没反应）；此处按目标下标直接插入。
        """
        lst, layout = outline._get_owner_list_and_layout()
        if lst is None or layout is None:
            return False
        try:
            old_i = lst.index(outline)
        except ValueError:
            return False
        if new_index < 0 or new_index >= len(lst):
            return False
        if old_i == new_index:
            return True
        self.push_undo_snapshot()
        lst.pop(old_i)
        lst.insert(new_index, outline)
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        outline._emit_dirty()
        return True

    def _reorder_outline_relative_to_target(
        self,
        source: StepOutlineFrame,
        target: StepOutlineFrame,
        *,
        insert_before: bool,
    ) -> bool:
        if source is target:
            return False
        if source._parallel_parent is not target._parallel_parent:
            return False
        lst, layout = source._get_owner_list_and_layout()
        t_lst, t_layout = target._get_owner_list_and_layout()
        if lst is not t_lst or layout is None or t_layout is None or layout is not t_layout:
            return False
        try:
            from_i = lst.index(source)
            to_i = lst.index(target)
        except ValueError:
            return False
        self.push_undo_snapshot()
        lst.pop(from_i)
        if from_i < to_i:
            to_i -= 1
        insert_at = to_i if insert_before else (to_i + 1)
        lst.insert(insert_at, source)
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        source._emit_dirty()
        return True

    def _iter_all_step_outlines(self):
        def walk(ol: StepOutlineFrame):
            yield ol
            if ol._step is None:
                return
            if ol._step._kind_combo.currentData() == "parallel":
                for c in ol._step._child_outlines:
                    yield from walk(c)

        for top in self._step_outlines:
            yield from walk(top)

    def _set_all_step_collapsed(self, collapsed: bool) -> None:
        if collapsed:
            for ol in self._iter_all_step_outlines():
                ol.set_collapsed(True, refresh=False)
            return
        # 展开全部：parallel 子轨在父级 StepWidget 构建后才进入迭代，需多轮直到无仍折叠的结点
        while True:
            batch = list(self._iter_all_step_outlines())
            pending = [ol for ol in batch if ol._collapsed]
            if not pending:
                break
            for ol in pending:
                ol.set_collapsed(False, refresh=False)

    def _on_any_outline_changed(self) -> None:
        # 逐键内容编辑走去抖，避免每次按键都 O(步骤数) 重排序号/斑马/摘要。
        # 结构性操作（增删/重排/复制）自身会直接调 _refresh_outline_indices_and_zebra 即时刷新。
        self._index_refresh_debounce.start()
        self._overlay_id_selectors_debounce.start()

    # ----- 步骤搜索 / 命中跳转（顶层过滤；命中含折叠并行内部内容） -----

    def _apply_step_filter(self, text: str) -> None:
        q = (text or "").strip().lower()
        self._search_matches = []
        for ol in self._step_outlines:
            if not q:
                ol.setVisible(True)
                continue
            try:
                hay = json.dumps(ol._header_dict(), ensure_ascii=False).lower()
            except Exception:  # noqa: BLE001
                hay = ""
            m = q in hay
            ol.setVisible(m)
            if m:
                self._search_matches.append(ol)
        self._search_match_idx = -1
        if not q:
            self._search_count.setText("")
        else:
            self._search_count.setText(f"{len(self._search_matches)} 命中")

    def _goto_search_match(self, delta: int) -> None:
        # 防御：只保留仍在顶层列表里的命中行（用 is 比较，绝不触碰可能已析构的 C++ 对象）。
        live = [ol for ol in self._search_matches
                if any(ol is x for x in self._step_outlines)]
        if len(live) != len(self._search_matches):
            self._search_matches = live
            self._search_match_idx = -1
        if not self._search_matches:
            self._search_count.setText("")
            return
        n = len(self._search_matches)
        self._search_match_idx = (self._search_match_idx + delta) % n
        ol = self._search_matches[self._search_match_idx]
        ol.setVisible(True)
        self._steps_scroll.ensureWidgetVisible(ol)
        ol.flash_highlight()
        self._search_count.setText(f"{self._search_match_idx + 1}/{n}")
        self.focus_outline(ol)

    def _reapply_step_filter_if_active(self) -> None:
        box = getattr(self, "_step_search", None)
        if box is not None and box.text().strip():
            self._apply_step_filter(box.text())

    def _remember_view_state(self) -> None:
        cid = self._current_cutscene_id()
        if not cid:
            return
        expanded = [i for i, ol in enumerate(self._step_outlines) if not ol._collapsed]
        # 就地更新而非整体赋值：分组折叠态也存在这个 dict 里，覆盖会把它抹掉
        st = self._view_state_by_cid.setdefault(cid, {})
        st["expanded"] = expanded
        st["scroll"] = self._steps_scroll.verticalScrollBar().value()
        st["groups_collapsed"] = [
            h.group_key() for h in self._dialogue_groups if h.is_collapsed()
        ]

    def _remembered_expanded_indices(self, cid: str | None) -> set[int]:
        st = self._view_state_by_cid.get(cid or "")
        if not st:
            return set()
        return {int(i) for i in st.get("expanded", [])}

    def _restore_scroll_state(self, cid: str | None) -> None:
        """恢复滚动位置（展开态由 _rebuild_steps 预先构建，勿在此事后展开——
        行加入布局后再展开会撞上 QScrollArea 的过期高度，把展开行压成裁切的细条）。"""
        st = self._view_state_by_cid.get(cid or "")
        if not st:
            return
        val = int(st.get("scroll", 0))
        bar = self._steps_scroll.verticalScrollBar()
        QTimer.singleShot(0, self._steps_scroll, lambda: bar.setValue(val))

    # ----- 校验：把 validate-data 对本过场的问题引进编辑器，落到具体步骤 -----

    def _clear_validation_report(self) -> None:
        """清空上一段过场留下的校验结论（换段/重建步骤列表时必须调，否则清单指向已析构的行）。"""
        lst = getattr(self, "_issue_list", None)
        if lst is not None:
            lst.clear()
            lst.setVisible(False)
        summary = getattr(self, "_validate_summary", None)
        if summary is not None:
            summary.setStyleSheet("")
            summary.setText("")
            summary.setToolTip("点「校验」检查本过场的引用/类型/白名单/字幕语音等问题")

    def _run_current_cutscene_validation(self, *, scroll_to_first: bool = True) -> None:
        # scroll_to_first 仅键参：手动点「校验」滚到首个问题行；Apply 自动校验
        # （scroll_to_first=False）不抢滚动位，只更新状态区与问题清单。
        for ol in self._iter_all_step_outlines():
            ol.set_issue_marker(None, [])
        self._issue_list.clear()
        cid = self._current_cutscene_id() or self._c_id.text().strip() or ""
        steps = [ol.to_dict() for ol in self._step_outlines]
        try:
            from ..validator import (
                Issue, _validate_cutscene_steps, _cutscene_has_show_movie_bar,
                _cutscene_temp_actor_ids_in_steps, _walk_cutscene_action_param_refs,
                cutscene_voice_sustained_before as _cutscene_voice_sustained_before,
            )
        except Exception as exc:  # noqa: BLE001
            self._issue_list.setVisible(False)
            self._validate_summary.setStyleSheet("")
            self._validate_summary.setText("校验未运行")
            self._validate_summary.setToolTip(f"无法加载校验器：{exc}")
            return
        # 整树才看得全的两件事：黑边是否出现过（避免单步视角误报「无 showMovieBar」）、
        # 本段 spawn 出的临时演员集（外层 spawn 的 _cut_* 在单行视角里不存在，会误报无法解析）。
        try:
            whole_mb = _cutscene_has_show_movie_bar(steps)
            temp_ids = frozenset(_cutscene_temp_actor_ids_in_steps(steps))
        except Exception as exc:  # noqa: BLE001 — 校验器异常绝不能影响编辑
            self._issue_list.setVisible(False)
            self._validate_summary.setStyleSheet("")
            self._validate_summary.setText("校验未运行")
            self._validate_summary.setToolTip(f"{type(exc).__name__}: {exc}")
            return
        # 逐顶层步校验 → 每条问题都落到具体行（并行嵌套问题归到其顶层 parallel 行）。
        # 参数引用扫描面限定在本行子树、判据用整树临时演员集：与 validate-data 同一口径，
        # 但每条都有归属行（旧实现把参数引用问题只算进总数、不落行 → 有计数没标记）。
        n_err = n_warn = 0
        first_row: int | None = None
        for i, step in enumerate(steps):
            row_issues: list[Any] = []
            try:
                _validate_cutscene_steps(
                    self._model, [deepcopy(step)], cid, row_issues,
                    scan_param_refs=False, cutscene_movie_bar=whole_mb,
                    step_index_base=i,
                    # 单行视角看不到上文：跨拍留声的配音（前面某拍勾了「播完不停」）
                    # 必须由整树算出来带进来，否则"接管前面那条配音"这种合法写法
                    # 每次都被误报成"没有配音可接管"（与 whole_mb / temp_ids 同一个道理）。
                    voice_sustain=[_cutscene_voice_sustained_before(steps, i)])
                _walk_cutscene_action_param_refs(
                    self._model, row_issues, [deepcopy(step)], cid, temp_ids)
            except Exception as exc:  # noqa: BLE001
                # fail-safe：校验器在某步上炸了要如实报出来，不能静默当这步没问题。
                row_issues = [Issue(
                    "error", "cutscene", cid,
                    f"step #{i + 1} 校验器异常：{type(exc).__name__}: {exc}",
                )]
            if not row_issues:
                continue
            n_err += sum(1 for it in row_issues if it.severity == "error")
            n_warn += sum(1 for it in row_issues if it.severity != "error")
            level = ("error" if any(it.severity == "error" for it in row_issues)
                     else "warning")
            self._step_outlines[i].set_issue_marker(
                level, [it.message for it in row_issues])
            for it in row_issues:
                self._append_issue_list_item(i, it)
            if first_row is None:
                first_row = i
        parts = []
        if n_err:
            parts.append(f"{n_err} 错误")
        if n_warn:
            parts.append(f"{n_warn} 警告")
        # error 标红 / warning 标橙：Apply 后自动校验靠这里在状态区提示（不阻断入库）。
        if n_err:
            self._validate_summary.setStyleSheet(
                app_theme.semantic_text_css("error") + " font-weight:bold;")
        elif n_warn:
            self._validate_summary.setStyleSheet(app_theme.semantic_text_css("warn"))
        else:
            self._validate_summary.setStyleSheet("")
        self._validate_summary.setText(
            "校验：" + ("、".join(parts) if parts else "无问题 ✓"))
        self._validate_summary.setToolTip(
            "下方清单逐条列出；点一条跳到对应步骤"
            if self._issue_list.count() else "本过场未发现问题。")
        # 问题清单是这次校验的正文：有问题就展开，没问题不占地方。
        self._issue_list.setVisible(self._issue_list.count() > 0)
        # 问题标记刚落到行上：重建缩略条，红/橙点随之出现在对应格顶。
        self._rebuild_minimap()
        if scroll_to_first and first_row is not None:
            self._jump_to_top_step(first_row)

    def _append_issue_list_item(self, row: int, issue: Any) -> None:
        """把一条问题写进清单。定位标签优先取消息里的层级步号（"4.2"），回落到本行序号。"""
        message = str(getattr(issue, "message", "") or "")
        m = _STEP_LABEL_RE.match(message)
        if m:
            label, text = m.group(1), message[m.end():]
        else:
            label, text = str(row + 1), message
        is_err = getattr(issue, "severity", "") == "error"
        item = QListWidgetItem(f"{'✖' if is_err else '⚠'} 第 {label} 步 · {text}")
        item.setToolTip(f"{'错误' if is_err else '警告'}：{text}\n（点击跳到第 {label} 步）")
        item.setForeground(QColor(
            app_theme.semantic_text_color("error" if is_err else "warn")))
        item.setData(Qt.ItemDataRole.UserRole, row)
        self._issue_list.addItem(item)

    def _on_issue_item_activated(self, item: QListWidgetItem) -> None:
        row = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(row, int):
            self._jump_to_top_step(row)

    def _on_issue_list_menu(self, pos: QPoint) -> None:
        if self._issue_list.count() == 0:
            return
        menu = QMenu(self._issue_list)
        act_copy = menu.addAction("复制全部问题")
        chosen = menu.exec(self._issue_list.viewport().mapToGlobal(pos))
        if chosen is act_copy:
            lines = [self._issue_list.item(i).text()
                     for i in range(self._issue_list.count())]
            QApplication.clipboard().setText("\n".join(lines))

    def _jump_to_top_step(self, row: int) -> None:
        """滚到并高亮某个顶层步。被过滤隐藏时先清掉过滤词，否则点了像没反应。"""
        if not (0 <= row < len(self._step_outlines)):
            return
        ol = self._step_outlines[row]
        if not ol.isVisible():
            box = getattr(self, "_step_search", None)
            if box is not None and box.text().strip():
                box.clear()
        self._steps_scroll.ensureWidgetVisible(ol)
        ol.flash_highlight()
        self.focus_outline(ol)

    def _autoscroll_steps_for_drag(self) -> None:
        """拖拽重排时，光标接近步骤滚动区上下边缘则自动滚动，便于远距离搬运。"""
        sc = getattr(self, "_steps_scroll", None)
        if sc is None:
            return
        vp = sc.viewport()
        y = vp.mapFromGlobal(QCursor.pos()).y()
        bar = sc.verticalScrollBar()
        margin = 30
        if y < margin:
            bar.setValue(bar.value() - 26)
        elif y > vp.height() - margin:
            bar.setValue(bar.value() + 26)

    def _refresh_outline_indices_and_zebra(self) -> None:
        for i, ol in enumerate(self._step_outlines):
            ol.set_row_index(str(i + 1))
            ol.set_zebra_alt(i % 2 == 1)
            ol.refresh_header()
        self._refresh_parallel_track_zebra()
        self._refresh_edit_buttons()
        # 结构变更（增删/重排/复制粘贴/合并）都经此处：重跑过滤，使命中集只含存活行、
        # 新步骤按当前关键词决定可见性，避免命中集里残留已 deleteLater 的悬空引用。
        self._reapply_step_filter_if_active()
        self._rebuild_dialogue_groups()
        self._rebuild_minimap()
        # 重排/增删后焦点条对象没变（高亮跟着走），但缩略条的当前格是下标、会过期
        foc = getattr(self, "_focused_outline", None)
        if foc is not None and any(foc is x for x in self._iter_all_step_outlines()):
            self._sync_minimap_current(foc)

    # ----- 缩略时间轴 -----

    def _rebuild_minimap(self) -> None:
        """重算格子。与大纲序号/斑马同一时机（已去抖），逐键编辑不会每字符重算。"""
        mm = getattr(self, "_minimap", None)
        if mm is None:
            return
        cells: list[_MinimapCell] = []
        names = self.speaker_names()
        for ol in self._step_outlines:
            try:
                d = ol._header_dict()
            except Exception:  # noqa: BLE001 — 缩略条是辅助视图，绝不能因坏数据打断编辑
                d = {"kind": "present"}
            kind = str(d.get("kind", "present"))
            if kind == "parallel" and ol._step is not None:
                summary = parallel_tracks_summary(
                    [c.to_dict() for c in ol._step._child_outlines], names)
            else:
                summary = step_summary_line(d, names)
            dis = ol.is_step_disabled()
            cells.append(_MinimapCell(
                kind=kind,
                ms=estimate_step_duration_ms(d),   # 禁用步在此已归 0
                summary=("〔已禁用〕" + summary) if dis else summary,
                issue=ol.issue_level(),
                disabled=dis,
            ))
        mm.set_cells(cells)
        self._sync_minimap_viewport()

    def _sync_minimap_viewport(self) -> None:
        """把滚动区当前可见的步区间标到缩略条上——「我翻到哪了」的答案。"""
        mm = getattr(self, "_minimap", None)
        sc = getattr(self, "_steps_scroll", None)
        if mm is None or sc is None or not self._step_outlines:
            return
        vp = sc.viewport()
        top, bottom = 0, vp.height()
        first, last = -1, -2
        for i, ol in enumerate(self._step_outlines):
            if not ol.isVisible():
                continue
            y = ol.mapTo(vp, QPoint(0, 0)).y()
            if y + ol.height() < top or y > bottom:
                continue
            if first < 0:
                first = i
            last = i
        mm.set_viewport(first, last)

    # ----- 对白分组（纯视图聚合） -----

    #: 少于这个句数不成组——两句以下收起来反而更难找
    _GROUP_MIN = 2

    def _dialogue_group_spans(self) -> list[tuple[int, int]]:
        """顶层里所有连续对白/字幕区间 [lo, hi]（长度 ≥ _GROUP_MIN）。"""
        spans: list[tuple[int, int]] = []
        lo: int | None = None
        for i, ol in enumerate(self._step_outlines):
            if self._is_dialogue_step(ol):
                if lo is None:
                    lo = i
            else:
                if lo is not None and i - lo >= self._GROUP_MIN:
                    spans.append((lo, i - 1))
                lo = None
        n = len(self._step_outlines)
        if lo is not None and n - lo >= self._GROUP_MIN:
            spans.append((lo, n - 1))
        return spans

    @staticmethod
    def _group_key_for(members: list["StepOutlineFrame"]) -> str:
        """分组的记忆键：用首句正文而非下标——增删步后下标全变，按正文才认得回来。"""
        if not members:
            return ""
        try:
            d = members[0]._header_dict()
            return f"{d.get('type', '')}|{str(d.get('text') or '')[:40]}"
        except Exception:  # noqa: BLE001
            return ""

    def _rebuild_dialogue_groups(self) -> None:
        """重建组头行。与序号/斑马同一时机（已去抖）。

        `_step_outlines` 结构**不动**——组头只是额外插进布局的装饰行，
        序号、拖拽、to_dict、Apply 全都照旧看平铺列表。
        """
        if getattr(self, "_loading_ui", False):
            return
        prev_state = {h.group_key(): h.is_collapsed()
                      for h in getattr(self, "_dialogue_groups", [])}
        for h in getattr(self, "_dialogue_groups", []):
            self._steps_layout.removeWidget(h)
            h.setParent(None)
            h.deleteLater()
        self._dialogue_groups = []

        # 过滤激活时不分组：过滤本身就是另一种视图，组头会和命中集打架
        box = getattr(self, "_step_search", None)
        if box is not None and box.text().strip():
            return

        remembered = self._remembered_group_collapsed(self._current_cutscene_id())
        for lo, hi in self._dialogue_group_spans():
            members = self._step_outlines[lo:hi + 1]
            header = DialogueGroupHeader(self, self._steps_container)
            key = self._group_key_for(members)
            header.set_members(members, key)
            at = self._steps_layout.indexOf(members[0])
            if at < 0:
                at = 0
            self._steps_layout.insertWidget(at, header)
            self._dialogue_groups.append(header)
            # 记忆优先级：本次会话内的现状 > 该过场记住的状态 > 展开
            if key in prev_state:
                header.set_collapsed(prev_state[key])
            elif key in remembered:
                header.set_collapsed(True)

    def _remembered_group_collapsed(self, cid: str | None) -> set[str]:
        st = self._view_state_by_cid.get(cid or "")
        if not st:
            return set()
        return {str(k) for k in st.get("groups_collapsed", [])}

    def remember_dialogue_group_state(self) -> None:
        """把当前折叠的分组记进本过场的视图状态（切走再回来还是这样）。"""
        cid = self._current_cutscene_id()
        if not cid:
            return
        st = self._view_state_by_cid.setdefault(cid, {})
        st["groups_collapsed"] = [
            h.group_key() for h in getattr(self, "_dialogue_groups", []) if h.is_collapsed()
        ]

    def _refresh_dialogue_group_texts(self) -> None:
        for h in getattr(self, "_dialogue_groups", []):
            try:
                h.refresh_text()
            except RuntimeError:
                pass

    def append_line_to_group(self, after_ol: "StepOutlineFrame") -> None:
        """往某段对白末尾接写一句（继承该句的说话人/立绘设置）。"""
        try:
            d = after_ol.to_dict()
        except Exception:  # noqa: BLE001
            d = {"kind": "present", "type": "showDialogue"}
        step = deepcopy(d)
        step["text"] = ""
        if str(step.get("type")) == "showDialogue":
            step.setdefault("speaker", "")
        self.insert_steps_after(after_ol, [step], expand_first=True)

    # ----- 当前焦点条（「我在改哪条」——长列表里唯一一眼可认的锚） -----

    def focus_outline(self, ol: "StepOutlineFrame | None") -> None:
        """把强高亮移到 ol；同时只有一条焦点。ol=None 则清除。

        所有「跳到某步」的入口都要过这里：点表头、展开、缩略条点击、搜索命中、
        全局搜索落点、条目播放键。否则用户跳过去了却认不出落在哪行。
        """
        prev = getattr(self, "_focused_outline", None)
        if prev is ol:
            if ol is not None:
                self._sync_minimap_current(ol)
            return
        if prev is not None and any(prev is x for x in self._iter_all_step_outlines()):
            try:
                prev.set_focused(False)
            except RuntimeError:
                pass          # 已析构：忽略（结构操作后旧引用可能失效）
        self._focused_outline = ol
        if ol is not None:
            ol.set_focused(True)
            self._sync_minimap_current(ol)

    def _sync_minimap_current(self, ol: "StepOutlineFrame") -> None:
        """焦点条对应的顶层步同步到缩略条（并行子轨归其所属顶层步）。"""
        mm = getattr(self, "_minimap", None)
        if mm is None:
            return
        top = ol
        while top._parallel_parent is not None:
            owner = top._parallel_parent._outline_frame
            if owner is None or owner is top:
                break
            top = owner
        for i, x in enumerate(self._step_outlines):
            if x is top:
                mm.set_current(i)
                return

    def set_playback_position(self, cutscene_id: str, path: str | None) -> None:
        """主窗轮询游戏后推进来：把播放头点到缩略条上。

        `path` 是运行时的步路径（"7" / "32.p1"）——取首段即顶层下标；
        过场 id 与当前正在编辑的不一致时不点（别在 A 段上画 B 段的播放头）。
        """
        mm = getattr(self, "_minimap", None)
        if mm is None:
            return
        cur = (self._current_cutscene_id() or "").strip()
        if not path or not cur or (cutscene_id or "").strip() != cur:
            mm.set_playhead(-1)
            return
        head = str(path).split(".", 1)[0]
        try:
            idx = int(head)
        except ValueError:
            mm.set_playhead(-1)
            return
        mm.set_playhead(idx if 0 <= idx < len(self._step_outlines) else -1)

    def _on_minimap_cell_clicked(self, idx: int) -> None:
        if not (0 <= idx < len(self._step_outlines)):
            return
        ol = self._step_outlines[idx]
        if ol.is_collapsed():
            ol.set_collapsed(False)
        self._steps_scroll.ensureWidgetVisible(ol)
        ol.flash_highlight()
        self.focus_outline(ol)

    def _refresh_parallel_track_zebra(self) -> None:
        for i, top in enumerate(self._step_outlines):
            if top._step is None:
                continue
            self._zebra_descendant_tracks(top._step, prefix=str(i + 1))

    def _zebra_descendant_tracks(self, sw: StepWidget, *, prefix: str = "") -> None:
        # 并行子轨也编分层号（3.1 / 3.2.1…），让深层步骤有可寻址的位置标识。
        if sw._kind_combo.currentData() != "parallel":
            return
        for i, ol in enumerate(sw._child_outlines):
            label = f"{prefix}.{i + 1}" if prefix else str(i + 1)
            ol.set_row_index(label)
            ol.set_zebra_alt(i % 2 == 1)
            ol.refresh_header()
            if ol._step is None:
                continue
            self._zebra_descendant_tracks(ol._step, prefix=label)

    def _on_model_data_changed(self, data_type: str, item_id: str) -> None:
        # 名字表在下面任何一个提前 return 之前作废：NPC 改名走 scene/characterRegistry、
        # 主角缺省名与旁白标签走 strings，几个桶都要让大纲上的说话人跟着变。
        self._speaker_names_cache = None
        if data_type != "scene":
            return
        if self._loading_ui:
            return
        if self._current_idx < 0:
            return
        tid = self._target_scene.current_id().strip()
        changed_sid = (item_id or "").strip()
        # 仅当变更的是本过场 targetScene（或未携带具体场景 id）时，才刷新各 Action 绑定的 NPC 等上下文；
        # 否则保存其它场景时也会 walk 整棵步骤树，过场复杂时极慢。
        propagate = (not changed_sid) or (changed_sid == tid)
        self._pending_scene_refresh_need_propagate |= propagate
        # Save All 等会在同一调用栈里连续 mark_dirty 多次；合并为一次刷新，避免 O(步骤数)×N。
        self._scene_data_changed_debounce.start(0)

    def speaker_names(self) -> Mapping[str, str]:
        """摘要里把说话人 id 换成玩家看到的名字用的表（空串键 = 旁白标签）。

        一次列表重排要问上百次（每行大纲 + 缩略条整份过场），故缓存一份；
        任何模型数据变更即作废（`_on_model_data_changed`），改完名不用重开过场。
        """
        if self._speaker_names_cache is None:
            self._speaker_names_cache = speaker_display_names(self._model)
        return self._speaker_names_cache

    def _run_debounced_scene_model_refresh(self) -> None:
        if self._loading_ui or self._current_idx < 0:
            self._pending_scene_refresh_need_propagate = False
            self._scene_model_refresh_pending_while_hidden = False
            return
        if not self.isVisible():
            # 避免在其它 Tab（如场景）Apply 时对本页整棵步骤树做 NPC/Action 上下文传播。
            self._scene_model_refresh_pending_while_hidden = True
            return
        self._scene_model_refresh_pending_while_hidden = False
        tid = self._target_scene.current_id().strip()
        need = self._pending_scene_refresh_need_propagate
        self._pending_scene_refresh_need_propagate = False
        self._refresh_target_scene_combo_items(tid, propagate_context=need)

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        if self._scene_model_refresh_pending_while_hidden:
            self._scene_model_refresh_pending_while_hidden = False
            QTimer.singleShot(0, self, self._run_debounced_scene_model_refresh)

    def mark_pending_changes(self, *args) -> None:
        if self._loading_ui:
            return
        self._pending_changes = True

    def _scene_dropdown_rows(self, orphan_if_missing: str) -> list[tuple[str, str]]:
        """(id, 展示名)：含场景 name；孤儿 targetScene 保留一项以免无法表示未入库引用。"""
        rows: list[tuple[str, str]] = []
        seen: set[str] = set()
        for sid in sorted(self._model.all_scene_ids()):
            seen.add(sid)
            sc = self._model.scenes.get(sid) or {}
            label = sc.get("name") or sid
            rows.append((sid, str(label)))
        o = (orphan_if_missing or "").strip()
        if o and o not in seen:
            rows.append((o, f"{o} · 未在项目场景表中"))
        return rows

    def _refresh_target_scene_combo_items(
        self, committed: str, *, propagate_context: bool = True,
    ) -> None:
        committed = (committed or "").strip()
        with QSignalBlocker(self._target_scene):
            self._target_scene.set_items(self._scene_dropdown_rows(committed))
            self._target_scene.set_current(committed)
        if propagate_context:
            self._propagate_cutscene_scene_to_action_rows()

    def has_pending_changes(self) -> bool:
        return self._pending_changes

    def confirm_apply_or_discard(self, parent: QWidget) -> str:
        if not self._pending_changes or self._current_idx < 0:
            return "proceed"
        r = QMessageBox.question(
            parent,
            "过场",
            "当前过场有未 Apply 的修改，如何处理？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return "cancel"
        if r == QMessageBox.StandardButton.Save:
            if not self._apply():
                return "cancel"
        else:
            self._pending_changes = False
        return "proceed"

    @staticmethod
    def _cutscene_list_label(cs: dict) -> str:
        """左侧列表项展示：id · N步 · →targetScene（仅展示，select 仍走 id/索引）。"""
        cid = str(cs.get("id", "") or "?")
        steps = cs.get("steps")
        n = len(steps) if isinstance(steps, list) else 0
        ts = str(cs.get("targetScene") or "").strip()
        suffix = f"  ·  {n}步" + (f"  →{ts}" if ts else "")
        return f"{cid}{suffix}"

    def _refresh(self) -> None:
        self._list.clear()
        for c in self._model.cutscenes:
            self._list.addItem(self._cutscene_list_label(c))
        # 重建列表后重新套用搜索过滤，避免刷新即丢失过滤态
        box = getattr(self, "_list_search", None)
        if box is not None:
            box.textChanged.emit(box.text())

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        cid = (item_id or "").strip()
        if not cid:
            return
        search = getattr(self, "_list_search", None)
        if search is not None and search.text():
            search.clear()  # 目标行可能被过场列表过滤隐藏
        for i, cutscene in enumerate(self._model.cutscenes):
            if str(cutscene.get("id", "")).strip() == cid:
                self._list.setCurrentRow(i)
                return

    def focus_step(self, cutscene_id: str, step_index: int) -> bool:
        """全局搜索落点：选中过场并展开第 step_index 个顶层步骤（懒详情就地
        构造），滚到眼前。返回是否真正落位。"""
        cid = (cutscene_id or "").strip()
        self.select_by_id(cid)
        # 核验真的切到了目标过场——id 不存在(过期搜索结果)或切换被未提交
        # 修改的确认弹窗取消时,选中仍是旧过场;不核验会展开错过场的步骤
        # 还谎报成功(对抗审查确认项)。
        row = self._list.currentRow()
        cuts = self._model.cutscenes
        if not (0 <= row < len(cuts)) or str(cuts[row].get("id", "")).strip() != cid:
            return False
        step_search = getattr(self, "_step_search", None)
        if step_search is not None and step_search.text():
            step_search.clear()  # 步骤过滤会把目标步骤行藏起来
        outlines = getattr(self, "_step_outlines", None) or []
        if not (0 <= step_index < len(outlines)):
            return False
        ol = outlines[step_index]
        try:
            ol.set_collapsed(False)  # 内含 _ensure_detail_built
        except Exception:
            return False
        p = ol.parentWidget()
        while p is not None:
            if isinstance(p, QScrollArea):
                p.ensureWidgetVisible(ol, 48, 48)
                break
            p = p.parentWidget()
        self.focus_outline(ol)
        return True

    def _on_target_scene_changed(self, sid: str) -> None:
        if self._spawn_loading:
            return
        if not sid:
            self._spawn_key = ""
            self._refresh_spawn_display()
            self._propagate_cutscene_scene_to_action_rows()
            return
        sc = self._model.scenes.get(sid)
        if sc and self._spawn_key:
            if self._spawn_key not in (sc.get("spawnPoints") or {}):
                self._spawn_key = ""
        self._refresh_spawn_display()
        self._propagate_cutscene_scene_to_action_rows()

    def _refresh_spawn_display(self) -> None:
        # 显示的是「运行时会发生什么」，不是字段裸值：空值过去写成「默认 (spawnPoint)」，
        # 读起来像"会落到场景默认出生点"，而同场景其实是一动不动。
        sid = self._target_scene.current_id()
        self._spawn_pick_btn.setEnabled(bool(sid))
        self._spawn_clear_btn.setEnabled(bool(self._spawn_key))
        # 字段窄，长句会被裁；细则（跨场景例外、targetX/Y 覆盖）留在悬停说明里。
        self._spawn_display.setText(self._spawn_key or "不指定：就地开演")

    def _clear_spawn_key(self) -> None:
        if not self._spawn_key:
            return
        self._spawn_key = ""
        self._refresh_spawn_display()
        self.mark_pending_changes()

    def _open_spawn_picker(self) -> None:
        sid = self._target_scene.current_id()
        if not sid:
            QMessageBox.information(
                self, "过场",
                "没填 targetScene 时本来就不挪玩家（就地开演），无需选出生点。\n"
                "要挪人请先选目标场景。",
            )
            return
        dlg = TargetSpawnPickerDialog(
            self._model, sid, self._spawn_key, self,
            empty_label="不指定（就地开演，不挪玩家）",
            empty_hint=(
                "第一项「不指定」= 同场景不挪玩家、就在当前镜头位置开演"
                "（跨场景时落该场景的默认 spawnPoint）；其余对应 spawnPoints 中的键。"
            ),
        )
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._spawn_key = dlg.selected_spawn_key()
            self._refresh_spawn_display()
            self.mark_pending_changes()

    def _on_select(self, row: int) -> None:
        old = self._current_idx
        if old >= 0 and row >= 0 and old != row and self._pending_changes:
            r = QMessageBox.question(
                self, "过场",
                "当前过场有未 Apply 的修改，切换前如何处理？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Save,
            )
            if r == QMessageBox.StandardButton.Cancel:
                self._list.blockSignals(True)
                self._list.setCurrentRow(old)
                self._list.blockSignals(False)
                return
            if r == QMessageBox.StandardButton.Save:
                if not self._apply():
                    self._list.blockSignals(True)
                    self._list.setCurrentRow(old)
                    self._list.blockSignals(False)
                    return
            else:
                self._pending_changes = False

        if row < 0 or row >= len(self._model.cutscenes):
            return
        # 记住离开这段过场时的展开态 / 滚动位置（切回可恢复），仅在确实换段时。
        if old != row:
            self._remember_view_state()
        self._loading_ui = True
        try:
            self._current_idx = row
            self._undo_stack.clear()
            self._redo_stack.clear()
            cs = self._model.cutscenes[row]
            self._c_id.setText(cs.get("id", ""))
            self._spawn_loading = True
            try:
                self._spawn_key = (cs.get("targetSpawnPoint") or "").strip()
                committed = str(cs.get("targetScene") or "").strip()
                self._refresh_target_scene_combo_items(committed)
            finally:
                self._spawn_loading = False
            self._refresh_spawn_display()
            has_pos = "targetX" in cs and "targetY" in cs
            self._pos_chk.setChecked(has_pos)
            self._target_x.setValue(float(cs.get("targetX", 0)))
            self._target_y.setValue(float(cs.get("targetY", 0)))
            self._restore_chk.setChecked(cs.get("restoreState", True))
            new_cid = str(cs.get("id", "")).strip() or None
            self._rebuild_steps(
                cs.get("steps", []),
                expanded_indices=self._remembered_expanded_indices(new_cid),
            )
            self._restore_scroll_state(new_cid)
            self._pending_changes = False
        finally:
            self._loading_ui = False

    def _rebuild_steps(
        self, steps: list[dict], *, expanded_indices: set[int] | None = None,
    ) -> None:
        # 上一段/上一版的校验结论对新列表已失效（清单条目指的是刚被 deleteLater 的行）。
        self._clear_validation_report()
        self._overlay_selectors_fp_valid = False
        # 焦点引用必须先断：下面整批 deleteLater，留着会变悬空指针
        self._focused_outline = None
        for ol in self._step_outlines:
            self._steps_layout.removeWidget(ol)
            ol.deleteLater()
        self._step_outlines.clear()
        cid = self._current_cutscene_id()
        for i, step in enumerate(steps):
            ol = StepOutlineFrame(
                step, self._model, self, self._steps_container,
                indent_px=0,
                parallel_parent=None,
                zebra_alt=(i % 2 == 1),
                cutscene_id=cid,
            )
            # 恢复记忆的展开态必须在 addWidget 之前完成：行带着已展开的详情进入布局，
            # 首次布局即含正确高度。若加入布局后再展开，QScrollArea 会按过期的容器
            # 高度分配空间，把展开行压成表头裁切+详情细缝（真实窗口可复现）。
            if expanded_indices and i in expanded_indices:
                try:
                    ol.set_collapsed(False, refresh=False)
                except Exception:  # noqa: BLE001 — 单行详情构建失败不拖垮整段载入
                    pass
            ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.append(ol)
            self._steps_layout.addWidget(ol)
        self._refresh_outline_indices_and_zebra()
        self._reapply_step_filter_if_active()
        # 载入期 _loading_ui 为 True，上面那轮分组重建被门掉了；载入落定后补建一次。
        # 视口区间同理——要等布局稳定才量得准。
        QTimer.singleShot(0, self, self._post_rebuild_view_sync)

    def _post_rebuild_view_sync(self) -> None:
        self._rebuild_dialogue_groups()
        self._sync_minimap_viewport()

    def _current_cutscene_id(self) -> str | None:
        if 0 <= self._current_idx < len(self._model.cutscenes):
            cid = str(self._model.cutscenes[self._current_idx].get("id", "")).strip()
            return cid or None
        return None

    def cutscene_binding_target_scene(self) -> str:
        """当前过场绑定的场景 ID。

        载入 UI 中与磁盘对齐；绑定表单可操作且未载入时一律以控件为准（含未 Apply 修改），
        以便 action 的 NPC 列表与表单一致。
        """
        if (
            self._current_idx < 0
            or self._current_idx >= len(self._model.cutscenes)
        ):
            return ""
        if getattr(self, "_loading_ui", False):
            return str(
                self._model.cutscenes[self._current_idx].get("targetScene") or "",
            ).strip()
        ts = getattr(self, "_target_scene", None)
        if ts is not None:
            return ts.current_id().strip()
        return str(
            self._model.cutscenes[self._current_idx].get("targetScene") or "",
        ).strip()

    def _outline_overlay_show_and_hide_sets(self) -> tuple[set[str], set[str]]:
        """基于当前编辑器内步骤快照（含未 Apply），收集 showImg / hideImg 的 overlay id。"""
        show_ids: set[str] = set()
        hide_ids: set[str] = set()
        for ol in self._step_outlines:
            self._walk_collect_overlay_ids(ol.to_dict(), show_ids, hide_ids)
        return show_ids, hide_ids

    @staticmethod
    def _walk_collect_overlay_ids(step: dict, show_ids: set[str], hide_ids: set[str]) -> None:
        if not isinstance(step, dict):
            return
        k = str(step.get("kind", ""))
        if k == "present":
            t = str(step.get("type", ""))
            oid = str(step.get("id") or "").strip()
            if oid:
                if t == "showImg":
                    show_ids.add(oid)
                elif t == "hideImg":
                    hide_ids.add(oid)
            return
        if k == "parallel":
            for tr in step.get("tracks") or []:
                TimelineEditor._walk_collect_overlay_ids(tr, show_ids, hide_ids)

    def _merged_overlay_rows(
        self, pool_sorted: list[str], committed: str, orphan_hint: str,
    ) -> list[tuple[str, str]]:
        seen: set[str] = set()
        rows: list[tuple[str, str]] = []
        for i in pool_sorted:
            if i and i not in seen:
                seen.add(i)
                rows.append((i, i))
        c = committed.strip()
        if c and c not in seen:
            rows.append((c, orphan_hint))
        return rows

    def _propagate_cutscene_scene_to_action_rows(self) -> None:
        """绑定 targetScene 变更后刷新各 action 的 NPC/target 下拉候选项。"""
        if getattr(self, "_loading_ui", False):
            return
        sid_raw = self.cutscene_binding_target_scene()
        sid_n = sid_raw if sid_raw else None
        cid = self._current_cutscene_id()
        for ol in self._iter_all_step_outlines():
            sw = getattr(ol, "_step", None)
            if sw is None:
                continue
            ar = getattr(sw, "_action_row", None)
            if isinstance(ar, ActionRow):
                ar.set_project_context(self._model, sid_n, cutscene_id=cid)
            sw.refresh_subtitle_emote_target_items()
            sw.refresh_show_dialogue_scene_scope()

    def _refresh_all_present_overlay_id_selectors(self) -> None:
        """步骤树变化后刷新 showImg / hideImg 的 id 下拉候选项。"""
        if getattr(self, "_loading_ui", False):
            return
        show_set, hide_set = self._outline_overlay_show_and_hide_sets()
        fp = "|".join(
            (
                "+:" + ":".join(sorted(show_set, key=lambda x: (x.lower(), x))),
                "-:" + ":".join(sorted(hide_set, key=lambda x: (x.lower(), x))),
            ),
        )
        if self._overlay_selectors_fp_valid and fp == self._overlay_selectors_fp_cache:
            return
        show_sorted = sorted(show_set, key=lambda x: (x.lower(), x))
        union_sorted = sorted(
            show_set | hide_set, key=lambda x: (x.lower(), x),
        )
        for ol in self._iter_all_step_outlines():
            sw = ol._step
            if sw is None:
                continue
            if sw._kind_combo.currentData() != "present":
                continue
            ptype = sw._type_combo.committed_type()
            if ptype not in ("showImg", "hideImg"):
                continue
            sel = sw._widgets.get("id")
            if not isinstance(sel, IdRefSelector):
                continue
            cur = sel.current_id().strip()
            if ptype == "showImg":
                hint = (
                    (f"{cur} · 仅本条数据引用")
                    if cur else "(空 id)"
                )
                rows = self._merged_overlay_rows(union_sorted, cur, hint)
            else:
                hint = (
                    (f"{cur} · hide 先于 showImg 或缺同名 showImg")
                    if cur else "(空 id)"
                )
                rows = self._merged_overlay_rows(show_sorted, cur, hint)
            sel.blockSignals(True)
            try:
                sel.set_items(rows)
                sel.set_current(cur)
            finally:
                sel.blockSignals(False)
        self._overlay_selectors_fp_cache = fp
        self._overlay_selectors_fp_valid = True

    def _add_step(self, kind: str) -> None:
        self._append_steps([_new_step_data(kind)])

    def insert_steps_after(
        self, after_ol: "StepOutlineFrame | None", datas: list[dict],
        *, expand_first: bool = False,
    ) -> None:
        """在某个顶层步之后插入若干步；after_ol=None 则追加到末尾。"""
        if not datas:
            return
        if after_ol is None or after_ol._parallel_parent is not None:
            self._append_steps(datas, expand_first=expand_first)
            return
        try:
            at = self._step_outlines.index(after_ol) + 1
        except ValueError:
            self._append_steps(datas, expand_first=expand_first)
            return
        self.push_undo_snapshot()
        cid = self._current_cutscene_id()
        first: StepOutlineFrame | None = None
        for offset, data in enumerate(datas):
            ol = StepOutlineFrame(
                data, self._model, self, self._steps_container,
                indent_px=0, parallel_parent=None, zebra_alt=False, cutscene_id=cid,
            )
            ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.insert(at + offset, ol)
            if first is None:
                first = ol
        self._relayout_outline_list(self._step_outlines, self._steps_layout)
        if expand_first and first is not None:
            try:
                first.set_collapsed(False)
            except Exception:  # noqa: BLE001
                pass
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()
        if first is not None:
            self.focus_outline(first)
            QTimer.singleShot(0, first, lambda: self._steps_scroll.ensureWidgetVisible(first))

    def _append_steps(self, datas: list[dict], *, expand_first: bool = False) -> None:
        """把一组步骤追加到顶层末尾（+Present/+Action/+Parallel 与常用预设共用）。"""
        if not datas:
            return
        self.push_undo_snapshot()
        first: StepOutlineFrame | None = None
        for data in datas:
            ol = StepOutlineFrame(
                data, self._model, self, self._steps_container,
                indent_px=0,
                parallel_parent=None,
                zebra_alt=(len(self._step_outlines) % 2 == 1),
                cutscene_id=self._current_cutscene_id(),
            )
            ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.append(ol)
            self._steps_layout.addWidget(ol)
            if first is None:
                first = ol
        if expand_first and first is not None:
            # 预设建出来就是要马上填内容的：省掉「再点一下展开」
            try:
                first.set_collapsed(False)
            except Exception:  # noqa: BLE001 — 展开失败不该拖累插入本身
                pass
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()
        if first is not None:
            self.focus_outline(first)
        # 追加后滚到新步，避免它落在视口外看不见（布局稳定后再滚）
        last = self._step_outlines[-1]
        QTimer.singleShot(0, last, lambda: self._steps_scroll.ensureWidgetVisible(last))

    # ----- 常用步骤预设 -----

    def _last_dialogue_context(self) -> dict:
        """末尾往前找最近的一句对白，取其说话人/立绘设置作为新对白的底模。

        连着写一段某人的台词时，这几个字段每句都一样——每次重填是纯粹的浪费。
        """
        for ol in reversed(self._step_outlines):
            try:
                d = ol._header_dict()
            except Exception:  # noqa: BLE001
                continue
            if str(d.get("kind")) == "present" and str(d.get("type")) == "showDialogue":
                out: dict = {}
                for k in ("scriptedNpcId", "portrait", "speaker"):
                    if k in d:
                        out[k] = deepcopy(d[k])
                return out
        return {}

    def _insert_preset(self, key: str) -> None:
        if key == "dialogue":
            step = {"kind": "present", "type": "showDialogue", "speaker": "", "text": ""}
            step.update(self._last_dialogue_context())
            step["text"] = ""          # 继承说话人/立绘，但正文必须空着
            self._append_steps([step], expand_first=True)
        elif key == "subtitle":
            self._append_steps(
                [{"kind": "present", "type": "showSubtitle", "text": "", "position": "bottom"}],
                expand_first=True)
        elif key == "blackout":
            # 成对出现：本工程 9 次 fadeToBlack / 11 次 fadeIn，几乎总是夹着换景
            self._append_steps([
                {"kind": "present", "type": "fadeToBlack", "duration": 1000},
                {"kind": "present", "type": "fadeIn", "duration": 1000},
            ])
        elif key == "movieband":
            self._append_steps([
                {"kind": "present", "type": "showMovieBar", "heightPercent": 0.12},
            ])
        elif key == "shot":
            self._append_steps([
                {"kind": "present", "type": "cameraMove", "x": 0, "y": 0, "duration": 1000},
                {"kind": "present", "type": "waitTime", "duration": 800},
            ], expand_first=True)
        elif key == "sfx":
            self._append_steps(
                [{"kind": "action", "type": "playSfx", "params": {"id": ""}}],
                expand_first=True)
        elif key == "illust":
            self._append_steps([
                {"kind": "present", "type": "showImg", "id": "", "image": ""},
            ], expand_first=True)

    def _build_preset_menu(self, btn: QToolButton) -> None:
        menu = QMenu(btn)
        for key, label, tip in (
            ("dialogue", "一句对白", "showDialogue；自动继承上一句的说话人实体与立绘设置"),
            ("subtitle", "一句字幕", "showSubtitle（底部）"),
            ("sfx", "一个音效", "action:playSfx"),
            ("illust", "一张插画", "showImg（选图后填句柄 id）"),
            ("blackout", "黑场转场", "fadeToBlack 1000ms + fadeIn 1000ms 两步"),
            ("movieband", "上电影黑边", "showMovieBar 12%"),
            ("shot", "推镜头 + 停顿", "cameraMove 1000ms + waitTime 800ms 两步"),
        ):
            act = QAction(label, menu)
            act.setToolTip(tip)
            act.triggered.connect(lambda _c=False, k=key: self._insert_preset(k))
            menu.addAction(act)
        btn.setMenu(menu)

    def _apply(self) -> bool:
        from ..editor_perf import PerfClock, maybe_stamp, perf_log_enabled

        _ap_clk = PerfClock(label="TimelineEditor._apply") if perf_log_enabled() else None

        if self._current_idx < 0:
            return False

        # —— 过场 id 守卫（审查 P2）：空 id 拒绝；与其它过场撞 id 需确认 ——
        # 运行时按 id 找过场是 first-wins：重复 id 会把另一条静默遮蔽。
        new_id = self._c_id.text().strip()
        if not new_id:
            QMessageBox.warning(self, "过场", "过场 id 不能为空，请填写后再 Apply。")
            return False
        if any(
            i != self._current_idx and str(c.get("id", "")).strip() == new_id
            for i, c in enumerate(self._model.cutscenes)
        ):
            r = QMessageBox.question(
                self, "过场",
                f"已有另一段过场使用 id「{new_id}」。\n"
                "重复 id 运行时只取第一条，另一条会被静默遮蔽。仍要保存吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return False

        steps = [ol.to_dict() for ol in self._step_outlines]

        cs = self._model.cutscenes[self._current_idx]
        cs["id"] = new_id

        scene = self._target_scene.current_id()
        if scene:
            cs["targetScene"] = scene
        else:
            cs.pop("targetScene", None)

        spawn = self._spawn_key.strip()
        if spawn:
            cs["targetSpawnPoint"] = spawn
        else:
            cs.pop("targetSpawnPoint", None)

        if self._pos_chk.isChecked():
            # 数值保真：未改动的值按原始 JSON 表示回写（int 保 int、100.0 保 100.0）；
            # 新值 / 被改动的值整数化落 int，避免 QDoubleSpinBox 把 100 漂成 100.0。
            for key, w in (("targetX", self._target_x), ("targetY", self._target_y)):
                v = float(w.value())
                ov = cs.get(key)
                if (
                    isinstance(ov, (int, float))
                    and not isinstance(ov, bool)
                    and float(ov) == v
                ):
                    cs[key] = ov
                else:
                    cs[key] = int(v) if v.is_integer() else v
        else:
            cs.pop("targetX", None)
            cs.pop("targetY", None)

        if not self._restore_chk.isChecked():
            cs["restoreState"] = False
        else:
            cs.pop("restoreState", None)

        cs["steps"] = steps
        cs.pop("commands", None)
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        if 0 <= self._current_idx < self._list.count():
            self._list.blockSignals(True)
            try:
                it = self._list.item(self._current_idx)
                if it is not None:
                    it.setText(self._cutscene_list_label(cs))
            finally:
                self._list.blockSignals(False)
        maybe_stamp(_ap_clk, f"done steps={len(steps)} idx={self._current_idx}")
        # Apply 成功后自动跑本过场校验（纯内存低成本，审查 P2）：有 error 在状态区
        # 标红提示但不阻断——带病组合能入库但必须被看见；不抢滚动位。
        try:
            self._run_current_cutscene_validation(scroll_to_first=False)
        except Exception:  # noqa: BLE001 — 校验绝不能让 Apply 失败
            pass
        return True

    # ----- 过场资产级拆分 / 组合（非破坏式：来源资产始终保留） -----

    def _prepare_asset_operation(self) -> bool:
        """先处理当前表单暂存，避免拆分/组合读到 UI 与模型的混合状态。"""
        if not self._pending_changes or self._current_idx < 0:
            return True
        r = QMessageBox.question(
            self,
            "过场资产操作",
            "当前过场有未 Apply 的修改。继续前要如何处理？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            return self._apply()
        # Discard 不能只清脏标记：必须把表单与步骤树恢复到模型快照，之后的
        # 拆分位置和来源内容才来自同一份数据。
        self._pending_changes = False
        self._on_select(self._current_idx)
        return True

    def _bound_entity_refs(
        self, cutscene_id: str,
    ) -> list[tuple[str, str, int, dict]]:
        """返回通过 cutsceneIds 绑定 cid 的场景实体；不修正任何脏数据。"""
        cid = (cutscene_id or "").strip()
        if not cid:
            return []
        out: list[tuple[str, str, int, dict]] = []
        for scene_id, scene in self._model.scenes.items():
            if not isinstance(scene, dict):
                continue
            for collection in ("npcs", "hotspots"):
                entities = scene.get(collection)
                if not isinstance(entities, list):
                    continue
                for index, entity in enumerate(entities):
                    if not isinstance(entity, dict):
                        continue
                    ids = entity.get("cutsceneIds")
                    if isinstance(ids, list) and cid in ids:
                        out.append((str(scene_id), collection, index, entity))
        return out

    def _cutscene_binding_signature(
        self, cutscene_id: str,
    ) -> frozenset[tuple[str, str, str]]:
        return frozenset(
            (
                scene_id,
                collection,
                str(entity.get("id") or f"#{index}"),
            )
            for scene_id, collection, index, entity
            in self._bound_entity_refs(cutscene_id)
        )

    def _append_bindings_to_entities(
        self,
        refs: list[tuple[str, str, int, dict]],
        new_ids: list[str],
    ) -> None:
        """只追加缺失 id，保留既有顺序/重复/未知实体字段。"""
        dirty_scenes: set[str] = set()
        for scene_id, _collection, _index, entity in refs:
            ids = entity.get("cutsceneIds")
            if not isinstance(ids, list):
                continue
            changed = False
            for cid in new_ids:
                if cid not in ids:
                    ids.append(cid)
                    changed = True
            if changed:
                dirty_scenes.add(scene_id)
        for scene_id in sorted(dirty_scenes):
            self._model.mark_dirty("scene", scene_id)

    def _create_split_assets(
        self,
        source_index: int,
        split_after: int,
        first_id: str,
        second_id: str,
        *,
        keep_continuity: bool,
        copy_bindings: bool,
    ) -> tuple[dict, dict]:
        """创建两个拆分副本；校验全部通过前不修改模型。"""
        cuts = self._model.cutscenes
        if not (0 <= source_index < len(cuts)):
            raise ValueError("来源过场已不存在，请刷新后重试。")
        source = cuts[source_index]
        if not isinstance(source, dict):
            raise ValueError("来源过场不是对象，无法安全拆分。")
        steps = source.get("steps")
        if not isinstance(steps, list) or len(steps) < 2:
            raise ValueError("过场至少需要两个顶层步骤才能拆分。")
        if not (0 <= split_after < len(steps) - 1):
            raise ValueError("拆分点必须位于首步与末步之间。")
        first_id = (first_id or "").strip()
        second_id = (second_id or "").strip()
        if not first_id or not second_id or first_id == second_id:
            raise ValueError("两个新过场必须使用不同的非空 id。")
        taken = {str(c.get("id", "")).strip() for c in cuts if isinstance(c, dict)}
        source_id = str(source.get("id", "")).strip()
        if not source_id or sum(
            1 for c in cuts
            if isinstance(c, dict) and str(c.get("id", "")).strip() == source_id
        ) != 1:
            raise ValueError("来源过场 id 为空或不唯一，无法安全复制它的引用。")
        conflict = [cid for cid in (first_id, second_id) if cid in taken]
        if conflict:
            raise ValueError("id 已存在，不会覆盖：" + "、".join(conflict))

        first = deepcopy(source)
        second = deepcopy(source)
        first["id"] = first_id
        second["id"] = second_id
        first["steps"] = deepcopy(steps[:split_after + 1])
        second["steps"] = deepcopy(steps[split_after + 1:])
        first.pop("commands", None)
        second.pop("commands", None)
        if keep_continuity:
            first["restoreState"] = False

        # 到这里才开始变更内存；来源对象从未被改动。
        cuts[source_index + 1:source_index + 1] = [first, second]
        self._model.mark_dirty("cutscene")
        if copy_bindings:
            self._append_bindings_to_entities(
                self._bound_entity_refs(source_id),
                [first_id, second_id],
            )
        self._pending_changes = False
        self._refresh()
        self.select_by_id(first_id)
        return first, second

    def _create_combined_asset(
        self,
        source_ids: list[str],
        new_id: str,
    ) -> dict:
        """顺序拼接相容资产；来源与旧绑定保留，新资产继承共同绑定。"""
        ids = [(cid or "").strip() for cid in source_ids]
        if len(ids) < 2 or len(set(ids)) != len(ids):
            raise ValueError("请选择至少两个不同的来源过场。")
        occurrences: dict[str, list[tuple[int, dict]]] = {}
        for i, cutscene in enumerate(self._model.cutscenes):
            if not isinstance(cutscene, dict):
                continue
            cid = str(cutscene.get("id", "")).strip()
            if cid:
                occurrences.setdefault(cid, []).append((i, cutscene))
        ambiguous = [cid for cid in ids if len(occurrences.get(cid, [])) > 1]
        if ambiguous:
            raise ValueError("来源 id 在项目中不唯一：" + "、".join(ambiguous))
        by_id = {cid: rows[0] for cid, rows in occurrences.items() if len(rows) == 1}
        missing = [cid for cid in ids if cid not in by_id]
        if missing:
            raise ValueError("来源过场已不存在：" + "、".join(missing))
        new_id = (new_id or "").strip()
        if not new_id:
            raise ValueError("新过场 id 不能为空。")
        if new_id in occurrences:
            raise ValueError(f"id「{new_id}」已存在，不会覆盖。")
        sources = [by_id[cid][1] for cid in ids]
        base_signature = CutsceneCombineDialog._root_signature(sources[0])
        if any(
            CutsceneCombineDialog._root_signature(source) != base_signature
            for source in sources[1:]
        ):
            raise ValueError("来源过场的根级场景绑定或扩展字段不一致，无法无损组合。")
        step_lists = [source.get("steps") for source in sources]
        if any(not isinstance(steps, list) for steps in step_lists):
            raise ValueError("来源过场存在非数组 steps，无法安全组合。")
        binding_signatures = [self._cutscene_binding_signature(cid) for cid in ids]
        if any(sig != binding_signatures[0] for sig in binding_signatures[1:]):
            raise ValueError(
                "来源过场的 NPC/Hotspot 绑定集合不一致，组合会改变演员显影语义。"
            )

        combined = deepcopy(sources[0])
        combined["id"] = new_id
        combined["steps"] = [
            deepcopy(step)
            for steps in step_lists
            for step in steps
        ]
        combined.pop("commands", None)
        last = sources[-1]
        if "restoreState" in last:
            combined["restoreState"] = deepcopy(last["restoreState"])
        else:
            combined.pop("restoreState", None)

        insert_at = max(by_id[cid][0] for cid in ids) + 1
        self._model.cutscenes.insert(insert_at, combined)
        self._model.mark_dirty("cutscene")
        self._append_bindings_to_entities(self._bound_entity_refs(ids[0]), [new_id])
        self._pending_changes = False
        self._refresh()
        self.select_by_id(new_id)
        return combined

    def split_after_outline(self, outline: StepOutlineFrame) -> None:
        if outline._parallel_parent is not None or outline not in self._step_outlines:
            QMessageBox.information(self, "拆分过场", "只能在顶层步骤之间拆分。")
            return
        split_after = self._step_outlines.index(outline)
        if split_after >= len(self._step_outlines) - 1:
            QMessageBox.information(self, "拆分过场", "末步之后没有可拆出的后半段。")
            return
        if not self._prepare_asset_operation():
            return
        source_index = self._current_idx
        if not (0 <= source_index < len(self._model.cutscenes)):
            return
        source = self._model.cutscenes[source_index]
        source_id = str(source.get("id", "")).strip()
        steps = source.get("steps")
        if not isinstance(steps, list) or split_after >= len(steps) - 1:
            QMessageBox.warning(self, "拆分过场", "来源步骤已变化，请重新选择拆分点。")
            return
        dlg = CutsceneSplitDialog(
            source_id,
            first_count=split_after + 1,
            second_count=len(steps) - split_after - 1,
            taken_ids={
                str(c.get("id", "")).strip()
                for c in self._model.cutscenes if isinstance(c, dict)
            },
            bound_entity_count=len(self._bound_entity_refs(source_id)),
            parent=self,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        try:
            self._create_split_assets(
                source_index,
                split_after,
                dlg.first_id(),
                dlg.second_id(),
                keep_continuity=dlg.keep_continuity(),
                copy_bindings=dlg.copy_bindings(),
            )
        except ValueError as exc:
            QMessageBox.warning(self, "拆分过场", str(exc))

    def _split_at_focused_outline(self) -> None:
        outline = self._focused_outline
        if outline is None:
            QMessageBox.information(self, "拆分过场", "请先点击要作为前半段末尾的顶层步骤。")
            return
        self.split_after_outline(outline)

    def _open_combine_dialog(self) -> None:
        if len(self._model.cutscenes) < 2:
            QMessageBox.information(self, "组合过场", "至少需要两段过场才能组合。")
            return
        if not self._prepare_asset_operation():
            return
        initial_id = self._current_cutscene_id() or ""
        signatures = {
            str(c.get("id", "")).strip(): self._cutscene_binding_signature(
                str(c.get("id", "")),
            )
            for c in self._model.cutscenes if isinstance(c, dict)
        }
        dlg = CutsceneCombineDialog(
            self._model.cutscenes,
            initial_id=initial_id,
            binding_signatures=signatures,
            parent=self,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        try:
            self._create_combined_asset(dlg.selected_ids(), dlg.new_id())
        except ValueError as exc:
            QMessageBox.warning(self, "组合过场", str(exc))

    def _add(self) -> None:
        # 新增前处理当前过场未 Apply 的编辑：与左侧切行同一套确认，
        # 旧实现强制 _pending_changes=False 绕过确认=静默丢编辑（审查 P1-3）
        if self._pending_changes:
            choice = self.confirm_apply_or_discard(self)
            if choice == "cancel":
                return
        taken = {str(c.get("id", "")) for c in self._model.cutscenes}
        n = 0
        while f"cutscene_{n}" in taken:
            n += 1  # len() 命名删过中间项必撞既存 id（现库就有 cutscene_11，审查 P1-26）
        self._model.cutscenes.append({
            "id": f"cutscene_{n}",
            "steps": [],
        })
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()
        # 自动选中新建过场，省去再去左侧点一下
        self._list.setCurrentRow(len(self._model.cutscenes) - 1)

    def _on_play(self, from_step: int = 0) -> None:
        cid = self._c_id.text().strip()
        if cid:
            self.play_requested.emit(cid, max(0, int(from_step)))

    # ----- 连续对白段批量编辑 -----

    #: 可进批量对白编辑的 present 类型（都以 speaker/text 为主体）
    _DIALOGUE_RUN_TYPES = ("showDialogue", "showSubtitle")

    def _is_dialogue_step(self, ol: "StepOutlineFrame") -> bool:
        try:
            d = ol._header_dict()
        except Exception:  # noqa: BLE001
            return False
        return (str(d.get("kind")) == "present"
                and str(d.get("type")) in self._DIALOGUE_RUN_TYPES)

    def dialogue_run_bounds(self, ol: "StepOutlineFrame") -> tuple[int, int] | None:
        """含 ol 在内的、同为对白/字幕的最长连续顶层区间；ol 非对白或不在顶层则 None。

        只认顶层：并行子轨里的对白各属不同轨，摊平成一列会丢掉 fork-join 语义。
        """
        if ol._parallel_parent is not None or not self._is_dialogue_step(ol):
            return None
        try:
            i = self._step_outlines.index(ol)
        except ValueError:
            return None
        lo = i
        while lo > 0 and self._is_dialogue_step(self._step_outlines[lo - 1]):
            lo -= 1
        hi = i
        last = len(self._step_outlines) - 1
        while hi < last and self._is_dialogue_step(self._step_outlines[hi + 1]):
            hi += 1
        return lo, hi

    def edit_dialogue_run(self, ol: "StepOutlineFrame") -> None:
        bounds = self.dialogue_run_bounds(ol)
        if bounds is None:
            return
        lo, hi = bounds
        try:
            steps = [self._step_outlines[i].to_dict() for i in range(lo, hi + 1)]
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "批量编辑对白", f"读取这段对白失败：{e}")
            return
        dlg = DialogueRunEditorDialog(
            steps, self._model, self, self, first_step_no=lo + 1)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        new_steps = dlg.result_steps()
        if new_steps == steps:
            return
        self._replace_top_range(lo, hi, new_steps)
        self._status_after_run_edit(len(steps), len(new_steps))

    def new_dialogue_block(self, after_ol: "StepOutlineFrame | None" = None) -> None:
        """开一个空对话块连着写几句，确认后一次性插入。

        after_ol=None 追加到末尾；否则插到该步之后。新句继承最近一句对白的
        说话人实体与立绘设置——连着写同一个人的台词时省掉逐句重填。
        """
        seed = new_dialogue_step(self._last_dialogue_context_step(after_ol))
        dlg = DialogueRunEditorDialog(
            [seed], self._model, self, self, creating=True)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        # 判空只看正文：speaker 是从上一句继承来的默认值（常是 {{npc}}），
        # 拿它当「写了东西」会把一句没填的空块也插进去。
        steps = [s for s in dlg.result_steps() if str(s.get("text") or "").strip()]
        if not steps:
            return          # 一句没写：当作放弃，不插空步
        self.insert_steps_after(after_ol, steps, expand_first=False)
        self._status_after_run_edit(0, len(steps))

    def _last_dialogue_context_step(
        self, before_ol: "StepOutlineFrame | None" = None,
    ) -> dict | None:
        """取参照对白步的完整 dict（新块的底模）：从 before_ol 往前找，没有就从末尾往前找。"""
        end = len(self._step_outlines)
        if before_ol is not None:
            try:
                end = self._step_outlines.index(before_ol) + 1
            except ValueError:
                pass
        for i in range(end - 1, -1, -1):
            ol = self._step_outlines[i]
            if self._is_dialogue_step(ol):
                try:
                    return ol.to_dict()
                except Exception:  # noqa: BLE001
                    return None
        return None

    def _replace_top_range(self, lo: int, hi: int, new_steps: list[dict]) -> None:
        """把顶层 [lo, hi] 整段换成 new_steps（句数可增可减），并把焦点落回段首。"""
        self.push_undo_snapshot()
        for i in range(hi, lo - 1, -1):
            old = self._step_outlines.pop(i)
            self._steps_layout.removeWidget(old)
            old.deleteLater()
        self._focused_outline = None      # 刚删的可能正是焦点条，断掉悬空引用
        cid = self._current_cutscene_id()
        first: StepOutlineFrame | None = None
        for offset, data in enumerate(new_steps):
            new_ol = StepOutlineFrame(
                data, self._model, self, self._steps_container,
                indent_px=0, parallel_parent=None,
                zebra_alt=False, cutscene_id=cid,
            )
            new_ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.insert(lo + offset, new_ol)
            if first is None:
                first = new_ol
        self._relayout_outline_list(self._step_outlines, self._steps_layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()
        # 编完回到外层对应位置——「找不到刚才编的是哪段」的解药
        if first is not None:
            self.focus_outline(first)
            QTimer.singleShot(0, first, lambda: self._steps_scroll.ensureWidgetVisible(first))

    def _status_after_run_edit(self, before: int, after: int) -> None:
        if before == 0:
            msg = f"已插入 {after} 句对白"
        elif after == before:
            msg = f"已更新 {after} 句对白"
        elif after > before:
            msg = f"已更新对白：{before} → {after} 句（新增 {after - before}）"
        else:
            msg = f"已更新对白：{before} → {after} 句（删除 {before - after}）"
        win = self.window()
        bar = getattr(win, "_status", None)
        if bar is not None:
            bar.showMessage(msg + "（Ctrl+Z 可撤销；仍需 Apply）", 5000)

    def play_from_outline(self, ol: "StepOutlineFrame") -> None:
        """从某个顶层步开播：之前的步在游戏侧瞬时快进（建立底图/图层/黑边/相机/演员站位），
        到该步恢复常速。并行子轨没有独立的顶层下标，按其所属并行块整体起播。"""
        top = ol
        while top._parallel_parent is not None:
            owner = top._parallel_parent._outline_frame
            if owner is None or owner is top:
                break
            top = owner
        try:
            idx = self._step_outlines.index(top)
        except ValueError:
            idx = 0
        self._on_play(idx)

    # ----- 并行结构：移出 / 并入（供 StepOutlineFrame 菜单调用） -----

    def outline_list_and_layout(self, ol: StepOutlineFrame) -> tuple[list[Any], Any]:
        """包含 ol 所在大纲行的列表与纵向 layout（顶层 steps 或某一 parallel 的子轨）。"""
        if ol._parallel_parent is None:
            return self._step_outlines, self._steps_layout
        pw = ol._parallel_parent
        return pw._child_outlines, pw._parallel_layout

    def lift_parallel_track_out(self, child_ol: StepOutlineFrame) -> None:
        """将并行中的一轨移到外层，插在该 parallel 步骤之后（同级）；若并行因此为空则删掉该 parallel。"""
        pw = child_ol._parallel_parent
        if pw is None or pw._outline_frame is None or pw._parallel_layout is None:
            return
        par_ol = pw._outline_frame
        lst, layout = self.outline_list_and_layout(par_ol)
        try:
            idx_par = lst.index(par_ol)
        except ValueError:
            return
        try:
            idx_ch = pw._child_outlines.index(child_ol)
        except ValueError:
            return
        self.push_undo_snapshot()
        data = deepcopy(child_ol.to_dict())
        pw._child_outlines.pop(idx_ch)
        pw._parallel_layout.removeWidget(child_ol)
        child_ol.deleteLater()

        host = par_ol.parentWidget()
        if host is None:
            host = self._steps_container
        cid = self._current_cutscene_id()
        new_ol = StepOutlineFrame(
            data, self._model, self, host,
            indent_px=par_ol._indent_px,
            parallel_parent=par_ol._parallel_parent,
            zebra_alt=False,
            cutscene_id=cid,
        )
        new_ol.contentChanged.connect(self._on_any_outline_changed)
        lst.insert(idx_par + 1, new_ol)
        self._relayout_outline_list(lst, layout)

        if not pw._child_outlines:
            lst2, layout2 = self.outline_list_and_layout(par_ol)
            try:
                lst2.remove(par_ol)
            except ValueError:
                pass
            if layout2 is not None:
                layout2.removeWidget(par_ol)
            par_ol.deleteLater()
            if layout2 is not None:
                self._relayout_outline_list(lst2, layout2)

        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def _relayout_outline_list(self, lst: list[Any], layout: Any) -> None:
        # 把 layout 重排为「大纲行(lst) 按序 + 其它常驻控件殿后」（如并行块末尾的「+ Track」
        # 按钮；顶层 _steps_layout 无其它控件，行为不变）。以 is 比较，绝不触碰可能已析构的
        # C++ 对象。
        #
        # 【禁用 takeAt()】此处严禁用 `layout.takeAt(0)` 排空再 addWidget：takeAt 把
        # QWidgetItem 的所有权移交给 Python 包装对象，包装对象析构时机（引用计数/GC）晚于
        # 重新 addWidget 时，其 C++ 析构会把行控件的 QWidgetPrivate::widgetItem 指针清空。
        # 此后该行的 updateGeometry() 再也打不穿新布局项的 heightForWidth 缓存 →
        # QScrollArea 拿到的 totalSizeHint 永远停在旧值 → 之后任何「展开详情」都不再撑高
        # 容器，展开行被压成表头裁切的细条、详情空白（移动/复制/粘贴一次后必现）。
        # removeWidget/insertWidget 在 C++ 侧同步删建布局项，无此问题。
        current: list[Any] = []
        for k in range(layout.count()):
            w = layout.itemAt(k).widget()
            if w is not None:
                current.append(w)
        # 对白组头不属于 lst，会被当成「常驻控件」殿后到末尾——它们本就是每次
        # _refresh_outline_indices_and_zebra 重建的，这里直接摘掉，免得中间态闪一下错位。
        groups = getattr(self, "_dialogue_groups", [])
        if groups:
            current = [w for w in current if not any(w is g for g in groups)]
        others = [w for w in current if not any(w is x for x in lst)]
        for i, w in enumerate(lst):
            layout.removeWidget(w)
            layout.insertWidget(i, w)
        for w in others:
            layout.removeWidget(w)
            layout.addWidget(w)

    def can_merge_adjacent_into_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol.step_kind() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i + 1 >= len(lst):
            return False
        return lst[i + 1].step_kind() != "parallel"

    def merge_adjacent_into_parallel(self, ol: StepOutlineFrame) -> None:
        """当前项与下一项（须均为 present/action）合并为一个 parallel（两轨）。"""
        if not self.can_merge_adjacent_into_parallel(ol):
            return
        self.push_undo_snapshot()
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        ol_next = lst[i + 1]
        d1 = deepcopy(ol.to_dict())
        d2 = deepcopy(ol_next.to_dict())
        pdata = {"kind": "parallel", "tracks": [d1, d2]}
        host = ol.parentWidget() or self._steps_container
        indent = ol._indent_px
        pp = ol._parallel_parent
        cid = self._current_cutscene_id()

        lst.pop(i + 1)
        lst.pop(i)
        layout.removeWidget(ol_next)
        layout.removeWidget(ol)
        ol_next.deleteLater()
        ol.deleteLater()

        new_par = StepOutlineFrame(
            pdata, self._model, self, host,
            indent_px=indent,
            parallel_parent=pp,
            zebra_alt=False,
            cutscene_id=cid,
        )
        new_par.contentChanged.connect(self._on_any_outline_changed)
        lst.insert(i, new_par)
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def can_merge_into_prev_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol.step_kind() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i == 0:
            return False
        return lst[i - 1].step_kind() == "parallel"

    def merge_into_prev_parallel(self, ol: StepOutlineFrame) -> None:
        if not self.can_merge_into_prev_parallel(ol):
            return
        self.push_undo_snapshot()
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        prev_ol = lst[i - 1]
        data = deepcopy(ol.to_dict())
        lst.pop(i)
        layout.removeWidget(ol)
        ol.deleteLater()

        prev_ol.ensure_step_detail()
        par_sw = prev_ol._step
        if par_sw is None:
            return
        self._append_track_to_parallel(par_sw, data)
        prev_ol.refresh_header()
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def can_merge_into_next_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol.step_kind() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i + 1 >= len(lst):
            return False
        return lst[i + 1].step_kind() == "parallel"

    def merge_into_next_parallel(self, ol: StepOutlineFrame) -> None:
        if not self.can_merge_into_next_parallel(ol):
            return
        self.push_undo_snapshot()
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        next_ol = lst[i + 1]
        data = deepcopy(ol.to_dict())
        lst.pop(i)
        layout.removeWidget(ol)
        ol.deleteLater()

        next_ol.ensure_step_detail()
        par_sw = next_ol._step
        if par_sw is None:
            return
        self._prepend_track_to_parallel(par_sw, data)
        next_ol.refresh_header()
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def _append_track_to_parallel(self, par_sw: StepWidget, data: dict) -> StepOutlineFrame:
        assert par_sw._parallel_layout is not None and par_sw._parallel_group is not None
        cid = self._current_cutscene_id()
        ol = StepOutlineFrame(
            deepcopy(data), self._model, self,
            par_sw._parallel_group,
            indent_px=16,
            parallel_parent=par_sw,
            zebra_alt=(len(par_sw._child_outlines) % 2 == 1),
            cutscene_id=cid,
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        par_sw._child_outlines.append(ol)
        par_sw._parallel_layout.insertWidget(par_sw._parallel_layout.count() - 1, ol)
        par_sw._on_parallel_child_changed()
        return ol

    def _prepend_track_to_parallel(self, par_sw: StepWidget, data: dict) -> StepOutlineFrame:
        assert par_sw._parallel_layout is not None and par_sw._parallel_group is not None
        cid = self._current_cutscene_id()
        ol = StepOutlineFrame(
            deepcopy(data), self._model, self,
            par_sw._parallel_group,
            indent_px=16,
            parallel_parent=par_sw,
            zebra_alt=False,
            cutscene_id=cid,
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        par_sw._child_outlines.insert(0, ol)
        par_sw._parallel_layout.insertWidget(0, ol)
        par_sw._on_parallel_child_changed()
        return ol

    def _delete(self) -> None:
        if self._current_idx >= 0:
            cut = self._model.cutscenes[self._current_idx]
            steps = cut.get("steps") or cut.get("commands") or []
            if not confirm.confirm_delete(
                self, f"过场「{cut.get('id', '')}」",
                f"包含 {len(steps)} 个步骤,删除后无法恢复。",
            ):
                return
            _del_idx = self._current_idx
            self._model.cutscenes.pop(_del_idx)
            self._current_idx = -1
            self._model.mark_dirty("cutscene")
            self._pending_changes = False
            self._refresh()
            # 选中相邻过场，避免右侧残留已删过场的表单（编辑无效且 Apply 静默无反馈）
            if self._model.cutscenes:
                self._list.setCurrentRow(min(_del_idx, len(self._model.cutscenes) - 1))
