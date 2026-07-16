"""OSS credential load / prompt / persist."""

from __future__ import annotations

import getpass
import os
from pathlib import Path

from tools.dev.paths import repo_root

KEY_ID = "OSS_ACCESS_KEY_ID"
KEY_SECRET = "OSS_ACCESS_KEY_SECRET"

MISSING_CREDS_MESSAGE = (
    "OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET must both be set. "
    "Run ./bootstrap.sh first so credentials are collected into .tools/oss.env, "
    "or export them in this shell before using OSS-backed tasks."
)


def oss_env_file() -> Path:
    return repo_root() / ".tools" / "oss.env"


def read_oss_env_file() -> dict[str, str]:
    path = oss_env_file()
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def write_oss_env_file(key_id: str, key_secret: str) -> Path:
    path = oss_env_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{KEY_ID}={key_id}\n{KEY_SECRET}={key_secret}\n", encoding="utf-8")
    if os.name == "posix":
        os.chmod(path, 0o600)
    return path


def hydrate_credentials() -> tuple[str | None, str | None]:
    """Fill os.environ from file; return (key_id, secret)."""
    kid = os.environ.get(KEY_ID)
    ks = os.environ.get(KEY_SECRET)
    if kid and ks:
        return kid, ks

    from_file = read_oss_env_file()
    kid = kid or from_file.get(KEY_ID)
    ks = ks or from_file.get(KEY_SECRET)

    if kid:
        os.environ[KEY_ID] = kid
    if ks:
        os.environ[KEY_SECRET] = ks
    return kid, ks


def ensure_credentials(prompt: bool = False) -> tuple[str, str]:
    """Hydrate, optionally prompting interactively; raise when unavailable."""
    kid, ks = hydrate_credentials()
    if kid and ks:
        return kid, ks
    if not prompt:
        raise SystemExit(MISSING_CREDS_MESSAGE)

    print(f"OSS credentials are missing. They will be saved to {oss_env_file()}.")
    if not kid:
        kid = input(f"{KEY_ID}: ").strip()
    if not ks:
        ks = getpass.getpass(f"{KEY_SECRET}: ").strip()
    if not (kid and ks):
        raise SystemExit(MISSING_CREDS_MESSAGE)
    write_oss_env_file(kid, ks)
    os.environ[KEY_ID] = kid
    os.environ[KEY_SECRET] = ks
    print("OSS credentials: saved")
    return kid, ks


def assert_credentials() -> None:
    ensure_credentials(prompt=False)
