# -*- coding: utf-8 -*-
"""进程内真 HTTP：路由齐全且 no-store、原画代理不许拼出 public 之外的路径、模板清单 / 用在哪 / 原画候选 / 只读场景视图 /
玩家 / 预设 / 效果、保存 / 新建（尺寸必填）/ 复制 / 改名清单 + 改名 / 删除走服务端、站位本地判定、联动协议 v2（假游戏槽）：
载荷形状（没有布置库、探针 {target, socket?, point?}）、探针与站位序号「粘」住、形状不对的那份不推并说原因、
槽拒收原样回页面、连不上软失败。全部在临时样例工程里。"""
from __future__ import annotations

import json
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

from tools.burn_workbench import fixtures, serve, store  # noqa: E402
from tools.burn_workbench.game_link import BurnLink       # noqa: E402
from tools.editor.shared import burnables as B            # noqa: E402


def _start(handler) -> tuple[ThreadingHTTPServer, str]:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


@pytest.fixture()
def srv(tmp_path, monkeypatch):
    fixtures.build_project(tmp_path)
    monkeypatch.setattr(store, "PROJECT", tmp_path)
    monkeypatch.setattr(store, "DATA", tmp_path)
    link = BurnLink("http://127.0.0.1:9")
    link.open_browser = lambda url: "（测试不开浏览器）"
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
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_static_and_no_store(srv):
    base, _ = srv
    for path in ("/", "/viewer/app.js", "/viewer/core.js", "/viewer/preview.js", "/viewer/render.js", "/viewer/views.js",
                 "/viewer/inspector.js", "/vendor/dropdown.js", "/gen/burnShade.glsl"):
        code, headers, body = _get(base, path)
        assert code == 200, path
        assert "no-store" in (headers.get("Cache-Control") or ""), path
        if path.endswith(".js"):
            assert headers["Content-Type"].startswith("text/javascript"), (path, headers["Content-Type"])
    _c, _h, glsl = _get(base, "/gen/burnShade.glsl")
    assert b"//__BURN_SHADE_BEGIN__" in glsl and b"burnSample" in glsl
    code, _h, _b = _get(base, "/vendor/common.js")
    assert code == 404, "共用件只放白名单"
    _c, _h, html = _get(base, "/")
    assert "sceneSel".encode() not in html and "hotspotList".encode() not in html, "页面上不许再有场景选择 / 热点列表"


def test_public_file_proxy_is_confined(srv):
    base, _ = srv
    code, headers, body = _get(base, fixtures.PAPER_IMG)
    assert code == 200 and headers["Content-Type"] == "image/png" and body[:4] == b"\x89PNG"
    for bad in ("/resources/../../secret.txt", "/resources/%2e%2e/%2e%2e/x.png", "/assets/data/../../../pyproject.toml"):
        code, _h, _b = _get(base, bad)
        assert code == 404, bad


