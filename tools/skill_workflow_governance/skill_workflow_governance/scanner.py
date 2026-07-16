from __future__ import annotations

import json
import os
import re
import shlex
from datetime import datetime
from fnmatch import fnmatch
from pathlib import Path
from typing import Iterable

from .models import Artifact, Reference


EXCLUDED_DIRS = {
    ".git",
    ".venv",
    ".tools",
    "node_modules",
    "dist",
    "build",
    ".pytest_cache",
    ".dvc",
    "tmp",
    "logs",
    "asset-backups",
    "__pycache__",
    "out",
}

TEXT_EXTS = {
    ".md",
    ".txt",
    ".json",
    ".jsonl",
    ".yml",
    ".yaml",
    ".toml",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".cjs",
    ".mjs",
    ".sh",
}

PATH_EXTS = {
    ".md",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".cjs",
    ".mjs",
    ".json",
    ".jsonl",
    ".yml",
    ".yaml",
    ".toml",
    ".sh",
    ".txt",
    ".html",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".wav",
    ".mp3",
}

TRIGGER_WORDS = (
    "trigger",
    "use when",
    "when to use",
    "applies",
    "scope",
    "适用",
    "使用",
    "触发",
    "场景",
    "范围",
    "目的",
    "目标",
    "规则",
)

WORKFLOW_WORDS = (
    "workflow",
    "工作流",
    "流程",
    "验收",
    "checklist",
    "requirements",
    "status",
    "guide",
)

KNOWN_ROOTS = {
    ".cursor",
    ".claude",
    ".codex",
    ".github",
    "artifact",
    "assets",
    "config",
    "data",
    "docs",
    "engine",
    "public",
    "resources",
    "scripts",
    "src",
    "tools",
    "world",
}

MD_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
INLINE_CODE_RE = re.compile(r"`([^`\n]{1,240})`")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
_INDEX_CACHE: dict[str, tuple[list[tuple[str, Path]], list[tuple[str, Path]]]] = {}
_MATCH_CACHE: dict[tuple[str, str, str], list[Path]] = {}


def scan_project(root: Path) -> list[Artifact]:
    root = root.resolve()
    seen: set[str] = set()
    artifacts: list[Artifact] = []

    for path in sorted(_iter_skill_files(root)):
        artifacts.append(_scan_text_artifact(root, path, "skill", "cursor_skill", _skill_id(root, path), agent="cursor"))
        seen.add(_rel(root, path))

    for rel in ("CLAUDE.md", "AGENTS.md", ".mcp.json"):
        path = root / rel
        if path.exists():
            artifacts.append(_scan_text_artifact(root, path, "agent_rules", "agent_entry", f"agent.{path.stem.lower()}"))
            seen.add(_rel(root, path))

    for path in sorted(_iter_workflow_files(root)):
        rel = _rel(root, path)
        if rel in seen:
            continue
        artifacts.append(_scan_text_artifact(root, path, _classify_workflow(path), _workflow_source(root, path), _artifact_id(root, path)))
        seen.add(rel)

    package = root / "package.json"
    if package.exists():
        artifacts.extend(_scan_package_scripts(root, package))

    return sorted(artifacts, key=lambda a: (a.type, a.path, a.id))


def _iter_skill_files(root: Path) -> Iterable[Path]:
    candidates = [
        root / ".cursor" / "skills",
        root / ".claude" / "skills",
        root / ".codex" / "skills",
    ]
    for base in candidates:
        if not base.exists():
            continue
        for path in base.glob("*/SKILL.md"):
            if _is_allowed(path, root):
                yield path


def _iter_workflow_files(root: Path) -> Iterable[Path]:
    fixed = [
        root / "artifact" / "cursor-workflow-guide.md",
        root / ".github" / "workflows",
        root / "docs",
        root / "tools",
        root / "scripts",
    ]
    for base in fixed:
        if not base.exists():
            continue
        if base.is_file():
            if _looks_like_workflow_file(base):
                yield base
            continue
        for path in base.rglob("*"):
            if not path.is_file() or not _is_allowed(path, root):
                continue
            if _looks_like_workflow_file(path):
                yield path

    for rel in ("dev.sh", "bootstrap.sh"):
        path = root / rel
        if path.exists():
            yield path


