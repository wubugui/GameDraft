"""把旧构建压成 7z 归档，以及归档的还原与删除。

**纯逻辑，无 Qt。** 长任务（压缩一次要几十秒）由调用方放到后台线程里跑，
这里只提供可注入 `progress` 回调的同步函数。

## 关于压缩率，先说实话

实测（2026-08-28，573 MB 的发行包，`-mx=9 -md=256m -ms=on`）：

    573 MB → 549.8 MB，省 4%，耗时 47 秒

因为包里 **97% 是 PNG / MP3 / OGG**，本来就是压缩格式，LZMA2 再压也榨不出多少。
7z 在这里的价值主要是**一次构建一个文件**（好搜、好拷、好删），不是省空间。

真要控制留档占用，管用的是保留份数（`keep_archives`），
或者跨构建去重（相邻两次构建绝大多数文件逐字节相同）——那是另一套方案，本模块不做。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .builds import ARCHIVE_SUFFIX, BuildEntry, read_marker

ProgressFn = Callable[[str], None]

#: 7z 常见安装位置。PATH 里找不到时按顺序试——装了 7-Zip 但没进 PATH 是常态。
_SEVEN_ZIP_CANDIDATES = (
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
    "/usr/bin/7z",
    "/usr/local/bin/7z",
    "/opt/homebrew/bin/7z",
)

#: 超高压参数。`-ms=on` 固实：把所有文件当成一个流压，能吃到跨文件的重复。
#: `-md=256m` 字典调到 256 MB——对这个体量的包，字典越大越能找到远距离重复。
SEVEN_ZIP_MAX_ARGS = ("-t7z", "-mx=9", "-md=256m", "-mfb=273", "-ms=on")


def find_seven_zip(configured: str = "") -> str | None:
    """找 7z：配置里指定的优先，然后 PATH，最后常见安装位置。"""
    if configured.strip():
        p = Path(configured.strip())
        return str(p) if p.is_file() else None
    found = shutil.which("7z") or shutil.which("7za")
    if found:
        return found
    for cand in _SEVEN_ZIP_CANDIDATES:
        if Path(cand).is_file():
            return cand
    return None


@dataclass(frozen=True)
class ArchiveResult:
    ok: bool
    archive_path: Path | None
    original_bytes: int
    archive_bytes: int
    message: str

    @property
    def ratio_text(self) -> str:
        if not self.ok or self.original_bytes <= 0 or self.archive_bytes <= 0:
            return ""
        saved = self.original_bytes - self.archive_bytes
        pct = saved / self.original_bytes * 100
        return f"省 {saved / 1024 ** 2:.1f} MB（{pct:.1f}%）"


def archive_build(
    build: BuildEntry,
    archive_root: Path,
    *,
    seven_zip: str,
    progress: ProgressFn | None = None,
    remove_source: bool = True,
    timeout_sec: int = 3600,
) -> ArchiveResult:
    """把一次构建压成 `<archive_root>/<name>.7z`，成功后删掉原目录。

    **`gamedata/` 不进归档**：那是那台机器上玩出来的存档，不是构建产物；
    压进去既没意义又会让同一次构建的归档随"玩没玩过"而变化。

    压缩失败**绝不删原目录**——宁可占着磁盘，也不能既没归档又没原件。
    """
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    archive_root.mkdir(parents=True, exist_ok=True)
    target = archive_root / f"{build.name}{ARCHIVE_SUFFIX}"
    if target.exists():
        return ArchiveResult(False, None, 0, 0, f"归档已存在，跳过：{target.name}")

    # 只压构建产物本身；`gamedata/`（存档）与临时文件不进去
    items = [p for p in sorted(build.path.iterdir()) if p.name != "gamedata"]
    if not items:
        return ArchiveResult(False, None, 0, 0, f"{build.name}：目录是空的，没什么可归档")

    original = sum(
        sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir()
        else p.stat().st_size
        for p in items
    )

    tmp = target.with_suffix(".7z.part")
    tmp.unlink(missing_ok=True)
    say(f"压缩 {build.name}（{original / 1024 ** 2:.1f} MB）…")

    argv = [seven_zip, "a", *SEVEN_ZIP_MAX_ARGS, "-bso0", "-bsp0", str(tmp), *(str(p) for p in items)]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_sec)
    except (OSError, subprocess.TimeoutExpired) as e:
        tmp.unlink(missing_ok=True)
        return ArchiveResult(False, None, original, 0, f"{build.name}：7z 跑不起来或超时（{e}）")
    if proc.returncode != 0 or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        return ArchiveResult(
            False, None, original, 0,
            f"{build.name}：7z 退出码 {proc.returncode}\n" + "\n".join(tail),
        )

    os.replace(tmp, target)
    archived = target.stat().st_size

    # 元数据放在归档旁边：看一份归档的信息不该先解压 550 MB
    meta = read_marker(build.path) or {}
    meta["archivedFrom"] = build.name
    meta["archiveBytes"] = archived
    target.with_name(target.name + ".json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n",
    )

    result = ArchiveResult(True, target, original, archived, f"{build.name} 已归档")
    say(f"  → {target.name}，{result.ratio_text}")

    if remove_source:
        try:
            shutil.rmtree(build.path)
            say(f"  已删除原目录 {build.name}")
        except OSError as e:
            # 归档已经成好了，原目录删不掉不算失败——但要说出来，否则磁盘白占
            say(f"  ⚠ 归档成功但原目录删不掉（{e}）：{build.path}")
    return result


def restore_archive(
    archive_path: Path,
    dest_root: Path,
    *,
    seven_zip: str,
    progress: ProgressFn | None = None,
    timeout_sec: int = 3600,
) -> tuple[bool, str]:
    """把一份归档解回 `<dest_root>/<归档名>/`，解完就能直接跑。"""
    def say(msg: str) -> None:
        if progress:
            progress(msg)

    dest = dest_root / archive_path.stem
    if dest.exists():
        return False, f"目标已存在，先处理掉它：{dest}"
    dest.mkdir(parents=True, exist_ok=True)
    say(f"解压 {archive_path.name} → {dest}")
    argv = [seven_zip, "x", str(archive_path), f"-o{dest}", "-y", "-bso0", "-bsp0"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_sec)
    except (OSError, subprocess.TimeoutExpired) as e:
        shutil.rmtree(dest, ignore_errors=True)
        return False, f"7z 跑不起来或超时（{e}）"
    if proc.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        return False, f"7z 退出码 {proc.returncode}\n" + "\n".join(tail)
    say(f"  已解到 {dest}")
    return True, str(dest)


def delete_path(path: Path) -> tuple[bool, str]:
    """删一个构建目录或一份归档（含它旁边的 .json 元数据）。"""
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
            meta = path.with_name(path.name + ".json")
            meta.unlink(missing_ok=True)
    except OSError as e:
        return False, f"删不掉（{e}）：{path}"
    return True, f"已删除 {path.name}"
