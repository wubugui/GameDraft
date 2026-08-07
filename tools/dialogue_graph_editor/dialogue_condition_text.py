"""条件叶子 → 人话短摘要（纯函数，无 Qt 依赖）。

单一真相源：画布端口标签、节点列表摘要、检查器分支标题三处都读这里，
杜绝「同一条件在三个地方写法不一样」的镜像漂移（norms 不变量 8）。

叶子形状以运行时 `src/systems/graphDialogue/evaluateGraphCondition.ts` 为准；
未识别形状一律降级成紧凑 JSON，绝不臆造语义。
"""
from __future__ import annotations

import json
from typing import Any

__all__ = [
    "ALWAYS",
    "NEVER",
    "NORMAL",
    "case_condition_text",
    "case_effective_expr",
    "case_verdict",
    "condition_expr_text",
    "condition_expr_verdict",
    "shorten",
]

#: 与游戏状态无关，永远命中（后续分支与 defaultNext 成死路）。
ALWAYS = "always"
#: 与游戏状态无关，永远不命中（这条分支本身是死路，多半是写坏了）。
NEVER = "never"
#: 看游戏状态，正常分支。
NORMAL = "normal"

_AND_SEP = " 且 "
_OR_SEP = " 或 "


def shorten(text: str, limit: int = 26) -> str:
    text = " ".join(str(text).split())
    return text[: limit - 1] + "…" if len(text) > limit else text


