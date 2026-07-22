from __future__ import annotations

import numpy as np
from PIL import Image
import pytest

from tools.scene_depth_editor.hdr_reconstruction import (
    HDRSettings,
    PREVIEW_EV_HEATMAP,
    PREVIEW_GAIN_EV,
    PREVIEW_TONE_MAPPED,
    load_gain_ev,
    prepare_linear_source,
    reconstruct_hdr,
    reconstruct_hdr_from_linear,
    render_hdr_preview,
)
from tools.scene_depth_editor.lighting_debug import (
    FinalGatherSettings,
    QuadSettings,
    compute_final_gather,
)
from tools.scene_depth_editor.reconstruction import OrthoProjection


def _projection() -> OrthoProjection:
    return OrthoProjection(
        R=np.eye(3, dtype=np.float64),
        ppu=10.0,
        cx=16.0,
        cy=16.0,
    )


def test_hdr_reconstruction_matches_finalized_formula() -> None:
    source = Image.new("RGB", (2, 1), (128, 64, 32))
    gain = np.array([[0.0, 1.0]], dtype=np.float32)
    settings = HDRSettings(
        scene_exposure_ev=1.0,
        gain_ev_scale=1.0,
        max_gain_ev=3.32,
    )
    result = reconstruct_hdr(source, gain, settings)
    srgb = np.array([128.0, 64.0, 32.0], dtype=np.float32) / 255.0
    linear = np.where(
        srgb <= 0.04045,
        srgb / 12.92,
        ((srgb + 0.055) / 1.055) ** 2.4,
    )
    assert np.allclose(result.radiance_nits[0, 0], 100.0 * linear * 2.0, rtol=2e-6)
    assert np.allclose(result.radiance_nits[0, 1], 100.0 * linear * 4.0, rtol=2e-6)
    assert result.radiance_nits.dtype == np.float32
    assert result.stats["gain_coverage_percent"] == pytest.approx(50.0)
    assert result.stats["reconstruction_ms"] >= 0.0


def test_missing_gain_is_exactly_zero_not_luminance_heuristic() -> None:
    source = Image.fromarray(np.array([[[255, 255, 255], [1, 1, 1]]], dtype=np.uint8), "RGB")
    result = reconstruct_hdr(source, None, HDRSettings(scene_exposure_ev=0.0))
    assert np.array_equal(result.effective_gain_ev, np.zeros((1, 2), dtype=np.float32))
    assert result.stats["gain_coverage_percent"] == 0.0


def test_cached_linear_source_produces_identical_hdr() -> None:
    source = Image.new("RGB", (7, 5), (120, 80, 20))
    gain = np.linspace(0.0, 2.0, 35, dtype=np.float32).reshape(5, 7)
    settings = HDRSettings(scene_exposure_ev=-0.7, gain_ev_scale=0.8)
    direct = reconstruct_hdr(source, gain, settings)
    cached = reconstruct_hdr_from_linear(prepare_linear_source(source), gain, settings)
    assert np.array_equal(cached.radiance_nits, direct.radiance_nits)
    assert np.array_equal(cached.effective_gain_ev, direct.effective_gain_ev)
    assert cached.stats["radiance_update_ms"] >= 0.0


def test_gain_product_resolution_is_strict(tmp_path) -> None:
    path = tmp_path / "gain.npy"
    np.save(path, np.ones((4, 5), dtype=np.float32))
    loaded = load_gain_ev(path, (4, 5))
    assert loaded.shape == (4, 5)
    with pytest.raises(ValueError, match="does not match"):
        load_gain_ev(path, (5, 4))


@pytest.mark.parametrize(
    "mode", (PREVIEW_TONE_MAPPED, PREVIEW_EV_HEATMAP, PREVIEW_GAIN_EV),
)
def test_hdr_preview_has_luminance_scale(mode: str) -> None:
    source = Image.new("RGB", (32, 16), (180, 90, 40))
    result = reconstruct_hdr(source, np.ones((16, 32), dtype=np.float32), HDRSettings())
    preview = render_hdr_preview(result, HDRSettings(), mode, include_scale=True)
    assert preview.size == (32, 86)
    assert preview.mode == "RGB"


def test_final_gather_prefers_supplied_hdr_over_ldr_fallback() -> None:
    depth = np.ones((32, 32), dtype=np.float32)
    source = Image.new("RGB", (32, 32), (0, 0, 0))
    sprite = Image.new("RGBA", (8, 8), (255, 255, 255, 255))
    supplied = np.full((32, 32, 3), 3.0, dtype=np.float32)
    result = compute_final_gather(
        source,
        depth,
        sprite,
        _projection(),
        QuadSettings(
            foot_world=(0.0, 0.0, 0.0),
            width=0.4,
            height=0.6,
            main_normal_local=(0.0, 0.0, 1.0),
            calculation_height=8,
        ),
        FinalGatherSettings(
            samples_per_pixel=32,
            step_pixels=1.0,
            max_distance=8.0,
            front_epsilon_pixels=0.5,
            back_thickness_pixels=1.5,
        ),
        scene_radiance=supplied,
    )
    assert result.metrics["radiance_source"] == "provided_hdr"
    active = result.quad.active
    assert float(np.max(result.radiance[active])) > 1.0
    assert float(np.max(result.shaded_linear_hdr[active])) > 1.0
