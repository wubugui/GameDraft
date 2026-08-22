# -*- coding: utf-8 -*-
"""换灯型:摘干净旧类型的专属字段,保住与类型无关的作者意图。

为什么要有这一整组:编辑器**以前根本改不了灯型**(F2 面板有下拉,编辑器没有),
只能删了重建 —— 重建就丢 id、丢强度、丢色温,场景 JSON 里引用这盏灯的地方全断。
现在能改了,那就必须锁住"改完之后数据是干净的":旧型的字段留着不报错,
只是**静默失效**(运行时按缺省走,作者以为自己调了)。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.editor.editors import scene_lights  # noqa: E402


ALL_KINDS = ("point", "spot", "area", "directional")


def _light(kind: str) -> dict:
    return scene_lights.default_light(1, kind)


@pytest.mark.parametrize("src_kind", ALL_KINDS)
@pytest.mark.parametrize("dst_kind", ALL_KINDS)
def test_任意两种灯型互换都过校验(src_kind, dst_kind):
    out = scene_lights.retype(_light(src_kind), dst_kind)
    assert out["kind"] == dst_kind
    errs = scene_lights.validate_lights([out])
    assert errs == [], f"{src_kind}→{dst_kind}: {errs}"


@pytest.mark.parametrize("dst_kind", ALL_KINDS)
def test_与类型无关的作者意图跟着走(dst_kind):
    src = _light("point")
    src.update({"id": "lamp_门口", "intensity": 7.25, "kelvin": 3100,
                "castShadow": True, "enabled": False})
    out = scene_lights.retype(src, dst_kind)
    assert out["id"] == "lamp_门口"
    assert out["intensity"] == 7.25
    assert out["kelvin"] == 3100
    assert out["castShadow"] is True
    assert out["enabled"] is False


def test_旧型专属字段一概摘掉():
    src = _light("spot")
    src["dir"] = [0, -1, 0]
    src["innerAngleDeg"] = 11
    src["outerAngleDeg"] = 22
    out = scene_lights.retype(src, "point")
    for k in ("dir", "innerAngleDeg", "outerAngleDeg"):
        assert k not in out, f"{k} 该摘没摘 —— 留着是静默失效"


def test_换成面光会带上面光自己的必需字段():
    out = scene_lights.retype(_light("point"), "area")
    assert "size" in out and len(out["size"]) == 2
    assert "orientation" in out and len(out["orientation"]) == 3


def test_平行光没有位置也没有距离衰减():
    src = _light("point")
    src["pos"] = [100, 200, 300]
    src["range"] = 999
    out = scene_lights.retype(src, "directional")
    for k in ("pos", "range", "softeningRadius"):
        assert k not in out
    assert "elevationDeg" in out and "azimuthDeg" in out


def test_从平行光换回来会补出位置():
    """平行光没有 pos,换成点光必须有一个 —— 缺了运行时打包直接读不到。"""
    out = scene_lights.retype(_light("directional"), "point")
    assert isinstance(out.get("pos"), list) and len(out["pos"]) == 3
    assert scene_lights.validate_lights([out]) == []


def test_位置与半径在非平行光之间保留():
    src = _light("point")
    src["pos"] = [12.5, 240.0, -8.0]
    src["range"] = 620
    out = scene_lights.retype(src, "spot")
    assert out["pos"] == [12.5, 240.0, -8.0]
    assert out["range"] == 620
    # 拷贝而不是共用同一个 list —— 共用的话改一盏会连带改另一盏
    out["pos"][0] = 0
    assert src["pos"][0] == 12.5


def test_源灯没有颜色就不留一个值为_None_的键():
    """`out['color'] = src.get('color')` 那种写法会留下 color=None:

    JSON 里看不见,但按"键在不在"分支的代码会走错。
    """
    src = _light("point")
    src.pop("color", None)
    out = scene_lights.retype(src, "area")
    assert "color" not in out or out["color"] is not None


def test_颜色在的时候跟着走():
    src = _light("point")
    src["color"] = [0.9, 0.4, 0.2]
    assert scene_lights.retype(src, "spot")["color"] == [0.9, 0.4, 0.2]
