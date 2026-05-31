from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.asset_candidates import (
    list_asset_candidates,
    save_candidate_review,
)
from tools.production_workbench.asset_postprocess import (
    AssetPostprocessOptions,
    eligible_postprocess_candidates,
    format_asset_postprocess_report,
    postprocess_candidates,
    postprocess_saved_paths,
)
from tools.production_workbench.asset_tasks import AssetTask, asset_task_to_dict
from tools.production_workbench.codex_asset_runner import asset_task_runs_root
from tools.production_workbench.image_tools import inspect_image


class ProductionWorkbenchAssetPostprocessTests(TestCase):
    def test_postprocesses_passed_or_kept_candidates_only(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_candidate_run(root)
            report = list_asset_candidates(root)
            by_path = {item.display_path: item for item in report.candidates}
            failed = by_path["public/resources/runtime/images/props/bad_ring.png"]
            save_candidate_review(root, failed.candidate_id, status="keep", note="虽然尺寸不对，但先出临时版")
            report = list_asset_candidates(root)

            result = postprocess_candidates(
                root,
                report.candidates,
                AssetPostprocessOptions(
                    output_dir="public/resources/runtime/images/processed",
                    output_format="png",
                    suffix="_ready",
                    resize_width=8,
                    resize_height=8,
                    keep_aspect=False,
                    trim_transparent=True,
                ),
            )
            text = format_asset_postprocess_report(result)

            self.assertEqual(len(eligible_postprocess_candidates(report.candidates)), 2)
            self.assertEqual(result.ok_count, 2)
            self.assertIn("素材候选批量后处理", text)
            outputs = [item.output_path for item in result.processed if item.output_path is not None]
            self.assertEqual(len(outputs), 2)
            for output in outputs:
                self.assertTrue(output.is_file())
                info = inspect_image(output)
                self.assertEqual((info.width, info.height), (8, 8))

    def test_reject_and_failed_unkept_candidates_are_skipped(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_candidate_run(root)
            report = list_asset_candidates(root)
            by_path = {item.display_path: item for item in report.candidates}
            passed = by_path["public/resources/runtime/images/props/ring.png"]
            save_candidate_review(root, passed.candidate_id, status="reject", note="不用")
            report = list_asset_candidates(root)

            result = postprocess_candidates(
                root,
                report.candidates,
                AssetPostprocessOptions(output_format="png"),
            )

            self.assertEqual(result.ok_count, 0)
            self.assertEqual(len(result.skipped), 2)
            self.assertTrue(any("废弃" in item.message for item in result.skipped))
            self.assertTrue(any("自动验收失败" in item.message for item in result.skipped))

    def test_postprocess_saved_paths_creates_ready_copy(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            src = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            src.parent.mkdir(parents=True)
            Image.new("RGBA", (20, 20), (255, 0, 0, 255)).save(src)

            result = postprocess_saved_paths(
                root,
                ["public/resources/runtime/images/props/ring.png"],
                AssetPostprocessOptions(
                    output_dir="public/resources/runtime/images/processed",
                    suffix="_ready",
                    output_format="png",
                    resize_width=10,
                    resize_height=8,
                    keep_aspect=False,
                ),
            )

            self.assertEqual(result.ok_count, 1)
            output = result.processed[0].output_path
            self.assertIsNotNone(output)
            self.assertTrue(output.is_file())
            self.assertEqual(inspect_image(output).width, 10)  # type: ignore[arg-type]
            self.assertEqual(inspect_image(output).height, 8)  # type: ignore[arg-type]


def _write_candidate_run(root: Path) -> None:
    good = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
    bad = root / "public" / "resources" / "runtime" / "images" / "props" / "bad_ring.png"
    good.parent.mkdir(parents=True)
    Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(good)
    Image.new("RGB", (8, 8), (255, 0, 0)).save(bad)
    run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
    run_dir.mkdir(parents=True)
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
    (run_dir / "summary.json").write_text(
        json.dumps(
            {
                "taskId": "asset-ring",
                "task": asset_task_to_dict(task),
                "eventSummary": {
                    "savedPaths": [
                        "public/resources/runtime/images/props/ring.png",
                        "public/resources/runtime/images/props/bad_ring.png",
                    ]
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    import unittest

    unittest.main()
