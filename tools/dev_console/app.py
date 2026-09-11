from __future__ import annotations

import argparse
import atexit
import html
import json
import os
import platform
import re
import signal
import shlex
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlsplit, urlunsplit

from tools.dev.game_preview import open_game_preview
from tools.dev.paths import env_with_node_path, npm_command, project_python, repo_root
from tools.skill_workflow_governance.skill_workflow_governance.agent import (
    answer_governance_chat,
    build_governance_agent_run,
    list_governance_agents,
)
from tools.skill_workflow_governance.skill_workflow_governance.hub import (
    build_governance_hub,
    update_app_state,
)


@dataclass(frozen=True)
class ToolAction:
    label: str
    task: str
    note: str


@dataclass(frozen=True)
class DevShortcut:
    label: str
    value: str
    note: str = ""


@dataclass
class GovernanceJob:
    id: str
    provider: str
    run_mode: str
    status: str
    started_at: str
    run_dir: str
    stdout_path: str = ""
    stdout_href: str = ""
    seq: int = 0
    logs: list[dict[str, Any]] | None = None
    result: str = ""
    exit_code: int | None = None
    ended_at: str = ""
    before_stats: dict[str, Any] | None = None
    after_stats: dict[str, Any] | None = None
    audit_updated: bool = False

    def to_dict(self, since: int = 0) -> dict[str, Any]:
        logs = self.logs or []
        return {
            "id": self.id,
            "provider": self.provider,
            "runMode": self.run_mode,
            "status": self.status,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "runDir": self.run_dir,
            "stdoutPath": self.stdout_path,
            "stdoutHref": self.stdout_href,
            "seq": self.seq,
            "logs": [entry for entry in logs if int(entry.get("seq", 0)) > since],
            "result": self.result,
            "exitCode": self.exit_code,
            "beforeStats": self.before_stats or {},
            "afterStats": self.after_stats or {},
            "auditUpdated": self.audit_updated,
        }


TOOLS: tuple[ToolAction, ...] = (
    ToolAction("主编辑器", "editor", "内容、场景、资源索引"),
    ToolAction("手册", "handbook",
               "制作人自己维护的本地文档站（handbook/docs 下的 md 渲成网站：全站中文搜索、公式、表格、代码），与游戏/编辑器零耦合"),
    ToolAction("生产工作台", "workbench", "每日检查、剧情单元、素材任务"),
    ToolAction("构建管理工作台", "build-workbench", "发行版 ship 定时构建、归档与留档"),
    ToolAction("对话图", "dialogue-graph", "Graph 对话和节点关系"),
    ToolAction(
        "叙事调试器",
        "narrative-debugger",
        "边玩边看：戏走到哪、这一拍在等你做什么、刚才那一下系统认没认；可回到任意一拍重看"
        "（开完在游戏地址后面加 ?ndbg=1）",
    ),
    ToolAction("资源浏览器", "asset-browser", "浏览、拖拽、入库记录"),
    ToolAction("资源入库", "asset-ingest", "导入素材到工程结构"),
    ToolAction("图片缩放", "image-resizer", "等比缩放、水平/垂直对称、导出副本"),
    ToolAction("滤镜工具", "filter-tool", "ColorMatrix 预制和导出"),
    ToolAction("LightVolume 实验室", "lightvol", "深度图烘焙辐照度体积 / quad 预览(Web)"),
    ToolAction("光照烘焙实验室", "char-lighting",
               "光照烘焙的唯一入口:深度/标定/probe/体素/行走面 + 场景法线与天穹可见性,产物统一落 lighting/<背景图名>/(独立窗口,关窗即退,不占端口)"),
    ToolAction("轨迹工作台", "trajectory-workbench",
               "实体轨迹动画：加载场景（可还原 3D 伪世界）拉线 / 抛体物理烘成独立资产，"
               "playTrajectory 在任何场景挂任何实体播（独立窗口，零浏览器缓存）"),
    ToolAction("声学工作台", "acoustic-workbench",
               "场景回音：把场景在世界空间展开成 3D，反射面 / 听者贴着画里的崖壁摆，像 Unity 那样漫游操作；"
               "一键拉起游戏进当前场景实时预览、试听；它是 acoustic_spaces.json 的唯一写者（独立窗口，零浏览器缓存）"),
    ToolAction("粒子工作台", "vfx-workbench",
               "世界空间粒子 / 群体：发射器与模块按 types.ts 逐字建，3D 里摆发射器原点 / 巢半径 / 锚点，"
               "本地预览跑的就是运行时那份模拟核心；一键拉起游戏实时预览、发刺激；它是 assets/data/vfx/ 的唯一写者（独立窗口，零浏览器缓存）"),
    ToolAction("动画资源工作台", "anim-preview", "A→H 版本图 / 人工 R 装配 / 游戏真实渲染终验(Web IDE)"),
    ToolAction("Parallax 编辑器", "parallax-editor", "过场视差场景可视化编辑：图层/关键帧/轨迹，存 parallax_scenes.json(Web)"),
    ToolAction("Skill/Workflow 治理", "skill-governance", "扫描 skill、workflow 和 agent 入口，生成报告并打开 dashboard"),
    ToolAction("Agent Canvas OS", "agent-canvas-os", "AI 人机共创画布:tldraw + 任意 agent 经 MCP 感知/操作/生成/连线(独立,点开即起)"),
    ToolAction("编年史 v3", "chronicle-sim", "ChronicleSim v3"),
    ToolAction("编年史 v2", "chronicle-sim-v2", "ChronicleSim v2"),
)


GAME_SERVER_PORTS = (5173, 5174, 5175, 5176)
DEFAULT_GAME_URL = "http://localhost:5173/"
GAME_URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d+/?")

TOOL_LABELS: dict[str, str] = {tool.task: tool.label for tool in TOOLS}

# 工具进程的存活/孤儿检测缓存周期。页面每秒 poll 一次，枚举全机进程（要读每个 python 的
# 命令行）在 Windows 上要几十到几百毫秒，不能每次 poll 都扫。
TOOL_SCAN_TTL_SECONDS = 5.0


def tool_cmdline_matches(argv: list[str], task: str) -> bool:
    """这条命令行是不是 ``task`` 这个工具的一份实例。

    两种形态都算：控制台拉起的外层 ``python -m tools.dev <task>``，以及它再拉起的
    内层 ``python -m <该工具模块>``（见 tools/dev/launch.py 的 TOOL_MODULES）。
    只按 token 精确匹配：``tools.editor.validate`` 不是 ``editor``。
    """
    from tools.dev.launch import TOOL_MODULES

    module = TOOL_MODULES.get(task, ("", []))[0]
    for i, tok in enumerate(argv):
        if tok != "-m" or i + 1 >= len(argv):
            continue
        target = argv[i + 1]
        if target == "tools.dev" and i + 2 < len(argv) and argv[i + 2] == task:
            return True
        if module and target == module:
            return True
    return False


def _split_cmdline(cmd: str) -> list[str]:
    try:
        return shlex.split(cmd, posix=platform.system() != "Windows")
    except ValueError:
        return cmd.split()


def list_python_processes() -> list[dict[str, Any]]:
    """枚举本机 python 进程：``[{pid, ppid, argv, started}]``（started 为 datetime 或 None）。

    优先 psutil（项目 venv 自带）；没有就退到 PowerShell / ps。任何一步失败都返回空表——
    检测只是护栏，绝不能把控制台本身拖死。
    """
    try:
        import psutil  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - 缺库就走系统命令
        psutil = None
    if psutil is not None:
        out: list[dict[str, Any]] = []
        # 先只拿便宜的字段按名字筛，命令行（Windows 上要逐进程查询，全机 300+ 个进程要
        # 好几秒）只对 python 进程取。
        # 实测（Windows，438 个进程）：pid+name 枚举 0.02s；给每个进程取 ppid/create_time 要 4s。
        # 所以 ppid / create_time / cmdline 三项都只对筛出来的 python 进程取。
        for proc in psutil.process_iter(["pid", "name"]):
            info = proc.info
            name = str(info.get("name") or "").lower()
            if not name.startswith("python"):
                continue
            try:
                argv = list(proc.cmdline() or [])
                ppid = int(proc.ppid() or 0)
                created = float(proc.create_time() or 0)
            except (psutil.Error, OSError):
                continue
            started = None
            try:
                started = datetime.fromtimestamp(created)
            except (TypeError, ValueError, OSError, OverflowError):
                started = None
            out.append({"pid": int(info["pid"]), "ppid": ppid, "argv": argv, "started": started})
        return out
    return _list_python_processes_fallback()


