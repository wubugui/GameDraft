from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time

import numpy as np
from PIL import Image, ImageDraw


TONE_MAPPER_ACES = "aces"
TONE_MAPPER_REINHARD = "reinhard"
TONE_MAPPER_LINEAR = "linear"
TONE_MAPPERS = (
    TONE_MAPPER_ACES,
    TONE_MAPPER_REINHARD,
    TONE_MAPPER_LINEAR,
)

PREVIEW_TONE_MAPPED = "tone_mapped"
PREVIEW_EV_HEATMAP = "ev_heatmap"
PREVIEW_GAIN_EV = "gain_ev"
PREVIEW_MODES = (
    PREVIEW_TONE_MAPPED,
    PREVIEW_EV_HEATMAP,
    PREVIEW_GAIN_EV,
)


@dataclass(frozen=True)
class HDRSettings:
    """Editor controls for the finalized LDR-to-radiance reconstruction.

    ``scene_exposure_ev`` and the effective gain map affect physical radiance.
    ``display_exposure_ev`` and ``tone_mapper`` affect SDR visualization only.
    """

    scene_exposure_ev: float = 0.0
    gain_ev_scale: float = 1.0
    max_gain_ev: float = 3.32
    display_exposure_ev: float = 0.0
    tone_mapper: str = TONE_MAPPER_ACES
    reference_white_nits: float = 100.0


@dataclass(frozen=True)
class HDRResult:
    radiance_nits: np.ndarray
    effective_gain_ev: np.ndarray
    stats: dict[str, float]

    @property
    def radiance_relative(self) -> np.ndarray:
        """Linear HDR relative to the configured reference white."""
        reference = max(float(self.stats.get("reference_white_nits", 100.0)), 1e-6)
        return (self.radiance_nits / np.float32(reference)).astype(np.float32)


def srgb_eotf(value: np.ndarray) -> np.ndarray:
    x = np.asarray(value, dtype=np.float32)
    return np.where(
        x <= 0.04045,
        x / 12.92,
        ((x + 0.055) / 1.055) ** 2.4,
    ).astype(np.float32)


def linear_to_srgb(value: np.ndarray) -> np.ndarray:
    x = np.maximum(np.asarray(value, dtype=np.float32), 0.0)
    return np.where(
        x <= 0.0031308,
        12.92 * x,
        1.055 * np.power(x, 1.0 / 2.4) - 0.055,
    ).astype(np.float32)


def _source_rgb(source: Image.Image | np.ndarray) -> np.ndarray:
    if isinstance(source, Image.Image):
        return np.asarray(source.convert("RGB"), dtype=np.float32) / 255.0
    array = np.asarray(source)
    if array.ndim != 3 or array.shape[2] < 3:
        raise ValueError("source must be an RGB image")
    rgb = array[..., :3].astype(np.float32)
    if np.issubdtype(array.dtype, np.integer):
        rgb /= np.float32(np.iinfo(array.dtype).max)
    return np.clip(rgb, 0.0, 1.0)


def prepare_linear_source(source: Image.Image | np.ndarray) -> np.ndarray:
    """Decode an LDR source once for low-latency exposure/gain iteration."""
    return srgb_eotf(_source_rgb(source))


def reconstruct_hdr(
    source: Image.Image | np.ndarray,
    gain_ev: np.ndarray | None,
    settings: HDRSettings,
) -> HDRResult:
    """Restore scene radiance using the approved exposure + sparse gain formula.

    No luminance heuristic is used to invent emitters.  A missing gain product is
    exactly a zero-EV map, so the UI can tune base exposure without silently
    changing the finalized offline-baker contract.
    """
    started = time.perf_counter()
    linear_source = prepare_linear_source(source)
    result = reconstruct_hdr_from_linear(linear_source, gain_ev, settings)
    result.stats["reconstruction_ms"] = float(
        (time.perf_counter() - started) * 1000.0
    )
    result.stats["source_preparation_ms"] = max(
        0.0,
        result.stats["reconstruction_ms"] - result.stats["radiance_update_ms"],
    )
    return result


