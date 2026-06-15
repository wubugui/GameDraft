"""DVC/git orchestration behavior tests (no network or real git mutation)."""

from __future__ import annotations

from tools.dev import sync


def test_pull_syncs_vendor_runtime_and_editor(monkeypatch):
    calls = []

    monkeypatch.setattr(sync.proxyenv, "mask_proxy_env", lambda: calls.append(("mask",)))
    monkeypatch.setattr(sync.proxyenv, "run_git_with_temp_proxy", lambda argv, proxy: calls.append(("git", argv, proxy)) or 0)
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: calls.append(("python",)))
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: calls.append(("creds",)))
    monkeypatch.setattr(sync, "pull_dvc_target", lambda target: calls.append(("dvc-pull", target)))

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


def test_push_checks_and_uploads_all_dvc_targets(monkeypatch):
    calls = []

    class NullContext:
        def __enter__(self):
            calls.append(("without-proxy-enter",))

        def __exit__(self, exc_type, exc, tb):
            calls.append(("without-proxy-exit",))

    monkeypatch.setattr(sync.proxyenv, "mask_proxy_env", lambda: calls.append(("mask",)))
    monkeypatch.setattr(sync.bootstrap, "ensure_local_python", lambda: calls.append(("python",)))
    monkeypatch.setattr(sync.creds, "assert_credentials", lambda: calls.append(("creds",)))
    monkeypatch.setattr(sync.proxyenv, "without_proxy", lambda: NullContext())
    monkeypatch.setattr(sync, "run_project_python", lambda argv: calls.append(("python-cmd", argv)) or 0)
    monkeypatch.setattr(sync, "sync_dvc_cache", lambda action, *targets: calls.append(("sync-cache", action, targets)))
    monkeypatch.setattr(sync.proxyenv, "run_git_with_temp_proxy", lambda argv, proxy: calls.append(("git", argv, proxy)) or 0)

    assert sync.push(git_proxy="http://proxy:7") == 0

    assert ("python-cmd", ["-m", "dvc", "status"]) in calls
    assert ("sync-cache", "push", (sync.RUNTIME_TARGET, sync.EDITOR_TARGET, sync.VENDOR_TARGET)) in calls
    assert calls[-1] == ("git", ["push"], "http://proxy:7")


def test_commit_adds_all_dvc_roots_and_git_paths(monkeypatch, tmp_path):
    calls = []

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
    git_add_calls = [call for call in calls if call[0] == "run" and call[1][:2] == ["git", "add"]]
    assert any("public/assets" in call[1] for call in git_add_calls)
    assert any("public/resources" in call[1] for call in git_add_calls)
    assert any("resources" in call[1] for call in git_add_calls)
    assert calls[-1] == ("call", ["git", "commit", "-m", "asset sync"], str(tmp_path))
