from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.asset_output_validation import (
    format_asset_output_validation_report,
    validate_asset_outputs,
    validate_codex_run_summary,
)
from tools.production_workbench.asset_tasks import AssetTask, asset_task_to_dict


class ProductionWorkbenchAssetOutputValidationTests(TestCase):
    def test_validates_saved_path_size_alpha_and_sheet_grid(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            output = root / "public" / "resources" / "runtime" / "animation" / "walk.png"
            output.parent.mkdir(parents=True)
            Image.new("RGBA", (40, 10), (255, 0, 0, 128)).save(output)

            report = validate_asset_outputs(
                root,
                AssetTask(
                    title="walk",
                    category="animation",
                    operation="animation_sheet",
                    request="walk",
                    output_dir="public/resources/runtime/animation",
                    width=40,
                    height=10,
                    transparent=True,
                    frame_count=4,
                    task_id="asset-walk",
                ),
                ["public/resources/runtime/animation/walk.png"],
            )
            text = format_asset_output_validation_report(report)

            self.assertTrue(report.ok, text)
            self.assertEqual(report.items[0].sheet_columns, 4)
            self.assertEqual(report.items[0].sheet_frame_width, 10)
            self.assertIn("素材输出验收: 通过", text)

    def test_reports_missing_output_and_mismatch(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            output = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            output.parent.mkdir(parents=True)
            Image.new("RGB", (8, 8), (255, 0, 0)).save(output)

            report = validate_asset_outputs(
                root,
                AssetTask(
                    title="ring",
                    category="prop",
                    operation="new",
                    request="ring",
                    width=16,
                    height=16,
                    transparent=True,
                    task_id="asset-ring",
                ),
                [
                    "public/resources/runtime/images/props/ring.png",
                    "public/resources/runtime/images/props/missing.png",
                ],
            )

            self.assertFalse(report.ok)
            codes = {issue.code for issue in report.issues}
            self.assertIn("asset.output.sizeMismatch", codes)
            self.assertIn("asset.output.alphaMismatch", codes)
            self.assertIn("asset.output.missing", codes)

    def test_validates_run_summary_task_snapshot(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            output = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            output.parent.mkdir(parents=True)
            Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(output)
            summary = root / "resources" / "editor_projects" / "editor_data" / "production_workbench" / "asset_task_runs" / "run" / "summary.json"
            summary.parent.mkdir(parents=True)
            task = AssetTask(
                title="ring",
                category="prop",
                operation="new",
                request="ring",
                width=16,
                height=16,
                transparent=True,
                task_id="asset-ring",
            )
            summary.write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "task": asset_task_to_dict(task),
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = validate_codex_run_summary(root, summary)

            self.assertTrue(report.ok, format_asset_output_validation_report(report))


if __name__ == "__main__":
    import unittest

    unittest.main()
