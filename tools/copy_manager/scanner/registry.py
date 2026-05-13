"""RegistryManager: load, save, merge text entries with idempotent behavior."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from tools.copy_manager.scanner.base import TextEntry
from tools.copy_manager.utils import read_json, write_json


class RegistryManager:
    """Manages the copy-manager registry file."""

    def __init__(self, registry_path: Path):
        self.registry_path = registry_path
        self.data: dict[str, Any] = {"version": 1, "languages": [], "entries": [], "orphans": []}
        self._dirty = False

    def load(self) -> None:
        """Load registry from disk if it exists."""
        if self.registry_path.exists():
            self.data = read_json(self.registry_path)
        else:
            self.data = {"version": 1, "languages": [], "entries": [], "orphans": []}
        # Backfill missing group fields on existing entries
        if self._migrate_group_fields():
            self.save()  # Persist migration immediately

    def _migrate_group_fields(self) -> None:
        """Backfill group_id/group_label/field_label for entries missing them."""
        updated = False
        for entry in self.data.get("entries", []):
            if not entry.get("group_id"):
                gid, label = self._derive_group_info(entry)
                entry["group_id"] = gid
                entry["group_label"] = label
                # Derive field_label from field_path
                fp = entry.get("field_path", "")
                if "." in fp:
                    entry["field_label"] = fp.rsplit(".", 1)[-1]
                elif ":" in fp:
                    entry["field_label"] = fp.split(":")[0]
                else:
                    entry["field_label"] = fp
                updated = True
        if updated:
            self._dirty = True

    @staticmethod
    def _derive_group_info(entry: dict) -> tuple[str, str]:
        """Derive group_id and group_label from uid for old entries."""
        uid = entry.get("uid", "")
        parts = uid.split(":", 2)
        if len(parts) < 3:
            ft = entry.get("file_type", "ungrouped")
            return ft, ft

        ft_prefix = parts[0]
        uid_fp = parts[2]

        # Extract first bracket id
        first_id = None
        m = re.search(r"\[([^\]]+)\]", uid_fp)
        if m:
            first_id = m.group(1)

        if ft_prefix.startswith("json_"):
            cat = ft_prefix.replace("json_", "")
            if first_id:
                if uid_fp.startswith("archive.characters"):
                    return f"archive[{first_id}]", first_id
                return f"{cat}[{first_id}]", first_id
        elif ft_prefix.startswith("ink_"):
            if uid_fp.startswith("knot:"):
                knot_name = uid_fp.split(",")[0].split(":", 1)[1].strip() if ":" in uid_fp else "root"
                return f"ink:{knot_name}", knot_name
        elif ft_prefix.startswith("cutscenes"):
            if uid_fp.startswith("cutscenes["):
                m2 = re.match(r"^cutscenes\[([^\]]+)\]", uid_fp)
                if m2:
                    return f"cutscenes[{m2.group(1)}]", m2.group(1)

        # strings.json
        if uid_fp.startswith("strings."):
            cat_parts = uid_fp.split(".")
            if len(cat_parts) >= 2:
                cat = cat_parts[1]
                return f"strings.{cat}", cat

        gid = ft_prefix.replace("json_", "").replace("ink_", "").replace("cutscenes_", "")
        return gid or "ungrouped", gid or "ungrouped"

    def save(self) -> None:
        """Save registry to disk."""
        write_json(self.registry_path, self.data)
        self._dirty = False

    @property
    def languages(self) -> list[str]:
        return self.data.get("languages", [])

    @languages.setter
    def languages(self, value: list[str]) -> None:
        self.data["languages"] = value
        self._dirty = True

    def get_entries(self) -> list[TextEntry]:
        return [TextEntry.from_dict(d) for d in self.data.get("entries", [])]

    def get_entry_map(self) -> dict[str, TextEntry]:
        return {e.uid: e for e in self.get_entries()}

    def merge_entries(self, scanned: list[TextEntry]) -> list[str]:
        """Merge scanned entries with existing registry data.

        Returns list of new UIDs that were added.
        """
        existing_map = {d["uid"]: d for d in self.data.get("entries", [])}
        scanned_uids = {e.uid for e in scanned}
        new_uids: list[str] = []
        now = time.time()

        for entry in scanned:
            entry.scanned_at = now
            entry_dict = entry.to_dict()

            if entry.uid in existing_map:
                old = existing_map[entry.uid]
                # Preserve manual edits
                entry_dict["context_notes"] = old.get("context_notes", "")
                entry_dict["translations"] = old.get("translations", {})
                entry_dict["status"] = old.get("status", "pending")

                # Source text: if user has edited it (source_text != original_source_text),
                # preserve user's version. Otherwise use scanned version.
                old_original = old.get("original_source_text", old.get("source_text", ""))
                old_source = old.get("source_text", "")
                # User edited if current source differs from what was last scanned
                if old_source != old_original:
                    # Keep user's edited source_text, but record new scan as original
                    # so we can detect future game changes
                    entry_dict["source_text"] = old_source
                    entry_dict["original_source_text"] = entry.source_text
                else:
                    # User hasn't edited; update to scanned value
                    entry_dict["original_source_text"] = entry.source_text
                    # If source changed from what user last saw, mark as pending
                    if old_source != entry.source_text:
                        entry_dict["status"] = "pending"
            else:
                new_uids.append(entry.uid)
                entry_dict["original_source_text"] = entry.source_text

            existing_map[entry.uid] = entry_dict

        # Find orphaned entries (in registry but no longer in scan results)
        orphaned_uids = set(existing_map.keys()) - scanned_uids
        orphans = self.data.get("orphans", [])
        orphan_uid_set = {o["uid"] for o in orphans}
        for uid in orphaned_uids:
            if uid not in orphan_uid_set:
                orphans.append({
                    "uid": uid,
                    "data": existing_map.pop(uid),
                    "preserved_at": now,
                })
        self.data["orphans"] = orphans

        self.data["entries"] = list(existing_map.values())
        self.data["scanned_at"] = now
        self._dirty = True
        return new_uids

    def update_entry(self, uid: str, updates: dict[str, Any]) -> bool:
        """Update a single entry. Returns True if found."""
        for i, d in enumerate(self.data.get("entries", [])):
            if d["uid"] == uid:
                d.update(updates)
                self._dirty = True
                return True
        return False

    def get_entry(self, uid: str) -> dict[str, Any] | None:
        for d in self.data.get("entries", []):
            if d["uid"] == uid:
                return d
        return None

    @property
    def is_dirty(self) -> bool:
        return self._dirty

    def stats(self) -> dict[str, int]:
        entries = self.data.get("entries", [])
        return {
            "total": len(entries),
            "pending": sum(1 for e in entries if e.get("status") == "pending"),
            "reviewed": sum(1 for e in entries if e.get("status") == "reviewed"),
            "translated": sum(1 for e in entries if e.get("status") == "translated"),
            "optimized": sum(1 for e in entries if e.get("status") == "optimized"),
            "orphans": len(self.data.get("orphans", [])),
        }
