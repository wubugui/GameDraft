# -*- coding: utf-8 -*-
"""雷电样式（样式库 / 参数闸门 / 哈希 / 套进效果 / 同组同步 / 迁移 / 服务端路由）。

雷在游戏里现画：套用 = 把样式参数写进效果的 ``bolts`` 与那几层发射器，不烘任何贴图。
写盘一律指到临时目录（效果目录、样式库、旧生成目录），绝不碰工程资产。
"""
from __future__ import annotations

import copy
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.vfx_workbench import assets, lightning  # noqa: E402
from tools.editor.shared.vfx_bolt import effect_bolt_problems  # noqa: E402
from tools.editor.shared.vfx_generator import generator_problems, style_ids  # noqa: E402


@pytest.fixture()
def proj(tmp_path, monkeypatch):
    """临时工程：效果目录 / 样式库 / 旧生成目录全指到 tmp。"""
    vfx = tmp_path / "vfx"
    vfx.mkdir()
    monkeypatch.setattr(assets, "VFX_DIR", vfx)
    monkeypatch.setattr(lightning, "LIB_PATH", tmp_path / "vfx_lightning_styles.json")
    monkeypatch.setattr(lightning, "LEGACY_OUT_ROOT", tmp_path / "legacy_lightning")
    return tmp_path


def _style(sid: str = "fast", **over) -> dict:
    p = copy.deepcopy(lightning.style_map(lightning.default_library())["ref_bolt"]["params"])
    p.update(over)
    return {"id": sid, "label": sid, "kind": "bolt", "params": p}


def _effect(eid: str, style: str = "ref_bolt", seed: int = 5, group: str = "") -> dict:
    """旧版（离线烘贴图）的样子：样式那几层是帧表，外加旧的电丝层与作者自己的落点层。"""
    g = {"kind": "lightning", "style": style, "seed": seed}
    if group:
        g["group"] = group
    return {"id": eid, "emitters": [
        {"id": "bolt", "appearance": {"animFile": "/old/bolt/anim.json", "frameRate": 30, "sizeWu": 400,
                                      "alphaOverLife": [[0, 0.5], [1, 0]]},
         "spawn": {"max": 1, "burst": 1}, "life": {"seconds": [0.46, 0.46]}},
        {"id": "bolt_arcs", "appearance": {"animFile": "/old/arcs/anim.json", "sizeWu": 100}, "spawn": {"max": 1, "burst": 1}},
        {"id": "impact_sparks", "appearance": {"image": "/spark.png", "sizeWu": 3}, "spawn": {"max": 40, "burst": 40}},
    ], "generator": g}


# ---------------------------------------------------------------------------
# 参数闸门 / 样式库
# ---------------------------------------------------------------------------

def test_presets_are_drawn_bolts_and_the_first_is_the_reference_look() -> None:
    lib = lightning.default_library()
    assert [s["id"] for s in lib["styles"]] == list(lightning.PRESET_IDS) == ["ref_bolt", "ref_bolt_straight", "ref_bolt_branchy"]
    assert {s["kind"] for s in lib["styles"]} == {"bolt"}
    st = lightning.style_map(lib)
    assert st["ref_bolt_straight"]["params"]["branchPerKWu"] < st["ref_bolt"]["params"]["branchPerKWu"] \
        < st["ref_bolt_branchy"]["params"]["branchPerKWu"]
    keys = {s["key"] for s in lightning.SPEC["bolt"]}
    assert {"blastStrengthWu", "blastRadiusWu", "blastSeconds", "igniteRadiusWu"} <= keys, "落地那一下（冲击风 / 点火）在样式里调"


def test_normalize_fills_defaults_drops_unknown_and_rejects_bad_values() -> None:
    s = lightning.normalize_style({"id": "x", "kind": "bolt", "params": {"branchPerKWu": 40, "bogus": 1}})
    assert s["params"]["branchPerKWu"] == 40 and "bogus" not in s["params"]
    assert s["params"]["coreWu"] == lightning.style_map(lightning.default_library())["ref_bolt"]["params"]["coreWu"]
    assert s["label"] == "x"
    for bad, msg in (({"roughness": 0.9}, "之间"), ({"forkDepth": 1.5}, "整数"), ({"kinkDeg": [9, 3]}, "前一个"),
                     ({"glowColor": [1, 2, 0]}, "0..1"), ({"groundArcCount": [2.5, 3]}, "整数"),
                     ({"branchMinWu": 900, "branchMaxWu": 100}, "最短")):
        with pytest.raises(ValueError, match=msg):
            lightning.normalize_style({"id": "x", "kind": "bolt", "params": bad})
    with pytest.raises(ValueError, match="形状模型"):
        lightning.normalize_style({"id": "x", "kind": "rope"})
    with pytest.raises(ValueError, match="重复"):
        lightning.normalize_library({"styles": [{"id": "a", "kind": "bolt"}, {"id": "a", "kind": "bolt"}]})
    with pytest.raises(ValueError, match="至少"):
        lightning.normalize_library({"styles": []})


