# -*- coding: utf-8 -*-
"""布置库（``vfx_placements.json``）在粒子工作台这一侧：读写 / 归一化 / 语义检查 / 效果改名连带 / 删除守卫 /
时段外观 / 进程内真 HTTP 路由 / 联动推送（整份工作态库 + 切时段请求，序号服务端发且粘着重发）。

写盘一律在临时目录：``assets.VFX_DIR``、``placements.LIB_ROOT``、``placements.SCENES_JSON`` 全指到 tmp，
工程真数据只读（真库必须过形状闸门且归一化幂等——"闸门与线上数据同口径"的直接证据）。
"""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.shared import vfx_placements as vp  # noqa: E402
from tools.vfx_workbench import assets, placements  # noqa: E402

DN = [{"id": "辰", "label": "辰时", "daylight": True}, {"id": "午", "label": "午时", "daylight": True},
      {"id": "暮", "label": "向晚"}, {"id": "夜", "label": "入夜"}]


def _row(iid: str = "r1", effect: str = "fx", **over) -> dict:
    d = {"id": iid, "effect": effect, "anchor": {"x": 10, "y": 20}}
    d.update(over)
    return d


def _effect(eid: str) -> dict:
    return {"id": eid, "emitters": [{"id": "a", "appearance": {"image": "/x.png", "sizeWu": 4}, "spawn": {"max": 3, "rate": 1}}]}


