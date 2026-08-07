"""占位动画包盘点：哪些角色还欠正式资源、分别被谁用着。

占位包（`atlas.meta.json` 里 `placeholder: true`）在游戏里跟正式包长得一样——不盘点就
没人知道哪些还欠。本工具把「包 → 引用它的 NPC 摆放」连起来，输出就是"统一出资源"那天
的工单：**被用得越多的越该先补**。

用法::

    ./dev.sh placeholder-audit                 # 人读表格
    ./dev.sh placeholder-audit -- --json       # 机器读
    ./dev.sh placeholder-audit -- --unused     # 只看还没被任何场景用上的

判据一律读盘，不读任何缓存：`animation/*/atlas.meta.json` + `public/assets/scenes/*.json`
+ `character_registry.json`（角色注册表引用也算数）。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
ANIMATION_ROOT = REPO_ROOT / "public" / "resources" / "runtime" / "animation"
SCENES_ROOT = REPO_ROOT / "public" / "assets" / "scenes"
CHARACTER_REGISTRY = REPO_ROOT / "public" / "assets" / "data" / "character_registry.json"


def _bundle_id_from_ref(ref: Any) -> str:
    text = str(ref or "").strip().replace("\\", "/")
    if not text:
        return ""
    match = re.search(r"/animation/([^/]+)/", text)
    return match.group(1) if match else ""


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def scan_placeholder_bundles() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not ANIMATION_ROOT.is_dir():
        return out
    for bundle_dir in sorted(ANIMATION_ROOT.iterdir()):
        meta = _load_json(bundle_dir / "atlas.meta.json")
        if not isinstance(meta, dict) or not meta.get("placeholder"):
            continue
        anim = _load_json(bundle_dir / "anim.json") or {}
        # 早于 static_single_frame 的手搓占位包没有 authoredBodyHeight；它们同样是紧裁的，
        # 所以 anim.json 的 worldHeight 就是本体身高，可直接当回落（换正式包时对齐的就是它）。
        body_height = meta.get("authoredBodyHeight")
        if body_height is None:
            body_height = anim.get("worldHeight")
        out.append({
            "bundleId": bundle_dir.name,
            "packMode": meta.get("packMode"),
            "authoredBodyHeight": body_height,
            "bodyHeightSource": "meta" if meta.get("authoredBodyHeight") is not None else "anim.worldHeight",
            "states": sorted((anim.get("states") or {}).keys()),
            "cell": [meta.get("cellWidth"), meta.get("cellHeight")],
            "note": meta.get("note") or "",
            "sourceC": meta.get("sourceC") or "",
        })
    return out


def scan_bundle_usage() -> dict[str, list[dict[str, str]]]:
    """bundleId → 用到它的地方（场景 NPC 摆放 + 角色注册表）。"""
    usage: dict[str, list[dict[str, str]]] = {}

    def add(bundle: str, where: dict[str, str]) -> None:
        if bundle:
            usage.setdefault(bundle, []).append(where)

    registry_names: dict[str, str] = {}
    registry = _load_json(CHARACTER_REGISTRY)
    if isinstance(registry, dict):
        for character in registry.get("characters") or []:
            if not isinstance(character, dict):
                continue
            bundle = _bundle_id_from_ref(character.get("animFile"))
            add(bundle, {"kind": "registry", "id": str(character.get("id") or ""),
                         "name": str(character.get("name") or "")})
            if bundle:
                registry_names[str(character.get("id") or "")] = bundle

    for scene_path in sorted(SCENES_ROOT.glob("*.json")):
        scene = _load_json(scene_path)
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            bundle = _bundle_id_from_ref(npc.get("animFile"))
            if not bundle:
                bundle = registry_names.get(str(npc.get("characterId") or ""), "")
            add(bundle, {"kind": "scene", "id": f"{scene_path.stem}/{npc.get('id')}",
                         "name": str(npc.get("name") or "")})
    return usage


def build_report() -> dict[str, Any]:
    bundles = scan_placeholder_bundles()
    usage = scan_bundle_usage()
    rows = []
    for bundle in bundles:
        places = usage.get(bundle["bundleId"], [])
        rows.append({**bundle, "usedBy": places, "useCount": len(places)})
    rows.sort(key=lambda r: (-r["useCount"], r["bundleId"]))
    return {
        "placeholderCount": len(rows),
        "usedCount": sum(1 for r in rows if r["useCount"]),
        "unusedCount": sum(1 for r in rows if not r["useCount"]),
        "bundles": rows,
    }


def _print_table(report: dict[str, Any], only_unused: bool) -> None:
    rows = [r for r in report["bundles"] if not (only_unused and r["useCount"])]
    print(f"占位动画包 {report['placeholderCount']} 个"
          f"（已被引用 {report['usedCount']}，尚未上场 {report['unusedCount']}）\n")
    if not rows:
        print("（没有符合条件的包）")
        return
    width = max(len(r["bundleId"]) for r in rows)
    print(f"{'bundleId'.ljust(width)}  身高   格子       用处")
    print("-" * (width + 34))
    for row in rows:
        cell = f"{row['cell'][0]}x{row['cell'][1]}"
        where = "、".join(
            f"{p['id']}" for p in row["usedBy"][:3]) or "（未上场）"
        if row["useCount"] > 3:
            where += f" 等 {row['useCount']} 处"
        height = row["authoredBodyHeight"]
        print(f"{row['bundleId'].ljust(width)}  {str(height).rjust(5)}  {cell.ljust(10)} {where}")
        if row["note"]:
            print(f"{' ' * (width + 2)}  ↳ {row['note']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="placeholder-audit", description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    parser.add_argument("--unused", action="store_true", help="只列还没被任何场景用上的")
    args = parser.parse_args(argv)
    report = build_report()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_table(report, args.unused)
    return 0


if __name__ == "__main__":
    sys.exit(main())