def _is_allowed(path: Path, root: Path) -> bool:
    try:
        rel = path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    parts = rel.parts
    if ".claude" in parts and "worktrees" in parts:
        return False
    if len(parts) >= 2 and parts[0] == "tools" and parts[1] == "skill_workflow_governance":
        return False
    return not any(part in EXCLUDED_DIRS for part in parts)


def _looks_like_workflow_file(path: Path) -> bool:
    name = path.name.lower()
    rel = path.as_posix().lower()
    if path.suffix.lower() not in TEXT_EXTS:
        return False
    if ".github/workflows/" in rel:
        return True
    if name in {"readme.md", "requirements.txt"} and "/tools/" in rel:
        return True
    if name.endswith(".sh") or "/scripts/" in rel:
        return True
    return any(word in rel for word in WORKFLOW_WORDS)


def _scan_package_scripts(root: Path, package: Path) -> list[Artifact]:
    try:
        data = json.loads(package.read_text(encoding="utf-8"))
    except Exception:
        return []
    scripts = data.get("scripts") or {}
    artifacts: list[Artifact] = []
    stat = package.stat()
    modified = _mtime(stat.st_mtime)
    for name, command in sorted(scripts.items()):
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name)
        artifacts.append(
            Artifact(
                id=f"package-script.{safe_name}",
                type="package_script",
                title=f"npm run {name}",
                path=_rel(root, package),
                source="package_json",
                summary=str(command),
                modified=modified,
                modified_ts=stat.st_mtime,
                size=stat.st_size,
                commands=[str(command)],
                references=_extract_references(root, package, str(command)),
                tags=["workflow", "script"],
            )
        )
    return artifacts


def _scan_text_artifact(root: Path, path: Path, artifact_type: str, source: str, artifact_id: str, agent: str = "shared") -> Artifact:
    text = _read_text(path)
    stat = path.stat()
    headings = _headings(text)
    title = _title(path, headings)
    summary = _summary(text)
    return Artifact(
        id=artifact_id,
        type=artifact_type,
        title=title,
        path=_rel(root, path),
        source=source,
        summary=summary,
        agent=agent,
        modified=_mtime(stat.st_mtime),
        modified_ts=stat.st_mtime,
        size=stat.st_size,
        headings=headings,
        trigger_hints=_trigger_hints(text),
        commands=_commands(text),
        references=_extract_references(root, path, text),
        tags=_tags(path, text, artifact_type),
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def _headings(text: str) -> list[str]:
    out: list[str] = []
    for line in text.splitlines():
        m = HEADING_RE.match(line)
        if m:
            out.append(m.group(2).strip())
    return out


def _title(path: Path, headings: list[str]) -> str:
    if headings:
        return _clean_heading(headings[0])
    if path.name == "SKILL.md":
        return path.parent.name
    return path.stem


def _clean_heading(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("#", "")).strip()


def _summary(text: str) -> str:
    lines = text.splitlines()
    block: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(">"):
            if block:
                break
            continue
        if line.startswith(("-", "*", "|")):
            if block:
                break
            continue
        block.append(line)
        if len(" ".join(block)) > 260:
            break
    return _clip(" ".join(block), 320)


def _trigger_hints(text: str) -> list[str]:
    hints: list[str] = []
    lines = text.splitlines()
    for idx, raw in enumerate(lines):
        line = raw.strip()
        low = line.lower()
        if any(word in low for word in TRIGGER_WORDS):
            snippet = [line]
            for extra in lines[idx + 1 : idx + 4]:
                extra_line = extra.strip()
                if not extra_line:
                    if snippet:
                        break
                    continue
                if extra_line.startswith("#"):
                    break
                snippet.append(extra_line)
            hints.append(_clip(" ".join(snippet), 360))
        if len(hints) >= 5:
            break
    return hints


def _commands(text: str) -> list[str]:
    commands: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("python ", "python3 ", "npm ", "npx ", "./", "bash ", "node ", "pytest ", "vitest ")):
            commands.append(_clip(stripped, 240))
    for code in INLINE_CODE_RE.findall(text):
        stripped = code.strip()
        if stripped.startswith(("python ", "python3 ", "npm ", "npx ", "./", "bash ", "node ", "pytest ", "vitest ")):
            commands.append(_clip(stripped, 240))
    return sorted(dict.fromkeys(commands))


