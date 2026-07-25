"""Fail before Python tests mutate the real GameDraft working tree.

Tests may read the checked-out project, but writable fixtures must live outside
the repository (normally under pytest's ``tmp_path``).  The guard is installed
as a Python audit hook, so ordinary ``open``/``pathlib``/``os``/``shutil``
mutations are rejected before they reach disk.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any


class RepositoryWriteBlocked(PermissionError):
    """Raised when a test attempts to mutate the checked-out repository."""


_WRITE_OPEN_FLAGS = (
    os.O_WRONLY
    | os.O_RDWR
    | os.O_APPEND
    | os.O_CREAT
    | os.O_TRUNC
    | getattr(os, "O_EXCL", 0)
)

#: 单路径变更事件 -> 该事件里 ``dir_fd`` 的参数下标（None = 该调用没有 dir_fd）。
#: 下标取自 CPython 的 ``sys.audit`` 调用签名，无 dir_fd 时值是 ``-1``。
_ONE_PATH_MUTATIONS: dict[str, int | None] = {
    "os.remove": 1,
    "os.rmdir": 1,
    "os.mkdir": 2,
    "os.chmod": 2,
    "os.chown": 3,
    "os.truncate": None,
    "os.utime": 3,
    "os.setxattr": None,
    "os.removexattr": None,
}

#: macOS ``<sys/fcntl.h>``：由打开的 fd 反查它的路径。
_F_GETPATH = 50

_installed_roots: set[Path] = set()
_installed_guards: list["RepositoryWriteGuard"] = []


def _dir_fd_path(dir_fd: int) -> Path | None:
    """把 ``dir_fd`` 还原成目录路径；还原不出来返回 ``None``。

    ``shutil.rmtree`` 在支持 fd 的平台上走 ``_rmtree_safe_fd``，删每个条目用的是
    **裸文件名 + dir_fd**，而不是完整路径。不还原基准目录就拿 ``Path.cwd()`` 去拼，
    会把「删临时目录里的 xxx」误判成「删仓库里的 xxx」——本守卫早期就是这么把 pytest
    的 tmp 清理拦死的（每轮刷一屏 ``rm_rf error ... Directory not empty``，
    ``$TMPDIR/pytest-of-*`` 越堆越大）。
    """
    if sys.platform == "darwin":
        try:
            import fcntl

            raw = fcntl.fcntl(dir_fd, _F_GETPATH, b"\0" * 1024)
        except (OSError, ValueError):
            return None
        return Path(os.fsdecode(raw.split(b"\0", 1)[0]))
    try:
        return Path(os.readlink(f"/proc/self/fd/{dir_fd}"))
    except OSError:
        return None


class RepositoryWriteGuard:
    """Callable audit hook that makes a repository read-only to test code."""

    def __init__(self, repository_root: Path) -> None:
        self.repository_root = repository_root.resolve()

    @staticmethod
    def _event_paths(raw: Any, base: Path | None = None) -> tuple[Path, ...]:
        if isinstance(raw, int) or raw is None:
            return ()
        try:
            decoded = os.fsdecode(raw)
        except TypeError:
            return ()
        candidate = Path(decoded)
        if not candidate.is_absolute():
            candidate = (base if base is not None else Path.cwd()) / candidate
        lexical = Path(os.path.abspath(candidate))
        resolved = candidate.resolve(strict=False)
        if lexical == resolved:
            return (lexical,)
        # Check both forms: this blocks a path lexically inside the repository
        # that escapes through a symlink, and an outside path resolving inward.
        return (lexical, resolved)

    def _is_repository_path(self, candidate: Path | None) -> bool:
        if candidate is None:
            return False
        try:
            relative = candidate.relative_to(self.repository_root)
        except ValueError:
            return False

        # Python and pytest are allowed to maintain their own disposable caches.
        # No game/editor/source data is allowed through this exception.
        parts = relative.parts
        if "__pycache__" in parts:
            return False
        if parts and parts[0] in {".pytest_cache", ".hypothesis", "htmlcov"}:
            return False
        if len(parts) == 1 and (
            parts[0].startswith(".coverage") or parts[0] in {"coverage.xml", "junit.xml"}
        ):
            return False
        return True

    @staticmethod
    def _base_for(args: tuple[Any, ...], dir_fd_index: int | None) -> Path | None:
        """相对路径该拼在哪个目录下：有 dir_fd 就拼它，否则拼 cwd（返回 None 表示用 cwd）。"""
        if dir_fd_index is None or len(args) <= dir_fd_index:
            return None
        dir_fd = args[dir_fd_index]
        if not isinstance(dir_fd, int) or dir_fd < 0:  # -1 = 该次调用没传 dir_fd
            return None
        return _dir_fd_path(dir_fd)

    def _block(
        self,
        event: str,
        raw_path: Any,
        args: tuple[Any, ...] = (),
        dir_fd_index: int | None = None,
    ) -> None:
        base = self._base_for(args, dir_fd_index)
        if (
            base is None
            and dir_fd_index is not None
            and self._has_dir_fd(args, dir_fd_index)
            and not self._is_absolute(raw_path)
        ):
            # 带 dir_fd 但还原不出基准目录（跨平台兜底）：**相对**路径无从判断，放行。
            # 这类调用只来自 stdlib 的 fd 遍历（rmtree/scandir），不是测试代码写仓库的路子。
            # 绝对路径不受影响——它压根不需要 base，照常往下判（有 dir_fd 时内核也忽略它）。
            return
        for candidate in self._event_paths(raw_path, base):
            if self._is_repository_path(candidate):
                raise RepositoryWriteBlocked(
                    "Test attempted to mutate the real GameDraft working tree: "
                    f"event={event}, path={candidate}. "
                    "Use tmp_path/TemporaryDirectory or redirect the writable sidecar."
                )

    @staticmethod
    def _is_absolute(raw: Any) -> bool:
        if isinstance(raw, int) or raw is None:
            return False
        try:
            return Path(os.fsdecode(raw)).is_absolute()
        except TypeError:
            return False

    @staticmethod
    def _has_dir_fd(args: tuple[Any, ...], dir_fd_index: int) -> bool:
        if len(args) <= dir_fd_index:
            return False
        dir_fd = args[dir_fd_index]
        return isinstance(dir_fd, int) and dir_fd >= 0

    def __call__(self, event: str, args: tuple[Any, ...]) -> None:
        if event == "open" and args:
            # open 的审计负载是 (path, mode, flags)，没有 dir_fd 字段。
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else 0
            mode_writes = isinstance(mode, str) and any(ch in mode for ch in "wax+")
            flags_write = isinstance(flags, int) and bool(flags & _WRITE_OPEN_FLAGS)
            if mode_writes or flags_write:
                self._block(event, args[0])
            return

        if event in _ONE_PATH_MUTATIONS and args:
            self._block(event, args[0], args, _ONE_PATH_MUTATIONS[event])
            return

        # os.replace emits the os.rename audit event too.
        # 负载 (src, dst, src_dir_fd, dst_dir_fd)。
        if event == "os.rename" and len(args) >= 2:
            self._block(event, args[0], args, 2)
            self._block(event, args[1], args, 3)
            return

        # Creating a link mutates its destination, not its source.
        # os.link 负载 (src, dst, src_dir_fd, dst_dir_fd)；os.symlink 是 (src, dst, dir_fd)。
        if event in {"os.link", "os.symlink"} and len(args) >= 2:
            self._block(event, args[1], args, 3 if event == "os.link" else 2)


def install_repository_write_guard(repository_root: Path) -> RepositoryWriteGuard:
    """Install one idempotent process-wide guard and return it."""

    resolved = repository_root.resolve()
    for guard in _installed_guards:
        if guard.repository_root == resolved:
            return guard
    guard = RepositoryWriteGuard(resolved)
    sys.addaudithook(guard)
    _installed_roots.add(resolved)
    _installed_guards.append(guard)
    return guard


def repository_write_guard_installed(repository_root: Path) -> bool:
    """Expose installation state for a cheap, non-mutating regression probe."""

    return repository_root.resolve() in _installed_roots
