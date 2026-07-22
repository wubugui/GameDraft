from __future__ import annotations

import sys

import numpy as np
import pytest
from PIL import Image

from tools.scene_depth_editor.workspace_cache import (
    DEPTH_CACHE_KIND,
    HDR_CACHE_KIND,
    array_sha256,
    build_cache_metadata,
    depth_signature,
    hdr_signature,
    load_json,
    save_json_atomic,
    save_npy_atomic,
    validate_cache_metadata,
)


def test_depth_cache_metadata_reports_exact_stale_source() -> None:
    depth = np.linspace(0.0, 1.0, 20, dtype=np.float32).reshape(4, 5)
    signature = depth_signature(
        background_sha256="background-a",
        model_id="depth-model-a",
        shape=depth.shape,
    )
    metadata = build_cache_metadata(
        kind=DEPTH_CACHE_KIND,
        signature=signature,
        array=depth,
    )
    assert validate_cache_metadata(
        metadata,
        kind=DEPTH_CACHE_KIND,
        expected_signature=signature,
        array=depth,
    ).fresh

    changed_background = depth_signature(
        background_sha256="background-b",
        model_id="depth-model-a",
        shape=depth.shape,
    )
    result = validate_cache_metadata(
        metadata,
        kind=DEPTH_CACHE_KIND,
        expected_signature=changed_background,
        array=depth,
    )
    assert result.fresh is False
    assert "背景图" in result.reason

    changed_model = depth_signature(
        background_sha256="background-a",
        model_id="depth-model-b",
        shape=depth.shape,
    )
    result = validate_cache_metadata(
        metadata,
        kind=DEPTH_CACHE_KIND,
        expected_signature=changed_model,
        array=depth,
    )
    assert result.fresh is False
    assert "模型" in result.reason


def test_hdr_cache_ignores_display_settings_but_tracks_physical_settings() -> None:
    radiance = np.ones((3, 4, 3), dtype=np.float32)
    signature = hdr_signature(
        background_sha256="background",
        gain_sha256="gain",
        shape=radiance.shape,
        scene_exposure_ev=1.0,
        gain_ev_scale=0.8,
        max_gain_ev=3.32,
        reference_white_nits=100.0,
    )
    metadata = build_cache_metadata(
        kind=HDR_CACHE_KIND,
        signature=signature,
        array=radiance,
    )
    # Tone mapper/display EV are intentionally absent from the physical signature.
    assert "display_exposure_ev" not in signature["physical_settings"]
    assert "tone_mapper" not in signature["physical_settings"]
    assert validate_cache_metadata(
        metadata,
        kind=HDR_CACHE_KIND,
        expected_signature=signature,
        array=radiance,
    ).fresh

    changed = hdr_signature(
        background_sha256="background",
        gain_sha256="gain",
        shape=radiance.shape,
        scene_exposure_ev=1.1,
        gain_ev_scale=0.8,
        max_gain_ev=3.32,
        reference_white_nits=100.0,
    )
    result = validate_cache_metadata(
        metadata,
        kind=HDR_CACHE_KIND,
        expected_signature=changed,
        array=radiance,
    )
    assert result.fresh is False
    assert "物理标定" in result.reason


def test_cache_detects_data_corruption() -> None:
    depth = np.zeros((2, 2), dtype=np.float32)
    signature = depth_signature(
        background_sha256="background",
        model_id="model",
        shape=depth.shape,
    )
    metadata = build_cache_metadata(
        kind=DEPTH_CACHE_KIND,
        signature=signature,
        array=depth,
    )
    corrupted = depth.copy()
    corrupted[0, 0] = 1.0
    assert array_sha256(corrupted) != metadata["data"]["sha256"]
    result = validate_cache_metadata(
        metadata,
        kind=DEPTH_CACHE_KIND,
        expected_signature=signature,
        array=corrupted,
    )
    assert result.fresh is False
    assert "损坏" in result.reason