def _extract_references(root: Path, source_path: Path, text: str) -> list[Reference]:
    refs: list[Reference] = []
    seen: set[tuple[str, int, str]] = set()
    for line_no, line in enumerate(text.splitlines(), start=1):
        for raw in MD_LINK_RE.findall(line):
            ref = _reference_from_candidate(root, source_path, raw, "markdown_link", line_no)
            if ref and (ref.raw, ref.line, ref.kind) not in seen:
                refs.append(ref)
                seen.add((ref.raw, ref.line, ref.kind))
        for raw in INLINE_CODE_RE.findall(line):
            ref = _reference_from_candidate(root, source_path, raw, "inline_code", line_no)
            if ref and (ref.raw, ref.line, ref.kind) not in seen:
                refs.append(ref)
                seen.add((ref.raw, ref.line, ref.kind))
    return refs


def _reference_from_candidate(root: Path, source_path: Path, raw: str, kind: str, line: int) -> Reference | None:
    target = _normalize_candidate(raw)
    if not target or not _looks_like_path(target):
        return None
    ref = Reference(raw=raw.strip(), kind=kind, line=line, target=target)
    _resolve_reference(root, source_path, ref)
    return ref


def _normalize_candidate(raw: str) -> str:
    s = raw.strip().strip("\"'")
    if not s or s.startswith(("#", "http://", "https://", "mailto:")):
        return ""
    if any(mark in s for mark in ("<", ">", "{", "}")):
        return ""
    if s.startswith(("./", "../", "~/")) and " " in s:
        try:
            s = shlex.split(s)[0]
        except ValueError:
            s = s.split()[0]
    if " " in s and not s.startswith(("./", "../")):
        return ""
    s = s.split("#", 1)[0]
    s = re.sub(r":\d+(?::\d+)?$", "", s)
    s = s.rstrip(".,;:)")
    return s


def _looks_like_path(s: str) -> bool:
    if s.startswith("<") and s.endswith(">"):
        return False
    if s.startswith("/") and not s.startswith(("/assets/", "/public/")) and not Path(s).exists():
        return False
    if s.startswith(".") and not s.startswith(("./", "../", ".cursor", ".claude", ".codex", ".github", ".mcp", ".git", ".clinerules")):
        if "/" not in s:
            return False
    if s.startswith(("/", "./", "../", "~/", ".")):
        return True
    suffix = Path(s).suffix.lower()
    if suffix in PATH_EXTS:
        return True
    if "/" not in s:
        return False
    first = s.split("/", 1)[0]
    if first == "GameDraft":
        return True
    if first in KNOWN_ROOTS:
        return True
    if "*" in s or "?" in s:
        return True
    return False


def _resolve_reference(root: Path, source_path: Path, ref: Reference) -> None:
    target = ref.target or ""
    if target.startswith(root.name + "/"):
        target = target[len(root.name) + 1 :]
        ref.target = target
    if "*" in target or "?" in target:
        matches = list(root.glob(target))
        if not matches:
            matches = _find_by_suffix(root, target)
        ref.status = "ok" if matches else "missing"
        ref.resolved_to = _rel(root, matches[0]) if matches else None
        ref.note = f"glob matches={len(matches)}"
        return
    candidates: list[Path] = []
    if target.startswith("~/"):
        candidates.append(Path(os.path.expanduser(target)))
    elif target.startswith("/assets/"):
        candidates.append(root / "public" / target.lstrip("/"))
    elif target.startswith("/public/"):
        candidates.append(root / target.lstrip("/"))
    elif target.startswith("/"):
        candidates.append(Path(target))
    else:
        candidates.append(source_path.parent / target)
        candidates.append(root / target)

    for candidate in candidates:
        if candidate.exists():
            ref.status = "ok"
            try:
                ref.resolved_to = _rel(root, candidate)
            except ValueError:
                ref.resolved_to = candidate.as_posix()
            return
    suffix_matches = _find_by_suffix(root, target)
    if suffix_matches:
        ref.status = "ok"
        ref.resolved_to = _rel(root, suffix_matches[0])
        ref.note = f"suffix matches={len(suffix_matches)}"
        return
    if "/" not in target and Path(target).suffix.lower() in PATH_EXTS:
        basename_matches = _find_by_basename(root, target)
        if basename_matches:
            ref.status = "ok"
            ref.resolved_to = _rel(root, basename_matches[0])
            ref.note = f"basename matches={len(basename_matches)}"
            return
    if target.endswith("/"):
        dirname_matches = _find_dir_by_name(root, target.rstrip("/"))
        if dirname_matches:
            ref.status = "ok"
            ref.resolved_to = _rel(root, dirname_matches[0])
            ref.note = f"dirname matches={len(dirname_matches)}"
            return
    ref.status = "missing"
    ref.resolved_to = None


