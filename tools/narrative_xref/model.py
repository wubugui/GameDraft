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

# 信号作用域（`signals[].scope`，真相源 src/core/narrativeGraphValidation.ts 的
# `signal.scope.invalid`：只认 'global' / 'private'，缺省即 global）。
# **私有信号只投递给发射方 owner 拥有的 wrapper 图**，缺 owner 上下文是 fail-loud 丢弃、
# 绝不回落成全局广播（见 agent_docs/runtime/mechanisms/private-narrative-signal.md）。
# 两侧清单必须把它标出来：同一条私有信号名会被 N 个同类实体共用，不标就会被当成
# "一发全推"，而那正是这个机制要避免的事。
SCOPE_GLOBAL = "global"
SCOPE_PRIVATE = "private"

# 反应式触发：不吃信号、靠条件自动评估，signal 字段**恒为占位且理应如此**。
# 真相源是 src/core/NarrativeStateManager.ts 的 `trigger?: 'signal' | 'reactive' | ...`，
# 本表是全 Python 侧唯一副本（调试器从这里 import，别再各写一份），parity 测试对着 TS 锁。
REACTIVE_TRIGGERS = frozenset({"reactive", "reactiveAll", "reactiveAny"})
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
    container_label: str = ""     # 具体条目的显示名；没有就等于 id
    kind_label: str = ""          # 类别中文名（'对话图' / '场景' / '任务'…），界面不甩字段名
    where: str = ""               # 人话位置：'节点「c_jie」· 动作 第 1 个'
    context: str = ""             # 附近台词 / 状态名，帮策划认出是哪一句
    note: str = ""                # 附注：调试专用、初始状态…
    file: str = ""                # 仓库相对路径（跳转用）
    pointer: str = ""             # JSON pointer（跳转用）
    anchors: list[list[str]] = field(default_factory=list)
    # 主编辑器只加载不保存的数据面（物件检视）：目录要看得见它发的信号，但**跳不过去**。
    # 界面据此提前说明，而不是给人一颗按下去必然失败的按钮。
    readonly: bool = False
    # 叙事图内的坐标（广播状态 / 状态动作 / 上游转移才有）。这类行的正确跳法是
    # **画布定位**：narrative_graphs.json 的文件级跳转只认 states/<id>，转移落不到点，
    # 会退化成"打开了叙事状态机页"——而你本来就在那一页，画面纹丝不动。
    composition_id: str = ""
    element_id: str = ""
    graph_id: str = ""
    state_id: str = ""
    transition_id: str = ""
    # 这条路**通不通**。只对派生信号的上游因果有意义：占位信号的转移运行时拒发，
    # 那条路根本走不到，界面必须把它跟真能走的路分开画，否则等于告诉人"有路可走"。
    wired: bool = True
    # 这一发**带不带宿主身份**（`emitNarrativeSignal` 的 ownerType/ownerId 参数）。
    # 私有信号按发射方 owner 定向投递；owner 绝大多数情况由发射点上下文隐式带进来
    # （ActionRegistry 的四档 origin 解析，作者不书写，静态扫不出来），但作者可以在
    # 发射点用这对参数**显式覆盖**——那是唯一写在数据里、静态看得见的宿主身份。
    # ⚠ 两个都填才生效（运行时 `paramOwnerType && paramOwnerId ? … : origin…`），
    # 只填一个等于没填，界面若照单显示会让人以为定向已经接上。
    owner_type: str = ""
    owner_id: str = ""

    @property
    def owner_bound(self) -> bool:
        """这一发是否在数据里显式钉死了宿主身份（两个参数都齐才算）。"""
        return bool(_clean(self.owner_type) and _clean(self.owner_id))

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "channel": self.channel,
            "containerKind": self.container_kind,
            "containerId": self.container_id,
            "containerLabel": self.container_label,
            "kindLabel": self.kind_label,
            "where": self.where,
            "context": self.context,
            "note": self.note,
            "file": self.file,
            "pointer": self.pointer,
            "anchors": [list(a) for a in self.anchors],
            "readonly": self.readonly,
            "compositionId": self.composition_id,
            "elementId": self.element_id,
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "transitionId": self.transition_id,
            "wired": self.wired,
            "ownerType": self.owner_type,
            "ownerId": self.owner_id,
            "ownerBound": self.owner_bound,
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
    # 这条转移**怎么才会走**（一句人话，三个界面共用）。各拼各的就会出现
    # 「收到「__draft__」时走」这种把走不通的路说成能走的文案。
    how: str = ""
    # 活计图（有 run 声明）只有在它是"当前激活的那一个"时才吃信号
    # （运行时 NarrativeStateManager.listScannableGraphEntries）。挂起的活计图看着
    # 停在起点，实际一个信号都不接——调试器据此把圆点降级，绝不报"正等着"。
    run_graph: bool = False
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
            "how": self.how,
            "runGraph": self.run_graph,
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
    kind_label: str = ""
    where: str = ""
    file: str = ""
    pointer: str = ""
    readonly: bool = False
    anchors: list[list[str]] = field(default_factory=list)
    # 这一行**自己长在哪**（不是它读的那张图）。读状态的引用有相当一部分就写在
    # narrative_graphs.json 里（转移条件、活计计数叶…），那类行必须走画布定位：
    # 文件级跳转对 narrative_graphs.json 只认 states/<id>，条件指针落不到点，
    # 会退化成"打开了叙事状态机页"——而人本来就在那一页，等于按钮没反应。
    composition_id: str = ""
    element_id: str = ""
    host_graph_id: str = ""
    host_transition_id: str = ""
    # ---- 这条引用**管的是世界里的什么** ----
    # 策划盯的是实体和流程，不是"条件叶·第 1 项"。列一串技术路径等于没回答问题：
    # 要说清楚"雾津街头那个挑空担的汉子出不出现"，而不是 npcs[3].conditions[0]。
    subject_kind: str = ""     # npc | hotspot | zone | quest | package | mapNode | dialogue | archive | …
    subject_name: str = ""     # 人看的名字（NPC 的 name / 热点的 label / 任务的 title…）
    subject_id: str = ""       # 它自己的 id（名字缺席时退到它）
    subject_scene: str = ""    # 在哪个场景里（场景实体才有）
    subject_effect: str = ""   # 这一拍决定它什么：出不出现 / 算不算完成 / 开不开…

    subject_kind_label: str = ""   # 主体类别的中文名（NPC / 热点 / 区域 / 任务…）
    # 这一项要的是「到过」还是「正停在」。差别很大：正停在＝此刻就能判死；到过＝要看历史。
    # 调试器据此决定敢不敢下断言（判不出来就照实说，绝不编）。
    reached: bool = False
    # 这一项被 not 包着（"不满足才成立"）。漏掉它会把结论说反。
    negated: bool = False

    @property
    def subject_display(self) -> str:
        return self.subject_name or self.subject_id or self.container_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "subjectKind": self.subject_kind,
            "subjectKindLabel": self.subject_kind_label,
            "reached": self.reached,
            "negated": self.negated,
            "subjectName": self.subject_name,
            "subjectId": self.subject_id,
            "subjectScene": self.subject_scene,
            "subjectEffect": self.subject_effect,
            "subjectDisplay": self.subject_display,
            "compositionId": self.composition_id,
            "elementId": self.element_id,
            "hostGraphId": self.host_graph_id,
            "hostTransitionId": self.host_transition_id,
            "containerKind": self.container_kind,
            "containerId": self.container_id,
            "kindLabel": self.kind_label,
            "where": self.where,
            "file": self.file,
            "pointer": self.pointer,
            "readonly": self.readonly,
            "anchors": [list(a) for a in self.anchors],
        }