@pytest.fixture()
def world(tmp_path, monkeypatch):
    """临时工程：效果目录 + 布置库根 + 两个场景（开了日夜带「夜」变体的 hill / 没开日夜的 room）。"""
    vfx = tmp_path / "vfx"
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (scenes / "hill.json").write_text(json.dumps({
        "id": "hill", "backgrounds": [{"image": "background.png"}], "dayNight": {"enabled": True},
        "timeVariants": {"夜": {"backgrounds": [{"image": "night.png"}]}, "午": {}},
    }, ensure_ascii=False), encoding="utf-8")
    (scenes / "room.json").write_text(json.dumps({"id": "room", "backgrounds": [{"image": "bg.png"}]}), encoding="utf-8")
    cfg = tmp_path / "game_config.json"
    cfg.write_text(json.dumps({"dayNight": {"phases": DN}}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(assets, "VFX_DIR", vfx)
    monkeypatch.setattr(placements, "LIB_ROOT", tmp_path / "libroot")
    monkeypatch.setattr(placements, "SCENES_JSON", scenes)
    monkeypatch.setattr(placements, "GAME_CONFIG", cfg)
    # 布置库之外的引用（挂件预设 / playVfx）也扫临时工程：真工程里的 torch 不许混进这些用例
    monkeypatch.setattr(placements, "REF_ROOT", tmp_path / "refroot")
    for eid in ("fx", "other"):
        assets.save_asset(_effect(eid))
    return tmp_path


# ---------------------------------------------------------------------------
# 时段外观
# ---------------------------------------------------------------------------

def test_scene_phases_follow_resolve_scene_appearance(world) -> None:
    hill = placements.scene_doc("hill")
    ph = placements.scene_phases(hill)
    assert [p["key"] for p in ph] == ["", "夜", "午"], "base 在前，变体按场景 JSON 顺序"
    base, night, noon = ph
    assert base["background"] == "background.png" and night["background"] == "night.png"
    assert noon["background"] == "background.png", "变体没写 backgrounds = 用顶层背景（外观键照样是它自己）"
    # base 该切到的真实时段：没单列外观的第一个、优先白天——午单列了，所以是辰
    assert base["timePhase"] == "辰" and night["timePhase"] == "夜" and noon["timePhase"] == "午"
    assert base["label"] == "基底（辰时、向晚）" and night["label"] == "入夜（夜）"
    room = placements.scene_phases(placements.scene_doc("room"))
    assert [(p["key"], p["timePhase"]) for p in room] == [("", "")], "没开日夜：只有 base，切时段也换不到别的外观"


def test_scene_phases_base_prefers_daylight_and_ignores_variants_without_daynight(world) -> None:
    data = {"backgrounds": [{"image": "b.png"}], "dayNight": {"enabled": True},
            "timeVariants": {"辰": {}, "午": {}}}
    assert placements.scene_phases(data, DN)[0]["timePhase"] == "暮", "白天都单列了 → 退到第一个剩下的"
    night_first = [{"id": "夜", "label": "入夜"}, {"id": "辰", "label": "辰时", "daylight": True}]
    plain = {"backgrounds": [{"image": "b.png"}], "dayNight": {"enabled": True}}
    assert placements.scene_phases(plain, night_first)[0]["timePhase"] == "辰", "按 game_config 顺序，但优先 daylight:true"
    allv = {"backgrounds": [], "dayNight": {"enabled": True}, "timeVariants": {p["id"]: {} for p in DN}}
    assert placements.scene_phases(allv, DN)[0]["timePhase"] == "", "每个时段都单列了外观：基底永远用不到"
    off = {"backgrounds": [{"image": "b.png"}], "timeVariants": {"夜": {"backgrounds": [{"image": "n.png"}]}}}
    assert [p["key"] for p in placements.scene_phases(off, DN)] == [""], "没开 dayNight.enabled 时变体整套不生效"


# ---------------------------------------------------------------------------
# 读写 / 归一化 / 语义检查
# ---------------------------------------------------------------------------

def test_missing_library_is_empty_and_save_writes_normalized_lf(world) -> None:
    doc, err = placements.load()
    assert doc == vp.empty_library() and not err
    lib = {"scenes": {"hill": {"variants": {"夜": [{"anchor": {"y": 2, "x": 1}, "effect": "fx", "id": "a", "zz": 1}]},
                               "base": [_row("b")]}}}
    path, norm, warn = placements.save(lib)
    raw = path.read_bytes()
    assert raw.endswith(b"\n") and b"\r\n" not in raw, "LF + 末尾换行（Windows 上 write_text 会翻译换行）"
    assert path == vp.library_path(world / "libroot") and not warn
    back = json.loads(raw.decode("utf-8"))
    assert list(back.keys()) == ["_comment", "scenes"]
    assert list(back["scenes"]["hill"].keys()) == ["base", "variants"]
    row = back["scenes"]["hill"]["variants"]["夜"][0]
    assert list(row.keys()) == ["id", "effect", "anchor", "zz"], "已知键按 types.ts 序、未知键原样透传到末尾"
    assert list(row["anchor"].keys()) == ["x", "y"]
    x = row["anchor"]["x"]
    assert x == 1 and isinstance(x, int), "整数不许漂成 float"
    assert placements.load()[0] == back


def test_scope_save_detects_external_edit_without_blocking_unrelated_scopes(world) -> None:
    _, base, _ = placements.save({'scenes': {'hill': {'base': [_row()]}, 'room': {'base': [_row('room')]}}})
    placements.save_changes({'scenes': {'room': {'base': [_row('room', anchor={'x': 90, 'y': 20})]}}})
    change = {'scenes': {'hill': {'base': [_row(anchor={'x': 40, 'y': 20})]}}}
    _, saved, _ = placements.save_changes(change, base)
    assert vp.rows_for(saved, 'room', '')[0]['anchor']['x'] == 90
    assert placements.save_changes(change, base)[1] == saved, 'Retry is idempotent'
    stale = {'scenes': {'hill': {'base': []}}}
    before = placements.lib_path().read_bytes()
    with pytest.raises(ValueError, match='外部修改'):
        placements.save_changes(stale, base)
    assert placements.lib_path().read_bytes() == before
    assert vp.rows_for(placements.save_changes(stale, saved)[1], 'hill', '') == []


def test_scope_save_writes_a_normalize_fixed_point(world) -> None:
    """save_changes 写出去的必须是 ``normalize_library`` 的不动点（真库 09-21 就因此失配过：
    崖墓入口原来只有 variants，工作台给它加 base 后落成了 variants 在前）。未编辑的场景逐字不动。"""
    placements._write(vp.dumps({"_comment": "c", "scenes": {
        "hill": {"variants": {"夜": [_row("n")]}},
        "room": {"base": [_row("smoke", anchor={"x": 15, "y": 30, "h": 205})], "future": {"keep": 7}},
    }}))

    def disk() -> tuple[bytes, dict]:
        raw = placements.lib_path().read_bytes()
        return raw, json.loads(raw.decode("utf-8"))

    placements.save_changes({"scenes": {"hill": {"base": [_row("b")]}}})
    raw, doc = disk()
    assert list(doc["scenes"]["hill"]) == ["base", "variants"], "只有 variants 的场景加上 base：base 要在前"
    assert vp.dumps(vp.normalize_library(doc)) == raw
    assert doc["scenes"]["room"] == {"base": [_row("smoke", anchor={"x": 15, "y": 30, "h": 205})], "future": {"keep": 7}}

    placements.save_changes({"scenes": {"hill": {"variants": {"夜": []}}}})
    raw, doc = disk()
    assert doc["scenes"]["hill"] == {"base": [_row("b")]}, "清空最后一个时段份：连 variants 一起剥，不留 {\"夜\": []}"
    assert vp.dumps(vp.normalize_library(doc)) == raw

    placements.save_changes({"scenes": {"hill": {"base": []}}})
    raw, doc = disk()
    assert "hill" not in doc["scenes"], "一份都不剩的场景整条剥掉"
    assert vp.dumps(vp.normalize_library(doc)) == raw


def test_save_rejects_bad_shapes_and_writes_nothing(world) -> None:
    for bad, msg in (
        ({"scenes": {"hill": {"base": [_row(timePhases=["夜"])]}}}, "timePhases"),
        ({"scenes": {"hill": {"base": [_row("a"), _row("a")]}}}, "重复"),
        ({"scenes": {"hill": {"base": [_row(confine={"feather": 3})]}}}, "confine"),
        ({"scenes": {"hill": {"base": [_row(area=[[0, 0], [1, 1]])]}}}, "area"),
        ({"scenes": {"hill": {"base": [{"id": "a", "effect": "fx"}]}}}, "anchor"),
    ):
        with pytest.raises(ValueError) as e:
            placements.save(bad)
        assert msg in str(e.value), str(e.value)
    assert not placements.lib_path().exists()


def test_semantic_check_vetoes_only_changed_portions(world) -> None:
    """场景不存在 / 时段键不对：本次真改了的那份 = error；盘上原样没动的那份 = warning（不锁死整个库）。"""
    placements._write(vp.dumps({"_comment": "c", "scenes": {"gone": {"base": [_row()]}}}))
    # 盘上已有的"场景被删了"那份没动 → 只告警，别的改动照存
    lib = {"_comment": "c", "scenes": {"gone": {"base": [_row()]}, "hill": {"variants": {"夜": [_row("n")]}}}}
    _p, _norm, warn = placements.save(lib)
    assert any("gone" in w and "不存在" in w for w in warn), warn
    # 改了不存在场景那一份 → 拒
    lib2 = json.loads(json.dumps(lib))
    lib2["scenes"]["gone"]["base"][0]["anchor"]["x"] = 99
    with pytest.raises(ValueError) as e:
        placements.save(lib2)
    assert "gone" in str(e.value) and "不存在" in str(e.value)
    # 时段键不是这个场景的外观键 → 拒
    with pytest.raises(ValueError) as e:
        placements.save({"scenes": {"hill": {"variants": {"暮": [_row()]}}}})
    assert "暮" in str(e.value) and "时段外观" in str(e.value)
    # 效果不存在 → warning（可能正要去新建）
    _p, _n, warn = placements.save({"scenes": {"hill": {"base": [_row(effect="nope")]}}})
    assert any("nope" in w for w in warn), warn
    # 没开日夜的场景写了变体（键在 timeVariants 里也不行，这里 room 没有 timeVariants → error）
    with pytest.raises(ValueError):
        placements.save({"scenes": {"room": {"variants": {"夜": [_row()]}}}})


def test_save_refuses_to_overwrite_an_unreadable_library(world) -> None:
    p = placements.lib_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"{not json")
    with pytest.raises(ValueError) as e:
        placements.save({"scenes": {}})
    assert "读不懂" in str(e.value)
    assert p.read_bytes() == b"{not json", "读不懂的库一个字节都不许覆盖"


def test_real_library_passes_the_gate_and_normalize_is_idempotent() -> None:
    doc, err = vp.load_library(_ROOT)
    assert not err
    a = vp.normalize_library(doc)
    b = vp.normalize_library(json.loads(json.dumps(a, ensure_ascii=False)))
    assert vp.dumps(a) == vp.dumps(b)


# ---------------------------------------------------------------------------
# 效果改名 / 删除连带布置
# ---------------------------------------------------------------------------

def _two_scene_lib() -> dict:
    return {"_comment": "c", "scenes": {
        "hill": {"base": [_row("a", "fx"), _row("b", "other")], "variants": {"夜": [_row("a", "fx")]}},
        "room": {"base": [_row("c", "fx")]},
    }}


def test_rename_effect_renames_placements_first(world) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    r = placements.rename_effect("fx", "fx2")
    assert r["placementsChanged"] == 3 and (assets.VFX_DIR / "fx2.json").is_file() and not (assets.VFX_DIR / "fx.json").exists()
    lib = placements.load()[0]
    assert placements.refs_to_effect(lib, "fx") == []
    assert [(x["sceneId"], x["phase"], x["id"]) for x in placements.refs_to_effect(lib, "fx2")] == \
        [("hill", "", "a"), ("hill", "夜", "a"), ("room", "", "c")]
    assert vp.rows_for(lib, "hill", "")[1]["effect"] == "other", "别的效果的布置一个字不动"


def test_rename_failure_rolls_the_library_back(world, monkeypatch) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    before = placements.lib_path().read_bytes()

    def boom(old, new):
        raise OSError("磁盘满了")
    monkeypatch.setattr(assets, "rename_asset", boom)
    with pytest.raises(RuntimeError) as e:
        placements.rename_effect("fx", "fx2")
    assert "已回滚" in str(e.value)
    assert placements.lib_path().read_bytes() == before


def test_rename_reports_half_state_when_rollback_also_fails(world, monkeypatch) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    monkeypatch.setattr(assets, "rename_asset", lambda o, n: (_ for _ in ()).throw(OSError("改名失败")))
    monkeypatch.setattr(placements, "_restore", lambda snap: (_ for _ in ()).throw(OSError("回滚也失败")))
    with pytest.raises(RuntimeError) as e:
        placements.rename_effect("fx", "fx2")
    msg = str(e.value)
    assert "回滚也失败" in msg and "3 条" in msg and "fx2" in msg, msg


def test_rename_guards(world) -> None:
    with pytest.raises(FileNotFoundError):
        placements.rename_effect("nope", "x")
    with pytest.raises(FileExistsError):
        placements.rename_effect("fx", "other")
    p = placements.lib_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"[]")
    with pytest.raises(ValueError):
        placements.rename_effect("fx", "fx3")
    assert (assets.VFX_DIR / "fx.json").is_file(), "库读不懂 = 查不了引用 = 不改名"


