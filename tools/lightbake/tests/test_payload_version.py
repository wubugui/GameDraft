"""载荷代次钉死：`PAYLOAD_VERSION = 6`。

⚠ 三处常量必须同时改（方案 §4.1），本测试只钉死本工具这一处；
`src/core/SceneLightingSystem.ts` 与 `tools/editor/validator.py` 另两处留待 P6 接线时同步。
"""
from __future__ import annotations

from tools.lightbake.payload import PAYLOAD_VERSION


def test_payload_version_is_six():
    assert PAYLOAD_VERSION == 6
