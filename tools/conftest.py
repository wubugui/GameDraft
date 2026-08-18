"""Repository-wide safety fixtures for tests under ``tools/``."""
from __future__ import annotations

import faulthandler
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable, Iterator

# 离屏是测试的默认平台，省得每条命令都手打 QT_QPA_PLATFORM=offscreen。
# 用 setdefault：想开真窗口调试的人 `QT_QPA_PLATFORM=cocoa pytest ...` 照常生效。
# Qt 的平台插件在 QGuiApplication 构造时才解析这个变量，所以放模块顶层（早于任何
# QApplication 构造）就够，不必赶在 PySide6 import 之前。
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

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


_SHUTDOWN_GRACE_SECONDS = 120.0


def _child_pids_windows() -> list[str]:
    lister = subprocess.run(
        [
            "powershell", "-NoProfile", "-Command",
            f"(Get-CimInstance Win32_Process -Filter 'ParentProcessId={os.getpid()}').ProcessId",
        ],
        capture_output=True, text=True, check=False,
    )
    return [p.strip() for p in (lister.stdout or "").split() if p.strip().isdigit()]


def _dump_child_stacks(pids: list[str]) -> None:
    """py-spy 拍下卡死 worker 的 python 栈——这是定位「谁留了不退线程」的根因证据。

    py-spy 是可选依赖（pip install py-spy），不在就跳过，不影响强退兜底。
    """

    py_spy = Path(sys.executable).with_name("py-spy.exe" if os.name == "nt" else "py-spy")
    if not py_spy.exists():
        return
    for pid in pids:
        probe = subprocess.run(
            [str(py_spy), "dump", "--pid", pid, "--nonblocking"],
            capture_output=True, text=True, check=False, timeout=30,
        )
        sys.stderr.write(f"\n[tools/conftest] 卡死子进程 {pid} 的线程栈（py-spy）：\n")
        sys.stderr.write(probe.stdout or probe.stderr or "(py-spy 无输出)\n")
    sys.stderr.flush()


def _kill_child_process_trees_windows(pids: list[str]) -> None:
    """Terminate direct children (stuck xdist workers) so os._exit can keep the real exit code."""

    for pid in pids:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", pid],
            capture_output=True, check=False,
        )


@pytest.hookimpl(hookwrapper=True)
def pytest_sessionfinish(session, exitstatus):
    """Arm a shutdown watchdog so a stuck xdist worker cannot hang the whole run.

    实测（2026-08-17，Windows）：全量套件测试本体 ~7 分钟跑完后，个别 xdist worker
    在 execnet 收尾握手里退不出去，controller 干等 ~15 分钟，整条命令零输出挂死。
    这里在 controller 的会话收尾一开始点火一个守卫计时器：正常收尾几秒内进程自然
    退出、守卫（daemon 线程）随进程消亡；超时仍活着则先 dump 全线程栈到 stderr 留
    根因证据，再清掉残留 worker 进程树并以会话真实退出码强退。worker 侧不设卡——
    先测完的 worker 等 controller 收编是合法状态，掐它会丢测试。
    """
    if hasattr(session.config, "workerinput"):
        yield
        return

    status = int(exitstatus) if exitstatus is not None else 1

    def _force_shutdown() -> None:
        faulthandler.dump_traceback(all_threads=True, file=sys.stderr)
        sys.stderr.write(
            f"\n[tools/conftest] 会话结束 {_SHUTDOWN_GRACE_SECONDS:.0f}s 后进程仍未退出"
            "（xdist worker 收尾挂死），已 dump 线程栈并强退；退出码保留会话真实结果。\n",
        )
        sys.stderr.flush()
        if os.name == "nt":
            pids = _child_pids_windows()
            try:
                _dump_child_stacks(pids)
            except Exception:
                pass  # 取证失败不拦兜底强退
            _kill_child_process_trees_windows(pids)
        os._exit(status)

    watchdog = threading.Timer(_SHUTDOWN_GRACE_SECONDS, _force_shutdown)
    watchdog.daemon = True
    watchdog.start()
    yield


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
