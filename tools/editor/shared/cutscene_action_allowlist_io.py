"""Load cutscene action allow-list from repo src/data/cutscene_action_allowlist.json (single source)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_GAME_DRAFT_ROOT = Path(__file__).resolve().parents[3]
_ALLOWLIST_JSON = _GAME_DRAFT_ROOT / "src" / "data" / "cutscene_action_allowlist.json"


@lru_cache(maxsize=1)
def load_cutscene_action_allowlist_ordered() -> tuple[str, ...]:
    raw = json.loads(_ALLOWLIST_JSON.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("cutscene_action_allowlist.json 须为字符串数组")
    out: list[str] = []
    for x in raw:
        if not isinstance(x, str) or not str(x).strip():
            raise ValueError("cutscene_action_allowlist.json 含非法条目")
        s = str(x).strip()
        if s not in out:
            out.append(s)
    return tuple(out)


def cutscene_action_allowlist_frozenset() -> frozenset[str]:
    return frozenset(load_cutscene_action_allowlist_ordered())


def cutscene_action_allowlist_first() -> str:
    t = load_cutscene_action_allowlist_ordered()
    if not t:
        raise ValueError("cutscene_action_allowlist.json 不能为空")
    return t[0]
