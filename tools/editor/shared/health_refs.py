"""三把火组件的结构签名；目录、级联重构、xref 共用，零 Qt 依赖。"""
HEALTH_THREAT_SIGNALS = {
    "enteredSignal": "进入阴间边界",
    "repelledSignal": "火光驱退",
    "leftSignal": "离开威胁范围",
}


def vfx_health_sources(effect):
    """与 VfxSystem.playerHarassment 同名；资产/发射器改名有引用时必须拒绝。"""
    if not isinstance(effect, dict) or not isinstance(effect.get('id'), str):
        return []
    return [(f"vfx:{effect['id']}:{e['id']}", f"{effect.get('label', effect['id'])} / {e['id']}")
            for e in effect.get('emitters', []) if isinstance(e, dict) and isinstance(e.get('id'), str)
            and isinstance(e.get('behavior'), dict) and isinstance(e['behavior'].get('harassment'), dict)]


def health_reference_fields(node, *, threat_only=False):
    """仅引用，不把定义或同名台词算进来。"""
    if isinstance(node, dict):
        params = node.get('params')
        fields = {'applyHealthProtection': 'threatId'} if threat_only else {'applyHealthProtection': 'threatId', 'unlockHealth': 'id', 'removeHealthProtection': 'id'}
        field = fields.get(node.get('type')) if isinstance(node.get('type'), str) else None
        if field and isinstance(params, dict) and isinstance(params.get(field), str):
            yield params, field, params[field]
        protection = node.get('healthProtection')
        ids = protection.get('threatIds') if isinstance(protection, dict) else None
        if isinstance(ids, list):
            for index, value in enumerate(ids):
                if isinstance(value, str):
                    yield ids, index, value
        for value in node.values():
            yield from health_reference_fields(value, threat_only=threat_only)
    elif isinstance(node, list):
        for value in node:
            yield from health_reference_fields(value, threat_only=threat_only)


def health_signal_fields(node):
    threat = node.get("healthThreat") if isinstance(node, dict) else None
    if isinstance(threat, dict):
        for key in HEALTH_THREAT_SIGNALS:
            value = threat.get(key)
            if isinstance(value, str) and value.strip():
                yield threat, key, value.strip()


def survival_ranges(entity):
    """两个场景画布共用；半径是场景坐标，不再乘实体缩放或透视。"""
    import math
    result = []
    threat, fire = entity.get("healthThreat"), entity.get("fireProtection")
    for block, key, label, color in (
        (threat, "boundaryRadius", "过界", "#c99bff"),
        (threat, "damageRadius", "侵袭", "#ffad62"),
        (threat, "nearRadius", "近身侵袭", "#ff657a"),
        (fire, "radius", "火光保护", "#72df9b"),
    ):
        radius = block.get(key) if isinstance(block, dict) else None
        if isinstance(radius, (float, int)) and not isinstance(radius, bool) and math.isfinite(radius) and radius > 0:
            result.append((float(radius), label, color))
    return result
