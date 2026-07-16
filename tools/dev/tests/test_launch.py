from __future__ import annotations

from pathlib import Path

from tools.dev import launch


def test_run_tool_disables_pydantic_plugins_on_windows(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(launch.platform, "system", lambda: "Windows")
    monkeypatch.setattr(launch, "project_python_ready", lambda: True)
    monkeypatch.setattr(launch, "project_python", lambda: Path("C:/Python/python.exe"))
    monkeypatch.setattr(launch, "repo_root", lambda: Path("D:/GameDraft"))

    def fake_call(argv, cwd=None, env=None):
        calls.append({"argv": argv, "cwd": cwd, "env": env})
        return 0

    monkeypatch.setattr(launch.subprocess, "call", fake_call)

    assert launch.run_tool("chronicle-sim", []) == 0

    assert calls[0]["argv"][0].lower().endswith("python.exe")
    assert calls[0]["argv"][1:] == ["-m", "tools.chronicle_sim_v3"]
    assert calls[0]["env"]["PYDANTIC_DISABLE_PLUGINS"] == "1"


def test_run_tool_keeps_unix_environment_unchanged(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(launch.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(launch, "project_python_ready", lambda: True)
    monkeypatch.setattr(launch, "project_python", lambda: Path("/repo/.tools/venv/bin/python"))
    monkeypatch.setattr(launch, "repo_root", lambda: Path("/repo"))

    def fake_call(argv, cwd=None, env=None):
        calls.append({"argv": argv, "cwd": cwd, "env": env})
        return 0

    monkeypatch.setattr(launch.subprocess, "call", fake_call)

    assert launch.run_tool("chronicle-sim", []) == 0

    assert calls[0]["argv"][0].endswith("python")
    assert calls[0]["argv"][1:] == ["-m", "tools.chronicle_sim_v3"]
    assert calls[0]["env"] is None
