from __future__ import annotations

import json
import hashlib
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from tkinter import END, LEFT, RIGHT, TOP, X, Y, BOTH, StringVar, filedialog, messagebox, Canvas
from tkinter import Tk, Text, Toplevel
from tkinter import ttk


ROOT = Path(__file__).resolve().parents[2]
PYTHON = ROOT / ".tools" / "Python311" / "python.exe"
PY = str(PYTHON if PYTHON.exists() else sys.executable)
LOG_DIR = ROOT / "logs"
GUI_VERSION = "unified-reference-v9"

REFERENCE_KINDS = (
    "Signal Flow",
    "Flag Read/Write",
    "Quest Dependency",
    "Dialogue Graphs",
    "Runtime Trace Timeline",
)

ADVANCED_COMMANDS = (
    "content:render",
    "content:runtime-compatibility",
    "content:lsp-smoke",
    "content:simulate summary",
    "content:simulate case...",
    "content:explain summary",
    "content:explain case...",
    "content:trace-resolve file...",
    "新建 dialogue YAML 模板...",
    "新建 narrative YAML 模板...",
    "新建 quest YAML 模板...",
    "content:check",
    "project:test",
    "project:build",
    "narrative-editor:build",
    "vscode-extension:compile",
)

KIND_ROOTS = {
    "dialogue": ROOT / "authoring" / "dialogues",
    "narrative": ROOT / "authoring" / "narrative",
    "quest": ROOT / "authoring" / "quests",
}

TEMPLATE_OPTIONS = {
    "dialogue": (
        ("basic", "基础对话：一句话后结束"),
        ("choice", "选项对话：一句话 + 两个选项"),
        ("actions", "动作对话：一句话 + runActions"),
    ),
    "narrative": (
        ("basic", "基础状态机：start"),
        ("signal", "信号切状态：start -> done"),
        ("on_enter", "进入状态时执行 actions"),
    ),
    "quest": (
        ("basic", "基础任务：空条件 / 奖励"),
        ("conditions", "条件任务：带条件占位"),
        ("chain", "后续任务：带 nextQuests 占位"),
    ),
}


def open_path(path: Path) -> None:
    target = path if path.is_absolute() else ROOT / path
    if not target.exists():
        messagebox.showwarning("路径不存在", str(target))
        return
    if os.name == "nt":
        os.startfile(str(target))  # type: ignore[attr-defined]
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    subprocess.Popen([opener, str(target)], cwd=str(ROOT))


def open_logs_dir() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    open_path(LOG_DIR)


def is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def safe_filename(value: str) -> str:
    cleaned = "".join(ch if ch not in '<>:"/\\|?*' else "_" for ch in value.strip())
    cleaned = "_".join(cleaned.split())
    return cleaned or "new_graph"


def safe_log_slug(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_.-]+", "_", value.strip())
    return cleaned.strip("._-") or "planner"


def log_path_for_title(title: str, stamp: str | None = None) -> Path:
    stamp = stamp or datetime.now().strftime("%Y%m%d-%H%M%S")
    return LOG_DIR / f"planner-gui-{stamp}-{safe_log_slug(title)}.log"


