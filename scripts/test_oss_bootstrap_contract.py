#!/usr/bin/env python3
"""
Contract tests for OSS bootstrap / sync-dvc-cache behavior without real RAM keys.

Requires: pip install oss2 pyyaml
Run from repo root: python3 scripts/test_oss_bootstrap_contract.py
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent


def load_sync_dvc_cache():
    path = SCRIPTS / "sync-dvc-cache.py"
    spec = importlib.util.spec_from_file_location("sync_dvc_cache", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load sync-dvc-cache")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_is_likely_oss_auth_or_access_failure() -> None:
    m = load_sync_dvc_cache()
    assert m.is_likely_oss_auth_or_access_failure(RuntimeError("403 Forbidden"))
    assert m.is_likely_oss_auth_or_access_failure(RuntimeError("InvalidAccessKeyId"))
    assert m.is_likely_oss_auth_or_access_failure(RuntimeError("SignatureDoesNotMatch"))
    assert not m.is_likely_oss_auth_or_access_failure(RuntimeError("Connection reset"))
    assert not m.is_likely_oss_auth_or_access_failure(OSError(28, "no space left on device"))


def test_oss_env_diagnostic_line_never_prints_values() -> None:
    m = load_sync_dvc_cache()
    os.environ["OSS_ACCESS_KEY_ID"] = "LTAIxxxxxxxxxxxx"
    os.environ["OSS_ACCESS_KEY_SECRET"] = "secretvaluemustnotappear"
    try:
        line = m.oss_env_diagnostic_line()
        assert "LTAI" not in line
        assert "secretvalue" not in line
        assert "set" in line.lower() or "chars" in line
    finally:
        os.environ.pop("OSS_ACCESS_KEY_ID", None)
        os.environ.pop("OSS_ACCESS_KEY_SECRET", None)


def test_bucket_client_missing_exits_1() -> None:
    m = load_sync_dvc_cache()
    for k in ("OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"):
        os.environ.pop(k, None)
    try:
        m.bucket_client("dummy", "https://oss-cn-shanghai.aliyuncs.com")
    except SystemExit as e:
        assert e.code == 1
    else:
        raise AssertionError("expected SystemExit(1)")


def test_transfer_many_auth_failure_flag() -> None:
    m = load_sync_dvc_cache()
    import oss2.exceptions as oe

    def worker(_oid: str) -> bool:
        raise oe.AccessDenied(403, {}, "<Error/>", {"Code": "AccessDenied", "Message": "Denied"})

    changed, skipped, failed, auth_fail = m.transfer_many("downloaded", ["abc123"], worker)
    assert failed == 1
    assert auth_fail is True
    assert changed == 0


def test_transfer_many_non_auth_failure_flag() -> None:
    m = load_sync_dvc_cache()

    def worker(_oid: str) -> bool:
        raise RuntimeError("corrupt zip")

    changed, skipped, failed, auth_fail = m.transfer_many("downloaded", ["abc123"], worker)
    assert failed == 1
    assert auth_fail is False


def test_ps_doublequote_scanner() -> None:
    r = subprocess.run(
        [sys.executable, str(SCRIPTS / "scan_ps_doublequote_subexpr.py")],
        cwd=str(REPO),
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr


def main() -> int:
    test_is_likely_oss_auth_or_access_failure()
    test_oss_env_diagnostic_line_never_prints_values()
    test_bucket_client_missing_exits_1()
    test_transfer_many_auth_failure_flag()
    test_transfer_many_non_auth_failure_flag()
    test_ps_doublequote_scanner()
    print("test_oss_bootstrap_contract: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
