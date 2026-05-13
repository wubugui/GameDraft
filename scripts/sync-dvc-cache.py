from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import oss2
import yaml


DEFAULT_BUCKET = "gamedraft-assets"
DEFAULT_ENDPOINT = "https://oss-cn-shanghai.aliyuncs.com"
DEFAULT_PREFIX = "gamedraft/dvc/files/md5"
PART_SIZE = 16 * 1024 * 1024
MULTIPART_THRESHOLD = 64 * 1024 * 1024
THREADS = 8
OBJECT_WORKERS = 16
DEFAULT_DVCFILES = [
    "public/resources/runtime.dvc",
    "resources/editor_projects.dvc",
    "resources/vendor_archives.dvc",
]


def cache_path(root: Path, oid: str) -> Path:
    return root / ".dvc" / "cache" / "files" / "md5" / oid[:2] / oid[2:]


def object_key(prefix: str, oid: str) -> str:
    return f"{prefix.rstrip('/')}/{oid[:2]}/{oid[2:]}"


def oss_env_diagnostic_line() -> str:
    kid = os.environ.get("OSS_ACCESS_KEY_ID")
    ks = os.environ.get("OSS_ACCESS_KEY_SECRET")
    id_desc = "not set" if not kid else f"set, {len(kid)} chars"
    sec_desc = "not set" if not ks else f"set, {len(ks)} chars"
    return f"OSS_ACCESS_KEY_ID: {id_desc}; OSS_ACCESS_KEY_SECRET: {sec_desc} (values are not printed)."


def is_likely_oss_auth_or_access_failure(exc: BaseException) -> bool:
    try:
        import oss2.exceptions as oe

        auth_types: tuple[type, ...] = tuple(
            t
            for name in (
                "AccessDenied",
                "InvalidAccessKeyId",
                "SignatureDoesNotMatch",
                "Forbidden",
            )
            if (t := getattr(oe, name, None)) is not None and isinstance(t, type)
        )
        if auth_types and isinstance(exc, auth_types):
            return True
    except ImportError:
        pass
    text = f"{type(exc).__name__}: {exc}".lower()
    if re.search(r"accessdenied|invalidaccesskeyid|signaturedoesnotmatch|access key|403|401|forbidden", text):
        return True
    return False


