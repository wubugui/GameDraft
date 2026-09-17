"""ActionRow 保存：全局剔除表（`_OMIT_WHEN_ABSENT_AND_DEFAULT`）的「清回中性档 = 不写键」。

背景（2026-09-15）：全局表原本只剔"盘上原本没有"的中性值——盘上 `playNpcAnimation.thenState:"zz_walk"`
在界面上清空，一存落成 `thenState:""`。运行时 trim 后空串＝不切换，与缺键同义，所以是游离键不是行为变化；
作用域表早已改成"盘上非中性 → 清回中性也去键"，全局表现在同一语义。

例外 `_OMIT_ONLY_WHEN_ABSENT`：名字在某个 action 里是 actionParamManifest.ts 的 required（text / key /
itemName / slots / options），去键会把合法中性值改成"缺必填参数"或改行为（`enableRuleOffers.slots:[]`
是登记空槽，缺键是不动）——清空照旧留中性值。
盘上原本就写着中性值的，没动过一律原样保留（editor norms 不变量 1）。
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
from PySide6.QtWidgets import QApplication, QCheckBox, QComboBox, QDoubleSpinBox, QLineEdit, QSpinBox  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    _OMIT_ONLY_WHEN_ABSENT,
    _OMIT_WHEN_ABSENT_AND_DEFAULT,
    ActionEditor,
)
from tools.editor.shared.narrative_required_params import load_required_params  # noqa: E402
from tools.editor.shared.position_ref_field import MODE_NONE  # noqa: E402


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


def _clear(*names: str):
    """把控件从真实入口拨回中性档：勾选框取消、数值归 0、下拉点「空值」那一行、文本清空。"""
    def run(o: _Open) -> None:
        for name in names:
            w = o.w(name)
            if isinstance(w, QCheckBox):
                w.setChecked(False)
            elif isinstance(w, (QSpinBox, QDoubleSpinBox)):
                w.setValue(0)
            elif isinstance(w, QComboBox) and hasattr(w, "committed_type"):
                idx = next((i for i in range(w.count())
                            if (w.itemData(i, Qt.ItemDataRole.UserRole) or "") == ""), -1)
                if idx >= 0:
                    w.setCurrentIndex(idx)
                else:
                    w.set_committed_type("")
                assert w.committed_type() == "", (name, w.committed_type())
            elif isinstance(w, QComboBox) and hasattr(w, "current_id"):
                # IdRefSelector：首行「(none)」= 空
                w.setCurrentIndex(0)
                assert w.current_id() == "", (name, w.current_id())
            elif isinstance(w, QComboBox):
                idx = w.findData("")
                if idx < 0:
                    idx = w.findText("")
                assert idx >= 0, (name, [w.itemData(i) for i in range(w.count())])
                w.setCurrentIndex(idx)
            elif isinstance(w, QLineEdit):
                w.clear()
            elif hasattr(w, "set_value"):
                w.set_value("")
            elif hasattr(w, "set_current"):
                w.set_current("")
            elif hasattr(w, "set_text"):
                w.set_text("")
            elif hasattr(w, "setText"):
                w.setText("")
            else:  # pragma: no cover - 控件换型时让用例自己报出来
                raise AssertionError(f"不认识的控件 {name}: {type(w).__name__}")
    return run


def _pick_mode(name: str, mode: str):
    def run(o: _Open) -> None:
        field = o.w(name)
        idx = field.mode_combo.findData(mode)
        assert idx >= 0, mode
        field.mode_combo.setCurrentIndex(idx)
    return run


def _scene(model: ProjectModel) -> str:
    sid = (model.all_scene_ids() or [""])[0]
    assert sid, "工程里没有场景，switchScene 用例需要一个真实场景 id"
    return sid


_SCENE = "<first-scene>"


def _resolve(model: ProjectModel, act: dict) -> dict:
    return {**act, "params": {k: (_scene(model) if v == _SCENE else v) for k, v in act["params"].items()}}


_OPTS = [{"text": "甲", "actions": []}]

# (动作, 怎么清, 清掉的键)：盘上非中性 → 清回中性 → 存完这些键必须没有，其余键原值不动
_CLEAR_CASES = [
    ({"type": "faceEntity", "params": {"target": "player", "direction": "left", "faceTarget": "zz_npc"}},
     _clear("direction"), ("direction",)),
    ({"type": "faceEntity", "params": {"target": "player", "direction": "left", "faceTarget": "zz_npc"}},
     _pick_mode("at", MODE_NONE), ("faceTarget",)),
    ({"type": "showEmote", "params": {"target": "player", "emote": "?", "anchorOffsetX": 12, "anchorOffsetY": -8.5}},
     _clear("anchorOffsetX", "anchorOffsetY"), ("anchorOffsetX", "anchorOffsetY")),
    ({"type": "emitNarrativeSignal", "params": {"signal": "zz_sig", "sourceType": "npc", "sourceId": "zz_npc"}},
     _clear("sourceType", "sourceId"), ("sourceType", "sourceId")),
    ({"type": "chooseAction", "params": {"prompt": "问一句", "allowCancel": True, "options": _OPTS}},
     _clear("prompt", "allowCancel"), ("prompt", "allowCancel")),
    ({"type": "pickup", "params": {"itemName": "铜钱", "count": 3, "isCurrency": True}},
     _clear("isCurrency"), ("isCurrency",)),
    ({"type": "blendOverlayImage", "params": {"id": "zz_ov", "fromImage": "/a.png", "toImage": "/b.png",
                                              "durationMs": 600, "delayMs": 300,
                                              "xPercent": 10, "yPercent": 20, "widthPercent": 30}},
     _clear("delayMs"), ("delayMs",)),
    ({"type": "switchScene", "params": {"targetScene": _SCENE, "targetSpawnPoint": "zz_sp"}},
     _clear("targetSpawnPoint"), ("targetSpawnPoint",)),
    ({"type": "changeScene", "params": {"targetScene": _SCENE, "targetSpawnPoint": "zz_sp"}},
     _clear("targetSpawnPoint"), ("targetSpawnPoint",)),
    ({"type": "setSmell", "params": {"scent": "corpse", "intensity": 60, "dir": 0.5, "flicker": True}},
     _clear("dir", "flicker"), ("dir", "flicker")),
    ({"type": "giveItem", "params": {"id": "zz_item", "count": 2, "critical": True}},
     _clear("critical"), ("critical",)),
    ({"type": "playNpcAnimation", "params": {"target": "player", "state": "idle", "reverse": True,
                                             "loop": "true", "thenState": "zz_walk"}},
     _clear("reverse", "loop", "thenState"), ("reverse", "loop", "thenState")),
    # 三态 loop 盘上是真 bool：清回「沿用状态定义」同样去键
    ({"type": "playNpcAnimation", "params": {"target": "player", "state": "idle", "loop": False}},
     _clear("loop"), ("loop",)),
    # text 在全局表里只剔缺键；waitClickContinue 是它唯一可选的宿主，走作用域表清空去键
    ({"type": "waitClickContinue", "params": {"text": "点一下"}},
     _clear("text"), ("text",)),
]
_CLEAR_IDS = [f"{a['type']}.{'+'.join(gone)}" for a, _c, gone in _CLEAR_CASES]


def test_clear_cases_cover_every_clearable_global_key() -> None:
    covered = {k for _a, _c, gone in _CLEAR_CASES for k in gone}
    assert set(_OMIT_WHEN_ABSENT_AND_DEFAULT) - _OMIT_ONLY_WHEN_ABSENT <= covered


@pytest.mark.parametrize("act,clear,gone", _CLEAR_CASES, ids=_CLEAR_IDS)
def test_global_optional_param_cleared_saves_without_the_key(model, act, clear, gone) -> None:
    act = _resolve(model, act)
    with _Open(model, act) as o:
        clear(o)
        prm = o.save()
    want = {k: v for k, v in act["params"].items() if k not in gone}
    assert prm == want, prm


@pytest.mark.parametrize("act", [
    # 作者自己写的中性值：没动过就原样保留（剔除只针对"原本没有"与"清回中性"）
    {"type": "faceEntity", "params": {"target": "player", "direction": "", "faceTarget": "zz_npc"}},
    {"type": "showEmote", "params": {"target": "player", "emote": "?", "anchorOffsetX": 0, "anchorOffsetY": 0.0}},
    {"type": "emitNarrativeSignal", "params": {"signal": "zz_sig", "sourceType": "", "sourceId": ""}},
    {"type": "chooseAction", "params": {"prompt": "", "allowCancel": False, "options": _OPTS}},
    {"type": "pickup", "params": {"itemName": "铜钱", "count": 3, "isCurrency": False}},
    {"type": "blendOverlayImage", "params": {"id": "zz_ov", "fromImage": "/a.png", "toImage": "/b.png",
                                             "durationMs": 600, "delayMs": 0,
                                             "xPercent": 10, "yPercent": 20, "widthPercent": 30}},
    {"type": "switchScene", "params": {"targetScene": _SCENE, "targetSpawnPoint": ""}},
    {"type": "setSmell", "params": {"scent": "corpse", "intensity": 60, "dir": 0, "flicker": False}},
    {"type": "giveItem", "params": {"id": "zz_item", "count": 2, "critical": False}},
    {"type": "playNpcAnimation", "params": {"target": "player", "state": "idle", "reverse": False,
                                            "loop": "", "thenState": ""}},
    {"type": "waitClickContinue", "params": {"text": ""}},
    # 语义中性、字面不同：过场数据里的 bool 常写成字符串
    {"type": "chooseAction", "params": {"allowCancel": "false", "options": _OPTS}},
], ids=lambda a: a["type"])
def test_authored_neutral_values_roundtrip_untouched(model, act) -> None:
    act = _resolve(model, act)
    with _Open(model, act) as o:
        prm = o.save()
    assert _dumps(prm) == _dumps(act["params"])


# 例外名单：清空留中性值，不去键
_KEEP_CASES = [
    ({"type": "showNotification", "params": {"text": "提示一句"}}, _clear("text"), {"text": ""}),
    ({"type": "pickup", "params": {"itemName": "铜钱", "count": 3, "isCurrency": True}}, _clear("itemName"),
     {"itemName": "", "count": 3, "isCurrency": True}),
]


@pytest.mark.parametrize("act,clear,want", _KEEP_CASES, ids=[f"{c[0]['type']}-{i}" for i, c in enumerate(_KEEP_CASES)])
def test_required_elsewhere_param_cleared_keeps_the_neutral_value(model, act, clear, want) -> None:
    with _Open(model, act) as o:
        clear(o)
        prm = o.save()
    assert prm == want, prm


@pytest.mark.parametrize("act_type,disk,written", [
    # 列表类与 flag key 的控件不是单个输入框：直接喂保存路径"控件写出了中性值"，只验后处理
    ("enableRuleOffers", {"slots": [{"ruleId": "zz_rule", "resultActions": []}]}, {"slots": []}),
    ("chooseAction", {"options": _OPTS}, {"options": []}),
    ("appendFlag", {"key": "zz_flag", "text": "x"}, {"key": "", "text": ""}),
])
def test_only_when_absent_keys_survive_postprocessing(model, act_type, disk, written) -> None:
    with _Open(model, {"type": act_type, "params": disk}) as o:
        o.row._to_dict_raw = lambda: {"type": act_type, "params": copy.deepcopy(written)}
        assert o.row.to_dict()["params"] == written


def test_only_when_absent_set_matches_manifest_required() -> None:
    """全局表里在任一 action 是 required 的名字 == 例外名单：新加的必填名字漏登就红，名单烂了也红。"""
    man = load_required_params()
    assert man, "actionParamManifest.ts 解析失败"
    required_anywhere = {k for k in _OMIT_WHEN_ABSENT_AND_DEFAULT if any(k in req for req, _ne in man.values())}
    assert required_anywhere == set(_OMIT_ONLY_WHEN_ABSENT)
