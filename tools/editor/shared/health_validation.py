"""三把火形状/数值校验，纯数据；保存门与动作校验共用。"""
from __future__ import annotations
import math


def _number(value, *, minimum=0, positive=False, maximum=None):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and (value > minimum if positive else value >= minimum)
            and (maximum is None or value <= maximum))


def health_action_errors(kind: str, params: dict) -> list[str]:
    errors = []
    if not isinstance(kind, str) or kind not in {"setMaxHealth", "lockHealth", "unlockHealth", "inflictHealthDamage", "applyHealthProtection", "removeHealthProtection", "setRetryCheckpoint"}:
        return errors
    if kind in {"lockHealth", "unlockHealth", "applyHealthProtection", "removeHealthProtection", "setRetryCheckpoint"}:
        if not isinstance(params.get("id"), str) or not params["id"].strip():
            errors.append("id 必须是非空名称")
    if kind in {"setMaxHealth", "inflictHealthDamage"}:
        if not _number(params.get("amount"), positive=kind == "setMaxHealth"):
            errors.append("amount 须为正有限数" if kind == "setMaxHealth" else "amount 须为非负有限数")
    if kind == "lockHealth":
        if "min" not in params and "max" not in params:
            errors.append("至少指定 min 或 max")
        for key in ("min", "max"):
            if key in params and not _number(params[key]):
                errors.append(f"{key} 须为非负有限数")
        if _number(params.get("min")) and _number(params.get("max")) and params["min"] > params["max"]:
            errors.append("min 不得大于 max")
        if "scope" in params and params["scope"] not in ("scene", "persistent", ""):
            errors.append("scope 只能为 scene 或 persistent")
    if kind == "inflictHealthDamage":
        if params.get("kind") not in ("yin", "fright"):
            errors.append("kind 须为 yin 或 fright")
        if not isinstance(params.get("sourceId"), str) or not params["sourceId"].strip():
            errors.append("sourceId 须为非空伤害来源名称")
    if kind == "applyHealthProtection":
        if not _number(params.get("seconds"), positive=True):
            errors.append("seconds 须为正有限数（游戏内秒数）")
        if "reduction" in params and not _number(params["reduction"], maximum=1):
            errors.append("reduction 须在 0 到 1 之间")
        if "maxHealthBonus" in params and not _number(params["maxHealthBonus"]):
            errors.append("maxHealthBonus 须为非负有限数")
        if params.get("kind", "") not in ("", "yin", "fright"):
            errors.append("kind 只能为 yin、fright 或留空")
    return [f"{kind}: {error}" for error in errors]


def health_config_errors(config) -> list[str]:
    if not isinstance(config, dict):
        return ["health 须为对象"]
    errors = []
    fire = config.get("fireProtection")
    if "fireProtection" in config:
        if not isinstance(fire, dict):
            errors.append("health.fireProtection 须为对象")
        else:
            ids = fire.get("heldPropIds", [])
            if not isinstance(ids, list) or any(not isinstance(p, str) or not p.strip() for p in ids):
                errors.append("health.fireProtection.heldPropIds 须为非空挂件 id 的数组")
            if "lossGraceSeconds" in fire and not _number(fire["lossGraceSeconds"], maximum=10):
                errors.append("health.fireProtection.lossGraceSeconds 须在 0 到 10 秒之间")
    for key in ("maxHealth", "deathThreshold", "restoreFloor"):
        if key in config and not _number(config[key], positive=key != "deathThreshold"):
            errors.append(f"health.{key} 须为{'非负' if key == 'deathThreshold' else '正'}有限数")
    maximum, threshold = config.get("maxHealth", 100), config.get("deathThreshold", 0)
    if _number(maximum) and _number(threshold) and threshold >= maximum:
        errors.append("health.deathThreshold 必须低于初始 maxHealth")
    if "retry" in config:
        if not isinstance(config["retry"], dict):
            errors.append("health.retry 须为对象")
        else:
            for key in ("title", "retryText", "menuText", "failedText", "firstDeathNoteId"):
                if key in config["retry"] and not isinstance(config["retry"][key], str):
                    errors.append(f"health.retry.{key} 须为文字")
    return errors


