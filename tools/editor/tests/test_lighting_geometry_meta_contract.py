"""几何场 meta 的校验口径必须与运行时逐字相同。

运行时按 `src/core/lightingPayloadFiles.ts#LIGHTING_GEOMETRY_META_REQUIRED` 决定一份 `geometry.json`
能不能用;校验器是它的 Python 镜像。两边分家不会报错,只会出现"校验全绿、进游戏光照不启用"
(或反过来把能用的载荷报成 error)。这正是它取代的那个 `version == 4` 出过的事:同一个数手抄三处,
迁移脚本里那份早就停在 3。
"""
from __future__ import annotations

import re
from pathlib import Path

from tools.editor.validator import _LIGHTING_GEOMETRY_META_REQUIRED, _geometry_meta_problems

_ROOT = Path(__file__).resolve().parents[3]


def _ts_required() -> tuple[str, ...]:
    src = (_ROOT / "src" / "core" / "lightingPayloadFiles.ts").read_text(encoding="utf-8")
    m = re.search(r"export const LIGHTING_GEOMETRY_META_REQUIRED[^=]*=\s*\[([^\]]*)\]", src)
    assert m, "TS 里找不到 export const LIGHTING_GEOMETRY_META_REQUIRED = [...]"
    return tuple(re.findall(r"'([^']+)'", m.group(1)))


def test_字段表与运行时逐字相同() -> None:
    assert _LIGHTING_GEOMETRY_META_REQUIRED == _ts_required()


def test_版本号不参与判定() -> None:
    meta = {"native": {"w": 2048, "h": 1152}, "work": {"w": 512, "h": 288},
            "cal": {"ppu": 112.64}, "scale": {"char_wu": 0.49, "scene_per_wu": 302.7}}
    assert _geometry_meta_problems({**meta, "version": 3}) == []
    assert _geometry_meta_problems(meta) == []


def test_缺字段点名() -> None:
    assert _geometry_meta_problems({"native": {"w": 1}}) == [
        "native.h", "scale.scene_per_wu", "scale.char_wu", "work.w", "cal.ppu"]
    assert _geometry_meta_problems({"native": {"w": True, "h": 2}})[0] == "native.w"
