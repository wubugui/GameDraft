from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import numpy as np
from PIL import Image


# ==================================================================
# DepthMapping
# ==================================================================

@dataclass
class DepthMapping:
    """Maps raw normalised [0,1] relative depth to calibrated depth."""

    invert: bool = True
    scale: float = 1.0
    offset: float = 0.0


def apply_depth_mapping(raw_norm: np.ndarray, mapping: DepthMapping) -> np.ndarray:
    """Convert normalised [0,1] depth to calibrated depth."""
    d = raw_norm.astype(np.float64, copy=True)
    if mapping.invert:
        d = 1.0 - d
    return d * mapping.scale + mapping.offset


def inverse_depth_mapping(calibrated: np.ndarray, mapping: DepthMapping) -> np.ndarray:
    """Convert calibrated depth back to raw normalised [0,1]."""
    d = (calibrated - mapping.offset) / mapping.scale
    if mapping.invert:
        d = 1.0 - d
    return np.clip(d, 0.0, 1.0)


# ==================================================================
# OrthoProjection (M) — the single calibrated transform
# ==================================================================

@dataclass
class OrthoProjection:
    """Encapsulates the full calibrated orthographic projection M.

    M maps  (sx, sy, d_raw)  →  (X, Y, Z) in world space.
    M⁻¹ maps  (X, Y, Z)  →  (sx, sy, d_calibrated).

    All information (rotation R, pixels-per-unit, principal point,
    depth mapping) is baked into this single object.
    """

    R: np.ndarray = field(default_factory=lambda: np.eye(3, dtype=np.float64))
    ppu: float = 100.0
    cx: float = 0.0
    cy: float = 0.0
    depth_mapping: DepthMapping = field(default_factory=DepthMapping)

    @property
    def right(self) -> np.ndarray:
        return self.R[:, 0]

    @property
    def up(self) -> np.ndarray:
        return self.R[:, 1]

    @property
    def view_dir(self) -> np.ndarray:
        return self.R[:, 2]

    # ---------- forward: screen → world ----------

    def screen_to_world(self, sx: np.ndarray, sy: np.ndarray,
                        d_calibrated: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(sx, sy, d_calibrated) → (X, Y, Z) world coordinates."""
        px = (sx - self.cx) / self.ppu
        py = (self.cy - sy) / self.ppu
        r, u, v = self.right, self.up, self.view_dir
        X = r[0] * px + u[0] * py + v[0] * d_calibrated
        Y = r[1] * px + u[1] * py + v[1] * d_calibrated
        Z = r[2] * px + u[2] * py + v[2] * d_calibrated
        return X, Y, Z

    # ---------- inverse: world → screen ----------

    def world_to_screen(self, X: np.ndarray, Y: np.ndarray,
                        Z: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(X, Y, Z) → (sx, sy, d_calibrated). Uses R^T since R is orthogonal."""
        Rt = self.R.T
        px = Rt[0, 0] * X + Rt[0, 1] * Y + Rt[0, 2] * Z
        py = Rt[1, 0] * X + Rt[1, 1] * Y + Rt[1, 2] * Z
        d = Rt[2, 0] * X + Rt[2, 1] * Y + Rt[2, 2] * Z
        sx = px * self.ppu + self.cx
        sy = self.cy - py * self.ppu
        return sx, sy, d

    # ---------- floor depth ----------

    def floor_depth_at_screen(self, sx: float, sy: float) -> float:
        """Calibrated depth that places (sx, sy) on the Y=0 floor."""
        u, v = self.up, self.view_dir
        if abs(v[1]) < 1e-12:
            return 0.0
        py = (self.cy - sy) / self.ppu
        return -(u[1] * py) / v[1]

    def floor_depth_at_screen_vec(self, sx: np.ndarray,
                                  sy: np.ndarray) -> np.ndarray:
        """Vectorised floor_depth_at_screen."""
        u, v = self.up, self.view_dir
        if abs(v[1]) < 1e-12:
            return np.zeros_like(sx)
        py = (self.cy - sy) / self.ppu
        return -(u[1] * py) / v[1]


def build_M(camera, mapping: DepthMapping) -> OrthoProjection:
    """Construct OrthoProjection from OrthoCamera + DepthMapping."""
    right, up, vd = camera.axes()
    R = np.column_stack([right, up, vd])
    return OrthoProjection(
        R=R, ppu=camera.pixels_per_unit,
        cx=camera.cx, cy=camera.cy,
        depth_mapping=mapping,
    )


# ==================================================================
# World-space XZ collision map (non-stretched quad projection)
# ==================================================================

@dataclass
class WorldHeightMap:
    """Regular XZ grid built by projecting non-stretched mesh quads.

    For each quad in the mesh, its 4 edge lengths are computed in 3D.
    If the max edge exceeds ``median_edge * stretch_factor``, the quad
    is considered a depth-discontinuity artifact and discarded.

    Remaining (valid) quads are AABB-rasterized onto the XZ grid.
    ``covered`` stores the binary occupancy; ``grid`` stores max-Y of
    valid quads for reference.
    """

    grid: np.ndarray
    covered: np.ndarray
    x_min: float
    z_min: float
    cell_size: float

    @staticmethod
    def from_mesh(X: np.ndarray, Y: np.ndarray, Z: np.ndarray,
                  cell_size: float | None = None,
                  stretch_factor: float = 3.0) -> WorldHeightMap:
        x_min, x_max = float(X.min()), float(X.max())
        z_min, z_max = float(Z.min()), float(Z.max())

        if cell_size is None:
            span = max(x_max - x_min, z_max - z_min, 0.01)
            cell_size = span / 200.0

        gw = max(1, int(np.ceil((x_max - x_min) / cell_size)) + 1)
        gh = max(1, int(np.ceil((z_max - z_min) / cell_size)) + 1)

        grid = np.full((gh, gw), 0.0, dtype=np.float64)
        covered = np.zeros((gh, gw), dtype=np.bool_)

        h_m, w_m = X.shape
        if h_m < 2 or w_m < 2:
            return WorldHeightMap(grid=grid, covered=covered,
                                  x_min=x_min, z_min=z_min,
                                  cell_size=cell_size)

        x_tl, x_tr = X[:-1, :-1], X[:-1, 1:]
        x_bl, x_br = X[1:, :-1], X[1:, 1:]
        y_tl, y_tr = Y[:-1, :-1], Y[:-1, 1:]
        y_bl, y_br = Y[1:, :-1], Y[1:, 1:]
        z_tl, z_tr = Z[:-1, :-1], Z[:-1, 1:]
        z_bl, z_br = Z[1:, :-1], Z[1:, 1:]

        def _edge_len(ax, ay, az, bx, by, bz):
            return np.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2)

        e_top = _edge_len(x_tl, y_tl, z_tl, x_tr, y_tr, z_tr)
        e_bot = _edge_len(x_bl, y_bl, z_bl, x_br, y_br, z_br)
        e_lft = _edge_len(x_tl, y_tl, z_tl, x_bl, y_bl, z_bl)
        e_rgt = _edge_len(x_tr, y_tr, z_tr, x_br, y_br, z_br)
        max_edge = np.maximum(np.maximum(e_top, e_bot),
                              np.maximum(e_lft, e_rgt))

        median_edge = float(np.median(max_edge))
        edge_limit = median_edge * stretch_factor
        valid_quad = max_edge <= edge_limit

        qx_lo = np.minimum(np.minimum(x_tl, x_tr), np.minimum(x_bl, x_br))
        qx_hi = np.maximum(np.maximum(x_tl, x_tr), np.maximum(x_bl, x_br))
        qz_lo = np.minimum(np.minimum(z_tl, z_tr), np.minimum(z_bl, z_br))
        qz_hi = np.maximum(np.maximum(z_tl, z_tr), np.maximum(z_bl, z_br))
        qy_mx = np.maximum(np.maximum(y_tl, y_tr), np.maximum(y_bl, y_br))

        qx_lo = qx_lo[valid_quad]
        qx_hi = qx_hi[valid_quad]
        qz_lo = qz_lo[valid_quad]
        qz_hi = qz_hi[valid_quad]
        qy_mx = qy_mx[valid_quad]

        if qx_lo.size == 0:
            return WorldHeightMap(grid=grid, covered=covered,
                                  x_min=x_min, z_min=z_min,
                                  cell_size=cell_size)

        gx_lo = np.clip(((qx_lo - x_min) / cell_size).astype(np.intp), 0, gw - 1)
        gx_hi = np.clip(((qx_hi - x_min) / cell_size).astype(np.intp), 0, gw - 1)
        gz_lo = np.clip(((qz_lo - z_min) / cell_size).astype(np.intp), 0, gh - 1)
        gz_hi = np.clip(((qz_hi - z_min) / cell_size).astype(np.intp), 0, gh - 1)

        span_x = int((gx_hi - gx_lo).max()) + 1
        span_z = int((gz_hi - gz_lo).max()) + 1

        flat_y = qy_mx.ravel()
        flat_gx_lo = gx_lo.ravel()
        flat_gz_lo = gz_lo.ravel()
        flat_span_x = (gx_hi - gx_lo).ravel()
        flat_span_z = (gz_hi - gz_lo).ravel()

        for dz in range(span_z):
            for dx in range(span_x):
                mask = (dx <= flat_span_x) & (dz <= flat_span_z)
                if not mask.any():
                    continue
                tgx = np.clip(flat_gx_lo[mask] + dx, 0, gw - 1)
                tgz = np.clip(flat_gz_lo[mask] + dz, 0, gh - 1)
                np.maximum.at(grid, (tgz, tgx), flat_y[mask])
                covered[tgz, tgx] = True

        return WorldHeightMap(grid=grid, covered=covered,
                              x_min=x_min, z_min=z_min,
                              cell_size=cell_size)

    def is_collision(self, x: float, z: float,
                     height_offset: float = 0.0) -> bool:
        gx = int((x - self.x_min) / self.cell_size)
        gz = int((z - self.z_min) / self.cell_size)
        gh, gw = self.covered.shape
        if 0 <= gx < gw and 0 <= gz < gh:
            return self.covered[gz, gx] and self.grid[gz, gx] > height_offset
        return False

    def collision_mask(self, height_offset: float = 0.0) -> np.ndarray:
        return self.covered & (self.grid > height_offset)

    # ---------- manual editing ----------

    def brush(self, cx: float, cz: float, radius: float, value: bool) -> None:
        gh, gw = self.covered.shape
        r_cells = int(np.ceil(radius / self.cell_size)) + 1
        gc_x = int((cx - self.x_min) / self.cell_size)
        gc_z = int((cz - self.z_min) / self.cell_size)
        z0, z1 = max(0, gc_z - r_cells), min(gh, gc_z + r_cells + 1)
        x0, x1 = max(0, gc_x - r_cells), min(gw, gc_x + r_cells + 1)
        if z0 >= z1 or x0 >= x1:
            return
        gz, gx = np.mgrid[z0:z1, x0:x1]
        cell_cx = self.x_min + (gx + 0.5) * self.cell_size
        cell_cz = self.z_min + (gz + 0.5) * self.cell_size
        mask = (cell_cx - cx) ** 2 + (cell_cz - cz) ** 2 <= radius ** 2
        self.covered[z0:z1, x0:x1][mask] = value
        self.grid[z0:z1, x0:x1][mask] = 1e6 if value else 0.0

    def fill_polygon(self, vertices: list[tuple[float, float]],
                     value: bool) -> None:
        if len(vertices) < 3:
            return
        verts = np.array(vertices, dtype=np.float64)
        x_lo, z_lo = verts.min(axis=0)
        x_hi, z_hi = verts.max(axis=0)
        gh, gw = self.covered.shape
        gx0 = max(0, int((x_lo - self.x_min) / self.cell_size))
        gx1 = min(gw, int(np.ceil((x_hi - self.x_min) / self.cell_size)) + 1)
        gz0 = max(0, int((z_lo - self.z_min) / self.cell_size))
        gz1 = min(gh, int(np.ceil((z_hi - self.z_min) / self.cell_size)) + 1)
        if gx0 >= gx1 or gz0 >= gz1:
            return
        gz_idx, gx_idx = np.mgrid[gz0:gz1, gx0:gx1]
        px = self.x_min + (gx_idx + 0.5) * self.cell_size
        pz = self.z_min + (gz_idx + 0.5) * self.cell_size
        inside = np.zeros(px.shape, dtype=bool)
        n = len(vertices)
        for i in range(n):
            x1v, z1v = vertices[i]
            x2v, z2v = vertices[(i + 1) % n]
            crossing = ((z1v <= pz) & (z2v > pz)) | ((z2v <= pz) & (z1v > pz))
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (pz - z1v) / (z2v - z1v)
                x_int = x1v + t * (x2v - x1v)
            inside ^= crossing & (px < x_int)
        self.covered[gz0:gz1, gx0:gx1][inside] = value
        self.grid[gz0:gz1, gx0:gx1][inside] = 1e6 if value else 0.0

    # ---------- persistence ----------

    def save(self, directory: str) -> None:
        os.makedirs(directory, exist_ok=True)
        meta = {
            "x_min": self.x_min,
            "z_min": self.z_min,
            "cell_size": self.cell_size,
            "grid_width": int(self.covered.shape[1]),
            "grid_height": int(self.covered.shape[0]),
        }
        with open(os.path.join(directory, "collision_meta.json"), "w") as f:
            json.dump(meta, f, indent=2)
        img = Image.fromarray((self.covered.astype(np.uint8) * 255), mode="L")
        img.save(os.path.join(directory, "collision.png"))
        np.save(os.path.join(directory, "collision_grid.npy"),
                self.grid.astype(np.float32))

    @staticmethod
    def load(directory: str) -> WorldHeightMap | None:
        meta_path = os.path.join(directory, "collision_meta.json")
        img_path = os.path.join(directory, "collision.png")
        if not os.path.exists(meta_path) or not os.path.exists(img_path):
            return None
        with open(meta_path, "r") as f:
            meta = json.load(f)
        img = Image.open(img_path).convert("L")
        covered = np.array(img) > 127
        grid_path = os.path.join(directory, "collision_grid.npy")
        if os.path.exists(grid_path):
            grid = np.load(grid_path).astype(np.float64)
        else:
            grid = np.where(covered, 1e6, 0.0)
        return WorldHeightMap(
            grid=grid, covered=covered,
            x_min=meta["x_min"], z_min=meta["z_min"],
            cell_size=meta["cell_size"],
        )


