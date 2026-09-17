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
    # 挂件预设风吹灭块的越线动作（blowout.onEmberActions / onOutActions）
    "onEmberActions": "掉到残炭时",
    "onOutActions": "被风吹灭时",
}

# 其余要译的结构键（不是容器、不是动作面、也不是条件面）。
STRUCT_KEYS: dict[str, str] = {
    "blowout": "风吹灭",
}

# 纯结构噪声，读出来只会碍事。
SKIP_KEYS = frozenset({"params", "graph", "mainGraph", "meta"})


def plain_label(key: str) -> str | None:
    """这个键本身就该译成一个词（条件/分支/不满足…），下一层不是它的正主。"""
    return CONDITION_KEYS.get(key) or STRUCT_KEYS.get(key)


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
    if isinstance(cond.get("heldProp"), str):
        return _held_prop_phrase(cond)
    if isinstance(cond.get("propLevel"), str):
        return _prop_level_phrase(cond)
    if isinstance(cond.get("burn"), str):
        return _burn_phrase(cond)
    keys = list(cond.keys())
    return "、".join(f"{k}={cond[k]}" for k in keys[:2])


_HELD_PROP_LOCK_PHRASE = {"lit": "锁定不灭", "unlit": "点不燃", "none": "没上锁"}
_BURN_STATE_PHRASE = {"unburnt": "没点", "burning": "在烧", "out": "灭了", "burnt": "烧完了"}


def _burn_phrase(cond: dict) -> str:
    """可燃物叶 → 「可燃物「hs_paper」在烧」/「义庄的可燃物「hs_candle」烧完了」/「玩家「left_hand」上的可燃挂件在烧」。

    写了 `burnSocket` = 问这个人这个挂点上拿着的可燃挂件（`burnScene` 不读）；没写 = 场景里的可燃实体（热点 / NPC / 演出生成的对象）。
    """
    eid = str(cond.get("burn") or "").strip() or "?"
    state = str(cond.get("burnState") or "").strip()
    socket = cond.get("burnSocket")
    if isinstance(socket, str) and socket.strip():
        who = "玩家" if eid == "player" else f"「{eid}」"
        where = f"{who}「{socket.strip()}」上的可燃挂件"
    else:
        scene = cond.get("burnScene")
        where = f"{scene.strip()}的可燃物「{eid}」" if isinstance(scene, str) and scene.strip() else f"可燃物「{eid}」"
    return where + _BURN_STATE_PHRASE.get(state, f"燃烧状态是 {state or '?'}")


def _prop_level_phrase(cond: dict) -> str:
    """挂件等级叶 → 「「xianteng_torch」升到第 2 级或更高」。`op` 不写 = `>=`。"""
    pid = str(cond.get("propLevel") or "").strip() or "?"
    op = cond.get("op")
    op_text = op.strip() if isinstance(op, str) and op.strip() else ">="
    v = cond.get("value")
    if op_text == ">=":
        return f"「{pid}」升到第 {v} 级或更高"
    if op_text == "==":
        return f"「{pid}」正是第 {v} 级"
    return f"「{pid}」的等级 {op_text} {v}"


def _held_prop_phrase(cond: dict) -> str:
    """手持挂件叶 → 「玩家手上的「xianteng_torch」燃着、火势<0.3」。没写的项不限，不出现。"""
    who = str(cond.get("heldProp") or "").strip()
    who_text = "玩家" if who == "player" else f"「{who or '?'}」"
    socket = cond.get("socket")
    where = f"{who_text}「{socket.strip()}」上" if isinstance(socket, str) and socket.strip() else f"{who_text}手上"
    prop = cond.get("prop")
    prop_id = prop.strip() if isinstance(prop, str) else ""
    bits: list[str] = []
    state = cond.get("propState")
    if isinstance(state, str) and state.strip():
        bits.append(f"处在「{state.strip()}」")
    if isinstance(cond.get("burning"), bool):
        bits.append("燃着" if cond["burning"] else "没燃")
    op = cond.get("vitalityOp")
    if isinstance(op, str) and op.strip():
        bits.append(f"火势{op.strip()}{cond.get('vitality')}")
    fop = cond.get("fuelOp")
    if isinstance(fop, str) and fop.strip():
        bits.append(f"燃料{fop.strip()}{cond.get('fuel')}")
    effect = cond.get("effect")
    if isinstance(effect, str) and effect.strip():
        bits.append(f"带「{effect.strip()}」")
    lock = cond.get("lock")
    if isinstance(lock, str) and lock.strip():
        bits.append(_HELD_PROP_LOCK_PHRASE.get(lock.strip(), f"锁是 {lock.strip()}"))
    if not bits:
        return f"{where}拿着「{prop_id}」" if prop_id else f"{where}拿着东西"
    thing = f"的「{prop_id}」" if prop_id else "拿的东西"
    return f"{where}{thing}" + "、".join(bits)


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
