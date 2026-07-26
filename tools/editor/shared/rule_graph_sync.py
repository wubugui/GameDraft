"""规矩层图生成器：rules.json → narrative_graphs.json 的 ``rule_ledger`` composition。

**为什么要生成而不是手画**：手工在网页叙事编辑器里画一条规矩的三张层图，实测要
「建 wrapper ×3 → 改 ownerType → 填 ownerId → 改显示名 → 建状态 ×N → 逐个改名 →
拖连线 ×N → 每条连线开信号弹窗」约 100~130 次交互。20 条规矩就是 2000+ 次。
不做生成器，这套方案不是「体验差一点」，是不可行。策划只维护 rules.json，层图机器产出。

**模型**（详见 artifact/Design/规矩系统迁移-L0L3计划-2026-07-26.md §2）：
- 一条规矩的每一层各一张图 ``<ruleId>__<layer>``，全部装进一个 composition
  （侧边栏只多 1 项而不是 40 项——痛点从来不是图的数量，是手工画图）
- 状态即**正文版本**：``未闻``(initial) → ``未验``(入口版本) → 作者写的其它版本
- ``reached('未验')`` = 掌握了这一层（单调）；``active`` = 现在信哪一版（可来回改）
- 信号按**目标版本**命名，并从**所有**其它状态各连一条边——所以 ``advanceRule``
  永远不会因为「当前不在预期前驱」而静默无效（那是本设计最想消灭的失败模式）

**不生成的东西**（硬纪律，靠 validator 兜）：层图状态一律不挂 onEnterActions、
不点名 activePlane。层图是永久单调的，点名位面会把别的位面顶掉；戏写在推它的那一头。

产出是纯函数 + 幂等：同样的 rules.json 反复跑，字节级一致。
"""

from __future__ import annotations

from typing import Any

from .rule_graph_naming import (
    RULE_LAYER_KEYS,
    RULE_LEDGER_COMPOSITION_ID,
    rule_layer_graph_id,
)

#: 层图初态：没听说过这一层。
RULE_LAYER_INITIAL_STATE = "未闻"
#: 层图入口版本：刚学到、还没验证。reached 它 ≡ 掌握了这一层。
RULE_LAYER_ENTRY_STATE = "未验"

_LEDGER_LABEL = "规矩账本（rules.json 生成，勿手改）"


def rule_advance_signal(rule_id: str, layer: str, to: str) -> str:
    """与 src/data/ruleGraphNaming.ts::ruleAdvanceSignal 同源。"""
    return f"rule:{str(rule_id).strip()}:{str(layer).strip()}:{str(to).strip()}"


def _layer_versions(rule: dict[str, Any], layer: str) -> list[dict[str, Any]]:
    """该层的额外版本（入口版本「未验」不在内）。

    版本表放在 **rule 级** 的 ``versions`` 键下、按层分组——不是放进 ``layers`` 里。
    理由：rule_editor 的 ``_apply_rule`` 会整体重建 ``layers``，塞进去的自定义键
    会被人类开一次面板就抹掉；rule 级键则能存活。
    """
    versions = rule.get("versions")
    if not isinstance(versions, dict):
        return []
    rows = versions.get(layer)
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        vid = str(row.get("id") or "").strip()
        if not vid or vid in seen or vid in (RULE_LAYER_INITIAL_STATE, RULE_LAYER_ENTRY_STATE):
            continue
        seen.add(vid)
        out.append(row)
    return out


def build_layer_graph(rule: dict[str, Any], layer: str) -> dict[str, Any]:
    """单张层图。刻意**不设 ownerType/ownerId**——一个 owner 挂多张 wrapper 会打掉
    getPrimaryGraphByOwner 并逼项目为规矩让渡一条全局治理规则；规矩不需要 @owner token。"""
    rule_id = str(rule.get("id") or "").strip()
    gid = rule_layer_graph_id(rule_id, layer)
    extra = _layer_versions(rule, layer)

    states: dict[str, Any] = {
        RULE_LAYER_INITIAL_STATE: {"id": RULE_LAYER_INITIAL_STATE, "label": "没听说过"},
        RULE_LAYER_ENTRY_STATE: {"id": RULE_LAYER_ENTRY_STATE, "label": "听来的，没验过"},
    }
    for row in extra:
        vid = str(row["id"]).strip()
        node: dict[str, Any] = {"id": vid}
        label = str(row.get("label") or "").strip()
        if label:
            node["label"] = label
        states[vid] = node

    targets = [RULE_LAYER_ENTRY_STATE, *[str(r["id"]).strip() for r in extra]]
    transitions: list[dict[str, Any]] = []
    for target in targets:
        signal = rule_advance_signal(rule_id, layer, target)
        for src in states:
            if src == target:
                continue
            transitions.append({
                "id": f"t_{src}_到_{target}",
                "from": src,
                "to": target,
                "signal": signal,
            })

    return {
        "id": gid,
        "label": f"{rule.get('name') or rule_id}·{layer}",
        "initialState": RULE_LAYER_INITIAL_STATE,
        "states": states,
        "transitions": transitions,
    }