def test_atomic_cache_round_trip(tmp_path) -> None:
    array_path = tmp_path / "radiance_cache.npy"
    metadata_path = tmp_path / "radiance_cache_meta.json"
    radiance = np.arange(36, dtype=np.float32).reshape(3, 4, 3)
    metadata = build_cache_metadata(
        kind=HDR_CACHE_KIND,
        signature=hdr_signature(
            background_sha256="background",
            gain_sha256=None,
            shape=radiance.shape,
            scene_exposure_ev=0.0,
            gain_ev_scale=1.0,
            max_gain_ev=3.32,
            reference_white_nits=100.0,
        ),
        array=radiance,
    )
    save_npy_atomic(array_path, radiance)
    save_json_atomic(metadata_path, metadata)
    loaded = np.load(array_path, allow_pickle=False)
    loaded_metadata = load_json(metadata_path)
    assert np.array_equal(loaded, radiance)
    assert loaded_metadata == metadata


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_editor_workspace_round_trips_depth_and_hdr_caches(tmp_path) -> None:
    from tools.scene_depth_editor.app import SceneDepthEditorApp

    source_pixels = np.zeros((12, 16, 3), dtype=np.uint8)
    source_pixels[..., 0] = np.arange(16, dtype=np.uint8)[None, :] * 8
    source_pixels[..., 1] = np.arange(12, dtype=np.uint8)[:, None] * 10
    source_image = Image.fromarray(source_pixels, "RGB")
    source = SceneDepthEditorApp()
    restored = SceneDepthEditorApp()
    try:
        source._scene_path = tmp_path
        source.source_image = source_image.copy()
        source.raw_depth_array = np.linspace(
            0.0, 1.0, 12 * 16, dtype=np.float64,
        ).reshape(12, 16)
        source._depth_generated_model_id = source._current_depth_model_id()
        assert source._write_depth_cache() is True
        assert source._write_hdr_cache() is True
        assert source._depth_cache_state == "fresh"
        assert source._hdr_cache_state == "fresh"
        assert (tmp_path / source._DEPTH_CACHE).exists()
        assert (tmp_path / source._DEPTH_CACHE_META).exists()
        assert (tmp_path / source._HDR_CACHE).exists()
        assert (tmp_path / source._HDR_CACHE_META).exists()

        restored._scene_path = tmp_path
        restored.source_image = source_image.copy()
        assert restored._load_depth_cache(tmp_path / restored._DEPTH_CACHE) is True
        restored._load_workspace_hdr_cache()
        assert restored._depth_cache_state == "fresh"
        assert restored._hdr_cache_state == "fresh"
        assert np.allclose(restored.raw_depth_array, source.raw_depth_array)
        assert np.array_equal(
            restored._hdr_cached_radiance,
            source._hdr_cached_radiance,
        )
    finally:
        source.root.destroy()
        restored.root.destroy()


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_depth_model_user_event_marks_editor_cache_for_update(tmp_path) -> None:
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication

    from tools.scene_depth_editor.app import SceneDepthEditorApp

    app = SceneDepthEditorApp()
    try:
        app._scene_path = tmp_path
        app.source_image = Image.new("RGB", (16, 12), (30, 40, 50))
        app.raw_depth_array = np.zeros((12, 16), dtype=np.float64)
        app._depth_generated_model_id = app._current_depth_model_id()
        assert app._write_depth_cache() is True
        app.root.show()
        QApplication.instance().processEvents()

        app.depth_model_combo.setFocus()
        QTest.keyClick(app.depth_model_combo, Qt.Key_Down)
        QTest.keyClick(app.depth_model_combo, Qt.Key_Return)
        QApplication.instance().processEvents()

        assert app._depth_cache_state == "stale"
        assert "模型" in app._depth_cache_reason
        assert "需要更新" in app._depth_cache_label.text()
        assert "需要更新" in app.status_var.get()
    finally:
        app.root.destroy()


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_background_load_preserves_software_camera_calibration(tmp_path) -> None:
    from tools.scene_depth_editor.app import SceneDepthEditorApp

    app = SceneDepthEditorApp()
    try:
        app._scene_path = tmp_path
        app._apply_calibration_data({
            "camera": {"cx": 3.25, "cy": 7.5},
            "depth_mapping": {},
        })
        background_path = tmp_path / app._BG_FILENAME
        Image.new("RGB", (16, 12), (20, 30, 40)).save(background_path)
        app._load_background(background_path)
        assert app.camera.cx == pytest.approx(3.25)
        assert app.camera.cy == pytest.approx(7.5)
    finally:
        app.root.destroy()
