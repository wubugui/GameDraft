"""`spriteSort` 三处登记面的 parity 锁（运行时 / 编辑器 / 校验器）。

`EntitySpriteSort` 的取值同时被四处手工镜像：

  1. `src/data/types.ts`      —— 权威联合类型（热点展示图与 NpcDef 共用）
  2. `src/entities/Npc.ts`    —— 把 def 的声明打到容器 `entitySortBand` 上
  3. `tools/editor/editors/scene_editor.py` —— NPC 面板下拉的 currentData
  4. `tools/editor/validator.py`            —— NPC 侧取值校验

norms 第 8 条：手工镜像必配语义级 parity。任一侧加了档位（比如将来加 'middle'）
而其它侧没跟，本文件即红——否则策划在编辑器里选得出来、运行时静默不认。
"""
from __future__ import annotations

from pathlib import Path
import re
import unittest

REPO = Path(__file__).resolve().parents[3]


def _read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


class SpriteSortParityTests(unittest.TestCase):
    def setUp(self) -> None:
        types_ts = _read("src/data/types.ts")
        m = re.search(r"export type EntitySpriteSort\s*=\s*([^;]+);", types_ts)
        self.assertIsNotNone(m, "src/data/types.ts 提不到 EntitySpriteSort 联合")
        self.bands = sorted(re.findall(r"'([^']+)'", m.group(1)))
        self.assertTrue(self.bands, "EntitySpriteSort 联合为空")
        self.types_ts = types_ts

    def test_npc_and_hotspot_share_the_same_union(self) -> None:
        npc_block = re.search(
            r"export interface NpcDef\s*\{(.*?)\n\}", self.types_ts, re.S
        )
        self.assertIsNotNone(npc_block, "提不到 interface NpcDef")
        self.assertRegex(
            npc_block.group(1),
            r"spriteSort\?:\s*EntitySpriteSort;",
            "NpcDef 没有声明 spriteSort（或没用共用联合类型）",
        )
        display_block = re.search(
            r"export interface HotspotDisplayImage\s*\{(.*?)\n\}", self.types_ts, re.S
        )
        self.assertIsNotNone(display_block, "提不到 interface HotspotDisplayImage")
        self.assertRegex(display_block.group(1), r"spriteSort\?:\s*EntitySpriteSort;")

    def test_runtime_npc_applies_every_band(self) -> None:
        npc_ts = _read("src/entities/Npc.ts")
        applied = re.search(
            r"applySpriteSortBand\(\):\s*void\s*\{.*?\n  \}", npc_ts, re.S
        )
        self.assertIsNotNone(applied, "Npc.ts 提不到 applySpriteSortBand 方法定义")
        body = applied.group(0)
        for band in self.bands:
            self.assertIn(
                f"'{band}'", body, f"Npc.applySpriteSortBand 不认档位 {band!r}"
            )
        # 构造时必须真的调用一次，否则字段写了也不生效
        self.assertIn("this.applySpriteSortBand();", npc_ts)

    def test_scene_editor_npc_combo_offers_every_band(self) -> None:
        editor_py = _read("tools/editor/editors/scene_editor.py")
        combo = re.findall(r"self\._npc_sprite_sort\.addItem\([^,]+,\s*\"([^\"]+)\"\)", editor_py)
        self.assertEqual(
            sorted(value for value in combo if value != "default"),
            self.bands,
            "NPC 面板「精灵排序」下拉与 EntitySpriteSort 不一致",
        )
        # 缺省项必须存在且写回时删键（不写 'default' 到 JSON）
        self.assertIn("default", combo)
        handler = re.search(
            r"def _on_npc_sprite_sort_changed\(.*?\n\n", editor_py, re.S
        )
        self.assertIsNotNone(handler, "提不到 _on_npc_sprite_sort_changed")
        self.assertIn('npc.pop("spriteSort", None)', handler.group(0))

    def test_validator_accepts_exactly_the_same_bands_for_npc(self) -> None:
        validator_py = _read("tools/editor/validator.py")
        m = re.search(
            r"nsort = npc\.get\(\"spriteSort\"\)\s*\n\s*if nsort is not None and nsort not in \(([^)]*)\)",
            validator_py,
        )
        self.assertIsNotNone(m, "validator 没有 NPC spriteSort 取值校验")
        self.assertEqual(sorted(re.findall(r"\"([^\"]+)\"", m.group(1))), self.bands)


if __name__ == "__main__":
    unittest.main()