def reconstruct_hdr_from_linear(
    linear_source: np.ndarray,
    gain_ev: np.ndarray | None,
    settings: HDRSettings,
) -> HDRResult:
    """Update HDR radiance from a cached linear source without repeating EOTF."""
    started = time.perf_counter()
    linear = np.asarray(linear_source, dtype=np.float32)
    if linear.ndim != 3 or linear.shape[2] != 3:
        raise ValueError("linear_source must have shape HxWx3")
    if not np.all(np.isfinite(linear)) or np.any(linear < 0.0):
        raise ValueError("linear_source must contain finite non-negative values")
    height, width = linear.shape[:2]
    if gain_ev is None:
        gain = np.zeros((height, width), dtype=np.float32)
    else:
        gain = np.asarray(gain_ev, dtype=np.float32)
        if gain.ndim == 3 and gain.shape[2] == 1:
            gain = gain[..., 0]
        if gain.shape != (height, width):
            raise ValueError(
                "gainEV shape does not match source image: "
                f"{gain.shape} != {(height, width)}"
            )
        gain = np.nan_to_num(gain, nan=0.0, posinf=0.0, neginf=0.0)

    max_gain = max(0.0, float(settings.max_gain_ev))
    gain_scale = max(0.0, float(settings.gain_ev_scale))
    effective_gain = np.clip(gain * np.float32(gain_scale), 0.0, max_gain)
    total_ev = np.clip(
        effective_gain + np.float32(settings.scene_exposure_ev), -32.0, 32.0,
    )
    radiance = (
        np.float32(max(float(settings.reference_white_nits), 1e-6))
        * linear
        * np.exp2(total_ev)[..., None]
    ).astype(np.float32)
    stats = radiance_statistics(radiance, settings.reference_white_nits)
    stats["gain_ev_min"] = float(np.min(effective_gain))
    stats["gain_ev_max"] = float(np.max(effective_gain))
    stats["gain_coverage_percent"] = float(np.mean(effective_gain > 1e-4) * 100.0)
    stats["radiance_update_ms"] = float((time.perf_counter() - started) * 1000.0)
    stats["reconstruction_ms"] = stats["radiance_update_ms"]
    stats["source_preparation_ms"] = 0.0
    return HDRResult(radiance, effective_gain.astype(np.float32), stats)


def luminance_nits(radiance_nits: np.ndarray) -> np.ndarray:
    rgb = np.asarray(radiance_nits, dtype=np.float32)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("radiance must have shape HxWx3")
    return (
        rgb[..., 0] * np.float32(0.2126)
        + rgb[..., 1] * np.float32(0.7152)
        + rgb[..., 2] * np.float32(0.0722)
    ).astype(np.float32)


def radiance_statistics(
    radiance_nits: np.ndarray,
    reference_white_nits: float = 100.0,
) -> dict[str, float]:
    luminance = luminance_nits(radiance_nits)
    finite = luminance[np.isfinite(luminance)]
    if finite.size == 0:
        finite = np.zeros(1, dtype=np.float32)
    return {
        "luminance_min_nits": float(np.min(finite)),
        "luminance_p50_nits": float(np.percentile(finite, 50.0)),
        "luminance_p95_nits": float(np.percentile(finite, 95.0)),
        "luminance_max_nits": float(np.max(finite)),
        "above_100_nits_percent": float(np.mean(finite > 100.0) * 100.0),
        "above_1000_nits_percent": float(np.mean(finite > 1000.0) * 100.0),
        "reference_white_nits": float(reference_white_nits),
        "data_megabytes": float(np.asarray(radiance_nits).nbytes / (1024.0 * 1024.0)),
    }


def tone_map_linear(linear_hdr: np.ndarray, tone_mapper: str = TONE_MAPPER_ACES) -> np.ndarray:
    x = np.maximum(np.asarray(linear_hdr, dtype=np.float32), 0.0)
    if tone_mapper == TONE_MAPPER_ACES:
        mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
    elif tone_mapper == TONE_MAPPER_REINHARD:
        mapped = x / (1.0 + x)
    elif tone_mapper == TONE_MAPPER_LINEAR:
        mapped = x
    else:
        raise ValueError(f"unsupported tone mapper: {tone_mapper}")
    return np.clip(mapped, 0.0, 1.0).astype(np.float32)


def display_rgb(
    radiance_nits: np.ndarray,
    settings: HDRSettings,
) -> np.ndarray:
    reference = max(float(settings.reference_white_nits), 1e-6)
    linear_hdr = (
        np.asarray(radiance_nits, dtype=np.float32)
        / np.float32(reference)
        * np.float32(2.0 ** float(settings.display_exposure_ev))
    )
    mapped = tone_map_linear(linear_hdr, settings.tone_mapper)
    return np.clip(linear_to_srgb(mapped), 0.0, 1.0)


def display_relative_rgba(
    linear_hdr: np.ndarray,
    alpha: np.ndarray,
    settings: HDRSettings,
) -> Image.Image:
    exposed = (
        np.asarray(linear_hdr, dtype=np.float32)
        * np.float32(2.0 ** float(settings.display_exposure_ev))
    )
    mapped = tone_map_linear(exposed, settings.tone_mapper)
    rgb = np.clip(linear_to_srgb(mapped), 0.0, 1.0)
    a = np.clip(np.asarray(alpha, dtype=np.float32), 0.0, 1.0)
    rgba = np.dstack([rgb, a])
    return Image.fromarray(np.round(rgba * 255.0).astype(np.uint8), "RGBA")


