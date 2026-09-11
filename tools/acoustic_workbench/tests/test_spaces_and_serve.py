# -*- coding: utf-8 -*-
"""空间库读写（v2 形状、原子写、.bak、id 护栏）+ 服务端 API（进程内真服务）+ 与游戏槽位的联动（假 vite）。

写盘类用例全部指到 tmp 目录，绝不碰工程库。联动用一个进程内的假 vite（实现两个槽位的 GET/POST 语义），
断言"工作台发出去的文档带 rev、游戏回传的状态能读到"。
"""
from __future__ import annotations

import json
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.acoustic_workbench import game_link, spaces  # noqa: E402

GOOD = {
    "label": "测试",
    "authoring": {"sceneId": "跑马梁"},
    "distanceScale": 12,
    "earHeight": 141,
    "listener": {"x": 0, "z": 0, "y": 0},
    "reflectors": [{"id": "对崖", "a": [-880, 1760], "b": [880, 1760], "height": 440, "absorb": 0.05, "rough": 0.3}],
    "order": 2, "tail": {"seconds": 3, "gain": 0.1}, "air": {"tempC": 5}, "width": 0.8, "occlusion": True,
}


# ---------------------------------------------------------------------------
# spaces
# ---------------------------------------------------------------------------

class TestSpaces:
    def test_id_guard(self) -> None:
        assert spaces.valid_id("山谷_大") and spaces.valid_id("valley-1")
        for bad in ("", " pad", "a/b", "a\\b", "a:b", ".hidden", "x?y", "a" * 200, "a\nb"):
            assert not spaces.valid_id(bad), bad

    def test_normalize_keeps_int_and_drops_defaults(self) -> None:
        n = spaces.normalize_def(GOOD)
        assert n["distanceScale"] == 12 and isinstance(n["distanceScale"], int)
        assert n["reflectors"][0]["a"] == [-880, 1760]
        assert "y" not in n["reflectors"][0] and "tiltDeg" not in n["reflectors"][0]
        assert list(n.keys())[:5] == ["label", "authoring", "distanceScale", "earHeight", "listener"]
        n2 = spaces.normalize_def({**GOOD, "reflectors": [{**GOOD["reflectors"][0], "y": 12.34567, "tiltDeg": 90}]})
        assert n2["reflectors"][0]["y"] == 12.346 and n2["reflectors"][0]["tiltDeg"] == 90

    def test_normalize_rejects_broken(self) -> None:
        with pytest.raises(ValueError):
            spaces.normalize_def({**GOOD, "distanceScale": 0})
        with pytest.raises(ValueError):
            spaces.normalize_def({**GOOD, "reflectors": [{"a": [0, 0], "b": [0, 0], "height": 10, "absorb": 0, "rough": 0}]})
        with pytest.raises(ValueError):
            spaces.normalize_def({**GOOD, "reflectors": [{"a": [0, 0], "b": [1, 1], "height": 0, "absorb": 0, "rough": 0}]})
        with pytest.raises(ValueError):
            spaces.normalize_def({**GOOD, "reflectors": [{"a": [0, 0], "b": [1, 1], "height": 5, "absorb": 2, "rough": 0}]})
        with pytest.raises(ValueError):
            spaces.normalize_def({**GOOD, "listener": None})

    def test_save_is_atomic_lf_and_keeps_bak(self, tmp_path) -> None:
        p = tmp_path / "acoustic_spaces.json"
        spaces.save_space("a", GOOD, p)
        raw = p.read_bytes()
        assert raw.endswith(b"\n") and b"\r\n" not in raw
        doc = json.loads(raw.decode("utf-8"))
        assert list(doc.keys()) == ["_comment", "spaces"] and "a" in doc["spaces"]
        spaces.save_space("b", GOOD, p)
        assert (tmp_path / "acoustic_spaces.json.bak").exists()
        assert not (tmp_path / "acoustic_spaces.json.tmp").exists()
        assert set(spaces.load_library(p)["spaces"]) == {"a", "b"}

    def test_create_delete_rename_duplicate(self, tmp_path, monkeypatch) -> None:
        p = tmp_path / "acoustic_spaces.json"
        monkeypatch.setattr(spaces, "scene_bindings", lambda *a, **k: {"a": ["某场景"]})
        d = spaces.create_space("a", "跑马梁", "background.png", "说明", p)
        assert d["authoring"] == {"sceneId": "跑马梁", "background": "background.png"} and d["reflectors"] == []
        with pytest.raises(FileExistsError):
            spaces.create_space("a", "跑马梁", "", "", p)
        with pytest.raises(ValueError):
            spaces.rename_space("a", "b", p)          # 被场景绑定着：拒绝
        spaces.duplicate_space("a", "c", p)
        assert set(spaces.load_library(p)["spaces"]) == {"a", "c"}
        spaces.rename_space("c", "d", p)
        assert set(spaces.load_library(p)["spaces"]) == {"a", "d"}
        assert spaces.delete_space("d", p) and not spaces.delete_space("d", p)
        assert spaces.unique_id("a", ["a", "a_2"]) == "a_3"

    def test_shipped_library_is_v2(self) -> None:
        """现网那份必须已迁移：v1 残留 = 两套坐标系。"""
        lib = spaces.load_library()
        assert lib["spaces"], "库不能为空"
        for name, sp in lib["spaces"].items():
            assert "anchor" not in sp and "wuPerMeter" not in sp, name
            assert sp.get("distanceScale", 0) > 0, name
            assert sp.get("authoring", {}).get("sceneId"), name
            spaces.normalize_def(sp)