def test_hash_ignores_int_vs_float_but_follows_every_param_and_the_seed() -> None:
    """页面 JSON 把 1.0 写成 1、盘上还是 1.0：同一个值必须同一个哈希（套用完立刻显示"过期"就是这个）。"""
    a = _style()
    b = copy.deepcopy(a)
    b["params"]["coreColor"] = [1.0, 1.0, 1.0]
    b["params"]["detailWu"] = 3.0
    assert lightning.expected_hash(a, 5) == lightning.expected_hash(b, 5)
    for k, v in (("zigzag", 0.61), ("igniteRadiusWu", 81), ("blastSeconds", 1.3)):
        c = copy.deepcopy(a)
        c["params"][k] = v
        assert lightning.expected_hash(a, 5) != lightning.expected_hash(c, 5), k
    assert lightning.expected_hash(a, 5) != lightning.expected_hash(a, 6)


def test_library_save_checks_the_loaded_base(proj) -> None:
    lib = lightning.default_library()
    lightning.save_library(lib)
    external = copy.deepcopy(lib)
    external["styles"][1]["label"] = "外面改的"
    lightning.save_library(external)
    mine = copy.deepcopy(lib)
    mine["styles"][2]["label"] = "我改的"
    with pytest.raises(ValueError, match="外部修改"):
        lightning.save_library(mine, base=lib)
    assert lightning.load_library()[0]["styles"][1]["label"] == "外面改的"
    assert lightning.save_library(mine, base=external)["styles"][2]["label"] == "我改的"


def test_generator_block_shape_is_shared_with_the_validator(proj) -> None:
    assert generator_problems({"kind": "lightning", "style": "ref_bolt", "seed": 3}) == []
    for bad in ({"kind": "fire", "style": "a", "seed": 1}, {"kind": "lightning", "style": "", "seed": 1},
                {"kind": "lightning", "style": "a", "seed": -1}, {"kind": "lightning", "style": "a", "seed": 1.5}, []):
        assert generator_problems(bad), bad
    assert style_ids(proj) is None, "样式库不存在 = None（校验器据此报库本身的问题）"
    lightning.save_library(lightning.default_library())
    assert "ref_bolt" in style_ids(proj)


# ---------------------------------------------------------------------------
# 参数 → 效果
# ---------------------------------------------------------------------------

def test_bolts_carry_shape_lights_and_impact_and_pass_the_shared_gate() -> None:
    p = _style()["params"]
    sky, ground, water = lightning.bolts_for(p, 7)
    assert (sky["id"], sky["kind"], sky["seed"]) == ("sky", "sky", 7)
    assert (ground["seed"], water["seed"]) == (8, 9), "贴地 / 水面电弧各自的种子"
    assert sky["sky"]["cloudWu"] == lightning.CLOUD_WU and sky["sky"]["tiltDeg"] == p["tiltDeg"]
    assert sky["light"]["channel"] == {"gain": p["channelGain"], "heightWu": p["channelHeightWu"], "rangeWu": p["channelRangeWu"]}
    assert sky["impact"] == {"blast": {"strengthWu": p["blastStrengthWu"], "radiusWu": p["blastRadiusWu"],
                                       "seconds": p["blastSeconds"]}, "igniteRadiusWu": p["igniteRadiusWu"]}
    assert "impact" not in ground and "light" not in water
    doc = {"id": "x", "bolts": [sky, ground, water], "emitters": []}
    assert effect_bolt_problems(doc) == []
    # 0 = 不要：没有冲击风就不写 blast（闸门要求三项 > 0），不点火就不写半径，两样都不要就没有 impact
    only_fire = lightning.bolts_for({**p, "blastStrengthWu": 0}, 7)[0]
    assert only_fire["impact"] == {"igniteRadiusWu": p["igniteRadiusWu"]}
    assert "impact" not in lightning.bolts_for({**p, "blastStrengthWu": 0, "igniteRadiusWu": 0}, 7)[0]


def test_impact_gate_rejects_bad_blasts_and_impact_on_surface_arcs() -> None:
    base = lightning.bolts_for(_style()["params"], 1)
    sky = copy.deepcopy(base[0])
    sky["impact"] = {"blast": {"strengthWu": 0, "radiusWu": 10, "seconds": 1}, "igniteRadiusWu": -1}
    probs = effect_bolt_problems({"bolts": [sky], "emitters": []})
    assert any("strengthWu" in x for x in probs) and any("igniteRadiusWu" in x for x in probs)
    arc = copy.deepcopy(base[1])
    arc["impact"] = {"igniteRadiusWu": 10}
    assert any("贴地电弧" in x for x in effect_bolt_problems({"bolts": [arc], "emitters": []}))


