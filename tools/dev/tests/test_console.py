"""Unified console behavior tests (no GUI, no subprocess launch)."""

from __future__ import annotations

from tools.dev_console.app import ConsoleState


def test_launch_tool_routes_output_through_console_process(monkeypatch):
    state = ConsoleState()
    calls = []

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
        return object()

    monkeypatch.setattr(state, "_start_process", fake_start_process)

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


def test_launch_tool_rejects_unknown_tool():
    state = ConsoleState()

    ok, message = state.launch_tool("missing-tool")

    assert not ok
    assert "Unknown tool" in message
