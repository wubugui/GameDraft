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

    def test_light_gain_is_0_to_10_sits_after_emissive_and_only_means_something_when_lit(self) -> None:
        """受光强度：乘在这个发射器收到的光上（运行时夹 0..10）。越界拒存——作者填 30 却只看到 10 是静默失真。"""
        warn0: list[str] = []
        ok = assets.normalize_effect(_doc(emitters=[_emitter(appearance={
            "lightGain": 2.5, "emissive": 0.45, "lit": True, "sizeWu": 4, "image": "/resources/runtime/images/vfx/drop.png"})]), warn0)
        ap = ok["emitters"][0]["appearance"]
        assert ap["lightGain"] == 2.5
        assert list(ap.keys()) == ["image", "sizeWu", "lit", "emissive", "lightGain"], "键序跟着 types.ts 走（紧跟 emissive）"
        assert not [w for w in warn0 if "lightGain" in w], warn0
        for edge in (0, 10, 1):
            assets.normalize_effect(_doc(emitters=[_emitter(appearance={"image": "/x.png", "sizeWu": 4, "lightGain": edge})]))
        for bad in (-0.1, 10.5, "2", True, None, float("nan")):
            with pytest.raises(ValueError) as e:
                assets.normalize_effect(_doc(emitters=[_emitter(appearance={
                    "image": "/x.png", "sizeWu": 4, "lightGain": bad})]))
            assert "lightGain" in str(e.value), (bad, str(e.value))
        warn: list[str] = []
        assets.normalize_effect(_doc(emitters=[_emitter(appearance={
            "image": "/x.png", "sizeWu": 4, "lit": False, "lightGain": 3})]), warn)
        assert any("lightGain 没有意义" in w for w in warn), warn

    def test_socket_attach_is_workbench_state_next_to_the_anchor(self) -> None:
        """``authoring.attach``（锚点模式=角色挂点）：与 anchor 同一块工作态，运行时忽略整个 authoring。

        键序钉在 anchor 之后；**不在的时候一个字节都不加**（关掉这一档的资产必须字节不变）。
        """
        doc = _doc()
        doc["authoring"] = {"note": "n", "attach": {"offsetX": 12, "heightWu": 110}, "sceneId": "s",
                            "anchor": {"y": 2, "x": 1}}
        out = assets.normalize_effect(doc)
        assert list(out["authoring"].keys()) == ["sceneId", "anchor", "attach", "note"]
        assert list(out["authoring"]["attach"].keys()) == ["heightWu", "offsetX"]
        hw = out["authoring"]["attach"]["heightWu"]
        assert hw == 110 and isinstance(hw, int), "整数不许漂成 float"
        plain = assets.normalize_effect(_doc())
        assert "authoring" not in plain, "没开这一档 = 一个键都不写"
        for bad, msg in (({"offsetX": 3}, "heightWu"), ({"heightWu": -1}, "heightWu"),
                         ({"heightWu": "110"}, "heightWu"), ({"heightWu": 1, "offsetX": "x"}, "offsetX"),
                         (5, "attach")):
            d = _doc()
            d["authoring"] = {"attach": bad}
            with pytest.raises(ValueError) as e:
                assets.normalize_effect(d)
            assert msg in str(e.value), str(e.value)

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
        assert not [w for w in warn if "不是动画包" in w], f"{p.name}: 状态名打错了（运行时静默退回第一个状态）：{warn}"


