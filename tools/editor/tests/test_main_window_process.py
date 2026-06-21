from __future__ import annotations

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
