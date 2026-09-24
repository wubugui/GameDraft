"""世界空间粒子 / 群体（VFX）的登记面 + 往返 + 校验器契约。

四条 action（`playVfx` / `stopVfx` / `setVfxState` / `emitVfxField`）的登记面散在七处
（运行时 register / TS manifest / 编辑器 ACTION_TYPES 与 _PARAM_SCHEMAS / ACTION_PERSISTENCE /
过场白名单 / 校验器 / entity_refactor），漏哪一处报哪种错各不相同
（见 agent_docs runtime/mechanisms/action-registration-registry-surfaces.md）。
三方 parity 由既有护栏覆盖，本文件补它们盖不到的那几面，外加效果资产的校验与实例候选。

效果资产目录 `assets/data/vfx/` 与轨迹同一待遇：**唯一写者是 tools/vfx_workbench**，
主编辑器只读（候选 / 校验），这里钉死"没有脏桶、不进 save_all"。

实例（`instanceId` 的候选）2026-09-14 起摆在粒子布置库 `assets/data/vfx_placements.json`
（按「场景 × 时段外观」各配各的，同一场景白天 / 夜里各一份同 id 是常态），场景 JSON 不再有 `vfx`。
候选 = 本场景各时段外观 id 的**并集**；布置库本身的校验在 `test_vfx_placements_validation.py`。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
    _VFX_FIELD_KINDS,
    _VFX_FLOCK_STATES,
    _VFX_SURFACES,
)
from tools.editor.tests.save_test_utils import repo_root_from_tests  # noqa: E402

REPO = repo_root_from_tests()
ACTS = ["playVfx", "stopVfx", "setVfxState", "emitVfxField"]


# --------------------------------------------------------------------------- #
# 登记面
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("act", ACTS)
def test_registered_on_every_editor_surface(act: str) -> None:
    assert act in ACTION_TYPES, f"{act} 不在 ACTION_TYPES：编辑器下拉里选不到"
    assert act in _PARAM_SCHEMAS, f"{act} 不在 _PARAM_SCHEMAS：参数编辑不出来"
    # 粒子 / 群体是纯表演态：VfxSystem.serialize 恒为空桶，标成 save 会给动作挂错存档点
    assert ACTION_PERSISTENCE.get(act) == "memory", f"{act} 的持久化档标错了"


@pytest.mark.parametrize("act", ACTS)
def test_in_cutscene_allowlist(act: str) -> None:
    """纯表演动作必须进过场白名单，否则过场里被静默跳过（只在控制台一行 warn）。"""
    allow = json.loads((REPO / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert act in allow


def test_runtime_register_param_names_match_manifest() -> None:
    """register 的 paramNames 与 TS manifest 对齐。这一面 tsc 与 validate-data **都不报**。"""
    reg = (REPO / "src/core/ActionRegistry.ts").read_text("utf-8")
    man = (REPO / "src/core/actionParamManifest.ts").read_text("utf-8")
    expect = {
        "playVfx": {"instanceId", "effect", "at", "x", "y", "h", "surface", "seed", "countScale", "restart", "oneShot", "followCamera", "handle"},
        "stopVfx": {"instanceId", "handle", "soft", "fadeMs"},
        "setVfxState": {"instanceId", "state"},
        "emitVfxField": {"kind", "tag", "radius", "strength", "duration", "at", "x", "y", "h", "direction"},
    }
    for act, names in expect.items():
        assert f"executor.register('{act}'" in reg, f"{act} 未在 ActionRegistry 注册"
        assert f"  {act}: {{" in man, f"{act} 未收录进 ACTION_PARAM_MANIFEST"
        schema_names = {n for n, _k in _PARAM_SCHEMAS[act]}
        # direction 是三元组，泛型 (name, kind) schema 表达不了，走 manifest 的 optional 不建控件
        assert schema_names <= names, f"{act} 的 schema 里有 manifest 没有的幻影参数：{schema_names - names}"


def test_default_valued_optionals_are_scoped_omitted() -> None:
    """"缺省即未设"的可选键都登记了作用域剔除表，否则"打开→不改→保存"凭空多键。"""
    for key in (
        ("playVfx", "surface"),
        ("playVfx", "h"),
        ("emitVfxField", "kind"),
        ("emitVfxField", "duration"),
        ("emitVfxField", "h"),
    ):
        assert key in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT, key
    # 这几个是通用词，进全局表会误伤别的 action（surface / kind / duration / h 到处都是）
    from tools.editor.shared.action_editor import _OMIT_WHEN_ABSENT_AND_DEFAULT
    for name in ("surface", "kind", "duration", "h"):
        assert name not in _OMIT_WHEN_ABSENT_AND_DEFAULT, f"{name} 不该进全局剔除表"


def test_every_optional_with_a_widget_is_covered_by_a_roundtrip_table() -> None:
    """**每个**建了控件的可选参数都得被两张往返表之一盖住，不是只盖已知的那几个。

    ⚠ 本条只查"有没有登记"，查不出"登记的值对不对"——`("playVfx","surface")` 曾按运行时默认
    登记成 `"ground"`（控件中性值其实是空串），键在表里、却**永不命中**，最小形态照样漂出
    `surface:""`。值那一侧只能实跑控件验，锁在
    `test_action_condition_data_safety.py::test_play_vfx_minimal_form_does_not_grow_optional_params`
    一族（2026-09-12 全量扫描收口）。
    """
    from tools.editor.shared.action_editor import (
        _ACTION_PARAM_RUNTIME_DEFAULTS,
        _OMIT_WHEN_ABSENT_AND_DEFAULT,
    )

    man = (REPO / "src/core/actionParamManifest.ts").read_text("utf-8")
    for act in ACTS:
        head = man.index(f"  {act}: {{")
        i = man.index("{", head)
        depth, j = 0, i
        while j < len(man):  # 括号配平取条目块（条目里有嵌套对象/注释，正则截不准）
            if man[j] == "{":
                depth += 1
            elif man[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        block = man[i:j + 1]
        om = re.search(r"optional\s*:\s*\[([^\]]*)\]", block)
        optionals = set(re.findall(r"'([^']+)'", om.group(1))) if om else set()
        widgets = {n for n, _k in _PARAM_SCHEMAS[act]}
        for pname in sorted(optionals & widgets):
            covered = (
                (act, pname) in _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT
                or (act, pname) in _ACTION_PARAM_RUNTIME_DEFAULTS
                or pname in _OMIT_WHEN_ABSENT_AND_DEFAULT
                # 指定/继承控件自行区分缺键和显式 0，不经过中性值剔除表。
                or dict(_PARAM_SCHEMAS[act])[pname] in ("optional_number", "optional_int")
            )
            assert covered, (
                f"{act}.{pname} 是可选参数且建了控件，但两张往返表都没登记："
                "缺省值会被「打开→不改→保存」凭空写进全项目数据"
            )


def test_selector_kinds_map_to_real_universes() -> None:
    """两个 id 引用参数都走选择器（铁律：引用字段禁裸 QLineEdit），且宇宙真的存在。"""
    assert _SELECTOR_KIND_UNIVERSE.get("vfx_effect") == "vfx_effects"
    assert _SELECTOR_KIND_UNIVERSE.get("vfx_instance") == "vfx_instances"
    from tools.json_lang.id_universes import collect_id_universes
    ud = collect_id_universes(REPO)
    assert "vfx_effects" in ud.ids and ud.ids["vfx_effects"], "效果资产宇宙是空的"
    assert "vfx_instances" in ud.ids, "场景实例宇宙没建"
    assert "scene_vfx" in ud.scoped, "场景作用域的实例映射没建"
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS
    assert CONTENT_ID_PARAMS.get(("playVfx", "effect")) == "vfx_effects"


def test_presentation_action_python_gate_matches_typescript() -> None:
    """新增表现参数在 TS 与 Python 里同判，避免编辑器比运行时权威更严。"""
    import subprocess
    from tools.editor.validator import _presentation_action_errors

    cases = []
    for key in ("visualStrikes", "visualExtraChance", "visualGapMs", "visualGapJitterMs",
                "fallbackMargin", "fallbackMinDistance", "fallbackSeparation", "fallbackMaxSlopeDeg", "sfxVoices", "vfxVoices", "effectSeed"):
        for value in (None, "0", False, -1, 0, 0.45, 1, 5, 16, 32, 33, 90, 91, 1200):
            cases.append(["strikeThreat", {key: value}])
    for value in (None, False, True, "false", 0):
        cases.extend([["strikeThreat", {"fallbackGroundOnly": value}],
                      ["strikeThreat", {"fallbackStrictSeparation": value}], ["playSfx", {"loop": value}],
                      ["stopVfx", {"handle": "cloud", "soft": value}]])
    for value in (None, "", " ", "surface_zone", False, 0, []):
        cases.append(["strikeThreat", {"fallbackSurfaceZone": value}])
    cases.extend([
        ["playVfx", {"handle": "cloud", "effect": "storm", "x": 0, "y": 0}],
        ["playVfx", {"handle": "cloud", "instanceId": "placed", "effect": "storm"}],
        ["playVfx", {"handle": "cloud"}], ["playVfx", {"handle": ""}],
        ["stopVfx", {}], ["stopVfx", {"instanceId": "placed"}],
        ["stopVfx", {"handle": "cloud", "fadeMs": 0}],
        ["stopVfx", {"handle": "cloud", "fadeMs": -1}],
        ["stopVfx", {"handle": "cloud", "instanceId": "placed"}],
        ["strikeThreat", {"strikes": 0, "gapMs": -1}],  # 本轮不能借机收紧旧参数
    ])
    script = """
