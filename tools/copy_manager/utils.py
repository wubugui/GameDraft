"""Shared utilities: JSON read/write, path helpers."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    """Read and parse a JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any, *, indent: int = 2) -> None:
    """Write data as formatted JSON with UTF-8 encoding."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
        f.write("\n")


def backup_file(path: Path) -> Path:
    """Create a .bak copy of a file. Returns the backup path."""
    bak = path.with_suffix(path.suffix + ".bak")
    bak.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    return bak


def project_relative(full_path: Path, project_root: Path) -> str:
    """Return a forward-slash relative path string."""
    try:
        return str(full_path.relative_to(project_root)).replace("\\", "/")
    except ValueError:
        return str(full_path).replace("\\", "/")


def resolve_path(rel_path: str, project_root: Path) -> Path:
    """Resolve a relative path string against the project root."""
    return project_root / rel_path
