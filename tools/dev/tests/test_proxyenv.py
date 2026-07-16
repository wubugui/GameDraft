"""Stdlib-only unit tests for proxy env isolation (no network)."""

import os

from tools.dev import proxyenv


def test_is_proxy_related_env_name():
    assert proxyenv.is_proxy_related_env_name("HTTP_PROXY")
    assert proxyenv.is_proxy_related_env_name("https_proxy")
    assert proxyenv.is_proxy_related_env_name("NO_PROXY")
    assert proxyenv.is_proxy_related_env_name("all_proxy")
    assert proxyenv.is_proxy_related_env_name("npm_config_https_proxy")
    assert not proxyenv.is_proxy_related_env_name("PATH")
    assert not proxyenv.is_proxy_related_env_name("npm_config_registry")


def test_mask_and_restore(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://example:1")
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))
    snapshot = proxyenv.proxy_env_snapshot()
    assert snapshot.get("HTTP_PROXY") == "http://example:1"

    with proxyenv.without_proxy():
        assert os.environ.get("HTTP_PROXY") is None
        assert os.environ.get("NO_PROXY") == "*"
        # PATH (non-proxy) is untouched.
        assert "PATH" in os.environ

    assert os.environ.get("HTTP_PROXY") == "http://example:1"


def test_git_proxy_url_precedence(monkeypatch):
    monkeypatch.delenv("GAMEDRAFT_GIT_PROXY", raising=False)
    assert proxyenv.git_proxy_url() == proxyenv.DEFAULT_GIT_PROXY
    assert proxyenv.git_proxy_url("http://arg:9") == "http://arg:9"
    monkeypatch.setenv("GAMEDRAFT_GIT_PROXY", "http://env:8")
    assert proxyenv.git_proxy_url() == "http://env:8"
    # Explicit arg still wins over env.
    assert proxyenv.git_proxy_url("http://arg:9") == "http://arg:9"


def test_loopback_safe_proxy_env(monkeypatch):
    monkeypatch.delenv("GAMEDRAFT_GIT_PROXY", raising=False)
    env = proxyenv.loopback_safe_proxy_env("http://p:7")
    assert env["HTTP_PROXY"] == "http://p:7"
    assert env["NO_PROXY"] == proxyenv.LOOPBACK_NO_PROXY
