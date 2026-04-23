"""极简表达式求值器 — RFC §7.3 BNF 子集。

核心策略：
1. 节点参数中允许写 `${path}` `${subgraph:NAME}` `${preset:T/N}` 三种 placeholder；
   其它字符串原样保留（GraphLoader 在 cook 前调 `prepare_value` 把含 `${...}` 的节点
   挑出来调用本模块）。
2. `${...}` 内部用 Python `ast` parse，遍历后白名单。
3. 严禁 lambda / 推导式 / `__attr__` / import / Starred / JoinedStr / 自定义函数名。
4. 引用根：`ctx` `nodes` `item` `params` `inputs` 五个；其余 NameError。

设计权衡：实现 `evaluate(ast, scope)` 不接用户字符串，是为了避免运行时构造 expr 再 eval
（RFC 硬约束）。所有 expr 字符串必须由 GraphLoader 静态调 `parse` 一次得到 ExprAST，
然后传给 evaluate。
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any

from tools.chronicle_sim_v3.engine.errors import ExprEvalError, ExprSyntaxError

# 允许的 AST 节点类型
_ALLOWED_NODES: tuple[type, ...] = (
    ast.Expression,
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.Attribute,
    ast.Subscript,
    ast.Index,  # py<3.9 兼容；3.12 已弃用但仍出现
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.Call,
    # 二元运算子
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.FloorDiv, ast.Pow,
    # 比较运算子
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn,
    # 逻辑
    ast.And, ast.Or, ast.Not,
    # 一元
    ast.USub, ast.UAdd,
    # 字面量容器（允许 list/dict/tuple 但 GraphLoader 通常不需要）
    ast.List, ast.Tuple,
)

# 显式禁止
_FORBIDDEN_NODES: tuple[type, ...] = (
    ast.Lambda,
    ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
    ast.Starred, ast.Await, ast.Yield, ast.YieldFrom,
    ast.JoinedStr, ast.FormattedValue,
    ast.IfExp,  # 禁三元，避免分支求值复杂化
    ast.NamedExpr,  # walrus
    ast.Slice,
    ast.Import, ast.ImportFrom,
    ast.Assign, ast.AugAssign, ast.AnnAssign,
    ast.Dict, ast.Set,
)

_WHITELIST_FUNCS: dict[str, Any] = {
    "len": len,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "min": min,
    "max": max,
    "sum": sum,
    "abs": abs,
}

_ROOT_NAMES: frozenset[str] = frozenset({"ctx", "nodes", "item", "params", "inputs"})


@dataclass(frozen=True)
class ExprAST:
    """已校验的表达式 AST 包装。kind 标识根类型。"""

    kind: str  # 'placeholder' | 'subgraph_ref' | 'preset_ref' | 'plain'
    raw: str
    tree: ast.Expression | None = None  # placeholder 才有
    payload: str = ""  # subgraph/preset 的 'NAME' / 'TOPIC/NAME'


@dataclass(frozen=True)
class SubgraphRef:
    name: str


@dataclass(frozen=True)
class PresetRef:
    topic: str
    name: str


_PLACEHOLDER_RE = re.compile(r"\$\{([^}]+)\}")


def _check_node(node: ast.AST) -> None:
    if isinstance(node, _FORBIDDEN_NODES):
        raise ExprSyntaxError(
            f"表达式禁止节点 {type(node).__name__}（RFC §7.3 白名单外）"
        )
    if not isinstance(node, _ALLOWED_NODES):
        raise ExprSyntaxError(
            f"表达式不在白名单：{type(node).__name__}"
        )
    # 双下划线属性访问全部禁
    if isinstance(node, ast.Attribute):
        if node.attr.startswith("__"):
            raise ExprSyntaxError(f"禁止访问双下划线属性 {node.attr!r}")
    # Call 必须命中白名单函数名
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ExprSyntaxError("函数调用必须是简单名（白名单），不允许属性调用 / 闭包")
        if node.func.id not in _WHITELIST_FUNCS:
            raise ExprSyntaxError(f"非白名单函数：{node.func.id!r}")
        if node.keywords:
            raise ExprSyntaxError("白名单函数不允许关键字参数")
    # Subscript 仅允许常量 key（避免动态 key 引出花活）
    if isinstance(node, ast.Subscript):
        slc = node.slice
        if isinstance(slc, ast.Constant) and isinstance(slc.value, (str, int)):
            pass
        elif isinstance(slc, ast.Index):  # py<3.9 兼容
            v = slc.value  # type: ignore[attr-defined]
            if not (isinstance(v, ast.Constant) and isinstance(v.value, (str, int))):
                raise ExprSyntaxError("Subscript key 仅允许常量 str/int")
        else:
            raise ExprSyntaxError("Subscript key 仅允许常量 str/int")


def _walk_check(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        _check_node(node)


def parse(expr_str: str) -> ExprAST:
    """把节点参数字符串解析为 ExprAST。

    三种形态：
    - '${ctx.week}' / '${nodes.x.out}' / '${len(item.list)}' → placeholder（python ast 可解析）
    - '${subgraph:foo}' → subgraph_ref
    - '${preset:rumor_sim/aggressive}' → preset_ref
    - 不含 '${...}' 的字符串 → plain（原样字符串）
    """
    if not isinstance(expr_str, str):
        raise ExprSyntaxError(f"parse 需要 str，收到 {type(expr_str).__name__}")

    text = expr_str.strip()
    m = _PLACEHOLDER_RE.fullmatch(text)
    if not m:
        # 普通字符串：必须不含 '${'，否则视为半途占位（错误）
        if "${" in text:
            raise ExprSyntaxError(
                f"placeholder 必须是整段 '${{...}}'；混合字符串未支持: {expr_str!r}"
            )
        return ExprAST(kind="plain", raw=expr_str)

    inner = m.group(1).strip()
    if inner.startswith("subgraph:"):
        name = inner[len("subgraph:") :].strip()
        if not name or "/" in name:
            raise ExprSyntaxError(f"subgraph 引用名非法: {inner!r}")
        return ExprAST(kind="subgraph_ref", raw=expr_str, payload=name)
    if inner.startswith("preset:"):
        body = inner[len("preset:") :].strip()
        if "/" not in body:
            raise ExprSyntaxError(f"preset 引用应为 TOPIC/NAME，得到 {body!r}")
        topic, _, name = body.partition("/")
        if not topic or not name:
            raise ExprSyntaxError(f"preset 引用 topic/name 不完整: {body!r}")
        return ExprAST(kind="preset_ref", raw=expr_str, payload=f"{topic}/{name}")

    try:
        tree = ast.parse(inner, mode="eval")
    except SyntaxError as e:
        raise ExprSyntaxError(f"表达式语法错误: {inner!r}: {e}") from e
    _walk_check(tree)
    return ExprAST(kind="placeholder", raw=expr_str, tree=tree)


def evaluate(expr: ExprAST, scope: dict[str, Any]) -> Any:
    """根据已 parse 过的 ExprAST 求值。

    placeholder：用 scope（必须是 _ROOT_NAMES 的子集）求值
    subgraph_ref / preset_ref：返回占位 dataclass，由 GraphLoader 实例化
    plain：返回 raw 字符串
    """
    if expr.kind == "plain":
        return expr.raw
    if expr.kind == "subgraph_ref":
        return SubgraphRef(name=expr.payload)
    if expr.kind == "preset_ref":
        topic, _, name = expr.payload.partition("/")
        return PresetRef(topic=topic, name=name)
    if expr.kind != "placeholder" or expr.tree is None:
        raise ExprEvalError(f"未知 ExprAST kind={expr.kind}")
    return _eval_node(expr.tree, scope)


def _eval_node(node: ast.AST, scope: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, scope)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _WHITELIST_FUNCS:
            return _WHITELIST_FUNCS[node.id]
        if node.id in _ROOT_NAMES:
            if node.id not in scope:
                raise ExprEvalError(f"scope 缺少根 {node.id!r}")
            return scope[node.id]
        raise ExprEvalError(f"未知名称 {node.id!r}（仅允许 {sorted(_ROOT_NAMES)} + 白名单函数）")
    if isinstance(node, ast.Attribute):
        target = _eval_node(node.value, scope)
        return _attr_get(target, node.attr)
    if isinstance(node, ast.Subscript):
        target = _eval_node(node.value, scope)
        slc = node.slice
        if isinstance(slc, ast.Constant):
            key: Any = slc.value
        elif isinstance(slc, ast.Index):  # py<3.9
            key = slc.value.value  # type: ignore[attr-defined]
        else:
            raise ExprEvalError("Subscript key 必须常量")
        return _item_get(target, key)
    if isinstance(node, ast.UnaryOp):
        v = _eval_node(node.operand, scope)
        if isinstance(node.op, ast.USub):
            return -v
        if isinstance(node.op, ast.UAdd):
            return +v
        if isinstance(node.op, ast.Not):
            return not v
        raise ExprEvalError(f"未支持一元 {type(node.op).__name__}")
    if isinstance(node, ast.BinOp):
        left = _eval_node(node.left, scope)
        right = _eval_node(node.right, scope)
        op = node.op
        if isinstance(op, ast.Add): return left + right
        if isinstance(op, ast.Sub): return left - right
        if isinstance(op, ast.Mult): return left * right
        if isinstance(op, ast.Div): return left / right
        if isinstance(op, ast.FloorDiv): return left // right
        if isinstance(op, ast.Mod): return left % right
        if isinstance(op, ast.Pow): return left ** right
        raise ExprEvalError(f"未支持二元 {type(op).__name__}")
    if isinstance(node, ast.BoolOp):
        vals = [_eval_node(v, scope) for v in node.values]
        if isinstance(node.op, ast.And):
            r = True
            for v in vals: r = r and v
            return r
        if isinstance(node.op, ast.Or):
            r = False
            for v in vals: r = r or v
            return r
        raise ExprEvalError(f"未支持 BoolOp {type(node.op).__name__}")
    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, scope)
        for op, comp in zip(node.ops, node.comparators):
            right = _eval_node(comp, scope)
            if not _cmp(left, op, right):
                return False
            left = right
        return True
    if isinstance(node, ast.Call):
        # _check_node 已校验 func 是 Name 且在白名单
        func = _WHITELIST_FUNCS[node.func.id]  # type: ignore[union-attr]
        args = [_eval_node(a, scope) for a in node.args]
        return func(*args)
    if isinstance(node, ast.List):
        return [_eval_node(e, scope) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_node(e, scope) for e in node.elts)
    raise ExprEvalError(f"求值不支持节点 {type(node).__name__}")


def _cmp(left: Any, op: ast.cmpop, right: Any) -> bool:
    if isinstance(op, ast.Eq): return left == right
    if isinstance(op, ast.NotEq): return left != right
    if isinstance(op, ast.Lt): return left < right
    if isinstance(op, ast.LtE): return left <= right
    if isinstance(op, ast.Gt): return left > right
    if isinstance(op, ast.GtE): return left >= right
    if isinstance(op, ast.In): return left in right
    if isinstance(op, ast.NotIn): return left not in right
    raise ExprEvalError(f"未支持比较 {type(op).__name__}")


def _attr_get(target: Any, name: str) -> Any:
    """属性读取：dict 走 key，object 走 getattr。

    禁止双下划线属性已在 _check_node 阶段拒绝。
    """
    if isinstance(target, dict):
        if name not in target:
            raise ExprEvalError(f"dict 缺少 key {name!r}")
        return target[name]
    if hasattr(target, name):
        return getattr(target, name)
    raise ExprEvalError(f"对象 {type(target).__name__} 无属性 {name!r}")


def _item_get(target: Any, key: Any) -> Any:
    try:
        return target[key]
    except (KeyError, IndexError, TypeError) as e:
        raise ExprEvalError(f"索引失败 [{key!r}]: {e}") from e
