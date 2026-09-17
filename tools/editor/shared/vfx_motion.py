"""粒子效果运动模块里「形状要查」的那几项，工作台形状闸门与主校验器共用一份。

目前只有 ``motion.followAnchor``（锚点动了、**已发射**的粒子怎么走，``src/data/types.ts`` 的
``VfxMotionDef.followAnchor`` / ``VfxFollowAnchor``）：
工作台保存时 ``tools/vfx_workbench/assets.py`` 拿问题拒存（ValueError）、拿提醒进 warnings；
主校验器 ``validator._validate_vfx_effects`` 报成 error / warning——口径与措辞只写在这里，
两边各自只加「发射器 X」前缀。纯函数，不碰 Qt、不读写文件。

缺省口径：不写 = ``none``。**写入者（工作台检视器）选「不跟」= 删键**；形状闸门对显式写着的
``"none"`` **原样保留**（与 ``appearance.blend: "normal"`` / ``lit: true`` 同一条：闸门只收束键序、
不替作者改值）。
"""
from __future__ import annotations

from typing import Any

#: 与 ``types.ts`` 的 ``VfxFollowAnchor`` 逐字同序（parity 测试读 types.ts 对账）
FOLLOW_ANCHOR_VALUES: tuple[str, ...] = ("none", "rig", "full")


def follow_anchor_problem(value: Any) -> str | None:
    """``motion.followAnchor`` 的取值问题；None = 合法。调用方决定「键不在 / JSON null」算不算未填。"""
    if isinstance(value, str) and value in FOLLOW_ANCHOR_VALUES:
        return None
    return (f"motion.followAnchor 只能是 none / rig / full"
            f"（不跟 / 跟动作、不跟走 / 完全跟），收到 {value!r}")


def follow_anchor_ignored(value: Any, solver: str) -> str | None:
    """群体 / 薄片发射器写了 ``rig`` / ``full``：运行时 ``moveAnchor`` 对它们整个跳过，写了没用。

    ``solver`` = ``vfx_program.effective_solver(emitter)``（与运行时 ``resolveEmitterProgram`` 同判据）。
    显式 ``"none"`` 不提醒——它就是运行时对这两类的实际行为，没有误导。
    """
    if solver not in ("flock", "plate") or value not in ("rig", "full"):
        return None
    kind = "群体" if solver == "flock" else "薄片"
    return (f"群体 / 薄片不吃 followAnchor，写了没用（这是{kind}发射器，"
            f"运行时忽略 motion.followAnchor={value!r}，在飞的粒子不跟锚点）")
