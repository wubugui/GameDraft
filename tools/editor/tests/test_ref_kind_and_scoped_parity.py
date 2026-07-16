"""ref-kind 三方 parity + SCOPED_PARAM_RULES 有效性护栏（FIX-1 任务 6 普查补漏）。

普查发现两处"手工镜像但只有软护栏/零护栏"：

1. **实体引用 kind 三方镜像**（此前仅 extract.py 里一句 warning，非硬门）：
   - `entity_refactor.ENTITY_REF_PARAMS` 各参数的 ref kind（重构/校验实际用的种类）；
   - `schema_build.REF_KIND_UNIVERSE` 的 key（json_lang 据此把 ref 参数烤成 id 宇宙枚举）；
   - `extract._KNOWN_REF_KINDS`（json_lang 新 kind 侦测的已知集）。
   新增 ref kind 只加一处 → schema 静默不给该参数注入宇宙枚举（typo 不再波浪线）。

2. **SCOPED_PARAM_RULES 跨字段收窄规则**（V4 点名候选，零 parity）：
   `schema_build.SCOPED_PARAM_RULES` 里每条 (action, scope_param, target_param) 都手写；
   若 action 改名/参数改名而这里漏改，收窄规则静默失效（"选了场景 A 填场景 B 出生点"
   不再当场波浪线），且无人察觉。此处锁：action 已注册、两个参数都是 manifest 真参数。
"""
from __future__ import annotations

from tools.editor.shared.action_editor import ACTION_TYPES
from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
from tools.editor.tests.test_param_schema_manifest_parity import _manifest_entries
from tools.json_lang.extract import _KNOWN_REF_KINDS
from tools.json_lang.schema_build import REF_KIND_UNIVERSE, SCOPED_PARAM_RULES


def test_ref_kind_universe_keys_equal_known_ref_kinds() -> None:
    ru = set(REF_KIND_UNIVERSE)
    kk = set(_KNOWN_REF_KINDS)
    assert ru == kk, (
        "schema_build.REF_KIND_UNIVERSE 的 key 与 extract._KNOWN_REF_KINDS 不一致——"
        "两处手工镜像漂移：\n"
        f"  仅 REF_KIND_UNIVERSE={sorted(ru - kk)}\n"
        f"  仅 _KNOWN_REF_KINDS ={sorted(kk - ru)}"
    )


def test_entity_ref_param_kinds_are_all_mapped_to_universe() -> None:
    used = {k for m in ENTITY_REF_PARAMS.values() for k in m.values()}
    unmapped = sorted(used - set(REF_KIND_UNIVERSE))
    assert not unmapped, (
        "ENTITY_REF_PARAMS 用了 schema_build.REF_KIND_UNIVERSE 未映射的 ref kind——"
        f"这些参数不会被烤成 id 宇宙枚举（typo 不波浪线、跨场景引用不收窄）：{unmapped}"
    )


def test_scoped_param_rules_reference_real_actions_and_params() -> None:
    man = _manifest_entries()
    action_types = set(ACTION_TYPES)
    offenders: list[str] = []
    for rule in SCOPED_PARAM_RULES:
        act, scope_param, target_param = rule[0], rule[1], rule[2]
        if act not in action_types:
            offenders.append(f"{act}: 不是已注册 action（ACTION_TYPES 无）")
            continue
        entry = man.get(act)
        if entry is None:
            offenders.append(f"{act}: manifest 无条目，无法核验 scoped 参数")
            continue
        known = entry["required"] | entry["nonEmpty"] | entry["optional"]
        # scoped 参数也可能是纯 ENTITY_REF 参数（未必进 manifest），并集核验
        known |= set(ENTITY_REF_PARAMS.get(act, {}))
        for role, p in (("scope_param", scope_param), ("target_param", target_param)):
            if p not in known:
                offenders.append(
                    f"{act}.{p}（{role}）不是该 action 的已知参数"
                    f"（manifest∪entity_ref={sorted(known)}）——scoped 收窄规则已失效"
                )
    assert not offenders, (
        "SCOPED_PARAM_RULES 引用了不存在的 action/参数（跨字段收窄静默失效）：\n"
        + "\n".join(offenders)
    )
