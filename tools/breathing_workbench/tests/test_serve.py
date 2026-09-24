# -*- coding: utf-8 -*-
"""进程内真 HTTP:路由齐全且 no-store、媒体代理只放行 public 下的图与位移场、清单 / 一张图 + 体检 + 用在哪、
导出到游戏(只许改参数;烘焙产物改了拒)、推给游戏(假游戏槽:载荷形状、探针序号「粘」住、形状不对的推盘上那份并说原因、
槽拒收原样回页面、连不上软失败)、探针动作与游戏侧那张表对账、出片(循环 GIF + 接触表)。全部在临时样例工程里。"""
from __future__ import annotations

import json
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.breathing_workbench import fixtures, game_link, serve, store  # noqa: E402
from tools.breathing_workbench.game_link import BreathingLink            # noqa: E402


def _start(handler) -> tuple[ThreadingHTTPServer, str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    fixtures.build_project(tmp_path)
    monkeypatch.setattr(store, "PROJECT", tmp_path)
    monkeypatch.setattr(store, "DATA", tmp_path)
    link = BreathingLink("http://127.0.0.1:9")
    link.open_browser = lambda url: "(测试不开浏览器)"
    link.spawn_game_server = lambda: None
    monkeypatch.setattr(serve, "LINK", link)
    httpd, base = _start(serve.H)
    yield base, tmp_path
    httpd.shutdown()


def _get(base: str, path: str):
    try:
        with urllib.request.urlopen(base + path, timeout=20) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def _json(base: str, path: str, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_static_and_no_store(srv):
    base, _ = srv
    for path in ("/", "/viewer/app.js", "/vendor/dropdown.js", "/gen/breathingShade.glsl"):
        code, headers, body = _get(base, path)
        assert code == 200, path
        assert "no-store" in headers.get("Cache-Control", "")
        assert body
    code, headers, _ = _get(base, "/viewer/app.js")
    assert headers.get("Content-Type", "").startswith("text/javascript")
    assert _get(base, "/viewer/_gen/breathing.bundle.js")[0] == 404
    assert _get(base, "/vendor/evil.js")[0] == 404


def test_media_proxy(srv):
    base, _ = srv
    code, headers, body = _get(base, fixtures.MEDIA + "/base.png")
    assert code == 200 and headers.get("Content-Type") == "image/png" and body[:4] == b"\x89PNG"
    code, headers, body = _get(base, fixtures.MEDIA + "/fields.bin")
    assert code == 200 and len(body) == fixtures.FW * fixtures.FH * 4 * 2 * 2
    assert _get(base, "/resources/../src/data/breathingParams.json")[0] == 404
    assert _get(base, "/resources/runtime/images/breathing/nope.png")[0] == 404


def test_list_doc_check_and_stories(srv):
    base, _ = srv
    code, j = _json(base, "/api/breathing")
    assert code == 200 and [r["id"] for r in j["breathing"]] == [fixtures.ASSET_ID]
    code, j = _json(base, f"/api/breathing/doc?id={fixtures.ASSET_ID}")
    assert code == 200 and j["doc"]["id"] == fixtures.ASSET_ID
    assert j["check"] == {"errors": [], "warnings": []}
    assert len(j["stories"]) == 1 and j["stories"][0]["handle"] == "paper"
    assert _json(base, "/api/breathing/doc?id=nope")[0] == 404
    code, j = _json(base, "/api/boot")
    assert j["real"] is False and j["initialScene"] == "sample_scene" and Path(j["breathingDir"]).as_posix().endswith("public/assets/data/breathing")


def test_save_params_only(srv):
    base, tmp = srv
    doc = _json(base, f"/api/breathing/doc?id={fixtures.ASSET_ID}")[1]["doc"]
    new = json.loads(json.dumps(doc))
    new["params"]["lag"] = 0.75
    code, j = _json(base, "/api/save", {"doc": new, "base": doc})
    assert code == 200 and j["written"] and j["doc"]["params"]["lag"] == 0.75
    on_disk = json.loads((tmp / store.BREATHING_REL / f"{fixtures.ASSET_ID}.json").read_text(encoding="utf-8"))
    assert on_disk["params"]["lag"] == 0.75
    bad = json.loads(json.dumps(j["doc"]))
    bad["rig"]["pxPerMm"] = 3.0
    code, j2 = _json(base, "/api/save", {"doc": bad, "base": j["doc"]})
    assert code == 400 and "烘焙产物" in j2["err"]


class _FakeSlot(BaseHTTPRequestHandler):
    docs: list = []
    reject = False

    def do_GET(self):  # noqa: N802
        body = json.dumps({"doc": self.docs[-1] if self.docs else None, "ageMs": 5}).encode("utf-8")
        if self.path.startswith(game_link.STATUS_PATH):
            body = json.dumps({"doc": {"writer": "game:x", "sceneId": "s", "instances": []}, "ageMs": 100, "pages": []}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        doc = json.loads(self.rfile.read(n))
        if self.reject:
            body = b'{"ok":false,"err":"probe \xe5\xbd\xa2\xe7\x8a\xb6\xe4\xb8\x8d\xe5\xaf\xb9"}'
            self.send_response(400)
        else:
            self.docs.append(doc)
            body = json.dumps({"ok": True, "rev": len(self.docs)}).encode("utf-8")
            self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_publish_protocol(srv, monkeypatch):
    base, _ = srv
    _FakeSlot.docs = []
    _FakeSlot.reject = False
    slot, slot_url = _start(_FakeSlot)
    try:
        serve.LINK.set_base(slot_url)
        doc = _json(base, f"/api/breathing/doc?id={fixtures.ASSET_ID}")[1]["doc"]
        code, j = _json(base, "/api/link/publish", {"breathing": {fixtures.ASSET_ID: doc}, "probe": {"action": "gasp", "target": fixtures.ASSET_ID}})
        assert code == 200 and j["ok"] and j["probeSeq"] == 1
        sent = _FakeSlot.docs[-1]
        assert set(sent) == {"writer", "breathing", "probe"} and sent["probe"] == {"seq": 1, "action": "gasp", "target": fixtures.ASSET_ID}
        # 下一发只带工作态:探针原样粘着(同序号),游戏不会重做
        _json(base, "/api/link/publish", {"breathing": {fixtures.ASSET_ID: doc}})
        assert _FakeSlot.docs[-1]["probe"]["seq"] == 1
        # 形状不对的推盘上那份并说原因
        broken = json.loads(json.dumps(doc))
        broken["rig"] = "坏"
        code, j = _json(base, "/api/link/publish", {"breathing": {fixtures.ASSET_ID: broken}})
        assert j["ok"] and j["notes"] and "盘上那份" in j["notes"][0]
        assert _FakeSlot.docs[-1]["breathing"][fixtures.ASSET_ID]["rig"] == doc["rig"]
        # 不认识的探针动作页面这边就拒
        code, j = _json(base, "/api/link/publish", {"probe": {"action": "explode", "target": "x"}})
        assert j["ok"] is False
        # 槽拒收原样回页面
        _FakeSlot.reject = True
        code, j = _json(base, "/api/link/publish", {"probe": {"action": "show", "target": fixtures.ASSET_ID}})
        assert j["ok"] is False and j.get("rejected") and "形状不对" in j["err"]
        code, st = _json(base, "/api/link/status")
        assert st["connected"] and st["gameAlive"]
    finally:
        slot.shutdown()


def test_publish_soft_fails_when_game_is_down(srv):
    base, _ = srv
    serve.LINK.set_base("http://127.0.0.1:9")
    code, j = _json(base, "/api/link/publish", {"probe": {"action": "show", "target": fixtures.ASSET_ID}})
    assert code == 200 and j["ok"] is False and j["connected"] is False
    code, st = _json(base, "/api/link/status")
    assert st["connected"] is False


def test_probe_actions_match_game_side():
    ts = (_ROOT / "src/dev/runtimeBreathingSync.ts").read_text(encoding="utf-8")
    m = re.search(r"BREATHING_PROBE_ACTIONS\s*=\s*\[([^\]]*)\]", ts)
    assert m, "游戏侧探针表没找到"
    game = tuple(re.findall(r"'([^']+)'", m.group(1)))
    assert game == game_link.PROBE_ACTIONS


def test_render_loop_pipeline(srv):
    base, tmp = srv
    w, h = 16, 8
    code, j = _json(base, "/api/render/begin", {"kind": "loop", "id": fixtures.ASSET_ID, "fps": 15, "width": w, "height": h, "paramsText": "参数"})
    assert code == 200
    token = j["token"]
    for i in range(6):
        raw = bytes([i * 40 % 256, 20, 30, 255]) * (w * h)
        req = urllib.request.Request(f"{base}/api/render/frame?token={token}&i={i}", data=raw, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            assert json.loads(r.read())["ok"]
    meta = {"frames": [{"t": i / 15, "ph": "吸", "V": 0.5, "mm": -1.0} for i in range(6)]}
    code, fin = _json(base, "/api/render/finish", {"token": token, "meta": meta})
    assert code == 200 and fin["frames"] == 6
    out = Path(fin["dir"])
    assert out.is_relative_to(tmp) and (out / "参数.txt").read_text(encoding="utf-8") == "参数"
    assert any(f.endswith(".gif") for f in fin["files"]) and all(Path(f).exists() for f in fin["files"])
    bad = urllib.request.Request(f"{base}/api/render/frame?token={token}&i=0", data=b"1234", method="POST")
    with pytest.raises(urllib.error.HTTPError):
        urllib.request.urlopen(bad, timeout=20)
