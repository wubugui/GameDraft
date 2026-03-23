from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image


@dataclass
class OrthoCamera:
    """Orthographic camera always looking at the world origin.

    Elevation and azimuth define the viewing direction in spherical
    coordinates.  ``pixels_per_unit`` maps world units to screen pixels.
    ``(cx, cy)`` is the screen position that corresponds to the origin
    of the image-plane coordinate system (typically the image centre).
    """

    elevation_deg: float = 30.0
    azimuth_deg: float = 0.0
    pixels_per_unit: float = 100.0
    cx: float = 0.0
    cy: float = 0.0

    def axes(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return *(right, up, view_dir)* as unit vectors in world space.

        * *right* is always horizontal (``right_y == 0``).
        * *view_dir* points **into** the scene (from camera toward origin).
        """
        el = math.radians(max(5.0, min(85.0, self.elevation_deg)))
        az = math.radians(self.azimuth_deg)

        ce, se = math.cos(el), math.sin(el)
        ca, sa = math.cos(az), math.sin(az)

        look_from = np.array([ce * ca, se, ce * sa], dtype=np.float64)
        view_dir = -look_from

        world_up = np.array([0.0, 1.0, 0.0])
        right = np.cross(world_up, look_from)
        rn = np.linalg.norm(right)
        if rn < 1e-12:
            right = np.array([1.0, 0.0, 0.0])
        else:
            right /= rn

        up = np.cross(look_from, right)
        up /= np.linalg.norm(up)

        return right, up, view_dir


def reconstruct_points(
    source_image: Image.Image,
    calibrated_depth: np.ndarray,
    camera: OrthoCamera,
    subsample: int = 6,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Reconstruct a 3-D point cloud from calibrated depth.

    Returns ``(X, Y, Z, colors)`` where each is a 2-D array of shape
    ``(h_sub, w_sub)``.  *colors* has shape ``(h_sub, w_sub, 3)`` with
    values in ``[0, 1]`` for use with matplotlib *facecolors*.
    """
    right, up, vd = camera.axes()
    ppu = camera.pixels_per_unit
    cx, cy = camera.cx, camera.cy

    h, w = calibrated_depth.shape
    sy_full, sx_full = np.mgrid[0:h, 0:w]

    sy = sy_full[::subsample, ::subsample].astype(np.float64)
    sx = sx_full[::subsample, ::subsample].astype(np.float64)
    d = calibrated_depth[::subsample, ::subsample]

    px = (sx - cx) / ppu
    py = (cy - sy) / ppu

    X = right[0] * px + up[0] * py + vd[0] * d
    Y = right[1] * px + up[1] * py + vd[1] * d
    Z = right[2] * px + up[2] * py + vd[2] * d

    src_arr = np.asarray(source_image.convert("RGB"), dtype=np.float64) / 255.0
    colors = src_arr[::subsample, ::subsample]

    return X, Y, Z, colors


def floor_depth_at_screen(
    sx: float,
    sy: float,
    camera: OrthoCamera,
) -> float:
    """Compute the calibrated-depth value that places screen point
    *(sx, sy)* on the world floor (Y = 0).

    Uses: ``d = -(up_y / view_dir_y) * (cy - sy) / ppu``
    """
    _right, up, vd = camera.axes()
    if abs(vd[1]) < 1e-12:
        return 0.0
    return -(up[1] / vd[1]) * (camera.cy - sy) / camera.pixels_per_unit
