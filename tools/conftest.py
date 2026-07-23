"""Repository-wide safety fixtures for tests under ``tools/``."""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Callable, Iterator

import pytest

from tools.testing.repo_write_guard import install_repository_write_guard


_REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
_qsettings_tempdir: tempfile.TemporaryDirectory[str] | None = None
_qsettings_root: Path | None = None
_original_qsettings_class: type | None = None


def _install_qsettings_isolation() -> None:
    """Force two-string QSettings constructors onto a temporary INI store.

    macOS ignores ``setDefaultFormat(IniFormat)`` for ``QSettings(org, app)``
    and otherwise writes ``~/Library/Preferences/*.plist``.  The test-facing
    subclass selects the explicit INI constructor, whose path is redirectable.
    """

    global _qsettings_tempdir, _qsettings_root, _original_qsettings_class
    if _original_qsettings_class is not None:
        return

    from PySide6 import QtCore

    real_qsettings = QtCore.QSettings
    tempdir = tempfile.TemporaryDirectory(prefix="gamedraft-pytest-qsettings-")
    settings_root = Path(tempdir.name).resolve()
    real_qsettings.setPath(
        real_qsettings.Format.IniFormat,
        real_qsettings.Scope.UserScope,
        str(settings_root),
    )
    real_qsettings.setPath(
        real_qsettings.Format.IniFormat,
        real_qsettings.Scope.SystemScope,
        str(settings_root),
    )

    class IsolatedQSettings(real_qsettings):
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003
            if len(args) == 2 and all(isinstance(arg, str) for arg in args):
                super().__init__(
                    real_qsettings.Format.IniFormat,
                    real_qsettings.Scope.UserScope,
                    args[0],
                    args[1],
                    **kwargs,
                )
                return
            super().__init__(*args, **kwargs)

    IsolatedQSettings.__name__ = "QSettings"
    IsolatedQSettings.__qualname__ = "QSettings"
    QtCore.QSettings = IsolatedQSettings
    _qsettings_tempdir = tempdir
    _qsettings_root = settings_root
    _original_qsettings_class = real_qsettings


def pytest_configure() -> None:
    """Make the checked-out project read-only before test collection completes."""

    install_repository_write_guard(_REPOSITORY_ROOT)
    _install_qsettings_isolation()


def pytest_unconfigure() -> None:
    """Restore the QtCore class; the isolated files remain disposable."""

    global _qsettings_tempdir, _qsettings_root, _original_qsettings_class
    if _original_qsettings_class is not None:
        from PySide6 import QtCore

        QtCore.QSettings = _original_qsettings_class
    if _qsettings_tempdir is not None:
        _qsettings_tempdir.cleanup()
    _qsettings_tempdir = None
    _qsettings_root = None
    _original_qsettings_class = None


@pytest.fixture(scope="session", autouse=True)
def _redirect_dialogue_layout_store(
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[tuple[Path, Path]]:
    """Keep the layout redirect installed for the entire pytest process.

    Tests still read every game/editor asset from the real project.  Only
    ``dialogue_flow_layout.json`` is redirected; no media or DVC tree is copied.
    """

    from tools.dialogue_graph_editor import flow_layout_store

    original_layout_file_path: Callable[[Path], Path] = flow_layout_store.layout_file_path
    source_layout = original_layout_file_path(_REPOSITORY_ROOT)
    isolated_project_root = tmp_path_factory.mktemp("dialogue-layout-project")
    isolated_layout = original_layout_file_path(isolated_project_root)

    def redirected_layout_file_path(project_root: Path) -> Path:
        resolved_root = Path(project_root).resolve()
        if resolved_root != _REPOSITORY_ROOT:
            return original_layout_file_path(Path(project_root))
        return isolated_layout

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        flow_layout_store,
        "layout_file_path",
        redirected_layout_file_path,
    )
    try:
        yield source_layout, isolated_layout
    finally:
        monkeypatch.undo()


@pytest.fixture(autouse=True)
def isolated_dialogue_layout_store(
    _redirect_dialogue_layout_store: tuple[Path, Path],
) -> Path:
    """Reset the 65 KiB sidecar for each test, never the whole project."""

    source_layout, isolated_layout = _redirect_dialogue_layout_store
    isolated_layout.parent.mkdir(parents=True, exist_ok=True)
    if source_layout.is_file():
        shutil.copy2(source_layout, isolated_layout)
    else:
        isolated_layout.write_text(json.dumps({}, indent=2) + "\n", encoding="utf-8")
    return isolated_layout


@pytest.fixture(scope="session", autouse=True)
def isolated_qsettings() -> Iterator[Path]:
    """Keep Qt user preferences out of the developer's real profile."""

    assert _qsettings_root is not None
    yield _qsettings_root
