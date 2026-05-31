"""Small report persistence helpers for the production workbench."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from tools.editor.shared.project_paths import ProjectPaths


def workbench_reports_root(project_root: Path) -> Path:
    return ProjectPaths(project_root.resolve()).editor_data_root / "production_workbench" / "reports"


def save_workbench_report(project_root: Path, category: str, text: str) -> Path:
    """Persist a human-readable report and return its path."""
    clean_text = str(text or "").strip()
    if not clean_text:
        raise ValueError("report text is empty")
    root = workbench_reports_root(project_root)
    root.mkdir(parents=True, exist_ok=True)
    stem = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{_safe_name(category)}"
    path = root / f"{stem}.txt"
    suffix = 1
    while path.exists():
        suffix += 1
        path = root / f"{stem}-{suffix}.txt"
    path.write_text(clean_text + "\n", encoding="utf-8")
    return path


def _safe_name(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
    return text or "report"
