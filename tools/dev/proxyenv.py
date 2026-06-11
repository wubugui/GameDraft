"""Proxy environment isolation, ported from scripts/no-proxy.ps1.

Aliyun OSS phases must not go through a local HTTP proxy; git remotes may
need one. The masking/restore semantics here mirror the PowerShell helpers
one-to-one — orchestrators (pull/push) mask once at entry so nested
``without_proxy()`` blocks do not restore inherited HTTP(S)_PROXY mid-run.
"""

from __future__ import annotations

import contextlib
import os
import subprocess
from collections.abc import Iterator

from tools.dev import winenv

DEFAULT_GIT_PROXY = "http://127.0.0.1:7078"
# Local dev server must bypass any temporary proxy (HMR / loopback).
LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1"


def is_proxy_related_env_name(name: str) -> bool:
    lu = name.lower()
    if lu.endswith("_proxy"):
        return True
    if lu in ("no_proxy", "all_proxy"):
        return True
    if lu.startswith("npm_config_") and "proxy" in lu:
        return True
    return False


def proxy_env_snapshot() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if is_proxy_related_env_name(k)}


def clear_proxy_env() -> None:
    for name in [k for k in os.environ if is_proxy_related_env_name(k)]:
        del os.environ[name]


def restore_proxy_env(snapshot: dict[str, str]) -> None:
    clear_proxy_env()
    for key, value in snapshot.items():
        os.environ[key] = value


def mask_proxy_env() -> None:
    """Clear proxy vars; NO_PROXY=* avoids hostname wildcard quirks for OSS."""
    clear_proxy_env()
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


@contextlib.contextmanager
def without_proxy() -> Iterator[None]:
    previous = proxy_env_snapshot()
    mask_proxy_env()
    try:
        yield
    finally:
        restore_proxy_env(previous)


def git_proxy_url(proxy_url: str = "") -> str:
    u = (proxy_url or "").strip()
    if not u:
        u = os.environ.get("GAMEDRAFT_GIT_PROXY", "").strip()
    if not u:
        u = (winenv.read_user_env("GAMEDRAFT_GIT_PROXY") or "").strip()
    if not u:
        u = (winenv.read_machine_env("GAMEDRAFT_GIT_PROXY") or "").strip()
    if not u:
        # Default local Git proxy (e.g. clash/v2ray mixed port); override with
        # --git-proxy or GAMEDRAFT_GIT_PROXY.
        u = DEFAULT_GIT_PROXY
    return u


def run_git_with_temp_proxy(git_args: list[str], proxy_url: str = "") -> int:
    """``git -c http.proxy=… -c https.proxy=… <args>`` for this call only.

    Mask sets NO_PROXY=*; omit NO_PROXY for this git invocation so -c
    http.proxy applies.
    """
    if not git_args:
        raise ValueError("Need at least one git argument.")
    u = git_proxy_url(proxy_url)
    prev = {k: os.environ.pop(k) for k in ("NO_PROXY", "no_proxy") if k in os.environ}
    try:
        return subprocess.call(
            ["git", "-c", f"http.proxy={u}", "-c", f"https.proxy={u}", *git_args]
        )
    finally:
        os.environ.update(prev)


def loopback_safe_proxy_env(proxy_url: str = "") -> dict[str, str]:
    """Temp proxy env for npm/node calls, keeping loopback traffic direct."""
    u = git_proxy_url(proxy_url)
    return {
        "HTTP_PROXY": u,
        "HTTPS_PROXY": u,
        "http_proxy": u,
        "https_proxy": u,
        "NO_PROXY": LOOPBACK_NO_PROXY,
        "no_proxy": LOOPBACK_NO_PROXY,
    }
