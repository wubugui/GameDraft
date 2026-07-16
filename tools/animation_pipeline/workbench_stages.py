"""Deterministic stage adapters for the animation resource workbench.

This module deliberately does *not* drive the graph and never publishes into
``public/resources/runtime``.  It turns an already reviewed parent revision
into a new, non-overwriting staging directory:

E  explicit video frame indices -> full-canvas PNG sequence
F  per-frame subject bbox -> one union rectangle applied to every frame
G  precise matte -> same geometry and ordering, with actual fallback provenance
R  human calibration -> uniform per-action transform into one common cell
H  common cells -> row-major atlas + GameDraft anim.json staging package
H_STATIC  accepted C PNG -> byte-identical, explicitly named static staging package

The array-level functions are intentionally independent of the workbench
database so they can be tested and reused by an Agent that has read the IDE's
structured state.  All arrays in this module use RGBA byte order.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import threading
from typing import Any, Callable, Mapping, Sequence

import cv2
import numpy as np
from PIL import Image

from tools.animation_pipeline import matting
from tools.video_to_atlas import atlas_core


SCHEMA_VERSION = 1
RUNTIME_ROOT = (
    Path(__file__).resolve().parents[2] / "public" / "resources" / "runtime"
).resolve()
_MATTING_PROVENANCE_LOCK = threading.Lock()


@dataclass
class StageSequence:
    """In-memory stage result; ``frames`` are always HxWx4 uint8 RGBA."""

    frames: list[np.ndarray]
    records: list[dict[str, Any]]
    metadata: dict[str, Any]


def _rgba(frame: np.ndarray, *, label: str = "frame") -> np.ndarray:
    arr = np.asarray(frame)
    if arr.dtype != np.uint8:
        raise ValueError(f"{label} must be uint8, got {arr.dtype}")
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError(f"{label} must be HxWx3 or HxWx4")
    if arr.shape[0] < 1 or arr.shape[1] < 1:
        raise ValueError(f"{label} has an empty canvas")
    if arr.shape[2] == 3:
        alpha = np.full(arr.shape[:2] + (1,), 255, dtype=np.uint8)
        arr = np.concatenate((arr, alpha), axis=2)
    return np.ascontiguousarray(arr.copy())


def _validate_same_canvas(frames: Sequence[np.ndarray]) -> tuple[int, int]:
    if not frames:
        raise ValueError("frame sequence is empty")
    h, w = frames[0].shape[:2]
    for i, frame in enumerate(frames):
        if frame.shape != (h, w, 4):
            raise ValueError(
                f"frame {i} canvas {frame.shape} differs from {(h, w, 4)}"
            )
    return w, h


def _as_finite(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number")
    return result


def _positive(value: Any, label: str) -> float:
    result = _as_finite(value, label)
    if result <= 0:
        raise ValueError(f"{label} must be > 0")
    return result


def _positive_optional(value: Any, label: str) -> float | None:
    if value is None:
        return None
    return _positive(value, label)


def _point(value: Any, label: str) -> tuple[float, float]:
    if isinstance(value, Mapping):
        return _as_finite(value.get("x"), f"{label}.x"), _as_finite(
            value.get("y"), f"{label}.y"
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        if len(value) == 2:
            return _as_finite(value[0], f"{label}[0]"), _as_finite(
                value[1], f"{label}[1]"
            )
    raise ValueError(f"{label} must be {{x, y}} or [x, y]")


def _size(value: Any, label: str) -> tuple[int, int]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be {{width, height}}")
    width = _positive(value.get("width"), f"{label}.width")
    height = _positive(value.get("height"), f"{label}.height")
    if not width.is_integer() or not height.is_integer():
        raise ValueError(f"{label} pixel dimensions must be integers")
    return int(width), int(height)


def _pixel_size_sequence(value: Sequence[Any], label: str) -> tuple[int, int]:
    if len(value) != 2:
        raise ValueError(f"{label} must contain width and height")
    width = _positive(value[0], f"{label}[0]")
    height = _positive(value[1], f"{label}[1]")
    if not width.is_integer() or not height.is_integer():
        raise ValueError(f"{label} pixel dimensions must be integers")
    return int(width), int(height)


def _validate_world_aspect(
    world_width: float | None,
    world_height: float | None,
    cell_width: int,
    cell_height: int,
) -> None:
    """Prevent SpriteEntity from introducing a hidden non-uniform X/Y scale."""

    if world_width is None or world_height is None:
        return
    pixel_aspect = cell_width / cell_height
    world_aspect = world_width / world_height
    if not math.isclose(pixel_aspect, world_aspect, rel_tol=1e-6, abs_tol=1e-6):
        raise ValueError(
            "worldSize aspect must match the common cell to preserve uniform runtime scale; "
            "provide one dimension only or an aspect-matched width/height pair"
        )


def loop_transition_metrics(rgba_frames: Sequence[np.ndarray]) -> dict[str, Any]:
    """Measure the closing transition without pretending it replaces review.

    A cyclic motion does not require its last and first images to be identical.
    The useful signal is how the closing-frame delta compares with ordinary
    adjacent deltas in the selected sequence.
    """

    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(rgba_frames)]
    _validate_same_canvas(frames)
    if len(frames) < 2:
        raise ValueError("loop seam metrics require at least two frames")

    def delta(left: np.ndarray, right: np.ndarray) -> float:
        return float(np.mean(np.abs(left.astype(np.float32) - right.astype(np.float32))) / 255.0)

    adjacent = [delta(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    closing = delta(frames[-1], frames[0])
    median_adjacent = float(np.median(np.asarray(adjacent, dtype=np.float64)))
    ratio = closing / max(median_adjacent, 1e-9)
    first_alpha = frames[0][:, :, 3] > 8
    last_alpha = frames[-1][:, :, 3] > 8
    union = int(np.logical_or(first_alpha, last_alpha).sum())
    alpha_iou = float(np.logical_and(first_alpha, last_alpha).sum() / union) if union else 1.0
    return {
        "closingMeanAbsDelta": closing,
        "adjacentMeanAbsDeltas": adjacent,
        "medianAdjacentMeanAbsDelta": median_adjacent,
        "closingToMedianRatio": ratio,
        "endpointAlphaIoU": alpha_iou,
        "interpretation": "review aid only; play the loop in the IDE before accepting E",
    }


def decode_explicit_video_frames(
    video_path: str | Path,
    frame_indices: Sequence[int],
    *,
    loop_required: bool = False,
) -> StageSequence:
    """Decode exactly ``frame_indices`` in the given order without cropping.

    Duplicate and descending indices are allowed because the human/Agent may
    intentionally author such a sequence.  Invalid indices and partial decode
    are errors instead of being silently clamped or skipped.
    """

    path = Path(video_path)
    if not path.is_file():
        raise FileNotFoundError(f"video does not exist: {path}")
    if not frame_indices:
        raise ValueError("at least one explicit frame index is required")
    indices: list[int] = []
    for i, raw in enumerate(frame_indices):
        if isinstance(raw, bool) or not isinstance(raw, (int, np.integer)):
            raise ValueError(f"frame index {i} is not an integer: {raw!r}")
        indices.append(int(raw))

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        cap.release()
        raise RuntimeError(f"cannot open video: {path}")
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if total <= 0:
            raise RuntimeError(f"video reports no addressable frames: {path}")
        if fps <= 1e-6:
            raise RuntimeError(f"video reports an invalid frame rate: {path}")
        for index in indices:
            if index < 0 or index >= total:
                raise ValueError(
                    f"frame index {index} outside video range 0..{total - 1}"
                )
        times = [index / fps for index in indices]
        bgra_frames, decoded_times = atlas_core._decode_rgba_index_sequence(
            cap,
            indices,
            times,
            False,
            (0, 0, 0),
            0.0,
            total,
        )
    finally:
        cap.release()

    if len(bgra_frames) != len(indices):
        raise RuntimeError(
            f"decoded {len(bgra_frames)} of {len(indices)} requested frames"
        )
    frames = [
        np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGRA2RGBA))
        for frame in bgra_frames
    ]
    frames = [_rgba(frame, label=f"decoded frame {i}") for i, frame in enumerate(frames)]
    width, height = _validate_same_canvas(frames)
    records = [
        {
            "sequenceIndex": i,
            "sourceFrameIndex": index,
            "timeSec": decoded_times[i],
        }
        for i, index in enumerate(indices)
    ]
    metadata = {
        "sourceVideo": str(path.resolve()),
        "sourceFrameCount": total,
        "sourceFps": fps,
        "originalCanvas": {"width": width, "height": height},
        "selectionMode": "explicit_frame_indices",
        "geometryOperations": [],
        "loopRequired": bool(loop_required),
    }
    if loop_required:
        metadata["loopTransitionMetrics"] = loop_transition_metrics(frames)
    return StageSequence(
        frames=frames,
        records=records,
        metadata=metadata,
    )


def _normalise_mask(mask: np.ndarray, shape: tuple[int, int], label: str) -> np.ndarray:
    arr = np.asarray(mask)
    if arr.shape != shape:
        raise ValueError(f"{label} shape {arr.shape} differs from {shape}")
    if arr.dtype == np.bool_:
        return arr.astype(np.float32)
    out = arr.astype(np.float32)
    if not np.isfinite(out).all():
        raise ValueError(f"{label} contains non-finite values")
    if out.size and float(out.max()) > 1.0:
        out /= 255.0
    return np.clip(out, 0.0, 1.0)


def _bbox_from_mask(mask: np.ndarray, threshold: float) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask > threshold)
    if len(xs) == 0:
        raise ValueError("subject mask is empty at the configured threshold")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def union_crop_frames(
    rgba_frames: Sequence[np.ndarray],
    *,
    masks: Sequence[np.ndarray] | None = None,
    bbox_method: str = "auto",
    threshold: float = 0.10,
    padding: int = 0,
) -> StageSequence:
    """Apply one union bbox crop to every frame.

    ``auto`` uses alpha only when every frame already has meaningful
    transparency; otherwise it uses the existing flat-grey color key merely as
    a coarse bbox detector.  It never translates, scales, or recentres a frame.
    """

    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(rgba_frames)]
    width, height = _validate_same_canvas(frames)
    threshold = _as_finite(threshold, "threshold")
    if threshold < 0 or threshold >= 1:
        raise ValueError("threshold must be in [0, 1)")
    if isinstance(padding, bool) or int(padding) != padding or padding < 0:
        raise ValueError("padding must be a non-negative integer")
    padding = int(padding)

    if masks is not None:
        if len(masks) != len(frames):
            raise ValueError("mask count differs from frame count")
        detector = "provided_mask"
        subject_masks = [
            _normalise_mask(mask, (height, width), f"mask {i}")
            for i, mask in enumerate(masks)
        ]
    else:
        allowed = {"auto", "alpha", "color_key"}
        if bbox_method not in allowed:
            raise ValueError(f"bbox_method must be one of {sorted(allowed)}")
        detector = bbox_method
        if detector == "auto":
            alpha_is_meaningful = all(
                bool(np.any(frame[:, :, 3] < 255)) for frame in frames
            )
            detector = "alpha" if alpha_is_meaningful else "color_key"
        if detector == "alpha":
            subject_masks = [frame[:, :, 3].astype(np.float32) / 255.0 for frame in frames]
        else:
            subject_masks = [matting.color_key(frame[:, :, :3]) for frame in frames]

    boxes = [_bbox_from_mask(mask, threshold) for mask in subject_masks]
    x0 = max(0, min(box[0] for box in boxes) - padding)
    y0 = max(0, min(box[1] for box in boxes) - padding)
    x1 = min(width, max(box[2] for box in boxes) + padding)
    y1 = min(height, max(box[3] for box in boxes) + padding)
    union_box = (x0, y0, x1, y1)
    cropped = [frame[y0:y1, x0:x1].copy() for frame in frames]
    crop_width, crop_height = _validate_same_canvas(cropped)
    records = [
        {
            "sequenceIndex": i,
            "sourceBbox": {"x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3]},
        }
        for i, b in enumerate(boxes)
    ]
    return StageSequence(
        frames=cropped,
        records=records,
        metadata={
            "originalCanvas": {"width": width, "height": height},
            "outputCanvas": {"width": crop_width, "height": crop_height},
            "bboxDetector": detector,
            "bboxThreshold": threshold,
            "padding": padding,
            "unionCrop": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
            "geometryInvariant": "one_fixed_union_crop_for_every_frame",
            "perFrameTranslation": False,
            "perFrameScale": False,
        },
    )


def matte_rgba_with_provenance(
    rgba_frame: np.ndarray,
    method: str = "fusion",
) -> tuple[np.ndarray, dict[str, Any]]:
    """Call the existing matting implementation and expose its real fallback.

    ``matting.matte`` intentionally swallows the BiRefNet exception for fusion.
    The narrow, process-local instrumentation below records that exception and
    the rembg model actually called.  A lock ensures calls through this adapter
    cannot interleave while the two module functions are wrapped.
    """

    frame = _rgba(rgba_frame)
    supported = {"fusion", "color_key", "birefnet", "rembg_isnet"}
    if method not in supported:
        raise ValueError(f"matte method must be one of {sorted(supported)}")
    fallback_reason: str | None = None
    rembg_model: str | None = None

    if method != "fusion":
        out = matting.matte_rgba(frame[:, :, :3], method)
        actual = method
    else:
        with _MATTING_PROVENANCE_LOCK:
            original_birefnet = matting._birefnet_alpha
            original_rembg = matting._rembg_alpha

            def tracked_birefnet(rgb: np.ndarray) -> np.ndarray:
                nonlocal fallback_reason
                try:
                    return original_birefnet(rgb)
                except Exception as exc:
                    fallback_reason = f"{type(exc).__name__}: {exc}"[:500]
                    raise

            def tracked_rembg(rgb: np.ndarray, model: str = "isnet-general-use") -> np.ndarray:
                nonlocal rembg_model
                rembg_model = model
                return original_rembg(rgb, model)

            matting._birefnet_alpha = tracked_birefnet
            matting._rembg_alpha = tracked_rembg
            try:
                out = matting.matte_rgba(frame[:, :, :3], method)
            finally:
                matting._birefnet_alpha = original_birefnet
                matting._rembg_alpha = original_rembg
        actual = "rembg_isnet" if rembg_model is not None else "fusion"

    result = _rgba(out, label="matting output")
    if result.shape != frame.shape:
        raise RuntimeError(
            f"matting changed geometry from {frame.shape} to {result.shape}"
        )
    provenance: dict[str, Any] = {
        "requestedMethod": method,
        "actualMethod": actual,
    }
    if actual != method:
        provenance["fallback"] = {
            "from": method,
            "to": actual,
            "reason": fallback_reason or "BiRefNet unavailable",
        }
        if rembg_model is not None:
            provenance["fallback"]["model"] = rembg_model
    return result, provenance


def matte_sequence_preserve_geometry(
    rgba_frames: Sequence[np.ndarray],
    *,
    method: str = "fusion",
    matte_one: Callable[[np.ndarray, str], tuple[np.ndarray, dict[str, Any]]] | None = None,
) -> StageSequence:
    """Matte frames in order and reject any geometry mutation."""

    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(rgba_frames)]
    width, height = _validate_same_canvas(frames)
    runner = matte_one or (lambda frame, requested: matte_rgba_with_provenance(frame, requested))
    output: list[np.ndarray] = []
    records: list[dict[str, Any]] = []
    for i, frame in enumerate(frames):
        result, provenance = runner(frame, method)
        result = _rgba(result, label=f"matting output {i}")
        if result.shape != frame.shape:
            raise RuntimeError(
                f"matting changed frame {i} geometry from {frame.shape} to {result.shape}"
            )
        output.append(result)
        records.append({"sequenceIndex": i, **provenance})
    actual_counts = Counter(str(record["actualMethod"]) for record in records)
    fallback_count = sum(1 for record in records if "fallback" in record)
    return StageSequence(
        frames=output,
        records=records,
        metadata={
            "canvas": {"width": width, "height": height},
            "requestedMethod": method,
            "actualMethodCounts": dict(sorted(actual_counts.items())),
            "fallbackFrameCount": fallback_count,
            "geometryInvariant": "matting_only_same_canvas_same_order",
            "cropApplied": False,
            "translationApplied": False,
            "scaleApplied": False,
        },
    )


def _alpha_bbox(rgba: np.ndarray, threshold: int = 8) -> tuple[int, int, int, int]:
    ys, xs = np.where(rgba[:, :, 3] > threshold)
    if len(xs) == 0:
        raise ValueError("transparent/empty frame cannot be calibrated")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _warp_rgba_uniform(
    rgba: np.ndarray, matrix: np.ndarray, cell_size: tuple[int, int]
) -> np.ndarray:
    """Premultiplied-alpha affine warp, preventing grey RGB edge bleed."""

    width, height = cell_size
    source = rgba.astype(np.float32)
    alpha = source[:, :, 3:4] / 255.0
    premultiplied = np.concatenate((source[:, :, :3] * alpha, source[:, :, 3:4]), axis=2)
    warped = cv2.warpAffine(
        premultiplied,
        matrix.astype(np.float32),
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0.0, 0.0, 0.0, 0.0),
    )
    out_alpha = np.clip(warped[:, :, 3:4], 0.0, 255.0)
    alpha_unit = out_alpha / 255.0
    out_rgb = np.zeros_like(warped[:, :, :3])
    np.divide(
        warped[:, :, :3],
        alpha_unit,
        out=out_rgb,
        where=alpha_unit > (1.0 / 255.0),
    )
    out = np.concatenate((np.clip(out_rgb, 0.0, 255.0), out_alpha), axis=2)
    return np.ascontiguousarray(np.rint(out).astype(np.uint8))


def bake_calibrated_action(
    rgba_frames: Sequence[np.ndarray],
    *,
    source_root: tuple[float, float] | Mapping[str, Any] | Sequence[float],
    scale: float,
    target_root: tuple[float, float] | Mapping[str, Any] | Sequence[float],
    cell_size: tuple[int, int] | Mapping[str, Any],
    allow_clip: bool = False,
) -> StageSequence:
    """Bake one action using one root and one uniform transform for all frames."""

    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(rgba_frames)]
    source_width, source_height = _validate_same_canvas(frames)
    sx, sy = _point(source_root, "sourceRoot")
    tx, ty = _point(target_root, "targetRoot")
    uniform_scale = _positive(scale, "scale")
    if isinstance(cell_size, Mapping):
        cell_width, cell_height = _size(cell_size, "cellSize")
    else:
        cell_width, cell_height = _pixel_size_sequence(cell_size, "cell_size")
    if tx < 0 or tx > cell_width or ty < 0 or ty > cell_height:
        raise ValueError("targetRoot must lie on or inside the common cell")

    dx = tx - sx * uniform_scale
    dy = ty - sy * uniform_scale
    matrix = np.array(
        [[uniform_scale, 0.0, dx], [0.0, uniform_scale, dy]], dtype=np.float64
    )
    transformed_bounds: list[dict[str, float]] = []
    clipped_indices: list[int] = []
    for i, frame in enumerate(frames):
        x0, y0, x1, y1 = _alpha_bbox(frame)
        bounds = {
            "x0": x0 * uniform_scale + dx,
            "y0": y0 * uniform_scale + dy,
            "x1": x1 * uniform_scale + dx,
            "y1": y1 * uniform_scale + dy,
        }
        transformed_bounds.append(bounds)
        if (
            bounds["x0"] < -1e-6
            or bounds["y0"] < -1e-6
            or bounds["x1"] > cell_width + 1e-6
            or bounds["y1"] > cell_height + 1e-6
        ):
            clipped_indices.append(i)
    if clipped_indices and not allow_clip:
        raise ValueError(
            "calibration clips visible pixels in frames "
            + ", ".join(str(index) for index in clipped_indices)
        )

    baked = [
        _warp_rgba_uniform(frame, matrix, (cell_width, cell_height)) for frame in frames
    ]
    records = [
        {
            "sequenceIndex": i,
            "transformedAlphaBounds": transformed_bounds[i],
            "clipped": i in clipped_indices,
        }
        for i in range(len(frames))
    ]
    return StageSequence(
        frames=baked,
        records=records,
        metadata={
            "sourceCanvas": {"width": source_width, "height": source_height},
            "cellSize": {"width": cell_width, "height": cell_height},
            "sourceRoot": {"x": sx, "y": sy},
            "targetRoot": {"x": tx, "y": ty},
            "uniformScale": uniform_scale,
            "matrix": matrix.tolist(),
            "sameTransformForEveryFrame": True,
            "clippedFrameIndices": clipped_indices,
        },
    )


def bake_calibrated_actions(
    actions: Mapping[str, Mapping[str, Any]],
    *,
    cell_size: tuple[int, int] | Mapping[str, Any],
    target_root: tuple[float, float] | Mapping[str, Any] | Sequence[float],
    world_size: Mapping[str, Any],
) -> StageSequence:
    """Flatten all manually calibrated actions into common-cell frame order."""

    if not actions:
        raise ValueError("calibration contains no actions")
    if not isinstance(world_size, Mapping):
        raise ValueError("worldSize must be {width, height}")
    world_width = _positive_optional(world_size.get("width"), "worldSize.width")
    world_height = _positive_optional(world_size.get("height"), "worldSize.height")
    if world_width is None and world_height is None:
        raise ValueError("worldSize must define width and/or height")
    target = _point(target_root, "targetRoot")
    if isinstance(cell_size, Mapping):
        cell = _size(cell_size, "cellSize")
    else:
        cell = _pixel_size_sequence(cell_size, "cell_size")
    _validate_world_aspect(world_width, world_height, cell[0], cell[1])

    flat_frames: list[np.ndarray] = []
    flat_records: list[dict[str, Any]] = []
    action_reports: dict[str, Any] = {}
    state_specs: dict[str, dict[str, Any]] = {}
    cursor = 0
    for action_id, spec in actions.items():
        if not isinstance(action_id, str) or not action_id.strip():
            raise ValueError("action ids must be non-empty strings")
        source_frames = spec.get("frames")
        if not isinstance(source_frames, Sequence) or isinstance(source_frames, (str, bytes)):
            raise ValueError(f"actions.{action_id}.frames must be a frame sequence")
        loop = spec.get("loop")
        if not isinstance(loop, bool):
            raise ValueError(f"actions.{action_id}.loop must be boolean")
        frame_rate = _positive(spec.get("frameRate"), f"actions.{action_id}.frameRate")
        result = bake_calibrated_action(
            source_frames,
            source_root=spec.get("sourceRoot"),
            scale=spec.get("scale"),
            target_root=target,
            cell_size=cell,
            allow_clip=False,
        )
        indices = list(range(cursor, cursor + len(result.frames)))
        state_specs[action_id] = {
            "frames": indices,
            "frameRate": frame_rate,
            "loop": loop,
        }
        for action_frame_index, (frame, record) in enumerate(
            zip(result.frames, result.records)
        ):
            flat_frames.append(frame)
            flat_records.append(
                {
                    **record,
                    "sequenceIndex": cursor + action_frame_index,
                    "actionId": action_id,
                    "actionFrameIndex": action_frame_index,
                }
            )
        action_reports[action_id] = {
            **result.metadata,
            "frameRate": frame_rate,
            "loop": loop,
            # UI visibility is review-only; it must never drop an action from H.
            "visible": bool(spec.get("visible", True)),
            "frameIndices": indices,
        }
        cursor += len(result.frames)

    return StageSequence(
        frames=flat_frames,
        records=flat_records,
        metadata={
            "cellSize": {"width": cell[0], "height": cell[1]},
            "targetRoot": {"x": target[0], "y": target[1]},
            "worldSize": {"width": world_width, "height": world_height},
            "actions": action_reports,
            "states": state_specs,
            "geometryInvariant": "one_uniform_transform_per_action_into_common_cell",
            "humanAuthored": True,
        },
    )


def choose_grid(
    frame_count: int, cell_width: int, cell_height: int, max_side: int = 2048
) -> tuple[int, int]:
    """Choose a fitting row-major grid without changing common-cell pixels."""

    if frame_count <= 0:
        raise ValueError("frame_count must be > 0")
    if cell_width <= 0 or cell_height <= 0:
        raise ValueError("cell dimensions must be > 0")
    if max_side <= 0 or max_side > 2048:
        raise ValueError("max_side must be in 1..2048")
    max_cols = min(frame_count, max_side // cell_width)
    candidates: list[tuple[tuple[int, int, int], int, int]] = []
    for cols in range(1, max_cols + 1):
        rows = math.ceil(frame_count / cols)
        atlas_width = cols * cell_width
        atlas_height = rows * cell_height
        if atlas_height > max_side:
            continue
        score = (
            cols * rows - frame_count,
            atlas_width * atlas_height,
            abs(atlas_width - atlas_height),
        )
        candidates.append((score, cols, rows))
    if not candidates:
        raise ValueError(
            f"{frame_count} cells of {cell_width}x{cell_height} cannot fit within {max_side}x{max_side}; "
            "reduce frame count or adjust the human R-stage cell/scale"
        )
    _, cols, rows = min(candidates, key=lambda item: item[0])
    return cols, rows


def pack_common_cell_states(
    rgba_frames: Sequence[np.ndarray],
    states: Mapping[str, Mapping[str, Any]],
    *,
    world_size: Mapping[str, Any],
    max_side: int = 2048,
) -> tuple[Image.Image, dict[str, Any], dict[str, Any]]:
    """Pack already-common R cells; no crop, translation, or scaling occurs."""

    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(rgba_frames)]
    cell_width, cell_height = _validate_same_canvas(frames)
    if not states:
        raise ValueError("states are empty")
    normalised_states: dict[str, dict[str, Any]] = {}
    referenced: list[int] = []
    for name, spec in states.items():
        if not isinstance(name, str) or not name:
            raise ValueError("state names must be non-empty strings")
        raw_indices = spec.get("frames")
        if not isinstance(raw_indices, list) or not raw_indices:
            raise ValueError(f"state {name} must contain frame indices")
        indices: list[int] = []
        for raw in raw_indices:
            if isinstance(raw, bool) or not isinstance(raw, (int, np.integer)):
                raise ValueError(f"state {name} contains a non-integer frame index")
            index = int(raw)
            if index < 0 or index >= len(frames):
                raise ValueError(f"state {name} frame {index} is out of range")
            indices.append(index)
        loop = spec.get("loop")
        if not isinstance(loop, bool):
            raise ValueError(f"state {name}.loop must be boolean")
        frame_rate = _positive(spec.get("frameRate"), f"state {name}.frameRate")
        normalised_states[name] = {
            "frames": indices,
            "frameRate": frame_rate,
            "loop": loop,
        }
        referenced.extend(indices)
    if sorted(referenced) != list(range(len(frames))):
        raise ValueError("R frames must be referenced exactly once across H states")

    if not isinstance(world_size, Mapping):
        raise ValueError("world_size must be {width, height}")
    world_width = _positive_optional(world_size.get("width"), "worldSize.width")
    world_height = _positive_optional(world_size.get("height"), "worldSize.height")
    if world_width is None and world_height is None:
        raise ValueError("worldSize must define width and/or height")
    _validate_world_aspect(world_width, world_height, cell_width, cell_height)

    cols, rows = choose_grid(len(frames), cell_width, cell_height, max_side)
    atlas_arr = np.zeros((rows * cell_height, cols * cell_width, 4), dtype=np.uint8)
    content_sizes: list[tuple[int, int]] = []
    for index, frame in enumerate(frames):
        col, row = index % cols, index // cols
        y0, x0 = row * cell_height, col * cell_width
        atlas_arr[y0 : y0 + cell_height, x0 : x0 + cell_width] = frame
        bx0, by0, bx1, by1 = _alpha_bbox(frame)
        content_sizes.append((bx1 - bx0, by1 - by0))
    atlas = Image.fromarray(atlas_arr, mode="RGBA")
    meta: dict[str, Any] = {
        "version": 2,
        "packMode": "workbench_common_cells",
        "frameIndexBase": 0,
        "frameCount": len(frames),
        "cols": cols,
        "rows": rows,
        "cellWidth": cell_width,
        "cellHeight": cell_height,
        "maxTextureSide": max_side,
        "anchor": "manual_root_to_common_target",
        "rowMajorOrder": "col=index%cols, row=index//cols",
        "geometryOperations": [],
        "frames": [
            {
                "logicalIndex": i,
                "atlasIndex": i,
                "cellWidth": cell_width,
                "cellHeight": cell_height,
                "contentWidth": content_sizes[i][0],
                "contentHeight": content_sizes[i][1],
            }
            for i in range(len(frames))
        ],
    }
    anim = atlas_core.export_gamedraft_anim_multi(
        meta,
        "atlas.png",
        world_width,
        world_height,
        normalised_states,
    )
    # Manual world-size adjustment is realtime and may be fractional.  The old
    # helper rounds values, so restore exactly the authored positive dimensions.
    anim.pop("worldWidth", None)
    anim.pop("worldHeight", None)
    if world_width is not None:
        anim["worldWidth"] = world_width
    if world_height is not None:
        anim["worldHeight"] = world_height
    return atlas, anim, meta


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _new_output_temp(out_dir: Path) -> Path:
    out_dir = out_dir.resolve()
    if out_dir.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {out_dir}")
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.tmp-", dir=out_dir.parent))


def _commit_output_temp(temp_dir: Path, out_dir: Path) -> None:
    out_dir = out_dir.resolve()
    try:
        # mkdir is the atomic no-replace claim.  A direct rename can replace an
        # empty destination directory on POSIX, which is too weak for revisions.
        out_dir.mkdir()
    except FileExistsError as exc:
        raise FileExistsError(f"refusing to overwrite existing output: {out_dir}") from exc
    try:
        children = sorted(
            temp_dir.iterdir(), key=lambda child: (child.name == "manifest.json", child.name)
        )
        for child in children:
            os.rename(child, out_dir / child.name)
        temp_dir.rmdir()
    except Exception:
        # Only the directory atomically claimed above is removed here; no
        # pre-existing user path can reach this branch.
        shutil.rmtree(out_dir)
        raise


def write_sequence_stage(
    out_dir: str | Path,
    stage: str,
    result: StageSequence,
) -> dict[str, Any]:
    """Write a new E/F/G/R directory. Existing paths are never overwritten."""

    if stage not in {"E", "F", "G", "R"}:
        raise ValueError("sequence stage must be E, F, G, or R")
    frames = [_rgba(frame, label=f"frame {i}") for i, frame in enumerate(result.frames)]
    width, height = _validate_same_canvas(frames)
    if len(result.records) != len(frames):
        raise ValueError("record count differs from frame count")
    out = Path(out_dir)
    temp = _new_output_temp(out)
    try:
        frame_dir = temp / "frames"
        frame_dir.mkdir()
        records: list[dict[str, Any]] = []
        for i, (frame, source_record) in enumerate(zip(frames, result.records)):
            rel = Path("frames") / f"{i:06d}.png"
            path = temp / rel
            Image.fromarray(frame, mode="RGBA").save(path, format="PNG")
            records.append(
                {
                    **source_record,
                    "sequenceIndex": i,
                    "file": rel.as_posix(),
                    "sha256": _sha256(path),
                    "byteSize": path.stat().st_size,
                }
            )
        manifest: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "stage": stage,
            "frameCount": len(frames),
            "canvas": {"width": width, "height": height},
            "frames": records,
            "metadata": result.metadata,
        }
        (temp / "manifest.json").write_text(
            atlas_core._dump_json_text(manifest), encoding="utf-8"
        )
        _commit_output_temp(temp, out)
        return manifest
    except Exception:
        if temp.exists():
            shutil.rmtree(temp)
        raise


def load_sequence_stage(stage_dir: str | Path) -> tuple[StageSequence, dict[str, Any]]:
    """Load and hash-verify an immutable sequence stage."""

    root = Path(stage_dir).resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"stage manifest does not exist: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"unsupported stage schema: {manifest.get('schemaVersion')!r}")
    raw_records = manifest.get("frames")
    if not isinstance(raw_records, list) or not raw_records:
        raise ValueError("stage manifest contains no frames")
    if manifest.get("frameCount") != len(raw_records):
        raise ValueError("stage frameCount differs from frame records")
    frames: list[np.ndarray] = []
    records: list[dict[str, Any]] = []
    for i, raw_record in enumerate(raw_records):
        if not isinstance(raw_record, dict):
            raise ValueError(f"frame record {i} is not an object")
        if raw_record.get("sequenceIndex") != i:
            raise ValueError(f"frame record {i} has a non-canonical sequenceIndex")
        rel = raw_record.get("file")
        if not isinstance(rel, str) or not rel:
            raise ValueError(f"frame record {i} has no file")
        path = (root / rel).resolve()
        if root != path and root not in path.parents:
            raise ValueError(f"frame record {i} escapes the stage directory")
        if not path.is_file():
            raise FileNotFoundError(f"stage frame does not exist: {path}")
        expected_hash = raw_record.get("sha256")
        if expected_hash and _sha256(path) != expected_hash:
            raise ValueError(f"stage frame hash mismatch: {path}")
        with Image.open(path) as image:
            frames.append(np.asarray(image.convert("RGBA"), dtype=np.uint8).copy())
        records.append(dict(raw_record))
    width, height = _validate_same_canvas(frames)
    canvas = manifest.get("canvas") or {}
    if canvas != {"width": width, "height": height}:
        raise ValueError("stage canvas metadata differs from PNG geometry")
    return (
        StageSequence(
            frames=frames,
            records=records,
            metadata=dict(manifest.get("metadata") or {}),
        ),
        manifest,
    )


def write_h_stage(
    out_dir: str | Path,
    atlas: Image.Image,
    anim: Mapping[str, Any],
    atlas_meta: Mapping[str, Any],
    *,
    source_r_stage: str | Path,
) -> dict[str, Any]:
    """Write a staging-only H package and refuse any runtime destination."""

    out = Path(out_dir).resolve()
    if out == RUNTIME_ROOT or RUNTIME_ROOT in out.parents:
        raise ValueError("H adapter is staging-only and refuses public/resources/runtime")
    temp = _new_output_temp(out)
    try:
        atlas_path = temp / "atlas.png"
        anim_path = temp / "anim.json"
        meta_path = temp / "atlas.meta.json"
        atlas.convert("RGBA").save(atlas_path, format="PNG")
        anim_path.write_text(atlas_core._dump_json_text(dict(anim)), encoding="utf-8")
        meta_path.write_text(
            atlas_core._dump_json_text(dict(atlas_meta)), encoding="utf-8"
        )
        artifacts = []
        for path in (atlas_path, anim_path, meta_path):
            artifacts.append(
                {
                    "file": path.name,
                    "sha256": _sha256(path),
                    "byteSize": path.stat().st_size,
                }
            )
        manifest: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "stage": "H",
            "stagingOnly": True,
            "published": False,
            "sourceRStage": str(Path(source_r_stage).resolve()),
            "artifacts": artifacts,
            "atlas": {
                "width": atlas.width,
                "height": atlas.height,
                "cols": atlas_meta["cols"],
                "rows": atlas_meta["rows"],
                "cellWidth": atlas_meta["cellWidth"],
                "cellHeight": atlas_meta["cellHeight"],
            },
        }
        (temp / "manifest.json").write_text(
            atlas_core._dump_json_text(manifest), encoding="utf-8"
        )
        _commit_output_temp(temp, out)
        return manifest
    except Exception:
        if temp.exists():
            shutil.rmtree(temp)
        raise


def _static_target_name(value: str) -> str:
    """Validate the filename portion of an explicitly configured static target."""

    name = str(value or "").strip()
    if (
        not name
        or name in {".", ".."}
        or Path(name).name != name
        or "\\" in name
        or "\x00" in name
        or Path(name).suffix.lower() != ".png"
    ):
        raise ValueError("static target name must be one PNG filename")
    return name


def write_h_static_stage(
    out_dir: str | Path,
    source_png: str | Path,
    *,
    target_name: str,
    world_width: float | None = None,
    world_height: float | None = None,
) -> dict[str, Any]:
    """Stage one accepted C sprite without changing a byte or guessing its target.

    The workspace owns the full repository-relative target path.  This adapter
    receives only that path's filename so the staged artifact already has the
    exact name the publication receipt will require.  Copying into the runtime
    tree remains an explicit Agent action after human acceptance.
    """

    out = Path(out_dir).resolve()
    if out == RUNTIME_ROOT or RUNTIME_ROOT in out.parents:
        raise ValueError("H_STATIC adapter is staging-only and refuses public/resources/runtime")
    source_input = Path(source_png)
    if source_input.is_symlink():
        raise FileNotFoundError(f"accepted C PNG cannot be a symlink: {source_input}")
    source = source_input.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"accepted C PNG does not exist as a regular file: {source}")
    name = _static_target_name(target_name)
    try:
        with Image.open(source) as image:
            if image.format != "PNG":
                raise ValueError("H_STATIC input must be a PNG")
            width, height = image.size
            has_alpha = "A" in image.getbands() or "transparency" in image.info
            if not has_alpha:
                raise ValueError("H_STATIC input must preserve a transparent channel")
            image.verify()
    except (OSError, SyntaxError) as exc:
        raise ValueError(f"H_STATIC input is not a valid PNG: {source}") from exc

    authored_world_width = _positive_optional(world_width, "worldWidth")
    authored_world_height = _positive_optional(world_height, "worldHeight")
    temp = _new_output_temp(out)
    try:
        staged = temp / name
        shutil.copyfile(source, staged)
        source_hash = _sha256(source)
        staged_hash = _sha256(staged)
        if source_hash != staged_hash or source.stat().st_size != staged.stat().st_size:
            raise RuntimeError("H_STATIC byte-copy verification failed")
        manifest: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "stage": "H_STATIC",
            "stagingOnly": True,
            "published": False,
            "sourceC": str(source),
            "targetFileName": name,
            "canvas": {"width": width, "height": height},
            "worldSize": {
                "width": authored_world_width,
                "height": authored_world_height,
            },
            "geometryOperations": [],
            "artifacts": [
                {
                    "file": name,
                    "sha256": staged_hash,
                    "byteSize": staged.stat().st_size,
                }
            ],
        }
        (temp / "manifest.json").write_text(
            atlas_core._dump_json_text(manifest), encoding="utf-8"
        )
        _commit_output_temp(temp, out)
        return manifest
    except Exception:
        if temp.exists():
            shutil.rmtree(temp)
        raise


def _source_record(record: Mapping[str, Any]) -> dict[str, Any]:
    keep = ("sequenceIndex", "file", "sha256", "sourceFrameIndex", "timeSec")
    return {key: record[key] for key in keep if key in record}


def _read_indices(args: argparse.Namespace) -> list[int]:
    if args.indices is not None:
        chunks = [chunk.strip() for chunk in args.indices.split(",")]
        if not chunks or any(not chunk for chunk in chunks):
            raise ValueError("--indices must be a comma-separated integer list")
        try:
            return [int(chunk) for chunk in chunks]
        except ValueError as exc:
            raise ValueError("--indices must contain integers only") from exc
    data = json.loads(Path(args.indices_file).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("frameIndices")
    if not isinstance(data, list):
        raise ValueError("indices JSON must be an array or {frameIndices: [...]}")
    return data


def _cmd_e(args: argparse.Namespace) -> dict[str, Any]:
    result = decode_explicit_video_frames(
        args.video, _read_indices(args), loop_required=args.loop
    )
    return write_sequence_stage(args.out, "E", result)


def _cmd_f(args: argparse.Namespace) -> dict[str, Any]:
    source, source_manifest = load_sequence_stage(args.input)
    if source_manifest.get("stage") != "E":
        raise ValueError("F input must be an E stage")
    result = union_crop_frames(
        source.frames,
        bbox_method=args.bbox_method,
        threshold=args.threshold,
        padding=args.padding,
    )
    for record, parent_record in zip(result.records, source.records):
        record["sourceFrame"] = _source_record(parent_record)
    result.metadata["sourceStage"] = str(Path(args.input).resolve())
    return write_sequence_stage(args.out, "F", result)


def _cmd_g(args: argparse.Namespace) -> dict[str, Any]:
    source, source_manifest = load_sequence_stage(args.input)
    if source_manifest.get("stage") != "F":
        raise ValueError("G input must be an F stage")
    result = matte_sequence_preserve_geometry(source.frames, method=args.method)
    for record, parent_record in zip(result.records, source.records):
        record["sourceFrame"] = _source_record(parent_record)
    result.metadata["sourceStage"] = str(Path(args.input).resolve())
    return write_sequence_stage(args.out, "G", result)


def _load_calibration(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("calibration"), dict):
        data = data["calibration"]
    if not isinstance(data, dict):
        raise ValueError("calibration JSON must be an object")
    return data


def _cmd_r(args: argparse.Namespace) -> dict[str, Any]:
    calibration_path = Path(args.calibration).resolve()
    calibration = _load_calibration(calibration_path)
    raw_actions = calibration.get("actions")
    if not isinstance(raw_actions, dict) or not raw_actions:
        raise ValueError("calibration.actions must be a non-empty object")
    actions: dict[str, dict[str, Any]] = {}
    source_records: dict[str, list[dict[str, Any]]] = {}
    source_paths: dict[str, Path] = {}
    for action_id, raw_spec in raw_actions.items():
        if not isinstance(raw_spec, dict):
            raise ValueError(f"calibration action {action_id} must be an object")
        source_value = raw_spec.get("source") or raw_spec.get("sourceStage")
        if not isinstance(source_value, str) or not source_value:
            raise ValueError(f"calibration action {action_id} has no G source")
        source_path = Path(source_value)
        if not source_path.is_absolute():
            source_path = calibration_path.parent / source_path
        source, source_manifest = load_sequence_stage(source_path)
        if source_manifest.get("stage") != "G":
            raise ValueError(f"calibration action {action_id} source must be G")
        actions[action_id] = {**raw_spec, "frames": source.frames}
        source_records[action_id] = source.records
        source_paths[action_id] = source_path.resolve()

    cell_value = calibration.get("cellSize") or calibration.get("cell")
    if not isinstance(cell_value, Mapping):
        raise ValueError("calibration.cellSize must be {width, height}")
    result = bake_calibrated_actions(
        actions,
        cell_size=cell_value,
        target_root=calibration.get("targetRoot"),
        world_size=calibration.get("worldSize"),
    )
    for record in result.records:
        action_id = record["actionId"]
        action_frame = record["actionFrameIndex"]
        record["sourceFrame"] = _source_record(source_records[action_id][action_frame])
    for action_id, source_path in source_paths.items():
        result.metadata["actions"][action_id]["sourceStage"] = str(source_path)
        result.metadata["actions"][action_id]["sourceManifestSha256"] = _sha256(
            source_path / "manifest.json"
        )
    result.metadata["calibrationFile"] = str(calibration_path)
    return write_sequence_stage(args.out, "R", result)


def _cmd_h(args: argparse.Namespace) -> dict[str, Any]:
    source, source_manifest = load_sequence_stage(args.input)
    if source_manifest.get("stage") != "R":
        raise ValueError("H input must be an R stage")
    states = source.metadata.get("states")
    world_size = source.metadata.get("worldSize")
    if not isinstance(states, Mapping):
        raise ValueError("R metadata.states must be an object")
    if not isinstance(world_size, Mapping):
        raise ValueError("R metadata.worldSize must be an object")
    atlas, anim, meta = pack_common_cell_states(
        source.frames,
        states,
        world_size=world_size,
        max_side=args.max_side,
    )
    meta["sourceRStage"] = str(Path(args.input).resolve())
    meta["targetRoot"] = source.metadata.get("targetRoot")
    return write_h_stage(
        args.out,
        atlas,
        anim,
        meta,
        source_r_stage=args.input,
    )


def _cmd_h_static(args: argparse.Namespace) -> dict[str, Any]:
    return write_h_static_stage(
        args.out,
        args.input,
        target_name=args.target_name,
        world_width=args.world_width,
        world_height=args.world_height,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Animation workbench E/F/G/R/H/H_STATIC staging adapters (never publishes)"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    e = sub.add_parser("e", help="explicit video frame extraction, full canvas")
    e.add_argument("--video", required=True)
    indices = e.add_mutually_exclusive_group(required=True)
    indices.add_argument("--indices", help="comma-separated zero-based frame indices")
    indices.add_argument("--indices-file", help="JSON array or {frameIndices: [...]} file")
    e.add_argument("--loop", action="store_true", help="record loop closing-transition QA metrics")
    e.add_argument("--out", required=True)
    e.set_defaults(handler=_cmd_e)

    f = sub.add_parser("f", help="one union bbox crop for every E frame")
    f.add_argument("--input", required=True, help="E stage directory")
    f.add_argument("--out", required=True)
    f.add_argument("--bbox-method", choices=("auto", "alpha", "color_key"), default="auto")
    f.add_argument("--threshold", type=float, default=0.10)
    f.add_argument("--padding", type=int, default=0)
    f.set_defaults(handler=_cmd_f)

    g = sub.add_parser("g", help="precise matting without geometry changes")
    g.add_argument("--input", required=True, help="F stage directory")
    g.add_argument("--out", required=True)
    g.add_argument(
        "--method",
        choices=("fusion", "color_key", "birefnet", "rembg_isnet"),
        default="fusion",
    )
    g.set_defaults(handler=_cmd_g)

    r = sub.add_parser("r", help="bake human-authored roots/scales into common cells")
    r.add_argument("--calibration", required=True)
    r.add_argument("--out", required=True)
    r.set_defaults(handler=_cmd_r)

    h = sub.add_parser("h", help="pack common cells into a staging-only GameDraft bundle")
    h.add_argument("--input", required=True, help="R stage directory")
    h.add_argument("--out", required=True)
    h.add_argument("--max-side", type=int, default=2048)
    h.set_defaults(handler=_cmd_h)

    h_static = sub.add_parser(
        "h-static",
        help="byte-copy one accepted C PNG into a staging-only static package",
    )
    h_static.add_argument("--input", required=True, help="accepted C-stage transparent PNG")
    h_static.add_argument("--target-name", required=True, help="filename from workspace staticTargetPath")
    h_static.add_argument("--world-width", type=float)
    h_static.add_argument("--world-height", type=float)
    h_static.add_argument("--out", required=True)
    h_static.set_defaults(handler=_cmd_h_static)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        manifest = args.handler(args)
    except (FileNotFoundError, FileExistsError, ValueError, RuntimeError) as exc:
        parser.error(str(exc))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
