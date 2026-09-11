"""`playTrajectory` / `stopTrajectory` 的登记面 + 往返 + 校验器契约。

这两条 action 的登记面散在五处（运行时 register / TS manifest / 编辑器 ACTION_TYPES
与 _PARAM_SCHEMAS / ACTION_PERSISTENCE / 校验器 / entity_refactor），漏哪一处报哪种错
各不相同（见 agent_docs runtime/mechanisms/action-registration-registry-surfaces.md）。
三方 parity 由既有护栏覆盖，本文件补的是**它们盖不到的那几面**：

- `ACTION_PERSISTENCE`（漏了 import 期直接 raise，但"标错档"没人拦）；
- 过场白名单（纯表演动作必须进得去，否则过场里静默跳过）；
- **最小形态**与**填满形态**两条往返无漂移——尤其"打开→什么都不改→保存"
  不许凭空多出 `wait` / `flipX` / `anchorX` / `toEnd` / `reset`（那不是格式漂移，是把
  运行时缺省 true 的 wait 钉成 false 之类的**行为改变**）；
- `wait` 三态：磁盘上真 bool 与字符串两种写法都得保真；
- 轨迹资产校验器（`assets/data/trajectories/<id>.json`，TS 权威 `TrajectoryAsset`）
  与 playTrajectory 的参数检查。

轨迹已迁出场景 JSON：主编辑器对 `assets/data/trajectories/` **只读**（唯一写者是
`tools/trajectory_workbench`），这里同时钉死"没有脏桶、不进 save_all"。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
    _TRISTATE_BOOL_PARAMS,
)
from tools.editor.tests.save_test_utils import repo_root_from_tests  # noqa: E402

REPO = repo_root_from_tests()


# --------------------------------------------------------------------------- #
# 登记面
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("act", ["playTrajectory", "stopTrajectory"])
def test_registered_on_every_editor_surface(act: str) -> None:
    assert act in ACTION_TYPES, f"{act} 不在 ACTION_TYPES：编辑器下拉里选不到"
    assert act in _PARAM_SCHEMAS, f"{act} 不在 _PARAM_SCHEMAS：参数编辑不出来"
    # 轨迹是纯表演态：TrajectorySystem.serialize 恒为空桶，标成 save 会给动作挂错存档点
    assert ACTION_PERSISTENCE.get(act) == "memory", f"{act} 的持久化档标错了"


@pytest.mark.parametrize("act", ["playTrajectory", "stopTrajectory"])
def test_in_cutscene_allowlist(act: str) -> None:
    """纯表演动作必须进过场白名单，否则过场里被静默跳过（只在控制台一行 warn）。"""
    allow = json.loads((REPO / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert act in allow


def test_wait_is_tristate_not_a_checkbox() -> None:
    """`wait` 运行时缺省 true ⇒ 勾选框的中性值(false)配不出"不等"，必须走三态。"""
    assert "wait" in _TRISTATE_BOOL_PARAMS.get("playTrajectory", ())
    kinds = dict(_PARAM_SCHEMAS["playTrajectory"])
    assert kinds["wait"] == "str", "wait 用 bool 控件就等于把运行时缺省钉成 false"
    # flipX 运行时缺省 false，勾选框才是对的
    assert kinds["flipX"] == "bool"
    # 反过来：toEnd / reset 运行时缺省是 false，勾选框才是对的
    stop_kinds = dict(_PARAM_SCHEMAS["stopTrajectory"])
    assert stop_kinds["toEnd"] == "bool"
    assert stop_kinds["reset"] == "bool"


def test_default_valued_optionals_are_scoped_omitted() -> None:
    """四个"缺省即未设"的可选键都登记了作用域剔除表，否则打开即保存会凭空多键。"""
    for key in (
        ("playTrajectory", "wait"),
        ("playTrajectory", "flipX"),
        ("stopTrajectory", "toEnd"),
        ("stopTrajectory", "reset"),
    ):
        assert key in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT, key
    # 旧的 anchor / sceneId 档已经没了：登记表里残留一条就是往返时凭空多键的温床
    assert ("playTrajectory", "anchor") not in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT
    assert "sceneId" not in dict(_PARAM_SCHEMAS["playTrajectory"])
    assert "anchor" not in dict(_PARAM_SCHEMAS["playTrajectory"])


def test_runtime_register_param_names_match_manifest() -> None:
    """register 的 paramNames 与 TS manifest 对齐（DEV 启动的一致性审计同一判据）。

    这一面 `tsc` 与 validate-data **都不报**，只有这里能抓。
    """
    reg = (REPO / "src/core/ActionRegistry.ts").read_text("utf-8")
    man = (REPO / "src/core/actionParamManifest.ts").read_text("utf-8")
    for act, expect in (
        ("playTrajectory",
         {"trajectoryId", "target", "spawn", "at", "anchorX", "anchorY", "flipX", "wait", "animState"}),
        ("stopTrajectory", {"target", "toEnd", "reset"}),
    ):
        assert f"executor.register('{act}'" in reg, f"{act} 未在 ActionRegistry 注册"
        assert f"  {act}: {{" in man, f"{act} 未收录进 ACTION_PARAM_MANIFEST"
        # 编辑器 schema 的参数集必须与运行时/manifest 的并集一致
        assert {n for n, _k in _PARAM_SCHEMAS[act]} == expect, act


def test_trajectory_selector_kind_maps_to_trajectories_universe() -> None:
    """`trajectoryId` 选择器服务的宇宙 = json_lang 的 `trajectories`（宇宙级 parity 的一端）。"""
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS
    assert _SELECTOR_KIND_UNIVERSE.get("trajectory") == "trajectories"
    assert CONTENT_ID_PARAMS.get(("playTrajectory", "trajectoryId")) == "trajectories"


def test_trajectories_dir_is_read_only_for_the_main_editor() -> None:
    """轨迹资产目录的唯一写者是轨迹工作台：主编辑器不许有脏桶、不许进 save_all。"""
    from tools.editor.project_model import ProjectModel
    assert "trajectory" not in ProjectModel.KNOWN_DIRTY_BUCKETS
    assert "trajectories" not in ProjectModel.KNOWN_DIRTY_BUCKETS
    src = (REPO / "tools/editor/project_model.py").read_text("utf-8")
    # save_all / _planned_write_paths 里不得出现该目录（写了就是与工作台互删）
    assert "trajectories_dir" in src
    for fn_name in ("def save_all", "def _planned_write_paths"):
        start = src.index(fn_name)
        end = src.find("\n    def ", start + 1)
        body = src[start:end if end > 0 else None]
        assert "trajector" not in body, f"{fn_name} 碰了轨迹资产目录"


# --------------------------------------------------------------------------- #
# 往返（最小形态 / 填满形态 / 三态保真 / 悬垂保值）
# --------------------------------------------------------------------------- #

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


def _roundtrip(model, action: dict, scene_id: str | None) -> dict:
    from tools.editor.shared.action_editor import ActionEditor
    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([json.loads(json.dumps(action))])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


@pytest.fixture(scope="module")
def scene_id(model) -> str:
    ids = model.all_scene_ids()
    assert ids
    return ids[0]


@pytest.mark.parametrize("action", [
    # 最小形态：只有必填项。打开→不改→保存**不许**多出 wait / flipX / anchorX / anchorY
    {"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "target": "player"}},
    # 填满形态（int 锚点必须保持 int，不得漂成 float）
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player",
        "anchorX": 120, "anchorY": 88.5, "flipX": True, "wait": False, "animState": "walk"}},
    # 显式写了运行时缺省档：原数据有这些键就必须保留（不是"多余键"，是作者的显式声明）
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player", "flipX": False, "wait": True}},
    # 三态字符串写法（过场老数据的形状）必须原样保真，不许归一成真 bool
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player", "wait": "false"}},
    # 播放位置的三种活引用（2026-09-11 无锚点模型）：数字 / 实体此刻位置 / 场景曲线插槽
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player", "at": {"kind": "point", "x": 120, "y": 88.5}}},
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player", "at": {"kind": "entity", "id": "player"}}},
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player",
        "at": {"kind": "slot", "trajectoryId": "coin_drop_demo", "slotId": "slot_1"}}},
    # 临时生成的运动对象：图片 / 角色模板（target 不写）；keep = 播完留下
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo",
        "spawn": {"kind": "image", "src": "/resources/runtime/images/trajectory/coin.png", "worldWidth": 24, "worldHeight": 24,
                  "anchor": {"x": 0.5, "y": 0.5}, "id": "coin_1", "name": "铜钱", "keep": True},
        "at": {"kind": "entity", "id": "player"}, "wait": False}},
    {"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "spawn": {"kind": "character", "characterId": "绝不存在的角色_probe"}}},
    # stopTrajectory：最小 / 填满
    {"type": "stopTrajectory", "params": {"target": "player"}},
    {"type": "stopTrajectory", "params": {"target": "player", "toEnd": True, "reset": True}},
    {"type": "stopTrajectory", "params": {"target": "player", "toEnd": False}},
])
def test_roundtrip_no_drift(model, scene_id, action: dict) -> None:
    assert _roundtrip(model, action, scene_id) == action


def test_roundtrip_key_order(model, scene_id) -> None:
    """键序固定 trajectoryId, target | spawn, at | anchorX+anchorY, flipX, wait, animState。"""
    out = _roundtrip(model, {"type": "playTrajectory", "params": {
        "animState": "walk", "wait": False, "flipX": True, "anchorY": 2, "anchorX": 1,
        "target": "player", "trajectoryId": "coin_drop_demo"}}, scene_id)
    assert list(out["params"]) == [
        "trajectoryId", "target", "anchorX", "anchorY", "flipX", "wait", "animState"]
    out = _roundtrip(model, {"type": "playTrajectory", "params": {
        "animState": "walk", "wait": False, "at": {"kind": "entity", "id": "player"}, "flipX": True,
        "spawn": {"kind": "character", "characterId": "c"}, "trajectoryId": "coin_drop_demo"}}, scene_id)
    assert list(out["params"]) == ["trajectoryId", "spawn", "at", "flipX", "wait", "animState"]


def test_scene_id_is_never_written(model, scene_id) -> None:
    """旧的 sceneId 档已删：即使原数据带着它，表单也不再回写（运行时从不读它）。"""
    out = _roundtrip(
        model,
        {"type": "playTrajectory", "params": {"trajectoryId": "t", "target": "player"}},
        scene_id,
    )
    assert "sceneId" not in out["params"] and "anchor" not in out["params"]


def test_dangling_trajectory_id_is_preserved(model, scene_id) -> None:
    """共享控件保值契约：候选里没有的轨迹 id 必须原样保留，不得清空/顶替。"""
    act = {"type": "playTrajectory", "params": {"trajectoryId": "绝不存在的轨迹_probe", "target": "player"}}
    assert _roundtrip(model, act, scene_id) == act


def test_trajectory_candidates_come_from_the_global_asset_dir(model, scene_id) -> None:
    """候选取自 ProjectModel.trajectories（assets/data/trajectories/*.json 的只读镜像）。"""
    from tools.editor.shared.action_editor import ActionRow
    from tools.editor.shared.id_ref_selector import IdRefSelector

    known = {i for i, _ in model.all_trajectory_ids()}
    assert "coin_drop_demo" in known, "真资产 coin_drop_demo.json 没进候选"
    row = ActionRow({"type": "playTrajectory", "params": {}}, model=model, scene_id=scene_id)
    w = row._param_widgets.get("trajectoryId")
    assert isinstance(w, IdRefSelector)
    assert known <= set(getattr(w, "_ids", [])), "轨迹资产没灌进 trajectoryId 选择器"
    assert getattr(w, "_content_id_universe", None) == "trajectories"


def test_target_selector_is_not_a_bare_line_edit(model, scene_id) -> None:
    """选择器铁律：引用字段禁止裸 QLineEdit；相机已不是合法目标，候选里不许再冒出来。"""
    from PySide6.QtWidgets import QLineEdit
    from tools.editor.shared.action_editor import ActionRow
    from tools.editor.shared.id_ref_selector import IdRefSelector

    for act in ("playTrajectory", "stopTrajectory"):
        row = ActionRow({"type": act, "params": {}}, model=model, scene_id=scene_id)
        w = row._param_widgets.get("target")
        assert w is not None and type(w) is not QLineEdit, act
        assert isinstance(w, IdRefSelector), act
        ids = getattr(w, "_ids", [])
        assert "player" in ids, f"{act}.target 选不出 player"
        assert "camera" not in ids, f"{act}.target 还给得出 camera（相机已不是轨迹目标）"


def _play_row(ed):
    from tools.editor.shared.action_editor import ActionRow
    rows = [r for r in ed.findChildren(ActionRow) if "at" in r._param_widgets]
    assert len(rows) == 1
    return rows[0]


def test_position_field_modes_write_at_or_legacy_anchor(model, scene_id, qt_app) -> None:
    """播放位置走统一的位置引用控件：不指定 = 不写；数字 = at point（老 anchorX/Y 没动就原样保真）；
    实体 / 插槽 = at 对象。"""
    from tools.editor.shared.action_editor import ActionEditor
    from tools.editor.shared.position_ref_field import MODE_ENTITY, MODE_NONE, MODE_POINT, MODE_SLOT, PositionRefField

    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([{"type": "playTrajectory", "params": {
        "trajectoryId": "coin_drop_demo", "target": "player", "anchorX": 10, "anchorY": 20}}])
    f = _play_row(ed)._param_widgets["at"]
    assert isinstance(f, PositionRefField)
    assert f.mode() == MODE_POINT and f.x_spin.value() == 10 and f.y_spin.value() == 20, "老锚点读成数字坐标"
    out = ed.to_list()[0]["params"]
    assert out["anchorX"] == 10 and out["anchorY"] == 20 and "at" not in out, "没动 → 老写法原样保真"
    f.set_point(11, 20)
    out = ed.to_list()[0]["params"]
    assert "anchorX" not in out and out["at"] == {"kind": "point", "x": 11, "y": 20}, "动了 → 写成 at point"
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_ENTITY))
    f.entity_sel.set_current("player")
    out = ed.to_list()[0]["params"]
    assert out["at"] == {"kind": "entity", "id": "player"} and "anchorX" not in out
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_SLOT))
    f.traj_sel.set_current("绝不存在的轨迹_probe")
    f.slot_sel.set_current("s9")
    out = ed.to_list()[0]["params"]
    assert out["at"] == {"kind": "slot", "trajectoryId": "绝不存在的轨迹_probe", "slotId": "s9"}, "悬垂插槽引用保值"
    f.mode_combo.setCurrentIndex(f.mode_combo.findData(MODE_NONE))
    out = ed.to_list()[0]["params"]
    assert "at" not in out and "anchorX" not in out and "anchorY" not in out, "不指定 = 什么位置键都不写"


def test_mover_switch_between_target_and_spawn(model, scene_id, qt_app) -> None:
    """运动对象三选一：切到临时生成写 spawn 不写 target；切回来写 target 不写 spawn。"""
    from PySide6.QtWidgets import QCheckBox, QComboBox
    from tools.editor.shared.action_editor import ActionEditor

    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([{"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "target": "player"}}])
    row = _play_row(ed)
    mover = row._param_widgets["_moverMode"]
    assert isinstance(mover, QComboBox) and mover.currentData() == "target"
    mover.setCurrentIndex(mover.findData("image"))
    row._param_widgets["_spawnSrc"].set_path("/resources/runtime/images/trajectory/coin.png")
    keep = row._param_widgets["_spawnKeep"]
    assert isinstance(keep, QCheckBox)
    keep.setChecked(True)
    out = ed.to_list()[0]["params"]
    assert "target" not in out
    assert out["spawn"] == {"kind": "image", "src": "/resources/runtime/images/trajectory/coin.png", "keep": True}, out
    mover.setCurrentIndex(mover.findData("character"))
    out = ed.to_list()[0]["params"]
    assert out["spawn"]["kind"] == "character" and "src" not in out["spawn"]
    mover.setCurrentIndex(mover.findData("target"))
    out = ed.to_list()[0]["params"]
    assert out.get("target") == "player" and "spawn" not in out


def test_trajectory_info_line_reports_binding(model, scene_id, qt_app) -> None:
    """轨迹选择器旁边的说明行：场景曲线报绑定场景与插槽数，相对曲线报"必须给位置"。"""
    from PySide6.QtWidgets import QLabel
    from tools.editor.shared.action_editor import ActionEditor

    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([{"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "target": "player"}}])
    row = _play_row(ed)
    labels = [w.text() for w in row.findChildren(QLabel)]
    want = "场景曲线" if model.trajectory_binding("coin_drop_demo") == "scene" else "相对曲线"
    assert any(want in t for t in labels), labels


# --------------------------------------------------------------------------- #
# 校验器：轨迹资产
# --------------------------------------------------------------------------- #

def _issue_texts(issues, severity: str | None = None) -> list[str]:
    return [i.message for i in issues if severity is None or i.severity == severity]


class _MiniModel:
    """校验器只吃它用到的那几个面：trajectories 只读镜像 + 场景 NPC 面。"""

    def __init__(self, trajectories: dict, npcs=(("npc_a", "甲"),)) -> None:
        self.trajectories = dict(trajectories)
        self.scenes = {
            "s1": {
                "id": "s1",
                "npcs": [{"id": nid, "name": nm, "x": 0, "y": 0} for nid, nm in npcs],
                "hotspots": [], "zones": [],
            },
        }
        self.cutscenes: list = []

    def npc_ids_for_scene(self, sid):
        sc = self.scenes.get(sid) or {}
        return [(str(n.get("id")), str(n.get("name") or "")) for n in sc.get("npcs") or []]

    def collect_cutscene_temp_actor_ids(self):
        return []

    def all_scene_ids(self):
        return list(self.scenes)

    def all_trajectory_ids(self):
        return [(str((d or {}).get("id") or k), k) for k, d in self.trajectories.items()]

    def trajectory_binding(self, tid):
        from tools.editor.project_model import ProjectModel
        return ProjectModel.trajectory_binding(self, tid)

    def trajectory_doc(self, tid):
        from tools.editor.project_model import ProjectModel
        return ProjectModel.trajectory_doc(self, tid)

    def trajectory_scene_id(self, tid):
        from tools.editor.project_model import ProjectModel
        return ProjectModel.trajectory_scene_id(self, tid)

    def trajectory_slots(self, tid):
        from tools.editor.project_model import ProjectModel
        return ProjectModel.trajectory_slots(self, tid)


def _validate(trajectories: dict, **kw) -> list:
    from tools.editor.validator import _validate_trajectories
    issues: list = []
    _validate_trajectories(_MiniModel(trajectories, **kw), issues)
    return issues


def _traj(**over) -> dict:
    base = {
        "id": "t1",
        "space": "screen",
        "keyframes": [{"atMs": 0, "x": 0, "y": 0}, {"atMs": 500, "x": 10, "y": 10}],
    }
    base.update(over)
    return base


def _world(**over) -> dict:
    base = _traj(space="world", worldKeyframes=[
        {"atMs": 0, "x": 0, "y": 0, "z": 0, "h": 0},
        {"atMs": 500, "x": 10, "y": 0, "z": 5, "h": 3},
    ])
    base.update(over)
    return base


def test_validator_accepts_minimal_legal_screen_asset() -> None:
    """红线：兜底 ⊆ TS 权威——合法最小形态必须零告警通过。"""
    assert _validate({"t1": _traj()}) == []


def test_validator_accepts_minimal_legal_world_asset() -> None:
    assert _validate({"t1": _world()}) == []


def test_real_asset_on_disk_passes() -> None:
    """仓库里唯一的真资产必须零 error（它就是运行时正在播的那条）。"""
    path = REPO / "public/assets/data/trajectories/coin_drop_demo.json"
    doc = json.loads(path.read_text("utf-8"))
    assert _issue_texts(_validate({path.stem: doc}), "error") == []


def test_validator_rejects_id_mismatch_and_bad_space() -> None:
    msgs = _issue_texts(_validate({"file_a": _traj(id="other")}), "error")
    assert any("与文件名" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(id="")}), "error")
    assert any("缺少非空 id" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(space="camera")}), "error")
    assert any("space" in m for m in msgs)


def test_validator_rejects_empty_or_unbaked_keyframes() -> None:
    empty = _issue_texts(_validate({"t1": _traj(keyframes=[])}), "error")
    assert any("没有 keyframes" in m for m in empty)
    unbaked = _issue_texts(_validate({"t1": _traj(keyframes=[], source={"segments": []})}), "error")
    assert any("未烘焙" in m for m in unbaked)


def test_validator_checks_frame_time_order_and_first_frame() -> None:
    back = _issue_texts(_validate({"t1": _traj(keyframes=[
        {"atMs": 0, "x": 0, "y": 0}, {"atMs": 100, "x": 1, "y": 1}, {"atMs": 50, "x": 2, "y": 2},
    ])}), "error")
    assert any("非递减" in m for m in back)
    late = _issue_texts(_validate({"t1": _traj(keyframes=[
        {"atMs": 120, "x": 0, "y": 0}, {"atMs": 500, "x": 1, "y": 1},
    ])}), "warning")
    assert any("首帧" in m for m in late)
    nan = _issue_texts(_validate({"t1": _traj(keyframes=[{"atMs": "x", "x": 0, "y": 0}])}), "error")
    assert any("atMs" in m for m in nan)


def test_validator_checks_channel_ranges_and_easing() -> None:
    msgs = _issue_texts(_validate({"t1": _traj(keyframes=[
        {"atMs": 0, "x": 0, "y": 0, "scale": -1, "alpha": 2, "sortY": "nope",
         "easing": "bounce"},
    ])}), "error")
    assert any("scale" in m for m in msgs)
    assert any("alpha" in m for m in msgs)
    assert any("sortY" in m for m in msgs)
    assert any("easing" in m for m in msgs)


def test_validator_world_asset_needs_aligned_world_frames() -> None:
    missing = _issue_texts(_validate({"t1": _traj(space="world")}), "error")
    assert any("worldKeyframes" in m for m in missing)
    # 帧数不等 = error
    short = _issue_texts(_validate({"t1": _world(worldKeyframes=[
        {"atMs": 0, "x": 0, "y": 0, "z": 0, "h": 0}])}), "error")
    assert any("逐帧对应" in m for m in short)
    # 帧数相等但 atMs 对不上 = error
    skew = _issue_texts(_validate({"t1": _world(worldKeyframes=[
        {"atMs": 0, "x": 0, "y": 0, "z": 0, "h": 0},
        {"atMs": 400, "x": 10, "y": 0, "z": 5, "h": 3}])}), "error")
    assert any("不一致" in m for m in skew)
    # h < 0 = error
    neg = _issue_texts(_validate({"t1": _world(worldKeyframes=[
        {"atMs": 0, "x": 0, "y": 0, "z": 0, "h": -1},
        {"atMs": 500, "x": 10, "y": 0, "z": 5, "h": 3}])}), "error")
    assert any("离地高度" in m for m in neg)


def test_validator_warns_on_huge_frame_count() -> None:
    frames = [{"atMs": i, "x": 0, "y": 0} for i in range(600)]
    msgs = _issue_texts(_validate({"t1": _traj(keyframes=frames)}), "warning")
    assert any("容差" in m for m in msgs)


def test_validator_authoring_refs_are_soft() -> None:
    """authoring 只是工作台重开现场用：场景/NPC 没了只 warning，绝不 error。"""
    gone_scene = _validate({"t1": _traj(authoring={"sceneId": "没有这个场景", "anchor": {"x": 0, "y": 0}})})
    assert gone_scene and all(i.severity == "warning" for i in gone_scene)
    gone_npc = _validate({"t1": _traj(authoring={
        "sceneId": "s1", "entity": {"kind": "npc", "id": "npc_没了"}, "anchor": {"x": 0, "y": 0}})})
    assert gone_npc and all(i.severity == "warning" for i in gone_npc)
    ok = _validate({"t1": _traj(authoring={
        "sceneId": "s1", "entity": {"kind": "npc", "id": "npc_a"}, "anchor": {"x": 0, "y": 0}})})
    assert ok == []


def test_validator_binding_and_slots() -> None:
    """binding / slots / origin：场景曲线要 sceneId（error）、要 origin（warning）；相对曲线不该绑场景、不该有插槽（warning）；
    插槽 id 空 / 重复 / 坐标坏 = error；binding 写了别的值 = error。"""
    ok = _validate({"t1": _traj(binding="scene", slots=[{"id": "a", "x": 1, "y": 2, "label": "甲"}],
                                authoring={"sceneId": "s1", "origin": {"x": 0, "y": 0}})})
    assert ok == []
    assert _validate({"t1": _traj(binding="free")}) == []
    msgs = _issue_texts(_validate({"t1": _traj(binding="scene")}), "error")
    assert any("authoring.sceneId 为空" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(binding="scene", authoring={"sceneId": "s1"})}), "warning")
    assert any("authoring.origin" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(binding="free", authoring={"sceneId": "s1"})}), "warning")
    assert any("相对曲线" in m and "sceneId" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(binding="free", slots=[{"id": "a", "x": 1, "y": 2}])}), "warning")
    assert any("相对曲线带了命名插槽" in m for m in msgs)
    msgs = _issue_texts(_validate({"t1": _traj(binding="orbit")}), "error")
    assert any("binding" in m for m in msgs)
    bad = _validate({"t1": _traj(binding="scene", authoring={"sceneId": "s1", "origin": {"x": 0, "y": 0}},
                                 slots=[{"id": "", "x": 1, "y": 2}, {"id": "a", "x": "nope", "y": 2}, {"id": "a", "x": 1, "y": 2}, "x"])})
    errs = _issue_texts(bad, "error")
    assert any("缺少非空 id" in m for m in errs)
    assert any("slots[1].x" in m for m in errs)
    assert any("重复" in m for m in errs)
    assert any("slots[3] 须为对象" in m for m in errs)
    # 老资产：没写 binding，按 authoring.sceneId 推成场景曲线；老锚点就是曲线起点（运行时 trajectoryOrigin 回落）→ 零问题
    assert _validate({"t1": _traj(authoring={"sceneId": "s1", "anchor": {"x": 0, "y": 0}})}) == []
    msgs = _issue_texts(_validate({"t1": _traj(authoring={"sceneId": "s1"})}), "warning")
    assert any("authoring.origin" in m for m in msgs)


def test_validator_reports_unparseable_files_as_errors(tmp_path: Path) -> None:
    """读不进模型的资产文件按目录重扫补成 error（引用它的 playTrajectory 运行时整步跳过）。"""
    from tools.editor.shared.project_paths import ProjectPaths
    from tools.editor.validator import _validate_trajectories

    d = tmp_path / "public" / "assets" / "data" / "trajectories"
    d.mkdir(parents=True)
    (d / "bad.json").write_text("{not json", encoding="utf-8")
    (d / "list.json").write_text("[]", encoding="utf-8")
    (d / "good.json").write_text(json.dumps(_traj(id="good")), encoding="utf-8")
    m = _MiniModel({"good": _traj(id="good")})
    m.paths = ProjectPaths(tmp_path)
    issues: list = []
    _validate_trajectories(m, issues)
    errs = [i for i in issues if i.severity == "error"]
    assert {i.item_id for i in errs} == {"bad", "list"}
    assert all(i.data_type == "trajectory" for i in errs)


# --------------------------------------------------------------------------- #
# 校验器：playTrajectory / stopTrajectory 参数
# --------------------------------------------------------------------------- #

def test_play_trajectory_param_ref_issues(model, scene_id) -> None:
    """`playTrajectory.trajectoryId` 悬垂 → warning（"宁可少校验不误报"，别升 error）。"""
    from tools.editor.validator import _append_action_param_ref_issues
    issues: list = []
    _append_action_param_ref_issues(
        model, issues,
        {"type": "playTrajectory", "params": {"trajectoryId": "绝不存在的轨迹_probe", "target": "player"}},
        "parity", "probe", scene_id,
    )
    hit = [i for i in issues if "绝不存在的轨迹_probe" in i.message]
    assert hit, "悬垂 trajectoryId 一声不吭 = 运行时静默跳过、校验全绿"
    assert all(i.severity == "warning" for i in hit)
    # 真资产 + player：零问题
    issues = []
    _append_action_param_ref_issues(
        model, issues,
        {"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "target": "player"}},
        "parity", "probe", scene_id,
    )
    assert issues == []


def test_play_trajectory_missing_id_or_target_is_error(model, scene_id) -> None:
    from tools.editor.validator import _append_action_param_ref_issues
    issues: list = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {}}, "parity", "probe", scene_id)
    assert any(i.severity == "error" and "trajectoryId" in i.message for i in issues)
    assert any(i.severity == "error" and "target" in i.message for i in issues)


def test_play_trajectory_anchor_pair_and_flip_shape(model, scene_id) -> None:
    from tools.editor.validator import _append_action_param_ref_issues
    issues: list = []
    _append_action_param_ref_issues(
        model, issues,
        {"type": "playTrajectory", "params": {
            "trajectoryId": "coin_drop_demo", "target": "player", "anchorX": 12}},
        "parity", "probe", scene_id)
    assert any(i.severity == "warning" and "成对" in i.message for i in issues)
    issues = []
    _append_action_param_ref_issues(
        model, issues,
        {"type": "playTrajectory", "params": {
            "trajectoryId": "coin_drop_demo", "target": "player",
            "anchorX": "abc", "anchorY": 1, "flipX": "yes"}},
        "parity", "probe", scene_id)
    assert any(i.severity == "warning" and "anchorX" in i.message for i in issues)
    assert any(i.severity == "warning" and "flipX" in i.message for i in issues)


def test_play_trajectory_needs_target_or_spawn(model, scene_id) -> None:
    """运动对象二选一：都没有 = error；spawn 给了就不再要 target；坏 spawn 形状 = error。"""
    from tools.editor.validator import _append_action_param_ref_issues
    issues: list = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo"}}, "parity", "probe", scene_id)
    assert any(i.severity == "error" and "运动对象" in i.message for i in issues)
    issues = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {
            "trajectoryId": "coin_drop_demo",
            "spawn": {"kind": "image", "src": "/resources/runtime/images/trajectory/绝不存在.png", "worldWidth": -1}}},
        "parity", "probe", scene_id)
    assert not any(i.severity == "error" for i in issues), [i.message for i in issues]
    assert any("找不到文件" in i.message for i in issues)
    assert any("worldWidth" in i.message for i in issues)
    issues = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {
            "trajectoryId": "coin_drop_demo", "spawn": {"kind": "character"}}},
        "parity", "probe", scene_id)
    assert any(i.severity == "error" and "characterId" in i.message for i in issues)
    issues = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {
            "trajectoryId": "coin_drop_demo", "spawn": {"kind": "character", "characterId": "绝不存在的角色_probe"}}},
        "parity", "probe", scene_id)
    assert any(i.severity == "warning" and "character_registry" in i.message for i in issues)
    issues = []
    _append_action_param_ref_issues(
        model, issues, {"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "spawn": "coin"}},
        "parity", "probe", scene_id)
    assert any(i.severity == "error" and "spawn 须为对象" in i.message for i in issues)


def test_play_trajectory_at_shape_and_resolution(model, scene_id) -> None:
    """at：坏形状 error；实体解析不到 warning；插槽悬垂轨迹 warning、缺插槽 error。"""
    from tools.editor.validator import _append_action_param_ref_issues

    def run(at):
        issues: list = []
        _append_action_param_ref_issues(
            model, issues, {"type": "playTrajectory", "params": {"trajectoryId": "coin_drop_demo", "target": "player", "at": at}},
            "parity", "probe", scene_id)
        return issues

    assert run({"kind": "point", "x": 1, "y": 2}) == []
    assert run({"kind": "entity", "id": "player"}) == []
    assert any(i.severity == "error" for i in run("player"))
    assert any(i.severity == "error" and "at.kind" in i.message for i in run({"kind": "camera"}))
    assert any(i.severity == "error" and "at.y" in i.message for i in run({"kind": "point", "x": 1, "y": "nope"}))
    assert any(i.severity == "warning" and "绝不存在的实体_probe" in i.message for i in run({"kind": "entity", "id": "绝不存在的实体_probe"}))
    assert any(i.severity == "error" for i in run({"kind": "slot", "trajectoryId": "coin_drop_demo"}))
    dangling = run({"kind": "slot", "trajectoryId": "绝不存在的轨迹_probe", "slotId": "s"})
    assert dangling and all(i.severity == "warning" for i in dangling)
    missing = run({"kind": "slot", "trajectoryId": "coin_drop_demo", "slotId": "绝不存在的插槽_probe"})
    assert any(i.severity == "error" and "插槽" in i.message for i in missing)


def test_camera_target_is_now_a_dangling_actor(model, scene_id) -> None:
    """`target: camera` 不再是合法档：按普通悬垂 actor 引用出 warning，且不崩。"""
    from tools.editor.validator import _append_action_param_ref_issues
    for act in ("playTrajectory", "stopTrajectory"):
        issues: list = []
        params = {"target": "camera"}
        if act == "playTrajectory":
            params["trajectoryId"] = "coin_drop_demo"
        _append_action_param_ref_issues(
            model, issues, {"type": act, "params": params}, "parity", "probe", scene_id)
        hit = [i for i in issues if "camera" in i.message]
        assert hit, f"{act}.target=camera 没被当悬垂报出来"
        assert all(i.severity == "warning" for i in hit), act


def test_stop_trajectory_requires_target(model, scene_id) -> None:
    from tools.editor.validator import _append_action_param_ref_issues
    issues: list = []
    _append_action_param_ref_issues(
        model, issues, {"type": "stopTrajectory", "params": {}}, "parity", "probe", scene_id)
    assert any(i.severity == "error" and "target" in i.message for i in issues)


# --------------------------------------------------------------------------- #
# 时间轴摘要（纯显示，不许动 to_dict 的输出）
# --------------------------------------------------------------------------- #

def test_timeline_summary_line_reads_the_key_fields() -> None:
    from tools.editor.editors.timeline_editor import step_summary_line
    line = step_summary_line({
        "kind": "action", "type": "playTrajectory",
        "params": {"trajectoryId": "轨迹_甲", "target": "npc_x",
                   "anchorX": 12, "anchorY": 34, "flipX": True, "wait": False, "animState": "walk"},
    })
    for frag in ("playTrajectory", "轨迹_甲", "npc_x", "12", "34", "翻转", "不等", "walk"):
        assert frag in line, (frag, line)
    # target 缺省时说清是缺了，而不是留白让人以为漏填
    assert "缺 target" in step_summary_line({
        "kind": "action", "type": "playTrajectory", "params": {"trajectoryId": "t"},
    })
    line = step_summary_line({
        "kind": "action", "type": "playTrajectory",
        "params": {"trajectoryId": "t", "spawn": {"kind": "image", "src": "/a/b/coin.png", "keep": True},
                   "at": {"kind": "slot", "trajectoryId": "t", "slotId": "落点"}},
    })
    for frag in ("生成图片", "coin.png", "留下", "插槽", "落点"):
        assert frag in line, (frag, line)
    line = step_summary_line({
        "kind": "action", "type": "playTrajectory",
        "params": {"trajectoryId": "t", "target": "npc_x", "at": {"kind": "entity", "id": "npc_y"}},
    })
    assert "实体:npc_y" in line