def bucket_client(bucket_name: str, endpoint: str) -> oss2.Bucket:
    key_id = os.environ.get("OSS_ACCESS_KEY_ID")
    key_secret = os.environ.get("OSS_ACCESS_KEY_SECRET")
    if not key_id or not key_secret:
        print(oss_env_diagnostic_line(), file=sys.stderr)
        print(
            "OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET are not visible to this Python process "
            "(empty or unset). Fix bootstrap / shell so keys are set on the same process before sync.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return oss2.Bucket(oss2.Auth(key_id, key_secret), endpoint, bucket_name)


def remote_has_object(bucket: oss2.Bucket, key: str, size: int) -> bool:
    try:
        return bucket.head_object(key).content_length == size
    except oss2.exceptions.NoSuchKey:
        return False
    except oss2.exceptions.NotFound:
        return False


def upload_one(bucket: oss2.Bucket, prefix: str, root: Path, oid: str) -> bool:
    path = cache_path(root, oid)
    if not path.is_file():
        raise FileNotFoundError(path)
    key = object_key(prefix, oid)
    size = path.stat().st_size
    if remote_has_object(bucket, key, size):
        return False
    oss2.resumable_upload(
        bucket,
        key,
        str(path),
        multipart_threshold=MULTIPART_THRESHOLD,
        part_size=PART_SIZE,
        num_threads=THREADS,
    )
    return True


def download_one(bucket: oss2.Bucket, prefix: str, root: Path, oid: str) -> bool:
    path = cache_path(root, oid)
    if path.is_file():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    oss2.resumable_download(
        bucket,
        object_key(prefix, oid),
        str(path),
        multiget_threshold=MULTIPART_THRESHOLD,
        part_size=PART_SIZE,
        num_threads=THREADS,
    )
    return True


def root_oids_from_dvcfiles(dvcfiles: list[Path]) -> list[str]:
    oids: list[str] = []
    for dvcfile in dvcfiles:
        data = yaml.safe_load(dvcfile.read_text(encoding="utf-8"))
        for out in data.get("outs", []):
            md5 = out.get("md5")
            if md5:
                oids.append(md5)
    return oids


def collect_required_oids_from_local(root: Path, root_oids: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    def visit(oid: str) -> None:
        if oid in seen:
            return
        seen.add(oid)
        ordered.append(oid)
        if not oid.endswith(".dir"):
            return
        entries = json.loads(cache_path(root, oid).read_text(encoding="utf-8"))
        for entry in entries:
            visit(entry["md5"])

    for oid in root_oids:
        visit(oid)
    return ordered


def collect_required_oids_from_remote(bucket: oss2.Bucket, prefix: str, root: Path, root_oids: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []

    def visit(oid: str) -> None:
        if oid in seen:
            return
        seen.add(oid)
        ordered.append(oid)
        if not oid.endswith(".dir"):
            return
        download_one(bucket, prefix, root, oid)
        entries = json.loads(cache_path(root, oid).read_text(encoding="utf-8"))
        for entry in entries:
            visit(entry["md5"])

    for oid in root_oids:
        visit(oid)
    return ordered


def transfer_many(label: str, oids: list[str], worker) -> tuple[int, int, int, bool]:
    changed = 0
    skipped = 0
    failed = 0
    auth_or_access_failure = False
    total = len(oids)
    with ThreadPoolExecutor(max_workers=OBJECT_WORKERS) as executor:
        futures = {executor.submit(worker, oid): oid for oid in oids}
        for index, future in enumerate(as_completed(futures), 1):
            oid = futures[future]
            try:
                did_change = future.result()
            except Exception as exc:
                failed += 1
                if is_likely_oss_auth_or_access_failure(exc):
                    auth_or_access_failure = True
                print(f"{label} failed {index}/{total} {oid}: {exc}")
                continue
            if did_change:
                changed += 1
                print(f"{label} {index}/{total} {oid}")
            else:
                skipped += 1
    return changed, skipped, failed, auth_or_access_failure


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["push", "pull"])
    parser.add_argument("targets", nargs="*", help="DVC files to sync, for example public/resources/runtime.dvc")
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--root", default=".")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    bucket = bucket_client(args.bucket, args.endpoint)

    targets = args.targets or DEFAULT_DVCFILES
    target_paths = [root / target for target in targets]
    started = time.perf_counter()

    if args.mode == "push":
        required = collect_required_oids_from_local(root, root_oids_from_dvcfiles(target_paths))
        changed, skipped, failed, auth_fail = transfer_many(
            "uploaded",
            required,
            lambda oid: upload_one(bucket, args.prefix, root, oid),
        )
        elapsed = max(time.perf_counter() - started, 0.001)
        if failed:
            print(oss_env_diagnostic_line(), file=sys.stderr)
            if auth_fail:
                print(
                    "OSS denied upload or the AccessKey is invalid / lacks RAM permissions. "
                    "If keys are wrong, re-enter them when bootstrap asks again.",
                    file=sys.stderr,
                )
                raise SystemExit(2)
            print("DVC cache push failed for reasons other than typical OSS auth errors.", file=sys.stderr)
            raise SystemExit(1)
        print(f"DVC cache push complete: {changed} uploaded, {skipped} skipped, {len(required)} checked in {elapsed:.1f}s.")
        return 0

    try:
        required = collect_required_oids_from_remote(bucket, args.prefix, root, root_oids_from_dvcfiles(target_paths))
    except Exception as exc:
        print(oss_env_diagnostic_line(), file=sys.stderr)
        if is_likely_oss_auth_or_access_failure(exc):
            print(
                "OSS denied access while resolving remote cache (invalid AccessKey or insufficient policy). "
                "Re-enter OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET when bootstrap prompts again.",
                file=sys.stderr,
            )
            raise SystemExit(2) from exc
        raise

    changed, skipped, failed, auth_fail = transfer_many(
        "downloaded",
        [oid for oid in required if not oid.endswith(".dir")],
        lambda oid: download_one(bucket, args.prefix, root, oid),
    )
    elapsed = max(time.perf_counter() - started, 0.001)
    if failed:
        print(oss_env_diagnostic_line(), file=sys.stderr)
        if auth_fail:
            print(
                "OSS denied download or the AccessKey is invalid / lacks RAM permissions (e.g. oss:GetObject on the DVC cache prefix). "
                "Re-enter OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET when bootstrap prompts again.",
                file=sys.stderr,
            )
            raise SystemExit(2)
        print("DVC cache pull failed for reasons other than typical OSS auth errors.", file=sys.stderr)
        raise SystemExit(1)
    print(f"DVC cache pull complete: {changed} downloaded, {skipped} skipped, {len(required)} checked in {elapsed:.1f}s.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
