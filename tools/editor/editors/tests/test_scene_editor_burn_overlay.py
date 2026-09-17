"""场景页的可燃实例（A3.8「模板 + 实例」）：热点 / NPC 属性面板的「可燃」块 + 画布按模板画 + 着火点标记。

- 宿主身上写 ``burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?}``；开 = 写块、关 = 删整块，
  缺省值不写回、没动过原样往返；
- 画布上开了可燃的实体按**模板图、模板真实尺寸**画（× 实体 scale / rotation / 朝向 / 锚点 / 透视），与运行时
  ``burnEntityPlacement`` 同口径（``shared/burn_geometry`` 是它的镜像，这里按 ``burnSim.test.ts`` 同组用例钉死）；
- 着火点是模板图内 uv，与贴图从同一个摆法派生；模板在盘上改了（燃烧工作台存盘）画布与检视器立刻重画。
"""
from __future__ import annotations

import copy
import json
import math
import os
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPointF, Qt  # noqa: E402
from PySide6.QtGui import QColor, QImage, QTransform  # noqa: E402
from PySide6.QtWidgets import QApplication, QGraphicsPixmapItem  # noqa: E402

from tools.editor.editors.scene_editor import SceneEditor, _SceneNpcAnimRuntime  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import burn_geometry as geo  # noqa: E402
from tools.editor.shared import burnables as bn  # noqa: E402
from tools.editor.shared.burnable_host_form import BurnableHostSection  # noqa: E402
from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

