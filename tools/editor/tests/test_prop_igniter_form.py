"""挂件预设「能点火」（`igniter`，燃烧系统 A3.8）在编辑器侧的表单与往返。

运行时权威：`src/data/propPresets.ts`（`PropIgniterDef` / `parseIgniter` / `PROP_IGNITER_DEFAULT_FLAME_CM`，
`resolvePropAttach` 里 `'igniter' in st ? (st.igniter ?? null) : preset.igniter`）。钉死：

1. 表单管着的键 / 缺省火焰长度与 TS 同一份；
2. 最小形态（没写 igniter）打开→不动→保存不长键，没展开过的块不建控件；
3. 基础块：勾上写 `{}`、填火焰长度写数（整数落 int）、取消勾删键；
4. 状态三档从下拉入口切：沿用 = 无键、点不了 = `null`、覆盖 = 对象；
5. 怪值（非对象、负数、字符串、不认识的子键）没动过原样回吐；
6. 真数据 `prop_presets.json` 经统一保存出口逐字节不变。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.editors.prop_preset_blocks import (  # noqa: E402
    IGNITER_FLAME_CM_DEFAULT,
    IGNITER_FLAME_TIP,
    IGNITER_KEYS,
    STATE_IGNITER_INHERIT,
    STATE_IGNITER_NONE,
    STATE_IGNITER_OWN,
    PropStateIgniterField,
)
from tools.editor.project_model import ProjectModel  # noqa: E402

_IMG = "/resources/runtime/images/icons/taomu_sword.png"

SYNTH = {
    "plain": {"image": _IMG, "states": {"lit": {}, "out": {}}},
    "torch": {
        "image": _IMG,
        "igniter": {"备注": "留着", "flameLength": 25},
        "states": {
            "lit": {"label": "点着"},
            "out": {"igniter": None},
            "ember": {"igniter": {"flameLength": 8.5}},
            "guard": {"label": "护火", "igniter": {}},
        },
        "defaultState": "lit",
    },
    "empty_obj": {"image": _IMG, "igniter": {}},
    "odd": {
        "image": _IMG,
        "igniter": {"flameLength": -5, "未来": [1, 2]},
        "states": {"a": {"igniter": "坏"}, "b": {"igniter": {"flameLength": "20"}}, "c": {"igniter": 0}},
    },
    "odd2": {"image": _IMG, "igniter": {"flameLength": "20"}},
    "bad_null": {"image": _IMG, "igniter": None},
    "bad_num": {"image": _IMG, "igniter": 5},
    "bad_list": {"image": _IMG, "igniter": [{"flameLength": 3}]},
}


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def project(app):
    """临时工程：往 prop_presets.json 里写给定的表（或真数据原字节），返回 (model, root)。"""
    tds: list[TemporaryDirectory] = []

    def make(table: dict | None = None, raw: bytes | None = None) -> tuple[ProjectModel, Path]:
        td = TemporaryDirectory()
        tds.append(td)
        root = Path(td.name) / "p"
        for sub in ("public/assets/data", "public/assets/scenes",
                    "public/assets/dialogues/graphs", "public/resources/runtime/animation"):
            (root / sub).mkdir(parents=True, exist_ok=True)
        path = root / "public/assets/data/prop_presets.json"
        if raw is not None:
            path.write_bytes(raw)
        else:
            path.write_text(_dumps(table), encoding="utf-8", newline="\n")
        m = ProjectModel()
        m.load_project(root)
        m._dirty.clear()
        return m, root

    yield make
    for td in tds:
        td.cleanup()


def _page(model: ProjectModel):
    from tools.editor.editors.prop_preset_editor import PropPresetEditor

    return PropPresetEditor(model)


def _select(ed, key: str) -> None:
    items = ed._list.findItems(key, Qt.MatchFlag.MatchExactly)
    assert items, key
    ed._list.setCurrentItem(items[0])


def _visit_everything(ed, keys) -> None:
    """每个预设、每个状态、每块都真建出来走一遍（懒建的块没展开过等于没测）。"""
    for key in keys:
        _select(ed, key)
        ed._blowout_block.ensure_built()
        ed._player_block.ensure_built()
        ed._igniter_block.ensure_built()
        se = ed._states_editor
        se.ensure_built()
        for name in se.state_names():
            se._on_select(name)


# --------------------------------------------------------------------------- #
# 与 TS 同一份
# --------------------------------------------------------------------------- #

def test_form_keys_and_default_match_runtime() -> None:
    ts = (_ROOT / "src/data/propPresets.ts").read_text("utf-8")
    body = re.search(r"export interface PropIgniterDef \{(?P<b>.*?)\n\}", ts, re.S).group("b")
    assert set(re.findall(r"^\s*(\w+)\??:", body, re.M)) == set(IGNITER_KEYS)
    m = re.search(r"export const PROP_IGNITER_DEFAULT_FLAME_CM\s*=\s*([\d.]+)", ts)
    assert m and float(m.group(1)) == IGNITER_FLAME_CM_DEFAULT
    # 状态里的 igniter 由表单管（不在透传集合里 = 沿用档删得掉）
    from tools.editor.editors.prop_preset_blocks import STATE_KEYS
    from tools.editor.editors.prop_preset_editor import PropPresetEditor

    assert "igniter" in STATE_KEYS and "igniter" in PropPresetEditor._MANAGED_KEYS


def test_flame_tooltip_says_what_it_governs(project) -> None:
    for needle in ("厘米", "只管引燃判定够得着多远", "不管火苗画多大", f"不写 = {IGNITER_FLAME_CM_DEFAULT} cm"):
        assert needle in IGNITER_FLAME_TIP, needle
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _select(ed, "torch")
        f = ed._igniter_block._form._flame
        assert "不管火苗画多大" in f.toolTip() and "不管火苗画多大" in f._spin.toolTip()
        assert f.parentWidget().layout().labelForField(f).text() == "火焰长度 cm"
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 往返
# --------------------------------------------------------------------------- #

def test_minimal_form_does_not_grow_keys_and_block_stays_lazy(project) -> None:
    table = {"plain": SYNTH["plain"], "bare": {"image": _IMG}}
    m, _root = project(table)
    ed = _page(m)
    try:
        _select(ed, "plain")
        assert not ed._igniter_block._built, "没写 igniter 的条目不许建控件（默认折叠·懒建）"
        assert "igniter" not in ed._staged()["plain"]
        _visit_everything(ed, list(table))
        assert not ed._dirty, "打开即脏是红线"
        assert _dumps(ed._staged()) == _dumps(table)
        ed.flush_to_model(True)
        assert "prop_presets" not in m._dirty
    finally:
        ed.deleteLater()


def test_synthetic_forms_roundtrip_byte_for_byte(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _visit_everything(ed, list(SYNTH))
        assert not ed._dirty
        assert _dumps(ed._staged()) == _dumps(SYNTH)
        ed.flush_to_model(True)
        assert "prop_presets" not in m._dirty, "没改就不许标脏"
    finally:
        ed.deleteLater()


def test_written_block_is_built_and_expanded_on_select(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _select(ed, "torch")
        blk = ed._igniter_block
        assert blk._built and blk._on.isChecked(), "配了能点火就当场建控件、勾上"
        assert blk._section.is_expanded()
        assert blk._form._flame.value() == 25
        assert blk._section._plain_title == "能点火：火焰长度 25 cm"
        _select(ed, "empty_obj")
        assert ed._igniter_block._section._plain_title == f"能点火：火焰长度 {IGNITER_FLAME_CM_DEFAULT} cm（缺省）"
    finally:
        ed.deleteLater()


def test_real_data_saves_byte_for_byte(project) -> None:
    """真数据经统一保存出口（save_all）写回，逐字节不变。"""
    raw = (_ROOT / "public/assets/data/prop_presets.json").read_bytes()
    m, root = project(raw=raw)
    ed = _page(m)
    try:
        keys = list(m.prop_presets)
        assert keys, "真数据是空表，测不到东西"
        _visit_everything(ed, keys)
        assert not ed._dirty
        ed.flush_to_model(True)
        assert "prop_presets" not in m._dirty, "真数据打开→不动 就标脏"
        path = root / "public/assets/data/prop_presets.json"
        before = path.stat()
        m.mark_dirty("prop_presets")        # 强制走一次写盘，验的是写出来的字节
        m.save_all()
        after = path.stat()
        assert (after.st_ino, after.st_mtime_ns) != (before.st_ino, before.st_mtime_ns), "写盘根本没发生"
        assert path.read_bytes() == raw
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 基础块
# --------------------------------------------------------------------------- #

def test_base_block_toggle_and_flame_length(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _select(ed, "plain")
        blk = ed._igniter_block
        assert not blk._built
        blk._section._header.click()                # 用户点开折叠头 ⇒ 懒建
        assert blk._built and not blk._on.isChecked()
        assert "igniter" not in ed._staged()["plain"]
        blk._on.click()
        assert ed._dirty
        assert ed._staged()["plain"]["igniter"] == {}, "勾上 = 写对象（全用缺省）"
        flame = blk._form._flame
        flame._on.click()
        got = ed._staged()["plain"]["igniter"]
        assert got == {"flameLength": IGNITER_FLAME_CM_DEFAULT} and isinstance(got["flameLength"], int), got
        flame._spin.setValue(30)
        got = ed._staged()["plain"]["igniter"]
        assert got == {"flameLength": 30} and isinstance(got["flameLength"], int), "整数不漂 float"
        flame._spin.setValue(12.5)
        assert ed._staged()["plain"]["igniter"] == {"flameLength": 12.5}
        flame._on.click()
        assert ed._staged()["plain"]["igniter"] == {}, "取消「写」= 删 flameLength"
        blk._on.click()
        assert "igniter" not in ed._staged()["plain"], "取消勾 = 删键"
        assert blk._section._plain_title == "能点火（不写 = 点不了）"

        _select(ed, "torch")
        blk = ed._igniter_block
        flame = blk._form._flame
        flame._spin.setValue(40)
        out = ed._staged()["torch"]["igniter"]
        assert out == {"备注": "留着", "flameLength": 40} and list(out) == ["备注", "flameLength"], \
            "不认识的子键透传、键序按磁盘原序"
        flame._spin.setValue(25)
        out = ed._staged()["torch"]["igniter"]
        assert out["flameLength"] == 25 and isinstance(out["flameLength"], int)
        blk._on.click()
        assert "igniter" not in ed._staged()["torch"]
        blk._on.click()
        assert ed._staged()["torch"]["igniter"] == SYNTH["torch"]["igniter"], "勾回去原值保住"
    finally:
        ed.deleteLater()


def test_base_bad_shapes_are_preserved_until_touched(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        for key in ("bad_null", "bad_num", "bad_list"):
            _select(ed, key)
            blk = ed._igniter_block
            assert blk._built and not blk._on.isChecked(), key
            assert "点不了" in blk._form._note.text(), key
            # 改一个别的字段：坏块原样留着
            ed._spins["scale"].setValue(0.7)
            assert ed._staged()[key]["igniter"] == SYNTH[key]["igniter"], key
        _select(ed, "bad_null")
        blk = ed._igniter_block
        blk._on.click()
        assert ed._staged()["bad_null"]["igniter"] == {}, "从坏形态勾上 = 新配一块"

        _select(ed, "odd")
        blk = ed._igniter_block
        assert blk._on.isChecked() and blk._form._flame._on.isChecked()
        assert "不是 > 0 的数" in blk._form._note.text()
        ed._spins["scale"].setValue(0.7)
        assert ed._staged()["odd"]["igniter"] == {"flameLength": -5, "未来": [1, 2]}, "负数没动过原样回吐"
        blk._form._flame._spin.setValue(15)
        assert ed._staged()["odd"]["igniter"] == {"flameLength": 15, "未来": [1, 2]}

        _select(ed, "odd2")
        blk = ed._igniter_block
        assert not blk._form._flame._on.isChecked(), "字符串控件显示成没写"
        blk._on.click()
        blk._on.click()                               # 勾掉再勾回 = 回到载入态
        assert ed._staged()["odd2"]["igniter"] == {"flameLength": "20"}
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 状态三档
# --------------------------------------------------------------------------- #

def test_state_three_modes_from_the_combo(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _select(ed, "torch")
        se = ed._states_editor
        se.ensure_built()
        field = se._st_igniter
        assert field.parentWidget().layout().labelForField(field).text() == "点火"
        want = {"lit": STATE_IGNITER_INHERIT, "out": STATE_IGNITER_NONE,
                "ember": STATE_IGNITER_OWN, "guard": STATE_IGNITER_OWN}
        for name, mode in want.items():
            se._on_select(name)
            assert field.mode() == mode, name
            assert field._form.isVisibleTo(field) == (mode == STATE_IGNITER_OWN), name

        se._on_select("lit")
        field._mode.setCurrentIndex(field._mode.findData(STATE_IGNITER_NONE))
        assert ed._staged()["torch"]["states"]["lit"] == {"label": "点着", "igniter": None}
        field._mode.setCurrentIndex(field._mode.findData(STATE_IGNITER_OWN))
        assert ed._staged()["torch"]["states"]["lit"] == {"label": "点着", "igniter": {}}, "覆盖 = 写对象"
        field._form._flame._on.click()
        field._form._flame._spin.setValue(18)
        got = ed._staged()["torch"]["states"]["lit"]["igniter"]
        assert got == {"flameLength": 18} and isinstance(got["flameLength"], int)
        field._mode.setCurrentIndex(field._mode.findData(STATE_IGNITER_INHERIT))
        assert ed._staged()["torch"]["states"]["lit"] == {"label": "点着"}, "沿用档 = 什么都不写"

        se._on_select("out")
        field._mode.setCurrentIndex(field._mode.findData(STATE_IGNITER_INHERIT))
        se._on_select("ember")                         # commit-on-leave
        assert "igniter" not in ed._staged()["torch"]["states"]["out"]
        field._form._flame._spin.setValue(9)
        assert ed._staged()["torch"]["states"]["ember"]["igniter"] == {"flameLength": 9}
        assert ed._dirty
    finally:
        ed.deleteLater()


def test_state_bad_shapes_are_preserved(project) -> None:
    m, _root = project(SYNTH)
    ed = _page(m)
    try:
        _select(ed, "odd")
        se = ed._states_editor
        se.ensure_built()
        field = se._st_igniter
        for name in ("a", "b", "c"):
            se._on_select(name)
            assert field.mode() == STATE_IGNITER_OWN, name
        se._on_select("a")
        assert "沿用基础块" in field._form._note.text()
        se._on_select("c")
        se._st_burn._on.click()                         # 改同一状态的别的字段
        st = ed._staged()["odd"]["states"]
        assert st["c"]["igniter"] == 0 and st["a"]["igniter"] == "坏" and st["b"]["igniter"] == {"flameLength": "20"}
        assert "burn" in st["c"]
    finally:
        ed.deleteLater()


def test_state_own_mode_is_not_squeezed_flat(app) -> None:
    field = PropStateIgniterField()
    try:
        field.set_data({})
        field.show()
        field._mode.setCurrentIndex(field._mode.findData(STATE_IGNITER_OWN))
        field.resize(field.sizeHint())
        QApplication.processEvents()
        assert field._form.height() >= field._form.sizeHint().height() - 1, "切到覆盖后表单被压扁"
    finally:
        field.deleteLater()


def test_state_field_reads_null_vs_missing(app) -> None:
    field = PropStateIgniterField()
    try:
        for state, mode, expect in (
            ({}, STATE_IGNITER_INHERIT, {}),
            ({"igniter": None}, STATE_IGNITER_NONE, {"igniter": None}),
            ({"igniter": {"flameLength": 3}}, STATE_IGNITER_OWN, {"igniter": {"flameLength": 3}}),
        ):
            field.set_data(copy.deepcopy(state))
            assert field.mode() == mode
            out: dict = {}
            field.write_into(out)
            assert out == expect, state
    finally:
        field.deleteLater()
