"""DVC/git orchestration behavior tests (no network or real git mutation)."""

from __future__ import annotations

from tools.dev import sync


class NullContext:
    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc, tb):
        return False


def _record_pull(monkeypatch, calls):
    monkeypatch.setattr(sync.proxyenv, "mask_proxy_env", lambda: calls.append(("mask",)))
    monkeypatch.setattr(sync.proxyenv, "run_git_with_temp_proxy", lambda argv, proxy: calls.append(("git", argv, proxy)) or 0)
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: calls.append(("python",)))
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: calls.append(("creds",)))
    monkeypatch.setattr(sync, "pull_dvc_target", lambda target: calls.append(("dvc-pull", target)))


def _pulled(calls):
    return [call[1] for call in calls if call[0] == "dvc-pull"]


def test_pull_syncs_vendor_runtime_and_editor(monkeypatch):
    calls = []
    _record_pull(monkeypatch, calls)

    assert sync.pull(editor=True, git_proxy="http://proxy:7") == 0

    assert calls == [
        ("mask",),
        ("git", ["pull"], "http://proxy:7"),
        ("python",),
        ("creds",),
        ("dvc-pull", sync.VENDOR_TARGET),
        ("dvc-pull", sync.RUNTIME_TARGET),
        ("dvc-pull", sync.EDITOR_TARGET),
    ]


def test_pull_default_set_is_only_what_running_the_game_needs(monkeypatch):
    calls = []
    _record_pull(monkeypatch, calls)

    assert sync.pull() == 0

    assert _pulled(calls) == [sync.VENDOR_TARGET, sync.RUNTIME_TARGET]


def test_pull_leaves_audio_sources_out_of_the_editor_flag(monkeypatch):
    """scripts/pull-all.sh 无条件带 --editor —— 音源并进去就等于变成默认拉取。"""
    calls = []
    _record_pull(monkeypatch, calls)

    assert sync.pull(editor=True) == 0

    assert sync.AUDIO_SOURCES_TARGET not in _pulled(calls)
    assert sync.AUDIO_IMPORTED_TARGET not in _pulled(calls)


def test_pull_fetches_audio_sources_only_with_its_own_flag(monkeypatch):
    calls = []
    _record_pull(monkeypatch, calls)

    assert sync.pull(editor=True, audio=True) == 0

    assert _pulled(calls) == [
        sync.VENDOR_TARGET,
        sync.RUNTIME_TARGET,
        sync.EDITOR_TARGET,
        sync.AUDIO_SOURCES_TARGET,
        sync.AUDIO_IMPORTED_TARGET,
    ]


def test_audio_can_be_pulled_without_the_editor_projects(monkeypatch):
    calls = []
    _record_pull(monkeypatch, calls)

    assert sync.pull(audio=True) == 0

    assert _pulled(calls) == [
        sync.VENDOR_TARGET,
        sync.RUNTIME_TARGET,
        sync.AUDIO_SOURCES_TARGET,
        sync.AUDIO_IMPORTED_TARGET,
    ]


def test_init_audio_pulls_vendor_and_the_source_library(monkeypatch):
    calls = []
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: None)
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: None)
    monkeypatch.setattr(sync, "pull_dvc_target", lambda target: calls.append(target))

    assert sync.init_audio() == 0

    assert calls == [
        sync.VENDOR_TARGET,
        sync.AUDIO_SOURCES_TARGET,
        sync.AUDIO_IMPORTED_TARGET,
    ]


def test_init_editor_does_not_drag_in_the_audio_sources(monkeypatch):
    calls = []
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: None)
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: None)
    monkeypatch.setattr(sync, "pull_dvc_target", lambda target: calls.append(target))

    assert sync.init_editor() == 0

    assert calls == [sync.VENDOR_TARGET, sync.EDITOR_TARGET]
    assert sync.AUDIO_IMPORTED_TARGET not in calls


def test_push_checks_and_uploads_all_dvc_targets(monkeypatch):
    calls = []

    class RecordingContext:
        def __enter__(self):
            calls.append(("without-proxy-enter",))

        def __exit__(self, exc_type, exc, tb):
            calls.append(("without-proxy-exit",))

    monkeypatch.setattr(sync.proxyenv, "mask_proxy_env", lambda: calls.append(("mask",)))
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: calls.append(("python",)))
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: calls.append(("creds",)))
    monkeypatch.setattr(sync.proxyenv, "without_proxy", lambda: RecordingContext())
    monkeypatch.setattr(sync, "run_project_python", lambda argv: calls.append(("python-cmd", argv)) or 0)
    monkeypatch.setattr(sync, "sync_dvc_cache", lambda action, *targets: calls.append(("sync-cache", action, targets)))
    monkeypatch.setattr(sync.proxyenv, "run_git_with_temp_proxy", lambda argv, proxy: calls.append(("git", argv, proxy)) or 0)
    monkeypatch.setattr(sync, "target_is_in_local_cache", lambda target: True)

    assert sync.push(git_proxy="http://proxy:7") == 0

    assert ("python-cmd", ["-m", "dvc", "status"]) in calls
    assert ("sync-cache", "push", tuple(sync.ALL_DVC_TARGETS)) in calls
    assert sync.ALL_DVC_TARGETS == [
        sync.RUNTIME_TARGET,
        sync.EDITOR_TARGET,
        sync.VENDOR_TARGET,
        sync.AUDIO_SOURCES_TARGET,
        sync.AUDIO_IMPORTED_TARGET,
    ]
    assert calls[-1] == ("git", ["push"], "http://proxy:7")


