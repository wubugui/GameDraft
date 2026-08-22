"""`lighting.shadowBias` 的校验。

## 为什么值得一个测试

这两个量（起步偏置 / 遮挡体厚度窗，**都是 wu**）从 2026-08-20 起一直
**写死在两个 shader 的 uniform 初值里**（`[0.035, 2]`），且 `applyParams` 从不写它们
——也就是说 F2 调不到、场景 JSON 也写不了，是一对**死值**。

而那个 `thick = 2 wu` 在雾津街头（全场深度跨度只有 3.81 wu）盖住了**一半场景深度**，
正是 `lightingCore.glsl` 自己注释里点名的失败模式「隔山打影」（远处的墙挡住近处的地）。

接通之后作者第一次能填这两个数，所以要挡住量级明显不对的填法：场景纵深普遍
3–5 wu，厚度窗超过 3 wu 基本等于"前面有东西就算挡"，低于 0.005 wu 则必然漏挡。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.validator import _shadow_bias_issues  # noqa: E402


def test_没配就不报() -> None:
    assert _shadow_bias_issues(None) == []


def test_缺省值合法() -> None:
    from tools.editor.editors.scene_lights import default_lighting_block
    assert _shadow_bias_issues(default_lighting_block()['shadowBias']) == []


def test_只写一半也合法() -> None:
    assert _shadow_bias_issues({'thickness': 260}) == []
    assert _shadow_bias_issues({'bias': 30}) == []


def test_不是对象要报() -> None:
    for bad in (260, 'x', [30, 260]):
        assert _shadow_bias_issues(bad), bad


@pytest.mark.parametrize('val', [-1, 401, 'x', [30]])
def test_偏置越界或非数值要报(val: object) -> None:
    assert any('bias' in t for t in _shadow_bias_issues({'bias': val})), val


def test_布尔不算数值() -> None:
    """`isinstance(True, int)` 是真——不显式挡住的话 `true` 会被当成 1 放过去。"""
    assert any('bias' in t for t in _shadow_bias_issues({'bias': True}))


def test_厚度窗按_wu_的量级把关() -> None:
    # 角色高 150 wu；3000 wu = 20 个人高，再厚基本等于「前面有东西就算挡」
    assert _shadow_bias_issues({'thickness': 3000}) == []
    assert any('thickness' in t for t in _shadow_bias_issues({'thickness': 3001}))
    # 缺省 260 wu ≈ 1.7 个人高，一堵墙的进深
    assert _shadow_bias_issues({'thickness': 260}) == []
    # 太薄会漏挡（1 wu = 1/150 个人高）
    assert any('thickness' in t for t in _shadow_bias_issues({'thickness': 1}))


def test_不认识的键要报() -> None:
    issues = _shadow_bias_issues({'bias': 30, 'thick': 2})
    assert any("'thick'" in t for t in issues), issues


def test_与运行时缺省同值() -> None:
    """编辑器/校验器这一份是运行时 `lightPacking.ts` 的镜像，分家了不报错、只是不一致。"""
    from tools.editor.editors.scene_lights import (
        DEFAULT_SHADOW_BIAS_WU, DEFAULT_SHADOW_THICKNESS_WU,
    )
    src = (_ROOT / 'src' / 'rendering' / 'lighting' / 'lightPacking.ts').read_text('utf-8')
    assert f'DEFAULT_SHADOW_BIAS_WU = {DEFAULT_SHADOW_BIAS_WU:g};' in src
    assert f'DEFAULT_SHADOW_THICKNESS_WU = {DEFAULT_SHADOW_THICKNESS_WU:g};' in src
