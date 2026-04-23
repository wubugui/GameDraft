"""表达式求值器：合法/非法用例覆盖。"""
from __future__ import annotations

import pytest

from tools.chronicle_sim_v3.engine.errors import ExprEvalError, ExprSyntaxError
from tools.chronicle_sim_v3.engine.expr import (
    ExprAST,
    PresetRef,
    SubgraphRef,
    evaluate,
    parse,
)


# ---------- 合法用例 ----------

@pytest.mark.parametrize(
    "src,scope,expect",
    [
        ("${ctx.week}", {"ctx": {"week": 3}}, 3),
        ("${nodes.x.out}", {"nodes": {"x": {"out": [1, 2]}}}, [1, 2]),
        ("${item.id}", {"item": {"id": "a01"}}, "a01"),
        ("${params.threshold}", {"params": {"threshold": 0.5}}, 0.5),
        ("${inputs.week}", {"inputs": {"week": 7}}, 7),
        ("${1 + 2 * 3}", {}, 7),
        ("${ctx.week + 1}", {"ctx": {"week": 4}}, 5),
        ("${ctx.week == 1}", {"ctx": {"week": 1}}, True),
        ("${ctx.week > 0 and ctx.week < 10}", {"ctx": {"week": 5}}, True),
        ("${len(item.list)}", {"item": {"list": [1, 2, 3]}}, 3),
        ("${str(ctx.week)}", {"ctx": {"week": 4}}, "4"),
        ("${max(1, 2, 3)}", {}, 3),
        ("${abs(-7)}", {}, 7),
        ("${ctx.tags[0]}", {"ctx": {"tags": ["a", "b"]}}, "a"),
        ("${ctx.dict['k']}", {"ctx": {"dict": {"k": 9}}}, 9),
        ("${not ctx.flag}", {"ctx": {"flag": False}}, True),
        ("${1 <= ctx.week <= 10}", {"ctx": {"week": 5}}, True),
        ("${ctx.role in ['npc', 'pc']}", {"ctx": {"role": "npc"}}, True),
    ],
)
def test_eval_ok(src: str, scope: dict, expect) -> None:
    expr = parse(src)
    assert expr.kind == "placeholder"
    assert evaluate(expr, scope) == expect


def test_plain_string_passthrough() -> None:
    expr = parse("hello world")
    assert expr.kind == "plain"
    assert evaluate(expr, {}) == "hello world"


def test_subgraph_ref() -> None:
    expr = parse("${subgraph:week_end}")
    assert expr.kind == "subgraph_ref"
    val = evaluate(expr, {})
    assert val == SubgraphRef(name="week_end")


def test_preset_ref() -> None:
    expr = parse("${preset:rumor_sim/aggressive}")
    assert expr.kind == "preset_ref"
    val = evaluate(expr, {})
    assert val == PresetRef(topic="rumor_sim", name="aggressive")


# ---------- 非法用例：每条 RFC §7.3 禁止项 ----------

@pytest.mark.parametrize(
    "src",
    [
        "${lambda x: x+1}",
        "${[x for x in ctx.lst]}",
        "${{x for x in ctx.lst}}",
        "${{k: v for k,v in ctx.d.items()}}",
        "${(x for x in ctx.lst)}",
        "${ctx.__class__}",
        "${ctx.__init__}",
        "${ctx[__import__('os')]}",  # __import__ 是 Name，不在 ROOT，会被求值期拒绝；但这里更早的语法层捕获 Subscript 非常量
        "${unknown_func(1)}",
        "${ctx.value if True else 1}",
        "${ctx.tags[ctx.idx]}",
        "${`backtick`}",  # SyntaxError
        "${ctx.x = 1}",
        "${*ctx.tags}",
        "${f'val={ctx.week}'}",
    ],
)
def test_parse_rejects_forbidden(src: str) -> None:
    with pytest.raises(ExprSyntaxError):
        parse(src)


def test_unknown_root_name_rejected() -> None:
    expr = parse("${self.week}")  # self 不在 ROOT
    with pytest.raises(ExprEvalError):
        evaluate(expr, {})


def test_missing_root_in_scope() -> None:
    expr = parse("${ctx.week}")
    with pytest.raises(ExprEvalError):
        evaluate(expr, {})


def test_partial_placeholder_string_rejected() -> None:
    with pytest.raises(ExprSyntaxError):
        parse("week=${ctx.week}")


def test_subgraph_ref_with_slash_rejected() -> None:
    with pytest.raises(ExprSyntaxError):
        parse("${subgraph:foo/bar}")


def test_preset_ref_missing_name_rejected() -> None:
    with pytest.raises(ExprSyntaxError):
        parse("${preset:rumor_sim/}")
    with pytest.raises(ExprSyntaxError):
        parse("${preset:nopart}")


def test_attribute_call_rejected() -> None:
    """白名单只允许简单函数调用 len/str/...；属性调用 ctx.foo() 必拒。"""
    with pytest.raises(ExprSyntaxError):
        parse("${ctx.x.upper()}")


def test_keyword_args_rejected() -> None:
    with pytest.raises(ExprSyntaxError):
        parse("${max(1, key=2)}")


def test_dict_literal_rejected() -> None:
    with pytest.raises(ExprSyntaxError):
        parse("${{'a': 1}}")
