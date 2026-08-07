"""叙事信号交叉引用的数据形状（纯 stdlib，无 Qt / 无编辑器依赖）。

一条信号只有两侧：**谁发**（Emitter）与**谁听**（Listener）。别的都是这两侧的注脚：

- `Declaration` = 黑盒元素 `meta.emits` 的「声明」。它**不是实发**（运行时不执行任何
  东西），只是画布上告诉人「这个盒子里将来会发这条信号」。口径与
  `agent_docs/editor-tools/mechanisms/emitted-signal-catalog.md` 一致，两侧永远分列，
  绝不合并计数——合并就会让"声明了但没人真发"这类问题永久隐身。
- 派生信号（`state:<图>:<状态>`）的「发送方」有两层：源状态自己（进入即广播）+ **能让
  它进入的路**（上游转移 / 强制设状态 / 图初始状态）。只列第一层等于没回答"谁让它发的"。

每个定位都带 `file` + `pointer` + `anchors`，形状与 `tools/json_lang/search.py` 的命中
一致，因此可以直接喂给主编辑器既有的 `navigate_to_search_hit()` 跳转引擎（复用而不是
再造一套路由；那套已覆盖对话图节点、场景实体、任务、过场步骤、档案、小游戏实例…）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

DRAFT_SIGNAL = "__draft__"
DERIVED_PREFIX = "state:"

# 发送方通道。UI 分组按它走，别按 container_kind——策划先问"这是戏里发的还是系统发的"。
CHANNEL_DIALOGUE = "dialogue"          # 对话图节点动作树
CHANNEL_ASSET = "asset"                # 场景/任务/遭遇/过场/压力条/档案/小游戏…动作树
CHANNEL_NARRATIVE_ACTION = "narrativeAction"  # 叙事图 state 的 onEnter/onExitActions
CHANNEL_BROADCAST = "broadcast"        # broadcastOnEnter 派生：进入该状态自动发
CHANNEL_UPSTREAM = "upstream"          # 仅派生信号：能让源状态发生的路

# 信号种类
KIND_AUTHOR = "author"      # 注册表里登记过的作者信号
KIND_DERIVED = "derived"    # state:<图>:<状态>，由 broadcastOnEnter 派生
KIND_DRAFT = "draft"        # __draft__ 占位
KIND_UNKNOWN = "unknown"    # 被用到但没登记（校验会报"未在信号注册表登记"）


def _clean(value: Any) -> str:
    return str(value or "").strip()


@dataclass
class Emitter:
    """一处「真会把这条信号发出去」的地方（或派生信号的一条上游因果）。"""

    signal: str
    channel: str
    container_kind: str = ""      # dialogue / scene / quest / cutscene / narrativeGraph …
    container_id: str = ""
    container_label: str = ""     # 中文名；没有就等于 id
    where: str = ""               # 人话位置：'节点 c_jie · actions[0]'
    context: str = ""             # 附近台词 / 状态名，帮策划认出是哪一句
    note: str = ""                # 附注：调试专用、初始状态…
    file: str = ""                # 仓库相对路径（跳转用）
    pointer: str = ""             # JSON pointer（跳转用）
    anchors: list[list[str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "channel": self.channel,
            "containerKind": self.container_kind,
            "containerId": self.container_id,
            "containerLabel": self.container_label,
            "where": self.where,
            "context": self.context,
            "note": self.note,
            "file": self.file,
            "pointer": self.pointer,
            "anchors": [list(a) for a in self.anchors],
        }


@dataclass
class Declaration:
    """黑盒元素 `meta.emits` 的声明。**不算实发**，永远单列。"""

    signal: str
    composition_id: str = ""
    composition_label: str = ""
    element_id: str = ""
    element_label: str = ""
    element_kind: str = ""
    ref_id: str = ""
    file: str = ""
    pointer: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "compositionId": self.composition_id,
            "compositionLabel": self.composition_label,
            "elementId": self.element_id,
            "elementLabel": self.element_label,
            "elementKind": self.element_kind,
            "refId": self.ref_id,
            "file": self.file,
            "pointer": self.pointer,
        }


@dataclass
class Listener:
    """一条监听该信号的转移。**信号的接收方只有转移这一种**——运行时其它系统听的是
    `narrative:stateChanged`（状态变了），不是信号本身（见 NarrativeStateManager）。"""

    signal: str
    composition_id: str = ""
    composition_label: str = ""
    graph_id: str = ""
    graph_label: str = ""
    element_id: str = ""          # 空 = 该编排的 mainGraph
    transition_id: str = ""
    from_state: str = ""
    from_label: str = ""
    to_state: str = ""
    to_label: str = ""
    conditions: list[str] = field(default_factory=list)
    priority: int = 0
    trigger: str = ""             # reactive / reactiveAll / reactiveAny（正常信号转移为空）
    file: str = ""
    pointer: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "compositionId": self.composition_id,
            "compositionLabel": self.composition_label,
            "graphId": self.graph_id,
            "graphLabel": self.graph_label,
            "elementId": self.element_id,
            "transitionId": self.transition_id,
            "from": self.from_state,
            "fromLabel": self.from_label,
            "to": self.to_state,
            "toLabel": self.to_label,
            "conditions": list(self.conditions),
            "priority": self.priority,
            "trigger": self.trigger,
            "file": self.file,
            "pointer": self.pointer,
        }


@dataclass
class StateRead:
    """条件叶里读了某个状态（`{"narrative": 图, "state": 态}`）。

    **不是信号接收**，但对派生信号必须显示：广播只被条件叶消费时，运行时红条与
    静态 unused 检查都会报"没人听"，那是已知噪声而非数据 bug
    （见 emitted-signal-catalog 已知坑）。列出来，人一眼就能判断是不是噪声。
    """

    graph_id: str = ""
    state_id: str = ""
    container_kind: str = ""
    container_id: str = ""
    where: str = ""
    file: str = ""
    pointer: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "containerKind": self.container_kind,
            "containerId": self.container_id,
            "where": self.where,
            "file": self.file,
            "pointer": self.pointer,
        }


# 诊断码。两侧对不齐的每一种形状各一条，UI 直接按码取文案/配色。
DIAG_NO_EMITTER = "noEmitter"            # 有人听、没人发（悬垂监听）
DIAG_DECLARED_ONLY = "declaredOnly"      # 只有黑盒声明、没有实发
DIAG_NO_LISTENER = "noListener"          # 有人发、没人听（发了没用）
DIAG_UNREGISTERED = "unregistered"       # 用到了但没在注册表登记
DIAG_DRAFT = "draft"                     # __draft__ 占位（运行时拒发）
DIAG_ORPHAN = "orphan"                   # 登记了但两侧都空
DIAG_BROADCAST_OFF = "broadcastOff"      # 派生信号的源状态没开 broadcastOnEnter / 不存在


@dataclass
class Diagnostic:
    code: str
    severity: str      # error | warning | info
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "severity": self.severity, "message": self.message}


@dataclass
class SignalCard:
    """一条信号的完整两侧视图。UI 直接渲染它，不再自己算口径。"""

    signal: str
    kind: str
    label: str = ""
    notes: str = ""
    registered: bool = False
    emitters: list[Emitter] = field(default_factory=list)
    declarations: list[Declaration] = field(default_factory=list)
    listeners: list[Listener] = field(default_factory=list)
    state_reads: list[StateRead] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    # 派生信号专属：源状态在哪张图、叫什么
    source_graph_id: str = ""
    source_state_id: str = ""
    source_state_label: str = ""

    @property
    def real_emitter_count(self) -> int:
        """真发射数：不含派生信号的上游因果（那是"谁让它发生"，不是"谁发出"）。"""
        return sum(1 for e in self.emitters if e.channel != CHANNEL_UPSTREAM)

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "kind": self.kind,
            "label": self.label,
            "notes": self.notes,
            "registered": self.registered,
            "emitters": [e.to_dict() for e in self.emitters],
            "declarations": [d.to_dict() for d in self.declarations],
            "listeners": [l.to_dict() for l in self.listeners],
            "stateReads": [s.to_dict() for s in self.state_reads],
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "sourceGraphId": self.source_graph_id,
            "sourceStateId": self.source_state_id,
            "sourceStateLabel": self.source_state_label,
            "emitterCount": self.real_emitter_count,
            "listenerCount": len(self.listeners),
            "declarationCount": len(self.declarations),
        }


def is_derived(signal: str) -> bool:
    return _clean(signal).startswith(DERIVED_PREFIX)


def parse_derived(signal: str) -> tuple[str, str] | None:
    """`state:<图>:<状态>` → (图, 状态)。图 id 不含冒号是既有数据约定（与 TS 侧同）。"""
    sid = _clean(signal)
    if not sid.startswith(DERIVED_PREFIX):
        return None
    rest = sid[len(DERIVED_PREFIX):]
    graph_id, sep, state_id = rest.partition(":")
    if not sep or not graph_id.strip() or not state_id.strip():
        return None
    return graph_id.strip(), state_id.strip()


def derived_signal_key(graph_id: str, state_id: str) -> str:
    return f"{DERIVED_PREFIX}{_clean(graph_id)}:{_clean(state_id)}"
