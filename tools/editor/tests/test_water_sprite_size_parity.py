"""水域画布精灵尺寸 parity：编辑器画布的品类默认显示尺寸必须与运行时
``src/systems/waterMinigame/WaterEntity.ts`` 的 ``DEFAULT_DISPLAY_SIZE`` 逐值一致。

背景（审查 P2）：画布曾用 grass56/floating48/其余44 的独立表，与运行时
grass70/sunken62/floating46/swimming52 脱节，预览尺寸撒谎。此处从运行时源码解析
常量与画布表对账（editor-tools-norms 不变量 8：手工镜像清单必配 parity 测试），
防两处再各自漂移。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor.editors.water_minigame_canvas import (
    _DEFAULT_DISPLAY_SIZE,
    _DISPLAY_SIZE_FALLBACK,
    _target_edge_for_entity,
)


def _repo_root() -> Path:
    # tools/editor/tests/ → 仓库根
    return Path(__file__).resolve().parents[3]


def _parse_runtime_default_display_size() -> dict[str, int]:
    src = (_repo_root() / "src" / "systems" / "waterMinigame" / "WaterEntity.ts").read_text(
        encoding="utf-8",
    )
    m = re.search(
        r"DEFAULT_DISPLAY_SIZE\s*:\s*Record<[^>]+>\s*=\s*\{(.*?)\}",
        src,
        re.DOTALL,
    )
    assert m is not None, "未能在 WaterEntity.ts 定位 DEFAULT_DISPLAY_SIZE"
    body = m.group(1)
    out: dict[str, int] = {}
    for key, val in re.findall(r"(\w+)\s*:\s*(\d+)", body):
        out[key] = int(val)
    return out


class WaterSpriteSizeParityTests(unittest.TestCase):
    def test_editor_table_matches_runtime(self) -> None:
        runtime = _parse_runtime_default_display_size()
        self.assertTrue(runtime, "解析运行时常量为空——正则或源文件结构变了")
        self.assertEqual(
            _DEFAULT_DISPLAY_SIZE, runtime,
            "画布品类默认显示尺寸必须与运行时 WaterEntity.ts 逐值一致",
        )

    def test_runtime_fallback_constant(self) -> None:
        # WaterEntity 构造里 `DEFAULT_DISPLAY_SIZE[cat] ?? 52`：兜底 52 也须对齐。
        src = (_repo_root() / "src" / "systems" / "waterMinigame" / "WaterEntity.ts").read_text(
            encoding="utf-8",
        )
        self.assertIn("?? 52", src, "运行时兜底常量变了，请同步 _DISPLAY_SIZE_FALLBACK")
        self.assertEqual(_DISPLAY_SIZE_FALLBACK, 52)

    def test_display_size_overrides_category_default(self) -> None:
        # displaySize（>0 有限）优先于品类默认；否则回落品类默认。
        self.assertEqual(_target_edge_for_entity({"category": "grass"}), 70.0)
        self.assertEqual(
            _target_edge_for_entity({"category": "grass", "displaySize": 120}), 120.0,
        )
        # displaySize 0 / 负 / 非数：忽略，回落品类默认。
        self.assertEqual(
            _target_edge_for_entity({"category": "sunken", "displaySize": 0}), 62.0,
        )
        self.assertEqual(
            _target_edge_for_entity({"category": "floating", "displaySize": -5}), 46.0,
        )
        # 未知品类：兜底 52。
        self.assertEqual(_target_edge_for_entity({"category": "???"}), 52.0)


if __name__ == "__main__":
    unittest.main()
