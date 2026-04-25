"""浏览器元数据与状态：收藏、标签、布局。不修改素材文件本体。"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _editor_dir() -> Path:
    p = _repo_root() / "editor_data"
    p.mkdir(parents=True, exist_ok=True)
    return p


STATE_PATH = _editor_dir() / "asset_browser_state.json"
METADATA_PATH = _editor_dir() / "asset_browser_metadata.json"
OPS_LOG_PATH = _editor_dir() / "asset_browser_ops.jsonl"


@dataclass
class BrowserState:
    splitter_h: list[int] = field(default_factory=lambda: [280, 560, 420])
    splitter_v_fav: list[int] = field(default_factory=lambda: [200, 400])
    view_mode: str = "grid"  # grid | table
    thumb_size: int = 96
    last_dir: str = ""
    favorites: list[str] = field(default_factory=list)
    recent_dirs: list[str] = field(default_factory=list)
    window_x: int | None = None
    window_y: int | None = None
    window_w: int = 1280
    window_h: int = 800
    filter_type: str = "all"
    search: str = ""
    search_recursive: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "splitter_h": self.splitter_h,
            "splitter_v_fav": self.splitter_v_fav,
            "view_mode": self.view_mode,
            "thumb_size": self.thumb_size,
            "last_dir": self.last_dir,
            "favorites": self.favorites,
            "recent_dirs": self.recent_dirs[:30],
            "window": {
                "x": self.window_x,
                "y": self.window_y,
                "w": self.window_w,
                "h": self.window_h,
            },
            "filter_type": self.filter_type,
            "search": self.search,
            "search_recursive": self.search_recursive,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "BrowserState":
        w = d.get("window") or {}
        return cls(
            splitter_h=d.get("splitter_h") or [280, 560, 420],
            splitter_v_fav=d.get("splitter_v_fav") or [200, 400],
            view_mode=d.get("view_mode") or "grid",
            thumb_size=int(d.get("thumb_size") or 96),
            last_dir=d.get("last_dir") or "",
            favorites=list(d.get("favorites") or []),
            recent_dirs=list(d.get("recent_dirs") or []),
            window_x=w.get("x"),
            window_y=w.get("y"),
            window_w=int(w.get("w") or 1280),
            window_h=int(w.get("h") or 800),
            filter_type=d.get("filter_type") or "all",
            search=d.get("search") or "",
            search_recursive=bool(d.get("search_recursive", False)),
        )


@dataclass
class AssetMetadata:
    """路径 -> 标签（相对仓库的路径键，统一 posix）。"""

    tags: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"tags": self.tags}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AssetMetadata":
        t = d.get("tags") or {}
        return cls(tags={str(k): list(v) for k, v in t.items() if isinstance(v, list)})


def load_state() -> BrowserState:
    if not STATE_PATH.is_file():
        st = BrowserState()
        st.last_dir = str(_repo_root())
        return st
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        st = BrowserState.from_dict(d if isinstance(d, dict) else {})
        if not st.last_dir or not os.path.isdir(st.last_dir):
            st.last_dir = str(_repo_root())
        return st
    except (json.JSONDecodeError, OSError):
        st = BrowserState()
        st.last_dir = str(_repo_root())
        return st


def save_state(st: BrowserState) -> None:
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(st.to_dict(), f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def load_metadata() -> AssetMetadata:
    if not METADATA_PATH.is_file():
        return AssetMetadata()
    try:
        with open(METADATA_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return AssetMetadata.from_dict(d if isinstance(d, dict) else {})
    except (json.JSONDecodeError, OSError):
        return AssetMetadata()


def save_metadata(m: AssetMetadata) -> None:
    try:
        with open(METADATA_PATH, "w", encoding="utf-8") as f:
            json.dump(m.to_dict(), f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def norm_key(path: str) -> str:
    try:
        return str(Path(path).resolve().as_posix())
    except OSError:
        return path


def append_op_log(
    op: str, items: list[str], ok: list[str], failed: list[tuple[str, str]]
) -> None:
    rec = {
        "op": op,
        "items": items,
        "ok": ok,
        "failed": [{"path": a, "error": b} for a, b in failed],
    }
    try:
        with open(OPS_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