def test_delete_guard_lists_refs_then_deletes_with_placements(world) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    r = placements.delete_effect("fx", with_placements=False)
    assert r["deleted"] is False and r["needConfirm"] is True
    assert [(x["sceneId"], x["phase"], x["id"]) for x in r["refs"]] == [("hill", "", "a"), ("hill", "夜", "a"), ("room", "", "c")]
    assert (assets.VFX_DIR / "fx.json").is_file() and placements.refs_to_effect(placements.load()[0], "fx")
    r2 = placements.delete_effect("fx", with_placements=True)
    assert r2["deleted"] is True and r2["placementsRemoved"] == 3 and not (assets.VFX_DIR / "fx.json").exists()
    lib = placements.load()[0]
    assert placements.refs_to_effect(lib, "fx") == []
    assert list(lib["scenes"].keys()) == ["hill"] and "variants" not in lib["scenes"]["hill"], "删空的份 / 场景剥掉"
    # 没人引用的直接删
    r3 = placements.delete_effect("other", with_placements=False)
    assert r3["needConfirm"] is True, "hill.base 里的 b 还引用着 other"


def test_delete_failure_rolls_the_library_back(world, monkeypatch) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    before = placements.lib_path().read_bytes()
    monkeypatch.setattr(assets, "delete_asset", lambda eid: (_ for _ in ()).throw(OSError("被占用")))
    with pytest.raises(RuntimeError) as e:
        placements.delete_effect("fx", with_placements=True)
    assert "已回滚" in str(e.value) and placements.lib_path().read_bytes() == before


