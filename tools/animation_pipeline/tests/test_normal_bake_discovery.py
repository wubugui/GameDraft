"""展示图法线的发现口径 = 运行时预载清单请求 `.normal.png` 的那一组。

两侧一一对应是硬约束（见 `discover_display_images` 的 docstring）：这里漏一类，
那类图就没人烘，dev server 对不存在的文件回 200+HTML → Pixi 解码失败 → 进场弹红条。
2026-09-03 的铜钱就是这么漏的：当时只扫 `hotspots[]`，`npcs[].displayImage` 整类在外。
"""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tools.animation_pipeline.bake_normal_atlas import discover_display_images


def write_scene(root: Path, name: str, data: dict) -> None:
    scenes = root / "public/assets/scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    (scenes / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def touch_image(root: Path, rel: str) -> Path:
    path = root / "public" / rel.lstrip("/")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


class DisplayImageDiscoveryTests(unittest.TestCase):
    def test_covers_hotspot_and_static_npc_display_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hotspot_img = touch_image(root, "/resources/runtime/images/props/crate.png")
            npc_img = touch_image(root, "/resources/runtime/images/props/copper_coin.png")
            write_scene(root, "s.json", {
                "hotspots": [{"id": "hs", "displayImage": {"image": "/resources/runtime/images/props/crate.png"}}],
                "npcs": [{"id": "npc", "displayImage": {"image": "/resources/runtime/images/props/copper_coin.png"}}],
            })

            found = set(discover_display_images(root))

        self.assertEqual(found, {hotspot_img, npc_img})

    def test_skips_animated_npc_and_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            touch_image(root, "/resources/runtime/images/props/crate.png")
            write_scene(root, "s.json", {
                "npcs": [
                    # 有动画包 → 法线走图集那一路（bake_one），不是单帧展示图
                    {"id": "a", "animFile": "/resources/runtime/animation/x/anim.json",
                     "displayImage": {"image": "/resources/runtime/images/props/crate.png"}},
                    # 图不在盘上 → 不入队（烘不了，也不该报错）
                    {"id": "b", "displayImage": {"image": "/resources/runtime/images/props/gone.png"}},
                ],
            })

            self.assertEqual(discover_display_images(root), [])

    def test_renderRaw_placement_still_bakes(self) -> None:
        """`renderRaw` 是**这一处摆放**不受光；同一张图在别处（轨迹 spawn）照样受光。

        法线是图的派生物、不是摆放的派生物，且预载清单对 renderRaw 实体一样会请求它。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img = touch_image(root, "/resources/runtime/images/props/copper_coin.png")
            write_scene(root, "s.json", {
                "npcs": [{"id": "n", "renderRaw": True,
                          "displayImage": {"image": "/resources/runtime/images/props/copper_coin.png"}}],
            })

            self.assertEqual(discover_display_images(root), [img])


if __name__ == "__main__":
    unittest.main()
