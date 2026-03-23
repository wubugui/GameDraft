"""Quick end-to-end pipeline check with a real scene image."""
import sys, os
sys.path.insert(0, ".")
import numpy as np
from PIL import Image
from tools.scene_depth_editor.calibration import IsometricCalibration, render_calibration_overlay
from tools.scene_depth_editor.reconstruction import (
    DepthMapping, apply_depth_mapping, depth_to_colormap, depth_to_grayscale,
    BillboardParams, render_billboard_occlusion,
)

src_path = "public/assets/images/backgrounds/normal_teahouse_bg.png"
depth_path = "public/assets/images/backgrounds/normal_teahouse_bg_depth.png"

src = Image.open(src_path).convert("RGB")
depth_img = Image.open(depth_path).convert("L")
w, h = src.size
print(f"Source: {w}x{h}   Depth: {depth_img.size}")

raw = np.array(depth_img, dtype=np.float64) / 255.0

mapping = DepthMapping(invert=True, scale=1.0, offset=0.0)
cal = apply_depth_mapping(raw, mapping)
print(f"Calibrated depth range: [{cal.min():.4f}, {cal.max():.4f}]")

color_viz = depth_to_colormap(cal)
gray_viz = depth_to_grayscale(cal)
print(f"Color viz: {color_viz.size} {color_viz.mode}   Gray viz: {gray_viz.size} {gray_viz.mode}")

calib = IsometricCalibration(origin_x=w/2, origin_y=h/2, pixels_per_unit=80,
                              show_grid=True, show_axes=True)
overlay = render_calibration_overlay(w, h, calib)
composed = Image.alpha_composite(src.convert("RGBA"), overlay).convert("RGB")
print(f"Calibration overlay: {composed.size}")

bb = BillboardParams(base_x=w*0.5, base_y=h*0.7, width_px=60, height_px=120,
                     enabled=True, show_wireframe=True)
result = render_billboard_occlusion(src, cal, bb)
print(f"Billboard result: {result.size} {result.mode}")

result.save("_pipeline_result.png")
print("Saved _pipeline_result.png - check visually.")
print("Pipeline OK.")
