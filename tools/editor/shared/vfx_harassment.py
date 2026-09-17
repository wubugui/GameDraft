"""群体近身侵扰数值闸门：工作台与全工程校验共用。"""
import math


def harassment_errors(value):
    if not isinstance(value, dict):
        return ["harassment 须为对象"]
    errors = []
    for key in ("radius", "height", "attackPerSecond"):
        v = value.get(key)
        if (not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
                or v < 0 or (key == "radius" and v == 0)):
            errors.append(f"harassment.{key} 须为{'正' if key == 'radius' else '非负'}有限数")
    return errors