def encode_depth_rg16(raw_depth: np.ndarray) -> Image.Image:
    """Encode normalised [0,1] depth into an RGB image with 16-bit precision.

    R = high byte, G = low byte, B = 0.  Decode in shader:
        float d = (R * 255.0 + G) / 256.0 / 255.0;
    which yields  d = (hi * 256 + lo) / 65535.
    """
    clamped = np.clip(raw_depth, 0.0, 1.0)
    uint16 = np.round(clamped * 65535.0).astype(np.uint16)
    hi = (uint16 >> 8).astype(np.uint8)
    lo = (uint16 & 0xFF).astype(np.uint8)
    zeros = np.zeros_like(hi)
    rgb = np.stack([hi, lo, zeros], axis=-1)
    return Image.fromarray(rgb, mode="RGB")


def generate_screen_collision_overlay(
    hmap: WorldHeightMap,
    M: OrthoProjection,
    img_w: int, img_h: int,
    height_offset: float = 0.0,
) -> np.ndarray:
    """Project world-space collision coverage back to screen space.

    Returns:
        Boolean array (img_h, img_w).
    """
    sy, sx = np.mgrid[0:img_h, 0:img_w].astype(np.float64)
    d_floor = M.floor_depth_at_screen_vec(sx, sy)
    X, _, Z = M.screen_to_world(sx, sy, d_floor)

    gx = np.clip(((X - hmap.x_min) / hmap.cell_size).astype(np.intp),
                  0, hmap.covered.shape[1] - 1)
    gz = np.clip(((Z - hmap.z_min) / hmap.cell_size).astype(np.intp),
                  0, hmap.covered.shape[0] - 1)

    return hmap.covered[gz, gx] & (hmap.grid[gz, gx] > height_offset)


