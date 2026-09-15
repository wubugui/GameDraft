"""校验器对粒子布置库 ``assets/data/vfx_placements.json`` 的兜底校验。

布置搬进粒子工作台之后（2026-09-14），场景 JSON 不再有 ``vfx``；实例按「场景 × 时段外观」摆在布置库里，
各配各的、互不继承、没配就没有。运行时对这一块的内容错**一律静默**——场景 id 写错永远用不到、
时段键写错永远命中不到、实例坏了那条不建——画面上都是"粒子没出来"，只能构建期拦。

跑法分三层（照 ``test_footstep_validation.py`` 的样板）：

* 绝大多数用例：临时工程 + ``_validate_vfx_placements`` 本体，一个用例只坏一处，断言**恰好**多出那一条；
* ``WiredIntoValidateTests``：钉住它真的挂进了 ``validate()``（本仓反复吃过"写对了没挂进入口"的亏）；
* ``test_real_repo_*``：真实工程数据零 error（收尾门）。

布置库是**从盘上读的**（工作台写的，盘上就是真相），所以每个用例把库写进临时工程再装模型。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tools.editor import validator
from tools.editor.project_model import ProjectModel
from tools.editor.shared import vfx_placements as vp
from tools.editor.tests.save_test_utils import (
    repo_root_from_tests,
    write_minimal_loadable_project,
)

REPO = repo_root_from_tests()
DT = "vfx_placements"

_POLY = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]]
_FAR = [[5000, 5000], [5100, 5000], [5100, 5100], [5000, 5100]]
_BOW = [[0, 0], [100, 100], [100, 0], [0, 100]]

_PHASES = [
    {"id": "辰", "from": "07:00", "label": "辰时", "daylight": True},
    {"id": "夜", "from": "20:00", "label": "入夜"},
]

#: 三类效果：薄片（纸钱）、从锚点发射的普通粒子（烟）、群体（蝙蝠）
_EFFECTS = {
    "paper_money": {"id": "paper_money", "emitters": [
        {"id": "paper", "appearance": {"image": "/x.png", "sizeWu": 16}, "spawn": {"max": 1},
         "plate": {"size": [16, 16], "terminalSpeed": 90}}]},
    "smoke": {"id": "smoke", "emitters": [
        {"id": "puff", "appearance": {"image": "/x.png", "sizeWu": 8}, "spawn": {"max": 1, "rate": 1}}]},
    "bats": {"id": "bats", "emitters": [
        {"id": "b", "appearance": {"image": "/x.png", "sizeWu": 8}, "spawn": {"max": 1}, "behavior": {}}]},
}

#: sc_dn：开了日夜、夜单列外观；sc_plain：没开日夜（但有 timeVariants.夜，好让"没开日夜"那条单独触发）
_SCENES = {
    "sc_dn": {"id": "sc_dn", "name": "日夜", "hotspots": [], "zones": [], "spawnPoints": {},
              "dayNight": {"enabled": True}, "timeVariants": {"夜": {}}},
    "sc_plain": {"id": "sc_plain", "name": "平", "hotspots": [], "zones": [], "spawnPoints": {},
                 "timeVariants": {"夜": {}}},
}

LOC_DN_BASE = "sc_dn · 基底（辰时）"
LOC_DN_NIGHT = "sc_dn · 入夜（夜）"
LOC_PLAIN_BASE = "sc_plain · 基底（全天：本场景没开日夜）"


def _row(**over) -> dict:
    r = {"id": "v", "effect": "smoke", "anchor": {"x": 10, "y": 20}}
    r.update(over)
    return r


def _dump(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _project(root: Path, library: Any = None, *, raw_library: bytes | None = None,
             scenes: dict | None = None) -> ProjectModel:
    write_minimal_loadable_project(root)
    data = root / "public" / "assets" / "data"
    _dump(data / "game_config.json", {"dayNight": {"phases": _PHASES}})
    for eid, doc in _EFFECTS.items():
        _dump(data / "vfx" / f"{eid}.json", doc)
    for sid, doc in (scenes if scenes is not None else _SCENES).items():
        _dump(root / "public" / "assets" / "scenes" / f"{sid}.json", doc)
    if raw_library is not None:
        vp.library_path(root).write_bytes(raw_library)
    elif library is not None:
        _dump(vp.library_path(root), library)
    model = ProjectModel()
    model.load_project(root)
    return model


def _lib(scenes: dict) -> dict:
    return {"_comment": "测试", "scenes": scenes}


def _run(tmp_path: Path, library: Any = None, **kw) -> list:
    model = _project(tmp_path / "p", library, **kw)
    issues: list = []
    validator._validate_vfx_placements(model, issues)
    return issues


def _fmt(issues: list) -> list[str]:
    return [f"{i.severity}|{i.data_type}|{i.item_id}|{i.message}" for i in issues]


def _only(issues: list, severity: str, item_id: str, frag: str):
    assert len(issues) == 1, _fmt(issues)
    iss = issues[0]
    assert (iss.severity, iss.data_type, iss.item_id) == (severity, DT, item_id), _fmt(issues)
    assert frag in iss.message, _fmt(issues)
    return iss


# --------------------------------------------------------------------------- #
# 合法形态零告警
# --------------------------------------------------------------------------- #

def test_missing_library_is_clean(tmp_path: Path) -> None:
    assert _run(tmp_path) == []


def test_legal_library_is_clean(tmp_path: Path) -> None:
    """合法形态必须零告警——兜底比 TS 权威更严就是拒存合法数据（norms 红线）。"""
    lib = _lib({
        "sc_dn": {
            "base": [_row(id="a"), _row(id="p", effect="paper_money", area=_POLY, confine={"feather": 0})],
            "variants": {"夜": [_row(id="a"), _row(id="only_night", effect="bats")]},
        },
        "sc_plain": {"base": [_row(id="a", conditions=[{"vfx": "a", "vfxState": "active"}])]},
    })
    assert _fmt(_run(tmp_path, lib)) == []


def test_null_optionals_mean_unset(tmp_path: Path) -> None:
    """运行时对可选项一律 `??` 取缺省，null = 没写；兜底不许比 TS 更严（写侧闸门更严是另一回事）。"""
    row = _row(seed=None, countScale=None, autoStart=None, conditions=None, area=None, confine=None,
               anchor={"x": 1, "y": 2, "h": None, "surface": None})
    row2 = _row(id="w", area=_POLY, confine={"area": _POLY, "feather": None, "ceiling": None})
    lib = _lib({"sc_dn": {"base": [row, row2], "variants": None}})
    assert _fmt(_run(tmp_path, lib)) == []


# --------------------------------------------------------------------------- #
# 整份读不懂 / 场景 / 时段外观
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("raw,frag", [
    (b"{ broken", "读不懂"),
    (b"[]", "根不是对象"),
    (b'{"scenes": 3}', "缺 scenes"),
])
def test_unreadable_library_is_an_error(tmp_path: Path, raw: bytes, frag: str) -> None:
    _only(_run(tmp_path, raw_library=raw), "error", "vfx_placements.json", frag)


def test_unknown_scene_is_an_error(tmp_path: Path) -> None:
    iss = _only(_run(tmp_path, _lib({"没这个场景": {"base": [_row()]}})), "error", "没这个场景", "不存在")
    assert "永远用不到" in iss.message


def test_scene_entry_must_be_object(tmp_path: Path) -> None:
    _only(_run(tmp_path, _lib({"sc_dn": [_row()]})), "error", "sc_dn", "{base, variants}")


def test_variants_must_be_object(tmp_path: Path) -> None:
    _only(_run(tmp_path, _lib({"sc_dn": {"variants": [_row()]}})), "error", "sc_dn", "variants 要是对象")


def test_variant_key_must_be_in_time_variants(tmp_path: Path) -> None:
    iss = _only(_run(tmp_path, _lib({"sc_dn": {"variants": {"雨": [_row()]}}})), "error", "sc_dn · 雨", "timeVariants")
    assert "永远命中不到" in iss.message and "夜" in iss.message, "要告诉作者本场景有哪些时段外观"


def test_variants_without_day_night_is_a_warning(tmp_path: Path) -> None:
    iss = _only(_run(tmp_path, _lib({"sc_plain": {"variants": {"夜": [_row()]}}})), "warning", "sc_plain", "dayNight.enabled")
    assert "整份不生效" in iss.message


def test_rows_must_be_array(tmp_path: Path) -> None:
    _only(_run(tmp_path, _lib({"sc_dn": {"base": {"id": "v"}}})), "error", LOC_DN_BASE, "要是实例数组")
    _only(_run(tmp_path / "2", _lib({"sc_dn": {"variants": {"夜": "x"}}})), "error", LOC_DN_NIGHT, "要是实例数组")


# --------------------------------------------------------------------------- #
# 实例：形状闸门原样报 error
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("row", [
    "不是对象",
    _row(id=""),
    _row(effect=""),
    _row(timePhases=["夜"]),
    _row(anchor={"x": 1}),
    _row(anchor={"x": 1, "y": 2, "surface": "wall"}),
    _row(seed="1"),
    _row(countScale=0),
    _row(autoStart="yes"),
    _row(conditions={"flag": "x"}),
    _row(area=[[0, 0], [1, 1]]),
    _row(area=_POLY, confine="yes"),
    _row(area=_POLY, confine={"feather": -1}),
    _row(area=_POLY, confine={"ceiling": 0}),
    _row(confine={"area": [[0, 0]]}),
    _row(confine={}),
], ids=lambda r: json.dumps(r, ensure_ascii=False)[:40])
def test_instance_shape_errors_use_gate_text_verbatim(tmp_path: Path, row) -> None:
    with pytest.raises(ValueError) as ei:
        vp.normalize_instance(row, "第 2 条")
    lib = _lib({"sc_dn": {"variants": {"夜": [_row(id="ok"), row]}}})
    iss = _only(_run(tmp_path, lib), "error", LOC_DN_NIGHT, "第 2 条")
    assert iss.message == str(ei.value), "闸门文案要原样报，不许另写一套"


def test_time_phases_on_instance_is_rejected(tmp_path: Path) -> None:
    """布置已按时段外观分份，实例上还留着 timePhases = 作者以为只在夜里出现，其实照旧口径根本不读。"""
    lib = _lib({"sc_dn": {"base": [_row(timePhases=[])]}})
    _only(_run(tmp_path, lib), "error", LOC_DN_BASE, "timePhases")


def test_duplicate_id_in_same_phase_is_an_error(tmp_path: Path) -> None:
    lib = _lib({"sc_plain": {"base": [_row(id="a"), _row(id=" a ")]}})
    iss = _only(_run(tmp_path, lib), "error", LOC_PLAIN_BASE, "'a' 重复")
    assert "同一场景同一套时段外观" in iss.message


def test_same_id_in_base_and_night_is_legal(tmp_path: Path) -> None:
    lib = _lib({"sc_dn": {"base": [_row(id="a")], "variants": {"夜": [_row(id="a")]}}})
    assert _fmt(_run(tmp_path, lib)) == []


def test_unknown_effect_is_a_warning(tmp_path: Path) -> None:
    iss = _only(_run(tmp_path, _lib({"sc_dn": {"base": [_row(effect="没这个效果")]}})), "warning", LOC_DN_BASE, "没这个效果")
    assert "assets/data/vfx/" in iss.message


# --------------------------------------------------------------------------- #
# 粒子区域（_check_vfx_confine 按 场景 · 时段外观 定位）
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("row,frag", [
    (_row(effect="paper_money", anchor={"x": 5050, "y": 5050}, area=_POLY, confine={"area": _FAR}), "不相交"),
    (_row(effect="paper_money", area=_BOW, confine={}), "自相交"),
    (_row(effect="bats", area=_POLY, confine={}), "群体"),
    (_row(effect="smoke", anchor={"x": 5050, "y": 5050}, area=_POLY, confine={}), "锚点在粒子区域外"),
])
def test_confine_warnings_are_located_by_scene_and_phase(tmp_path: Path, row: dict, frag: str) -> None:
    lib = _lib({"sc_dn": {"variants": {"夜": [row]}}})
    iss = _only(_run(tmp_path, lib), "warning", LOC_DN_NIGHT, frag)
    assert "'v'" in iss.message, "要点名是哪条实例"


# --------------------------------------------------------------------------- #
# conditions 照旧走 _walk_conditions
# --------------------------------------------------------------------------- #

def test_instance_conditions_are_walked(tmp_path: Path) -> None:
    lib = _lib({"sc_dn": {"base": [_row(conditions=[{"vfx": "", "vfxState": "active"}])]}})
    _only(_run(tmp_path, lib), "error", f"{LOC_DN_BASE} · v", "vfx 条件需要非空 vfx")


# --------------------------------------------------------------------------- #
# 场景 JSON 残留 vfx 键
# --------------------------------------------------------------------------- #

def _scene_vfx_key_issues(model: ProjectModel) -> list:
    return [i for i in validator.validate(model)
            if i.data_type == "scene" and "vfx_placements.json" in i.message]


@pytest.mark.parametrize("value", [[_row()], [], "乱写"])
def test_leftover_vfx_key_in_scene_json_is_an_error(tmp_path: Path, value) -> None:
    """开着旧代码主编辑器 Save All 会把内存里的旧 vfx[] 写回场景——新代码必须报，不能静默吞掉。"""
    scenes = json.loads(json.dumps(_SCENES, ensure_ascii=False))
    scenes["sc_plain"]["vfx"] = value
    hits = _scene_vfx_key_issues(_project(tmp_path / "p", scenes=scenes))
    assert len(hits) == 1, _fmt(hits)
    assert (hits[0].severity, hits[0].item_id) == ("error", "sc_plain")
    assert "运行时不再读" in hits[0].message


def test_scene_without_vfx_key_adds_nothing(tmp_path: Path) -> None:
    assert _scene_vfx_key_issues(_project(tmp_path / "p")) == []


# --------------------------------------------------------------------------- #
# 条件叶 vfx：实例查找 = 布置库并集
# --------------------------------------------------------------------------- #

def _leaf_warnings(model: ProjectModel, vid: str) -> list:
    issues: list = []
    validator._walk_conditions(model, issues, [{"vfx": vid, "vfxState": "active"}], "quest", "q", None)
    return [i for i in issues if "没摆在布置库" in i.message]


def test_condition_leaf_finds_ids_in_any_phase_of_any_scene(tmp_path: Path) -> None:
    scenes = json.loads(json.dumps(_SCENES, ensure_ascii=False))
    scenes["sc_plain"]["vfx"] = [_row(id="ghost")]  # 场景 JSON 里的旧 vfx 不算数
    lib = _lib({
        "sc_dn": {"base": [_row(id="day")], "variants": {"夜": [_row(id="night_only")]}},
        "sc_plain": {"base": [_row(id="plain")]},
    })
    model = _project(tmp_path / "p", lib, scenes=scenes)
    for vid in ("day", "night_only", "plain"):
        assert _leaf_warnings(model, vid) == [], vid
    hits = _leaf_warnings(model, "ghost")
    assert len(hits) == 1 and hits[0].severity == "warning", _fmt(hits)
    assert len(_leaf_warnings(model, "nowhere")) == 1


def test_condition_leaf_does_not_spam_when_library_unreadable(tmp_path: Path) -> None:
    """库读不懂那条 error 已经报过；再逐条报"找不到"是拿一个根因刷一屏假告警。"""
    model = _project(tmp_path / "p", raw_library=b"{ broken")
    assert _leaf_warnings(model, "anything") == []


def test_library_is_read_from_disk_each_run(tmp_path: Path) -> None:
    """工作台随时在写，盘上就是真相：模型装好之后库变了，下一轮校验要看到新的。"""
    model = _project(tmp_path / "p", _lib({"sc_dn": {"base": [_row(id="a")]}}))
    assert _leaf_warnings(model, "b") != []
    _dump(vp.library_path(tmp_path / "p"), _lib({"sc_dn": {"base": [_row(id="b")]}}))
    assert _leaf_warnings(model, "b") == []


# --------------------------------------------------------------------------- #
# 动作 playVfx / stopVfx / setVfxState 的 instanceId：与条件叶同一口径
# （工作台里删 / 改 id 一条布置后，引用它的动作靠这里兜底——运行时只 warn 一句整步跳过）
# --------------------------------------------------------------------------- #

def _action_warnings(model: ProjectModel, act: dict) -> list:
    issues: list = []
    validator._append_action_param_ref_issues(model, issues, act, "quest", "q", None)
    return [i for i in issues if "没摆在布置库" in i.message]


@pytest.mark.parametrize("act_type,extra", [
    ("playVfx", {}),
    ("stopVfx", {}),
    ("setVfxState", {"state": "fleeing"}),
])
def test_action_instance_id_must_be_placed_somewhere(tmp_path: Path, act_type: str, extra: dict) -> None:
    lib = _lib({"sc_dn": {"base": [_row(id="day")], "variants": {"夜": [_row(id="night_only")]}}})
    model = _project(tmp_path / "p", lib)
    for vid in ("day", "night_only"):
        act = {"type": act_type, "params": {"instanceId": vid, **extra}}
        assert _action_warnings(model, act) == [], (act_type, vid)
    hits = _action_warnings(model, {"type": act_type, "params": {"instanceId": "gone", **extra}})
    assert len(hits) == 1 and hits[0].severity == "warning", _fmt(hits)
    assert act_type in hits[0].message and "'gone'" in hits[0].message, _fmt(hits)


def test_action_without_instance_id_or_unreadable_library_adds_no_placement_warning(tmp_path: Path) -> None:
    """临时实例（effect + 位置）不查库；库读不懂不刷假告警；缺 instanceId 那条 error 另有，不重复报。"""
    model = _project(tmp_path / "p", _lib({"sc_dn": {"base": [_row(id="day")]}}))
    assert _action_warnings(model, {"type": "playVfx", "params": {"effect": "smoke", "x": 1, "y": 2}}) == []
    assert _action_warnings(model, {"type": "stopVfx", "params": {}}) == []
    broken = _project(tmp_path / "b", raw_library=b"{ broken")
    assert _action_warnings(broken, {"type": "stopVfx", "params": {"instanceId": "anything"}}) == []


# --------------------------------------------------------------------------- #
# 挂进 validate() 入口
# --------------------------------------------------------------------------- #

class TestWiredIntoValidate:
    """``_validate_vfx_placements`` 真的被 ``validate()`` 挂上了。"""

    def test_bad_library_surfaces_through_public_entry(self, tmp_path: Path) -> None:
        lib = _lib({"sc_dn": {"variants": {"夜": [_row(timePhases=["夜"])], "雨": [_row(id="r")]}}})
        issues = [i for i in validator.validate(_project(tmp_path / "p", lib)) if i.data_type == DT]
        got = sorted((i.severity, i.item_id) for i in issues)
        assert got == [("error", LOC_DN_NIGHT), ("error", "sc_dn · 雨")], _fmt(issues)

    def test_clean_library_adds_nothing(self, tmp_path: Path) -> None:
        lib = _lib({"sc_dn": {"base": [_row()], "variants": {"夜": [_row()]}}})
        issues = validator.validate(_project(tmp_path / "p", lib))
        assert [i for i in issues if i.data_type == DT] == []


# --------------------------------------------------------------------------- #
# 真实工程数据
# --------------------------------------------------------------------------- #

def test_real_repo_vfx_placements_have_zero_errors() -> None:
    model = ProjectModel()
    model.load_project(REPO)
    issues = validator.validate(model)
    vfx_related = [
        i for i in issues
        if i.data_type == DT
        or (i.data_type == "scene" and "vfx_placements.json" in i.message)
        or "没摆在布置库" in i.message
    ]
    assert [i for i in vfx_related if i.severity == "error"] == [], _fmt(vfx_related)
    assert vfx_related == [], f"真实数据不该有任何布置库告警：{_fmt(vfx_related)}"