def test_boot_lists_refs_images_and_readonly_scene(srv):
    base, root = srv
    _c, j = _json(base, "/api/boot")
    assert j["ok"] and j["real"] is False and j["data"] == str(root) and j["aspectTolerance"] == 0.02
    assert "library" not in j
    code, j = _json(base, "/api/scenes")
    assert code == 404, "没有场景清单了：模板和场景无关"
    code, j = _json(base, "/api/library")
    assert code == 404, "布置库已删"
    _c, j = _json(base, "/api/burnables")
    assert {r["id"] for r in j["burnables"]} == {"paper_pile", "candle_red", "zz_loose"}
    _c, j = _json(base, "/api/burnable?id=paper_pile")
    assert j["doc"]["widthCm"] == 136.36 and len(j["refs"]) == 4
    code, j = _json(base, "/api/burnable?id=nope")
    assert code == 404 and not j["ok"]
    _c, j = _json(base, "/api/refs?id=candle_red")
    refs = {r["kind"]: r for r in j["refs"]}
    assert set(refs) == {"hotspot", "prop", "spawn"}
    assert refs["hotspot"]["scene"] == fixtures.SCENE and refs["hotspot"]["sceneName"] == "燃烧自检房间" and refs["hotspot"]["entity"] == "hs_candle"
    assert refs["prop"]["prop"] == "zz_incense_prop" and refs["prop"]["label"] == "手上的蜡烛"
    assert refs["spawn"]["file"] == fixtures.CUTSCENE_REL and refs["spawn"]["where"] == "steps[0].params.spawn"
    _c, j = _json(base, "/api/refs?id=paper_pile")
    npc = next(r for r in j["refs"] if r["kind"] == "npc")
    assert npc["entity"] == "npc_paper" and npc["entityLabel"] == "抱纸的人"
    code, j = _json(base, "/api/refs?id=../x")
    assert code == 400
    _c, j = _json(base, "/api/images")
    assert fixtures.PAPER_IMG in j["images"] and fixtures.TORCH_IMG in j["images"]
    assert "/resources/runtime/scenes/zz_burn_room/background.png" in j["images"], "候选 = public/resources/runtime 下全部图（与校验器同一个面）"
    assert sorted(j["used"][fixtures.PAPER_IMG]) == ["paper_pile", "zz_loose"]
    assert j["worldSizes"][fixtures.PAPER_IMG] == [120.0, 80.0]
    _c, j = _json(base, f"/api/scene?id={fixtures.SCENE}")
    sc = j["scene"]
    assert sc["worldWidth"] == 1600 and sc["worldHeight"] == 900 and sc["cal"] is None and sc["wind"]["speed"] == 44
    ents = {e["id"]: e for e in sc["entities"]}
    assert set(ents) == {"hs_paper", "hs_paper2", "hs_candle", "npc_paper"}, "只列开了可燃的实体"
    assert ents["hs_paper2"]["perspectiveScaleEnabled"] is True and ents["hs_paper2"]["displayFacing"] == "left"
    assert ents["npc_paper"]["kind"] == "npc" and ents["npc_paper"]["initialFacing"] == "left" and ents["npc_paper"]["label"] == "抱纸的人"
    assert ents["hs_candle"]["host"] == {"template": "candle_red", "initial": "burning"} and ents["hs_paper"]["interactionRange"] == 120
    code, _h, png = _get(base, f"/api/scene_bg?id={fixtures.SCENE}&w=400")
    assert code == 200 and png[:4] == b"\x89PNG"
    code, _j = _json(base, f"/api/scene_ground?id={fixtures.SCENE}")
    assert code == 404, "没有深度载荷的场景没有行走面"
    code, j = _json(base, "/api/scene?id=nope")
    assert code == 404
    _c, j = _json(base, "/api/player")
    assert j["sheetSize"] == [96, 48] and j["sockets"]["igniteSlots"] == [2] and j["stateMap"]["ignite"] == "light"
    _c, j = _json(base, "/api/presets")
    assert [p["id"] for p in j["presets"]] == ["zz_torch"], "只列写了 igniter 的预设"
    assert j["presets"][0]["sizes"][fixtures.TORCH_IMG] == [60, 240]
    _c, j = _json(base, "/api/effects")
    assert [e["id"] for e in j["effects"]] == ["zz_burn_flame", "zz_paper_money"] and j["effects"][0]["external"] is True


def test_save_create_duplicate_over_http(srv):
    base, root = srv
    _c, j = _json(base, "/api/burnable?id=paper_pile")
    doc = j["doc"]
    code, j = _json(base, "/api/save", {"doc": doc, "base": doc})
    assert code == 200 and j["written"] is False
    code, j = _json(base, "/api/save", {"doc": dict(doc, gridCells=12), "base": doc})
    assert code == 400 and "gridCells" in j["err"]
    code, j = _json(base, "/api/save", {"doc": {k: v for k, v in doc.items() if k != "heightCm"}, "base": doc})
    assert code == 400 and "heightCm" in j["err"]
    code, j = _json(base, "/api/save", {"doc": dict(doc, label="新名字"), "base": doc})
    assert code == 200 and j["written"] and j["doc"]["label"] == "新名字"
    code, j = _json(base, "/api/save", {"doc": dict(doc, label="过期"), "base": doc})
    assert code == 400 and "别处" in j["err"]
    code, j = _json(base, "/api/create", {"id": "zz_c", "image": fixtures.CANDLE_IMG, "mode": "consume"})
    assert code == 400 and "widthCm" in j["err"], "尺寸必填"
    code, j = _json(base, "/api/create", {"id": "zz_c", "image": fixtures.CANDLE_IMG, "mode": "consume", "widthCm": 5, "heightCm": 20})
    assert code == 200 and j["doc"]["mode"] == "consume" and j["doc"]["widthCm"] == 5
    code, j = _json(base, "/api/create", {"id": "zz_c", "image": fixtures.CANDLE_IMG, "widthCm": 5, "heightCm": 20})
    assert code == 400
    code, j = _json(base, "/api/duplicate", {"id": "zz_c", "to": "zz_d", "doc": dict(j.get("doc") or {}, id="zz_c", image=fixtures.CANDLE_IMG, widthCm=5, heightCm=20, label="工作态")})
    assert code == 200 and j["doc"]["label"] == "工作态"


