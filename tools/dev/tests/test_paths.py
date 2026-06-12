"""Stdlib-only unit tests for interpreter resolution."""

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
    assert name.endswith("npm") or name == "npm"
