"""Dependency installer behavior tests (no network)."""

from __future__ import annotations

from pathlib import Path

from tools.dev import deps, proxyenv


def test_install_deps_uses_default_temporary_proxy(monkeypatch, tmp_path: Path):
    (tmp_path / "node_modules").mkdir()
    pip_envs = []

    def fake_pip(_args, _description, env=None):
        pip_envs.append(env)

    monkeypatch.setattr(deps, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(deps, "_pip", fake_pip)

    deps.install_deps()

    assert pip_envs
    assert all(env is not None for env in pip_envs)
    assert all(env["HTTP_PROXY"] == proxyenv.DEFAULT_GIT_PROXY for env in pip_envs)
    assert all(env["NO_PROXY"] == proxyenv.LOOPBACK_NO_PROXY for env in pip_envs)


def test_install_deps_can_disable_temporary_proxy(monkeypatch, tmp_path: Path):
    (tmp_path / "node_modules").mkdir()
    pip_envs = []

    def fake_pip(_args, _description, env=None):
        pip_envs.append(env)

    monkeypatch.setattr(deps, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(deps, "_pip", fake_pip)

    deps.install_deps(no_proxy=True)

    assert pip_envs == [None, None]
