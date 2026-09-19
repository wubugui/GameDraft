"""`runActionsDetached`（脱手执行一批动作）的各宿主面。

为什么需要它、为什么单独一份：缺省的动作批在探索态会把游戏切进 `ActionSequence`——
批里每条 `waitMs` 都是**玩家一动不能动**的等待。热区检视要的就是这个；但雷符那段近十秒的
「压天 → 起风 → 远雷 → 惊雷」放在缺省批里，就是把人钉在原地看完（2026-09-19 制作人报
「放了技能之后完全不能动」）。这条容器让整批脱手跑，玩家全程照常活动。

它是**容器动作**，所以三件事必须同时成立，少一件就是策划配得出来、运行时/校验器看不见：
下拉里选得到、子动作列表往返保真、校验器会下钻进去。
"""
from __future__ import annotations

import copy
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_PERSISTENCE, ACTION_TYPES, ActionEditor,
)
from tools.editor.shared.action_structure import (  # noqa: E402
    NESTED_ACTION_SLOTS, detached_forbidden, detached_presentation_only,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402
from tools.editor.validator import Issue, _walk_action_defs  # noqa: E402


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


def test_selectable_in_the_editor() -> None:
    assert "runActionsDetached" in ACTION_TYPES


def test_registered_as_a_container_with_one_action_list() -> None:
    slots = NESTED_ACTION_SLOTS.get("runActionsDetached")
    assert slots is not None, "没登记进 NESTED_ACTION_SLOTS：大纲树、引用校验、关系图全都不下钻"
    assert [s.key for s in slots] == ["actions"]


def test_child_actions_survive_open_and_save(model) -> None:
    act = {"type": "runActionsDetached", "params": {"actions": [
        {"type": "setSceneDim", "params": {"scale": 0.38, "fadeMs": 1600}},
        {"type": "waitMs", "params": {"durationMs": 1800}},
        {"type": "cameraShake", "params": {"amplitude": 26, "durationMs": 750, "frequency": 20}},
    ]}}
    assert _roundtrip(model, act) == act


def test_empty_batch_survives(model) -> None:
    """空批是合法最小形态（运行时直接返回）；打开再存不许变形。"""
    act = {"type": "runActionsDetached", "params": {"actions": []}}
    assert _roundtrip(model, act) == act


class TestValidatorDescends(unittest.TestCase):
    def test_bad_child_action_is_reported(self) -> None:
        """脱手不等于不校验：里面写错的动作照样要报出来。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            issues: list[Issue] = []
            _walk_action_defs(model, issues, [{
                "type": "runActionsDetached",
                "params": {"actions": [{"type": "__missing_action__", "params": {}}]},
            }], "item", "leifu", None)
            self.assertTrue(
                any("__missing_action__" in i.message for i in issues),
                [i.message for i in issues],
            )


# --------------------------------------------------------------------------- #
# 演出名 id：顶替按它算
# --------------------------------------------------------------------------- #

def test_session_id_survives_open_and_save(model) -> None:
    act = {"type": "runActionsDetached", "params": {
        "id": "leifu", "actions": [{"type": "waitMs", "params": {"durationMs": 100}}],
    }}
    assert _roundtrip(model, act) == act


def test_missing_session_id_is_not_invented(model) -> None:
    """不写 id = 运行时叫 detached。打开再存不许凭空写上一个空串。"""
    act = {"type": "runActionsDetached", "params": {"actions": []}}
    assert _roundtrip(model, act) == act


# --------------------------------------------------------------------------- #
# 两张分类表：跳过表不许吞掉任何后果
# --------------------------------------------------------------------------- #

def test_classification_tables_are_readable_from_runtime() -> None:
    """表在 TS 里（唯一权威源），Python 这边解析得到——解析不出来就是静默按空表跑。"""
    assert len(detached_presentation_only()) > 20
    assert len(detached_forbidden()) > 10


def test_tables_only_name_real_actions() -> None:
    known = set(ACTION_TYPES)
    for name, table in (("PRESENTATION_ONLY", detached_presentation_only()),
                        ("DETACHED_FORBIDDEN", detached_forbidden())):
        unknown = sorted(table - known)
        assert not unknown, f"{name} 里有不存在的动作类型：{unknown}"


def test_no_save_writing_action_is_ever_skipped() -> None:
    """**这条是整套机制的命门**。

    打断脱手演出时，跳过表里的动作**整条不跑**。表里一旦混进一个会改存档 / 推状态 / 动背包的
    动作，玩家就会遇到"放了技能，什么都没发生"——而且只在恰好被打断的那一次。
    口径按编辑器的 ACTION_PERSISTENCE："save" 档一律不许进跳过表。
    """
    offenders = sorted(
        a for a in detached_presentation_only() if ACTION_PERSISTENCE.get(a) == "save"
    )
    assert not offenders, (
        "这些动作会改存档 / 可持久化数据，却被登记成「打断时整条跳过」："
        f"{offenders}。跳过它们＝玩家放了技能却没有后果"
    )


def test_forbidden_table_covers_the_takeover_entrances() -> None:
    """脱手演出跑在玩家背后：抢控制权的入口一个都不许漏，漏一个就是随机时刻被拽走。"""
    must = {
        "startCutscene", "startEncounter", "startDialogueGraph", "playScriptedDialogue",
        "chooseAction", "waitClickContinue", "openShop", "openMap",
        "startWaterMinigame", "startSugarWheelMinigame", "startPaperCraftMinigame",
        "startObjectExamine", "startPressureHold", "switchScene", "changeScene",
    }
    assert must <= detached_forbidden(), sorted(must - detached_forbidden())


# --------------------------------------------------------------------------- #
# 校验器：脱手演出批自己的三条规矩
# --------------------------------------------------------------------------- #

class TestDetachedBatchRules(unittest.TestCase):
    def _issues(self, params: dict) -> list:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            issues: list[Issue] = []
            _walk_action_defs(
                model, issues, [{"type": "runActionsDetached", "params": params}],
                "item", "probe", None,
            )
            return issues

    def test_takeover_action_inside_is_an_error(self) -> None:
        issues = self._issues({"id": "sk", "actions": [
            {"type": "startCutscene", "params": {"id": "c"}},
        ]})
        hit = [i for i in issues if i.severity == "error" and "startCutscene" in i.message]
        self.assertTrue(hit, [i.message for i in issues])

    def test_missing_id_warns_about_superseding(self) -> None:
        issues = self._issues({"actions": [{"type": "waitMs", "params": {}}]})
        self.assertTrue(
            any("顶替" in i.message for i in issues), [i.message for i in issues],
        )

    def test_unregistered_presentation_action_warns(self) -> None:
        """演出类但没登记进跳过表：打断时它会照跑，正好播在过场上面。"""
        issues = self._issues({"id": "sk", "actions": [
            {"type": "setEntityEnabled", "params": {"target": "x", "enabled": False}},
        ]})
        self.assertTrue(
            any("PRESENTATION_ONLY_ACTIONS" in i.message for i in issues),
            [i.message for i in issues],
        )

    def test_nested_container_warns_about_async_tail(self) -> None:
        issues = self._issues({"id": "sk", "actions": [
            {"type": "runActions", "params": {"actions": []}},
        ]})
        self.assertTrue(
            any("只有顶层" in i.message for i in issues), [i.message for i in issues],
        )

    def test_clean_batch_is_quiet(self) -> None:
        issues = self._issues({"id": "sk", "actions": [
            {"type": "waitMs", "params": {"durationMs": 100}},
            {"type": "screenFlash", "params": {}},
        ]})
        self.assertEqual([i.message for i in issues], [])