const fs = require('fs'), ts = require('typescript');
const source = fs.readFileSync('src/core/actionParamManifest.ts', 'utf8');
const moduleObject = {exports: {}};
new Function('module', 'exports', ts.transpileModule(source,
  {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText)(moduleObject, moduleObject.exports);
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(([type, params]) => moduleObject.exports.presentationActionErrors(type, params).length > 0)));
"""
    completed = subprocess.run(["node", "-e", script], cwd=REPO, input=json.dumps(cases),
                               text=True, capture_output=True, check=True, timeout=30)
    expected = json.loads(completed.stdout)
    actual = [bool(_presentation_action_errors(action, params)) for action, params in cases]
    assert actual == expected, [(case, py, ts) for case, py, ts in zip(cases, actual, expected) if py != ts]
    assert not _presentation_action_errors("strikeThreat", {"sfxVoices": 0, "vfxVoices": 0, "effectSeed": 0})
    assert _presentation_action_errors("strikeThreat", {"effectSeed": 0.45})


def test_presentation_numbers_keep_zero_and_can_return_to_inheritance() -> None:
    from PySide6.QtWidgets import QApplication
    from tools.editor.shared.action_editor import ActionEditor
    from tools.editor.shared.collapsible_section import CollapsibleSection

    app = QApplication.instance() or QApplication([])
    editor = ActionEditor("雷链表现")
    params = {"strikes": 3, "extraChance": 0.45, "gapMs": 240, "gapJitterMs": 110,
              "sfxVolume": 0.4, "seed": 7, "effectSeed": 91, "lightHeight": 260,
              "visualStrikes": 5, "visualExtraChance": 0.6, "visualGapMs": 600,
              "visualGapJitterMs": 250, "fallbackMargin": 0.15, "fallbackMinDistance": 80,
              "fallbackSeparation": 100, "fallbackMaxSlopeDeg": 30,
              "fallbackStrictSeparation": False, "fallbackGroundOnly": False,
              "fallbackSurfaceZone": "unresolved_surface_zone",
              "sfxVoices": 2, "vfxVoices": 4, "futureParam": "keep"}
    action = {"type": "strikeThreat", "params": params}
    editor.set_data([action])
    assert editor.to_list() == [action]
    row = editor._rows[0]
    assert "visualStrikes" not in row._param_widgets  # 默认折叠且懒建
    section = next(s for s in row.findChildren(CollapsibleSection) if s._plain_title == "空地落雷与补足表现")
    section._header.click()
    app.processEvents()
    assert editor.to_list() == [action]
    assert row._param_widgets["fallbackSurfaceZone"].current_value() == "unresolved_surface_zone"
    row._param_widgets["fallbackSurfaceZone"].set_value("")
    assert "fallbackSurfaceZone" not in editor.to_list()[0]["params"]
    row._param_widgets["fallbackStrictSeparation"].click()
    assert editor.to_list()[0]["params"]["fallbackStrictSeparation"] is True
    row._param_widgets["fallbackStrictSeparation"].click()
    assert editor.to_list()[0]["params"]["fallbackStrictSeparation"] is False
    zero_keys = ("sfxVolume", "seed", "effectSeed", "lightHeight", "strikes", "extraChance", "gapMs", "gapJitterMs", "visualStrikes", "visualExtraChance",
                 "visualGapMs", "visualGapJitterMs", "fallbackMinDistance", "fallbackMaxSlopeDeg", "sfxVoices", "vfxVoices")
    for key in zero_keys:
        row._param_widgets[key].spin.setValue(0)
    output = editor.to_list()[0]["params"]
    for key in zero_keys:
        assert key in output and output[key] == 0
        row._param_widgets[key].enabled.click()
    output = editor.to_list()[0]["params"]
    assert not set(zero_keys) & output.keys()
    assert output["futureParam"] == "keep"
    editor.set_data([{"type": "strikeThreat", "params": {}}])
    section = next(s for s in editor._rows[0].findChildren(CollapsibleSection) if s._plain_title == "空地落雷与补足表现")
    section._header.click()
    app.processEvents()
    assert editor.to_list() == [{"type": "strikeThreat", "params": {}}]


def _raw_occurrences(lib: dict, sid: str) -> dict[str, list[tuple[str, str]]]:
    """直接走布置库原始 JSON（不经共享模块的查询）：实例 id → ``[(时段键, 效果 id), …]``，base 记作 ``""``。

    真数据的期望值一律从这里现算——布置库是作者面、一直在长（09-21 各场景加了一批 pml_atmo_*），
    写死 id 清单一加布置就失配。"""
    ent = lib["scenes"][sid]
    out: dict[str, list[tuple[str, str]]] = {}
    for ph, rows in [("", ent.get("base") or [])] + list((ent.get("variants") or {}).items()):
        for r in rows:
            out.setdefault(str(r["id"]).strip(), []).append((ph, str(r["effect"]).strip()))
    return out


def test_json_lang_instance_universe_reads_the_placement_library() -> None:
    """json_lang 的实例宇宙读**布置库**（场景 JSON 已没有 vfx），每个场景 = 各时段外观 id 的并集。

    逐场景与共享模块 `instance_ids_for_scene` 对账（语义级，不只锁存在性），再与原始 JSON 现算的并集对账：
    同 id 在基底与夜各摆一份 → 候选只出现一次；只摆在某个时段外观里的（萤火虫只在崖墓入口的夜里）→ 照样是候选。
    """
    from tools.editor.shared import vfx_placements as vp
    from tools.json_lang.id_universes import collect_id_universes

    ud = collect_id_universes(REPO)
    lib, err = vp.load_library(REPO)
    assert err == ""
    scene_vfx = ud.scoped["scene_vfx"]
    for sid in ud.ids["scenes"]:
        assert scene_vfx.get(sid) == sorted(vp.instance_ids_for_scene(lib, sid)), sid
    placed = [sid for sid in lib["scenes"] if sid in scene_vfx]
    assert placed, "布置库里的场景一个都不在场景宇宙里？"
    for sid in placed:
        assert scene_vfx[sid] == sorted(_raw_occurrences(lib, sid)), sid
    assert ud.ids["vfx_instances"] == sorted({i for ids in scene_vfx.values() for i in ids})
    assert {i for sid in placed for i in _raw_occurrences(lib, sid)} <= set(ud.ids["vfx_instances"])


def test_json_lang_instance_universe_honours_overlay_and_ignores_scene_vfx(tmp_path: Path) -> None:
    """LSP overlay 里改着的布置库要算数；场景 JSON 里残留的旧 vfx 不算（运行时不读它）。"""
    from tools.editor.shared import vfx_placements as vp
    from tools.json_lang.id_universes import collect_id_universes

    root = tmp_path / "p"
    sp = root / "public" / "assets" / "scenes"
    sp.mkdir(parents=True)
    (sp / "s.json").write_bytes(json.dumps(
        {"id": "s", "vfx": [{"id": "ghost", "effect": "e", "anchor": {"x": 0, "y": 0}}]},
        ensure_ascii=False).encode("utf-8"))
    disk = {"scenes": {"s": {"base": [{"id": "disk", "effect": "e", "anchor": {"x": 0, "y": 0}}]}}}
    lp = vp.library_path(root)
    lp.parent.mkdir(parents=True)
    lp.write_bytes(vp.dumps(disk))

    ud = collect_id_universes(root)
    assert ud.scoped["scene_vfx"] == {"s": ["disk"]}

    overlay = {"scenes": {"s": {"base": [{"id": "b", "effect": "e", "anchor": {"x": 0, "y": 0}}],
                                "variants": {"夜": [{"id": "n", "effect": "e", "anchor": {"x": 0, "y": 0}},
                                                   {"id": "b", "effect": "e", "anchor": {"x": 0, "y": 0}}]}}}}

    def read(path: Path) -> str:
        if Path(path).resolve() == lp.resolve():
            return json.dumps(overlay, ensure_ascii=False)
        return Path(path).read_text(encoding="utf-8")

    ud2 = collect_id_universes(root, read_text=read)
    assert ud2.scoped["scene_vfx"] == {"s": ["b", "n"]}
    assert ud2.ids["vfx_instances"] == ["b", "n"]

    lp.write_bytes(b"{ broken")
    assert collect_id_universes(root).scoped["scene_vfx"] == {"s": []}, "读不懂 = 没有实例（校验器另报 error）"


def test_enums_mirror_the_ts_side() -> None:
    """三张短枚举与 TS `types.ts` 逐字对齐（改一处要改两处，这里是那道机械闸）。"""
    types_ts = (REPO / "src/data/types.ts").read_text("utf-8")
    assert "surface?: 'ground' | 'shell'" in types_ts
    assert "export type VfxFlockState = 'roosting' | 'airborne' | 'fleeing' | 'returning';" in types_ts
    assert "export type VfxFieldKind = 'fear' | 'attract' | 'wind' | 'airflow';" in types_ts
    assert {v for v, _l in _VFX_SURFACES if v} == {"ground", "shell"}
    assert {v for v, _l in _VFX_FLOCK_STATES} == {"roosting", "airborne", "fleeing", "returning"}
    assert {v for v, _l in _VFX_FIELD_KINDS if v} == {"fear", "attract", "wind", "airflow"}


def test_position_params_are_registered_as_entity_refs() -> None:
    """位置参数是位置引用：漏登记会让它对重构引擎与可达性校验**双双隐形**。"""
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    assert ENTITY_REF_PARAMS.get("playVfx", {}).get("at") == "position_ref"
    assert ENTITY_REF_PARAMS.get("emitVfxField", {}).get("at") == "position_ref"
    assert ENTITY_REF_PARAMS.get("strikeThreat", {}).get("fallbackSurfaceZone") == "zone"
    from tools.editor.project_model import ProjectModel
    from tools.editor.validator import _append_action_param_ref_issues
    model = ProjectModel()
    model.scenes = {"s": {"id": "s", "zones": [{"id": "surface_zone", "polygon": [[0, 0], [1, 0], [1, 1]]}]},
                    "other": {"id": "other", "zones": []}}
    for sid, zone, expected_warning in (("s", "surface_zone", False), ("s", "missing", True),
                                         ("other", "surface_zone", True)):
        issues = []
        _append_action_param_ref_issues(model, issues, {"type": "strikeThreat", "params": {"fallbackSurfaceZone": zone}},
                                       "scene", sid, sid)
        assert any("fallbackSurfaceZone" in issue.message for issue in issues) is expected_warning


def test_vfx_dir_is_read_only_for_the_main_editor() -> None:
    """效果资产目录的唯一写者是粒子工作台：主编辑器不许有脏桶、不许进 save_all。"""
    from tools.editor.project_model import ProjectModel
    assert "vfx" not in ProjectModel.KNOWN_DIRTY_BUCKETS
    assert "vfx_effects" not in ProjectModel.KNOWN_DIRTY_BUCKETS
    src = (REPO / "tools/editor/project_model.py").read_text("utf-8")
    assert "vfx_dir" in src
    for fn_name in ("def save_all", "def _planned_write_paths"):
        start = src.index(fn_name)
        end = src.find("\n    def ", start + 1)
        body = src[start:end if end > 0 else None]
        assert "vfx" not in body, f"{fn_name} 碰了效果资产目录"


# --------------------------------------------------------------------------- #
# 只读镜像与候选
# --------------------------------------------------------------------------- #

def _model_on_repo():
    from tools.editor.project_model import ProjectModel
    m = ProjectModel()
    m.load_project(REPO)
    return m


def test_effect_mirror_and_id_providers() -> None:
    m = _model_on_repo()
    assert m.vfx_effects, "效果资产镜像是空的（目录扫描没接上）"
    ids = dict(m.all_vfx_effect_ids())
    assert "bat_cliff" in ids
    assert "发射器" in ids["bat_cliff"], "候选 label 应带发射器数，下拉里才分得清"
    # 实例候选读布置库：同 id 在基底与夜各摆一份 → 并集里只出现一次；期望从真库原始 JSON 现算
    from tools.editor.shared import vfx_placements as vp
    lib, err = vp.load_library(REPO)
    assert err == "" and lib["scenes"], "布置库是空的？"
    for sid in lib["scenes"]:
        occ = _raw_occurrences(lib, sid)
        pairs = m.vfx_instance_ids_for_scene(sid)
        assert sorted(iid for iid, _lab in pairs) == sorted(occ), (sid, pairs)  # 行序是作者面的顺序，不写死
        for iid, lab in pairs:
            for ph, eff in occ[iid]:
                assert eff in lab, f"{sid} · {iid}：候选 label 要带效果 id「{eff}」：{lab}"
                assert (ph or "基底") in lab, f"{sid} · {iid}：候选 label 要写出现在哪几份（缺「{ph or '基底'}」）：{lab}"
    assert m.vfx_instance_ids_for_scene(None) == []
    assert m.vfx_instance_ids_for_scene("不存在的场景") == []


def test_instance_candidates_are_the_placement_library_union() -> None:
    """主编辑器候选与共享模块逐场景同口径（语义级对账：候选面必须等于校验面）。"""
    from tools.editor.shared import vfx_placements as vp

    m = _model_on_repo()
    lib, err = vp.load_library(REPO)
    assert err == ""
    assert lib["scenes"], "布置库是空的？"
    for sid in lib["scenes"]:
        got = [iid for iid, _lab in m.vfx_instance_ids_for_scene(sid)]
        assert got == vp.instance_ids_for_scene(lib, sid), sid
    # 只摆在某个时段外观里的（萤火虫只在崖墓入口的夜里）照样是候选（动作可能就在那个时段播）；从真库现算，不写死 id
    for sid in lib["scenes"]:
        got = {iid for iid, _ in m.vfx_instance_ids_for_scene(sid)}
        for iid, where in _raw_occurrences(lib, sid).items():
            if all(ph for ph, _eff in where):
                assert iid in got, f"{sid} · {iid} 只摆在 {[ph for ph, _ in where]} 里，也得是候选"
    # 场景 JSON 已经不带 vfx：候选不许再从那里来
    for sid, sc in m.scenes.items():
        assert "vfx" not in (sc or {}), f"{sid} 的场景 JSON 还带着 vfx（运行时不读，校验器会报 error）"


def test_instance_candidates_ignore_leftover_scene_vfx(tmp_path: Path) -> None:
    """临时工程：布置库里 base 一份、夜一份（有重叠），场景 JSON 残留一条旧 vfx——候选只认布置库的并集。"""
    from tools.editor.project_model import ProjectModel
    from tools.editor.shared import vfx_placements as vp
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    sp = root / "public" / "assets" / "scenes" / "sc_a.json"
    sc = json.loads(sp.read_text(encoding="utf-8"))
    sc["vfx"] = [{"id": "ghost", "effect": "e", "anchor": {"x": 0, "y": 0}}]
    sp.write_bytes(json.dumps(sc, ensure_ascii=False, indent=2).encode("utf-8"))
    anchor = {"x": 1, "y": 2}
    lib = {"scenes": {"sc_a": {
        "base": [{"id": "a", "effect": "e1", "anchor": anchor}],
        "variants": {"夜": [{"id": "n", "effect": "e2", "anchor": anchor},
                           {"id": "a", "effect": "e1", "anchor": anchor}]},
    }}}
    vp.library_path(root).write_bytes(vp.dumps(lib))
    m = ProjectModel()
    m.load_project(root)
    assert [iid for iid, _ in m.vfx_instance_ids_for_scene("sc_a")] == ["a", "n"]
    assert m.vfx_instance_ids_for_scene("sc_b") == []


# --------------------------------------------------------------------------- #
# 校验器：合法最小形态零告警 / 坏数据必报
# --------------------------------------------------------------------------- #

MINIMAL_EFFECT = {
    "id": "zz_min",
    "emitters": [{
        "id": "e",
        "appearance": {"image": "/x.png", "sizeWu": 3},
        "spawn": {"max": 5},
    }],
}


def _issues_for_effects(tmp_path: Path, effects: dict[str, dict]) -> list:
    """只跑效果资产那一段校验，避免整工程装载的噪音。"""
    from tools.editor import validator

    class FakeModel:
        vfx_effects = effects

        class paths:  # noqa: D106
            vfx_dir = tmp_path / "nope"

    issues: list = []
    validator._validate_vfx_effects(FakeModel(), issues)  # type: ignore[arg-type]
    return issues


def test_minimal_effect_is_clean(tmp_path: Path) -> None:
    """合法最小形态必须零告警——兜底比 TS 权威更严就是拒存合法数据（norms 红线）。"""
    issues = _issues_for_effects(tmp_path, {"zz_min": json.loads(json.dumps(MINIMAL_EFFECT))})
    assert issues == [], [i.message for i in issues]


def test_shipped_effects_are_clean(tmp_path: Path) -> None:
    """仓库里五份真效果资产必须零 error（它们就是这套形状的第一批消费者）。"""
    m = _model_on_repo()
    issues = _issues_for_effects(tmp_path, m.vfx_effects)
    errs = [i for i in issues if i.severity == "error"]
    assert errs == [], [i.message for i in errs]


@pytest.mark.parametrize("mutate,frag", [
    (lambda d: d.update(id="别的名字"), "与文件名"),
    # 空 emitters 且没有光柱仍是 error（只有光柱的效果才许 emitters 为空）
    (lambda d: d.update(emitters=[]), "发射器与光柱（beams）至少有一样"),
    (lambda d: d["emitters"][0]["appearance"].update(sizeWu=0), "sizeWu"),
    (lambda d: d["emitters"][0]["appearance"].pop("image"), "animFile"),
    (lambda d: d["emitters"][0]["spawn"].update(max=0), "spawn.max"),
    (lambda d: d["emitters"][0].update(collision={"onHit": {"emitter": "没有这个", "count": 1}}), "不是本效果里的发射器"),
    (lambda d: d["emitters"][0].update(collision={"onHit": {"emitter": "e", "count": 1}}), "指向自己"),
    (lambda d: d["emitters"][0].update(collision={"ground": "乱写"}), "collision.ground"),
    (lambda d: d["emitters"][0]["appearance"].update(alphaOverLife=[[0, 1], [2, 0]]), "不在 [0,1]"),
    (lambda d: d["emitters"][0]["appearance"].update(sizeOverLife=[[1, 1], [0, 0]]), "按 t 递增"),
    (lambda d: d["emitters"][0].update(subOnly=True, behavior={"cruise": 1}), "不能并存"),
])
def test_broken_effect_is_reported(tmp_path: Path, mutate, frag: str) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    mutate(d)
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    msgs = " | ".join(i.message for i in issues)
    assert frag in msgs, f"该报没报：期望提到「{frag}」，实际 {msgs!r}"


def test_flock_behaviour_required_numbers(tmp_path: Path) -> None:
    """群体模块缺一个数值运行时就是 NaN 扩散（粒子飞到无穷远且不报错）。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["behavior"] = {"cruise": 100}   # 其余全缺
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    msgs = " | ".join(i.message for i in issues)
    for key in ("max", "maxAccel", "minAltitude", "senseRadius", "separation", "accel", "orbit", "home", "attitude"):
        assert key in msgs, f"behavior.{key} 缺了没报"