def _list_python_processes_fallback() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        if platform.system() == "Windows":
            script = (
                "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | ForEach-Object {"
                " $c = if ($_.CreationDate) { $_.CreationDate.ToString('s') } else { '' };"
                " \"$($_.ProcessId)`t$($_.ParentProcessId)`t$c`t$($_.CommandLine)\" }"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, errors="replace", timeout=20, check=False,
            )
            for line in result.stdout.splitlines():
                parts = line.split("\t", 3)
                if len(parts) < 4 or not parts[0].strip().isdigit():
                    continue
                started = None
                try:
                    started = datetime.fromisoformat(parts[2].strip()) if parts[2].strip() else None
                except ValueError:
                    started = None
                out.append({
                    "pid": int(parts[0]), "ppid": int(parts[1] or 0),
                    "argv": _split_cmdline(parts[3]), "started": started,
                })
        else:
            result = subprocess.run(
                ["ps", "-eo", "pid=,ppid=,lstart=,args="],
                capture_output=True, text=True, errors="replace", timeout=20, check=False,
            )
            for line in result.stdout.splitlines():
                fields = line.split(None, 7)  # pid ppid + lstart 的 5 个字段 + args
                if len(fields) < 8 or not fields[0].isdigit():
                    continue
                started = None
                try:
                    started = datetime.strptime(" ".join(fields[2:7]), "%a %b %d %H:%M:%S %Y")
                except ValueError:
                    started = None
                argv = _split_cmdline(fields[7])
                if not argv or "python" not in os.path.basename(argv[0]).lower():
                    continue
                out.append({"pid": int(fields[0]), "ppid": int(fields[1]), "argv": argv, "started": started})
    except (OSError, subprocess.TimeoutExpired):
        return []
    return out


def tool_instance_roots(processes: list[dict[str, Any]], task: str, exclude_pids: set[int]) -> list[dict[str, Any]]:
    """从进程表里挑出 ``task`` 的实例，并折成"树根"（父进程不在匹配集里的那些）。

    ``exclude_pids``：本控制台自己拉起的实例（连同它们的后代）不算孤儿。后代按 ppid 链判。
    """
    by_pid = {p["pid"]: p for p in processes}

    def owned(pid: int) -> bool:
        seen: set[int] = set()
        cur = pid
        while cur and cur not in seen:
            if cur in exclude_pids:
                return True
            seen.add(cur)
            cur = int(by_pid.get(cur, {}).get("ppid") or 0)
        return False

    matched = {p["pid"]: p for p in processes if tool_cmdline_matches(p["argv"], task) and not owned(p["pid"])}
    roots = [p for pid, p in matched.items() if int(p.get("ppid") or 0) not in matched]
    roots.sort(key=lambda p: p["pid"])
    return [
        {
            "pid": p["pid"],
            "started": p["started"].strftime("%m-%d %H:%M:%S") if isinstance(p["started"], datetime) else None,
            "cmd": " ".join(p["argv"]),
        }
        for p in roots
    ]
GOVERNANCE_PATH = "/governance/"
GOVERNANCE_AGENT_SHELL_PORT = 8790
GOVERNANCE_AGENT_SHELL_PACKAGE = "claude-code-web@3.4.0"
GOVERNANCE_MCP_SERVER_NAME = "gamedraft-governance"
GOVERNANCE_OUT_MIME: dict[str, str] = {
    "agent-context-current.md": "text/markdown; charset=utf-8",
    "inventory.csv": "text/csv; charset=utf-8",
    "registry.json": "application/json; charset=utf-8",
    "report.md": "text/markdown; charset=utf-8",
}


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _scene_display_name(root: Path, scene_id: str, fallback: str = "") -> str:
    scene_json = root / "public" / "assets" / "scenes" / f"{scene_id}.json"
    raw = _read_json_file(scene_json)
    if isinstance(raw, dict):
        name = raw.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return fallback.strip() or scene_id


def load_dev_shortcuts(root: Path | None = None) -> dict[str, list[dict[str, str]]]:
    project_root = root or repo_root()
    data_dir = project_root / "public" / "assets" / "data"
    scenes: list[DevShortcut] = []
    seen_scenes: set[str] = set()

    def add_scene(scene_id: str, fallback_name: str = "") -> None:
        sid = scene_id.strip()
        if not sid or sid in seen_scenes:
            return
        seen_scenes.add(sid)
        label = _scene_display_name(project_root, sid, fallback_name)
        note = sid if label != sid else ""
        scenes.append(DevShortcut(label=label, value=sid, note=note))

    add_scene("dev_room", "Dev Room")

    # 全量场景直接来自 scenes/*.json（场景 id = 文件名，与运行时同口径）。此前只从
    # map_config 节点 + game_config 入口派生：map_config 只登记玩家可走的节点，梦境 /
    # 演出 / 测试场景都不在其中，而 dev 控制台要跳的正是这些——新建一个不进地图的场景，
    # 这里就永远看不见它。现在新建场景不需要登记到任何地方。
    rest: list[tuple[str, str]] = []
    for scene_json in (project_root / "public" / "assets" / "scenes").glob("*.json"):
        sid = scene_json.stem
        rest.append((_scene_display_name(project_root, sid), sid))
    for label, sid in sorted(rest):
        add_scene(sid, label)

    narrative: list[DevShortcut] = []
    narrative_config = _read_json_file(data_dir / "dev_narrative_warps.json")
    if isinstance(narrative_config, dict) and isinstance(narrative_config.get("warps"), list):
        for item in narrative_config["warps"]:
            if not isinstance(item, dict):
                continue
            warp_id = str(item.get("id") or "").strip()
            if not warp_id:
                continue
            label = str(item.get("label") or warp_id).strip()
            scene = str(item.get("scene") or "").strip()
            narrative.append(DevShortcut(label=label, value=warp_id, note=scene))

    return {
        "scenes": [shortcut.__dict__ for shortcut in scenes],
        "narrative": [shortcut.__dict__ for shortcut in narrative],
    }


DEV_SHORTCUTS = load_dev_shortcuts()


