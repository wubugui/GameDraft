"""Generic launchers for the Python GUI tools.

Each runs ``<project_python> -m tools.<module> [args]`` from the repo root.
"""

from __future__ import annotations

import subprocess

from tools.dev.paths import project_python, project_python_ready, repo_root

# task name -> (module, default extra argv)
TOOL_MODULES: dict[str, tuple[str, list[str]]] = {
    "editor": ("tools.editor", []),
    "asset-browser": ("tools.asset_browser.main", []),
    "asset-ingest": ("tools.asset_ingest.main", []),
    "dialogue-graph": ("tools.dialogue_graph_editor", []),
    "workbench": ("tools.production_workbench", []),
    "chronicle-sim-v2": ("tools.chronicle_sim_v2", []),
    "chronicle-sim": ("tools.chronicle_sim_v3", []),
    "filter-tool": ("tools.filter_tool", []),
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
    return subprocess.call([str(python), *argv], cwd=str(repo_root()))


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
    return subprocess.call(
        [str(python), script, *extra], cwd=str(repo_root()), env=env
    )
