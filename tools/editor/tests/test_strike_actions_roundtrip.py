"""雷雨演出这批新动作（screenFlash / cameraShake / setSceneDim / strikeThreat /
duckAudio / restoreAudio）的编辑器往返。

为什么单独一份：这几条几乎全是**可选参数**，而往返测试的常规覆盖只探"给了值保不保值"，
探不到加可选参数最典型的两个事故（见 action-registration-registry-surfaces 卡「已知坑」）：

1. **最小形态打开→不改→保存，凭空多出键**。对这几条一律是**行为级**的：
   `alpha:0` = 根本不闪、`durationMs:0` = 时长归零、`lightIntensity:0` = 雷不发光。
2. **盘上有值→清空→保存，键还在**（或落成 `""` / `0`）。

外加一条本批特有的：`strikeThreat.removeTarget` 运行时缺省 **true**，必须是三态字符串，
用勾选框就配不出"只演不收"那一档。
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

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import (  # noqa: E402
    ACTION_TYPES,
    _TRISTATE_BOOL_PARAMS,
    ActionEditor,
)

STRIKE_ACTIONS = (
    "screenFlash", "cameraShake", "setSceneDim", "strikeThreat",
    "duckAudio", "restoreAudio",
)


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


def test_all_four_are_selectable_in_the_editor() -> None:
    """登记面：编辑器下拉里选得到（漏了这一条 = 策划根本加不了这条动作）。"""
    for t in STRIKE_ACTIONS:
        assert t in ACTION_TYPES, f"{t} 不在 ACTION_TYPES 里"


# --------------------------------------------------------------------------- #
# 最小形态：打开 → 什么都不改 → 保存，一个键都不许多
# --------------------------------------------------------------------------- #

MINIMAL = [
    # 全可选：`{}` 本身就是合法最小形态（220ms 惨白）
    {"type": "screenFlash", "params": {}},
    # amplitude 必填，其余可选
    {"type": "cameraShake", "params": {"amplitude": 20}},
    # scale 必填，其余可选
    {"type": "setSceneDim", "params": {"scale": 0.4}},
    # 全可选：`{}` = 照缺省挑最凶的劈了
    {"type": "strikeThreat", "params": {}},
    # 闪避两条也全可选。⚠ 中性值 0 在这里是"把这条通道摁死"，不是"没填"
    {"type": "duckAudio", "params": {"bgm": 0.05}},
    {"type": "restoreAudio", "params": {}},
]


@pytest.mark.parametrize("act", MINIMAL, ids=[a["type"] for a in MINIMAL])
def test_minimal_shape_survives_open_and_save(model, act) -> None:
    got = _roundtrip(model, act)
    assert got["type"] == act["type"]
    assert got["params"] == act["params"], (
        f"{act['type']} 最小形态打开→保存凭空多出键：{sorted(set(got['params']) - set(act['params']))}"
        f"（对这几条一律是行为级：alpha:0 不闪、durationMs:0 时长归零、lightIntensity:0 雷不发光）"
    )


# --------------------------------------------------------------------------- #
# 填满形态：每个值都要保住（含三态、含枚举、含选择器）
# --------------------------------------------------------------------------- #

FULL = [
    {"type": "screenFlash", "params": {"durationMs": 300, "color": "#dfe8ff", "alpha": 0.8, "wait": True}},
    {"type": "cameraShake", "params": {"amplitude": 26, "durationMs": 750, "frequency": 20}},
    {"type": "setSceneDim", "params": {"scale": 0.3, "fadeMs": 700, "wait": True}},
    {"type": "strikeThreat", "params": {
        "rank": "distance", "maxDistance": 1800, "fallback": "none", "fallbackRadius": 340,
        "effect": "lightning_bolt", "effectHeight": 12, "effectSeed": 0, "lightIntensity": 260, "lightHeight": 300,
        "lightRange": 5000, "lightKelvin": 9000, "lightMs": 460, "removeTarget": False, "seed": 7,
        # 绑在落点上的雷声 + 连劈 + 每道雷自带的闪白/震屏
        "sfx": "sfx_thunder_crack", "sfxVolume": 1.0, "sfxVoices": 0, "vfxVoices": 0,
        "strikes": 3, "extraChance": 0.45, "gapMs": 240, "gapJitterMs": 110,
        "flashAlpha": 0.42, "flashMs": 150, "shakeAmplitude": 26, "shakeMs": 750,
    }},
    {"type": "duckAudio", "params": {
        "id": "leifu", "bgm": 0.05, "ambient": 0.08, "sfx": 0.9, "voice": 1.0,
        "fadeMs": 900, "holdMs": 15000,
    }},
    {"type": "restoreAudio", "params": {
        "id": "leifu", "fadeMs": 1600, "stopSfx": "sfx_storm_brew,sfx_wind_gust",
    }},
]


@pytest.mark.parametrize("act", FULL, ids=[a["type"] for a in FULL])
def test_full_shape_survives_open_and_save(model, act) -> None:
    got = _roundtrip(model, act)
    assert got["params"] == act["params"], f"{act['type']} 填满形态往返漂移"


# --------------------------------------------------------------------------- #
# removeTarget：运行时缺省 true ⇒ 必须三态，否则「只演不收」配不出来
# --------------------------------------------------------------------------- #

def test_remove_target_is_tristate_not_a_checkbox() -> None:
    assert "removeTarget" in _TRISTATE_BOOL_PARAMS.get("strikeThreat", ()), (
        "strikeThreat.removeTarget 运行时缺省 true：用勾选框的话控件中性态(false)与"
        "运行时缺省(true)分不开，等于配不出 false"
    )


def test_remove_target_false_survives_and_stays_a_real_bool(model) -> None:
    """盘上写真 bool 的，存回去仍是真 bool（不许被三态控件改写成字符串 "false"）。"""
    got = _roundtrip(model, {"type": "strikeThreat", "params": {"removeTarget": False}})
    assert got["params"]["removeTarget"] is False


def test_remove_target_absent_stays_absent(model) -> None:
    """不写 = 收掉（运行时缺省）。打开再存不许凭空写上 removeTarget。"""
    got = _roundtrip(model, {"type": "strikeThreat", "params": {"effect": "lightning_bolt"}})
    assert "removeTarget" not in got["params"]


# --------------------------------------------------------------------------- #
# 枚举的悬垂值保值（norms 第 6 条：绝不静默顶替成第一项）
# --------------------------------------------------------------------------- #

def test_unknown_enum_values_are_kept_not_silently_replaced(model) -> None:
    got = _roundtrip(model, {"type": "strikeThreat", "params": {"rank": "未来的新档", "fallback": "另一种"}})
    assert got["params"]["rank"] == "未来的新档"
    assert got["params"]["fallback"] == "另一种"


# --------------------------------------------------------------------------- #
# 闪避：压 0 是合法的「压到听不见」，所以中性值不能被当成「没填」
# --------------------------------------------------------------------------- #

def test_duck_zero_is_a_real_value_not_an_empty_slot(model) -> None:
    """`bgm: 0` = 这一段里背景乐彻底哑掉。往返必须原样保住，不许被当成中性值剔掉。"""
    got = _roundtrip(model, {"type": "duckAudio", "params": {"bgm": 0}})
    assert got["params"].get("bgm") == 0, "压到 0 被当成「没填」剔掉了：那一段背景乐会照常响"
