"""端口标签 parse / normalize / can_connect 用例。"""
from __future__ import annotations

import pytest

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.types import (
    PortSpec,
    TagRef,
    can_connect,
    normalize_alias,
    parse_tag,
)


def test_parse_atom() -> None:
    assert parse_tag("Agent") == TagRef("Agent")


def test_parse_list() -> None:
    assert parse_tag("List[Agent]") == TagRef("List", (TagRef("Agent"),))


def test_parse_nested() -> None:
    t = parse_tag("Dict[Str, List[Agent]]")
    assert t == TagRef(
        "Dict",
        (TagRef("Str"), TagRef("List", (TagRef("Agent"),))),
    )


def test_parse_optional_union() -> None:
    assert parse_tag("Optional[Event]") == TagRef("Optional", (TagRef("Event"),))
    assert parse_tag("Union[Str, Int]") == TagRef(
        "Union", (TagRef("Str"), TagRef("Int"))
    )


def test_parse_strips_whitespace() -> None:
    assert parse_tag("  List[ Agent ]  ") == TagRef("List", (TagRef("Agent"),))


def test_parse_rejects_empty() -> None:
    with pytest.raises(ValidationError):
        parse_tag("")
    with pytest.raises(ValidationError):
        parse_tag("List[]")


def test_parse_rejects_unmatched_brackets() -> None:
    with pytest.raises(ValidationError):
        parse_tag("List[Agent")


def test_normalize_alias_simple() -> None:
    norm = normalize_alias(parse_tag("AgentList"))
    assert norm == TagRef("List", (TagRef("Agent"),))


def test_normalize_alias_inside_container() -> None:
    norm = normalize_alias(parse_tag("Dict[Str, EventList]"))
    assert norm == TagRef(
        "Dict",
        (TagRef("Str"), TagRef("List", (TagRef("Event"),))),
    )


def test_can_connect_any_passes_both_directions() -> None:
    assert can_connect(parse_tag("Agent"), parse_tag("Any"))
    assert can_connect(parse_tag("Any"), parse_tag("Agent"))


def test_can_connect_alias_equivalence() -> None:
    assert can_connect(parse_tag("AgentList"), parse_tag("List[Agent]"))


def test_can_connect_optional_dst() -> None:
    assert can_connect(parse_tag("Event"), parse_tag("Optional[Event]"))
    assert not can_connect(parse_tag("Agent"), parse_tag("Optional[Event]"))


def test_can_connect_union_dst() -> None:
    assert can_connect(parse_tag("Str"), parse_tag("Union[Str, Int]"))
    assert not can_connect(parse_tag("Agent"), parse_tag("Union[Str, Int]"))


def test_can_connect_no_subtype_relax() -> None:
    """Json 不能接 Event。"""
    assert not can_connect(parse_tag("Json"), parse_tag("Event"))


def test_can_connect_inner_any_passes() -> None:
    """RFC 字面之外的实用让步：容器内层 Any 也通配。
    `List[Agent] → List[Any]` 与反向都允许；这是为了让通用 data 节点（List[Any]
    输入）能直接接受域类型 List；否则每个 data 节点要为每个域类型重载。
    """
    assert can_connect(parse_tag("List[Agent]"), parse_tag("List[Any]"))
    assert can_connect(parse_tag("List[Any]"), parse_tag("List[Agent]"))
    assert can_connect(parse_tag("Dict[Str, Json]"), parse_tag("Dict[Str, Any]"))


def test_can_connect_distinct_atoms_rejected() -> None:
    assert not can_connect(parse_tag("Agent"), parse_tag("Faction"))


def test_port_spec_tag_roundtrip() -> None:
    p = PortSpec(name="agents", type="AgentList", required=True)
    assert p.tag() == TagRef("AgentList")
    assert normalize_alias(p.tag()) == TagRef("List", (TagRef("Agent"),))
