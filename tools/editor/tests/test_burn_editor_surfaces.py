"""燃烧系统（A3.8，2026-09-16「可燃物模板 + 宿主身上 burnable 块」）接进主编辑器 / 校验器 / 各登记面的契约。

模型：可燃物模板 `assets/data/burnables/<id>.json`（唯一写入者燃烧工作台，和场景无关）；谁可燃写在宿主自己身上——
热点 / NPC（场景 JSON）、挂件预设、轨迹 spawn 规格的 `burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?}`，
粒子薄片 `plate.burnable: {template}`。旧布置库 `burn_placements.json` 已删除，任何面都不许再读它。

动作 `igniteBurnable {target, socket?, point?}` / `extinguishBurnable {target, socket?}` / `resetBurnable {target, socket?}`、
条件叶 `{burn, burnSocket?, burnScene?, burnState}`：socket 没写 = 场景里的可燃实体；写了 = 拿东西的人手上那件。

本文件钉：
1. 登记面（action 授权面 / TS manifest / 运行时注册参数 / 持久化档 / 过场白名单 / 实体引用 kind / json_lang）；
2. ProjectModel 候选（含演出生成且留下的可燃对象），且**候选面 = 校验面**（动作表单 / 条件树 / 校验器同一组函数）；
3. 校验器：模板闸门、宿主块（场景实体 / 挂件预设互斥 / spawn / 粒子薄片）、条件叶与动作、「给开了可燃的实体换图 / 换动画」；
4. 动作表单往返（最小 / 填满 / 悬垂 / 清空去键）、三个选择器互相刷新、spawn 规格「可燃」块往返保真；
5. 条件叶全部面（条件树往返、形状兜底、人话摘要）；
6. 信号实发源（宿主 burnable.signals）与信号关系、实体改名跟随、主窗口入口。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import burnables as bn  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    _OMIT_WHEN_ABSENT_AND_DEFAULT,
    _PARAM_SCHEMAS,
    ActionEditor,
    ActionRow,
    BurnableHostBlock,
    FilterableTypeCombo,
)
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

ACTS = ("igniteBurnable", "extinguishBurnable", "resetBurnable")
PAPER_IMG = "/resources/runtime/images/burn/paper.png"
CANDLE_IMG = "/resources/runtime/images/burn/candle.png"
INCENSE_IMG = "/resources/runtime/images/burn/incense.png"
OTHER_IMG = "/resources/runtime/images/burn/other.png"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _dump(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _templates() -> dict:
    return {
        "paper_pile": {"id": "paper_pile", "label": "纸钱堆", "image": PAPER_IMG, "widthCm": 40, "heightCm": 20,
                       "mode": "spread",
                       "ignitionPoints": [{"id": "p1", "u": 0.5, "v": 0.9}, {"id": "p2", "u": 0.1, "v": 0.2}]},
        "candle_red": {"id": "candle_red", "image": CANDLE_IMG, "widthCm": 3, "heightCm": 12, "mode": "consume"},
        "incense": {"id": "incense", "image": INCENSE_IMG, "widthCm": 1, "heightCm": 30, "mode": "consume",
                    "ignitionPoints": [{"id": "tip", "u": 0.5, "v": 0.0}]},
    }


def _traj(spawn: dict) -> dict:
    return {"type": "playTrajectory", "params": {"trajectoryId": "tr_x", "spawn": spawn}}


def _make_project(root: Path, *, templates: dict | None = None, scene_a_extra: dict | None = None,
                  prop_presets: dict | None = None, cutscene_steps: list | None = None) -> Path:
    write_minimal_loadable_project(root)
    sp = root / "public" / "assets" / "scenes"
    sc_a = json.loads((sp / "sc_a.json").read_text(encoding="utf-8"))
    sc_a["hotspots"] = [
        {"id": "hs_paper", "type": "inspect", "label": "纸钱", "x": 100, "y": 200, "data": {},
         "displayImage": {"image": PAPER_IMG, "worldWidth": 35.2, "worldHeight": 17.6},
         "burnable": {"template": "paper_pile", "signals": {"ignited": "纸钱烧起来了"}}},
        {"id": "hs_candle", "type": "inspect", "x": 150, "y": 200, "data": {},
         "burnable": {"template": "candle_red", "initial": "burning", "playerIgnite": False}},
        {"id": "hs_plain", "type": "inspect", "x": 10, "y": 20, "data": {"text": "看"}},
    ]
    sc_a["npcs"] = [
        {"id": "npc_straw", "name": "草人", "x": 300, "y": 300, "animFile": "/x/anim.json",
         "burnable": {"template": "paper_pile"}},
        {"id": "npc_guard", "name": "守卫", "x": 320, "y": 300},
        {"id": "npc_twin", "name": "双生", "x": 340, "y": 300, "burnable": {"template": "paper_pile"}},
    ]
    sc_a.update(scene_a_extra or {})
    _dump(sp / "sc_a.json", sc_a)
    sc_b = json.loads((sp / "sc_b.json").read_text(encoding="utf-8"))
    sc_b["hotspots"] = [{"id": "hs_lamp", "type": "inspect", "x": 1, "y": 2, "data": {},
                         "burnable": {"template": "candle_red"}}]
    sc_b["npcs"] = [{"id": "npc_twin", "name": "双生", "x": 1, "y": 1}]
    _dump(sp / "sc_b.json", sc_b)
    for rel in (PAPER_IMG, CANDLE_IMG, INCENSE_IMG, OTHER_IMG):
        disk = root / "public" / rel.lstrip("/")
        disk.parent.mkdir(parents=True, exist_ok=True)
        disk.write_bytes(b"\x89PNG\r\n\x1a\n")
    for tid, doc in (templates if templates is not None else _templates()).items():
        _dump(bn.burnables_dir(root) / f"{tid}.json", doc)
    data = root / "public" / "assets" / "data"
    _dump(data / "prop_presets.json", prop_presets if prop_presets is not None else {
        "incense_prop": {"label": "线香", "burnable": {"template": "incense", "signals": {"burntOut": "香烧完了"}}},
        "torch": {"image": OTHER_IMG},
    })
    steps = cutscene_steps if cutscene_steps is not None else [
        {"kind": "action", **_traj({"kind": "image", "id": "sp_paper", "keep": True,
                                    "burnable": {"template": "paper_pile", "signals": {"burntOut": "纸人烧完"}}})},
        {"kind": "action", **_traj({"kind": "image", "id": "sp_fly", "burnable": {"template": "paper_pile"}})},
        {"kind": "action", **_traj({"kind": "image", "id": "sp_plain", "src": OTHER_IMG, "keep": True})},
    ]
    _dump(data / "cutscenes" / "index.json", [{"id": "cut_ok", "steps": steps}])
    return root


def _model(root: Path) -> ProjectModel:
    m = ProjectModel()
    m.load_project(root)
    return m


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    return _make_project(tmp_path / "p")


@pytest.fixture()
def model(project: Path, app) -> ProjectModel:
    return _model(project)


def _ids(rows) -> list[str]:
    return [r[0] for r in rows]


# --------------------------------------------------------------------------- #
# 1. 登记面
# --------------------------------------------------------------------------- #

def test_actions_registered_on_every_editor_surface() -> None:
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    man = (_ROOT / "src/core/actionParamManifest.ts").read_text("utf-8")
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    want = {"igniteBurnable": ["target", "socket", "point"],
            "extinguishBurnable": ["target", "socket"], "resetBurnable": ["target", "socket"]}
    for act in ACTS:
        assert act in ACTION_TYPES and act in CONTENT_ACTION_TYPES, f"{act} 编辑器下拉里选不到"
        m = re.search(rf"executor\.register\('{act}',.*?\}}, \[([^\]]*)\]\);", reg, re.S)
        assert m, f"{act} 运行时没注册"
        assert [x.strip().strip("'") for x in m.group(1).split(",")] == want[act], "运行时参数表与编辑器 schema 对不上"
        line = re.search(rf"^  {act}: \{{(.*)\}},$", man, re.M)
        assert line and "required: ['target']" in line.group(1) and "'socket'" in line.group(1), line
        assert ACTION_PERSISTENCE.get(act) == "save"
        assert act not in allow, f"{act} 改存档，不能进过场白名单"
        assert [n for n, _k in _PARAM_SCHEMAS[act]] == want[act]


def test_optional_params_are_scoped_omitted_not_global() -> None:
    """point / socket 缺键 = 缺省；控件中性值是空串。进作用域表（socket 在挂件动作里是必填、point 在 playPropVfx 是另一个形状）。"""
    assert _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT.get(("igniteBurnable", "point")) == ""
    for act in ACTS:
        assert _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT.get((act, "socket")) == ""
    assert "point" not in _OMIT_WHEN_ABSENT_AND_DEFAULT and "socket" not in _OMIT_WHEN_ABSENT_AND_DEFAULT


def test_entity_ref_kind_and_json_lang_registries() -> None:
    from tools.editor.shared.entity_refactor import _BARE_KIND_SCOPE, ENTITY_REF_PARAMS
    from tools.json_lang.extract import _KNOWN_REF_KINDS, _MODELED_LEAVES, extract_language_spec
    from tools.json_lang.schema_build import REF_KIND_UNIVERSE

    for act in ACTS:
        assert ENTITY_REF_PARAMS.get(act) == {"target": "burn_target"}
    assert _BARE_KIND_SCOPE["burn_target"] == ("npc", "hotspot"), "可燃实体是热点或 NPC；拿东西的人是 NPC"
    assert "hotspot" not in _BARE_KIND_SCOPE, "只认热点的旧 kind 已作废"
    assert REF_KIND_UNIVERSE["burn_target"] == "emote_subjects" and "hotspot" not in REF_KIND_UNIVERSE
    assert "burn_target" in _KNOWN_REF_KINDS and "hotspot" not in _KNOWN_REF_KINDS
    assert "burn" in _MODELED_LEAVES
    spec = extract_language_spec(_ROOT)
    assert "burn" in spec.condition_leaves
    noisy = [w for w in spec.warnings if "burn" in w.lower() or "hotspot" in w]
    assert noisy == [], f"json_lang tripwire 还在响：{noisy}"


def test_json_lang_schema_models_the_burn_leaf() -> None:
    from tools.json_lang.extract import extract_language_spec
    from tools.json_lang.id_universes import collect_id_universes
    from tools.json_lang.schema_build import build_schema

    schema = build_schema(extract_language_spec(_ROOT), collect_id_universes(_ROOT))
    branches = schema["definitions"]["conditionExpr"]["anyOf"]
    burn = [b for b in branches if b.get("required") == ["burn", "burnState"]]
    assert len(burn) == 1
    props = burn[0]["properties"]
    assert props["burnState"] == {"enum": ["unburnt", "burning", "out", "burnt"]}
    assert props["burnSocket"] == {"type": "string"}
    assert not [b for b in branches if b.get("required") == ["burn"]], "burn 叶还落在未建模兜底里"


def test_condition_leaf_shape_matches_runtime_types() -> None:
    types_ts = (_ROOT / "src/data/types.ts").read_text("utf-8")
    body = types_ts[types_ts.index("export interface BurnConditionLeaf"):]
    body = body[:body.index("}")]
    assert "burnSocket?: string;" in body and "burnScene?: string;" in body
    assert "burnState: 'unburnt' | 'burning' | 'out' | 'burnt';" in body
    assert bn.BURN_STATES == ("unburnt", "burning", "out", "burnt")


def test_no_surface_reads_the_deleted_placement_library() -> None:
    files = [
        "tools/editor/validator.py", "tools/editor/shared/action_editor.py", "tools/editor/shared/action_structure.py",
        "tools/editor/shared/condition_expr_tree.py", "tools/editor/shared/narrative_catalog.py",
        "tools/editor/shared/entity_refactor.py", "tools/editor/main_window.py",
        "tools/editor/editors/narrative_state_editor.py", "tools/narrative_xref/scan.py", "tools/narrative_xref/sources.py",
        "tools/json_lang/schema_build.py", "tools/json_lang/extract.py",
        "tools/dialogue_graph_editor/dialogue_condition_text.py", "src/core/narrativeGraphValidation.ts",
    ]
    for rel in files:
        text = (_ROOT / rel).read_text("utf-8")
        for needle in ("burn_placements", "burnable_hotspot_ids", "burn_placement_for", "iter_placements",
                       "signals_emitted", "load_library as _load_burn"):
            assert needle not in text, f"{rel} 还在读旧布置库：{needle}"


# --------------------------------------------------------------------------- #
# 2. 模型候选
# --------------------------------------------------------------------------- #

def test_model_mirror_is_read_only_and_reload_reports_changes(project: Path, model: ProjectModel) -> None:
    assert set(model.burnables) == {"paper_pile", "candle_red", "incense"}
    assert not hasattr(model, "burn_placements")
    assert "burn" not in ProjectModel.KNOWN_DIRTY_BUCKETS and "burnables" not in ProjectModel.KNOWN_DIRTY_BUCKETS
    src = (_ROOT / "tools/editor/project_model.py").read_text("utf-8")
    for fn_name in ("def save_all", "def _planned_write_paths"):
        start = src.index(fn_name)
        end = src.find("\n    def ", start + 1)
        assert "burnables" not in src[start:end], f"{fn_name} 碰了可燃物模板（唯一写入者是燃烧工作台）"
    seen: list[tuple[str, str]] = []
    model.data_changed.connect(lambda k, i: seen.append((k, i)))
    assert model.reload_burn_from_disk() is False
    _dump(bn.burnables_dir(project) / "zz_new.json", {"id": "zz_new", "image": PAPER_IMG, "widthCm": 1, "heightCm": 1})
    assert model.reload_burn_from_disk() is True
    assert seen == [("burn", "")] and "zz_new" in model.burnables


def test_missing_template_dir_is_silent(tmp_path: Path, app) -> None:
    root = tmp_path / "empty"
    write_minimal_loadable_project(root)
    m = _model(root)
    assert m.burnables == {} and m.burn_target_ids(None) == [] and m.burnable_spawn_specs() == []
    from tools.editor.validator import validate
    assert [i for i in validate(m) if "可燃" in i.message or i.data_type == "burnable"] == []


def test_candidates(model: ProjectModel) -> None:
    assert _ids(model.burn_target_ids("sc_a")) == ["hs_paper", "hs_candle", "npc_straw", "npc_twin", "sp_paper"]
    assert _ids(model.burn_target_ids("sc_b")) == ["hs_lamp", "sp_paper"]
    assert set(_ids(model.burn_target_ids(None))) == {"hs_paper", "hs_candle", "hs_lamp", "npc_straw", "npc_twin",
                                                      "sp_paper"}
    assert "sp_fly" not in _ids(model.burn_target_ids(None)), "没勾「播完留下」的生成对象不是场景实体"
    assert "paper_pile" in dict(model.burn_target_ids("sc_a"))["hs_paper"], "label 要带模板 id"
    assert _ids(model.burn_target_ids("sc_a", "left_hand")) == ["player", "npc_straw", "npc_guard", "npc_twin"]
    assert _ids(model.burn_target_ids(None, "left_hand")) == ["player", "npc_guard", "npc_straw", "npc_twin"]
    assert _ids(model.burn_point_ids("sc_a", "hs_paper")) == ["p1", "p2"]
    assert model.burn_point_ids("sc_a", "hs_candle") == []
    assert _ids(model.burn_point_ids(None, "sp_paper")) == ["p1", "p2"], "演出生成对象的着火点取它的模板"
    assert _ids(model.burn_point_ids("sc_a", "player", "left_hand")) == ["tip"], "手上的 = 开了可燃的挂件预设的模板"
    assert _ids(model.burn_scene_ids()) == ["sc_a", "sc_b"]
    assert _ids(model.burnable_prop_ids()) == ["incense_prop"]
    assert model.burn_socket_names(None, "hs_paper") == model.burn_socket_names(None, "player"), \
        "还没选人（或选的是场景实体）时退到玩家的挂点"


def test_spawn_table_scans_every_action_source_and_follows_edits(project: Path, model: ProjectModel) -> None:
    _dump(project / "public" / "assets" / "dialogues" / "graphs" / "g_burn.json", {
        "id": "g_burn", "entry": "n1",
        "nodes": {"n1": {"type": "runActions", "actions": [{"type": "runActionsIf", "params": {
            "condition": {"flag": "f"},
            "actions": [_traj({"kind": "character", "id": "sp_dlg", "keep": True, "burnable": {"template": "incense"}})],
        }}]}},
    })
    model._burnable_spawn_cache = None
    assert "sp_dlg" in _ids(model.burnable_spawn_ids()), "对话图里嵌在 runActionsIf 里的生成规格也要算"
    model.quests.append({"id": "q1", "onComplete": [_traj({"kind": "image", "id": "sp_q", "keep": True,
                                                          "burnable": {"template": "paper_pile"}})]})
    assert "sp_q" not in _ids(model.burnable_spawn_ids()), "没标脏前走缓存"
    model.mark_dirty("quest")
    assert "sp_q" in _ids(model.burnable_spawn_ids()), "标脏后缓存作废"


# --------------------------------------------------------------------------- #
# 3. 校验器
# --------------------------------------------------------------------------- #

def _validate(model: ProjectModel) -> list[tuple[str, str, str, str]]:
    from tools.editor.validator import validate

    return [(i.severity, i.data_type, i.item_id, i.message) for i in validate(model)]


def _has(rows, sev: str, text: str, item: str | None = None) -> bool:
    return any(s == sev and text in m and (item is None or it == item) for s, _dt, it, m in rows)


def test_clean_project_has_no_burn_errors(model: ProjectModel) -> None:
    rows = [r for r in _validate(model) if "可燃" in r[3] or r[1] == "burnable"]
    assert [r for r in rows if r[0] == "error"] == []
    assert all("信号" in r[3] for r in rows), rows


def test_template_gate_errors(tmp_path: Path, app) -> None:
    tpl = _templates()
    tpl["paper_pile"] = {**tpl["paper_pile"], "ignitionPoints": [{"id": "p1", "u": 0.5, "v": 0.5},
                                                                  {"id": "p1", "u": 0.1, "v": 0.1}]}
    del tpl["candle_red"]["widthCm"]
    tpl["no_image"] = {"id": "no_image", "image": "/resources/runtime/images/burn/missing.png", "widthCm": 1, "heightCm": 1}
    tpl["bad_grip"] = {"id": "bad_grip", "image": PAPER_IMG, "widthCm": 1, "heightCm": 1, "grip": {"u": 2, "v": 0}}
    root = _make_project(tmp_path / "p", templates=tpl)
    (bn.burnables_dir(root) / "broken.json").write_text("{ nope", encoding="utf-8")
    rows = _validate(_model(root))
    assert _has(rows, "error", "着火点 id 重复", "paper_pile")
    assert _has(rows, "error", "widthCm 必填", "candle_red")
    assert _has(rows, "error", "图片文件不存在", "no_image")
    assert _has(rows, "error", "grip", "bad_grip")
    assert _has(rows, "error", "读不懂", "broken")


def test_scene_and_prop_host_errors(tmp_path: Path, app) -> None:
    root = _make_project(tmp_path / "p", scene_a_extra={"hotspots": [
        {"id": "hs_ghost_tpl", "type": "inspect", "x": 1, "y": 1, "data": {}, "burnable": {"template": "zz_missing"}},
        {"id": "hs_bad_shape", "type": "inspect", "x": 1, "y": 1, "data": {}, "burnable": {"template": "paper_pile",
                                                                                        "initial": "later"}},
        {"id": "hs_other_img", "type": "inspect", "x": 1, "y": 1, "data": {},
         "displayImage": {"image": OTHER_IMG, "worldWidth": 5, "worldHeight": 5, "facing": "left"},
         "burnable": {"template": "paper_pile", "signals": {"extinguished": "state:x:y"},
                      "igniteConditions": [{"burn": "hs_lamp", "burnState": "burning"}]}},
        {"id": "hs_null", "type": "inspect", "x": 1, "y": 1, "data": {}, "burnable": None},
    ]}, prop_presets={
        "incense_prop": {"burnable": {"template": "incense", "playerIgnite": False},
                         "light": {"intensity": 1}, "states": {"lit": {}}, "image": OTHER_IMG, "scale": 2},
    })
    rows = _validate(_model(root))
    assert _has(rows, "error", "zz_missing", "sc_a")
    assert _has(rows, "error", "initial", "sc_a"), "形状闸门（normalize_burnable_host）的拒绝要报出来"
    assert _has(rows, "error", "burnable 必须是对象", "sc_a")
    assert _has(rows, "warning", "这张图不画", "sc_a"), "有展示图且与模板图不同 = 警告"
    assert _has(rows, "error", "保留信号", "sc_a")
    assert any(s == "warning" and "能点的条件" in m and "hs_lamp" in m and "sc_a" in m for s, _d, _i, m in rows), \
        "能点的条件按宿主所在场景解析 burn 叶"
    assert _has(rows, "error", "与 light 互斥", "incense_prop")
    assert _has(rows, "error", "与 states 互斥", "incense_prop")
    assert _has(rows, "warning", "image 被模板接管", "incense_prop")
    assert not _has(rows, "warning", "scale 被模板接管", "incense_prop"), "scale 照用，不许报"
    assert not _has(rows, "error", "与 scale 互斥", "incense_prop")
    assert _has(rows, "warning", "playerIgnite 运行时不读", "incense_prop")


def test_spawn_host_is_validated_through_the_action_walker(tmp_path: Path, app) -> None:
    root = _make_project(tmp_path / "p", scene_a_extra={"onEnter": [{"type": "runActions", "params": {"actions": [
        {"type": "runActionsIf", "params": {"condition": {"flag": "f"}, "actions": [
            _traj({"kind": "character", "id": "sp_bad", "burnable": {"template": "zz_nope"}}),
        ]}},
    ]}}]}, cutscene_steps=[
        {"kind": "action", **_traj({"kind": "image", "id": "sp_ok", "keep": True, "burnable": {"template": "paper_pile"}})},
        {"kind": "action", **_traj({"kind": "image", "id": "sp_src", "src": OTHER_IMG,
                                    "burnable": {"template": "paper_pile"}})},
        {"kind": "action", **_traj({"kind": "image", "burnable": {"template": "paper_pile",
                                                                 "signals": {"ignited": "sig_anon"}}})},
    ])
    rows = _validate(_model(root))
    assert not _has(rows, "error", "缺少 src"), "开了可燃的生成对象 src 不必填"
    assert not _has(rows, "error", "缺少 characterId")
    assert _has(rows, "error", "zz_nope", "sc_a"), "嵌套在 runActions / runActionsIf 里的也要走到"
    assert _has(rows, "warning", "这张图不画")
    assert _has(rows, "warning", "没写 id")


def test_vfx_plate_binding() -> None:
    from tools.editor import validator

    def emitter(plate_extra: dict) -> dict:
        return {"id": "e", "appearance": {"image": "/x.png", "sizeWu": 3}, "spawn": {"max": 5},
                "plate": {"size": [4, 2], "terminalSpeed": 90, **plate_extra}}

    effects = {
        "ok": {"id": "ok", "emitters": [emitter({"burnable": {"template": "paper_pile"}})]},
        "consume": {"id": "consume", "emitters": [emitter({"burnable": {"template": "candle_red"}})]},
        "missing": {"id": "missing", "emitters": [emitter({"burnable": {"template": "zz"}})]},
        "shape": {"id": "shape", "emitters": [emitter({"burnable": "paper_pile"})]},
        "legacy": {"id": "legacy", "emitters": [emitter({"flammable": {"burnSeconds": 1}})]},
    }
    out: list = []
    validator._validate_vfx_effects(SimpleNamespace(
        vfx_effects=effects, project_path=None, load_anomalies=[], burnables=_templates(), burnables_errors={}), out)
    by: dict = {}
    for i in out:
        by.setdefault(i.item_id, []).append((i.severity, i.message))
    assert not [m for s, m in by.get("ok", []) if "burnable" in m or "可燃" in m]
    assert any(s == "error" and "只能绑面燃烧" in m for s, m in by["consume"])
    assert any(s == "error" and "zz" in m for s, m in by["missing"])
    assert any(s == "error" and "plate.burnable" in m for s, m in by["shape"])
    assert any(s == "warning" and "plate.flammable" in m for s, m in by["legacy"])


def _action_issues(model, act: dict, scene: str | None) -> list[tuple[str, str]]:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "t", "i", scene)
    return [(i.severity, i.message) for i in out]


@pytest.mark.parametrize("scene", [None, "sc_a", "sc_b"])
@pytest.mark.parametrize("socket", ["", "left_hand"])
def test_action_candidates_equal_validator(model: ProjectModel, app, scene, socket) -> None:
    """候选面 = 校验面：动作表单 target 下拉里的每一个都不报，下拉外的都报；point 同理。"""
    params = {"target": "hs_paper", **({"socket": socket} if socket else {})}
    row = ActionRow({"type": "igniteBurnable", "params": params}, model=model, scene_id=scene)
    try:
        tw = row._param_widgets["target"]
        assert isinstance(tw, IdRefSelector) and not tw.isEditable(), "引用字段只许选"
        cands = [i for i in tw._ids if i]
        want = _ids(model.burn_target_ids(scene, socket))
        assert set(want) <= set(cands) and set(cands) - set(want) <= {"hs_paper"}, "下拉候选 ≠ 模型候选（除保值行）"
        universe = {"hs_paper", "hs_candle", "hs_plain", "hs_lamp", "npc_straw", "npc_guard", "npc_twin",
                    "sp_paper", "sp_fly", "sp_plain", "player", "绝不存在"}
        for tid in universe:
            p = {"target": tid, **({"socket": socket} if socket else {})}
            issues = [x for x in _action_issues(model, {"type": "igniteBurnable", "params": p}, scene)
                      if "target" in x[1]]
            assert bool(issues) == (tid not in want), (scene, socket, tid, issues)
    finally:
        row.deleteLater()
    for tid in model.burn_target_ids(scene, socket):
        pts = model.burn_point_ids(scene, tid[0], socket)
        for pid in _ids(pts) + ["zz_point"]:
            p = {"target": tid[0], "point": pid, **({"socket": socket} if socket else {})}
            issues = [x for x in _action_issues(model, {"type": "igniteBurnable", "params": p}, scene) if "point" in x[1]]
            assert bool(issues) == (pid == "zz_point"), (scene, tid, pid, issues)


def test_action_issues(model: ProjectModel) -> None:
    for act in ACTS:
        assert _action_issues(model, {"type": act, "params": {}}, None)[0][0] == "error"
        assert _action_issues(model, {"type": act, "params": {"target": "npc_straw"}}, "sc_a") == []
        assert _action_issues(model, {"type": act, "params": {"target": "player", "socket": "left_hand"}}, "sc_a") == []
    w = _action_issues(model, {"type": "resetBurnable", "params": {"target": "hs_lamp"}}, "sc_a")
    assert w and w[0][0] == "warning", "有场景上下文：别的场景的可燃实体在这儿点不着"
    w = _action_issues(model, {"type": "resetBurnable", "params": {"target": "sp_fly"}}, None)
    assert w and "播完留在终点" in w[0][1], "开了可燃但不留下的生成对象要说清楚为什么"
    w = _action_issues(model, {"type": "igniteBurnable", "params": {"target": "hs_paper", "socket": "left_hand"}}, "sc_a")
    assert w and "拿着可燃挂件的人" in w[0][1]
    assert _action_issues(model, {"type": "igniteBurnable", "params": {"target": "hs_paper", "point": 3}}, "sc_a")[0][0] \
        == "error"
    assert _action_issues(model, {"type": "extinguishBurnable", "params": {"target": "player", "socket": 3}}, None)[0][0] \
        == "warning"
    w = _action_issues(model, {"type": "resetBurnable", "params": {"target": "hs_paper", "socket": ""}}, "sc_a")
    assert [x[0] for x in w] == ["warning"] and "空串" in w[0][1], "写了空挂点 = 当没写：只提醒，仍按场景实体查"


def _cond_issues(model, cond: dict, scene: str | None = None) -> list[tuple[str, str]]:
    from tools.editor.validator import _walk_conditions

    out: list = []
    _walk_conditions(model, out, [cond], "t", "i", scene)
    return [(i.severity, i.message) for i in out]


def test_condition_leaf_issues(model: ProjectModel) -> None:
    assert _cond_issues(model, {"burn": "hs_paper", "burnState": "burnt"}) == []
    assert _cond_issues(model, {"burn": "npc_straw", "burnState": "burning"}, "sc_a") == []
    assert _cond_issues(model, {"burn": "sp_paper", "burnScene": "sc_b", "burnState": "burnt"}) == []
    assert _cond_issues(model, {"burn": "hs_lamp", "burnScene": "sc_b", "burnState": "out"}) == []
    assert _cond_issues(model, {"burn": "hs_paper", "burnState": "ashes"})[0][0] == "error"
    assert _cond_issues(model, {"burn": "", "burnState": "burnt"})[0][0] == "error"
    assert _cond_issues(model, {"burn": "hs_paper", "burnScene": "sc_nope", "burnState": "burnt"})[0][0] == "error"
    assert _cond_issues(model, {"burn": "hs_paper", "burnScene": "sc_b", "burnState": "burnt"})[0][0] == "warning"
    assert _cond_issues(model, {"burn": "hs_plain", "burnState": "burnt"})[0][0] == "warning"
    assert _cond_issues(model, {"burn": "hs_lamp", "burnState": "burnt"}, "sc_a")[0][0] == "warning"
    # 写了 burnSocket：burn 是拿东西的人
    assert _cond_issues(model, {"burn": "player", "burnSocket": "left_hand", "burnState": "burning"}) == []
    assert _cond_issues(model, {"burn": "npc_guard", "burnSocket": "left_hand", "burnState": "burning"}) == []
    assert _cond_issues(model, {"burn": "hs_paper", "burnSocket": "left_hand", "burnState": "burning"})[0][0] == "warning"
    w = _cond_issues(model, {"burn": "player", "burnSocket": "left_hand", "burnScene": "sc_a", "burnState": "out"})
    assert w and "burnScene" in w[0][1] and "不读" in w[0][1]
    assert _cond_issues(model, {"burn": "player", "burnSocket": 7, "burnState": "out"})[0][0] == "warning"
    w = _cond_issues(model, {"burn": "hs_paper", "burnSocket": " ", "burnState": "out"})
    assert [x[0] for x in w] == ["warning"] and "空串" in w[0][1], "写了空挂点 = 当没写：只提醒，仍按场景实体查"
    assert not any("无法识别的条件叶子" in m for _s, m in _cond_issues(model, {"burn": "hs_paper", "burnState": "burnt"}))


def test_condition_tree_candidates_equal_validator(model: ProjectModel, app) -> None:
    from tools.editor.shared.condition_expr_tree import ConditionExprNodeEditor

    universe = {"hs_paper", "hs_candle", "hs_plain", "hs_lamp", "npc_straw", "npc_guard", "npc_twin", "sp_paper",
                "sp_fly", "player", "绝不存在"}
    for leaf in ({"burn": "hs_paper", "burnState": "burnt"},
                 {"burn": "hs_lamp", "burnScene": "sc_b", "burnState": "burnt"},
                 {"burn": "player", "burnSocket": "left_hand", "burnState": "burnt"}):
        n = ConditionExprNodeEditor(0, lambda: model)
        n.set_dict(copy.deepcopy(leaf))
        try:
            cands = {r[0] for r in n._burn_target_rows()}
            for eid in universe:
                probe = {**leaf, "burn": eid}
                bad = [x for x in _cond_issues(model, probe) if "burn" in x[1]]
                assert bool(bad) == (eid not in cands), (leaf, eid, bad)
        finally:
            n.deleteLater()


def test_render_override_on_burnable_entities_is_an_error(model: ProjectModel) -> None:
    def burn_msgs(act: dict, scene: str | None) -> list[tuple[str, str]]:
        return [x for x in _action_issues(model, act, scene) if "开了可燃" in x[1]]

    errors = [
        ({"type": "playNpcAnimation", "params": {"target": "npc_straw", "state": "walk"}}, "sc_a"),
        ({"type": "persistNpcAnimState", "params": {"target": "npc_straw", "state": "idle"}}, "sc_a"),
        ({"type": "persistPlayNpcAnimation", "params": {"target": "npc_straw", "state": "idle"}}, None),
        ({"type": "moveEntityTo", "params": {"target": "npc_straw", "x": 1, "y": 2, "moveAnimState": "walk"}}, "sc_a"),
        ({"type": "jumpEntityTo", "params": {"target": "npc_straw", "x": 1, "y": 2, "landAnimState": "idle"}}, "sc_a"),
        ({"type": "playTrajectory", "params": {"trajectoryId": "t", "target": "npc_straw", "animState": "roll"}}, "sc_a"),
        ({"type": "setEntityField", "params": {"sceneId": "sc_a", "entityKind": "npc", "entityId": "npc_straw",
                                               "fieldName": "animFile", "value": "/y/anim.json"}}, None),
        ({"type": "setEntityField", "params": {"sceneId": "sc_a", "entityKind": "hotspot", "entityId": "hs_paper",
                                               "fieldName": "displayImage",
                                               "value": {"image": OTHER_IMG, "worldWidth": 1, "worldHeight": 1}}}, None),
        ({"type": "setHotspotDisplayImage", "params": {"sceneId": "sc_a", "hotspotId": "hs_paper", "image": OTHER_IMG}},
         None),
        ({"type": "playNpcAnimation", "params": {"target": "sp_paper", "state": "walk"}}, None),
    ]
    for act, scene in errors:
        got = burn_msgs(act, scene)
        assert got and got[0][0] == "error" and "不播动画也不换图" in got[0][1], (act, got)
    fine = [
        ({"type": "moveEntityTo", "params": {"target": "npc_straw", "x": 1, "y": 2}}, "sc_a"),
        ({"type": "setEntityField", "params": {"sceneId": "sc_a", "entityKind": "npc", "entityId": "npc_straw",
                                               "fieldName": "x", "value": 3}}, None),
        ({"type": "playNpcAnimation", "params": {"target": "npc_guard", "state": "walk"}}, "sc_a"),
        ({"type": "playNpcAnimation", "params": {"target": "npc_twin", "state": "walk"}}, "sc_b"),
        ({"type": "setHotspotDisplayImage", "params": {"sceneId": "sc_a", "hotspotId": "hs_plain", "image": OTHER_IMG}},
         None),
    ]
    for act, scene in fine:
        assert burn_msgs(act, scene) == [], act
    got = burn_msgs({"type": "playNpcAnimation", "params": {"target": "npc_twin", "state": "walk"}}, None)
    assert got and got[0][0] == "warning", "同 id 有的场景开了可燃、有的没开：没有场景上下文只提醒"


# --------------------------------------------------------------------------- #
# 4. 动作表单
# --------------------------------------------------------------------------- #

def _roundtrip(model: ProjectModel, act: dict, scene_id: str | None) -> dict:
    ed = ActionEditor("t")
    ed.set_project_context(model, scene_id)
    ed.set_data([copy.deepcopy(act)])
    try:
        out = ed.to_list()
        assert len(out) == 1
        return out[0]
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("scene", [None, "sc_a"])
def test_minimal_and_filled_forms_roundtrip_byte_for_byte(model: ProjectModel, app, scene) -> None:
    for act in (
        {"type": "igniteBurnable", "params": {"target": "hs_paper"}},
        {"type": "igniteBurnable", "params": {"target": "hs_paper", "point": "p2"}},
        {"type": "igniteBurnable", "params": {"target": "player", "socket": "left_hand", "point": "tip"}},
        {"type": "extinguishBurnable", "params": {"target": "npc_straw"}},
        {"type": "extinguishBurnable", "params": {"target": "player", "socket": "left_hand"}},
        {"type": "resetBurnable", "params": {"target": "sp_paper"}},
        # 悬垂值原样保留（改名 / 模板里删了点 / 没标过的挂点）
        {"type": "igniteBurnable", "params": {"target": "hs_gone", "socket": "zz_socket", "point": "p_gone"}},
        {"type": "igniteBurnable", "params": {"target": "hs_paper", "point": "", "extra": 1}},
    ):
        assert _dumps(_roundtrip(model, act, scene)) == _dumps(act), act


def test_socket_switches_target_candidates_and_point_follows(model: ProjectModel, app) -> None:
    ed = ActionEditor("t")
    ed.set_project_context(model, "sc_a")
    ed.set_data([{"type": "igniteBurnable", "params": {"target": "hs_paper", "point": "p2"}}])
    try:
        row = ed._rows[0]
        tw, sw, pw = row._param_widgets["target"], row._param_widgets["socket"], row._param_widgets["point"]
        assert isinstance(sw, FilterableTypeCombo) and isinstance(pw, FilterableTypeCombo)
        assert {i for i in tw._ids if i} == set(_ids(model.burn_target_ids("sc_a")))
        assert [v for _l, v in pw._entries] == ["", "p1", "p2"]
        # 写上挂点：target 候选切到「拿东西的人」，已选的 hs_paper 保值（标缺失），point 候选换成挂件模板的
        sw.set_committed_type("left_hand")
        sw.typeCommitted.emit("left_hand")
        assert {i for i in tw._ids if i} - {"hs_paper"} == set(_ids(model.burn_target_ids("sc_a", "left_hand")))
        assert tw.current_id() == "hs_paper", "换候选不许清空已选值"
        assert "tip" in [v for _l, v in pw._entries] and pw.committed_type() == "p2", "point 保值"
        tw.set_current("player")
        tw.value_changed.emit("player")
        pw.set_committed_type("tip")
        assert ed.to_list()[0]["params"] == {"target": "player", "socket": "left_hand", "point": "tip"}
        # 清空挂点 = 不写键
        sw.set_committed_type("")
        sw.typeCommitted.emit("")
        assert ed.to_list()[0]["params"] == {"target": "player", "point": "tip"}
        pw.set_committed_type("")
        assert ed.to_list()[0]["params"] == {"target": "player"}, "清空 point = 不写键"
    finally:
        ed.deleteLater()


def test_socket_candidates_come_from_the_holder(model: ProjectModel, app, monkeypatch) -> None:
    calls: list[tuple] = []

    def fake(scene_id, holder):
        calls.append((scene_id, holder))
        return [("left_hand", "左手"), ("right_hand", "右手")] if holder in ("player", "npc_guard") else []

    monkeypatch.setattr(model, "burn_socket_names", fake)
    row = ActionRow({"type": "extinguishBurnable", "params": {"target": "npc_guard", "socket": "belt"}},
                    model=model, scene_id="sc_a")
    try:
        sw = row._param_widgets["socket"]
        vals = [v for _l, v in sw._entries]
        assert vals[0] == "" and "left_hand" in vals and "belt" in vals, "候选来自 target 的挂点，悬垂值保值"
        assert sw.committed_type() == "belt"
        assert calls[-1] == ("sc_a", "npc_guard")
    finally:
        row.deleteLater()


# --------------------------------------------------------------------------- #
# 4b. 轨迹 spawn 规格的「可燃」块
# --------------------------------------------------------------------------- #

def _traj_row(model, spawn: dict, scene: str | None = "sc_a") -> ActionRow:
    return ActionRow({"type": "playTrajectory", "params": {"trajectoryId": "tr_x", "spawn": copy.deepcopy(spawn)}},
                     model=model, scene_id=scene)


@pytest.mark.parametrize("spawn", [
    {"kind": "image", "id": "sp_a", "keep": True, "burnable": {"template": "paper_pile"}},
    {"kind": "image", "src": OTHER_IMG, "id": "sp_b", "burnable": {
        "zz": 1, "signals": {"burntOut": "a", "ignited": "b"}, "template": "zz_missing", "initial": "unburnt",
        "playerIgnite": "false", "igniteConditions": [{"flag": "f"}, {"burn": "hs_paper", "burnState": "burnt"}]}},
    {"kind": "character", "id": "sp_c", "burnable": "weird"},
    {"kind": "image", "src": OTHER_IMG, "id": "sp_d"},
])
def test_spawn_burnable_block_roundtrips_byte_for_byte(model: ProjectModel, app, spawn) -> None:
    ed = ActionEditor("t")
    ed.set_project_context(model, "sc_a")
    act = {"type": "playTrajectory", "params": {"trajectoryId": "tr_x", "spawn": spawn}}
    ed.set_data([copy.deepcopy(act)])
    try:
        out = ed.to_list()[0]
        assert _dumps(out["params"]["spawn"]) == _dumps(spawn)
        blk = ed._rows[0]._param_widgets["_spawnBurnable"]
        assert isinstance(blk, BurnableHostBlock)
        assert blk.is_enabled() == ("burnable" in spawn)
        if isinstance(spawn.get("burnable"), dict):
            blk._ensure_cond_editor(True)  # 展开过条件、什么都没动 = 仍逐字回吐
            assert _dumps(ed.to_list()[0]["params"]["spawn"]) == _dumps(spawn)
    finally:
        ed.deleteLater()


def test_spawn_burnable_block_edits(model: ProjectModel, app) -> None:
    row = _traj_row(model, {"kind": "image", "id": "sp_new", "keep": True})
    try:
        blk = row._param_widgets["_spawnBurnable"]
        assert not blk.is_enabled() and blk._body.isHidden()
        assert "burnable" not in row.to_dict()["params"]["spawn"]
        blk._enabled.setChecked(True)
        assert row.to_dict()["params"]["spawn"]["burnable"] == {"template": ""}, "开了还没选模板：写空模板让校验器报"
        assert "src" not in row.to_dict()["params"]["spawn"], "开了可燃 src 不必填：空着就不写键"
        assert {i for i in blk._template._ids if i} == set(model.burnables), "模板候选 = 模板镜像"
        blk._template.set_current("paper_pile")
        blk._template.value_changed.emit("paper_pile")
        blk._initial.set_committed_type("burning")
        blk._player_ignite.set_committed_type("false")
        blk._signal_fields["burntOut"]._value = "sig_out"
        blk._signal_fields["ignited"]._value = "sig_in"
        spawn = row.to_dict()["params"]["spawn"]
        assert list(spawn["burnable"]) == ["template", "initial", "playerIgnite", "signals"], "新块按 HOST_ORDER"
        assert spawn["burnable"] == {"template": "paper_pile", "initial": "burning", "playerIgnite": False,
                                     "signals": {"ignited": "sig_in", "burntOut": "sig_out"}}
        blk._clear_signal(blk._signal_fields["ignited"])
        blk._clear_signal(blk._signal_fields["burntOut"])
        blk._initial.set_committed_type("")
        blk._player_ignite.set_committed_type("")
        assert row.to_dict()["params"]["spawn"]["burnable"] == {"template": "paper_pile"}, "回到缺省 = 删键"
        blk._enabled.setChecked(False)
        assert "burnable" not in row.to_dict()["params"]["spawn"], "关掉可燃 = 删整块"
    finally:
        row.deleteLater()


def test_spawn_burnable_block_does_not_collapse_when_toggled(model: ProjectModel, app) -> None:
    """开关切显隐后整块不许被压成一条缝（布局塌陷 model 层测不出来，量实际高度）。"""
    row = _traj_row(model, {"kind": "image", "id": "sp_new", "keep": True})
    try:
        row.apply_fold_policy(True)  # 单行策略 = 恒展开
        row.resize(900, 1400)
        row.show()
        blk = row._param_widgets["_spawnBurnable"]
        for on in (True, False, True):
            blk._enabled.setChecked(on)
            for _ in range(4):
                app.processEvents()
            assert blk.isVisible()
            assert blk.height() >= blk.sizeHint().height() - 1, (on, blk.height(), blk.sizeHint().height())
            assert blk._template.isVisible() == on
    finally:
        row.hide()
        row.deleteLater()


def test_spawn_burnable_block_keeps_existing_key_order(model: ProjectModel, app) -> None:
    raw = {"signals": {"burntOut": "a"}, "template": "paper_pile", "zz": 1}
    row = _traj_row(model, {"kind": "image", "id": "sp_x", "burnable": raw})
    try:
        blk = row._param_widgets["_spawnBurnable"]
        blk._initial.set_committed_type("burning")
        got = row.to_dict()["params"]["spawn"]["burnable"]
        assert list(got) == ["initial", "signals", "template", "zz"] or list(got) == ["signals", "template", "initial", "zz"]
        assert got["zz"] == 1 and got["signals"] == {"burntOut": "a"}, "没动的项与不认识的键原样留住"
    finally:
        row.deleteLater()


# --------------------------------------------------------------------------- #
# 5. 条件叶的全部面
# --------------------------------------------------------------------------- #

def test_condition_text_shape_and_phrases() -> None:
    from tools.dialogue_graph_editor.dialogue_condition_text import NORMAL, condition_expr_text, condition_expr_verdict
    from tools.editor.editors.narrative_state_editor import _is_condition_shape
    from tools.editor.shared.action_structure import summarize_condition
    from tools.narrative_xref.phrases import describe_condition

    leaf = {"burn": "hs_paper", "burnState": "burning"}
    assert condition_expr_text(leaf) == "可燃物 hs_paper 燃烧状态 = 在烧"
    assert summarize_condition({"burn": "hs_c", "burnScene": "义庄", "burnState": "burnt"}) == "可燃物 义庄/hs_c 燃烧状态 = 烧完"
    held = {"burn": "player", "burnSocket": "left_hand", "burnState": "out"}
    assert condition_expr_text(held) == "玩家 left_hand 上的可燃挂件 燃烧状态 = 灭了"
    assert describe_condition(leaf) == "可燃物「hs_paper」在烧"
    assert describe_condition(held) == "玩家「left_hand」上的可燃挂件灭了"
    assert condition_expr_verdict(held) == NORMAL
    assert _is_condition_shape(held) is True
    assert _is_condition_shape({"burn": "", "burnState": "burning"}) is False
    assert _is_condition_shape({"burn": "hs", "burnState": "ash"}) is False


def test_condition_tree_burn_leaf_roundtrip(model: ProjectModel, app) -> None:
    from tools.editor.shared.condition_expr_tree import ConditionExprNodeEditor

    def node(data: dict) -> ConditionExprNodeEditor:
        n = ConditionExprNodeEditor(0, lambda: model)
        n.set_dict(copy.deepcopy(data))
        return n

    raw = {"burnState": "out", "x": 1, "burn": "hs_paper", "burnScene": "sc_a"}
    n = node(raw)
    try:
        assert n._kind.currentData() == "burn"
        assert _dumps(n.to_dict()) == _dumps(raw), "没动过逐字回吐（键序、未知键）"
        n._bn_state.setCurrentIndex(n._bn_state.findData("burnt"))
        assert n.to_dict() == {"burnState": "burnt", "x": 1, "burn": "hs_paper", "burnScene": "sc_a"}
        n._bn_scene.set_value("")
        assert n.to_dict() == {"burnState": "burnt", "x": 1, "burn": "hs_paper"}, "清空场景 = 不写 burnScene"
        assert [r[0] for r in n._burn_target_rows()] == _ids(model.burn_target_ids(None, ""))
        n._bn_scene.set_value("sc_b")
        assert [r[0] for r in n._burn_target_rows()] == _ids(model.burn_target_ids("sc_b", ""))
        assert [r[0] for r in n._burn_scene_rows()] == ["sc_a", "sc_b"]
        n._bn_socket.set_committed_type("left_hand")
        n._on_bn_socket_changed()
        assert [r[0] for r in n._burn_target_rows()] == _ids(model.burn_target_ids(None, "left_hand"))
        n._bn_target.set_value("player")
        assert list(n.to_dict()) == ["burnState", "x", "burn", "burnScene", "burnSocket"], "已有键保序、新键追加"
        assert n.to_dict()["burnSocket"] == "left_hand"
        n._bn_socket.set_committed_type("")
        assert "burnSocket" not in n.to_dict(), "清空挂点 = 不写 burnSocket"
    finally:
        n.deleteLater()

    held = {"burn": "npc_guard", "burnSocket": "zz_socket", "burnState": "burning"}
    n = node(held)
    try:
        assert _dumps(n.to_dict()) == _dumps(held)
        assert n._bn_socket.committed_type() == "zz_socket", "悬垂挂点保值展示"
    finally:
        n.deleteLater()

    weird = {"burn": "hs_paper", "burnSocket": 7, "burnState": 7}
    n = node(weird)
    try:
        assert n.to_dict() == weird
        n._bn_scene.set_value("sc_a")
        assert n.to_dict() == {"burn": "hs_paper", "burnSocket": 7, "burnState": 7, "burnScene": "sc_a"}, "没动的怪值原样回吐"
    finally:
        n.deleteLater()


# --------------------------------------------------------------------------- #
# 6. 信号 / 改名 / 主窗口
# --------------------------------------------------------------------------- #

def test_host_signals_count_as_emitted(project: Path, model: ProjectModel) -> None:
    from tools.editor.shared.narrative_catalog import burnable_host_signal_fields, emitted_signal_ids
    from tools.narrative_xref import build_index, from_disk, from_project_model

    emitted = set(emitted_signal_ids(model))
    assert {"纸钱烧起来了", "香烧完了", "纸人烧完"} <= emitted, "场景实体 / 挂件预设 / spawn 规格三处宿主都算实发"
    assert emitted_signal_ids(SimpleNamespace()) == []
    assert list(burnable_host_signal_fields({"burnable": {"signals": {"ignited": "x"}}})) == [], "没模板不建实例、不发"
    for src in (from_project_model(model), from_disk(project)):
        idx = build_index(src)
        rows = idx.emitters.get("纸钱烧起来了") or []
        assert len(rows) == 1, src.origin
        row = rows[0]
        assert row.readonly and row.file.endswith("scenes/sc_a.json")
        assert row.pointer == "/hotspots/0/burnable/signals/ignited"
        assert row.owner_type == "hotspot" and row.owner_id == "hs_paper"
        assert "可燃" in row.note
        prop_row = (idx.emitters.get("香烧完了") or [None])[0]
        assert prop_row is not None and prop_row.readonly and prop_row.owner_type == ""
        spawn_row = (idx.emitters.get("纸人烧完") or [None])[0]
        assert spawn_row is not None and spawn_row.owner_type == "npc" and spawn_row.owner_id == "sp_paper"


def test_entity_rename_follows_burn_action_target(tmp_path: Path, app) -> None:
    from tools.editor.shared.entity_refactor import rename_entity, scan_entity_usages

    root = _make_project(tmp_path / "p", scene_a_extra={"onEnter": [
        {"type": "igniteBurnable", "params": {"target": "hs_paper", "point": "p1"}},
        {"type": "resetBurnable", "params": {"target": "hs_candle"}},
        {"type": "extinguishBurnable", "params": {"target": "npc_straw"}},
        {"type": "extinguishBurnable", "params": {"target": "npc_guard", "socket": "left_hand"}},
    ]})
    m = _model(root)
    assert scan_entity_usages(m, "sc_a", "hotspot", "hs_paper"), "扫描要能看见燃烧动作的 target"
    rename_entity(m, "sc_a", "hotspot", "hs_paper", "hs_paper2")
    rename_entity(m, "sc_a", "npc", "npc_straw", "npc_straw2")
    rename_entity(m, "sc_a", "npc", "npc_guard", "npc_guard2")
    acts = m.scenes["sc_a"]["onEnter"]
    assert acts[0]["params"] == {"target": "hs_paper2", "point": "p1"}
    assert acts[1]["params"] == {"target": "hs_candle"}
    assert acts[2]["params"] == {"target": "npc_straw2"}, "可燃 NPC 改名跟随"
    assert acts[3]["params"] == {"target": "npc_guard2", "socket": "left_hand"}, "拿东西的人改名跟随"


def test_main_window_burn_workbench_entry(monkeypatch) -> None:
    from tools.editor import main_window

    launched: list[list[str]] = []

    class _Proc:
        def poll(self):
            return None

    def fake_popen(cmd, **_kw):
        launched.append(list(cmd))
        return _Proc()

    monkeypatch.setattr(main_window.subprocess, "Popen", fake_popen)
    procs: list = []
    msgs: list[str] = []
    owner = SimpleNamespace(
        _ensure_valid_tool_root=lambda: _ROOT,
        _dialogue_external_processes=procs,
        _dialogue_process_watch_timer=SimpleNamespace(start=lambda: None),
        _status=SimpleNamespace(showMessage=lambda m, *_a: msgs.append(m)),
    )
    main_window.MainWindow.open_burn_workbench(owner, "paper_pile")
    assert launched[0][1:] == ["-m", "tools.burn_workbench", "--open", "paper_pile"]
    assert procs, "要登记进外置进程监视表（退出时自动重读）"
    main_window.MainWindow.open_burn_workbench(owner)
    assert launched[1][1:] == ["-m", "tools.burn_workbench"]

    calls: list[str] = []
    owner2 = SimpleNamespace(
        _model=SimpleNamespace(
            project_path=Path("."), burnables={"a": {}, "b": {}}, burnables_errors={"c": "坏"},
            reload_burn_from_disk=lambda: (calls.append("model"), True)[1],
        ),
        _status=SimpleNamespace(showMessage=lambda m, *_a: (calls.append("status"), msgs.append(m))),
        _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
    )
    main_window.MainWindow._reload_burn_from_disk(owner2)
    assert calls == ["model", "pages", "status"]
    assert "2 份可燃物模板" in msgs[-1] and "1 份读不懂" in msgs[-1] and "布置" not in msgs[-1]
    calls.clear()
    owner2._model.reload_burn_from_disk = lambda: (calls.append("model"), False)[1]
    main_window.MainWindow._resync_burn_from_disk(owner2)
    assert calls == ["model"], "盘上没变不重建页面"

    src = Path(main_window.__file__).read_text(encoding="utf-8")
    assert "self._resync_burn_from_disk()" in src
    assert "QTimer.singleShot(0, self, self._resync_burn_from_disk)" in src
    assert '"燃烧工作台…"' in src and '"刷新燃烧数据"' in src
