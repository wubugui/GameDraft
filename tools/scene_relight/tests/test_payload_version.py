# -*- coding: utf-8 -*-
"""载荷代次的**三处常量**必须一致。

`PAYLOAD_VERSION`（烘焙器写进 meta）、`LIGHTING3_VERSION`（运行时的版本闸）、
`_LIGHTING3_VERSION`（校验器）分别写在三个文件、三种语言里。

## 为什么值得一条测试

因为漂了不报错，只是**整包被静默忽略**：`SceneLightingSystem` 发现代次不符就
depthError 一行日志然后回落旧路径，画面照样出、tsc 全绿、单测全绿。
2026-08-23 一天之内漂了两次：

- 代次 2→3 时校验器忘了跟，它此后一直拿 2 去比，对着全部 28 个场景报假错；
- 代次 3→4 时运行时忘了跟，真机直接 `统一光影未启用`，靠肉眼看画面才发现。
"""
from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]


def _grab(rel: str, pattern: str) -> int:
    src = (_ROOT / rel).read_text(encoding='utf-8')
    m = re.search(pattern, src, re.M)
    assert m, f'{rel}: 找不到代次常量（{pattern}）'
    return int(m.group(1))


def test_三处代次常量一致() -> None:  # noqa: N802
    bake = _grab('tools/scene_relight/bake_gbuffer.py', r'^PAYLOAD_VERSION = (\d+)')
    runtime = _grab('src/core/SceneLightingSystem.ts',
                    r'^export const LIGHTING3_VERSION = (\d+);')
    validator = _grab('tools/editor/validator.py', r'^_LIGHTING3_VERSION = (\d+)')
    assert bake == runtime == validator, (
        f'代次漂了：烘焙器 {bake} / 运行时 {runtime} / 校验器 {validator}。'
        f'不一致的后果是**静默**的 —— 运行时整包忽略、回落旧路径，画面照样出。')
