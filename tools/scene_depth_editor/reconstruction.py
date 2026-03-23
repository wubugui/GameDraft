from __future__ import annotations

import math
import tkinter as tk
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

from .calibration import OrthoCamera, floor_depth_at_screen, reconstruct_points


@dataclass
class DepthMapping:
    """Parameters for mapping raw normalised [0,1] relative depth to a
    calibrated depth value usable for occlusion comparison."""

    invert: bool = True
    scale: float = 1.0
    offset: float = 0.0


def apply_depth_mapping(raw_norm: np.ndarray, mapping: DepthMapping) -> np.ndarray:
    """Convert normalised [0,1] relative depth to calibrated depth.

    With *invert=True* (default), near surfaces get **small** values and far
    surfaces get **large** values, matching real-distance semantics.
    """
    d = raw_norm.astype(np.float64, copy=True)
    if mapping.invert:
        d = 1.0 - d
    return d * mapping.scale + mapping.offset


# ------------------------------------------------------------------
# 3-D viewer (matplotlib)
# ------------------------------------------------------------------

class Viewer3D:
    """Manages a Toplevel window with an embedded matplotlib 3-D surface."""

    def __init__(self, parent: tk.Misc) -> None:
        from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
        from matplotlib.figure import Figure

        self._top = tk.Toplevel(parent)
        self._top.title("3D 重建视图")
        self._top.geometry("800x700")
        self._top.protocol("WM_DELETE_WINDOW", self._on_close)

        self._fig = Figure(figsize=(8, 7), dpi=100)
        self._ax = self._fig.add_subplot(111, projection="3d")
        self._canvas = FigureCanvasTkAgg(self._fig, master=self._top)
        self._canvas.get_tk_widget().pack(fill="both", expand=True)

        self._alive = True

    @property
    def alive(self) -> bool:
        return self._alive

    def update(
        self,
        X: np.ndarray,
        Y: np.ndarray,
        Z: np.ndarray,
        colors: np.ndarray,
    ) -> None:
        if not self._alive:
            return

        ax = self._ax
        elev, azim = ax.elev, ax.azim
        ax.clear()

        fc = colors.clip(0, 1)
        if fc.ndim == 3:
            fc = fc[:-1, :-1]

        ax.plot_surface(X, Y, Z, facecolors=fc, shade=False,
                        rstride=1, cstride=1, antialiased=False)

        x_range = float(X.max() - X.min()) or 1.0
        z_range = float(Z.max() - Z.min()) or 1.0
        half = max(x_range, z_range) * 0.6
        cx = float((X.max() + X.min()) / 2)
        cz = float((Z.max() + Z.min()) / 2)
        plane_x = np.array([[cx - half, cx + half], [cx - half, cx + half]])
        plane_z = np.array([[cz - half, cz - half], [cz + half, cz + half]])
        plane_y = np.zeros_like(plane_x)
        ax.plot_surface(plane_x, plane_y, plane_z,
                        color="green", alpha=0.15)

        ax.set_xlabel("X")
        ax.set_ylabel("Y")
        ax.set_zlabel("Z")
        ax.set_title("Y=0 green plane = floor")

        if elev is not None:
            ax.view_init(elev=elev, azim=azim)

        self._canvas.draw_idle()

    def _on_close(self) -> None:
        self._alive = False
        self._top.destroy()


def open_3d_viewer(parent: tk.Misc) -> Viewer3D:
    return Viewer3D(parent)


# ------------------------------------------------------------------
# Billboard probe
# ------------------------------------------------------------------

@dataclass
class BillboardParams:
    """Test billboard configuration."""

    base_x: float = 0.0
    base_y: float = 0.0
    width_px: int = 60
    height_px: int = 120
    depth_offset: float = 0.0
    show_wireframe: bool = True
    enabled: bool = True


