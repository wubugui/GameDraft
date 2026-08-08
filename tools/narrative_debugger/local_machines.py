"""局部机（实体绑定即实例化的私有状态机）在调试器这一侧的模型层。

设计稿：``artifact/Design/实体局部状态机-技术设计-2026-08-08.md``。

**调试器是唯一有权看见实例私有状态的消费者**——内容层按设计不可寻址（`narrative` /
`narrativeCount` 叶拒收局部机 id），但排障必须看得见：不给看的话，"这个箱子为什么没打开"
就只剩重启游戏猜一遍这一条路。

这一层只做三件事，刻意不碰 Qt：

1. **实例键的拼/拆**——与 TS 侧 ``narrativeLocalInstanceKey`` /
   ``parseNarrativeLocalInstanceKey`` 逐字对齐（格式 ``<原型>@<场景>/<类型>:<实体>``）。
   两边各写一套迟早会漂，而漂了的表现是"面板上一个实例都不显示"，最难查。
2. **原型声明**（变量表 + 默认值 + 监听/导出声明）从 narrative_graphs.json 里读出来。
   实例只携带**被写过**的变量，变量表的完整当前值 = 原型默认值叠上实例覆盖。
3. **运行时实例视图**：把 ``debugSnapshot().localInstances`` 那份原始映射译成带人话的行，
   外加分组/过滤（1000 个实例时列表必须还能用）。

查不到的一律照实说（`None` / 空串），绝不编——面板上"不知道"比一个编出来的默认值有用。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from tools.narrative_debugger.model import NarrativeIndex

#: 实例键的分隔符。`@` 是图 id 的保留禁用字符（活计图设计 §5.6 定，现网 0 处），
#: 所以能安全用作「原型 / 宿主」的分界。
KEY_SEP = "@"

#: 实体类型 → 人话。宿主只可能是场景里摆着的三类实体（NpcDef / HotspotDef / ZoneDef）。
ENTITY_KIND_LABEL = {
    "npc": "人",
    "hotspot": "物件",
    "zone": "区域",
}


def instance_key(machine_id: str, scene_id: str, entity_kind: str, entity_id: str) -> str:
    """`<machineId>@<sceneId>/<entityKind>:<entityId>`（与 TS 同口径）。"""
    return f"{str(machine_id).strip()}{KEY_SEP}{str(scene_id).strip()}/{str(entity_kind).strip()}:{str(entity_id).strip()}"


@dataclass(frozen=True)
class ParsedKey:
    machine_id: str
    scene_id: str
    entity_kind: str
    entity_id: str


def parse_instance_key(key: str) -> ParsedKey | None:
    """实例键的逆运算。格式非法返回 None（与 TS 的 parseNarrativeLocalInstanceKey 一致）。

    ⚠ 用 `indexOf('@')` 而不是 `split`：场景/实体 id 里理论上还能再出现分隔符，
    只有"第一个 @、第一个 /、第一个 :"这套取法才和运行时拼出来的键一一对上。
    """
    raw = str(key or "")
    at = raw.find(KEY_SEP)
    if at <= 0:
        return None
    machine_id = raw[:at]
    rest = raw[at + 1:]
    slash = rest.find("/")
    if slash < 0:
        return None
    scene_id = rest[:slash]
    tail = rest[slash + 1:]
    colon = tail.find(":")
    if colon <= 0:
        return None
    entity_kind = tail[:colon]
    entity_id = tail[colon + 1:]
    if not (machine_id and scene_id and entity_kind and entity_id):
        return None
    return ParsedKey(machine_id, scene_id, entity_kind, entity_id)


@dataclass(frozen=True)
class LocalVarDef:
    """原型声明的一个实例变量。"""

    key: str
    type: str = "bool"
    default: Any = None

    @property
    def value(self) -> Any:
        """没写 default 时按类型给出厂值（与 TS 的 localVarDefault 同口径）。"""
        if self.default is not None:
            return self.default
        return 0 if self.type == "float" else "" if self.type == "string" else False


@dataclass(frozen=True)
class LocalMachineDef:
    """一台局部机原型（可复用资产；实体绑定它才产生实例）。"""

    machine_id: str
    label: str
    initial_state: str
    var_defs: tuple[LocalVarDef, ...] = ()
    listens: tuple[str, ...] = ()
    emits: tuple[str, ...] = ()

    def default_for(self, key: str) -> Any:
        for v in self.var_defs:
            if v.key == key:
                return v.value
        return None

    def declares(self, key: str) -> bool:
        return any(v.key == key for v in self.var_defs)


def machine_defs(index: NarrativeIndex) -> dict[str, LocalMachineDef]:
    """从叙事索引里挑出全部局部机原型。

    数据面还没落地时（现网 narrative_graphs.json 里一台都没有）返回空表——
    面板据此说"工程里还没有局部机原型"，而不是空着让人以为工具坏了。
    """
    out: dict[str, LocalMachineDef] = {}
    for graph_id, graph in index.graphs.items():
        local = graph.get("local")
        if not isinstance(local, dict):
            continue
        var_defs: list[LocalVarDef] = []
        for raw in local.get("vars") or []:
            if not isinstance(raw, dict):
                continue
            key = str(raw.get("key") or "").strip()
            if not key:
                continue
            var_defs.append(LocalVarDef(
                key=key,
                type=str(raw.get("type") or "bool"),
                default=raw.get("default"),
            ))
        out[graph_id] = LocalMachineDef(
            machine_id=graph_id,
            label=index.graph_labels.get(graph_id, graph_id),
            initial_state=str(graph.get("initialState") or ""),
            var_defs=tuple(var_defs),
            listens=tuple(str(s) for s in (local.get("listens") or []) if str(s).strip()),
            emits=tuple(str(s) for s in (local.get("emits") or []) if str(s).strip()),
        )
    return out


@dataclass(frozen=True)
class LocalInstance:
    """一台**活着的**私有机器：某个实体身上那一份态与变量。"""

    key: str
    machine_id: str
    scene_id: str
    entity_kind: str
    entity_id: str
    active: str
    #: 宿主在不在场（所属场景已装载）。**None = 引擎没报**——照实说，不假装它不在场。
    loaded: bool | None = None
    #: 实例上被写过的变量（不含仍是出厂值的那些）。
    overrides: dict[str, Any] = field(default_factory=dict)

    @property
    def host_key(self) -> str:
        return f"{self.scene_id}/{self.entity_kind}:{self.entity_id}"


def read_instances(narrative_snapshot: Any, index: NarrativeIndex) -> list[LocalInstance]:
    """把 ``debugSnapshot().localInstances`` 译成实例行（按实例键排序，稳定不跳动）。

    宿主坐标优先取快照里的 `host`；缺了就从键上拆——键本身就是由宿主推导出来的，
    这条退路能让"引擎少报一个字段"不至于让整个面板空掉。
    """
    raw = narrative_snapshot.get("localInstances") if isinstance(narrative_snapshot, dict) else None
    if not isinstance(raw, dict):
        return []
    out: list[LocalInstance] = []
    for key, entry in raw.items():
        inst = _read_instance(str(key), entry)
        if inst is not None:
            out.append(inst)
    out.sort(key=lambda i: (i.machine_id, i.scene_id, i.entity_id))
    return out


def _read_instance(key: str, entry: Any) -> LocalInstance | None:
    data = entry if isinstance(entry, dict) else {}
    host = data.get("host") if isinstance(data.get("host"), dict) else {}
    parsed = parse_instance_key(key)
    machine_id = str(data.get("machineId") or (parsed.machine_id if parsed else "")).strip()
    scene_id = str(host.get("sceneId") or (parsed.scene_id if parsed else "")).strip()
    entity_kind = str(host.get("entityKind") or (parsed.entity_kind if parsed else "")).strip()
    entity_id = str(host.get("entityId") or (parsed.entity_id if parsed else "")).strip()
    if not machine_id:
        return None
    loaded = data.get("loaded")
    overrides = data.get("vars")
    return LocalInstance(
        key=key,
        machine_id=machine_id,
        scene_id=scene_id,
        entity_kind=entity_kind,
        entity_id=entity_id,
        active=str(data.get("active") or ""),
        loaded=loaded if isinstance(loaded, bool) else None,
        overrides=dict(overrides) if isinstance(overrides, dict) else {},
    )


def current_vars(inst: LocalInstance, definition: LocalMachineDef | None) -> dict[str, Any]:
    """变量表的**当前全量值**：原型默认值打底，实例写过的盖上去。

    只显示 overrides 是不够的——策划问的是"这个箱子被踢过几次"，
    没被踢过时答案是 0，而不是"这一栏没有这个变量"。
    """
    out: dict[str, Any] = {}
    if definition is not None:
        for v in definition.var_defs:
            out[v.key] = v.value
    # 原型里没声明的键正常不该出现（setLocalVar 会 fail-loud 拒写），
    # 但存档里可能留着历史脏数据——照样显示出来，藏起来只会让人查不到根因。
    out.update(inst.overrides)
    return out


def deviates(inst: LocalInstance, definition: LocalMachineDef | None) -> bool:
    """这台机器动过没有（＝会不会进存档）。

    与 TS 的 serializeLocalInstances 同口径：态偏离 initialState、或有变量偏离默认值。
    1000 个没被碰过的箱子在存档里是 0 条目，面板上「只看动过的」也应该一个不剩。
    """
    if definition is None:
        return bool(inst.overrides) or bool(inst.active)
    if inst.active and inst.active != definition.initial_state:
        return True
    return any(value != definition.default_for(key) for key, value in inst.overrides.items())


# ---- 人话 ---------------------------------------------------------------


def machine_label(index: NarrativeIndex, machine_id: str) -> str:
    return index.graph_labels.get(machine_id, machine_id)


def state_label(index: NarrativeIndex, machine_id: str, state_id: str) -> str:
    node = index.state(machine_id, state_id)
    return node.display if node is not None else (state_id or "（没态）")


def scene_label(index: NarrativeIndex, scene_id: str) -> str:
    return index.scene_names.get(scene_id, scene_id)


def entity_label(index: NarrativeIndex, inst: LocalInstance) -> str:
    """宿主实体的人话名。场景数据里配了名字就用名字，没配就退回 id，不编。"""
    label = index.entity_labels.get(inst.host_key, "")
    return label or inst.entity_id


def host_phrase(index: NarrativeIndex, inst: LocalInstance) -> str:
    """「雾津街头的物件『铁箱』」——策划站在世界里认得出是哪一个。"""
    scene = scene_label(index, inst.scene_id)
    kind = ENTITY_KIND_LABEL.get(inst.entity_kind, inst.entity_kind or "实体")
    name = entity_label(index, inst)
    return f"{scene}的{kind}「{name}」" if scene else f"{kind}「{name}」"


def instance_phrase(index: NarrativeIndex, inst: LocalInstance) -> str:
    """一句话说清是哪台机器、装在谁身上、现在什么态。"""
    return (
        f"「{machine_label(index, inst.machine_id)}」装在{host_phrase(index, inst)}上，"
        f"现在「{state_label(index, inst.machine_id, inst.active)}」"
    )


def key_phrase(index: NarrativeIndex, key: str) -> str:
    """只拿到一个实例键时的人话（trace 事件里就只有键）。

    拆不开的键**原样返回**——照实说比编一个宿主出来强，那种编造会让人去找一个
    根本不存在的实体。
    """
    parsed = parse_instance_key(key)
    if parsed is None:
        return key or "（不知道是哪台）"
    inst = LocalInstance(
        key=key,
        machine_id=parsed.machine_id,
        scene_id=parsed.scene_id,
        entity_kind=parsed.entity_kind,
        entity_id=parsed.entity_id,
        active="",
    )
    return f"「{machine_label(index, parsed.machine_id)}」·{host_phrase(index, inst)}"


def entity_label_from_key(index: NarrativeIndex, key: str) -> str:
    """只拿到实例键时的宿主名（断点行上用）。拆不开就原样返回，不编。"""
    parsed = parse_instance_key(key)
    if parsed is None:
        return key
    host_key = f"{parsed.scene_id}/{parsed.entity_kind}:{parsed.entity_id}"
    return index.entity_labels.get(host_key) or parsed.entity_id


def presence_phrase(loaded: bool | None) -> str:
    if loaded is True:
        return "在场"
    if loaded is False:
        return "不在场"
    return "不知道"


# ---- 过滤 / 分组 ---------------------------------------------------------


def haystack(index: NarrativeIndex, inst: LocalInstance) -> str:
    """搜索用的干草堆：id 与人话名都能搜到（策划记得住的通常是名字）。"""
    return " ".join((
        inst.key,
        inst.machine_id,
        machine_label(index, inst.machine_id),
        inst.scene_id,
        scene_label(index, inst.scene_id),
        inst.entity_kind,
        inst.entity_id,
        entity_label(index, inst),
        inst.active,
        state_label(index, inst.machine_id, inst.active),
    )).lower()


def filter_instances(
    index: NarrativeIndex,
    instances: Iterable[LocalInstance],
    *,
    machine_id: str = "",
    scene_id: str = "",
    text: str = "",
    only_loaded: bool = False,
    only_touched: bool = False,
    defs: dict[str, LocalMachineDef] | None = None,
) -> list[LocalInstance]:
    """按原型 / 场景 / 关键词 / 在场 / 动过 筛。全部条件是「与」。"""
    needle = text.strip().lower()
    machines = defs if defs is not None else {}
    out: list[LocalInstance] = []
    for inst in instances:
        if machine_id and inst.machine_id != machine_id:
            continue
        if scene_id and inst.scene_id != scene_id:
            continue
        # loaded 未知（引擎没报）时不当作"不在场"筛掉——那会让整张表凭空消失
        if only_loaded and inst.loaded is False:
            continue
        if only_touched and not deviates(inst, machines.get(inst.machine_id)):
            continue
        if needle and needle not in haystack(index, inst):
            continue
        out.append(inst)
    return out


def group_by_machine_and_scene(
    instances: Iterable[LocalInstance],
) -> list[tuple[str, list[tuple[str, list[LocalInstance]]]]]:
    """[(原型 id, [(场景 id, [实例…])…])…]，两层都按 id 排序，刷新之间顺序稳定。"""
    buckets: dict[str, dict[str, list[LocalInstance]]] = {}
    for inst in instances:
        buckets.setdefault(inst.machine_id, {}).setdefault(inst.scene_id, []).append(inst)
    return [
        (machine_id, [
            (scene_id, sorted(rows, key=lambda i: i.entity_id))
            for scene_id, rows in sorted(scenes.items())
        ])
        for machine_id, scenes in sorted(buckets.items())
    ]