def _external_world(world) -> dict[str, bytes]:
    """临时工程里放一份挂件预设（顶层 particles + states.ember.particles，外加一条运行时不读的旧 vfx）
    与一段演出里的 playVfx 临时实例；返回原字节（核"一个字节都不写"）。"""
    root = placements.REF_ROOT
    data = root / "public" / "assets" / "data"
    (data / "cutscenes").mkdir(parents=True)
    (data / "archive").mkdir()
    (data / "vfx").mkdir()
    files = {
        data / "prop_presets.json": {"torch": {"label": "火把", "particles": [{"effect": "other", "point": [0.5, 0]}],
                                               "states": {"lit": {},
                                                          "ember": {"particles": [{"effect": "smoke"}, {"effect": "fx"}]},
                                                          "out": {"vfx": ["fx"]}}},
                                     "sword": {"label": "剑"}},
        data / "cutscenes" / "index.json": [{"id": "cs1", "steps": [
            {"kind": "action", "type": "playSfx", "params": {"id": "x"}},
            {"kind": "action", "type": "playVfx", "params": {"effect": "fx", "x": 1, "y": 2}}]}],
        # 归档 / 备份 / 本台自己写的目录不算（运行时不读它们，列出来只会误拦改名）
        data / "archive" / "old.json": [{"type": "playVfx", "params": {"effect": "fx"}}],
        data / "quests.json.bak": [{"type": "playVfx", "params": {"effect": "fx"}}],
        data / "vfx" / "fx.json": {"type": "playVfx", "params": {"effect": "fx"}},
    }
    out = {}
    for p, doc in files.items():
        b = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        p.write_bytes(b)
        out[str(p)] = b
    return out


def test_external_refs_list_held_props_and_play_vfx_actions(world) -> None:
    _external_world(world)
    refs = placements.external_refs_to_effect("fx")
    assert [(r["kind"], r["where"]) for r in refs] == [("prop", "torch · states.ember.particles[1]"), ("action", "[0].steps[1]")], \
        f"粒子挂载按条给下标；运行时不读的旧 vfx 不算引用：{refs}"
    assert refs[0]["file"] == "public/assets/data/prop_presets.json" and refs[1]["file"] == "public/assets/data/cutscenes/index.json"
    assert [r["where"] for r in placements.external_refs_to_effect("other")] == ["torch · particles[0]"]
    assert placements.external_refs_to_effect("nobody") == []
    assert "prop_presets.json" in placements.external_refs_text(refs) and "cutscenes/index.json" in placements.external_refs_text(refs)


def test_play_prop_vfx_effect_refs_are_listed_and_guard_rename_and_delete(world) -> None:
    """``playPropVfx``（手持挂件上播的效果）也按 id 引用效果：常住挂件预设状态的 ``onEnterActions``
    （火把灭了冒的那口烟），也可能在演出里。漏扫 = 工作台里改名 / 删掉它，火把熄灭时静默不冒烟。"""
    root = placements.REF_ROOT
    data = root / "public" / "assets" / "data"
    (data / "cutscenes").mkdir(parents=True)
    files = {
        data / "prop_presets.json": {"torch": {"label": "火把", "states": {
            "lit": {},
            "out": {"onEnterActions": [
                {"type": "playSfx", "params": {"id": "snuff"}},
                {"type": "runActions", "params": {"actions": [
                    {"type": "playPropVfx", "params": {"target": "player", "socket": "right_hand", "effect": "fx"}}]}},
                {"type": "playPropVfx", "params": {"effect": "fx"}},
            ]},
        }}},
        data / "cutscenes" / "index.json": [{"id": "cs1", "steps": [
            {"kind": "action", "type": "playPropVfx",
             "params": {"target": "player", "socket": "right_hand", "effect": "other", "point": [0.5, 0.1]}}]}],
    }
    before = {}
    for p, doc in files.items():
        b = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        p.write_bytes(b)
        before[str(p)] = b

    refs = placements.external_refs_to_effect("fx")
    assert [(r["kind"], r.get("action"), r["where"]) for r in refs] == [
        ("action", "playPropVfx", "torch.states.out.onEnterActions[1].params.actions[0]"),
        ("action", "playPropVfx", "torch.states.out.onEnterActions[2]"),
    ], refs
    assert all(r["file"] == "public/assets/data/prop_presets.json" for r in refs)
    assert refs[1]["label"].startswith("playPropVfx 动作 · "), refs[1]["label"]
    other = placements.external_refs_to_effect("other")
    assert [(r.get("action"), r["file"]) for r in other] == [("playPropVfx", "public/assets/data/cutscenes/index.json")]

    with pytest.raises(ValueError) as e:
        placements.rename_effect("fx", "fx2")
    assert "playPropVfx" in str(e.value) and "prop_presets.json" in str(e.value), str(e.value)
    assert (assets.VFX_DIR / "fx.json").is_file() and not (assets.VFX_DIR / "fx2.json").exists()
    r = placements.delete_effect("fx", with_placements=False)
    assert r["deleted"] is False and r["needConfirm"] is True and len(r["externalRefs"]) == 2
    assert (assets.VFX_DIR / "fx.json").is_file()
    assert {k: Path(k).read_bytes() for k in before} == before, "工作台不写挂件预设 / 演出"


