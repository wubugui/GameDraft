from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.asset_style_sampler import (
    build_asset_style_reference,
    format_asset_style_reference_report,
)


class ProductionWorkbenchAssetStyleSamplerTests(TestCase):
    def test_builds_style_reference_with_palette_and_naming_tokens(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            props = root / "public" / "resources" / "runtime" / "images" / "props"
            backgrounds = root / "public" / "resources" / "runtime" / "images" / "backgrounds"
            props.mkdir(parents=True)
            backgrounds.mkdir(parents=True)
            Image.new("RGBA", (16, 16), (224, 64, 32, 255)).save(props / "old_ring_clean_edge.png")
            Image.new("RGBA", (16, 16), (192, 64, 32, 255)).save(props / "old_ring_dirty_edge.png")
            Image.new("RGB", (320, 180), (40, 80, 120)).save(backgrounds / "market_dawn_bg.jpg")

            report = build_asset_style_reference(root, samples_per_category=2)
            text = format_asset_style_reference_report(report)

            by_category = {item.category: item for item in report.categories}
            self.assertIn("prop", by_category)
            self.assertIn("background", by_category)
            self.assertEqual(by_category["prop"].image_count, 2)
            self.assertGreaterEqual(by_category["prop"].alpha_count, 2)
            self.assertTrue(by_category["prop"].samples[0].palette)
            self.assertIn("old", dict(by_category["prop"].common_name_tokens))
            self.assertIn("素材风格/命名参考", text)
            self.assertIn("old_ring", text)
            self.assertIn("palette:", text)
            self.assertIn("给 GPT 的提示", text)


if __name__ == "__main__":
    import unittest

    unittest.main()
