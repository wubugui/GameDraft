"""端口标签（Port Tags）—— RFC §4.

设计要点：
- 没有运行时类型系统。本文件只服务 GUI 拖线校验、CLI graph validate 静态检查、文档生成。
- 容器写法 `List[Agent]` / `Dict[Str, IntentList]` / `Optional[Event]` / `Union[Str, Int]`
  在 schema 里是字符串，由 `parse_tag` 解析为 `TagRef`。
- alias 表是仓库内固定的，用户不能添加（避免领域类型蔓延）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from tools.chronicle_sim_v3.engine.errors import ValidationError


class PortType(str, Enum):
    """RFC §4.2 的标签集合。容器（List/Dict/Optional/Union）不在枚举内。"""

    Any = "Any"
    Trigger = "Trigger"
    Int = "Int"
    Float = "Float"
    Str = "Str"
    Bool = "Bool"
    Bytes = "Bytes"
    Json = "Json"

    AgentId = "AgentId"
    Agent = "Agent"
    AgentList = "AgentList"
    FactionId = "FactionId"
    Faction = "Faction"
    FactionList = "FactionList"
    LocationId = "LocationId"
    Location = "Location"
    LocationList = "LocationList"
    EdgeList = "EdgeList"
    Path = "Path"
    Event = "Event"
    EventList = "EventList"
    Draft = "Draft"
    DraftList = "DraftList"
    Rumor = "Rumor"
    RumorList = "RumorList"
    Intent = "Intent"
    IntentList = "IntentList"
    Belief = "Belief"
    BeliefList = "BeliefList"
    EventType = "EventType"
    EventTypeList = "EventTypeList"
    Pacing = "Pacing"
    Week = "Week"
    RunId = "RunId"
    Seed = "Seed"
    LLMRef = "LLMRef"
    SubgraphRef = "SubgraphRef"
    Mutation = "Mutation"
    # 域类型补充（catalog 中可能涉及）
    Edge = "Edge"


_CONTAINER_BASES = frozenset({"List", "Dict", "Optional", "Union", "Tuple", "Set"})

# RFC §4.4 alias 表：左边的简写 → 右边的容器形式
_ALIASES: dict[str, "TagRef"] = {}


def _alias(short: str, long_form: "TagRef") -> None:
    _ALIASES[short] = long_form


@dataclass(frozen=True)
class TagRef:
    """端口标签的内部表示。

    base = 'List' / 'Dict' / 'Optional' / 'Union' / 域类型名 / 'Any' 等
    args = 容器参数；非容器为空 tuple
    """

    base: str
    args: tuple["TagRef", ...] = field(default_factory=tuple)

    def __str__(self) -> str:
        if not self.args:
            return self.base
        inner = ", ".join(str(a) for a in self.args)
        return f"{self.base}[{inner}]"


def _atom(name: str) -> TagRef:
    return TagRef(base=name)


# 注册 alias（必须在 TagRef 定义之后）
_alias("AgentList", TagRef("List", (_atom("Agent"),)))
_alias("FactionList", TagRef("List", (_atom("Faction"),)))
_alias("LocationList", TagRef("List", (_atom("Location"),)))
_alias("EventList", TagRef("List", (_atom("Event"),)))
_alias("DraftList", TagRef("List", (_atom("Draft"),)))
_alias("RumorList", TagRef("List", (_atom("Rumor"),)))
_alias("IntentList", TagRef("List", (_atom("Intent"),)))
_alias("BeliefList", TagRef("List", (_atom("Belief"),)))
_alias("EventTypeList", TagRef("List", (_atom("EventType"),)))
_alias("EdgeList", TagRef("List", (_atom("Edge"),)))


def _split_top_level(s: str, sep: str = ",") -> list[str]:
    """按 sep 切分，但跳过中括号内的逗号。"""
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in s:
        if ch == "[":
            depth += 1
            buf.append(ch)
        elif ch == "]":
            depth -= 1
            buf.append(ch)
        elif ch == sep and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf).strip())
    return out


def parse_tag(text: str) -> TagRef:
    """把 'List[Agent]' / 'Dict[Str, IntentList]' / 'Agent' 解析成 TagRef。

    宽松规则：
    - 大小写敏感
    - 空白会被 strip
    - 嵌套通过 '[' 计数处理
    """
    text = text.strip()
    if not text:
        raise ValidationError("parse_tag: 空字符串")
    lb = text.find("[")
    if lb < 0:
        return TagRef(base=text)
    if not text.endswith("]"):
        raise ValidationError(f"parse_tag: 缺少右括号 in {text!r}")
    base = text[:lb].strip()
    if not base:
        raise ValidationError(f"parse_tag: 缺少容器名 in {text!r}")
    inner = text[lb + 1 : -1]
    parts = _split_top_level(inner, ",")
    if not parts or any(not p for p in parts):
        raise ValidationError(f"parse_tag: 空容器参数 in {text!r}")
    return TagRef(base=base, args=tuple(parse_tag(p) for p in parts))


def normalize_alias(t: TagRef) -> TagRef:
    """递归把简写域类型展开为 List[X]。"""
    if not t.args and t.base in _ALIASES:
        return normalize_alias(_ALIASES[t.base])
    if t.args:
        return TagRef(base=t.base, args=tuple(normalize_alias(a) for a in t.args))
    return t


def can_connect(src: TagRef, dst: TagRef) -> bool:
    """RFC §4.5：Any 双向通配；alias 归一相同；Optional/Union 解包。

    Any 是逃生口，**容器内层 Any 也通配**：`List[Any]` 接 `List[Agent]` OK；
    `Dict[Str, Any]` 接 `Dict[Str, Json]` OK。这是 RFC 字面之外的实用让步：
    没有它，每个通用 data 节点（filter / map / count）都得为每种域类型重载。
    """
    if src.base == "Any" or dst.base == "Any":
        return True
    s = normalize_alias(src)
    d = normalize_alias(dst)
    if s == d:
        return True
    if d.base == "Optional" and len(d.args) == 1 and can_connect(s, d.args[0]):
        return True
    if d.base == "Union" and any(can_connect(s, t) for t in d.args):
        return True
    if s.base == "Union" and all(can_connect(t, d) for t in s.args):
        return True
    # 同一容器 base 内逐 arg 递归（让内层 Any 也能通配）
    if s.base == d.base and len(s.args) == len(d.args) and s.args:
        return all(can_connect(sa, da) for sa, da in zip(s.args, d.args))
    return False


class PortSpec(BaseModel):
    """节点端口定义（RFC §4.6）。"""

    name: str
    type: str = Field(description="端口标签字符串，由 parse_tag 解析")
    required: bool = True
    default: Any = None
    multi: bool = False
    doc: str = ""

    def tag(self) -> TagRef:
        return parse_tag(self.type)