def test_delete_with_external_refs_needs_explicit_confirmation_and_never_touches_those_files(world) -> None:
    before = _external_world(world)
    r = placements.delete_effect("fx", with_placements=False)
    assert r["deleted"] is False and r["needConfirm"] is True and r["refs"] == [] and len(r["externalRefs"]) == 2, \
        "没有布置引用、但火把的余烟还按 id 用它：原来直接删了"
    assert (assets.VFX_DIR / "fx.json").is_file()
    r2 = placements.delete_effect("fx", with_placements=True)
    assert r2["needConfirm"] is True, "「连布置一起删」不等于确认了外部引用"
    r3 = placements.delete_effect("fx", with_placements=False, confirm_external=True)
    assert r3["deleted"] is True and len(r3["externalRefs"]) == 2 and not (assets.VFX_DIR / "fx.json").exists()
    assert {k: Path(k).read_bytes() for k in before} == before, "工作台不写挂件预设 / 演出 / 任何主编辑器的文件"


def test_rename_refuses_while_external_refs_exist_and_names_the_files(world) -> None:
    before = _external_world(world)
    placements._write(vp.dumps(_two_scene_lib()))
    lib_before = placements.lib_path().read_bytes()
    with pytest.raises(ValueError) as e:
        placements.rename_effect("fx", "fx2")
    msg = str(e.value)
    assert "torch" in msg and "prop_presets.json" in msg and "cutscenes/index.json" in msg and "主编辑器" in msg, msg
    assert (assets.VFX_DIR / "fx.json").is_file() and not (assets.VFX_DIR / "fx2.json").exists()
    assert placements.lib_path().read_bytes() == lib_before, "拒绝在先：布置库一个字节都没改"
    assert {k: Path(k).read_bytes() for k in before} == before


def test_http_effect_reports_external_refs_and_delete_confirm_flag(server, world) -> None:
    get, post = server
    _external_world(world)
    r = get("/api/effect?id=fx")
    assert r["ok"] and [x["kind"] for x in r["externalRefs"]] == ["prop", "action"]
    assert get("/api/effect?id=other")["externalRefs"][0]["label"] == "挂件预设「torch」· particles[0]"
    rn = post("/api/rename", {"id": "fx", "to": "fx2"})
    assert rn["ok"] is False and "主编辑器" in rn["err"]
    d = post("/api/delete", {"id": "fx"})
    assert d["ok"] and d["needConfirm"] and len(d["externalRefs"]) == 2
    d2 = post("/api/delete", {"id": "fx", "confirmExternal": True})
    assert d2["ok"] and d2["deleted"] is True


def _instance_ref_world(world) -> dict[str, bytes]:
    """临时工程里按**实例 id**「纸钱_山顶」引用布置的各种写法；返回原字节（核"一个字节都不写"）。"""
    root = placements.REF_ROOT
    data = root / "public" / "assets" / "data"
    (data / "cutscenes").mkdir(parents=True)
    (data / "archive").mkdir()
    (root / "public" / "assets" / "dialogues" / "graphs").mkdir(parents=True)
    (root / "public" / "assets" / "scenes").mkdir(parents=True)
    iid = "纸钱_山顶"
    files = {
        data / "cutscenes" / "index.json": [{"id": "cs1", "steps": [
            {"kind": "action", "type": "playVfx", "params": {"instanceId": iid}},
            {"kind": "action", "type": "playVfx", "params": {"instanceId": "别的实例"}},
            # effect 同名不算实例引用（临时实例那一档按效果 id）
            {"kind": "action", "type": "playVfx", "params": {"effect": iid, "x": 1, "y": 2}},
            {"kind": "action", "type": "stopVfx", "params": {"instanceId": iid}}]}],
        data / "quests.json": [{"id": "q1", "conditions": [{"all": [{"vfx": iid, "vfxState": "active"}]}],
                                "onComplete": [{"type": "setVfxState", "params": {"instanceId": iid, "state": "fleeing"}}]}],
        root / "public" / "assets" / "dialogues" / "graphs" / "g.json": {"nodes": {"n1": {"type": "switch", "cases": [
            {"conditions": [{"vfx": iid, "vfxState": "inactive"}]}]}}},
        # 挂件预设的粒子挂载按效果 id、场景 JSON 残留的 vfx 是数组：都不是实例引用 / 条件叶
        data / "prop_presets.json": {"torch": {"particles": [{"effect": iid}]}},
        root / "public" / "assets" / "scenes" / "hill.json": {"id": "hill", "vfx": [{"id": iid}]},
        # 归档 / 备份不算
        data / "archive" / "old.json": [{"type": "stopVfx", "params": {"instanceId": iid}}],
        data / "quests.json.bak": [{"type": "stopVfx", "params": {"instanceId": iid}}],
    }
    out = {}
    for p, doc in files.items():
        b = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        p.write_bytes(b)
        out[str(p)] = b
    return out


