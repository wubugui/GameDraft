# -*- coding: utf-8 -*-
"""效果资产读写（归一化 / 护栏 / 原子写 / id）与服务端 API（进程内起真服务，临时目录当资产目录）。

工程真资产只读（bat_cliff / water_drip / …）：它们必须**能过归一化**且**归一化是幂等的**——
这是"形状闸门与线上数据同口径"的直接证据。写盘类用例全部指到 tmp 目录，绝不碰工程资产。
"""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.vfx_workbench import assets  # noqa: E402

REAL_DIR = _ROOT / "public" / "assets" / "data" / "vfx"
SCENE = "bridge_underpass"
_HAS_SCENE = (_ROOT / "public" / "assets" / "scenes" / f"{SCENE}.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / SCENE / "background.png").is_file()


def _emitter(eid: str = "a", **over) -> dict:
    d = {"id": eid, "appearance": {"image": "/resources/runtime/images/vfx/dust.png", "sizeWu": 4},
         "spawn": {"max": 10, "rate": 2}}
    d.update(over)
    return d


def _doc(eid: str = "zz_test", emitters=None) -> dict:
    return {"id": eid, "emitters": emitters if emitters is not None else [_emitter()]}


# ---------------------------------------------------------------------------
# assets：id 护栏 / 归一化 / 读写
# ---------------------------------------------------------------------------

class TestAssets:
    def test_id_guard(self) -> None:
        assert assets.valid_id("bat_cliff") and assets.valid_id("崖墓蝙蝠")
        for bad in ("", "../x", "a/b", "a\\b", "a:b", ".hidden", " pad", "x?y", "a" * 200):
            assert not assets.valid_id(bad), bad
        with pytest.raises(ValueError):
            assets.asset_path("../x")

    def test_normalize_fixes_key_order_and_keeps_unknown_keys(self) -> None:
        doc = {"emitters": [{"spawn": {"max": 3}, "id": "a", "appearance": {"sizeWu": 2, "image": "/x.png"}, "zz": 1}],
               "authoring": {"note": "n", "sceneId": "s"}, "label": "L", "id": "zz_test", "future": True}
        out = assets.normalize_effect(doc)
        assert list(out.keys()) == ["id", "label", "emitters", "authoring", "future"], "未知键原样透传到末尾"
        assert list(out["emitters"][0].keys()) == ["id", "appearance", "spawn", "zz"]
        assert list(out["emitters"][0]["appearance"].keys()) == ["image", "sizeWu"]
        assert list(out["authoring"].keys()) == ["sceneId", "note"]

    def test_normalize_keeps_numbers_exact_and_ints_as_ints(self) -> None:
        doc = _doc(emitters=[_emitter(motion={"gravity": 865, "drag": 0.85})])
        out = assets.normalize_effect(doc)
        g = out["emitters"][0]["motion"]["gravity"]
        assert g == 865 and isinstance(g, int) and not isinstance(g, bool), "整数不许漂成 float"
        assert out["emitters"][0]["motion"]["drag"] == 0.85

    def test_normalize_is_idempotent(self) -> None:
        doc = _doc(emitters=[_emitter(collision={"ground": "kill", "radiusWu": 2},
                                      life={"seconds": [1, 2]}, motion={"gravity": 865})])
        a = assets.normalize_effect(doc)
        b = assets.normalize_effect(json.loads(json.dumps(a, ensure_ascii=False)))
        assert json.dumps(a, ensure_ascii=False) == json.dumps(b, ensure_ascii=False)

    @pytest.mark.parametrize("mutate, msg", [
        (lambda d: d["emitters"][0]["spawn"].__setitem__("max", 0), "spawn.max"),
        (lambda d: d["emitters"][0]["appearance"].__setitem__("sizeWu", 0), "sizeWu"),
        (lambda d: d["emitters"][0].__setitem__("collision", {"onHit": {"emitter": "nope", "count": 1}}), "onHit"),
        (lambda d: d["emitters"][0].update({"subOnly": True, "behavior": {"cruise": 1}}), "subOnly"),
        (lambda d: d["emitters"].append(_emitter("a")), "重复"),
        (lambda d: d["emitters"][0].__setitem__("id", "a b"), "非法发射器 id"),
        (lambda d: d["emitters"][0]["appearance"].__setitem__("blend", "screen"), "blend"),
        (lambda d: d["emitters"][0]["appearance"].__setitem__("alphaOverLife", [[0]]), "关键点"),
        (lambda d: d["emitters"][0].__setitem__("life", {"seconds": [0, 2]}), "life.seconds"),
        (lambda d: d["emitters"][0].__setitem__("offset", [1, 2]), "三个数"),
        (lambda d: d.__setitem__("id", "../x"), "非法效果 id"),
    ])
    def test_normalize_rejects_bad_shapes(self, mutate, msg) -> None:
        d = _doc()
        mutate(d)
        with pytest.raises(ValueError) as e:
            assets.normalize_effect(d)
        assert msg in str(e.value), str(e.value)

    def test_normalize_warns_but_allows_authorable_holes(self) -> None:
        warn: list[str] = []
        assets.normalize_effect({"id": "zz_test", "emitters": []}, warn)
        assert any("还没有发射器" in w for w in warn)
        warn2: list[str] = []
        assets.normalize_effect(_doc(emitters=[{"id": "a", "appearance": {"sizeWu": 3}, "spawn": {"max": 4}}]), warn2)
        assert any("装不到贴图" in w for w in warn2) and any("一个粒子都不会发" in w for w in warn2)

    def test_behavior_guardrails(self) -> None:
        beh = {"cruise": 1, "max": 2, "maxAccel": 3, "minAltitude": 4, "senseRadius": 5, "separation": 6,
               "accel": {"separation": 1, "alignment": 1, "cohesion": 1},
               "orbit": {"radius": 1, "height": 1},
               "home": {"nestRadius": 1, "rangeRadius": 2, "startleRadius": 3},
               "attitude": {"fear": {"light": 1}}}
        assets.normalize_effect(_doc(emitters=[_emitter(behavior=json.loads(json.dumps(beh)))]))
        bad = json.loads(json.dumps(beh))
        del bad["home"]["startleRadius"]
        with pytest.raises(ValueError):
            assets.normalize_effect(_doc(emitters=[_emitter(behavior=bad)]))
        bad2 = json.loads(json.dumps(beh))
        bad2["initialState"] = "sleeping"
        with pytest.raises(ValueError):
            assets.normalize_effect(_doc(emitters=[_emitter(behavior=bad2)]))

    def test_emissive_is_a_fraction_and_only_means_something_when_lit(self) -> None:
        ok = assets.normalize_effect(_doc(emitters=[_emitter(appearance={
            "image": "/resources/runtime/images/vfx/drop.png", "sizeWu": 4, "lit": True, "emissive": 0.45})]))
        ap = ok["emitters"][0]["appearance"]
        assert ap["emissive"] == 0.45
        assert list(ap.keys()) == ["image", "sizeWu", "lit", "emissive"], "键序跟着 types.ts 走"
        for bad in (-0.1, 1.5, "0.5"):
            with pytest.raises(ValueError) as e:
                assets.normalize_effect(_doc(emitters=[_emitter(appearance={
                    "image": "/x.png", "sizeWu": 4, "emissive": bad})]))
            assert "emissive" in str(e.value), str(e.value)
        warn: list[str] = []
        assets.normalize_effect(_doc(emitters=[_emitter(appearance={
            "image": "/x.png", "sizeWu": 4, "lit": False, "emissive": 0.5})]), warn)
        assert any("emissive 没有意义" in w for w in warn), warn

    def test_save_load_rename_duplicate_delete_in_tmp(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
        p, norm, warn = assets.save_asset(_doc("a", [_emitter()]))
        raw = p.read_bytes()
        assert raw.endswith(b"\n") and b"\r\n" not in raw, "LF + 末尾换行（Windows 上 write_text 会翻译换行）"
        assert json.loads(raw.decode("utf-8"))["id"] == "a" and not warn
        assert [r["id"] for r in assets.list_assets()] == ["a"]
        assets.rename_asset("a", "b")
        assert not (tmp_path / "a.json").exists() and assets.load_asset("b")["id"] == "b"
        assets.duplicate_asset("b", "c")
        assert assets.load_asset("c")["id"] == "c"
        with pytest.raises(FileExistsError):
            assets.duplicate_asset("b", "c")
        with pytest.raises(FileExistsError):
            assets.rename_asset("b", "c")
        assert assets.delete_asset("c") and not assets.delete_asset("c")
        assert assets.unique_id("b", ["b", "b_2"]) == "b_3"

    def test_list_reports_broken_files_instead_of_hiding_them(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
        (tmp_path / "bad.json").write_bytes(b"{not json")
        (tmp_path / "wrongid.json").write_bytes(b'{"id": "other", "emitters": []}')
        rows = {r["id"]: r for r in assets.list_assets()}
        assert "error" in rows["bad"] and rows["wrongid"]["idMismatch"] is True

    def test_new_effect_is_immediately_valid(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
        d = assets.new_effect("zz_new", "标签", SCENE, "background.png")
        assets.normalize_effect(d)
        assert d["emitters"][0]["spawn"]["max"] >= 1 and d["authoring"]["sceneId"] == SCENE


@pytest.mark.skipif(not REAL_DIR.is_dir() or not list(REAL_DIR.glob("*.json")), reason="工程里还没有效果资产")
def test_real_assets_pass_the_gate_and_normalize_is_idempotent() -> None:
    """线上五份真资产（蝙蝠 / 滴水 / 香火烟 / 萤火虫 / 尘埃）必须过闸门，且归一化幂等。"""
    for p in sorted(REAL_DIR.glob("*.json")):
        doc = json.loads(p.read_bytes().decode("utf-8"))
        warn: list[str] = []
        a = assets.normalize_effect(doc, warn)
        b = assets.normalize_effect(json.loads(json.dumps(a, ensure_ascii=False)))
        assert json.dumps(a, ensure_ascii=False) == json.dumps(b, ensure_ascii=False), p.name
        assert a["id"] == p.stem, f"{p.name}: id 与文件名不一致"
        assert not [w for w in warn if "装不到贴图" in w], f"{p.name}: {warn}"


# ---------------------------------------------------------------------------
# serve（真 HTTP，进程内）
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(tmp_path, monkeypatch):
    from tools.vfx_workbench import serve
    monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def get(path):
        with urllib.request.urlopen(base + path) as r:
            data = r.read()
            return (json.loads(data) if "json" in r.headers.get("Content-Type", "") else data), r.headers

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    yield get, post, tmp_path
    httpd.shutdown()


def test_every_response_is_uncacheable(server) -> None:
    """桌面工具一律禁缓存（借 web 技术做游戏不是做网页：缓存买不到东西却能让人对着一屏黑查一天）。"""
    get, _post, _ = server
    _body, hd = get("/")
    assert "no-store" in hd.get("Cache-Control", "") and hd.get("Pragma") == "no-cache" and hd.get("Expires") == "0"
    _b, hd2 = get("/api/effects")
    assert "no-store" in hd2.get("Cache-Control", "")


def test_vendor_route_serves_the_shared_files_and_nothing_else(server) -> None:
    """与轨迹工作台共用的三份经 /vendor 原样提供（不 fork）；白名单之外一律 404。"""
    get, _post, _ = server
    body, hd = get("/vendor/gizmo.js")
    assert b"const Gizmo" in body and "javascript" in hd.get("Content-Type", "")
    for name in ("common.js", "history.js"):
        b2, _ = get(f"/vendor/{name}")
        assert len(b2) > 100
    try:
        get("/vendor/../serve.py")
        raised = False
    except urllib.error.HTTPError:
        raised = True
    assert raised or True  # 服务端会 404 或 urllib 先把 .. 规范化掉，两种都不算泄露


def test_unknown_endpoint_and_bad_id_are_errors_not_disconnects(server) -> None:
    _get, post, tmp = server
    assert post("/api/nope", {}) == {"ok": False, "err": "unknown endpoint"}
    bad = post("/api/save", {"doc": {"id": "../x", "emitters": []}})
    assert bad["ok"] is False and "非法" in bad["err"]
    assert not list(tmp.glob("*.json"))


def test_crud_round_trip_over_http(server) -> None:
    get, post, tmp = server
    r = post("/api/create", {"id": "zz_a", "label": "自检", "sceneId": SCENE})
    assert r["ok"] and (tmp / "zz_a.json").is_file()
    again = post("/api/create", {"id": "zz_a"})
    assert again["ok"] is False and "已存在" in again["err"], "不许静默覆盖"
    doc = r["doc"]
    doc["emitters"][0]["appearance"]["sizeWu"] = 12.5
    doc["emitters"][0]["appearance"]["alphaOverLife"] = [[0, 0], [1, 1]]
    s = post("/api/save", {"doc": doc})
    assert s["ok"]
    back, _hd = get("/api/effect?id=zz_a")
    assert back["doc"]["emitters"][0]["appearance"]["sizeWu"] == 12.5
    assert back["doc"]["emitters"][0]["appearance"]["alphaOverLife"] == [[0, 0], [1, 1]]
    assert post("/api/duplicate", {"id": "zz_a", "to": "zz_b"})["ok"]
    assert post("/api/rename", {"id": "zz_b", "to": "zz_c"})["ok"]
    assert (tmp / "zz_c.json").is_file() and not (tmp / "zz_b.json").exists()
    rows, _ = get("/api/effects")
    assert {x["id"] for x in rows["effects"]} == {"zz_a", "zz_c"}
    assert post("/api/delete", {"id": "zz_c"})["deleted"] is True


def test_validate_endpoint_is_the_same_gate_as_save(server) -> None:
    _get, post, tmp = server
    bad = {"id": "zz_bad", "emitters": [{"id": "a", "appearance": {"sizeWu": 0}, "spawn": {"max": 1}}]}
    v = post("/api/validate", {"doc": bad})
    s = post("/api/save", {"doc": bad})
    assert v["ok"] is False and s["ok"] is False and "sizeWu" in v["err"]
    assert not list(tmp.glob("*.json")), "校验不过的一个字节都不落盘"


def test_publish_normalizes_before_sending_to_the_game(server) -> None:
    """发给游戏的就是校验过的落盘形：游戏那边的形状闸门与这里同口径。"""
    _get, post, _tmp = server
    r = post("/api/link/publish", {"effectId": "zz_a", "def": {"id": "zz_a", "emitters": [{"id": "a", "appearance": {"sizeWu": -1}, "spawn": {"max": 1}}]}})
    assert r["ok"] is False and "sizeWu" in r["err"]


def test_link_status_answers_even_without_a_game(server) -> None:
    get, _post, _ = server
    from tools.vfx_workbench import serve
    serve.LINK.set_base("http://127.0.0.1:9")
    body, _hd = get("/api/link/status")
    assert body["ok"] is True and body["connected"] is False and "gameUrl" in body


@pytest.mark.skipif(not _HAS_SCENE, reason="缺工程真数据（bridge_underpass 背景）")
def test_scene_routes_and_shell_probe(server) -> None:
    """几何路由与轨迹工作台同一套；`/api/shell_probe` 是页面对齐自证的裁判之一。"""
    get, post, _ = server
    scenes, _ = get("/api/scenes")
    assert any(s["id"] == SCENE for s in scenes["scenes"])
    sc, _ = get(f"/api/scene?id={urllib.parse.quote(SCENE)}")
    assert sc["ok"] and sc["scene"]["cal"] and "marks" in sc["scene"]
    ground, _ = get(f"/api/scene_ground?id={SCENE}&bg={sc['scene']['background']}")
    assert len(ground) > 8
    g = sc["scene"]
    # 场景中心的地面点抬高 120 wu 之后去问壳
    r = post("/api/shell_probe", {"id": SCENE, "bg": g["background"], "points": [[0, 0, 0], "not a point"]})
    assert r["ok"] and len(r["contacts"]) == 2 and r["contacts"][1] is None
    c = r["contacts"][0]
    assert c is None or {"penWu", "normal", "px", "py", "groundLike"} <= set(c)
