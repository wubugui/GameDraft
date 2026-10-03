"""动画 AO 默认与运行时共读一份数据；只认实际 state 名，不猜测动作别名。"""
from __future__ import annotations

import json
from pathlib import Path


_DEFAULTS_PATH = Path(__file__).resolve().parents[3] / "src" / "data" / "animationContactAoDefaults.json"
_ENABLED_STATES = frozenset(json.loads(_DEFAULTS_PATH.read_text(encoding="utf-8"))["enabledStates"])


def animation_contact_ao_enabled(name: str, state: dict | None = None) -> bool:
    value = state.get("contactAoEnabled") if isinstance(state, dict) else None
    return value if isinstance(value, bool) else name in _ENABLED_STATES