def test_rename_plan_rename_and_delete_over_http(srv):
    base, root = srv
    code, plan = _json(base, "/api/rename_plan", {"id": "paper_pile", "to": "paper_r"})
    assert code == 200 and sorted(f["file"] for f in plan["files"]) == ["public/assets/data/vfx/zz_paper_money.json", f"public/assets/scenes/{fixtures.SCENE}.json"]
    code, j = _json(base, "/api/rename_plan", {"id": "paper_pile", "to": "candle_red"})
    assert code == 400 and "已存在" in j["err"]
    # 确认之后场景被别处改了 ⇒ 拒绝、说清楚
    sp = root / "public" / "assets" / "scenes" / f"{fixtures.SCENE}.json"
    raw = sp.read_bytes()
    sp.write_bytes(raw.replace(b'"worldWidth": 1600', b'"worldWidth": 1601'))
    code, j = _json(base, "/api/rename", {"id": "paper_pile", "to": "paper_r", "expect": plan["expect"]})
    assert code == 400 and "确认之后被别处改过" in j["err"] and "zz_burn_room.json" in j["err"]
    assert (B.burnables_dir(root) / "paper_pile.json").is_file()
    sp.write_bytes(raw)
    code, j = _json(base, "/api/rename", {"id": "paper_pile", "to": "paper_r", "expect": plan["expect"]})
    assert code == 200 and j["refsChanged"] == 4 and j["doc"]["id"] == "paper_r" and j["path"].endswith("paper_r.json")
    scene = json.loads(sp.read_bytes())
    assert [h.get("burnable", {}).get("template") for h in scene["hotspots"]] == ["paper_r", "paper_r", "candle_red", None]
    assert scene["npcs"][0]["burnable"]["template"] == "paper_r"
    code, j = _json(base, "/api/delete", {"id": "paper_r"})
    assert code == 200 and j["deleted"] is False and len(j["refs"]) == 4
    code, j = _json(base, "/api/delete", {"id": "zz_loose"})
    assert j["deleted"] is True and not (B.burnables_dir(root) / "zz_loose.json").exists()


def test_walk_check(srv):
    base, _ = srv
    _c, j = _json(base, "/api/walk_check", {"sceneId": fixtures.SCENE, "points": [[10, 10], [-1, 5], [1600, 900], [1600.5, 1], "x"]})
    assert j["results"] == [True, False, True, False, None] and j["source"] == "local"
    _c, j = _json(base, "/api/walk_check", {"sceneId": "nope", "points": [[1, 1]]})
    assert j["results"] == [None]


class _FakeSlot(BaseHTTPRequestHandler):
    docs: list = []
    reject = False
    status_doc: dict | None = None

    def log_message(self, *a):
        pass

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/__gamedraft-api/runtime-burn-status"):
            return self._send(200, {"doc": type(self).status_doc, "ageMs": 100, "pages": []})
        if self.path.startswith("/__gamedraft-api/runtime-burn"):
            return self._send(200, {"doc": type(self).docs[-1] if type(self).docs else None, "ageMs": 10})
        return self._send(404, {})

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        doc = json.loads(self.rfile.read(n))
        if type(self).reject:
            return self._send(400, {"ok": False, "err": "walkProbe 必须是 {seq, sceneId, points}"})
        type(self).docs.append(doc)
        return self._send(200, {"ok": True, "rev": len(type(self).docs)})


