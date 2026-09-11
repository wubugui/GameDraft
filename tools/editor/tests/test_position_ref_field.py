"""位置引用 `at`（数字 / 实体此刻位置 / 场景曲线插槽）在六条位置动作上的往返、控件行为与重构跟随。

2026-09-11 制作人定：轨迹曲线没有锚点，播放位置在播放时给；所有"引用某个点"的动作参数共用一个
选择器（`tools/editor/shared/position_ref_field.py`），不能只靠下拉。本文件钉住：

- **老数据一个字节不动**：只有 x/y 的动作打开→保存仍只有 x/y（数字模式不写 `at`）；
- 实体 / 插槽引用往返保真（含 int 不漂 float、悬垂 id 保值）；x/y 写编辑期快照当回落；
- 控件：模式切换只显示对应那一行；实体候选来自 ProjectModel（player 恒在，热点也在）；
  插槽候选只列有插槽的场景曲线；
- 校验器：六条动作的 `at` 形状 / 解析；
- 重构引擎：改 NPC 名字时 `at.id` 跟随，扫描计数认得它。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from tools.editor.tests.save_test_utils import repo_root_from_tests  # noqa: E402

REPO = repo_root_from_tests()

POSITION_ACTIONS = ("moveEntityTo", "jumpEntityTo", "teleportEntityTo", "persistNpcAt", "cutsceneSpawnActor", "setSceneEntityPosition")


@pytest.fixture(scope="module")
def qt_app():
    from PySide6.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(qt_app):
    from tools.editor.project_model import ProjectModel
    m = ProjectModel()
    m.load_project(Path(REPO))
    return m


@pytest.fixture(scope="module")
def scene_id(model) -> str:
    ids = model.all_scene_ids()
    assert ids
    return ids[0]


@pytest.fixture(scope="module")
def npc_id(model, scene_id) -> str:
    rows = model.npc_ids_for_scene(scene_id)
    assert rows, "第一个场景得有 NPC 才能测实体引用"
    return rows[0][0]


def _roundtrip(model, action: dict, scene_id: str | None) -> dict:
    from tools.editor.shared.action_editor import ActionEditor
    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([json.loads(json.dumps(action))])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


def _base(act: str, scene_id: str, npc_id: str, **extra) -> dict:
    if act == "setSceneEntityPosition":
        p = {"sceneId": scene_id, "entityKind": "npc", "entityId": npc_id, "x": 100, "y": 200.5}
    elif act == "cutsceneSpawnActor":
        p = {"id": "_cut_probe", "name": "???", "x": 100, "y": 200.5}
    elif act == "persistNpcAt":
        p = {"target": npc_id, "x": 100, "y": 200.5}
    elif act == "moveEntityTo":
        p = {"target": npc_id, "x": 100, "y": 200.5, "speed": 80}
    elif act == "jumpEntityTo":
        p = {"target": npc_id, "x": 100, "y": 200.5, "durationMs": 600, "arcHeight": 120}
    else:
        p = {"target": npc_id, "x": 100, "y": 200.5}
    p.update(extra)
    return {"type": act, "params": p}


# --------------------------------------------------------------------------- #
# 往返
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("act", POSITION_ACTIONS)
def test_numbers_only_roundtrip_is_byte_stable(model, scene_id, npc_id, act: str) -> None:
    """老形状（只有 x/y）打开→不改→保存：不多出 at、int 不漂 float。"""
    action = _base(act, scene_id, npc_id)
    out = _roundtrip(model, action, scene_id)
    assert out == action, out
    assert isinstance(out["params"]["x"], int)


@pytest.mark.parametrize("act", POSITION_ACTIONS)
def test_entity_ref_roundtrip_keeps_at_and_snapshot_xy(model, scene_id, npc_id, act: str) -> None:
    """`at: entity` 往返原样；x/y 保留（未改动 → 磁盘原值）。"""
    action = _base(act, scene_id, npc_id, at={"kind": "entity", "id": "player"})
    out = _roundtrip(model, action, scene_id)
    assert out == action, out


@pytest.mark.parametrize("act", POSITION_ACTIONS)
def test_slot_ref_roundtrip_preserves_dangling(model, scene_id, npc_id, act: str) -> None:
    """悬垂插槽引用（轨迹 / 插槽都不存在）保值往返——共享控件保值契约。"""
    action = _base(act, scene_id, npc_id, at={"kind": "slot", "trajectoryId": "绝不存在的轨迹_probe", "slotId": "s1"})
    out = _roundtrip(model, action, scene_id)
    assert out == action, out


def test_key_order_puts_at_right_after_xy(model, scene_id, npc_id) -> None:
    out = _roundtrip(model, {"type": "moveEntityTo", "params": {
        "speed": 80, "at": {"kind": "entity", "id": "player"}, "y": 2, "x": 1, "target": npc_id}}, scene_id)
    assert list(out["params"]) == ["target", "x", "y", "at", "speed"]
    out = _roundtrip(model, {"type": "cutsceneSpawnActor", "params": {
        "at": {"kind": "entity", "id": "player"}, "y": 2, "x": 1, "id": "_cut_a"}}, scene_id)
    assert list(out["params"]) == ["id", "x", "y", "at"]


def test_switching_to_entity_mode_writes_at_and_snapshot(model, scene_id, npc_id, qt_app) -> None:
    """控件切到「实体此刻位置」并选 NPC：写 at.entity，x/y 变成该 NPC 在场景里的摆放位置（编辑期快照）。"""
    from tools.editor.shared.action_editor import ActionEditor, ActionRow
    from tools.editor.shared.position_ref_field import MODE_ENTITY, PositionRefField, scene_entity_xy

    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([_base("teleportEntityTo", scene_id, npc_id)])
    row = ed.findChildren(ActionRow)[0]
    f = row._param_widgets["at"]
    assert isinstance(f, PositionRefField)
    assert f.mode() == "point" and f.x_spin.value() == 100
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_ENTITY))
    f.entity_sel.set_current(npc_id)
    out = ed.to_list()[0]["params"]
    assert out["at"] == {"kind": "entity", "id": npc_id}
    snap = scene_entity_xy(model, scene_id, npc_id)
    assert snap is not None
    assert (out["x"], out["y"]) == (round(snap[0], 2), round(snap[1], 2))


def test_field_rows_follow_mode_and_candidates_come_from_model(model, scene_id, npc_id, qt_app) -> None:
    from tools.editor.shared.position_ref_field import (
        MODE_ENTITY, MODE_POINT, MODE_SLOT, PositionRefField, entity_rows_for_position,
    )

    f = PositionRefField(model, lambda: scene_id)
    f.load(None, (3, 4))
    assert f.mode() == MODE_POINT and not f._row_point.isHidden() and f._row_entity.isHidden() and f._row_slot.isHidden()
    ids = [i for i, _ in entity_rows_for_position(model, scene_id)]
    assert "player" in ids and npc_id in ids
    hot = model.hotspot_ids_for_scene(scene_id)
    if hot:
        assert hot[0][0] in ids, "热点也能当「此刻位置」的来源"
    assert set(ids) <= set(getattr(f.entity_sel, "_ids", [])) | {""}
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_ENTITY))
    assert f._row_point.isHidden() and not f._row_entity.isHidden()
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_SLOT))
    assert not f._row_slot.isHidden()
    # 插槽候选只列有插槽的场景曲线
    for tid in getattr(f.traj_sel, "_ids", []):
        if not tid:
            continue
        assert model.trajectory_binding(tid) == "scene" and model.trajectory_slots(tid), tid
    # 可选：不指定
    g = PositionRefField(model, lambda: scene_id, optional=True)
    g.load(None, None)
    assert g.mode() == "" and g.value() is None and g.snapshot_xy() is None
    g.set_point(7, 8)
    assert g.value() == {"kind": "point", "x": 7, "y": 8} and g.snapshot_xy() == (7, 8)


def test_no_position_param_is_a_bare_line_edit(model, scene_id, npc_id, qt_app) -> None:
    """选择器铁律：六条动作的 `at` 都是复合控件，target / entityId 不是裸 QLineEdit。"""
    from PySide6.QtWidgets import QLineEdit
    from tools.editor.shared.action_editor import ActionRow
    from tools.editor.shared.position_ref_field import PositionRefField

    for act in POSITION_ACTIONS:
        row = ActionRow(_base(act, scene_id, npc_id), model=model, scene_id=scene_id)
        assert isinstance(row._param_widgets.get("at"), PositionRefField), act
        for key in ("target", "entityId"):
            w = row._param_widgets.get(key)
            if w is not None:
                assert type(w) is not QLineEdit, f"{act}.{key}"


# --------------------------------------------------------------------------- #
# 校验器
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("act", POSITION_ACTIONS)
def test_validator_checks_at_on_every_position_action(model, scene_id, npc_id, act: str) -> None:
    from tools.editor.validator import _append_action_param_ref_issues

    def run(at):
        issues: list = []
        _append_action_param_ref_issues(
            model, issues, _base(act, scene_id, npc_id, at=at), "parity", "probe", scene_id,
            cutscene_temp_ids=frozenset({"_cut_probe"}),
        )
        return issues

    assert not [i for i in run({"kind": "entity", "id": "player"}) if "at" in i.message]
    assert any(i.severity == "error" and "at 须为对象" in i.message for i in run(5))
    assert any(i.severity == "error" and "at.kind" in i.message for i in run({"kind": "orbit"}))
    assert any(i.severity == "warning" and "绝不存在的实体_probe" in i.message for i in run({"kind": "entity", "id": "绝不存在的实体_probe"}))
    assert any(i.severity == "error" and "at.id 为空" in i.message for i in run({"kind": "entity", "id": ""}))
    dangling = [i for i in run({"kind": "slot", "trajectoryId": "绝不存在的轨迹_probe", "slotId": "s"}) if "at" in i.message]
    assert dangling and all(i.severity == "warning" for i in dangling)


# --------------------------------------------------------------------------- #
# 重构引擎：at.id 跟随改名
# --------------------------------------------------------------------------- #

def test_entity_rename_follows_at_id() -> None:
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS, _count_entity_refs, _rewrite_bare_in_tree

    for act in POSITION_ACTIONS + ("playTrajectory",):
        assert ENTITY_REF_PARAMS.get(act, {}).get("at") == "position_ref", act
    node = {"actions": [
        {"type": "moveEntityTo", "params": {"target": "npc_a", "x": 1, "y": 2, "at": {"kind": "entity", "id": "npc_a"}}},
        {"type": "playTrajectory", "params": {"trajectoryId": "t", "target": "player", "at": {"kind": "entity", "id": "npc_a"}}},
        {"type": "teleportEntityTo", "params": {"target": "npc_b", "x": 1, "y": 2, "at": {"kind": "slot", "trajectoryId": "t", "slotId": "npc_a"}}},
    ]}
    bare, qualified, soft = _count_entity_refs(node, "s1", "npc", "npc_a")
    assert bare == 3 and qualified == 0 and soft == 0, "target 一处 + at.entity 两处；插槽 id 撞名不算"
    n = _rewrite_bare_in_tree(node, "s1", "npc", "npc_a", "npc_z", include_soft=False)
    assert n == 3
    assert node["actions"][0]["params"]["at"] == {"kind": "entity", "id": "npc_z"}
    assert node["actions"][1]["params"]["at"] == {"kind": "entity", "id": "npc_z"}
    assert node["actions"][2]["params"]["at"]["slotId"] == "npc_a", "插槽 id 不是实体引用"


# --------------------------------------------------------------------------- #
# 曲线上的点（curve）：2026-09-11 制作人要的"曲线 eval 的实时点"
# --------------------------------------------------------------------------- #

CURVE_ASSET = {
    "id": "zz_curve_probe", "label": "取值探针", "space": "screen", "binding": "scene",
    "keyframes": [
        {"atMs": 0, "x": 0, "y": 0},
        {"atMs": 500, "x": 50, "y": -20},
        {"atMs": 1000, "x": 120, "y": 10},
    ],
    "authoring": {"sceneId": "__SCENE__", "origin": {"x": 1000, "y": 2000}},
}


@pytest.fixture()
def curve_model(qt_app, tmp_path, scene_id):
    """真 ProjectModel + 一条落在临时目录里的曲线（不碰工程资产）。"""
    import json as _json
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    m = ProjectModel()
    m.load_project(root)
    sid = next(iter(m.scenes.keys()))
    doc = _json.loads(_json.dumps(CURVE_ASSET).replace("__SCENE__", sid))
    d = m.paths.trajectories_dir
    d.mkdir(parents=True, exist_ok=True)
    (d / "zz_curve_probe.json").write_text(_json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    m.reload_trajectories_from_disk()
    return m, sid


def test_model_samples_the_curve_like_the_runtime(curve_model) -> None:
    """编辑期快照与运行时 sampleTrajectoryOffset 同口径：钳两端、线性插值、加曲线原点。"""
    m, _sid = curve_model
    assert m.trajectory_duration_ms("zz_curve_probe") == 1000
    assert m.trajectory_origin("zz_curve_probe") == (1000, 2000)
    assert m.trajectory_curve_point("zz_curve_probe") == (1120, 2010)          # end
    assert m.trajectory_curve_point("zz_curve_probe", "start") == (1000, 2000)
    assert m.trajectory_curve_point("zz_curve_probe", "time", 500) == (1050, 1980)
    assert m.trajectory_curve_point("zz_curve_probe", "time", 250) == (1025, 1990)
    assert m.trajectory_curve_point("zz_curve_probe", "progress", None, 0.5) == (1050, 1980)
    assert m.trajectory_curve_point("zz_curve_probe", "time", 99999) == (1120, 2010), "越界钳到末帧"
    assert m.trajectory_curve_point("没有这条") is None


@pytest.mark.parametrize("act", POSITION_ACTIONS)
def test_curve_ref_roundtrip(curve_model, act: str) -> None:
    m, sid = curve_model
    npc = m.npc_ids_for_scene(sid)[0][0] if m.npc_ids_for_scene(sid) else "player"
    action = _base(act, sid, npc, at={"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "end"})
    assert _roundtrip(m, action, sid) == action


def test_curve_mode_writes_ref_and_snapshot_xy(curve_model, qt_app) -> None:
    """切到「曲线上的点」：写 at.curve，x/y 落成作者场景里的那个点（回落快照）。"""
    from tools.editor.shared.action_editor import ActionEditor, ActionRow
    from tools.editor.shared.position_ref_field import MODE_CURVE, PositionRefField

    m, sid = curve_model
    npc = m.npc_ids_for_scene(sid)[0][0] if m.npc_ids_for_scene(sid) else "player"
    ed = ActionEditor("t")
    ed.set_project_context(m, sid)
    ed.set_data([_base("teleportEntityTo", sid, npc)])
    f = ed.findChildren(ActionRow)[0]._param_widgets["at"]
    assert isinstance(f, PositionRefField)
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_CURVE))
    f.curve_sel.set_current("zz_curve_probe")
    f._on_curve_changed("")
    out = ed.to_list()[0]["params"]
    assert out["at"] == {"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "end"}
    assert (out["x"], out["y"]) == (1120, 2010), "x/y = 编辑期快照（运行时用 at）"
    # 换成"指定时刻"：多写 atMs，快照跟着变
    f.point_combo.setCurrentIndex(f.point_combo.findData("time"))
    f.at_spin.setValue(500)
    out = ed.to_list()[0]["params"]
    assert out["at"] == {"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "time", "atMs": 500}
    assert (out["x"], out["y"]) == (1050, 1980)
    ed.deleteLater()


def test_curve_candidates_only_baked_curves(curve_model, qt_app) -> None:
    from tools.editor.shared.position_ref_field import PositionRefField, curve_rows

    m, sid = curve_model
    ids = [i for i, _ in curve_rows(m, sid)]
    assert ids == ["zz_curve_probe"]
    f = PositionRefField(m, lambda: sid)
    assert "zz_curve_probe" in list(getattr(f.curve_sel, "_ids", []))


def test_validator_checks_curve_refs(curve_model) -> None:
    from tools.editor.validator import _append_action_param_ref_issues

    m, sid = curve_model
    npc = m.npc_ids_for_scene(sid)[0][0] if m.npc_ids_for_scene(sid) else "player"

    def run(at, act="teleportEntityTo", params=None):
        issues: list = []
        a = _base(act, sid, npc, at=at) if params is None else {"type": act, "params": {**params, "at": at}}
        _append_action_param_ref_issues(m, issues, a, "parity", "probe", sid)
        return issues

    assert run({"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "end"}) == []
    assert any(i.severity == "error" and "trajectoryId" in i.message for i in run({"kind": "curve"}))
    assert any(i.severity == "error" and "at.point" in i.message
               for i in run({"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "apex"}))
    assert any(i.severity == "error" and "atMs" in i.message
               for i in run({"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "time", "atMs": "x"}))
    assert any(i.severity == "warning" and "总时长" in i.message
               for i in run({"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "time", "atMs": 9999}))
    assert any(i.severity == "warning" and "0~1" in i.message
               for i in run({"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "progress", "progress": 2}))
    assert any(i.severity == "warning" and "不在 assets/data/trajectories" in i.message
               for i in run({"kind": "curve", "trajectoryId": "绝不存在的轨迹_probe"}))
    # playTrajectory 引用自己：开播那刻它还没在播
    self_ref = run({"kind": "curve", "trajectoryId": "zz_curve_probe"}, "playTrajectory",
                   {"trajectoryId": "zz_curve_probe", "target": "player"})
    assert any(i.severity == "warning" and "引用了它自己" in i.message for i in self_ref)


# --------------------------------------------------------------------------- #
# 相机：跟随轨迹生成物 / cameraMove 的位置引用（制作人 2026-09-11 第六轮）
# --------------------------------------------------------------------------- #

def test_trajectory_spawn_ids_enter_the_actor_universe(curve_model, qt_app) -> None:
    """"镜头跟着刚生成的铜钱走"要配得出来：spawn.id 必须进 actor 候选（严格下拉不能手输）。"""
    from tools.editor.shared.action_editor import ActionRow
    from tools.editor.shared.id_ref_selector import IdRefSelector

    m, sid = curve_model
    m.cutscenes.append({
        "id": "zz_cs", "targetScene": sid, "steps": [
            {"kind": "action", "type": "playTrajectory", "params": {
                "trajectoryId": "zz_curve_probe",
                "spawn": {"kind": "image", "src": "/a.png", "id": "coin_1", "name": "铜钱", "keep": False}}},
        ],
    })
    m.mark_dirty("cutscene")   # 编排改了 → 候选缓存作废
    assert ("coin_1", "铜钱（轨迹生成·图片）") in m.collect_trajectory_spawn_ids()
    assert "coin_1" in [i for i, _ in m.actor_id_items_for_scene(sid)]

    row = ActionRow({"type": "cameraFollowActor", "params": {}}, model=m, scene_id=sid)
    w = row._param_widgets.get("target")
    assert isinstance(w, IdRefSelector)
    assert "coin_1" in list(getattr(w, "_ids", [])), "相机跟随目标下拉里选不到轨迹生成物"


def test_validator_accepts_spawn_ids_as_actors(curve_model) -> None:
    """候选与校验必须同口径：选得出来就不能报悬垂。"""
    from tools.editor.validator import _append_action_param_ref_issues

    m, sid = curve_model
    m.cutscenes.append({
        "id": "zz_cs2", "targetScene": sid, "steps": [
            {"kind": "action", "type": "playTrajectory", "params": {
                "trajectoryId": "zz_curve_probe", "spawn": {"kind": "character", "characterId": "c", "id": "ghost_1"}}},
        ],
    })
    m.mark_dirty("cutscene")
    issues: list = []
    _append_action_param_ref_issues(
        m, issues, {"type": "cameraFollowActor", "params": {"target": "ghost_1"}}, "parity", "probe", sid)
    assert issues == [], [i.message for i in issues]
    issues = []
    _append_action_param_ref_issues(
        m, issues, {"type": "cameraFollowActor", "params": {"target": "绝不存在的实体_probe"}}, "parity", "probe", sid)
    assert any("绝不存在的实体_probe" in i.message for i in issues)


def test_camera_move_step_roundtrip_and_position_ref(curve_model, qt_app) -> None:
    """过场 cameraMove：老的纯数字步一个字节不动；切到位置引用写 at + x/y 快照。"""
    from tools.editor.editors.timeline_editor import StepWidget
    from tools.editor.shared.position_ref_field import MODE_CURVE, PositionRefField

    m, sid = curve_model
    plain = {"kind": "present", "type": "cameraMove", "x": 200, "y": 700, "duration": 1000}
    sw = StepWidget(dict(plain), m)
    assert sw.to_dict() == plain, sw.to_dict()

    withref = {"kind": "present", "type": "cameraMove", "x": 1120, "y": 2010,
               "at": {"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "end"}, "duration": 800}
    sw2 = StepWidget(dict(withref), m)
    assert sw2.to_dict() == withref, sw2.to_dict()
    f = sw2._widgets.get("__cameraMoveAt__")
    assert isinstance(f, PositionRefField)
    assert f.mode() == MODE_CURVE

    # 切到"曲线上的点"：写 at，x/y 变成编辑期快照（运行时用 at，跳过路径用 x/y 回落）
    sw3 = StepWidget(dict(plain), m)
    f3 = sw3._widgets["__cameraMoveAt__"]
    f3.mode_combo.setCurrentIndex(f3.mode_combo.findData(MODE_CURVE))
    f3.curve_sel.set_current("zz_curve_probe")
    f3._on_curve_changed("")
    out = sw3.to_dict()
    assert out["at"] == {"kind": "curve", "trajectoryId": "zz_curve_probe", "point": "end"}
    assert (out["x"], out["y"]) == (1120, 2010), out
    assert list(out) == ["kind", "type", "x", "y", "at", "duration"], list(out)
