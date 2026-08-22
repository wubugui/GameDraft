"""Bootstrap/clean behavior tests (no network, no real filesystem outside tmp)."""

from __future__ import annotations

from tools.dev import bootstrap, sync


def test_clean_removes_every_dvc_workspace_directory():
    """clean 漏掉一个 DVC 目录 = 留下"目录还在、缓存已清空"的半残状态。

    那个状态下,下一次 push 展开该目标的缓存清单会直接抛 FileNotFoundError。
    """
    for path in sync.COMMIT_DVC_ADD_PATHS:
        assert path in bootstrap.CLEAN_PATHS, path
    assert ".dvc/cache" in bootstrap.CLEAN_PATHS


def test_clean_names_what_it_is_about_to_delete(monkeypatch, capsys):
    removed = []
    monkeypatch.setattr(bootstrap, "_remove_repo_path", lambda path: removed.append(path))

    assert bootstrap.clean_local_environment(assume_yes=True) == 0

    assert removed == bootstrap.CLEAN_PATHS
    out = capsys.readouterr().out
    for path in bootstrap.CLEAN_PATHS:
        assert path in out


def test_clean_refuses_to_touch_anything_outside_the_repo(tmp_path, monkeypatch):
    monkeypatch.setattr(bootstrap, "repo_root", lambda: tmp_path)
    outside = tmp_path.parent / "not-in-repo.txt"
    outside.write_text("keep me", encoding="utf-8")
    try:
        try:
            bootstrap._remove_repo_path("../not-in-repo.txt")
        except SystemExit:
            pass
        assert outside.is_file()
    finally:
        outside.unlink()


def test_initialize_editor_stops_at_runtime_and_editor_projects(monkeypatch):
    """配音音源(70MB)不进通用编辑器初始化,只走 init-audio / pull --audio。"""
    targets = []
    monkeypatch.setattr(bootstrap, "_initialize", lambda ts: targets.extend(ts))

    assert bootstrap.initialize_editor() == 0

    assert targets == [sync.RUNTIME_TARGET, sync.EDITOR_TARGET]
    assert sync.AUDIO_SOURCES_TARGET not in targets


def test_initialize_game_stops_at_the_runtime_target(monkeypatch):
    targets = []
    monkeypatch.setattr(bootstrap, "_initialize", lambda ts: targets.extend(ts))

    assert bootstrap.initialize_game() == 0

    assert targets == [sync.RUNTIME_TARGET]
