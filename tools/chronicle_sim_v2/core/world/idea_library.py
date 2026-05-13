"""设定库管理：CRUD + Chroma 索引。"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from tools.chronicle_sim_v2.core.schema.idea import IdeaEntry
from tools.chronicle_sim_v2.core.world.chroma import add_idea, search_ideas
from tools.chronicle_sim_v2.core.world.fs import read_text, write_text


_MANIFEST_NAME = "manifest.json"


def _load_manifest(run_dir: Path) -> list[dict[str, Any]]:
    p = run_dir / "ideas" / _MANIFEST_NAME
    if not p.is_file():
        return []
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_manifest(run_dir: Path, items: list[dict[str, Any]]) -> None:
    p = run_dir / "ideas" / _MANIFEST_NAME
    (run_dir / "ideas").mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def create_idea(run_dir: Path, title: str, body: str, tags: list[str] | None = None) -> IdeaEntry:
    """创建新灵感条目。"""
    now = datetime.now(timezone.utc).isoformat()
    idea_id = uuid4().hex[:10]
    entry = IdeaEntry(
        id=idea_id,
        title=title,
        body=body,
        source="manual",
        tags=tags or [],
        created_at=now,
        updated_at=now,
    )
    _save_md(run_dir, entry)
    _add_to_manifest(run_dir, entry)
    add_idea(run_dir, idea_id, body, {"title": title, "tags": ",".join(entry.tags)})
    return entry


def update_idea(
    run_dir: Path,
    idea_id: str,
    title: str | None = None,
    body: str | None = None,
    tags: list[str] | None = None,
) -> IdeaEntry | None:
    """更新灵感条目。"""
    entry = _load_by_id(run_dir, idea_id)
    if entry is None:
        return None
    now = datetime.now(timezone.utc).isoformat()
    if title is not None:
        entry.title = title
    if body is not None:
        entry.body = body
    if tags is not None:
        entry.tags = tags
    entry.updated_at = now
    _save_md(run_dir, entry)
    _update_manifest(run_dir, entry)
    if body is not None:
        add_idea(run_dir, idea_id, body, {"title": entry.title, "tags": ",".join(entry.tags)})
    return entry


def delete_idea(run_dir: Path, idea_id: str) -> bool:
    """删除灵感条目。"""
    entry = _load_by_id(run_dir, idea_id)
    if entry is None:
        return False
    md_path = run_dir / "ideas" / f"{idea_id}.md"
    if md_path.is_file():
        os.unlink(md_path)
    _remove_from_manifest(run_dir, idea_id)
    # ChromaDB 删除（如果支持）
    try:
        from tools.chronicle_sim_v2.core.world.chroma import get_ideas_collection
        coll = get_ideas_collection(run_dir)
        if coll is not None:
            coll.delete(ids=[idea_id])
    except Exception:
        pass
    return True


def list_ideas(run_dir: Path) -> list[IdeaEntry]:
    """列出所有灵感条目。"""
    manifest = _load_manifest(run_dir)
    ideas = []
    for item in manifest:
        entry = _load_by_id(run_dir, item.get("id", ""))
        if entry:
            ideas.append(entry)
    return ideas


def import_md_file(run_dir: Path, file_path: str | Path) -> IdeaEntry | None:
    """导入外部 MD 文件到设定库。"""
    fp = Path(file_path)
    if not fp.is_file():
        return None
    content = fp.read_text(encoding="utf-8")
    title = fp.stem
    now = datetime.now(timezone.utc).isoformat()
    idea_id = uuid4().hex[:10]
    entry = IdeaEntry(
        id=idea_id,
        title=title,
        body=content,
        source="imported",
        source_file=str(fp),
        created_at=now,
        updated_at=now,
    )
    _save_md(run_dir, entry)
    _add_to_manifest(run_dir, entry)
    add_idea(run_dir, idea_id, content, {"title": title, "source": "imported"})
    return entry


def build_ideas_blob(run_dir: Path, char_limit: int = 50_000) -> str:
    """从 manifest 读取全部条目，拼接为 initializer 可消费的文本 blob。"""
    manifest = _load_manifest(run_dir)
    parts: list[str] = []
    total = 0
    for item in manifest:
        idea_id = item.get("id", "")
        md_path = run_dir / "ideas" / f"{idea_id}.md"
        if not md_path.is_file():
            continue
        entry = _load_by_id(run_dir, idea_id)
        if entry is None:
            continue
        text = f"## {entry.title}\n\n{entry.body}\n"
        if total + len(text) > char_limit:
            break
        parts.append(text)
        total += len(text)
    return "\n---\n\n".join(parts)


def search_ideas_semantic(run_dir: Path, query: str, n_results: int = 5) -> list[IdeaEntry]:
    """语义搜索设定库。"""
    results = search_ideas(run_dir, query, n_results)
    entries = []
    for r in results:
        idea_id = r.get("id", "")
        entry = _load_by_id(run_dir, idea_id)
        if entry:
            entries.append(entry)
    return entries


def _load_by_id(run_dir: Path, idea_id: str) -> IdeaEntry | None:
    md_path = run_dir / "ideas" / f"{idea_id}.md"
    if not md_path.is_file():
        return None
    content = md_path.read_text(encoding="utf-8")
    # 解析 frontmatter (简单格式)
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            header = parts[1].strip()
            body = parts[2].strip()
            meta: dict[str, Any] = {}
            for line in header.split("\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            return IdeaEntry(
                id=idea_id,
                title=meta.get("title", ""),
                body=body,
                source=meta.get("source", "manual"),
                source_file=meta.get("source_file") or None,
                tags=_parse_tags(meta.get("tags", "")),
                created_at=meta.get("created_at", ""),
                updated_at=meta.get("updated_at", ""),
            )
    # 没有 frontmatter，纯文本
    return IdeaEntry(id=idea_id, title=md_path.stem, body=content)


def _save_md(run_dir: Path, entry: IdeaEntry) -> None:
    md_path = run_dir / "ideas" / f"{entry.id}.md"
    header = (
        f"---\ntitle: {entry.title}\nsource: {entry.source}\n"
        f"tags: {', '.join(entry.tags)}\n"
        f"created_at: {entry.created_at}\nupdated_at: {entry.updated_at}\n---\n"
    )
    write_text(run_dir, f"ideas/{entry.id}.md", header + "\n" + entry.body)


def _add_to_manifest(run_dir: Path, entry: IdeaEntry) -> None:
    manifest = _load_manifest(run_dir)
    manifest.append({
        "id": entry.id,
        "title": entry.title,
        "tags": entry.tags,
        "source": entry.source,
        "created_at": entry.created_at,
    })
    _save_manifest(run_dir, manifest)


def _update_manifest(run_dir: Path, entry: IdeaEntry) -> None:
    manifest = _load_manifest(run_dir)
    for i, item in enumerate(manifest):
        if item.get("id") == entry.id:
            manifest[i] = {
                "id": entry.id,
                "title": entry.title,
                "tags": entry.tags,
                "source": entry.source,
                "created_at": entry.created_at,
                "updated_at": entry.updated_at,
            }
            break
    _save_manifest(run_dir, manifest)


def _remove_from_manifest(run_dir: Path, idea_id: str) -> None:
    manifest = _load_manifest(run_dir)
    manifest = [m for m in manifest if m.get("id") != idea_id]
    _save_manifest(run_dir, manifest)


def _parse_tags(raw: str) -> list[str]:
    return [t.strip() for t in raw.split(",") if t.strip()] if raw else []