# ==================================================================
# 2D Billboard occlusion rendering
# ==================================================================

def render_billboard_occlusion_2d(
    source_image: Image.Image,
    raw_depth: np.ndarray,
    M: OrthoProjection,
    billboard_texture: Image.Image,
    billboard_uv: tuple[float, float],
    billboard_scale: float = 1.0,
    depth_tolerance: float = 0.0,
    floor_offset: float = 0.0,
    collision_map: np.ndarray | None = None,
    collision_alpha: float = 0.3,
) -> Image.Image:
    """Render a screen-space sprite with per-pixel depth occlusion.

    The sprite is a rectangle on screen.  Its world-space geometry is the
    intersection of the back-projected rectangular prism (screen rect along
    view_dir) with a **vertical plane** (spanned by world-Y and camera-right)
    passing through the anchor at the anchor's depth.

    This means the sprite stands truly upright in world space.  The depth
    varies linearly with screen-y (rows), not screen-x (columns):

        d(sy) = d_base + (up . n) / (vd . n * ppu) * (sy - base_sy)

    where n = cross(right, world_up) is the vertical-plane normal.

    Args:
        source_image: background scene (RGB).
        raw_depth: normalised [0,1] relative depth, same size as source_image.
        M: calibrated OrthoProjection.
        billboard_texture: RGBA sprite image.
        billboard_uv: (sx, sy) screen pixel where the sprite base-center sits.
        billboard_scale: pixel-size multiplier for the sprite on screen.
        depth_tolerance: added to scene depth before comparison.
        floor_offset: calibrated-depth bias added to the sprite base depth.
        collision_map: optional bool array (h, w).  True = obstacle.
        collision_alpha: opacity of collision overlay (0 = invisible, 1 = opaque).

    Returns:
        Composited RGB image.
    """
    calibrated_depth = apply_depth_mapping(raw_depth, M.depth_mapping)
    img_h, img_w = calibrated_depth.shape

    bb_tex = billboard_texture.convert("RGBA")
    bb_w, bb_h = bb_tex.size

    scr_w = max(1, int(round(bb_w * billboard_scale)))
    scr_h = max(1, int(round(bb_h * billboard_scale)))
    bb_resized = bb_tex.resize((scr_w, scr_h), Image.Resampling.LANCZOS)
    bb_arr = np.array(bb_resized)

    base_sx, base_sy = billboard_uv

    d_base = M.floor_depth_at_screen(base_sx, base_sy) + floor_offset

    right = M.right
    up = M.up
    vd = M.view_dir
    world_up = np.array([0.0, 1.0, 0.0])
    n = np.cross(right, world_up)
    nn = np.linalg.norm(n)

    depth_per_sy = 0.0
    if nn > 1e-12:
        n /= nn
        vd_n = np.dot(vd, n)
        if abs(vd_n) > 1e-12:
            depth_per_sy = np.dot(up, n) / (vd_n * M.ppu)

    left = int(round(base_sx - scr_w / 2.0))
    top = int(round(base_sy - scr_h))

    sy_local, sx_local = np.mgrid[0:scr_h, 0:scr_w]
    screen_x = sx_local + left
    screen_y = sy_local + top

    sprite_d = d_base + depth_per_sy * (screen_y.astype(np.float64) - base_sy)

    in_bounds = ((screen_x >= 0) & (screen_x < img_w) &
                 (screen_y >= 0) & (screen_y < img_h))
    has_alpha = bb_arr[:, :, 3] > 0
    candidates = in_bounds & has_alpha

    cand_r, cand_c = np.nonzero(candidates)
    if cand_r.size == 0:
        return source_image.convert("RGB")

    tgt_x = screen_x[cand_r, cand_c]
    tgt_y = screen_y[cand_r, cand_c]
    spr_d = sprite_d[cand_r, cand_c]

    scene_d = calibrated_depth[tgt_y, tgt_x]
    visible = (scene_d + depth_tolerance) >= spr_d

    vis_r = cand_r[visible]
    vis_c = cand_c[visible]
    vis_tx = tgt_x[visible]
    vis_ty = tgt_y[visible]

    result = source_image.convert("RGBA").copy()

    if collision_map is not None and collision_alpha > 1e-3:
        a = int(np.clip(collision_alpha * 255, 0, 255))
        col_overlay = np.zeros((img_h, img_w, 4), dtype=np.uint8)
        col_overlay[collision_map, 0] = 220
        col_overlay[collision_map, 1] = 40
        col_overlay[collision_map, 2] = 40
        col_overlay[collision_map, 3] = a
        result = Image.alpha_composite(result, Image.fromarray(col_overlay, "RGBA"))

    sprite_overlay = np.zeros((img_h, img_w, 4), dtype=np.uint8)
    sprite_overlay[vis_ty, vis_tx] = bb_arr[vis_r, vis_c]
    result = Image.alpha_composite(result, Image.fromarray(sprite_overlay, "RGBA"))

    return result.convert("RGB")
