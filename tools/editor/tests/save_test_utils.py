"""保存契约测试辅助：哈希快照、裁剪 assets 拷贝、极小可加载工程骨架。"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any


def repo_root_from_tests() -> Path:
    """`tools/editor/tests/*.py` -> GameDraft 仓库根目录。"""
    return Path(__file__).resolve().parents[3]


def copy_assets_subset(repo: Path, dest_project: Path, subdirs: tuple[str, ...]) -> Path:
    """将 `repo/public/assets/{subdirs}` 复制到 `dest_project/public/assets/`。"""
    src_root = repo / "public" / "assets"
    dst_root = dest_project / "public" / "assets"
    if not src_root.is_dir():
        raise FileNotFoundError(str(src_root))
    for sub in subdirs:
        s = src_root / sub
        if not s.is_dir():
            continue
        shutil.copytree(s, dst_root / sub, dirs_exist_ok=True)
    return dest_project


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot_json_hashes(
    directory: Path, *, suffix: str = ".json",
) -> dict[str, str]:
    """相对路径 posix -> SHA256。"""
    out: dict[str, str] = {}
    if not directory.is_dir():
        return out
    for p in sorted(directory.rglob(f"*{suffix}")):
        if p.is_file():
            rel = p.relative_to(directory).as_posix()
            out[rel] = file_sha256(p)
    return out


def write_minimal_loadable_project(root: Path) -> None:
    """生成 `ProjectModel.load_project` 可加载的兜底文件（极小集，validators 可走通）。"""
    dp = root / "public" / "assets" / "data"
    sp = root / "public" / "assets" / "scenes"
    dp.mkdir(parents=True, exist_ok=True)
    sp.mkdir(parents=True, exist_ok=True)

    def dump(rel: str, obj: Any) -> None:
        path = dp / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(obj, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    dump("game_config.json", {})
    dump(
        "items.json",
        [{"id": "i_ok", "name": "plain", "type": "consumable", "description": "", "maxStack": 1}],
    )
    dump("quests.json", [])
    dump("questGroups.json", [])
    dump("encounters.json", [])
    dump("rules.json", {"rules": [], "fragments": []})
    dump("shops.json", [])
    dump("map_config.json", [])
    dump("cutscenes/index.json", [{"id": "cut_ok", "steps": []}])
    dump("audio_config.json", {})
    dump("strings.json", {})
    for arc in ("characters", "books", "documents"):
        dump(f"archive/{arc}.json", [])
    dump("archive/lore.json", {})
    dump("overlay_images.json", {})
    dump("document_reveals.json", [])
    dump("scenarios.json", {"scenarios": []})

    (sp / "sc_a.json").write_text(
        json.dumps({"id": "sc_a", "name": "A", "hotspots": [], "zones": [], "spawnPoints": {}},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (sp / "sc_b.json").write_text(
        json.dumps({"id": "sc_b", "name": "B", "hotspots": [], "zones": [], "spawnPoints": {}},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
