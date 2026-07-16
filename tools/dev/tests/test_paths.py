"""Stdlib-only unit tests for interpreter resolution."""

from pathlib import Path

from tools.dev import paths


def test_repo_root_has_marker():
    root = paths.repo_root()
    assert (root / "package.json").is_file()
    assert (root / "tools" / "dev" / "__main__.py").is_file()


def test_project_python_returns_path():
    p = paths.project_python()
    assert p.name.lower().startswith("python")


def test_npm_command_shape():
    name = paths.npm_command()
    assert name.endswith(("npm", "npm.cmd", "npm.exe")) or name in {"npm", "npm.cmd"}


def test_npm_command_prefers_cmd_on_windows(monkeypatch):
    monkeypatch.setattr(paths.platform, "system", lambda: "Windows")
    monkeypatch.setattr(paths, "node_dir", lambda: Path("C:/Program Files/nodejs"))
    monkeypatch.setattr(Path, "is_file", lambda self: self.name == "npm.cmd")

    assert paths.npm_command().endswith("npm.cmd")


def test_npm_command_keeps_plain_npm_on_unix(monkeypatch):
    monkeypatch.setattr(paths.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(paths, "node_dir", lambda: Path("/opt/homebrew/bin"))
    monkeypatch.setattr(Path, "is_file", lambda self: self.name == "npm")

    assert paths.npm_command().endswith("npm")
