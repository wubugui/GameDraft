"""从 data/private_llm_defaults.json 读取本地默认 LLM 配置（勿提交该 JSON）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim.paths import DATA_DIR

_PRIVATE_PATH = DATA_DIR / "private_llm_defaults.json"


def private_llm_defaults_file() -> Path:
    return _PRIVATE_PATH


def load_private_llm_defaults() -> dict[str, Any]:
    if not _PRIVATE_PATH.is_file():
        return {}
    try:
        raw = json.loads(_PRIVATE_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}
