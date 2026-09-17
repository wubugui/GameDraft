"""ProjectModel.all_flags 必须下钻容器动作与 ConditionExpr 组合树。

曾经只读顶层动作列表（外加手写的 enableRuleOffers.slots[].resultActions 一种）与平铺的
``{flag: ...}`` 叶子：runActionsIf / chooseAction / runActions / randomBranch /
addDelayedEvent 里写的 flag、all/any/not 里读的 flag、runActionsIf.params.condition 里读的
flag 一概漏掉——生产工作台的前置 flag 选择器选不到，剧情验收把它们报成
``acceptance.flag.unknown``。下钻口径读唯一真相源 ``action_structure.NESTED_ACTION_SLOTS``。
"""
from __future__ import annotations

from tools.editor.project_model import ProjectModel


def _set(key: str) -> dict:
    return {"type": "setFlag", "params": {"key": key, "value": True}}


def _model() -> ProjectModel:
    return ProjectModel()


def test_scene_hotspot_actions_under_run_actions_if_and_choose_action() -> None:
    model = _model()
    model.scenes = {
        "sc": {
            "hotspots": [{
                "id": "h",
                "conditions": [{"any": [{"flag": "hs_cond_any"}, {"quest": "q", "questStatus": "Active"}]}],
                "data": {"actions": [{
                    "type": "runActionsIf",
                    "params": {
                        "condition": {"all": [{"flag": "if_read_all"}, {"not": {"flag": "if_read_not"}}]},
                        "actions": [_set("if_then_write")],
                        "elseActions": [{
                            "type": "chooseAction",
                            "params": {
                                "prompt": "选",
                                "options": [
                                    {"text": "甲", "actions": [_set("choose_opt0_write")]},
                                    {"text": "乙", "actions": [{
                                        "type": "runActionsIf",
                                        "params": {
                                            "condition": {"flag": "deep_if_read", "op": ">=", "value": 2},
                                            "actions": [_set("deep_if_write")],
                                        },
                                    }]},
                                ],
                            },
                        }],
                    },
                }]},
            }],
        },
    }

    flags = model.all_flags()

    for key in (
        "hs_cond_any",
        "if_read_all", "if_read_not", "if_then_write",
        "choose_opt0_write", "deep_if_read", "deep_if_write",
    ):
        assert key in flags, f"{key} 未被收集：{sorted(flags)}"


def test_scene_on_enter_and_zone_events_walk_every_container_slot() -> None:
    model = _model()
    model.scenes = {
        "sc": {
            "onEnter": [
                {"type": "randomBranch", "params": {
                    "probability": 0.5,
                    "aboveActions": [{"type": "runActions", "params": {"actions": [_set("above_write")]}}],
                    "belowActions": [_set("below_write")],
                }},
                {"type": "addDelayedEvent", "params": {"targetDay": 3, "actions": [_set("delayed_write")]}},
            ],
            "zones": [{
                "id": "z",
                "conditions": [{"not": {"flag": "zone_cond_not"}}],
                "onExit": [{"type": "enableRuleOffers", "params": {"slots": [{
                    "ruleId": "r",
                    "resultActions": [{"type": "runActionsIf", "params": {
                        "condition": {"flag": "slot_if_read"},
                        "actions": [_set("slot_if_write")],
                    }}],
                }]}}],
            }],
        },
    }

    flags = model.all_flags()

    for key in (
        "above_write", "below_write", "delayed_write",
        "zone_cond_not", "slot_if_read", "slot_if_write",
    ):
        assert key in flags, f"{key} 未被收集：{sorted(flags)}"


