"""asset_reference_audit 的契约测试：扫 fixture 覆盖三个根的解析与拒绝。"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.shared.asset_reference_audit import (
    audit_project_assets,
)


def _write(root: Path, rel: str, data) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, (dict, list)):
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        p.write_bytes(b"")
    return p


def _make_skeleton(root: Path) -> None:
    # public/assets：只放 JSON
    _write(root, "public/assets/data/cutscenes/index.json", [
        {
            "id": "ok_cutscene",
            "steps": [
                {"image": "/resources/runtime/images/illustrations/x.png"},
                {"text": "[img:images/backgrounds/y.png] hello"},
            ],
        },
    ])
    _write(root, "public/assets/scenes/demo.json", {
        "id": "demo",
        "backgrounds": [{"image": "background.png"}],
        "depthConfig": {
            "depth_map": "raw_depth_rg.png",
            "collision_map": "collision.png",
        },
    })

    # public/resources/runtime：媒体
    _write(root, "public/resources/runtime/images/illustrations/x.png", b"")
    _write(root, "public/resources/runtime/images/backgrounds/y.png", b"")
    _write(root, "public/resources/runtime/scenes/demo/background.png", b"")
    _write(root, "public/resources/runtime/scenes/demo/raw_depth_rg.png", b"")
    _write(root, "public/resources/runtime/scenes/demo/collision.png", b"")


class TestAssetReferenceAuditClean(unittest.TestCase):
    def test_clean_project_has_no_issues(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            report = audit_project_assets(root)
            self.assertEqual(report.issues, [])
            # 至少抓到了 cutscene image / scene background / depth_map / collision_map
            self.assertGreaterEqual(report.media_count, 4)
            # 抓到了富文本 [img:...] 短名
            self.assertGreaterEqual(report.rich_img_count, 1)


class TestAssetReferenceAuditDetectsMissing(unittest.TestCase):
    def test_missing_runtime_file_reported(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            # 故意删一个媒体文件
            (root / "public/resources/runtime/images/illustrations/x.png").unlink()
            report = audit_project_assets(root)
            reasons = [i.reason for i in report.issues]
            self.assertTrue(any("不存在" in r for r in reasons))


class TestAssetReferenceAuditDetectsAssetsMedia(unittest.TestCase):
    def test_media_referencing_assets_root_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            _write(root, "public/assets/data/document_reveals.json", [
                {
                    "id": "bad",
                    "blurredImagePath": "/assets/images/illustrations/y.png",
                    "clearImagePath": "/assets/images/illustrations/y.png",
                },
            ])
            report = audit_project_assets(root)
            self.assertTrue(report.issues, "应当至少有一个 issue")
            reasons = [i.reason for i in report.issues]
            self.assertTrue(
                any("禁止 /assets/" in r for r in reasons),
                f"reasons: {reasons}",
            )


class TestAssetReferenceAuditScansDialogues(unittest.TestCase):
    def test_dialogue_graph_image_references_are_scanned(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            _write(root, "public/assets/dialogues/graphs/g1.json", {
                "id": "g1",
                "nodes": [
                    {
                        "id": "n1",
                        "actions": [
                            {
                                "type": "showOverlayImage",
                                "params": {
                                    "image": "/resources/runtime/images/illustrations/x.png",
                                },
                            },
                        ],
                    },
                ],
            })
            report = audit_project_assets(root)
            self.assertEqual(report.issues, [])
            self.assertGreaterEqual(report.media_count, 5)


if __name__ == "__main__":
    unittest.main()
