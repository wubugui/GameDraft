from __future__ import annotations

from dataclasses import dataclass, field
import math
import time
from typing import Callable

import numpy as np
from PIL import Image

from .reconstruction import OrthoProjection


FATE_RANGE = np.uint8(0)
FATE_HIT = np.uint8(1)
FATE_EXIT = np.uint8(2)

MISS_BLACK = "black"
MISS_HIT_NORMALIZED = "hit_normalized"
MISS_BORDER_ENVIRONMENT = "border_environment"
MISS_MODES = (
    MISS_BLACK,
    MISS_HIT_NORMALIZED,
    MISS_BORDER_ENVIRONMENT,
)


@dataclass(frozen=True)
class QuadSettings:
    foot_world: tuple[float, float, float] = (0.0, 0.0, 0.0)
    width: float = 0.25
    height: float = 0.55
    bulge_ratio: float = 0.0
    # Shading normal in calibrated-camera coordinates:
    # X=screen right, Y=screen up, Z=depth into the scene.  Geometry remains
    # camera-facing; this vector only rotates the normal field used by lighting.
    main_normal_local: tuple[float, float, float] = (0.0, 0.0, -1.0)
    calculation_height: int = 64


@dataclass(frozen=True)
class FinalGatherSettings:
    samples_per_pixel: int = 64
    step_pixels: float = 1.5
    max_distance: float = 0.0
    front_epsilon_pixels: float = 0.75
    back_thickness_pixels: float = 4.0
    scene_exposure_ev: float = 0.0
    miss_mode: str = MISS_BLACK
    seed: int = 7
    batch_points: int = 24
    visual_ray_budget: int = 3000


@dataclass
class QuadSamples:
    rgba: np.ndarray
    albedo_linear: np.ndarray
    alpha: np.ndarray
    active: np.ndarray
    points_world: np.ndarray
    normals_world: np.ndarray
    qz_offset: np.ndarray
    corners_world: np.ndarray
    main_normal_world: np.ndarray


@dataclass
class FinalGatherResult:
    shaded_image: Image.Image
    shaded_linear_hdr: np.ndarray
    quad: QuadSamples
    radiance: np.ndarray
    hit_fraction: np.ndarray
    ray_origins_world: np.ndarray
    ray_endpoints_world: np.ndarray
    ray_fates: np.ndarray
    ray_toward_background: np.ndarray
    metrics: dict[str, object] = field(default_factory=dict)


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
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


def _resize_sprite(sprite: Image.Image, calculation_height: int) -> np.ndarray:
    source = sprite.convert("RGBA")
    height = max(8, min(256, int(calculation_height)))
    width = max(8, int(round(source.width * height / max(source.height, 1))))
    resized = source.resize((width, height), Image.Resampling.LANCZOS)
    return np.asarray(resized, dtype=np.float32) / 255.0


def _chamfer_distance(mask: np.ndarray) -> np.ndarray:
    """Approximate distance to the alpha silhouette without a SciPy dependency."""
    padded = np.pad(mask.astype(bool), 1, mode="constant", constant_values=False)
    inf = np.float32(max(mask.shape) * 4 + 8)
    distance = np.where(padded, inf, 0.0).astype(np.float32)
    diag = np.float32(math.sqrt(2.0))
    h, w = distance.shape
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if distance[y, x] <= 0.0:
                continue
            distance[y, x] = min(
                distance[y, x],
                distance[y - 1, x] + 1.0,
                distance[y, x - 1] + 1.0,
                distance[y - 1, x - 1] + diag,
                distance[y - 1, x + 1] + diag,
            )
    for y in range(h - 2, 0, -1):
        for x in range(w - 2, 0, -1):
            if distance[y, x] <= 0.0:
                continue
            distance[y, x] = min(
                distance[y, x],
                distance[y + 1, x] + 1.0,
                distance[y, x + 1] + 1.0,
                distance[y + 1, x + 1] + diag,
                distance[y + 1, x - 1] + diag,
            )
    return distance[1:-1, 1:-1]


