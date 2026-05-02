"""JSON file I/O for the GameDraft editor."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def read_json(path: Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _json_text(data: dict | list) -> str:
    txt = json.dumps(data, ensure_ascii=False, indent=2)
    if not txt.endswith("\n"):
        txt += "\n"
    return txt


def write_json(path: Path, data: dict | list) -> None:
    """Write JSON atomically via temp file + replace to avoid truncated files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = _json_text(data).encode("utf-8")
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.isfile(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def list_json_files(directory: Path, pattern: str = "*.json") -> list[Path]:
    if not directory.exists():
        return []
    return sorted(directory.glob(pattern))