# --------------------------------------------------------------------------- #
# 校验器：appearance.emissive（镜面 / 自发光份额）
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", [-0.1, 1.5, "0.5", True])
def test_emissive_out_of_range_is_an_error(tmp_path: Path, bad) -> None:
    """0..1 之外的值渲染侧会夹断，作者填了 3 却只看到 1 —— 静默失真，必须构建期拦。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["emissive"] = bad
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    errs = [i for i in issues if i.severity == "error" and "emissive" in i.message]
    assert errs, f"emissive={bad!r} 该报 error 没报：{[i.message for i in issues]!r}"


@pytest.mark.parametrize("ok", [0, 0.45, 1])
def test_emissive_in_range_is_clean(tmp_path: Path, ok) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["emissive"] = ok
    d["emitters"][0]["appearance"]["lit"] = True
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


def test_emissive_null_means_unset(tmp_path: Path) -> None:
    """JSON 里的 null 一律当“没填”（校验器对所有可选项都是这个口径）；
    工作台是写入者，它自己从不写 null，所以写侧更严不算两道门打架。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["emissive"] = None
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


def test_emissive_with_lit_false_is_a_warning_not_an_error(tmp_path: Path) -> None:
    """关了受光就走无光 shader，这一项根本读不到。是作者填错了地方，但不该拒存。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"].update(lit=False, emissive=0.5)
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    assert [i for i in issues if i.severity == "warning" and "emissive" in i.message], \
        [f"{i.severity}:{i.message}" for i in issues]
    assert not [i for i in issues if i.severity == "error"], [i.message for i in issues]


def test_emissive_gate_matches_the_workbench_gate(tmp_path: Path) -> None:
    """编辑器兜底与工作台闸门必须同口径——两道门不一致时，能存进去的东西会被校验器拒掉。"""
    from tools.vfx_workbench import assets as wb

    for v in (-0.1, 1.5, "0.5"):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["appearance"]["emissive"] = v
        with pytest.raises(ValueError):
            wb.normalize_effect(json.loads(json.dumps(d)))
        assert [i for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "error"], v

    for v in (0, 0.45, 1):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["appearance"].update(emissive=v, lit=True)
        warn: list[str] = []
        wb.normalize_effect(json.loads(json.dumps(d)), warn)
        assert not [w for w in warn if "emissive" in w], warn
        assert _issues_for_effects(tmp_path, {"zz_min": d}) == [], v


# --------------------------------------------------------------------------- #
# 校验器：appearance.lightGain（受光强度，乘在发射器收到的光上）
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", [-0.1, 10.5, "2", True, float("nan")])
def test_light_gain_out_of_range_is_an_error(tmp_path: Path, bad) -> None:
    """运行时夹到 0..10：作者填 30 却只看到 10 —— 静默失真，构建期拦。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["lightGain"] = bad
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    assert [i for i in issues if i.severity == "error" and "lightGain" in i.message], \
        f"lightGain={bad!r} 该报 error 没报：{[i.message for i in issues]!r}"