def _find_by_suffix(root: Path, target: str) -> list[Path]:
    key = (root.resolve().as_posix(), "suffix", target)
    if key in _MATCH_CACHE:
        return _MATCH_CACHE[key]
    needle = target.lstrip("./")
    matches: list[Path] = []
    pattern = f"*/{needle}"
    files, dirs = _path_index(root)
    for rel, path in [*files, *dirs]:
        if rel == needle or rel.endswith("/" + needle) or fnmatch(rel, pattern):
            matches.append(path)
            if len(matches) > 20:
                break
    _MATCH_CACHE[key] = matches
    return matches


def _find_by_basename(root: Path, name: str) -> list[Path]:
    key = (root.resolve().as_posix(), "basename", name)
    if key in _MATCH_CACHE:
        return _MATCH_CACHE[key]
    matches: list[Path] = []
    files, _dirs = _path_index(root)
    for _rel_path, path in files:
        if path.name == name:
            matches.append(path)
            if len(matches) > 20:
                break
    _MATCH_CACHE[key] = matches
    return matches


def _find_dir_by_name(root: Path, name: str) -> list[Path]:
    key = (root.resolve().as_posix(), "dirname", name)
    if key in _MATCH_CACHE:
        return _MATCH_CACHE[key]
    base = name.rsplit("/", 1)[-1]
    matches: list[Path] = []
    _files, dirs = _path_index(root)
    for _rel_path, path in dirs:
        if path.name == base:
            matches.append(path)
            if len(matches) > 20:
                break
    _MATCH_CACHE[key] = matches
    return matches


def _path_index(root: Path) -> tuple[list[tuple[str, Path]], list[tuple[str, Path]]]:
    key = root.resolve().as_posix()
    cached = _INDEX_CACHE.get(key)
    if cached is not None:
        return cached
    files: list[tuple[str, Path]] = []
    dirs: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d
            for d in dirnames
            if d not in EXCLUDED_DIRS and not (Path(dirpath).name == ".claude" and d == "worktrees")
        ]
        current = Path(dirpath)
        if current != root:
            dirs.append((current.relative_to(root).as_posix(), current))
        for filename in filenames:
            path = current / filename
            files.append((path.relative_to(root).as_posix(), path))
    cached = (files, dirs)
    _INDEX_CACHE[key] = cached
    return cached


def _tags(path: Path, text: str, artifact_type: str) -> list[str]:
    tags = {artifact_type}
    low = (path.as_posix() + "\n" + text[:2000]).lower()
    if "codex" in low:
        tags.add("codex")
    if "claude" in low:
        tags.add("claude")
    if "cursor" in low:
        tags.add("cursor")
    if any(word in low for word in WORKFLOW_WORDS):
        tags.add("workflow")
    if "validate" in low or "验收" in low:
        tags.add("validation")
    return sorted(tags)


def _classify_workflow(path: Path) -> str:
    rel = path.as_posix().lower()
    if ".github/workflows/" in rel:
        return "ci_workflow"
    if path.suffix.lower() in {".sh", ".py", ".cjs", ".mjs", ".js"} or "/scripts/" in rel:
        return "script"
    if path.name.lower() == "requirements.txt":
        return "tool_requirements"
    return "workflow_doc"


def _workflow_source(root: Path, path: Path) -> str:
    rel = _rel(root, path)
    if rel.startswith(".github/workflows/"):
        return "github_actions"
    if rel.startswith("tools/"):
        return "tool_doc"
    if rel.startswith("docs/"):
        return "docs"
    if rel.startswith("artifact/"):
        return "artifact"
    if rel.startswith("scripts/") or path.suffix == ".sh":
        return "script"
    return "project"


def _skill_id(root: Path, path: Path) -> str:
    rel = path.relative_to(root)
    name = path.parent.name
    base = rel.parts[0].lstrip(".") if rel.parts else "skill"
    return f"{base}-skill.{name}"


def _artifact_id(root: Path, path: Path) -> str:
    rel = _rel(root, path)
    base = re.sub(r"[^a-zA-Z0-9_.-]+", "-", rel.rsplit(".", 1)[0]).strip("-").lower()
    return base or path.stem


def _rel(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _mtime(ts: float) -> str:
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds")


def _clip(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "..."
