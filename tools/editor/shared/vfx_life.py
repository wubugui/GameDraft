"""粒子效果寿命模块里「形状要查」的那几项，工作台形状闸门与主校验器共用一份。

目前只有 ``life.maxDistance``（最远烧到多远，wu，离发射器原点；``src/data/types.ts`` 的
``VfxLifeDef.maxDistance``，运行时 ``vfxSim.stepGeneric``：每一步粒子的 age 取
``max(age, 离原点距离 / (maxDistance × 实例距离倍率) × life)``——离火源越远越早走完寿命曲线，到那个距离烧完）：
工作台保存时 ``tools/vfx_workbench/assets.py`` 拿问题拒存（ValueError）、拿提醒进 warnings；
主校验器 ``validator._validate_vfx_effects`` 报成 error / warning——口径与措辞只写在这里，
两边各自只加「发射器 X」前缀。纯函数，不碰 Qt、不读写文件。

缺省口径：不写 = 不限距离（运行时 ``?? 0``，≤ 0 不算）。**写入者（工作台检视器）清空 = 删键**，从不写 0 / null；
形状闸门对写着的值只查「有限且 > 0」，不替作者改值。
"""
from __future__ import annotations

import math
from typing import Any


def max_distance_problem(value: Any) -> str | None:
    """``life.maxDistance`` 的取值问题；None = 合法。调用方决定「键不在 / JSON null」算不算未填。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        return None
    return (f"life.maxDistance 必须是 > 0 的数（最远烧到多远 wu，离发射器原点；不限距离就删掉这个键），"
            f"收到 {value!r}")


def max_distance_ignored(solver: str, life: Any) -> str | None:
    """写了 ``maxDistance`` 但运行时不读：群体 / 薄片不走 ``stepGeneric``；没有 ``life.seconds`` 的粒子寿命是 0（永生），
    运行时 ``p.life > 0`` 才按距离烧。

    ``solver`` = ``vfx_program.effective_solver(emitter)``（与运行时 ``resolveEmitterProgram`` 同判据）；
    ``life`` = 发射器的 ``life`` 模块（``seconds`` 键在且非 null 就算有寿命，形状另查）。
    """
    if solver in ("flock", "plate"):
        kind = "群体" if solver == "flock" else "薄片"
        why = f"这是{kind}发射器，运行时不走普通粒子那一步"
    elif not isinstance(life, dict) or life.get("seconds") is None:
        why = "这个发射器没有 life.seconds（永生），运行时只对有寿命的粒子按距离烧完"
    else:
        return None
    return f"没有寿命 / 群体 / 薄片不吃 maxDistance，写了没用（{why}，life.maxDistance 被忽略）"