def _rotation_from_to(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Return a stable 3x3 rotation mapping unit ``source`` to ``target``."""
    a = np.asarray(source, dtype=np.float64)
    b = np.asarray(target, dtype=np.float64)
    a /= max(float(np.linalg.norm(a)), 1e-12)
    b /= max(float(np.linalg.norm(b)), 1e-12)
    cross = np.cross(a, b)
    sine = float(np.linalg.norm(cross))
    cosine = float(np.clip(np.dot(a, b), -1.0, 1.0))
    if sine < 1e-8:
        if cosine > 0.0:
            return np.eye(3, dtype=np.float32)
        # 180 degrees: choose a deterministic axis orthogonal to the source.
        reference = np.array([1.0, 0.0, 0.0], dtype=np.float64)
        if abs(float(a[0])) > 0.9:
            reference = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        axis = np.cross(a, reference)
        axis /= max(float(np.linalg.norm(axis)), 1e-12)
        return (2.0 * np.outer(axis, axis) - np.eye(3)).astype(np.float32)
    axis = cross / sine
    skew = np.array([
        [0.0, -axis[2], axis[1]],
        [axis[2], 0.0, -axis[0]],
        [-axis[1], axis[0], 0.0],
    ], dtype=np.float64)
    rotation = np.eye(3) + skew * sine + (skew @ skew) * (1.0 - cosine)
    return rotation.astype(np.float32)


def build_quad_samples(
    sprite: Image.Image,
    projection: OrthoProjection,
    settings: QuadSettings,
) -> QuadSamples:
    rgba = _resize_sprite(sprite, settings.calculation_height)
    alpha = rgba[..., 3].astype(np.float32)
    active = alpha > 0.02
    h, w = alpha.shape

    qz_offset = np.zeros((h, w), dtype=np.float32)
    if settings.bulge_ratio > 0.0 and active.any():
        # Chamfer distance is 1 at the first opaque pixel.  Rebase that ring to
        # zero so the silhouette (including the feet) stays on the original quad.
        distance = np.maximum(_chamfer_distance(active) - 1.0, 0.0)
        radius = max(float(np.percentile(distance[active], 99.0)), 1.0)
        t = np.clip(distance / radius, 0.0, 1.0)
        profile = np.sqrt(np.maximum(2.0 * t - t * t, 0.0)).astype(np.float32)
        profile[~active] = 0.0
        qz_offset = -profile * float(settings.width) * float(settings.bulge_ratio)

    dx = float(settings.width) / max(w - 1, 1)
    dy = float(settings.height) / max(h - 1, 1)
    dz_drow, dz_dcol = np.gradient(qz_offset)
    dz_dx = dz_dcol / max(dx, 1e-9)
    dz_dy = -dz_drow / max(dy, 1e-9)

    right = np.asarray(projection.right, dtype=np.float32)
    up = np.asarray(projection.up, dtype=np.float32)
    view = np.asarray(projection.view_dir, dtype=np.float32)
    geometric_normal = (
        dz_dx[..., None] * right
        + dz_dy[..., None] * up
        - view
    ).astype(np.float32)
    geometric_normal /= np.maximum(
        np.linalg.norm(geometric_normal, axis=-1, keepdims=True), 1e-8,
    )

    main_local = np.asarray(settings.main_normal_local, dtype=np.float32)
    main_length = float(np.linalg.norm(main_local))
    if not np.isfinite(main_length) or main_length < 1e-6:
        raise ValueError("main_normal_local must be a non-zero finite vector")
    main_local /= main_length
    main_world = (
        main_local[0] * right + main_local[1] * up + main_local[2] * view
    ).astype(np.float32)
    main_world /= max(float(np.linalg.norm(main_world)), 1e-8)
    normal_rotation = _rotation_from_to(-view, main_world)
    normal = (geometric_normal @ normal_rotation.T).astype(np.float32)
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-8)

    x = np.linspace(-0.5 * settings.width, 0.5 * settings.width, w, dtype=np.float32)
    y = np.linspace(settings.height, 0.0, h, dtype=np.float32)
    local_x, local_y = np.meshgrid(x, y)
    foot = np.asarray(settings.foot_world, dtype=np.float32)
    points = (
        foot
        + local_x[..., None] * right
        + local_y[..., None] * up
        + qz_offset[..., None] * view
    ).astype(np.float32)

    half_width = 0.5 * float(settings.width)
    corners = np.stack([
        foot - right * half_width,
        foot + right * half_width,
        foot + right * half_width + up * float(settings.height),
        foot - right * half_width + up * float(settings.height),
    ]).astype(np.float32)
    return QuadSamples(
        rgba=rgba,
        albedo_linear=srgb_to_linear(rgba[..., :3]),
        alpha=alpha,
        active=active,
        points_world=points,
        normals_world=normal,
        qz_offset=qz_offset,
        corners_world=corners,
        main_normal_world=main_world,
    )


def cosine_hemisphere_directions(
    normals: np.ndarray,
    samples_per_pixel: int,
    seed: int,
    point_indices: np.ndarray,
) -> np.ndarray:
    """Deterministic cosine-weighted hemisphere directions around each normal."""
    spp = max(1, int(samples_per_pixel))
    ray_index = np.arange(spp, dtype=np.float32)
    u1 = (ray_index + 0.5) / float(spp)
    radius = np.sqrt(u1)
    local_z = np.sqrt(np.maximum(1.0 - u1, 0.0))
    golden = np.float32((math.sqrt(5.0) - 1.0) * 0.5)
    hashes = np.mod(
        np.sin((point_indices.astype(np.float32) + seed * 11.73) * 73.719)
        * 43758.5453,
        1.0,
    )
    u2 = np.mod(ray_index[None, :] * golden + hashes[:, None], 1.0)
    phi = 2.0 * np.pi * u2
    local_x = radius[None, :] * np.cos(phi)
    local_y = radius[None, :] * np.sin(phi)

    n = np.asarray(normals, dtype=np.float32)
    reference = np.zeros_like(n)
    use_y = np.abs(n[:, 1]) < 0.92
    reference[use_y, 1] = 1.0
    reference[~use_y, 0] = 1.0
    tangent = np.cross(reference, n)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=-1, keepdims=True), 1e-8)
    bitangent = np.cross(n, tangent)
    directions = (
        tangent[:, None, :] * local_x[..., None]
        + bitangent[:, None, :] * local_y[..., None]
        + n[:, None, :] * local_z[None, :, None]
    ).astype(np.float32)
    directions /= np.maximum(np.linalg.norm(directions, axis=-1, keepdims=True), 1e-8)
    return directions


def _sample_nearest(array: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    ix = np.clip(np.rint(sx).astype(np.int32), 0, array.shape[1] - 1)
    iy = np.clip(np.rint(sy).astype(np.int32), 0, array.shape[0] - 1)
    return array[iy, ix]


def _scene_border_environment(scene_radiance: np.ndarray) -> np.ndarray:
    border = np.concatenate([
        scene_radiance[0],
        scene_radiance[-1],
        scene_radiance[:, 0],
        scene_radiance[:, -1],
    ], axis=0)
    return np.mean(border, axis=0).astype(np.float32)


def _q_to_world(q: np.ndarray, projection: OrthoProjection) -> np.ndarray:
    return np.asarray(q, dtype=np.float32) @ np.asarray(projection.R, dtype=np.float32).T


def trace_depth_field(
    depth: np.ndarray,
    scene_radiance: np.ndarray,
    projection: OrthoProjection,
    points_world: np.ndarray,
    normals_world: np.ndarray,
    settings: FinalGatherSettings,
    progress: Callable[[float], None] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict[str, object]]:
    """Trace the visible scene depth field and return radiance plus debug rays.

    The marcher operates in calibrated q=(screen-x, screen-y, depth) space.  World
    points and normals are transformed through the exact orthogonal calibration R.
    """
    points_world = np.asarray(points_world, dtype=np.float32).reshape(-1, 3)
    normals_world = np.asarray(normals_world, dtype=np.float32).reshape(-1, 3)
    point_count = len(points_world)
    spp = max(1, int(settings.samples_per_pixel))
    if point_count == 0:
        empty3 = np.zeros((0, 3), dtype=np.float32)
        return (
            empty3, np.zeros(0, dtype=np.float32), empty3, empty3,
            np.zeros(0, dtype=np.uint8), np.zeros(0, dtype=bool),
            {"point_count": 0, "ray_count": 0},
        )

    R = np.asarray(projection.R, dtype=np.float32)
    points_q = points_world @ R
    normals_q = normals_world @ R
    normals_q /= np.maximum(np.linalg.norm(normals_q, axis=-1, keepdims=True), 1e-8)

    ppu = max(float(projection.ppu), 1e-6)
    step_q = max(0.1, float(settings.step_pixels)) / ppu
    auto_distance = math.hypot(depth.shape[1], depth.shape[0]) / ppu * 1.08
    max_distance = float(settings.max_distance) if settings.max_distance > 0.0 else auto_distance
    max_steps = max(1, int(math.ceil(max_distance / step_q)))
    front_q = max(0.0, float(settings.front_epsilon_pixels)) / ppu
    back_q = max(0.0, float(settings.back_thickness_pixels)) / ppu
    perpendicular_q = (max(0.0, float(settings.back_thickness_pixels)) + 0.75) / ppu

    incoming_result = np.zeros((point_count, 3), dtype=np.float32)
    hit_fraction = np.zeros(point_count, dtype=np.float32)
    total_fates = np.zeros(3, dtype=np.int64)
    camera_fates = np.zeros(3, dtype=np.int64)
    background_fates = np.zeros(3, dtype=np.int64)
    border_environment = _scene_border_environment(scene_radiance)

    visual_origins: list[np.ndarray] = []
    visual_endpoints: list[np.ndarray] = []
    visual_fates: list[np.ndarray] = []
    visual_background: list[np.ndarray] = []
    visual_points = min(point_count, max(1, int(math.sqrt(max(settings.visual_ray_budget, 1)) * 2)))
    visual_point_ids = set(np.linspace(0, point_count - 1, visual_points).astype(int).tolist())
    rays_per_visual_point = max(1, min(spp, settings.visual_ray_budget // max(visual_points, 1)))
    visual_ray_ids = np.linspace(0, spp - 1, rays_per_visual_point).astype(int)

    started = time.perf_counter()
    batch_size = max(1, int(settings.batch_points))
    for start in range(0, point_count, batch_size):
        stop = min(start + batch_size, point_count)
        count = stop - start
        point_indices = np.arange(start, stop, dtype=np.int32)
        p = points_q[start:stop]
        n = normals_q[start:stop]
        directions = cosine_hemisphere_directions(n, spp, settings.seed, point_indices)
        origins = p + n * (0.5 / ppu)

        alive = np.ones((count, spp), dtype=bool)
        fates = np.full((count, spp), FATE_RANGE, dtype=np.uint8)
        incoming = np.zeros((count, spp, 3), dtype=np.float32)
        end_q = origins[:, None, :] + directions * max_distance

        for step in range(1, max_steps + 1):
            if not alive.any():
                break
            distance_q = step * step_q
            q = origins[:, None, :] + directions * distance_q
            sx = projection.cx + ppu * q[..., 0]
            sy = projection.cy - ppu * q[..., 1]
            inside = (
                (sx >= 0.5)
                & (sx < depth.shape[1] - 0.5)
                & (sy >= 0.5)
                & (sy < depth.shape[0] - 0.5)
            )
            just_exit = alive & ~inside
            if just_exit.any():
                fates[just_exit] = FATE_EXIT
                end_q[just_exit] = q[just_exit]

            surface_depth = _sample_nearest(depth, sx, sy)
            signed_depth = q[..., 2] - surface_depth
            perpendicular = np.abs(signed_depth) * np.sqrt(
                np.maximum(1.0 - directions[..., 2] ** 2, 0.0)
            )
            candidate = (
                alive
                & inside
                & (signed_depth >= -front_q)
                & (signed_depth <= back_q)
                & (perpendicular <= perpendicular_q)
            )
            if candidate.any():
                fates[candidate] = FATE_HIT
                end_q[candidate] = q[candidate]
                incoming[candidate] = _sample_nearest(
                    scene_radiance, sx[candidate], sy[candidate]
                )
            alive &= inside & ~candidate

        hits = np.sum(fates == FATE_HIT, axis=1)
        if settings.miss_mode == MISS_HIT_NORMALIZED:
            incoming_result[start:stop] = (
                np.sum(incoming, axis=1) / np.maximum(hits[:, None], 1)
            )
        elif settings.miss_mode == MISS_BORDER_ENVIRONMENT:
            misses = spp - hits
            incoming_result[start:stop] = (
                np.sum(incoming, axis=1)
                + misses[:, None] * border_environment[None, :]
            ) / float(spp)
        else:
            incoming_result[start:stop] = np.mean(incoming, axis=1)
        hit_fraction[start:stop] = hits.astype(np.float32) / float(spp)

        for fate_code in (FATE_RANGE, FATE_HIT, FATE_EXIT):
            fate_index = int(fate_code)
            total_fates[fate_index] += int(np.sum(fates == fate_code))
            toward_background = directions[..., 2] >= 0.0
            camera_fates[fate_index] += int(np.sum((fates == fate_code) & ~toward_background))
            background_fates[fate_index] += int(np.sum((fates == fate_code) & toward_background))

        for local_index, global_index in enumerate(range(start, stop)):
            if global_index not in visual_point_ids:
                continue
            ids = visual_ray_ids
            visual_origins.append(np.broadcast_to(origins[local_index], (len(ids), 3)).copy())
            visual_endpoints.append(end_q[local_index, ids].copy())
            visual_fates.append(fates[local_index, ids].copy())
            visual_background.append((directions[local_index, ids, 2] >= 0.0).copy())

        if progress is not None:
            progress(stop / float(point_count))

    ray_origins_q = np.concatenate(visual_origins, axis=0) if visual_origins else np.zeros((0, 3), dtype=np.float32)
    ray_endpoints_q = np.concatenate(visual_endpoints, axis=0) if visual_endpoints else np.zeros((0, 3), dtype=np.float32)
    ray_fates = np.concatenate(visual_fates, axis=0) if visual_fates else np.zeros(0, dtype=np.uint8)
    ray_toward_background = np.concatenate(visual_background, axis=0) if visual_background else np.zeros(0, dtype=bool)
    ray_count = point_count * spp

    def percentages(counts: np.ndarray) -> dict[str, float]:
        denom = max(int(np.sum(counts)), 1)
        return {
            "range": float(counts[int(FATE_RANGE)] * 100.0 / denom),
            "hit": float(counts[int(FATE_HIT)] * 100.0 / denom),
            "exit": float(counts[int(FATE_EXIT)] * 100.0 / denom),
        }

    metrics: dict[str, object] = {
        "seconds": time.perf_counter() - started,
        "point_count": point_count,
        "samples_per_pixel": spp,
        "ray_count": ray_count,
        "visual_ray_count": int(len(ray_fates)),
        "step_pixels": float(settings.step_pixels),
        "max_steps": max_steps,
        "fates_percent": percentages(total_fates),
        "toward_camera_percent": float(np.sum(camera_fates) * 100.0 / max(ray_count, 1)),
        "toward_background_percent": float(np.sum(background_fates) * 100.0 / max(ray_count, 1)),
        "toward_camera_fates_percent": percentages(camera_fates),
        "toward_background_fates_percent": percentages(background_fates),
    }
    return (
        incoming_result,
        hit_fraction,
        _q_to_world(ray_origins_q, projection),
        _q_to_world(ray_endpoints_q, projection),
        ray_fates,
        ray_toward_background,
        metrics,
    )


def compute_final_gather(
    source_image: Image.Image,
    calibrated_depth: np.ndarray,
    sprite: Image.Image,
    projection: OrthoProjection,
    quad_settings: QuadSettings,
    gather_settings: FinalGatherSettings,
    progress: Callable[[float], None] | None = None,
    *,
    scene_radiance: np.ndarray | None = None,
) -> FinalGatherResult:
    depth = np.asarray(calibrated_depth, dtype=np.float32)
    if depth.ndim != 2:
        raise ValueError("calibrated_depth must be a 2-D array")
    if scene_radiance is None:
        scene = source_image.convert("RGB")
        if scene.size != (depth.shape[1], depth.shape[0]):
            scene = scene.resize((depth.shape[1], depth.shape[0]), Image.Resampling.LANCZOS)
        scene_linear = srgb_to_linear(np.asarray(scene, dtype=np.float32) / 255.0)
        trace_radiance = scene_linear * np.float32(2.0 ** gather_settings.scene_exposure_ev)
        radiance_source = "ldr_fallback"
    else:
        trace_radiance = np.asarray(scene_radiance, dtype=np.float32)
        expected = (depth.shape[0], depth.shape[1], 3)
        if trace_radiance.shape != expected:
            raise ValueError(
                f"scene_radiance shape does not match depth: {trace_radiance.shape} != {expected}"
            )
        if not np.all(np.isfinite(trace_radiance)):
            raise ValueError("scene_radiance must contain finite values")
        trace_radiance = np.maximum(trace_radiance, 0.0)
        radiance_source = "provided_hdr"

    quad = build_quad_samples(sprite, projection, quad_settings)
    ys, xs = np.where(quad.active)
    points = quad.points_world[ys, xs]
    normals = quad.normals_world[ys, xs]
    (
        radiance_points,
        hit_fraction_points,
        ray_origins,
        ray_endpoints,
        ray_fates,
        ray_toward_background,
        metrics,
    ) = trace_depth_field(
        depth,
        trace_radiance,
        projection,
        points,
        normals,
        gather_settings,
        progress,
    )

    radiance = np.zeros((*quad.alpha.shape, 3), dtype=np.float32)
    hit_fraction = np.zeros(quad.alpha.shape, dtype=np.float32)
    radiance[ys, xs] = radiance_points
    hit_fraction[ys, xs] = hit_fraction_points
    shaded_linear = quad.albedo_linear * radiance
    shaded_rgb = np.clip(linear_to_srgb(shaded_linear), 0.0, 1.0)
    shaded_rgba = np.dstack([shaded_rgb, quad.alpha])
    shaded_image = Image.fromarray(
        np.round(shaded_rgba * 255.0).astype(np.uint8), "RGBA"
    )
    metrics["mean_hit_fraction"] = float(np.mean(hit_fraction_points)) if len(hit_fraction_points) else 0.0
    metrics["zero_hit_pixel_percent"] = float(np.mean(hit_fraction_points == 0.0) * 100.0) if len(hit_fraction_points) else 0.0
    metrics["miss_mode"] = gather_settings.miss_mode
    metrics["radiance_source"] = radiance_source
    return FinalGatherResult(
        shaded_image=shaded_image,
        shaded_linear_hdr=shaded_linear,
        quad=quad,
        radiance=radiance,
        hit_fraction=hit_fraction,
        ray_origins_world=ray_origins,
        ray_endpoints_world=ray_endpoints,
        ray_fates=ray_fates,
        ray_toward_background=ray_toward_background,
        metrics=metrics,
    )
