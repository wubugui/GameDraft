"""Generic launchers for the Python GUI tools.

Each runs ``<project_python> -m tools.<module> [args]`` from the repo root.
"""

from __future__ import annotations

import os
import platform
import subprocess

from tools.dev.paths import project_python, project_python_ready, repo_root

# task name -> (module, default extra argv)
TOOL_MODULES: dict[str, tuple[str, list[str]]] = {
    "console": ("tools.dev_console", []),
    "editor": ("tools.editor", []),
    "asset-browser": ("tools.asset_browser.main", []),
    "asset-ingest": ("tools.asset_ingest.main", []),
    "image-resizer": ("tools.image_resizer", []),
    "dialogue-graph": ("tools.dialogue_graph_editor", []),
    "workbench": ("tools.production_workbench", []),
    "chronicle-sim-v2": ("tools.chronicle_sim_v2", []),
    "chronicle-sim": ("tools.chronicle_sim_v3", []),
    "filter-tool": ("tools.filter_tool", []),
    "lightvol": ("tools.lightvolume_lab", []),
    "anim-preview": ("tools.anim_preview", []),
    "parallax-editor": ("tools.parallax_editor", []),
    "skill-governance": ("tools.skill_workflow_governance.console", []),
    "validate-data": ("tools.editor.validate", []),
}


def _argv_for(task: str, extra: list[str]) -> list[str]:
    module, default_args = TOOL_MODULES[task]
    args = ["-m", module, *default_args, *extra]
    if task in ("editor", "dialogue-graph", "workbench") and not extra:
        # These tools accept the project root as positional/--project argument.
        root = str(repo_root())
        if task == "dialogue-graph":
            return ["-m", module, "--project", root]
        return ["-m", module, root]
    return args


def _tool_env(base: dict[str, str] | None = None) -> dict[str, str] | None:
    if platform.system() != "Windows":
        return base
    env = dict(os.environ if base is None else base)
    env.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")
    return env


def run_tool(task: str, extra: list[str], check: bool = False) -> int:
    argv = _argv_for(task, extra)
    python = project_python()
    if check:
        print(f"[check] python={python}")
        print(f"[check] argv={argv}")
        print(f"[check] cwd={repo_root()}")
        return 0
    if not project_python_ready():
        print("Project Python runtime missing. Run ./bootstrap.sh first.")
        return 1
    try:
        return subprocess.call([str(python), *argv], cwd=str(repo_root()), env=_tool_env())
    except KeyboardInterrupt:
        return 130


def run_chronicle_week(extra: list[str], check: bool = False) -> int:
    """Run the weekly simulation helper with ``PYTHONPATH`` set to repo root."""
    import os

    script = "tools/chronicle_sim_v2/scripts/run_simulation_once.py"
    python = project_python()
    if check:
        print(f"[check] python={python} script={script} argv={extra}")
        return 0
    env = dict(os.environ)
    env["PYTHONPATH"] = str(repo_root())
    try:
        return subprocess.call([str(python), script, *extra], cwd=str(repo_root()), env=_tool_env(env))
    except KeyboardInterrupt:
        return 130


def run_agent_canvas_os(check: bool = False) -> int:
    """Launch the standalone Agent Canvas OS (~/AIWork/agent-canvas-os): sync server + tldraw web, then open the canvas.

    Not a ``tools.<module>`` GUI — it's a separate repo started via its ``scripts/start.sh``.
    """
    import socket
    import time
    import webbrowser
    from pathlib import Path

    start = Path.home() / "AIWork" / "agent-canvas-os" / "scripts" / "start.sh"
    if check:
        print(f"[check] bash {start}")
        return 0
    if not start.exists():
        print(f"Agent Canvas OS not found: {start} (build it first)")
        return 1
    subprocess.call(["bash", str(start)], cwd=str(start.parent.parent))
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1", 3100), timeout=0.3):
                webbrowser.open("http://localhost:3100/")
                return 0
        except OSError:
            time.sleep(0.5)
    print("Canvas web (:3100) not ready yet — open http://localhost:3100 manually.")
    return 0


def run_acos_agent(check: bool = False) -> int:
    """Run the Agent Canvas OS 'canvas agent' loop: watches the chat inbox and acts on the canvas.

    Standalone repo; needs ANTHROPIC_API_KEY (or a logged-in Claude Agent SDK).
    """
    from pathlib import Path

    agent = Path.home() / "AIWork" / "agent-canvas-os" / "scripts" / "agent.sh"
    if check:
        print(f"[check] bash {agent}")
        return 0
    if not agent.exists():
        print(f"canvas agent not found: {agent} (build Agent Canvas OS first)")
        return 1
    try:
        return subprocess.call(["bash", str(agent)])
    except KeyboardInterrupt:
        return 130