def test_apply_style_rebuilds_owned_layers_keeps_author_layers_and_drops_the_old_arcs() -> None:
    doc = _effect("e1")
    out = lightning.apply_style(doc, lightning.normalize_style(_style()), 5)
    ids = [e["id"] for e in out["emitters"]]
    assert ids == ["bolt", "bolt_stroke", "ground_arcs", "water_arcs", "impact_sparks"], \
        "样式层按 OWNED 在前；旧版的电丝层（画的是删掉的旧贴图）拿掉；作者的落点层原样原序"
    bolt = out["emitters"][0]["appearance"]
    assert "animFile" not in bolt and "frameRate" not in bolt
    assert bolt["alphaOverLife"] == lightning.LAYER_DEFAULTS["bolt"]["alphaOverLife"], "帧表 → 现画：换了形式，回缺省曲线"
    assert bolt["bolt"]["bolt"] == "sky" and bolt["bolt"]["part"] == "all"
    assert out["emitters"][1]["appearance"]["bolt"]["part"] == "main"
    assert out["emitters"][2]["onSurface"] == ["ground"] and out["emitters"][3]["onSurface"] == ["water"]
    assert out["emitters"][4] == doc["emitters"][2]
    assert out["generator"]["built"] == lightning.expected_hash(lightning.normalize_style(_style()), 5)
    norm = assets.normalize_effect(out)
    assert effect_bolt_problems(norm) == [] and norm["bolts"][0]["impact"]["igniteRadiusWu"] > 0
    # 同一形式再套：作者调过的曲线 / 寿命留着，只换 appearance.bolt
    out["emitters"][0]["appearance"]["alphaOverLife"] = [[0, 0.5], [1, 0]]
    out["emitters"][0]["life"] = {"seconds": [0.3, 0.3]}
    again = lightning.apply_style(out, lightning.normalize_style(_style(coreWu=2)), 5)
    assert again["emitters"][0]["appearance"]["alphaOverLife"] == [[0, 0.5], [1, 0]]
    assert again["emitters"][0]["life"] == {"seconds": [0.3, 0.3]} and again["emitters"][0]["appearance"]["bolt"]["coreWu"] == 2
    no_stroke = lightning.apply_style(doc, lightning.normalize_style(_style(strokeCoreGain=0)), 5)
    assert "bolt_stroke" not in [e["id"] for e in no_stroke["emitters"]], "回击加粗亮度 0 = 不要那一层"


def test_apply_end_to_end_switches_a_group_and_guards_the_library(proj) -> None:
    lib = lightning.default_library()
    lightning.save_library(lib)
    for eid in ("g1", "g2"):
        assets.save_asset(_effect(eid, group="G"))
    r = lightning.apply(lib, lib)                       # 旧版的哈希对不上 → 两份都重新套用
    assert [x["id"] for x in r["results"] if x["ok"]] == ["g1", "g2"]
    assert all(row["upToDate"] for row in lightning.status_rows())
    assert lightning.apply(lib, lib)["results"] == [], "什么都没变：不重写"
    lib2 = {**lib, "styles": lib["styles"] + [_style("mine", branchPerKWu=40)]}
    r = lightning.apply(lib2, lib, assign={"g1": "mine", "g2": "mine"})
    assert all(x["ok"] for x in r["results"])
    g1 = assets.load_asset("g1")
    assert g1["generator"]["style"] == "mine" and g1["bolts"][0]["sky"]["branchPerKWu"] == 40
    lib2 = lightning.load_library()[0]
    with pytest.raises(ValueError, match="还被"):
        lightning.apply({"styles": [s for s in lib2["styles"] if s["id"] != "mine"]}, lib2)
    with pytest.raises(ValueError, match="不在样式库里"):
        lightning.apply(lib2, lib2, assign={"g1": "nope"})
    lightning.save_library({**lib2, "styles": [{**lib2["styles"][0], "label": "别处改了"}] + lib2["styles"][1:]})
    with pytest.raises(ValueError, match="外部修改"):
        lightning.apply({**lib2, "styles": [{**lib2["styles"][0], "label": "旧窗口"}] + lib2["styles"][1:]}, lib2)


