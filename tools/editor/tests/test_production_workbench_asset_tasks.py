from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.editor.tests.test_production_workbench_asset_audit import _png_bytes
from tools.production_workbench.asset_tasks import (
    AssetTask,
    asset_tasks_path,
    build_asset_task_prompt,
    save_asset_task,
    suggest_task_defaults,
)


class ProductionWorkbenchAssetTaskTests(TestCase):
    def test_asset_task_prompt_contains_structured_generation_requirements(self) -> None:
        task = AssetTask(
            title="重抽铁环道具",
            category="prop",
            operation="redraw",
            request="保留竹编铁环轮廓，去掉多余文字。",
            target_path="public/resources/runtime/images/props/ring.png",
            output_dir="public/resources/runtime/images/props",
            reference_paths=["public/resources/runtime/images/props/old_ring.png"],
            width=512,
            height=512,
            transparent=True,
            frame_count=None,
            style_notes="民国重庆乡土质感，手绘但边缘干净。",
            acceptance="透明背景，不能有文字。",
        )

        prompt = build_asset_task_prompt(task)

        self.assertIn("重抽铁环道具", prompt)
        self.assertIn("目标尺寸: 512x512", prompt)
        self.assertIn("透明背景: 需要", prompt)
        self.assertIn("old_ring.png", prompt)
        self.assertIn("不能有文字", prompt)

    def test_save_asset_task_appends_jsonl_with_prompt(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            task = AssetTask(
                title="坏路径会被清理",
                category="prop",
                operation="new",
                request="生成一个小道具。",
                target_path="../bad.png",
            )

            saved = save_asset_task(root, task)
            path = asset_tasks_path(root)
            line = path.read_text(encoding="utf-8").strip()
            payload = json.loads(line)

            self.assertTrue(saved.task_id.startswith("asset-"))
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["targetPath"], "")
            self.assertIn("prompt", payload)
            self.assertIn("生成一个小道具", payload["prompt"])

    def test_suggest_task_defaults_uses_existing_asset_specs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            prop = root / "public" / "resources" / "runtime" / "images" / "props"
            prop.mkdir(parents=True)
            (prop / "ring_a.png").write_bytes(_png_bytes(64, 64, color_type=6))
            (prop / "ring_b.png").write_bytes(_png_bytes(64, 64, color_type=6))

            defaults = suggest_task_defaults(root, "prop")

            self.assertEqual(defaults["outputDir"], "public/resources/runtime/images/props")
            self.assertEqual((defaults["width"], defaults["height"]), (64, 64))
            self.assertTrue(defaults["transparent"])
            self.assertEqual(len(defaults["referencePaths"]), 2)


if __name__ == "__main__":
    import unittest

    unittest.main()
