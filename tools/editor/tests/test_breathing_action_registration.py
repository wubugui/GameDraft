"""呼吸图三条动作（showBreathingOverlay / breathingPerform / setBreathingParams）的编辑器侧契约。

登记面清单见 agent_docs `runtime/mechanisms/action-registration-registry-surfaces.md`；三方 parity
（运行时 register ↔ ACTION_TYPES ↔ TS manifest）由既有护栏覆盖，本文件补它们盖不到的面：

1. 授权面：ACTION_TYPES / _PARAM_SCHEMAS / 持久化档 / 内容 id 宇宙（json_lang + 选择器 + 叙事关联）/
   act 枚举与 TS `BREATHING_ACTS` 对账 / 可选参数的往返剔除表；
2. 往返：最小形态与填满形态逐字节不漂（int 不漂 float、参数表里的未知键 / 非数值 / 越界值 / 坏形态原样）；
3. 控件：句柄走下拉（候选 = 全工程 showBreathingOverlay 写过的句柄，hideOverlayImage 也带上），
   呼吸图走资产选择器，act 走短枚举，params 走专用行表——**参数名 / 中文名 / 分组现读
   src/data/breathingParams.json**，增删改都从控件入口进；
4. 校验器：资产不存在 / act 不认识 / 百分比不是数 / 参数名不认识 / 值不是数 → error，越界 → warning；
   资产文件本身按 TS `resolveBreathingOverlay` 的拒收条件查；素材审计收图层与位移场（打包闭包的来源）。
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

from PySide6.QtWidgets import QApplication, QLineEdit  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT,
    _OMIT_WHEN_ABSENT_AND_DEFAULT,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
    ActionEditor,
    FilterableTypeCombo,
)
from tools.editor.shared.breathing_params import BREATHING_ACT_ROWS, breathing_param_defs  # noqa: E402
from tools.editor.shared.breathing_params_field import BreathingParamsField  # noqa: E402
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402

ACTS = ("showBreathingOverlay", "breathingPerform", "setBreathingParams")
ASSET = "dream_face_paper"


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
        self.ed = ActionEditor("t")
        self.ed.set_project_context(model, None)
        self.ed.set_data([copy.deepcopy(act)])

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        self.ed.deleteLater()

    def w(self, name: str):
        return self.ed._rows[0]._param_widgets[name]

    def save(self) -> dict:
        out = self.ed.to_list()
        assert len(out) == 1
        return out[0]


def _dumps(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _roundtrip(model: ProjectModel, act: dict) -> dict:
    with _Open(model, act) as o:
        return o.save()


def _schema_json() -> dict:
    return json.loads((_ROOT / "src/data/breathingParams.json").read_text("utf-8"))


# --------------------------------------------------------------------------- #
# 登记面
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("act", ACTS)
def test_registered_on_every_editor_surface(act: str) -> None:
    assert act in ACTION_TYPES and act in CONTENT_ACTION_TYPES, "编辑器类型下拉里选不到"
    assert act in _PARAM_SCHEMAS, "参数编辑不出来"
    # 纯表演：BreathingOverlaySystem 不入存档（与 showOverlayImage 同档）
    assert ACTION_PERSISTENCE.get(act) == "memory"


def test_schema_param_names_match_runtime_register_and_manifest() -> None:
    reg = (_ROOT / "src/core/ActionRegistry.ts").read_text("utf-8")
    man = (_ROOT / "src/core/actionParamManifest.ts").read_text("utf-8")
    for act in ACTS:
        at = reg.index(f"executor.register('{act}'")
        tail = reg[at:]
        names_m = re.search(r"\},\s*\[([^\]]*)\]\);", tail)
        assert names_m, act
        runtime_names = re.findall(r"'([^']+)'", names_m.group(1))
        assert [n for n, _k in _PARAM_SCHEMAS[act]] == runtime_names, act
        assert f"  {act}: {{" in man, f"{act} 未收录进 ACTION_PARAM_MANIFEST"


def test_same_host_policy_as_show_overlay_image() -> None:
    """与 showOverlayImage 同一宿主口径：不在过场白名单里（过场里用叠图也是走动作批）。"""
    allow = json.loads((_ROOT / "src/data/cutscene_action_allowlist.json").read_text("utf-8"))
    assert "showOverlayImage" not in allow
    for act in ACTS:
        assert act not in allow


def test_act_rows_match_runtime_breathing_acts() -> None:
    """act 的五档是手工镜像：TS `BREATHING_ACTS` 加 / 改一档，这里当场红。"""
    ts = (_ROOT / "src/systems/breathing/BreathingOverlaySystem.ts").read_text("utf-8")
    m = re.search(r"export const BREATHING_ACTS[^=]*=\s*\[([^\]]*)\]", ts)
    assert m, "BreathingOverlaySystem.ts 里找不到 BREATHING_ACTS"
    assert [v for v, _l in BREATHING_ACT_ROWS] == re.findall(r"'([^']+)'", m.group(1))
    assert [lab for _v, lab in BREATHING_ACT_ROWS] == ["恢复呼吸", "渐弱至停", "猛抽一口气", "立刻停住", "从头来"]


def test_content_id_universe_is_registered_everywhere() -> None:
    from tools.json_lang.id_universes import collect_id_universes
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS
    from tools.narrative_xref.targets import TARGET_SPECS

    assert CONTENT_ID_PARAMS.get(("showBreathingOverlay", "breathing")) == "breathing_overlays"
    assert _SELECTOR_KIND_UNIVERSE.get("breathing_overlay") == "breathing_overlays"
    assert "breathing_overlays" in TARGET_SPECS
    ud = collect_id_universes(_ROOT)
    assert ASSET in ud.ids.get("breathing_overlays", []), "json_lang 的呼吸图宇宙里没有真资产"


def test_optional_params_are_covered_by_a_roundtrip_table() -> None:
    """wait / durationMs 进**作用域**剔除表（通用词，进全局表会误伤）；order 走带「不写」档的可选数值控件。"""
    assert _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT.get(("breathingPerform", "wait")) is False
    assert _ACTION_SCOPED_OMIT_WHEN_ABSENT_AND_DEFAULT.get(("setBreathingParams", "durationMs")) == 0
    for name in ("wait", "durationMs", "order"):
        assert name not in _OMIT_WHEN_ABSENT_AND_DEFAULT
    assert dict(_PARAM_SCHEMAS["showBreathingOverlay"])["order"] == "optional_number"


# --------------------------------------------------------------------------- #
# 往返
# --------------------------------------------------------------------------- #

_FORMS = [
    {"type": "showBreathingOverlay", "params": {
        "id": "zz_face", "breathing": ASSET, "xPercent": 50, "yPercent": 40.5, "widthPercent": 60}},
    {"type": "showBreathingOverlay", "params": {
        "id": "zz_face", "breathing": ASSET, "xPercent": 12.345, "yPercent": 0, "widthPercent": 100, "order": -3}},
    # 越界的百分比不夹、悬垂资产保值
    {"type": "showBreathingOverlay", "params": {
        "id": "zz_face", "breathing": "绝不存在的呼吸图", "xPercent": 120, "yPercent": -5, "widthPercent": 40}},
    {"type": "breathingPerform", "params": {"id": "zz_face", "act": "fadeOut"}},
    {"type": "breathingPerform", "params": {"id": "zz_face", "act": "gasp", "wait": True}},
    {"type": "breathingPerform", "params": {"id": "zz_face", "act": "breathe", "wait": False}},
    {"type": "breathingPerform", "params": {"id": "zz_face", "act": "未知档"}},
    {"type": "setBreathingParams", "params": {"id": "zz_face", "params": {}}},
    {"type": "setBreathingParams", "params": {"id": "zz_face", "params": {
        "ti": 5, "lag": 1.5, "damp": 0.18, "zz_unknown": 3, "volume": "loud", "vent": 99.25,
        "gaspT": 1.0, "edge": 1.8000000000000003}, "durationMs": 1200}},
    {"type": "setBreathingParams", "params": {"id": "zz_face", "params": {"ti": 2.7}, "durationMs": 0}},
    {"type": "setBreathingParams", "params": {"id": "zz_face", "params": "不是对象"}},
    {"type": "setBreathingParams", "params": {"id": "zz_face", "params": None}},
    {"type": "hideOverlayImage", "params": {"id": "zz_face"}},
]


@pytest.mark.parametrize("act", _FORMS, ids=[f"{a['type']}-{i}" for i, a in enumerate(_FORMS)])
def test_forms_roundtrip_byte_for_byte(model, act) -> None:
    assert _dumps(_roundtrip(model, act)) == _dumps(act)


@pytest.mark.parametrize("act", _FORMS[:10], ids=[f"{a['type']}-{i}" for i, a in enumerate(_FORMS[:10])])
def test_unknown_top_level_key_survives(model, act) -> None:
    act = copy.deepcopy(act)
    act["params"]["zz_future"] = {"keep": [1, 2]}
    assert _roundtrip(model, act)["params"]["zz_future"] == {"keep": [1, 2]}


def test_wait_unchecked_and_duration_zero_do_not_write_keys(model) -> None:
    with _Open(model, {"type": "breathingPerform", "params": {"id": "a", "act": "gasp", "wait": True}}) as o:
        o.w("wait").setChecked(False)
        assert "wait" not in o.save()["params"], "清回不勾 = 不写键（与运行时缺省同义）"
    with _Open(model, {"type": "setBreathingParams", "params": {"id": "a", "params": {}, "durationMs": 800}}) as o:
        o.w("durationMs").setValue(0)
        assert "durationMs" not in o.save()["params"]


# --------------------------------------------------------------------------- #
# 控件
# --------------------------------------------------------------------------- #

def test_widgets_follow_the_selector_rule(model) -> None:
    with _Open(model, _FORMS[0]) as o:
        assert isinstance(o.w("id"), FilterableTypeCombo) and o.w("id").isEditable(), "句柄可手输（开放命名空间）"
        sel = o.w("breathing")
        assert isinstance(sel, IdRefSelector)
        assert getattr(sel, "_content_id_universe", None) == "breathing_overlays"
    with _Open(model, _FORMS[3]) as o:
        act = o.w("act")
        assert isinstance(act, FilterableTypeCombo) and not act.isEditable(), "act 是短枚举下拉"
        vals = [act.itemData(i) for i in range(act.count())]
        assert [v for v, _l in BREATHING_ACT_ROWS] == [v for v in vals if v]
    with _Open(model, _FORMS[8]) as o:
        assert isinstance(o.w("params"), BreathingParamsField)
        assert not any(type(w) is QLineEdit for w in o.ed._rows[0]._param_widgets.values())


def test_handle_candidates_come_from_show_breathing_overlay(model) -> None:
    """句柄候选 = 全工程 showBreathingOverlay 写过的 id；hideOverlayImage 的下拉也带上它（同一套句柄）。"""
    quest = {"id": "zz_probe_quest", "acceptActions": [
        {"type": "runActions", "params": {"actions": [
            {"type": "showBreathingOverlay", "params": {
                "id": "zz_probe_handle", "breathing": ASSET, "xPercent": 50, "yPercent": 50, "widthPercent": 40}},
        ]}},
    ]}
    model.quests.append(quest)
    try:
        def values(combo: FilterableTypeCombo) -> list[str]:
            return [combo.itemData(i) for i in range(combo.count())]

        with _Open(model, {"type": "hideOverlayImage", "params": {"id": "x"}}) as o:
            assert "zz_probe_handle" in values(o.w("id"))
        for act in ("breathingPerform", "setBreathingParams"):
            with _Open(model, {"type": act, "params": {"id": ""}}) as o:
                assert "zz_probe_handle" in values(o.w("id"))
                assert o.w("id").committed_type() == "", "新行不许被静默填成别处的句柄"
    finally:
        model.quests.remove(quest)


def test_params_editor_reads_the_schema_json(app) -> None:
    """参数菜单的分组、键、中文名全部来自 breathingParams.json——不是 Python 里抄的一份。"""
    doc = _schema_json()
    f = BreathingParamsField({}, None, project_root=_ROOT)
    menu = f.add_btn.menu()
    menu.aboutToShow.emit()
    heads = [a.text() for a in menu.actions() if not a.isEnabled() and a.data() is None]
    keys = [a.data() for a in menu.actions() if a.data()]
    assert heads == [g["title"] + (f"（{g['note']}）" if g.get("note") else "") for g in doc["groups"]]
    assert keys == [p["key"] for g in doc["groups"] for p in g["params"]]
    labels = {a.data(): a.text() for a in menu.actions() if a.data()}
    for g in doc["groups"]:
        for p in g["params"]:
            assert p["label"] in labels[p["key"]]
    assert set(breathing_param_defs(_ROOT)) == set(keys)
    f.deleteLater()


def _trigger(menu, key: str) -> None:
    menu.aboutToShow.emit()
    act = next(a for a in menu.actions() if a.data() == key)
    assert act.isEnabled(), key
    act.trigger()


def test_params_editor_add_edit_switch_remove_from_the_controls(app) -> None:
    raw = {"ti": 5, "zz_unknown": 3, "vent": 99.25}
    f = BreathingParamsField(copy.deepcopy(raw), None, project_root=_ROOT)
    hits: list[int] = []
    f.changed.connect(lambda: hits.append(1))
    assert f.value() == raw and list(f.value()) == list(raw), "打开即取：键序与表示都不变"
    defs = breathing_param_defs(_ROOT)

    # 越界的 99.25 不夹：控件照原值显示并标出来
    vent = next(r for r in f.rows() if r.key == "vent")
    assert vent.spin.value() == 99.25 and "超出范围" in vent.spin.toolTip()
    # 未知键整行只读保值
    unk = next(r for r in f.rows() if r.key == "zz_unknown")
    assert not unk.is_numeric() and "未知参数" in unk.key_btn.text()

    # 加一行：已在表里的键在菜单里是灰的
    menu = f.add_btn.menu()
    menu.aboutToShow.emit()
    assert not next(a for a in menu.actions() if a.data() == "ti").isEnabled()
    _trigger(menu, "lag")
    assert f.value()["lag"] == defs["lag"].default and list(f.value())[-1] == "lag"

    # 改一个数：整数写 int、小数按步长位数
    ti = next(r for r in f.rows() if r.key == "ti")
    ti.spin.setValue(3.25)
    assert f.value()["ti"] == 3.25
    ti.spin.setValue(4.0)
    assert f.value()["ti"] == 4 and isinstance(f.value()["ti"], int)

    # 换参数：未知键换成认识的参数，数值保留
    _trigger(unk.key_btn.menu(), "sink")
    out = f.value()
    assert "zz_unknown" not in out and out["sink"] == 3

    # 删一行（点「−」）
    vent.remove_btn.click()
    assert "vent" not in f.value()
    assert hits, "每一步用户动作都要发 changed"
    f.deleteLater()


def test_params_editor_non_object_switches_only_on_explicit_click(app) -> None:
    f = BreathingParamsField("不是对象", None, project_root=_ROOT)
    assert f.value() == "不是对象"
    assert not f.add_btn.isVisibleTo(f)
    f._to_table_btn.click()
    assert f.value() == {}
    f.deleteLater()


# --------------------------------------------------------------------------- #
# 校验器
# --------------------------------------------------------------------------- #

def _issues(model, act: dict) -> list:
    from tools.editor.validator import _append_action_param_ref_issues

    out: list = []
    _append_action_param_ref_issues(model, out, act, "probe", "p", None)
    return out


def _errors(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "error"]


def _warnings(issues: list) -> list[str]:
    return [i.message for i in issues if i.severity == "warning"]


@pytest.mark.parametrize("act", [_FORMS[0], _FORMS[1], _FORMS[3], _FORMS[4], _FORMS[7], _FORMS[9]])
def test_written_forms_are_clean(model, act) -> None:
    assert [i.message for i in _issues(model, act)] == []


def test_show_checks(model) -> None:
    errs = _errors(_issues(model, _FORMS[2]))
    assert any("绝不存在的呼吸图" in m and "找不到资产" in m for m in errs)
    # 口径跟运行时的 Number()：转不成数的串 / 缺键（undefined）才会整条跳过；数字串照样能用，不冤枉
    errs = _errors(_issues(model, {"type": "showBreathingOverlay", "params": {
        "id": " ", "breathing": "", "xPercent": "左边", "widthPercent": "40", "order": "前面"}}))
    assert any("缺少 id" in m for m in errs)
    assert any("缺少 breathing" in m for m in errs)
    assert any("xPercent" in m for m in errs) and any("yPercent" in m for m in errs)
    assert not any("widthPercent" in m for m in errs)
    assert any("order" in m for m in errs)


def test_perform_checks(model) -> None:
    errs = _errors(_issues(model, _FORMS[6]))
    assert any("未知档" in m for m in errs)
    errs = _errors(_issues(model, {"type": "breathingPerform", "params": {"id": "a", "act": "gasp", "wait": "true"}}))
    assert any("wait" in m for m in errs), "运行时只认严格 true，字符串会静默退回「不等」"


def test_set_params_checks(model) -> None:
    issues = _issues(model, _FORMS[8])
    errs, warns = _errors(issues), _warnings(issues)
    assert any("zz_unknown" in m for m in errs)
    assert any("'volume'" in m and "数值" in m for m in errs)
    assert any("'vent'" in m and "超出范围" in m for m in warns), "越界运行时会夹 → warning 不是 error"
    assert not any("'ti'" in m or "'lag'" in m for m in errs + warns)
    errs = _errors(_issues(model, _FORMS[10]))
    assert any("params 须为" in m for m in errs)
    warns = _warnings(_issues(model, {"type": "setBreathingParams", "params": {
        "id": "a", "params": {}, "durationMs": -5}}))
    assert any("durationMs" in m for m in warns)


def test_real_breathing_asset_is_clean(model) -> None:
    from tools.editor.validator import _validate_breathing_overlays

    issues: list = []
    _validate_breathing_overlays(model, issues)
    assert issues == []


def test_broken_breathing_asset_is_reported(tmp_path) -> None:
    from tools.editor.validator import _validate_breathing_overlays

    bdir = tmp_path / "breathing"
    bdir.mkdir()
    (bdir / "坏.json").write_bytes(b"{not json")
    fake = SimpleNamespace(
        paths=SimpleNamespace(breathing_dir=bdir),
        breathing_overlays={"甲": {"id": "乙", "size": [0, 10], "layers": {"base": ""},
                                   "fields": {"file": "x.bin", "width": 0, "height": 4}, "rig": {}}},
    )
    issues: list = []
    _validate_breathing_overlays(fake, issues)
    msgs = [(i.severity, i.item_id, i.message) for i in issues]
    assert any(s == "error" and iid == "坏" for s, iid, _m in msgs)
    joined = "\n".join(m for _s, iid, m in msgs if iid == "甲")
    for frag in ("size", "layers.base", "fields", "rig 不完整", "文件名"):
        assert frag in joined, frag


def test_asset_audit_resolves_layers_and_fields_file() -> None:
    """图层与位移场（含 .bin）进审计的 resolved_media —— 打包清单的 JSON 引用闭包就是它。"""
    from tools.editor.shared.asset_reference_audit import audit_project_assets

    report = audit_project_assets(_ROOT)
    doc = json.loads((_ROOT / "public/assets/data/breathing" / f"{ASSET}.json").read_text("utf-8"))
    refs = [v for v in doc["layers"].values() if v] + [doc["fields"]["file"]]
    resolved = {p.resolve() for p in report.resolved_media}
    for ref in refs:
        disk = (_ROOT / "public" / ref.lstrip("/")).resolve()
        assert disk in resolved, ref
    assert not [i for i in report.issues if "breathing" in i.file]
