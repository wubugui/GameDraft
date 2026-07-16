"""json_lang LSP 客户端(编辑器侧)——「JSON=语言」大脑的编辑器接入层。

职责与边界:
- **overlay 发布者**:编辑器内存态(两阶段写盘,磁盘上看不见)经 didOpen/didChange
  推给 LSP server,让 IDE / agent 的查询实时看见未保存内容。镜像表
  `_SIMPLE_OVERLAY_FILES` + 特殊桶按 ProjectModel.save_all 的写盘分支一一对应;
  不镜像的桶必须登记进 `OVERLAY_EXEMPT_BUCKETS`(parity 测试
  test_lsp_overlay_parity.py 锁定,防第三处漂移)。漏镜像的后果只是该桶的
  overlay 缺席,查询退回磁盘视图——安全降级,但对话框明示"实时包含未保存编辑",
  所以单文件纯内容桶一律要求镜像。
- **查引用消费者**:gamedraft/refs 全宇宙查引用(编辑器菜单「查引用」用)。
- **绝不写盘、绝不改模型**:只读模型属性做序列化;server 挂了所有调用变 no-op。

纯 stdlib(threading+subprocess),不依赖 Qt;防抖等 UI 节奏由调用方(main_window)管。
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Optional

_REQUEST_TIMEOUT = 8.0


def _uri(path: Path) -> str:
    return "file://" + urllib.parse.quote(str(path))


# 客户端生命周期状态(状态栏指示灯消费;单向流转,dead 仅从 running 进入):
# idle → starting → running → (dead | stopped);starting → failed;任何态 stop() → stopped
STATE_IDLE = "idle"          # 尚未 start()
STATE_STARTING = "starting"  # start() 进行中(拉子进程/initialize 握手)
STATE_RUNNING = "running"    # 握手成功,可服务查询
STATE_FAILED = "failed"      # 启动失败(缺 server 文件/拉进程失败/握手超时)
STATE_DEAD = "dead"          # 曾 running,server 进程意外退出
STATE_STOPPED = "stopped"    # 主动 stop()


class JsonLangLspClient:
    """最小 JSON-RPC/stdio 客户端;线程安全;进程死亡后所有操作静默降级。

    状态经 ``state`` 只读暴露;流转时回调 ``on_state_changed(state)``(可能来自
    任意线程——Qt 侧接 Signal.emit 即自动排队回主线程)。"""

    def __init__(self, project_root: Path):
        self.root = Path(project_root)
        self._server = self.root / "tools" / "json_lang" / "lsp_server.py"
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._next_id = 0
        self._pending: dict[int, tuple[threading.Event, list]] = {}
        self._opened: set[str] = set()
        self._versions: dict[str, int] = {}
        self._state = STATE_IDLE
        self.last_error: str = ""
        self.on_state_changed: Optional[Callable[[str], None]] = None

    # ---------------- 生命周期 ----------------

    @property
    def available(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def state(self) -> str:
        return self._state

    def _set_state(self, state: str, error: str = "") -> None:
        if error:
            self.last_error = error
        if state == self._state:
            return
        self._state = state
        cb = self.on_state_changed
        if cb is not None:
            try:
                cb(state)
            except Exception:
                pass  # 状态回调是纯咨询,故障不影响客户端本体

    def start(self) -> bool:
        if self.available:
            return True
        self._set_state(STATE_STARTING)
        if not self._server.is_file():
            self._set_state(STATE_FAILED, f"server 文件不存在: {self._server}")
            return False
        try:
            self._proc = subprocess.Popen(
                [sys.executable, str(self._server)],
                cwd=str(self.root),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            self._proc = None
            self._set_state(STATE_FAILED, f"拉起 server 进程失败: {e}")
            return False
        threading.Thread(target=self._reader, daemon=True).start()
        init = self.request("initialize", {"rootUri": _uri(self.root)}, timeout=10.0)
        if init is None:
            self.stop()
            self._set_state(STATE_FAILED, "initialize 握手无响应(10s)")
            return False
        self.notify("initialized", {})
        self._set_state(STATE_RUNNING)
        return True

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            self._set_state(STATE_STOPPED)
            return
        try:
            self._send_to(proc, {"jsonrpc": "2.0", "id": self._bump_id(), "method": "shutdown"})
            self._send_to(proc, {"jsonrpc": "2.0", "method": "exit"})
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
        try:
            if proc.stdin is not None:
                proc.stdin.close()  # 半途 EPIPE 的残留写缓冲,不关会在 GC 终结时打 ignored 异常噪音
        except Exception:
            pass
        # stdout 不在这里关:reader 线程可能仍阻塞在 readline,进程死后它随 EOF 自然退出。
        self._set_state(STATE_STOPPED)

    # ---------------- RPC ----------------

    def _bump_id(self) -> int:
        # 多线程并发 request(搜索 worker/状态拉取/查引用)共用计数器——挂锁,
        # 免得撞 id 后一方的 (event, box) 被覆盖、请求空等到超时。
        with self._lock:
            self._next_id += 1
            return self._next_id

    def _send(self, msg: dict) -> bool:
        return self._send_to(self._proc, msg)

    def _send_to(self, proc: Optional[subprocess.Popen], msg: dict) -> bool:
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return False
        body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        with self._lock:
            try:
                proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
                proc.stdin.write(body)
                proc.stdin.flush()
                return True
            except OSError:
                return False

    def _reader(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        stdout = proc.stdout
        while True:
            headers: dict[str, str] = {}
            line = stdout.readline()
            if not line:
                break
            while line and line.strip():
                text = line.decode("ascii", "replace").strip()
                if ":" in text:
                    k, v = text.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
                line = stdout.readline()
            length = int(headers.get("content-length", 0) or 0)
            if length <= 0:
                continue
            try:
                msg = json.loads(stdout.read(length).decode("utf-8"))
            except Exception:
                continue
            slot = self._pending.pop(msg.get("id"), None) if msg.get("id") is not None else None
            if slot is not None:
                event, box = slot
                box.append(msg.get("result") if "error" not in msg else {"__error__": msg["error"]})
                event.set()
        # 进程结束:唤醒所有等待者。先原子换出整个 dict 再遍历——并发 request()
        # 还在往 self._pending 插入,直接迭代会 RuntimeError 炸死本线程,
        # 导致下面的 DEAD 流转永远不发生(状态芯片谎报 running、自动重启被卡)。
        pending, self._pending = self._pending, {}
        for event, box in pending.values():
            box.append(None)
            event.set()
        # 换出之后才插入的等待者:_send 对已死进程返回 False,request 自行清理返 None。
        # 仍挂在 self._proc 上说明不是主动 stop——server 意外退出
        if self._proc is proc and self._state == STATE_RUNNING:
            self._set_state(STATE_DEAD, "server 进程意外退出")

    def request(self, method: str, params: Any = None, timeout: float = _REQUEST_TIMEOUT):
        if self._proc is None:
            return None
        msg_id = self._bump_id()
        event: threading.Event = threading.Event()
        box: list = []
        self._pending[msg_id] = (event, box)
        payload: dict = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params is not None:
            payload["params"] = params
        if not self._send(payload):
            self._pending.pop(msg_id, None)
            return None
        if not event.wait(timeout):
            self._pending.pop(msg_id, None)
            return None
        return box[0] if box else None

    def notify(self, method: str, params: Any = None) -> None:
        payload: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

    # ---------------- overlay ----------------

    def push_overlay(self, abs_path: Path, data: Any) -> None:
        """把一份内存态数据作为该文件的未保存内容推给 server(不写盘)。"""
        if not self.available:
            return
        try:
            text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        except (TypeError, ValueError):
            return  # 不可序列化的中间态:跳过本次,等下次防抖
        uri = _uri(abs_path)
        version = self._versions.get(uri, 0) + 1
        self._versions[uri] = version
        if uri not in self._opened:
            self._opened.add(uri)
            self.notify("textDocument/didOpen", {
                "textDocument": {"uri": uri, "languageId": "json", "version": version, "text": text},
            })
        else:
            self.notify("textDocument/didChange", {
                "textDocument": {"uri": uri, "version": version},
                "contentChanges": [{"text": text}],
            })

    def clear_overlays(self) -> None:
        """保存成功后调用:磁盘已是真相,撤掉全部 overlay。"""
        for uri in sorted(self._opened):
            self.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        self._opened.clear()


# ---------------------------------------------------------------------------
# overlay 镜像登记面(与 ProjectModel.save_all 写盘分支一一对应)。三张表合起来
# 必须精确覆盖 ProjectModel.KNOWN_DIRTY_BUCKETS——由
# tools/editor/tests/test_lsp_overlay_parity.py 锁定,防"第三处漂移"
# (2026-07-14 审查 P1-15:characterRegistry 曾漏登记,未保存角色编辑对搜索静默失真)。
# ---------------------------------------------------------------------------

#: 单文件内容桶 → [(相对 data 根的文件路径, 模型属性名)],序列化形状 = 属性原样。
_SIMPLE_OVERLAY_FILES: dict[str, list[tuple[str, str]]] = {
    "config": [("game_config.json", "game_config")],
    "item": [("items.json", "items")],
    "quest": [("quests.json", "quests")],
    "questGroup": [("questGroups.json", "quest_groups")],
    "encounter": [("encounters.json", "encounters")],
    "rules": [("rules.json", "rules_data")],
    "shop": [("shops.json", "shops")],
    "cutscene": [("cutscenes/index.json", "cutscenes")],
    "audio": [("audio_config.json", "audio_config")],
    "strings": [("strings.json", "strings")],
    "archive": [
        ("archive/characters.json", "archive_characters"),
        ("archive/lore.json", "archive_lore"),
        ("archive/books.json", "archive_books"),
        ("archive/documents.json", "archive_documents"),
    ],
    "overlay_images": [("overlay_images.json", "overlay_images")],
    "scenarios": [("scenarios.json", "scenarios_catalog")],
    "narrative_graphs": [("narrative_graphs.json", "narrative_graphs")],
    "document_reveals": [("document_reveals.json", "document_reveals")],
    "smell_profiles": [("smell_profiles.json", "smell_profiles")],
    "pressure_holds": [("pressure_holds.json", "pressure_holds")],
    "signal_cues": [("signal_cues.json", "signal_cues")],
    "planes": [("planes.json", "planes")],
}

#: 序列化形状特殊的镜像桶(overlay_payloads 内逐一特判,形状对齐 save_all 分支):
#: - flag_registry:文件在 assets 根旁路(flag_registry_path)
#: - scene:多文件 scenes/<id>.json,可按 item_id 增量
#: - characterRegistry:dict → {"characters": [按 id 排序]}(与 save_all 同形)
OVERLAY_SPECIAL_BUCKETS: frozenset = frozenset({"flag_registry", "scene", "characterRegistry"})

#: 显式豁免清单:这些桶不做 overlay 镜像,查询以磁盘为准(安全降级)。
#: - map:保存时经 map_config_document() 现算文档形状且带写盘副作用,不做内存镜像
#: - narrative_templates / narrative_categories:编辑器侧整理数据,保存时经 normalize
#: - dialogue_stubs / dialogue_graph_edits:多文件暂存桶(搜索对话框 tip 已注明以磁盘为准)
#: - water_minigames / sugar_wheel / paper_craft / filter:多文件暂存桶,同上
OVERLAY_EXEMPT_BUCKETS: frozenset = frozenset({
    "map", "narrative_templates", "narrative_categories",
    "dialogue_stubs", "dialogue_graph_edits",
    "water_minigames", "sugar_wheel", "paper_craft", "filter",
})


def overlay_mirrored_buckets() -> frozenset:
    """当前会被镜像成 overlay 的脏桶全集(parity 测试消费)。"""
    return frozenset(_SIMPLE_OVERLAY_FILES) | OVERLAY_SPECIAL_BUCKETS


def overlay_payloads(model, data_type: str, item_id: str = "") -> list[tuple[Path, Any]]:
    if data_type == "flag_registry":
        from ..flag_registry import flag_registry_path
        return [(flag_registry_path(model.assets_path), model.flag_registry)]
    if data_type == "scene":
        sid = (item_id or "").strip()
        scenes = model.scenes if not sid else {sid: model.scenes.get(sid)}
        return [
            (model.scenes_path / f"{k}.json", v) for k, v in scenes.items() if isinstance(v, dict)
        ]
    dp = model.data_path
    if data_type == "characterRegistry":
        # 形状对齐 ProjectModel.save_all:{"characters": [按载入/插入顺序]}
        # (save_all 现按插入序回写以保往返字节,不再 sorted;overlay 只喂 LSP 解析 id,
        #  顺序不影响查询,但仍与写盘分支保持同形以免误导)。
        reg = model.character_registry
        return [(
            dp / "character_registry.json",
            {"characters": list(reg.values())},
        )]
    out: list[tuple[Path, Any]] = []
    for rel, attr in _SIMPLE_OVERLAY_FILES.get(data_type, []):
        try:
            out.append((dp / rel, getattr(model, attr)))
        except Exception:
            continue
    return out