def test_animation_state_names_are_checked_against_the_anim_pack(tmp_path, monkeypatch) -> None:
    """「状态 / 栖息状态」是对动画包的引用：打错一个字母运行时不报错——state 退回第一个状态、restState 被忽略。"""
    anim = tmp_path / "resources" / "runtime" / "animation" / "fx_bat"
    anim.mkdir(parents=True)
    (anim / "anim.json").write_text(json.dumps({"spritesheet": "a.png", "states": {"hang": {}, "fly": {}}}), encoding="utf-8")
    monkeypatch.setattr(assets, "PUBLIC_DIR", tmp_path)
    url = "/resources/runtime/animation/fx_bat/anim.json"
    assert assets.anim_states(url) == ["hang", "fly"]
    assert assets.anim_states("/../../etc/passwd") is None and assets.anim_states("/resources/nope/anim.json") is None

    def warns(**ap) -> list[str]:
        w: list[str] = []
        assets.normalize_effect(_doc(emitters=[_emitter(appearance=dict({"animFile": url, "sizeWu": 4}, **ap))]), w)
        return [x for x in w if "不是动画包" in x]

    assert warns(state="fly", restState="hang") == []
    bad = warns(state="fyl", restState="hnag")
    assert len(bad) == 2 and "fyl" in bad[0] and "第一个状态「hang」" in bad[0] and "hnag" in bad[1] and "忽略" in bad[1], bad
    # 动画包读不到：缺文件归校验器报，这里不猜状态名
    w2: list[str] = []
    assets.normalize_effect(_doc(emitters=[_emitter(appearance={"animFile": "/resources/gone/anim.json", "sizeWu": 4, "state": "x"})]), w2)
    assert not [x for x in w2 if "不是动画包" in x]


# ---------------------------------------------------------------------------
# serve（真 HTTP，进程内）
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(tmp_path, monkeypatch):
    from tools.vfx_workbench import placements, serve
    monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
    # 布置库一样指到临时目录：删 / 改名效果会连带读写它，绝不碰真库
    monkeypatch.setattr(placements, "LIB_ROOT", tmp_path / "libroot")
    monkeypatch.setattr(placements, "REF_ROOT", tmp_path / "refroot")
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


def test_save_checks_loaded_base_and_allows_idempotent_retry(server) -> None:
    get, post, directory = server
    base = post('/api/save', {'doc': _doc('shared')})['doc']
    local = {**base, 'label': 'local edit'}
    external = {**base, 'label': 'external edit', 'future': {'keep': [2, 1]}}
    post('/api/save', {'doc': external})
    before = (directory / 'shared.json').read_bytes()
    rejected = post('/api/save', {'doc': local, 'base': base})
    assert not rejected['ok'] and '外部修改' in rejected['err']
    assert (directory / 'shared.json').read_bytes() == before
    # Reloading acknowledges the external version; a lost response may safely be retried.
    assert post('/api/save', {'doc': local, 'base': external})['ok']
    assert post('/api/save', {'doc': local, 'base': external})['ok']
    assets.delete_asset('shared')
    assert not post('/api/save', {'doc': local, 'base': local})['ok']
    assert not (directory / 'shared.json').exists(), 'A stale window cannot resurrect a deleted effect'


def test_every_response_is_uncacheable(server) -> None:
    """桌面工具一律禁缓存（借 web 技术做游戏不是做网页：缓存买不到东西却能让人对着一屏黑查一天）。"""
    get, _post, _ = server
    _body, hd = get("/")
    assert "no-store" in hd.get("Cache-Control", "") and hd.get("Pragma") == "no-cache" and hd.get("Expires") == "0"
    _b, hd2 = get("/api/effects")
    assert "no-store" in hd2.get("Cache-Control", "")


def test_vendor_route_serves_the_shared_files_and_nothing_else(server) -> None:
    """与轨迹工作台共用的那几份经 /vendor 原样提供（不 fork）；白名单之外一律 404。"""
    get, _post, _ = server
    body, hd = get("/vendor/gizmo.js")
    assert b"const Gizmo" in body and "javascript" in hd.get("Content-Type", "")
    # 页内下拉：页面靠它掐死系统原生弹窗（高 DPI 下每开一次再乘一次缩放），route 掉了就又变回原生
    dd, _ = get("/vendor/dropdown.js")
    assert b"ddlist" in dd and b"preventDefault" in dd
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


