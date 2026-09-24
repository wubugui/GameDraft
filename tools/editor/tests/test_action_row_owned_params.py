"""ActionRow 保存：控件接管的参数「清空 = 不写键」真的存得下去；未登记参数照旧原值透传。

背景（2026-09-15 实测）：`_to_dict_raw` 末尾的「未登记参数原值透传」曾把**控件有意不写**的
schema 参数也从磁盘原值塞回去——attachToSocket 清空 images 一存，旧 images 原样回来；配音 / 气泡锚
改回继承、runActionsIf 清空条件同样存不下去。现在按"由控件接管"（owned）判：控件没写 = 它选了不写。

作用域剔除表（`_ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT`）是另一条同类的路：原本只剔
"原本就没有"的中性值，清空一个盘上有值的参数会落成中性值——playVfx.at 落成 `at:""`，运行时
整条动作静默跳过。现在"盘上非中性 → 清回中性"也去键；盘上原本就写着中性值的照旧保留。
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication, QLineEdit, QPushButton  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import audio_cue  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_TYPES,
    DIALOGUE_LAYOUT_DEFAULT,
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    ActionEditor,
    ActionRow,
    _scoped_omit_original_is_neutral,
)
from tools.editor.shared.position_ref_field import MODE_ENTITY, MODE_NONE, MODE_POINT  # noqa: E402


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


class _Open:
    """打开一条动作 → 在控件上动手 → 保存。"""

    def __init__(self, model: ProjectModel, act: dict) -> None:
        self.act = copy.deepcopy(act)
        self.ed = ActionEditor("t")
        self.ed.set_project_context(model, (model.all_scene_ids() or [None])[0])
        self.ed.set_data([copy.deepcopy(act)])

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        self.ed.deleteLater()

    @property
    def row(self):
        return self.ed._rows[0]

    def w(self, name: str):
        return self.row._param_widgets[name]

    def save(self) -> dict:
        out = self.ed.to_list()
        assert len(out) == 1
        return out[0]["params"]


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _roundtrip(model: ProjectModel, act: dict) -> dict:
    with _Open(model, act) as o:
        return {"type": act["type"], "params": o.save()}


# --------------------------------------------------------------------------- #
# 泛型控件选了不写：透传不许塞回来
# --------------------------------------------------------------------------- #

def _click_remove_buttons(images_field) -> None:
    """从真实入口删：点每一行的「−」。"""
    while True:
        btns = [b for b in images_field.findChildren(QPushButton) if b.text() == "−" and b.isEnabled()]
        live = [b for b in btns if b.parentWidget() is not None and b.parentWidget().parentWidget() is images_field]
        if not images_field._rows or not live:
            break
        live[0].click()


def test_attach_to_socket_clearing_images_saves_without_the_key(model) -> None:
    act = {"type": "attachToSocket", "params": {
        "target": "player", "socket": "right_hand", "image": "/a.png", "images": ["/a.png", "/b.png"],
        "zz_future": {"keep": True}}}
    with _Open(model, act) as o:
        _click_remove_buttons(o.w("images"))
        assert o.w("images").to_list() == []
        prm = o.save()
    assert "images" not in prm, prm
    assert prm == {"target": "player", "socket": "right_hand", "image": "/a.png", "zz_future": {"keep": True}}


def test_attach_to_socket_removing_one_image_keeps_the_rest(model) -> None:
    act = {"type": "attachToSocket", "params": {
        "target": "player", "socket": "right_hand", "images": ["/a.png", "/b.png"]}}
    with _Open(model, act) as o:
        f = o.w("images")
        f._remove(f._rows[0], f._rows[0].parentWidget())
        assert o.save()["images"] == ["/b.png"]


def test_attach_to_socket_untouched_images_roundtrip(model) -> None:
    act = {"type": "attachToSocket", "params": {
        "target": "player", "socket": "right_hand", "images": ["/a.png", "/b.png"]}}
    assert _dumps(_roundtrip(model, act)) == _dumps(act)


def test_clearing_voice_and_auto_advance_saves_without_the_keys(model) -> None:
    act = {"type": "showEmoteAndWait", "params": {
        "target": "player", "emote": "?", "voice": {"id": "v_probe", "volume": 0.5}, "autoAdvance": "voice"}}
    with _Open(model, act) as o:
        vf = o.w("voice")
        idw = vf._id_widget
        if isinstance(idw, QLineEdit):
            idw.clear()
        else:
            idw.set_current("")
        vf._advance.setCurrentIndex(vf._advance.findData("click"))
        prm = o.save()
    assert "voice" not in prm and "autoAdvance" not in prm, prm


def test_bubble_anchor_and_scale_back_to_inherit_save_without_the_keys(model) -> None:
    act = {"type": "showEmote", "params": {
        "target": "player", "emote": "?", "bubbleAnchorY": -120, "bubbleScale": 1.5}}
    with _Open(model, act) as o:
        w = o.w("bubbleAnchorY")
        assert w.value() is not None and w.scale_value() is not None
        w._chk.setChecked(False)
        w._scale_chk.setChecked(False)
        prm = o.save()
    assert "bubbleAnchorY" not in prm and "bubbleScale" not in prm, prm


def test_run_actions_if_clearing_condition_saves_without_the_key(model) -> None:
    act = {"type": "runActionsIf", "params": {"condition": {"flag": "zz_probe"}, "actions": []}}
    with _Open(model, act) as o:
        o.row._cond_if_section.set_expanded(True)
        assert o.row._cond_if_expr is not None, "展开后条件树应已建出"
        o.row._cond_if_expr.set_expr(None)
        prm = o.save()
    assert prm == {"actions": []}, prm
    # 没展开（懒建未建）：条件原样透传
    assert _dumps(_roundtrip(model, act)) == _dumps(act)


def test_play_sfx_volume_back_to_neutral_saves_without_the_key(model) -> None:
    act = {"type": "playSfx", "params": {"id": "zz_probe_sfx", "volume": 0.5}}
    assert _dumps(_roundtrip(model, act)) == _dumps(act), "没动过的本处音量原样回写"
    with _Open(model, act) as o:
        o.w("id")._volume.setValue(audio_cue.NEUTRAL_VOLUME)
        prm = o.save()
    assert prm == {"id": "zz_probe_sfx"}, prm


# --------------------------------------------------------------------------- #
# 作用域剔除表：清回中性档 = 不写
# --------------------------------------------------------------------------- #

def _set_text(w, text: str) -> None:
    if isinstance(w, QLineEdit):
        w.setText(text)
    elif hasattr(w, "set_committed_type"):
        w.set_committed_type(text)
    elif hasattr(w, "set_current"):
        w.set_current(text)
    elif hasattr(w, "set_path"):
        w.set_path(text)
    else:  # pragma: no cover - 控件换型时让用例自己报出来
        raise AssertionError(f"不认识的控件 {type(w).__name__}")


@pytest.mark.parametrize("act,pname,clear", [
    ({"type": "playVfx", "params": {"effect": "torch_snuff", "at": {"kind": "entity", "id": "player"}}},
     "at", lambda w: w.clear()),
    ({"type": "playVfx", "params": {"effect": "torch_snuff", "at": "player"}},
     "at", lambda w: w.clear()),
    ({"type": "emitVfxField", "params": {"kind": "fear", "tag": "zz_tag", "radius": 3.0, "strength": 1.0,
                                         "at": {"kind": "entity", "id": "player"}}},
     "at", lambda w: w.clear()),
    ({"type": "setPropState", "params": {"target": "player", "socket": "right_hand", "state": "out", "fadeMs": 500}},
     "fadeMs", lambda w: w.setValue(0)),
    ({"type": "fadeLight", "params": {"lightId": "zz_lamp", "scale": 0.0, "fadeMs": 800}},
     "fadeMs", lambda w: w.setValue(0)),
    ({"type": "playVfx", "params": {"effect": "torch_snuff", "x": 10.0, "y": 20.0, "seed": 7}},
     "seed", lambda w: w.setValue(0)),
    ({"type": "attachToSocket", "params": {"target": "player", "socket": "right_hand", "prop": "lantern",
                                           "state": "lit"}},
     "state", lambda w: _set_text(w, "")),
    ({"type": "attachToSocket", "params": {"target": "player", "socket": "right_hand", "image": "/a.png"}},
     "image", lambda w: _set_text(w, "")),
    ({"type": "attachToSocket", "params": {"target": "player", "socket": "right_hand", "image": "/a.png",
                                           "mirror": False}},
     "mirror", lambda w: _set_text(w, "")),
])
def test_scoped_optional_param_cleared_saves_without_the_key(model, act, pname, clear) -> None:
    assert (act["type"], pname) in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT
    with _Open(model, act) as o:
        clear(o.w(pname))
        prm = o.save()
    assert pname not in prm, prm
    want = {k: v for k, v in act["params"].items() if k != pname}
    assert prm == want, prm


@pytest.mark.parametrize("act", [
    # 作者自己写的中性值：没动过就原样保留（剔除只针对"原本没有"与"清回中性"）
    {"type": "setPropState", "params": {"target": "player", "socket": "right_hand", "state": "out", "fadeMs": 0}},
    {"type": "fadeLight", "params": {"lightId": "zz_lamp", "scale": 1.0, "fadeMs": 0}},
    {"type": "playVfx", "params": {"effect": "torch_snuff", "at": ""}},
    {"type": "attachToSocket", "params": {"target": "player", "socket": "right_hand", "image": "", "state": ""}},
    {"type": "playPropVfx", "params": {"target": "", "socket": "", "effect": "torch_snuff"}},
    # 语义中性、字面不同：三态 wait 盘上是真 bool、控件里是字符串；过场里的 bool 常写成字符串
    {"type": "playTrajectory", "params": {"trajectoryId": "zz_traj", "target": "player", "wait": True}},
    {"type": "playTrajectory", "params": {"trajectoryId": "zz_traj", "target": "player", "wait": "true"}},
    {"type": "clearBubbleLineSet", "params": {"target": "player", "silence": False}},
    {"type": "showSystemNote", "params": {"noteId": "zz_note", "force": False}},
])
def test_authored_neutral_values_roundtrip_untouched(model, act) -> None:
    assert _dumps(_roundtrip(model, act)) == _dumps(act)


@pytest.mark.parametrize("orig,neutral,want", [
    (None, "", True),
    ("", "", True),
    ("  ", "", True),
    ("player", "", False),
    ({"kind": "entity", "id": "player"}, "", False),
    (False, "", False),
    (True, "true", True),
    ("TRUE", "true", True),
    ("false", "true", False),
    (False, False, True),
    ("false", False, True),
    ("off", False, True),
    (True, False, False),
    ("yes", False, False),
    (0, 0, True),
    (0.0, 0, True),
    ("0", 0, True),
    (500, 0, False),
    ("abc", 0, False),
    (False, 0, False),
    ([], [], True),
    ([{"type": "waitMs"}], [], False),
    ("npc", "npc", True),
    ("hotspot", "npc", False),
])
def test_scoped_omit_original_is_neutral(orig, neutral, want) -> None:
    assert _scoped_omit_original_is_neutral(orig, neutral) is want


# --------------------------------------------------------------------------- #
# 未登记参数：照旧原值透传
# --------------------------------------------------------------------------- #

def test_unregistered_params_still_roundtrip(model) -> None:
    sid = (model.all_scene_ids() or [""])[0]
    for act in (
        {"type": "changeScene", "params": {"targetScene": sid, "cameraX": 5, "cameraY": -3.5}},
        {"type": "sugarWheelResetPointer", "params": {"angleDeg": 0.0, "angle": 90}},
        {"type": "showEmote", "params": {"target": "player", "emote": "?", "zz_future": [1, {"a": None}]}},
        {"type": "playSfx", "params": {"id": "zz_probe_sfx", "zz_future": "x"}},
        {"type": "runActionsIf", "params": {"condition": {"flag": "zz"}, "actions": [], "zz_future": 1}},
    ):
        out = _roundtrip(model, act)
        for k, v in act["params"].items():
            assert out["params"].get(k) == v, (act, out)


def _minimal_forms() -> list[tuple[str, dict]]:
    from tools.editor.tests import scan_action_minimal_roundtrip as scan

    man = scan._manifest_entries()
    return [
        (act, scan._minimal_params(act, man[act]))
        for act in ACTION_TYPES
        if act not in scan._MANIFEST_EXEMPT and act in man
    ]


def test_every_passthrough_action_keeps_an_unknown_key(model) -> None:
    """泛型表单与专用表单（`ActionRow._CUSTOM_FORMS`）一视同仁：没有豁免名单。"""
    lost: list[str] = []
    for act, prm in _minimal_forms():
        prm = {**prm, "zz_unknown": {"keep": [1, 2]}}
        out = _roundtrip(model, {"type": act, "params": prm})
        if out["params"].get("zz_unknown") != {"keep": [1, 2]}:
            lost.append(act)
    assert not lost, f"未登记参数被吞了：{lost}"


def test_minimal_forms_do_not_grow_keys(model) -> None:
    """scan_action_minimal_roundtrip 的判据落成用例：只填 manifest 必填，打开→保存不许多出键。"""
    grown: dict[str, dict] = {}
    for act, prm in _minimal_forms():
        out = _roundtrip(model, {"type": act, "params": json.loads(json.dumps(prm))})
        extra = {k: v for k, v in out["params"].items() if k not in prm}
        if extra:
            grown[act] = extra
    assert not grown, grown


# --------------------------------------------------------------------------- #
# 专用表单（ActionRow._CUSTOM_FORMS）：清空接管的键 = 存下去就没了；未登记参数照旧留着
# --------------------------------------------------------------------------- #

_KEEP = {"keep": [1, 2]}
_CHANGED = object()   # want 里的占位：存出来的值必须和磁盘原值不同
_PRESENT = object()   # want 里的占位：键必须在，值不管


def _act(act_type: str, **params) -> dict:
    return {"type": act_type, "params": {**params, "zz_unknown": copy.deepcopy(_KEEP)}}


def _pick_mode(field, mode: str) -> None:
    """从位置控件的档位下拉切（真实入口，会发 changed）。"""
    idx = field.mode_combo.findData(mode)
    assert idx >= 0, mode
    field.mode_combo.setCurrentIndex(idx)


def _select(combo, value: str) -> None:
    """按取值点下拉里那一行（真实入口：走 currentIndexChanged → 提交）。"""
    idx = next((i for i in range(combo.count()) if (combo.itemData(i, Qt.ItemDataRole.UserRole) or "") == value), -1)
    assert idx >= 0, (value, [combo.itemData(i, Qt.ItemDataRole.UserRole) for i in range(combo.count())])
    combo.setCurrentIndex(idx)
    assert combo.committed_type() == value


def _steps(*fns):
    def run(o) -> None:
        for fn in fns:
            fn(o)
    return run


_ENTITY_AT = {"kind": "entity", "id": "player"}
# 动画状态下拉只在值是候选时才有「不播放」那一行（悬垂值另见 anim-state picker 的已知问题），
# 所以这几条用 player 在当前场景上下文里真有的状态，开测时再换成实值。
_PLAYER_STATE = "<player-anim-state>"


def _resolve(model: ProjectModel, act: dict) -> dict:
    if _PLAYER_STATE not in act["params"].values():
        return act
    states = model.animation_state_names_for_actor((model.all_scene_ids() or [""])[0], "player")
    assert states, "工程里 player 没有任何动画状态，用例需要换一个有状态的演员"
    return {**act, "params": {k: (states[0] if v == _PLAYER_STATE else v) for k, v in act["params"].items()}}

# (动作, 在控件上怎么清, 存完必须没有的键, 存完必须等于的值)
_CUSTOM_FORM_CLEAR_CASES = [
    (_act("setSceneEntityPosition", sceneId="zz_scene", entityKind="npc", entityId="zz_npc",
          x=1, y=2, at=_ENTITY_AT),
     lambda o: _pick_mode(o.w("at"), MODE_POINT),
     ("at",), {"x": _PRESENT, "y": _PRESENT}),
    (_act("setEntityField", sceneId="zz_scene", entityKind="npc", entityId="zz_npc", fieldName="x", value=5),
     lambda o: o.w("value").setValue(0),
     (), {"value": 0}),
    (_act("setHotspotDisplayImage", sceneId="zz_scene", hotspotId="zz_hs", image="/a.png",
          worldWidth=120, worldHeight=80, facing="left"),
     _steps(lambda o: o.w("worldWidth").setValue(0), lambda o: o.w("worldHeight").setValue(0),
            lambda o: _select(o.w("facing"), "")),
     ("worldWidth", "worldHeight", "facing"), {"image": "/a.png"}),
    (_act("tempSetHotspotDisplayFacing", sceneId="zz_scene", hotspotId="zz_hs", facing="left"),
     lambda o: _select(o.w("facing"), "restore"),
     (), {"facing": "restore"}),
    (_act("persistHotspotEnabled", sceneId="zz_scene", hotspotId="zz_hs", enabled=True),
     lambda o: o.w("enabled").setChecked(False),
     (), {"enabled": False}),
    (_act("setZoneEnabled", sceneId="zz_scene", zoneId="zz_zone", enabled=True),
     lambda o: o.w("enabled").setChecked(False),
     (), {"enabled": False}),
    (_act("persistZoneEnabled", sceneId="zz_scene", zoneId="zz_zone", enabled=True),
     lambda o: o.w("enabled").setChecked(False),
     (), {"enabled": False}),
    (_act("showOverlayImage", id="zz_ov", image="/a.png", xPercent=10, yPercent=20, widthPercent=30, fill=True),
     _steps(lambda o: o.w("image").set_path(""), lambda o: o.w("fill").setChecked(False)),
     ("fill",), {"image": ""}),
    (_act("blendOverlayImage", id="zz_ov", fromImage="/a.png", toImage="/b.png", durationMs=600, delayMs=0,
          xPercent=10, yPercent=20, widthPercent=30),
     lambda o: o.w("toImage").set_path(""),
     (), {"toImage": "", "fromImage": "/a.png"}),
    (_act("startDialogueGraph", graphId="zz_graph", entry="n1", npcId="zz_npc", ownerType="npc",
          ownerId="zz_npc", dimBackground=True),
     _steps(lambda o: o.w("entry").set_value(""), lambda o: o.w("npcId").set_value(""),
            lambda o: _select(o.w("ownerType"), ""), lambda o: o.w("ownerId").set_value(""),
            lambda o: o.w("dimBackground").setChecked(False)),
     ("entry", "npcId", "ownerType", "ownerId", "dimBackground"), {"graphId": "zz_graph"}),
    (_act("playScriptedDialogue", lines=[], scriptedNpcId="player", dimBackground=True, layout="top"),
     _steps(lambda o: o.w("scriptedNpcId").set_current(""), lambda o: o.w("dimBackground").setChecked(False),
            lambda o: o.w("layout").setCurrentIndex(o.w("layout").findData(DIALOGUE_LAYOUT_DEFAULT))),
     ("scriptedNpcId", "dimBackground", "layout"), {"lines": []}),
    (_act("setPlayerAvatar", animManifest="/resources/runtime/animation/zz_pack/anim.json",
          stateMap={"idle": "zz_idle"}, portraitSlug="zz_slug"),
     _steps(lambda o: _select(o.w("animManifest"), ""), lambda o: o.w("bundleId").set_current(""),
            lambda o: _select(o.w("idle"), ""), lambda o: _select(o.w("portraitSlug"), "")),
     ("animManifest", "bundleId", "stateMap", "portraitSlug"), {}),
    (_act("setScenarioPhase", scenarioId="zz_line", phase="p1", status="active", outcome="win"),
     lambda o: o.w("outcome").clear(),
     ("outcome",), {"phase": "p1", "status": "active"}),
    *[
        (_act(t, scenarioId="zz_line"), lambda o: o.w("scenarioId").set_committed_type(""),
         (), {"scenarioId": _CHANGED})
        for t in ("startScenario", "activateScenario", "completeScenario")
    ],
    (_act("revealDocument", documentId="zz_doc", force=True),
     lambda o: o.w("force").setChecked(False),
     ("force",), {"documentId": "zz_doc"}),
    (_act("hideDocument", documentId="zz_doc"),
     lambda o: o.w("documentId").set_committed_type(""),
     (), {"documentId": _CHANGED}),
    (_act("moveEntityTo", target="player", sceneId="zz_scene", x=1, y=2, at=_ENTITY_AT, speed=50,
          moveAnimState=_PLAYER_STATE, arriveAnimState=_PLAYER_STATE, waypoints=[{"x": 3, "y": 4}],
          faceTowardMovement=True),
     _steps(lambda o: _pick_mode(o.w("at"), MODE_POINT), lambda o: _select(o.w("moveAnimState"), ""),
            lambda o: _select(o.w("arriveAnimState"), ""),
            lambda o: o.row._move_entity_waypoints_store.__setitem__(0, []),
            lambda o: o.w("faceTowardMovement").setChecked(False)),
     ("at", "moveAnimState", "arriveAnimState", "waypoints", "faceTowardMovement"),
     {"x": _PRESENT, "y": _PRESENT, "speed": 50}),
    (_act("jumpEntityTo", target="player", x=1, y=2, at=_ENTITY_AT, durationMs=800, arcHeight=60,
          jumpAnimState=_PLAYER_STATE, landAnimState=_PLAYER_STATE, faceTowardMovement=True),
     _steps(lambda o: _pick_mode(o.w("at"), MODE_POINT), lambda o: _select(o.w("jumpAnimState"), ""),
            lambda o: _select(o.w("landAnimState"), ""),
            lambda o: o.w("faceTowardMovement").setChecked(False)),
     ("at", "jumpAnimState", "landAnimState", "faceTowardMovement"), {"durationMs": 800, "arcHeight": 60}),
    (_act("teleportEntityTo", target="player", x=1, y=2, at=_ENTITY_AT),
     lambda o: _pick_mode(o.w("at"), MODE_POINT),
     ("at",), {"x": _PRESENT, "y": _PRESENT}),
    # 运动对象换到临时生成 = 不写 target；播放位置「不指定」= 老 anchorX/anchorY 一并不写
    (_act("playTrajectory", trajectoryId="zz_traj", target="player", anchorX=10, anchorY=20, flipX=True,
          wait="false", animState=_PLAYER_STATE),
     _steps(lambda o: o.w("_moverMode").setCurrentIndex(o.w("_moverMode").findData("image")),
            lambda o: _pick_mode(o.w("at"), MODE_NONE), lambda o: _select(o.w("wait"), ""),
            lambda o: _select(o.w("animState"), ""), lambda o: o.w("flipX").setChecked(False)),
     ("target", "anchorX", "anchorY", "at", "flipX", "wait", "animState"), {"spawn": _PRESENT}),
    # 顶层 x/y 不是 playTrajectory 的参数（运行时不读）：播放位置控件不读它们，按未登记参数原样留着
    (_act("playTrajectory", trajectoryId="zz_traj", target="player", at=_ENTITY_AT, x=5, y=6),
     lambda o: _pick_mode(o.w("at"), MODE_NONE),
     ("at",), {"target": "player", "x": 5, "y": 6}),
    (_act("persistNpcAt", target="zz_npc", x=1, y=2, at=_ENTITY_AT),
     lambda o: _pick_mode(o.w("at"), MODE_POINT),
     ("at",), {"x": _PRESENT, "y": _PRESENT}),
    # 气味源所属场景下拉选回「当前场景」= 不写 scene；源位置换回数字档 = 不写 at
    (_act("setSmellSource", x=1, y=2, at=_ENTITY_AT, scene="zz_scene"),
     _steps(lambda o: _pick_mode(o.w("at"), MODE_POINT), lambda o: _select(o.w("scene"), "")),
     ("at", "scene"), {"x": _PRESENT, "y": _PRESENT}),
    (_act("cutsceneSpawnActor", id="_cut_zz", name="zz_name", x=1, y=2, at=_ENTITY_AT),
     lambda o: _pick_mode(o.w("at"), MODE_POINT),
     ("at",), {"name": "zz_name", "x": _PRESENT, "y": _PRESENT}),
    (_act("cameraFollowActor", at={"kind": "point", "x": 1, "y": 2}, smooth=True),
     _steps(lambda o: _pick_mode(o.w("at"), MODE_ENTITY), lambda o: o.w("smooth").setChecked(False)),
     ("at", "smooth"), {}),
    (_act("faceEntity", target="player", direction="left", faceTarget="zz_npc"),
     lambda o: _pick_mode(o.w("at"), MODE_NONE),
     ("faceTarget", "at"), {"target": "player", "direction": "left"}),
]
_CUSTOM_FORM_CASE_IDS = [f"{c[0]['type']}-{i}" for i, c in enumerate(_CUSTOM_FORM_CLEAR_CASES)]


def test_custom_form_clear_cases_cover_every_custom_form() -> None:
    assert {c[0]["type"] for c in _CUSTOM_FORM_CLEAR_CASES} == set(ActionRow._CUSTOM_FORMS)


@pytest.mark.parametrize("act,clear,gone,want", _CUSTOM_FORM_CLEAR_CASES, ids=_CUSTOM_FORM_CASE_IDS)
def test_custom_form_cleared_keys_stay_cleared(model, act, clear, gone, want) -> None:
    act = _resolve(model, act)
    with _Open(model, act) as o:
        clear(o)
        prm = o.save()
    assert prm.get("zz_unknown") == _KEEP, prm
    for k in gone:
        assert k not in prm, (k, prm)
    for k, v in want.items():
        if v is _PRESENT:
            assert k in prm, (k, prm)
        elif v is _CHANGED:
            assert prm.get(k) != act["params"][k], (k, prm)
        else:
            assert prm.get(k) == v, (k, prm)


@pytest.mark.parametrize("act", [c[0] for c in _CUSTOM_FORM_CLEAR_CASES], ids=_CUSTOM_FORM_CASE_IDS)
def test_custom_form_untouched_keeps_owned_and_unknown_keys(model, act) -> None:
    """同一批填满形态、没动过：接管的键一个不少，未登记参数也在。"""
    act = _resolve(model, act)
    out = _roundtrip(model, act)["params"]
    assert out.get("zz_unknown") == _KEEP, out
    missing = [k for k in act["params"] if k not in out]
    assert not missing, (missing, out)


def test_set_entity_field_unknown_field_keeps_its_value(model) -> None:
    """字段名不在字段表里 → 建不出值控件：值按磁盘原样回写，不存成 ""。"""
    act = _act("setEntityField", sceneId="zz_scene", entityKind="npc", entityId="zz_npc",
               fieldName="zz_future_field", value={"a": [1, None]})
    assert _dumps(_roundtrip(model, act)) == _dumps(act)


def test_choose_action_layout_roundtrips_and_default_writes_no_key(model) -> None:
    """chooseAction 的版式下拉（与对白同一张表）：第一人称档原样存回；选回屏底缺省档 = 不写键。"""
    act = {"type": "chooseAction", "params": {
        "prompt": "", "allowCancel": False, "options": [], "layout": "firstPerson"}}
    with _Open(model, act) as o:
        assert o.save().get("layout") == "firstPerson"
        cb = o.w("layout")
        cb.setCurrentIndex(cb.findData("bottom"))
        assert "layout" not in o.save()


def test_show_overlay_image_fill_writes_true_and_greys_percent_fields(model) -> None:
    """叠图「铺满窗口」：勾上写 `fill: true`、百分比三格置灰但值照存；不勾不写键。"""
    act = {"type": "showOverlayImage", "params": {
        "id": "zz_ov", "image": "/a.png", "xPercent": 10, "yPercent": 20, "widthPercent": 30}}
    with _Open(model, act) as o:
        assert "fill" not in o.save(), "没勾 = 不写键（与运行时缺省同义）"
        pct = [o.w(k) for k in ("xPercent", "yPercent", "widthPercent")]
        assert all(w.isEnabled() for w in pct)
        o.w("fill").setChecked(True)
        assert not any(w.isEnabled() for w in pct), "铺满时百分比不起作用，要置灰"
        out = o.save()
    assert out["fill"] is True
    assert (out["xPercent"], out["yPercent"], out["widthPercent"]) == (10, 20, 30)
