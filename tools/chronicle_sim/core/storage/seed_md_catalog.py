"""包内「设定 MD 库」：manifest + files，供生成种子时合并为 LLM 输入。"""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from tools.chronicle_sim.paths import (
    PROJECT_ROOT,
    SEED_MD_FILES_DIR,
    SEED_MD_MANIFEST_PATH,
    ensure_seed_md_library_dirs,
)


class SeedMdEntry(BaseModel):
    id: str
    title: str = "未命名"
    category: str = "misc"
    enabled: bool = True
    sort_order: int = 0


class SeedMdManifest(BaseModel):
    entries: list[SeedMdEntry] = Field(default_factory=list)


def load_manifest() -> SeedMdManifest:
    ensure_seed_md_library_dirs()
    if not SEED_MD_MANIFEST_PATH.is_file():
        return SeedMdManifest()
    try:
        raw = json.loads(SEED_MD_MANIFEST_PATH.read_text(encoding="utf-8"))
        return SeedMdManifest.model_validate(raw)
    except (json.JSONDecodeError, OSError, ValueError):
        return SeedMdManifest()


def save_manifest(m: SeedMdManifest) -> None:
    ensure_seed_md_library_dirs()
    SEED_MD_MANIFEST_PATH.write_text(
        json.dumps(m.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def entry_body_path(entry_id: str) -> Path:
    return SEED_MD_FILES_DIR / f"{entry_id}.md"


def read_entry_body(entry_id: str) -> str:
    p = entry_body_path(entry_id)
    if not p.is_file():
        return ""
    return p.read_text(encoding="utf-8", errors="replace")


def write_entry_body(entry_id: str, text: str) -> None:
    ensure_seed_md_library_dirs()
    entry_body_path(entry_id).write_text(text, encoding="utf-8")


def delete_entry_files(entry_id: str) -> None:
    p = entry_body_path(entry_id)
    if p.is_file():
        p.unlink()


def build_library_blob(*, use_legacy_project_blueprints: bool = False, max_chars_per_file: int = 16000) -> str:
    """合并 MD 库中已启用的文档；可选附加项目根旧版固定文件名列表。"""
    m = load_manifest()
    chunks: list[str] = []
    entries = sorted([e for e in m.entries if e.enabled], key=lambda x: (x.sort_order, x.title))
    for e in entries:
        body = read_entry_body(e.id).strip()
        if not body:
            continue
        cap = body[:max_chars_per_file]
        label = f"{e.title} [{e.category}]"
        chunks.append(f"=== {label} (id={e.id}) ===\n{cap}\n")

    if use_legacy_project_blueprints:
        names = [
            "关二狗的故事.md",
            "李天狗的故事.md",
            "关二狗的故事_序章落地拆解.md",
            "袍哥.md",
            "车船店脚牙.md",
            "川渝骂人话.md",
            "一些故事搜集.md",
        ]
        for n in names:
            p = PROJECT_ROOT / n
            if p.is_file():
                t = p.read_text(encoding="utf-8", errors="replace")[:12000]
                chunks.append(f"===项目根/{n}（旧版列表）===\n{t}\n")

    return "\n".join(chunks)


def slug_from_title(title: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff\-]+", "-", title.strip())[:48]
    return s or uuid.uuid4().hex[:8]
