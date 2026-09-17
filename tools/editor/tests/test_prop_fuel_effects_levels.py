"""火把养成（玩法清单 A3.7）的**作者面**：挂件预设页新增的三块（耐久 `fuel` / 效果块 `effects` /
等级 `levels`）+ `playerControl.guardBlocksRun`，以及新的「挂件效果块」页（`prop_effects.json`）。

运行时权威：`src/data/propPresets.ts`（`PropFuelDef` / `PropEffectDef` / `PropLevelDef` /
`PROP_EFFECTS_MAX` / `parseFuel` / `parsePropEffects` / `parseLevels`）。
覆盖（每条对应一个"漏了会静默"的口子）：

1. 镜像对账：三个 TS 接口的字段 ↔ 表单管着的键 ↔ 校验器的键；上限常量三处同值。
2. 挂件预设页往返：现网数据与合成脏数据「打开→不动→Apply」逐字节、不判脏；没展开过的块原样透传；
   从控件入口改一项只动那一项。
3. 「挂件效果块」页：浏览一遍不改不脏；每类控件改一项只动那一项、未知键透传、数值原表示保真；
   改名一并改写挂件预设引用；还被用着的不许删。
4. 校验器：好形态干净、每条护栏先改坏一次（含"倍率 ≤ 0 运行时当没写"这条最要命的）。
5. 工程接线：脏桶 / 存盘分支 / overlay 镜像 / 主窗页签 / 素材清单（等级换图不进包 = 包里升了级还是老样子）。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.editors.prop_effects_editor import PropEffectsEditor  # noqa: E402
from tools.editor.editors.prop_preset_editor import PropPresetEditor  # noqa: E402
from tools.editor.editors.prop_preset_blocks import (  # noqa: E402
    FUEL_KEYS,
    LEVEL_KEYS,
    PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT,
    PROP_EFFECTS_MAX_HINT,
    prop_effect_summary,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

IMG = "/resources/runtime/images/a.png"

EFFECTS = {
    "oiled": {"label": "裹布浸桐油", "note": "第二级", "wind": {"windSpeed": 1.25, "drainSeconds": 1.4},
              "tags": ["耐风"]},
    "resin": {"label": "松脂旺", "light": {"intensity": 1.5}, "burn": 1.4, "fuelRate": 1.6,
              "fields": [{"kind": "attract", "tag": "torch:招", "radius": 600, "strength": 1.2}],
              "tags": ["招东西"]},
    # 不认识的键 / 坏值 / 非对象条目：编辑器一律保值，校验器说话
    "weird": {"label": "怪", "burn": 0, "light": {"intensity": "1.2", "nope": 3},
              "fields": [{"kind": "x", "tag": "", "radius": 0, "strength": "a"}, 5],
              "tags": ["", 3], "zzz": 1},
    "bad": [1, 2],
}
PRESETS = {
    "torch": {
        "label": "火把", "image": IMG,
        "states": {"lit": {"burn": 1}, "out": {"burn": 0}},
        "playerControl": {"litState": "lit", "outState": "out"},
        "fuel": {"seconds": 150, "windFactor": 0.2, "outState": "out",
                 "onSpentActions": [{"type": "playSfx", "params": {"id": "s"}}]},
        "effects": ["resin"],
        "levels": [
            {"label": "第一级"},
            {"note": "键序倒着写的一条", "effects": ["oiled"], "label": "第二级"},
        ],
    },
    # 坏形态：耐久不是对象、效果块不是数组、等级里混着非对象与空名字 —— 一个字节都不许改
    "junk": {
        "image": IMG, "fuel": 5, "effects": "oiled",
        "levels": [{"label": ""}, 7, {"label": "三", "image": IMG, "zz": 1}],
        "playerControl": {"guardBlocksRun": "false"},
    },
    "plain": {"image": IMG},
}


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _write(root: Path, presets: dict, effects: dict) -> ProjectModel:
    write_minimal_loadable_project(root)
    dp = root / "public/assets/data"
    img = root / "public/resources/runtime/images"
    img.mkdir(parents=True, exist_ok=True)
    (img / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    for name, doc in (("prop_presets.json", presets), ("prop_effects.json", effects)):
        (dp / name).write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    m = ProjectModel()
    m.load_project(root)
    return m


@pytest.fixture()
def model(tmp_path, app) -> ProjectModel:
    return _write(tmp_path / "p", copy.deepcopy(PRESETS), copy.deepcopy(EFFECTS))


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


# =========================================================================== #
# 1. 镜像对账
# =========================================================================== #

def _ts_interface(name: str) -> str:
    text = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    m = re.search(rf"export interface {name} \{{(?P<b>.*?)\n\}}", text, re.S)
    assert m, f"propPresets.ts 里没有 {name}"
    return m.group("b")


def _ts_fields(body: str) -> list[str]:
    return re.findall(r"^\s{2}(\w+)\??:", body, re.M)


def test_fuel_keys_match_runtime_type_and_validator() -> None:
    from tools.editor.validator import _PROP_FUEL_KEYS

    ts = _ts_fields(_ts_interface("PropFuelDef"))
    assert tuple(ts) == FUEL_KEYS == tuple(sorted(_PROP_FUEL_KEYS, key=FUEL_KEYS.index))
    assert set(ts) == set(_PROP_FUEL_KEYS)
    assert re.search(r"^\s{2}seconds: number;", _ts_interface("PropFuelDef"), re.M), "seconds 应必填"


def test_level_keys_match_runtime_type() -> None:
    assert tuple(_ts_fields(_ts_interface("PropLevelDef"))) == LEVEL_KEYS
    assert re.search(r"^\s{2}label: string;", _ts_interface("PropLevelDef"), re.M), "label 应必填"


def test_effect_keys_match_runtime_type_and_validator() -> None:
    from tools.editor.validator import (
        _PROP_EFFECT_FIELD_KEYS,
        _PROP_EFFECT_FIELD_KINDS,
        _PROP_EFFECT_KEYS,
        _PROP_EFFECT_SCALARS,
        _PROP_EFFECT_SCALE_BLOCKS,
    )
    from tools.editor.editors.prop_effects_editor import BLOCK_ROWS, MANAGED_KEYS, SCALAR_ROWS

    body = _ts_interface("PropEffectDef")
    ts = set(_ts_fields(body)) - {"id"}   # id 是运行时补的（键即 id），不落在条目里
    assert ts == set(_PROP_EFFECT_KEYS) == set(MANAGED_KEYS)
    assert {k for k, _l, _t in SCALAR_ROWS} == set(_PROP_EFFECT_SCALARS)
    for block, _title, rows in BLOCK_ROWS:
        assert tuple(k for k, _l, _t in rows) == _PROP_EFFECT_SCALE_BLOCKS[block]
    # fields 一条的四项与两档 kind
    fb = re.search(r"fields\?:\s*\{(?P<b>[^}]*)\}", body).group("b")
    assert {k.strip() for k in re.findall(r"(\w+)\s*:", fb)} == set(_PROP_EFFECT_FIELD_KEYS)
    assert set(re.findall(r"'(fear|attract)'", fb)) == set(_PROP_EFFECT_FIELD_KINDS)


def test_effects_max_is_the_same_number_everywhere() -> None:
    from tools.editor.validator import _PROP_EFFECTS_MAX

    text = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    ts = int(re.search(r"export const PROP_EFFECTS_MAX = (\d+);", text).group(1))
    assert ts == PROP_EFFECTS_MAX_HINT == _PROP_EFFECTS_MAX == 2


def test_guard_blocks_run_default_matches_runtime() -> None:
    from tools.editor.validator import _PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT

    text = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    block = re.search(r"export const PROP_CONTROL_DEFAULTS = \{(?P<b>.*?)\} as const;", text, re.S).group("b")
    ts = re.search(r"guardBlocksRun:\s*(\w+)", block).group(1)
    assert (ts == "true") is PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT \
        is _PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT


def test_fuel_wind_factor_default_matches_runtime() -> None:
    from tools.editor.editors.prop_preset_blocks import FUEL_WIND_FACTOR_DEFAULT
    from tools.editor.validator import _PROP_FUEL_WIND_FACTOR_DEFAULT

    text = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    ts = float(re.search(r"export const PROP_FUEL_WIND_FACTOR = ([\d.]+);", text).group(1))
    assert ts == FUEL_WIND_FACTOR_DEFAULT == _PROP_FUEL_WIND_FACTOR_DEFAULT


# =========================================================================== #
# 2. 挂件预设页往返
# =========================================================================== #

def test_page_roundtrips_byte_for_byte_and_does_not_dirty(model: ProjectModel, app) -> None:
    before = copy.deepcopy(model.prop_presets)
    ed = PropPresetEditor(model)
    try:
        for pid in list(before):
            assert ed.select_by_id(pid)
            assert _dumps(ed._staged()[pid]) == _dumps(before[pid]), pid
        assert not ed._dirty, "只是浏览了一遍，不该判脏"
        assert model.prop_presets == before, "浏览不许写模型"
    finally:
        ed.deleteLater()


def test_repo_presets_roundtrip_byte_for_byte(app) -> None:
    """现网 prop_presets.json（火把养成三块的真数据）：打开→不动→Apply 一个字节都不改。"""
    m = ProjectModel()
    m.load_project(_ROOT)
    before = copy.deepcopy(m.prop_presets)
    ed = PropPresetEditor(m)
    try:
        for pid in list(before):
            assert ed.select_by_id(pid)
            assert _dumps(ed._staged()[pid]) == _dumps(before[pid]), pid
        assert not ed._dirty
    finally:
        ed.deleteLater()


def test_unexpanded_blocks_pass_the_raw_bytes_through(model: ProjectModel, app) -> None:
    """全表都没这三个键时块压根不建控件，`dump()` 回吐的是「不写键」而不是凭空写一个。"""
    only_plain = _write(model.project_path.parent / "only", {"plain": copy.deepcopy(PRESETS["plain"])},
                        copy.deepcopy(EFFECTS))
    ed = PropPresetEditor(only_plain)
    try:
        assert ed.select_by_id("plain")
        assert not ed._fuel_block._built and not ed._effects_block._built
        assert not ed._levels_editor._built
        assert ed._staged()["plain"] == PRESETS["plain"]
        assert not ed._dirty
    finally:
        ed.deleteLater()


def test_blocks_go_back_to_not_writing_the_key_after_leaving_an_entry(model: ProjectModel, app) -> None:
    """控件复用的反面：从写了 fuel 的条目切到没写的，三块都得回到「不写键」。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        assert ed._fuel_block._built and ed._levels_editor._built
        assert ed.select_by_id("plain")
        assert ed._staged()["plain"] == PRESETS["plain"], "切回来不许凭空写出 fuel / effects / levels"
        assert not ed._dirty
    finally:
        ed.deleteLater()