def test_external_refs_to_instance_lists_actions_and_condition_leaves(world) -> None:
    before = _instance_ref_world(world)
    refs = placements.external_refs_to_instance("纸钱_山顶")
    got = sorted((r["file"], r["path"], r["kind"]) for r in refs)
    assert got == sorted([
        ("public/assets/data/cutscenes/index.json", "[0].steps[0]", "playVfx"),
        ("public/assets/data/cutscenes/index.json", "[0].steps[3]", "stopVfx"),
        ("public/assets/data/quests.json", "[0].conditions[0].all[0]", "condition"),
        ("public/assets/data/quests.json", "[0].onComplete[0]", "setVfxState"),
        ("public/assets/dialogues/graphs/g.json", "nodes.n1.cases[0].conditions[0]", "condition"),
    ]), refs
    assert all(set(r) == {"file", "path", "kind"} for r in refs), refs
    assert [r["kind"] for r in placements.external_refs_to_instance("别的实例")] == ["playVfx"]
    assert placements.external_refs_to_instance("nobody") == [] and placements.external_refs_to_instance("  ") == []
    assert {k: Path(k).read_bytes() for k in before} == before, "只读：一个字节都不写"


def test_http_instance_refs(server, world) -> None:
    get, _post = server
    _instance_ref_world(world)
    r = get("/api/instance_refs?id=" + urllib.parse.quote("纸钱_山顶"))
    assert r["ok"] is True and len(r["refs"]) == 5, r
    assert {x["kind"] for x in r["refs"]} == {"playVfx", "stopVfx", "setVfxState", "condition"}
    empty = get("/api/instance_refs?id=nobody")
    assert empty == {"ok": True, "refs": []}, empty
    assert get("/api/instance_refs")["refs"] == []


def test_duplicate_effect_leaves_placements_alone(world) -> None:
    placements._write(vp.dumps(_two_scene_lib()))
    before = placements.lib_path().read_bytes()
    assets.duplicate_asset("fx", "fx_copy")
    assert placements.lib_path().read_bytes() == before


def test_check_report(world) -> None:
    ok, lines = placements.check_report()
    assert ok and "不存在" in lines[0]
    placements._write(vp.dumps({"_comment": "c", "scenes": {"gone": {"base": [_row(effect="nope")]}}}))
    ok, lines = placements.check_report()
    assert ok and any("gone" in ln for ln in lines) and any("nope" in ln for ln in lines), lines
    placements._write(b'{"scenes": {"hill": {"base": [{"id": "a"}]}}}\n')
    ok, lines = placements.check_report()
    assert not ok and "形状闸门" in lines[0]


# ---------------------------------------------------------------------------
# 进程内真 HTTP
# ---------------------------------------------------------------------------

@pytest.fixture()
def server(world):
    from tools.vfx_workbench import serve
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.H)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def get(path):
        try:
            with urllib.request.urlopen(base + path) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

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


def test_http_placements_round_trip(server, world) -> None:
    get, post = server
    r = get("/api/placements")
    assert r["ok"] and r["doc"]["scenes"] == {}
    boot = get("/api/boot")
    assert boot["placements"]["real"] is False, "测试进程里指着的是临时库"
    lib = {"scenes": {"hill": {"variants": {"夜": [{"effect": "fx", "id": "a", "anchor": {"y": 1, "x": 2}}]}}}}
    v = post("/api/placements/validate", {"doc": lib})
    assert v["ok"] and list(v["doc"]["scenes"]["hill"]["variants"]["夜"][0].keys()) == ["id", "effect", "anchor"]
    assert not placements.lib_path().exists(), "validate 不写盘"
    s = post("/api/placements/save", {"changes": lib})
    assert s["ok"] and placements.lib_path().is_file()
    assert get("/api/placements")["doc"] == s["doc"]
    bad = post("/api/placements/save", {"changes": {"scenes": {"hill": {"variants": {"暮": [_row()]}}}}})
    assert bad["ok"] is False and "暮" in bad["err"]
    assert get("/api/placements")["doc"] == s["doc"], "被拒的一个字节都不落盘"


def test_http_unreadable_library_is_an_error_not_an_empty_library(server, world) -> None:
    get, post = server
    p = placements.lib_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"{nope")
    r = get("/api/placements")
    assert r["ok"] is False and "读不懂" in r["err"], "页面据此只读——拿空库当真就会在下次保存时把盘上那份整个抹掉"


def test_edit_hill_never_submits_or_rewrites_unopened_room(server, world) -> None:
    get, post = server
    original = {"scenes": {
        "hill": {"base": [_row("hill_day")], "variants": {"夜": [_row("hill_night")]}},
        "room": {"base": [_row("smoke", anchor={"x": 15, "y": 30, "h": 205})], "future": {"keep": 7}},
    }, "author_metadata": {"keep": True}}
    placements._write(vp.dumps(original))
    changes = {"scenes": {"hill": {"base": [_row("hill_day", anchor={"x": 99, "y": 20})]}}}
    result = post("/api/placements/save", {"changes": changes})
    assert result["ok"], result
    saved = get("/api/placements")["doc"]
    assert saved["scenes"]["room"] == original["scenes"]["room"]
    assert saved["scenes"]["hill"]["variants"] == original["scenes"]["hill"]["variants"]
    assert saved["author_metadata"] == original["author_metadata"]
    assert saved["scenes"]["hill"]["base"][0]["anchor"]["x"] == 99
    # 旧窗口仍发送整个缓存库：不能猜范围，更不能受理后才警告。
    before = placements.lib_path().read_bytes()
    rejected = post("/api/placements/save", {"doc": original})
    assert not rejected["ok"] and "刷新" in rejected["err"]
    assert placements.lib_path().read_bytes() == before


