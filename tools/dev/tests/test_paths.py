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


def test_node_dir_falls_back_to_the_vendored_node_on_windows(monkeypatch, tmp_path):
    """PATH 上没有 node 时,Windows 必须能认出 .tools/node 里那份便携版。

    这条锁的是一个真实故障:GUI 起的编辑器/控制台继承旧环境,`which node` 落空,
    而当时 Windows 侧一个候选目录都没有(只有 homebrew/volta/nvm 这些 POSIX 路径),
    于是 npm_command() 退回裸 "npm.cmd",启动游戏必炸 WinError 2。
    """
    vendored = tmp_path / ".tools" / "node" / "node-v22.14.0-win-x64"
    vendored.mkdir(parents=True)
    (vendored / "node.exe").write_bytes(b"")
    (vendored / "npm.cmd").write_bytes(b"")

    monkeypatch.setattr(paths.platform, "system", lambda: "Windows")
    monkeypatch.setattr(paths, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(paths.shutil, "which", lambda _tool: None)

    assert paths.node_dir() == vendored


def test_node_dir_is_none_on_windows_without_any_node(monkeypatch, tmp_path):
    """没装也没自带时如实返回 None——不要假装找到了一个不存在的目录。"""
    monkeypatch.setattr(paths.platform, "system", lambda: "Windows")
    monkeypatch.setattr(paths, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(paths.shutil, "which", lambda _tool: None)
    monkeypatch.setattr(paths.os.environ, "get", lambda *_a, **_k: "")

    assert paths.node_dir() is None


def test_node_dir_on_unix_still_only_looks_at_posix_dirs(monkeypatch, tmp_path):
    """Windows 分支不能污染 Unix:自带的 .tools/node 在 macOS/Linux 上不参与查找。"""
    vendored = tmp_path / ".tools" / "node" / "node-v22.14.0-win-x64"
    vendored.mkdir(parents=True)
    (vendored / "node.exe").write_bytes(b"")

    monkeypatch.setattr(paths.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(paths, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(paths.shutil, "which", lambda _tool: None)
    monkeypatch.setattr(paths, "_unix_node_candidate_dirs", list)

    assert paths.node_dir() is None
