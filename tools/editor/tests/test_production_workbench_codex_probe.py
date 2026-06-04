from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from tools.production_workbench.codex_probe import find_codex_executable


class ProductionWorkbenchCodexProbeTests(TestCase):
    def test_find_codex_executable_prefers_explicit_environment_path(self) -> None:
        expected = r"C:\Tools\Codex\codex.exe"

        with patch.dict(os.environ, {"GAMEDRAFT_CODEX_EXE": expected}, clear=True):
            self.assertEqual(find_codex_executable(), expected)

    def test_find_codex_executable_skips_windowsapps_alias_and_uses_extension_cli(self) -> None:
        with TemporaryDirectory() as td:
            home = Path(td)
            extension_codex = (
                home
                / ".vscode"
                / "extensions"
                / "openai.chatgpt-test"
                / "bin"
                / "win32"
                / "codex.exe"
            )
            extension_codex.parent.mkdir(parents=True)
            extension_codex.write_text("", encoding="utf-8")
            windowsapps_alias = (
                r"C:\Program Files\WindowsApps"
                r"\OpenAI.Codex_26.527.7698.0_x64__2p2nqsd0c76g0"
                r"\app\resources\codex.EXE"
            )

            with (
                patch.dict(os.environ, {}, clear=True),
                patch("tools.production_workbench.codex_probe.shutil.which", return_value=windowsapps_alias),
                patch("tools.production_workbench.codex_probe.Path.home", return_value=home),
            ):
                self.assertEqual(find_codex_executable(), str(extension_codex))

    def test_find_codex_executable_prefers_windows_cli_over_linux_cli_on_windows(self) -> None:
        with TemporaryDirectory() as td:
            home = Path(td)
            extension_root = home / ".vscode" / "extensions" / "openai.chatgpt-test" / "bin"
            linux_codex = extension_root / "linux-x86_64" / "codex"
            windows_codex = extension_root / "windows-x86_64" / "codex.exe"
            linux_codex.parent.mkdir(parents=True)
            windows_codex.parent.mkdir(parents=True)
            linux_codex.write_text("", encoding="utf-8")
            windows_codex.write_text("", encoding="utf-8")

            with (
                patch.dict(os.environ, {}, clear=True),
                patch("tools.production_workbench.codex_probe.shutil.which", return_value=None),
                patch("tools.production_workbench.codex_probe.Path.home", return_value=home),
                patch("tools.production_workbench.codex_probe.sys.platform", "win32"),
            ):
                self.assertEqual(find_codex_executable(), str(windows_codex))

    def test_find_codex_executable_returns_none_when_only_windowsapps_alias_exists(self) -> None:
        windowsapps_alias = (
            r"C:\Program Files\WindowsApps"
            r"\OpenAI.Codex_26.527.7698.0_x64__2p2nqsd0c76g0"
            r"\app\resources\codex.EXE"
        )

        with TemporaryDirectory() as td:
            with (
                patch.dict(os.environ, {}, clear=True),
                patch("tools.production_workbench.codex_probe.shutil.which", return_value=windowsapps_alias),
                patch("tools.production_workbench.codex_probe.Path.home", return_value=Path(td)),
            ):
                self.assertIsNone(find_codex_executable())


if __name__ == "__main__":
    import unittest

    unittest.main()
