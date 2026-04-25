"""搜索、类型、标签、路径、收藏 等过滤（纯函数 + 可组合）。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

from .file_ops import rel_to_repo

# 与 fs_proxy 隐藏目录 对齐（递归遍历时跳过子目录名）
DIR_BLOCKLIST = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".vite",
        ".cursor",
        "dist",
        "build",
        "coverage",
    }
)

# 与 preview_panel 的扩展集合对齐（不导入 preview 避免循环可单独维护）
EXT_IMAGE = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga", ".jxl", ".heic",
}
EXT_VIDEO = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}
EXT_AUDIO = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"}
EXT_TEXT = {
    ".json", ".txt", ".md", ".xml", ".csv", ".ink", ".html", ".htm", ".css",
    ".ts", ".tsx", ".js", ".mjs", ".yml", ".yaml",
}
EXT_GAME_SOURCE = {".gltf", ".glb", ".fbx", ".obj", ".blend"}
EXT_JSON = {".json"}
EXT_SCENE = {".tscn", ".unity", ".uasset"}


def file_kind(path: str) -> str:
    p = Path(path)
    if p.is_dir():
        return "dir"
    s = p.suffix.lower()
    if s in EXT_IMAGE:
        return "image"
    if s in EXT_VIDEO:
        return "video"
    if s in EXT_AUDIO:
        return "audio"
    if s in EXT_TEXT or s in EXT_JSON:
        if s in EXT_JSON:
            return "json"
        return "text"
    if s in EXT_GAME_SOURCE:
        return "3d"
    if s in EXT_SCENE or "scene" in s:
        return "scene"
    return "other"


def type_filter_accepts(
    path: str, filter_id: str
) -> bool:
    f = (filter_id or "all").lower()
    if f == "all":
        return True
    k = file_kind(path)
    if f == "folders":
        return k == "dir"
    if f == "images":
        return k == "image"
    if f == "video":
        return k == "video"
    if f == "audio":
        return k == "audio"
    if f in ("text", "code"):
        return k in ("text", "json")
    if f == "json":
        return k in ("json",) or path.lower().endswith(".json")
    if f == "3d" or f == "model":
        return k == "3d"
    if f == "animation_source":
        ex = Path(path).suffix.lower()
        return ex in {".mp4", ".gif", ".apng", ".webm", ".fbx", ".gltf", ".json"}
    if f == "scene_related":
        ex = Path(path).suffix.lower()
        return ex in (EXT_SCENE | {".gltf", ".glb", ".fbx", ".tscn"})
    return True


def search_accepts(
    path: str,
    query: str,
    *,
    tags_for_path: Callable[[str], list[str]] | None = None,
) -> bool:
    q = (query or "").strip()
    if not q:
        return True
    qf = q.casefold()
    name = Path(path).name.casefold()
    if qf in name:
        return True
    try:
        if qf in rel_to_repo(path).casefold():
            return True
    except (OSError, ValueError):
        pass
    if tags_for_path is not None:
        for t in tags_for_path(path):
            if qf in t.casefold():
                return True
    return False


def build_regex_fts(query: str) -> re.Pattern[str] | None:
    q = (query or "").strip()
    if not q:
        return None
    try:
        return re.compile(re.escape(q), re.IGNORECASE)
    except re.error:
        return None
