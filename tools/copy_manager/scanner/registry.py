"""RegistryManager: load, save, merge text entries with idempotent behavior."""
from __future__ import annotations

import json
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
                # If source text changed, mark as pending but keep notes
                if old.get("source_text") != entry.source_text:
                    if entry_dict["status"] not in ("pending",):
                        entry_dict["status"] = "pending"
            else:
                new_uids.append(entry.uid)

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
