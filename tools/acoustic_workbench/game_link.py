# -*- coding: utf-8 -*-
"""工作台 ↔ 游戏的联动：走游戏 dev server（vite）上的两个文件槽，外加**一键拉起游戏进到当前场景**。

页面不直接 fetch 游戏的端口（跨源，vite 那两条中间件没有 CORS 头），一律经本工具的 Python 服务代理：

  工作台页 ──/api/link/publish──▶ 本服务 ──POST /__gamedraft-api/runtime-acoustics────────▶ vite ──▶ 游戏
  工作台页 ◀──/api/link/status─── 本服务 ◀──GET  /__gamedraft-api/runtime-acoustics-status── vite ◀── 游戏
  工作台页 ──/api/link/launch───▶ 本服务 ──▶ 游戏在跑：切场景命令 / dev server 在跑：开页 / 都没有：让控制台起游戏（没控制台就自己起）

游戏地址：环境变量 ``GAMEDRAFT_GAME_URL`` > 开发控制台 ``/api/state`` 的 ``gameUrl``（它盯着 vite 输出）
> 根目录 ``devstate.json`` 的 ``gameUrl`` > 缺省 ``http://127.0.0.1:5173``。连不上时每几秒重新发现一次，
控制台把游戏起来后工作台自动跟上。⚠ ``localhost`` 一律换成 ``127.0.0.1``：vite 只听 IPv4，urllib 先试 ``::1``
会把每一发都等到超时（scene_lights 那边踩过，实测 3s vs 0.00s）。

游戏没起时不是错误：``status()`` 返回 ``connected=False``，工作台照常工作，只是没有预览。
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
from urllib.parse import urlencode

# 游戏页一律开在专用预览窗（免手势音频、不后台降级、不缓存），不丢给系统浏览器——见 tools/dev/game_preview.py
from tools.dev.game_preview import open_game_preview

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GAME_URL = "http://127.0.0.1:5173"
DEFAULT_CONSOLE_URL = "http://127.0.0.1:8765"
DOC_PATH = "/__gamedraft-api/runtime-acoustics"
STATUS_PATH = "/__gamedraft-api/runtime-acoustics-status"
TIMEOUT_S = 0.8
#: 重新发现游戏地址的最小间隔（连不上时）
REDISCOVER_S = 3.0
#: 起游戏服务后等它听端口的上限
START_WAIT_S = 60.0


def normalize_base(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    if "://" not in u:
        u = "http://" + u
    return u.replace("//localhost:", "//127.0.0.1:").replace("//localhost/", "//127.0.0.1/")


def console_url() -> str:
    return normalize_base(os.environ.get("GAMEDRAFT_CONSOLE_URL", "")) or DEFAULT_CONSOLE_URL


def _get_json(url: str, timeout: float = TIMEOUT_S) -> dict | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as r:
            raw = r.read().decode("utf-8")
        doc = json.loads(raw) if raw.strip() else None
        return doc if isinstance(doc, dict) else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def console_state(base: str | None = None) -> dict | None:
    """开发控制台的状态（``gameRunning`` / ``gameUrl`` …）；控制台没开返回 None。"""
    return _get_json((base or console_url()) + "/api/state?since=2000000000")


def console_open_dev_entry(scene_id: str, base: str | None = None) -> tuple[bool, str]:
    """让开发控制台起游戏服务（已在跑就复用）并用浏览器打开 ``?mode=dev&devScene=<scene>``——与控制台页上
    「直达场景」同一条动作。"""
    url = (base or console_url()) + "/api/action"
    body = json.dumps({"action": "open_dev_entry", "kind": "scene", "value": scene_id}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("message") or f"HTTP {e.code}"
        except Exception:  # noqa: BLE001
            msg = f"HTTP {e.code}"
        return False, str(msg)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return False, str(getattr(e, "reason", e))
    try:
        doc = json.loads(raw)
    except ValueError:
        return False, "控制台返回了非 JSON"
    return bool(doc.get("ok")), str(doc.get("message") or "")


def discover_game_url(root: Path = ROOT) -> str:
    env = os.environ.get("GAMEDRAFT_GAME_URL", "").strip()
    if env:
        return normalize_base(env)
    cs = console_state()
    if cs and cs.get("gameRunning") and str(cs.get("gameUrl") or "").strip():
        return normalize_base(str(cs["gameUrl"]))
    try:
        st = json.loads((root / "devstate.json").read_text(encoding="utf-8"))
        url = str(st.get("gameUrl") or "").strip()
        if url and st.get("gameRunning"):
            return normalize_base(url)
    except (OSError, ValueError):
        pass
    return DEFAULT_GAME_URL


def game_url_for(base: str, scene_id: str) -> str:
    """游戏页地址：dev 外壳 + 直达场景。"""
    return f"{normalize_base(base) or DEFAULT_GAME_URL}/?{urlencode({'mode': 'dev', 'devScene': scene_id})}"


def _acoustics_slot_alive(base: str) -> bool:
    """这个地址上跑的是不是我们的 vite（有声学槽位中间件）。"""
    return _get_json(normalize_base(base) + STATUS_PATH, timeout=0.6) is not None


class GameLink:
    def __init__(self, base_url: str = "", writer: str = ""):
        self.explicit = bool(normalize_base(base_url))
        self.base = normalize_base(base_url) or discover_game_url()
        self.writer = writer or f"workbench:{os.getpid()}"
        self.published = 0
        self.last_rev = 0
        # 试听序号由服务端发；起点第一次从槽里现有文档取（服务重启也接得上）
        self.probe_seq = 0
        self._slot_seq_seeded = False
        self.fail_streak = 0
        self.last_error = ""
        self.last_ok_at = 0.0
        self._rediscover_at = 0.0
        self._console_at = 0.0
        self._console_ok = False
        self.launch_note = ""
        self._launch_thread: threading.Thread | None = None
        # 钩子：测试里替换掉，别真开浏览器 / 真起进程。返回值是一句人话（走了哪条路），写进 launch_note
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
                detail = e.read().decode("utf-8", "replace")[:200]
            except Exception:  # noqa: BLE001
                pass
            raise ConnectionError(f"HTTP {e.code} {detail}".strip()) from e
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
        """控制台在不在（缓存 3 秒；状态轮询 400ms 一次，不能每次都去敲它）。"""
        now = time.time()
        if now - self._console_at > REDISCOVER_S:
            self._console_at = now
            self._console_ok = console_state() is not None
        return self._console_ok

    def _maybe_rediscover(self) -> None:
        """连不上时每几秒重新发现一次地址（控制台把游戏起来后自动跟上）。显式指定过地址就不动。"""
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

    # ------------------------------------------------------------------ api
    def publish(self, space_id: str, definition: dict, probe: dict | None = None,
                scene_id: str | None = None) -> dict:
        payload: dict = {"writer": self.writer, "spaceId": space_id, "def": definition}
        if probe:
            # 试听序号由服务端发：页面一刷新就从 0 数起，游戏只认「比记住的大」的序号，前 N 次点击会被静默吞掉。
            # 起点取槽里现有的序号（服务重启也接得上），客户端给的只当下限。
            seq = max(self.probe_seq, self._slot_probe_seq(), int(probe.get("seq", 0) or 0)) + 1
            self.probe_seq = seq
            pr: dict = {"seq": seq, "sfxId": str(probe.get("sfxId") or "")}
            at = probe.get("at")
            if isinstance(at, dict):
                # 从哪个发声点播（wu，M-world）；不给 = 听者自己喊
                pr["at"] = {"x": float(at.get("x", 0)), "y": float(at.get("y", 0)), "z": float(at.get("z", 0))}
            payload["probe"] = pr
        if scene_id:
            payload["sceneId"] = scene_id
        try:
            res = self._request(DOC_PATH, payload)
        except ConnectionError as e:
            self._fail(e)
            return {"ok": False, "err": str(e), "connected": False}
        self._ok()
        rev = int(res.get("rev") or 0)
        self.last_rev = max(self.last_rev, rev)
        self.published += 1
        out = {"ok": True, "rev": rev, "connected": True}
        if probe:
            out["probeSeq"] = payload["probe"]["seq"]
        return out

    def _slot_probe_seq(self) -> int:
        """槽里现有文档的试听序号（服务刚起时问一次，之后靠自己数）。问不到就 0。"""
        if self._slot_seq_seeded:
            return 0
        self._slot_seq_seeded = True
        try:
            res = self._request(DOC_PATH)
            doc = res.get("doc") if isinstance(res, dict) else None
            pr = doc.get("probe") if isinstance(doc, dict) else None
            return int(pr.get("seq", 0) or 0) if isinstance(pr, dict) else 0
        except (ConnectionError, ValueError, TypeError, AttributeError):
            return 0

    def status(self) -> dict:
        common = {"gameUrl": self.base, "lastRev": self.last_rev, "published": self.published,
                  "console": self.console_available(), "launchNote": self.launch_note}
        try:
            res = self._request(STATUS_PATH)
        except ConnectionError as e:
            self._fail(e)
            self._maybe_rediscover()
            return {"ok": True, "connected": False, "err": str(e), "doc": None, "ageMs": None, **common, "gameUrl": self.base}
        self._ok()
        doc = res.get("doc")
        age = res.get("ageMs")
        # 游戏每 2s 至少回传一次心跳；槽里的文档超过 6s 没更新 = 游戏没在跑（vite 还开着）
        alive = isinstance(doc, dict) and isinstance(age, (int, float)) and age < 6000
        # 槽按页分开存：doc 是它挑出来的那页（最新开的），其余还活着的页列出来——两个页会抢同一条通道，得让作者关掉旧的
        pages = [p for p in (res.get("pages") or []) if isinstance(p, dict)]
        mine = doc.get("writer") if isinstance(doc, dict) else None
        others = [p for p in pages if p.get("writer") != mine and isinstance(p.get("ageMs"), (int, float)) and p["ageMs"] < 6000]
        return {"ok": True, "connected": True, "gameAlive": bool(alive), "doc": doc if isinstance(doc, dict) else None,
                "ageMs": age, "pages": pages, "otherPages": others, **common}

    def set_base(self, url: str) -> str:
        self.base = normalize_base(url) or DEFAULT_GAME_URL
        self.explicit = True
        self.fail_streak = 0
        self.last_error = ""
        return self.base

    # ------------------------------------------------------------------ 一键拉起
    def launch(self, scene_id: str, force_open: bool = False) -> dict:
        """让游戏进到 ``scene_id``：

        1. 游戏页已在跑 → 运行时命令队列 ``debugSwitchScene``（不开第二个页；命令带 targetBootId，
           多开页签时只指挥槽挑出来的那页）；
        2. dev server 在跑但没开着游戏页 → 专用预览窗打开 ``?mode=dev&devScene=<scene>``；
        3. 什么都没有 → 让开发控制台起游戏服务并开页（它盯着 vite 输出、管进程）；
           控制台也没开 → 工作台自己起 ``tools.dev game start``，等端口通了再开页。
        ``force_open``：游戏页明明在跑也开一个专用预览窗——作者那页跑在普通浏览器里（音频锁着）时用。
        返回立刻，起服务的等待在后台线程里，进度写进 ``launch_note``（状态轮询带回页面）。
        """
        sid = (scene_id or "").strip()
        if not sid:
            return {"ok": False, "mode": "none", "message": "没有场景 id"}
        if self._launch_thread is not None and self._launch_thread.is_alive():
            return {"ok": False, "mode": "busy", "message": "上一次拉起还在等游戏服务起来"}
        st = self.status()
        if force_open and st.get("connected"):
            url = game_url_for(self.base, sid)
            how = self._open(url)
            self.launch_note = f"{how}：{url}"
            return {"ok": True, "mode": "open", "message": f"{how} {url}。原来那个游戏页记得关掉，两个页会抢同一条通道", "gameUrl": self.base}
        if st.get("connected") and st.get("gameAlive"):
            r = enqueue_switch_scene(sid, target_boot_id=_boot_id_of(st.get("doc")))
            self.launch_note = f"已让游戏切到「{sid}」" if r.get("ok") else str(r.get("message") or "")
            return {"ok": bool(r.get("ok")), "mode": "switch", "message": f"游戏已在跑：已让它切到「{sid}」（轮询到就切，场景大的要几秒）" if r.get("ok") else str(r.get("message") or ""), "gameUrl": self.base}
        if st.get("connected"):
            url = game_url_for(self.base, sid)
            how = self._open(url)
            self.launch_note = f"{how}：{url}"
            return {"ok": True, "mode": "open", "message": f"dev server 在跑、没开着游戏页：{how} {url}", "gameUrl": self.base}
        if console_state() is not None:
            ok, msg = console_open_dev_entry(sid)
            if not ok:
                return {"ok": False, "mode": "console", "message": f"开发控制台拒绝：{msg}"}
            self.launch_note = "控制台正在起游戏服务…"
            self._launch_thread = threading.Thread(target=self._follow_console, args=(sid,), daemon=True)
            self._launch_thread.start()
            return {"ok": True, "mode": "console", "message": "已让开发控制台起游戏服务并打开场景页（约十几秒，起来后这里自动接上）", "gameUrl": self.base}
        proc = self.spawn_game_server()
        if proc is None:
            return {"ok": False, "mode": "start", "message": "起不了游戏服务（tools.dev game start 没起来）"}
        self.launch_note = "工作台自己起了游戏服务，等它听端口…"
        self._launch_thread = threading.Thread(target=self._follow_started, args=(sid,), daemon=True)
        self._launch_thread.start()
        return {"ok": True, "mode": "start", "message": "开发控制台没开：工作台自己起了游戏服务，端口通了会自动打开场景页（约 15 秒）", "gameUrl": self.base}

    def _follow_console(self, sid: str) -> None:
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline:
            cs = console_state()
            if cs and cs.get("gameRunning") and str(cs.get("gameUrl") or "").strip():
                base = normalize_base(str(cs["gameUrl"]))
                if _acoustics_slot_alive(base):
                    self.base = base
                    self.explicit = False
                    self.fail_streak = 0
                    self.launch_note = f"控制台已起游戏服务 {base}，场景页由它打开"
                    return
            time.sleep(0.5)
        self.launch_note = f"等了 {int(START_WAIT_S)} 秒控制台还没报游戏地址（看控制台日志）"

    def _follow_started(self, sid: str) -> None:
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline:
            if _acoustics_slot_alive(DEFAULT_GAME_URL):
                self.base = DEFAULT_GAME_URL
                self.explicit = False
                self.fail_streak = 0
                url = game_url_for(self.base, sid)
                how = self._open(url)
                self.launch_note = f"游戏服务已起，{how}：{url}"
                return
            time.sleep(0.5)
        self.launch_note = f"等了 {int(START_WAIT_S)} 秒游戏服务还没听 5173（端口被占？用控制台看）"

    def _open(self, url: str) -> str:
        """开游戏页，返回一句人话（钩子被测试换成返回 True / None 的替身时也给个说法）。"""
        note = self.open_browser(url)
        return note if isinstance(note, str) and note else "已打开"

    @staticmethod
    def _spawn_game_server() -> subprocess.Popen | None:
        """与控制台同一条起法：``python -m tools.dev game start``（vite strictPort 5173）。
        detached：工作台关掉它也留着（和控制台起的一样，用控制台的「停止游戏」收）。"""
        cmd = [sys.executable, "-m", "tools.dev", "game", "start"]
        kwargs: dict = {"cwd": str(ROOT), "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            return subprocess.Popen(cmd, **kwargs)
        except OSError:
            return None


def _boot_id_of(doc) -> str | None:
    """状态文档里那页的实例 id：显式 ``bootId``，没有就从 ``writer``（``game:<bootId>``）里抠。"""
    if not isinstance(doc, dict):
        return None
    b = str(doc.get("bootId") or "").strip()
    if b:
        return b
    w = str(doc.get("writer") or "")
    return w[5:] or None if w.startswith("game:") else None


def enqueue_switch_scene(scene_id: str, root: Path = ROOT, target_boot_id: str | None = None) -> dict:
    """让游戏切到某个场景：走现有的运行时命令队列（生产工作台那条，游戏在轮询它）。

    ``target_boot_id``：只让这一页执行（多开页签时其它页会把命令留在队列里）；不给就谁先轮到谁切。
    """
    from tools.production_workbench.runtime_command import enqueue_runtime_command
    payload: dict = {"sceneId": scene_id}
    if target_boot_id:
        payload["targetBootId"] = target_boot_id
    rep = enqueue_runtime_command(root, "debugSwitchScene", reason="acoustic-workbench: 切到正在编辑的场景",
                                  payload=payload)
    return {"ok": bool(rep.ok), "message": rep.message, "queued": len(rep.commands)}
