from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.production_workbench.image_tools import (
    ImageEditOptions,
    apply_image_edit,
    inspect_image,
    resolve_output_path,
)
from tools.production_workbench.workbench_window import CropPreviewLabel


class ProductionWorkbenchImageToolTests(TestCase):
    def test_image_edit_crops_resizes_adjusts_and_converts(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            src = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            src.parent.mkdir(parents=True)
            img = Image.new("RGBA", (100, 80), (10, 20, 30, 255))
            img.save(src)

            result = apply_image_edit(
                root,
                ImageEditOptions(
                    source_path="public/resources/runtime/images/props/ring.png",
                    output_path="public/resources/runtime/images/props/ring_small.jpg",
                    output_format="jpeg",
                    crop_x=10,
                    crop_y=5,
                    crop_width=50,
                    crop_height=40,
                    resize_width=25,
                    resize_height=20,
                    keep_aspect=False,
                    brightness=1.1,
                    contrast=1.2,
                ),
            )

            self.assertEqual((result.original_width, result.original_height), (100, 80))
            self.assertEqual((result.output_width, result.output_height), (25, 20))
            self.assertEqual(result.output_format, "jpeg")
            self.assertTrue(result.output_path.is_file())
            info = inspect_image(result.output_path)
            self.assertEqual((info.width, info.height), (25, 20))
            self.assertFalse(info.has_alpha)
            self.assertIn("裁剪", " ".join(result.operations))
            self.assertIn("缩放", " ".join(result.operations))

    def test_image_edit_trims_transparent_edges(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            src = root / "public" / "resources" / "runtime" / "images" / "props" / "trim.png"
            src.parent.mkdir(parents=True)
            img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
            img.paste((255, 0, 0, 255), (5, 4, 15, 14))
            img.save(src)

            result = apply_image_edit(
                root,
                ImageEditOptions(
                    source_path=str(src),
                    output_path="public/resources/runtime/images/props/trimmed.png",
                    trim_transparent=True,
                ),
            )

            self.assertEqual((result.output_width, result.output_height), (10, 10))
            self.assertTrue(result.has_alpha)
            self.assertIn("自动裁透明边", " ".join(result.operations))

    def test_image_edit_does_not_overwrite_without_confirmation(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            src = root / "public" / "resources" / "runtime" / "images" / "props" / "a.png"
            out = root / "public" / "resources" / "runtime" / "images" / "props" / "out.png"
            src.parent.mkdir(parents=True)
            Image.new("RGBA", (8, 8), (1, 2, 3, 255)).save(src)
            Image.new("RGBA", (4, 4), (9, 9, 9, 255)).save(out)

            with self.assertRaises(FileExistsError):
                apply_image_edit(
                    root,
                    ImageEditOptions(
                        source_path=str(src),
                        output_path="public/resources/runtime/images/props/out.png",
                    ),
                )

    def test_output_path_must_stay_inside_project(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            with self.assertRaises(ValueError):
                resolve_output_path(root, str(Path(td) / "outside.png"), "png")

    def test_explicit_output_format_aligns_file_suffix(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            output = resolve_output_path(root, "public/resources/runtime/images/props/out.png", "jpeg")
            self.assertEqual(output.suffix, ".jpg")
            self.assertTrue(str(output).endswith("out.jpg"))

    def test_crop_preview_maps_display_selection_to_source_pixels(self) -> None:
        app = QApplication.instance() or QApplication([])
        self.assertIsNotNone(app)

        with TemporaryDirectory() as td:
            src = Path(td) / "preview.png"
            Image.new("RGBA", (100, 80), (1, 2, 3, 255)).save(src)

            preview = CropPreviewLabel()
            preview.resize(500, 400)
            self.assertTrue(preview.set_image_path(src))

            preview.set_crop_pixels(10, 5, 50, 40)
            self.assertEqual(preview.current_crop_pixels(), (10, 5, 50, 40))

            preview.resize(250, 200)
            self.assertEqual(preview.current_crop_pixels(), (10, 5, 50, 40))


if __name__ == "__main__":
    import unittest

    unittest.main()