@pytest.mark.parametrize("ok", [0, 1, 2.5, 10])
def test_light_gain_in_range_is_clean(tmp_path: Path, ok) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"].update(lightGain=ok, lit=True)
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


def test_light_gain_null_means_unset(tmp_path: Path) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["lightGain"] = None
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


def test_light_gain_with_lit_false_is_a_warning_not_an_error(tmp_path: Path) -> None:
    """关了受光走无光 shader，受光强度恒按 1——填错了地方，但不该拒存。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"].update(lit=False, lightGain=3)
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    assert [i for i in issues if i.severity == "warning" and "lightGain" in i.message], \
        [f"{i.severity}:{i.message}" for i in issues]
    assert not [i for i in issues if i.severity == "error"], [i.message for i in issues]


def test_light_gain_gate_matches_the_workbench_gate(tmp_path: Path) -> None:
    """编辑器兜底与工作台闸门同口径（0..10、lit=false 只警告）。"""
    from tools.vfx_workbench import assets as wb

    for v in (-0.1, 10.5, "2"):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["appearance"]["lightGain"] = v
        with pytest.raises(ValueError):
            wb.normalize_effect(json.loads(json.dumps(d)))
        assert [i for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "error"], v

    for v in (0, 1, 10):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["appearance"].update(lightGain=v, lit=True)
        warn: list[str] = []
        wb.normalize_effect(json.loads(json.dumps(d)), warn)
        assert not [w for w in warn if "lightGain" in w], warn
        assert _issues_for_effects(tmp_path, {"zz_min": d}) == [], v

    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"].update(lightGain=3, lit=False)
    warn2: list[str] = []
    wb.normalize_effect(json.loads(json.dumps(d)), warn2)
    assert [w for w in warn2 if "lightGain" in w], warn2
    assert [i for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "warning" and "lightGain" in i.message]

    # 唯一有意的差别：显式 null。工作台是写入者，从不写 null（检查器清空 = 删键），闸门按类型错拒；
    # 编辑器兜底读的是手改过的文件，null 按"未填"放过（运行时同样按缺省 1）。与 emissive 同一套口径。
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["lightGain"] = None
    with pytest.raises(ValueError):
        wb.normalize_effect(json.loads(json.dumps(d)))
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


# --------------------------------------------------------------------------- #
# 校验器：appearance.tintOverLife（颜色 × 寿命，乘在 tint 上）
# --------------------------------------------------------------------------- #

_TINT_OVER_LIFE_BAD = [
    ({"k": 1}, "数组"),
    ([[0, 1, 1]], "四个有限数"),
    ([[0, 1, 1, 1, 1]], "四个有限数"),
    ([[0, 1, "1", 1]], "四个有限数"),
    ([[0, 1, True, 1]], "四个有限数"),
    ([[0, 1, float("nan"), 1]], "四个有限数"),
    ([[0, 1, float("inf"), 1]], "四个有限数"),
    ([[-0.1, 1, 1, 1]], "不在 [0,1]"),
    ([[0, 1, 1, 1], [1.5, 1, 1, 1]], "不在 [0,1]"),
    ([[0.6, 1, 1, 1], [0.2, 1, 0, 0]], "按 t 递增"),
    ([[0, 1.2, 1, 1]], "r=1.2"),
    ([[0, 1, -0.1, 1]], "g=-0.1"),
    ([[0, 1, 1, 2]], "b=2"),
]


@pytest.mark.parametrize("bad,frag", _TINT_OVER_LIFE_BAD)
def test_tint_over_life_bad_shapes_are_errors(tmp_path: Path, bad, frag: str) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["tintOverLife"] = bad
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    errs = [i.message for i in issues if i.severity == "error" and "tintOverLife" in i.message]
    assert any(frag in m for m in errs), f"tintOverLife={bad!r} 该报「{frag}」没报：{[i.message for i in issues]!r}"


@pytest.mark.parametrize("ok", [
    [],                                                    # 空 = 恒白
    [[0, 1, 0.9, 0.6]],                                    # 单键 = 整段取它
    [[0, 1, 0.95, 0.7], [0.4, 1, 0.55, 0.15], [1, 0.35, 0.05, 0]],
    [[0, 1, 1, 1], [0.5, 1, 1, 1], [0.5, 1, 0, 0], [1, 0, 0, 0]],   # 同一个 t 两个键（硬切）= 非降序，合法
    None,                                                  # 显式 null = 未填（与 emissive / lightGain 同口径）
])
def test_tint_over_life_valid_shapes_are_clean(tmp_path: Path, ok) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["tintOverLife"] = ok
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


def test_tint_over_life_gate_matches_the_workbench_gate(tmp_path: Path) -> None:
    """编辑器兜底与工作台闸门读同一个 `vfx_appearance.tint_over_life_problems`：拒的一样、放的一样。"""
    from tools.vfx_workbench import assets as wb

    for bad, _frag in _TINT_OVER_LIFE_BAD:
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["appearance"]["tintOverLife"] = bad
        with pytest.raises(ValueError, match="tintOverLife"):
            wb.normalize_effect(json.loads(json.dumps(d)))
        assert [i for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "error"], bad
    good = [[0, 1, 0.95, 0.7], [0.4, 1, 0.55, 0.15], [1, 0.35, 0.05, 0]]
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["appearance"]["tintOverLife"] = good
    out = wb.normalize_effect(json.loads(json.dumps(d)))
    assert out["emitters"][0]["appearance"]["tintOverLife"] == good
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


# --------------------------------------------------------------------------- #
# 校验器：motion.followAnchor（锚点动了、在飞的粒子怎么走）
# --------------------------------------------------------------------------- #

_FLOCK_BEHAVIOR = {
    "cruise": 1, "max": 2, "maxAccel": 3, "minAltitude": 4, "senseRadius": 5, "separation": 6,
    "accel": {"separation": 1, "alignment": 1, "cohesion": 1},
    "orbit": {"radius": 1, "height": 1},
    "home": {"nestRadius": 1, "rangeRadius": 2, "startleRadius": 3},
    "attitude": {"fear": {"light": 1}},
}
_PLATE = {"size": [16, 16], "terminalSpeed": 90}


@pytest.mark.parametrize("bad", ["hover", "Full", "", 1, True, ["full"]])
def test_follow_anchor_unknown_value_is_an_error(tmp_path: Path, bad) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["motion"] = {"followAnchor": bad}
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    assert [i for i in issues if i.severity == "error" and "motion.followAnchor 只能是 none / rig / full" in i.message], \
        f"followAnchor={bad!r} 该报 error 没报：{[i.message for i in issues]!r}"


@pytest.mark.parametrize("ok", ["none", "rig", "full", None])
def test_follow_anchor_valid_values_are_clean_on_plain_particles(tmp_path: Path, ok) -> None:
    """null 按"未填"（与 emissive / lightGain 同口径）。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["motion"] = {"followAnchor": ok}
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


