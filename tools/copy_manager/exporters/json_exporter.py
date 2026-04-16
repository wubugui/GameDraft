"""JSON exporter: reconstructs translated JSON files from registry entries.

SAFETY GUARANTEE: This exporter NEVER modifies data structure.
It only replaces existing string values with translated string values.
All writes are in-memory copies of the original data — original files are untouched.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.copy_manager.utils import read_json, write_json


class JsonExporter:
    """Exports translated entries to language-specific JSON files.

    Safety rules:
    1. Only writes to a NEW directory (public/assets/data/{lang}/)
    2. Only replaces values that are already strings
    3. Never adds, removes, or renames keys
    4. Never changes numeric, boolean, array, or object values
    5. If a target path cannot be resolved, the entry is silently skipped
    """

    def __init__(self, project_root: Path):
        self.project_root = project_root

    def export(
        self,
        entries: list[dict],
        language: str,
        categories: list[str] | None = None,
    ) -> dict[str, Path]:
        """Export entries for a given language.

        Returns dict of {rel_output_path: actual_path} for files written.
        """
        if categories:
            entries = [e for e in entries if e.get("category") in categories]

        # Group entries by file_path
        by_file: dict[str, list[dict]] = {}
        for entry in entries:
            fp = entry.get("file_path", "")
            trans = entry.get("translations", {})
            if language in trans and trans[language]:
                by_file.setdefault(fp, []).append(entry)

        written: dict[str, Path] = {}

        # Handle strings.json specially — it's a {category: {key: text}} structure
        if "public/assets/data/strings.json" in by_file:
            out_path = self._export_strings(
                by_file.pop("public/assets/data/strings.json"), language
            )
            if out_path:
                written[str(out_path.relative_to(self.project_root))] = out_path

        # Handle all other files by loading original and replacing translated values
        for file_path, file_entries in by_file.items():
            out_path = self._export_file(file_path, file_entries, language)
            if out_path:
                written[str(out_path.relative_to(self.project_root))] = out_path

        return written

    def _export_strings(self, entries: list[dict], language: str) -> Path | None:
        """Export strings.json — structured as {category: {key: text}}."""
        src = self.project_root / "public/assets/data/strings.json"
        if not src.exists():
            return None

        data = read_json(src)
        for entry in entries:
            fp = entry.get("field_path", "")  # e.g. "strings.notifications.gameOver"
            trans = entry.get("translations", {}).get(language, "")
            if fp.startswith("strings."):
                parts = fp[len("strings."):].split(".", 1)
                if len(parts) == 2:
                    cat, key = parts
                    if cat in data and isinstance(data[cat], dict) and key in data[cat]:
                        # Only replace if original value is a string
                        if isinstance(data[cat][key], str):
                            data[cat][key] = trans

        out = self._output_path("public/assets/data/strings.json", language)
        write_json(out, data)
        return out

    def _export_file(
        self, file_path: str, entries: list[dict], language: str
    ) -> Path | None:
        """Export a regular JSON file with translated values."""
        src = self.project_root / file_path
        if not src.exists():
            return None

        data = read_json(src)

        for entry in entries:
            field_path = entry.get("field_path", "")
            trans = entry.get("translations", {}).get(language, "")
            _set_value_safe(data, field_path, trans)

        out = self._output_path(file_path, language)
        write_json(out, data)
        return out

    def _output_path(self, original_path: str, language: str) -> Path:
        """Compute the output path for a translated file."""
        # Strip the common prefix so we get e.g. "strings.json" not "public/assets/data/strings.json"
        prefix = "public/assets/data/"
        if original_path.startswith(prefix):
            filename = original_path[len(prefix):]
        else:
            filename = original_path.split("/")[-1]
        return self.project_root / "public/assets/data" / language / filename


def _parse_field_path(field_path: str) -> list[tuple[str, str | None]]:
    """Parse a field path into navigation steps.

    Returns list of (key_or_array_name, id_or_index).
    Examples:
        "quests[opening_01].title" -> [("quests", "opening_01"), ("title", None)]
        "items[copper_coins].dynamicDescriptions[0].text"
            -> [("items", "copper_coins"), ("dynamicDescriptions", "0"), ("text", None)]
        "rules.rules[rule_zombie_fire].name"
            -> [("rules", None), ("rules", "rule_zombie_fire"), ("name", None)]
    """
    parts: list[tuple[str, str | None]] = []
    current = ""
    i = 0
    while i < len(field_path):
        ch = field_path[i]
        if ch == ".":
            if current:
                parts.append((current, None))
                current = ""
        elif ch == "[":
            if current:
                parts.append((current, None))
                current = ""
            # Find closing bracket
            j = field_path.index("]", i)
            bracket_content = field_path[i + 1:j]
            # Last part is the array accessor, attach id/index to previous key
            if parts:
                prev_key, _ = parts[-1]
                parts[-1] = (prev_key, bracket_content)
            else:
                parts.append(("", bracket_content))
            i = j
        else:
            current += ch
        i += 1
    if current:
        parts.append((current, None))
    return parts


def _set_value_safe(data: Any, field_path: str, value: str) -> None:
    """Navigate to the target field and replace its value.

    Safety checks:
    - Only replaces if the existing value is a string
    - Only navigates through keys/arrays that actually exist
    - Silently skips if path cannot be resolved
    """
    if not field_path or not data:
        return

    steps = _parse_field_path(field_path)
    if not steps:
        return

    _navigate_and_set(data, steps, value)


def _navigate_and_set(data: Any, steps: list[tuple[str, str | None]], value: str) -> None:
    """Navigate through the data structure following steps, then set the final value.

    Each step is (key, id_or_idx). When the value at `key` is an array,
    use `id_or_idx` to find the specific item before continuing.
    """
    current = data

    for i, (key, id_or_idx) in enumerate(steps):
        is_last = (i == len(steps) - 1)

        if isinstance(current, dict):
            if key not in current:
                return  # Path doesn't exist, skip silently

            if is_last:
                # Final key: replace value only if it's a string
                if isinstance(current[key], str):
                    current[key] = value
                return

            # Navigate into the value
            current = current[key]

            # If the value is an array, use id_or_idx to find the right item
            if isinstance(current, list) and id_or_idx is not None:
                found = _find_in_array(current, id_or_idx)
                if found is None:
                    return  # Item not found
                current = found

        elif isinstance(current, list):
            # We arrived at an array from a previous step — find by id_or_idx
            if id_or_idx is None:
                return
            item = _find_in_array(current, id_or_idx)
            if item is None:
                return
            current = item

        else:
            return  # Can't navigate further (hit a scalar)


def _find_in_array(arr: list, id_or_idx: str) -> Any | None:
    """Find an item in an array by id string or numeric index.

    - First tries to match item.get("id") == id_or_idx
    - Falls back to arr[int(id_or_idx)] if id_or_idx is a valid integer
    """
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
