from __future__ import annotations

import argparse
import atexit
import json
import os
import socket
import subprocess
import threading
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from tools.dev.paths import env_with_node_path, npm_command, repo_root


@dataclass(frozen=True)
class ToolAction:
    label: str
    task: str
    note: str


TOOLS: tuple[ToolAction, ...] = (
    ToolAction("主编辑器", "editor", "内容、场景、资源索引"),
    ToolAction("生产工作台", "workbench", "每日检查、剧情单元、素材任务"),
    ToolAction("对话图", "dialogue-graph", "Graph 对话和节点关系"),
    ToolAction("资源浏览器", "asset-browser", "浏览、拖拽、入库记录"),
    ToolAction("资源入库", "asset-ingest", "导入素材到工程结构"),
    ToolAction("滤镜工具", "filter-tool", "ColorMatrix 预制和导出"),
    ToolAction("编年史 v3", "chronicle-sim", "ChronicleSim v3"),
    ToolAction("编年史 v2", "chronicle-sim-v2", "ChronicleSim v2"),
)


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
                "logs": logs,
                "seq": self.seq,
            }

    def run_action(self, action: str, payload: dict[str, Any]) -> tuple[bool, str]:
        if action == "pull":
            return self._run_exclusive("Pull", ["./pull-all.sh"], cwd=self.scripts_dir)
        if action == "push":
            return self._run_exclusive("Push", ["./push-all.sh"], cwd=self.scripts_dir)
        if action == "commit":
            msg = str(payload.get("message") or "").strip()
            if not msg:
                return False, "请输入提交说明。"
            return self._run_exclusive("Commit", ["./commit-all.sh", msg], cwd=self.scripts_dir)
        if action == "git_status":
            return self._run_exclusive("Git status", ["git", "status", "--short", "--branch"])
        if action == "start_game":
            return self._start_game()
        if action == "stop_game":
            return self._stop_game()
        if action == "build":
            return self._run_exclusive("Build", [npm_command(), "run", "build"], env=env_with_node_path())
        if action == "test":
            return self._run_exclusive("Test", [npm_command(), "test", "--", "--run"], env=env_with_node_path())
        if action == "install_deps":
            return self._run_exclusive("Install deps", [str(self.dev_sh), "install-deps"])
        if action == "init_runtime":
            return self._run_exclusive("Init runtime", [str(self.dev_sh), "init-runtime"])
        if action == "init_editor":
            return self._run_exclusive("Init editor", [str(self.dev_sh), "init-editor"])
        return False, f"Unknown action: {action}"

    def launch_tool(self, task: str) -> tuple[bool, str]:
        if task not in {tool.task for tool in TOOLS}:
            return False, f"Unknown tool: {task}"
        self._start_process(f"Launch {task}", [str(self.dev_sh), task], exclusive=False)
        return True, "ok"

    def _start_game(self) -> tuple[bool, str]:
        if self.game_process is not None and self.game_process.poll() is None:
            return True, "Game server is already running."
        self.game_process = self._start_process("Game server", [str(self.dev_sh), "game", "start"], exclusive=False)
        return True, "started"

    def _stop_game(self) -> tuple[bool, str]:
        self._start_process("Stop game", [str(self.dev_sh), "game", "stop"], exclusive=False)
        return True, "started"

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
    ) -> subprocess.Popen[str]:
        self.add_log(f"$ {title}: {' '.join(argv)}", "cmd")
        proc = subprocess.Popen(
            argv,
            cwd=str(cwd or self.root),
            env=env or os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._watch_process, args=(title, proc, exclusive), daemon=True).start()
        return proc

    def _watch_process(self, title: str, proc: subprocess.Popen[str], exclusive: bool) -> None:
        if proc.stdout is not None:
            for line in proc.stdout:
                self.add_log(line)
        code = proc.wait()
        self.add_log(f"{title} finished with exit code {code}.", "ok" if code == 0 else "err")
        with self.lock:
            if exclusive and proc is self.active_process:
                self.active_process = None
                self.active_title = ""
            if proc is self.game_process:
                self.game_process = None

    def stop_game_on_exit(self) -> None:
        if self.game_process is not None and self.game_process.poll() is None:
            subprocess.Popen([str(self.dev_sh), "game", "stop"], cwd=str(self.root))


STATE = ConsoleState()


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "GameDraftConsole/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(INDEX_HTML)
            return
        if parsed.path == "/api/state":
            since = int(parse_qs(parsed.query).get("since", ["0"])[0] or "0")
            self._send_json(STATE.snapshot(since))
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
            ok, message = STATE.launch_tool(str(payload.get("task") or ""))
            self._send_json({"ok": ok, "message": message}, HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST)
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

    def _send_html(self, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


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
    atexit.register(STATE.stop_game_on_exit)
    url = f"http://127.0.0.1:{port}/"
    STATE.add_log(f"Console listening at {url}", "ok")
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
.bar{display:flex;justify-content:space-between;align-items:center;margin:14px 0 6px}
#state{font-size:13px;color:#374151}
#log{height:270px;overflow:auto;background:#111827;color:#e5e7eb;border-radius:6px;padding:10px;font:12px Menlo,Consolas,monospace;white-space:pre-wrap}
.cmd{color:#93c5fd}.ok{color:#86efac}.err{color:#fca5a5}
@media(max-width:800px){.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}}
@media(prefers-color-scheme:dark){:root{background:#111827;color:#f9fafb}section{background:#1f2937;border-color:#374151}button{background:#111827;color:#f9fafb;border-color:#4b5563}button:hover{background:#273244}input{background:#111827;color:#f9fafb;border-color:#4b5563}.sep{background:#374151}#root,.note,#state{color:#9ca3af}}
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
<div class="bar"><strong>日志</strong><span id="state"></span><button id="clearLog">清空</button></div>
<div id="log"></div>
</main>
<script>
const tools = %TOOLS_JSON%;
const logEl = document.querySelector("#log");
const rootEl = document.querySelector("#root");
const stateEl = document.querySelector("#state");
let seq = 0;

function append(entry){
  const div = document.createElement("div");
  div.className = entry.kind || "log";
  div.textContent = `[${entry.time}] ${entry.text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
async function post(url, body){
  const r = await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){
    const data = await r.json().catch(()=>({message:r.statusText}));
    append({time:new Date().toLocaleTimeString(),kind:"err",text:data.message || r.statusText});
  }
}
async function poll(){
  const data = await fetch(`/api/state?since=${seq}`).then(r=>r.json());
  rootEl.textContent = data.root;
  stateEl.textContent = data.active ? `运行中: ${data.activeTitle}` : (data.gameRunning ? "游戏服务运行中" : "空闲");
  for(const entry of data.logs){ append(entry); seq = Math.max(seq, entry.seq); }
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
for(const tool of tools){
  const wrap = document.createElement("div");
  wrap.className = "tool";
  const btn = document.createElement("button");
  btn.textContent = tool.label;
  btn.addEventListener("click",()=>post("/api/tool",{task:tool.task}));
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = tool.note;
  wrap.append(btn,note);
  toolsEl.appendChild(wrap);
}
setInterval(poll, 800);
poll();
</script>
</body>
</html>
""".replace(
    "%TOOLS_JSON%",
    json.dumps([tool.__dict__ for tool in TOOLS], ensure_ascii=False),
)
