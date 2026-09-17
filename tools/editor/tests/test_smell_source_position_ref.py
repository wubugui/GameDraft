"""气味源走统一位置选择器（2026-09-16 制作人：气味源不许手输数字）。

区域气味 `zone.smell.source` 与动作 `setSmellSource` 都用 `PositionRefField`：实体此刻位置（铺子热点 /
尸体 NPC，运行时每帧跟着它）/ 地图拾取 / 曲线插槽 / 曲线上的点。本文件钉住：

- 老数据 `{x, y}`（无 kind）打开→不改→保存一个字节不动（int 不漂 float，不凭空写 kind）；
- 引用形状 `{kind:'entity', id}` 往返原样；在面板里切到实体档落盘成引用；
- 没配源的区保存后仍没有 source；「不指定」= 删掉 source；
- setSmellSource：老形状 / 带 scene / 带 at 三种往返原样；scene 是下拉、at 是复合控件（不是裸 QLineEdit）；
- 校验器：zone 源的引用形状与实体可解析性（与动作 at 同一套）。
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

_SMELLS = {"profiles": {"baozi": {"name": "包子香"}, "yin": {"name": "阴腥"}}}


def _scene(source: object | None) -> dict:
    smell: dict = {"scent": "baozi", "intensity": 55}
    if source is not None:
        smell["source"] = source
    return {
        "id": "sc_a",
        "name": "场景甲",
        "hotspots": [{"id": "hs_铺子", "x": 400, "y": 300, "label": "包子铺"}],
        "npcs": [{"id": "npc_老汉", "name": "老汉", "x": 120, "y": 80}],
        "zones": [{
            "id": "z1",
            "polygon": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 50, "y": 50}],
            "smell": smell,
        }],
        "spawnPoints": {},
    }


@pytest.fixture(scope="module")
def qt_app():
    return QApplication.instance() or QApplication(sys.argv)


@pytest.fixture
def scene_editor(qt_app):
    from tools.editor.editors.scene_editor import SceneEditor
    from tools.editor.project_model import ProjectModel

    made: list = []
    tds: list[TemporaryDirectory] = []

    def build(source: object | None):
        td = TemporaryDirectory()
        tds.append(td)
        root = Path(td.name) / "p"
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.smell_profiles = copy.deepcopy(_SMELLS)
        model.scenes = {"sc_a": _scene(copy.deepcopy(source))}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        ed._undo.clear()
        made.append(ed)
        ed._on_item_selected("zone", "z1")
        QApplication.processEvents()
        return ed, model

    yield build
    for ed in made:
        try:
            ed._scene_npc_anim_timer.stop()
            ed._patrol_overlay_refresh_timer.stop()
            ed._canvas._gfx.blockSignals(True)
        except Exception:
            pass
        ed.deleteLater()
    QApplication.processEvents()
    for td in tds:
        td.cleanup()


def _smell(model) -> dict:
    return model.scenes["sc_a"]["zones"][0]["smell"]


# --------------------------------------------------------------------------- #
# 区域气味
# --------------------------------------------------------------------------- #

def test_zone_source_is_position_ref_field_not_spinboxes(scene_editor) -> None:
    from tools.editor.shared.position_ref_field import PositionRefField

    ed, _m = scene_editor({"x": 10, "y": 20})
    props = ed._props
    assert isinstance(props._zn_smell_source, PositionRefField)
    assert not hasattr(props, "_zn_smell_src_x"), "手输 x/y 两个框必须没了"


@pytest.mark.parametrize("source", [
    {"x": 382, "y": 762.6},
    {"kind": "entity", "id": "hs_铺子"},
    {"kind": "entity", "id": "绝不存在的实体_probe"},
    {"kind": "slot", "trajectoryId": "绝不存在的轨迹_probe", "slotId": "s1"},
    None,
])
def test_zone_source_roundtrip_is_byte_stable(scene_editor, source) -> None:
    ed, model = scene_editor(source)
    before = json.dumps(_smell(model), ensure_ascii=False, sort_keys=True)
    ed._apply_props()
    after = _smell(model)
    assert json.dumps(after, ensure_ascii=False, sort_keys=True) == before
    if isinstance(source, dict) and "kind" not in source:
        assert "kind" not in after["source"] and isinstance(after["source"]["x"], int)


def test_zone_source_pick_entity_writes_ref(scene_editor) -> None:
    from tools.editor.shared.position_ref_field import MODE_ENTITY

    ed, model = scene_editor({"x": 10, "y": 20})
    f = ed._props._zn_smell_source
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_ENTITY))
    ids = list(f.entity_sel._ids)
    assert "hs_铺子" in ids and "npc_老汉" in ids, ids   # 铺子热点、尸体 NPC 都能直接选
    f.entity_sel.setCurrentIndex(ids.index("hs_铺子"))   # 真实入口：点下拉那一行
    assert "400" in f.info_lbl.text(), f.info_lbl.text()   # 说明行给出热点摆放位置
    ed._apply_props()
    assert _smell(model)["source"] == {"kind": "entity", "id": "hs_铺子"}


def test_zone_source_none_removes_key(scene_editor) -> None:
    from tools.editor.shared.position_ref_field import MODE_NONE

    ed, model = scene_editor({"kind": "entity", "id": "npc_老汉"})
    f = ed._props._zn_smell_source
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_NONE))
    ed._apply_props()
    assert "source" not in _smell(model)
    assert _smell(model)["scent"] == "baozi"


# --------------------------------------------------------------------------- #
# setSmellSource 动作
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def repo_model(qt_app):
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import repo_root_from_tests

    m = ProjectModel()
    m.load_project(Path(repo_root_from_tests()))
    return m


def _roundtrip(model, action: dict, scene_id: str | None) -> dict:
    from tools.editor.shared.action_editor import ActionEditor

    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([json.loads(json.dumps(action))])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


@pytest.mark.parametrize("params", [
    {"x": 649.6, "y": 337.7},
    {"x": 382, "y": 762.6, "scene": "跑马梁"},
    {"x": 1, "y": 2, "at": {"kind": "entity", "id": "player"}},
    {"x": 1, "y": 2, "at": {"kind": "entity", "id": "绝不存在的实体_probe"}, "scene": "绝不存在的场景_probe"},
])
def test_set_smell_source_roundtrip(repo_model, params) -> None:
    action = {"type": "setSmellSource", "params": params}
    sid = repo_model.all_scene_ids()[0]
    assert _roundtrip(repo_model, action, sid) == action


def test_set_smell_source_widgets_are_selectors(repo_model, qt_app) -> None:
    from tools.editor.shared.action_editor import ActionRow, FilterableTypeCombo
    from tools.editor.shared.position_ref_field import PositionRefField

    sid = repo_model.all_scene_ids()[0]
    row = ActionRow({"type": "setSmellSource", "params": {"x": 1, "y": 2}}, model=repo_model, scene_id=sid)
    assert isinstance(row._param_widgets.get("at"), PositionRefField)
    assert isinstance(row._param_widgets.get("scene"), FilterableTypeCombo)
    for w in row._param_widgets.values():
        assert type(w) is not QLineEdit


# --------------------------------------------------------------------------- #
# 校验器
# --------------------------------------------------------------------------- #

def _zone_issues(model, source) -> list:
    from tools.editor.validator import validate

    model.scenes = {"sc_a": _scene(copy.deepcopy(source))}
    return [i for i in validate(model) if "smell.source" in i.message]


def test_validator_zone_source_shapes(scene_editor) -> None:
    _ed, model = scene_editor(None)
    assert not _zone_issues(model, {"x": 1, "y": 2})
    assert not _zone_issues(model, {"kind": "entity", "id": "hs_铺子"})
    assert not _zone_issues(model, {"kind": "entity", "id": "npc_老汉"})
    assert any(i.severity == "warning" for i in _zone_issues(model, {"kind": "entity", "id": "绝不存在的实体_probe"}))
    assert any(i.severity == "error" for i in _zone_issues(model, {"kind": "entity", "id": ""}))
    assert any(i.severity == "error" for i in _zone_issues(model, {"x": "a"}))
