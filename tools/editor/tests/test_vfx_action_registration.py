"""世界空间粒子 / 群体（VFX）的登记面 + 往返 + 校验器契约。

四条 action（`playVfx` / `stopVfx` / `setVfxState` / `emitVfxField`）的登记面散在七处
（运行时 register / TS manifest / 编辑器 ACTION_TYPES 与 _PARAM_SCHEMAS / ACTION_PERSISTENCE /
过场白名单 / 校验器 / entity_refactor），漏哪一处报哪种错各不相同
（见 agent_docs runtime/mechanisms/action-registration-registry-surfaces.md）。
三方 parity 由既有护栏覆盖，本文件补它们盖不到的那几面，外加效果资产与场景实例的校验。

效果资产目录 `assets/data/vfx/` 与轨迹同一待遇：**唯一写者是 tools/vfx_workbench**，
主编辑器只读（候选 / 校验），这里钉死"没有脏桶、不进 save_all"。
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
        "playVfx": {"instanceId", "effect", "at", "x", "y", "h", "surface", "seed", "countScale"},
        "stopVfx": {"instanceId"},
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


def test_enums_mirror_the_ts_side() -> None:
    """三张短枚举与 TS `types.ts` 逐字对齐（改一处要改两处，这里是那道机械闸）。"""
    types_ts = (REPO / "src/data/types.ts").read_text("utf-8")
    assert "surface?: 'ground' | 'shell'" in types_ts
    assert "export type VfxFlockState = 'roosting' | 'airborne' | 'fleeing' | 'returning';" in types_ts
    assert "export type VfxFieldKind = 'fear' | 'attract' | 'wind';" in types_ts
    assert {v for v, _l in _VFX_SURFACES if v} == {"ground", "shell"}
    assert {v for v, _l in _VFX_FLOCK_STATES} == {"roosting", "airborne", "fleeing", "returning"}
    assert {v for v, _l in _VFX_FIELD_KINDS if v} == {"fear", "attract", "wind"}


def test_position_params_are_registered_as_entity_refs() -> None:
    """位置参数是位置引用：漏登记会让它对重构引擎与可达性校验**双双隐形**。"""
    from tools.editor.shared.entity_refactor import ENTITY_REF_PARAMS
    assert ENTITY_REF_PARAMS.get("playVfx", {}).get("at") == "position_ref"
    assert ENTITY_REF_PARAMS.get("emitVfxField", {}).get("at") == "position_ref"


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
    rows = dict(m.vfx_instance_ids_for_scene("崖墓前段"))
    assert "vfx_bats" in rows and "bat_cliff" in rows["vfx_bats"]
    assert m.vfx_instance_ids_for_scene(None) == []
    assert m.vfx_instance_ids_for_scene("不存在的场景") == []


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
    (lambda d: d.update(emitters=[]), "非空 emitters"),
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
