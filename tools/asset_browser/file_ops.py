"""统一文件操作：移动、复制、重命名、删除到回收站、新建目录。失败汇总。"""
from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PySide6.QtCore import QObject, QUrl
from PySide6.QtGui import QDesktopServices

try:
    from natsort import natsorted
except ImportError:
    natsorted = sorted  # type: ignore[assignment, misc]

try:
    import send2trash
except ImportError:
    send2trash = None  # type: ignore[assignment]


@dataclass
class FileOpResult:
    ok: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)

    def add_ok(self, p: str) -> None:
        self.ok.append(p)

    def add_fail(self, p: str, err: str) -> None:
        self.failed.append((p, err))


def ensure_dir(p: str | Path) -> None:
    Path(p).mkdir(parents=True, exist_ok=True)


def _unique_destination(dest: Path, name: str) -> Path:
    t = dest / name
    if not t.exists():
        return t
    stem = t.stem
    suffix = t.suffix
    n = 1
    while True:
        candidate = dest / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def copy_to(
    dest_dir: str,
    src_paths: list[str],
    overwrite: bool = False,
    *,
    autorename: bool = False,
) -> FileOpResult:
    r = FileOpResult()
    dest = Path(dest_dir)
    if not dest.is_dir():
        for p in src_paths:
            r.add_fail(p, f"目标不是目录: {dest_dir}")
        return r
    for sp in src_paths:
        s = Path(sp)
        if not s.exists():
            r.add_fail(sp, "源不存在")
            continue
        name = s.name
        t = dest / name
        if t.exists() and autorename and not overwrite:
            t = _unique_destination(dest, name)
        if t.exists() and not overwrite:
            r.add_fail(sp, "目标已存在")
            continue
        try:
            if s.is_dir():
                if t.exists() and overwrite and t.is_dir():
                    shutil.rmtree(t)
                shutil.copytree(s, t, dirs_exist_ok=overwrite)
            else:
                shutil.copy2(s, t)
            r.add_ok(str(s))
        except OSError as e:
            r.add_fail(sp, str(e))
    return r


def move_to(dest_dir: str, src_paths: list[str], overwrite: bool = False) -> FileOpResult:
    r = FileOpResult()
    dest = Path(dest_dir)
    if not dest.is_dir():
        for p in src_paths:
            r.add_fail(p, f"目标不是目录: {dest_dir}")
        return r
    for sp in src_paths:
        s = Path(sp)
        if not s.exists():
            r.add_fail(sp, "源不存在")
            continue
        try:
            s_res = s.resolve()
        except OSError:
            s_res = s
        if str(s_res).rstrip("/\\") == str(dest.resolve()).rstrip("/\\") or s_res.parent == dest.resolve():
            r.add_ok(str(s))
            continue
        t = dest / s.name
        if t.exists() and not overwrite and t != s:
            r.add_fail(sp, "目标已存在")
            continue
        try:
            if t.exists() and overwrite:
                if t.is_dir() and s.is_dir():
                    shutil.rmtree(t)
                elif t.is_file() or t.is_symlink():
                    t.unlink()
            shutil.move(str(s), str(t))
            r.add_ok(str(t))
        except OSError as e:
            r.add_fail(sp, str(e))
    return r


def rename_path(old: str, new_name: str) -> FileOpResult:
    r = FileOpResult()
    o = Path(old)
    if not o.exists():
        r.add_fail(old, "源不存在")
        return r
    new_name = new_name.replace("/", "").replace("\\", "")
    if not new_name or new_name in (".", ".."):
        r.add_fail(old, "非法名称")
        return r
    parent = o.parent
    t = parent / new_name
    if t.exists() and t.resolve() != o.resolve():
        r.add_fail(old, "目标已存在")
        return r
    try:
        o.rename(t)
        r.add_ok(str(t))
    except OSError as e:
        r.add_fail(old, str(e))
    return r


def trash_paths(paths: list[str]) -> FileOpResult:
    r = FileOpResult()
    if send2trash is None:
        for p in paths:
            r.add_fail(p, "未安装 send2trash，无法放入回收站")
        return r
    for p in paths:
        if not os.path.exists(p):
            r.add_fail(p, "路径不存在")
            continue
        try:
            send2trash.send2trash(p)
            r.add_ok(p)
        except OSError as e:
            r.add_fail(p, str(e))
    return r


def delete_permanent(paths: list[str]) -> FileOpResult:
    r = FileOpResult()
    for p in paths:
        o = Path(p)
        if not o.exists():
            r.add_fail(p, "路径不存在")
            continue
        try:
            if o.is_dir():
                shutil.rmtree(o)
            else:
                o.unlink()
            r.add_ok(p)
        except OSError as e:
            r.add_fail(p, str(e))
    return r