def test_sync_group_copies_author_layers_but_keeps_each_bolt_shape(proj) -> None:
    lightning.save_library(lightning.default_library())
    for eid, seed in (("a", 1), ("b", 2), ("c", 3)):
        assets.save_asset(_effect(eid, seed=seed, group="G" if eid != "c" else "other"))
    lightning.apply(lightning.default_library(), lightning.load_library()[0])
    src = assets.load_asset("a")
    src["emitters"].append({"id": "water_splash", "onSurface": ["water"], "appearance": {"image": "/drop.png", "sizeWu": 6},
                            "spawn": {"max": 10, "burst": 10}})
    src["prewarmSeconds"] = [1, 1]
    assets.save_asset(src)
    res = lightning.sync_group("a")
    assert [(x["id"], x["ok"], x["changed"]) for x in res] == [("b", True, True)], "只抄同组"
    b = assets.load_asset("b")
    assert [e["id"] for e in b["emitters"]][-1] == "water_splash" and b["bolts"][0]["seed"] == 2
    assert b["emitters"][4:] == assets.load_asset("a")["emitters"][4:]
    assert "water_splash" not in [e["id"] for e in assets.load_asset("c")["emitters"]]
    assert lightning.sync_group("a")[0]["changed"] is False
    assets.save_asset({"id": "solo", "emitters": [{"id": "x", "appearance": {"image": "/a.png", "sizeWu": 1},
                                                   "spawn": {"max": 1, "burst": 1}}]})
    with pytest.raises(ValueError, match="不在任何"):
        lightning.sync_group("solo")


def test_migrate_replaces_the_library_reapplies_every_effect_and_removes_the_old_outputs(proj) -> None:
    (proj / "vfx_lightning_styles.json").write_text(json.dumps({"styles": [{"id": "rope", "kind": "rope"}]}), encoding="utf-8")
    assert lightning.load_library()[0] is None, "旧版的样式库（旧形状模型）读不懂——迁移正是要换掉它"
    old_out = proj / "legacy_lightning" / "e1" / "h"
    old_out.mkdir(parents=True)
    (old_out / "atlas.png").write_bytes(b"x")
    assets.save_asset(_effect("e1", style="rope_stroke_thick"))
    res = lightning.migrate_to_bolt()
    assert [(r["id"], r["ok"]) for r in res] == [("e1", True)]
    assert [s["id"] for s in lightning.load_library()[0]["styles"]] == list(lightning.PRESET_IDS)
    e1 = assets.load_asset("e1")
    assert e1["generator"]["style"] == "ref_bolt" and "bolt_arcs" not in [e["id"] for e in e1["emitters"]]
    assert not (proj / "legacy_lightning").exists()


# ---------------------------------------------------------------------------
# 服务端路由
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(proj, monkeypatch):
    from tools.vfx_workbench import placements, serve
    monkeypatch.setattr(placements, "LIB_ROOT", proj / "libroot")
    monkeypatch.setattr(placements, "REF_ROOT", proj / "refroot")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

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

    yield get, post
    httpd.shutdown()


def test_routes_state_compose_sync_and_apply(server, proj) -> None:
    get, post = server
    st, hd = get("/api/lightning")
    assert st["ok"] and not st["libraryOnDisk"] and [s["id"] for s in st["library"]["styles"]][0] == "ref_bolt"
    assert {s["key"] for s in st["spec"]["bolt"]} >= {"tiltDeg", "branchPerKWu", "coreMinPx", "channelGain", "igniteRadiusWu"}
    assert "no-store" in hd.get("Cache-Control", "")
    assert not post("/api/lightning/compose", {"style": {"id": "x"}, "seed": "1"})["ok"]
    bad = post("/api/lightning/compose", {"style": _style(roughness=0.9), "seed": 1})
    assert not bad["ok"] and "之间" in bad["err"]
    # 只读：拼出「套用之后」的 bolts 与样式那几层，不落任何盘
    c = post("/api/lightning/compose", {"style": _style(), "seed": 3, "doc": _effect("x")})
    assert c["ok"] and [b["id"] for b in c["bolts"]] == ["sky", "ground", "water"]
    assert [e["id"] for e in c["emitters"]] == list(lightning.OWNED)
    assert not any(proj.joinpath("vfx").iterdir()) and not (proj / "vfx_lightning_styles.json").exists()
    with pytest.raises(urllib.error.HTTPError):
        get("/gen/lightning/x.png")
    lib = copy.deepcopy(st["library"])
    assets.save_asset(_effect("r1", group="G"))
    assets.save_asset(_effect("r2", seed=9, group="G"))
    r = post("/api/lightning/apply", {"library": lib, "base": st["library"]})
    assert r["ok"] and r["libraryOnDisk"] and [x["id"] for x in r["results"]] == ["r1", "r2"]
    assert all(e["upToDate"] for e in r["effects"])
    s = post("/api/lightning/sync_group", {"effectId": "r1"})
    assert s["ok"] and [x["id"] for x in s["results"]] == ["r2"]
    assert not post("/api/lightning/sync_group", {})["ok"]
    p, _ = get("/api/lightning/progress")
    assert p["ok"] and not p["running"]
