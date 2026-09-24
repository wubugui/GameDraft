# -*- coding: utf-8 -*-
"""表面材质（落雷的灯照出的反光用）：全局缺省材质 ``defaultSurface`` + 场景的表面材质区 ``scenes[id].surfaces``。

钉住的事：两块的形状闸门与键序；缺省值与运行时 ``surfaceMask.ts`` 同值；布置库的 scoped 保存能单独改 / 清掉它们、
盘上被外部改过拒写、没改的场景不动。写盘一律在临时目录。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.shared import vfx_placements as vp  # noqa: E402
from tools.vfx_workbench import placements  # noqa: E402

WATER = {"id": "river", "kind": "water", "polygon": [[0, 0], [100, 0], [100, 50]]}


@pytest.fixture()
def lib_root(tmp_path, monkeypatch):
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    for sid in ("hill", "room"):
        (scenes / f"{sid}.json").write_text(json.dumps({"id": sid, "backgrounds": [{"image": "bg.png"}]}), encoding="utf-8")
    cfg = tmp_path / "game_config.json"
    cfg.write_text(json.dumps({}), encoding="utf-8")
    monkeypatch.setattr(placements, "LIB_ROOT", tmp_path / "libroot")
    monkeypatch.setattr(placements, "SCENES_JSON", scenes)
    monkeypatch.setattr(placements, "GAME_CONFIG", cfg)
    monkeypatch.setattr(placements, "REF_ROOT", tmp_path / "refroot")
    return tmp_path


def test_surface_region_gate_orders_keys_and_rejects_bad_shapes() -> None:
    r = vp.normalize_surface({"polygon": [[0, 0], [1, 0], [1, 1]], "feather": 5, "kind": "wet", "id": " a "}, "t")
    assert list(r) == ["id", "kind", "polygon", "feather"] and r["id"] == "a"
    for bad, msg in (({"kind": "wet", "polygon": [[0, 0], [1, 0], [1, 1]]}, "缺 id"),
                     ({"id": "a", "kind": "lava", "polygon": [[0, 0], [1, 0], [1, 1]]}, "water"),
                     ({"id": "a", "kind": "wet", "polygon": [[0, 0], [1, 0]]}, "多边形"),
                     ({"id": "a", "kind": "wet", "polygon": [[0, 0], [1, 0], [1, 1]], "reflect": 2}, "0..1"),
                     ({"id": "a", "kind": "wet", "polygon": [[0, 0], [1, 0], [1, 1]], "feather": -1}, "feather")):
        with pytest.raises(ValueError, match=msg):
            vp.normalize_surface(bad, "t")
    with pytest.raises(ValueError, match="重复"):
        vp.normalize_surfaces([WATER, dict(WATER)], "t")


def test_default_surface_gate_ranges_unknown_keys_and_top_level_order() -> None:
    assert list(vp.normalize_default_surface({"ripple": 0.5, "reflect": 1})) == ["reflect", "ripple"]
    for bad, msg in (({"roughness": 1.5}, "roughness"), ({"detail": 3}, "detail"), ({"shine": 1}, "不认得"), ([], "对象")):
        with pytest.raises(ValueError, match=msg):
            vp.normalize_default_surface(bad)
    lib = vp.normalize_library({"scenes": {}, "defaultSurface": {"detail": 0.5}, "_comment": "c"})
    assert list(lib) == ["_comment", "defaultSurface", "scenes"]
    assert "defaultSurface" not in vp.normalize_library({"scenes": {}, "defaultSurface": {}}), "空对象 = 回运行时缺省，不留空壳"


def test_defaults_match_the_runtime_source() -> None:
    """缺省值只有两处写（Python 占位 / 校验、TS 运行时）：逐字对上，工作台的占位提示才是游戏里真用的数。"""
    src = (_ROOT / "src" / "rendering" / "lighting" / "surfaceMask.ts").read_text(encoding="utf-8")
    block = src[src.index("export const SURFACE_DEFAULTS"):]
    block = block[:block.index("} as const;")]
    for kind in ("ground", "water", "wet"):
        m = re.search(kind + r": \{([^}]*)\}", block)
        assert m, kind
        ts = {k: float(v) for k, v in re.findall(r"(\w+): ([\d.]+)", m.group(1))}
        assert ts == {k: float(v) for k, v in vp.SURFACE_DEFAULTS[kind].items()}, kind
    assert float(re.search(r"featherWu: ([\d.]+)", block).group(1)) == vp.SURFACE_DEFAULTS["featherWu"]


def test_scoped_save_sets_and_clears_default_and_regions_without_touching_other_scenes(lib_root) -> None:
    placements.save_changes({"scenes": {"room": {"surfaces": [WATER]}}})
    disk, _ = placements.load()
    base = json.loads(json.dumps(disk))
    _p, doc, _w = placements.save_changes({"scenes": {"hill": {"surfaces": [WATER]}}, "defaultSurface": {"roughness": 0.3}}, base=base)
    assert doc["defaultSurface"] == {"roughness": 0.3}
    assert vp.surfaces_for(doc, "hill") == [WATER] and vp.surfaces_for(doc, "room") == [WATER]
    # 清掉：空对象 / 空数组 = 删键
    _p, doc2, _w = placements.save_changes({"scenes": {"hill": {"surfaces": []}}, "defaultSurface": {}}, base=doc)
    assert "defaultSurface" not in doc2 and "hill" not in doc2["scenes"] and vp.surfaces_for(doc2, "room") == [WATER]


def test_scoped_save_refuses_when_the_default_changed_on_disk(lib_root) -> None:
    placements.save_changes({"scenes": {}, "defaultSurface": {"detail": 1.5}})
    stale = {"scenes": {}}
    with pytest.raises(ValueError, match="全局缺省表面材质已被外部修改"):
        placements.save_changes({"scenes": {}, "defaultSurface": {"detail": 0.2}}, base=stale)
    assert placements.load()[0]["defaultSurface"] == {"detail": 1.5}
    with pytest.raises(ValueError, match="detail"):
        placements.normalize_changes({"scenes": {}, "defaultSurface": {"detail": 9}})
