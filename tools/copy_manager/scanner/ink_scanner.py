"""Ink scanner: extracts dialogue, choices, thoughts, and narration from .ink source files."""
from __future__ import annotations

import re
from pathlib import Path

from tools.copy_manager.scanner.base import BaseScanner, TextEntry, make_uid


# Regex patterns for Ink syntax
_KNOT_RE = re.compile(r"^===\s+(.+?)\s*===", re.MULTILINE)
_STITCH_RE = re.compile(r"^\s*===\s+(.+?)\s*$", re.MULTILINE)
_SPEAKER_RE = re.compile(r"^#\s*speaker:\s*(.+)$")
_CHOICE_RE = re.compile(r"^(\+{1,3})\s*\[(.+?)\]")
_THOUGHT_RE = re.compile(r"^@\s*:\s*(.+)$")
_NPC_SHORT_RE = re.compile(r"^%\s*:\s*(.+)$")
_COMMENT_RE = re.compile(r"^\s*(//|/\*|\*/|EXTERNAL)")
_DIVERT_RE = re.compile(r"^\s*->\s*")
_LOGIC_RE = re.compile(r"^\s*[{~}]")
_BLANK_RE = re.compile(r"^\s*$")


class InkScanner(BaseScanner):
    """Scans .ink source dialogue files for translatable text."""

    @property
    def name(self) -> str:
        return "Ink Dialogue Files"

    def scan(self, project_root: Path) -> list[TextEntry]:
        entries = []
        dialogues_dir = project_root / "public/assets/dialogues"

        if not dialogues_dir.exists():
            return entries

        for ink_file in sorted(dialogues_dir.glob("*.ink")):
            file_rel = str(ink_file.relative_to(project_root)).replace("\\", "/")
            entries.extend(self._scan_file(ink_file, file_rel, project_root))

        return entries

    def _scan_file(self, path: Path, file_rel: str, project_root: Path) -> list[TextEntry]:
        entries = []
        content = path.read_text(encoding="utf-8")
        lines = content.split("\n")

        current_knot = "root"
        current_speaker: str | None = None
        is_deprecated = False

        for line_no, line in enumerate(lines, start=1):
            stripped = line.strip()

            # Check for deprecated file marker
            if line_no <= 5 and "废弃稿" in stripped:
                is_deprecated = True

            # Knot definition (=== knot_name === or === knot_name)
            knot_match = re.match(r"^===+\s+(.+?)\s*=*\s*$", stripped)
            if knot_match:
                knot_name = knot_match.group(1).strip().rstrip("=").strip()
                if knot_name:
                    current_knot = knot_name
                    current_speaker = None
                continue

            # Skip comments, externals, and directives
            if _COMMENT_RE.match(stripped) or _DIVERT_RE.match(stripped) or _LOGIC_RE.match(stripped):
                # For comments, check for embedded speaker tag
                if stripped.startswith("//") or stripped.startswith("/*"):
                    speaker_match = _SPEAKER_RE.match(stripped.lstrip("/").strip())
                    if speaker_match:
                        current_speaker = speaker_match.group(1).strip()
                continue

            # Speaker annotation
            speaker_match = _SPEAKER_RE.match(stripped)
            if speaker_match:
                current_speaker = speaker_match.group(1).strip()
                continue

            # Skip other ink commands (# tags that aren't speaker)
            if stripped.startswith("# "):
                continue

            # Internal thought
            thought_match = _THOUGHT_RE.match(stripped)
            if thought_match:
                text = thought_match.group(1).strip()
                if text:
                    entries.append(self._make_entry(
                        "ink_thought", text, file_rel, current_knot, line_no,
                        current_speaker, is_deprecated,
                    ))
                continue

            # NPC shorthand dialogue
            npc_match = _NPC_SHORT_RE.match(stripped)
            if npc_match:
                text = npc_match.group(1).strip()
                if text:
                    entries.append(self._make_entry(
                        "ink_dialogue", text, file_rel, current_knot, line_no,
                        "%(shorthand)", is_deprecated,
                    ))
                continue

            # Choice
            choice_match = _CHOICE_RE.match(stripped)
            if choice_match:
                text = choice_match.group(2).strip()
                if text:
                    entries.append(self._make_entry(
                        "ink_choice", text, file_rel, current_knot, line_no,
                        current_speaker, is_deprecated,
                    ))
                continue

            # Blank line resets speaker context for safety
            if not stripped:
                continue

            # Bare text line (dialogue or narration)
            if current_speaker:
                entries.append(self._make_entry(
                    "ink_dialogue", stripped, file_rel, current_knot, line_no,
                    current_speaker, is_deprecated,
                ))
            elif stripped and not stripped.startswith("}") and not stripped.startswith("{"):
                # Narration (no speaker)
                entries.append(self._make_entry(
                    "ink_narration", stripped, file_rel, current_knot, line_no,
                    None, is_deprecated,
                ))

        return entries

    def _make_entry(
        self,
        file_type: str,
        text: str,
        file_rel: str,
        knot: str,
        line_no: int,
        speaker: str | None,
        is_deprecated: bool,
    ) -> TextEntry:
        field_path = f"knot:{knot}, line:{line_no}"
        uid = make_uid(file_type, file_rel, field_path)

        tags = [f"knot:{knot}", f"line:{line_no}"]
        if speaker:
            tags.append(f"speaker:{speaker}")
        if is_deprecated:
            tags.append("deprecated")

        category = "dialogue"
        if file_type in ("ink_choice",):
            category = "dialogue"

        return TextEntry(
            uid=uid,
            source_text=text,
            file_path=file_rel,
            field_path=field_path,
            file_type=file_type,
            category=category,
            tags=tags,
        )
