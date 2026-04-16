"""JSON scanner: extracts translatable text from all JSON config files."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.copy_manager.constants import (
    CATEGORY_LABELS,
    FILE_TYPE_LABELS,
    JSON_EXTRACTION_RULES,
    NESTED_EXTRACTION_RULES,
)
from tools.copy_manager.scanner.base import BaseScanner, TextEntry, find_entry_id, is_translatable_text, make_uid
from tools.copy_manager.utils import read_json


class JsonScanner(BaseScanner):
    """Scans JSON data files for translatable text."""

    @property
    def name(self) -> str:
        return "JSON Config Files"

    def scan(self, project_root: Path) -> list[TextEntry]:
        entries: list[TextEntry] = []

        # 1. Scan strings.json (special case — already a key-value table)
        strings_path = project_root / "public/assets/data/strings.json"
        if strings_path.exists():
            entries.extend(self._scan_strings(strings_path, project_root))

        # 2. Scan each configured JSON file
        for rel_path, rule in JSON_EXTRACTION_RULES.items():
            full_path = project_root / rel_path
            if not full_path.exists():
                continue

            data = read_json(full_path)
            file_rel = rel_path.replace("\\", "/")

            # Determine if it's a dict (like rules.json) or array (like quests.json)
            if isinstance(data, dict):
                # For rules.json: top-level keys like "rules", "fragments" are arrays
                if "rules" in data and isinstance(data["rules"], list):
                    entries.extend(self._scan_array(
                        data["rules"], rel_path, file_rel, project_root, rule,
                        array_key="rules"
                    ))
                if "fragments" in data and isinstance(data["fragments"], list):
                    entries.extend(self._scan_array(
                        data["fragments"], rel_path, file_rel, project_root, rule,
                        array_key="fragments"
                    ))
                # For lore.json: entries is nested
                if "entries" in data and isinstance(data["entries"], list):
                    entries.extend(self._scan_array(
                        data["entries"], rel_path, file_rel, project_root, rule,
                        array_key="entries"
                    ))
            elif isinstance(data, list):
                # For top-level arrays (quests.json, items.json, etc.), use category as prefix
                entries.extend(self._scan_array(
                    data, rel_path, file_rel, project_root, rule,
                    array_key=rule.category
                ))

            # 3. Handle nested extraction rules (sub-arrays like options, fragments, etc.)
            if rel_path in NESTED_EXTRACTION_RULES:
                for sub_path, sub_fields in NESTED_EXTRACTION_RULES[rel_path]:
                    entries.extend(self._scan_nested_array(
                        data, rel_path, file_rel, project_root, sub_path, sub_fields,
                        rule.category
                    ))

        return entries

    def _scan_strings(self, path: Path, project_root: Path) -> list[TextEntry]:
        """Scan strings.json — already structured as {category: {key: text}}."""
        entries = []
        data = read_json(path)
        file_rel = str(path.relative_to(project_root)).replace("\\", "/")

        for category, keys in data.items():
            if not isinstance(keys, dict):
                continue
            for key, text in keys.items():
                if not is_translatable_text(text):
                    continue
                uid = make_uid("json_strings", file_rel, f"strings.{category}.{key}")
                entries.append(TextEntry(
                    uid=uid,
                    source_text=str(text),
                    file_path=file_rel,
                    field_path=f"strings.{category}.{key}",
                    file_type="json_strings",
                    category="ui",
                    tags=[f"category:{category}"],
                ))
        return entries

    def _scan_array(
        self,
        items: list[dict],
        rel_path: str,
        file_rel: str,
        project_root: Path,
        rule: Any,
        array_key: str,
    ) -> list[TextEntry]:
        """Scan a top-level array of objects for text fields."""
        entries = []
        prefix = array_key

        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue

            entry_id = find_entry_id(item, "id", i)
            tags: list[str] = []
            if rule.tags_from_id:
                tags.append(f"{rule.tags_from_id}:{entry_id}")

            for field_name in rule.fields:
                value = item.get(field_name)
                if not is_translatable_text(value):
                    continue

                field_path = f"{prefix}[{entry_id}].{field_name}"
                uid = make_uid(f"json_{rule.category}", file_rel, field_path)
                entries.append(TextEntry(
                    uid=uid,
                    source_text=str(value),
                    file_path=file_rel,
                    field_path=field_path,
                    file_type=f"json_{rule.category}",
                    category=rule.category,
                    tags=tags,
                ))
        return entries

    def _scan_nested_array(
        self,
        data: Any,
        rel_path: str,
        file_rel: str,
        project_root: Path,
        sub_path: str,
        fields: list[str],
        category: str,
    ) -> list[TextEntry]:
        """Scan nested arrays like encounters.options[*], rules.fragments[*], etc."""
        entries = []

        # Navigate to the parent array
        if sub_path.startswith("pages.entries"):
            # Handle books → pages → entries
            items = self._get_items_from_nested(data, ["pages", "entries"])
            sub_prefix = "pages"
        elif "." in sub_path:
            parts = sub_path.split(".")
            items = self._get_items_from_nested(data, parts[:-1])
            sub_prefix = parts[-1]
        else:
            if isinstance(data, dict):
                items = data.get(sub_path, [])
            else:
                items = self._get_sub_array(data, sub_path)
            sub_prefix = sub_path

        if not isinstance(items, list):
            return entries

        # For top-level array items (like encounters), each item has its own id
        top_level_array = self._get_top_level_array(data)
        for ti, top_item in enumerate(top_level_array or []):
            if not isinstance(top_item, dict):
                continue
            top_id = find_entry_id(top_item, "id", ti)

            # Get the sub-array for this top item
            if "." in sub_path:
                # e.g. "pages.entries" → get top_item["pages"], then each page["entries"]
                sub_items = self._get_sub_items_from_nested(top_item, sub_path)
            else:
                sub_items = top_item.get(sub_path, [])

            if not isinstance(sub_items, list):
                continue

            for si, sub_item in enumerate(sub_items):
                if not isinstance(sub_item, dict):
                    continue

                sub_id = find_entry_id(sub_item, "id", si)

                for field_name in fields:
                    value = sub_item.get(field_name)
                    if not is_translatable_text(value):
                        continue

                    field_path = f"{sub_prefix}[{top_id}][{sub_id}].{field_name}"
                    uid = make_uid(f"json_{category}", file_rel, field_path)
                    entries.append(TextEntry(
                        uid=uid,
                        source_text=str(value),
                        file_path=file_rel,
                        field_path=field_path,
                        file_type=f"json_{category}",
                        category=category,
                        tags=[f"{category}_id:{top_id}", f"sub_index:{sub_id}"],
                    ))

        return entries

    def _get_sub_array(self, data: Any, key: str) -> list:
        """Get a sub-array from data. Handles both dict and array inputs."""
        if isinstance(data, dict):
            return data.get(key, [])
        result = []
        for item in data:
            if isinstance(item, dict) and key in item:
                val = item[key]
                if isinstance(val, list):
                    result.extend(val)
        return result

    def _get_top_level_array(self, data: Any) -> list | None:
        """Get the top-level array from data (handles both direct array and dict-wrapped)."""
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            # Try common array keys
            for key in ("rules", "fragments", "entries", "scenarios", "items"):
                if key in data and isinstance(data[key], list):
                    return data[key]
        return None

    def _get_items_from_nested(self, data: Any, path_parts: list[str]) -> list:
        """Navigate to deeply nested items. E.g. books → pages → entries."""
        current = data
        for part in path_parts:
            if isinstance(current, dict):
                current = current.get(part, [])
            elif isinstance(current, list):
                # Flatten: collect all sub-items from each array element
                result = []
                for item in current:
                    if isinstance(item, dict) and part in item:
                        result.append(item[part])
                current = result
        return current if isinstance(current, list) else []

    def _get_sub_items_from_nested(self, top_item: dict, sub_path: str) -> list:
        """Get sub-items from a nested path within a single top-level item.
        E.g. for "pages.entries", get top_item["pages"], then collect all entries."""
        parts = sub_path.split(".")
        current = top_item
        for i, part in enumerate(parts):
            if isinstance(current, dict):
                current = current.get(part, [])
            elif isinstance(current, list):
                # For "pages.entries", we have a list of pages, need to get all entries
                result = []
                for item in current:
                    if isinstance(item, dict) and part in item:
                        result.append(item[part])
                current = result
        # If we went through an intermediate array (like pages), flatten the result
        if isinstance(current, list) and current and isinstance(current[0], list):
            flattened = []
            for sublist in current:
                if isinstance(sublist, list):
                    flattened.extend(sublist)
                else:
                    flattened.append(sublist)
            return flattened
        return current if isinstance(current, list) else []