def test_quest_and_encounter_actions_and_condition_trees() -> None:
    model = _model()
    model.quests = [{
        "id": "q",
        "preconditions": [{"all": [{"flag": "quest_pre_all"}]}],
        "acceptActions": [{"type": "runActionsIf", "params": {
            "condition": {"any": [{"flag": "accept_if_read"}]},
            "actions": [{"type": "chooseAction", "params": {"options": [
                {"text": "好", "actions": [_set("accept_choose_write")]},
            ]}}],
        }}],
        "rewards": [{"type": "runActions", "params": {"actions": [_set("reward_nested_write")]}}],
        "nextQuests": [{"questId": "q2", "conditions": [{"not": {"flag": "next_cond_not"}}]}],
    }]
    model.encounters = [{
        "id": "e",
        "options": [{
            "text": "打",
            "conditions": [{"any": [{"flag": "enc_opt_cond_any"}]}],
            "resultActions": [{"type": "runActionsIf", "params": {
                "condition": {"flag": "enc_if_read"},
                "actions": [],
                "elseActions": [_set("enc_else_write")],
            }}],
        }],
    }]

    flags = model.all_flags()

    for key in (
        "quest_pre_all", "accept_if_read", "accept_choose_write", "reward_nested_write",
        "next_cond_not", "enc_opt_cond_any", "enc_if_read", "enc_else_write",
    ):
        assert key in flags, f"{key} 未被收集：{sorted(flags)}"


def test_archive_and_item_condition_trees() -> None:
    model = _model()
    model.items = [{"id": "i", "dynamicDescriptions": [{"conditions": [{"all": [{"flag": "item_dd_all"}]}]}]}]
    model.archive_characters = [{
        "id": "c",
        "unlockConditions": [{"not": {"flag": "char_unlock_not"}}],
        "impressions": [{"conditions": [{"any": [{"flag": "char_imp_any"}]}]}],
        "knownInfo": [{"conditions": [{"all": [{"flag": "char_known_all"}]}]}],
    }]
    model.archive_lore = {"entries": [{"unlockConditions": [{"any": [{"flag": "lore_any"}]}]}]}
    model.archive_documents = [{"discoverConditions": [{"all": [{"flag": "doc_all"}]}]}]
    model.archive_books = [{"pages": [{"unlockConditions": [{"not": {"flag": "book_not"}}]}]}]

    flags = model.all_flags()

    for key in (
        "item_dd_all", "char_unlock_not", "char_imp_any", "char_known_all",
        "lore_any", "doc_all", "book_not",
    ):
        assert key in flags, f"{key} 未被收集：{sorted(flags)}"


def test_item_use_and_prop_state_on_enter_actions() -> None:
    """物件 use.actions 与挂件状态 onEnterActions 是同一类「真执行的动作树」，flag 收集要一视同仁。"""
    model = _model()
    model.items = [{"id": "i", "use": {
        "label": "用",
        "conditions": [{"not": {"flag": "use_cond_not"}}],
        "actions": [{"type": "runActions", "params": {"actions": [_set("use_nested_write")]}}],
    }}]
    model.prop_presets = {
        "torch": {"image": "/a.png", "states": {
            "lit": {},
            "out": {"onEnterActions": [
                _set("prop_out_write"),
                {"type": "runActionsIf", "params": {
                    "condition": {"flag": "prop_if_read"},
                    "actions": [], "elseActions": [_set("prop_else_write")]}},
            ]},
            "坏": None,
        }},
        "junk": "not-a-preset",
    }

    flags = model.all_flags()

    for key in ("use_cond_not", "use_nested_write",
                "prop_out_write", "prop_if_read", "prop_else_write"):
        assert key in flags, f"{key} 未被收集：{sorted(flags)}"


def test_flat_shapes_still_collected_and_junk_is_ignored() -> None:
    model = _model()
    model.scenes = {
        "sc": {
            "onEnter": [_set("flat_on_enter"), "not-an-action", {"type": "setFlag", "params": {"key": ""}}],
            "hotspots": [{"conditions": [{"flag": "flat_hs_cond"}], "data": {"actions": [_set("flat_hs_write")]}}],
            "zones": [{"conditions": [], "onEnter": [{"type": "setFlag", "params": {"key": {"bad": 1}}}]}],
        },
    }
    model.quests = [{"completionConditions": [{"flag": "flat_quest_done"}, {"all": []}, "junk"]}]

    flags = model.all_flags()

    assert {"flat_on_enter", "flat_hs_cond", "flat_hs_write", "flat_quest_done"} <= flags
    assert "" not in flags
    assert all(isinstance(f, str) for f in flags)
