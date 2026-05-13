"""节奏曲线：加载 pacing profile，计算每周张力系数。"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import yaml

from tools.chronicle_sim_v2.paths import DATA_DIR


def load_pacing_profile(profile_id: str) -> dict[str, Any]:
    path = DATA_DIR / "pacing_profiles.yaml"
    if not path.is_file():
        return {"id": "default", "weeks": []}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    profiles = raw.get("profiles") or []
    for p in profiles:
        if p.get("id") == profile_id:
            return p
    return profiles[0] if profiles else {"id": "default", "weeks": []}


def multiplier_for_week(profile: dict[str, Any], week: int) -> float:
    weeks = profile.get("weeks") or []
    if not weeks:
        return 1.0 + 0.15 * math.sin(week / 2.0)
    for w in weeks:
        if w.get("week_start", 1) <= week <= w.get("week_end", 999):
            return float(w.get("tension", 1.0))
    return 1.0
