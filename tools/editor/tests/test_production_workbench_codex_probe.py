from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from tools.production_workbench.codex_probe import find_codex_executable


class ProductionWorkbenchCodexProbeTests(TestCase):
    def test_find_codex_executable_prefers_explicit_environment_path(self) -> None:
        expected = "/opt/homebrew/bin/codex"

        with patch.dict(os.environ, {"GAMEDRAFT_CODEX_EXE": expected}, clear=True):
            self.assertEqual(find_codex_executable(), expected)

    def test_find_codex_executable_uses_platform_extension_cli(self) -> None:
        with TemporaryDirectory() as td:
            home = Path(td)
            extension_codex = (
                home
                / ".vscode"
                / "extensions"
                / "openai.chatgpt-test"
                / "bin"
                / "darwin-arm64"
                / "codex"
            )
            extension_codex.parent.mkdir(parents=True)
            extension_codex.write_text("", encoding="utf-8")

            with (
                patch.dict(os.environ, {}, clear=True),
                patch("tools.production_workbench.codex_probe.shutil.which", return_value=None),
                patch("tools.production_workbench.codex_probe.Path.home", return_value=home),
            ):
                self.assertEqual(find_codex_executable(), str(extension_codex))

    def test_find_codex_executable_ignores_non_codex_extension_cli_name(self) -> None:
        with TemporaryDirectory() as td:
            home = Path(td)
            non_codex = (
                home
                / ".vscode"
                / "extensions"
                / "openai.chatgpt-test"
                / "bin"
                / "darwin-arm64"
                / "codex-helper"
            )
            non_codex.parent.mkdir(parents=True)
            non_codex.write_text("", encoding="utf-8")

            with (
                patch.dict(os.environ, {}, clear=True),
                patch("tools.production_workbench.codex_probe.shutil.which", return_value=None),
                patch("tools.production_workbench.codex_probe.Path.home", return_value=home),
            ):
                self.assertIsNone(find_codex_executable())


if __name__ == "__main__":
    import unittest

    unittest.main()
