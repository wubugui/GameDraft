"""Ink text parsing utilities for the dialogue editor.

Provides structured parsing of Ink files for:
- Flow graph construction (knots and diverts)
- Tag extraction and grouping
- Validation against project data
- Simulation tree building
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..project_model import ProjectModel

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

RE_KNOT = re.compile(r"^===\s*(\S+)\s*===$")
RE_DIVERT = re.compile(r"^\s*->\s*(\S+)\s*$")
RE_INLINE_DIVERT = re.compile(r"->\s*(\S+)\s*$")
RE_CHOICE = re.compile(r"^(\s*)([\+\*]+)\s*(.*)")
RE_CHOICE_BRACKET = re.compile(r"^\[([^\]]*)\]\s*(.*)")
RE_TAG_INLINE = re.compile(r"#\s*(\S+(?::[^\s#]*)*)")
RE_EXTERNAL = re.compile(r"^EXTERNAL\s+")
RE_EXTERNAL_DECL = re.compile(r"^EXTERNAL\s+(\w+)\s*\(([^)]*)\)")
RE_COND_EXTERN = re.compile(r'^\{(\w+)\("([^"]+)"\)\s*:')
RE_COND_ELSE = re.compile(r"^\s*-\s*else\s*:")
RE_COND_END = re.compile(r"^\s*\}\s*$")
RE_SPEAKER_TAG = re.compile(r"#\s*speaker:(\S+)")
RE_SPEAKER_PREFIX = re.compile(r"^([^\s:：]{1,10})\s*[:：]\s+(.+)")

# ---------------------------------------------------------------------------
# Data classes -- structural
# ---------------------------------------------------------------------------


@dataclass
class InkKnot:
    name: str
    start_line: int
    end_line: int


@dataclass
class InkTag:
    tag_type: str
    raw: str
    parts: list[str]
    line_number: int


@dataclass
class InkDivert:
    target: str
    line_number: int
    source_knot: str


# ---------------------------------------------------------------------------
# Data classes -- flow graph
# ---------------------------------------------------------------------------


@dataclass
class InkFlowNode:
    id: str
    label: str
    node_type: str
    line_number: int = 0


@dataclass
class InkFlowEdge:
    source_id: str
    target_id: str
    label: str = ""


# ---------------------------------------------------------------------------
# Data classes -- validation
# ---------------------------------------------------------------------------


@dataclass
class InkValidationIssue:
    line_number: int
    message: str
    severity: str = "error"


# ---------------------------------------------------------------------------
# Data classes -- simulation tree
# ---------------------------------------------------------------------------


@dataclass
class SimNode:
    kind: str  # 'text', 'choice_group', 'divert', 'conditional', 'tag'
    text: str = ""
    speaker: str = ""
    tags: list[str] = field(default_factory=list)
    divert_target: str = ""
    choices: list[SimChoice] = field(default_factory=list)
    condition_flag: str = ""
    true_children: list[SimNode] = field(default_factory=list)
    false_children: list[SimNode] = field(default_factory=list)
    line_number: int = 0


@dataclass
class SimChoice:
    display_text: str
    body: list[SimNode] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Ink external function registry
# ---------------------------------------------------------------------------
# Auto-discovered from src/data/inkExternals.ts (typed TS constant).
# The TS compiler validates the structure; Python parses the file at startup.


@dataclass
class InkExternalParam:
    name: str
    completion_type: str


@dataclass
class InkExternalDef:
    name: str
    params: list[InkExternalParam]


INK_EXTERNALS: dict[str, InkExternalDef] = {}

_RE_EXT_ENTRY = re.compile(r"(\w+)\s*:\s*\[(.+?)\]", re.DOTALL)
_RE_EXT_PARAM = re.compile(r"name:\s*'(\w+)'.*?completion:\s*'(\w+)'")


def discover_ink_externals(contract_file: Path) -> dict[str, InkExternalDef]:
    """Parse ``src/data/inkExternals.ts`` to build the external function registry."""
    result: dict[str, InkExternalDef] = {}
    if not contract_file.is_file():
        return result
    try:
        text = contract_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return result
    for entry_m in _RE_EXT_ENTRY.finditer(text):
        func_name = entry_m.group(1)
        params_block = entry_m.group(2)
        params: list[InkExternalParam] = []
        for pm in _RE_EXT_PARAM.finditer(params_block):
            params.append(InkExternalParam(pm.group(1), pm.group(2)))
        if params:
            result[func_name] = InkExternalDef(func_name, params)
    return result


def format_external_signature(ext: InkExternalDef) -> str:
    params = ", ".join(p.name for p in ext.params)
    return f"{ext.name}({params})"


def all_external_signatures() -> list[str]:
    return [format_external_signature(e) for e in INK_EXTERNALS.values()]


# ---------------------------------------------------------------------------
# Core parsing
# ---------------------------------------------------------------------------


def parse_knots(text: str) -> list[InkKnot]:
    lines = text.splitlines()
    knots: list[InkKnot] = []
    for i, line in enumerate(lines):
        m = RE_KNOT.match(line.strip())
        if m:
            if knots:
                knots[-1].end_line = i
            knots.append(InkKnot(name=m.group(1), start_line=i, end_line=len(lines)))
    if knots:
        knots[-1].end_line = len(lines)
    return knots


def parse_tags(text: str) -> list[InkTag]:
    tags: list[InkTag] = []
    for i, line in enumerate(text.splitlines()):
        for m in RE_TAG_INLINE.finditer(line):
            raw = m.group(1)
            parts = raw.split(":")
            first = parts[0]
            if first == "action":
                tag_type = "action"
            elif first in ("require", "speaker", "ruleHint", "cost"):
                tag_type = first
            else:
                tag_type = "other"
            tags.append(InkTag(tag_type=tag_type, raw=raw, parts=parts, line_number=i))
    return tags


def _knot_at_line(knots: list[InkKnot], ln: int) -> str:
    for k in knots:
        if k.start_line <= ln < k.end_line:
            return k.name
    return ""


def parse_diverts(text: str) -> list[InkDivert]:
    lines = text.splitlines()
    knots = parse_knots(text)
    diverts: list[InkDivert] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if RE_KNOT.match(stripped) or RE_EXTERNAL.match(stripped):
            continue
        m = RE_INLINE_DIVERT.search(stripped)
        if m:
            diverts.append(InkDivert(
                target=m.group(1), line_number=i,
                source_knot=_knot_at_line(knots, i),
            ))
    return diverts


# ---------------------------------------------------------------------------
# Flow graph
# ---------------------------------------------------------------------------


def build_flow_graph(text: str) -> tuple[list[InkFlowNode], list[InkFlowEdge]]:
    knots = parse_knots(text)
    diverts = parse_diverts(text)
    nodes: list[InkFlowNode] = []
    edges: list[InkFlowEdge] = []

    for k in knots:
        nodes.append(InkFlowNode(
            id=k.name, label=k.name,
            node_type="knot", line_number=k.start_line,
        ))

    has_end = any(d.target == "END" for d in diverts)
    if has_end:
        nodes.append(InkFlowNode(id="END", label="END", node_type="end"))

    seen: set[tuple[str, str]] = set()
    for d in diverts:
        key = (d.source_knot, d.target)
        if d.source_knot and key not in seen:
            edges.append(InkFlowEdge(source_id=d.source_knot, target_id=d.target))
            seen.add(key)

    return nodes, edges


# ---------------------------------------------------------------------------
# NPC reverse references
# ---------------------------------------------------------------------------


def extract_npc_references(
    model: ProjectModel, ink_filename: str,
) -> list[tuple[str, str, str]]:
    results: list[tuple[str, str, str]] = []
    for sid, sc in model.scenes.items():
        for npc in sc.get("npcs", []):
            df = npc.get("dialogueFile", "")
            if df:
                fname = df.rsplit("/", 1)[-1] if "/" in df else df
                if fname == ink_filename:
                    npc_id = npc.get("id") or npc.get("name") or "?"
                    knot = npc.get("dialogueKnot", "")
                    results.append((sid, str(npc_id), knot))
    return results


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_ink(text: str, model: ProjectModel | None = None) -> list[InkValidationIssue]:
    from ..shared.action_editor import ACTION_TYPES

    issues: list[InkValidationIssue] = []
    lines = text.splitlines()
    knots = parse_knots(text)
    knot_names = {k.name for k in knots}
    knot_names.add("END")

    for i, line in enumerate(lines):
        stripped = line.strip()
        ext_m = RE_EXTERNAL_DECL.match(stripped)
        if ext_m:
            func_name = ext_m.group(1)
            if func_name not in INK_EXTERNALS:
                issues.append(InkValidationIssue(
                    i, f"Unknown EXTERNAL '{func_name}' -- not registered in game runtime", "error",
                ))
            else:
                declared_params = [p.strip() for p in ext_m.group(2).split(",") if p.strip()]
                expected = INK_EXTERNALS[func_name].params
                if len(declared_params) != len(expected):
                    issues.append(InkValidationIssue(
                        i,
                        f"EXTERNAL '{func_name}' expects {len(expected)} param(s) "
                        f"({', '.join(p.name for p in expected)}), got {len(declared_params)}",
                        "error",
                    ))
            continue
        if RE_KNOT.match(stripped):
            continue
        cond_m = RE_COND_EXTERN.match(stripped)
        if cond_m:
            fn = cond_m.group(1)
            arg = cond_m.group(2)
            if fn not in INK_EXTERNALS:
                issues.append(InkValidationIssue(
                    i, f"Condition uses unregistered external '{fn}'", "warning",
                ))
            elif model:
                ext_def = INK_EXTERNALS[fn]
                if ext_def.params and ext_def.params[0].completion_type == "flag_key":
                    from ..flag_registry import validate_flag_key_loose
                    reg = model.flag_registry or {}
                    if not validate_flag_key_loose(arg, reg):
                        issues.append(InkValidationIssue(
                            i, f"Flag '{arg}' not in registry", "warning",
                        ))

        dm = RE_INLINE_DIVERT.search(stripped)
        if dm:
            target = dm.group(1)
            if target not in knot_names:
                issues.append(InkValidationIssue(
                    i, f"Divert target '{target}' not defined", "warning",
                ))

    for tag in parse_tags(text):
        if tag.tag_type == "action" and len(tag.parts) >= 2:
            act_type = tag.parts[1]
            if act_type not in ACTION_TYPES:
                issues.append(InkValidationIssue(
                    tag.line_number,
                    f"Unknown action type: '{act_type}'", "error",
                ))

        if model:
            from ..flag_registry import validate_flag_key_loose
            reg = model.flag_registry or {}
            if (tag.tag_type == "action" and len(tag.parts) >= 3
                    and tag.parts[1] == "setFlag"):
                fk = tag.parts[2]
                if not validate_flag_key_loose(fk, reg):
                    issues.append(InkValidationIssue(
                        tag.line_number,
                        f"Flag '{fk}' not in registry", "warning",
                    ))
            elif tag.tag_type == "require" and len(tag.parts) >= 2:
                fk = tag.parts[1]
                if not validate_flag_key_loose(fk, reg):
                    issues.append(InkValidationIssue(
                        tag.line_number,
                        f"Required flag '{fk}' not in registry", "warning",
                    ))

    return issues


# ---------------------------------------------------------------------------
# Simulation tree builder
# ---------------------------------------------------------------------------


def _extract_line_tags(line: str) -> list[str]:
    return [m.group(1) for m in RE_TAG_INLINE.finditer(line)]


def _strip_tags(line: str) -> str:
    return RE_TAG_INLINE.sub("", line).strip()


def _detect_speaker(line: str, tags: list[str]) -> str:
    for t in tags:
        sm = RE_SPEAKER_TAG.match(f"# {t}")
        if sm:
            return sm.group(1)
    pm = RE_SPEAKER_PREFIX.match(line)
    if pm:
        return pm.group(1)
    return ""


def parse_knot_sim_tree(
    all_lines: list[str], start: int, end: int,
) -> list[SimNode]:
    nodes: list[SimNode] = []
    i = start
    while i < end:
        raw = all_lines[i]
        stripped = raw.strip()

        if not stripped or RE_KNOT.match(stripped) or RE_EXTERNAL.match(stripped):
            i += 1
            continue

        cond_m = RE_COND_EXTERN.match(stripped)
        if cond_m:
            flag_key = cond_m.group(2)
            true_lines: list[int] = []
            false_lines: list[int] = []
            in_else = False
            j = i + 1
            while j < end:
                sl = all_lines[j].strip()
                if RE_COND_END.match(sl):
                    j += 1
                    break
                if RE_COND_ELSE.match(sl):
                    in_else = True
                    j += 1
                    continue
                if in_else:
                    false_lines.append(j)
                else:
                    true_lines.append(j)
                j += 1
            true_children = _parse_line_indices(all_lines, true_lines)
            false_children = _parse_line_indices(all_lines, false_lines)
            nodes.append(SimNode(
                kind="conditional", condition_flag=flag_key,
                true_children=true_children, false_children=false_children,
                line_number=i,
            ))
            i = j
            continue

        dm = RE_DIVERT.match(stripped)
        if dm:
            nodes.append(SimNode(
                kind="divert", divert_target=dm.group(1), line_number=i,
            ))
            i += 1
            continue

        cm = RE_CHOICE.match(raw)
        if cm:
            depth = len(cm.group(2))
            choices: list[SimChoice] = []
            while i < end:
                cm2 = RE_CHOICE.match(all_lines[i])
                if not cm2 or len(cm2.group(2)) != depth:
                    break
                choice_raw = cm2.group(3).strip()
                choice_tags = _extract_line_tags(choice_raw)
                choice_text_clean = _strip_tags(choice_raw)
                bm = RE_CHOICE_BRACKET.match(choice_text_clean)
                display = bm.group(1) if bm else choice_text_clean
                body_start = i + 1
                j = body_start
                while j < end:
                    cm3 = RE_CHOICE.match(all_lines[j])
                    if cm3 and len(cm3.group(2)) <= depth:
                        break
                    if all_lines[j].strip() and not all_lines[j][0].isspace():
                        sl = all_lines[j].strip()
                        if (RE_KNOT.match(sl) or
                                (not sl.startswith("#") and not sl.startswith("->")
                                 and not sl.startswith("{") and not sl.startswith("}")
                                 and not sl.startswith("-"))):
                            break
                    j += 1
                body = parse_knot_sim_tree(all_lines, body_start, j)
                choices.append(SimChoice(
                    display_text=display, body=body, tags=choice_tags,
                ))
                i = j
            nodes.append(SimNode(kind="choice_group", choices=choices, line_number=i))
            continue

        tags = _extract_line_tags(stripped)
        text_clean = _strip_tags(stripped)
        if text_clean:
            speaker = _detect_speaker(text_clean, tags)
            nodes.append(SimNode(
                kind="text", text=text_clean,
                speaker=speaker, tags=tags, line_number=i,
            ))
        elif tags:
            nodes.append(SimNode(kind="tag", tags=tags, line_number=i))
        i += 1

    return nodes


def _parse_line_indices(all_lines: list[str], indices: list[int]) -> list[SimNode]:
    if not indices:
        return []
    nodes: list[SimNode] = []
    for idx in indices:
        stripped = all_lines[idx].strip()
        if not stripped:
            continue
        dm = RE_DIVERT.match(stripped)
        if dm:
            nodes.append(SimNode(kind="divert", divert_target=dm.group(1), line_number=idx))
            continue
        tags = _extract_line_tags(stripped)
        text_clean = _strip_tags(stripped)
        if text_clean:
            speaker = _detect_speaker(text_clean, tags)
            nodes.append(SimNode(
                kind="text", text=text_clean,
                speaker=speaker, tags=tags, line_number=idx,
            ))
        elif tags:
            nodes.append(SimNode(kind="tag", tags=tags, line_number=idx))
    return nodes


def build_sim_tree(text: str) -> dict[str, list[SimNode]]:
    """Parse full ink text into per-knot simulation trees."""
    lines = text.splitlines()
    knots = parse_knots(text)
    result: dict[str, list[SimNode]] = {}
    for k in knots:
        result[k.name] = parse_knot_sim_tree(lines, k.start_line + 1, k.end_line)
    return result