@pytest.mark.parametrize("extra", [{"behavior": _FLOCK_BEHAVIOR}, {"plate": _PLATE}], ids=["flock", "plate"])
def test_follow_anchor_on_flock_or_plate_is_a_warning(tmp_path: Path, extra) -> None:
    """群体 / 薄片运行时不吃：rig / full 警告不拦；显式 none 不警告。"""
    for v in ("rig", "full"):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0].update(json.loads(json.dumps(extra)))
        d["emitters"][0]["motion"] = {"followAnchor": v}
        issues = _issues_for_effects(tmp_path, {"zz_min": d})
        assert [i for i in issues if i.severity == "warning" and "群体 / 薄片不吃 followAnchor，写了没用" in i.message], \
            [f"{i.severity}:{i.message}" for i in issues]
        assert not [i for i in issues if "followAnchor" in i.message and i.severity == "error"]
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0].update(json.loads(json.dumps(extra)))
    d["emitters"][0]["motion"] = {"followAnchor": "none"}
    assert not [i for i in _issues_for_effects(tmp_path, {"zz_min": d}) if "followAnchor" in i.message]


def test_follow_anchor_gate_matches_the_workbench_gate(tmp_path: Path) -> None:
    """编辑器兜底与工作台闸门读同一个 `vfx_motion`：拒的一样、警告的一样，措辞逐字相同（只差前缀）。"""
    from tools.vfx_workbench import assets as wb

    for bad in ("hover", "", 1):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["motion"] = {"followAnchor": bad}
        with pytest.raises(ValueError) as e:
            wb.normalize_effect(json.loads(json.dumps(d)))
        errs = [i.message for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "error"]
        assert len(errs) == 1 and str(e.value).split(".", 1)[1] == errs[0].split(" ", 2)[2], (str(e.value), errs)

    for extra in ({"behavior": _FLOCK_BEHAVIOR}, {"plate": _PLATE}):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0].update(json.loads(json.dumps(extra)))
        d["emitters"][0]["motion"] = {"followAnchor": "full"}
        warn: list[str] = []
        wb.normalize_effect(json.loads(json.dumps(d)), warn)
        wb_w = [w.split(": ", 1)[1] for w in warn if "followAnchor" in w]
        ed_w = [i.message.split(" ", 2)[2] for i in _issues_for_effects(tmp_path, {"zz_min": d})
                if i.severity == "warning" and "followAnchor" in i.message]
        assert wb_w and wb_w == ed_w, (wb_w, ed_w)

    # 唯一有意的差别：显式 null。工作台是写入者，从不写 null（检视器选「不跟」= 删键），闸门拒；编辑器兜底按"未填"放过
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["motion"] = {"followAnchor": None}
    with pytest.raises(ValueError):
        wb.normalize_effect(json.loads(json.dumps(d)))
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


