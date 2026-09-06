"""Check DVC/OSS metadata using HTTP HEAD only; never transfer object bodies.

All directory manifests come from the existing local DVC cache. Every referenced
remote object's Content-Length is compared with the corresponding cache file's
size. ETags are recorded only, including multipart ETags; they are not assumed
to be whole-file MD5. This proves remote presence/size, not content hashes.

Only JSON/TXT reports are written. No remote, cache, pointer, or resource writes.
Run with repository Python; tools.dev.creds/proxyenv handle credentials/proxies.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import configparser
import hashlib
import json
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import oss2
import yaml
from tools.dev import creds, proxyenv

OID_PATTERN = re.compile(r"[0-9a-f]{32}(?:\.dir)?\Z")


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT).decode("utf-8").strip()


def cache_path(oid: str) -> Path:
    if not OID_PATTERN.fullmatch(oid):
        raise ValueError("Invalid DVC MD5 object identifier")
    return ROOT / ".dvc" / "cache" / "files" / "md5" / oid[:2] / oid[2:]


def remote_config() -> dict[str, str]:
    config = configparser.ConfigParser()
    config.read(ROOT / ".dvc" / "config", encoding="utf-8")
    name = config.get("core", "remote")
    section = f'remote "{name}"'
    if not config.has_section(section):
        section = f"'{section}'"
    url = urlsplit(config.get(section, "url"))
    if url.scheme != "oss" or not url.hostname or url.username or url.password:
        raise ValueError("DVC remote must be an OSS bucket URL without credentials")
    return {"name": name, "bucket": url.hostname,
            "endpoint": config.get(section, "oss_endpoint"),
            "prefix": url.path.strip("/") + "/files/md5"}


def write_reports(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "DVC / OSS metadata audit (HTTP HEAD only)",
        "Result: " + ("PASS" if report["ok"] else "FAIL"),
        "Started UTC: " + report["started_utc"],
        "Elapsed seconds: " + str(report["elapsed_seconds"]),
        "Git HEAD at audit: " + report["git"]["head"],
        "Pointer source: current worktree; uncommitted pointer changes are reported separately.",
        "Manifest source: existing local cache only.",
        "Objects checked: " + str(report["checked_objects"]) + "/" + str(report["unique_objects"]),
        "Object-body bytes transferred: 0",
        "ETag recorded only; remote content hashes were NOT verified.",
        "No remote/cache/resource/pointer writes.",
    ]
    for target in report["targets"]:
        lines += ["", target["pointer"],
                  "Pointer matches Git HEAD: " + str(target["pointer_matches_git_head"]),
                  "Root object: " + target["out"]["md5"],
                  "Files: " + str(target["manifest_files"]) + " / declared " + str(target["out"].get("nfiles", 1)),
                  "Cache file bytes: " + str(target["cache_file_bytes"]) + " / declared " + str(target["out"].get("size")),
                  "Remote files with matching metadata: " + str(target["verified_files"])]
    lines += ["", "Pending pointer commits: " + json.dumps(report["git"]["pending_pointer_commit"]),
              "Issues: " + str(len(report["issues"]))]
    lines += [json.dumps(issue, ensure_ascii=False) for issue in report["issues"]]
    path.with_suffix(".txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default="artifact/OpenWorld/dvc-oss-metadata-audit-2026-09-06.json")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("--workers must be between 1 and 16")
    report_path = (ROOT / args.report).resolve()
    if report_path.suffix != ".json" or not report_path.is_relative_to(ROOT / "artifact"):
        parser.error("--report must be a .json file under the repository artifact directory")

    started = time.perf_counter()
    started_utc = datetime.now(timezone.utc).isoformat()
    head = git("rev-parse", "HEAD")
    branch = git("branch", "--show-current")
    remote = remote_config()
    objects: dict[str, dict] = {}
    manifests: dict[str, list[dict]] = {}
    targets: list[dict] = []
    pointer_snapshots: dict[str, bytes] = {}
    pending_pointer_commit: list[str] = []
    results: dict[str, dict] = {}
    issues: list[dict] = []

    def register(oid: str, pointer: str, relpath: str) -> None:
        path = cache_path(oid)
        if oid not in objects:
            exists = path.is_file()
            objects[oid] = {"oid": oid, "local_cache_exists": exists,
                            "local_cache_bytes": path.stat().st_size if exists else None,
                            "references": []}
            if not exists:
                issues.append({"kind": "local_cache_missing", "oid": oid})
        objects[oid]["references"].append({"pointer": pointer, "relpath": relpath})

    for pointer in git("ls-files", "*.dvc").splitlines():
        raw = (ROOT / pointer).read_bytes()
        pointer_snapshots[pointer] = raw
        working = yaml.safe_load(raw)
        committed = yaml.safe_load(git("show", f"{head}:{pointer}"))
        pointer_matches = working == committed
        if not pointer_matches:
            pending_pointer_commit.append(pointer)
        for out in working["outs"]:
            target = {"pointer": pointer, "pointer_matches_git_head": pointer_matches,
                      "out": out, "entries": []}
            targets.append(target)

            def walk(oid: str, prefix: str = "", ancestors: frozenset[str] = frozenset()) -> None:
                register(oid, pointer, prefix or ".")
                if oid in ancestors:
                    issues.append({"kind": "local_manifest_cycle", "oid": oid})
                    return
                if not oid.endswith(".dir"):
                    target["entries"].append({"relpath": prefix, "md5": oid})
                    return
                path = cache_path(oid)
                if not path.is_file():
                    return
                if oid not in manifests:
                    body = path.read_bytes()
                    if hashlib.md5(body).hexdigest() != oid.removesuffix(".dir"):
                        issues.append({"kind": "local_manifest_md5_mismatch", "oid": oid})
                        return
                    parsed = json.loads(body)
                    if not isinstance(parsed, list):
                        issues.append({"kind": "local_manifest_not_list", "oid": oid})
                        return
                    manifests[oid] = parsed
                for entry in manifests[oid]:
                    relpath = str(PurePosixPath(prefix, entry["relpath"]))
                    walk(entry["md5"], relpath, ancestors | {oid})

            walk(out["md5"])
            print(f"Local manifest expanded: {pointer}, {len(target['entries'])} files", flush=True)

    key_id, key_secret = creds.ensure_credentials(prompt=False)
    tls = threading.local()

    def bucket():
        if not hasattr(tls, "bucket"):
            client = oss2.Bucket(oss2.Auth(key_id, key_secret), remote["endpoint"], remote["bucket"])
            client.session.session.trust_env = False
            client.session.session.proxies = {}
            tls.bucket = client
        return tls.bucket

    def check_metadata(oid: str) -> dict:
        key = f"{remote['prefix']}/{oid[:2]}/{oid[2:]}"
        expected_size = objects[oid]["local_cache_bytes"]
        for attempt in range(1, 4):
            try:
                # The sole OSS request in this script. Never request an object body.
                response = bucket().head_object(key)
                return {"oid": oid, "key": key, "exists": True,
                        "ok": expected_size is not None and response.content_length == expected_size,
                        "content_length": response.content_length,
                        "expected_local_cache_bytes": expected_size,
                        "etag": response.etag, "etag_used_as_content_md5": False,
                        "attempts": attempt, "method": "HTTP_HEAD_only"}
            except Exception as error:
                safe_error = {"type": type(error).__name__,
                              "status": getattr(error, "status", None),
                              "code": getattr(error, "code", None)}
                if attempt < 3:
                    time.sleep(attempt)
        return {"oid": oid, "key": key, "ok": False, "attempts": 3,
                "expected_local_cache_bytes": expected_size, "error": safe_error,
                "method": "HTTP_HEAD_only"}

    print(f"Checking metadata only: {len(objects)} unique objects, HTTP HEAD, zero body transfer", flush=True)
    last_progress = time.perf_counter()
    with proxyenv.without_proxy(), concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(check_metadata, oid): oid for oid in objects}
        for future in concurrent.futures.as_completed(futures):
            record = future.result()
            results[record["oid"]] = record
            if not record["ok"]:
                issues.append({"kind": "oss_object_metadata_failed", **record})
            now = time.perf_counter()
            if len(results) % 100 == 0 or now - last_progress >= 10:
                print(f"HEAD checked {len(results)}/{len(objects)} objects; {len(issues)} issues; {now-started:.1f}s", flush=True)
                last_progress = now

    for target in targets:
        entries = target.pop("entries")
        target["manifest_files"] = len(entries)
        target["cache_file_bytes"] = sum(objects[e["md5"]]["local_cache_bytes"] or 0 for e in entries)
        target["verified_files"] = sum(bool(results[e["md5"]]["ok"]) for e in entries)
        if len(entries) != target["out"].get("nfiles", 1):
            issues.append({"kind": "manifest_file_count", "pointer": target["pointer"]})
        if target["cache_file_bytes"] != target["out"].get("size"):
            issues.append({"kind": "pointer_total_size", "pointer": target["pointer"],
                           "actual": target["cache_file_bytes"]})
    for pointer, raw in pointer_snapshots.items():
        if (ROOT / pointer).read_bytes() != raw:
            issues.append({"kind": "working_pointer_changed_during_audit", "pointer": pointer})
    end_head = git("rev-parse", "HEAD")
    report = {
        "started_utc": started_utc, "finished_utc": datetime.now(timezone.utc).isoformat(),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "method": "Local DVC manifests; OSS HTTP HEAD only for presence and Content-Length versus cache sizes.",
        "limits": "ETag is metadata only; multipart ETag is not assumed to be whole-file MD5. No remote content-hash verification.",
        "object_body_bytes_transferred": 0, "remote_content_hash_verified": False,
        "remote_writes": False, "cache_writes": False,
        "git": {"branch": branch, "head": head, "head_at_finish": end_head,
                "pending_pointer_commit": pending_pointer_commit},
        "remote": remote, "targets": targets, "unique_objects": len(objects),
        "checked_objects": len(results), "ok": not issues, "issues": issues,
        "objects": [{**objects[oid], **results[oid]} for oid in sorted(results)],
    }
    write_reports(report_path, report)
    print(json.dumps({"ok": report["ok"], "objects": len(results), "issues": len(issues),
                      "elapsed_seconds": report["elapsed_seconds"], "report": str(report_path),
                      "object_body_bytes_transferred": 0}, ensure_ascii=True), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