# 诊断码。两侧对不齐的每一种形状各一条，UI 直接按码取文案/配色。
DIAG_NO_EMITTER = "noEmitter"            # 有人听、没人发（悬垂监听）
DIAG_DECLARED_ONLY = "declaredOnly"      # 只有黑盒声明、没有实发
DIAG_NO_LISTENER = "noListener"          # 有人发、没人听（发了没用）
DIAG_UNREGISTERED = "unregistered"       # 用到了但没在注册表登记
DIAG_DRAFT = "draft"                     # __draft__ 占位（运行时拒发）
DIAG_ORPHAN = "orphan"                   # 登记了但两侧都空
DIAG_BROADCAST_OFF = "broadcastOff"      # 派生信号的源状态没开 broadcastOnEnter / 不存在
DIAG_REACTIVE_ONLY = "reactiveOnly"       # 只有反应式转移在 signal 字段里填了它（运行时不看那字段）
DIAG_UNREACHABLE = "unreachable"         # 进这一拍的路全是占位（运行时拒发）= 这条广播发不出来


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
    # 注册表里写的 `scope`（原样带出来，不猜不补默认值：未登记信号根本没有这一栏，
    # 硬填 'global' 会让"没登记"和"登记了是全局"在界面上长得一模一样）。
    scope: str = ""
    registered: bool = False
    emitters: list[Emitter] = field(default_factory=list)
    declarations: list[Declaration] = field(default_factory=list)
    listeners: list[Listener] = field(default_factory=list)
    # 反应式转移的 signal 字段里填了这条信号名的（运行时不看那个字段，故不算监听）。
    # 单列一栏是为了不让人对着"没人听"发懵——名字确实写在那儿，只是运行时不认。
    reactive_refs: list[Listener] = field(default_factory=list)
    state_reads: list[StateRead] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    # 派生信号专属：源状态在哪张图、叫什么
    source_graph_id: str = ""
    source_graph_label: str = ""   # 同一张卡上别一处叫 id、一处叫中文名（会被当成两个东西）
    source_state_id: str = ""
    source_state_label: str = ""

    @property
    def real_emitter_count(self) -> int:
        """真发射数：不含派生信号的上游因果（那是"谁让它发生"，不是"谁发出"）。"""
        return sum(1 for e in self.emitters if e.channel != CHANNEL_UPSTREAM)

    @property
    def is_private(self) -> bool:
        """私有信号：只投递给发射方 owner 拥有的 wrapper 图，不进全局扫描面。"""
        return _clean(self.scope) == SCOPE_PRIVATE

    def to_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "kind": self.kind,
            "label": self.label,
            "notes": self.notes,
            "scope": self.scope,
            "private": self.is_private,
            "registered": self.registered,
            "emitters": [e.to_dict() for e in self.emitters],
            "declarations": [d.to_dict() for d in self.declarations],
            "listeners": [l.to_dict() for l in self.listeners],
            "reactiveRefs": [l.to_dict() for l in self.reactive_refs],
            "stateReads": [s.to_dict() for s in self.state_reads],
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "sourceGraphId": self.source_graph_id,
            "sourceGraphLabel": self.source_graph_label,
            "sourceStateId": self.source_state_id,
            "sourceStateLabel": self.source_state_label,
            "emitterCount": self.real_emitter_count,
            "listenerCount": len(self.listeners),
            "reactiveRefCount": len(self.reactive_refs),
            "declarationCount": len(self.declarations),
        }


