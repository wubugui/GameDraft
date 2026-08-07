"""玩家身体动词响应编辑器（实体级 acts / zone 级 onPlayerAct）。

对应运行时 `ZoneActMap`（ZoneDef.onPlayerAct）。派发优先级：
目标级（开目标自己那张图、entry＝动词名）→ 区域级（本文件）→ 全局兜底，匹配到即停。

**实体上没有动词响应表**：某个具体目标要吃某个动词，靠它已有的对话图里有没有
同名 entry 回答（踢狗 = 开狗的图、entry 走 `kick`）。所以这里只剩 zone 一层。

**重块懒建**：五个动词各一节，控件树推迟到该节第一次展开才造。
收益在"该实体没配这个动词"时兑现——**配了的动词 `set_data` 会当场建出来并展开**，
所以内容侧铺开后构造成本会随之回来。
（不懒建的代价是实打实的：编辑器测试的耗时对存活控件数是 O(N²)，
每个场景面板多挂十几棵 ActionEditor 会把全套测试从分钟级推到超时。）

**契约**：动作列表为空的动词不写键。
"""
from __future__ import annotations

import copy
from typing import Any, Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel

from .action_editor import ActionEditor
from .collapsible_section import CollapsibleSection

# 与 src/data/types.ts 的 PLAYER_VERBS 对齐（test_player_verbs_parity.py 锁定）
PLAYER_VERBS: tuple[str, ...] = ("crouch", "gaze", "kick", "jump", "lie")

PLAYER_VERB_LABELS: dict[str, str] = {
    "crouch": "蹲下（C）",
    "gaze": "驻足注视（X）",
    "kick": "上脚 / 踢（F）",
    "jump": "跳（空格）",
    "lie": "躺（躺点上按 C）",
}

# 姿态动词（持续态）；其余为一次性动作
PLAYER_POSTURES: tuple[str, ...] = ("crouch", "gaze", "lie")


class _LazyVerbSection:
    """一个动词的折叠节：控件在首次展开时才建，之前只揣着原始数据。"""

    def __init__(self, title: str, build: Callable[[QWidget], None]) -> None:
        self.section = CollapsibleSection(title, start_open=False)
        self._build = build
        self.built = False
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self.section.add_body(self._body)
        self.section.expanded_changed.connect(self._on_expanded)

    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self.built:
            return
        self.built = True
        self._build(self._body)

    def add(self, w: QWidget) -> None:
        self._body_layout.addWidget(w)


class ZoneActsEditor(QWidget):
    """zone 的 `onPlayerAct`：每个动词一串 actions（事件驱动，不受 onStay 节流影响）。"""

    #: 任一动词的动作列表被用户改动。**调用方必须接到 `_emit_props_changed`**，
    #: 否则编辑不置 pending-dirty，切条目时 staging 被 auto-discard ＝ 静默丢数据。
    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        hint = QLabel(
            "玩家在本区内做这个动作时执行；只有当动作没被目标级 acts 接住才轮到这里。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888;")
        lay.addWidget(hint)

        self._model: Any = None
        self._scene_id: str | None = None
        self._pending: dict[str, Any] = {}
        self._acts: dict[str, ActionEditor] = {}
        self._sections: dict[str, _LazyVerbSection] = {}
        for verb in PLAYER_VERBS:
            sec = _LazyVerbSection(
                PLAYER_VERB_LABELS[verb],
                lambda body, v=verb: self._build_verb_body(v, body),
            )
            lay.addWidget(sec.section)
            self._sections[verb] = sec

    def _build_verb_body(self, verb: str, _body: QWidget) -> None:
        act = ActionEditor("actions")
        self._sections[verb].add(act)
        self._acts[verb] = act
        act.set_project_context(self._model, self._scene_id)
        raw = self._pending.get(verb)
        act.set_data(raw if isinstance(raw, list) else [])
        act.changed.connect(self._on_user_edit)

    def _on_user_edit(self) -> None:
        if self._loading:
            return
        self.changed.emit()

    def set_project_context(self, model: Any, scene_id: str | None = None) -> None:
        self._model = model
        self._scene_id = scene_id
        for verb in PLAYER_VERBS:
            if self._sections[verb].built:
                self._acts[verb].set_project_context(model, scene_id)

    def reload_refs_from_model(self) -> None:
        for verb in PLAYER_VERBS:
            if not self._sections[verb].built:
                continue
            fn = getattr(self._acts[verb], "reload_refs_from_model", None)
            if callable(fn):
                fn()

    def set_data(self, on_player_act: Any) -> None:
        data = on_player_act if isinstance(on_player_act, dict) else {}
        self._loading = True
        try:
            self._pending = copy.deepcopy(data)
            for verb in PLAYER_VERBS:
                raw = data.get(verb)
                sec = self._sections[verb]
                if raw:
                    sec.ensure_built()
                    sec.section.set_expanded(True)
                if sec.built:
                    self._acts[verb].set_data(raw if isinstance(raw, list) else [])
        finally:
            self._loading = False

    def to_dict(self) -> dict:
        out: dict = {}
        for verb in PLAYER_VERBS:
            if not self._sections[verb].built:
                raw = self._pending.get(verb)
                if isinstance(raw, list) and raw:
                    out[verb] = copy.deepcopy(raw)
                continue
            actions = self._acts[verb].to_list()
            if actions:
                out[verb] = actions
        return out
