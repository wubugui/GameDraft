"""三方 action 清单 parity 护栏（审查 P2-1：五处手工镜像清单零 parity 护栏的系统性根因）。

运行时 ActionExecutor/ActionRegistry 注册的 action ↔ 编辑器 ACTION_TYPES ↔ TS
actionParamManifest.ts 必须保持一致。任一处新增/删除 action 而漏同步，会导致：
- 编辑器打不开/写不出该 action（ACTION_TYPES 缺）；
- 网页叙事校验幻影 error 拦保存（manifest 缺，正是本轮修复的 P1-32 类问题）；
- validate-data 把合法数据打成 error（validator 用 ACTION_TYPES）。

本测试比对三份清单，任一漂移即失败并列出差集。
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _runtime_action_ids() -> set[str]:
    ids: set[str] = set()
    for rel in ("src/core/ActionExecutor.ts", "src/core/ActionRegistry.ts"):
        p = REPO / rel
        if p.is_file():
            ids |= set(re.findall(r"register\(\s*['\"]([A-Za-z][A-Za-z0-9]*)['\"]", p.read_text("utf-8")))
    return ids


def _manifest_action_ids() -> set[str]:
    p = REPO / "src/core/actionParamManifest.ts"
    text = p.read_text("utf-8")
    # 仅取对象字面量顶层键：行首两空格 + 标识符 + 冒号
    return set(re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]*)\s*:", text, re.MULTILINE))


def _editor_action_types() -> set[str]:
    from tools.editor.shared.action_editor import ACTION_TYPES
    return {str(x) for x in ACTION_TYPES}


def test_runtime_actions_covered_by_editor_and_manifest() -> None:
    runtime = _runtime_action_ids()
    editor = _editor_action_types()
    manifest = _manifest_action_ids()
    assert runtime, "未能从运行时源码解析出任何 register('…') action"

    missing_in_editor = sorted(runtime - editor)
    missing_in_manifest = sorted(runtime - manifest)
    assert not missing_in_editor, (
        f"运行时注册但编辑器 ACTION_TYPES 缺失（打不开/写不出）：{missing_in_editor}"
    )
    assert not missing_in_manifest, (
        f"运行时注册但 TS actionParamManifest 缺失（网页叙事校验会幻影 error 拦保存）："
        f"{missing_in_manifest}"
    )


def test_editor_action_types_are_known_to_manifest() -> None:
    from tools.editor.shared.action_editor import DEBUG_ONLY_ACTION_TYPES

    editor = _editor_action_types()
    manifest = _manifest_action_ids()
    # setNarrativeState 等调试通道 action 无运行时 handler，manifest 明文不收录（见其头注释）。
    exempt = {str(x) for x in DEBUG_ONLY_ACTION_TYPES}
    unknown = sorted(editor - manifest - exempt)
    assert not unknown, f"编辑器 ACTION_TYPES 有 manifest 未登记的 action：{unknown}"


# 语义级 parity：登记面 ENTITY_REF_PARAMS ↔ validator 的解析检查
# ---------------------------------------------------------------------------
# 曾经 validator 手抄了第二份 actor 清单，漏掉 jumpEntityTo.target —— 重构引擎认得它、
# 校验器不认，于是悬垂演员引用一路静默（运行时那一步直接跳过）。这里不锁"名字都在"，
# 锁"喂一个绝不存在的 id 进去，校验真的会报"。

# npc_soft 是软引用：命中不了就当显示名用，报不报由各调用点自行决定，不进硬 parity。
_HARD_BARE_REF_KINDS = ("actor", "emote_subject", "bubble_speaker", "npc")


def test_every_registered_bare_entity_ref_param_is_actually_validated() -> None:
    from tools.editor.project_model import ProjectModel
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    from tools.editor.validator import _append_action_param_ref_issues

    model = ProjectModel()
    model.load_project(REPO)
    ghost = "绝不存在的实体_parity_probe"

    unchecked: list[str] = []
    for act_type, params in sorted(ENTITY_REF_PARAMS.items()):
        for key, kind in params.items():
            if kind not in _HARD_BARE_REF_KINDS:
                continue
            issues: list = []
            _append_action_param_ref_issues(
                model, issues, {"type": act_type, "params": {key: ghost}},
                "parity", "probe", None,
            )
            if not any(ghost in i.message and key in i.message for i in issues):
                unchecked.append(f"{act_type}.{key}（{kind}）")

    assert not unchecked, (
        "这些参数在 ENTITY_REF_PARAMS 里登记为实体引用，但 validator 喂悬垂 id 也不报——"
        "改名/迁移后会静默断（运行时跳过该步，校验全绿）：" + "、".join(unchecked)
    )


def test_validator_actor_keys_come_from_the_single_registry() -> None:
    """validator 的 actor 参数面必须**读**登记面，而不是另抄一份。"""
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    from tools.editor.validator import _actor_ref_keys

    for act_type, params in ENTITY_REF_PARAMS.items():
        expected = tuple(k for k, kind in params.items() if kind == "actor")
        assert _actor_ref_keys(act_type) == expected, act_type
    assert _actor_ref_keys("jumpEntityTo") == ("target",), "本轮修复的漏网之鱼"
    assert _actor_ref_keys("根本不是 action") == ()