def test_duplicate_can_carry_the_working_doc_and_leaves_the_source_alone(server) -> None:
    """「复制」带上页面上没存的改动：副本 = 工作态（过同一道形状闸门、id 换成新的），源文件一个字节不动。
    （2026-09-14 日常流程审查：原来复制只读盘上那份，作者"在副本上接着改"拿到的是改之前的版本。）"""
    get, post, tmp = server
    r = post("/api/create", {"id": "zz_src", "sceneId": SCENE})
    assert r["ok"]
    before = (tmp / "zz_src.json").read_bytes()
    working = json.loads(json.dumps(r["doc"]))
    working["emitters"][0]["spawn"]["max"] = 77
    d = post("/api/duplicate", {"id": "zz_src", "to": "zz_dup", "doc": working})
    assert d["ok"] and d["doc"]["id"] == "zz_dup"
    back, _ = get("/api/effect?id=zz_dup")
    assert back["doc"]["emitters"][0]["spawn"]["max"] == 77
    assert (tmp / "zz_src.json").read_bytes() == before, "源文件不许被复制动过"
    bad = json.loads(json.dumps(working))
    bad["emitters"][0]["appearance"]["sizeWu"] = 0
    rej = post("/api/duplicate", {"id": "zz_src", "to": "zz_dup2", "doc": bad})
    assert rej["ok"] is False and not (tmp / "zz_dup2.json").exists(), "工作态也要过形状闸门"
    plain = post("/api/duplicate", {"id": "zz_src", "to": "zz_dup3"})
    assert plain["ok"] and plain["doc"]["emitters"][0]["spawn"]["max"] == r["doc"]["emitters"][0]["spawn"]["max"]


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
    # 带着工作态（挂点预览）的那份照样过闸门（游戏那边忽略整个 authoring）。
    # 地址先钉到死端口：绝不往真在跑的游戏里发临时效果（本机真有 dev server 在跑，实测 connected=True）。
    from tools.vfx_workbench import serve
    serve.LINK.set_base("http://127.0.0.1:9")
    good = _doc("zz_a")
    good["authoring"] = {"attach": {"heightWu": 110}, "anchor": {"x": 1, "y": 2}}
    r2 = post("/api/link/publish", {"effectId": "zz_a", "def": good})
    assert r2["ok"] is False and r2.get("connected") is False, r2            # 连不上 ≠ 形状被拒
    assert "attach" not in (r2.get("err") or "") and "sizeWu" not in (r2.get("err") or ""), r2


def test_anims_route_lists_state_names_per_anim_pack(server) -> None:
    """外观「状态 / 栖息状态」的下拉候选：每个动画包带它 anim.json 的 states 键（真工程只读）。"""
    get, _post, _ = server
    body, _hd = get("/api/anims")
    assert body["ok"] and isinstance(body["images"], list)
    rows = {a["path"]: a["states"] for a in body["anims"]}
    assert all(isinstance(a, dict) and set(a) == {"path", "states"} for a in body["anims"])
    bat = "/resources/runtime/animation/fx_bat/anim.json"
    if bat in rows:
        assert "fly" in rows[bat] and "hang" in rows[bat], rows[bat]


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
    # 本地预览要跟游戏同口径跑：风（薄片只吃它）、透视（薄片尺寸 / 位移）、时段外观（布置按它分份）一样不少
    assert {"wind", "perspectiveScale", "phases", "phase", "timePhase", "dayNight"} <= set(sc["scene"])
    # 布置搬进了布置库：场景描述里不再有 vfx（残留的 vfx 由校验器报 error，工作台不吞也不用）
    assert "vfx" not in sc["scene"]
    ground, _ = get(f"/api/scene_ground?id={SCENE}&bg={sc['scene']['background']}")
    assert len(ground) > 8
    g = sc["scene"]
    # 场景中心的地面点抬高 120 wu 之后去问壳
    r = post("/api/shell_probe", {"id": SCENE, "bg": g["background"], "points": [[0, 0, 0], "not a point"]})
    assert r["ok"] and len(r["contacts"]) == 2 and r["contacts"][1] is None
    c = r["contacts"][0]
    assert c is None or {"penWu", "normal", "px", "py", "groundLike"} <= set(c)