@dataclass
class StateCard:
    """一个**状态**（策划嘴里的"一拍"）的全貌。

    与信号卡是两个问题：信号问"谁发谁听"，状态问"**怎么进来、怎么出去、谁在看着**"。
    最后那一栏是重点——读状态的引用里 346/370 是转移以外的消费者（对话分支、场景实体
    显隐、章节包、任务、地图节点、档案），它们全在因果图之外，改一拍最容易漏的就是它们。
    """

    graph_id: str
    state_id: str
    graph_label: str = ""
    state_label: str = ""
    composition_id: str = ""
    composition_label: str = ""
    element_id: str = ""
    exists: bool = True
    is_initial: bool = False
    broadcasts: bool = False       # 勾了「进入时广播」
    run_graph: bool = False        # 活计图（可重复运行的委托机器）
    broadcast_signal: str = ""     # 勾了广播才有：state:<图>:<态>
    ways_in: list[Emitter] = field(default_factory=list)      # 怎么进来（上游转移 / 强制设状态）
    ways_out: list[Listener] = field(default_factory=list)    # 从这儿能去哪
    emits: list[Emitter] = field(default_factory=list)        # 进/出这一拍会发什么信号
    readers: list[StateRead] = field(default_factory=list)    # 谁在看着这一拍
    diagnostics: list[Diagnostic] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.graph_id}.{self.state_id}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "graphLabel": self.graph_label,
            "stateLabel": self.state_label,
            "compositionId": self.composition_id,
            "compositionLabel": self.composition_label,
            "elementId": self.element_id,
            "exists": self.exists,
            "isInitial": self.is_initial,
            "broadcasts": self.broadcasts,
            "runGraph": self.run_graph,
            "broadcastSignal": self.broadcast_signal,
            "waysIn": [e.to_dict() for e in self.ways_in],
            "waysOut": [l.to_dict() for l in self.ways_out],
            "emits": [e.to_dict() for e in self.emits],
            "readers": [r.to_dict() for r in self.readers],
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "wayInCount": len(self.ways_in),
            "wayOutCount": len(self.ways_out),
            "readerCount": len(self.readers),
            "emitCount": len(self.emits),
        }


# 状态诊断码
DIAG_STATE_MISSING = "stateMissing"        # 被引用，但图里根本没有这个状态
DIAG_STATE_NO_WAY_IN = "stateNoWayIn"      # 进不来（非初始态且零上游）
DIAG_STATE_DEAD_END = "stateDeadEnd"       # 出不去（没有出口转移）
DIAG_STATE_UNUSED = "stateUnused"          # 没人读、也不广播：改它不牵连任何人


def is_reactive(trigger: str) -> bool:
    return _clean(trigger) in REACTIVE_TRIGGERS


def transition_is_unwired(signal: str, trigger: str) -> bool:
    """这条转移是不是**真的还没接线**。

    ⚠ 只看 `signal == __draft__` 会把反应式转移一并冤枉掉：它压根不吃信号，线接在
    conditions 上（踩过：主线「闲逛A→闲逛B」写了条件，因果图不画、还写"没接线"）。
    反过来，纯信号触发 + 占位信号 = 运行时明确拒发（NarrativeStateManager 拒发
    `__draft__`），那条路**走不通**，说成"收到信号 __draft__ 时走"就是骗人。

    调试器与本引擎共用这一条判据（调试器的 `Transition.is_unwired` 直接调它），
    两处各写一份的后果就是同一份数据在两个工具里给出相反答案。
    """
    return _clean(signal) == DRAFT_SIGNAL and not is_reactive(trigger)


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