# --------------------------------------------------------------------------- #
# 校验器：life.maxDistance（最远烧到多远，wu，离发射器原点）
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", [0, -3, "60", True, [60], float("nan"), float("inf")])
def test_max_distance_non_positive_or_non_number_is_an_error(tmp_path: Path, bad) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["life"] = {"seconds": [1, 2], "maxDistance": bad}
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    assert [i for i in issues if i.severity == "error" and "life.maxDistance 必须是 > 0 的数" in i.message], \
        f"maxDistance={bad!r} 该报 error 没报：{[i.message for i in issues]!r}"


@pytest.mark.parametrize("ok", [60, 0.5, None])
def test_max_distance_valid_values_are_clean_on_particles_with_life(tmp_path: Path, ok) -> None:
    """null 按"未填"（与 followAnchor / emissive / lightGain 同口径）。"""
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["life"] = {"seconds": [1, 2], "maxDistance": ok}
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


@pytest.mark.parametrize("extra, why", [
    ({"behavior": _FLOCK_BEHAVIOR, "life": {"seconds": [1, 2], "maxDistance": 30}}, "这是群体发射器"),
    ({"plate": _PLATE, "life": {"seconds": [1, 2], "maxDistance": 30}}, "这是薄片发射器"),
    ({"life": {"maxDistance": 30}}, "没有 life.seconds"),
], ids=["flock", "plate", "immortal"])
def test_max_distance_where_the_runtime_ignores_it_is_a_warning(tmp_path: Path, extra, why) -> None:
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0].update(json.loads(json.dumps(extra)))
    issues = _issues_for_effects(tmp_path, {"zz_min": d})
    hit = [i for i in issues if i.severity == "warning" and "没有寿命 / 群体 / 薄片不吃 maxDistance，写了没用" in i.message]
    assert len(hit) == 1 and why in hit[0].message, [f"{i.severity}:{i.message}" for i in issues]
    assert not [i for i in issues if "maxDistance" in i.message and i.severity == "error"]


