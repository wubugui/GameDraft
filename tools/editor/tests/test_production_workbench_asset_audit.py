from __future__ import annotations

import struct
import zlib
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.production_workbench.asset_audit import (
    audit_asset_specs,
    format_asset_audit_report,
)


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _png_bytes(width: int, height: int, *, color_type: int = 6) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IEND", b"")


def _jpeg_bytes(width: int, height: int) -> bytes:
    sof = (
        b"\xff\xc0"
        + struct.pack(">H", 17)
        + b"\x08"
        + struct.pack(">HH", height, width)
        + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    )
    return b"\xff\xd8" + sof + b"\xff\xd9"


class ProductionWorkbenchAssetAuditTests(TestCase):
    def test_asset_audit_reads_dimensions_categories_and_animation_sheet(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            anim = root / "public" / "resources" / "runtime" / "animation" / "hero_anim"
            scene = root / "public" / "resources" / "runtime" / "scenes" / "dock"
            prop = root / "public" / "resources" / "runtime" / "images" / "props"
            audio = root / "public" / "resources" / "runtime" / "audio"
            anim.mkdir(parents=True)
            scene.mkdir(parents=True)
            prop.mkdir(parents=True)
            audio.mkdir(parents=True)
            (anim / "atlas.png").write_bytes(_png_bytes(128, 64, color_type=6))
            (anim / "anim.json").write_text("{}", encoding="utf-8")
            (scene / "background.jpg").write_bytes(_jpeg_bytes(320, 180))
            (prop / "ring.png").write_bytes(_png_bytes(32, 32, color_type=2))
            (audio / "cue.ogg").write_bytes(b"OggS")

            report = audit_asset_specs(root)
            text = format_asset_audit_report(report)

            self.assertEqual(len(report.images), 3)
            self.assertEqual(len(report.audio), 1)
            atlas = next(x for x in report.images if x.rel_path.endswith("atlas.png"))
            self.assertEqual((atlas.width, atlas.height), (128, 64))
            self.assertTrue(atlas.has_alpha)
            self.assertTrue(atlas.is_animation_sheet)
            bg = next(x for x in report.images if x.rel_path.endswith("background.jpg"))
            self.assertEqual((bg.width, bg.height), (320, 180))
            self.assertEqual(bg.category, "scene")
            self.assertIn("素材规格审计", text)
            self.assertIn("animation: 1", text)
            self.assertIn("scene: 1", text)
            self.assertIn("动画 sheet: 1", text)

    def test_asset_audit_reports_unknown_dimensions_without_crashing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            img = root / "public" / "resources" / "runtime" / "images" / "props"
            img.mkdir(parents=True)
            (img / "broken.png").write_bytes(b"not a png")

            report = audit_asset_specs(root)
            text = format_asset_audit_report(report)

            self.assertEqual(len(report.images), 1)
            self.assertIsNone(report.images[0].width)
            self.assertIn("无法读取尺寸: 1", text)

    def test_asset_audit_uses_file_magic_before_extension(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            img = root / "public" / "resources" / "runtime" / "images" / "backgrounds"
            img.mkdir(parents=True)
            (img / "actually_jpeg.png").write_bytes(_jpeg_bytes(640, 360))

            report = audit_asset_specs(root)

            self.assertEqual(len(report.images), 1)
            self.assertEqual((report.images[0].width, report.images[0].height), (640, 360))
            self.assertEqual(report.images[0].ext, "png")
            self.assertEqual(report.images[0].detected_format, "jpeg")


if __name__ == "__main__":
    import unittest

    unittest.main()
