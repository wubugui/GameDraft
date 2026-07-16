"""Unified console behavior tests (no GUI, no subprocess launch)."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from tools.dev_console import app
from tools.dev_console.app import ConsoleState, TOOLS
from tools.skill_workflow_governance.skill_workflow_governance.mcp_server import GovernanceMcpServer


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
    launch_tools = [tool for tool in TOOLS if tool.task != "skill-governance"]

    for tool in launch_tools:
        ok, message = state.launch_tool(tool.task)
        assert ok, tool.task
        assert message == "ok"

    assert [call["argv"] for call in calls] == [
        [str(python), "-m", "tools.dev", tool.task] for tool in launch_tools
    ]
    assert all(call["argv"] != [str(python), "-m", "tools.dev", "skill-governance"] for call in calls)


def test_all_tool_buttons_keep_dev_sh_on_unix(monkeypatch):
    _configure_platform(monkeypatch, "Linux")
    state = ConsoleState()
    calls = _capture_processes(monkeypatch, state)
    launch_tools = [tool for tool in TOOLS if tool.task != "skill-governance"]

    for tool in launch_tools:
        ok, message = state.launch_tool(tool.task)
        assert ok, tool.task
        assert message == "ok"

    assert [call["argv"] for call in calls] == [
        [str(state.dev_sh), tool.task] for tool in launch_tools
    ]
    assert all(call["argv"] != [str(state.dev_sh), "skill-governance"] for call in calls)


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


def test_launch_tool_refreshes_skill_governance_dashboard(monkeypatch):
    state = ConsoleState()
    calls: list[str] = []

    def fake_refresh():
        calls.append("refresh")
        return True, "ready"

    monkeypatch.setattr(state, "refresh_governance_dashboard", fake_refresh)

    ok, message = state.launch_tool("skill-governance")

    assert ok
    assert message == "ready"
    assert calls == ["refresh"]


def test_skill_governance_button_runs_audit_before_dashboard_redirect():
    assert 'tool.task === "skill-governance"' in app.INDEX_HTML
    assert 'post("/api/tool",{task:tool.task})' in app.INDEX_HTML
    assert 'window.location.href = data.url || "/governance/?fresh=1"' in app.INDEX_HTML
    assert "治理生成中..." in app.INDEX_HTML


def test_refresh_governance_dashboard_runs_audit_and_uses_generated_html(monkeypatch, tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    launcher = tmp_path / "tools" / "skill_workflow_governance" / "govern.py"
    dashboard = tmp_path / "tools" / "skill_workflow_governance" / "out" / "dashboard.html"
    launcher.parent.mkdir(parents=True)
    dashboard.parent.mkdir(parents=True)
    launcher.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    dashboard.write_text("<!doctype html><title>治理</title>", encoding="utf-8")
    calls: list[dict] = []

    class Result:
        returncode = 0
        stdout = "Artifacts: 1\nIssues:    0\n"
        stderr = ""

    def fake_run(argv, **kwargs):
        calls.append({"argv": argv, "kwargs": kwargs})
        return Result()

    monkeypatch.setattr(app.subprocess, "run", fake_run)

    ok, message = state.refresh_governance_dashboard()

    assert ok
    assert message == "ready"
    assert state.governance_dashboard_path() == dashboard
    assert calls[0]["argv"] == [app.sys.executable, str(launcher), "audit"]
    assert calls[0]["kwargs"]["cwd"] == str(tmp_path)


def test_governance_agent_reply_delegates_with_project_root(monkeypatch, tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    (tmp_path / "tools" / "skill_workflow_governance" / "out").mkdir(parents=True)
    (tmp_path / "tools" / "skill_workflow_governance" / "out" / "registry.json").write_text(
        "{}",
        encoding="utf-8",
    )
    seen: list[tuple[Path, dict]] = []

    def fake_answer(root: Path, payload: dict):
        seen.append((root, payload))
        return {"ok": True, "mode": "test", "reply": "pong"}

    monkeypatch.setattr(app, "answer_governance_chat", fake_answer)

    result = state.ask_governance_agent({"message": "ping"})

    assert result == {"ok": True, "mode": "test", "reply": "pong"}
    assert seen == [(tmp_path, {"message": "ping"})]


def test_governance_agent_prompt_includes_host_snapshot(tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    out_dir = tmp_path / "tools" / "skill_workflow_governance" / "out"
    run_dir = out_dir / "agent_runs" / "prompt-test"
    out_dir.mkdir(parents=True)
    (out_dir / "registry.json").write_text(
        """
        {
          "stats": {"artifact_count": 1, "issue_count": 1},
          "workpacks": [
            {"id": "broken-reference", "title": "断链修复包", "summary": "修断链", "issue_count": 1}
          ],
          "issues": [],
          "artifacts": []
        }
        """,
        encoding="utf-8",
    )

    run = app.build_governance_agent_run(
        tmp_path,
        {
            "provider": "local",
            "message": "ping",
            "references": [{"type": "workpack", "id": "broken-reference"}],
            "canvasState": {"provider": "claude", "selectedRefs": [{"type": "workpack", "id": "broken-reference"}]},
        },
        run_dir,
    )
    prompt = (run_dir / "prompt.md").read_text(encoding="utf-8")

    assert run["ok"]
    assert "治理台 Host/MCP 快照 JSON" in prompt
    assert "gamedraft.governance.host" in prompt
    assert "governance.apply_patch" in prompt
    assert "broken-reference" in prompt


def test_governance_job_log_preserves_raw_agent_output(tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    job = app.GovernanceJob(
        id="job-1",
        provider="claude",
        run_mode="chat",
        status="running",
        started_at="2026-07-08 22:00:00",
        run_dir=str(tmp_path / "run"),
        logs=[],
    )
    state.governance_jobs[job.id] = job
    raw_line = '{"type":"assistant","delta":"不要压缩这行"}\n'

    state._governance_job_log(job.id, raw_line, "raw")
    for index in range(405):
        state._governance_job_log(job.id, f"raw-{index}\n", "raw")

    snapshot = state.governance_job_snapshot(job.id)
    logs = snapshot["job"]["logs"]

    assert logs[0]["kind"] == "raw"
    assert logs[0]["text"] == raw_line
    assert len(logs) == 406
    assert logs[-1]["text"] == "raw-404\n"


def test_governance_hub_exposes_canvas_apps_resources_and_tools(tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    out_dir = tmp_path / "tools" / "skill_workflow_governance" / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "registry.json").write_text(
        """
        {
          "stats": {"artifact_count": 2, "issue_count": 1},
          "workpacks": [
            {"id": "broken-reference", "title": "断链修复包", "summary": "修断链", "issue_count": 1}
          ],
          "issues": [
            {"id": "issue-1", "path": "CLAUDE.md", "line": 1}
          ],
          "artifacts": [
            {"id": "artifact-1", "path": "CLAUDE.md"}
          ]
        }
        """,
        encoding="utf-8",
    )

    result = state.governance_hub_snapshot(
        {
            "canvasState": {
                "provider": "claude",
                "selectedRefs": [{"type": "workpack", "id": "broken-reference"}],
            }
        }
    )
    hub = result["hub"]

    assert result["ok"]
    assert hub["kind"] == "gamedraft.governance.host"
    assert hub["canvas"]["selectedRefs"] == [{"type": "workpack", "id": "broken-reference"}]
    assert any(app["id"] == "app-registry" and app["enabled"] for app in hub["apps"])
    assert any(resource["uri"] == "governance://canvas/current" for resource in hub["resources"])
    assert any(tool["name"] == "governance.apply_patch" for tool in hub["tools"])
    assert any(prompt["name"] == "governance.triage" for prompt in hub["prompts"])


def test_governance_apps_can_be_added_and_enabled(tmp_path):
    state = ConsoleState()
    state.root = tmp_path
    out_dir = tmp_path / "tools" / "skill_workflow_governance" / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "registry.json").write_text("{}", encoding="utf-8")

    result = state.update_governance_apps(
        {
            "action": "add",
            "label": "Design MCP",
            "endpoint": "http://127.0.0.1:9000/mcp",
        }
    )
    hub = result["hub"]

    assert result["ok"]
    assert any(app["id"] == "custom-design-mcp" and app["enabled"] for app in hub["apps"])
    assert (out_dir / "apps.json").exists()


def test_governance_mcp_server_exposes_hub_resources_and_tools(tmp_path):
    out_dir = tmp_path / "tools" / "skill_workflow_governance" / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "registry.json").write_text(
        """
        {
          "stats": {"artifact_count": 1, "issue_count": 0},
          "workpacks": [],
          "issues": [],
          "artifacts": []
        }
        """,
        encoding="utf-8",
    )
    server = GovernanceMcpServer(tmp_path)

    init = server._dispatch("initialize", {})
    resources = server._dispatch("resources/list", {})
    tools = server._dispatch("tools/list", {})
    read = server._dispatch("resources/read", {"uri": "governance://hub"})

    assert init["capabilities"]["resources"]
    assert any(resource["uri"] == "governance://hub" for resource in resources["resources"])
    assert any(tool["name"] == "governance.read_resource" for tool in tools["tools"])
    assert "gamedraft.governance.host" in read["contents"][0]["text"]


def test_governance_mcp_source_resource_is_self_describing(tmp_path):
    rel_path = ".cursor/skills/add-text-ref/SKILL.md"
    source = tmp_path / rel_path
    source.parent.mkdir(parents=True)
    source.write_text("# Add Text Ref\n\nSkill body.\n", encoding="utf-8")
    out_dir = tmp_path / "tools" / "skill_workflow_governance" / "out"
    out_dir.mkdir(parents=True)
    (out_dir / "registry.json").write_text(
        json.dumps(
            {
                "generated_at": "2026-07-09T00:00:00Z",
                "stats": {"artifact_count": 1, "issue_count": 1},
                "artifacts": [
                    {
                        "id": "artifact-add-text-ref",
                        "type": "skill",
                        "title": "add-text-ref",
                        "path": rel_path,
                        "source": ".cursor",
                        "summary": "Text reference skill.",
                        "tags": ["skill"],
                    }
                ],
                "issues": [
                    {
                        "id": "issue-add-text-ref-drift",
                        "severity": "warn",
                        "category": "drift",
                        "artifact_id": "artifact-add-text-ref",
                        "path": rel_path,
                        "line": 1,
                        "title": "Drift risk",
                        "evidence": "Example evidence.",
                        "suggestion": "Review this skill.",
                    }
                ],
                "workpacks": [
                    {
                        "id": "drift-risk",
                        "priority": "P1",
                        "title": "Drift risk",
                        "kind": "review",
                        "summary": "Review drift-prone skills.",
                        "next": "Inspect and align instructions.",
                        "issue_count": 1,
                        "artifact_count": 1,
                        "issue_ids": ["issue-add-text-ref-drift"],
                        "paths": [rel_path],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    server = GovernanceMcpServer(tmp_path)

    templates = server._dispatch("resources/templates/list", {})
    read = server._dispatch("resources/read", {"uri": "governance://source/.cursor%2Fskills%2Fadd-text-ref%2FSKILL.md"})
    payload = json.loads(read["contents"][0]["text"])

    assert any(item["uriTemplate"] == "governance://source/{path}" for item in templates["resourceTemplates"])
    assert payload["kind"] == "source"
    assert payload["uri"] == "governance://source/.cursor%2Fskills%2Fadd-text-ref%2FSKILL.md"
    assert payload["exists"] is True
    assert "whenPastedAlone" in payload["agentUse"]
    assert payload["related"]["issueCount"] == 1
    assert payload["related"]["workpackCount"] == 1
    assert payload["related"]["artifactCount"] == 1
    assert payload["related"]["issues"][0]["uri"] == "governance://issue/issue-add-text-ref-drift"
    assert payload["related"]["workpacks"][0]["uri"] == "governance://workpack/drift-risk"
    assert payload["related"]["artifacts"][0]["uri"] == "governance://artifact/artifact-add-text-ref"
    assert any(item["uri"] == "governance://workpack/drift-risk" for item in payload["nextResources"])


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
