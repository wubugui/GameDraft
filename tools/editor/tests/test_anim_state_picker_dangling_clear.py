"""动画状态下拉：悬垂值保值展示时，「空值」那一行必须还在，作者能从界面清掉它。

背景（2026-09-15 实测）：moveEntityTo / jumpEntityTo / playTrajectory / playNpcAnimation /
persistNpcAnimState 的状态候选刷新器在注入「(数据) 旧值」行时写成 `[(数据)] + rows[1:]`，
把首行空值（「（不播放移动动画）」之类）切掉了。select_only 下拉里没有 "" 这一行，
`set_committed_type("")` 又落回 entries[0]＝孤儿行——存了一个演员没有的状态，就再也清不掉。

护栏从真实入口进：打开动作 → 在下拉上点 UserRole 为 "" 的那一行 → `ActionEditor.to_list()` 保存。
"""
from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import ActionEditor, FilterableTypeCombo  # noqa: E402

_DANGLING = "zz_walk"


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app) -> ProjectModel:
    m = ProjectModel()
    m.load_project(_ROOT)
    return m


def _values(combo: FilterableTypeCombo) -> list[str]:
    return [str(combo.itemData(i, Qt.ItemDataRole.UserRole) or "") for i in range(combo.count())]


# (动作, 悬垂值所在的键, 选空之后存完必须没有该键)
_CASES = [
    ({"type": "moveEntityTo", "params": {"target": "player", "x": 1, "y": 2, "moveAnimState": _DANGLING}},
     "moveAnimState", True),
    ({"type": "moveEntityTo", "params": {"target": "player", "x": 1, "y": 2, "arriveAnimState": _DANGLING}},
     "arriveAnimState", True),
    ({"type": "jumpEntityTo", "params": {"target": "player", "x": 1, "y": 2, "jumpAnimState": _DANGLING}},
     "jumpAnimState", True),
    ({"type": "jumpEntityTo", "params": {"target": "player", "x": 1, "y": 2, "landAnimState": _DANGLING}},
     "landAnimState", True),
    ({"type": "playTrajectory", "params": {"trajectoryId": "zz_traj", "target": "player", "animState": _DANGLING}},
     "animState", True),
    # thenState 走全局 _OMIT_WHEN_ABSENT_AND_DEFAULT：盘上有值、清回空 = 不写键
    #（运行时 trim 后空串＝不切换，与缺键同义；曾落成 thenState:"" 的游离键）。
    ({"type": "playNpcAnimation", "params": {"target": "player", "state": "idle", "thenState": _DANGLING}},
     "thenState", True),
    # state 是必填：清空后写不写键归保存路径管，这里只锁"空值行在、选得中、不再存回悬垂值"
    ({"type": "playNpcAnimation", "params": {"target": "player", "state": _DANGLING}},
     "state", False),
    ({"type": "persistNpcAnimState", "params": {"target": "player", "state": _DANGLING}},
     "state", False),
]
_IDS = [f"{a['type']}.{k}" for a, k, _ in _CASES]


def _open(model: ProjectModel, act: dict) -> ActionEditor:
    ed = ActionEditor("t")
    ed.set_project_context(model, (model.all_scene_ids() or [None])[0])
    ed.set_data([copy.deepcopy(act)])
    return ed


@pytest.mark.parametrize("act,key,absent", _CASES, ids=_IDS)
def test_dangling_anim_state_keeps_empty_row_and_can_be_cleared(model, act, key, absent) -> None:
    ed = _open(model, act)
    try:
        combo = ed._rows[0]._param_widgets[key]
        assert isinstance(combo, FilterableTypeCombo)
        values = _values(combo)
        assert combo.committed_type() == _DANGLING, values
        assert _DANGLING in values, values
        assert values[0] == "", values

        idx = values.index("")
        combo.setCurrentIndex(idx)
        assert combo.committed_type() == ""

        prm = ed.to_list()[0]["params"]
        if absent:
            assert key not in prm, prm
        else:
            assert prm.get(key, "") == "", prm
    finally:
        ed.deleteLater()


@pytest.mark.parametrize("act,key,_absent", _CASES, ids=_IDS)
def test_dangling_anim_state_untouched_roundtrips(model, act, key, _absent) -> None:
    """没动过：悬垂值原样存回（保值契约另一半）。"""
    ed = _open(model, act)
    try:
        prm = ed.to_list()[0]["params"]
        assert prm.get(key) == _DANGLING, prm
    finally:
        ed.deleteLater()