class ConsoleState:
    def __init__(self) -> None:
        self.root = repo_root()
        self.dev_sh = self.root / "dev.sh"
        self.scripts_dir = self.root / "scripts"
        self.lock = threading.Lock()
        self.logs: list[dict[str, Any]] = []
        self.seq = 0
        self.active_process: subprocess.Popen[str] | None = None
        self.active_title = ""
        self.game_process: subprocess.Popen[str] | None = None
        self.game_url = ""
        self.stopping_game_pids: set[int] = set()
        # 本控制台拉起的工具进程（task → Popen）。2026-09-09 事故：控制台重开时旧编辑器
        # 没被回收，孤儿进程拿启动那一刻的旧代码往现网数据上写。凡启动都登记、退出都回收、
        # 重复启动先拦。
        self.tool_processes: dict[str, subprocess.Popen[str]] = {}
        self._tool_scan_lock = threading.Lock()
        self._tool_scan_at = 0.0
        self._tool_scan_result: dict[str, list[dict[str, Any]]] = {}
        self.governance_jobs: dict[str, GovernanceJob] = {}
        self.governance_shell_process: subprocess.Popen[str] | None = None
        self.governance_shell_port = 0
        self.governance_shell_starting = False
        self.governance_mcp_status: dict[str, Any] = {"ok": False, "status": "unknown", "message": "not checked"}

    @property
    def is_windows(self) -> bool:
        return platform.system() == "Windows"

    def _dev_argv(self, *args: str) -> list[str]:
        if self.is_windows:
            return [str(project_python()), "-m", "tools.dev", *args]
        return [str(self.dev_sh), *args]

    def _script_or_dev_argv(self, script_name: str, *dev_args: str) -> list[str]:
        if self.is_windows:
            return self._dev_argv(*dev_args)
        return [f"./{script_name}"]

    def add_log(self, text: str, kind: str = "log") -> None:
        with self.lock:
            self.seq += 1
            self.logs.append(
                {
                    "seq": self.seq,
                    "time": time.strftime("%H:%M:%S"),
                    "kind": kind,
                    "text": text.rstrip(),
                }
            )
            if len(self.logs) > 3000:
                self.logs = self.logs[-2500:]

    def snapshot(self, since: int = 0) -> dict[str, Any]:
        with self.lock:
            logs = [entry for entry in self.logs if entry["seq"] > since]
            active = self.active_process is not None and self.active_process.poll() is None
            game = self.game_process is not None and self.game_process.poll() is None
            return {
                "root": str(self.root),
                "active": active,
                "activeTitle": self.active_title if active else "",
                "gameRunning": game,
                "gameUrl": self.game_url,
                "governanceMcp": dict(self.governance_mcp_status),
                "logs": logs,
                "seq": self.seq,
            }

    def snapshot_with_tools(self, since: int = 0) -> dict[str, Any]:
        """snapshot + 工具进程状态（含孤儿）。进程扫描带 TTL 缓存，不在 self.lock 里做。"""
        data = self.snapshot(since)
        data["tools"] = self.tools_status()
        return data

    def run_action(self, action: str, payload: dict[str, Any]) -> tuple[bool, str]:
        if action == "pull":
            return self._run_exclusive(
                "Pull",
                self._script_or_dev_argv("pull-all.sh", "pull", "--editor"),
                cwd=None if self.is_windows else self.scripts_dir,
            )
        if action == "push":
            return self._run_exclusive(
                "Push",
                self._script_or_dev_argv("push-all.sh", "push"),
                cwd=None if self.is_windows else self.scripts_dir,
            )
        if action == "commit":
            msg = str(payload.get("message") or "").strip()
            if not msg:
                return False, "请输入提交说明。"
            argv = (
                self._dev_argv("commit", "-m", msg)
                if self.is_windows
                else ["./commit-all.sh", msg]
            )
            return self._run_exclusive(
                "Commit",
                argv,
                cwd=None if self.is_windows else self.scripts_dir,
            )
        if action == "cancel_active":
            return self._cancel_active()
        if action == "git_status":
            return self._run_exclusive("Git status", ["git", "status", "--short", "--branch"])
        if action == "start_game":
            return self._start_game()
        if action == "stop_game":
            return self._stop_game()
        if action == "stop_tool":
            return self.stop_tool(str(payload.get("task") or ""))
        if action == "open_dev_entry":
            return self._open_dev_entry(
                str(payload.get("kind") or ""),
                str(payload.get("value") or payload.get("id") or ""),
                with_debugger=bool(payload.get("debugger")),
            )
        if action == "build":
            return self._run_exclusive("Build", [npm_command(), "run", "build"], env=env_with_node_path())
        if action == "test":
            return self._run_exclusive("Test", [npm_command(), "test", "--", "--run"], env=env_with_node_path())
        if action == "install_deps":
            args = ("install-deps", "--tools", "all") if self.is_windows else ("install-deps",)
            return self._run_exclusive("Install deps", self._dev_argv(*args))
        if action == "init_runtime":
            return self._run_exclusive("Init runtime", self._dev_argv("init-runtime"))
        if action == "init_editor":
            return self._run_exclusive("Init editor", self._dev_argv("init-editor"))
        return False, f"Unknown action: {action}"

    def launch_tool(self, task: str) -> tuple[bool, str]:
        if task not in {tool.task for tool in TOOLS}:
            return False, f"Unknown tool: {task}"
        if task == "skill-governance":
            return self.refresh_governance_dashboard()
        label = TOOL_LABELS.get(task, task)
        with self.lock:
            own = self.tool_processes.get(task)
        if own is not None and own.poll() is None:
            return False, (
                f"「{label}」已在运行（PID {own.pid}，本控制台启动）。不再开第二份——"
                "两份编辑器交替写同一批文件必丢数据；要重开先点「结束」或关掉它。"
            )
        orphans = self.find_tool_instances(task, fresh=True)
        if orphans:
            desc = "、".join(f"PID {o['pid']}（起于 {o['started'] or '未知'}）" for o in orphans)
            return False, (
                f"「{label}」还有上一个控制台留下的实例在跑：{desc}。它跑的是启动那一刻的旧代码，"
                "保存会用旧格式覆盖现网数据。先点「结束」（走它自己的关闭确认）或手动关掉，再启动。"
            )
        proc = self._start_process(f"Launch {task}", self._dev_argv(task), exclusive=False)
        if proc is None:
            return False, f"Failed to launch {task}."
        with self.lock:
            self.tool_processes[task] = proc
        return True, "ok"

    # ------------------------------------------------------------------ #
    # 工具进程生命周期：登记 / 孤儿检测 / 结束 / 退出回收
    # ------------------------------------------------------------------ #
    def _scan_tool_instances(self, *, fresh: bool = False) -> dict[str, list[dict[str, Any]]]:
        """全部工具的"非本控制台所有"实例（孤儿）。

        ``fresh=False``（页面 poll）只读缓存、绝不阻塞——缓存由 ``tool_scan_loop`` 后台线程
        每 TOOL_SCAN_TTL_SECONDS 刷一次；``fresh=True``（启动/结束按钮）同步真扫一次。
        """
        if not fresh:
            with self._tool_scan_lock:
                return self._tool_scan_result
        with self._tool_scan_lock:
            processes = list_python_processes()
            with self.lock:
                exclude = {p.pid for p in self.tool_processes.values() if p.poll() is None}
            exclude.add(os.getpid())
            result = {
                tool.task: tool_instance_roots(processes, tool.task, exclude)
                for tool in TOOLS
                if tool.task != "skill-governance"
            }
            self._tool_scan_result = result
            self._tool_scan_at = time.monotonic()
            return result

    def find_tool_instances(self, task: str, *, fresh: bool = False) -> list[dict[str, Any]]:
        return list(self._scan_tool_instances(fresh=fresh).get(task, []))

    def tools_status(self) -> dict[str, dict[str, Any]]:
        """给页面的每个工具按钮：running / pid / owned / started。"""
        orphans = self._scan_tool_instances()
        status: dict[str, dict[str, Any]] = {}
        with self.lock:
            owned = {task: proc for task, proc in self.tool_processes.items() if proc.poll() is None}
        for tool in TOOLS:
            own = owned.get(tool.task)
            if own is not None:
                status[tool.task] = {"running": True, "owned": True, "pid": own.pid, "started": None}
                continue
            roots = orphans.get(tool.task) or []
            if roots:
                status[tool.task] = {
                    "running": True, "owned": False,
                    "pid": roots[0]["pid"], "started": roots[0]["started"], "count": len(roots),
                }
            else:
                status[tool.task] = {"running": False, "owned": False, "pid": None, "started": None}
        return status

    def _process_tree_pids(self, pid: int) -> set[int]:
        """pid 及其全部后代（psutil；没有就退到 python 进程表的 ppid 链——非 python 子进程
        如 QtWebEngineProcess 本来就不拥有顶层窗口，漏掉无妨）。"""
        try:
            import psutil  # type: ignore[import-not-found]

            root = psutil.Process(pid)
            return {pid} | {c.pid for c in root.children(recursive=True)}
        except Exception:  # noqa: BLE001 - 缺库 / 进程已退出都走退路
            pass
        pids = {pid}
        procs = list_python_processes()
        changed = True
        while changed:
            changed = False
            for p in procs:
                if p["pid"] not in pids and int(p.get("ppid") or 0) in pids:
                    pids.add(p["pid"])
                    changed = True
        return pids

    def _windows_of_process_tree(self, pid: int) -> list[int]:
        """进程树名下所有**可见顶层窗口**的 HWND（仅 Windows）。"""
        import ctypes
        from ctypes import wintypes

        pids = self._process_tree_pids(pid)
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        found: list[int] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def _visit(hwnd, _lparam):  # noqa: ANN001
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value in pids and user32.IsWindowVisible(hwnd):
                found.append(int(hwnd))
            return True

        user32.EnumWindows(_visit, 0)
        return found

    def _post_wm_close(self, hwnd: int) -> None:
        import ctypes

        WM_CLOSE = 0x0010
        ctypes.windll.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)  # type: ignore[attr-defined]

    def _close_process_gracefully(self, pid: int) -> None:
        """请进程树自己关。

        Windows：给它名下每个可见顶层窗口 PostMessage(WM_CLOSE)——Qt 收到就走 closeEvent，
        编辑器的"未保存改动"确认照常弹。**不能用 `taskkill /T`（不带 /F）**：实测它一看到
        进程还有子进程（QtWebEngine 渲染子进程永远在）就直接拒绝，连 WM_CLOSE 都不发。
        一个可见窗口都没有 = 还没起来或已在退出，没有任何未保存的东西可丢 → 才强杀整棵树。
        POSIX：SIGTERM 进程组。
        """
        if self.is_windows:
            try:
                hwnds = self._windows_of_process_tree(pid)
            except Exception as exc:  # noqa: BLE001 - ctypes 出错不能拖死控制台
                self.add_log(f"枚举进程 {pid} 的窗口失败：{exc}", "err")
                hwnds = []
            if hwnds:
                for hwnd in hwnds:
                    self._post_wm_close(hwnd)
                self.add_log(f"已向 PID {pid} 的 {len(hwnds)} 个窗口发出关闭（WM_CLOSE），等它自己收尾。", "ok")
                return
            self.add_log(f"PID {pid} 没有任何可见窗口（未起完或正在退出），直接结束整棵进程树。", "cmd")
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True, text=True, errors="replace", check=False,
                )
            except OSError as exc:
                self.add_log(f"Failed to terminate process tree {pid}: {exc}", "err")
            return
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                return

    def stop_tool(self, task: str) -> tuple[bool, str]:
        if task not in TOOL_LABELS:
            return False, f"Unknown tool: {task}"
        label = TOOL_LABELS.get(task, task)
        with self.lock:
            own = self.tool_processes.get(task)
        if own is not None and own.poll() is None:
            self.add_log(f"请求关闭「{label}」（PID {own.pid}）…有未保存改动时它会自己弹确认。", "cmd")
            self._close_process_gracefully(own.pid)
            return True, f"已向「{label}」发出关闭请求。"
        orphans = self.find_tool_instances(task, fresh=True)
        if not orphans:
            return False, f"「{label}」没有在运行。"
        for root in orphans:
            self.add_log(
                f"请求关闭上一个控制台留下的「{label}」（PID {root['pid']}，起于 {root['started'] or '未知'}）…", "cmd",
            )
            self._close_process_gracefully(int(root["pid"]))
        self._scan_tool_instances(fresh=True)
        return True, f"已向 {len(orphans)} 个「{label}」旧实例发出关闭请求。"

    def tool_scan_loop(self) -> None:
        """后台刷新工具进程缓存：先报一次启动时的孤儿，之后每个 TTL 周期真扫一次。"""
        self.warn_about_orphans_on_startup()
        while True:
            time.sleep(TOOL_SCAN_TTL_SECONDS)
            try:
                self._scan_tool_instances(fresh=True)
            except Exception:  # noqa: BLE001 - 护栏线程绝不能因一次枚举失败而死
                continue

    def warn_about_orphans_on_startup(self) -> None:
        """控制台一起来就把上一个实例留下的工具进程报出来——沉默才是事故的温床。"""
        try:
            orphans = self._scan_tool_instances(fresh=True)
        except Exception as exc:  # noqa: BLE001 - 护栏不能拖死控制台
            self.add_log(f"启动时扫描旧工具进程失败：{exc}", "err")
            return
        for task, roots in orphans.items():
            if not roots:
                continue
            label = TOOL_LABELS.get(task, task)
            desc = "、".join(f"PID {r['pid']}（起于 {r['started'] or '未知'}）" for r in roots)
            self.add_log(
                f"⚠ 发现上一个控制台留下的「{label}」还在跑：{desc}。它用的是启动那一刻的旧代码，"
                "保存会覆盖现网数据；建议在工具区点「结束」关掉后再重开。", "err",
            )

    def governance_dashboard_path(self) -> Path:
        return self.root / "tools" / "skill_workflow_governance" / "out" / "dashboard.html"

    def refresh_governance_dashboard(self) -> tuple[bool, str]:
        script = self.root / "tools" / "skill_workflow_governance" / "govern.py"
        if not script.exists():
            return False, f"Missing governance launcher: {script}"

        self.add_log("Refreshing Skill/Workflow governance dashboard ...", "cmd")
        try:
            result = subprocess.run(
                [sys.executable, str(script), "audit"],
                cwd=str(self.root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.add_log(f"Governance refresh failed: {exc}", "err")
            return False, str(exc)

        output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        if output:
            for line in output.splitlines():
                self.add_log(line, "log")
        if result.returncode != 0:
            message = f"Governance audit exited with code {result.returncode}."
            self.add_log(message, "err")
            return False, message

        dashboard = self.governance_dashboard_path()
        if not dashboard.exists():
            message = f"Governance dashboard was not generated: {dashboard}"
            self.add_log(message, "err")
            return False, message

        self.add_log(f"Governance dashboard ready: {GOVERNANCE_PATH}", "ok")
        self.refresh_governance_mcp_status(log=True)
        return True, "ready"

    def governance_mcp_command(self) -> list[str]:
        python = project_python()
        if not python.exists():
            python = Path(sys.executable)
        launcher = self.root / "tools" / "skill_workflow_governance" / "mcp_server.py"
        return [str(python), "-B", str(launcher), str(self.root)]

    def governance_mcp_install_info(self) -> dict[str, Any]:
        command = self.governance_mcp_command()
        codex_cli = Path("/Applications/Codex.app/Contents/Resources/codex")
        codex = str(codex_cli if codex_cli.exists() else "codex")
        return {
            "serverName": GOVERNANCE_MCP_SERVER_NAME,
            "command": command,
            "codexInstall": shlex.join([codex, "mcp", "add", GOVERNANCE_MCP_SERVER_NAME, "--", *command]),
            "claudeCodeInstall": shlex.join(["claude", "mcp", "add", "--scope", "user", GOVERNANCE_MCP_SERVER_NAME, "--", *command]),
            "claudeDesktopConfig": {
                "mcpServers": {
                    GOVERNANCE_MCP_SERVER_NAME: {
                        "command": command[0],
                        "args": command[1:],
                    }
                }
            },
        }

    def refresh_governance_mcp_status(self, *, log: bool = False) -> dict[str, Any]:
        command = self.governance_mcp_command()
        request = "\n".join(
            json.dumps(payload, ensure_ascii=False)
            for payload in (
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "id": 2, "method": "resources/list", "params": {}},
                {"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {"uri": "governance://hub"}},
            )
        ) + "\n"
        status: dict[str, Any]
        try:
            result = subprocess.run(
                command,
                cwd=str(self.root),
                input=request,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=12,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            status = {"ok": False, "status": "failed", "message": str(exc), "install": self.governance_mcp_install_info()}
            self.governance_mcp_status = status
            if log:
                self.add_log(f"Governance MCP failed: {exc}", "err")
            return status

        responses: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                responses.append(item)
        resources = []
        for item in responses:
            payload = item.get("result")
            if isinstance(payload, dict) and isinstance(payload.get("resources"), list):
                resources = payload["resources"]
                break
        ok = result.returncode == 0 and any(item.get("id") == 1 and isinstance(item.get("result"), dict) for item in responses)
        status = {
            "ok": ok,
            "status": "ready" if ok else "failed",
            "message": "stdio self-test passed" if ok else (result.stderr.strip() or "MCP self-test failed"),
            "resourceCount": len(resources),
            "install": self.governance_mcp_install_info(),
        }
        self.governance_mcp_status = status
        if log:
            kind = "ok" if ok else "err"
            self.add_log(f"Governance MCP {status['status']}: {status['message']}", kind)
        return status

    def ask_governance_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        registry = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        if not registry.exists():
            self.refresh_governance_dashboard()
        return answer_governance_chat(self.root, payload)

    def start_governance_agent_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        registry = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        if not registry.exists():
            self.refresh_governance_dashboard()

        job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        run_dir = self.root / "tools" / "skill_workflow_governance" / "out" / "agent_runs" / job_id
        stdout_path = run_dir / "stdout.log"
        stdout_href = self._governance_file_href(stdout_path)
        run = build_governance_agent_run(self.root, payload, run_dir)
        provider = str(run.get("provider") or payload.get("provider") or "codex")
        run_mode = str(run.get("runMode") or payload.get("runMode") or "chat")
        job = GovernanceJob(
            id=job_id,
            provider=provider,
            run_mode=run_mode,
            status="queued",
            started_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            run_dir=str(run_dir),
            stdout_path=str(stdout_path),
            stdout_href=stdout_href,
            logs=[],
            before_stats=self._governance_stats(),
        )
        with self.lock:
            self.governance_jobs[job_id] = job

        if not run.get("ok"):
            self._governance_job_log(job_id, str(run.get("message") or "Agent 启动失败。"), "err")
            with self.lock:
                job.status = "failed"
                job.ended_at = time.strftime("%Y-%m-%d %H:%M:%S")
                job.result = str(run.get("message") or "Agent 启动失败。")
            return {"ok": True, "jobId": job_id, "status": job.status}

        if run.get("localReply"):
            self._governance_job_log(job_id, "Local governance helper completed.", "ok")
            with self.lock:
                job.status = "complete"
                job.ended_at = time.strftime("%Y-%m-%d %H:%M:%S")
                job.exit_code = 0
                job.result = str(run.get("localReply") or "")
                job.after_stats = self._governance_stats()
            return {"ok": True, "jobId": job_id, "status": job.status}

        threading.Thread(target=self._run_governance_agent_job, args=(job_id, run), daemon=True).start()
        return {"ok": True, "jobId": job_id, "status": "queued"}

    def governance_job_snapshot(self, job_id: str, since: int = 0) -> dict[str, Any]:
        with self.lock:
            job = self.governance_jobs.get(job_id)
            if job is None:
                return {"ok": False, "message": f"Unknown governance job: {job_id}"}
            return {"ok": True, "job": job.to_dict(since)}

    def governance_hub_snapshot(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        registry_path = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        if not registry_path.exists():
            self.refresh_governance_dashboard()
        try:
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            registry = {}
        with self.lock:
            jobs = dict(self.governance_jobs)
        return {"ok": True, "hub": build_governance_hub(self.root, registry if isinstance(registry, dict) else {}, payload or {}, jobs)}

    def update_governance_apps(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = update_app_state(self.root, payload)
        hub = self.governance_hub_snapshot({"canvasState": payload.get("canvasState") or {}}).get("hub", {})
        return {"ok": True, "state": state, "hub": hub}

    def ensure_governance_agent_shell(self) -> dict[str, Any]:
        with self.lock:
            proc = self.governance_shell_process
            port = self.governance_shell_port
            already_starting = self.governance_shell_starting
            if proc is not None and proc.poll() is None and port:
                return {
                    "ok": True,
                    "status": "ready" if self._port_is_open(port) else "starting",
                    "url": f"http://127.0.0.1:{port}/",
                    "port": port,
                    "pid": proc.pid,
                }
            if already_starting and port:
                pending_port = port
            else:
                pending_port = 0
                port = _free_port(GOVERNANCE_AGENT_SHELL_PORT)
                self.governance_shell_port = port
                self.governance_shell_starting = True

        if pending_port:
            ready = self._wait_for_port(pending_port, timeout=18.0)
            with self.lock:
                proc = self.governance_shell_process
                port = self.governance_shell_port or pending_port
            return {
                "ok": True,
                "status": "ready" if ready else "starting",
                "url": f"http://127.0.0.1:{port}/",
                "port": port,
                "pid": proc.pid if proc is not None else 0,
                "package": GOVERNANCE_AGENT_SHELL_PACKAGE,
            }

        if self._port_is_open(port):
            with self.lock:
                self.governance_shell_starting = False
            return {
                "ok": True,
                "status": "ready",
                "url": f"http://127.0.0.1:{port}/",
                "port": port,
                "pid": 0,
                "package": GOVERNANCE_AGENT_SHELL_PACKAGE,
            }

        env = self._governance_agent_shell_env()
        argv = [
            npm_command(),
            "exec",
            "--yes",
            "--package",
            GOVERNANCE_AGENT_SHELL_PACKAGE,
            "--",
            "cc-web",
            "--port",
            str(port),
            "--no-open",
            "--disable-auth",
            "--claude-alias",
            "Claude",
            "--codex-alias",
            "Codex",
        ]
        proc = self._start_process("Governance agent shell", argv, env=env, exclusive=False)
        if proc is None:
            with self.lock:
                self.governance_shell_starting = False
            return {"ok": False, "message": "Agent shell 启动失败。"}

        with self.lock:
            self.governance_shell_process = proc
            self.governance_shell_port = port
            self.governance_shell_starting = False

        ready = self._wait_for_port(port, timeout=18.0)
        return {
            "ok": True,
            "status": "ready" if ready else "starting",
            "url": f"http://127.0.0.1:{port}/",
            "port": port,
            "pid": proc.pid,
            "package": GOVERNANCE_AGENT_SHELL_PACKAGE,
        }

    def create_governance_context(self, payload: dict[str, Any]) -> dict[str, Any]:
        registry = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        if not registry.exists():
            self.refresh_governance_dashboard()

        context_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        run_dir = self.root / "tools" / "skill_workflow_governance" / "out" / "agent_contexts" / context_id
        prompt_payload = dict(payload)
        prompt_payload["localOnly"] = True
        run = build_governance_agent_run(self.root, prompt_payload, run_dir)
        prompt_path = Path(str(run.get("promptPath") or run_dir / "prompt.md"))
        if not prompt_path.exists():
            return {"ok": False, "message": "治理上下文生成失败。"}
        prompt = prompt_path.read_text(encoding="utf-8", errors="replace")
        current_path = self.root / "tools" / "skill_workflow_governance" / "out" / "agent-context-current.md"
        current_path.write_text(prompt, encoding="utf-8")
        return {
            "ok": True,
            "id": context_id,
            "path": str(current_path),
            "href": self._governance_file_href(current_path),
            "prompt": prompt,
            "bytes": len(prompt.encode("utf-8")),
        }

    def _run_governance_agent_job(self, job_id: str, run: dict[str, Any]) -> None:
        command = [str(part) for part in run.get("command") or []]
        stdin_text = str(run.get("stdin") or "")
        last_message_path = Path(str(run.get("lastMessagePath") or ""))
        stdout_path = Path(str(run.get("promptPath") or "")).with_name("stdout.log")
        with self.lock:
            job = self.governance_jobs[job_id]
            job.status = "running"
        self._governance_job_log(job_id, "$ " + _display_command(command), "cmd")

        code = 1
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(self.root),
                stdin=subprocess.PIPE if stdin_text else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                start_new_session=not self.is_windows,
            )
            if stdin_text and proc.stdin is not None:
                proc.stdin.write(stdin_text)
                proc.stdin.close()
            with stdout_path.open("w", encoding="utf-8") as stdout_file:
                if proc.stdout is not None:
                    for line in proc.stdout:
                        stdout_file.write(line)
                        stdout_file.flush()
                        self._governance_job_log(job_id, line, "raw")
            code = proc.wait()
        except OSError as exc:
            self._governance_job_log(job_id, f"Agent CLI failed: {exc}", "err")
            code = 1

        result = ""
        if last_message_path.exists():
            try:
                result = last_message_path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                result = ""
        if not result and stdout_path.exists():
            try:
                result = stdout_path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                result = ""
        if not result:
            result = f"Agent finished with exit code {code}."

        audit_updated = False
        after_stats: dict[str, Any] = {}
        if code == 0:
            self._governance_job_log(job_id, "Agent finished. Refreshing governance audit ...", "cmd")
            ok, message = self.refresh_governance_dashboard()
            audit_updated = ok
            after_stats = self._governance_stats()
            self._governance_job_log(job_id, message, "ok" if ok else "err")

        with self.lock:
            job = self.governance_jobs[job_id]
            job.status = "complete" if code == 0 else "failed"
            job.exit_code = code
            job.ended_at = time.strftime("%Y-%m-%d %H:%M:%S")
            job.result = result
            job.after_stats = after_stats
            job.audit_updated = audit_updated

    def _governance_job_log(self, job_id: str, text: str, kind: str = "log") -> None:
        with self.lock:
            job = self.governance_jobs.get(job_id)
            if job is None:
                return
            job.seq += 1
            logs = job.logs if job.logs is not None else []
            logs.append(
                {
                    "seq": job.seq,
                    "time": time.strftime("%H:%M:%S"),
                    "kind": kind,
                    "text": text if kind == "raw" else text.rstrip(),
                }
            )
            job.logs = logs

    def _governance_file_href(self, path: Path) -> str:
        try:
            rel_path = str(path.resolve().relative_to(self.root.resolve()))
        except ValueError:
            return ""
        return f"/governance/source?{urlencode({'path': rel_path})}"

    def _governance_stats(self) -> dict[str, Any]:
        registry = self.root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
        try:
            data = json.loads(registry.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        stats = data.get("stats")
        return stats if isinstance(stats, dict) else {}

    def _governance_agent_shell_env(self) -> dict[str, str]:
        env = env_with_node_path()
        path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part]
        try:
            agents = list_governance_agents().get("agents", [])
        except Exception:
            agents = []
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            command = str(agent.get("command") or "").strip()
            if not command:
                continue
            try:
                executable = shlex.split(command)[0]
            except (IndexError, ValueError):
                continue
            exe_path = Path(executable).expanduser()
            if exe_path.is_file():
                folder = str(exe_path.parent)
                if folder not in path_parts:
                    path_parts.insert(0, folder)
        env["PATH"] = os.pathsep.join(path_parts)
        return env

    def _port_is_open(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return True
        except OSError:
            return False

    def _wait_for_port(self, port: int, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._port_is_open(port):
                return True
            time.sleep(0.25)
        return False

    def _start_game(self) -> tuple[bool, str]:
        if self.game_process is not None and self.game_process.poll() is None:
            return True, "Game server is already running."
        self.game_url = ""
        self.game_process = self._start_process(
            "Game server",
            self._dev_argv("game", "start"),
            exclusive=False,
        )
        if self.game_process is None:
            return False, "Failed to start game server."
        return True, "started"

    def _stop_game(self) -> tuple[bool, str]:
        if self.game_process is not None and self.game_process.poll() is None:
            self.add_log("Stopping tracked game process ...", "cmd")
            with self.lock:
                self.stopping_game_pids.add(self.game_process.pid)
            self._terminate_process_group(self.game_process)
            self.game_process = None
        proc = self._start_process("Stop game", self._dev_argv("game", "stop"), exclusive=False)
        self.game_url = ""
        if proc is None:
            return False, "Failed to stop game server."
        return True, "started"

    def _open_dev_entry(self, kind: str, value: str, *, with_debugger: bool = False) -> tuple[bool, str]:
        entry_kind = kind.strip()
        entry_value = value.strip()
        if entry_kind not in {"scene", "narrative", "debug"}:
            return False, f"Unknown dev entry kind: {kind}"
        if not entry_value:
            return False, "Missing dev entry value."

        # 叙事调试器要先起来监听，游戏那边才连得上（连不上会退避重连，但先起省得等）
        if with_debugger or entry_kind == "debug":
            self._launch_narrative_debugger()

        ok, message = self._start_game()
        if not ok:
            return ok, message

        params = {"mode": "dev"}
        if entry_kind == "narrative":
            params["narrativeWarp"] = entry_value
        elif entry_kind == "scene":
            params["devScene"] = entry_value
        # 策划不该记得往地址后面加参数——勾了就自动带上
        if with_debugger or entry_kind == "debug":
            params["ndbg"] = "1"

        label = entry_value if entry_kind != "debug" else "边玩边调"
        self.add_log(f"Opening dev {entry_kind}: {label}", "cmd")
        threading.Thread(target=self._open_game_url_when_ready, args=(params,), daemon=True).start()
        return True, "opening"

    def _launch_narrative_debugger(self) -> None:
        """起叙事调试器窗口。走与其它工具同一条 launch 路径（非独占，不挡别的任务）。

        已经开着再点一次也无妨：端口被占时它自己会弹提示让人换端口。
        """
        ok, message = self.launch_tool("narrative-debugger")
        if ok:
            self.add_log("叙事调试器已启动（游戏连上后顶栏那个点会变绿）", "cmd")
        else:
            self.add_log(f"叙事调试器启动失败：{message}", "err")

    def _cancel_active(self) -> tuple[bool, str]:
        with self.lock:
            proc = self.active_process
            title = self.active_title
        if proc is None or proc.poll() is not None:
            return False, "没有正在执行的一次性任务。"
        self.add_log(f"Stopping {title} ...", "cmd")
        self._terminate_process_group(proc)
        return True, "stopping"

    def _run_exclusive(
        self,
        title: str,
        argv: list[str],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> tuple[bool, str]:
        with self.lock:
            if self.active_process is not None and self.active_process.poll() is None:
                return False, f"{self.active_title} 正在执行。"
        proc = self._start_process(title, argv, cwd=cwd, env=env, exclusive=True)
        if proc is None:
            return False, f"{title} 启动失败。"
        with self.lock:
            self.active_process = proc
            self.active_title = title
        return True, "started"

    def _start_process(
        self,
        title: str,
        argv: list[str],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        *,
        exclusive: bool,
    ) -> subprocess.Popen[str] | None:
        self.add_log(f"$ {title}: {' '.join(argv)}", "cmd")
        kwargs: dict[str, Any] = {
            "cwd": str(cwd or self.root),
            "env": env or os.environ.copy(),
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "bufsize": 1,
        }
        if self.is_windows:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        try:
            proc = subprocess.Popen(argv, **kwargs)
        except OSError as exc:
            self.add_log(f"{title} failed to start: {exc}", "err")
            return None
        threading.Thread(target=self._watch_process, args=(title, proc, exclusive), daemon=True).start()
        return proc

    def _watch_process(self, title: str, proc: subprocess.Popen[str], exclusive: bool) -> None:
        if proc.stdout is not None:
            for line in proc.stdout:
                if proc is self.game_process:
                    self._record_game_url_from_line(line)
                self.add_log(line)
        code = proc.wait()
        with self.lock:
            expected_game_stop = proc.pid in self.stopping_game_pids
            if expected_game_stop:
                self.stopping_game_pids.discard(proc.pid)
            if exclusive and proc is self.active_process:
                self.active_process = None
                self.active_title = ""
            if proc is self.game_process:
                self.game_process = None
                self.game_url = ""
            for task, tracked in list(self.tool_processes.items()):
                if tracked is proc:
                    del self.tool_processes[task]
        if expected_game_stop:
            self.add_log(f"{title} stopped.", "ok")
        else:
            self.add_log(f"{title} finished with exit code {code}.", "ok" if code == 0 else "err")

    def stop_children_on_exit(self) -> None:
        """控制台退出：回收游戏服务、治理 shell，**以及本控制台拉起的所有工具**。

        工具走礼貌关闭（WM_CLOSE / SIGTERM），编辑器有未保存改动会自己弹确认；
        不回收它们就是 2026-09-09 那种"旧代码孤儿进程接着往现网写"的事故源。
        """
        with self.lock:
            shell_proc = self.governance_shell_process
            tools = [(task, proc) for task, proc in self.tool_processes.items() if proc.poll() is None]
        for task, proc in tools:
            self.add_log(f"控制台退出，请求关闭「{TOOL_LABELS.get(task, task)}」（PID {proc.pid}）", "cmd")
            self._close_process_gracefully(proc.pid)
        if shell_proc is not None and shell_proc.poll() is None:
            self._terminate_process_group(shell_proc)
        if self.game_process is not None and self.game_process.poll() is None:
            self._terminate_process_group(self.game_process)
            try:
                subprocess.Popen(self._dev_argv("game", "stop"), cwd=str(self.root))
            except OSError as exc:
                self.add_log(f"Stop game on exit failed: {exc}", "err")

    def _terminate_process_group(self, proc: subprocess.Popen[str]) -> None:
        if self.is_windows:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    check=False,
                )
            except OSError as exc:
                self.add_log(f"Failed to terminate process tree {proc.pid}: {exc}", "err")
                return
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError:
            try:
                proc.terminate()
            except ProcessLookupError:
                return

    def _record_game_url_from_line(self, line: str) -> None:
        match = GAME_URL_RE.search(line)
        if not match:
            return
        with self.lock:
            self.game_url = match.group(0).rstrip("/") + "/"

    def _detect_game_url(self) -> str:
        with self.lock:
            if self.game_url:
                return self.game_url
        for port in GAME_SERVER_PORTS:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    url = f"http://localhost:{port}/"
                    with self.lock:
                        self.game_url = url
                    return url
            except OSError:
                continue
        return ""

    def _open_game_url_when_ready(self, params: dict[str, str], timeout: float = 25.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            base = self._detect_game_url()
            if base:
                url = self._build_game_url(params, base)
                # 游戏页开在专用预览窗（免手势音频、不后台降级、不缓存），不丢给系统浏览器——见 tools/dev/game_preview.py
                note = open_game_preview(url)
                self.add_log(f"Open URL: {url} → {note}", "ok")
                return
            time.sleep(0.25)
        url = self._build_game_url(params)
        note = open_game_preview(url)
        self.add_log(f"Game URL not detected; opening fallback: {url} → {note}", "err")

    def _build_game_url(self, params: dict[str, str], base_url: str = DEFAULT_GAME_URL) -> str:
        parts = urlsplit(base_url or DEFAULT_GAME_URL)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query.update({key: value for key, value in params.items() if value})
        path = parts.path or "/"
        return urlunsplit((parts.scheme, parts.netloc, path, urlencode(query), parts.fragment))


STATE = ConsoleState()


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "GameDraftConsole/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(INDEX_HTML)
            return
        if parsed.path in {"/governance", GOVERNANCE_PATH, "/governance/dashboard.html"}:
            query = parse_qs(parsed.query)
            dashboard_path = STATE.governance_dashboard_path()
            skip_refresh = query.get("fresh", [""])[0] == "1"
            if not skip_refresh or not dashboard_path.exists():
                ok, message = STATE.refresh_governance_dashboard()
                if not ok:
                    self._send_html(_error_html("治理页生成失败", message), HTTPStatus.INTERNAL_SERVER_ERROR)
                    return
            try:
                html = dashboard_path.read_text(encoding="utf-8")
            except OSError as exc:
                self._send_html(_error_html("治理页读取失败", str(exc)), HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._send_html(html)
            return
        if parsed.path == "/governance/source":
            query = parse_qs(parsed.query)
            rel_path = query.get("path", [""])[0]
            try:
                line = int(query.get("line", ["0"])[0] or "0")
            except ValueError:
                line = 0
            self._send_html(_source_html(STATE.root, rel_path, line))
            return
        if parsed.path.startswith(GOVERNANCE_PATH):
            file_name = parsed.path.removeprefix(GOVERNANCE_PATH).strip("/")
            if file_name in GOVERNANCE_OUT_MIME:
                out_path = STATE.root / "tools" / "skill_workflow_governance" / "out" / file_name
                self._send_file(out_path, GOVERNANCE_OUT_MIME[file_name])
                return
        if parsed.path == "/api/state":
            since = int(parse_qs(parsed.query).get("since", ["0"])[0] or "0")
            self._send_json(STATE.snapshot_with_tools(since))
            return
        if parsed.path == "/api/governance/agents":
            self._send_json(list_governance_agents())
            return
        if parsed.path == "/api/governance/hub":
            self._send_json(STATE.governance_hub_snapshot())
            return
        if parsed.path == "/api/governance/mcp":
            response = STATE.refresh_governance_mcp_status()
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/governance/job":
            query = parse_qs(parsed.query)
            job_id = query.get("id", [""])[0]
            try:
                since = int(query.get("since", ["0"])[0] or "0")
            except ValueError:
                since = 0
            response = STATE.governance_job_snapshot(job_id, since)
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.NOT_FOUND)
            return
        if parsed.path == "/api/governance/shell":
            response = STATE.ensure_governance_agent_shell()
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        payload = self._read_json()
        if parsed.path == "/api/action":
            ok, message = STATE.run_action(str(payload.get("action") or ""), payload)
            self._send_json({"ok": ok, "message": message}, HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/tool":
            task = str(payload.get("task") or "")
            ok, message = STATE.launch_tool(task)
            response: dict[str, Any] = {"ok": ok, "message": message}
            if ok and task == "skill-governance":
                response["url"] = f"{GOVERNANCE_PATH}?fresh=1"
            self._send_json(response, HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/governance/chat":
            response = STATE.ask_governance_agent(payload)
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/governance/run":
            response = STATE.start_governance_agent_job(payload)
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/governance/apps":
            response = STATE.update_governance_apps(payload)
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/api/governance/context":
            response = STATE.create_governance_context(payload)
            self._send_json(response, HTTPStatus.OK if response.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _send_json(self, data: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            body = path.read_bytes()
        except OSError as exc:
            self._send_html(_error_html("文件读取失败", str(exc)), HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _error_html(title: str, message: str) -> str:
    safe_title = html.escape(title)
    safe_message = html.escape(message)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_title}</title>
<style>
body{{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}}
main{{max-width:760px;margin:0 auto;padding:32px 18px}}
a{{color:#2563eb}}
pre{{white-space:pre-wrap;background:#111827;color:#e5e7eb;border-radius:6px;padding:12px;overflow:auto}}
</style>
</head>
<body>
<main>
<h1>{safe_title}</h1>
<p><a href="/">返回 Console</a></p>
<pre>{safe_message}</pre>
</main>
</body>
</html>"""


def _source_html(root: Path, rel_path: str, focus_line: int = 0) -> str:
    safe_root = root.resolve()
    target = (safe_root / rel_path).resolve()
    try:
        target.relative_to(safe_root)
    except ValueError:
        return _error_html("路径不在项目内", rel_path)
    if not target.is_file():
        return _error_html("文件不存在", rel_path)
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return _error_html("文件读取失败", str(exc))

    rows: list[str] = []
    for index, line_text in enumerate(text.splitlines(), start=1):
        cls = "focus" if index == focus_line else ""
        rows.append(
            f'<tr id="L{index}" class="{cls}"><td class="line">{index}</td>'
            f"<td><code>{html.escape(line_text)}</code></td></tr>"
        )
    safe_path = html.escape(rel_path)
    body = "\n".join(rows)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_path}</title>
<style>
body{{margin:0;background:#f6f7f9;color:#111827;font:13px/1.45 Menlo,Consolas,monospace}}
header{{position:sticky;top:0;background:#fff;border-bottom:1px solid #d9dde5;padding:10px 14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
a{{color:#17634f;text-decoration:none}}
table{{border-collapse:collapse;width:100%;background:#fff}}
td{{vertical-align:top;border-bottom:1px solid #eef1f5;padding:0 10px}}
.line{{width:58px;text-align:right;color:#7b8190;background:#f0f2f5;user-select:none}}
.focus td{{background:#fff8db}}
code{{white-space:pre-wrap}}
</style>
</head>
<body>
<header><a href="/governance/">返回治理台</a> / {safe_path}</header>
<table>{body}</table>
</body>
</html>"""


def _display_command(command: list[str]) -> str:
    display: list[str] = []
    for part in command:
        if len(part) > 160:
            display.append(part[:80] + "..." + part[-40:])
        else:
            display.append(part)
    return " ".join(display)


def _free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free console port found.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gamedraft-console")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)

    port = _free_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), ConsoleHandler)
    atexit.register(STATE.stop_children_on_exit)
    url = f"http://127.0.0.1:{port}/"
    STATE.add_log(f"Console listening at {url}", "ok")
    threading.Thread(target=STATE.tool_scan_loop, name="tool-scan", daemon=True).start()
    print(url, flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        STATE.stop_game_on_exit()
    return 0


INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameDraft 控制台</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}
body{margin:0}
main{max-width:1180px;margin:0 auto;padding:18px}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}
h1{font-size:30px;line-height:1;margin:0}
#root{color:#6b7280;font-size:13px;word-break:break-all}
.grid{display:grid;grid-template-columns:minmax(280px,0.9fr) minmax(360px,1.2fr);gap:12px}
section{background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:12px}
h2{font-size:16px;margin:0 0 10px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
button{min-height:38px;border:1px solid #9ca3af;border-radius:5px;background:#f9fafb;color:#111827;font-size:14px;cursor:pointer}
button:hover{background:#eef2f7}
button:disabled{opacity:.55;cursor:not-allowed}
input{min-height:36px;border:1px solid #9ca3af;border-radius:5px;padding:0 10px;font-size:14px}
.sep{height:1px;background:#e5e7eb;margin:12px 0}
.tool{display:grid;grid-template-columns:1fr;gap:3px;margin-bottom:8px}
.note{font-size:12px;color:#6b7280}
.toolStatus{display:flex;align-items:center;gap:6px;font-size:12px;color:#065f46}
.toolStatus[hidden]{display:none}
.toolStatus.orphan{color:#b45309}
.toolStatus .toolStop{padding:2px 8px;font-size:12px}
.wide{margin-top:12px}
.shortcut-row{display:grid;grid-template-columns:52px minmax(0,1fr) 76px;gap:8px;align-items:center;margin-bottom:8px}
.debug-row{grid-template-columns:52px auto minmax(0,1fr)}
.inline-check{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.75;white-space:nowrap}
.hint{font-size:12px;opacity:.6;margin:2px 0 0}
label{font-size:13px;font-weight:700;color:#374151}
select{min-height:38px;border:1px solid #9ca3af;border-radius:5px;background:#f9fafb;color:#111827;font-size:14px;padding:0 10px;min-width:0}
.bar{display:flex;justify-content:space-between;align-items:center;margin:14px 0 6px}
#state{font-size:13px;color:#374151}
#log{height:270px;overflow:auto;background:#111827;color:#e5e7eb;border-radius:6px;padding:10px;font:12px Menlo,Consolas,monospace;white-space:pre-wrap}
.cmd{color:#93c5fd}.ok{color:#86efac}.err{color:#fca5a5}
@media(max-width:800px){.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}.shortcut-row{grid-template-columns:1fr}.shortcut-row button{width:100%}}
@media(prefers-color-scheme:dark){:root{background:#111827;color:#f9fafb}section{background:#1f2937;border-color:#374151}button{background:#111827;color:#f9fafb;border-color:#4b5563}button:hover{background:#273244}input,select{background:#111827;color:#f9fafb;border-color:#4b5563}.sep{background:#374151}#root,.note,#state{color:#9ca3af}label{color:#d1d5db}}
</style>
</head>
<body>
<main>
<header><h1>GameDraft 控制台</h1><div id="root"></div></header>
<div class="grid">
<section>
<h2>版本与运行</h2>
<div class="two">
<button data-action="pull" data-exclusive="1">Pull</button>
<button data-action="push" data-exclusive="1">Push</button>
<input id="commitMessage" placeholder="提交说明">
<button id="commitBtn" data-exclusive="1">Commit</button>
</div>
<div class="sep"></div>
<div class="two">
<button data-action="start_game" data-game-start="1">启动游戏</button>
<button data-action="stop_game">停止游戏</button>
<button data-action="build" data-exclusive="1">Build</button>
<button data-action="test" data-exclusive="1">Test</button>
</div>
<div class="sep"></div>
<div class="two">
<button data-action="install_deps" data-exclusive="1">安装依赖</button>
<button data-action="cancel_active">停止当前任务</button>
<button data-action="git_status" data-exclusive="1">Git 状态</button>
<button data-action="init_runtime" data-exclusive="1">拉运行资源</button>
<button data-action="init_editor" data-exclusive="1">拉编辑器资源</button>
</div>
</section>
<section>
<h2>编辑器与工具</h2>
<div class="two" id="tools"></div>
</section>
</div>
<section class="wide">
<h2>Dev 快捷入口</h2>
<div class="shortcut-row">
<label for="devSceneSelect">场景</label>
<select id="devSceneSelect"></select>
<button id="openDevScene">打开</button>
</div>
<div class="shortcut-row">
<label for="devNarrativeSelect">叙事</label>
<select id="devNarrativeSelect"></select>
<button id="openDevNarrative">打开</button>
</div>
<div class="shortcut-row debug-row">
<label>边玩边调</label>
<button id="openPlayWithDebugger">开调试器 + 开游戏</button>
<label class="inline-check"><input type="checkbox" id="devWithDebugger"> 上面两个入口也带上调试器</label>
</div>
<p class="hint">叙事调试器＝边玩边看：戏走到哪、这一拍在等你做什么、刚才那一下系统认没认；可回到任意一拍重看。</p>
</section>
<div class="bar"><strong>日志</strong><span id="mcpState"></span><span id="state"></span><button id="clearLog">清空</button></div>
<div id="log"></div>
</main>
<script>
const tools = %TOOLS_JSON%;
const devShortcuts = %DEV_SHORTCUTS_JSON%;
const logEl = document.querySelector("#log");
const rootEl = document.querySelector("#root");
const stateEl = document.querySelector("#state");
const mcpStateEl = document.querySelector("#mcpState");
let seq = 0;

function append(entry){
  const div = document.createElement("div");
  div.className = entry.kind || "log";
  div.textContent = `[${entry.time}] ${entry.text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
async function post(url, body){
  try{
    const r = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const data = await r.json().catch(()=>({message:r.statusText}));
    const result = data && typeof data === "object" ? data : {message:r.statusText};
    if(!r.ok || result.ok === false){
      append({time:new Date().toLocaleTimeString(),kind:"err",text:result.message || r.statusText});
    }
    return {...result, ok:r.ok && result.ok !== false};
  }catch(err){
    const message = err && err.message ? err.message : String(err);
    append({time:new Date().toLocaleTimeString(),kind:"err",text:message});
    return {ok:false,message};
  }
}
async function poll(){
  const data = await fetch(`/api/state?since=${seq}`).then(r=>r.json());
  rootEl.textContent = data.root;
  stateEl.textContent = data.active ? `运行中: ${data.activeTitle}` : (data.gameRunning ? `游戏服务运行中 ${data.gameUrl || ""}` : "空闲");
  const mcp = data.governanceMcp || {};
  mcpStateEl.textContent = mcp.status ? `MCP: ${mcp.status}${mcp.resourceCount ? " · " + mcp.resourceCount + " resources" : ""}` : "";
  for(const entry of data.logs){ append(entry); seq = Math.max(seq, entry.seq); }
  renderToolStatus(data.tools);
  document.querySelectorAll("button[data-action],#commitBtn").forEach(btn=>{
    if(btn.dataset.gameStart === "1"){
      btn.disabled = data.gameRunning;
    }else if(btn.dataset.exclusive === "1"){
      btn.disabled = data.active;
    }else{
      btn.disabled = false;
    }
  });
}
document.querySelectorAll("button[data-action]").forEach(btn=>{
  btn.addEventListener("click",()=>post("/api/action",{action:btn.dataset.action}));
});
document.querySelector("#commitBtn").addEventListener("click",()=>{
  post("/api/action",{action:"commit",message:document.querySelector("#commitMessage").value});
});
document.querySelector("#clearLog").addEventListener("click",()=>{logEl.innerHTML=""});
const toolsEl = document.querySelector("#tools");
const toolStatusEls = {};
for(const tool of tools){
  const wrap = document.createElement("div");
  wrap.className = "tool";
  const btn = document.createElement("button");
  btn.textContent = tool.label;
  btn.addEventListener("click",async ()=>{
    if(tool.task === "skill-governance"){
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "治理生成中...";
      append({time:new Date().toLocaleTimeString(),kind:"cmd",text:"Skill/Workflow 治理：运行 audit"});
      const data = await post("/api/tool",{task:tool.task});
      if(data.ok){
        window.location.href = data.url || "/governance/?fresh=1";
        return;
      }
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }
    post("/api/tool",{task:tool.task});
  });
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = tool.note;
  // 运行状态行：本控制台启动的 / 上一个控制台留下的孤儿（旧代码在跑，保存会覆盖现网数据）
  const status = document.createElement("div");
  status.className = "toolStatus";
  status.hidden = true;
  const statusText = document.createElement("span");
  const stopBtn = document.createElement("button");
  stopBtn.className = "toolStop";
  stopBtn.textContent = "结束";
  stopBtn.title = "请它自己关闭（有未保存改动会弹确认），不是强杀";
  stopBtn.addEventListener("click",()=>post("/api/action",{action:"stop_tool",task:tool.task}));
  status.append(statusText, stopBtn);
  toolStatusEls[tool.task] = {status, statusText, launchBtn: btn};
  wrap.append(btn,status,note);
  toolsEl.appendChild(wrap);
}
function renderToolStatus(toolsState){
  for(const [task, els] of Object.entries(toolStatusEls)){
    const st = toolsState && toolsState[task];
    if(!st || !st.running){
      els.status.hidden = true;
      els.status.classList.remove("orphan");
      els.launchBtn.title = "";
      continue;
    }
    els.status.hidden = false;
    els.status.classList.toggle("orphan", !st.owned);
    els.statusText.textContent = st.owned
      ? `运行中 · PID ${st.pid}`
      : `⚠ 上一个控制台留下的实例在跑 · PID ${st.pid}${st.started ? " · 起于 " + st.started : ""}${st.count > 1 ? " 等 " + st.count + " 个" : ""}（旧代码，保存会覆盖现网数据）`;
    els.launchBtn.title = st.owned ? "已在运行；再点会被拒绝" : "有旧实例在跑；先「结束」再启动";
  }
}
function fillDevSelect(select, items){
  for(const item of items){
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.note ? `${item.label} · ${item.note}` : item.label;
    select.appendChild(option);
  }
}
const devSceneSelect = document.querySelector("#devSceneSelect");
const devNarrativeSelect = document.querySelector("#devNarrativeSelect");
fillDevSelect(devSceneSelect, devShortcuts.scenes || []);
fillDevSelect(devNarrativeSelect, devShortcuts.narrative || []);
document.querySelector("#openDevScene").disabled = devSceneSelect.options.length === 0;
document.querySelector("#openDevNarrative").disabled = devNarrativeSelect.options.length === 0;
const devWithDebugger = document.querySelector("#devWithDebugger");
document.querySelector("#openDevScene").addEventListener("click",()=>{
  post("/api/action",{action:"open_dev_entry",kind:"scene",value:devSceneSelect.value,
                      debugger:devWithDebugger.checked?"1":""});
});
document.querySelector("#openDevNarrative").addEventListener("click",()=>{
  post("/api/action",{action:"open_dev_entry",kind:"narrative",value:devNarrativeSelect.value,
                      debugger:devWithDebugger.checked?"1":""});
});
document.querySelector("#openPlayWithDebugger").addEventListener("click",()=>{
  post("/api/action",{action:"open_dev_entry",kind:"debug",value:"1",debugger:"1"});
});
setInterval(poll, 800);
poll();
</script>
</body>
</html>
""".replace(
    "%TOOLS_JSON%",
    json.dumps([tool.__dict__ for tool in TOOLS], ensure_ascii=False),
).replace(
    "%DEV_SHORTCUTS_JSON%",
    json.dumps(DEV_SHORTCUTS, ensure_ascii=False),
)


if __name__ == "__main__":
    raise SystemExit(main())
