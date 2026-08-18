"""人话渲染：位置路径、条件表达式。编辑器与调试器共用同一套叫法。

界面文案不许直接甩 JSON 字段名（editor-tools 规范 · 图对话卡第 18 条）：结构键一律
译成中文，**id 保持原样**（id 是数据本体，不是字段名），未登记的结构键退回原文
——退回也比编一个假名字强。
"""

from __future__ import annotations

from typing import Any, Callable, Iterable

# 「容器键」：它下一段是 id 或下标，读作「节点 c_jie」这样。
CONTAINER_KEYS: dict[str, str] = {
    "nodes": "节点",
    "zones": "区域",
    "hotspots": "热点",
    "npcs": "NPC",
    "states": "状态",
    "transitions": "转移",
    "elements": "元素",
    "compositions": "编排",
    "steps": "步骤",
    "options": "选项",
    "choices": "选项",
    "interrupts": "打断",
    "entries": "条目",
    "slots": "槽位",
    "phases": "阶段",
    "objectives": "目标",
    "stages": "阶段",
    "items": "条目",
    "characters": "人物",
    "books": "书",
    "documents": "文书",
    "quests": "任务",
    "encounters": "遭遇",
    "cutscenes": "过场",
    "packages": "章节包",
    "entities": "实体",
    "clues": "线索",
}

# 「条件面」的结构键。它们不是容器也不是动作面，但**必须译**：读状态那一栏的位置串
# 里满屏 conditions / cases / not / any（2026-08-07 审查实测），等于把 JSON 字段名甩给
# 策划，违反 editor-tools 图对话卡第 18 条。
CONDITION_KEYS: dict[str, str] = {
    "conditions": "条件",
    "unlockConditions": "解锁条件",
    "completionConditions": "完成条件",
    "requires": "前置条件",
    "when": "生效条件",
    "done": "完成条件",
    "cases": "分支",
    "all": "同时满足",
    "any": "任一满足",
    "not": "不满足",
    "preconditions": "前置",
    "revealCondition": "揭示条件",
    "impressions": "印象",
    "knownInfo": "已知情报",
    "entityGroups": "实体组",
}

# 「动作面键」：它下一段是下标，读作「进入时 第 1 个动作」。
ACTION_LIST_KEYS: dict[str, str] = {
    "actions": "动作",
    "onEnter": "进入时",
    "onExit": "离开时",
    "onStay": "停留时",
    "onInteract": "交互时",
    "onExamine": "查看时",
    "onComplete": "完成时",
    "onAborted": "中断时",
    "onFail": "失败时",
    "onSuccess": "成功时",
    "onStart": "开始时",
    "onEnterActions": "进入时动作",
    "onExitActions": "离开时动作",
    "aboveActions": "水上分支",
    "belowActions": "水下分支",
    "firstViewActions": "首次查看",
    "onFirstView": "首次查看",
    "collectActions": "首次采集",
    "effects": "效果",
    "rewards": "奖励",
    "onGive": "交付时",
    "onAccept": "接下时",
    "onRefuse": "拒绝时",
    "onPullSuccess": "拉起成功时",
    "onPullFail": "拉起失败时",
}

# 纯结构噪声，读出来只会碍事。
SKIP_KEYS = frozenset({"params", "graph", "mainGraph", "meta"})


def plain_label(key: str) -> str | None:
    """这个键本身就该译成一个词（条件/分支/不满足…），下一层不是它的正主。"""
    return CONDITION_KEYS.get(key)


def pending_label(key: str) -> str | None:
    """这个键是不是「下一层才是正主」的容器/动作面？是就返回它的中文名。

    `nodes` → 节点（下一层是节点 id）；`onEnter` → 进入时（下一层是第几个动作）。
    """
    if key in CONTAINER_KEYS:
        return CONTAINER_KEYS[key]
    if key in ACTION_LIST_KEYS:
        return ACTION_LIST_KEYS[key]
    return None


def join_trail(trail: list[str]) -> str:
    return " · ".join(p for p in trail if p)


def describe_condition(cond: Any, state_phrase: Callable[[str, str, str], str] | None = None) -> str:
    """条件表达式 → 人话。``state_phrase(图, 态, 动词)`` 由调用方提供（能拿到中文名更好听）。

    调试器 `NarrativeIndex.describe_condition` 与编辑器面板共用本实现——两处各写一遍，
    同一条件在两个工具里读起来不一样，策划就得学两套话。
    """
    if not isinstance(cond, dict):
        return ""
    phrase = state_phrase or (lambda g, s, v: f"「{g}」{v}「{s}」")
    if "all" in cond:
        inner = [p for p in (describe_condition(c, state_phrase) for c in cond.get("all") or []) if p]
        return "（" + " 且 ".join(inner) + "）" if len(inner) > 1 else "".join(inner)
    if "any" in cond:
        inner = [p for p in (describe_condition(c, state_phrase) for c in cond.get("any") or []) if p]
        if len(inner) > 3:
            return f"（{inner[0]} 等 {len(inner)} 种组合里的任意一种）"
        return "（" + " 或 ".join(inner) + "）" if len(inner) > 1 else "".join(inner)
    if "not" in cond:
        inner = describe_condition(cond.get("not"), state_phrase)
        return f"不满足{inner}" if inner else ""
    if "narrative" in cond:
        verb = "到过" if cond.get("reached") is True else "正停在"
        return phrase(str(cond.get("narrative") or ""), str(cond.get("state") or ""), verb)
    if "flag" in cond:
        return f"标记「{cond.get('flag')}」成立"
    if "quest" in cond:
        return f"任务「{cond.get('quest')}」是 {cond.get('status', '')}"
    if "item" in cond:
        return f"身上有「{cond.get('item')}」"
    if "plane" in cond:
        return f"位面「{cond.get('plane')}」开着"
    if "narrativeCount" in cond:
        return f"活计「{cond.get('narrativeCount')}」的次数达标"
    keys = list(cond.keys())
    return "、".join(f"{k}={cond[k]}" for k in keys[:2])


def describe_conditions(
    conditions: Iterable[Any],
    state_phrase: Callable[[str, str, str], str] | None = None,
) -> str:
    parts = [describe_condition(c, state_phrase) for c in conditions or []]
    return " 且 ".join(p for p in parts if p)


def condition_parts(
    conditions: Iterable[Any],
    state_phrase: Callable[[str, str, str], str] | None = None,
) -> list[str]:
    return [describe_condition(c, state_phrase) for c in conditions or []]
