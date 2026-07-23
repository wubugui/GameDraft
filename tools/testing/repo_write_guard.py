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

_ONE_PATH_MUTATIONS = frozenset(
    {
        "os.remove",
        "os.rmdir",
        "os.mkdir",
        "os.chmod",
        "os.chown",
        "os.truncate",
        "os.utime",
        "os.setxattr",
        "os.removexattr",
    }
)

_installed_roots: set[Path] = set()
_installed_guards: list["RepositoryWriteGuard"] = []


class RepositoryWriteGuard:
    """Callable audit hook that makes a repository read-only to test code."""

    def __init__(self, repository_root: Path) -> None:
        self.repository_root = repository_root.resolve()

    @staticmethod
    def _event_paths(raw: Any) -> tuple[Path, ...]:
        if isinstance(raw, int) or raw is None:
            return ()
        try:
            decoded = os.fsdecode(raw)
        except TypeError:
            return ()
        candidate = Path(decoded)
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
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

    def _block(self, event: str, raw_path: Any) -> None:
        for candidate in self._event_paths(raw_path):
            if self._is_repository_path(candidate):
                raise RepositoryWriteBlocked(
                    "Test attempted to mutate the real GameDraft working tree: "
                    f"event={event}, path={candidate}. "
                    "Use tmp_path/TemporaryDirectory or redirect the writable sidecar."
                )

    def __call__(self, event: str, args: tuple[Any, ...]) -> None:
        if event == "open" and args:
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else 0
            mode_writes = isinstance(mode, str) and any(ch in mode for ch in "wax+")
            flags_write = isinstance(flags, int) and bool(flags & _WRITE_OPEN_FLAGS)
            if mode_writes or flags_write:
                self._block(event, args[0])
            return

        if event in _ONE_PATH_MUTATIONS and args:
            self._block(event, args[0])
            return

        # os.replace emits the os.rename audit event too.
        if event == "os.rename" and len(args) >= 2:
            self._block(event, args[0])
            self._block(event, args[1])
            return

        # Creating a link mutates its destination, not its source.
        if event in {"os.link", "os.symlink"} and len(args) >= 2:
            self._block(event, args[1])


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
