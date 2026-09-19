"""Action 的结构面（哪些动作带子动作列表）与一行摘要。纯数据，不碰 Qt。

**容器动作登记表是唯一真相源**：大纲编辑器建树、ActionRow 的大纲模式取子列表、
动作登记表页展开嵌套，都读 `NESTED_ACTION_SLOTS`，不各写一份 if/elif。
口径对齐运行时 `src/core/ActionRegistry.ts` 里所有 `actionListFromParam(...)` 的调用点
（runActions / chooseAction / randomBranch / runActionsIf）与 addDelayedEvent、
enableRuleOffers（槽位 resultActions 由 ZoneSystem/规矩面执行）。护栏见
`tools/editor/tests/test_action_outline_editor.py::test_slot_registry_matches_runtime_containers`。

摘要是给**大纲树的一行**用的：必须一眼读得出这一条干了什么，但绝不代替表单——
值原样显示（id 是数据本体，不译），结构词译成中文（且/或/非/满足时…）。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator


@dataclass(frozen=True)
class ActionListSlot:
    """容器动作的一条子动作列表。

    kind="list"  : ``params[key]`` 直接就是动作列表（runActions.actions …）。
    kind="items" : ``params[key]`` 是条目列表，每个条目的 ``item_actions_key`` 才是动作列表
                   （chooseAction.options[].actions / enableRuleOffers.slots[].resultActions）。
    """

    key: str
    label: str
    kind: str = "list"
    item_label: str = ""
    item_actions_key: str = ""
    hint: str = ""


NESTED_ACTION_SLOTS: dict[str, tuple[ActionListSlot, ...]] = {
    "runActions": (
        ActionListSlot("actions", "依次执行", hint="按顺序逐条执行（等待型动作会等它结束再往下）。"),
    ),
    "runActionsDetached": (
        ActionListSlot(
            "actions", "脱手执行",
            hint="发车即返回：这一批在背景里按顺序跑，玩家全程照常活动，批外后续动作不等它。",
        ),
    ),
    "addDelayedEvent": (
        ActionListSlot("actions", "到期执行", hint="到 targetDay 那天时执行这些动作。"),
    ),
    "runActionsIf": (
        ActionListSlot("actions", "满足时", hint="条件为真时执行。"),
        ActionListSlot("elseActions", "不满足时", hint="条件为假时执行；留空＝什么都不做。"),
    ),
    "randomBranch": (
        ActionListSlot("aboveActions", "分支 A（r > p）", hint="均匀采样 r∈[0,1)；r > probability 时执行。"),
        ActionListSlot("belowActions", "分支 B（r ≤ p）", hint="r ≤ probability 时执行。"),
    ),
    "chooseAction": (
        ActionListSlot(
            "options", "选项", kind="items", item_label="选项", item_actions_key="actions",
            hint="玩家看到的选项；选中后顺序执行该选项里的动作。",
        ),
    ),
    "enableRuleOffers": (
        ActionListSlot(
            "slots", "规矩槽", kind="items", item_label="规矩槽", item_actions_key="resultActions",
            hint="须在 Zone 的 onEnter/onExit 中配合 disableRuleOffers 使用。",
        ),
    ),
}


def action_slots(action_type: str) -> tuple[ActionListSlot, ...]:
    return NESTED_ACTION_SLOTS.get(str(action_type or ""), ())


def is_container_action(action_type: str) -> bool:
    return str(action_type or "") in NESTED_ACTION_SLOTS


def _params(action: Any) -> dict:
    if not isinstance(action, dict):
        return {}
    p = action.get("params")
    return p if isinstance(p, dict) else {}


def iter_child_action_lists(action: Any) -> Iterator[tuple[str, list]]:
    """yield (相对路径, 动作列表)：该动作**直接**持有的每一条子动作列表（不递归）。

    路径形如 ``actions`` / ``options[2].actions``，与校验器/登记表页的位置串同形。
    缺键或形状不对的列表跳过（运行时 actionListFromParam 同样当空）。
    """
    params = _params(action)
    for slot in action_slots(action.get("type") if isinstance(action, dict) else ""):
        raw = params.get(slot.key)
        if slot.kind == "list":
            if isinstance(raw, list):
                yield slot.key, raw
            continue
        if not isinstance(raw, list):
            continue
        for i, item in enumerate(raw):
            if isinstance(item, dict) and isinstance(item.get(slot.item_actions_key), list):
                yield f"{slot.key}[{i}].{slot.item_actions_key}", item[slot.item_actions_key]


def flatten_actions(actions: Any, prefix: str = "") -> list[tuple[str, dict]]:
    """展开动作列表（含全部嵌套容器），返回 [(路径, action dict)]，先序。"""
    out: list[tuple[str, dict]] = []
    for i, act in enumerate(actions if isinstance(actions, list) else []):
        if not isinstance(act, dict):
            continue
        path = f"{prefix}[{i}]"
        out.append((path, act))
        for rel, child in iter_child_action_lists(act):
            out.extend(flatten_actions(child, f"{path}.{rel}"))
    return out


def count_actions_deep(actions: Any) -> int:
    return len(flatten_actions(actions))


# ---------------------------------------------------------------------------
# 摘要
# ---------------------------------------------------------------------------

_MAX_TEXT = 40


def _clip(text: str, n: int = _MAX_TEXT) -> str:
    s = " ".join(str(text).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _value_text(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return f"“{_clip(v, 24)}”"
    try:
        return _clip(json.dumps(v, ensure_ascii=False), 32)
    except (TypeError, ValueError):
        return _clip(str(v), 32)


def _is_composite(expr: Any) -> bool:
    return isinstance(expr, dict) and (
        (isinstance(expr.get("all"), list) and len(expr["all"]) > 1)
        or (isinstance(expr.get("any"), list) and len(expr["any"]) > 1)
    )


def summarize_condition(expr: Any) -> str:
    """ConditionExpr → 精确的一行（运算符/取值都在，all/any 不省略）。

    叶子口径对齐 `src/systems/graphDialogue/evaluateGraphCondition.ts` 与
    `condition_expr_tree.ConditionExprNodeEditor` 的导出形状。
    """
    if not isinstance(expr, dict) or not expr:
        return "（未配置）"
    if isinstance(expr.get("all"), list):
        items = [e for e in expr["all"] if isinstance(e, dict)]
        if not items:
            return "（恒真：空的「全部满足」）"
        parts = [f"({summarize_condition(e)})" if _is_composite(e) else summarize_condition(e) for e in items]
        return " 且 ".join(parts)
    if isinstance(expr.get("any"), list):
        items = [e for e in expr["any"] if isinstance(e, dict)]
        if not items:
            return "（恒假：空的「任一满足」）"
        parts = [f"({summarize_condition(e)})" if _is_composite(e) else summarize_condition(e) for e in items]
        return " 或 ".join(parts)
    if "not" in expr:
        inner = expr.get("not")
        if not isinstance(inner, dict) or not inner or inner == {"all": []}:
            return "（恒假：not 未配置内层）"
        body = summarize_condition(inner)
        return f"非({body})" if _is_composite(inner) else f"非 {body}"
    if "flag" in expr:
        key = str(expr.get("flag") or "")
        op = str(expr.get("op") or "==")
        if "value" not in expr and op == "==":
            return key
        v = expr.get("value", True)
        if op == "==" and v is True:
            return key
        return f"{key} {op} {_value_text(v)}"
    if "quest" in expr:
        st = expr.get("questStatus", expr.get("status", "Completed"))
        return f"任务 {expr.get('quest')} 为 {st}"
    if "scenarioLine" in expr:
        return f"线 {expr.get('scenarioLine')} 为 {expr.get('lineStatus', 'inactive')}"
    if "scenario" in expr:
        ph = str(expr.get("phase") or "")
        s = f"scenario {expr.get('scenario')}"
        if ph:
            s += f"·{ph}"
        s += f" 为 {expr.get('status', 'done')}"
        if "outcome" in expr:
            s += f"（outcome={_value_text(expr.get('outcome'))}）"
        return s
    if "narrativeCount" in expr:
        ex = str(expr.get("exitState") or "")
        where = f"{expr.get('narrativeCount')}" + (f"→{ex}" if ex else "")
        return f"活计 {where} 次数 {expr.get('op', '>=')} {expr.get('value', 1)}"
    if "narrative" in expr:
        verb = "到过" if expr.get("reached") is True else "正在"
        return f"叙事 {expr.get('narrative')} {verb} {expr.get('state')}"
    if "plane" in expr:
        return f"位面 = {expr.get('plane')}"
    if "posture" in expr:
        return f"姿态 = {expr.get('posture')}"
    if "timePhase" in expr:
        return f"时段 = {expr.get('timePhase')}"
    if isinstance(expr.get("heldProp"), str):
        # 手持挂件叶：与图对话摘要同一份叫法（纯函数模块，无 Qt 依赖）
        from tools.dialogue_graph_editor.dialogue_condition_text import held_prop_leaf_text

        return held_prop_leaf_text(expr)
    if isinstance(expr.get("propLevel"), str):
        # 挂件等级叶：与图对话摘要同一份叫法（纯函数模块，无 Qt 依赖）
        from tools.dialogue_graph_editor.dialogue_condition_text import prop_level_leaf_text

        return prop_level_leaf_text(expr)
    if isinstance(expr.get("burn"), str) and isinstance(expr.get("burnState"), str):
        # 可燃物叶：与图对话摘要同一份叫法（纯函数模块，无 Qt 依赖）
        from tools.dialogue_graph_editor.dialogue_condition_text import burn_leaf_text

        return burn_leaf_text(expr)
    return _clip(json.dumps(expr, ensure_ascii=False), 60)


def _schema_order(action_type: str) -> list[str]:
    try:
        from .action_editor import _PARAM_SCHEMAS  # 延迟导入：本模块保持无 Qt 依赖可单测
    except Exception:  # pragma: no cover - 无 Qt 环境
        return []
    return [name for name, _kind in _PARAM_SCHEMAS.get(action_type, [])]


def _generic_param_parts(action_type: str, params: dict, skip: set[str]) -> list[str]:
    order = _schema_order(action_type)
    keys = [k for k in order if k in params] + [k for k in params if k not in order]
    parts: list[str] = []
    for k in keys:
        if k in skip:
            continue
        v = params[k]
        if v is None or v == "" or v == [] or v == {}:
            continue
        if isinstance(v, list):
            parts.append(f"{k}[{len(v)}]")
            continue
        parts.append(f"{k}={_value_text(v) if not isinstance(v, str) else _clip(v, 28)}")
    return parts


def _count_label(n: int) -> str:
    return f"{n} 条" if n else "空"


def summarize_action(action: Any) -> str:
    """一条 action → 一行摘要（不含类型名本身；大纲树第二列用）。"""
    if not isinstance(action, dict):
        return "（不是对象：运行时会跳过）"
    at = str(action.get("type") or "")
    p = _params(action)
    if at == "runActionsIf":
        cond = p.get("condition")
        head = f"若 {summarize_condition(cond)}" if isinstance(cond, dict) and cond else "无条件（恒真）"
        return head
    if at == "randomBranch":
        prob = p.get("probability", 0.5)
        return f"p = {prob}"
    if at == "runActions":
        n = len(p.get("actions")) if isinstance(p.get("actions"), list) else 0
        return _count_label(n)
    if at == "addDelayedEvent":
        n = len(p.get("actions")) if isinstance(p.get("actions"), list) else 0
        return f"targetDay={p.get('targetDay', '?')} · {_count_label(n)}"
    if at == "chooseAction":
        opts = p.get("options") if isinstance(p.get("options"), list) else []
        prompt = str(p.get("prompt") or "").strip()
        head = f"“{_clip(prompt, 24)}” · " if prompt else ""
        return f"{head}{len(opts)} 个选项" + (" · 可取消" if p.get("allowCancel") is True else "")
    if at == "enableRuleOffers":
        slots = p.get("slots") if isinstance(p.get("slots"), list) else []
        ids = [str(s.get("ruleId") or "?") for s in slots if isinstance(s, dict)]
        return f"{len(slots)} 个槽" + (f"：{_clip(', '.join(ids), 32)}" if ids else "")
    if at == "setFlag":
        return f"{p.get('key', '')} = {_value_text(p.get('value'))}"
    if at == "addFlagValue":
        d = p.get("delta", 0)
        try:
            neg = float(d) < 0
        except (TypeError, ValueError):
            neg = False
        return f"{p.get('key', '')} {'-=' if neg else '+='} {_value_text(abs(d) if neg else d)}"
    if at == "appendFlag":
        return f"{p.get('key', '')} 追加 {_value_text(p.get('text', ''))}"
    if at == "playScriptedDialogue":
        lines = p.get("lines") if isinstance(p.get("lines"), list) else []
        first = next((ln for ln in lines if isinstance(ln, dict)), None)
        if first is None:
            return _count_label(0)
        spk = str(first.get("speaker") or "").strip()
        txt = _clip(str(first.get("text") or ""), 30)
        more = f"  …共 {len(lines)} 句" if len(lines) > 1 else ""
        return f"{spk + '：' if spk else ''}{txt}{more}"
    skip = {s.key for s in action_slots(at)}
    parts = _generic_param_parts(at, p, skip)
    return "  ".join(parts) if parts else ""


def action_row_label(index: int, action: Any) -> str:
    """大纲一行的第一列（「1. runActionsIf」）。原生大纲窗与网页预览共用，一处定叫法。"""
    if not isinstance(action, dict):
        return f"{index + 1}. （非法条目）"
    return f"{index + 1}. {str(action.get('type') or '') or '（无类型）'}"


def slot_row_texts(slot: ActionListSlot, owner: Any) -> tuple[str, str]:
    params = _params(owner)
    raw = params.get(slot.key)
    n = len(raw) if isinstance(raw, list) else 0
    return slot.label, (f"{n} 条" if n else "空")


def item_row_label(slot: ActionListSlot, index: int) -> str:
    return f"{slot.item_label} {index + 1}"


def outline_rows(actions: Any) -> list[dict]:
    """把动作列表摊成带层级的只读大纲行（给没有树控件的宿主用，如叙事网页的预览列表）。

    每行 {depth, kind: action|bad|slot|item, label, summary, type?}。层级规则与原生大纲窗一致：
    只有一条子列表的容器，子节点直接挂在动作下；多分支容器多一层分支行。
    """
    rows: list[dict] = []

    def walk_list(lst: Any, depth: int) -> None:
        for i, act in enumerate(lst if isinstance(lst, list) else []):
            if not isinstance(act, dict):
                try:
                    raw = json.dumps(act, ensure_ascii=False)
                except (TypeError, ValueError):
                    raw = str(act)
                rows.append({"depth": depth, "kind": "bad", "label": action_row_label(i, act), "summary": _clip(raw, 60)})
                continue
            rows.append({
                "depth": depth, "kind": "action", "type": str(act.get("type") or ""),
                "label": action_row_label(i, act), "summary": summarize_action(act),
            })
            slots = action_slots(act.get("type"))
            direct = len(slots) == 1
            params = _params(act)
            for slot in slots:
                child_depth = depth + 1
                if not direct:
                    label, summary = slot_row_texts(slot, act)
                    rows.append({"depth": depth + 1, "kind": "slot", "label": label, "summary": summary})
                    child_depth = depth + 2
                raw = params.get(slot.key)
                if slot.kind == "list":
                    walk_list(raw, child_depth)
                    continue
                for j, it in enumerate(raw if isinstance(raw, list) else []):
                    rows.append({
                        "depth": child_depth, "kind": "item",
                        "label": item_row_label(slot, j), "summary": summarize_slot_item(slot, it),
                    })
                    if isinstance(it, dict):
                        walk_list(it.get(slot.item_actions_key), child_depth + 1)

    walk_list(actions, 0)
    return rows


def summarize_slot_item(slot: ActionListSlot, item: Any) -> str:
    """chooseAction 选项 / 规矩槽 这类「条目」的一行。"""
    if not isinstance(item, dict):
        return "（不是对象：运行时会跳过）"
    acts = item.get(slot.item_actions_key)
    n = len(acts) if isinstance(acts, list) else 0
    if slot.key == "options":
        text = str(item.get("text") or "").strip()
        head = f"“{_clip(text, 30)}”" if text else "（无文本：运行时不显示此选项）"
        return f"{head} · {_count_label(n)}"
    if slot.key == "slots":
        return f"{item.get('ruleId') or '（未选规矩）'} · {_count_label(n)}"
    return _count_label(n)


# ---------------------------------------------------------------------------
# 脱手演出（runActionsDetached）的两张分类表 —— **读运行时那份，不在这里另抄一份**
#
# 权威源是 `src/core/actionParamManifest.ts` 里的 `PRESENTATION_ONLY_ACTIONS` /
# `DETACHED_FORBIDDEN_ACTIONS`。这边只做解析：抄一份进 Python 就是又一处会漂的表，
# 而这两张表决定的是"打断时哪条动作会被跳过"——漂了就是玩家放了技能什么都没发生。
# ---------------------------------------------------------------------------

_MANIFEST_TS = Path(__file__).resolve().parents[3] / "src" / "core" / "actionParamManifest.ts"


def _parse_ts_string_set(name: str) -> frozenset[str]:
    """从 actionParamManifest.ts 里抠出一个 `new Set([...])` 的字符串成员。"""
    try:
        text = _MANIFEST_TS.read_text("utf-8")
    except OSError:
        return frozenset()
    m = re.search(
        r"export const %s:\s*ReadonlySet<string>\s*=\s*new Set\(\[(.*?)\]\);" % re.escape(name),
        text,
        re.DOTALL,
    )
    if not m:
        return frozenset()
    return frozenset(re.findall(r"'([A-Za-z0-9_]+)'", m.group(1)))


def detached_presentation_only() -> frozenset[str]:
    """快进时整条跳过的纯演出动作（打断脱手演出时用）。"""
    return _parse_ts_string_set("PRESENTATION_ONLY_ACTIONS")


def detached_forbidden() -> frozenset[str]:
    """脱手演出里禁止出现的动作：抢控制权 / 换世界 / 推时间。"""
    return _parse_ts_string_set("DETACHED_FORBIDDEN_ACTIONS")
