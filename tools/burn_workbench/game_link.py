# -*- coding: utf-8 -*-
"""燃烧工作台 ↔ 游戏的联动：走游戏 dev server（vite）上的一对槽，外加一键拉起游戏进当前场景。

页面不直接 fetch 游戏端口（跨源），一律经本工具的 Python 服务代理：

  工作台页 ──/api/link/publish──▶ 本服务 ──POST /__gamedraft-api/runtime-burn────────▶ vite ──▶ 游戏
  工作台页 ◀──/api/link/status─── 本服务 ◀──GET  /__gamedraft-api/runtime-burn-status── vite ◀── 游戏

槽的形状见 ``src/dev/runtimeBurnSync.ts`` / ``runtimeBurnApiPlugin.ts``（联动协议 v2，2026-09-16 模板化之后）：
  ``runtime-burn``        ``{writer, burnables?: {id: 模板工作态}, probe?: {seq, action, target, socket?, point?}, walkProbe?}``，``rev`` 服务端自增
                          （没有布置库了；``target`` = 场景实体 id，带 ``socket`` = 这个人手上那个挂点上的可燃挂件）
  ``runtime-burn-status`` 游戏状态页（场景 / appliedRev / probeSeqDone /
                          ``items: [{kind: scene|held, sceneId?, target, socket?, template, state, events, ready}]`` / stats / walkProbeResult）

**两个序号（探针 / 站位判定）是「粘」的**（与粒子台同一条论述）：发过之后每一发都带着同一个序号重发，直到下一次
请求加一——槽是整份覆盖的，游戏 400 ms 才轮询一次，不粘的话紧跟着的一次改动就把请求盖掉了。同序号重发游戏不会重做。

地址发现 / 拉起游戏 / 切场景与声学台逐字同一套，直接 import（第三份拷贝就是第三处会漂的地方）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from tools.acoustic_workbench.game_link import (
    DEFAULT_GAME_URL,
    REDISCOVER_S,
    START_WAIT_S,
    TIMEOUT_S,
    console_open_dev_entry,
    console_state,
    discover_game_url,
    enqueue_switch_scene,
    game_url_for,
    normalize_base,
)

ROOT = Path(__file__).resolve().parents[2]
DOC_PATH = "/__gamedraft-api/runtime-burn"
STATUS_PATH = "/__gamedraft-api/runtime-burn-status"
PROBE_ACTIONS = ("ignite", "extinguish", "reset")
WALK_POINTS_MAX = 256


def _get_json(url: str, timeout: float = TIMEOUT_S) -> dict | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as r:
            raw = r.read().decode("utf-8")
        doc = json.loads(raw) if raw.strip() else None
        return doc if isinstance(doc, dict) else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _slot_alive(base: str) -> bool:
    return _get_json(normalize_base(base) + STATUS_PATH, timeout=0.6) is not None


class SlotRejected(ConnectionError):
    """dev server 连上了、但把这份文档拒了（HTTP 4xx/5xx）。文字 = 它回的 body，原样给页面看。"""

    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code} {body}".strip())
        self.code = code
        self.body = body


def _boot_id_of(doc) -> str | None:
    if not isinstance(doc, dict):
        return None
    b = str(doc.get("bootId") or "").strip()
    if b:
        return b
    w = str(doc.get("writer") or "")
    return (w[5:] or None) if w.startswith("game:") else None


def _clean_points(points) -> list[list[float]]:
    out: list[list[float]] = []
    for p in (points or [])[:WALK_POINTS_MAX]:
        if isinstance(p, (list, tuple)) and len(p) >= 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in p[:2]):
            out.append([float(p[0]), float(p[1])])
    return out


class BurnLink:
    def __init__(self, base_url: str = "", writer: str = ""):
        self.explicit = bool(normalize_base(base_url))
        self.base = normalize_base(base_url) or discover_game_url()
        self.writer = writer or f"burn-workbench:{os.getpid()}"
        self.published = 0
        self.last_rev = 0
        self.probe_seq = 0
        self.walk_seq = 0
        self._seeded = False
        self.last_probe: dict | None = None
        self.last_walk: dict | None = None
        self.fail_streak = 0
        self.last_error = ""
        self.last_ok_at = 0.0
        self._rediscover_at = 0.0
        self._console_at = 0.0
        self._console_ok = False
        self.launch_note = ""
        self._launch_thread: threading.Thread | None = None
        from tools.dev.game_preview import open_game_preview
        # 钩子：测试里替换掉，别真开浏览器 / 真起进程
        self.open_browser = open_game_preview
        self.spawn_game_server = self._spawn_game_server

    # ------------------------------------------------------------------ http
    def _request(self, path: str, body: dict | None = None) -> dict:
        url = self.base + path
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
                raw = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:  # noqa: BLE001
                pass
            raise SlotRejected(e.code, detail) from e
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise ConnectionError(str(getattr(e, "reason", e))) from e
        try:
            return json.loads(raw) if raw.strip() else {}
        except ValueError as e:
            raise ConnectionError(f"非 JSON 响应: {raw[:80]!r}") from e

    def _ok(self) -> None:
        self.fail_streak = 0
        self.last_error = ""
        self.last_ok_at = time.time()

    def _fail(self, e: Exception) -> None:
        self.fail_streak += 1
        self.last_error = str(e)

    def console_available(self) -> bool:
        now = time.time()
        if now - self._console_at > REDISCOVER_S:
            self._console_at = now
            self._console_ok = console_state() is not None
        return self._console_ok

    def _maybe_rediscover(self) -> None:
        if self.explicit:
            return
        now = time.time()
        if now - self._rediscover_at < REDISCOVER_S:
            return
        self._rediscover_at = now
        found = discover_game_url()
        if found and found != self.base:
            self.base = found
            self.fail_streak = 0

    def _seed(self) -> None:
        """槽里现有文档的两个序号（服务刚起时问一次，之后靠自己数）。问不到就当 0。"""
        if self._seeded:
            return
        self._seeded = True
        try:
            res = self._request(DOC_PATH)
            doc = res.get("doc") if isinstance(res, dict) else None
        except (ConnectionError, ValueError, TypeError, AttributeError):
            return
        if not isinstance(doc, dict):
            return
        for key, attr in (("probe", "probe_seq"), ("walkProbe", "walk_seq")):
            pr = doc.get(key)
            try:
                seq = int(pr.get("seq", 0) or 0) if isinstance(pr, dict) else 0
            except (TypeError, ValueError):
                seq = 0
            setattr(self, attr, max(getattr(self, attr), seq))

    # ------------------------------------------------------------------ api
    def publish(self, burnables: dict | None, probe: dict | None = None, walk: dict | None = None) -> dict:
        """推一发。``burnables`` 为 None = 这一发不带工作态（只发探针 / 站位判定时，游戏不重建）。

        ``probe`` = ``{action, target, socket?, point?}``（在游戏里点着 / 熄灭 / 复原一个实例），序号这里发；
        ``walk`` = ``{sceneId, points}``（请游戏用它自己的 isCollision 判站位），点变了才发新序号。
        """
        payload: dict = {"writer": self.writer}
        out: dict = {}
        if probe:
            action = str(probe.get("action") or "")
            target = str(probe.get("target") or "").strip()
            if action not in PROBE_ACTIONS or not target:
                return {"ok": False, "err": f"探针要 action ∈ {PROBE_ACTIONS} + target（场景实体 id / 拿东西的人）"}
            self._seed()
            self.probe_seq += 1
            self.last_probe = {"seq": self.probe_seq, "action": action, "target": target}
            socket = str(probe.get("socket") or "").strip()
            if socket:
                self.last_probe["socket"] = socket
            pt = str(probe.get("point") or "").strip()
            if pt:
                self.last_probe["point"] = pt
        if walk:
            pts = _clean_points(walk.get("points"))
            sid = str(walk.get("sceneId") or "").strip()
            if sid and pts:
                same = self.last_walk and self.last_walk["sceneId"] == sid and self.last_walk["points"] == pts
                if not same or walk.get("force"):
                    self._seed()
                    self.walk_seq += 1
                    self.last_walk = {"seq": self.walk_seq, "sceneId": sid, "points": pts}
        if self.last_probe:
            payload["probe"] = self.last_probe
        if self.last_walk:
            payload["walkProbe"] = self.last_walk
        if isinstance(burnables, dict):
            payload["burnables"] = burnables
        try:
            res = self._request(DOC_PATH, payload)
        except SlotRejected as e:
            self._fail(e)
            return {"ok": False, "err": e.body or str(e), "connected": True, "rejected": True}
        except ConnectionError as e:
            self._fail(e)
            return {"ok": False, "err": str(e), "connected": False}
        self._ok()
        rev = int(res.get("rev") or 0)
        self.last_rev = max(self.last_rev, rev)
        self.published += 1
        out.update({"ok": True, "rev": rev, "connected": True})
        if self.last_probe:
            out["probeSeq"] = self.last_probe["seq"]
        if self.last_walk:
            out["walkSeq"] = self.last_walk["seq"]
        return out

    def status(self) -> dict:
        common = {"gameUrl": self.base, "lastRev": self.last_rev, "published": self.published,
                  "console": self.console_available(), "launchNote": self.launch_note,
                  "probeSeq": self.last_probe["seq"] if self.last_probe else 0,
                  "walkSeq": self.last_walk["seq"] if self.last_walk else 0}
        try:
            res = self._request(STATUS_PATH)
        except ConnectionError as e:
            self._fail(e)
            self._maybe_rediscover()
            return {"ok": True, "connected": False, "err": str(e), "doc": None, "ageMs": None,
                    "pages": [], **common, "gameUrl": self.base}
        self._ok()
        doc = res.get("doc")
        age = res.get("ageMs")
        alive = isinstance(doc, dict) and isinstance(age, (int, float)) and age < 6000
        pages = [p for p in (res.get("pages") or []) if isinstance(p, dict)]
        return {"ok": True, "connected": True, "gameAlive": bool(alive), "doc": doc if isinstance(doc, dict) else None,
                "ageMs": age, "pages": pages, **common}

    def set_base(self, url: str) -> str:
        self.base = normalize_base(url) or DEFAULT_GAME_URL
        self.explicit = True
        self.fail_streak = 0
        self.last_error = ""
        return self.base

    # ------------------------------------------------------------------ 一键拉起
    def launch(self, scene_id: str) -> dict:
        """让游戏进到 ``scene_id``（与声学 / 粒子台同一套四条路）。场景从「用在哪」的场景视图 / 第一个场景实体引用来。"""
        sid = (scene_id or "").strip()
        if not sid:
            return {"ok": False, "mode": "none", "message": "没有场景 id"}
        if self._launch_thread is not None and self._launch_thread.is_alive():
            return {"ok": False, "mode": "busy", "message": "上一次拉起还在等游戏服务起来"}
        st = self.status()
        if st.get("connected") and st.get("gameAlive"):
            r = enqueue_switch_scene(sid, target_boot_id=_boot_id_of(st.get("doc")))
            self.launch_note = f"已让游戏切到「{sid}」" if r.get("ok") else str(r.get("message") or "")
            return {"ok": bool(r.get("ok")), "mode": "switch",
                    "message": f"游戏已在跑：已让它切到「{sid}」" if r.get("ok") else str(r.get("message") or "")}
        if st.get("connected"):
            url = game_url_for(self.base, sid)
            how = self._open(url)
            self.launch_note = f"{how}：{url}"
            return {"ok": True, "mode": "open", "message": f"dev server 在跑、没开着游戏页：{how} {url}"}
        if console_state() is not None:
            ok, msg = console_open_dev_entry(sid)
            if not ok:
                return {"ok": False, "mode": "console", "message": f"开发控制台拒绝：{msg}"}
            self.launch_note = "控制台正在起游戏服务…"
            self._launch_thread = threading.Thread(target=self._follow_console, daemon=True)
            self._launch_thread.start()
            return {"ok": True, "mode": "console", "message": "已让开发控制台起游戏服务并打开场景页（约十几秒）"}
        proc = self.spawn_game_server()
        if proc is None:
            return {"ok": False, "mode": "start", "message": "起不了游戏服务（tools.dev game start 没起来）"}
        self.launch_note = "工作台自己起了游戏服务，等它听端口…"
        self._launch_thread = threading.Thread(target=self._follow_started, args=(sid,), daemon=True)
        self._launch_thread.start()
        return {"ok": True, "mode": "start", "message": "开发控制台没开：工作台自己起了游戏服务，端口通了自动打开场景页（约 15 秒）"}

    def _follow_console(self) -> None:
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline:
            cs = console_state()
            if cs and cs.get("gameRunning") and str(cs.get("gameUrl") or "").strip():
                base = normalize_base(str(cs["gameUrl"]))
                if _slot_alive(base):
                    self.base = base
                    self.explicit = False
                    self.fail_streak = 0
                    self.launch_note = f"控制台已起游戏服务 {base}"
                    return
            time.sleep(0.5)
        self.launch_note = f"等了 {int(START_WAIT_S)} 秒控制台还没报游戏地址（看控制台日志）"

    def _follow_started(self, sid: str) -> None:
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline:
            if _slot_alive(DEFAULT_GAME_URL):
                self.base = DEFAULT_GAME_URL
                self.explicit = False
                self.fail_streak = 0
                url = game_url_for(self.base, sid)
                self.launch_note = f"游戏服务已起，{self._open(url)}：{url}"
                return
            time.sleep(0.5)
        self.launch_note = f"等了 {int(START_WAIT_S)} 秒游戏服务还没听 5173（端口被占？用控制台看）"

    def _open(self, url: str) -> str:
        note = self.open_browser(url)
        return note if isinstance(note, str) and note else "已打开"

    @staticmethod
    def _spawn_game_server() -> subprocess.Popen | None:
        cmd = [sys.executable, "-m", "tools.dev", "game", "start"]
        kwargs: dict = {"cwd": str(ROOT), "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            return subprocess.Popen(cmd, **kwargs)
        except OSError:
            return None
