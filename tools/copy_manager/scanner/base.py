"""Base scanner and TextEntry dataclass."""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class TextEntry:
    """A single piece of translatable text extracted from the project."""
    uid: str                   # Unique identifier: "{file_type}:{file_rel_path}:{field_path}"
    group_id: str              # Parent group key (e.g. "quest[opening_01]", "ink_knot:first_visit")
    group_label: str           # Human-readable group label (e.g. "听张叨叨摆书", "first_visit")
    source_text: str           # Original text content
    file_path: str             # Relative path from project root (forward slashes)
    field_path: str            # JSON pointer or ink location descriptor
    field_label: str           # Human-readable field name (e.g. "title", "对话 #3")
    file_type: str             # "json_strings" | "json_quests" | "ink_dialogue" | ...
    category: str              # "ui" | "quest" | "rule" | "item" | "dialogue" | ...
    tags: list[str] = field(default_factory=list)
    context_notes: str = ""
    status: str = "pending"    # "pending" | "reviewed" | "translated" | "optimized"
    translations: dict[str, str] = field(default_factory=dict)
    scanned_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "uid": self.uid,
            "source_text": self.source_text,
            "file_path": self.file_path,
            "field_path": self.field_path,
            "file_type": self.file_type,
            "category": self.category,
            "group_id": self.group_id,
            "group_label": self.group_label,
            "field_label": self.field_label,
            "tags": self.tags,
            "context_notes": self.context_notes,
            "status": self.status,
            "translations": self.translations,
            "scanned_at": self.scanned_at,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TextEntry":
        return cls(
            uid=d["uid"],
            source_text=d.get("source_text", ""),
            file_path=d.get("file_path", ""),
            field_path=d.get("field_path", ""),
            file_type=d.get("file_type", ""),
            category=d.get("category", ""),
            group_id=d.get("group_id", ""),
            group_label=d.get("group_label", ""),
            field_label=d.get("field_label", ""),
            tags=d.get("tags", []),
            context_notes=d.get("context_notes", ""),
            status=d.get("status", "pending"),
            translations=d.get("translations", {}),
            scanned_at=d.get("scanned_at", 0.0),
        )


class BaseScanner(ABC):
    """Abstract base for text extractors."""

    @abstractmethod
    def scan(self, project_root: Path) -> list[TextEntry]:
        """Scan files and return extracted text entries."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable scanner name."""
        ...


def make_uid(file_type: str, file_rel: str, field_path: str) -> str:
    """Create a unique entry ID."""
    return f"{file_type}:{file_rel}:{field_path}"


def find_entry_id(entry: dict[str, Any], field: str, fallback_index: int) -> str:
    """Find the 'id' field of a JSON object for stable UIDs. Returns '{id}' or '[{index}]'."""
    if "id" in entry and entry["id"]:
        return str(entry["id"])
    return str(fallback_index)


def is_translatable_text(value: Any) -> bool:
    """Check if a value looks like translatable Chinese text."""
    if not isinstance(value, str):
        return False
    s = value.strip()
    if not s:
        return False
    # Skip paths that look like asset paths
    if s.startswith(("/", "assets/", "public/")):
        return False
    return True
