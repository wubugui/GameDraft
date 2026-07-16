"""Dependency installer behavior tests (no network)."""

from __future__ import annotations

from pathlib import Path

from tools.dev import deps, proxyenv


def test_pip_places_proxy_before_command_and_progress_after_install(monkeypatch):
    calls = []

    def fake_call(argv, cwd=None, env=None):
        calls.append(argv)
        return 0

    monkeypatch.setattr(deps.subprocess, "call", fake_call)

    deps._pip(
        ["install", "-r", "requirements.txt"],
        "Installing test deps",
        proxy_url="http://proxy:7",
    )

    assert calls == [
        [
            str(deps.project_python()),
            "-m",
            "pip",
            "--proxy",
            "http://proxy:7",
            "install",
            "--progress-bar",
            "raw",
            "-r",
            "requirements.txt",
        ]
    ]


def test_install_deps_uses_default_temporary_proxy(monkeypatch, tmp_path: Path):
    (tmp_path / "node_modules").mkdir()
    pip_envs = []
    pip_proxies = []

    def fake_pip(_args, _description, env=None, proxy_url=""):
        pip_envs.append(env)
        pip_proxies.append(proxy_url)

    monkeypatch.setattr(deps, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(deps, "_pip", fake_pip)

    deps.install_deps()

    assert pip_envs
    assert all(env is not None for env in pip_envs)
    assert all(env["HTTP_PROXY"] == proxyenv.DEFAULT_GIT_PROXY for env in pip_envs)
    assert all(env["NO_PROXY"] == proxyenv.LOOPBACK_NO_PROXY for env in pip_envs)
    assert pip_proxies == [proxyenv.DEFAULT_GIT_PROXY, proxyenv.DEFAULT_GIT_PROXY]


def test_install_deps_can_disable_temporary_proxy(monkeypatch, tmp_path: Path):
    (tmp_path / "node_modules").mkdir()
    pip_envs = []
    pip_proxies = []

    def fake_pip(_args, _description, env=None, proxy_url=""):
        pip_envs.append(env)
        pip_proxies.append(proxy_url)

    monkeypatch.setattr(deps, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(deps, "_pip", fake_pip)

    deps.install_deps(no_proxy=True)

    assert pip_envs == [None, None]
    assert pip_proxies == ["", ""]
