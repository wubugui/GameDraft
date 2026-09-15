# -*- coding: utf-8 -*-
"""工作台 ↔ 游戏的联动：走游戏 dev server（vite）上的**一对新槽**，外加一键拉起游戏进当前场景。

页面不直接 fetch 游戏的端口（跨源，vite 那两条中间件没有 CORS 头），一律经本工具的 Python 服务代理：

  工作台页 ──/api/link/publish──▶ 本服务 ──POST /__gamedraft-api/runtime-vfx────────▶ vite ──▶ 游戏
  工作台页 ◀──/api/link/status─── 本服务 ◀──GET  /__gamedraft-api/runtime-vfx-status── vite ◀── 游戏

两个槽方向不同（与声学同一条论述，见 `src/dev/runtimeVfxSync.ts` 文件头）：
  ``runtime-vfx``        工作台 → 游戏：正在编辑的效果 id + 工作态定义 + 一次刺激请求（序号 + 场 + 画面点）
                         + **整份工作态布置库**（``placements: {library, sceneId, phase}``）+ 切时段请求
                         （``phaseRequest: {seq, timePhase}``）。``rev`` 服务端自增
  ``runtime-vfx-status`` 游戏 → 工作台：场景、引用该效果的实例 id / 状态 / 只数、stats、玩家脚点、bootId、心跳、
                         此刻时段 / 外观键 / 用的是哪份布置（``timePhase`` / ``appearancePhase`` / ``placementsApplied``）。按页分桶

**两个序号（刺激 / 切时段）是「粘」的**：发过一次以后，之后每一发文档都带着**同一个**序号原样重发，
直到下一次请求把它加一。槽是整份覆盖的，游戏 400ms 才轮询一次——不粘的话，作者点完「让游戏切到这个时段」
紧跟着拖一下东西（120ms 防抖就发），那份带请求的文档还没被游戏读到就被盖掉了，而且一点痕迹都没有。
同一个序号重发不会重做（游戏只认比记住的大的），所以粘着是安全的。

**地址发现、拉起游戏、切场景这三件与声学逐字同一套**，所以直接 import 声学工作台那份
（`normalize_base / discover_game_url / game_url_for / console_state / console_open_dev_entry /
enqueue_switch_scene`）——第三份拷贝就是第三处会漂的地方。这里只加「vfx 槽活不活」的探针与
publish/status 的载荷。
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
from tools.dev.game_preview import open_game_preview

ROOT = Path(__file__).resolve().parents[2]
DOC_PATH = "/__gamedraft-api/runtime-vfx"
STATUS_PATH = "/__gamedraft-api/runtime-vfx-status"


def _get_json(url: str, timeout: float = TIMEOUT_S) -> dict | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=timeout) as r:
            raw = r.read().decode("utf-8")
        doc = json.loads(raw) if raw.strip() else None
        return doc if isinstance(doc, dict) else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _vfx_slot_alive(base: str) -> bool:
    """这个地址上跑的是不是我们的 vite（有粒子槽位中间件）。"""
    return _get_json(normalize_base(base) + STATUS_PATH, timeout=0.6) is not None


class SlotRejected(ConnectionError):
    """dev server 连上了、但把这份文档**拒了**（HTTP 4xx/5xx）。文字 = 它回的 body，原样给页面看，别吞。"""

    def __init__(self, code: int, body: str):
        super().__init__(f"HTTP {code} {body}".strip())
        self.code = code
        self.body = body


def _boot_id_of(doc) -> str | None:
    """状态文档里那页的实例 id：显式 ``bootId``，没有就从 ``writer``（``game:<bootId>``）里抠。"""
    if not isinstance(doc, dict):
        return None
    b = str(doc.get("bootId") or "").strip()
    if b:
        return b
    w = str(doc.get("writer") or "")
    return w[5:] or None if w.startswith("game:") else None


class VfxLink:
    def __init__(self, base_url: str = "", writer: str = ""):
        self.explicit = bool(normalize_base(base_url))
        self.base = normalize_base(base_url) or discover_game_url()
        self.writer = writer or f"vfx-workbench:{os.getpid()}"
        self.published = 0
        self.last_rev = 0
        #: 刺激 / 切时段的序号由服务端发（页面刷新后从 0 数起会被游戏当旧序号吞掉）
        self.probe_seq = 0
        self.phase_seq = 0
        self._slot_seq_seeded = False
        #: 最近一次的刺激 / 切时段请求（带着序号）：之后每一发都原样重发（见模块文档「粘」）
        self.last_probe: dict | None = None
        self.last_phase_request: dict | None = None
        #: 每个效果最近一份**过了形状闸门**的定义：作者改到一半效果暂时不合法时推它，布置照推（见 serve 的 publish）
        self._good_defs: dict[str, dict] = {}
        self.fail_streak = 0
        self.last_error = ""
        self.last_ok_at = 0.0
        self._rediscover_at = 0.0
        self._console_at = 0.0
        self._console_ok = False
        self.launch_note = ""
        self._launch_thread: threading.Thread | None = None
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
        """控制台在不在（缓存几秒；状态轮询 400ms 一次，不能每次都去敲它）。"""
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
    def remember_good_def(self, effect_id: str, definition: dict) -> None:
        """记下这份过了闸门的定义（只留最近一份；进程内，不落盘）。"""
        if effect_id and isinstance(definition, dict):
            self._good_defs[effect_id] = definition

    def good_def(self, effect_id: str) -> dict | None:
        return self._good_defs.get(effect_id)

    def publish(self, effect_id: str, definition: dict, probe: dict | None = None,
                scene_id: str | None = None, placements: dict | None = None,
                phase_request: dict | None = None) -> dict:
        """把工作态效果推给游戏。

        ``probe`` = 一次刺激：``{field: VfxFieldDef, at: {x, y, h}}``（画面点 + 离地高）；
        ``placements`` = ``{library, sceneId, phase}``（整份工作态布置库，调用方已过形状闸门）；
        ``phase_request`` = ``{timePhase}``（「让游戏切到这个时段」，序号这里发）。
        刺激与切时段请求发过之后一直粘在后续文档里（同一个序号，见模块文档）。
        """
        payload: dict = {"writer": self.writer, "effectId": effect_id, "def": definition}
        if probe:
            self._seed_slot_seqs()
            seq = max(self.probe_seq, int(probe.get("seq", 0) or 0)) + 1
            self.probe_seq = seq
            at = probe.get("at") if isinstance(probe.get("at"), dict) else {}
            self.last_probe = {
                "seq": seq,
                "field": probe.get("field") or {},
                "at": {"x": float(at.get("x", 0)), "y": float(at.get("y", 0)), "h": float(at.get("h", 0))},
            }
        tp = str((phase_request or {}).get("timePhase") or "").strip()
        if tp:
            self._seed_slot_seqs()
            seq = max(self.phase_seq, int((phase_request or {}).get("seq", 0) or 0)) + 1
            self.phase_seq = seq
            self.last_phase_request = {"seq": seq, "timePhase": tp}
        if self.last_probe:
            payload["probe"] = self.last_probe
        if self.last_phase_request:
            payload["phaseRequest"] = self.last_phase_request
        if scene_id:
            payload["sceneId"] = scene_id
        if isinstance(placements, dict):
            payload["placements"] = placements
        try:
            res = self._request(DOC_PATH, payload)
        except SlotRejected as e:
            # dev server 在、但拒了这份（形状不对）：原样把它说的话给页面，别当成"连不上"
            self._fail(e)
            return {"ok": False, "err": e.body or str(e), "connected": True, "rejected": True}
        except ConnectionError as e:
            self._fail(e)
            return {"ok": False, "err": str(e), "connected": False}
        self._ok()
        rev = int(res.get("rev") or 0)
        self.last_rev = max(self.last_rev, rev)
        self.published += 1
        out: dict = {"ok": True, "rev": rev, "connected": True}
        if probe:
            out["probeSeq"] = self.last_probe["seq"]
        if tp:
            out["phaseSeq"] = self.last_phase_request["seq"]
        return out

    def _seed_slot_seqs(self) -> None:
        """槽里现有文档的刺激 / 切时段序号（服务刚起时问一次，之后靠自己数）。问不到就当 0。"""
        if self._slot_seq_seeded:
            return
        self._slot_seq_seeded = True
        try:
            res = self._request(DOC_PATH)
            doc = res.get("doc") if isinstance(res, dict) else None
        except (ConnectionError, ValueError, TypeError, AttributeError):
            return
        if not isinstance(doc, dict):
            return
        for key, attr in (("probe", "probe_seq"), ("phaseRequest", "phase_seq")):
            pr = doc.get(key)
            try:
                seq = int(pr.get("seq", 0) or 0) if isinstance(pr, dict) else 0
            except (TypeError, ValueError):
                seq = 0
            setattr(self, attr, max(getattr(self, attr), seq))

    def status(self) -> dict:
        common = {"gameUrl": self.base, "lastRev": self.last_rev, "published": self.published,
                  "console": self.console_available(), "launchNote": self.launch_note}
        try:
            res = self._request(STATUS_PATH)
        except ConnectionError as e:
            self._fail(e)
            self._maybe_rediscover()
            return {"ok": True, "connected": False, "err": str(e), "doc": None, "ageMs": None,
                    "pages": [], "otherPages": [], **common, "gameUrl": self.base}
        self._ok()
        doc = res.get("doc")
        age = res.get("ageMs")
        # 游戏每 2s 至少回传一次心跳；槽里的文档超过 6s 没更新 = 游戏没在跑（vite 还开着）
        alive = isinstance(doc, dict) and isinstance(age, (int, float)) and age < 6000
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
        """让游戏进到 ``scene_id``（四条路与声学工作台同一套，见那份 ``GameLink.launch`` 的论述）。"""
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
            return {"ok": bool(r.get("ok")), "mode": "switch",
                    "message": f"游戏已在跑：已让它切到「{sid}」（轮询到就切，场景大的要几秒）" if r.get("ok") else str(r.get("message") or ""),
                    "gameUrl": self.base}
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
                if _vfx_slot_alive(base):
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
            if _vfx_slot_alive(DEFAULT_GAME_URL):
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
        note = self.open_browser(url)
        return note if isinstance(note, str) and note else "已打开"

    @staticmethod
    def _spawn_game_server() -> subprocess.Popen | None:
        """与控制台同一条起法：``python -m tools.dev game start``（vite strictPort 5173）。"""
        cmd = [sys.executable, "-m", "tools.dev", "game", "start"]
        kwargs: dict = {"cwd": str(ROOT), "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        try:
            return subprocess.Popen(cmd, **kwargs)
        except OSError:
            return None
