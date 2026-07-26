"""规矩层图的命名约定（唯一真相源）。

一条规矩的每一层各是一张叙事小图，id 约定为 ``<ruleId>__<layer>``，
全部收在 composition ``rule_ledger`` 下，由 rules.json 幂等生成。
设计见 artifact/Design/规矩系统迁移-L0L3计划-2026-07-26.md §2.1 / §2.3。

任何需要「这是不是一张规矩层图」判断的地方（条件编辑器候选过滤、重构引擎、
校验器）都从这里取，禁止各处自己拼字符串。
"""

from __future__ import annotations

#: 规矩的三层键，顺序即象/理/术的展示序（三层互相独立、无先后依赖）。
RULE_LAYER_KEYS: tuple[str, ...] = ("xiang", "li", "shu")

#: 规矩层图所在的 composition id。
RULE_LEDGER_COMPOSITION_ID = "rule_ledger"

_LAYER_SEP = "__"


def rule_layer_graph_id(rule_id: str, layer: str) -> str:
    """(规矩 id, 层键) -> 层图 id。"""
    return f"{str(rule_id or '').strip()}{_LAYER_SEP}{str(layer or '').strip()}"


def parse_rule_layer_graph_id(graph_id: str) -> tuple[str, str] | None:
    """层图 id -> (规矩 id, 层键)；不符合约定返回 None。"""
    text = str(graph_id or "").strip()
    for layer in RULE_LAYER_KEYS:
        suffix = f"{_LAYER_SEP}{layer}"
        if text.endswith(suffix) and len(text) > len(suffix):
            return text[: -len(suffix)], layer
    return None


def is_rule_layer_graph_id(graph_id: str) -> bool:
    """是否是一张规矩层图的 id。"""
    return parse_rule_layer_graph_id(graph_id) is not None


def is_rule_ledger_composition(composition: object) -> bool:
    """该 composition 是否是规矩账本（其下全部 wrapper 都是层图）。"""
    return (
        isinstance(composition, dict)
        and str(composition.get("id") or "").strip() == RULE_LEDGER_COMPOSITION_ID
    )