def _compact(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _value_text(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return str(v)


def condition_expr_text(expr: Any, depth: int = 0) -> str:
    """任意 ConditionExpr（叶子或 all/any/not）→ 一行人话。"""
    if depth > 6:
        return "…"
    if not isinstance(expr, dict) or not expr:
        return ""

    if isinstance(expr.get("all"), list):
        parts = [condition_expr_text(e, depth + 1) for e in expr["all"]]
        parts = [p for p in parts if p]
        if not parts:
            return "（空 all→恒真）"
        body = _AND_SEP.join(parts)
        return f"({body})" if depth and len(parts) > 1 else body
    if isinstance(expr.get("any"), list):
        parts = [condition_expr_text(e, depth + 1) for e in expr["any"]]
        parts = [p for p in parts if p]
        if not parts:
            return "（空 any→恒假）"
        body = _OR_SEP.join(parts)
        return f"({body})" if depth and len(parts) > 1 else body
    if isinstance(expr.get("not"), dict):
        return f"非({condition_expr_text(expr['not'], depth + 1)})"

    if isinstance(expr.get("flag"), str):
        name = expr["flag"].strip() or "?"
        op = str(expr.get("op") or "==")
        if "value" not in expr:
            return f"{name} 为真"
        val = _value_text(expr.get("value"))
        return f"{name}={val}" if op == "==" else f"{name}{op}{val}"
    if isinstance(expr.get("quest"), str):
        qid = expr["quest"].strip() or "?"
        status = str(expr.get("questStatus") or expr.get("status") or "Active")
        return f"任务 {qid}={status}"
    if isinstance(expr.get("scenario"), str):
        sid = expr["scenario"].strip() or "?"
        phase = str(expr.get("phase") or "").strip()
        status = str(expr.get("status") or "").strip()
        head = f"{sid}/{phase}" if phase else sid
        return f"{head}={status}" if status else head
    if isinstance(expr.get("scenarioLine"), str):
        sid = expr["scenarioLine"].strip() or "?"
        status = str(expr.get("status") or "").strip()
        return f"线 {sid}={status}" if status else f"线 {sid}"
    if isinstance(expr.get("narrative"), str):
        gid = expr["narrative"].strip() or "?"
        state = str(expr.get("state") or "").strip() or "?"
        return f"{gid}:{state}" + ("(到过)" if expr.get("reached") is True else "")
    if isinstance(expr.get("narrativeCount"), str):
        arch = expr["narrativeCount"].strip() or "?"
        op = str(expr.get("op") or ">=")
        exit_state = str(expr.get("exitState") or "").strip()
        head = f"做过 {arch}" + (f"[{exit_state}]" if exit_state else "")
        return f"{head}{op}{_value_text(expr.get('value'))}"
    if isinstance(expr.get("plane"), str):
        return f"位面={expr['plane'].strip() or '?'}"
    if "posture" in expr:
        return f"姿态={_value_text(expr.get('posture'))}"

    return _compact(expr)


# 运行时能认出来的叶子形状（镜像 evaluateGraphCondition.ts 的 isXxxLeaf 类型守卫）。
# 认不出来的形状运行时走 `console.warn('unrecognized shape')` 并返回 false —— 也就是
# **恒假**，不是恒真。parity 由 test_switch_node_safety.py 的守卫清单对账测试锁住。
def _is_recognized_leaf(expr: dict[str, Any]) -> bool:
    has = expr.__contains__
    flag_is_str = isinstance(expr.get("flag"), str)
    # isScenarioLineLeaf
    if (
        isinstance(expr.get("scenarioLine"), str)
        and isinstance(expr.get("lineStatus"), str)
        and not flag_is_str
        and not has("quest")
        and expr.get("lineStatus") in ("inactive", "active", "completed")
    ):
        return True
    # isScenarioLeaf（scenarioLine 为字符串时被否决）
    if (
        not isinstance(expr.get("scenarioLine"), str)
        and isinstance(expr.get("scenario"), str)
        and isinstance(expr.get("phase"), str)
        and isinstance(expr.get("status"), str)
    ):
        return True
    # isNarrativeStateLeaf
    if (
        isinstance(expr.get("narrative"), str)
        and isinstance(expr.get("state"), str)
        and not flag_is_str
        and not has("quest")
        and not has("scenario")
    ):
        return True
    # isNarrativeCountLeaf（JS 的 number 含布尔外的整数/小数；bool 在 Python 里要排除）
    if isinstance(expr.get("narrativeCount"), str) and isinstance(
        expr.get("value"), (int, float)
    ) and not isinstance(expr.get("value"), bool):
        return True
    # isPlaneLeaf / isPostureLeaf
    for key in ("plane", "posture"):
        if (
            isinstance(expr.get(key), str)
            and not flag_is_str
            and not has("quest")
            and not has("scenario")
            and not has("narrative")
        ):
            return True
    # isQuestLeaf
    if isinstance(expr.get("quest"), str) and not has("scenario"):
        return True
    # isConditionLeaf
    return flag_is_str


def condition_expr_verdict(expr: Any, depth: int = 0) -> str:
    """这条表达式是否与游戏状态无关：ALWAYS / NEVER / NORMAL。

    严格按运行时 `evaluateConditionExpr` 的求值顺序推：
    `all` 空数组走 `Array.every` → **恒真**；`any` 空数组走 `Array.some` → **恒假**；
    `{}` 和任何认不出的形状落到 `console.warn` 分支 → **恒假**。
    """
    if depth > 8 or not isinstance(expr, dict):
        return NEVER
    if isinstance(expr.get("all"), list):
        items = expr["all"]
        if not items:
            return ALWAYS
        verdicts = [condition_expr_verdict(e, depth + 1) for e in items]
        if NEVER in verdicts:
            return NEVER
        return ALWAYS if all(v == ALWAYS for v in verdicts) else NORMAL
    if isinstance(expr.get("any"), list):
        items = expr["any"]
        if not items:
            return NEVER
        verdicts = [condition_expr_verdict(e, depth + 1) for e in items]
        if ALWAYS in verdicts:
            return ALWAYS
        return NEVER if all(v == NEVER for v in verdicts) else NORMAL
    if isinstance(expr.get("not"), dict):
        inner = condition_expr_verdict(expr["not"], depth + 1)
        return {ALWAYS: NEVER, NEVER: ALWAYS}.get(inner, NORMAL)
    if not expr:
        return NEVER
    return NORMAL if _is_recognized_leaf(expr) else NEVER


def case_effective_expr(case: Any) -> Any:
    """还原 `evalSwitch` 真正拿去求值的那个表达式（含 condition 优先与空列表兜底）。"""
    if not isinstance(case, dict):
        return {}
    cond = case.get("condition")
    if cond is not None:
        return cond
    conds = case.get("conditions")
    if not isinstance(conds, list):
        conds = []
    if len(conds) <= 1:
        return conds[0] if conds else {"all": []}
    return {"all": conds}


def case_verdict(case: Any) -> str:
    """switch 单分支：ALWAYS（恒命中）/ NEVER（永不命中）/ NORMAL。"""
    return condition_expr_verdict(case_effective_expr(case))


def case_condition_text(case: Any) -> str:
    """switch 单分支的条件摘要；无条件分支返回空串（调用方自行标注告警）。"""
    if not isinstance(case, dict):
        return ""
    cond = case.get("condition")
    if isinstance(cond, dict) and cond:
        return condition_expr_text(cond)
    conds = case.get("conditions")
    if isinstance(conds, list):
        parts = [condition_expr_text(c) for c in conds if isinstance(c, dict)]
        parts = [p for p in parts if p]
        if parts:
            return _AND_SEP.join(parts)
    return ""
