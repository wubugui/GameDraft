"""叙事状态机模板引擎测试：替换 / 抽取-盖章往返 / 撞名 / 校验 / 桩 schema / 格式保真。"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from tools.editor.file_io import _json_text
from tools.editor.project_model import ProjectModel
from tools.editor.shared.narrative_templates import (
    _build_dialogue_stub,
    extract_template,
    iter_placeholders,
    normalize_templates_file,
    stamp_template,
    substitute,
    validate_template,
    validate_templates_file,
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


# 一张最小但结构完整的作曲（含 mainGraph + dialogue/minigame blackbox 元件）。
def _mini_composition() -> dict:
    return {
        "id": "flow_淹尸活",
        "label": "背尸·淹尸活",
        "description": "接活→上肩→交尸",
        "mainGraph": {
            "id": "flow_淹尸活_graph",
            "ownerType": "flow",
            "ownerId": "淹尸活",
            "initialState": "initial",
            "states": {
                "initial": {"id": "initial"},
                "carrying": {"id": "carrying", "activePlane": "背尸"},
                "delivered": {"id": "delivered"},
            },
            "transitions": [
                {"id": "t1", "from": "initial", "to": "carrying", "signal": "淹尸活__shouldered"},
                {"id": "t2", "from": "carrying", "to": "delivered", "signal": "淹尸活__delivered"},
            ],
        },
        "elements": [
            {"id": "mg", "kind": "minigameBlackbox", "refId": "carry_drowned_corpse",
             "meta": {"emits": ["淹尸活__shouldered"]}},
            {"id": "dlg", "kind": "dialogueBlackbox", "refId": "寻狗_交尸",
             "meta": {"emits": ["淹尸活__delivered"]}},
        ],
    }


def _mini_specs() -> list[dict]:
    return [
        {"name": "taskId", "type": "identifier", "sample": "淹尸活", "required": True},
        {"name": "plane", "type": "planeRef", "sample": "背尸", "default": "背尸"},
        {"name": "minigame", "type": "minigameRef", "sample": "carry_drowned_corpse"},
        {"name": "deliverDlg", "type": "dialogueRef", "sample": "寻狗_交尸"},
    ]


# --------------------------------------------------------------------------- #
# 替换
# --------------------------------------------------------------------------- #
def test_substitute_string_and_typed():
    obj = {"id": "flow_{{taskId}}", "zoom": "{{zoom}}", "flag": "{{flag}}", "keep": "no holes"}
    out, unknown = substitute(obj, {"taskId": "枯尸", "zoom": 1.25, "flag": True})
    assert out["id"] == "flow_枯尸"
    assert out["zoom"] == 1.25  # 整串占位 + 非字符串值 → 保类型
    assert out["flag"] is True
    assert out["keep"] == "no holes"
    assert unknown == set()


def test_substitute_unknown_placeholder_preserved():
    out, unknown = substitute({"x": "{{a}}-{{b}}"}, {"a": "A"})
    assert out["x"] == "A-{{b}}"
    assert unknown == {"b"}


def test_iter_placeholders_covers_keys_and_values():
    found = iter_placeholders({"{{k}}": ["{{v}}", {"n": "{{w}}"}]})
    assert found == {"k", "v", "w"}


# --------------------------------------------------------------------------- #
# 抽取 → 盖章 往返不变式
# --------------------------------------------------------------------------- #
def test_extract_then_stamp_roundtrip_is_lossless():
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="beishi_arch")
    # 骨架里应只剩这些洞
    assert iter_placeholders(tpl["composition"]) == {"taskId", "plane", "minigame", "deliverDlg"}
    res = stamp_template(tpl, {
        "taskId": "淹尸活", "plane": "背尸", "minigame": "carry_drowned_corpse", "deliverDlg": "寻狗_交尸",
    })
    assert res["ok"], res["errors"]
    assert res["composition"] == comp  # 用原样值盖回 == 原作曲


def test_stamp_new_instance_signal_consistency():
    """信号命名铁律：盖章后 transition.signal 与 element.meta.emits 由同一次替换生成，永不错位。"""
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="beishi_arch")
    res = stamp_template(tpl, {
        "taskId": "枯尸活", "plane": "背尸", "minigame": "carry_drowned_corpse", "deliverDlg": "寻狗_枯交",
    })
    assert res["ok"], res["errors"]
    trans_sigs = {t["signal"] for t in res["composition"]["mainGraph"]["transitions"]}
    emit_sigs = set()
    for el in res["composition"]["elements"]:
        emit_sigs.update(el["meta"]["emits"])
    # 每个被监听的信号都有对应 emit（构造性一致）
    assert trans_sigs <= emit_sigs
    assert all(s.startswith("枯尸活__") for s in trans_sigs)
    assert "{{" not in json.dumps(res["composition"], ensure_ascii=False)


# --------------------------------------------------------------------------- #
# 撞名 / 必填 / 标识符
# --------------------------------------------------------------------------- #
def test_stamp_collision_detected():
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="beishi_arch")
    res = stamp_template(
        tpl, {"taskId": "淹尸活", "plane": "背尸", "minigame": "m", "deliverDlg": "d"},
        existing_composition_ids={"flow_淹尸活"},
    )
    assert not res["ok"]
    assert any(e["code"] == "stamp.collision.composition" for e in res["errors"])


def test_stamp_required_param_missing():
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="beishi_arch")
    res = stamp_template(tpl, {"plane": "背尸", "minigame": "m", "deliverDlg": "d"})
    assert not res["ok"]
    assert any(e["code"] == "stamp.param.required" for e in res["errors"])


def test_stamp_identifier_validation():
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="beishi_arch")
    res = stamp_template(tpl, {"taskId": "bad id!", "plane": "背尸", "minigame": "m", "deliverDlg": "d"})
    assert not res["ok"]
    assert any(e["code"] == "stamp.param.identifier" for e in res["errors"])


# --------------------------------------------------------------------------- #
# 对话桩 schema
# --------------------------------------------------------------------------- #
def test_dialogue_stub_schema_with_emit():
    g = _build_dialogue_stub("寻狗_接活", "接活", "枯尸活__accepted")
    assert g["schemaVersion"] == 1 and g["id"] == "寻狗_接活" and g["entry"] == "root"
    assert g["nodes"]["root"]["type"] == "line"
    assert g["nodes"]["root"]["next"] == "emit"
    act = g["nodes"]["emit"]["actions"][0]
    assert act["type"] == "emitNarrativeSignal"
    assert act["params"]["signal"] == "枯尸活__accepted"
    assert act["params"]["sourceId"] == "寻狗_接活"


def test_dialogue_stub_without_emit_is_terminal_line():
    g = _build_dialogue_stub("寻狗_闲聊", "闲聊", "")
    assert "emit" not in g["nodes"]
    assert "next" not in g["nodes"]["root"]


# --------------------------------------------------------------------------- #
# 模板文件校验（占位符感知）
# --------------------------------------------------------------------------- #
def test_validate_flags_undeclared_and_unused_params():
    tpl = {
        "id": "t1",
        "params": [{"name": "used", "type": "text"}, {"name": "never", "type": "text"}],
        "composition": {"id": "{{used}}", "x": "{{ghost}}"},
    }
    issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    codes = {i["code"] for i in issues}
    assert "template.param.undeclared" in codes  # ghost 用了没声明
    assert "template.param.unused" in codes      # never 声明了没用


def test_validate_bound_param_without_hole_is_error():
    """实体推导参数没在骨架里挖到洞 = 每个实体盖出同一份产物：升 error 拦在保存前。

    可证伪的坏：第一份静默绑到样本实体身上（策划选 B、产出 A 的图，ok=True 零警告），
    第二份起作曲 id 撞名整批作废。普通未用参数仍只是 warning。
    """
    tpl = {
        "id": "t1",
        "params": [
            {"name": "ownerId", "type": "identifier", "from": "entity.id"},
            {"name": "闲置", "type": "text"},
        ],
        "composition": {"id": "wrap_常量名"},  # 没有 {{ownerId}} 洞
    }
    issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    bound = [i for i in issues if i["code"] == "template.param.unused.bound"]
    assert bound and bound[0]["severity"] == "error", issues
    assert "ownerId" in bound[0]["message"]
    # 没绑 from 的闲置参数不受影响，仍是 warning
    plain = [i for i in issues if i["code"] == "template.param.unused"]
    assert plain and plain[0]["severity"] == "warning", issues

    # 骨架里挖了洞就零问题
    tpl["composition"] = {"id": "wrap_{{ownerId}}"}
    ok_issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    assert not [i for i in ok_issues if i["code"] == "template.param.unused.bound"], ok_issues


def test_same_from_bound_twice_is_error():
    """同一来源绑多个参数 = 批量盖章把它们填成同一个值 → 一个实体挂出多份产物。

    真实形状：站在母图上抽模板，母图挂着两张各绑不同实体的 wrapper，两条 ownerId 都被
    参数化；盖给一个 npc 时两条都填成它，`npc:X` 下两张图（owner 歧义）+ `hotspot:X`
    那张永远收不到信号。ok=True 零提示，只能靠校验拦。
    """
    tpl = {
        "id": "t1",
        "params": [
            {"name": "ownerId", "type": "identifier", "from": "entity.id"},
            {"name": "ownerId2", "type": "identifier", "from": "entity.id"},
        ],
        "composition": {"id": "a_{{ownerId}}_{{ownerId2}}"},
    }
    issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    dup = [i for i in issues if i["code"] == "template.param.from.duplicate"]
    assert dup and dup[0]["severity"] == "error", issues
    assert "ownerId" in dup[0]["message"] and "ownerId2" in dup[0]["message"]

    # 一个来源一个参数 = 正常
    tpl["params"][1]["from"] = "entity.kind"
    ok_issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    assert not [i for i in ok_issues if i["code"] == "template.param.from.duplicate"], ok_issues


def test_non_identity_sources_may_bind_several_params():
    """只有 entity.id 不许绑两次；显示名绑两处是正当需求，拦了会逼作者手写重复内容。

    真实形状：图 label 与镜像任务标题都用实体显示名——两个参数、同一个来源、同一个值，
    正是想要的效果。
    """
    tpl = {
        "id": "t1",
        "params": [
            {"name": "ownerId", "type": "identifier", "from": "entity.id"},
            {"name": "label", "type": "text", "from": "entity.label"},
            {"name": "questTitle", "type": "text", "from": "entity.label"},
        ],
        "composition": {"id": "w_{{ownerId}}", "label": "{{label}}"},
        "quest": {"id": "q_{{ownerId}}", "title": "{{questTitle}}"},
        "produces": ["composition", "quest"],
    }
    issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
    assert not [i for i in issues if i["code"] == "template.param.from.duplicate"], issues


def test_optional_bound_param_is_error_only_on_owner_fields():
    """只有喂 owner 字段的推导参数才必须必填。

    ownerType/ownerId 拼出运行时 owner 索引键，空串 = 那张图谁也找不到（私有信号收不到）；
    显示名之类为空只是画布上没名字——拦它是过度概括，会把正当模板堵死。
    """
    def issues_for(param: dict, owner_type: str) -> list[dict]:
        tpl = {
            "id": "t",
            "params": [{"name": "ownerId", "type": "identifier", "from": "entity.id", "required": True}, param],
            "composition": {
                "id": "wrap_{{ownerId}}",
                "label": "{{%s}}" % param["name"],
                "mainGraph": {
                    "id": "wrap_{{ownerId}}", "ownerType": owner_type, "ownerId": "{{ownerId}}",
                    "initialState": "a", "states": {"a": {"id": "a"}}, "transitions": [],
                },
            },
        }
        return [i for i in validate_templates_file({"schemaVersion": 1, "templates": [tpl]})
                if i["code"] == "template.param.from.optional"]

    # 只当显示名用 → 放行
    assert not issues_for({"name": "label", "type": "text", "from": "entity.label"}, "hotspot")
    # 喂 ownerType → 必须必填
    bad = issues_for({"name": "ownerType", "type": "text", "from": "entity.kind"}, "{{ownerType}}")
    assert bad and bad[0]["severity"] == "error", bad
    # 给了默认值就放行（作者显式表达过缺省）
    assert not issues_for(
        {"name": "ownerType", "type": "text", "from": "entity.kind", "default": "hotspot"},
        "{{ownerType}}",
    )


def test_stamp_collision_message_names_real_params_not_taskId():
    """撞名提示按模板**实际参数**给建议：实体绑定型模板没有 taskId，甩「换个 taskId」等于没说。"""
    tpl = normalize_templates_file({"templates": [{
        "id": "pick",
        "params": [{"name": "ownerId", "type": "identifier", "from": "entity.id"}],
        "composition": {"id": "wrap_{{ownerId}}", "mainGraph": {
            "id": "wrap_{{ownerId}}", "ownerType": "hotspot", "ownerId": "{{ownerId}}",
            "initialState": "s", "states": {"s": {"id": "s"}}, "transitions": [],
        }},
    }]})["templates"][0]
    res = stamp_template(tpl, {"ownerId": "箱子1"}, existing_composition_ids={"wrap_箱子1"})
    assert not res["ok"]
    msg = res["errors"][0]["message"]
    assert "taskId" not in msg, msg
    assert "ownerId" in msg, msg


def test_validate_missing_composition_is_error():
    issues = validate_templates_file({"templates": [{"id": "t1", "params": []}]})
    assert any(i["code"] == "template.composition.missing" and i["severity"] == "error" for i in issues)


def test_validate_duplicate_id_is_error():
    data = {"templates": [
        {"id": "dup", "composition": {"id": "a"}},
        {"id": "dup", "composition": {"id": "b"}},
    ]}
    issues = validate_templates_file(data)
    assert any(i["code"] == "template.id.duplicate" for i in issues)


def test_normalize_drops_invalid_and_dedups():
    data = {"templates": [
        {"id": "keep", "composition": {}},
        {"nope": 1},          # 无 id → 丢
        {"id": "keep", "composition": {}},  # 重复 id → 丢后一个
        "garbage",
    ]}
    norm = normalize_templates_file(data)
    assert [t["id"] for t in norm["templates"]] == ["keep"]
    assert norm["schemaVersion"] == 1


# --------------------------------------------------------------------------- #
# 真项目：种子模板存在、干净、可盖章、格式保真
# --------------------------------------------------------------------------- #
def test_seed_template_file_is_clean():
    path = _repo_root() / "public" / "assets" / "data" / "narrative_templates.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    issues = validate_templates_file(data)
    errors = [i for i in issues if i["severity"] == "error"]
    assert not errors, errors
    assert not issues, issues  # 种子应零 warning


def test_seed_template_file_format_fidelity():
    """种子文件经 normalize + write 后逐字节不变（黄金往返契约）。"""
    path = _repo_root() / "public" / "assets" / "data" / "narrative_templates.json"
    orig = path.read_text(encoding="utf-8")
    out = _json_text(normalize_templates_file(json.loads(orig)))
    assert orig == out


def test_seed_template_stamps_against_live_project():
    root = _repo_root()
    model = ProjectModel()
    model.load_project(root)
    templates = normalize_templates_file(model.narrative_templates)["templates"]
    assert templates, "种子模板应已登记"
    tpl = templates[0]
    ng = json.loads((root / "public/assets/data/narrative_graphs.json").read_text(encoding="utf-8"))
    existing_comp = {c["id"] for c in ng.get("compositions", []) if isinstance(c, dict)}
    existing_q = {q[0] for q in model.all_quest_ids()}
    existing_dlg = set(model.all_dialogue_graph_ids())
    res = stamp_template(
        tpl,
        {"taskId": "测试单元尸活", "compositionLabel": "背尸·单测", "plane": "背尸",
         "shoulderMinigame": "carry_drowned_corpse",
         "acceptDialogue": "单测_接活", "deliverDialogue": "单测_交尸",
         "questTitle": "背单测尸去义庄"},
        existing_composition_ids=existing_comp,
        existing_quest_ids=existing_q,
        existing_dialogue_ids=existing_dlg,
        generate_dialogue_stubs=True,
    )
    assert res["ok"], res["errors"]
    assert res["compositionId"] == "beishi_测试单元尸活_flow"
    assert res["questId"] == "背尸-测试单元尸活"
    assert "{{" not in json.dumps(res["composition"], ensure_ascii=False)
    assert "{{" not in json.dumps(res["quest"], ensure_ascii=False)
    # 两个新对话桩（accept/deliver），都不存在于现有图集里
    assert [s["id"] for s in res["dialogueStubs"]] == ["单测_接活", "单测_交尸"]
    assert all(not s["exists"] for s in res["dialogueStubs"])


def test_project_model_template_roundtrip_and_ids():
    root = _repo_root()
    model = ProjectModel()
    model.load_project(root)
    ids = model.all_narrative_template_ids()
    assert ("beishi_carry_archetype", "背尸零活模板") in ids
    # normalize 幂等
    assert normalize_templates_file(model.narrative_templates) == model.narrative_templates


def test_chinese_param_name_roundtrip():
    """中文参数名全链路：抽取造出 {{中文洞}}，盖章能填上（历史 bug：regex 只认 ASCII）。"""
    comp = _mini_composition()
    specs = [{"name": "任务名", "type": "identifier", "sample": "淹尸活", "required": True}]
    tpl = extract_template(comp, specs, template_id="t_cn")
    assert "{{任务名}}" in json.dumps(tpl["composition"], ensure_ascii=False)
    assert iter_placeholders(tpl["composition"]) == {"任务名"}
    res = stamp_template(tpl, {"任务名": "吊尸活"})
    assert res["ok"], res["errors"]
    assert res["composition"]["id"] == "flow_吊尸活"
    assert "{{" not in json.dumps(res["composition"], ensure_ascii=False)
    # 原样值盖回 == 原作曲
    back = stamp_template(tpl, {"任务名": "淹尸活"})
    assert back["composition"] == comp


def test_invalid_param_name_is_error():
    """带空格/标点/数字开头的参数名 = error（替换引擎认不出这种洞，禁止保存）。"""
    for bad in ("task id", "1abc", "a-b", "名字!"):
        tpl = {"id": "t1", "params": [{"name": bad, "type": "text"}], "composition": {"id": "x"}}
        issues = validate_template(normalize_templates_file({"templates": [tpl]})["templates"][0])
        assert any(i["code"] == "template.param.name" and i["severity"] == "error" for i in issues), bad


def test_stamp_rejects_unsafe_dialogue_stub_id():
    """对话桩 id 即文件名：含 / \\ .. 或以 . 开头 = error（防写出目录外/写进扫不到的子目录）。"""
    comp = _mini_composition()
    tpl = extract_template(comp, _mini_specs(), template_id="a",
                           dialogue_stubs=[{"id": "{{deliverDlg}}", "emitSignal": "淹尸活__delivered"}])
    for bad in ("../越界", "子目录/图", "a\\b", ".隐藏"):
        res = stamp_template(tpl, {"taskId": "新活", "plane": "背尸", "minigame": "m", "deliverDlg": bad})
        assert any(e["code"] == "stamp.dialogue.badId" for e in res["errors"]), bad
        assert not res["ok"]
    ok = stamp_template(tpl, {"taskId": "新活", "plane": "背尸", "minigame": "m", "deliverDlg": "正常图"})
    assert ok["ok"], ok["errors"]


def test_stamp_signal_collision_is_error():
    """模板声明的新信号与既有信号注册表重名 = error 禁止盖章（防跨任务串线）。"""
    comp = _mini_composition()
    tpl = extract_template(
        comp, _mini_specs(), template_id="a",
        signals=[{"id": "淹尸活__shouldered", "label": "上肩"}],
    )
    res = stamp_template(
        tpl, {"taskId": "夜活", "plane": "背尸", "minigame": "m", "deliverDlg": "d"},
        existing_signal_ids={"夜活__shouldered"},
    )
    assert any(e["code"] == "stamp.collision.signal" for e in res["errors"])
    assert not res["ok"]
    # 不撞时照常通过
    res2 = stamp_template(
        tpl, {"taskId": "夜活", "plane": "背尸", "minigame": "m", "deliverDlg": "d"},
        existing_signal_ids={"别家任务__accepted"},
    )
    assert res2["ok"], res2["errors"]


def test_validate_data_warns_raw_file_duplicate_ids(tmp_path):
    """手改文件里的重复模板 id：validate-data 必须读原始磁盘文件报警（模型加载已静默去重）。"""
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project
    from tools.editor import validator as v

    root = tmp_path / "proj"
    write_minimal_loadable_project(root)
    dup_file = {
        "schemaVersion": 1,
        "templates": [
            {"id": "dup", "label": "第一个", "params": [], "composition": {"id": "a"}},
            {"id": "dup", "label": "第二个", "params": [], "composition": {"id": "b"}},
        ],
    }
    (root / "public/assets/data/narrative_templates.json").write_text(
        json.dumps(dup_file, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    model = ProjectModel()
    model.load_project(root)
    # 加载后模型里只剩一条（静默去重）——警告必须仍能报出来
    assert len(model.narrative_templates["templates"]) == 1
    issues = v.validate(model)
    hits = [i for i in issues if i.data_type == "narrative_template" and "重复" in i.message]
    assert hits, "validate-data 应对原始文件里的重复模板 id 报警"
    assert hits[0].severity == "warning"


def _write_stub_test_project(tmp_path):
    """极小工程 + 一个带 quest/对话桩的模板，供盖章暂存语义测试。"""
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "proj"
    write_minimal_loadable_project(root)
    tpl_file = {
        "schemaVersion": 1,
        "templates": [{
            "id": "t_stage",
            "label": "暂存测试",
            "params": [{"name": "taskId", "type": "identifier", "required": True}],
            "signals": [{"id": "{{taskId}}__done"}],
            "composition": {
                "id": "c_{{taskId}}",
                "mainGraph": {
                    "id": "flow_{{taskId}}", "ownerType": "flow", "initialState": "a",
                    "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                    "transitions": [{"id": "t1", "from": "a", "to": "b", "signal": "{{taskId}}__done"}],
                },
                "elements": [{"id": "dlg", "kind": "dialogueBlackbox", "refId": "{{taskId}}_对话",
                              "meta": {"emits": ["{{taskId}}__done"]}}],
            },
            "quest": {"id": "q_{{taskId}}", "group": "g", "type": "side", "title": "t",
                      "preconditions": [],
                      "completionConditions": [{"narrative": "flow_{{taskId}}", "state": "b", "reached": True}],
                      "rewards": [], "nextQuests": []},
            "dialogueStubs": [{"id": "{{taskId}}_对话", "title": "{{taskId}}", "emitSignal": "{{taskId}}__done"}],
        }],
    }
    (root / "public/assets/data/narrative_templates.json").write_text(
        json.dumps(tpl_file, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return root


def test_stamp_stages_all_or_nothing_and_save_all_commits(tmp_path):
    """盖章 = 三样一并暂存、零磁盘写入；Save All 一次性落盘全部（全有全无，无孤儿）。"""
    from PySide6.QtWidgets import QApplication
    if QApplication.instance() is None:
        QApplication([])
    from tools.editor.editors.narrative_state_editor import NarrativeEditorBridge

    root = _write_stub_test_project(tmp_path)
    model = ProjectModel()
    model.load_project(root)
    bridge = NarrativeEditorBridge(model)

    ng_path = root / "public/assets/data/narrative_graphs.json"
    quests_path = root / "public/assets/data/quests.json"
    stub_path = root / "public/assets/dialogues/graphs/新活_对话.json"
    quests_disk_before = quests_path.read_text(encoding="utf-8")

    current = json.loads(bridge.getData())
    resp = json.loads(bridge.stampTemplate(json.dumps({
        "templateId": "t_stage", "values": {"taskId": "新活"},
        "currentNarrative": current, "generateDialogueStubs": True, "dryRun": False,
    }, ensure_ascii=False)))
    assert resp["ok"], resp
    assert resp["summary"]["questStaged"] is True
    assert resp["summary"]["stubsStaged"] == ["新活_对话"]

    # 盖章时刻：零磁盘写入（narrative_graphs 不存在 / quests 原样 / 无桩文件）
    assert not ng_path.exists()
    assert quests_path.read_text(encoding="utf-8") == quests_disk_before
    assert not stub_path.exists()
    # 但三样都已暂存进模型，脏键正确（save_all 认 "quest" 单数——标错键会无声丢任务）
    assert any(c.get("id") == "c_新活" for c in model.narrative_graphs["compositions"])
    assert any(q.get("id") == "q_新活" for q in model.quests)
    assert "新活_对话" in model.pending_dialogue_stubs
    assert {"narrative_graphs", "quest", "dialogue_stubs"} <= model._dirty

    # Save All：一次性全部落盘
    model.save_all()
    assert any(c.get("id") == "c_新活" for c in json.loads(ng_path.read_text(encoding="utf-8"))["compositions"])
    assert any(q.get("id") == "q_新活" for q in json.loads(quests_path.read_text(encoding="utf-8")))
    stub = json.loads(stub_path.read_text(encoding="utf-8"))
    assert stub["nodes"]["emit"]["actions"][0]["params"]["signal"] == "新活__done"
    assert model.pending_dialogue_stubs == {}
    assert not model.is_dirty

    # 全无路径：撞名盖章失败 = 模型零变化
    n_comps = len(model.narrative_graphs["compositions"])
    n_quests = len(model.quests)
    resp2 = json.loads(bridge.stampTemplate(json.dumps({
        "templateId": "t_stage", "values": {"taskId": "新活"},
        "currentNarrative": json.loads(bridge.getData()), "generateDialogueStubs": True, "dryRun": False,
    }, ensure_ascii=False)))
    assert not resp2["ok"]
    assert len(model.narrative_graphs["compositions"]) == n_comps
    assert len(model.quests) == n_quests
    assert model.pending_dialogue_stubs == {}
    assert not model.is_dirty


def test_pending_stub_never_overwrites_existing(tmp_path):
    """暂存桶落盘只写新文件：既有对话图（策划手作）绝不被覆盖。"""
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "proj"
    write_minimal_loadable_project(root)
    graphs_dir = root / "public/assets/dialogues/graphs"
    graphs_dir.mkdir(parents=True, exist_ok=True)
    precious = {"schemaVersion": 1, "id": "已有图", "entry": "root",
                "nodes": {"root": {"type": "line", "speaker": {"kind": "literal", "name": "旁白"}, "text": "手作内容"}}}
    target = graphs_dir / "已有图.json"
    target.write_text(json.dumps(precious, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    before = target.read_text(encoding="utf-8")

    model = ProjectModel()
    model.load_project(root)
    model.pending_dialogue_stubs["已有图"] = {"id": "已有图", "nodes": {}}
    model.pending_dialogue_stubs["../越界"] = {"id": "x"}  # 防御：坏 id 直接跳过
    model.mark_dirty("dialogue_stubs")
    with pytest.raises(OSError):
        model.save_all()
    assert target.read_text(encoding="utf-8") == before
    assert not (root / "public/assets/dialogues/越界.json").exists()
    assert "已有图" in model.pending_dialogue_stubs
    assert model.is_dirty


def test_save_all_template_roundtrip_byte_identical(tmp_path):
    """经真实 save_all 写盘：narrative_templates.json 逐字节不变（黄金往返）。"""
    from tools.editor.tests.save_test_utils import file_sha256, write_minimal_loadable_project

    root = tmp_path / "proj"
    write_minimal_loadable_project(root)
    seed = (_repo_root() / "public/assets/data/narrative_templates.json").read_text(encoding="utf-8")
    tpl_path = root / "public/assets/data/narrative_templates.json"
    tpl_path.write_text(seed, encoding="utf-8")

    model = ProjectModel()
    model.load_project(root)
    before = file_sha256(tpl_path)
    model.mark_dirty("narrative_templates")
    model.save_all()
    after = file_sha256(tpl_path)
    assert before == after
    assert tpl_path.read_text(encoding="utf-8") == seed


def test_signal_scope_survives_normalize_then_stamp():
    """终审复审 G-3：B3 修复行（normalize 保 scope）此前零护栏——判据改坏 59 条测试全绿。

    锁死真实链路：磁盘形状的模板文件 → normalize_templates_file → stamp_template，
    private 全程存活；'global' 是缺省语义**不落键**（保模板文件字节级往返）。
    """
    raw = {"templates": [{
        "id": "tpl_box", "label": "箱子壳",
        "params": [{"name": "taskId"}],
        "signals": [
            {"id": "{{taskId}}__opened", "scope": "private"},
            {"id": "{{taskId}}__done", "scope": "global"},
            {"id": "{{taskId}}__plain"},
        ],
        "composition": {"id": "comp_{{taskId}}", "mainGraph": {
            "id": "g_{{taskId}}", "initialState": "a", "states": {"a": {"id": "a"}},
            "transitions": [],
        }},
    }]}
    tpl = normalize_templates_file(raw)["templates"][0]
    rows = {r["id"]: r for r in tpl["signals"]}
    assert rows["{{taskId}}__opened"].get("scope") == "private", "normalize 丢了 private scope（B3 回归）"
    assert "scope" not in rows["{{taskId}}__done"], "global 必须归缺省不落键（字节往返）"
    assert "scope" not in rows["{{taskId}}__plain"]

    res = stamp_template(tpl, {"taskId": "箱子1"})
    assert res["ok"], res["errors"]
    out = {r["id"]: r for r in res["signals"]}
    assert out["箱子1__opened"].get("scope") == "private", "盖章产物丢了 private scope"
    assert "scope" not in out["箱子1__done"]


def test_template_signal_scope_typo_is_error_not_silent_fallopen():
    """终审复审 Z-2：scope 拼写错（PRIVATE/priv/…）此前被 normalize 静默丢键成全局广播。

    与 narrative_graphs 通道的 signal.scope.invalid 对齐：模板通道也必须 error 拦下；
    缺键 / 显式 null / 合法两值不响。
    """
    def _file_with_scope(scope) -> dict:
        row: dict = {"id": "{{taskId}}__opened"}
        if scope is not ...:
            row["scope"] = scope
        return {"templates": [{
            "id": "tpl_box", "params": [{"name": "taskId"}],
            "signals": [row],
            "composition": {"id": "comp_{{taskId}}", "mainGraph": {
                "id": "g_{{taskId}}", "initialState": "a", "states": {"a": {"id": "a"}},
                "transitions": [],
            }},
        }]}

    for bad in ("PRIVATE", "Private", "priv", "local", ""):
        issues = validate_templates_file(_file_with_scope(bad))
        codes = [i["code"] for i in issues]
        assert "template.signal.scope.invalid" in codes, f"scope={bad!r} 该 error 没响"
        bad_rows = [i for i in issues if i["code"] == "template.signal.scope.invalid"]
        assert bad_rows[0]["severity"] == "error"
    for ok in ("private", "global", None, ...):
        issues = validate_templates_file(_file_with_scope(ok))
        assert "template.signal.scope.invalid" not in [i["code"] for i in issues], f"scope={ok!r} 误报"


def test_extract_bundles_and_parameterizes_quest():
    comp = _mini_composition()
    quest = {"id": "背尸-淹尸活", "title": "拉个泡涨的", "completionConditions": [
        {"narrative": "flow_淹尸活_graph", "state": "delivered", "reached": True}]}
    specs = _mini_specs()
    tpl = extract_template(comp, specs, template_id="a", quest=quest)
    # quest 里的样值也被换成洞
    assert "{{taskId}}" in json.dumps(tpl["quest"], ensure_ascii=False)
    res = stamp_template(tpl, {"taskId": "淹尸活", "plane": "背尸", "minigame": "m", "deliverDlg": "d"})
    assert res["quest"] == quest  # 往返还原
