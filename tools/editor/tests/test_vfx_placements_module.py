"""粒子布置库共享模块 ``tools/editor/shared/vfx_placements.py`` 的契约。

这个模块是**三方共用的唯一一份**：粒子工作台（唯一写入者）、主编辑器（只读镜像 + 候选）、
校验器 / json_lang（兜底校验 + id 宇宙）。任何一处想"各写一套"都要先过这里钉的口径：

* 形状闸门 ``normalize_instance`` / ``normalize_library``：**只收键序、硬拒不合法形状，绝不改数值**
  （int 不许漂成 float——落盘口径是往返零改字节）；空份剥掉（没配 = 没有，不留空壳）；未知键透传。
* 查询：``instance_ids_for_scene`` 是 playVfx / 条件叶候选的并集口径（base 在前、首次出现序、去重）。
* ``phase_label``：校验器与编辑器给人看的时段外观名（base 列出它实际覆盖哪些时段）。
* ``dumps``：LF + 2 空格 + ``ensure_ascii=False`` + 末尾换行 + 不排序键。

每条硬拒都断言**报错文案里带着 where 前缀与点名的字段**——校验器把这段文案原样报给作者，
文案不点名字段，作者就只能对着一整条实例猜。
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from tools.editor.shared import vfx_placements as vp
from tools.editor.tests.save_test_utils import repo_root_from_tests

REPO = repo_root_from_tests()

_POLY = [[0, 0], [100, 0], [100, 100], [0, 100]]


def _row(**over) -> dict:
    base = {"id": "v", "effect": "paper_money", "anchor": {"x": 10, "y": 20}}
    base.update(over)
    return base


def _clone(o):
    return json.loads(json.dumps(o, ensure_ascii=False))


# --------------------------------------------------------------------------- #
# normalize_instance：硬拒
# --------------------------------------------------------------------------- #

_REJECTS = [
    ("not_object", lambda r: ["不是", "对象"], "实例不是对象"),
    ("no_id", lambda r: r.pop("id"), "缺 id"),
    ("blank_id", lambda r: r.update(id="   "), "缺 id"),
    ("no_effect", lambda r: r.pop("effect"), "缺 effect"),
    ("blank_effect", lambda r: r.update(effect=" "), "缺 effect"),
    ("time_phases", lambda r: r.update(timePhases=["夜"]), "timePhases"),
    ("time_phases_empty", lambda r: r.update(timePhases=[]), "timePhases"),
    ("no_anchor", lambda r: r.pop("anchor"), "anchor 要有画面点 x / y"),
    ("anchor_not_obj", lambda r: r.update(anchor=[1, 2]), "anchor 要有画面点 x / y"),
    ("anchor_x_str", lambda r: r["anchor"].update(x="10"), "anchor 要有画面点 x / y"),
    ("anchor_y_bool", lambda r: r["anchor"].update(y=True), "anchor 要有画面点 x / y"),
    ("anchor_x_nan", lambda r: r["anchor"].update(x=math.nan), "anchor 要有画面点 x / y"),
    ("anchor_y_inf", lambda r: r["anchor"].update(y=math.inf), "anchor 要有画面点 x / y"),
    ("anchor_h", lambda r: r["anchor"].update(h="高"), "anchor.h"),
    ("anchor_surface", lambda r: r["anchor"].update(surface="wall"), "anchor.surface"),
    ("seed", lambda r: r.update(seed="7"), "seed"),
    ("count_scale_zero", lambda r: r.update(countScale=0), "countScale"),
    ("count_scale_neg", lambda r: r.update(countScale=-1.5), "countScale"),
    ("count_scale_str", lambda r: r.update(countScale="2"), "countScale"),
    ("auto_start", lambda r: r.update(autoStart=1), "autoStart"),
    ("conditions", lambda r: r.update(conditions={"flag": "x"}), "conditions"),
    ("area_two_points", lambda r: r.update(area=[[0, 0], [1, 1]]), "发射区域 area"),
    ("area_bad_point", lambda r: r.update(area=[[0, 0], [1, 1], [2]]), "发射区域 area"),
    ("confine_not_obj", lambda r: r.update(area=_POLY, confine=True), "confine 要是对象"),
    ("confine_area", lambda r: r.update(confine={"area": [[0, 0]]}), "confine.area"),
    ("feather_neg", lambda r: r.update(area=_POLY, confine={"feather": -1}), "confine.feather"),
    ("feather_str", lambda r: r.update(area=_POLY, confine={"feather": "宽"}), "confine.feather"),
    ("ceiling_zero", lambda r: r.update(area=_POLY, confine={"ceiling": 0}), "confine.ceiling"),
    ("confine_no_region", lambda r: r.update(confine={"feather": 10}), "既没有范围区域也没有发射区域"),
]


@pytest.mark.parametrize("name,mutate,frag", _REJECTS, ids=[r[0] for r in _REJECTS])
def test_normalize_instance_rejects(name: str, mutate, frag: str) -> None:
    row = _row()
    ret = mutate(row)
    if isinstance(ret, list):  # "不是对象" 那条直接用返回值当行
        row = ret
    with pytest.raises(ValueError) as ei:
        vp.normalize_instance(row, "某场景 · 入夜（夜）")
    msg = str(ei.value)
    assert msg.startswith("某场景 · 入夜（夜）: "), f"报错没带 where 前缀：{msg!r}"
    assert frag in msg, f"期望提到「{frag}」，实际 {msg!r}"


@pytest.mark.parametrize("ok", [
    _row(),
    _row(anchor={"x": 0, "y": -3.5, "h": 0, "surface": "shell"}),
    _row(anchor={"x": 1, "y": 1, "surface": "ground"}),
    _row(seed=0, countScale=0.01, autoStart=False, conditions=[]),
    _row(area=_POLY),
    _row(confine={"area": _POLY}),                         # 只有范围区域、没有发射区域：合法
    _row(area=_POLY, confine={}),                           # 退回用发射区域
    _row(area=_POLY, confine={"feather": 0, "ceiling": 0.5}),
])
def test_normalize_instance_accepts_legal_shapes(ok: dict) -> None:
    before = _clone(ok)
    out = vp.normalize_instance(ok, "w")
    assert ok == before, "闸门改了入参"
    assert out == before, "合法形状过闸后内容变了（闸门只许收键序）"


def test_normalize_instance_strips_id_and_effect() -> None:
    out = vp.normalize_instance(_row(id="  a  ", effect=" bat_cliff "), "w")
    assert (out["id"], out["effect"]) == ("a", "bat_cliff")


def test_normalize_instance_key_order_and_passthrough() -> None:
    row = {
        "_note": "作者备注",
        "confine": {"ceiling": 300, "x_extra": 1, "feather": 40, "area": _POLY},
        "area": _POLY,
        "conditions": [],
        "autoStart": True,
        "countScale": 2,
        "seed": 5,
        "anchor": {"surface": "shell", "extra": "k", "h": 3, "y": 2, "x": 1},
        "effect": "e",
        "id": "i",
    }
    out = vp.normalize_instance(row, "w")
    assert list(out) == [*vp.INSTANCE_ORDER, "_note"], "实例键序没收成 INSTANCE_ORDER + 未知键在尾"
    assert list(out["anchor"]) == ["x", "y", "h", "surface", "extra"]
    assert list(out["confine"]) == ["area", "feather", "ceiling", "x_extra"]
    assert out["_note"] == "作者备注" and out["anchor"]["extra"] == "k" and out["confine"]["x_extra"] == 1
    assert list(row)[0] == "_note", "闸门把入参的键序改了"


def test_instance_order_matches_ts_interface() -> None:
    """键序与 ``types.ts`` 的 ``VfxInstanceDef`` 逐字同序（去掉 timePhases 之后）。"""
    ts = (REPO / "src/data/types.ts").read_text(encoding="utf-8")
    start = ts.index("export interface VfxInstanceDef {")
    body = ts[start:ts.index("\n}", start)]
    import re
    keys = [k for k in re.findall(r"^\s{2}(\w+)\??:", body, flags=re.M) if k != "timePhases"]
    assert tuple(keys) == vp.INSTANCE_ORDER


def test_normalize_instance_never_drifts_numbers() -> None:
    row = _row(anchor={"x": 700, "y": 800, "h": 0}, seed=3, countScale=1, area=[[1, 2], [3.0, 4], [5, 6.5]])
    out = vp.normalize_instance(row, "w")
    assert type(out["anchor"]["x"]) is int and type(out["anchor"]["h"]) is int
    assert type(out["seed"]) is int and type(out["countScale"]) is int
    assert type(out["area"][0][0]) is int and type(out["area"][1][0]) is float
    text = vp.dumps(out).decode("utf-8")
    assert '"x": 700,' in text and "700.0" not in text
    assert '"countScale": 1,' in text and '"h": 0\n' in text


# --------------------------------------------------------------------------- #
# normalize_library
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("doc,frag", [
    ([], "根不是对象"),
    ({"scenes": []}, "scenes 要是对象"),
    ({"scenes": {" ": {"base": []}}}, "空的场景 id"),
    ({"scenes": {"s": []}}, "{base, variants}"),
    ({"scenes": {"s": {"base": {}}}}, "s · 基底: 要是实例数组"),
    ({"scenes": {"s": {"variants": []}}}, "variants 要是对象"),
    ({"scenes": {"s": {"variants": {"": [_row()]}}}}, "空的时段 id"),
    ({"scenes": {"s": {"variants": {"夜": {}}}}}, "s · 夜: 要是实例数组"),
    ({"scenes": {"s": {"base": [_row(), _row()]}}}, "id 重复"),
    ({"scenes": {"s": {"variants": {"夜": [_row(id="a"), _row(id="a")]}}}}, "s · 夜: 实例 id 重复 ['a']"),
    ({"scenes": {"s": {"variants": {"夜": [_row(timePhases=["夜"])]}}}}, "s · 夜: 实例「v」带着 timePhases"),
    ({"scenes": {"s": {"base": [_row(anchor={})]}}}, "s · 基底: 实例「v」的 anchor"),
])
def test_normalize_library_rejects(doc, frag: str) -> None:
    with pytest.raises(ValueError) as ei:
        vp.normalize_library(doc)
    assert frag in str(ei.value), str(ei.value)


def test_same_id_across_phases_is_legal() -> None:
    """白天和夜里各摆一条同 id 的是**常态**（崖墓前段的蝙蝠就是）。"""
    doc = {"scenes": {"s": {"base": [_row(id="a")], "variants": {"夜": [_row(id="a")]}}}}
    assert vp.normalize_library(doc)["scenes"]["s"]["variants"]["夜"][0]["id"] == "a"


def test_normalize_library_strips_empty_and_orders_keys() -> None:
    doc = {
        "extra_top": 1,
        "scenes": {
            "empty_scene": {"base": [], "variants": {"夜": []}},
            "only_variants_empty": {"variants": {}},
            "s": {"variants": {"夜": [_row(id="n")], "雨": []}, "base": [_row(id="b")], "memo": "x"},
            "base_gone": {"base": [], "variants": {"夜": [_row()]}},
            "unknown_only": {"memo": "留着"},
        },
    }
    out = vp.normalize_library(doc)
    assert list(out) == ["_comment", "scenes", "extra_top"]
    assert out["_comment"] == vp.empty_library()["_comment"], "缺 _comment 时补上缺省说明"
    scenes = out["scenes"]
    assert "empty_scene" not in scenes and "only_variants_empty" not in scenes, "空场景要整条剥掉"
    assert list(scenes["s"]) == ["base", "variants", "memo"]
    assert list(scenes["s"]["variants"]) == ["夜"], "空的时段份要剥掉"
    assert "base" not in scenes["base_gone"], "空 base 要剥掉"
    assert scenes["unknown_only"] == {"memo": "留着"}, "只有未知键的场景条目透传（往返零丢失）"
    assert doc["scenes"]["s"]["variants"]["雨"] == [], "闸门改了入参"


def test_normalize_library_keeps_existing_comment() -> None:
    assert vp.normalize_library({"_comment": "我的", "scenes": {}})["_comment"] == "我的"
    assert vp.normalize_library({})["scenes"] == {}, "scenes 缺省 = 空表"


def test_real_library_is_a_fixed_point_byte_for_byte() -> None:
    """仓库里那份（迁移脚本 + 工作台写的）过闸再落盘必须逐字节不变——往返零改字节。"""
    path = vp.library_path(REPO)
    raw = path.read_bytes()
    doc, err = vp.load_library(REPO)
    assert err == ""
    assert vp.dumps(vp.normalize_library(doc)) == raw


# --------------------------------------------------------------------------- #
# 读取 / 查询 / set_rows
# --------------------------------------------------------------------------- #

def test_library_path_and_url_match_the_game() -> None:
    assert vp.library_path(Path("R")) == Path("R") / "public" / "assets" / "data" / "vfx_placements.json"
    ts = (REPO / "src/core/projectPaths.ts").read_text(encoding="utf-8")
    assert f"vfxPlacements: '{vp.LIBRARY_URL}'" in ts, "游戏侧 URL 与共享模块不同值"
    assert vp.BASE == ""


def _write_lib(root: Path, content: bytes) -> None:
    p = vp.library_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)


def test_load_library_missing_is_empty_without_error(tmp_path: Path) -> None:
    doc, err = vp.load_library(tmp_path)
    assert err == "" and doc == vp.empty_library()


@pytest.mark.parametrize("content,frag", [
    (b"{ not json", "读不懂"),
    (b"[]", "根不是对象"),
    (b'{"_comment": "x"}', "缺 scenes"),
    (b'{"scenes": []}', "缺 scenes"),
])
def test_load_library_unreadable_reports_error(tmp_path: Path, content: bytes, frag: str) -> None:
    _write_lib(tmp_path, content)
    doc, err = vp.load_library(tmp_path)
    assert frag in err, err
    assert doc == vp.empty_library(), "读不懂时要给空库，别把半坏的文档交给调用方"


def test_rows_phases_iter_and_scene_phase_keys() -> None:
    lib = {"scenes": {
        "s": {"base": [_row(id="a"), "坏行", _row(id="b")], "variants": {"夜": [_row(id="c")], "雨": "坏"}},
        "t": {"variants": {"夜": [_row(id="z")]}},
    }}
    assert [r["id"] for r in vp.rows_for(lib, "s", vp.BASE)] == ["a", "b"], "非 dict 行要滤掉"
    assert vp.rows_for(lib, "s", "雨") == [] and vp.rows_for(lib, "没有", vp.BASE) == []
    assert vp.phases_in_library(lib, "s") == ["", "夜", "雨"]
    assert vp.phases_in_library(lib, "t") == ["夜"], "没配 base 的场景不列 base"
    assert [(s, p, i, r["id"]) for s, p, i, r in vp.iter_rows(lib)] == [
        ("s", "", 0, "a"), ("s", "", 1, "b"), ("s", "夜", 0, "c"), ("t", "夜", 0, "z")]
    assert vp.scene_phase_keys({"timeVariants": {"夜": {}, "雨": {}}}) == ["", "夜", "雨"]
    assert vp.scene_phase_keys(None) == [""] and vp.scene_phase_keys({"timeVariants": []}) == [""]


def test_instance_ids_for_scene_is_ordered_union() -> None:
    lib = {"scenes": {"s": {
        "base": [_row(id="a"), _row(id="b"), _row(id="  ")],
        "variants": {"夜": [_row(id="b"), _row(id="c")], "雨": [_row(id=" d "), _row(id="a")]},
    }}}
    assert vp.instance_ids_for_scene(lib, "s") == ["a", "b", "c", "d"], \
        "候选 = base 在前、按库里时段顺序、首次出现序、去重、空 id 跳过"
    assert vp.instance_ids_for_scene(lib, "没有") == []
    assert vp.instance_ids_for_scene({}, "s") == []


def test_instance_ids_for_real_scene_unions_base_and_night() -> None:
    doc, _err = vp.load_library(REPO)
    # 并集里有哪些、去不去重是这里的判据；**顺序不写死**——库里的行序是作者面的顺序（工作台左栏 ↑↓ 就能换），
    # 上面那条纯数据用例已经钉住「base 在前、按时段顺序、首次出现序」的语义了
    assert sorted(vp.instance_ids_for_scene(doc, "崖墓前段")) == ["vfx_bats", "vfx_drip"]
    assert vp.instance_ids_for_scene(doc, "崖墓入口") == ["vfx_fireflies"], "萤火虫只在夜里那份"
    assert vp.rows_for(doc, "崖墓入口", vp.BASE) == [], "只在夜里摆的，基底里没有（没配就没有）"


def test_set_rows_returns_new_library() -> None:
    lib = vp.empty_library()
    a = vp.set_rows(lib, "s", vp.BASE, [_row(id="a")])
    assert lib["scenes"] == {}, "set_rows 改了入参"
    assert a["scenes"]["s"] == {"base": [_row(id="a")]}
    b = vp.set_rows(a, "s", "夜", [_row(id="n")])
    assert a["scenes"]["s"] == {"base": [_row(id="a")]}, "set_rows 改了入参"
    assert b["scenes"]["s"]["variants"] == {"夜": [_row(id="n")]}
    c = vp.set_rows(b, "s", "夜", [])
    assert "variants" not in c["scenes"]["s"], "删掉最后一个时段份要连 variants 一起剥"
    d = vp.set_rows(c, "s", vp.BASE, [])
    assert "s" not in d["scenes"], "一份都不剩的场景整条剥掉"
    e = vp.set_rows(vp.set_rows(b, "s", vp.BASE, []), "s", "夜", [])
    assert e["scenes"] == {}
    assert vp.set_rows("坏", "s", vp.BASE, [_row()])["scenes"]["s"]["base"][0]["id"] == "v"
    f = vp.set_rows(b, "t", "雨", [])
    assert "t" not in f["scenes"], "对不存在的场景删一份不许留空壳"
    g = vp.set_rows({"scenes": {"s": {"base": [_row(anchor={"x": 7, "y": 8})]}}}, "u", vp.BASE, [])
    assert type(g["scenes"]["s"]["base"][0]["anchor"]["x"]) is int, "拷贝过程中 int 漂成了 float"


# --------------------------------------------------------------------------- #
# phase_label
# --------------------------------------------------------------------------- #

_PHASES = [
    {"id": "辰", "label": "辰时"}, {"id": "午", "label": "午时"},
    {"id": "暮", "label": "向晚"}, {"id": "夜", "label": "入夜"},
]


def test_phase_label_base_without_day_night() -> None:
    assert vp.phase_label(vp.BASE, {}, _PHASES) == "基底（全天：本场景没开日夜）"
    assert vp.phase_label(vp.BASE, None, _PHASES) == "基底（全天：本场景没开日夜）"
    sc = {"dayNight": {"enabled": "true"}, "timeVariants": {"夜": {}}}
    assert vp.phase_label(vp.BASE, sc, _PHASES) == "基底（全天：本场景没开日夜）", "enabled 只认布尔 true"


def test_phase_label_base_with_variants() -> None:
    sc = {"dayNight": {"enabled": True}, "timeVariants": {"夜": {}}}
    assert vp.phase_label(vp.BASE, sc, _PHASES) == "基底（辰时、午时、向晚）"
    sc2 = {"dayNight": {"enabled": True}}
    assert vp.phase_label(vp.BASE, sc2, _PHASES) == "基底（辰时、午时、向晚、入夜）"


def test_phase_label_all_phases_split_out() -> None:
    sc = {"dayNight": {"enabled": True}, "timeVariants": {p["id"]: {} for p in _PHASES}}
    assert vp.phase_label(vp.BASE, sc, _PHASES) == "基底（每个时段都单列了外观，基底永远用不到）"


def test_phase_label_variant() -> None:
    assert vp.phase_label("夜", {}, _PHASES) == "入夜（夜）"
    assert vp.phase_label("雨", {}, _PHASES) == "雨", "没登记的时段就只写 id"
    assert vp.phase_label("x", {}, [{"id": "x", "label": "x"}]) == "x", "label 与 id 相同不重复写"
    assert vp.phase_label("x", {}, [{"id": "x"}]) == "x"


# --------------------------------------------------------------------------- #
# dumps
# --------------------------------------------------------------------------- #

def test_dumps_byte_format() -> None:
    doc = {"z": "中文", "a": [1, 2.5], "m": {"k": True}}
    raw = vp.dumps(doc)
    assert isinstance(raw, bytes)
    assert b"\r" not in raw, "写成了 CRLF"
    assert raw.endswith(b"}\n") and not raw.endswith(b"\n\n"), "末尾恰好一个换行"
    text = raw.decode("utf-8")
    assert "中文" in text and "\\u" not in text, "ensure_ascii 必须关"
    assert text.index('"z"') < text.index('"a"') < text.index('"m"'), "不许排序键"
    assert text.splitlines()[1] == '  "z": "中文",', "缩进是 2 空格"
    assert text.splitlines()[3] == "    1,"
    assert json.loads(text) == doc
