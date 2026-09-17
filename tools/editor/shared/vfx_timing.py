"""Timing shape gate shared by the workbench and project validator (runtime: vfxSim.ts)."""
import math


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timing_problems(doc: dict) -> list[str]:
    errors = []
    if "prewarmSeconds" in doc:
        warm = doc["prewarmSeconds"]
        if not (isinstance(warm, list) and len(warm) == 2 and all(_finite(v) for v in warm)
                and 0 <= warm[0] <= warm[1] <= 15):
            errors.append("prewarmSeconds 必须为 0..15 秒的有序范围")
    emitters = doc.get("emitters")
    for e in emitters if isinstance(emitters, list) else []:
        sp = e.get("spawn") if isinstance(e, dict) else None
        if isinstance(sp, dict) and "intervalJitter" in sp:
            v = sp["intervalJitter"]
            if not _finite(v) or not 0 <= v <= 0.95:
                errors.append(f"{e.get('id')}: spawn.intervalJitter 必须为 0..0.95")
    return errors