def test_fuel_block_edits_only_what_was_touched(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        assert ed._fuel_block._built, "磁盘上写了 fuel ⇒ 载入即建即展开"
        ed._fuel_block._seconds.setValue(151)
        out = ed._staged()["torch"]["fuel"]
        assert out == {**PRESETS["torch"]["fuel"], "seconds": 151}
        assert list(out) == list(PRESETS["torch"]["fuel"]), "键序按磁盘原序"
        # 勾掉 = 删键（这根变成烧不完的）；别的键不动
        ed._fuel_block._on.setChecked(False)
        staged = ed._staged()["torch"]
        assert "fuel" not in staged and staged["effects"] == ["resin"]
    finally:
        ed.deleteLater()


def test_fuel_keep_in_hand_tristate_roundtrip(model: ProjectModel, app) -> None:
    """`keepInHandWhenSpent`（烧完留在手上）：三态——不写 / true / false，不动就不写。

    运行时缺省 false（烟散完系统自己把烧完的杆子从手上拿掉），所以勾选框配不出"沿用缺省"，必须三态。
    """
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        blk = ed._fuel_block
        assert "keepInHandWhenSpent" not in ed._staged()["torch"]["fuel"], "没动就不写"
        blk._keep.setCurrentIndex(1)
        assert ed._staged()["torch"]["fuel"]["keepInHandWhenSpent"] is True
        blk._keep.setCurrentIndex(2)
        assert ed._staged()["torch"]["fuel"]["keepInHandWhenSpent"] is False
        blk._keep.setCurrentIndex(0)
        assert "keepInHandWhenSpent" not in ed._staged()["torch"]["fuel"], "回到沿用缺省 = 删键"
    finally:
        ed.deleteLater()


def test_fuel_keep_in_hand_preserves_disk_value(model: ProjectModel, app) -> None:
    """磁盘上写了这个键、作者没碰它 ⇒ 原样回吐（连非 bool 的坏值也不许被顶替）。"""
    model.prop_presets["torch"]["fuel"]["keepInHandWhenSpent"] = "yes"
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        assert ed._staged()["torch"]["fuel"]["keepInHandWhenSpent"] == "yes"
        ed._fuel_block._seconds.setValue(99)
        assert ed._staged()["torch"]["fuel"]["keepInHandWhenSpent"] == "yes", "改别的键不许动它"
    finally:
        ed.deleteLater()
        model.prop_presets["torch"]["fuel"].pop("keepInHandWhenSpent", None)


def test_effects_block_edits_and_limit_hint(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        field = ed._effects_block._field
        assert isinstance(field._rows[0]["sel"], IdRefSelector), "引用字段禁裸 QLineEdit"
        assert not field._rows[0]["sel"].isEditable()
        assert sorted(i for i, _l in field._items()) == sorted(model.prop_effects), "候选 = 效果块库"
        assert "松脂旺" in field._rows[0]["note"].text(), "行内要说清这一块乘了什么"
        field._add_row("oiled", quiet=False)
        assert ed._staged()["torch"]["effects"] == ["resin", "oiled"]
        # ⚠ 这里**已经**超了：torch 的第 2 级自己挂了一块，运行时等级排在前面 ⇒ 升到
        #   第 2 级之后这两块里只剩一块算数。旧写法只数"选中那一级"，在这儿一声不吭。
        assert "超过上限" in field._note.text() and "第 2 级" in field._note.text()
        field._add_row("weird", quiet=False)
        assert "超过上限" in field._note.text(), "超了要亮红字（但不拦，保值优先）"
        assert ed._staged()["torch"]["effects"] == ["resin", "oiled", "weird"], "超上限也照写，校验器说话"
    finally:
        ed.deleteLater()


def test_levels_editor_edits_reorder_and_delete(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        lv = ed._levels_editor
        assert lv._built and lv._list.count() == 2
        lv._list.setCurrentRow(1)
        lv._label.setText("裹布浸桐油")
        out = ed._staged()["torch"]["levels"]
        assert out[1]["label"] == "裹布浸桐油"
        assert list(out[1]) == ["note", "effects", "label"], "键序按磁盘原序（未知键与顺序都不动）"
        assert out[0] == {"label": "第一级"}, "没碰的那一级一个字节不动"
        # 顺序就是等级 ⇒ 上移 / 下移必须真的换位
        lv._move(-1)
        assert [x["label"] for x in ed._staged()["torch"]["levels"]] == ["裹布浸桐油", "第一级"]
        lv._on_new()
        assert lv._list.count() == 3
        assert ed._staged()["torch"]["levels"][2]["label"] == "第 3 级"
    finally:
        ed.deleteLater()


def test_level_effects_share_the_cap_with_the_preset_effects(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        lv = ed._levels_editor
        lv._list.setCurrentRow(1)
        assert lv._effects.count() == 1 and ed._effects_block.count() == 1
        lv._effects._add_row("resin", quiet=False)
        assert "超过上限" in lv._effects._note.text(), "等级那串与预设自己那串合起来算上限"
        assert "预设自己" in lv._effects._note.text()
    finally:
        ed.deleteLater()


def test_guard_blocks_run_tristate(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("torch")
        block = ed._player_block
        block.ensure_built()
        combo = block._guard_run
        assert type(combo) is not QLineEdit and not combo.isEditable()
        assert "guardBlocksRun" not in ed._staged()["torch"]["playerControl"]
        combo.setCurrentIndex(combo.findData("false"))
        assert ed._staged()["torch"]["playerControl"]["guardBlocksRun"] is False
        combo.setCurrentIndex(combo.findData("true"))
        assert ed._staged()["torch"]["playerControl"]["guardBlocksRun"] is True
        combo.setCurrentIndex(combo.findData("inherit"))
        assert "guardBlocksRun" not in ed._staged()["torch"]["playerControl"], "沿用 = 不写键"
    finally:
        ed.deleteLater()


def test_junk_shapes_survive_untouched(model: ProjectModel, app) -> None:
    """坏形态（fuel 不是对象、effects 不是数组、levels 里混着非对象）：编辑器**不替它修**。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("junk")
        assert _dumps(ed._staged()["junk"]) == _dumps(PRESETS["junk"])
        # 展开也不改（`guardBlocksRun: "false"` 这种怪值保值展示）
        ed._player_block.ensure_built()
        ed._levels_editor.ensure_built()
        assert _dumps(ed._staged()["junk"]) == _dumps(PRESETS["junk"])
    finally:
        ed.deleteLater()


# =========================================================================== #
# 3. 「挂件效果块」页
# =========================================================================== #

def test_effects_page_browse_does_not_change_anything(model: ProjectModel, app) -> None:
    before = copy.deepcopy(model.prop_effects)
    ed = PropEffectsEditor(model)
    try:
        for i in range(ed._list.count()):
            ed._list.setCurrentRow(i)
        assert model.prop_effects == before
        assert not model._dirty, "浏览不判脏"
    finally:
        ed.deleteLater()


def test_effects_page_edits_only_what_was_touched(model: ProjectModel, app) -> None:
    before = copy.deepcopy(model.prop_effects)
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("resin")
        ed._note.setText("改了")
        out = model.prop_effects["resin"]
        assert out == {**before["resin"], "note": "改了"}
        assert [k for k in out if k in before["resin"]] == list(before["resin"]), \
            "原有键保持磁盘原序，新增键才追加在尾部"
        # 倍率：勾了才写；数值没动的回吐原表示（1.4 不漂）
        ed._blocks["light"]["range"]._on.setChecked(True)
        ed._blocks["light"]["range"]._spin.setValue(1.2)
        assert model.prop_effects["resin"]["light"] == {"intensity": 1.5, "range": 1.2}
        assert model.prop_effects["resin"]["burn"] == 1.4
        # fields 一行改半径：同一行别的项与别的行不动
        ed._fields._rows[0]["radius"].setValue(700)
        assert model.prop_effects["resin"]["fields"] == [
            {"kind": "attract", "tag": "torch:招", "radius": 700, "strength": 1.2}]
        ed._tags._add_row("热", quiet=False)
        assert model.prop_effects["resin"]["tags"] == ["招东西", "热"]
        assert {k: v for k, v in model.prop_effects.items() if k != "resin"} == \
            {k: v for k, v in before.items() if k != "resin"}, "别的效果块一个字节不动"
        assert model._dirty, "改了要标脏"
    finally:
        ed.deleteLater()


def test_effects_page_keeps_unknown_keys_and_bad_rows(model: ProjectModel, app) -> None:
    before = copy.deepcopy(model.prop_effects["weird"])
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("weird")
        ed._label.setText("怪二")
        out = model.prop_effects["weird"]
        assert out["zzz"] == 1, "不认识的顶层键透传"
        assert out["light"]["nope"] == 3, "不认识的子键透传"
        assert out["fields"] == before["fields"], "坏条目原样保留（含非对象那一条）"
        assert out["tags"] == before["tags"]
        assert out["burn"] == 0, "运行时当没写的坏值也不替它改——校验器说话"
    finally:
        ed.deleteLater()


def test_effects_page_rename_rewrites_preset_references(model: ProjectModel, app) -> None:
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("oiled")
        assert "torch" in ed._usage.text(), "左下角要列出谁在用"
        n = ed._rename_in_presets("oiled", "tungoil")
        assert n == 1
        assert model.prop_presets["torch"]["levels"][1]["effects"] == ["tungoil"]
        assert "prop_presets" in model._dirty
    finally:
        ed.deleteLater()


def test_effects_page_refuses_to_delete_a_used_block(model: ProjectModel, app, monkeypatch) -> None:
    from PySide6.QtWidgets import QMessageBox

    warned: list[str] = []
    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: warned.append(a[2]))
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("resin")
        ed._on_delete()
        assert "resin" in model.prop_effects, "还被用着就不许删"
        assert warned and "torch" in warned[0]
    finally:
        ed.deleteLater()


def test_effect_summary_reads_the_multipliers() -> None:
    assert prop_effect_summary(EFFECTS["oiled"]) == "吹熄风速×1.25 · 掉得慢×1.4 · 标签：耐风"
    assert prop_effect_summary({"label": "空"}) == "（这一块什么都不改）"
    assert prop_effect_summary([1]) == "（这一条不是对象，运行时丢掉）"
    assert "招「torch:招」" in prop_effect_summary(EFFECTS["resin"])
    assert prop_effect_summary({"burn": 0}) == "（这一块什么都不改）", "≤0 运行时当没写，摘要也不许说它改了"


# =========================================================================== #
# 4. 校验器
# =========================================================================== #

def _issues(model: ProjectModel) -> list:
    from tools.editor.validator import _validate_prop_effects, _validate_prop_presets

    out: list = []
    _validate_prop_effects(model, out)
    _validate_prop_presets(model, out)
    return out


def _msgs(model: ProjectModel, item: str, sev: str) -> list[str]:
    return [i.message for i in _issues(model) if i.item_id == item and i.severity == sev]


def test_repo_data_is_clean(app) -> None:
    m = ProjectModel()
    m.load_project(_ROOT)
    bad = [i for i in _issues(m) if i.data_type in ("prop_effect", "prop_preset")]
    assert bad == [], [f"{i.severity} {i.item_id}: {i.message}" for i in bad]


@pytest.mark.parametrize("entry,sev,frag", [
    ({"label": ""}, "error", "label 必须是非空名字"),
    ({"label": "x", "burn": 0}, "error", "burn 须为 > 0 的倍率"),
    ({"label": "x", "burn": -1}, "error", "burn 须为 > 0 的倍率"),
    ({"label": "x", "fuelRate": "1.2"}, "warning", "写成了非数值"),
    ({"label": "x", "igniterFlame": 1}, "warning", "= 1（倍率 1 = 不改）"),
    ({"label": "x", "light": 3}, "error", "light 须为对象"),
    ({"label": "x", "light": {"intensity": 0}}, "error", "light.intensity 须为 > 0 的倍率"),
    ({"label": "x", "light": {}}, "warning", "一个认识的倍率都没写"),
    ({"label": "x", "wind": {"zz": 2}}, "warning", "不认识的键"),
    ({"label": "x", "zz": 2}, "warning", "含运行时不认识的键"),
    ({"label": "x", "note": 3}, "warning", "note 须为字符串"),
    ({"label": "x", "fields": 3}, "error", "fields 须为数组"),
    ({"label": "x", "fields": [{"kind": "x", "tag": "t", "radius": 1, "strength": 1}]},
     "error", "kind 只认 fear"),
    ({"label": "x", "fields": [{"kind": "fear", "tag": "", "radius": 1, "strength": 1}]},
     "error", "tag 须为非空标签"),
    ({"label": "x", "fields": [{"kind": "fear", "tag": "t", "radius": 0, "strength": 1}]},
     "error", "radius 须为 > 0 的数"),
    ({"label": "x", "fields": [{"kind": "fear", "tag": "t", "strength": 1}]},
     "error", "radius 须为 > 0 的数"),
    ({"label": "x", "fields": [{"kind": "fear", "tag": "t", "radius": 1, "strength": 1, "zz": 2}]},
     "warning", "不认识的键"),
    ({"label": "x", "tags": 3}, "error", "tags 须为字符串数组"),
    ({"label": "x", "tags": [""]}, "error", "tags[0] 须为非空字符串"),
])
def test_bad_effect_blocks_are_reported(tmp_path, app, entry, sev, frag) -> None:
    m = _write(tmp_path / "p", {"plain": {"image": IMG}}, {"e": entry})
    assert any(frag in x for x in _msgs(m, "e", sev)), _msgs(m, "e", sev)


def test_healthy_effect_blocks_are_clean(tmp_path, app) -> None:
    m = _write(tmp_path / "p", {"plain": {"image": IMG}},
               {k: v for k, v in EFFECTS.items() if k in ("oiled", "resin")})
    assert [i.message for i in _issues(m) if i.data_type == "prop_effect"] == []


def test_effect_file_root_must_be_an_object(tmp_path, app) -> None:
    m = _write(tmp_path / "p", {"plain": {"image": IMG}}, {})
    m.prop_effects = [1]
    assert any("根须为对象" in i.message for i in _issues(m))


@pytest.mark.parametrize("patch_,sev,frag", [
    ({"fuel": {"seconds": 0}}, "error", "整块 fuel 当没写"),
    ({"fuel": {"seconds": -1}}, "error", "整块 fuel 当没写"),
    ({"fuel": {}}, "error", "fuel.seconds 须为 > 0 的秒数"),
    ({"fuel": 5}, "error", "fuel 须为对象"),
    ({"fuel": {"seconds": 10, "windFactor": -1}}, "warning", "windFactor 须为 ≥ 0 的数"),
    ({"fuel": {"seconds": 10, "zz": 1}}, "warning", "含运行时不认识的键"),
    ({"fuel": {"seconds": 10, "outState": "nope"}}, "warning", "不在这个挂件的 states 里"),
    ({"fuel": {"seconds": 10, "onSpentActions": 3}}, "error", "onSpentActions 须为动作数组"),
    ({"fuel": {"seconds": 10, "onSpentActions": [5]}}, "error", "须为动作对象"),
    ({"effects": "oiled"}, "error", "effects 须为效果块 id 数组"),
    ({"effects": [1]}, "error", "须为非空效果块 id"),
    ({"effects": ["绝不存在"]}, "error", "不在 prop_effects.json 里"),
    ({"effects": ["oiled", "oiled"]}, "warning", "写了两遍"),
    ({"effects": ["oiled", "resin", "weird"]}, "error", "超过上限 2 块"),
    ({"levels": 3}, "error", "levels 须为数组"),
    ({"levels": []}, "warning", "levels 是空数组"),
    ({"levels": [5]}, "error", "levels[0] 须为对象"),
    ({"levels": [{"label": ""}]}, "error", "整条不算一级"),
    ({"levels": [{"label": "a", "image": ""}]}, "error", "image 必须是非空字符串"),
    ({"levels": [{"label": "a", "image": "/resources/runtime/images/nope.png"}]},
     "error", "指向的图片文件不存在"),
    ({"levels": [{"label": "a", "effects": ["绝不存在"]}]}, "error", "不在 prop_effects.json 里"),
    ({"levels": [{"label": "a", "note": 3}]}, "warning", "note 须为字符串"),
    ({"levels": [{"label": "a", "zz": 1}]}, "warning", "含运行时不认识的键"),
    ({"playerControl": {"guardBlocksRun": "false"}}, "warning", "guardBlocksRun 必须是 true/false"),
    ({"states": {"lit": {"fuel": {"seconds": 1}}}}, "warning", "运行时不读"),
    ({"states": {"lit": {"effects": ["oiled"]}}}, "warning", "运行时不读"),
    ({"states": {"lit": {"levels": []}}}, "warning", "运行时不读"),
])
def test_bad_preset_blocks_are_reported(tmp_path, app, patch_, sev, frag) -> None:
    entry = {"image": IMG, "states": {"lit": {}, "out": {}}, **patch_}
    if "states" in patch_:
        entry["states"] = {**{"lit": {}, "out": {}}, **patch_["states"]}
    m = _write(tmp_path / "p", {"t": entry}, copy.deepcopy(EFFECTS))
    assert any(frag in x for x in _msgs(m, "t", sev)), _msgs(m, "t", sev)


def test_level_effects_share_the_cap_in_the_validator(tmp_path, app) -> None:
    m = _write(tmp_path / "p", {"t": {
        "image": IMG, "effects": ["oiled", "resin"],
        "levels": [{"label": "a", "effects": ["weird"]}],
    }}, copy.deepcopy(EFFECTS))
    assert any("加上预设自己" in x for x in _msgs(m, "t", "error")), _msgs(m, "t", "error")


def test_healthy_preset_blocks_are_clean(tmp_path, app) -> None:
    m = _write(tmp_path / "p", {"t": {
        "image": IMG, "states": {"lit": {}, "out": {}},
        "fuel": {"seconds": 150, "windFactor": 0.2, "outState": "out"},
        "effects": ["oiled"],
        "levels": [{"label": "一"}, {"label": "二", "image": IMG, "effects": ["resin"], "note": "x"}],
        "playerControl": {"litState": "lit", "guardState": "lit", "outState": "out",
                          "guardBlocksRun": False},
    }}, copy.deepcopy(EFFECTS))
    assert _msgs(m, "t", "error") == [] and _msgs(m, "t", "warning") == []


# =========================================================================== #
# 5. 工程接线
# =========================================================================== #

def test_prop_effects_is_wired_into_load_save_and_overlay(tmp_path, app) -> None:
    from tools.editor.shared.lsp_client import overlay_mirrored_buckets

    m = _write(tmp_path / "p", {"plain": {"image": IMG}}, {"e": {"label": "x"}})
    assert m.prop_effects == {"e": {"label": "x"}}
    assert "prop_effects" in ProjectModel.KNOWN_DIRTY_BUCKETS
    assert "prop_effects" in overlay_mirrored_buckets()
    m.prop_effects["e"]["label"] = "y"
    m.mark_dirty("prop_effects")
    target = tmp_path / "p/public/assets/data/prop_effects.json"
    assert target in set(m._planned_write_paths()), "脏桶推演不认这个文件 = Save All 清脏却不写盘"
    m.save_all()
    assert json.loads(target.read_text("utf-8")) == {"e": {"label": "y"}}, "Save All 要真的把它写盘"


def test_page_is_registered_in_the_main_window() -> None:
    src = (_ROOT / "tools/editor/main_window.py").read_text("utf-8")
    assert '"挂件效果块", PropEffectsEditor' in src
    assert 'rel == "prop_effects.json"' in src, "全局搜索的落点要认这个文件"


def test_level_images_reach_the_asset_manifest() -> None:
    """等级换图不进包 = 包里升了级还是老样子（dev 服整个 public/ 都在，看不出来）。"""
    from tools.build.asset_manifest import _prop_preset_media

    got = [x for x in _prop_preset_media({
        "t": {"image": "/a.png", "levels": [{"label": "一"}, {"label": "二", "image": "/lv2.png"}, 5]},
    }) if isinstance(x, str)]
    assert "/lv2.png" in got


def test_effects_page_rename_also_rewrites_condition_leaves(model: ProjectModel, app) -> None:
    """内容里 `{heldProp, effect}` 问的就是这个 id——不跟着改名 = 那些条件从此恒为假、零报错。"""
    from tools.editor.shared.prop_preset_refs import rename_effect_references, scan_effect_usages

    model.scenes["sc_a"]["zones"] = [{"id": "z", "conditions": [
        {"heldProp": "player", "effect": "oiled"},
        {"not": {"heldProp": "player", "effect": "耐风"}},   # 写的是标签，不跟 id 走
    ]}]
    model._dirty.clear()
    assert scan_effect_usages(model, "oiled") == ["场景 sc_a"]
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("oiled")
        assert "场景 sc_a" not in ed._usage.text(), "选中只显示挂件预设那一半（全量扫要读盘上所有对话图）"
        ed._refresh_usage(deep=True)
        assert "场景 sc_a" in ed._usage.text(), "点「查引用」要把条件叶里的引用列出来"
    finally:
        ed.deleteLater()
    assert rename_effect_references(model, "oiled", "tungoil") == 1
    conds = model.scenes["sc_a"]["zones"][0]["conditions"]
    assert conds[0]["effect"] == "tungoil"
    assert conds[1]["not"]["effect"] == "耐风", "标签不该跟着 id 改名"
    assert model._dirty