def generated_id_from_name(name: str, prefix: str = "graph") -> str:
    cleaned = safe_filename(name).strip("._-").lower()
    cleaned = re.sub(r"[^0-9a-z_.-]+", "_", cleaned).strip("._-")
    if cleaned:
        return cleaned
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return f"{prefix}_{digest}"


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def read_yaml_id(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            stripped = line.strip()
            if not stripped.startswith("id:"):
                continue
            raw = stripped.partition(":")[2].strip()
            if not raw:
                return ""
            try:
                parsed = json.loads(raw)
                return str(parsed)
            except Exception:
                return raw.strip("'\"")
    except Exception:
        return ""
    return ""


def existing_ids(kind: str) -> set[str]:
    root = KIND_ROOTS[kind]
    ids: set[str] = set()
    for path in root.glob("**/*.y*ml"):
        ident = read_yaml_id(path)
        if ident:
            ids.add(ident)
    return ids


def unique_id_for_name(kind: str, name: str) -> str:
    base = generated_id_from_name(name, kind)
    used = existing_ids(kind)
    if base not in used:
        return base
    index = 2
    while f"{base}_{index}" in used:
        index += 1
    return f"{base}_{index}"


def template_text(kind: str, ident: str, name: str, owner: str = "", template_key: str = "basic") -> str:
    if kind == "narrative":
        owner_type, _, owner_id = (owner or "system:").partition(":")
        head = (
            f"id: {yaml_string(ident)}\n"
            "kind: narrativeGraph\n"
            f"title: {yaml_string(name)}\n"
            "owner:\n"
            f"  type: {yaml_string(owner_type or 'system')}\n"
            f"  id: {yaml_string(owner_id or ident)}\n"
        )
        if template_key == "signal":
            return head + (
                "initialState: start\n"
                "states:\n"
                "  start:\n"
                "    label: 起始\n"
                "  done:\n"
                "    label: 完成\n"
                "transitions:\n"
                "  - id: t_done\n"
                "    from: start\n"
                "    to: done\n"
                "    signal: TODO.signal\n"
            )
        if template_key == "on_enter":
            return head + (
                "initialState: start\n"
                "states:\n"
                "  start:\n"
                "    label: 起始\n"
                "  active:\n"
                "    label: 生效\n"
                "    onEnterActions:\n"
                "      - type: showNotification\n"
                "        params:\n"
                "          text: TODO\n"
                "          type: info\n"
                "transitions: []\n"
            )
        return head + (
            "initialState: start\n"
            "states:\n"
            "  start:\n"
            "    label: 起始\n"
            "transitions: []\n"
        )
    if kind == "quest":
        head = f"id: {yaml_string(ident)}\n" f"title: {yaml_string(name)}\n"
        if template_key == "conditions":
            return head + (
                "preconditions:\n"
                "  - flag: TODO.flag\n"
                "    equals: true\n"
                "completionConditions:\n"
                "  - narrative: TODO.graph\n"
                "    state: TODO_state\n"
                "acceptActions: []\n"
                "rewards: []\n"
                "nextQuests: []\n"
            )
        if template_key == "chain":
            return head + (
                "preconditions: []\n"
                "completionConditions: []\n"
                "acceptActions: []\n"
                "rewards: []\n"
                "nextQuests:\n"
                "  - questId: TODO.next_quest\n"
                "    conditions: []\n"
            )
        return head + "preconditions: []\ncompletionConditions: []\nacceptActions: []\nrewards: []\nnextQuests: []\n"
    if kind == "dialogue":
        head = (
            f"id: {yaml_string(ident)}\n"
            "kind: dialogueGraph\n"
            "meta:\n"
            f"  title: {yaml_string(name)}\n"
            "entry: start\n"
        )
        if template_key == "choice":
            return head + (
                "nodes:\n"
                "  start:\n"
                "    type: line\n"
                "    speaker:\n"
                "      kind: literal\n"
                "      name: 旁白\n"
                "    text: TODO\n"
                "    next: choose\n"
                "  choose:\n"
                "    type: choice\n"
                "    options:\n"
                "      - id: option_a\n"
                "        text: 选项 A\n"
                "        next: end\n"
                "      - id: option_b\n"
                "        text: 选项 B\n"
                "        next: end\n"
                "  end:\n"
                "    type: end\n"
            )
        if template_key == "actions":
            return head + (
                "nodes:\n"
                "  start:\n"
                "    type: line\n"
                "    speaker:\n"
                "      kind: literal\n"
                "      name: 旁白\n"
                "    text: TODO\n"
                "    next: actions\n"
                "  actions:\n"
                "    type: runActions\n"
                "    actions:\n"
                "      - type: showNotification\n"
                "        params:\n"
                "          text: TODO\n"
                "          type: info\n"
                "    next: end\n"
                "  end:\n"
                "    type: end\n"
            )
        return head + (
            "nodes:\n"
            "  start:\n"
            "    type: line\n"
            "    speaker:\n"
            "      kind: literal\n"
            "      name: 旁白\n"
            "    text: ''\n"
            "    next: end\n"
            "  end:\n"
            "    type: end\n"
        )
    raise ValueError(f"unknown template kind: {kind}")


def content_command(cmd: list[str]) -> str:
    for i, part in enumerate(cmd):
        if part == "-m" and i + 2 < len(cmd) and cmd[i + 1] == "tools.content_pipeline":
            return cmd[i + 2]
    return ""


def extract_json(text: str) -> object | None:
    start = text.find("{")
    if start < 0:
        start = text.find("[")
    if start < 0:
        return None
    try:
        payload, _ = json.JSONDecoder().raw_decode(text[start:])
        return payload
    except Exception:
        return None


def count_by(items: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in items:
        value = str(item.get(key, ""))
        out[value] = out.get(value, 0) + 1
    return out


def short_value(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def summarize_diff(diff: object) -> list[str]:
    if not isinstance(diff, dict) or not diff:
        return ["状态变化：无"]
    lines = ["状态变化："]
    for bucket in ("inventory", "flags", "quests", "narrative", "scenarios", "scene"):
        changes = diff.get(bucket)
        if not isinstance(changes, list) or not changes:
            continue
        for item in changes:
            if not isinstance(item, dict):
                continue
            ident = short_value(item.get("id"))
            before = item.get("before")
            after = item.get("after")
            if "before" in item:
                lines.append(f"  - {bucket}.{ident}: {short_value(before)} -> {short_value(after)}")
            else:
                lines.append(f"  - {bucket}.{ident}: {short_value(after)}")
    return lines if len(lines) > 1 else ["状态变化：无"]


def summarize_conditions(conditions: object) -> list[str]:
    if not isinstance(conditions, list) or not conditions:
        return ["条件检查：无"]
    total = len(conditions)
    passed = sum(1 for item in conditions if isinstance(item, dict) and item.get("result") is True)
    failed = sum(1 for item in conditions if isinstance(item, dict) and item.get("result") is False)
    lines = [f"条件检查：{total} 次，{passed} 通过，{failed} 未通过"]
    seen: set[str] = set()
    collapsed: list[str] = []
    for item in conditions:
        if not isinstance(item, dict) or item.get("result") is not False:
            continue
        ref = str(item.get("runtimeRef") or "")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        collapsed.append(ref)
    for ref in collapsed[:4]:
        lines.append(f"  - 未通过：{ref}")
    if len(collapsed) > 4:
        lines.append(f"  - 还有 {len(collapsed) - 4} 个未通过条件已折叠")
    return lines


def summarize_simulation(data: object) -> str:
    if not isinstance(data, dict):
        return "模拟结果：无法解析输出，详见日志。\n"
    lines: list[str] = []
    ok = data.get("ok") is True
    lines.append(f"模拟结果：{'成功' if ok else '失败'}")
    sim = data.get("input", {}).get("simulate", {}) if isinstance(data.get("input"), dict) else {}
    if isinstance(sim, dict):
        graph_id = sim.get("graphId")
        entry = sim.get("entry")
        if graph_id:
            lines.append(f"目标 Graph：{graph_id} / entry={entry or '默认'}")
        choices = sim.get("choices")
        if isinstance(choices, dict) and choices:
            pretty_choices = ", ".join(f"{k}={v}" for k, v in choices.items())
            lines.append(f"选择：{pretty_choices}")
    blocked = data.get("blocked")
    if isinstance(blocked, list) and blocked:
        lines.append(f"阻断：{len(blocked)} 处，需要处理")
        for item in blocked[:5]:
            lines.append(f"  - {short_value(item)}")
    else:
        lines.append("阻断：无")
    route = data.get("route")
    if isinstance(route, list) and route:
        route_text = " -> ".join(
            f"{item.get('nodeId')}({item.get('type')})"
            for item in route
            if isinstance(item, dict)
        )
        lines.append(f"路线：{route_text}")
    lines.extend(summarize_diff(data.get("diff")))
    events = [item for item in data.get("events", []) if isinstance(item, dict)] if isinstance(data.get("events"), list) else []
    if events:
        type_counts = count_by(events, "type")
        event_summary = ", ".join(f"{key} {value}" for key, value in sorted(type_counts.items()))
        lines.append(f"事件：{len(events)} 条（{event_summary}）")
    lines.extend(summarize_conditions(data.get("conditions")))
    diagnostics = [item for item in data.get("diagnostics", []) if isinstance(item, dict)] if isinstance(data.get("diagnostics"), list) else []
    errors = sum(1 for item in diagnostics if item.get("severity") == "error")
    warnings = sum(1 for item in diagnostics if item.get("severity") == "warning")
    lines.append(f"诊断：{errors} error，{warnings} warning")
    lines.append("详情：artifact/content_pipeline/simulation_result.json")
    return "\n".join(lines) + "\n"


def summarize_diagnostics_output(data: object) -> str:
    diagnostics = data.get("diagnostics") if isinstance(data, dict) else data
    if not isinstance(diagnostics, list):
        return "诊断结果：无法解析输出，详见 artifact/content_pipeline/diagnostics.json\n"
    errors = [item for item in diagnostics if isinstance(item, dict) and item.get("severity") == "error"]
    warnings = [item for item in diagnostics if isinstance(item, dict) and item.get("severity") == "warning"]
    lines = [f"诊断结果：{len(errors)} error，{len(warnings)} warning"]
    for item in (errors + warnings)[:8]:
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        lines.append(
            f"  - {item.get('severity')} {item.get('code')} "
            f"{source.get('file', '')}:{source.get('line', '')} {item.get('message', '')}"
        )
    if len(errors) + len(warnings) > 8:
        lines.append(f"  - 还有 {len(errors) + len(warnings) - 8} 条已折叠，见问题列表")
    lines.append("详情：artifact/content_pipeline/diagnostics.json")
    return "\n".join(lines) + "\n"


def summarize_runtime_output(data: object) -> str:
    if not isinstance(data, dict):
        return "Runtime 兼容性：无法解析输出。\n"
    ok = data.get("ok") is True
    issues = data.get("issues") if isinstance(data.get("issues"), list) else []
    lines = [f"Runtime 兼容性：{'通过' if ok else '未通过'}，{len(issues)} issue"]
    for item in issues[:8]:
        if isinstance(item, dict):
            lines.append(f"  - {item.get('severity')} {item.get('code')} {item.get('message')}")
    lines.append("详情：artifact/content_pipeline/runtime_compatibility.json")
    return "\n".join(lines) + "\n"


def summarize_explain_output(data: object) -> str:
    conditions = data.get("conditions") if isinstance(data, dict) else None
    if not isinstance(conditions, list):
        return "条件解释：无法解析输出。\n"
    lines = ["条件解释："]
    lines.extend(summarize_conditions(conditions))
    lines.append("详情可从命令执行 content:explain case... 重新生成。")
    return "\n".join(lines) + "\n"


def summarize_content_output(command: str, text: str) -> str | None:
    if command not in {"simulate", "diagnostics-json", "runtime-compatibility", "explain"}:
        return None
    data = extract_json(text)
    if command == "simulate":
        return summarize_simulation(data)
    if command == "diagnostics-json":
        return summarize_diagnostics_output(data)
    if command == "runtime-compatibility":
        return summarize_runtime_output(data)
    if command == "explain":
        return summarize_explain_output(data)
    return None


def role_count(rec: dict, role: str) -> int:
    values = rec.get(role)
    return len(values) if isinstance(values, list) else 0


def source_line(item: object) -> str:
    if not isinstance(item, dict):
        return short_value(item)
    file = str(item.get("file", ""))
    line = item.get("line", "")
    column = item.get("column", "")
    symbol = str(item.get("symbol", ""))
    path = str(item.get("path", ""))
    pieces = [p for p in (symbol, path) if p]
    loc = f"{file}:{line}:{column}" if file else ""
    return " | ".join([p for p in (loc, *pieces) if p])


def reference_rows(kind: str, index: object, simulation: object) -> list[tuple[str, str, str, str]]:
    rows: list[tuple[str, str, str, str]] = []
    if kind == "Runtime Trace Timeline":
        if not isinstance(simulation, dict):
            return rows
        for i, raw in enumerate(simulation.get("events", []) if isinstance(simulation.get("events"), list) else []):
            if not isinstance(raw, dict):
                continue
            source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
            summary = source_line(source)
            label = f"{raw.get('type', '')}:{raw.get('phase', '')} {raw.get('label', '')}".strip()
            details = json.dumps(raw, ensure_ascii=False, indent=2)
            rows.append((str(i + 1), label, summary, details))
        return rows
    if not isinstance(index, dict):
        return rows
    bucket_name = {
        "Signal Flow": "signals",
        "Flag Read/Write": "flags",
        "Quest Dependency": "quests",
        "Dialogue Graphs": "dialogueGraphs",
    }.get(kind)
    bucket = index.get(bucket_name or "")
    if not isinstance(bucket, dict):
        return rows
    for ident, raw in sorted(bucket.items(), key=lambda item: str(item[0])):
        rec = raw if isinstance(raw, dict) else {}
        if kind == "Signal Flow":
            summary = f"emit {role_count(rec, 'emitters')} / listen {role_count(rec, 'listeners')} / read {role_count(rec, 'readers')}"
        elif kind == "Flag Read/Write":
            value_type = ""
            declared = rec.get("declaredAt")
            if isinstance(declared, list) and declared and isinstance(declared[0], dict):
                value_type = str(declared[0].get("valueType", ""))
            summary = f"type {value_type or '?'} / read {role_count(rec, 'readers')} / write {role_count(rec, 'writers')}"
        elif kind == "Quest Dependency":
            title = ""
            declared = rec.get("declaredAt")
            if isinstance(declared, list) and declared and isinstance(declared[0], dict):
                title = str(declared[0].get("title", ""))
            summary = f"{title or ident} / read {role_count(rec, 'readers')} / write {role_count(rec, 'writers')}"
        else:
            summary = f"declared {role_count(rec, 'declaredAt')} / read {role_count(rec, 'readers')}"
        detail_lines = [f"{kind}: {ident}", ""]
        for role in ("declaredAt", "emitters", "listeners", "readers", "writers"):
            values = rec.get(role)
            if not isinstance(values, list) or not values:
                continue
            detail_lines.append(f"{role}:")
            detail_lines.extend(f"- {source_line(item)}" for item in values)
            detail_lines.append("")
        rows.append((str(ident), str(ident), summary, "\n".join(detail_lines).strip()))
    return rows


class PlannerGui:
    def __init__(self) -> None:
        self.root = Tk()
        self.root.title(f"GameDraft Graph 工作台 ({GUI_VERSION})")
        self.root.geometry("1180x780")
        self.root.minsize(980, 680)

        self.queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.running = False
        self.command_buttons: list[ttk.Button] = []
        self.log_lines: list[str] = []
        self.current_log_path: Path | None = None
        self.last_command = StringVar(value="未运行")
        self.status_text = StringVar(value="待检查")
        self.diagnostic_text = StringVar(value="诊断：未刷新")
        self.runtime_text = StringVar(value="Runtime：未检查")
        self.simulation_text = StringVar(value="模拟：未运行")
        self.log_path_text = StringVar(value="日志：运行命令后自动保存到 logs 目录")
        self.advanced_command = StringVar(value=ADVANCED_COMMANDS[0])
        self.reference_kind = StringVar(value=REFERENCE_KINDS[0])
        self.reference_filter = StringVar()
        self.reference_details = ""
        self.reference_row_details: dict[str, str] = {}

        self._build_style()
        self._build_ui()
        self._refresh_summary_from_disk()
        self.root.after(80, self._drain_queue)

    def _build_style(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:
            pass
        self.root.configure(bg="#f6f2e8")
        style.configure("Root.TFrame", background="#f6f2e8")
        style.configure("Card.TFrame", background="#fffaf0", relief="flat")
        style.configure("Title.TLabel", background="#f6f2e8", foreground="#2d261b", font=("Microsoft YaHei UI", 18, "bold"))
        style.configure("Subtle.TLabel", background="#f6f2e8", foreground="#6c6255", font=("Microsoft YaHei UI", 9))
        style.configure("CardTitle.TLabel", background="#fffaf0", foreground="#2d261b", font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("CardText.TLabel", background="#fffaf0", foreground="#655b4e", font=("Microsoft YaHei UI", 9))
        style.configure("Status.TLabel", background="#fffaf0", foreground="#2d261b", font=("Microsoft YaHei UI", 10, "bold"))
        style.configure("Primary.TButton", font=("Microsoft YaHei UI", 10, "bold"), padding=(12, 8))
        style.configure("Tool.TButton", font=("Microsoft YaHei UI", 9), padding=(8, 5))
        style.configure("Treeview", rowheight=24, font=("Microsoft YaHei UI", 9))
        style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 9, "bold"))

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, style="Root.TFrame", padding=14)
        outer.pack(fill=BOTH, expand=True)

        header = ttk.Frame(outer, style="Root.TFrame")
        header.pack(side=TOP, fill=X, pady=(0, 12))
        ttk.Label(header, text="GameDraft Graph 工作台", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            header,
            text=f"日常只做三件事：检查、模拟、看结果。编辑内容仍然回到 VS Code/YAML。当前版本：{GUI_VERSION}",
            style="Subtle.TLabel",
        ).pack(anchor="w", pady=(4, 0))

        body = ttk.Frame(outer, style="Root.TFrame")
        body.pack(fill=BOTH, expand=True)

        left_shell = ttk.Frame(body, style="Root.TFrame", width=350)
        left_shell.pack(side=LEFT, fill=Y, padx=(0, 14))
        left_shell.pack_propagate(False)

        left_canvas = Canvas(left_shell, bg="#f6f2e8", highlightthickness=0, borderwidth=0)
        left_scroll = ttk.Scrollbar(left_shell, orient="vertical", command=left_canvas.yview)
        left_canvas.configure(yscrollcommand=left_scroll.set)
        left_canvas.pack(side=LEFT, fill=BOTH, expand=True)
        left_scroll.pack(side=RIGHT, fill=Y)

        left = ttk.Frame(left_canvas, style="Root.TFrame")
        left_window = left_canvas.create_window((0, 0), window=left, anchor="nw")

        def sync_left_scroll(_event=None) -> None:
            left_canvas.configure(scrollregion=left_canvas.bbox("all"))

        def sync_left_width(event) -> None:
            left_canvas.itemconfigure(left_window, width=event.width)

        def enable_mousewheel(_event=None) -> None:
            left_canvas.bind_all("<MouseWheel>", on_mousewheel)

        def disable_mousewheel(_event=None) -> None:
            left_canvas.unbind_all("<MouseWheel>")

        def on_mousewheel(event) -> None:
            left_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        left.bind("<Configure>", sync_left_scroll)
        left_canvas.bind("<Configure>", sync_left_width)
        left_canvas.bind("<Enter>", enable_mousewheel)
        left_canvas.bind("<Leave>", disable_mousewheel)

        right = ttk.Frame(body, style="Root.TFrame")
        right.pack(side=RIGHT, fill=BOTH, expand=True)

        self._build_workflow(left)
        self._build_openers(left)
        self._build_status(right)
        self._build_result_tabs(right)

    def _card(self, parent: ttk.Frame, title: str, note: str = "") -> ttk.Frame:
        box = ttk.Frame(parent, style="Card.TFrame", padding=12)
        box.pack(fill=X, pady=(0, 12))
        ttk.Label(box, text=title, style="CardTitle.TLabel").pack(anchor="w")
        if note:
            ttk.Label(box, text=note, style="CardText.TLabel", wraplength=280).pack(anchor="w", pady=(3, 8))
        return box

    def _command_button(self, parent: ttk.Frame, text: str, command, *, primary: bool = False) -> None:
        btn = ttk.Button(parent, text=text, command=command, style="Primary.TButton" if primary else "Tool.TButton")
        btn.pack(fill=X, pady=4)
        self.command_buttons.append(btn)

    def _build_workflow(self, parent: ttk.Frame) -> None:
        daily = self._card(parent, "日常验收", "先检查，再模拟。这里只保留最常用动作。")
        self._command_button(daily, "1. 一键完整检查", self.run_full_check, primary=True)
        self._command_button(daily, "2. 模拟默认流程", self.run_default_simulation)
        self._command_button(daily, "选择模拟案例...", self.run_chosen_simulation)

        advanced = self._card(parent, "其它命令", "低频验收命令在这里。Build / 诊断 / 关系视图看右侧分页。")
        picker = ttk.Combobox(advanced, textvariable=self.advanced_command, values=ADVANCED_COMMANDS, state="readonly")
        picker.pack(fill=X, pady=(0, 6))
        self._command_button(advanced, "运行选中命令", self.run_selected_advanced_command)

    def _build_openers(self, parent: ttk.Frame) -> None:
        openers = self._card(parent, "打开位置", "不堆具体文件，只给入口和结果。")
        ttk.Button(openers, text="打开 authoring 源目录", command=lambda: open_path(Path("authoring")), style="Tool.TButton").pack(fill=X, pady=3)
        ttk.Button(openers, text="打开策划操作指南", command=lambda: open_path(Path("docs/策划-Graph内容操作指南.md")), style="Tool.TButton").pack(fill=X, pady=3)
        ttk.Button(openers, text="打开诊断报告", command=lambda: open_path(Path("artifact/content_pipeline/content_report.md")), style="Tool.TButton").pack(fill=X, pady=3)
        ttk.Button(openers, text="打开模拟结果", command=lambda: open_path(Path("artifact/content_pipeline/simulation_result.json")), style="Tool.TButton").pack(fill=X, pady=3)
        ttk.Button(openers, text="打开 Runtime Preview", command=lambda: open_path(Path("artifact/content_pipeline/runtime_preview")), style="Tool.TButton").pack(fill=X, pady=3)

    def _build_status(self, parent: ttk.Frame) -> None:
        box = ttk.Frame(parent, style="Card.TFrame", padding=12)
        box.pack(fill=X, pady=(0, 12))
        ttk.Label(box, textvariable=self.status_text, style="Status.TLabel").pack(anchor="w")
        ttk.Label(box, textvariable=self.diagnostic_text, style="CardText.TLabel").pack(anchor="w", pady=(5, 0))
        ttk.Label(box, textvariable=self.runtime_text, style="CardText.TLabel").pack(anchor="w")
        ttk.Label(box, textvariable=self.simulation_text, style="CardText.TLabel").pack(anchor="w")
        ttk.Label(box, textvariable=self.log_path_text, style="CardText.TLabel", wraplength=760).pack(anchor="w")
        ttk.Label(box, textvariable=self.last_command, style="CardText.TLabel").pack(anchor="w", pady=(5, 0))

    def _build_result_tabs(self, parent: ttk.Frame) -> None:
        tabs = ttk.Notebook(parent)
        tabs.pack(fill=BOTH, expand=True)

        diagnostics_tab = ttk.Frame(tabs, padding=8)
        build_tab = ttk.Frame(tabs, padding=8)
        reference_tab = ttk.Frame(tabs, padding=8)
        log_tab = ttk.Frame(tabs, padding=8)
        tabs.add(build_tab, text="Build")
        tabs.add(diagnostics_tab, text="问题列表")
        tabs.add(reference_tab, text="关系诊断")
        tabs.add(log_tab, text="命令日志")

        self._build_build_tab(build_tab)
        self._build_diagnostics_tab(diagnostics_tab)
        self._build_reference_tab(reference_tab)
        self._build_log_tab(log_tab)

    def _build_build_tab(self, parent: ttk.Frame) -> None:
        intro = ttk.Frame(parent)
        intro.pack(fill=X, pady=(0, 12))
        ttk.Label(intro, text="Build / Validate", font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w")
        ttk.Label(
            intro,
            text="Build 会生成运行时预览产物；Validate 只检查内容，不写产物。",
            font=("Microsoft YaHei UI", 9),
        ).pack(anchor="w", pady=(4, 0))

        actions = ttk.Frame(parent)
        actions.pack(fill=X, pady=(0, 12))
        self._command_button(actions, "Game Authoring: Build Content", lambda: self.run_pipeline("build"), primary=True)
        self._command_button(actions, "Game Authoring: Validate Content", lambda: self.run_pipeline("validate"))
        self._command_button(actions, "一键完整检查", self.run_full_check)

        ttk.Separator(parent).pack(fill=X, pady=12)
        ttk.Label(parent, text="说明", font=("Microsoft YaHei UI", 10, "bold")).pack(anchor="w")
        ttk.Label(
            parent,
            text=(
                "Build 用于生成 artifact/content_pipeline 和 runtime_preview。\n"
                "Validate 用于快速检查 YAML/schema/reference，不应该改动输出文件。\n"
                "一键完整检查会额外跑模拟、runtime compatibility、LSP smoke、单测和 VS Code 插件编译。"
            ),
            justify="left",
            wraplength=760,
        ).pack(anchor="w", pady=(6, 0))

    def _build_diagnostics_tab(self, parent: ttk.Frame) -> None:
        toolbar = ttk.Frame(parent)
        toolbar.pack(fill=X, pady=(0, 8))
        refresh = ttk.Button(toolbar, text="刷新诊断列表", command=lambda: self.run_pipeline("diagnostics-json"), style="Primary.TButton")
        refresh.pack(side=LEFT)
        self.command_buttons.append(refresh)
        ttk.Button(toolbar, text="复制选中问题", command=self.copy_selected_diagnostics, style="Tool.TButton").pack(side=LEFT)
        ttk.Button(toolbar, text="复制全部问题", command=self.copy_all_diagnostics, style="Tool.TButton").pack(side=LEFT, padx=6)
        ttk.Button(toolbar, text="打开选中文件", command=self.open_selected_diagnostic_file, style="Tool.TButton").pack(side=LEFT)

        columns = ("severity", "code", "file", "line", "message")
        self.diagnostics = ttk.Treeview(parent, columns=columns, show="headings", selectmode="extended")
        headings = {
            "severity": "级别",
            "code": "代码",
            "file": "文件",
            "line": "行",
            "message": "说明",
        }
        widths = {"severity": 60, "code": 150, "file": 250, "line": 56, "message": 420}
        for col in columns:
            self.diagnostics.heading(col, text=headings[col])
            self.diagnostics.column(col, width=widths[col], anchor="w", stretch=col == "message")
        self.diagnostics.tag_configure("error", foreground="#b42318")
        self.diagnostics.tag_configure("warning", foreground="#9a6700")
        self.diagnostics.pack(fill=BOTH, expand=True)

    def _build_reference_tab(self, parent: ttk.Frame) -> None:
        intro = ttk.Frame(parent)
        intro.pack(fill=X, pady=(0, 12))
        ttk.Label(intro, text="关系诊断 / Reference", font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w")
        ttk.Label(
            intro,
            text="这里放只读诊断入口：看 signal、flag、quest、dialogue route、runtime trace 的关系和结果。",
            font=("Microsoft YaHei UI", 9),
            wraplength=760,
        ).pack(anchor="w", pady=(4, 0))

        controls = ttk.Frame(parent)
        controls.pack(fill=X, pady=(0, 8))
        ttk.Label(controls, text="查看类型：").pack(side=LEFT)
        picker = ttk.Combobox(controls, textvariable=self.reference_kind, values=REFERENCE_KINDS, state="readonly", width=24)
        picker.pack(side=LEFT, padx=(4, 8))
        picker.bind("<<ComboboxSelected>>", lambda _event: self.refresh_reference_view())
        ttk.Label(controls, text="过滤：").pack(side=LEFT)
        filter_entry = ttk.Entry(controls, textvariable=self.reference_filter, width=28)
        filter_entry.pack(side=LEFT, padx=(4, 8))
        filter_entry.bind("<KeyRelease>", lambda _event: self.refresh_reference_view())
        ttk.Button(controls, text="刷新视图", command=self.refresh_reference_view, style="Primary.TButton").pack(side=LEFT)
        ttk.Button(controls, text="复制详情", command=self.copy_reference_details, style="Tool.TButton").pack(side=LEFT, padx=6)

        grid = ttk.Frame(parent)
        grid.pack(fill=X, pady=(0, 8))
        buttons = [
            ("生成/刷新 Content Index", lambda: self.run_pipeline("index")),
            ("重新加载视图", self.refresh_reference_view),
            ("Trace Resolve 文件...", self.run_trace_resolve),
            ("打开原始产物目录", lambda: open_path(Path("artifact/content_pipeline"))),
        ]
        for i, (label, command) in enumerate(buttons):
            btn = ttk.Button(grid, text=label, command=command, style="Tool.TButton")
            btn.grid(row=i // 2, column=i % 2, sticky="ew", padx=(0 if i % 2 == 0 else 8, 8 if i % 2 == 0 else 0), pady=4)
            if "生成" in label or label.startswith("Trace"):
                self.command_buttons.append(btn)
        grid.columnconfigure(0, weight=1)
        grid.columnconfigure(1, weight=1)

        content = ttk.Frame(parent)
        content.pack(fill=BOTH, expand=True)
        list_frame = ttk.Frame(content)
        list_frame.pack(side=LEFT, fill=BOTH, expand=True, padx=(0, 8))
        detail_frame = ttk.Frame(content)
        detail_frame.pack(side=RIGHT, fill=BOTH, expand=True)

        columns = ("id", "summary")
        self.reference_tree = ttk.Treeview(list_frame, columns=columns, show="headings", selectmode="browse")
        self.reference_tree.heading("id", text="对象")
        self.reference_tree.heading("summary", text="摘要")
        self.reference_tree.column("id", width=220, anchor="w")
        self.reference_tree.column("summary", width=360, anchor="w")
        ref_scroll = ttk.Scrollbar(list_frame, orient="vertical", command=self.reference_tree.yview)
        self.reference_tree.configure(yscrollcommand=ref_scroll.set)
        self.reference_tree.pack(side=LEFT, fill=BOTH, expand=True)
        ref_scroll.pack(side=RIGHT, fill=Y)
        self.reference_tree.bind("<<TreeviewSelect>>", lambda _event: self.show_selected_reference_detail())

        self.reference_detail = Text(detail_frame, wrap="word", font=("Consolas", 10), height=10)
        detail_scroll = ttk.Scrollbar(detail_frame, orient="vertical", command=self.reference_detail.yview)
        self.reference_detail.configure(yscrollcommand=detail_scroll.set)
        self.reference_detail.pack(side=LEFT, fill=BOTH, expand=True)
        detail_scroll.pack(side=RIGHT, fill=Y)
        self.refresh_reference_view()

    def _build_log_tab(self, parent: ttk.Frame) -> None:
        toolbar = ttk.Frame(parent)
        toolbar.pack(fill=X, pady=(0, 8))
        ttk.Button(toolbar, text="复制选中", command=self.copy_selected_log, style="Tool.TButton").pack(side=LEFT)
        ttk.Button(toolbar, text="复制全部", command=self.copy_all_log, style="Tool.TButton").pack(side=LEFT, padx=6)
        ttk.Button(toolbar, text="保存日志...", command=self.save_log, style="Tool.TButton").pack(side=LEFT)
        ttk.Button(toolbar, text="清空", command=self.clear_output, style="Tool.TButton").pack(side=LEFT, padx=6)
        ttk.Button(toolbar, text="打开 logs 目录", command=open_logs_dir, style="Tool.TButton").pack(side=RIGHT)

        self.output = Text(parent, wrap="word", font=("Consolas", 10), bg="#15120e", fg="#f3ead7", insertbackground="#f3ead7", relief="flat")
        scroll = ttk.Scrollbar(parent, orient="vertical", command=self.output.yview)
        self.output.configure(yscrollcommand=scroll.set)
        self.output.tag_configure("command", foreground="#8ecae6")
        self.output.tag_configure("success", foreground="#9bd18b")
        self.output.tag_configure("warning", foreground="#f7c948")
        self.output.tag_configure("error", foreground="#ff8a80")
        self.output.tag_configure("muted", foreground="#9c9284")
        self.output.tag_configure("plain", foreground="#f3ead7")
        self.output.pack(side=LEFT, fill=BOTH, expand=True)
        scroll.pack(side=RIGHT, fill=Y)
        self.write(f"准备好了。GUI 版本：{GUI_VERSION}。建议先点「一键完整检查」。\n", "muted")

    def run_pipeline(self, command: str, *args: str) -> None:
        self.run_process([PY, "-m", "tools.content_pipeline", command, *args], title=f"content {command}")

    def run_full_check(self) -> None:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        steps = [
            ("构建内容", [PY, "-m", "tools.content_pipeline", "build"]),
            ("刷新诊断", [PY, "-m", "tools.content_pipeline", "diagnostics-json"]),
            ("模拟摘要", [PY, "-m", "tools.content_pipeline", "simulate"]),
            ("Runtime 兼容性", [PY, "-m", "tools.content_pipeline", "runtime-compatibility"]),
            ("LSP smoke", [PY, "-m", "tools.content_pipeline", "lsp-smoke"]),
            ("Pipeline unittest", [PY, "-m", "unittest", "tools.content_pipeline.tests.test_cli"]),
            ("VS Code extension compile", [npm, "--prefix", "tools/vscode-game-authoring", "run", "compile"]),
        ]
        self.run_sequence(steps, title="完整检查")

    def run_default_simulation(self) -> None:
        case_path = ROOT / "authoring" / "simulations" / "ringboy_snatch_route.json"
        if case_path.exists():
            self.run_pipeline("simulate", str(case_path))
        else:
            self.run_pipeline("simulate")

    def run_chosen_simulation(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 simulation JSON",
            initialdir=str(ROOT / "authoring" / "simulations"),
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.run_pipeline("simulate", path)

    def run_chosen_explain(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 explain/simulation JSON",
            initialdir=str(ROOT / "authoring" / "simulations"),
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.run_pipeline("explain", path)

    def run_trace_resolve(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 runtime trace JSON",
            initialdir=str(ROOT / "logs"),
            filetypes=[("JSON", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.run_pipeline("trace-resolve", path)

    def ask_new_yaml_options(self, kind: str) -> dict[str, str] | None:
        options = TEMPLATE_OPTIONS[kind]
        labels = [label for _, label in options]
        result: dict[str, str] = {}
        dialog = Toplevel(self.root)
        dialog.title(f"新建 {kind} YAML")
        dialog.transient(self.root)
        dialog.grab_set()
        dialog.resizable(False, False)
        frame = ttk.Frame(dialog, padding=14)
        frame.pack(fill=BOTH, expand=True)
        ttk.Label(frame, text="显示名称（给人看的名字，不是 id）：").pack(anchor="w")
        name_var = StringVar()
        name_entry = ttk.Entry(frame, textvariable=name_var, width=42)
        name_entry.pack(fill=X, pady=(4, 10))
        ttk.Label(frame, text="选择模板：").pack(anchor="w")
        template_label = StringVar(value=labels[0])
        ttk.Combobox(frame, textvariable=template_label, values=labels, state="readonly", width=40).pack(fill=X, pady=(4, 10))
        owner_var = StringVar()
        if kind in {"dialogue", "narrative"}:
            ttk.Label(frame, text="owner（可空，例如 npc:ringboy 或 flow:dock）：").pack(anchor="w")
            ttk.Entry(frame, textvariable=owner_var, width=42).pack(fill=X, pady=(4, 10))
        button_row = ttk.Frame(frame)
        button_row.pack(fill=X, pady=(6, 0))

        def submit() -> None:
            name = name_var.get().strip()
            if not name:
                messagebox.showwarning("缺少名称", "请输入显示名称。", parent=dialog)
                return
            selected = template_label.get()
            template_key = next((key for key, label in options if label == selected), options[0][0])
            result.update({"name": name, "template": template_key, "owner": owner_var.get().strip()})
            dialog.destroy()

        def cancel() -> None:
            dialog.destroy()

        ttk.Button(button_row, text="下一步：选择保存位置", command=submit, style="Primary.TButton").pack(side=LEFT)
        ttk.Button(button_row, text="取消", command=cancel, style="Tool.TButton").pack(side=RIGHT)
        name_entry.focus_set()
        dialog.bind("<Return>", lambda _event: submit())
        dialog.bind("<Escape>", lambda _event: cancel())
        self.root.wait_window(dialog)
        return result or None

    def run_new_template(self, kind: str) -> None:
        options = self.ask_new_yaml_options(kind)
        if not options:
            return
        name = options["name"]
        owner = options.get("owner", "")
        template_key = options["template"]
        ident = unique_id_for_name(kind, name)
        root = KIND_ROOTS[kind]
        root.mkdir(parents=True, exist_ok=True)
        path = filedialog.asksaveasfilename(
            title=f"选择 {kind} YAML 保存位置",
            initialdir=str(root),
            initialfile=f"{safe_filename(ident)}.yaml",
            defaultextension=".yaml",
            filetypes=[("YAML", "*.yaml"), ("YAML", "*.yml"), ("All files", "*.*")],
        )
        if not path:
            return
        target = Path(path)
        if target.suffix.lower() not in {".yaml", ".yml"}:
            target = target.with_suffix(".yaml")
        if not is_relative_to(target, root):
            messagebox.showwarning("位置不对", f"{kind} YAML 必须放在：\n{root}")
            return
        existed = target.exists()
        if existed:
            confirmed = messagebox.askyesno(
                "确认覆盖",
                f"文件已存在，是否覆盖？\n\n{target}",
            )
            if not confirmed:
                self.status_text.set("已取消覆盖。")
                return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(template_text(kind, ident, name, owner, template_key), encoding="utf-8")
        self.clear_output()
        verb = "已覆盖" if existed else "已创建"
        self.write(f"{verb} {kind} YAML 模板：{target}\n", "success")
        self.write(f"显示名称：{name}\n", "plain")
        self.write(f"生成 id：{ident}\n", "plain")
        self.write(f"模板：{template_key}\n", "plain")
        self.write("文件已打开。改完后请运行“刷新诊断列表”或“一键完整检查”。\n", "muted")
        open_path(target)

    def run_selected_advanced_command(self) -> None:
        command = self.advanced_command.get()
        if command == "content:check":
            self.run_full_check()
        elif command == "project:test":
            npm = "npm.cmd" if os.name == "nt" else "npm"
            self.run_process([npm, "run", "test"], title="project test")
        elif command == "project:build":
            npm = "npm.cmd" if os.name == "nt" else "npm"
            self.run_process([npm, "run", "build"], title="project build")
        elif command == "narrative-editor:build":
            npm = "npm.cmd" if os.name == "nt" else "npm"
            self.run_process([npm, "run", "build:narrative-editor"], title="narrative editor build")
        elif command == "vscode-extension:compile":
            npm = "npm.cmd" if os.name == "nt" else "npm"
            self.run_process([npm, "--prefix", "tools/vscode-game-authoring", "run", "compile"], title="VS Code extension compile")
        elif command == "content:simulate summary":
            self.run_pipeline("simulate")
        elif command == "content:simulate case...":
            self.run_chosen_simulation()
        elif command == "content:explain summary":
            self.run_pipeline("explain")
        elif command == "content:explain case...":
            self.run_chosen_explain()
        elif command == "content:trace-resolve file...":
            self.run_trace_resolve()
        elif command == "新建 dialogue YAML 模板...":
            self.run_new_template("dialogue")
        elif command == "新建 narrative YAML 模板...":
            self.run_new_template("narrative")
        elif command == "新建 quest YAML 模板...":
            self.run_new_template("quest")
        elif command.startswith("content:"):
            self.run_pipeline(command.removeprefix("content:"))
        else:
            messagebox.showwarning("未知命令", command)

    def run_process(self, cmd: list[str], *, title: str) -> None:
        if self.running:
            messagebox.showinfo("正在运行", "已有命令正在运行，请等它结束。")
            return
        self.running = True
        self._set_command_buttons(False)
        self.clear_output()
        self._start_auto_log(title)
        self.status_text.set(f"正在运行：{title}")
        self.last_command.set(f"当前命令：{' '.join(cmd)}")
        self.write(f"\n--- {title} ---\n", "command")
        self.write(f"$ {' '.join(cmd)}\n", "command")
        threading.Thread(target=self._worker, args=(cmd, title), daemon=True).start()

    def run_sequence(self, steps: list[tuple[str, list[str]]], *, title: str) -> None:
        if self.running:
            messagebox.showinfo("正在运行", "已有命令正在运行，请等它结束。")
            return
        self.running = True
        self._set_command_buttons(False)
        self.clear_output()
        self._start_auto_log(title)
        self.status_text.set(f"正在运行：{title}")
        self.last_command.set(f"当前命令：{title}")
        self.write(f"\n--- {title} ---\n", "command")
        threading.Thread(target=self._sequence_worker, args=(steps, title), daemon=True).start()

    def _worker(self, cmd: list[str], title: str) -> None:
        started = time.time()
        try:
            command = content_command(cmd)
            summarize = command in {"simulate", "diagnostics-json", "runtime-compatibility", "explain"}
            proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert proc.stdout is not None
            captured: list[str] = []
            for line in proc.stdout:
                if summarize:
                    captured.append(line)
                else:
                    self.queue.put(("log", line))
            code = proc.wait()
            if summarize:
                raw = "".join(captured)
                summary = summarize_content_output(command, raw)
                self.queue.put(("log", summary if summary is not None else raw))
            elapsed = time.time() - started
            tag = "success" if code == 0 else "error"
            self.queue.put((tag, f"\n--- {title} 结束：exit {code}，{elapsed:.1f}s ---\n"))
            self.queue.put(("refresh", ""))
            if code == 0 and ("simulate" in cmd or title == "完整检查"):
                self.queue.put(("simulation_ok", ""))
            if code != 0:
                self.queue.put(("status", f"失败：{title}"))
            else:
                self.queue.put(("status", f"完成：{title}"))
        except Exception as exc:
            self.queue.put(("error", f"\n[ERROR] {exc}\n"))
            self.queue.put(("status", f"异常：{title}"))
        finally:
            self.queue.put(("done", ""))

    def _sequence_worker(self, steps: list[tuple[str, list[str]]], title: str) -> None:
        started_all = time.time()
        ok = True
        try:
            for step_title, cmd in steps:
                self.queue.put(("command", f"\n[{step_title}]\n$ {' '.join(cmd)}\n"))
                code, output = self._run_command_capture(cmd)
                command = content_command(cmd)
                summary = summarize_content_output(command, output)
                self.queue.put(("log", summary if summary is not None else output))
                tag = "success" if code == 0 else "error"
                self.queue.put((tag, f"[{step_title}] exit {code}\n"))
                self.queue.put(("refresh", ""))
                if code != 0:
                    ok = False
                    break
            elapsed = time.time() - started_all
            self.queue.put(("success" if ok else "error", f"\n--- {title} 结束：exit {0 if ok else 1}，{elapsed:.1f}s ---\n"))
            if ok:
                self.queue.put(("simulation_ok", ""))
            self.queue.put(("status", f"{'完成' if ok else '失败'}：{title}"))
        except Exception as exc:
            self.queue.put(("error", f"\n[ERROR] {exc}\n"))
            self.queue.put(("status", f"异常：{title}"))
        finally:
            self.queue.put(("done", ""))

    def _run_command_capture(self, cmd: list[str]) -> tuple[int, str]:
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert proc.stdout is not None
        output = proc.stdout.read()
        return proc.wait(), output

    def _set_command_buttons(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        for btn in self.command_buttons:
            btn.configure(state=state)

    def _drain_queue(self) -> None:
        while True:
            try:
                tag, text = self.queue.get_nowait()
            except queue.Empty:
                break
            if tag == "done":
                self.running = False
                self._set_command_buttons(True)
                continue
            if tag == "refresh":
                self._refresh_summary_from_disk()
                continue
            if tag == "status":
                self.status_text.set(text)
                continue
            if tag == "simulation_ok":
                self.simulation_text.set("模拟：最近一次运行成功")
                continue
            self.write(text, self._style_for_line(text) if tag == "log" else tag)
        self.root.after(80, self._drain_queue)

    def _style_for_line(self, text: str) -> str:
        low = text.lower()
        if "error" in low or "failed" in low or "traceback" in low or "exception" in low:
            return "error"
        if "warning" in low or '"severity": "warning"' in low:
            return "warning"
        if "ok" in low or "success" in low or "exit 0" in low or "lsp smoke ok" in low:
            return "success"
        if text.startswith(">") or text.startswith("$"):
            return "command"
        if text.strip().startswith("{") or text.strip().startswith("}") or text.strip().startswith("[") or text.strip().startswith("]"):
            return "muted"
        return "plain"

    def write(self, text: str, tag: str = "plain") -> None:
        self.log_lines.append(text)
        self.output.insert(END, text, tag)
        self.output.see(END)
        if self.current_log_path is not None:
            try:
                with self.current_log_path.open("a", encoding="utf-8") as f:
                    f.write(text)
            except Exception as exc:
                self.current_log_path = None
                self.status_text.set(f"日志自动保存失败：{exc}")

    def _start_auto_log(self, title: str) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.current_log_path = log_path_for_title(title)
        self.current_log_path.write_text(
            f"GameDraft Graph 工作台日志\nGUI: {GUI_VERSION}\n命令: {title}\n时间: {datetime.now().isoformat(timespec='seconds')}\n\n",
            encoding="utf-8",
        )
        self.log_path_text.set(f"日志：{self.current_log_path}")
        self.status_text.set(f"日志自动保存：{self.current_log_path}")

    def clear_output(self) -> None:
        self.log_lines.clear()
        self.output.delete("1.0", END)

    def _refresh_summary_from_disk(self) -> None:
        self._load_diagnostics()
        self._load_runtime_status()
        self.refresh_reference_view()

    def _load_diagnostics(self) -> None:
        path = ROOT / "artifact" / "content_pipeline" / "diagnostics.json"
        for row in self.diagnostics.get_children():
            self.diagnostics.delete(row)
        if not path.exists():
            self.diagnostic_text.set("诊断：还没有结果")
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.diagnostic_text.set(f"诊断：读取失败 {exc}")
            return
        if not isinstance(raw, list):
            self.diagnostic_text.set("诊断：格式异常")
            return
        errors = 0
        warnings = 0
        for i, item in enumerate(raw):
            if not isinstance(item, dict):
                continue
            severity = str(item.get("severity", ""))
            if severity == "error":
                errors += 1
            if severity == "warning":
                warnings += 1
            source = item.get("source") if isinstance(item.get("source"), dict) else {}
            values = (
                severity,
                str(item.get("code", "")),
                str(source.get("file", "")),
                str(source.get("line", "")),
                str(item.get("message", "")),
            )
            self.diagnostics.insert("", END, iid=str(i), values=values, tags=(severity,))
        self.diagnostic_text.set(f"诊断：{errors} error，{warnings} warning")
        if errors:
            self.status_text.set("有阻断错误，需要先修")
        else:
            self.status_text.set("当前无阻断错误")

    def _load_runtime_status(self) -> None:
        path = ROOT / "artifact" / "content_pipeline" / "runtime_compatibility.json"
        if not path.exists():
            self.runtime_text.set("Runtime：还没有结果")
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.runtime_text.set(f"Runtime：读取失败 {exc}")
            return
        ok = bool(raw.get("ok")) if isinstance(raw, dict) else False
        issues = raw.get("issues", []) if isinstance(raw, dict) else []
        self.runtime_text.set(f"Runtime：{'通过' if ok else '未通过'}，{len(issues) if isinstance(issues, list) else '?'} issue")

    def _read_artifact_json(self, relative: str) -> object:
        path = ROOT / relative
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"__error": f"读取失败：{exc}"}

    def refresh_reference_view(self) -> None:
        if not hasattr(self, "reference_tree"):
            return
        for row in self.reference_tree.get_children():
            self.reference_tree.delete(row)
        self.reference_row_details.clear()
        self.reference_detail.delete("1.0", END)

        kind = self.reference_kind.get()
        index = self._read_artifact_json("artifact/content_pipeline/content_index.json")
        simulation = self._read_artifact_json("artifact/content_pipeline/simulation_result.json")
        rows = reference_rows(kind, index, simulation)
        needle = self.reference_filter.get().strip().lower()
        if needle:
            rows = [row for row in rows if needle in " ".join(row[:3]).lower() or needle in row[3].lower()]

        if not rows:
            hint = "没有可显示的数据。请先在 Build 分页运行 Build Content，或在关系诊断中生成/刷新 Content Index。"
            self.reference_detail.insert(END, hint)
            self.reference_details = hint
            return
        for i, (_key, title, summary, details) in enumerate(rows):
            iid = str(i)
            self.reference_tree.insert("", END, iid=iid, values=(title, summary))
            self.reference_row_details[iid] = details
        first = self.reference_tree.get_children()
        if first:
            self.reference_tree.selection_set(first[0])
            self.show_selected_reference_detail()

    def show_selected_reference_detail(self) -> None:
        selected = self.reference_tree.selection()
        if not selected:
            return
        details = self.reference_row_details.get(selected[0], "")
        self.reference_details = details
        self.reference_detail.delete("1.0", END)
        self.reference_detail.insert(END, details)

    def copy_reference_details(self) -> None:
        text = self.reference_detail.get("1.0", END).strip()
        if not text:
            messagebox.showinfo("没有详情", "先在关系诊断列表里选中一条。")
            return
        self._copy_text(text)

    def _diagnostic_rows(self, selected_only: bool) -> list[str]:
        rows = self.diagnostics.selection() if selected_only else self.diagnostics.get_children()
        lines: list[str] = []
        for row in rows:
            severity, code, file, line, message = self.diagnostics.item(row, "values")
            lines.append(f"{severity} {code} {file}:{line} {message}")
        return lines

    def copy_selected_diagnostics(self) -> None:
        lines = self._diagnostic_rows(True)
        if not lines:
            messagebox.showinfo("没有选中", "先在问题列表里选中一条或多条问题。")
            return
        self._copy_text("\n".join(lines))

    def copy_all_diagnostics(self) -> None:
        lines = self._diagnostic_rows(False)
        self._copy_text("\n".join(lines))

    def open_selected_diagnostic_file(self) -> None:
        rows = self.diagnostics.selection()
        if not rows:
            messagebox.showinfo("没有选中", "先选中一条问题。")
            return
        values = self.diagnostics.item(rows[0], "values")
        file = str(values[2]) if len(values) >= 3 else ""
        if not file:
            messagebox.showwarning("没有文件", "这条问题没有源文件。")
            return
        open_path(Path(file))

    def copy_selected_log(self) -> None:
        try:
            text = self.output.get("sel.first", "sel.last")
        except Exception:
            messagebox.showinfo("没有选中", "先在日志里拖选一段文本。")
            return
        self._copy_text(text)

    def copy_all_log(self) -> None:
        self._copy_text(self.output.get("1.0", END).strip())

    def save_log(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        default = f"planner-gui-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
        path = filedialog.asksaveasfilename(
            title="保存日志",
            initialdir=str(LOG_DIR),
            initialfile=default,
            defaultextension=".log",
            filetypes=[("Log", "*.log"), ("Text", "*.txt"), ("All files", "*.*")],
        )
        if not path:
            return
        Path(path).write_text(self.output.get("1.0", END), encoding="utf-8")
        messagebox.showinfo("已保存", path)

    def _copy_text(self, text: str) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.root.update()
        self.status_text.set("已复制到剪贴板")

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print("GameDraft Planner GUI")
        print("")
        print("Usage:")
        print("  python tools/planner_gui/planner_gui.py")
        print("  npm run planner:gui")
        print("")
        print("Options:")
        print("  --help   Show this help and exit")
        print("  --smoke  Validate imports and paths, then exit")
        return 0
    if "--smoke" in sys.argv:
        print(f"root={ROOT}")
        print(f"python={PY}")
        print(f"project={(ROOT / 'authoring' / 'project.yaml').exists()}")
        print(f"gui={GUI_VERSION}")
        return 0
    app = PlannerGui()
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