def create_billboard_texture(width: int, height: int) -> Image.Image:
    """Semi-transparent test texture with a visible outline and base line."""
    img = Image.new("RGBA", (width, height), (80, 160, 255, 140))
    draw = ImageDraw.Draw(img)

    draw.rectangle([0, 0, width - 1, height - 1],
                   outline=(255, 255, 255, 200), width=2)

    cx = width // 2
    head_r = max(3, width // 6)
    head_cy = head_r + 4
    draw.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
                 fill=(180, 220, 255, 190))

    shoulder_y = head_cy + head_r + 2
    sw = max(4, width // 3)
    waist_y = int(height * 0.6)
    ww = max(3, width // 5)
    draw.polygon([
        (cx - sw, shoulder_y), (cx + sw, shoulder_y),
        (cx + ww, waist_y), (cx - ww, waist_y),
    ], fill=(100, 180, 255, 160))

    leg_w = max(2, width // 8)
    draw.rectangle([cx - ww, waist_y, cx - leg_w, height - 3],
                   fill=(70, 150, 240, 150))
    draw.rectangle([cx + leg_w, waist_y, cx + ww, height - 3],
                   fill=(70, 150, 240, 150))

    draw.line([(0, height - 2), (width - 1, height - 2)],
              fill=(255, 80, 80, 220), width=2)
    return img


def render_billboard_occlusion(
    source_image: Image.Image,
    calibrated_depth: np.ndarray,
    bb: BillboardParams,
    camera: OrthoCamera,
    custom_texture: Image.Image | None = None,
) -> Image.Image:
    """Composite billboard onto the scene with per-pixel depth occlusion.

    Billboard depth varies per row based on the camera model:
    ``pixel_depth = base_depth + world_height * view_dir_y``
    where *base_depth* comes from the floor-plane intersection (not depth-map
    sampling), making it correct even when the base is behind an occluder.
    """
    result = source_image.convert("RGBA").copy()
    img_w, img_h = result.size
    dh, dw = calibrated_depth.shape

    if not bb.enabled:
        return result.convert("RGB")

    bb_w, bb_h = bb.width_px, bb.height_px
    if bb_w < 1 or bb_h < 1:
        return result.convert("RGB")

    _right, up, vd = camera.axes()
    ppu = camera.pixels_per_unit

    base_depth = floor_depth_at_screen(bb.base_x, bb.base_y, camera) + bb.depth_offset

    # Screen directions for camera right and world-Y projection
    # Camera right is horizontal in world; its screen projection is along +sx
    # World Y projects onto screen as (0, -up_y * ppu) (up_y < 0 → screen down means world up)
    screen_up_dy = -up[1] * ppu  # pixels per world-Y-unit on screen (negative = up on screen)
    if abs(screen_up_dy) < 1e-6:
        return result.convert("RGB")

    tex = custom_texture if custom_texture is not None else create_billboard_texture(bb_w, bb_h)
    if tex.size != (bb_w, bb_h):
        tex = tex.resize((bb_w, bb_h), Image.Resampling.BILINEAR)
    tex_arr = np.array(tex.convert("RGBA"))

    bx, by = bb.base_x, bb.base_y

    ly_grid, lx_grid = np.mgrid[0:bb_h, 0:bb_w]
    # up_amount: how many pixels above base for each billboard row
    up_amount = (bb_h - 1) - ly_grid  # 0 at bottom row, bb_h-1 at top
    right_amount = lx_grid - bb_w / 2.0

    # Billboard extends straight up on screen (world-Y maps to screen-Y)
    screen_x = bx + right_amount
    screen_y = by - up_amount  # minus because screen Y is downward

    ix = np.round(screen_x).astype(np.int32)
    iy = np.round(screen_y).astype(np.int32)

    in_bounds = (ix >= 0) & (ix < img_w) & (iy >= 0) & (iy < img_h)
    has_alpha = tex_arr[:, :, 3] > 0
    candidates = in_bounds & has_alpha

    cand_rows, cand_cols = np.nonzero(candidates)
    if cand_rows.size == 0:
        return result.convert("RGB")

    tgt_x = ix[cand_rows, cand_cols]
    tgt_y = iy[cand_rows, cand_cols]

    # Per-row depth: world_height = up_y * (sy_base - sy_pixel) / ppu
    world_heights = up[1] * (by - iy[cand_rows, cand_cols].astype(np.float64)) / ppu
    bb_depths = base_depth + world_heights * vd[1]

    depth_sx = np.clip(tgt_x, 0, dw - 1)
    depth_sy = np.clip(tgt_y, 0, dh - 1)
    scene_d = calibrated_depth[depth_sy, depth_sx]
    visible = scene_d >= bb_depths

    vis_rows = cand_rows[visible]
    vis_cols = cand_cols[visible]
    vis_tx = tgt_x[visible]
    vis_ty = tgt_y[visible]

    overlay_arr = np.zeros((img_h, img_w, 4), dtype=np.uint8)
    overlay_arr[vis_ty, vis_tx] = tex_arr[vis_rows, vis_cols]

    overlay_img = Image.fromarray(overlay_arr, "RGBA")
    result = Image.alpha_composite(result, overlay_img)

    if bb.show_wireframe:
        draw = ImageDraw.Draw(result)
        corners = [
            (bx - bb_w / 2.0, by),
            (bx + bb_w / 2.0, by),
            (bx + bb_w / 2.0, by - bb_h + 1),
            (bx - bb_w / 2.0, by - bb_h + 1),
        ]
        for i in range(4):
            draw.line([corners[i], corners[(i + 1) % 4]],
                      fill=(255, 255, 0, 180), width=1)
        r = 4
        draw.ellipse([bx - r, by - r, bx + r, by + r],
                     fill=(255, 50, 50, 230),
                     outline=(255, 255, 255, 200))

    return result.convert("RGB")
