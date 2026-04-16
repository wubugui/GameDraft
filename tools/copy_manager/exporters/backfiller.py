"""Backfiller: writes optimized source text back to original files.

SAFETY GUARANTEE: This backfiller NEVER modifies data structure.
It only replaces existing string values with new string values.
A .bak backup is created before ANY write.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.copy_manager.exporters.json_exporter import _parse_field_path
from tools.copy_manager.utils import backup_file, read_json, write_json


class Backfiller:
    """Writes modified source_text entries back to the original JSON/Ink files.

    Safety rules:
    1. Creates a .bak backup before touching any file
    2. Only replaces values that are already strings
    3. Never adds, removes, or renames keys
    4. For Ink files, only replaces the text portion of a line (preserves leading whitespace)
    5. If a target path cannot be resolved, the entry is silently skipped
    """

    def __init__(self, project_root: Path):
        self.project_root = project_root

    def backfill(self, entries: list[dict]) -> dict[str, Path]:
        """Backfill modified entries to their source files.

        Returns dict of {file_path: backup_path} for files that were modified.
        """
        # Group entries by file
        by_file: dict[str, list[dict]] = {}
        for entry in entries:
            fp = entry.get("file_path", "")
            if fp.endswith(".ink"):
                by_file.setdefault(fp, []).append(entry)
            elif fp.endswith(".json"):
                by_file.setdefault(fp, []).append(entry)

        results: dict[str, Path] = {}

        for file_path, file_entries in by_file.items():
            if file_path.endswith(".json"):
                backup = self._backfill_json(file_path, file_entries)
            elif file_path.endswith(".ink"):
                backup = self._backfill_ink(file_path, file_entries)
            else:
                continue
            if backup:
                results[file_path] = backup

        return results

    def _backfill_json(self, file_path: str, entries: list[dict]) -> Path | None:
        """Backfill text entries to a JSON file."""
        full_path = self.project_root / file_path
        if not full_path.exists():
            return None

        data = read_json(full_path)
        modified = False

        for entry in entries:
            field_path = entry.get("field_path", "")
            new_text = entry.get("source_text", "")
            if _set_json_value_safe(data, field_path, new_text):
                modified = True

        if not modified:
            return None

        # Backup before writing
        backup = backup_file(full_path)
        write_json(full_path, data)
        return backup

    def _backfill_ink(self, file_path: str, entries: list[dict]) -> Path | None:
        """Backfill text entries to an Ink source file by line number."""
        full_path = self.project_root / file_path
        if not full_path.exists():
            return None

        lines = full_path.read_text(encoding="utf-8").split("\n")
        modified = False

        for entry in entries:
            fp = entry.get("field_path", "")  # "knot:knot_name, line:42"
            new_text = entry.get("source_text", "")

            # Parse line number from field_path
            line_match = fp.split("line:")
            if len(line_match) < 2:
                continue
            try:
                line_no = int(line_match[-1].strip().split(",")[0])
            except (ValueError, IndexError):
                continue

            idx = line_no - 1  # 0-based
            if 0 <= idx < len(lines):
                original_stripped = lines[idx].strip()
                if original_stripped != new_text:
                    # Preserve leading whitespace
                    original = lines[idx]
                    leading = original[:len(original) - len(original.lstrip())]
                    lines[idx] = leading + new_text
                    modified = True

        if not modified:
            return None

        backup = backup_file(full_path)
        full_path.write_text("\n".join(lines), encoding="utf-8")
        return backup


def _set_json_value_safe(data: Any, field_path: str, value: str) -> bool:
    """Set a value in a JSON structure by field path. Returns True if modified.

    Safety: Only replaces if the existing value is a string.
    """
    if not field_path or not data:
        return False

    steps = _parse_field_path(field_path)
    if not steps:
        return False

    # We need to track whether we actually modified something
    # Use a wrapper to detect changes
    return _navigate_and_set_with_result(data, steps, value)


def _navigate_and_set_with_result(
    data: Any, steps: list[tuple[str, str | None]], value: str
) -> bool:
    """Navigate through the data structure following steps, then set the final value.

    Returns True if a value was actually modified.

    Safety: Only replaces existing string values. Never creates new keys.
    """
    current = data

    for i, (key, id_or_idx) in enumerate(steps):
        is_last = (i == len(steps) - 1)

        if isinstance(current, dict):
            if key not in current:
                return False
            if is_last:
                if isinstance(current[key], str) and current[key] != value:
                    current[key] = value
                    return True
                return False
            current = current[key]
            # If the value is an array, use id_or_idx to find the right item
            if isinstance(current, list) and id_or_idx is not None:
                found = _find_in_array(current, id_or_idx)
                if found is None:
                    return False
                current = found

        elif isinstance(current, list):
            if id_or_idx is None:
                return False
            item = _find_in_array(current, id_or_idx)
            if item is None:
                return False
            current = item

        else:
            return False

    return False


def _find_in_array(arr: list, id_or_idx: str) -> Any | None:
    """Find an item in an array by id string or numeric index."""
    # Try id match
    for item in arr:
        if isinstance(item, dict) and str(item.get("id", "")) == id_or_idx:
            return item

    # Try numeric index
    try:
        idx = int(id_or_idx)
        if 0 <= idx < len(arr):
            return arr[idx]
    except (ValueError, TypeError):
        pass

    return None
