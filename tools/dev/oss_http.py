"""Direct (proxy-bypassing) OSS downloads, ported from scripts/bootstrap-dvc.ps1.

Supports anonymous GET and RAM signed GET (HMAC-SHA1, ``Authorization: OSS
key_id:signature``) for both virtual-host (bucket.oss-cn-x.aliyuncs.com/key)
and path-style (oss-cn-x.aliyuncs.com/bucket/key) URLs.
"""

from __future__ import annotations

import base64
import email.utils
import hashlib
import hmac
import re
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

_VIRTUAL_HOST_RE = re.compile(r"^(?P<bucket>[^.]+)\.(?P<suffix>oss-.+\.aliyuncs\.com)$", re.I)
_PATH_STYLE_HOST_RE = re.compile(r"^oss-.+\.aliyuncs\.com$", re.I)


def parse_bucket_and_key(url: str) -> tuple[str, str]:
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    path = parsed.path.lstrip("/")

    m = _VIRTUAL_HOST_RE.match(host)
    if m:
        if not path:
            raise ValueError(f"OSS URL has no object path: {url}")
        return m.group("bucket"), urllib.parse.unquote(path)

    if _PATH_STYLE_HOST_RE.match(host):
        segments = [s for s in path.split("/") if s]
        if len(segments) >= 2:
            return segments[0], urllib.parse.unquote("/".join(segments[1:]))

    raise ValueError(
        f"Cannot derive bucket/object key for OSS signing from URL: {url}. "
        "Use virtual host style bucket.oss-cn-xxx.aliyuncs.com/object-key or "
        "path-style oss-cn-xxx.aliyuncs.com/bucket/object-key."
    )


def download_direct(url: str, out_file: Path, headers: dict[str, str] | None = None) -> None:
    """GET ignoring all proxy env (mirrors Invoke-WebRequestDirect)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers=headers or {})
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with opener.open(request) as response, open(out_file, "wb") as fh:
        shutil.copyfileobj(response, fh)


def download_signed(url: str, out_file: Path, key_id: str, key_secret: str) -> None:
    bucket, object_key = parse_bucket_and_key(url)
    canonical_resource = f"/{bucket}/{object_key}"
    date_gmt = email.utils.formatdate(usegmt=True)
    string_to_sign = f"GET\n\n\n{date_gmt}\n{canonical_resource}"
    digest = hmac.new(
        key_secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1
    ).digest()
    signature = base64.b64encode(digest).decode("ascii")
    download_direct(
        url,
        out_file,
        headers={"Date": date_gmt, "Authorization": f"OSS {key_id}:{signature}"},
    )