def build_rule_ledger_composition(rules_data: dict[str, Any]) -> dict[str, Any]:
    """从 rules.json 整体生成 rule_ledger composition（纯函数、幂等）。"""
    elements: list[dict[str, Any]] = []
    for rule in rules_data.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        rule_id = str(rule.get("id") or "").strip()
        layers = rule.get("layers")
        if not rule_id or not isinstance(layers, dict):
            continue
        for layer in RULE_LAYER_KEYS:  # 固定顺序，保证幂等
            if layer not in layers or not isinstance(layers.get(layer), dict):
                continue
            elements.append({
                "id": f"el_{rule_id}__{layer}",
                "kind": "wrapperGraph",
                # ownerId 逐层唯一（<规矩id>:<层>）：编辑器要求 wrapper 必须绑定 owner，
                # 而唯一化能避开「一个 owner 挂多张 wrapper」——那会打掉
                # getPrimaryGraphByOwner 并逼项目为规矩让渡一条全局治理规则。
                # 刻意**不设 ownerType**：规矩不需要 @owner token，空 ownerType 在
                # TS/Python 两侧都被短路跳过，零校验豁免、零新增 NarrativeOwnerType。
                "ownerId": f"{rule_id}:{layer}",
                "label": f"{rule.get('name') or rule_id}·{layer}",
                "graph": build_layer_graph(rule, layer),
            })
    return {
        "id": RULE_LEDGER_COMPOSITION_ID,
        "label": _LEDGER_LABEL,
        "description": (
            "由 rules.json 生成，勿手改——下次 ./dev.sh sync-rule-graphs 会覆盖。"
            "改规矩请去规矩编辑器。"
        ),
        # composition 契约要求有 mainGraph。规矩账本没有"主流程"可言，
        # 放一张常驻单态占位图当锚，不参与任何逻辑。
        "mainGraph": {
            "id": "rule_ledger_index",
            "label": "规矩账本·锚（占位，无逻辑）",
            "initialState": "常驻",
            "states": {"常驻": {"id": "常驻", "label": "常驻"}},
            "transitions": [],
        },
        "elements": elements,
    }


def _compositions(narrative: Any) -> list[Any]:
    if not isinstance(narrative, dict):
        return []
    comps = narrative.get("compositions")
    return comps if isinstance(comps, list) else []


def current_rule_ledger(narrative: Any) -> dict[str, Any] | None:
    for comp in _compositions(narrative):
        if isinstance(comp, dict) and str(comp.get("id") or "").strip() == RULE_LEDGER_COMPOSITION_ID:
            return comp
    return None


def sync_rule_graphs(model: Any) -> dict[str, Any]:
    """把生成结果写进 model.narrative_graphs 并标脏。返回 {changed, elements, created}。

    零磁盘写入——落盘仍走主编辑器 Save All / CLI 的显式写盘。
    """
    narrative = getattr(model, "narrative_graphs", None)
    if not isinstance(narrative, dict):
        raise ValueError("model.narrative_graphs 不是对象，无法同步规矩层图")
    rules_data = getattr(model, "rules_data", None)
    if not isinstance(rules_data, dict):
        raise ValueError("model.rules_data 不是对象，无法同步规矩层图")

    built = build_rule_ledger_composition(rules_data)
    comps = narrative.setdefault("compositions", [])
    if not isinstance(comps, list):
        raise ValueError("narrative_graphs.compositions 不是数组")

    created = True
    changed = True
    for idx, comp in enumerate(comps):
        if isinstance(comp, dict) and str(comp.get("id") or "").strip() == RULE_LEDGER_COMPOSITION_ID:
            created = False
            changed = comp != built
            if changed:
                comps[idx] = built
            break
    else:
        comps.append(built)

    if changed and hasattr(model, "mark_dirty"):
        model.mark_dirty("narrative_graphs")
    return {"changed": changed, "created": created, "elements": len(built["elements"])}


def rule_ledger_drift(model: Any) -> str | None:
    """磁盘上的 rule_ledger 是否与按当前 rules.json 重新生成的一致。

    返回 None = 一致；否则返回一句人话差异描述（**带上修复命令**——AI 直接改 JSON 时
    必须能自己把这条清掉，否则收尾校验会变成只能开 GUI 才能解的死锁闸）。
    """
    rules_data = getattr(model, "rules_data", None)
    narrative = getattr(model, "narrative_graphs", None)
    if not isinstance(rules_data, dict) or not isinstance(narrative, dict):
        return None
    built = build_rule_ledger_composition(rules_data)
    current = current_rule_ledger(narrative)
    if current == built:
        return None
    if current is None:
        if not built["elements"]:
            return None  # 没有任何带层的规矩，本就不该有账本
        return (
            f"规矩层图缺失（应有 {len(built['elements'])} 张）——跑 ./dev.sh sync-rule-graphs 生成"
        )
    cur_ids = {
        str(e.get("id") or "")
        for e in (current.get("elements") or [])
        if isinstance(e, dict)
    }
    new_ids = {str(e.get("id") or "") for e in built["elements"]}
    missing = sorted(new_ids - cur_ids)
    extra = sorted(cur_ids - new_ids)
    bits = []
    if missing:
        bits.append(f"缺 {len(missing)} 张（如 {missing[0]}）")
    if extra:
        bits.append(f"多 {len(extra)} 张（如 {extra[0]}）")
    if not bits:
        bits.append("图内容与 rules.json 不一致")
    return f"规矩层图与 rules.json 不同步：{'；'.join(bits)}——跑 ./dev.sh sync-rule-graphs 重新生成"
