#!/usr/bin/env python3
"""Materialize the hash-verified shared resource subset for Godot exports."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
GRAPH = PORT_ROOT / "compatibility/resource-graph.json"
DESTINATION = PORT_ROOT / "generated/public"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    graph = json.loads(GRAPH.read_text(encoding="utf-8"))
    entries = graph.get("exportFiles", [])
    if not entries:
        raise RuntimeError("resource graph contains no exportFiles")
    if DESTINATION.parent.exists():
        shutil.rmtree(DESTINATION.parent)
    copied: list[dict[str, object]] = []
    seen_casefold: dict[str, str] = {}
    for entry in entries:
        source_rel = str(entry["path"])
        if not source_rel.startswith("public/") or ".." in Path(source_rel).parts:
            raise RuntimeError(f"unsafe export source path: {source_rel}")
        folded = source_rel.casefold()
        if folded in seen_casefold and seen_casefold[folded] != source_rel:
            raise RuntimeError(f"case-colliding export paths: {seen_casefold[folded]} / {source_rel}")
        seen_casefold[folded] = source_rel
        source = REPO_ROOT / source_rel
        if not source.is_file():
            raise RuntimeError(f"missing export source: {source_rel}")
        actual = sha256(source)
        if actual != entry.get("sha256"):
            raise RuntimeError(f"hash mismatch for {source_rel}: graph is stale")
        target = DESTINATION / Path(source_rel).relative_to("public")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append({"source": source_rel, "target": str(target.relative_to(PORT_ROOT)), "bytes": source.stat().st_size, "sha256": actual})
    manifest = {"sourceGraph": str(GRAPH.relative_to(REPO_ROOT)), "files": copied, "totalBytes": sum(int(x["bytes"]) for x in copied)}
    manifest_path = PORT_ROOT / "generated/export-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Shared media stays byte-identical and is decoded by RuntimeAssetManager.
    # Prevent Godot's importer from rewriting/rejecting legacy extension/signature pairs.
    (DESTINATION / ".gdignore").write_text("raw shared runtime assets; include_filter packs these files verbatim\n", encoding="utf-8")
    print(f"Godot export asset collection: PASS ({len(copied)} files, {manifest['totalBytes']} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