def mkdir_p(parent: str, name: str) -> FileOpResult:
    r = FileOpResult()
    name = name.replace("/", "").replace("\\", "")
    if not name:
        r.add_fail(parent, "名称为空")
        return r
    p = Path(parent) / name
    try:
        p.mkdir(parents=True, exist_ok=True)
        r.add_ok(str(p))
    except OSError as e:
        r.add_fail(str(p), str(e))
    return r


def list_natural_dir(path: str) -> list[Path]:
    p = Path(path)
    if not p.is_dir():
        return []
    try:
        names = list(p.iterdir())
    except OSError:
        return []
    return natsorted(names, key=lambda x: x.name)


_WALK_IGNORE = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".vite",
        ".cursor",
        "dist",
        "build",
        "coverage",
    }
)


def list_dir_all(path: str, *, recursive: bool) -> list[Path]:
    """列出目录下项；recursive 时在忽略噪音目录后递归。"""
    r = Path(path)
    if not r.is_dir():
        return []
    if not recursive:
        return list_natural_dir(path)
    out: list[Path] = []
    for dp, dnames, fnames in os.walk(str(r), topdown=True):
        dpath = Path(dp)
        dnames[:] = [x for x in dnames if x not in _WALK_IGNORE and not x.startswith(".")]
        for d in dnames:
            out.append(dpath / d)
        for f in fnames:
            out.append(dpath / f)
    return natsorted(out, key=lambda x: str(x).casefold())


# --- 相对仓库路径 ---
def get_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def rel_to_repo(abs_path: str) -> str:
    try:
        return str(Path(abs_path).resolve().relative_to(get_repo_root().resolve()))
    except (ValueError, OSError):
        return abs_path


def show_in_os(path: str) -> bool:
    if not path:
        return False
    p = path if os.path.isfile(path) else (os.path.dirname(path) or path)
    u = QUrl.fromLocalFile(p)
    return QDesktopServices.openUrl(u)


class FileOpsService(QObject):
    """供 UI/拖放 调用的薄封装，便于后续扩展。"""

    def copyTo(
        self,
        dest_dir: str,
        src: list[str],
        overwrite: bool = False,
        *,
        autorename: bool = False,
    ) -> FileOpResult:
        return copy_to(dest_dir, src, overwrite=overwrite, autorename=autorename)

    def moveTo(self, dest_dir: str, src: list[str], overwrite: bool = False) -> FileOpResult:
        return move_to(dest_dir, src, overwrite=overwrite)

    def trash(self, paths: list[str]) -> FileOpResult:
        return trash_paths(paths)

    @staticmethod
    def openInExplorer(p: str) -> bool:
        return show_in_os(p)


# --- 批量重命名（预览/执行）---
@dataclass
class BatchRenameItem:
    old_path: str
    new_name: str
    will_collide: bool = False
    is_invalid: bool = False
    error: str = ""


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def plan_batch_rename(
    paths: list[str],
    mode: Literal["sequential", "replace", "prefix", "suffix"],
    start_index: int = 1,
    find_text: str = "",
    repl_text: str = "",
    prefix: str = "",
    suffix: str = "",
) -> list[BatchRenameItem]:
    items: list[BatchRenameItem] = []
    if not paths:
        return items
    sorted_p = natsorted(paths, key=lambda x: Path(x).name)
    planned: set[str] = set()
    n = int(start_index)
    for p in sorted_p:
        o = Path(p)
        stem, ext = o.stem, o.suffix
        if mode == "sequential":
            new_name = f"{stem}_{n:04d}{ext}"
        elif mode == "replace":
            new_name = stem.replace(find_text, repl_text) + ext
        elif mode == "prefix":
            new_name = f"{prefix}{stem}{ext}"
        elif mode == "suffix":
            new_name = f"{stem}{suffix}{ext}"
        else:
            new_name = o.name
        new_name = _safe_name(new_name)
        if not new_name or new_name in (".", ".."):
            items.append(
                BatchRenameItem(
                    old_path=p, new_name=new_name, is_invalid=True, error="非法名"
                )
            )
            n += 1
            continue
        t = o.parent / new_name
        tkey = t.as_posix()
        on_disk = t.exists() and t.resolve() != o.resolve()
        in_batch = tkey in planned
        if on_disk or in_batch:
            err = "与已有重名" if on_disk else "本批重名"
            items.append(
                BatchRenameItem(
                    old_path=p,
                    new_name=new_name,
                    is_invalid=True,
                    will_collide=on_disk,
                    error=err,
                )
            )
        else:
            planned.add(tkey)
            items.append(BatchRenameItem(old_path=p, new_name=new_name))
        n += 1
    return items


def apply_batch_rename(planned: list[BatchRenameItem]) -> FileOpResult:
    r = FileOpResult()
    for it in planned:
        if it.is_invalid:
            continue
        o = Path(it.old_path)
        t = o.parent / it.new_name
        if t.exists() and t.resolve() != o.resolve():
            r.add_fail(it.old_path, "目标已存在")
            continue
        sub = rename_path(it.old_path, it.new_name)
        r.ok.extend(sub.ok)
        r.failed.extend(sub.failed)
    return r
