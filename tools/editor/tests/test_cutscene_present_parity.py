"""三方 cutscene present 类型 parity 护栏（FIX-1：根因2「手工镜像清单无语义 parity」合拢）。

过场 present 步的类型名是第四类三处手工镜像，此前零 parity 护栏：
- 运行时 `src/systems/CutsceneManager.ts` 的 `executePresent(step)` switch 分支
  （`switch (step.type)`）—— 真正被执行的 present 类型；
- 编辑器 `tools/editor/editors/timeline_editor.py` 的 `PRESENT_TYPES` —— 决定策划能
  在时间线里新建/编辑哪些 present 步；
- 校验器 `tools/editor/validator.py` 的 `_CUTSCENE_PRESENT_TYPES` —— `validate-data`
  据此把未知 present type 打成 error。

任一处新增/删除 present 类型而漏同步，会导致：
- 运行时有、编辑器无 → 策划打不开/写不出该 present 步；
- 运行时有、校验器无 → 合法数据被 validate-data 误判 error；
- 编辑器/校验器有、运行时无 → 幻影类型，运行时静默 `unknown present type` 告警跳过。

比对手法与 test_action_manifest_parity.py 一致：正则解析三份源、名集合三方比对。
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _runtime_present_types() -> set[str]:
    """CutsceneManager.executePresent 的 `switch (step.type)` 各 case 名。

    从唯一锚点 `switch (step.type)` 起、到该 switch 的 `default:` 止切片，
    只取 present 分支，天然排除 executeOneStep 的 kind switch（action/present/parallel）。
    """
    text = (REPO / "src/systems/CutsceneManager.ts").read_text("utf-8")
    anchor = "switch (step.type)"
    i = text.index(anchor)
    # 该 switch 内首个 default: 即分支结束（present case 内无嵌套 switch）
    end = text.index("default:", i)
    body = text[i:end]
    return set(re.findall(r"case\s*'([A-Za-z][A-Za-z0-9]*)'\s*:", body))


def _editor_present_types() -> set[str]:
    from tools.editor.editors.timeline_editor import PRESENT_TYPES
    return {str(x) for x in PRESENT_TYPES}


def _validator_present_types() -> set[str]:
    from tools.editor.validator import _CUTSCENE_PRESENT_TYPES
    return {str(x) for x in _CUTSCENE_PRESENT_TYPES}


def test_present_types_three_way_parity() -> None:
    runtime = _runtime_present_types()
    editor = _editor_present_types()
    validator = _validator_present_types()

    assert runtime, "未能从 CutsceneManager.executePresent 解析出任何 present case"

    missing_in_editor = sorted(runtime - editor)
    missing_in_validator = sorted(runtime - validator)
    assert not missing_in_editor, (
        f"运行时执行但编辑器 PRESENT_TYPES 缺失（策划打不开/写不出该 present 步）："
        f"{missing_in_editor}"
    )
    assert not missing_in_validator, (
        f"运行时执行但 validator._CUTSCENE_PRESENT_TYPES 缺失（validate-data 误判 error）："
        f"{missing_in_validator}"
    )

    phantom_editor = sorted(editor - runtime)
    phantom_validator = sorted(validator - runtime)
    assert not phantom_editor, (
        f"编辑器 PRESENT_TYPES 有运行时不认的幻影类型（运行时静默跳过）：{phantom_editor}"
    )
    assert not phantom_validator, (
        f"validator 有运行时不认的幻影 present 类型：{phantom_validator}"
    )


def test_editor_and_validator_present_types_agree() -> None:
    editor = _editor_present_types()
    validator = _validator_present_types()
    assert editor == validator, (
        "编辑器 PRESENT_TYPES 与 validator._CUTSCENE_PRESENT_TYPES 不一致："
        f"仅编辑器={sorted(editor - validator)} 仅校验器={sorted(validator - editor)}"
    )


def test_camera_easing_three_way_parity() -> None:
    """cameraMove/cameraZoom 的 easing 词表三方镜像：
    运行时 CutsceneManager.CUTSCENE_CAMERA_EASINGS（解析闸门）、
    编辑器 timeline_editor._CAMERA_EASING_ROWS（下拉候选，空值=不写键除外）、
    校验器 validator._PARALLAX_EASINGS（validate-data error 闸门）。
    """
    text = (REPO / "src/systems/CutsceneManager.ts").read_text("utf-8")
    m = re.search(
        r"CUTSCENE_CAMERA_EASINGS[^=]*=\s*new Set\(\[([^\]]*)\]\)", text)
    assert m, "未找到 CutsceneManager 的 CUTSCENE_CAMERA_EASINGS 定义"
    runtime = set(re.findall(r"'([A-Za-z]+)'", m.group(1)))

    from tools.editor.editors.timeline_editor import _CAMERA_EASING_ROWS
    editor = {v for _, v in _CAMERA_EASING_ROWS if v}

    from tools.editor.validator import _PARALLAX_EASINGS
    validator = set(_PARALLAX_EASINGS)

    assert runtime == editor == validator, (
        "easing 词表三方漂移："
        f"运行时={sorted(runtime)} 编辑器={sorted(editor)} 校验器={sorted(validator)}"
    )
