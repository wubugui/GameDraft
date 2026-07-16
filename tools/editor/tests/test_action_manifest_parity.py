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
