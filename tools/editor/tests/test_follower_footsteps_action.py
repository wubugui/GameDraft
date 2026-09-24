"""`setFollowerFootsteps`(跟脚声开关)的登记面与作者面。

跟脚声 2026-09-21 从 `healthThreat.presenceSfx`(固定间隔 + 钉在玩家身后)拆成独立的一条:
玩家落脚事件的延迟重放。作者面只有这一个动作,所以这里钉死三件事:

1. **四个登记面齐全**——运行时 register / TS manifest(parity 测试另管) / ACTION_TYPES+_PARAM_SCHEMAS /
   ACTION_PERSISTENCE。漏哪一个的报错通道都不同,见 action-registration-registry-surfaces。
2. **两条往返都不漂**——最小形态(只有 enabled)打开即保存不许凭空多键;填满形态字节不变。
   这条不是洁癖:`delayPercent` 凭空写 0 = 跟脚声与玩家自己的脚步完全重叠(等于听不见),
   `footstepSet` 凭空写空串 = 多一个键,都是"打开一下就改了行为/字节"。
3. **候选面 = 校验面**——脚步集选择器读的是 `ProjectModel.all_footstep_set_ids()`,
   与校验器 `_follower_footsteps_issues` 的接受面同一个函数。
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

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.id_ref_selector import IdRefSelector  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE,
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    ActionEditor,
    _PARAM_SCHEMAS,
    _SELECTOR_KIND_UNIVERSE,
)
from tools.editor.validator import validate  # noqa: E402

TYPE = "setFollowerFootsteps"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


def _roundtrip(model: ProjectModel, act: dict) -> dict:
    ed = ActionEditor("t")
    try:
        ed.set_project_context(model, (model.all_scene_ids() or [None])[0])
        ed.set_data([copy.deepcopy(act)])
        out = ed.to_list()
        assert len(out) == 1
        return out[0]
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 登记面
# --------------------------------------------------------------------------- #

def test_registered_on_every_editor_surface() -> None:
    assert TYPE in ACTION_TYPES
    assert TYPE in CONTENT_ACTION_TYPES, "不是调试专用动作,内容下拉里要选得到"
    # 开关与参数进存档(有个东西在跟着你是世界事实;这一段还有重试检查点)
    assert ACTION_PERSISTENCE[TYPE] == "save"
    names = [n for n, _t in _PARAM_SCHEMAS[TYPE]]
    assert names == [
        "enabled", "id", "delayPercent", "minDelayMs", "footstepSet", "gainDb", "fireStops", "abrupt",
    ]


def test_footstep_set_selector_serves_the_registered_universe() -> None:
    assert _SELECTOR_KIND_UNIVERSE["footstep_set"] == "footstep_sets"


def test_footstep_set_candidates_equal_the_validator_acceptance(model) -> None:
    """候选面 = 校验面:两边读同一个函数,不许一边宽一边严。"""
    act = {"type": TYPE, "params": {"enabled": True, "id": "x", "footstepSet": ""}}
    ed = ActionEditor("t")
    try:
        ed.set_project_context(model, (model.all_scene_ids() or [None])[0])
        ed.set_data([copy.deepcopy(act)])
        w = ed._rows[0]._param_widgets["footstepSet"]
        assert isinstance(w, IdRefSelector), "引用字段不许是裸 QLineEdit(选择器铁律)"
        assert getattr(w, "_content_id_universe", None) == "footstep_sets"
        known = {i for i, _l in model.all_footstep_set_ids()}
        assert known, "工程里本来就该有脚步集"
        # 每个校验器认得的集都真的选得出来（选不出来 = 候选面比校验面窄，配都配不出来）
        unselectable = []
        for sid in sorted(known):
            w.set_current(sid)
            if w.current_id().strip() != sid:
                unselectable.append(sid)
        assert unselectable == [], unselectable
    finally:
        ed.deleteLater()


# --------------------------------------------------------------------------- #
# 两条往返
# --------------------------------------------------------------------------- #

def test_minimal_form_does_not_grow_keys(model) -> None:
    """只写 enabled 的最小形态,打开→什么都不改→保存,不许多出任何键。

    尤其是 delayPercent:控件中性值 0 与运行时缺省 50 不是一回事,凭空写 0
    会让跟脚声与玩家自己的脚步叠在同一刻(听不出是两个人)。
    """
    act = {"type": TYPE, "params": {"enabled": True}}
    assert _roundtrip(model, act) == act


def test_disable_form_keeps_only_what_the_author_wrote(model) -> None:
    act = {"type": TYPE, "params": {"enabled": False, "id": "ridge_follower"}}
    assert _roundtrip(model, act) == act


def test_full_form_roundtrips_byte_for_byte(model) -> None:
    sets = [i for i, _l in model.all_footstep_set_ids()]
    act = {"type": TYPE, "params": {
        "enabled": True,
        "id": "ridge_follower",
        "delayPercent": 65,
        "minDelayMs": 220,
        "footstepSet": sets[0],
        "gainDb": -4,
        "fireStops": True,
        "abrupt": True,
    }}
    got = _roundtrip(model, act)
    assert json.dumps(got, ensure_ascii=False, sort_keys=True) == \
        json.dumps(act, ensure_ascii=False, sort_keys=True)


def test_unknown_future_param_is_passed_through(model) -> None:
    act = {"type": TYPE, "params": {"enabled": True, "zz_future": {"keep": True}}}
    assert _roundtrip(model, act)["params"]["zz_future"] == {"keep": True}


# --------------------------------------------------------------------------- #
# 校验器
# --------------------------------------------------------------------------- #

def _issues_for(params: dict, tmp_path: Path) -> list:
    """在一个最小工程里挂一条本动作,只看它自己报什么。"""
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    dp = root / "public/assets/data"
    (dp / "footstep_sets.json").write_text(
        json.dumps({"sets": {"纸钱路": {"sfx": {"walk": "sfx_x"}}}}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    m = ProjectModel()
    m.load_project(root)
    sid = next(iter(m.scenes))
    m.scenes[sid]["hotspots"] = [{
        "id": "H_test", "x": 10.0, "y": 10.0, "type": "inspect",
        "data": {"text": "", "actions": [{"type": TYPE, "params": params}]},
    }]
    return [i for i in validate(m) if TYPE in i.message]


def test_dangling_footstep_set_is_a_warning_not_an_error(tmp_path) -> None:
    """与 scene.footstepSet / zone.footstepSet 同口径:素材未入库时先填 id 是正常工作流。"""
    issues = _issues_for({"enabled": True, "footstepSet": "根本没有这个集"}, tmp_path)
    assert issues and all(i.severity == "warning" for i in issues), [i.message for i in issues]


def test_zero_delay_is_an_error(tmp_path) -> None:
    """0% = 与玩家自己的脚步完全重叠,正是这条机制要避免的那件事。"""
    issues = _issues_for({"enabled": True, "delayPercent": 0}, tmp_path)
    assert any(i.severity == "error" for i in issues), [i.message for i in issues]


def test_sane_params_report_nothing(tmp_path) -> None:
    assert _issues_for({
        "enabled": True, "id": "ridge_follower", "delayPercent": 50,
        "minDelayMs": 180, "footstepSet": "纸钱路", "gainDb": -4, "fireStops": True,
    }, tmp_path) == []