# ---------------------------------------------------------------------------
# 假 vite：两个槽位
# ---------------------------------------------------------------------------

class _FakeVite(BaseHTTPRequestHandler):
    doc: dict | None = None
    status: dict | None = None

    def log_message(self, *a):  # noqa: D401
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == game_link.DOC_PATH:
            return self._json({"doc": _FakeVite.doc, "ageMs": 10 if _FakeVite.doc else None})
        if self.path == game_link.STATUS_PATH:
            return self._json({"doc": _FakeVite.status, "ageMs": 100 if _FakeVite.status else None})
        return self._json({"err": "404"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == game_link.DOC_PATH:
            rev = (_FakeVite.doc or {}).get("rev", 0) + 1
            _FakeVite.doc = {**body, "rev": rev}
            return self._json({"rev": rev})
        if self.path == game_link.STATUS_PATH:
            _FakeVite.status = body
            return self._json({"ok": True})
        return self._json({"err": "404"}, 404)


@pytest.fixture
def fake_vite():
    _FakeVite.doc = None
    _FakeVite.status = None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeVite)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()


class TestGameLink:
    def test_normalize_base(self) -> None:
        assert game_link.normalize_base("http://localhost:5173/") == "http://127.0.0.1:5173"
        assert game_link.normalize_base("localhost:5191") == "http://127.0.0.1:5191"
        assert game_link.normalize_base("") == ""

    def test_publish_and_status_roundtrip(self, fake_vite) -> None:
        link = game_link.GameLink(fake_vite, writer="workbench:test")
        r = link.publish("a", GOOD, probe={"seq": 3, "sfxId": "sfx_gibbon_dry_a"}, scene_id="跑马梁")
        assert r["ok"] and r["rev"] == 1
        # 试听序号由服务端发（页面刷新后从 0 数起会被游戏吞掉）：客户端给的只是下限，发出去的是 max+1 并回给页面
        assert _FakeVite.doc["writer"] == "workbench:test" and _FakeVite.doc["probe"] == {"seq": 4, "sfxId": "sfx_gibbon_dry_a"}
        assert r["probeSeq"] == 4
        r2 = link.publish("a", GOOD)
        assert r2["rev"] == 2 and link.last_rev == 2 and link.published == 2 and "probeSeq" not in r2
        r3 = link.publish("a", GOOD, probe={"seq": 1, "sfxId": "x"})
        assert _FakeVite.doc["probe"]["seq"] == 5 and r3["probeSeq"] == 5   # 页面刷新后从 1 数起也不会倒退
        st = link.status()
        assert st["connected"] and st["doc"] is None and st["gameAlive"] is False
        _FakeVite.status = {"writer": "game:x", "sceneId": "跑马梁", "appliedRev": 2}
        st = link.status()
        assert st["gameAlive"] and st["doc"]["appliedRev"] == 2

    def test_unreachable_is_not_an_exception(self, monkeypatch) -> None:
        monkeypatch.setattr(game_link, "console_state", lambda *a, **k: None)
        link = game_link.GameLink("http://127.0.0.1:1", writer="w")
        r = link.publish("a", GOOD)
        assert r["ok"] is False and r["connected"] is False
        st = link.status()
        assert st["connected"] is False and link.fail_streak == 2 and st["console"] is False

    def test_game_url_for_scene_uses_dev_shell_and_direct_entry(self) -> None:
        assert game_link.game_url_for("http://localhost:5173/", "跑马梁") == \
            "http://127.0.0.1:5173/?mode=dev&devScene=%E8%B7%91%E9%A9%AC%E6%A2%81"


class _FakeConsole(BaseHTTPRequestHandler):
    """开发控制台的替身：/api/state 报 gameRunning/gameUrl，/api/action 记下 open_dev_entry 并"起"游戏。"""
    state: dict = {"gameRunning": False, "gameUrl": ""}
    actions: list[dict] = []
    on_open: object = None

    def log_message(self, *a):  # noqa: D401
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/state"):
            return self._json({**_FakeConsole.state, "logs": []})
        return self._json({"err": "404"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/action":
            _FakeConsole.actions.append(body)
            if body.get("action") == "open_dev_entry" and callable(_FakeConsole.on_open):
                _FakeConsole.on_open(body)
            return self._json({"ok": True, "message": "opening"})
        return self._json({"ok": False, "message": "404"}, 404)


@pytest.fixture
def fake_console(monkeypatch):
    _FakeConsole.state = {"gameRunning": False, "gameUrl": ""}
    _FakeConsole.actions = []
    _FakeConsole.on_open = None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeConsole)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    monkeypatch.setenv("GAMEDRAFT_CONSOLE_URL", base)
    try:
        yield base
    finally:
        httpd.shutdown()


class TestLaunch:
    """一键拉起的四条路：游戏在跑→切场景；dev server 在跑→开页；控制台在→让它起；都没有→自己起。
    全部用替身：绝不真开浏览器、真起 vite。"""

    def test_default_open_hook_is_the_dedicated_preview_window(self) -> None:
        """游戏页不丢给系统浏览器：缺省钩子就是专用预览窗（免手势音频、不后台降级）。"""
        from tools.dev.game_preview import open_game_preview
        assert game_link.GameLink("http://127.0.0.1:1", writer="w").open_browser is open_game_preview

    def _link(self, monkeypatch, base):
        link = game_link.GameLink(base, writer="w")
        opened, spawned = [], []
        link.open_browser = lambda url: opened.append(url) or True
        link.spawn_game_server = lambda: spawned.append(1) or object()
        self.switched = []
        monkeypatch.setattr(game_link, "enqueue_switch_scene",
                            lambda sid, root=None, target_boot_id=None: self.switched.append((sid, target_boot_id)) or {"ok": True, "message": "", "queued": 1})
        return link, opened, spawned

    def test_game_alive_switches_scene(self, fake_vite, monkeypatch) -> None:
        _FakeVite.status = {"writer": "game:x", "sceneId": "dev_room", "appliedRev": 0}
        link, opened, spawned = self._link(monkeypatch, fake_vite)
        r = link.launch("跑马梁")
        assert r["ok"] and r["mode"] == "switch" and not opened and not spawned
        # 命令只指挥槽挑出来的那页：targetBootId 从 writer「game:<bootId>」里抠（多开页签时其它页把它留在队列里）
        assert self.switched == [("跑马梁", "x")]

    def test_force_open_opens_a_preview_window_even_when_game_alive(self, fake_vite, monkeypatch) -> None:
        """作者那页跑在普通浏览器里（音频锁着）：forceOpen 另开专用预览窗，不去切那页。"""
        _FakeVite.status = {"writer": "game:x", "sceneId": "dev_room", "appliedRev": 0, "autoplayAllowed": False}
        link, opened, spawned = self._link(monkeypatch, fake_vite)
        r = link.launch("跑马梁", force_open=True)
        assert r["ok"] and r["mode"] == "open" and not self.switched and not spawned
        assert opened and opened[0].endswith("?mode=dev&devScene=%E8%B7%91%E9%A9%AC%E6%A2%81")

    def test_vite_up_but_no_page_opens_browser(self, fake_vite, monkeypatch) -> None:
        link, opened, spawned = self._link(monkeypatch, fake_vite)
        r = link.launch("跑马梁")
        assert r["ok"] and r["mode"] == "open" and not spawned
        assert opened == [game_link.game_url_for(fake_vite, "跑马梁")]

    def test_nothing_running_asks_console_and_follows_its_game_url(self, fake_console, fake_vite, monkeypatch) -> None:
        link, opened, spawned = self._link(monkeypatch, "http://127.0.0.1:1")
        # 控制台收到 open_dev_entry 后"起"了游戏：把假 vite 的地址报出来
        _FakeConsole.on_open = lambda body: _FakeConsole.state.update({"gameRunning": True, "gameUrl": fake_vite + "/"})
        r = link.launch("跑马梁")
        assert r["ok"] and r["mode"] == "console" and not spawned and not opened
        assert _FakeConsole.actions == [{"action": "open_dev_entry", "kind": "scene", "value": "跑马梁"}]
        link._launch_thread.join(10)
        assert link.base == fake_vite, "控制台报了地址就该跟上"
        assert "已起" in link.launch_note

    def test_no_console_spawns_server_and_opens_when_port_answers(self, fake_vite, monkeypatch) -> None:
        monkeypatch.setattr(game_link, "console_state", lambda *a, **k: None)
        monkeypatch.setattr(game_link, "DEFAULT_GAME_URL", fake_vite)
        monkeypatch.setattr(game_link, "START_WAIT_S", 5.0)
        link, opened, spawned = self._link(monkeypatch, "http://127.0.0.1:1")
        r = link.launch("跑马梁")
        assert r["ok"] and r["mode"] == "start" and spawned == [1]
        link._launch_thread.join(10)
        assert link.base == fake_vite and opened == [game_link.game_url_for(fake_vite, "跑马梁")]

    def test_launch_over_http(self, server, monkeypatch) -> None:
        base, _p = server
        from tools.acoustic_workbench import serve
        serve.LINK.open_browser = lambda url: True
        r = _post(base, "/api/link/launch", {"sceneId": "跑马梁"})
        assert r["ok"] and r["mode"] == "open"
        bad = _post(base, "/api/link/launch", {})
        assert bad["ok"] is False


# ---------------------------------------------------------------------------
# 服务端（进程内真 HTTP）
# ---------------------------------------------------------------------------

@pytest.fixture
def server(tmp_path, monkeypatch, fake_vite):
    from tools.acoustic_workbench import serve
    p = tmp_path / "acoustic_spaces.json"
    monkeypatch.setattr(spaces, "SPACES_PATH", p)
    # serve 通过 spaces.* 的缺省参数写盘：缺省参数在定义时绑定，所以这里改函数缺省值不行，改模块常量也不行——
    # 直接把几个入口包一层，指向 tmp。
    for name in ("list_spaces", "get_space", "save_space", "create_space", "delete_space", "rename_space", "duplicate_space"):
        fn = getattr(spaces, name)
        monkeypatch.setattr(spaces, name, (lambda f: (lambda *a, **k: f(*a, **{**k, "path": p})))(fn))
    monkeypatch.setattr(spaces, "scene_bindings", lambda *a, **k: {})
    serve.LINK.set_base(fake_vite)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}", p
    finally:
        httpd.shutdown()


def _get(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def _post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8"))


class TestServe:
    def test_space_crud_over_http(self, server) -> None:
        base, p = server
        assert _get(base, "/api/spaces")["spaces"] == []
        r = _post(base, "/api/create", {"id": "a", "sceneId": "跑马梁", "label": "x"})
        assert r["ok"] and r["def"]["authoring"]["sceneId"] == "跑马梁"
        r = _post(base, "/api/save", {"id": "a", "def": GOOD})
        assert r["ok"] and r["def"]["reflectors"][0]["id"] == "对崖"
        assert json.loads(p.read_text(encoding="utf-8"))["spaces"]["a"]["distanceScale"] == 12
        bad = _post(base, "/api/save", {"id": "a", "def": {**GOOD, "distanceScale": -1}})
        assert bad["ok"] is False and "distanceScale" in bad["err"]
        assert _get(base, "/api/space?id=a")["def"]["label"] == "测试"
        assert _post(base, "/api/duplicate", {"id": "a", "to": "b"})["ok"]
        assert _post(base, "/api/rename", {"id": "b", "to": "c"})["ok"]
        assert {s["id"] for s in _get(base, "/api/spaces")["spaces"]} == {"a", "c"}
        assert _post(base, "/api/delete", {"id": "c"})["deleted"] is True
        assert _get(base, "/api/probes")["probes"][0]["id"]

    def test_publish_goes_normalized_to_the_slot(self, server) -> None:
        base, _p = server
        r = _post(base, "/api/link/publish", {"spaceId": "a", "def": {**GOOD, "distanceScale": 12.0}, "sceneId": "跑马梁",
                                              "probe": {"seq": 1, "sfxId": "sfx_gibbon_dry_a"}})
        assert r["ok"] and r["rev"] == 1
        assert isinstance(_FakeVite.doc["def"]["distanceScale"], int) and _FakeVite.doc["sceneId"] == "跑马梁"
        bad = _post(base, "/api/link/publish", {"spaceId": "a", "def": {**GOOD, "reflectors": "x"}})
        assert bad["ok"] is False
        st = _get(base, "/api/link/status")
        assert st["connected"] and st["gameAlive"] is False
        cfg = _post(base, "/api/link/config", {"gameUrl": "http://localhost:5199"})
        assert cfg["gameUrl"] == "http://127.0.0.1:5199"

    def test_boot_reports_bundle_and_scenes_list_has_bindings(self, server) -> None:
        base, _p = server
        b = _get(base, "/api/boot")
        assert b["ok"] and "bundle" in b and b["gameUrl"]
        sc = _get(base, "/api/scenes")["scenes"]
        assert sc and all("acousticSpace" in s for s in sc)
