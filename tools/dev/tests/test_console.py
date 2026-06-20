"""Unified console behavior tests (no GUI, no subprocess launch)."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from tools.dev_console import app
from tools.dev_console.app import ConsoleState, TOOLS


class DummyProc:
    pid = 12345

    def __init__(self, poll_code: int | None = 1) -> None:
        self._poll_code = poll_code

    def poll(self) -> int | None:
        return self._poll_code


class ImmediateThread:
    def __init__(self, target, args=(), kwargs=None, daemon=None):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}
        self.daemon = daemon

    def start(self):
        self.target(*self.args, **self.kwargs)


def _capture_processes(monkeypatch: pytest.MonkeyPatch, state: ConsoleState) -> list[dict]:
    calls: list[dict] = []

    def fake_start_process(title, argv, cwd=None, env=None, *, exclusive):
        calls.append(
            {
                "title": title,
                "argv": argv,
                "cwd": cwd,
                "env": env,
                "exclusive": exclusive,
            }
        )
        return DummyProc()

    monkeypatch.setattr(state, "_start_process", fake_start_process)
    return calls


def _configure_platform(
    monkeypatch: pytest.MonkeyPatch,
    system: str,
    *,
    python: Path | None = None,
    npm: str = "npm",
    env: dict[str, str] | None = None,
) -> None:
    monkeypatch.setattr(app.platform, "system", lambda: system)
    if python is not None:
        monkeypatch.setattr(app, "project_python", lambda: python)
    monkeypatch.setattr(app, "npm_command", lambda: npm)
    monkeypatch.setattr(app, "env_with_node_path", lambda: env or {"PATH": "node-bin"})


def test_launch_tool_routes_output_through_dev_sh_on_unix(monkeypatch):
    _configure_platform(monkeypatch, "Darwin")
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    ok, message = state.launch_tool("editor")

    assert ok
    assert message == "ok"
    assert calls == [
        {
            "title": "Launch editor",
            "argv": [str(state.dev_sh), "editor"],
            "cwd": None,
            "env": None,
            "exclusive": False,
        }
    ]


def test_launch_tool_routes_output_through_tools_dev_on_windows(monkeypatch):
    python = Path("C:/Python/python.exe")
    _configure_platform(monkeypatch, "Windows", python=python)
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    ok, message = state.launch_tool("editor")

    assert ok
    assert message == "ok"
    assert calls == [
        {
            "title": "Launch editor",
            "argv": [str(python), "-m", "tools.dev", "editor"],
            "cwd": None,
            "env": None,
            "exclusive": False,
        }
    ]


@pytest.mark.parametrize(
    ("action", "payload", "title", "argv_suffix", "cwd_kind", "exclusive"),
    [
        ("pull", {}, "Pull", ["pull", "--editor"], "root", True),
        ("push", {}, "Push", ["push"], "root", True),
        ("commit", {"message": "save"}, "Commit", ["commit", "-m", "save"], "root", True),
        ("start_game", {}, "Game server", ["game", "start"], "root", False),
        ("stop_game", {}, "Stop game", ["game", "stop"], "root", False),
        ("install_deps", {}, "Install deps", ["install-deps", "--tools", "all"], "root", True),
        ("init_runtime", {}, "Init runtime", ["init-runtime"], "root", True),
        ("init_editor", {}, "Init editor", ["init-editor"], "root", True),
    ],
)
def test_windows_console_actions_route_through_tools_dev(
    monkeypatch,
    action,
    payload,
    title,
    argv_suffix,
    cwd_kind,
    exclusive,
):
    python = Path("C:/Python/python.exe")
    _configure_platform(monkeypatch, "Windows", python=python)
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    ok, message = state.run_action(action, payload)

    assert ok
    assert message in {"started", "ok"}
    assert calls == [
        {
            "title": title,
            "argv": [str(python), "-m", "tools.dev", *argv_suffix],
            "cwd": None,
            "env": None,
            "exclusive": exclusive,
        }
    ]


@pytest.mark.parametrize(
    ("action", "payload", "title", "argv", "cwd_attr", "exclusive"),
    [
        ("pull", {}, "Pull", ["./pull-all.sh"], "scripts_dir", True),
        ("push", {}, "Push", ["./push-all.sh"], "scripts_dir", True),
        ("commit", {"message": "save"}, "Commit", ["./commit-all.sh", "save"], "scripts_dir", True),
        ("start_game", {}, "Game server", ["dev_sh", "game", "start"], None, False),
        ("stop_game", {}, "Stop game", ["dev_sh", "game", "stop"], None, False),
        ("install_deps", {}, "Install deps", ["dev_sh", "install-deps"], None, True),
        ("init_runtime", {}, "Init runtime", ["dev_sh", "init-runtime"], None, True),
        ("init_editor", {}, "Init editor", ["dev_sh", "init-editor"], None, True),
    ],
)
def test_unix_console_actions_keep_existing_shell_entrypoints(
    monkeypatch,
    action,
    payload,
    title,
    argv,
    cwd_attr,
    exclusive,
):
    _configure_platform(monkeypatch, "Darwin")
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)
    expected_argv = [str(state.dev_sh) if item == "dev_sh" else item for item in argv]
    expected_cwd = getattr(state, cwd_attr) if cwd_attr else None

    ok, message = state.run_action(action, payload)

    assert ok
    assert message in {"started", "ok"}
    assert calls == [
        {
            "title": title,
            "argv": expected_argv,
            "cwd": expected_cwd,
            "env": None,
            "exclusive": exclusive,
        }
    ]


@pytest.mark.parametrize(
    ("action", "title", "argv"),
    [
        ("git_status", "Git status", ["git", "status", "--short", "--branch"]),
        ("build", "Build", ["npm.cmd", "run", "build"]),
        ("test", "Test", ["npm.cmd", "test", "--", "--run"]),
    ],
)
def test_console_shared_actions_use_resolved_commands(monkeypatch, action, title, argv):
    _configure_platform(monkeypatch, "Windows", python=Path("C:/Python/python.exe"), npm="npm.cmd")
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    ok, message = state.run_action(action, {})

    assert ok
    assert message == "started"
    assert calls[0]["title"] == title
    assert calls[0]["argv"] == argv
    if action in {"build", "test"}:
        assert calls[0]["env"] == {"PATH": "node-bin"}
    else:
        assert calls[0]["env"] is None


def test_all_tool_buttons_route_through_tools_dev_on_windows(monkeypatch):
    python = Path("C:/Python/python.exe")
    _configure_platform(monkeypatch, "Windows", python=python)
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    for tool in TOOLS:
        ok, message = state.launch_tool(tool.task)
        assert ok, tool.task
        assert message == "ok"

    assert [call["argv"] for call in calls] == [
        [str(python), "-m", "tools.dev", tool.task] for tool in TOOLS
    ]


def test_all_tool_buttons_keep_dev_sh_on_unix(monkeypatch):
    _configure_platform(monkeypatch, "Linux")
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)

    for tool in TOOLS:
        ok, message = state.launch_tool(tool.task)
        assert ok, tool.task
        assert message == "ok"

    assert [call["argv"] for call in calls] == [
        [str(state.dev_sh), tool.task] for tool in TOOLS
    ]


def test_cancel_active_terminates_process_tree(monkeypatch):
    _configure_platform(monkeypatch, "Windows")
    state = ConsoleState()
    state.active_process = DummyProc(poll_code=None)
    state.active_title = "Build"
    terminated: list[int] = []

    def fake_run(argv, **_kwargs):
        terminated.append(int(argv[2]))
        return DummyProc()

    monkeypatch.setattr(app.subprocess, "run", fake_run)

    ok, message = state.run_action("cancel_active", {})

    assert ok
    assert message == "stopping"
    assert terminated == [DummyProc.pid]


def test_stop_game_terminates_tracked_game_process_before_port_cleanup(monkeypatch):
    python = Path("C:/Python/python.exe")
    _configure_platform(monkeypatch, "Windows", python=python)
    state = ConsoleState()
    state.game_process = DummyProc(poll_code=None)
    calls = _capture_processes(monkeypatch, state)
    terminated: list[int] = []

    def fake_run(argv, **_kwargs):
        terminated.append(int(argv[2]))
        return DummyProc()

    monkeypatch.setattr(app.subprocess, "run", fake_run)

    ok, message = state.run_action("stop_game", {})

    assert ok
    assert message == "started"
    assert terminated == [DummyProc.pid]
    assert state.game_process is None
    assert calls == [
        {
            "title": "Stop game",
            "argv": [str(python), "-m", "tools.dev", "game", "stop"],
            "cwd": None,
            "env": None,
            "exclusive": False,
        }
    ]


def test_launch_tool_rejects_unknown_tool():
    state = ConsoleState()

    ok, message = state.launch_tool("missing-tool")

    assert not ok
    assert "Unknown tool" in message


def test_dev_shortcuts_load_scene_and_narrative_entries():
    shortcuts = app.load_dev_shortcuts(app.repo_root())

    assert any(item["value"] == "dev_room" for item in shortcuts["scenes"])
    assert any(item["value"] == "听书" for item in shortcuts["narrative"])


def test_open_dev_scene_entry_starts_server_and_queues_url(monkeypatch):
    state = ConsoleState()
    started: list[bool] = []
    params_seen: list[dict[str, str]] = []

    monkeypatch.setattr(state, "_start_game", lambda: (started.append(True), (True, "started"))[1])
    monkeypatch.setattr(state, "_open_game_url_when_ready", lambda params: params_seen.append(params))
    monkeypatch.setattr(app.threading, "Thread", ImmediateThread)

    ok, message = state.run_action("open_dev_entry", {"kind": "scene", "value": "teahouse"})

    assert ok
    assert message == "opening"
    assert started == [True]
    assert params_seen == [{"mode": "dev", "devScene": "teahouse"}]


def test_open_dev_narrative_entry_starts_server_and_queues_url(monkeypatch):
    state = ConsoleState()
    params_seen: list[dict[str, str]] = []

    monkeypatch.setattr(state, "_start_game", lambda: (True, "started"))
    monkeypatch.setattr(state, "_open_game_url_when_ready", lambda params: params_seen.append(params))
    monkeypatch.setattr(app.threading, "Thread", ImmediateThread)

    ok, message = state.run_action("open_dev_entry", {"kind": "narrative", "value": "义庄镇尸"})

    assert ok
    assert message == "opening"
    assert params_seen == [{"mode": "dev", "narrativeWarp": "义庄镇尸"}]


def test_build_game_url_preserves_base_query_and_encodes_chinese_values():
    state = ConsoleState()

    url = state._build_game_url(
        {"mode": "dev", "narrativeWarp": "义庄镇尸"},
        "http://localhost:5174/play?foo=bar",
    )
    parts = urlsplit(url)

    assert parts.scheme == "http"
    assert parts.netloc == "localhost:5174"
    assert parts.path == "/play"
    assert parse_qs(parts.query) == {
        "foo": ["bar"],
        "mode": ["dev"],
        "narrativeWarp": ["义庄镇尸"],
    }


def test_record_game_url_from_vite_output_line():
    state = ConsoleState()

    state._record_game_url_from_line("  ➜  Local:   http://localhost:5174/")

    assert state.game_url == "http://localhost:5174/"
