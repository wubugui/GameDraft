from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.asset_candidates import (
    batch_create_redraw_tasks,
    build_redraw_task_from_candidate,
    format_asset_candidate_redraw_task_report,
    format_asset_candidate_report,
    format_asset_candidate_score_report,
    list_asset_candidates,
    load_candidate_reviews,
    review_status_label,
    save_candidate_review,
    score_asset_candidates,
)
from tools.production_workbench.asset_tasks import AssetTask, asset_task_to_dict, asset_tasks_path
from tools.production_workbench.codex_asset_runner import asset_task_runs_root


class ProductionWorkbenchAssetCandidateTests(TestCase):
    def test_lists_saved_path_candidates_with_image_metadata(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            image_path = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image_path.parent.mkdir(parents=True)
            Image.new("RGBA", (32, 24), (255, 0, 0, 128)).save(image_path)
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {
                            "savedPaths": [
                                "public/resources/runtime/images/props/ring.png",
                                "public/resources/runtime/images/props/missing.png",
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = list_asset_candidates(root)
            text = format_asset_candidate_report(report)

            self.assertEqual(len(report.candidates), 2)
            self.assertEqual(report.existing_count, 1)
            self.assertEqual(report.missing_count, 1)
            existing = next(item for item in report.candidates if item.exists)
            self.assertEqual(existing.display_path, "public/resources/runtime/images/props/ring.png")
            self.assertEqual((existing.width, existing.height), (32, 24))
            self.assertTrue(existing.has_alpha)
            self.assertIn("asset-ring", text)

    def test_candidate_review_persists_and_appears_in_report(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            image_path = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image_path.parent.mkdir(parents=True)
            Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(image_path)
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            first = list_asset_candidates(root).candidates[0]

            save_candidate_review(root, first.candidate_id, status="reject", note="边缘有脏边，需要重抽")
            report = list_asset_candidates(root)
            text = format_asset_candidate_report(report)

            self.assertEqual(load_candidate_reviews(root)[first.candidate_id].status, "reject")
            self.assertEqual(report.candidates[0].review_status, "reject")
            self.assertEqual(report.candidates[0].review_note, "边缘有脏边，需要重抽")
            self.assertIn(review_status_label("reject"), text)
            self.assertIn("边缘有脏边", text)

    def test_build_redraw_task_from_candidate_uses_review_note_and_specs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            image_path = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image_path.parent.mkdir(parents=True)
            Image.new("RGBA", (32, 24), (255, 0, 0, 128)).save(image_path)
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            candidate = list_asset_candidates(root).candidates[0]

            task = build_redraw_task_from_candidate(candidate, "铁环更旧一点，边缘更干净")

            self.assertEqual(task.category, "prop")
            self.assertEqual(task.operation, "redraw")
            self.assertEqual(task.target_path, "public/resources/runtime/images/props/ring.png")
            self.assertEqual(task.output_dir, "public/resources/runtime/images/props")
            self.assertEqual(task.reference_paths, ["public/resources/runtime/images/props/ring.png"])
            self.assertEqual((task.width, task.height), (32, 24))
            self.assertTrue(task.transparent)
            self.assertIn("铁环更旧一点", task.request)

    def test_candidate_report_includes_output_validation_result(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
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

            report = list_asset_candidates(root)
            text = format_asset_candidate_report(report)

            by_path = {item.display_path: item for item in report.candidates}
            self.assertEqual(by_path["public/resources/runtime/images/props/ring.png"].validation_status, "passed")
            self.assertEqual(by_path["public/resources/runtime/images/props/bad_ring.png"].validation_status, "failed")
            self.assertIn("验收通过", text)
            self.assertIn("验收失败", text)
            self.assertIn("尺寸不符合任务", text)

    def test_batch_create_redraw_tasks_for_flagged_candidates(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
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
            first_report = list_asset_candidates(root)
            good_candidate = next(
                item for item in first_report.candidates
                if item.display_path == "public/resources/runtime/images/props/ring.png"
            )
            save_candidate_review(root, good_candidate.candidate_id, status="reject", note="边缘脏，重抽")
            report = list_asset_candidates(root)

            result = batch_create_redraw_tasks(root, report.candidates)
            text = format_asset_candidate_redraw_task_report(result)

            self.assertEqual(result.created_count, 2)
            self.assertEqual(result.skipped_count, 0)
            self.assertIn("素材候选批量重抽任务", text)
            path = asset_tasks_path(root)
            rows = [
                json.loads(line)
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(rows), 2)
            requests = "\n".join(str(row.get("request") or "") for row in rows)
            self.assertIn("边缘脏，重抽", requests)
            self.assertIn("尺寸不符合任务", requests)

    def test_score_asset_candidates_sorts_by_delivery_readiness(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
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
                                "public/resources/runtime/images/props/missing.png",
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            report = list_asset_candidates(root)
            good_candidate = next(
                item for item in report.candidates
                if item.display_path == "public/resources/runtime/images/props/ring.png"
            )
            save_candidate_review(root, good_candidate.candidate_id, status="accepted", note="可用")
            report = list_asset_candidates(root)

            score_report = score_asset_candidates(root, report.candidates)
            text = format_asset_candidate_score_report(score_report)

            self.assertEqual(score_report.items[0].display_path, "public/resources/runtime/images/props/ring.png")
            self.assertGreater(score_report.items[0].score, score_report.items[-1].score)
            self.assertEqual(score_report.items[-1].score, 0)
            self.assertIn("素材候选交付评分", text)
            self.assertIn("不判断美术质量", text)
            self.assertIn("自动验收失败", text)

    def test_empty_candidate_report_is_human_readable(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"

            report = list_asset_candidates(root)
            text = format_asset_candidate_report(report)

            self.assertEqual(report.candidates, [])
            self.assertIn("还没有 Codex 素材任务运行记录", text)


if __name__ == "__main__":
    import unittest

    unittest.main()