def _stub_push_environment(monkeypatch, calls):
    monkeypatch.setattr(sync.proxyenv, "mask_proxy_env", lambda: None)
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: None)
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: None)
    monkeypatch.setattr(sync.proxyenv, "without_proxy", lambda: NullContext())
    monkeypatch.setattr(sync, "run_project_python", lambda argv: 0)
    monkeypatch.setattr(sync, "sync_dvc_cache", lambda action, *targets: calls.append((action, targets)))
    monkeypatch.setattr(sync.proxyenv, "run_git_with_temp_proxy", lambda argv, proxy: 0)


def test_push_skips_targets_this_machine_never_pulled(monkeypatch, capsys):
    """没拉过 --audio 的机器上,盲目 push 会炸在缺失的 .dir 缓存 blob 上。"""
    calls = []
    _stub_push_environment(monkeypatch, calls)
    optional = {sync.AUDIO_SOURCES_TARGET, sync.AUDIO_IMPORTED_TARGET}
    monkeypatch.setattr(sync, "target_is_in_local_cache", lambda target: target not in optional)

    assert sync.push() == 0

    assert calls == [("push", (sync.RUNTIME_TARGET, sync.EDITOR_TARGET, sync.VENDOR_TARGET))]
    out = capsys.readouterr().out
    assert sync.AUDIO_SOURCES_TARGET in out
    assert sync.AUDIO_IMPORTED_TARGET in out


def test_push_skips_the_cache_transfer_entirely_when_nothing_is_local(monkeypatch):
    calls = []
    _stub_push_environment(monkeypatch, calls)
    monkeypatch.setattr(sync, "target_is_in_local_cache", lambda target: False)

    assert sync.push() == 0

    assert calls == []


def test_target_is_in_local_cache_reads_the_dvcfile_and_the_cache_blob(monkeypatch, tmp_path):
    monkeypatch.setattr(sync, "repo_root", lambda: tmp_path)
    oid = "7aeef641f1379c9172a935ac2176d728.dir"
    dvcfile = tmp_path / "resources" / "audio_sources.dvc"
    dvcfile.parent.mkdir(parents=True)
    dvcfile.write_text(
        "outs:\n- md5: " + oid + "\n  path: audio_sources\n", encoding="utf-8"
    )

    assert sync.target_is_in_local_cache("resources/audio_sources.dvc") is False

    blob = tmp_path / ".dvc" / "cache" / "files" / "md5" / oid[:2] / oid[2:]
    blob.parent.mkdir(parents=True)
    blob.write_text("[]", encoding="utf-8")

    assert sync.target_is_in_local_cache("resources/audio_sources.dvc") is True
    assert sync.target_is_in_local_cache("resources/nope.dvc") is False


def test_commit_adds_all_dvc_roots_and_git_paths(monkeypatch, tmp_path):
    calls = []

    for path in sync.COMMIT_DVC_ADD_PATHS:
        (tmp_path / path).mkdir(parents=True)

    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: calls.append(("python",)))
    monkeypatch.setattr(sync, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(sync, "run_project_python", lambda argv: calls.append(("python-cmd", argv)) or 0)

    def fake_run(argv, cwd=None, check=False):
        calls.append(("run", argv, cwd, check))
        return 0

    def fake_call(argv, cwd=None):
        calls.append(("call", argv, cwd))
        return 0

    monkeypatch.setattr(sync.subprocess, "run", fake_run)
    monkeypatch.setattr(sync.subprocess, "call", fake_call)

    assert sync.commit("asset sync") == 0

    assert ("python-cmd", ["-m", "dvc", "add", *sync.COMMIT_DVC_ADD_PATHS]) in calls
    assert sync.COMMIT_DVC_ADD_PATHS == [
        "public/resources/runtime",
        "resources/editor_projects",
        "resources/vendor_archives",
        "resources/audio_sources",
        "tools/audio_editor/imported",
    ]
    git_add_calls = [call for call in calls if call[0] == "run" and call[1][:2] == ["git", "add"]]
    assert any("public/assets" in call[1] for call in git_add_calls)
    assert any("public/resources" in call[1] for call in git_add_calls)
    assert any("resources" in call[1] for call in git_add_calls)
    assert calls[-1] == ("call", ["git", "commit", "-m", "asset sync"], str(tmp_path))


def test_commit_skips_dvc_add_for_paths_absent_on_this_machine(monkeypatch, tmp_path, capsys):
    """`dvc add` 对不存在的目录直接报错退出——没拉过的可选目标必须先滤掉。"""
    calls = []

    for path in sync.COMMIT_DVC_ADD_PATHS:
        if path != "resources/audio_sources":
            (tmp_path / path).mkdir(parents=True)

    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: None)
    monkeypatch.setattr(sync, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(sync, "run_project_python", lambda argv: calls.append(argv) or 0)
    monkeypatch.setattr(sync.subprocess, "run", lambda argv, cwd=None, check=False: 0)
    monkeypatch.setattr(sync.subprocess, "call", lambda argv, cwd=None: 0)

    assert sync.commit("code only") == 0

    expected = [p for p in sync.COMMIT_DVC_ADD_PATHS if p != "resources/audio_sources"]
    assert calls == [["-m", "dvc", "add", *expected]]
    assert "resources/audio_sources" in capsys.readouterr().out
