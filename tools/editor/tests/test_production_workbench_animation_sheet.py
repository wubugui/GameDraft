from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from PIL import Image

from tools.production_workbench.animation_sheet import (
    ComposeSheetOptions,
    SheetGridOptions,
    compose_animation_sheet,
    format_animation_sheet_report,
    inspect_animation_sheet,
    split_animation_sheet,
)
from tools.production_workbench.image_tools import inspect_image


class ProductionWorkbenchAnimationSheetTests(TestCase):
    def test_inspect_and_split_animation_sheet(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            sheet_path = root / "public" / "resources" / "runtime" / "animation" / "dog_walk.png"
            _write_sheet(sheet_path)

            report = inspect_animation_sheet(
                root,
                SheetGridOptions(
                    source_path="public/resources/runtime/animation/dog_walk.png",
                    columns=2,
                    rows=2,
                    frame_count=4,
                ),
            )
            text = format_animation_sheet_report(report)

            self.assertEqual((report.frame_width, report.frame_height), (10, 8))
            self.assertEqual(report.frame_count, 4)
            self.assertIn("动画 Sheet 检查", text)

            split = split_animation_sheet(
                root,
                SheetGridOptions(
                    source_path="public/resources/runtime/animation/dog_walk.png",
                    columns=2,
                    rows=2,
                    frame_count=4,
                ),
                "public/resources/runtime/animation/dog_walk_frames",
            )

            self.assertEqual(len(split.frame_paths), 4)
            self.assertTrue(split.frame_paths[0].is_file())
            info = inspect_image(split.frame_paths[0])
            self.assertEqual((info.width, info.height), (10, 8))

    def test_compose_animation_sheet_from_frames(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            frames_dir = root / "public" / "resources" / "runtime" / "animation" / "frames"
            frames_dir.mkdir(parents=True)
            for idx, color in enumerate([(255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)]):
                Image.new("RGBA", (6, 4), color).save(frames_dir / f"frame_{idx + 1:03d}.png")

            result = compose_animation_sheet(
                root,
                ComposeSheetOptions(
                    frames_dir="public/resources/runtime/animation/frames",
                    output_path="public/resources/runtime/animation/combined.png",
                    columns=2,
                    padding=1,
                ),
            )

            self.assertTrue(result.output_path.is_file())
            self.assertEqual((result.columns, result.rows), (2, 2))
            self.assertEqual((result.frame_width, result.frame_height), (6, 4))
            info = inspect_image(result.output_path)
            self.assertEqual((info.width, info.height), (13, 9))

    def test_compose_rejects_mismatched_frame_sizes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            frames_dir = root / "public" / "resources" / "runtime" / "animation" / "frames"
            frames_dir.mkdir(parents=True)
            Image.new("RGBA", (6, 4), (255, 0, 0, 255)).save(frames_dir / "a.png")
            Image.new("RGBA", (7, 4), (0, 255, 0, 255)).save(frames_dir / "b.png")

            with self.assertRaises(ValueError):
                compose_animation_sheet(
                    root,
                    ComposeSheetOptions(
                        frames_dir="public/resources/runtime/animation/frames",
                        output_path="public/resources/runtime/animation/combined.png",
                        columns=2,
                    ),
                )


def _write_sheet(path: Path) -> None:
    path.parent.mkdir(parents=True)
    sheet = Image.new("RGBA", (20, 16), (0, 0, 0, 0))
    colors = [
        (255, 0, 0, 255),
        (0, 255, 0, 255),
        (0, 0, 255, 255),
        (255, 255, 0, 255),
    ]
    for idx, color in enumerate(colors):
        col = idx % 2
        row = idx // 2
        frame = Image.new("RGBA", (10, 8), color)
        sheet.paste(frame, (col * 10, row * 8))
    sheet.save(path)


if __name__ == "__main__":
    import unittest

    unittest.main()