_HEAT_STOPS = np.asarray([
    [0.02, 0.02, 0.10],
    [0.08, 0.18, 0.55],
    [0.00, 0.72, 0.88],
    [0.24, 0.88, 0.30],
    [1.00, 0.86, 0.08],
    [1.00, 0.20, 0.03],
    [1.00, 1.00, 1.00],
], dtype=np.float32)


def _heat_color(normalized: np.ndarray) -> np.ndarray:
    t = np.clip(np.asarray(normalized, dtype=np.float32), 0.0, 1.0)
    scaled = t * np.float32(len(_HEAT_STOPS) - 1)
    lower = np.minimum(np.floor(scaled).astype(np.int32), len(_HEAT_STOPS) - 2)
    fraction = (scaled - lower)[..., None]
    return _HEAT_STOPS[lower] * (1.0 - fraction) + _HEAT_STOPS[lower + 1] * fraction


def render_hdr_preview(
    result: HDRResult,
    settings: HDRSettings,
    mode: str = PREVIEW_TONE_MAPPED,
    *,
    include_scale: bool = True,
) -> Image.Image:
    if mode == PREVIEW_TONE_MAPPED:
        rgb = display_rgb(result.radiance_nits, settings)
        scale_min, scale_max = -8.0, 6.0
        scale_label = "Luminance EV relative to 100 nit"
    elif mode == PREVIEW_EV_HEATMAP:
        luminance = luminance_nits(result.radiance_nits)
        ev = np.log2(np.maximum(luminance, 1e-6) / np.float32(settings.reference_white_nits))
        scale_min, scale_max = -8.0, 6.0
        rgb = _heat_color((ev - scale_min) / (scale_max - scale_min))
        scale_label = "Luminance EV relative to 100 nit"
    elif mode == PREVIEW_GAIN_EV:
        scale_min, scale_max = 0.0, max(float(settings.max_gain_ev), 0.01)
        rgb = _heat_color(result.effective_gain_ev / np.float32(scale_max))
        scale_label = "Effective gainEV"
    else:
        raise ValueError(f"unsupported preview mode: {mode}")

    image = Image.fromarray(np.round(np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8), "RGB")
    if not include_scale:
        return image

    legend_height = 70
    canvas = Image.new("RGB", (image.width, image.height + legend_height), (22, 22, 24))
    canvas.paste(image, (0, 0))
    draw = ImageDraw.Draw(canvas)
    margin = min(24, max(8, image.width // 40))
    bar_y = image.height + 12
    bar_width = max(2, image.width - margin * 2)
    gradient = np.linspace(0.0, 1.0, bar_width, dtype=np.float32)
    colors = _heat_color(gradient)
    bar = np.broadcast_to(colors[None, :, :], (12, bar_width, 3))
    bar_img = Image.fromarray(np.round(bar * 255.0).astype(np.uint8), "RGB")
    canvas.paste(bar_img, (margin, bar_y))
    draw.text((margin, bar_y + 17), f"{scale_min:+.2f}", fill=(225, 225, 225))
    right_text = f"{scale_max:+.2f}"
    right_x = max(margin, image.width - margin - 36)
    draw.text((right_x, bar_y + 17), right_text, fill=(225, 225, 225))
    draw.text((margin, bar_y + 36), scale_label, fill=(180, 180, 185))
    stats = result.stats
    summary = (
        f"p50 {stats['luminance_p50_nits']:.1f} nit   "
        f"p95 {stats['luminance_p95_nits']:.1f}   "
        f"max {stats['luminance_max_nits']:.1f}"
    )
    draw.text((max(margin, image.width - margin - 240), bar_y + 36), summary, fill=(180, 180, 185))
    return canvas


def load_gain_ev(
    path: str | Path,
    expected_shape: tuple[int, int],
    *,
    image_max_gain_ev: float = 3.32,
) -> np.ndarray:
    """Load a formal EV array (.npy) or a normalized grayscale exchange image."""
    source_path = Path(path)
    if source_path.suffix.lower() == ".npy":
        gain = np.load(str(source_path), allow_pickle=False)
        if gain.ndim == 3 and gain.shape[2] == 1:
            gain = gain[..., 0]
        gain = np.asarray(gain, dtype=np.float32)
    else:
        image = Image.open(source_path)
        array = np.asarray(image)
        if array.ndim == 3:
            if array.shape[2] < 3:
                array = array[..., 0]
            else:
                rgb = array[..., :3].astype(np.float32)
                array = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
        if np.issubdtype(array.dtype, np.integer):
            normalized = array.astype(np.float32) / np.float32(np.iinfo(array.dtype).max)
        else:
            normalized = np.clip(array.astype(np.float32), 0.0, 1.0)
        gain = normalized * np.float32(max(0.0, image_max_gain_ev))

    if gain.shape != tuple(expected_shape):
        raise ValueError(
            f"gainEV resolution {gain.shape} does not match scene {expected_shape}"
        )
    return np.nan_to_num(gain, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)
