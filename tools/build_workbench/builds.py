"""扫描构建根目录：有哪些构建、多大、什么时候打的、验收过没有。

**纯逻辑，无 Qt。** 只读磁盘，不改任何东西——删除/归档是 `archive.py` 与 UI 的事。

识别依据是 `release.mjs` 留下的 `.gamedraft-build.json`（`BUILD_MARKER`）。
一个目录有它才算"一次构建"；没有的目录一律不碰，也不列出来
——那个根目录底下可能还有别人的东西。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

#: 排序时给"没有时间戳"的条目垫底用。
#:
#: **不能用 `_EPOCH_FLOOR`** —— Windows 上那会抛 `OSError`
#: （年份 1 转本地时区下溢），于是任何一个时间戳缺失/格式不对的构建
#: 都会让整个列表崩掉，而不是安静地排到最后。
_EPOCH_FLOOR = datetime.min.replace(tzinfo=timezone.utc)

#: 与 `scripts/lib/build_helpers.mjs` 的 `BUILD_MARKER` 同名。两处改名要一起改。
BUILD_MARKER = ".gamedraft-build.json"
#: 归档文件后缀。
ARCHIVE_SUFFIX = ".7z"
#: 归档旁边那份元数据（从构建标记复制过来，免得为了看信息去解压）。
ARCHIVE_META_SUFFIX = ".7z.json"


@dataclass(frozen=True)
class BuildEntry:
    """一次构建（未压缩，可直接跑）。"""

    path: Path
    name: str
    built_at: datetime | None
    target: str
    file_count: int
    total_bytes: int
    verified: bool
    #: 磁盘上实测的体积（标记里记的是构建当时的；玩家跑过之后会多出 gamedata/）
    disk_bytes: int

    @property
    def runnable_exe(self) -> Path:
        return self.path / "gamedraft.exe"


@dataclass(frozen=True)
class ArchiveEntry:
    """一份归档（.7z）。"""

    path: Path
    name: str
    built_at: datetime | None
    target: str
    archive_bytes: int
    #: 归档前的原始体积（来自元数据；缺失为 0）
    original_bytes: int
    verified: bool

    @property
    def ratio(self) -> float | None:
        """压缩后 / 压缩前。没有原始体积时返回 None，不编数字。"""
        if self.original_bytes <= 0:
            return None
        return self.archive_bytes / self.original_bytes


def _parse_iso(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        # release.mjs 写的是 `new Date().toISOString()`，带 Z
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def _dir_size(path: Path) -> tuple[int, int]:
    """(文件数, 字节数)。扫不动的条目跳过，不因为一个坏文件让整次列表失败。"""
    count = 0
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                count += 1
                total += p.stat().st_size
        except OSError:
            continue
    return count, total


def read_marker(build_dir: Path) -> dict | None:
    """读一次构建的标记；不是构建目录返回 None。"""
    marker = build_dir / BUILD_MARKER
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def scan_builds(builds_root: Path) -> list[BuildEntry]:
    """列出 `builds_root` 下的所有构建，**新的在前**。

    只认带构建标记的目录。`archive/` 这类子目录自然被排除（它没有标记）。
    """
    out: list[BuildEntry] = []
    try:
        entries = sorted(builds_root.iterdir())
    except OSError:
        return out
    for d in entries:
        if not d.is_dir():
            continue
        data = read_marker(d)
        if data is None:
            continue
        count, size = _dir_size(d)
        out.append(BuildEntry(
            path=d,
            name=d.name,
            built_at=_parse_iso(data.get("builtAt")),
            target=str(data.get("target") or "?"),
            file_count=int(data.get("fileCount") or 0),
            total_bytes=int(data.get("totalBytes") or 0),
            verified=bool(data.get("verified", False)),
            disk_bytes=size,
        ))
    out.sort(key=lambda b: (b.built_at or _EPOCH_FLOOR, b.name), reverse=True)
    return out


def scan_archives(archive_root: Path) -> list[ArchiveEntry]:
    """列出归档，**新的在前**。"""
    out: list[ArchiveEntry] = []
    try:
        entries = sorted(archive_root.iterdir())
    except OSError:
        return out
    for f in entries:
        if not f.is_file() or f.suffix.lower() != ARCHIVE_SUFFIX:
            continue
        meta: dict = {}
        meta_path = f.with_name(f.name + ".json")
        try:
            loaded = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                meta = loaded
        except (OSError, json.JSONDecodeError):
            pass
        try:
            size = f.stat().st_size
        except OSError:
            continue
        out.append(ArchiveEntry(
            path=f,
            name=f.stem,
            built_at=_parse_iso(meta.get("builtAt")),
            target=str(meta.get("target") or "?"),
            archive_bytes=size,
            original_bytes=int(meta.get("totalBytes") or 0),
            verified=bool(meta.get("verified", False)),
        ))
    out.sort(key=lambda a: (a.built_at or _EPOCH_FLOOR, a.name), reverse=True)
    return out


def builds_to_archive(builds: list[BuildEntry], keep_uncompressed: int) -> list[BuildEntry]:
    """哪些构建该转归档：按新→旧排好之后，第 `keep_uncompressed` 份往后的。

    `keep_uncompressed` 至少为 1——0 会让刚构建完的那份立刻被归档，
    等于"自动构建产出的东西永远不能直接跑"。
    """
    keep = max(1, keep_uncompressed)
    return builds[keep:]


def archives_to_drop(archives: list[ArchiveEntry], keep_archives: int) -> list[ArchiveEntry]:
    """哪些归档该删：`keep_archives` 为 0 表示永久留档，一个都不删。"""
    if keep_archives <= 0:
        return []
    return archives[keep_archives:]


def new_build_dir_name(now: datetime) -> str:
    """自动构建的目录名：`2026-08-28_0400`。

    刻意用本地时间且不带秒——一天一次的节奏下秒没有信息量，
    而目录名要能一眼看出是哪天哪一次。
    """
    return now.strftime("%Y-%m-%d_%H%M")


def human_bytes(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"