def test_max_distance_gate_matches_the_workbench_gate(tmp_path: Path) -> None:
    """编辑器兜底与工作台闸门读同一个 `vfx_life`：拒的一样、警告的一样，措辞逐字相同（只差前缀）。"""
    from tools.vfx_workbench import assets as wb

    for bad in (0, -1, "60"):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0]["life"] = {"seconds": [1, 2], "maxDistance": bad}
        with pytest.raises(ValueError) as e:
            wb.normalize_effect(json.loads(json.dumps(d)))
        errs = [i.message for i in _issues_for_effects(tmp_path, {"zz_min": d}) if i.severity == "error"]
        assert len(errs) == 1 and str(e.value).split(".", 1)[1] == errs[0].split(" ", 2)[2], (str(e.value), errs)

    for extra in ({"behavior": _FLOCK_BEHAVIOR, "life": {"seconds": [1, 2], "maxDistance": 30}},
                  {"plate": _PLATE, "life": {"seconds": [1, 2], "maxDistance": 30}},
                  {"life": {"maxDistance": 30}}):
        d = json.loads(json.dumps(MINIMAL_EFFECT))
        d["emitters"][0].update(json.loads(json.dumps(extra)))
        warn: list[str] = []
        wb.normalize_effect(json.loads(json.dumps(d)), warn)
        wb_w = [w.split(": ", 1)[1] for w in warn if "maxDistance" in w]
        ed_w = [i.message.split(" ", 2)[2] for i in _issues_for_effects(tmp_path, {"zz_min": d})
                if i.severity == "warning" and "maxDistance" in i.message]
        assert wb_w and wb_w == ed_w, (wb_w, ed_w)

    # 唯一有意的差别：显式 null。工作台是写入者，从不写 null（检视器清空 = 删键），闸门拒；编辑器兜底按"未填"放过
    d = json.loads(json.dumps(MINIMAL_EFFECT))
    d["emitters"][0]["life"] = {"seconds": [1, 2], "maxDistance": None}
    with pytest.raises(ValueError):
        wb.normalize_effect(json.loads(json.dumps(d)))
    assert _issues_for_effects(tmp_path, {"zz_min": d}) == []