PAPER_IMG = "/resources/runtime/images/burn/paper.png"
CANDLE_IMG = "/resources/runtime/images/burn/candle.png"
OLD_IMG = "/resources/runtime/images/burn/old.png"
WU = bn.WU_PER_CM


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _dump(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _png(root: Path, url: str, w: int, h: int) -> None:
    p = root / "public" / url.lstrip("/")
    p.parent.mkdir(parents=True, exist_ok=True)
    img = QImage(w, h, QImage.Format.Format_ARGB32)
    img.fill(QColor(200, 100, 50, 255))
    assert img.save(str(p))


PAPER = {"id": "paper_pile", "label": "纸钱堆", "image": PAPER_IMG, "widthCm": 50, "heightCm": 25, "mode": "spread",
         "ignitionPoints": [{"id": "p1", "u": 0.25, "v": 0.5}, {"id": "p2", "u": 1, "v": 1}]}
CANDLE = {"id": "candle_red", "image": CANDLE_IMG, "widthCm": 10, "heightCm": 40, "mode": "consume"}


def _project(root: Path) -> Path:
    write_minimal_loadable_project(root)
    _png(root, PAPER_IMG, 64, 32)
    _png(root, CANDLE_IMG, 16, 64)
    _png(root, OLD_IMG, 20, 20)
    sp = root / "public" / "assets" / "scenes" / "sc_a.json"
    sc = json.loads(sp.read_text(encoding="utf-8"))
    sc["hotspots"] = [
        {"id": "hs_paper", "type": "inspect", "label": "hs_paper", "data": {}, "x": 300, "y": 400, "interactionRange": 50,
         "displayImage": {"image": OLD_IMG, "worldWidth": 100, "worldHeight": 50},
         "burnable": {"template": "paper_pile", "signals": {"ignited": "纸烧起来了"}}},
        {"id": "hs_candle", "type": "inspect", "label": "hs_candle", "data": {}, "x": 600, "y": 400, "scale": 2, "rotation": 30, "interactionRange": 50,
         "displayImage": {"image": CANDLE_IMG, "worldWidth": 20, "worldHeight": 60, "facing": "left"},
         "burnable": {"template": "candle_red", "initial": "burning", "playerIgnite": False}},
        {"id": "hs_ghost", "type": "inspect", "label": "hs_ghost", "data": {}, "x": 700, "y": 300, "interactionRange": 50,
         "burnable": {"template": "nope"}},
        {"id": "hs_plain", "type": "inspect", "label": "hs_plain", "data": {}, "x": 100, "y": 100, "interactionRange": 50,
         "displayImage": {"image": OLD_IMG, "worldWidth": 30, "worldHeight": 30}},
    ]
    sc["npcs"] = [
        {"id": "npc_torch", "name": "举火的人", "x": 900, "y": 500, "interactionRange": 60, "scale": 1.5,
         "anchor": {"x": 0.5, "y": 0.5}, "animFile": "/assets/animation/nobody/anim.json",
         "burnable": {"template": "paper_pile"}},
        {"id": "npc_plain", "name": "路人", "x": 950, "y": 520, "interactionRange": 60},
    ]
    _dump(sp, sc)
    _dump(bn.burnables_dir(root) / "paper_pile.json", PAPER)
    _dump(bn.burnables_dir(root) / "candle_red.json", CANDLE)
    return root


# --------------------------------------------------------------------------- #
# 几何：burn_geometry ↔ src/systems/burn/burnGeometry.ts（burnSim.test.ts 同组用例）
# --------------------------------------------------------------------------- #

def test_frame_bottom_center_is_the_foot() -> None:
    f = geo.entity_frame({"x": 300, "y": 500}, (40, 20), depth_scale=1.0, flip_x=False)
    assert geo.uv_to_scene(f, 0.5, 1) == pytest.approx((300, 500))
    assert (f.foot_x, f.foot_y) == pytest.approx((300, 500))


def test_frame_anchor_scale_rotation_flip_match_runtime_cases() -> None:
    f = geo.entity_frame({"x": 50, "y": 80, "scale": 2, "rotation": 30, "anchor": {"x": 0.5, "y": 0.5}},
                         (40, 20), depth_scale=1.0, flip_x=True)
    assert geo.uv_to_scene(f, 0.5, 0.5) == pytest.approx((50, 80), abs=1e-9)
    bottom = geo.uv_to_scene(f, 0.5, 1)
    assert (f.foot_x, f.foot_y) == pytest.approx(bottom, abs=1e-9)
    g = geo.entity_frame({"x": 0, "y": 0}, (40, 20), depth_scale=1.0, flip_x=True)
    assert geo.uv_to_scene(g, 0, 1)[0] == pytest.approx(20)
    # 透视系数与实例 scale 相乘；非法透视系数按 1
    h = geo.entity_frame({"x": 0, "y": 0, "scale": 2}, (40, 20), depth_scale=0.5, flip_x=False)
    assert geo.uv_to_scene(h, 1, 1)[0] == pytest.approx(20)
    k = geo.entity_frame({"x": 0, "y": 0}, (40, 20), depth_scale=float("nan"), flip_x=False)
    assert geo.uv_to_scene(k, 1, 1)[0] == pytest.approx(20)


@pytest.mark.parametrize("defn,flip,ds", [
    ({"x": 300, "y": 400}, False, 1.0),
    ({"x": 10, "y": 20, "scale": 1.5, "rotation": 30}, True, 0.7),
    ({"x": -5, "y": 7, "rotation": -90, "anchor": {"x": 0.2, "y": 0.4}}, False, 1.3),
])
def test_pixel_transform_and_npc_sprite_transform_agree_with_the_frame(app, defn, flip, ds) -> None:
    """贴图（QTransform）、着火点（uv_to_scene）、NPC 精灵（draw_at 的变换）三者是同一个摆法。"""
    size = (44.0, 22.0)
    fw, fh = 64.0, 32.0
    f = geo.entity_frame(defn, size, depth_scale=ds, flip_x=flip)
    t = QTransform(*geo.frame_pixel_transform(f, fw, fh))
    for u, v in ((0, 0), (0.25, 0.5), (1, 1), (0.5, 0.9)):
        p = t.map(QPointF(u * fw, v * fh))
        assert (p.x(), p.y()) == pytest.approx(geo.uv_to_scene(f, u, v), abs=1e-6)
    # NPC 精灵：draw_at 用的是 translate → rotate → scale(sx·facing, sy) → translate(-fw·ax, -fh·ay)
    ax, ay = (defn.get("anchor") or {}).get("x", 0.5), (defn.get("anchor") or {}).get("y", 1.0)
    s = float(defn.get("scale", 1)) * ds
    ref = QTransform()
    ref.translate(defn["x"], defn["y"])
    if defn.get("rotation"):
        ref.rotate(defn["rotation"])
    ref.scale(size[0] / fw * (-1 if flip else 1) * s, size[1] / fh * s)
    ref.translate(-fw * ax, -fh * ay)
    for u, v in ((0, 0), (0.25, 0.5), (1, 1)):
        p = ref.map(QPointF(u * fw, v * fh))
        assert (p.x(), p.y()) == pytest.approx(geo.uv_to_scene(f, u, v), abs=1e-6)


def test_prop_scale_follows_the_runtime_texture_width_rule() -> None:
    # 运行时挂件贴图宽 = texW × scale ⇒ 可燃挂件 scale = widthCm·0.88 / texW × 预设 scale
    assert geo.prop_scale_for_template({"widthCm": 50}, 64, 1) == pytest.approx(50 * 0.88 / 64)
    assert geo.prop_scale_for_template({"widthCm": 50}, 64, 2) == pytest.approx(2 * 50 * 0.88 / 64)
    assert geo.prop_scale_for_template({"widthCm": 0}, 64, 1) is None
    assert geo.prop_scale_for_template({"widthCm": 50}, 0, 1) is None
    assert geo.prop_anchor_for_template({"grip": {"u": 0.2, "v": 0.9}}) == (0.2, 0.9)
    assert geo.prop_anchor_for_template({}) == (0.5, 1.0)


# --------------------------------------------------------------------------- #
# 真场景页
# --------------------------------------------------------------------------- #

@pytest.fixture()
def editor(tmp_path: Path, app):
    root = _project(tmp_path / "p")
    model = ProjectModel()
    model.load_project(root)
    ed = SceneEditor(model)
    ed._refresh_scene_list()
    ed._load_scene("sc_a")
    for _ in range(3):
        QApplication.processEvents()
    try:
        yield ed, model, root
    finally:
        ed.deleteLater()
        QApplication.processEvents()
        destroy_leftover_qt_widgets()


def _hs(model: ProjectModel, hid: str) -> dict:
    return next(h for h in model.scenes["sc_a"]["hotspots"] if h["id"] == hid)


def _npc(model: ProjectModel, nid: str) -> dict:
    return next(n for n in model.scenes["sc_a"]["npcs"] if n["id"] == nid)


def _markers(ed: SceneEditor) -> dict[tuple[str, str, str], object]:
    return {(it.entity_kind_ref, it.entity_ref_id, it.point_id): it for it in ed._canvas.burn_marker_items()}


def test_canvas_draws_the_template_image_at_template_size(editor) -> None:
    ed, model, _root = editor
    canvas = ed._canvas
    item = canvas.entity_item_by_key("hotspot:hs_paper".replace("hotspot:", "hotspot_display:"))
    assert isinstance(item, QGraphicsPixmapItem)
    assert item.pixmap().width() == 64, "画的是模板的图（64×32），不是热点自己的展示图（20×20）"
    r = item.sceneBoundingRect()
    assert (r.width(), r.height()) == pytest.approx((50 * WU, 25 * WU), abs=1e-6), "按模板真实尺寸，不按 displayImage 宽高"
    assert (r.center().x(), r.bottom()) == pytest.approx((300, 400), abs=1e-6), "底边中点对准实体坐标"

    # 缩放 2 + 旋转 30 + 朝左：图四角与着火点都在同一个 BurnFrame 上
    hs = _hs(model, "hs_candle")
    cand = canvas.entity_item_by_key("hotspot_display:hs_candle")
    f = geo.entity_frame(hs, (10 * WU, 40 * WU), depth_scale=1.0, flip_x=True)
    pm = cand.pixmap()
    for u, v in ((0, 0), (1, 0), (0, 1), (1, 1)):
        p = cand.sceneTransform().map(QPointF(u * pm.width(), v * pm.height()))
        assert (p.x(), p.y()) == pytest.approx(geo.uv_to_scene(f, u, v), abs=1e-6)

    ms = _markers(ed)
    assert set(ms) == {("hotspot", "hs_paper", "p1"), ("hotspot", "hs_paper", "p2"), ("hotspot", "hs_candle", ""),
                       ("hotspot", "hs_ghost", ""), ("npc", "npc_torch", "p1"), ("npc", "npc_torch", "p2")}
    p1 = ms[("hotspot", "hs_paper", "p1")]
    fp = geo.entity_frame(_hs(model, "hs_paper"), (50 * WU, 25 * WU), depth_scale=1.0, flip_x=False)
    assert (p1.pos().x(), p1.pos().y()) == pytest.approx(geo.uv_to_scene(fp, 0.25, 0.5))
    assert "缺省" in p1.label_text(), "第一个着火点 = igniteBurnable 不写 point 时用的那个，要标出来"
    whole = ms[("hotspot", "hs_candle", "")]
    assert whole.style == "whole" and "整体点着" in whole.label_text()
    assert (whole.pos().x(), whole.pos().y()) == pytest.approx(geo.uv_to_scene(f, 0.5, 0.5))
    ghost = ms[("hotspot", "hs_ghost", "")]
    assert ghost.style == "warn" and "不存在" in ghost.label_text()
    assert (ghost.pos().x(), ghost.pos().y()) == (700, 300), "模板装不上：红叉标在实体锚点"
    assert canvas.entity_item_by_key("hotspot_display:hs_ghost") is None, "模板装不上：运行时不画，画布也不画"
    for it in ms.values():
        assert it.acceptedMouseButtons() == Qt.MouseButton.NoButton, "标记不许吃鼠标（会挡住下面的实体点选）"
        assert it.shape().isEmpty()

    plain = canvas.entity_item_by_key("hotspot_display:hs_plain")
    assert isinstance(plain, QGraphicsPixmapItem) and plain.sceneBoundingRect().width() == pytest.approx(30)
    assert not any(k[1] == "hs_plain" for k in ms), "没开可燃的热点照旧画自己的展示图、没有着火点"
    assert model.is_dirty is False, "打开场景不许标脏"


def test_burnable_npc_sprite_is_the_template_not_its_animation(editor) -> None:
    ed, model, _root = editor
    rt = ed._scene_npc_runtimes.get("npc_torch")
    assert isinstance(rt, _SceneNpcAnimRuntime), "开了可燃的 NPC：动画包都没有也要画出模板图"
    assert (rt.world_w, rt.world_h) == pytest.approx((50 * WU, 25 * WU))
    assert rt.atlas.width() == 64 and rt.frames == [0]
    assert "npc_plain" not in ed._scene_npc_runtimes
    # 着火点跟着精灵走：挪 NPC 画一拍，标记落在新摆法上
    rt.draw_at(1000.0, 600.0)
    f = ed._npc_burn_frame(rt, 1000.0, 600.0)
    p1 = _markers(ed)[("npc", "npc_torch", "p1")]
    assert (p1.pos().x(), p1.pos().y()) == pytest.approx(geo.uv_to_scene(f, 0.25, 0.5))
    # 锚点 0.5/0.5：锚点落在实体坐标上
    assert geo.uv_to_scene(f, 0.5, 0.5) == pytest.approx((1000, 600))
    item_center = rt.item.sceneBoundingRect().center()
    assert (item_center.x(), item_center.y()) == pytest.approx((1000, 600), abs=1e-6)


def test_markers_are_an_entity_part_and_hide_and_go_with_it(editor) -> None:
    from tools.editor.editors.scene_canvas_model import parts_of

    ed, model, _root = editor
    assert "burn" in parts_of("hotspot") and "burn" in parts_of("npc")
    canvas = ed._canvas
    canvas.set_entity_visible("hotspot", "hs_paper", False)
    assert not any(it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id == "hs_paper")
    canvas.set_entity_visible("npc", "npc_torch", False)
    assert not any(it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id == "npc_torch")
    # 藏着的时候精灵画一拍（巡逻 / 拖动）标记也不许冒出来
    ed._scene_npc_runtimes["npc_torch"].draw_at(900.0, 500.0)
    assert not any(it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id == "npc_torch")
    canvas.set_entity_visible("hotspot", "hs_paper", True)
    canvas.set_entity_visible("npc", "npc_torch", True)
    assert all(it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id in ("hs_paper", "npc_torch"))
    # 真视图过滤：热点只在「夜」出现、场景开了日夜、画布切到别的时段 → 重摆热点后它和它的着火点一起藏着
    hs = dict(_hs(model, "hs_paper"))
    hs["phases"] = ["夜"]
    canvas._record_entity_view("hotspot:hs_paper", hs)
    canvas.set_day_night_enabled(True)
    canvas.set_phase_filter("白日")
    canvas.refresh_hotspot_visuals(hs)
    handle_visible = canvas.entity_item_by_key("hotspot:hs_paper").isVisible()
    assert handle_visible is False
    assert [it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id == "hs_paper"] == [False, False], \
        "着火点与热点圆点的显隐不一致（藏了一半）"
    assert canvas.entity_item_by_key("hotspot_display:hs_paper").isVisible() is False
    canvas.set_phase_filter(None)
    assert all(it.isVisible() for it in canvas.burn_marker_items() if it.entity_ref_id in ("hs_paper", "npc_torch"))
    canvas.remove_hotspot_graphics("hs_paper")
    canvas.remove_npc_graphics("npc_torch")
    assert not any(it.entity_ref_id in ("hs_paper", "npc_torch") for it in canvas.burn_marker_items())


def test_template_change_on_disk_redraws_canvas_and_inspector(editor) -> None:
    ed, model, root = editor
    ed._on_item_selected("hotspot", "hs_paper")
    sec = ed._props._hs_burnable
    assert "50×25 cm" in sec.summary_label.text()
    doc = copy.deepcopy(PAPER)
    doc["widthCm"] = 100
    doc["ignitionPoints"] = [{"id": "edge", "u": 0, "v": 1}]
    _dump(bn.burnables_dir(root) / "paper_pile.json", doc)
    assert model.reload_burn_from_disk() is True
    for _ in range(3):
        QApplication.processEvents()
    r = ed._canvas.entity_item_by_key("hotspot_display:hs_paper").sceneBoundingRect()
    assert r.width() == pytest.approx(100 * WU), "模板改了尺寸：画布立刻按新尺寸重画"
    ms = _markers(ed)
    assert ("hotspot", "hs_paper", "edge") in ms and ("hotspot", "hs_paper", "p1") not in ms
    assert ("npc", "npc_torch", "edge") in ms
    assert ed._scene_npc_runtimes["npc_torch"].world_w == pytest.approx(100 * WU)
    assert "100×25 cm" in sec.summary_label.text() and "着火点 1 个（edge）" in sec.summary_label.text()
    assert model.is_dirty is False, "模板重读不改场景数据"


# --------------------------------------------------------------------------- #
# 属性面板「可燃」块
# --------------------------------------------------------------------------- #

def test_hotspot_block_loads_existing_config_and_roundtrips_untouched(editor) -> None:
    ed, model, _root = editor
    before = copy.deepcopy(model.scenes["sc_a"])
    ed._on_item_selected("hotspot", "hs_candle")
    sec: BurnableHostSection = ed._props._hs_burnable
    assert sec.is_built() and sec.section.is_expanded(), "有配置的实体：块自动展开"
    assert sec.enable_box.isChecked() and sec.template_selector.current_id() == "candle_red"
    assert sec.initial_combo.currentData() == "burning"
    assert sec.player_ignite_box is not None and not sec.player_ignite_box.isChecked()
    assert "可燃：candle_red" in sec.section._plain_title
    assert "展示图" in sec.takeover_label.text() and "不画" in sec.takeover_label.text()
    ed._on_item_selected("hotspot", "hs_paper")
    assert "old.png" in sec.warn_label.text() and "不是同一张" in sec.warn_label.text(), "展示图与模板图不同要显眼提示"
    ed._on_item_selected("hotspot", "hs_ghost")
    assert "不在 assets/data/burnables/" in sec.warn_label.text() and "缺失" in sec.template_selector.currentText(),         "未知模板保值展示"
    ed._on_item_selected("hotspot", "hs_plain")
    assert not sec.enable_box.isChecked() and sec.section._plain_title == "可燃（没开）"
    ed._commit_pending_scene_edits()
    assert model.scenes["sc_a"] == before, "只看不改：数据一个字节都不许变"
    assert model.is_dirty is False


def test_turn_on_configure_and_commit_writes_minimal_ordered_block(editor, monkeypatch) -> None:
    ed, model, _root = editor
    ed._on_item_selected("hotspot", "hs_plain")
    props = ed._props
    sec: BurnableHostSection = props._hs_burnable
    sec.section.set_expanded(True)
    sec.enable_box.setChecked(True)
    assert sec.template_selector.current_id() == "candle_red", "没有与展示图同一张的模板：挑第一份"
    assert props._pending_hotspot["burnable"] == {"template": "candle_red"}, "开 = 立刻写 {template}（画布要读它）"
    for _ in range(2):
        QApplication.processEvents()
    assert ed._canvas.entity_item_by_key("hotspot_display:hs_plain").pixmap().width() == 16, "画布立刻换成模板图"

    sec.template_selector.set_current("paper_pile")
    sec.template_selector.value_changed.emit("paper_pile")
    sec.initial_combo.setCurrentIndex(sec.initial_combo.findData("burning"))
    sec.player_ignite_box.setChecked(False)
    picker = sec.signal_fields["burntOut"]
    picker._value = "纸烧完了"
    picker.valueChanged.emit("纸烧完了")
    sec.conditions.set_data([{"flag": "f_can_burn", "op": "==", "value": True}])
    sec.conditions.changed.emit()
    ed._commit_pending_scene_edits()
    hs = _hs(model, "hs_plain")
    assert list(hs)[-1] == "burnable", "新块追加在实体既有键之后"
    assert hs["burnable"] == {"template": "paper_pile", "initial": "burning", "playerIgnite": False,
                              "igniteConditions": [{"flag": "f_can_burn", "op": "==", "value": True}],
                              "signals": {"burntOut": "纸烧完了"}}
    assert list(hs["burnable"]) == list(bn.HOST_ORDER), "键序按 HOST_ORDER"
    assert hs["x"] == 100 and isinstance(hs["x"], int), "数值不漂"
    assert model.is_dirty

    # 改回缺省 = 删键（不写 initial: unburnt / playerIgnite: true）
    ed._on_item_selected("hotspot", "hs_plain")
    sec.initial_combo.setCurrentIndex(sec.initial_combo.findData("unburnt"))
    sec.player_ignite_box.setChecked(True)
    sec._clear_signal("burntOut")
    sec.conditions.set_data([])
    sec.conditions.changed.emit()
    ed._commit_pending_scene_edits()
    assert _hs(model, "hs_plain")["burnable"] == {"template": "paper_pile"}

    # 关掉：块里只剩 template → 不问、直接删整块
    asked: list[str] = []
    monkeypatch.setattr(sec, "_confirm_disable", lambda text: asked.append(text) or True)
    ed._on_item_selected("hotspot", "hs_plain")
    sec.enable_box.setChecked(False)
    ed._commit_pending_scene_edits()
    assert "burnable" not in _hs(model, "hs_plain") and asked == []


def test_turning_off_a_configured_block_asks_first(editor, monkeypatch) -> None:
    ed, model, _root = editor
    ed._on_item_selected("hotspot", "hs_candle")
    sec: BurnableHostSection = ed._props._hs_burnable
    answers = [False, True]
    asked: list[str] = []

    def _confirm(text: str) -> bool:
        asked.append(text)
        return answers.pop(0)

    monkeypatch.setattr(sec, "_confirm_disable", _confirm)
    sec.enable_box.setChecked(False)
    assert sec.enable_box.isChecked(), "拒绝确认：开关弹回去"
    ed._commit_pending_scene_edits()
    assert _hs(model, "hs_candle")["burnable"]["initial"] == "burning"
    sec.enable_box.setChecked(False)
    assert len(asked) == 2 and "candle_red" in asked[0]
    ed._commit_pending_scene_edits()
    hs = _hs(model, "hs_candle")
    assert "burnable" not in hs and hs["displayImage"]["facing"] == "left", "关掉只删 burnable，其它键原样"


def test_npc_block_warns_that_animation_is_taken_over_and_sprite_follows_toggle(editor, monkeypatch) -> None:
    ed, model, _root = editor
    ed._on_item_selected("npc", "npc_torch")
    sec: BurnableHostSection = ed._props._npc_burnable
    assert sec.enable_box.isChecked()
    assert "animFile" in sec.warn_label.text() and "不再播" in sec.warn_label.text(), "NPC 有动画：显眼提示动画不画了"
    assert "playerIgnite" not in (sec.value() or {})
    monkeypatch.setattr(sec, "_confirm_disable", lambda _t: True)
    sec.enable_box.setChecked(False)
    for _ in range(2):
        QApplication.processEvents()
    assert "npc_torch" not in ed._scene_npc_runtimes, "关了可燃：回到 NPC 自己的动画（这里动画包不存在，所以没精灵）"
    assert not any(it.entity_ref_id == "npc_torch" for it in ed._canvas.burn_marker_items())
    sec.enable_box.setChecked(True)
    for _ in range(2):
        QApplication.processEvents()
    assert "npc_torch" in ed._scene_npc_runtimes
    ed._commit_pending_scene_edits()
    assert _npc(model, "npc_torch")["burnable"] == {"template": "paper_pile"}


def test_open_workbench_button_passes_the_template(editor, monkeypatch) -> None:
    ed, model, _root = editor
    props = ed._props
    opened: list[str] = []
    monkeypatch.setattr(props, "window",
                        lambda: type("W", (), {"open_burn_workbench": lambda _s, bid="": opened.append(bid)})())
    ed._on_item_selected("hotspot", "hs_paper")
    props._hs_burnable.open_btn.click()
    ed._on_item_selected("hotspot", "hs_plain")
    props._hs_burnable.section.set_expanded(True)
    props._hs_burnable.open_btn.click()
    assert opened == ["paper_pile", ""]
    assert model.is_dirty is False


def test_host_section_is_lazy_and_passes_unknown_shapes_through(app) -> None:
    model = ProjectModel()
    sec = BurnableHostSection(model, "hotspot")
    try:
        ent = {"id": "x", "burnable": {"template": "t", "zzz": 1, "initial": "weird"}}
        other = {"id": "y"}
        sec.load(other)
        assert not sec.is_built(), "没配置的实体不建控件（懒建）"
        out = dict(other)
        sec.write_to(out)
        assert out == {"id": "y"}
        sec.load(ent)
        assert sec.is_built()
        out = copy.deepcopy(ent)
        sec.write_to(out)
        assert out == ent, "没动过：未知键 / 未知值原样透传"
        # 动了别的项：未知键保住，未知的 initial 保值（下拉里那一行没被换掉）
        sec.player_ignite_box.setChecked(False)
        out = copy.deepcopy(ent)
        sec.write_to(out)
        assert out["burnable"] == {"template": "t", "initial": "weird", "playerIgnite": False, "zzz": 1}
    finally:
        sec.deleteLater()
        QApplication.processEvents()
        destroy_leftover_qt_widgets()


def test_toggle_is_one_undoable_command_and_canvas_follows_undo(editor) -> None:
    ed, model, _root = editor
    ed._on_item_selected("hotspot", "hs_plain")
    sec: BurnableHostSection = ed._props._hs_burnable
    sec.section.set_expanded(True)
    sec.enable_box.setChecked(True)
    assert ed._undo_flush_pending_as_command() is not False
    assert _hs(model, "hs_plain")["burnable"] == {"template": "candle_red"}
    for _ in range(2):
        QApplication.processEvents()
    assert ed._canvas.entity_item_by_key("hotspot_display:hs_plain").pixmap().width() == 16
    ed.editor_undo()
    for _ in range(3):
        QApplication.processEvents()
    assert "burnable" not in _hs(model, "hs_plain"), "Ctrl+Z 撤掉开可燃"
    assert ed._canvas.entity_item_by_key("hotspot_display:hs_plain").pixmap().width() == 20, "画布回到自己的展示图"
    assert not any(it.entity_ref_id == "hs_plain" for it in ed._canvas.burn_marker_items())
    ed.editor_redo()
    for _ in range(3):
        QApplication.processEvents()
    assert _hs(model, "hs_plain")["burnable"] == {"template": "candle_red"}
