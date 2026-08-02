from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QWidget

from tools.editor import main_window


def test_npm_run_command_uses_cmd_shell_on_windows(monkeypatch):
    monkeypatch.setattr(main_window.os, "name", "nt", raising=False)
    monkeypatch.setitem(main_window.os.environ, "ComSpec", "C:/Windows/System32/cmd.exe")
    monkeypatch.setattr(main_window, "npm_command", lambda: r"C:\Program Files\nodejs\npm.cmd")

    program, args = main_window._npm_run_command("run", "dev")

    assert program == "C:/Windows/System32/cmd.exe"
    assert args == ["/d", "/c", r"C:\Program Files\nodejs\npm.cmd", "run", "dev"]


def test_npm_run_command_uses_direct_npm_on_unix(monkeypatch):
    monkeypatch.setattr(main_window.os, "name", "posix", raising=False)
    monkeypatch.setattr(main_window, "npm_command", lambda: "/opt/homebrew/bin/npm")

    program, args = main_window._npm_run_command("run", "dev")

    assert program == "/opt/homebrew/bin/npm"
    assert args == ["run", "dev"]


def test_reference_catalog_reload_isolates_one_broken_editor():
    app = QApplication.instance() or QApplication([])
    del app

    class BrokenEditor(QWidget):
        def reload_refs_from_model(self):
            raise RuntimeError("bad catalog")

    class HealthyEditor(QWidget):
        calls = 0

        def reload_refs_from_model(self):
            self.calls += 1

    broken = BrokenEditor()
    healthy = HealthyEditor()
    status = SimpleNamespace(showMessage=lambda *_args: None)
    owner = SimpleNamespace(
        _editor_instances=[broken, healthy],
        _model=SimpleNamespace(),
        _status=status,
    )

    main_window.MainWindow._reload_all_reference_catalogs(owner)

    assert healthy.calls == 1


def test_dialogue_process_exit_refreshes_and_stops_watch_timer():
    class Process:
        def __init__(self, running: bool) -> None:
            self.running = running

        def poll(self):
            return None if self.running else 0

    events: list[str] = []
    owner = SimpleNamespace(
        _dialogue_external_processes=[Process(False), Process(True)],
        _dialogue_process_watch_timer=SimpleNamespace(
            stop=lambda: events.append("stop"),
        ),
        _reload_all_reference_catalogs=lambda: events.append("reload"),
    )

    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert len(owner._dialogue_external_processes) == 1
    assert events == ["reload"]

    owner._dialogue_external_processes[0].running = False
    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert events == ["reload", "reload", "stop"]