# --------------------------------------------------------------------------- #
# 素材存在性门：效果资产里的贴图引用真的被扫到了
# --------------------------------------------------------------------------- #

def test_effect_textures_are_inside_the_asset_existence_gate(tmp_path: Path) -> None:
    """效果资产的 `appearance.image` / `animFile` 必须进 asset_reference_audit 的扫描面。

    它不是靠 vfx 专用规则进去的，而是靠两条通用约定：效果资产落在 `assets/data/**`
    （审计对整棵 data 树递归），且这两个键名在 `_MEDIA_KEY_NAMES` / `_TEXT_KEY_NAMES` 里。
    两条里断任何一条，贴图路径写错都会**全绿通过**，运行时只是那个发射器不画——
    与"作者就没配"长得一模一样。所以这里正面钉住"扫到了"，而不是只跑一遍看它不报错。
    """
    from tools.editor.shared.asset_reference_audit import AuditReport, _audit_one_file
    from tools.editor.shared.project_paths import ProjectPaths

    root = repo_root_from_tests()
    paths = ProjectPaths(root)
    vfx_dir = Path(paths.vfx_dir)
    files = sorted(vfx_dir.glob("*.json"))
    assert files, f"仓库里一份效果资产都没有？{vfx_dir}"

    report = AuditReport(project_root=root)
    for jp in files:
        _audit_one_file(paths, jp, is_text_only=False, report=report)

    assert report.issues == [], [f"{i.file}:{i.field_path} {i.raw_value} — {i.reason}" for i in report.issues]

    resolved = {p.as_posix() for p in report.resolved_media} | {p.as_posix() for p in report.resolved_text}
    # 资产里写了多少个贴图引用，就应该解析出多少个落盘文件
    wanted: set[str] = set()
    for jp in files:
        doc = json.loads(jp.read_text(encoding="utf-8"))
        for em in doc.get("emitters") or []:
            ap = (em or {}).get("appearance") or {}
            for key in ("image", "animFile"):
                if isinstance(ap.get(key), str) and ap[key].strip():
                    wanted.add(ap[key].strip().lstrip("/"))
    assert wanted, "效果资产里一个贴图引用都没有？"
    for w in sorted(wanted):
        assert any(p.endswith(w) for p in resolved), \
            f"{w} 没被素材门解析到——写错这个路径不会有任何一道门报警"
