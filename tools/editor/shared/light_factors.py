"""场景角色 / 粒子受光倍率与色度的形状闸门（与 TS lightFactors 同口径）。"""
import math


def light_factor_issues(value):
    if value is None:
        return []
    if not isinstance(value, dict):
        return ["lighting.lightFactors 须为对象"]
    errors = []
    for kind, factors in value.items():
        if kind not in ("character", "particles") or not isinstance(factors, dict):
            errors.append(f"lighting.lightFactors.{kind} 须为 character / particles 的倍率对象")
            continue
        for key, val in factors.items():
            hi = 1 if key == "eChroma" else 64
            if key not in ("indirectFactor", "directFactor", "totalFactor", "eChroma"):
                errors.append(f"lighting.lightFactors.{kind} 不认识的键 {key}")
            elif isinstance(val, bool) or not isinstance(val, (float, int)) or not math.isfinite(val) or not 0 <= val <= hi:
                errors.append(f"lighting.lightFactors.{kind}.{key} 须为 0..{hi} 的有限数")
    return errors
