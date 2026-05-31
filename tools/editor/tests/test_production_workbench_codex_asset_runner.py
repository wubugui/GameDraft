from __future__ import annotations

import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.asset_postprocess import AssetPostprocessOptions
from tools.production_workbench.asset_tasks import AssetTask
from tools.production_workbench.codex_asset_runner import (
    CodexAssetRunResult,
    CodexEventSummary,
    build_codex_asset_command,
    format_codex_asset_run_result,
    normalize_codex_events,
    run_codex_asset_task,
)
from tools.production_workbench.image_tools import inspect_image


class ProductionWorkbenchCodexAssetRunnerTests(TestCase):
    def test_normalize_codex_events_extracts_saved_path_token_usage_and_model(self) -> None:
        with TemporaryDirectory() as td:
            events_path = Path(td) / "events.jsonl"
            stdout = "\n".join(
                [
                    json.dumps({"type": "thread.started", "model": "gpt-test"}),
                    "not json",
                    json.dumps(
                        {
                            "type": "imageGeneration.completed",
                            "imageGeneration": {"savedPath": "public/resources/runtime/images/a.png"},
                            "tokenUsage": {"inputTokens": 10, "outputTokens": 20},
                        }
                    ),
                ]
            )

            summary = normalize_codex_events(stdout, events_path)

            self.assertEqual(summary.event_count, 2)
            self.assertEqual(summary.models, ["gpt-test"])
            self.assertEqual(summary.saved_paths, ["public/resources/runtime/images/a.png"])
            self.assertEqual(summary.token_usage[-1]["inputTokens"], 10)
            self.assertEqual(len(events_path.read_text(encoding="utf-8").splitlines()), 2)

    def test_build_codex_asset_command_reads_prompt_from_stdin(self) -> None:
        command = build_codex_asset_command(
            "codex",
            Path("D:/GameDraft"),
            Path("D:/GameDraft/out/last.md"),
        )

        self.assertIn("exec", command)
        self.assertIn("--json", command)
        self.assertIn("--enable", command)
        self.assertEqual(command[-1], "-")

    def test_format_codex_asset_run_result_summarizes_token_usage_without_raw_json(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            result = CodexAssetRunResult(
                ok=True,
                task_id="task_1",
                started_at="2026-05-31T00-00-00",
                ended_at="2026-05-31T00-00-01",
                exit_code=0,
                command=["codex"],
                run_dir=root,
                prompt_path=root / "prompt.md",
                stdout_path=root / "stdout.jsonl",
                stderr_path=root / "stderr.txt",
                events_path=root / "events.normalized.jsonl",
                summary_path=root / "summary.json",
                last_message_path=root / "last-message.md",
                event_summary=CodexEventSummary(
                    token_usage=[{"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}],
                ),
                message="完成",
            )

            text = format_codex_asset_run_result(result)

            self.assertIn("输入 10，输出 20，总计 30", text)
            self.assertNotIn('{"inputTokens"', text)

    def test_run_codex_asset_task_persists_run_evidence_without_real_codex(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            (root / "public" / "assets").mkdir(parents=True)

            def fake_runner(
                command: list[str],
                prompt: str,
                cwd: Path,
                timeout_sec: int,
            ) -> subprocess.CompletedProcess[str]:
                self.assertIn("素材", prompt)
                self.assertEqual(cwd, root.resolve())
                output = cwd / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(output)
                stdout = json.dumps(
                    {
                        "type": "imageGeneration.completed",
                        "imageGeneration": {"savedPath": "public/resources/runtime/images/props/ring.png"},
                        "tokenUsage": {"totalTokens": 99},
                        "model": "gpt-test",
                    }
                )
                return subprocess.CompletedProcess(command, 0, stdout, "")

            result = run_codex_asset_task(
                root,
                AssetTask(
                    title="生成铁环",
                    category="prop",
                    operation="new",
                    request="生成一个铁环道具。",
                    output_dir="public/resources/runtime/images/props",
                    width=16,
                    height=16,
                    transparent=True,
                ),
                runner=fake_runner,
                executable="codex",
                timeout_sec=1,
            )

            self.assertTrue(result.ok)
            self.assertTrue(result.prompt_path.is_file())
            self.assertTrue(result.stdout_path.is_file())
            self.assertTrue(result.stderr_path.is_file())
            self.assertTrue(result.summary_path.is_file())
            self.assertEqual(result.event_summary.models, ["gpt-test"])
            self.assertEqual(
                result.event_summary.saved_paths,
                ["public/resources/runtime/images/props/ring.png"],
            )
            summary = json.loads(result.summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["task"]["width"], 16)
            self.assertTrue(summary["outputValidation"]["ok"])
            self.assertTrue((result.run_dir / "output-validation.txt").is_file())

    def test_run_codex_asset_task_reports_progress_steps(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            (root / "public" / "assets").mkdir(parents=True)
            progress: list[str] = []

            def fake_runner(
                command: list[str],
                prompt: str,
                cwd: Path,
                timeout_sec: int,
            ) -> subprocess.CompletedProcess[str]:
                output = cwd / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(output)
                stdout = json.dumps(
                    {
                        "type": "imageGeneration.completed",
                        "imageGeneration": {"savedPath": "public/resources/runtime/images/props/ring.png"},
                    }
                )
                return subprocess.CompletedProcess(command, 0, stdout, "")

            run_codex_asset_task(
                root,
                AssetTask(
                    title="生成铁环",
                    category="prop",
                    operation="new",
                    request="生成一个铁环道具。",
                    output_dir="public/resources/runtime/images/props",
                ),
                runner=fake_runner,
                executable="codex",
                timeout_sec=1,
                progress=progress.append,
            )

            text = "\n".join(progress)
            self.assertIn("开始调用 Codex CLI", text)
            self.assertIn("Codex 进程结束", text)
            self.assertIn("事件解析完成", text)
            self.assertIn("已写入 summary", text)

    def test_run_codex_asset_task_can_auto_postprocess_saved_paths(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            (root / "public" / "assets").mkdir(parents=True)

            def fake_runner(
                command: list[str],
                prompt: str,
                cwd: Path,
                timeout_sec: int,
            ) -> subprocess.CompletedProcess[str]:
                output = cwd / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (32, 24), (255, 0, 0, 255)).save(output)
                stdout = json.dumps(
                    {
                        "type": "imageGeneration.completed",
                        "imageGeneration": {"savedPath": "public/resources/runtime/images/props/ring.png"},
                    }
                )
                return subprocess.CompletedProcess(command, 0, stdout, "")

            result = run_codex_asset_task(
                root,
                AssetTask(
                    title="生成铁环",
                    category="prop",
                    operation="new",
                    request="生成一个铁环道具。",
                    output_dir="public/resources/runtime/images/props",
                    width=16,
                    height=16,
                    transparent=True,
                ),
                runner=fake_runner,
                executable="codex",
                timeout_sec=1,
                postprocess_options=AssetPostprocessOptions(
                    output_dir="public/resources/runtime/images/props",
                    suffix="_ready",
                    output_format="png",
                    resize_width=16,
                    resize_height=16,
                    keep_aspect=False,
                    trim_transparent=True,
                ),
            )

            ready = root / "public" / "resources" / "runtime" / "images" / "props" / "ring_ready.png"
            self.assertTrue(result.postprocess_report is not None)
            self.assertTrue(ready.is_file())
            info = inspect_image(ready)
            self.assertEqual((info.width, info.height), (16, 16))
            self.assertTrue((result.run_dir / "postprocess.txt").is_file())
            summary = json.loads(result.summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["postprocess"]["okCount"], 1)
            self.assertIn(str(ready), summary["postprocess"]["outputs"])


if __name__ == "__main__":
    import unittest

    unittest.main()
