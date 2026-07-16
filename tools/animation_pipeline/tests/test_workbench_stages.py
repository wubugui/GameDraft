from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import cv2
import numpy as np

from tools.animation_pipeline import workbench_stages as stages


def rgba_frame(width: int, height: int, color=(20, 40, 60, 0)) -> np.ndarray:
    frame = np.zeros((height, width, 4), dtype=np.uint8)
    frame[:, :] = color
    return frame


class WorkbenchStageTests(unittest.TestCase):
    def test_e_decodes_explicit_order_and_keeps_full_canvas(self) -> None:
        class FakeCapture:
            def isOpened(self) -> bool:
                return True

            def get(self, prop: int) -> float:
                if prop == cv2.CAP_PROP_FPS:
                    return 24.0
                if prop == cv2.CAP_PROP_FRAME_COUNT:
                    return 8.0
                return 0.0

            def release(self) -> None:
                pass

        def fake_decode(cap, indices, times, *args):
            output = []
            for index in indices:
                frame = np.zeros((5, 7, 4), dtype=np.uint8)
                frame[:, :, 0] = index  # BGRA blue -> RGBA blue after conversion.
                frame[:, :, 3] = 255
                output.append(frame)
            return output, list(times)

        with tempfile.TemporaryDirectory() as tmp:
            video = Path(tmp) / "source.mp4"
            video.touch()
            with mock.patch.object(stages.cv2, "VideoCapture", return_value=FakeCapture()), mock.patch.object(
                stages.atlas_core, "_decode_rgba_index_sequence", side_effect=fake_decode
            ):
                result = stages.decode_explicit_video_frames(video, [5, 1, 5])

        self.assertEqual([frame.shape for frame in result.frames], [(5, 7, 4)] * 3)
        self.assertEqual([int(frame[0, 0, 2]) for frame in result.frames], [5, 1, 5])
        self.assertEqual(
            [record["sourceFrameIndex"] for record in result.records], [5, 1, 5]
        )
        self.assertEqual(result.metadata["geometryOperations"], [])

    def test_e_loop_metrics_compare_closing_transition_with_normal_steps(self) -> None:
        frames = []
        for value in (0, 10, 20, 30):
            frame = rgba_frame(4, 3, (value, value, value, 255))
            frames.append(frame)
        metrics = stages.loop_transition_metrics(frames)
        self.assertGreater(metrics["closingToMedianRatio"], 2.9)
        self.assertEqual(len(metrics["adjacentMeanAbsDeltas"]), 3)
        self.assertEqual(metrics["endpointAlphaIoU"], 1.0)

    def test_f_uses_one_union_crop_without_recentering(self) -> None:
        first = rgba_frame(10, 8)
        second = rgba_frame(10, 8)
        first[1:3, 1:4] = (255, 0, 0, 255)
        second[4:7, 6:9] = (0, 255, 0, 255)

        result = stages.union_crop_frames(
            [first, second], bbox_method="alpha", threshold=0.1
        )

        self.assertEqual(result.metadata["unionCrop"], {"x0": 1, "y0": 1, "x1": 9, "y1": 7})
        self.assertEqual([frame.shape for frame in result.frames], [(6, 8, 4)] * 2)
        # Both positions are shifted by the same union origin; neither bbox is centred.
        self.assertEqual(stages._alpha_bbox(result.frames[0]), (0, 0, 3, 2))
        self.assertEqual(stages._alpha_bbox(result.frames[1]), (5, 3, 8, 6))
        self.assertFalse(result.metadata["perFrameTranslation"])
        self.assertFalse(result.metadata["perFrameScale"])

    def test_g_records_fusion_fallback_and_preserves_geometry_order(self) -> None:
        first = rgba_frame(6, 4, (10, 20, 30, 255))
        second = rgba_frame(6, 4, (40, 50, 60, 255))

        def unavailable(_rgb: np.ndarray) -> np.ndarray:
            raise RuntimeError("offline model")

        def fallback(rgb: np.ndarray, _model: str) -> np.ndarray:
            return np.full(rgb.shape[:2], rgb[0, 0, 0] / 255.0, dtype=np.float32)

        with mock.patch.object(stages.matting, "_birefnet_alpha", side_effect=unavailable), mock.patch.object(
            stages.matting, "_rembg_alpha", side_effect=fallback
        ):
            result = stages.matte_sequence_preserve_geometry(
                [first, second], method="fusion"
            )

        self.assertEqual([frame.shape for frame in result.frames], [(4, 6, 4)] * 2)
        np.testing.assert_array_equal(result.frames[0][:, :, :3], first[:, :, :3])
        np.testing.assert_array_equal(result.frames[1][:, :, :3], second[:, :, :3])
        self.assertEqual(
            [record["actualMethod"] for record in result.records],
            ["rembg_isnet", "rembg_isnet"],
        )
        self.assertIn("offline model", result.records[0]["fallback"]["reason"])
        self.assertEqual(result.metadata["fallbackFrameCount"], 2)
        self.assertFalse(result.metadata["cropApplied"])

    def test_g_rejects_geometry_change(self) -> None:
        frame = rgba_frame(6, 4, (10, 20, 30, 255))

        def bad_runner(_frame: np.ndarray, method: str):
            return rgba_frame(5, 4), {"requestedMethod": method, "actualMethod": method}

        with self.assertRaisesRegex(RuntimeError, "changed frame 0 geometry"):
            stages.matte_sequence_preserve_geometry(
                [frame], method="color_key", matte_one=bad_runner
            )

    def test_r_maps_custom_root_with_one_uniform_action_transform(self) -> None:
        first = rgba_frame(8, 8)
        second = rgba_frame(8, 8)
        first[3:5, 2:4] = (255, 100, 50, 255)
        second[2:5, 3:5] = (50, 100, 255, 255)

        result = stages.bake_calibrated_action(
            [first, second],
            source_root={"x": 2, "y": 5},
            scale=2.0,
            target_root={"x": 8, "y": 12},
            cell_size={"width": 20, "height": 20},
        )

        matrix = np.asarray(result.metadata["matrix"])
        mapped = matrix @ np.array([2.0, 5.0, 1.0])
        np.testing.assert_allclose(mapped, [8.0, 12.0])
        self.assertTrue(result.metadata["sameTransformForEveryFrame"])
        self.assertEqual([frame.shape for frame in result.frames], [(20, 20, 4)] * 2)
        self.assertEqual(result.metadata["clippedFrameIndices"], [])

    def test_r_visibility_does_not_drop_an_action(self) -> None:
        frame = rgba_frame(8, 8)
        frame[2:6, 2:6] = (200, 100, 50, 255)
        result = stages.bake_calibrated_actions(
            {
                "idle": {
                    "frames": [frame],
                    "sourceRoot": {"x": 4, "y": 6},
                    "scale": 1,
                    "frameRate": 8,
                    "loop": True,
                    "visible": False,
                }
            },
            cell_size={"width": 12, "height": 12},
            target_root={"x": 6, "y": 10},
            world_size={"width": None, "height": 120.5},
        )
        self.assertEqual(result.metadata["states"]["idle"]["frames"], [0])
        self.assertFalse(result.metadata["actions"]["idle"]["visible"])

    def test_h_packs_common_cells_without_pixel_changes(self) -> None:
        frames = [
            rgba_frame(4, 5, (255, 0, 0, 255)),
            rgba_frame(4, 5, (0, 255, 0, 255)),
            rgba_frame(4, 5, (0, 0, 255, 255)),
        ]
        atlas, anim, meta = stages.pack_common_cell_states(
            frames,
            {
                "idle": {"frames": [0, 1], "frameRate": 8, "loop": True},
                "jump": {"frames": [2], "frameRate": 6, "loop": False},
            },
            world_size={"width": None, "height": 120.5},
            max_side=20,
        )

        atlas_rgba = np.asarray(atlas)
        self.assertEqual((meta["cols"], meta["rows"]), (3, 1))
        for i, frame in enumerate(frames):
            np.testing.assert_array_equal(atlas_rgba[:, i * 4 : (i + 1) * 4], frame)
        self.assertEqual(anim["states"]["idle"]["frames"], [0, 1])
        self.assertEqual(anim["states"]["jump"]["frames"], [2])
        self.assertNotIn("worldWidth", anim)
        self.assertEqual(anim["worldHeight"], 120.5)
        self.assertEqual(meta["geometryOperations"], [])

    def test_h_rejects_non_uniform_world_quad_scale(self) -> None:
        frame = rgba_frame(4, 5, (255, 0, 0, 255))
        with self.assertRaisesRegex(ValueError, "aspect must match"):
            stages.pack_common_cell_states(
                [frame],
                {"idle": {"frames": [0], "frameRate": 8, "loop": True}},
                world_size={"width": 100, "height": 100},
            )

    def test_stage_writes_are_new_only_and_hash_verified(self) -> None:
        frame = rgba_frame(4, 5, (255, 0, 0, 255))
        result = stages.StageSequence(
            frames=[frame], records=[{"sequenceIndex": 0}], metadata={}
        )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "E"
            stages.write_sequence_stage(out, "E", result)
            loaded, manifest = stages.load_sequence_stage(out)
            np.testing.assert_array_equal(loaded.frames[0], frame)
            self.assertEqual(manifest["stage"], "E")
            with self.assertRaises(FileExistsError):
                stages.write_sequence_stage(out, "E", result)

    def test_r_to_h_cli_handlers_create_staging_bundle(self) -> None:
        frame = rgba_frame(8, 8)
        frame[2:6, 2:6] = (220, 120, 40, 255)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            g_dir = root / "G-idle"
            stages.write_sequence_stage(
                g_dir,
                "G",
                stages.StageSequence(
                    frames=[frame], records=[{"sequenceIndex": 0}], metadata={}
                ),
            )
            calibration = root / "calibration.json"
            calibration.write_text(
                json.dumps(
                    {
                        "cellSize": {"width": 12, "height": 12},
                        "targetRoot": {"x": 6, "y": 10},
                        "worldSize": {"width": None, "height": 120.25},
                        "actions": {
                            "idle": {
                                "source": str(g_dir),
                                "sourceRoot": {"x": 4, "y": 6},
                                "scale": 1,
                                "frameRate": 8,
                                "loop": True,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            r_dir = root / "R"
            h_dir = root / "H"
            stages._cmd_r(SimpleNamespace(calibration=str(calibration), out=str(r_dir)))
            manifest = stages._cmd_h(
                SimpleNamespace(input=str(r_dir), out=str(h_dir), max_side=2048)
            )

            anim = json.loads((h_dir / "anim.json").read_text(encoding="utf-8"))
            r_manifest = json.loads((r_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(anim["states"]["idle"]["frames"], [0])
            self.assertEqual(anim["worldHeight"], 120.25)
            self.assertEqual(
                r_manifest["metadata"]["actions"]["idle"]["sourceStage"],
                str(g_dir.resolve()),
            )
            self.assertEqual(
                len(r_manifest["metadata"]["actions"]["idle"]["sourceManifestSha256"]),
                64,
            )
            self.assertTrue(manifest["stagingOnly"])
            self.assertFalse(manifest["published"])

    def test_h_writer_refuses_runtime_tree_without_touching_it(self) -> None:
        frame = rgba_frame(2, 2, (255, 0, 0, 255))
        atlas, anim, meta = stages.pack_common_cell_states(
            [frame],
            {"idle": {"frames": [0], "frameRate": 8, "loop": True}},
            world_size={"width": 50, "height": 50},
        )
        forbidden = stages.RUNTIME_ROOT / "__workbench_test_must_not_exist__"
        self.assertFalse(forbidden.exists())
        with self.assertRaisesRegex(ValueError, "staging-only"):
            stages.write_h_stage(
                forbidden, atlas, anim, meta, source_r_stage="/tmp/nonexistent-r"
            )
        self.assertFalse(forbidden.exists())

    def test_h_static_stages_a_byte_identical_transparent_png_new_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "accepted-c.png"
            pixels = rgba_frame(7, 5)
            pixels[1:5, 2:6] = (120, 80, 220, 255)
            from PIL import Image

            Image.fromarray(pixels, mode="RGBA").save(source, format="PNG")
            source_bytes = source.read_bytes()
            out = root / "H_STATIC"
            manifest = stages.write_h_static_stage(
                out,
                source,
                target_name="npc_example.png",
                world_height=96.5,
            )

            self.assertEqual((out / "npc_example.png").read_bytes(), source_bytes)
            self.assertEqual(manifest["stage"], "H_STATIC")
            self.assertEqual(manifest["targetFileName"], "npc_example.png")
            self.assertEqual(manifest["geometryOperations"], [])
            self.assertEqual(manifest["worldSize"], {"width": None, "height": 96.5})
            with self.assertRaises(FileExistsError):
                stages.write_h_static_stage(
                    out,
                    source,
                    target_name="npc_example.png",
                )

    def test_h_static_rejects_opaque_or_runtime_output(self) -> None:
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "opaque.png"
            Image.new("RGB", (3, 4), (10, 20, 30)).save(source, format="PNG")
            with self.assertRaisesRegex(ValueError, "transparent channel"):
                stages.write_h_static_stage(
                    Path(tmp) / "out",
                    source,
                    target_name="npc.png",
                )
            with self.assertRaisesRegex(ValueError, "one PNG filename"):
                stages._static_target_name("../npc.png")

        forbidden = stages.RUNTIME_ROOT / "__workbench_h_static_test_must_not_exist__"
        self.assertFalse(forbidden.exists())
        with self.assertRaisesRegex(ValueError, "staging-only"):
            stages.write_h_static_stage(
                forbidden,
                "/tmp/nonexistent-c.png",
                target_name="npc.png",
            )
        self.assertFalse(forbidden.exists())

    def test_cli_calibration_wrapper_shape_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "calibration.json"
            payload = {
                "calibration": {
                    "worldSize": {"width": 80, "height": 120},
                    "targetRoot": {"x": 10, "y": 20},
                }
            }
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(stages._load_calibration(path), payload["calibration"])


if __name__ == "__main__":
    unittest.main()