def test_explicit_empty_scope_deletes_only_that_scope_and_empty_patch_does_not_write(server, world) -> None:
    get, post = server
    original = _two_scene_lib()
    placements._write(vp.dumps(original))
    result = post("/api/placements/save", {"changes": {"scenes": {"hill": {"base": []}}}})
    assert result["ok"], result
    saved = get("/api/placements")["doc"]
    assert "base" not in saved["scenes"]["hill"], "清空的份整条剥掉（没配 = 没有，不留空壳）"
    assert saved["scenes"]["room"] == original["scenes"]["room"]
    assert saved["scenes"]["hill"].get("variants") == original["scenes"]["hill"].get("variants")
    stamp = placements.lib_path().stat().st_mtime_ns
    assert post("/api/placements/save", {"changes": {"scenes": {}}})["ok"]
    assert placements.lib_path().stat().st_mtime_ns == stamp


def test_http_delete_and_rename_carry_placements(server, world) -> None:
    get, post = server
    placements._write(vp.dumps(_two_scene_lib()))
    d = post("/api/delete", {"id": "fx"})
    assert d["ok"] and d["deleted"] is False and d["needConfirm"] and len(d["refs"]) == 3
    rn = post("/api/rename", {"id": "fx", "to": "fx9"})
    assert rn["ok"] and rn["placementsChanged"] == 3 and placements.refs_to_effect(rn["placements"], "fx9")
    d2 = post("/api/delete", {"id": "fx9", "withPlacements": True})
    assert d2["ok"] and d2["deleted"] and d2["placementsRemoved"] == 3
    assert placements.refs_to_effect(get("/api/placements")["doc"], "fx9") == []


# ---------------------------------------------------------------------------
# 联动：整份工作态库 + 切时段请求（假槽：记下每一份文档）
# ---------------------------------------------------------------------------

class _Slot:
    """假的 vite 槽：POST 存文档回 {rev}；GET 回 {doc}。``reject`` 非空时 POST 回 400 + 这段文字。"""

    def __init__(self):
        self.docs: list[dict] = []
        self.reject = ""
        self.preseed: dict | None = None
        slot = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body: bytes, ctype="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                doc = slot.docs[-1] if slot.docs else slot.preseed
                self._send(200, json.dumps({"doc": doc, "ageMs": 10}).encode("utf-8"))

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n))
                if slot.reject:
                    self._send(400, slot.reject.encode("utf-8"), "text/plain; charset=utf-8")
                    return
                slot.docs.append(body)
                self._send(200, json.dumps({"rev": len(slot.docs)}).encode("utf-8"))

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


@pytest.fixture()
def slot(monkeypatch):
    from tools.vfx_workbench import serve
    from tools.vfx_workbench.game_link import VfxLink
    s = _Slot()
    link = VfxLink(base_url=s.base, writer="test")
    monkeypatch.setattr(serve, "LINK", link)
    yield s, link
    s.httpd.shutdown()


def test_publish_carries_edited_scopes_normalized(server, slot) -> None:
    _get, post = server
    s, _link = slot
    lib = {"scenes": {"hill": {"variants": {"夜": [{"anchor": {"y": 1, "x": 2}, "effect": "fx", "id": "a"}]}}}}
    r = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"), "sceneId": "hill",
                                   "placements": {"mode": "scoped", "library": lib, "sceneId": "hill", "phase": "夜"}})
    assert r["ok"] and "placementsErr" not in r
    doc = s.docs[-1]
    assert set(doc["placements"].keys()) == {"mode", "library", "sceneId", "phase"}
    assert doc["placements"]["sceneId"] == "hill" and doc["placements"]["phase"] == "夜"
    assert list(doc["placements"]["library"].keys()) == ["scenes"], "预览只带修改范围，不带整库元数据"
    assert list(doc["placements"]["library"]["scenes"]["hill"]["variants"]["夜"][0].keys()) == ["id", "effect", "anchor"]


def test_publish_with_a_bad_library_still_pushes_the_effect(server, slot) -> None:
    _get, post = server
    s, _link = slot
    r = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"),
                                   "placements": {"mode": "scoped", "library": {"scenes": {"hill": {"base": [{"id": "a"}]}}}, "sceneId": "hill", "phase": ""}})
    assert r["ok"] is True and "布置库没推" in r["placementsErr"]
    assert "placements" not in s.docs[-1] and s.docs[-1]["effectId"] == "fx"


def test_old_whole_library_preview_is_rejected_and_explicit_empty_scope_survives(server, slot) -> None:
    _get, post = server
    s, _link = slot
    legacy = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"),
                  "placements": {"library": _two_scene_lib(), "sceneId": "hill", "phase": ""}})
    assert "刷新" in legacy["placementsErr"]
    assert "placements" not in s.docs[-1]
    changes = {"scenes": {"hill": {"base": []}}}
    result = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"),
                  "placements": {"mode": "scoped", "library": changes, "sceneId": "hill", "phase": ""}})
    assert result["ok"] and "placementsErr" not in result
    assert s.docs[-1]["placements"]["library"] == changes


def _bad_effect(eid: str) -> dict:
    """作者改到一半的效果：刺激反应里唯一的恐惧标签刚被删掉（fear = {}），过不了闸门。"""
    d = _effect(eid)
    d["emitters"][0]["motion"] = {"stimulus": {"fear": {}, "accel": 700}}
    return d


