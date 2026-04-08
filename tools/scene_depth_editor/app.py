from __future__ import annotations

import json
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np


def _make_scrollable(parent, width: int) -> tuple[ttk.Frame, tk.Canvas]:
    """Create a scrollable frame. Returns (interior_frame, canvas)."""
    canvas = tk.Canvas(parent, width=width, highlightthickness=0)
    scrollbar = ttk.Scrollbar(parent, orient="vertical", command=canvas.yview)
    interior = ttk.Frame(canvas, width=width)
    win_id = canvas.create_window((0, 0), window=interior, anchor="nw")
    interior.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))

    def _on_mousewheel(e):
        canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")

    def _on_canvas_configure(e):
        canvas.itemconfig(win_id, width=e.width)

    canvas.bind("<Configure>", _on_canvas_configure)
    canvas.bind("<MouseWheel>", _on_mousewheel)
    interior.bind("<MouseWheel>", _on_mousewheel)

    canvas.configure(yscrollcommand=scrollbar.set)
    scrollbar.pack(side="right", fill="y")
    canvas.pack(side="left", fill="both", expand=True)
    return interior, canvas


def _bind_wheel_recursive(widget, canvas):
    """Bind MouseWheel to widget and all descendants so scrolling works over any control."""
    widget.bind("<MouseWheel>", lambda e: canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"))
    for c in widget.winfo_children():
        _bind_wheel_recursive(c, canvas)


from PIL import Image, ImageTk

from .calibration import OrthoCamera, reconstruct_points
from .depth_estimator import MODEL_OPTIONS, DepthEstimator
from .reconstruction import (
    DepthMapping, OrthoProjection, WorldHeightMap, apply_depth_mapping,
    inverse_depth_mapping, build_M, encode_depth_rg16,
    generate_screen_collision_overlay, render_billboard_occlusion_2d,
)

try:
    from .gl_viewer import (
        SceneGLViewer, _make_default_billboard_image,
        TOOL_NONE, TOOL_BRUSH, TOOL_ERASER, TOOL_POLYGON,
        TOOL_DEPTH_RAISE, TOOL_DEPTH_LOWER, TOOL_DEPTH_SMOOTH,
        _DEPTH_TOOLS,
    )
except ImportError as exc:
    raise RuntimeError(
        "缺少 OpenGL 依赖。请执行:\n"
        "pip install PyOpenGL pyopengltk"
    ) from exc


def _repo_root() -> Path:
    """GameDraft 仓库根目录（tools 的上一级）。"""
    return Path(__file__).resolve().parent.parent.parent


def _workspace_scenes_dir() -> Path:
    """编辑器工程场景根目录（打开/新建场景对话框默认从此处浏览）。"""
    return _repo_root() / "editor_data" / "scene"


class SceneDepthEditorApp:
    """Scene depth reconstruction tool.

    Left panel: controls (image, depth, camera, mapping).
    Right panel: OpenGL 3-D mesh viewer with axes and floor grid.
    """

    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("场景深度重建工具")
        self.root.geometry("1400x860")
        self.root.minsize(1060, 640)

        self.depth_estimator = DepthEstimator()

        self._scene_path: Path | None = None
        self.source_image: Image.Image | None = None
        self.depth_image: Image.Image | None = None
        self.raw_depth_array: np.ndarray | None = None
        self.calibrated_depth: np.ndarray | None = None

        self.camera = OrthoCamera()
        self.depth_mapping = DepthMapping()

        # 游戏资源导出目录（写入当前场景 editor.json 的 game_export_path）
        self._game_export_path: str | None = None

        # -- tk variables --
        self.status_var = tk.StringVar(value="新建或打开场景开始工作。")
        self.preview_mode_var = tk.StringVar(value="source")

        self.cam_elevation_var = tk.DoubleVar(value=30.0)
        self.cam_azimuth_var = tk.DoubleVar(value=0.0)
        self.cam_ppu_var = tk.DoubleVar(value=100.0)

        self.dm_invert_var = tk.BooleanVar(value=True)
        self.dm_scale_var = tk.DoubleVar(value=1.0)
        self.dm_offset_var = tk.DoubleVar(value=0.0)

        self.subsample_var = tk.IntVar(value=4)
        self.wireframe_var = tk.BooleanVar(value=False)

        self.show_grid_var = tk.BooleanVar(value=True)
        self.show_axes_var = tk.BooleanVar(value=True)
        self.show_labels_var = tk.BooleanVar(value=True)
        self.show_collision_var = tk.BooleanVar(value=True)

        self.billboard_enabled_var = tk.BooleanVar(value=False)
        self.billboard_scale_var = tk.DoubleVar(value=1.0)

        self.occlusion_step_var = tk.IntVar(value=10)
        self.occlusion_scale_var = tk.DoubleVar(value=1.0)
        self.occlusion_tolerance_var = tk.DoubleVar(value=0.0)
        self.occlusion_floor_offset_var = tk.DoubleVar(value=0.0)
        self.stretch_factor_var = tk.DoubleVar(value=3.0)
        self.collision_height_var = tk.DoubleVar(value=0.05)
        self.collision_alpha_var = tk.DoubleVar(value=0.3)
        self._occlusion_uv: list[float] = [0.0, 0.0]
        self._occlusion_sprite: Image.Image | None = None
        self._occlusion_window: tk.Toplevel | None = None
        self._occlusion_photo: ImageTk.PhotoImage | None = None
        self._occlusion_label: tk.Label | None = None
        self._occlusion_display_ratio: float = 1.0
        self._world_height_map: WorldHeightMap | None = None
        self._screen_collision: np.ndarray | None = None
        self._cached_mesh_xyz: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        self._collision_locked: bool = False

        self.edit_tool_var = tk.StringVar(value=TOOL_NONE)
        self.brush_radius_var = tk.DoubleVar(value=0.5)
        self.depth_strength_var = tk.DoubleVar(value=0.1)
        self._world_xz_cache: tuple[np.ndarray, np.ndarray] | None = None
        self._depth_edit_refresh_pending = False

        self._thumb_photo: ImageTk.PhotoImage | None = None

        self._build_ui()
        self._bind_traces()
        self.root.bind("<KeyPress>", self._on_global_key)

    # ==================================================================
    # UI Construction
    # ==================================================================

    def _build_ui(self) -> None:
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(0, weight=1)

        # -- Left panel: scrollable, fixed width --
        left_outer = ttk.Frame(self.root, padding=0)
        left_outer.grid(row=0, column=0, sticky="ns")
        left_outer.rowconfigure(0, weight=1)
        left_outer.columnconfigure(0, weight=1)
        left, left_canvas = _make_scrollable(left_outer, width=300)
        left.configure(padding=8)

        # -- Right panel (GL viewer, expanding) --
        right = ttk.Frame(self.root, padding=(0, 8, 8, 8))
        right.grid(row=0, column=1, sticky="nsew")
        right.rowconfigure(0, weight=1)
        right.columnconfigure(0, weight=1)

        self.gl_viewer = SceneGLViewer(right, width=800, height=600)
        self.gl_viewer.grid(row=0, column=0, sticky="nsew")
        self.gl_viewer.set_billboard_moved_callback(self._on_billboard_moved)
        self.gl_viewer.set_calibration_camera(self.camera)
        self.gl_viewer.set_collision_edit_callback(self._on_collision_edit)
        self.gl_viewer.set_collision_edit_end_callback(self._on_collision_edit_end)
        self.gl_viewer.set_depth_edit_callback(self._on_depth_edit)
        self.gl_viewer.set_depth_edit_end_callback(self._on_depth_edit_end)

        # -- Status bar --
        status = ttk.Label(self.root, textvariable=self.status_var, padding=(12, 4))
        status.grid(row=1, column=0, columnspan=2, sticky="ew")

        # -- Build left-panel sections --
        row = 0
        row = self._build_scene_section(left, row)
        row = self._build_depth_section(left, row)
        row = self._build_camera_section(left, row)
        row = self._build_mapping_section(left, row)
        row = self._build_recon_section(left, row)
        row = self._build_view_section(left, row)
        row = self._build_billboard_section(left, row)
        row = self._build_occlusion_section(left, row)
        row = self._build_collision_edit_section(left, row)
        row = self._build_depth_edit_section(left, row)
        row = self._build_export_section(left, row)

        _bind_wheel_recursive(left, left_canvas)

    # ---- Scene section ----

    def _build_scene_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="场景", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        r1 = ttk.Frame(box); r1.grid(row=0, column=0, sticky="ew")
        r1.columnconfigure(0, weight=1); r1.columnconfigure(1, weight=1)
        ttk.Button(r1, text="新建场景", command=self._new_scene).grid(
            row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(r1, text="打开场景", command=self._open_scene).grid(
            row=0, column=1, sticky="ew", padx=(2, 0))

        r2 = ttk.Frame(box); r2.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        r2.columnconfigure(0, weight=1); r2.columnconfigure(1, weight=1)
        ttk.Button(r2, text="保存场景", command=self._save_scene).grid(
            row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(r2, text="导出游戏数据", command=self._export_for_game).grid(
            row=0, column=1, sticky="ew", padx=(2, 0))

        self._scene_label = ttk.Label(box, text="未打开场景", foreground="#888",
                                      wraplength=260, justify="left")
        self._scene_label.grid(row=2, column=0, sticky="ew", pady=(6, 0))

        ttk.Separator(box, orient="horizontal").grid(row=3, column=0, sticky="ew", pady=6)

        ttk.Button(box, text="导入背景图", command=self._import_background).grid(
            row=4, column=0, sticky="ew")

        self.image_label = ttk.Label(box, text="无背景图", foreground="#888",
                                     wraplength=260, justify="left")
        self.image_label.grid(row=5, column=0, sticky="ew", pady=(4, 0))

        self.thumb_label = ttk.Label(box)
        self.thumb_label.grid(row=6, column=0, pady=(4, 0))

        mode_frame = ttk.Frame(box)
        mode_frame.grid(row=7, column=0, sticky="w", pady=(4, 0))
        ttk.Radiobutton(mode_frame, text="原图", variable=self.preview_mode_var,
                        value="source", command=self._update_thumb).pack(side="left")
        ttk.Radiobutton(mode_frame, text="深度", variable=self.preview_mode_var,
                        value="depth", command=self._update_thumb).pack(side="left", padx=8)

        return row + 1

    # ---- Depth estimation section ----

    def _build_depth_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="深度估计", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Label(box, text="模型").grid(row=0, column=0, sticky="w")
        self.depth_model_combo = ttk.Combobox(
            box, state="readonly",
            values=[f"{k} - {v}" for k, v in MODEL_OPTIONS.items()], width=32)
        self.depth_model_combo.current(0)
        self.depth_model_combo.grid(row=1, column=0, sticky="ew", pady=(2, 4))

        ttk.Button(box, text="计算深度图", command=self.generate_depth).grid(
            row=2, column=0, sticky="ew")

        return row + 1

    # ---- Camera section ----

    def _build_camera_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="正交相机", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        self._slider(box, "仰角 (5-85)", self.cam_elevation_var, 0, 5, 85, 1.0)
        self._slider(box, "方位角", self.cam_azimuth_var, 2, 0, 360, 1.0)
        self._slider(box, "像素/单位", self.cam_ppu_var, 4, 10, 500, 1.0)

        return row + 1

    # ---- Depth mapping section ----

    def _build_mapping_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="深度映射", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Checkbutton(box, text="反转 (近=小值)", variable=self.dm_invert_var
                        ).grid(row=0, column=0, sticky="w")

        # Scale: slider 0.01~100 + entry for arbitrary value
        ttk.Label(box, text="缩放 (0.01 ~ 100)").grid(row=1, column=0, sticky="w")
        scale_row = ttk.Frame(box)
        scale_row.grid(row=2, column=0, sticky="ew", pady=(0, 4))
        scale_row.columnconfigure(0, weight=1)
        self._scale_slider = tk.Scale(
            scale_row, from_=0.01, to=100.0, orient="horizontal", resolution=0.01,
            variable=self.dm_scale_var, showvalue=True, highlightthickness=0,
            command=lambda _: self._sync_scale_entry())
        self._scale_slider.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self._scale_entry = ttk.Entry(scale_row, width=8)
        self._scale_entry.insert(0, "1.0")
        self._scale_entry.grid(row=0, column=1)
        self._scale_entry.bind("<Return>", self._on_scale_entry_commit)

        # Offset: slider -200~200 + entry for arbitrary value
        ttk.Label(box, text="偏移 (-200 ~ 200)").grid(row=3, column=0, sticky="w")
        offset_row = ttk.Frame(box)
        offset_row.grid(row=4, column=0, sticky="ew", pady=(0, 4))
        offset_row.columnconfigure(0, weight=1)
        self._offset_slider = tk.Scale(
            offset_row, from_=-200.0, to=200.0, orient="horizontal", resolution=0.1,
            variable=self.dm_offset_var, showvalue=True, highlightthickness=0,
            command=lambda _: self._sync_offset_entry())
        self._offset_slider.grid(row=0, column=0, sticky="ew", padx=(0, 4))
        self._offset_entry = ttk.Entry(offset_row, width=8)
        self._offset_entry.insert(0, "0.0")
        self._offset_entry.grid(row=0, column=1)
        self._offset_entry.bind("<Return>", self._on_offset_entry_commit)

        return row + 1

    # ---- Reconstruction section ----

    def _build_recon_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="重建", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        self._slider(box, "采样间隔", self.subsample_var, 0, 1, 20, 1)
        ttk.Checkbutton(box, text="线框模式", variable=self.wireframe_var,
                        command=self._on_wireframe_toggle
                        ).grid(row=2, column=0, sticky="w", pady=(4, 0))

        self.mesh_info_label = ttk.Label(box, text="", foreground="#888")
        self.mesh_info_label.grid(row=3, column=0, sticky="w", pady=(4, 0))

        return row + 1

    # ---- View section ----

    def _build_view_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="3D 视图", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Checkbutton(box, text="显示网格", variable=self.show_grid_var,
                        command=self._on_view_toggle).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(box, text="显示坐标轴", variable=self.show_axes_var,
                        command=self._on_view_toggle).grid(row=1, column=0, sticky="w")
        ttk.Checkbutton(box, text="显示刻度数字", variable=self.show_labels_var,
                        command=self._on_view_toggle).grid(row=2, column=0, sticky="w")
        ttk.Checkbutton(box, text="显示碰撞区域", variable=self.show_collision_var,
                        command=self._on_view_toggle).grid(row=3, column=0, sticky="w")

        return row + 1

    # ---- Billboard section ----

    def _build_billboard_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="Billboard 测试", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Checkbutton(box, text="启用 Billboard (3D)", variable=self.billboard_enabled_var,
                        command=self._on_billboard_toggle).grid(row=0, column=0, sticky="w")
        ttk.Button(box, text="加载 Billboard 贴图", command=self._load_billboard).grid(
            row=1, column=0, sticky="ew", pady=(4, 0))
        ttk.Button(box, text="使用默认贴图", command=self._use_default_billboard).grid(
            row=2, column=0, sticky="ew", pady=(2, 0))
        self._slider(box, "缩放 (0.1 ~ 5)", self.billboard_scale_var, 3, 0.1, 5.0, 0.1)
        ttk.Label(box, text="WASD 移动 (需启用)", foreground="#888").grid(
            row=5, column=0, sticky="w", pady=(4, 0))

        return row + 1

    # ---- 2D Occlusion preview section ----

    def _build_occlusion_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="2D 遮挡预览", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Button(box, text="打开 2D 遮挡预览", command=self._open_occlusion_2d).grid(
            row=0, column=0, sticky="ew")
        self._slider(box, "移动步长 (像素)", self.occlusion_step_var, 1, 1, 50, 1)
        self._slider(box, "Sprite 缩放", self.occlusion_scale_var, 3, 0.1, 5.0, 0.1)
        self._slider(box, "深度容差", self.occlusion_tolerance_var, 5, -5.0, 5.0, 0.01)
        self._slider(box, "地板偏移", self.occlusion_floor_offset_var, 7, -2.0, 2.0, 0.01)

        ttk.Separator(box, orient="horizontal").grid(
            row=9, column=0, sticky="ew", pady=4)
        self._slider(box, "拉伸检测阈值", self.stretch_factor_var, 10, 1.0, 10.0, 0.1)
        self._slider(box, "碰撞高度偏移", self.collision_height_var, 12, -1.0, 2.0, 0.01)
        self._slider(box, "碰撞图透明度", self.collision_alpha_var, 14, 0.0, 1.0, 0.01)

        self._occlusion_pos_label = ttk.Label(box, text="位置: --", foreground="#888")
        self._occlusion_pos_label.grid(row=16, column=0, sticky="w", pady=(4, 0))
        ttk.Label(box, text="WASD 移动 (预览窗口聚焦时)", foreground="#888").grid(
            row=17, column=0, sticky="w")

        return row + 1

    # ---- Collision editing section ----

    def _build_collision_edit_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="碰撞编辑", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Button(box, text="生成碰撞草稿",
                   command=self._generate_collision_draft).grid(
            row=0, column=0, sticky="ew")

        tool_frame = ttk.Frame(box)
        tool_frame.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        for i, (val, txt) in enumerate([
            (TOOL_NONE, "无"), (TOOL_BRUSH, "笔刷"),
            (TOOL_ERASER, "擦除"), (TOOL_POLYGON, "多边形"),
        ]):
            ttk.Radiobutton(tool_frame, text=txt, value=val,
                            variable=self.edit_tool_var,
                            command=self._on_tool_change).grid(
                row=0, column=i, padx=2)

        self._slider(box, "笔刷半径", self.brush_radius_var, 2, 0.01, 5.0, 0.05)

        io_frame = ttk.Frame(box)
        io_frame.grid(row=4, column=0, sticky="ew", pady=(6, 0))
        io_frame.columnconfigure(0, weight=1)
        io_frame.columnconfigure(1, weight=1)
        ttk.Button(io_frame, text="保存碰撞", command=self._save_collision).grid(
            row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(io_frame, text="加载碰撞", command=self._load_collision).grid(
            row=0, column=1, sticky="ew", padx=(2, 0))

        self._collision_edit_label = ttk.Label(box, text="", foreground="#888")
        self._collision_edit_label.grid(row=5, column=0, sticky="w", pady=(4, 0))

        return row + 1

    # ---- Depth editing section ----

    def _build_depth_edit_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="深度编辑", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        tool_frame = ttk.Frame(box)
        tool_frame.grid(row=0, column=0, sticky="ew")
        for i, (val, txt) in enumerate([
            (TOOL_DEPTH_RAISE, "增大深度"),
            (TOOL_DEPTH_LOWER, "减小深度"),
            (TOOL_DEPTH_SMOOTH, "平滑"),
        ]):
            ttk.Radiobutton(tool_frame, text=txt, value=val,
                            variable=self.edit_tool_var,
                            command=self._on_tool_change).grid(
                row=0, column=i, padx=2)

        self._slider(box, "编辑强度", self.depth_strength_var, 1, 0.01, 1.0, 0.01)

        ttk.Button(box, text="重置为原始深度", command=self._reset_depth_edits).grid(
            row=3, column=0, sticky="ew", pady=(4, 0))

        self._depth_edit_label = ttk.Label(
            box, text="Ctrl+左键拖动编辑", foreground="#888")
        self._depth_edit_label.grid(row=4, column=0, sticky="w", pady=(4, 0))

        return row + 1

    # ---- Calibration IO & Presets section ----

    def _build_export_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="标定 Presets", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        preset_hdr = ttk.Frame(box)
        preset_hdr.grid(row=0, column=0, sticky="ew")
        preset_hdr.columnconfigure(0, weight=1)
        ttk.Label(preset_hdr, text="Presets").grid(row=0, column=0, sticky="w")
        ttk.Button(preset_hdr, text="保存当前", width=8,
                   command=self._save_preset).grid(row=0, column=1, padx=(4, 0))

        self._preset_frame = ttk.Frame(box)
        self._preset_frame.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        self._preset_frame.columnconfigure(0, weight=1)
        self._rebuild_preset_buttons()

        return row + 1

    # ---- Helpers ----

    @staticmethod
    def _slider(master, label: str, var, row: int,
                lo: float, hi: float, res: float = 1.0) -> None:
        ttk.Label(master, text=label).grid(row=row, column=0, sticky="w")
        tk.Scale(master, from_=lo, to=hi, orient="horizontal", resolution=res,
                 variable=var, showvalue=True, highlightthickness=0
                 ).grid(row=row + 1, column=0, sticky="ew", pady=(0, 4))

    # ==================================================================
    # Variable traces
    # ==================================================================

    def _bind_traces(self) -> None:
        for v in (self.cam_elevation_var, self.cam_azimuth_var, self.cam_ppu_var,
                  self.dm_invert_var, self.dm_scale_var, self.dm_offset_var,
                  self.subsample_var, self.billboard_scale_var):
            v.trace_add("write", lambda *_: self._schedule_refresh())

        self.billboard_scale_var.trace_add("write", lambda *_: self._on_billboard_scale_changed())
        self.stretch_factor_var.trace_add("write", lambda *_: self._on_stretch_factor_changed())
        self.collision_height_var.trace_add("write", lambda *_: self._on_collision_height_changed())
        self.brush_radius_var.trace_add("write", lambda *_: self.gl_viewer.set_brush_radius(
            self.brush_radius_var.get()))
        self._refresh_pending = False

    def _sync_scale_entry(self) -> None:
        if hasattr(self, "_scale_entry") and self._scale_entry.winfo_exists():
            try:
                v = self.dm_scale_var.get()
                self._scale_entry.delete(0, "end")
                self._scale_entry.insert(0, f"{v:.4g}")
            except tk.TclError:
                pass

    def _sync_offset_entry(self) -> None:
        if hasattr(self, "_offset_entry") and self._offset_entry.winfo_exists():
            try:
                v = self.dm_offset_var.get()
                self._offset_entry.delete(0, "end")
                self._offset_entry.insert(0, f"{v:.4g}")
            except tk.TclError:
                pass

    def _on_scale_entry_commit(self, _event=None) -> None:
        try:
            v = float(self._scale_entry.get())
            v = max(0.001, min(1000.0, v))
            self._scale_slider.configure(from_=min(0.01, v * 0.5), to=max(100, v * 2))
            self.dm_scale_var.set(v)
            self._scale_entry.delete(0, "end")
            self._scale_entry.insert(0, f"{v:.4g}")
        except ValueError:
            self._sync_scale_entry()

    def _on_offset_entry_commit(self, _event=None) -> None:
        try:
            v = float(self._offset_entry.get())
            v = max(-1000.0, min(1000.0, v))
            lo, hi = self._offset_slider.cget("from"), self._offset_slider.cget("to")
            if v < lo or v > hi:
                self._offset_slider.configure(from_=min(-200, v - 50), to=max(200, v + 50))
            self.dm_offset_var.set(v)
            self._offset_entry.delete(0, "end")
            self._offset_entry.insert(0, f"{v:.4g}")
        except ValueError:
            self._sync_offset_entry()

    def _schedule_refresh(self) -> None:
        if self._refresh_pending:
            return
        self._refresh_pending = True
        self.root.after(50, self._do_refresh)

    def _do_refresh(self) -> None:
        self._refresh_pending = False
        self._refresh_3d()

    # ==================================================================
    # Scene management
    # ==================================================================

    _BG_FILENAME = "background.png"
    _DEPTH_CACHE = "depth_cache.npy"
    _SCENE_JSON = "scene.json"
    _EDITOR_JSON = "editor.json"

    def _reset_state(self) -> None:
        self.source_image = None
        self.depth_image = None
        self.raw_depth_array = None
        self.calibrated_depth = None
        self._world_height_map = None
        self._screen_collision = None
        self._cached_mesh_xyz = None
        self._collision_locked = False
        self._world_xz_cache = None
        self._game_export_path = None
        self.gl_viewer.clear_mesh()
        self.image_label.configure(text="无背景图")
        self._thumb_photo = None
        self.thumb_label.configure(image="")
        self.mesh_info_label.configure(text="")

    def _workspace_scenes_initialdir(self) -> str:
        d = _workspace_scenes_dir()
        return str(d) if d.is_dir() else str(_repo_root())

    def _game_export_picker_initialdir(self) -> str:
        root = _repo_root()
        if self._game_export_path:
            resolved = self._resolve_game_export_dir()
            if resolved is not None and resolved.parent.is_dir():
                return str(resolved.parent)
        for rel in ("public/assets/scenes", "assets/scenes"):
            cand = root / rel
            if cand.is_dir():
                return str(cand)
        return str(root)

    def _normalize_path_for_config(self, p: Path) -> str:
        p = p.resolve()
        try:
            rel = p.relative_to(_repo_root())
            return rel.as_posix()
        except ValueError:
            return str(p)

    def _resolve_game_export_dir(self) -> Path | None:
        if not self._game_export_path:
            return None
        raw = self._game_export_path.strip()
        if not raw:
            return None
        p = Path(raw)
        if not p.is_absolute():
            p = _repo_root() / p
        return p.resolve()

    def _persist_game_export_path(self, folder: Path) -> None:
        if self._scene_path is None:
            return
        self._game_export_path = self._normalize_path_for_config(folder)
        editor_path = self._scene_path / self._EDITOR_JSON
        data: dict = {}
        if editor_path.exists():
            data = json.loads(editor_path.read_text(encoding="utf-8"))
        data["game_export_path"] = self._game_export_path
        editor_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _validate_export_target(self, dst_path: Path) -> tuple[bool, str]:
        if not dst_path.is_dir():
            return False, f"不是有效文件夹:\n{dst_path}"
        scene_id = dst_path.name
        scene_json_path = dst_path.parent / f"{scene_id}.json"
        return True, str(scene_json_path)

    def _prepare_scene_data_for_export(
        self, scene_json_path: Path, scene_id: str
    ) -> tuple[dict, bool]:
        """加载或构建可写入游戏的场景 JSON 对象；缺字段时补齐。

        返回 (scene_data, repaired)。repaired 表示新建文件、JSON 无法解析、
        或曾补全/修正关键字段（会与导出结果一并写回）。"""
        data: dict = {}
        repaired = False

        if scene_json_path.exists():
            try:
                raw = json.loads(scene_json_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    data = raw
                else:
                    repaired = True
            except (json.JSONDecodeError, OSError):
                repaired = True
        else:
            repaired = True

        if self.source_image is None:
            img_w, img_h = 800, 600
        else:
            img_w, img_h = self.source_image.size

        def _mark_repair() -> None:
            nonlocal repaired
            repaired = True

        if data.get("id") != scene_id:
            _mark_repair()
            data["id"] = scene_id

        name = data.get("name")
        if not name:
            _mark_repair()
            data["name"] = str(scene_id)

        ww, wh = data.get("worldWidth"), data.get("worldHeight")
        try:
            ww_ok = ww is not None and float(ww) > 0
        except (TypeError, ValueError):
            ww_ok = False
        try:
            wh_ok = wh is not None and float(wh) > 0
        except (TypeError, ValueError):
            wh_ok = False
        if not ww_ok:
            _mark_repair()
            data["worldWidth"] = int(img_w)
        if not wh_ok:
            _mark_repair()
            data["worldHeight"] = int(img_h)

        cam = data.get("camera")
        if not isinstance(cam, dict):
            _mark_repair()
            data["camera"] = {"zoom": 1.0, "pixelsPerUnit": 1.0}
        else:
            if "zoom" not in cam:
                _mark_repair()
                cam["zoom"] = 1.0
            if "pixelsPerUnit" not in cam:
                _mark_repair()
                cam["pixelsPerUnit"] = 1.0

        bgs = data.get("backgrounds")
        if not isinstance(bgs, list) or len(bgs) == 0:
            _mark_repair()
            data["backgrounds"] = [{"image": "background.png", "x": 0, "y": 0}]
        else:
            first = bgs[0]
            if not isinstance(first, dict) or not first.get("image"):
                _mark_repair()
                data["backgrounds"] = [{"image": "background.png", "x": 0, "y": 0}]
            elif first.get("image") != "background.png":
                _mark_repair()
                first_fixed = dict(first)
                first_fixed["image"] = "background.png"
                data["backgrounds"] = [first_fixed] + list(bgs[1:])

        sp = data.get("spawnPoint")
        if not isinstance(sp, dict):
            _mark_repair()
            data["spawnPoint"] = {
                "x": round(img_w / 2.0, 1),
                "y": round(img_h * 0.85, 1),
            }
        else:
            if "x" not in sp or "y" not in sp:
                _mark_repair()
                data["spawnPoint"] = {
                    "x": round(img_w / 2.0, 1),
                    "y": round(img_h * 0.85, 1),
                }

        return data, repaired

    def _new_scene(self) -> None:
        path = filedialog.askdirectory(
            title="选择新场景文件夹位置",
            initialdir=self._workspace_scenes_initialdir())
        if not path:
            return
        from tkinter import simpledialog
        name = simpledialog.askstring("新建场景", "场景名称:", parent=self.root)
        if not name or not name.strip():
            return
        scene_dir = Path(path) / name.strip()
        if scene_dir.exists():
            messagebox.showerror("错误", f"文件夹已存在: {scene_dir}")
            return
        scene_dir.mkdir(parents=True)
        (scene_dir / self._EDITOR_JSON).write_text("{}", encoding="utf-8")
        self._scene_path = scene_dir
        self._reset_state()
        self._scene_label.configure(text=f"场景: {scene_dir.name}")
        self.root.title(f"场景深度重建工具 - {scene_dir.name}")
        self._set_status(f"新建场景: {scene_dir}")

    def _open_scene(self) -> None:
        path = filedialog.askdirectory(
            title="打开场景文件夹",
            initialdir=self._workspace_scenes_initialdir())
        if not path:
            return
        scene_dir = Path(path)
        if not scene_dir.is_dir():
            return
        self._scene_path = scene_dir
        self._reset_state()
        self._scene_label.configure(text=f"场景: {scene_dir.name}")
        self.root.title(f"场景深度重建工具 - {scene_dir.name}")

        scene_json = scene_dir / self._SCENE_JSON
        if scene_json.exists():
            data = json.loads(scene_json.read_text(encoding="utf-8"))
            cal = data.get("calibration", {})
            self._apply_calibration_data(cal)

        editor_json = scene_dir / self._EDITOR_JSON
        if editor_json.exists():
            self._apply_editor_data(
                json.loads(editor_json.read_text(encoding="utf-8")))

        bg = scene_dir / self._BG_FILENAME
        if bg.exists():
            self._load_background(bg)

        depth = scene_dir / self._DEPTH_CACHE
        if depth.exists() and self.source_image is not None:
            self.raw_depth_array = np.load(str(depth)).astype(np.float64)
            self.depth_image = Image.fromarray(
                (self.raw_depth_array * 255).clip(0, 255).astype(np.uint8), "L")
            self._recompute_calibrated_depth()
            self._update_thumb()
            self._refresh_3d()

        self._load_collision(silent=True)

        self._set_status(f"场景已打开: {scene_dir.name}")

    def _save_scene(self) -> None:
        if self._scene_path is None:
            messagebox.showinfo("提示", "请先新建或打开一个场景。")
            return
        d = self._scene_path
        d.mkdir(parents=True, exist_ok=True)

        scene_data = {"calibration": self._collect_calibration_data()}
        (d / self._SCENE_JSON).write_text(
            json.dumps(scene_data, indent=2, ensure_ascii=False), encoding="utf-8")

        (d / self._EDITOR_JSON).write_text(
            json.dumps(self._collect_editor_data(), indent=2, ensure_ascii=False),
            encoding="utf-8")

        if self.raw_depth_array is not None:
            np.save(str(d / self._DEPTH_CACHE),
                    self.raw_depth_array.astype(np.float32))

        self._save_collision(silent=True)

        self._set_status(f"场景已保存: {d.name}")

    def _import_background(self) -> None:
        if self._scene_path is None:
            messagebox.showinfo("提示", "请先新建或打开一个场景。")
            return
        path = filedialog.askopenfilename(
            title="选择背景图片",
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        if not path:
            return
        dst = self._scene_path / self._BG_FILENAME
        img = Image.open(path).convert("RGB")
        img.save(str(dst), format="PNG")
        self.depth_image = None
        self.raw_depth_array = None
        self.calibrated_depth = None
        self._world_height_map = None
        self._screen_collision = None
        self._cached_mesh_xyz = None
        self._collision_locked = False
        self.gl_viewer.clear_mesh()
        self._load_background(dst)
        self._set_status(f"背景图已导入: {Path(path).name}")

    def _load_background(self, path: Path) -> None:
        self.source_image = Image.open(path).convert("RGB")
        w, h = self.source_image.size
        self.camera.cx = w / 2.0
        self.camera.cy = h / 2.0
        self.gl_viewer.set_calibration_camera(self.camera)
        self.image_label.configure(text=f"{path.name}  ({w} x {h})")
        self._update_thumb()
        self._occlusion_uv = [w / 2.0, h * 0.8]

    # ---- Scene data collect / apply ----

    def _collect_editor_data(self) -> dict:
        return {
            "depth_model": self.depth_model_combo.get(),
            "subsample": self.subsample_var.get(),
            "wireframe": self.wireframe_var.get(),
            "view": {
                "show_grid": self.show_grid_var.get(),
                "show_axes": self.show_axes_var.get(),
                "show_labels": self.show_labels_var.get(),
                "show_collision": self.show_collision_var.get(),
            },
            "collision_edit": {
                "stretch_factor": self.stretch_factor_var.get(),
                "height_offset": self.collision_height_var.get(),
                "collision_alpha": self.collision_alpha_var.get(),
                "brush_radius": self.brush_radius_var.get(),
            },
            "billboard": {
                "enabled": self.billboard_enabled_var.get(),
                "scale": self.billboard_scale_var.get(),
            },
            "occlusion": {
                "step": self.occlusion_step_var.get(),
                "scale": self.occlusion_scale_var.get(),
                "tolerance": self.occlusion_tolerance_var.get(),
                "floor_offset": self.occlusion_floor_offset_var.get(),
            },
            "game_export_path": self._game_export_path,
        }

    def _apply_editor_data(self, data: dict) -> None:
        if "depth_model" in data:
            idx = 0
            for i, v in enumerate(self.depth_model_combo["values"]):
                if v == data["depth_model"]:
                    idx = i
                    break
            self.depth_model_combo.current(idx)
        if "subsample" in data:
            self.subsample_var.set(data["subsample"])
        if "wireframe" in data:
            self.wireframe_var.set(data["wireframe"])
        view = data.get("view", {})
        for k, var in [("show_grid", self.show_grid_var),
                       ("show_axes", self.show_axes_var),
                       ("show_labels", self.show_labels_var),
                       ("show_collision", self.show_collision_var)]:
            if k in view:
                var.set(view[k])
        ce = data.get("collision_edit", {})
        for k, var in [("stretch_factor", self.stretch_factor_var),
                       ("height_offset", self.collision_height_var),
                       ("collision_alpha", self.collision_alpha_var),
                       ("brush_radius", self.brush_radius_var)]:
            if k in ce:
                var.set(ce[k])
        bb = data.get("billboard", {})
        if "enabled" in bb:
            self.billboard_enabled_var.set(bb["enabled"])
        if "scale" in bb:
            self.billboard_scale_var.set(bb["scale"])
        occ = data.get("occlusion", {})
        for k, var in [("step", self.occlusion_step_var),
                       ("scale", self.occlusion_scale_var),
                       ("tolerance", self.occlusion_tolerance_var),
                       ("floor_offset", self.occlusion_floor_offset_var)]:
            if k in occ:
                var.set(occ[k])
        if "game_export_path" in data and data["game_export_path"]:
            self._game_export_path = str(data["game_export_path"])
        else:
            self._game_export_path = None
        self._sync_viewer_from_vars()

    def _sync_viewer_from_vars(self) -> None:
        self.gl_viewer.set_show_grid(self.show_grid_var.get())
        self.gl_viewer.set_show_axes(self.show_axes_var.get())
        self.gl_viewer.set_show_labels(self.show_labels_var.get())
        self.gl_viewer.set_show_collision(self.show_collision_var.get())
        self.gl_viewer.set_wireframe(self.wireframe_var.get())
        self.gl_viewer.set_brush_radius(self.brush_radius_var.get())

    def generate_depth(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先导入背景图。")
            return

        model_key = self.depth_model_combo.get().split(" - ", 1)[0].strip()
        model_id = MODEL_OPTIONS[model_key]
        self._set_status("正在计算深度图...")

        def worker():
            try:
                result = self.depth_estimator.generate_depth(
                    self.source_image, model_id=model_id,
                    status=lambda t: self.root.after(0, lambda: self._set_status(t)))
                self.root.after(0, lambda: self._on_depth_done(result))
            except Exception as exc:
                self.root.after(0, lambda: self._show_error(str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _on_depth_done(self, result) -> None:
        self.depth_image = result.image
        self.raw_depth_array = np.array(result.raw_normalized, dtype=np.float64)
        if self._scene_path is not None:
            np.save(str(self._scene_path / self._DEPTH_CACHE),
                    self.raw_depth_array.astype(np.float32))
        self._recompute_calibrated_depth()
        self.preview_mode_var.set("depth")
        self._update_thumb()
        self._refresh_3d()
        self._set_status("深度图已生成并缓存。")

    # ==================================================================
    # Reconstruction
    # ==================================================================

    def _sync_camera(self) -> None:
        self.camera.elevation_deg = self.cam_elevation_var.get()
        self.camera.azimuth_deg = self.cam_azimuth_var.get()
        self.camera.pixels_per_unit = max(1.0, self.cam_ppu_var.get())

    def _recompute_calibrated_depth(self) -> None:
        if self.raw_depth_array is None:
            self.calibrated_depth = None
            return
        self.depth_mapping.invert = self.dm_invert_var.get()
        self.depth_mapping.scale = self.dm_scale_var.get()
        self.depth_mapping.offset = self.dm_offset_var.get()
        self.calibrated_depth = apply_depth_mapping(self.raw_depth_array, self.depth_mapping)

    def _refresh_3d(self, *, auto_fit: bool = True) -> None:
        if self.calibrated_depth is None or self.source_image is None:
            return
        self._sync_camera()
        self._recompute_calibrated_depth()
        self.gl_viewer.set_calibration_camera(self.camera)
        sub = max(1, self.subsample_var.get())
        X, Y, Z, colors = reconstruct_points(
            self.source_image, self.calibrated_depth, self.camera, subsample=sub)
        self.gl_viewer.set_mesh(X, Y, Z, colors, auto_fit=auto_fit)
        self.gl_viewer.set_mesh_texture(self.source_image)
        self._world_xz_cache = None

        self._cached_mesh_xyz = (X, Y, Z)
        if not self._collision_locked:
            self._rebuild_height_map()

        major = self.gl_viewer._grid_major
        self.mesh_info_label.configure(
            text=f"顶点: {self.gl_viewer.vertex_count}  "
                 f"三角面: {self.gl_viewer.tri_count}  "
                 f"网格: {major:.2f} 单位/格")

    def _rebuild_height_map(self) -> None:
        if self._cached_mesh_xyz is None:
            self._world_height_map = None
            self._screen_collision = None
            return
        X, Y, Z = self._cached_mesh_xyz
        sf = self.stretch_factor_var.get()
        self._world_height_map = WorldHeightMap.from_mesh(X, Y, Z,
                                                          stretch_factor=sf)
        self._rebuild_screen_collision()
        self._update_3d_collision()

    def _rebuild_screen_collision(self) -> None:
        if self._world_height_map is None or self.source_image is None:
            self._screen_collision = None
            return
        M = self._build_M()
        w, h = self.source_image.size
        ho = self.collision_height_var.get()
        self._screen_collision = generate_screen_collision_overlay(
            self._world_height_map, M, w, h, height_offset=ho)

    def _update_3d_collision(self) -> None:
        if self._world_height_map is None:
            self.gl_viewer.set_collision_data(None)
            return
        hmap = self._world_height_map
        ho = self.collision_height_var.get()
        mask = hmap.collision_mask(height_offset=ho)
        self.gl_viewer.set_collision_data(mask, hmap.x_min, hmap.z_min,
                                          hmap.cell_size, y_level=ho)

    # ==================================================================
    # Thumbnail preview
    # ==================================================================

    def _update_thumb(self) -> None:
        mode = self.preview_mode_var.get()
        img = None
        if mode == "source" and self.source_image is not None:
            img = self.source_image
        elif mode == "depth" and self.depth_image is not None:
            img = self.depth_image.convert("RGB")

        if img is None:
            self._thumb_photo = None
            self.thumb_label.configure(image="")
            return

        max_w, max_h = 260, 120
        ratio = min(max_w / img.width, max_h / img.height, 1.0)
        thumb = img.resize((int(img.width * ratio), int(img.height * ratio)),
                           Image.Resampling.LANCZOS)
        self._thumb_photo = ImageTk.PhotoImage(thumb)
        self.thumb_label.configure(image=self._thumb_photo)

    # ==================================================================
    # Wireframe toggle
    # ==================================================================

    def _on_wireframe_toggle(self) -> None:
        self.gl_viewer.set_wireframe(self.wireframe_var.get())

    def _on_view_toggle(self) -> None:
        self._sync_viewer_from_vars()

    def _on_billboard_toggle(self) -> None:
        on = self.billboard_enabled_var.get()
        self.gl_viewer.set_billboard_enabled(on)
        if on and self.gl_viewer._billboard_tex_id is None:
            self.gl_viewer.load_billboard_texture(None)
        self._update_billboard_status()

    def _on_billboard_scale_changed(self) -> None:
        self.gl_viewer.set_billboard_scale(self.billboard_scale_var.get())

    def _load_billboard(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 Billboard 贴图",
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"), ("All files", "*.*")])
        if path:
            self.gl_viewer.load_billboard_texture(path)
            self.billboard_enabled_var.set(True)
            self.gl_viewer.set_billboard_enabled(True)
            self._set_status(f"已加载 Billboard: {Path(path).name}")

    def _use_default_billboard(self) -> None:
        self.gl_viewer.load_billboard_texture(None)
        self.billboard_enabled_var.set(True)
        self.gl_viewer.set_billboard_enabled(True)
        self._set_status("已使用默认 Billboard 贴图")

    def _on_billboard_moved(self, x: float, z: float) -> None:
        self._update_billboard_status()

    def _update_billboard_status(self) -> None:
        if self.billboard_enabled_var.get():
            x, z = self.gl_viewer._billboard_pos[0], self.gl_viewer._billboard_pos[1]
            self._set_status(f"Billboard 位置: X={x:.2f} Z={z:.2f}  (WASD 移动)")

    def _on_stretch_factor_changed(self) -> None:
        if self._cached_mesh_xyz is not None and not self._collision_locked:
            self._rebuild_height_map()

    def _on_collision_height_changed(self) -> None:
        if self._world_height_map is not None:
            self._rebuild_screen_collision()
            self._update_3d_collision()

    # ==================================================================
    # Collision editing
    # ==================================================================

    def _on_tool_change(self) -> None:
        tool = self.edit_tool_var.get()
        self.gl_viewer.set_edit_tool(tool)
        if tool in (TOOL_BRUSH, TOOL_ERASER, TOOL_POLYGON):
            self._set_status("碰撞编辑: Ctrl+左键=编辑  右键拖拽=旋转  中键拖拽=平移")
        elif tool in _DEPTH_TOOLS:
            self._set_status("深度编辑: Ctrl+左键拖动=涂抹  右键拖拽=旋转  中键拖拽=平移")
        else:
            self._set_status("")

    def _generate_collision_draft(self) -> None:
        if self._cached_mesh_xyz is None:
            self._set_status("请先加载图像并生成深度")
            return
        self._collision_locked = False
        self._rebuild_height_map()
        self._collision_locked = True
        n = int(self._world_height_map.covered.sum()) if self._world_height_map else 0
        self._collision_edit_label.configure(text=f"草稿已生成 ({n} 个碰撞格)")
        self._set_status("碰撞草稿已生成，可使用工具编辑")

    def _on_collision_edit(self, action: str, points: list, radius: float) -> None:
        hmap = self._world_height_map
        if hmap is None:
            return
        self._collision_locked = True
        if action == "brush":
            for cx, cz in points:
                hmap.brush(cx, cz, radius, True)
        elif action == "erase":
            for cx, cz in points:
                hmap.brush(cx, cz, radius, False)
        elif action == "polygon":
            hmap.fill_polygon(points, True)
        self._update_3d_collision()

    def _on_collision_edit_end(self) -> None:
        self._rebuild_screen_collision()

    def _save_collision(self, *, silent: bool = False) -> bool:
        hmap = self._world_height_map
        if hmap is None:
            if not silent:
                self._set_status("没有碰撞数据可保存")
            return False
        if self._scene_path is None:
            if not silent:
                self._set_status("未打开场景")
            return False
        d = str(self._scene_path)
        hmap.save(d)
        meta_path = self._scene_path / "collision_meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["height_offset"] = self.collision_height_var.get()
        meta["stretch_factor"] = self.stretch_factor_var.get()
        meta["collision_alpha"] = self.collision_alpha_var.get()
        meta["brush_radius"] = self.brush_radius_var.get()
        meta_path.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
        if not silent:
            self._set_status(f"碰撞已保存到 {self._scene_path}")
        return True

    def _load_collision(self, *, silent: bool = False) -> bool:
        if self._scene_path is None:
            if not silent:
                self._set_status("未打开场景")
            return False
        hmap = WorldHeightMap.load(str(self._scene_path))
        if hmap is None:
            if not silent:
                self._set_status(f"未找到碰撞数据: {self._scene_path}")
            return False
        self._world_height_map = hmap
        self._collision_locked = True
        meta_path = self._scene_path / "collision_meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if "height_offset" in meta:
                    self.collision_height_var.set(meta["height_offset"])
                if "stretch_factor" in meta:
                    self.stretch_factor_var.set(meta["stretch_factor"])
                if "collision_alpha" in meta:
                    self.collision_alpha_var.set(meta["collision_alpha"])
                if "brush_radius" in meta:
                    self.brush_radius_var.set(meta["brush_radius"])
            except Exception:
                pass
        self._rebuild_screen_collision()
        self._update_3d_collision()
        n = int(hmap.covered.sum())
        self._collision_edit_label.configure(text=f"已加载 ({n} 个碰撞格)")
        if not silent:
            self._set_status(f"碰撞已加载: {self._scene_path}")
        return True

    def _on_global_key(self, e) -> None:
        if e.keysym.lower() in ("w", "a", "s", "d"):
            self.gl_viewer.on_key(e.keysym)

    # ==================================================================
    # Depth editing
    # ==================================================================

    def _recompute_world_xz_cache(self) -> None:
        if self.calibrated_depth is None or self.source_image is None:
            self._world_xz_cache = None
            return
        self._sync_camera()
        right, up, vd = self.camera.axes()
        ppu = self.camera.pixels_per_unit
        cx_cam, cy_cam = self.camera.cx, self.camera.cy
        h, w = self.calibrated_depth.shape
        sy, sx = np.mgrid[0:h, 0:w].astype(np.float64)
        px = (sx - cx_cam) / ppu
        py = (cy_cam - sy) / ppu
        d = self.calibrated_depth
        X = right[0] * px + up[0] * py + vd[0] * d
        Z = right[2] * px + up[2] * py + vd[2] * d
        self._world_xz_cache = (X, Z)

    def _on_depth_edit(self, action: str, center_xz: tuple,
                       radius: float) -> None:
        if self.calibrated_depth is None or self.raw_depth_array is None:
            return
        self._sync_camera()

        if self._world_xz_cache is None:
            self._recompute_world_xz_cache()
        if self._world_xz_cache is None:
            return

        X_c, Z_c = self._world_xz_cache
        bx, bz = center_xz
        dist_sq = (X_c - bx) ** 2 + (Z_c - bz) ** 2
        r_sq = radius * radius
        mask = dist_sq < r_sq
        if not mask.any():
            return

        sigma_sq = 2.0 * (radius * 0.5) ** 2
        weights = np.exp(-dist_sq[mask] / sigma_sq)
        strength = self.depth_strength_var.get()

        step = strength * 0.05

        if action == TOOL_DEPTH_RAISE:
            self.calibrated_depth[mask] += step * weights

        elif action == TOOL_DEPTH_LOWER:
            self.calibrated_depth[mask] -= step * weights

        elif action == TOOL_DEPTH_SMOOTH:
            cd = self.calibrated_depth
            padded = np.pad(cd, 1, mode='edge')
            avg = (padded[:-2, 1:-1] + padded[2:, 1:-1]
                   + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4.0
            delta = (avg[mask] - cd[mask]) * strength * weights
            cd[mask] += delta

        self.raw_depth_array = inverse_depth_mapping(
            self.calibrated_depth, self.depth_mapping)
        self.depth_image = Image.fromarray(
            (self.raw_depth_array * 255).clip(0, 255).astype(np.uint8), "L")
        self._schedule_depth_edit_refresh()

    def _on_depth_edit_end(self) -> None:
        self._world_xz_cache = None
        self._recompute_world_xz_cache()
        self._refresh_3d(auto_fit=False)
        self._update_thumb()
        if not self._collision_locked:
            self._rebuild_height_map()

    def _schedule_depth_edit_refresh(self) -> None:
        if self._depth_edit_refresh_pending:
            return
        self._depth_edit_refresh_pending = True
        self.root.after(80, self._do_depth_edit_refresh)

    def _do_depth_edit_refresh(self) -> None:
        self._depth_edit_refresh_pending = False
        if self.calibrated_depth is None or self.source_image is None:
            return
        self._sync_camera()
        sub = max(self.subsample_var.get(), 6)
        X, Y, Z, colors = reconstruct_points(
            self.source_image, self.calibrated_depth, self.camera, subsample=sub)
        self.gl_viewer.set_mesh(X, Y, Z, colors, auto_fit=False)

    def _reset_depth_edits(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先导入背景图。")
            return
        if messagebox.askyesno("确认", "将重新估计深度图，所有编辑将丢失。继续?"):
            self.generate_depth()

    # ==================================================================
    # 2D Occlusion preview
    # ==================================================================

    # ==================================================================
    # Game export
    # ==================================================================

    def _export_for_game(self) -> None:
        if self.source_image is None or self.raw_depth_array is None:
            messagebox.showinfo("提示", "请先导入背景图并生成深度图。")
            return
        if self._scene_path is None:
            messagebox.showinfo("提示", "请先打开或新建场景。")
            return

        dst_path: Path | None = None
        scene_json_path: Path | None = None
        resolved = self._resolve_game_export_dir()
        if resolved is not None and resolved.is_dir():
            ok, msg_or_json = self._validate_export_target(resolved)
            if ok:
                dst_path = resolved
                scene_json_path = Path(msg_or_json)

        if dst_path is None:
            picked = filedialog.askdirectory(
                title="选择游戏资源目录（与同名场景 JSON 同级，如 .../public/assets/scenes/teahouse；缺少或损坏的 JSON 将自动创建/修复）",
                initialdir=self._game_export_picker_initialdir())
            if not picked:
                return
            dst_path = Path(picked)
            dst_path.mkdir(parents=True, exist_ok=True)
            ok, msg_or_json = self._validate_export_target(dst_path)
            if not ok:
                messagebox.showerror("错误", msg_or_json)
                return
            scene_json_path = Path(msg_or_json)
            self._persist_game_export_path(dst_path)
            self._set_status(f"已记录导出目录到工程配置: {self._game_export_path}")

        assert dst_path is not None and scene_json_path is not None

        scene_data, scene_json_repaired = self._prepare_scene_data_for_export(
            scene_json_path, dst_path.name)

        M = self._build_M()

        rg16_img = encode_depth_rg16(self.raw_depth_array)
        rg16_img.save(str(dst_path / "raw_depth_rg.png"))

        self.source_image.save(str(dst_path / "background.png"), format="PNG")

        hmap = self._world_height_map
        if hmap is not None:
            ho = self.collision_height_var.get()
            mask = hmap.collision_mask(height_offset=ho)
            col_img = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
            col_img.save(str(dst_path / "collision.png"))

        right = M.right
        up = M.up
        vd = M.view_dir
        world_up = np.array([0.0, 1.0, 0.0])
        n = np.cross(right, world_up)
        nn = float(np.linalg.norm(n))

        depth_per_sy = 0.0
        if nn > 1e-12:
            n /= nn
            vd_n = float(np.dot(vd, n))
            if abs(vd_n) > 1e-12:
                depth_per_sy = float(np.dot(up, n)) / (vd_n * M.ppu)

        floor_depth_A = 0.0
        floor_depth_B = 0.0
        if abs(vd[1]) > 1e-12:
            floor_depth_A = up[1] / (vd[1] * M.ppu)
            floor_depth_B = -(up[1] * M.cy) / (vd[1] * M.ppu)

        depth_config: dict = {
            "depth_map": "raw_depth_rg.png",
            "collision_map": "collision.png" if hmap is not None else "",
            "M": {
                "R": M.R.tolist(),
                "ppu": M.ppu,
                "cx": M.cx,
                "cy": M.cy,
            },
            "depth_mapping": {
                "invert": M.depth_mapping.invert,
                "scale": M.depth_mapping.scale,
                "offset": M.depth_mapping.offset,
            },
            "shader": {
                "depth_per_sy": float(depth_per_sy),
                "floor_depth_A": float(floor_depth_A),
                "floor_depth_B": float(floor_depth_B),
            },
            "depth_tolerance": self.occlusion_tolerance_var.get(),
            "floor_offset": self.occlusion_floor_offset_var.get(),
        }

        if hmap is not None:
            ho = self.collision_height_var.get()
            depth_config["collision"] = {
                "x_min": hmap.x_min,
                "z_min": hmap.z_min,
                "cell_size": hmap.cell_size,
                "grid_width": int(hmap.covered.shape[1]),
                "grid_height": int(hmap.covered.shape[0]),
                "height_offset": ho,
            }

        scene_data["depthConfig"] = depth_config
        scene_json_path.write_text(
            json.dumps(scene_data, indent=2, ensure_ascii=False), encoding="utf-8")

        self._set_status(f"游戏数据已导出到: {dst_path}")
        repair_note = ""
        if scene_json_repaired:
            repair_note = "\n\n场景 JSON 已新建或已修复（含 id、背景、出生点等必要字段）。"
        messagebox.showinfo(
            "导出完成",
            f"资源已导出到:\n{dst_path}\n\n"
            f"depthConfig 已写入:\n{scene_json_path}"
            f"{repair_note}")

    def _build_M(self) -> OrthoProjection:
        self._sync_camera()
        self._recompute_calibrated_depth()
        return build_M(self.camera, self.depth_mapping)

    def _ensure_occlusion_sprite(self) -> Image.Image:
        if self._occlusion_sprite is None:
            self._occlusion_sprite = _make_default_billboard_image()
        return self._occlusion_sprite

    def _open_occlusion_2d(self) -> None:
        if self.source_image is None or self.raw_depth_array is None:
            messagebox.showinfo("提示", "请先导入背景图并计算深度图。")
            return

        if self._occlusion_window is not None and self._occlusion_window.winfo_exists():
            self._occlusion_window.focus_force()
            self._refresh_occlusion_2d()
            return

        win = tk.Toplevel(self.root)
        win.title("2D 遮挡预览  [WASD 移动]")
        self._occlusion_window = win

        self._occlusion_label = tk.Label(win)
        self._occlusion_label.pack(fill="both", expand=True)

        win.bind("<KeyPress>", self._on_occlusion_key)
        win.protocol("WM_DELETE_WINDOW", self._close_occlusion_2d)

        self._refresh_occlusion_2d()
        win.focus_force()

    def _close_occlusion_2d(self) -> None:
        if self._occlusion_window is not None:
            self._occlusion_window.destroy()
            self._occlusion_window = None
            self._occlusion_label = None

    def _on_occlusion_key(self, e) -> None:
        k = e.keysym.lower()
        if k not in ("w", "a", "s", "d"):
            return
        step = max(1, self.occlusion_step_var.get())
        new_uv = list(self._occlusion_uv)
        if k == "a":
            new_uv[0] -= step
        elif k == "d":
            new_uv[0] += step
        elif k == "w":
            new_uv[1] -= step
        elif k == "s":
            new_uv[1] += step

        if self._world_height_map is not None:
            M = self._build_M()
            d_floor = M.floor_depth_at_screen(new_uv[0], new_uv[1])
            bx, _, bz = M.screen_to_world(
                np.float64(new_uv[0]), np.float64(new_uv[1]), np.float64(d_floor))
            ho = self.collision_height_var.get()
            if self._world_height_map.is_collision(float(bx), float(bz), ho):
                return

        self._occlusion_uv = new_uv
        self._refresh_occlusion_2d()

    def _refresh_occlusion_2d(self) -> None:
        if self.source_image is None or self.raw_depth_array is None:
            return
        if self._occlusion_window is None or not self._occlusion_window.winfo_exists():
            return

        sprite = self._ensure_occlusion_sprite()
        M = self._build_M()
        uv = (self._occlusion_uv[0], self._occlusion_uv[1])
        scale = self.occlusion_scale_var.get()
        tol = self.occlusion_tolerance_var.get()
        f_off = self.occlusion_floor_offset_var.get()

        col_alpha = self.collision_alpha_var.get()

        result = render_billboard_occlusion_2d(
            self.source_image, self.raw_depth_array,
            M, sprite, billboard_uv=uv, billboard_scale=scale,
            depth_tolerance=tol, floor_offset=f_off,
            collision_map=self._screen_collision, collision_alpha=col_alpha,
        )
        self._show_occlusion_image(result)

        blocked = ""
        if self._world_height_map is not None:
            d_fl = M.floor_depth_at_screen(uv[0], uv[1])
            bx, _, bz = M.screen_to_world(
                np.float64(uv[0]), np.float64(uv[1]), np.float64(d_fl))
            ho = self.collision_height_var.get()
            if self._world_height_map.is_collision(float(bx), float(bz), ho):
                blocked = "  [碰撞!]"

        if hasattr(self, "_occlusion_pos_label"):
            self._occlusion_pos_label.configure(
                text=f"位置: X={uv[0]:.0f}  Y={uv[1]:.0f}{blocked}")

    def _show_occlusion_image(self, img: Image.Image) -> None:
        max_w, max_h = 1200, 800
        ratio = min(max_w / img.width, max_h / img.height, 1.0)
        self._occlusion_display_ratio = ratio
        display = img.resize((int(img.width * ratio), int(img.height * ratio)),
                             Image.Resampling.LANCZOS)

        win = self._occlusion_window
        if win is not None and win.winfo_exists():
            cur_geo = win.geometry().split("+")[0]
            target = f"{display.width}x{display.height}"
            if cur_geo != target:
                win.geometry(target)

        self._occlusion_photo = ImageTk.PhotoImage(display)
        if self._occlusion_label is not None:
            self._occlusion_label.configure(image=self._occlusion_photo)

    # ==================================================================
    # Calibration IO & Presets
    # ==================================================================

    _PRESETS_FILE = Path(__file__).resolve().parent / "presets.json"

    def _collect_calibration_data(self) -> dict:
        self._sync_camera()
        return {
            "camera": {
                "elevation_deg": self.camera.elevation_deg,
                "azimuth_deg": self.camera.azimuth_deg,
                "pixels_per_unit": self.camera.pixels_per_unit,
                "cx": self.camera.cx,
                "cy": self.camera.cy,
            },
            "depth_mapping": {
                "invert": self.depth_mapping.invert,
                "scale": self.depth_mapping.scale,
                "offset": self.depth_mapping.offset,
            },
        }

    def _apply_calibration_data(self, data: dict) -> None:
        cam = data.get("camera", {})
        dm = data.get("depth_mapping", {})
        if "elevation_deg" in cam:
            self.cam_elevation_var.set(cam["elevation_deg"])
        if "azimuth_deg" in cam:
            self.cam_azimuth_var.set(cam["azimuth_deg"])
        if "pixels_per_unit" in cam:
            self.cam_ppu_var.set(cam["pixels_per_unit"])
        if "cx" in cam:
            self.camera.cx = cam["cx"]
        if "cy" in cam:
            self.camera.cy = cam["cy"]
        if "invert" in dm:
            self.dm_invert_var.set(dm["invert"])
        if "scale" in dm:
            lo = min(0.01, dm["scale"] * 0.5)
            hi = max(100, dm["scale"] * 2)
            self._scale_slider.configure(from_=lo, to=hi)
            self.dm_scale_var.set(dm["scale"])
            self._sync_scale_entry()
        if "offset" in dm:
            lo = min(-200, dm["offset"] - 50)
            hi = max(200, dm["offset"] + 50)
            self._offset_slider.configure(from_=lo, to=hi)
            self.dm_offset_var.set(dm["offset"])
            self._sync_offset_entry()

    # ---- Presets ----

    def _load_all_presets(self) -> dict[str, dict]:
        if self._PRESETS_FILE.exists():
            try:
                return json.loads(self._PRESETS_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _save_all_presets(self, presets: dict[str, dict]) -> None:
        self._PRESETS_FILE.write_text(
            json.dumps(presets, indent=2, ensure_ascii=False), encoding="utf-8")

    def _save_preset(self) -> None:
        from tkinter import simpledialog
        name = simpledialog.askstring("保存 Preset", "请输入 Preset 名称:", parent=self.root)
        if not name or not name.strip():
            return
        name = name.strip()
        presets = self._load_all_presets()
        presets[name] = self._collect_calibration_data()
        self._save_all_presets(presets)
        self._rebuild_preset_buttons()
        self._set_status(f"Preset 已保存: {name}")

    def _apply_preset(self, name: str) -> None:
        presets = self._load_all_presets()
        data = presets.get(name)
        if data is None:
            messagebox.showinfo("提示", f"Preset \"{name}\" 不存在。")
            return
        self._apply_calibration_data(data)
        self._set_status(f"已应用 Preset: {name}")

    def _delete_preset(self, name: str) -> None:
        if not messagebox.askyesno("确认删除", f"删除 Preset \"{name}\"?"):
            return
        presets = self._load_all_presets()
        presets.pop(name, None)
        self._save_all_presets(presets)
        self._rebuild_preset_buttons()
        self._set_status(f"Preset 已删除: {name}")

    def _rebuild_preset_buttons(self) -> None:
        for w in self._preset_frame.winfo_children():
            w.destroy()
        presets = self._load_all_presets()
        if not presets:
            ttk.Label(self._preset_frame, text="(暂无 Preset)", foreground="#888"
                      ).grid(row=0, column=0, sticky="w")
            return
        for i, name in enumerate(presets):
            row_f = ttk.Frame(self._preset_frame)
            row_f.grid(row=i, column=0, sticky="ew", pady=1)
            row_f.columnconfigure(0, weight=1)
            ttk.Button(row_f, text=name,
                       command=lambda n=name: self._apply_preset(n)
                       ).grid(row=0, column=0, sticky="ew")
            ttk.Button(row_f, text="X", width=3,
                       command=lambda n=name: self._delete_preset(n)
                       ).grid(row=0, column=1, padx=(2, 0))

    # ==================================================================
    # Status helpers
    # ==================================================================

    def _set_status(self, text: str) -> None:
        self.status_var.set(text)

    def _show_error(self, text: str) -> None:
        self._set_status("发生错误。")
        messagebox.showerror("错误", text)

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    SceneDepthEditorApp().run()


if __name__ == "__main__":
    main()
