"""与 src/data/windGust.ts 同口径；正式校验和保存门共用。"""
from .health_validation import _number


def wind_gust_errors(params):
    errors = []
    for key, low, high, required in (("speedMultiplier", 1, 64, True), ("durationMs", 1, 60000, True),
                                    ("attackMs", 0, 60000, False), ("releaseMs", 0, 60000, False),
                                    ("volume", 0, 1, False)):
        if (required or key in params) and not _number(params.get(key), minimum=low, maximum=high):
            errors.append(f"{key} 须为 {low} 到 {high} 之间的有限数")
    duration = params.get("durationMs")
    if _number(duration, positive=True):
        attack = params.get("attackMs", min(120, duration * .1))
        release = params.get("releaseMs", min(500, duration * .25))
        if _number(attack) and _number(release) and attack + release > duration:
            errors.append("attackMs + releaseMs 不得超过 durationMs")
    if "id" in params and not isinstance(params["id"], str):
        errors.append("id 须为环境音 id")
    if "volume" in params and (not isinstance(params.get("id"), str) or not params["id"].strip()):
        errors.append("配置峰值 volume 时须选择环境音 id")
    if "wait" in params and not isinstance(params["wait"], bool):
        errors.append("wait 须为布尔值")
    return [f"sceneWindGust: {error}" for error in errors]
