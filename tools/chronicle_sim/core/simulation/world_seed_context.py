"""从 runs.world_seed 表拼出给导演/GM 用的世界观摘要（与 SeedDraft 写入一致）。"""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def load_world_bible_for_prompt(conn: sqlite3.Connection, max_chars: int = 8000) -> str:
    row = conn.execute(
        "SELECT world_setting_json, design_pillars_json, custom_sections_json FROM world_seed WHERE id = 1"
    ).fetchone()
    if not row:
        return ""

    def _obj(raw: Any, default: Any) -> Any:
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            return default
        if isinstance(raw, (dict, list)):
            return raw
        try:
            o = json.loads(raw)
            return o if isinstance(o, type(default)) else default
        except (json.JSONDecodeError, TypeError):
            return default

    ws: dict[str, Any] = _obj(row["world_setting_json"], {})
    pl: list[Any] = _obj(row["design_pillars_json"], [])
    cs: list[Any] = _obj(row["custom_sections_json"], [])
    if not isinstance(ws, dict):
        ws = {}
    if not isinstance(pl, list):
        pl = []
    if not isinstance(cs, list):
        cs = []

    chunks: list[str] = []
    if ws:
        lines = ["【世界观设定（种子）】"]
        order = [
            "title",
            "logline",
            "era_and_place",
            "tone_and_themes",
            "geography_overview",
            "social_structure",
            "supernatural_rules",
            "friction_sources",
            "player_promise",
            "raw_author_notes",
        ]
        for k in order:
            v = ws.get(k)
            if v is not None and str(v).strip():
                lines.append(f"- {k}: {v}")
        for k, v in sorted(ws.items()):
            if k in order:
                continue
            if v is not None and str(v).strip():
                lines.append(f"- {k}: {v}")
        chunks.append("\n".join(lines))

    if pl:
        lines = ["【设计支柱】"]
        for p in pl[:24]:
            if not isinstance(p, dict):
                continue
            name = p.get("name") or p.get("id") or "pillar"
            desc = (p.get("description") or "").strip()
            impl = (p.get("implications") or "").strip()
            lines.append(f"- {name}: {desc}" + (f"（推演：{impl}）" if impl else ""))
        chunks.append("\n".join(lines))

    if cs:
        lines = ["【自定义设定区块】"]
        for c in cs[:32]:
            if not isinstance(c, dict):
                continue
            title = c.get("title") or c.get("id") or "section"
            body = (c.get("body") or "").strip()
            if body:
                lines.append(f"### {title}\n{body[:2000]}")
        chunks.append("\n".join(lines))

    out = "\n\n".join(chunks).strip()
    if len(out) > max_chars:
        return out[: max_chars - 20] + "\n…（已截断）"
    return out
