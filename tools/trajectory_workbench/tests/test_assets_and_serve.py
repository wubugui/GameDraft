# -*- coding: utf-8 -*-
"""资产读写（相对化 / 落形 / 原子写 / id 护栏）与服务端 API（进程内起真服务，临时目录当资产目录）。

工程真数据只读一次（雾津街头 + coin_drop_demo）：重烘必须**逐字节**等于盘上那份——
这是"迁移没改语义"的直接证据。写盘类用例全部指到 tmp 目录，绝不碰工程资产。
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

from tools.trajectory_workbench import assets  # noqa: E402

SCENE = "雾津街头"
COIN = "coin_drop_demo"
_HAS_SCENE = (_ROOT / "public" / "assets" / "scenes" / f"{SCENE}.json").is_file() and \
    (_ROOT / "public" / "resources" / "runtime" / "scenes" / SCENE / "background.png").is_file()
_HAS_COIN = (_ROOT / "public" / "assets" / "data" / "trajectories" / f"{COIN}.json").is_file()


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------

class TestAssets:
    def test_id_guard(self) -> None:
        assert assets.valid_id("coin_drop_demo") and assets.valid_id("铜钱_滚走")
        for bad in ("", "../x", "a/b", "a\\b", "a:b", ".hidden", " pad", "x?y", "a" * 200):
            assert not assets.valid_id(bad), bad
        with pytest.raises(ValueError):
            assets.asset_path("../x")

    def test_relativize_screen_frames_subtracts_anchor_and_rederives_sorty_default(self) -> None:
        frames = [{"atMs": 0, "x": 992, "y": 1411, "sortY": 1500}, {"atMs": 33, "x": 988.27, "y": 1404.04, "sortY": 1500},
                  {"atMs": 66, "x": 900, "y": 1300, "sortY": 1300, "scale": 2, "rotation": 0}]
        out = assets.relativize_screen_frames(frames, (992, 1411))
        assert out[0] == {"atMs": 0, "x": 0, "y": 0, "sortY": 89}
        assert out[1] == {"atMs": 33, "x": -3.73, "y": -6.96, "sortY": 89}
        assert out[2] == {"atMs": 66, "x": -92, "y": -111, "scale": 2}, "sortY==y 就不写；rotation 0 不写"

    def test_write_world_keyframe_relative_and_sparse(self) -> None:
        f = assets.write_world_keyframe({"atMs": 33.4, "x": 10, "y": 20.123456, "z": -3, "h": -1, "rotation": 0, "scaleX": 1, "scaleY": 1, "alpha": 1}, (10, 20, -3))
        assert f == {"atMs": 33, "x": 0, "y": 0.12, "z": 0, "h": 0}
        g = assets.write_world_keyframe({"atMs": 0, "x": 1, "y": 2, "z": 3, "h": 4, "rotation": 12.345, "scaleX": 2, "scaleY": 0.5, "alpha": 0.25}, (0, 0, 0))
        assert list(g.keys()) == ["atMs", "x", "y", "z", "h", "rotation", "scaleX", "scaleY", "alpha"]
        assert g["rotation"] == 12.35 and g["scaleX"] == 2 and g["scaleY"] == 0.5 and g["alpha"] == 0.25

    def test_save_load_rename_delete_in_tmp(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(assets, "TRAJECTORIES_DIR", tmp_path)
        doc = {"authoring": {"sceneId": "x", "anchor": {"x": 0, "y": 0}}, "keyframes": [{"atMs": 0, "x": 0, "y": 0}], "id": "a", "space": "screen", "label": "  "}
        p = assets.save_asset(doc)
        raw = p.read_bytes()
        assert raw.endswith(b"\n") and b"\r\n" not in raw
        loaded = json.loads(raw.decode("utf-8"))
        assert list(loaded.keys()) == ["id", "space", "keyframes", "authoring"], "固定键序、空 label 不落盘"
        assert [r["id"] for r in assets.list_assets()] == ["a"]
        assets.rename_asset("a", "b")
        assert not (tmp_path / "a.json").exists() and assets.load_asset("b")["id"] == "b"
        with pytest.raises(FileExistsError):
            assets.save_asset({"id": "c", "keyframes": []}) and assets.rename_asset("c", "b")
        assert assets.delete_asset("b") and not assets.delete_asset("b")
        assert assets.unique_id("c", ["c", "c_2"]) == "c_3"

    def test_list_reports_broken_files_instead_of_hiding_them(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setattr(assets, "TRAJECTORIES_DIR", tmp_path)
        (tmp_path / "bad.json").write_bytes(b"{not json")
        (tmp_path / "wrongid.json").write_bytes(b'{"id": "other", "keyframes": []}')
        rows = {r["id"]: r for r in assets.list_assets()}
        assert "error" in rows["bad"] and rows["wrongid"]["idMismatch"] is True


# ---------------------------------------------------------------------------
# serve（真 HTTP，进程内）
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(tmp_path, monkeypatch):
    from tools.trajectory_workbench import serve
    monkeypatch.setattr(assets, "TRAJECTORIES_DIR", tmp_path)
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
    get, _post, _ = server
    _body, hd = get("/")
    assert "no-store" in hd.get("Cache-Control", "") and hd.get("Pragma") == "no-cache" and hd.get("Expires") == "0"
    _b, hd2 = get("/api/trajectories")
    assert "no-store" in hd2.get("Cache-Control", "")


def test_unknown_endpoint_and_bad_id_are_errors_not_disconnects(server) -> None:
    _get, post, tmp = server
    assert post("/api/nope", {}) == {"ok": False, "err": "unknown endpoint"}
    bad = post("/api/save", {"doc": {"id": "../x", "space": "screen", "source": {"segments": []}, "authoring": {"sceneId": SCENE, "anchor": {"x": 0, "y": 0}}}})
    assert bad["ok"] is False and "非法" in bad["err"]
    assert not list(tmp.glob("*.json"))


@pytest.mark.skipif(not (_HAS_SCENE and _HAS_COIN), reason="缺工程真数据")
def test_real_coin_asset_rebakes_bitwise_and_world_roundtrip(server) -> None:
    get, post, tmp = server
    coin = json.loads((_ROOT / "public" / "assets" / "data" / "trajectories" / f"{COIN}.json").read_text(encoding="utf-8"))
    b = post("/api/bake", {"doc": coin})
    assert b["ok"] and b["keyframes"] == coin["keyframes"] and not b["warnings"]
    assert len(b["preview"]["screen"]) > len(b["keyframes"])
    # 空段：不许清盘
    empty = post("/api/save", {"doc": {"id": "e", "space": "screen", "source": {"segments": []}, "authoring": coin["authoring"]}})
    assert empty["ok"] is False and not (tmp / "e.json").exists()
    # 世界空间：另存到 tmp → 读回 → 2D/3D 帧一一对应
    w = json.loads(json.dumps(coin))
    w["id"] = "w"
    w["space"] = "world"
    seg = w["source"]["segments"][0]
    seg["v0"] = {"x": -112, "y": 240, "z": 60}
    seg.pop("groundY", None)
    seg["radius"] = 7
    w["source"]["segments"] = [seg]
    r = post("/api/save", {"doc": w})
    assert r["ok"], r
    saved = json.loads((tmp / "w.json").read_text(encoding="utf-8"))
    assert saved["space"] == "world" and len(saved["worldKeyframes"]) == len(saved["keyframes"]) >= 2
    assert [f["atMs"] for f in saved["worldKeyframes"]] == [f["atMs"] for f in saved["keyframes"]]
    # 曲线没有锚点：烘焙机回填曲线起点（origin / originWorld），类型缺省按 sceneId 推成场景曲线
    assert saved["authoring"]["originWorld"] and saved["authoring"]["origin"] and saved["binding"] == "scene"
    assert "anchorWorld" not in saved["authoring"] and "anchorHeight" not in saved["authoring"]
    doc, _ = get("/api/trajectory?id=w")
    assert doc["doc"]["id"] == "w"
    assert post("/api/delete", {"id": "w"}) == {"ok": True, "deleted": True}


@pytest.mark.skipif(not _HAS_SCENE, reason="缺工程真数据")
def test_scene_endpoints(server) -> None:
    get, _post, _ = server
    q = urllib.parse.quote(SCENE)
    s, _ = get(f"/api/scene?id={q}")
    assert s["scene"]["cal"]["groundSource"] in ("ground_d", "shell") and s["scene"]["npcs"]
    bg, hd = get(f"/api/scene_bg?id={q}&w=256")
    assert hd.get("Content-Type") == "image/png" and len(bg) < 400_000
    mesh, _ = get(f"/api/scene_mesh?id={q}&stride=4")
    import struct
    nv, ni = struct.unpack("<II", mesh[:8])
    assert nv > 0 and ni % 3 == 0 and len(mesh) == 8 + nv * 20 + ni * 4
    hf, _ = get(f"/api/scene_heightfield?id={q}")
    n = struct.unpack("<I", hf[:4])[0]
    assert len(hf) == 4 + 32 + n * n * 4
    # 壳与行走面同格式同分辨率；壳在"立着的东西"处比行走面近（深度更小）
    gnd, _ = get(f"/api/scene_ground?id={q}")
    shl, _ = get(f"/api/scene_shell?id={q}")
    gw, gh = struct.unpack("<II", gnd[:8])
    assert struct.unpack("<II", shl[:8]) == (gw, gh) and len(shl) == len(gnd) == 8 + gw * gh * 4
    import numpy as np
    g_arr = np.frombuffer(gnd, np.float32, offset=8)
    s_arr = np.frombuffer(shl, np.float32, offset=8)
    assert np.isfinite(s_arr).all() and (s_arr < g_arr - 1e-3).any(), "场景里总该有东西立在地面上"
    e, _ = get(f"/api/entity?scene={q}&npc=player")
    assert e["entity"]["worldHeight"] == 150.0
