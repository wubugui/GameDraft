"""Stdlib-only unit tests for interpreter/oss-http resolution (no network)."""

import sys

from tools.dev import oss_http, paths


def test_repo_root_has_marker():
    root = paths.repo_root()
    assert (root / "package.json").is_file()
    assert (root / "tools" / "dev" / "__main__.py").is_file()


def test_project_python_returns_path():
    p = paths.project_python()
    assert p.name.lower().startswith("python")


def test_npm_command_shape():
    name = paths.npm_command()
    if sys.platform == "win32":
        assert name.endswith("npm.cmd") or name == "npm.cmd"
    else:
        assert name.endswith("npm") or name == "npm"


def test_oss_virtual_host_parse():
    bucket, key = oss_http.parse_bucket_and_key(
        "https://gamedraft-assets.oss-cn-shanghai.aliyuncs.com/gamedraft/bootstrap/x.zip"
    )
    assert bucket == "gamedraft-assets"
    assert key == "gamedraft/bootstrap/x.zip"


def test_oss_path_style_parse():
    bucket, key = oss_http.parse_bucket_and_key(
        "https://oss-cn-shanghai.aliyuncs.com/my-bucket/a/b/c.zip"
    )
    assert bucket == "my-bucket"
    assert key == "a/b/c.zip"


def test_oss_parse_rejects_bad_host():
    try:
        oss_http.parse_bucket_and_key("https://example.com/x.zip")
    except ValueError:
        return
    raise AssertionError("expected ValueError for non-OSS host")
