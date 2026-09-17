"""粒子效果外观模块里「形状要查」的那几项，工作台形状闸门与主校验器共用一份。

目前只有 ``appearance.tintOverLife``（颜色 × 寿命，``src/data/types.ts`` 的 ``VfxAppearanceDef``）：
工作台保存时 ``tools/vfx_workbench/assets.py`` 拿第一条问题拒存（ValueError），主校验器
``validator._validate_vfx_effects`` 把每条都报成 error——口径与措辞只写在这里。
纯函数，不碰 Qt、不读写文件。
"""
from __future__ import annotations

import math
from typing import Any


def _finite_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x))


def tint_over_life_problems(value: Any) -> list[str]:
    """``[t, r, g, b][]`` 的形状问题；空列表 = 合法（空表 / 没写 = 恒白）。

    采样口径与 ``VfxCurve`` 相同（按 t 线性插值、t 超出两端取端点值），语义是**乘在 ``tint`` 上**：
    - 每个关键点是长度 4、全是有限数的数组（坏一个就停：后面的下标没有意义）；
    - t 在 0..1 且**非降序**（乱序时插值区间对不上，颜色在寿命中途跳变）；
    - r / g / b 在 0..1。
    """
    if not isinstance(value, list):
        return [f"须为 [[t, r, g, b], …] 数组（收到 {value!r}）"]
    out: list[str] = []
    last: float | None = None
    for i, kp in enumerate(value):
        if not (isinstance(kp, list) and len(kp) == 4 and all(_finite_num(x) for x in kp)):
            out.append(f"[{i}] 须为 [t, r, g, b] 四个有限数（收到 {kp!r}）")
            return out
        t = float(kp[0])
        if not 0.0 <= t <= 1.0:
            out.append(f"[{i}] 的 t={kp[0]!r} 不在 [0,1]（t 是寿命归一化进度）")
        if last is not None and t < last:
            out.append(f"[{i}] 的 t 比上一点小；关键点须按 t 递增")
        last = t
        for name, c in zip("rgb", kp[1:]):
            if not 0.0 <= float(c) <= 1.0:
                out.append(f"[{i}] 的 {name}={c!r} 不在 [0,1]（颜色乘在 tint 上）")
    return out
