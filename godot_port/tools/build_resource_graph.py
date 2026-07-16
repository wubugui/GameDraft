#!/usr/bin/env python3
"""Build the planning/export resource graph for the Godot runtime shell.

This does not copy assets.  It reuses the repository's authoritative path and
asset-audit semantics, records every explicit JSON/code reference, follows
animation manifests to their sprite sheets, and adds conservative derived
bundles whose paths are constructed at runtime (currently dialogue portraits).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any


PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.editor.shared.asset_reference_audit import (  # noqa: E402
    _MEDIA_KEY_NAMES,
    _RICH_IMG_RE,
    _TEXT_KEY_NAMES,
    _walk_json,
    audit_project_assets,
)
from tools.editor.shared.project_paths import (  # noqa: E402
    ProjectPaths,
    URL_KIND_ANY,
    URL_KIND_MEDIA,
)


OUTPUT_PATH = PORT_ROOT / "compatibility" / "resource-graph.json"
HARDCODED_RUNTIME_URL_RE = re.compile(r"['\"](/resources/runtime/[^'\"`]+)['\"]")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except (OSError, ValueError):
        return str(path)


class GraphBuilder:
    def __init__(self) -> None:
        self.paths = ProjectPaths(REPO_ROOT)
        self.overlay_images = self._load_overlay_images()
        self.edges: list[dict[str, Any]] = []
        self._edge_keys: set[tuple[str, str, str, str, str]] = set()
        self.local_targets: set[Path] = set()
        self.remote_targets: set[str] = set()
        self.missing: list[dict[str, str]] = []

    def _load_overlay_images(self) -> dict[str, str]:
        path = self.paths.data_dir / "overlay_images.json"
        if not path.is_file():
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
        return {
            str(key): value
            for key, value in raw.items()
            if isinstance(key, str) and isinstance(value, str)
        } if isinstance(raw, dict) else {}

    def add_reference(
        self,
        *,
        source: str,
        field: str,
        raw: str,
        kind: str,
        scene_id: str | None = None,
        resolution: str = "explicit",
    ) -> None:
        value = raw.strip()
        if not value:
            return
        low = value.lower()
        if low.startswith("http://") or low.startswith("https://"):
            key = (source, field, raw, value, kind)
            if key not in self._edge_keys:
                self._edge_keys.add(key)
                self.edges.append({
                    "source": source,
                    "field": field,
                    "raw": raw,
                    "target": value,
                    "kind": "remote",
                    "resolution": resolution,
                    "exists": None,
                    "export": False,
                })
            self.remote_targets.add(value)
            return

        resolved_value = value
        resolved_by = resolution
        if kind == "media" and not value.startswith(("/", "resources/", "assets/")):
            alias = self.overlay_images.get(value)
            if alias:
                resolved_value = alias.strip()
                resolved_by = "overlayAlias"

        disk: Path | None = None
        if kind == "dialogueGraph":
            if resolved_value.startswith(("/assets/", "assets/")):
                disk = self.paths.url_to_disk(resolved_value, kind=URL_KIND_ANY)
            else:
                disk = self.paths.dialogues_dir / "graphs" / f"{resolved_value}.json"
        elif kind == "media" and scene_id and not resolved_value.startswith(("/", "resources/", "assets/")):
            try:
                disk = self.paths.scene_runtime_asset(scene_id, resolved_value)
                resolved_by = "sceneRelative" if resolved_by == "explicit" else resolved_by
            except ValueError:
                disk = None
        else:
            disk = self.paths.url_to_disk(
                resolved_value,
                kind=URL_KIND_MEDIA if kind == "media" else URL_KIND_ANY,
            )

        target = relative(disk) if disk is not None else ""
        exists = bool(disk and disk.is_file())
        export = bool(
            exists
            and disk is not None
            and (
                self.paths.runtime_root.resolve() in disk.resolve().parents
                or self.paths.assets_root.resolve() in disk.resolve().parents
            )
        )
        key = (source, field, raw, target, kind)
        if key in self._edge_keys:
            return
        self._edge_keys.add(key)
        edge = {
            "source": source,
            "field": field,
            "raw": raw,
            "target": target,
            "kind": kind,
            "resolution": resolved_by,
            "exists": exists,
            "export": export,
        }
        self.edges.append(edge)
        if exists and disk is not None:
            self.local_targets.add(disk.resolve())
        else:
            self.missing.append({
                "source": source,
                "field": field,
                "raw": raw,
                "kind": kind,
            })

    def scan_json(self, path: Path, *, scene_id: str | None = None) -> None:
        source = relative(path)
        data = json.loads(path.read_text(encoding="utf-8"))
        for field, key, leaf in _walk_json(data):
            if not isinstance(leaf, str):
                continue
            for match in _RICH_IMG_RE.finditer(leaf):
                self.add_reference(
                    source=source,
                    field=f"{field}#img",
                    raw=match.group(1),
                    kind="media",
                    resolution="richImage",
                )
            if key in _MEDIA_KEY_NAMES or leaf.startswith(("/resources/runtime/", "resources/runtime/")):
                self.add_reference(
                    source=source,
                    field=field,
                    raw=leaf,
                    kind="media",
                    scene_id=scene_id,
                )
            elif key in _TEXT_KEY_NAMES:
                kind = "dialogueGraph" if key == "dialogueGraphId" else "runtimeConfig"
                self.add_reference(
                    source=source,
                    field=field,
                    raw=leaf,
                    kind=kind,
                    scene_id=scene_id,
                )

    def scan_authoritative_json(self) -> None:
        for path in sorted((REPO_ROOT / "public/assets/data").rglob("*.json")):
            self.scan_json(path)
        for path in sorted((REPO_ROOT / "public/assets/scenes").glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            scene_id = str(data.get("id") or path.stem).strip()
            self.scan_json(path, scene_id=scene_id)
        for path in sorted((REPO_ROOT / "public/assets/dialogues/graphs").glob("*.json")):
            self.scan_json(path)

    def add_text_roots(self) -> None:
        for path in sorted((REPO_ROOT / "public/assets").rglob("*.json")):
            self.add_reference(
                source="authority:content-json-root",
                field="json",
                raw="/assets/" + path.relative_to(self.paths.assets_root).as_posix(),
                kind="textRoot",
                resolution="authoritativeRoot",
            )

    def scan_hardcoded_runtime_urls(self) -> None:
        source_roots = [REPO_ROOT / "src"]
        for source_root in source_roots:
            for path in sorted(source_root.rglob("*.ts")):
                if path.name.endswith(".test.ts"):
                    continue
                text = path.read_text(encoding="utf-8")
                for match in HARDCODED_RUNTIME_URL_RE.finditer(text):
                    raw = match.group(1)
                    if "${" in raw or "<" in raw or raw.endswith("/"):
                        continue
                    disk = self.paths.url_to_disk(raw, kind=URL_KIND_MEDIA)
                    if disk is not None and disk.is_dir():
                        continue
                    self.add_reference(
                        source=relative(path),
                        field=f"hardcodedRuntimeUrl@{text.count(chr(10), 0, match.start()) + 1}",
                        raw=raw,
                        kind="media",
                        resolution="codeLiteral",
                    )

    def add_registered_overlay_images(self) -> None:
        for alias, raw in sorted(self.overlay_images.items()):
            self.add_reference(
                source="public/assets/data/overlay_images.json",
                field=alias,
                raw=raw,
                kind="media",
                resolution="registeredOverlay",
            )

    def add_dialogue_portrait_bundle(self) -> None:
        root = self.paths.runtime_images_dir / "dialogue_portraits"
        if not root.is_dir():
            return
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            self.add_reference(
                source="derived:dialogue-portrait-runtime",
                field="portraitBundle",
                raw=self.paths.disk_to_runtime_url(path) or "",
                kind="media",
                resolution="derivedBundle",
            )

    def follow_animation_manifests(self) -> None:
        manifests = sorted(
            path for path in self.local_targets
            if path.name == "anim.json" and self.paths.runtime_animation_dir.resolve() in path.parents
        )
        for manifest in manifests:
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self.missing.append({
                    "source": relative(manifest), "field": "", "raw": "", "kind": "invalidAnimationManifest"
                })
                continue
            spritesheet = str(data.get("spritesheet") or "").strip()
            if not spritesheet:
                self.missing.append({
                    "source": relative(manifest), "field": "spritesheet", "raw": "", "kind": "animationSpritesheet"
                })
                continue
            target = manifest.parent / spritesheet
            self.add_reference(
                source=relative(manifest),
                field="spritesheet",
                raw=self.paths.disk_to_runtime_url(target) or spritesheet,
                kind="media",
                resolution="animationManifestRelative",
            )

    def build(self) -> dict[str, Any]:
        audit = audit_project_assets(REPO_ROOT)
        if audit.issues:
            raise RuntimeError(f"authoritative asset audit has {len(audit.issues)} issue(s); resource graph refused")

        self.add_text_roots()
        self.scan_authoritative_json()
        self.scan_hardcoded_runtime_urls()
        self.add_registered_overlay_images()
        self.add_dialogue_portrait_bundle()
        self.follow_animation_manifests()

        local_files = sorted(self.local_targets, key=relative)
        runtime_files = sorted(
            (path.resolve() for path in self.paths.runtime_root.rglob("*") if path.is_file()),
            key=relative,
        )
        referenced_runtime = {
            path for path in local_files if self.paths.runtime_root.resolve() in path.parents
        }
        unreferenced_runtime = [path for path in runtime_files if path not in referenced_runtime]
        export_bytes = sum(path.stat().st_size for path in local_files)
        runtime_export_bytes = sum(path.stat().st_size for path in referenced_runtime)
        return {
            "sourceBaseline": {
                "assetAudit": {
                    "mediaFields": audit.media_count,
                    "textFields": audit.text_count,
                    "richImages": audit.rich_img_count,
                    "mapScenes": audit.map_scene_count,
                    "issues": len(audit.issues),
                }
            },
            "summary": {
                "edges": len(self.edges),
                "localTargets": len(local_files),
                "remoteTargets": len(self.remote_targets),
                "missingTargets": len(self.missing),
                "exportBytes": export_bytes,
                "runtimeFiles": len(runtime_files),
                "referencedRuntimeFiles": len(referenced_runtime),
                "referencedRuntimeBytes": runtime_export_bytes,
                "unreferencedRuntimeFiles": len(unreferenced_runtime),
            },
            "edges": sorted(self.edges, key=lambda edge: (edge["source"], edge["field"], edge["raw"])),
            "exportFiles": [
                {"path": relative(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)}
                for path in local_files
            ],
            "remoteTargets": sorted(self.remote_targets),
            "missingTargets": self.missing,
            "unreferencedRuntimeFiles": [relative(path) for path in unreferenced_runtime],
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    graph = GraphBuilder().build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = graph["summary"]
    print(
        "resource graph: "
        f"{summary['edges']} edges, {summary['localTargets']} local targets, "
        f"{summary['missingTargets']} missing, {summary['referencedRuntimeFiles']}/{summary['runtimeFiles']} runtime files"
    )
    print(f"wrote {args.output.relative_to(REPO_ROOT)}")
    return 1 if graph["missingTargets"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