def health_protection_errors(value) -> list[str]:
    if not isinstance(value, dict):
        return ["healthProtection 须为对象"]
    errors = []
    if "reduction" in value and not _number(value["reduction"], maximum=1):
        errors.append("healthProtection.reduction 须在 0 到 1 之间")
    if "maxHealthBonus" in value and not _number(value["maxHealthBonus"]):
        errors.append("healthProtection.maxHealthBonus 须为非负有限数")
    if "kinds" in value and (not isinstance(value["kinds"], list) or any(k not in ("yin", "fright") for k in value["kinds"])):
        errors.append("healthProtection.kinds 须为 yin / fright 的数组")
    if "threatIds" in value and (not isinstance(value["threatIds"], list) or any(not isinstance(k, str) or not k.strip() for k in value["threatIds"])):
        errors.append("healthProtection.threatIds 须为非空威胁 id 的数组")
    return errors


def health_threat_errors(value) -> list[str]:
    if not isinstance(value, dict):
        return ["healthThreat 须为对象"]
    errors = []
    if not isinstance(value.get("id"), str) or not value["id"].strip():
        errors.append("healthThreat.id 须为非空名称")
    if value.get("kind") not in ("yin", "fright"):
        errors.append("healthThreat.kind 须为 yin 或 fright")
    for key in ("boundaryRadius", "damageRadius", "attackPerSecond"):
        if not _number(value.get(key), positive=key == "boundaryRadius"):
            errors.append(f"healthThreat.{key} 须为{'正' if key == 'boundaryRadius' else '非负'}有限数")
    for key in ("nearRadius", "nearAttackPerSecond"):
        if key in value and not _number(value[key]):
            errors.append(f"healthThreat.{key} 须为非负有限数")
    for inner, outer in (("damageRadius", "boundaryRadius"), ("nearRadius", "damageRadius")):
        if _number(value.get(inner)) and _number(value.get(outer)) and value[inner] > value[outer]:
            errors.append(f"healthThreat.{inner} 不得大于 {outer}")
    if "nearAttackPerSecond" in value and "nearRadius" not in value:
        errors.append("healthThreat.nearAttackPerSecond 需要 nearRadius")
    if "fireResponse" in value and value["fireResponse"] not in ("repelled", "ignore"):
        errors.append("healthThreat.fireResponse 须为 repelled 或 ignore")
    for key in ("nightOnly", "affectsWhenHidden", "duringPresentation", "soundOnlyMoving"):
        if key in value and not isinstance(value[key], bool):
            errors.append(f"healthThreat.{key} 须为布尔值")
    if "conditions" in value and not isinstance(value["conditions"], list):
        errors.append("healthThreat.conditions 须为条件数组")
    for key in ("enteredSignal", "repelledSignal", "leftSignal", "deathNoteId", "presenceSfx"):
        if key in value and not isinstance(value[key], str):
            errors.append(f"healthThreat.{key} 须为文字 id")
    for key, minimum, maximum in (("soundInterval", .1, None), ("soundBehindPlayer", 0, None), ("soundVolume", 0, 1)):
        if key in value and not _number(value[key], minimum=minimum, maximum=maximum):
            errors.append(f"healthThreat.{key} 数值超出范围")
    return errors


def environment_fire_errors(value) -> list[str]:
    if not isinstance(value, dict):
        return ["fireProtection 须为对象"]
    errors = []
    if not _number(value.get("radius"), positive=True):
        errors.append("fireProtection.radius 须为正有限数")
    if "requiresBurning" in value and not isinstance(value["requiresBurning"], bool):
        errors.append("fireProtection.requiresBurning 须为布尔值")
    if "conditions" in value and not isinstance(value["conditions"], list):
        errors.append("fireProtection.conditions 须为条件数组")
    return errors
