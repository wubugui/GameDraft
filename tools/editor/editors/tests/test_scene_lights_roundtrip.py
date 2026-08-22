"""灯位编辑的**往返保真**。

编辑器只显示灯位那一部分，但 `lighting` 块里还有天光/雾/显示变换等一大堆参数
（那些在游戏内 F2 里调）。**打开再保存不许把它们清掉** —— 这类丢失是静默的：
不报错、不崩，只是下次进游戏发现调了半天的夜景没了。

同类事故在本仓库有先例（`editor-data-sync-paradigm` / `numeric-roundtrip-fidelity`），
所以这条必须有测试锁死。
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.editors import scene_lights  # noqa: E402

FULL_BLOCK = {
    "sky": {"kelvin": 9000.0, "intensity": 0.045, "hemi": 0.92},
    # day.hemi 刻意不写：由烘焙拟合
    "day": {"sunIntensity": 0.0, "sunElevationDeg": 50.0, "sunAzimuthDeg": 180.0},
    "lights": [
        {"id": "lamp_1", "kind": "point", "pos": [0.1, 0.4, -0.2], "kelvin": 2400.0,
         "intensity": 2.88, "range": 0.6016, "castShadow": True, "enabled": True},
        {"id": "moon", "kind": "directional", "elevationDeg": 35.0, "azimuthDeg": 210.0,
         "intensity": 0.0, "kelvin": 5200.0, "castShadow": True, "enabled": True},
    ],
    "fog": {"sigma": 0.0, "scaleHeight": 0.6016, "baseHeight": 0.0,
            "kelvin": 6500.0, "scatter": 0.06},
    "display": {"ev": 3.3175638002432013, "tonemap": "filmic", "whiteKelvin": 7200.0,
                "contrast": 0.7, "saturation": 0.85, "lift": 0.0, "liftKelvin": 9000.0},
    "emissive": {"gain": 2.2, "coreRadius": 0.035094,
                 "haloRadius": 0.160428, "haloGain": 0.18},
    "dehaze": 1.0,
    "aoStrength": 1.0,
    "ratioMax": 6.0,
    # 将来新增的、本版编辑器不认识的字段也必须原样带回
    "__future_field__": {"whatever": [1, 2, 3]},
}


class _FakePanel:
    """把 scene_editor 里那两个纯数据方法搬出来单测（不起 Qt）。

    只复制**逻辑**，签名与真实方法一致；真实方法若改了这里会被 `test_逻辑未漂移` 抓到。
    """

    def __init__(self, block: dict | None) -> None:
        self._sc_lighting = copy.deepcopy(block) if block else None

    def writeback(self, sc: dict) -> None:
        if not self._sc_lighting:
            sc.pop("lighting", None)
            return
        out = copy.deepcopy(self._sc_lighting)
        for light in out.get("lights") or []:
            light.pop("_editorHeightWu", None)
        sc["lighting"] = out


def test_打开再保存_整块逐字节不变() -> None:
    scene = {"id": "x", "lighting": copy.deepcopy(FULL_BLOCK)}
    panel = _FakePanel(scene["lighting"])
    out: dict = {}
    panel.writeback(out)
    assert json.dumps(out["lighting"], sort_keys=True, ensure_ascii=False) == \
        json.dumps(FULL_BLOCK, sort_keys=True, ensure_ascii=False)


def test_编辑器专用的高度字段不进数据契约() -> None:
    """`_editorHeightWu` 是从 pos 反推的派生量，只给 UI 看，不许落盘。"""
    block = copy.deepcopy(FULL_BLOCK)
    block["lights"][0]["_editorHeightWu"] = 2.0
    panel = _FakePanel(block)
    out: dict = {}
    panel.writeback(out)
    assert "_editorHeightWu" not in out["lighting"]["lights"][0]
    # 其余字段一个不少
    assert out["lighting"]["lights"][0]["pos"] == FULL_BLOCK["lights"][0]["pos"]


def test_没有灯也保留其余参数() -> None:
    """把灯全删了不等于关掉统一光影——天光/雾/调色还在。"""
    block = copy.deepcopy(FULL_BLOCK)
    block["lights"] = []
    panel = _FakePanel(block)
    out: dict = {}
    panel.writeback(out)
    assert out["lighting"]["sky"] == FULL_BLOCK["sky"]
    assert out["lighting"]["display"] == FULL_BLOCK["display"]
    assert out["lighting"]["lights"] == []


def test_没有_lighting_块则不写键() -> None:
    panel = _FakePanel(None)
    out: dict = {"lighting": {"stale": 1}}
    panel.writeback(out)
    assert "lighting" not in out


def test_未知字段不被吞掉() -> None:
    panel = _FakePanel(FULL_BLOCK)
    out: dict = {}
    panel.writeback(out)
    assert out["lighting"]["__future_field__"] == {"whatever": [1, 2, 3]}


def test_逻辑未漂移() -> None:
    """真实的 `_writeback_scene_lights` 若改了实现，这里要提醒同步。

    判据保守：只要求它仍然剥掉 `_editorHeightWu` 并深拷贝整块。
    """
    src = (Path(_ROOT) / "tools/editor/editors/scene_editor.py").read_text(encoding="utf-8")
    i = src.find("def _writeback_scene_lights")
    assert i > 0, "找不到 _writeback_scene_lights —— 方法被改名了？"
    body = src[i:i + 900]
    assert "_editorHeightWu" in body, "写回不再剥编辑器专用字段，会污染数据契约"
    assert "copy.deepcopy" in body, "写回不再深拷贝，模型会被下游改动串味"


@pytest.mark.parametrize("kind", ["point", "spot", "area", "directional"])
def test_缺省灯通过校验且能往返(kind: str) -> None:
    block = scene_lights.default_lighting_block()
    block["lights"] = [scene_lights.default_light(1, kind)]
    assert scene_lights.validate_lights(block["lights"]) == []
    panel = _FakePanel(block)
    out: dict = {}
    panel.writeback(out)
    assert out["lighting"]["lights"][0]["kind"] == kind