def test_publish_with_an_invalid_effect_still_pushes_placements_with_the_last_good_def(server, slot) -> None:
    _get, post = server
    s, _link = slot
    good = _effect("fx")
    good["emitters"][0]["spawn"]["max"] = 9
    assert post("/api/link/publish", {"effectId": "fx", "def": good})["ok"]
    lib = {"scenes": {"hill": {"base": [_row("a", "fx")]}}}
    r = post("/api/link/publish", {"effectId": "fx", "def": _bad_effect("fx"),
                                   "placements": {"mode": "scoped", "library": lib, "sceneId": "hill", "phase": ""}})
    assert r["ok"] is True and "stimulus.fear" in r["defErr"] and "布置照推" in r["defErr"], r
    doc = s.docs[-1]
    assert doc["def"]["emitters"][0]["spawn"]["max"] == 9, "推的是上一份过了闸门的定义，不是半截的工作态"
    assert doc["placements"]["library"]["scenes"]["hill"]["base"][0]["id"] == "a", "布置不许被效果卡住"


def test_publish_with_an_invalid_effect_falls_back_to_disk_then_skips_softly(server, slot, world) -> None:
    _get, post = server
    s, _link = slot
    # 这个进程里没推过 other：退到盘上那份
    r = post("/api/link/publish", {"effectId": "other", "def": _bad_effect("other")})
    assert r["ok"] is True and r["defErr"] and s.docs[-1]["def"] == assets.normalize_effect(_effect("other"))
    # 盘上也没有、也没推过：不 500、不挂"游戏没收到"，只回 defErr
    n = len(s.docs)
    r2 = post("/api/link/publish", {"effectId": "ghost", "def": _bad_effect("ghost")})
    assert r2["ok"] is False and r2.get("skipped") is True and "stimulus.fear" in r2["defErr"] and len(s.docs) == n, r2


def test_phase_request_seq_is_server_side_and_sticky(server, slot) -> None:
    _get, post = server
    s, _link = slot
    s.preseed = {"phaseRequest": {"seq": 7, "timePhase": "午"}, "probe": {"seq": 3}}
    r1 = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"), "phaseRequest": {"timePhase": "夜"}})
    assert r1["ok"] and r1["phaseSeq"] == 8, "max(本地, 槽里现有, 请求) + 1"
    assert s.docs[-1]["phaseRequest"] == {"seq": 8, "timePhase": "夜"}
    # 之后的普通发布**粘着**同一个序号重发（槽是整份覆盖的；不粘就会被紧跟着的一发盖掉、游戏根本没读到）
    post("/api/link/publish", {"effectId": "fx", "def": _effect("fx")})
    assert s.docs[-1]["phaseRequest"] == {"seq": 8, "timePhase": "夜"}
    r3 = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"), "phaseRequest": {"timePhase": "辰", "seq": 20}})
    assert r3["phaseSeq"] == 21 and s.docs[-1]["phaseRequest"]["timePhase"] == "辰"
    # 刺激序号同样从槽里现有的接着数（与切时段各数各的）
    r4 = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"), "probe": {"field": {"kind": "fear"}, "at": {"x": 1, "y": 2}}})
    assert r4["probeSeq"] == 4 and s.docs[-1]["phaseRequest"]["seq"] == 21
    # 空时段不发请求（游戏那侧要求 timePhase 非空串）
    post("/api/link/publish", {"effectId": "fx", "def": _effect("fx"), "phaseRequest": {"timePhase": ""}})
    assert s.docs[-1]["phaseRequest"]["seq"] == 21


def test_slot_rejection_body_reaches_the_page(server, slot) -> None:
    """dev server 在、但 400 拒了：它说的话原样回给页面，而且不能说成"连不上"。"""
    _get, post = server
    s, _link = slot
    s.reject = "bad payload: placements 要 {library:{scenes:{}}, sceneId, phase}"
    r = post("/api/link/publish", {"effectId": "fx", "def": _effect("fx")})
    assert r["ok"] is False and r["connected"] is True and r.get("rejected") is True
    assert "placements 要" in r["err"]


def test_scene_route_resolves_the_phase_background(server, monkeypatch) -> None:
    """真场景（跑马梁 · 夜）：phase 选背景、几何共用；不存在的外观键报错而不是静默退回基底。"""
    get, _post = server
    sid = "跑马梁"
    if not (_ROOT / "public" / "assets" / "scenes" / f"{sid}.json").is_file():
        pytest.skip("缺工程真数据（跑马梁）")
    # world fixture 把 SCENES_JSON / GAME_CONFIG 指到了 tmp：这条用真场景（只读），换回来
    monkeypatch.setattr(placements, "SCENES_JSON", _ROOT / "public" / "assets" / "scenes")
    monkeypatch.setattr(placements, "GAME_CONFIG", _ROOT / "public" / "assets" / "data" / "game_config.json")
    data = placements.scene_doc(sid)
    night = next((p for p in placements.scene_phases(data) if p["key"] == "夜"), None)
    if night is None:
        pytest.skip("跑马梁没有夜的时段外观")
    q = urllib.parse.quote(sid)
    sc = get(f"/api/scene?id={q}&phase={urllib.parse.quote('夜')}")
    assert sc["ok"] and sc["scene"]["phase"] == "夜" and sc["scene"]["background"] == night["background"]
    assert sc["scene"]["timePhase"] == "夜" and sc["scene"]["dayNight"] is True
    base = get(f"/api/scene?id={q}&phase=")
    assert base["scene"]["phase"] == "" and base["scene"]["background"] != night["background"]
    bad = get(f"/api/scene?id={q}&phase={urllib.parse.quote('不存在')}")
    assert bad["ok"] is False and "没有时段外观" in bad["err"]
    scenes = get("/api/scenes")["scenes"]
    row = next(s for s in scenes if s["id"] == sid)
    assert [p["key"] for p in row["phases"]][:2] == ["", "夜"] and row["dayNight"] is True