def test_link_protocol_v2_payload_sticky_seqs_and_failures(srv):
    base, _ = srv
    _FakeSlot.docs = []
    _FakeSlot.reject = False
    _FakeSlot.status_doc = {"writer": "game:b1", "bootId": "b1", "sceneId": fixtures.SCENE, "appliedRev": 1, "probeSeqDone": 0,
                            "items": [{"kind": "scene", "sceneId": fixtures.SCENE, "target": "hs_paper", "template": "paper_pile", "state": "unburnt", "events": 0, "ready": True},
                                      {"kind": "held", "target": "player", "socket": "right_hand", "template": "candle_red", "state": "burning", "events": 1, "ready": True}],
                            "stats": {}, "walkProbeResult": {"seq": 1, "sceneId": fixtures.SCENE, "bits": "10"}}
    game, game_url = _start(_FakeSlot)
    try:
        _c, j = _json(base, "/api/link/config", {"gameUrl": game_url})
        assert j["gameUrl"] == game_url
        _c, paper = _json(base, "/api/burnable?id=paper_pile")
        bad = dict(paper["doc"], gridCells="x")
        _c, r = _json(base, "/api/link/publish", {"burnables": {"paper_pile": bad, "ghost": {"id": "ghost"}},
                                                  "library": {"scenes": {}},
                                                  "probe": {"action": "ignite", "target": "hs_paper", "point": "p1"}})
        assert r["ok"] and r["probeSeq"] == 1
        sent = _FakeSlot.docs[-1]
        assert sent["writer"].startswith("burn-workbench:")
        assert set(sent) == {"writer", "burnables", "probe"}, "v2：没有 library / sceneId"
        assert sent["burnables"]["paper_pile"]["gridCells"] == 32, "形状不对的推盘上那份"
        assert "ghost" not in sent["burnables"] and any("ghost" in n for n in r["notes"])
        assert sent["probe"] == {"seq": 1, "action": "ignite", "target": "hs_paper", "point": "p1"}
        # 手上的：带 socket；序号加一
        _c, r = _json(base, "/api/link/publish", {"probe": {"action": "extinguish", "target": "player", "socket": "right_hand"}})
        assert r["probeSeq"] == 2 and _FakeSlot.docs[-1]["probe"] == {"seq": 2, "action": "extinguish", "target": "player", "socket": "right_hand"}
        assert "burnables" not in _FakeSlot.docs[-1]
        # 站位判定：点变了才发新序号；探针序号粘住
        _c, r = _json(base, "/api/link/publish", {"walk": {"sceneId": fixtures.SCENE, "points": [[1, 2], [3, 4]]}})
        assert r["walkSeq"] == 1 and _FakeSlot.docs[-1]["probe"]["seq"] == 2
        assert _FakeSlot.docs[-1]["walkProbe"] == {"seq": 1, "sceneId": fixtures.SCENE, "points": [[1.0, 2.0], [3.0, 4.0]]}
        _c, r = _json(base, "/api/link/publish", {"walk": {"sceneId": fixtures.SCENE, "points": [[1, 2], [3, 4]]}})
        assert r["walkSeq"] == 1, "同一批点不重发新序号"
        _c, r = _json(base, "/api/link/publish", {"walk": {"sceneId": fixtures.SCENE, "points": [[1, 2]], "force": False}})
        assert r["walkSeq"] == 2
        _c, r = _json(base, "/api/link/publish", {"probe": {"action": "boom", "target": "hs_paper"}})
        assert not r["ok"]
        _c, r = _json(base, "/api/link/publish", {"probe": {"action": "ignite", "hotspotId": "hs_paper"}})
        assert not r["ok"] and "target" in r["err"], "旧形状（hotspotId）不认"
        _c, st = _json(base, "/api/link/status")
        assert st["connected"] and st["gameAlive"] and st["doc"]["walkProbeResult"]["bits"] == "10" and st["walkSeq"] == 2
        assert [it["kind"] for it in st["doc"]["items"]] == ["scene", "held"]
        _FakeSlot.reject = True
        _c, r = _json(base, "/api/link/publish", {})
        assert r["ok"] is False and r["rejected"] and "walkProbe" in r["err"]
    finally:
        game.shutdown()
    _c, r = _json(base, "/api/link/publish", {})
    assert r["ok"] is False and r["connected"] is False
    _c, st = _json(base, "/api/link/status")
    assert st["ok"] and st["connected"] is False


def test_unknown_routes(srv):
    base, _ = srv
    code, j = _json(base, "/api/nope")
    assert code == 404 and not j["ok"]
    code, j = _json(base, "/api/nope", {"x": 1})
    assert code == 404
    for gone in ("/api/library/save", "/api/library/rebind", "/api/library/candidates"):
        code, _j = _json(base, gone, {"doc": {}})
        assert code == 404, gone
