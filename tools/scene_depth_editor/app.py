from __future__ import annotations

import json
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import Image

from .calibration import OrthoCamera, floor_depth_at_screen, reconstruct_points
from .depth_estimator import MODEL_OPTIONS, DepthEstimator
from .editor_canvas import EditorCanvas
from .mask_utils import apply_mask_to_image, build_foreground_mask, AutoMaskSettings
from .reconstruction import (
    BillboardParams,
    DepthMapping,
    Viewer3D,
    apply_depth_mapping,
    open_3d_viewer,
    render_billboard_occlusion,
)


class SceneDepthEditorApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("场景深度遮挡实验工具")
        self.root.geometry("1280x860")
        self.root.minsize(1060, 720)

        self.depth_estimator = DepthEstimator()

        self.image_path: Path | None = None
        self.source_image: Image.Image | None = None
        self.depth_image: Image.Image | None = None
        self.mask_image: Image.Image | None = None
        self.auto_mask_image: Image.Image | None = None
        self.raw_depth_array: np.ndarray | None = None
        self.calibrated_depth: np.ndarray | None = None

        self.camera = OrthoCamera()
        self.depth_mapping = DepthMapping()
        self.billboard = BillboardParams()
        self.billboard_texture: Image.Image | None = None
        self._viewer3d: Viewer3D | None = None

        self.status_var = tk.StringVar(value="打开场景图，计算深度，然后在各页签中做标定与遮挡实验。")

        self.view_var = tk.StringVar(value="overlay")
        self.overlay_alpha_var = tk.IntVar(value=110)
        self.show_edge_overlay_var = tk.BooleanVar(value=False)
        self.edge_overlay_alpha_var = tk.IntVar(value=150)

        self.paint_value_var = tk.StringVar(value="add")
        self.tool_mode_var = tk.StringVar(value="depth_brush")
        self.brush_size_var = tk.IntVar(value=24)
        self.depth_tolerance_var = tk.IntVar(value=20)
        self.edge_barrier_var = tk.IntVar(value=10)
        self.fill_radius_var = tk.IntVar(value=64)

        self.cam_elevation_var = tk.DoubleVar(value=30.0)
        self.cam_azimuth_var = tk.DoubleVar(value=0.0)
        self.cam_ppu_var = tk.DoubleVar(value=100.0)

        self.dm_invert_var = tk.BooleanVar(value=True)
        self.dm_scale_var = tk.DoubleVar(value=1.0)
        self.dm_offset_var = tk.DoubleVar(value=0.0)

        self.recon_subsample_var = tk.IntVar(value=6)

        self.bb_width_var = tk.IntVar(value=60)
        self.bb_height_var = tk.IntVar(value=120)
        self.bb_depth_offset_var = tk.DoubleVar(value=0.0)
        self.bb_show_wire_var = tk.BooleanVar(value=True)
        self.bb_enabled_var = tk.BooleanVar(value=True)

        self._build_ui()
        self._bind_traces()
        self.root.bind_all("<Control-z>", self._on_undo_shortcut)
        self.root.bind_all("<Control-Z>", self._on_undo_shortcut)

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(0, weight=1)

        control_frame = ttk.Frame(self.root, padding=10)
        control_frame.grid(row=0, column=0, sticky="ns")
        control_frame.columnconfigure(0, weight=1)

        canvas_frame = ttk.Frame(self.root, padding=(0, 8, 8, 8))
        canvas_frame.grid(row=0, column=1, sticky="nsew")
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)

        self.canvas = EditorCanvas(canvas_frame, mask_changed=self._on_mask_changed)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.canvas.set_billboard_moved_callback(self._on_billboard_moved)
        self.canvas.set_point_picked_callback(self._on_floor_picked)

        status_bar = ttk.Label(self.root, textvariable=self.status_var, padding=(12, 4))
        status_bar.grid(row=1, column=0, columnspan=2, sticky="ew")

        top_actions = ttk.Frame(control_frame)
        top_actions.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        top_actions.columnconfigure(0, weight=1)
        top_actions.columnconfigure(1, weight=1)
        ttk.Button(top_actions, text="打开场景图", command=self.open_image).grid(
            row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(top_actions, text="适配画布", command=self.canvas.fit_to_view).grid(
            row=0, column=1, sticky="ew", padx=(4, 0))

        self.image_label = ttk.Label(control_frame, text="未选择图片",
                                     wraplength=260, justify="left")
        self.image_label.grid(row=1, column=0, sticky="ew", pady=(0, 8))

        self.notebook = ttk.Notebook(control_frame)
        self.notebook.grid(row=2, column=0, sticky="nsew")

        self._build_depth_tab()
        self._build_brush_tab()
        self._build_reconstruction_tab()
        self._build_test_tab()
        self._build_export_tab()

        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

        self._sync_brush_mode()
        self._sync_tool_mode()
        self._sync_depth_tolerance()
        self._sync_edge_barrier()
        self._sync_fill_radius()
        self._update_preview_mode()
        self._on_edge_overlay_toggle()

    def _build_depth_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        tab.columnconfigure(0, weight=1)
        self.notebook.add(tab, text="深度")

        box = ttk.LabelFrame(tab, text="深度图")
        box.grid(row=0, column=0, sticky="ew")
        box.columnconfigure(0, weight=1)

        ttk.Label(box, text="模型").grid(row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        self.depth_model_combo = ttk.Combobox(
            box, state="readonly",
            values=[f"{k} - {v}" for k, v in MODEL_OPTIONS.items()], width=34)
        self.depth_model_combo.current(0)
        self.depth_model_combo.grid(row=1, column=0, sticky="ew", padx=8, pady=(0, 8))

        ttk.Button(box, text="计算深度图", command=self.generate_depth).grid(
            row=2, column=0, sticky="ew", padx=8, pady=(0, 8))
        ttk.Button(box, text="从深度生成初始蒙版", command=self.build_mask_from_depth).grid(
            row=3, column=0, sticky="ew", padx=8, pady=(0, 8))
        ttk.Button(box, text="恢复到初始蒙版", command=self.restore_auto_mask).grid(
            row=4, column=0, sticky="ew", padx=8, pady=(0, 8))

    def _build_brush_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        tab.columnconfigure(0, weight=1)
        self.notebook.add(tab, text="画笔")

        box = ttk.LabelFrame(tab, text="手工精修")
        box.grid(row=0, column=0, sticky="ew")
        box.columnconfigure(0, weight=1)

        ttk.Label(box, text="绘制内容").grid(row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        ttk.Radiobutton(box, text="添加前景", variable=self.paint_value_var,
                         value="add", command=self._sync_brush_mode
                         ).grid(row=1, column=0, sticky="w", padx=8, pady=(0, 4))
        ttk.Radiobutton(box, text="擦除前景", variable=self.paint_value_var,
                         value="erase", command=self._sync_brush_mode
                         ).grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        ttk.Label(box, text="工具模式").grid(row=3, column=0, sticky="w", padx=8, pady=(8, 4))
        for ridx, (txt, val) in enumerate([
            ("普通画笔", "normal"),
            ("深度约束画笔", "depth_brush"),
            ("深度局部填充（单击）", "depth_fill"),
        ], start=4):
            ttk.Radiobutton(box, text=txt, variable=self.tool_mode_var,
                             value=val, command=self._sync_tool_mode
                             ).grid(row=ridx, column=0, sticky="w", padx=8, pady=(0, 4))

        self._add_scale(box, "画笔大小", self.brush_size_var, 7, 1, 200)
        self._add_scale(box, "深度容差", self.depth_tolerance_var, 9, 0, 80)
        self._add_scale(box, "边界阻断阈值", self.edge_barrier_var, 11, 0, 80)
        self._add_scale(box, "局部填充半径", self.fill_radius_var, 13, 4, 256)

    def _build_reconstruction_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        tab.columnconfigure(0, weight=1)
        self.notebook.add(tab, text="重建")

        cam_box = ttk.LabelFrame(tab, text="正交摄像机")
        cam_box.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        cam_box.columnconfigure(0, weight=1)

        self._add_scale_float(cam_box, "仰角 (5-85)", self.cam_elevation_var, 0, 5, 85, 1.0)
        self._add_scale_float(cam_box, "方位角 (0-360)", self.cam_azimuth_var, 2, 0, 360, 1.0)
        self._add_scale_float(cam_box, "像素/单位", self.cam_ppu_var, 4, 10, 500, 1.0)

        dm_box = ttk.LabelFrame(tab, text="深度映射")
        dm_box.grid(row=1, column=0, sticky="ew", pady=(0, 6))
        dm_box.columnconfigure(0, weight=1)

        ttk.Checkbutton(dm_box, text="反转深度方向 (近=小值)", variable=self.dm_invert_var,
                         command=self._refresh_reconstruction).grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        self._add_scale_float(dm_box, "缩放", self.dm_scale_var, 1, 0.01, 10.0, 0.01)
        self._add_scale_float(dm_box, "偏移", self.dm_offset_var, 3, -5.0, 5.0, 0.01)

        action_box = ttk.LabelFrame(tab, text="操作")
        action_box.grid(row=2, column=0, sticky="ew", pady=(0, 6))
        action_box.columnconfigure(0, weight=1)

        ttk.Button(action_box, text="点击画布设定地板 (Y=0)",
                   command=self._enter_pick_floor).grid(
            row=0, column=0, sticky="ew", padx=8, pady=(8, 4))

        self._add_scale(action_box, "采样间隔", self.recon_subsample_var, 1, 1, 20)

        ttk.Button(action_box, text="打开 3D 重建视图",
                   command=self._open_3d_viewer).grid(
            row=3, column=0, sticky="ew", padx=8, pady=(4, 8))

        ttk.Label(tab, text="重建 tab: 画布点击 = 设定地板 (Y=0)",
                  foreground="#888888").grid(row=3, column=0, sticky="w", pady=(4, 0))

    def _build_test_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        tab.columnconfigure(0, weight=1)
        self.notebook.add(tab, text="测试")

        box = ttk.LabelFrame(tab, text="Billboard 探针")
        box.grid(row=0, column=0, sticky="ew")
        box.columnconfigure(0, weight=1)

        ttk.Checkbutton(box, text="启用 Billboard", variable=self.bb_enabled_var,
                         command=self._refresh_billboard).grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        ttk.Checkbutton(box, text="显示边框 / 基点", variable=self.bb_show_wire_var,
                         command=self._refresh_billboard).grid(
            row=1, column=0, sticky="w", padx=8, pady=(0, 4))

        self._add_scale(box, "宽度 (px)", self.bb_width_var, 2, 10, 400)
        self._add_scale(box, "高度 (px)", self.bb_height_var, 4, 10, 600)
        self._add_scale_float(box, "深度偏移", self.bb_depth_offset_var, 6, -1.0, 1.0, 0.005)

        ttk.Button(box, text="加载自定义贴图", command=self._load_billboard_texture).grid(
            row=8, column=0, sticky="ew", padx=8, pady=(4, 4))
        ttk.Button(box, text="重置默认贴图", command=self._reset_billboard_texture).grid(
            row=9, column=0, sticky="ew", padx=8, pady=(0, 8))

        ttk.Label(tab, text="左键点击/拖动画布移动 Billboard",
                  foreground="#888888").grid(row=1, column=0, sticky="w", pady=(6, 0))

    def _build_export_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=8)
        tab.columnconfigure(0, weight=1)
        self.notebook.add(tab, text="导出")

        preview_box = ttk.LabelFrame(tab, text="旧版预览")
        preview_box.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        preview_box.columnconfigure(0, weight=1)

        for ridx, (txt, val) in enumerate([
            ("原图 + 蒙版", "overlay"),
            ("原始深度图", "depth"),
            ("前景扣图预览", "foreground"),
        ]):
            ttk.Radiobutton(preview_box, text=txt, variable=self.view_var,
                             value=val, command=self._update_preview_mode
                             ).grid(row=ridx, column=0, sticky="w", padx=8,
                                    pady=(8 if ridx == 0 else 0, 4))

        self._add_scale(preview_box, "蒙版透明度", self.overlay_alpha_var, 3, 0, 255)
        ttk.Checkbutton(preview_box, text="显示深度边界辅助线",
                         variable=self.show_edge_overlay_var,
                         command=self._on_edge_overlay_toggle).grid(
            row=5, column=0, sticky="w", padx=8, pady=(4, 4))
        self._add_scale(preview_box, "边界辅助线透明度", self.edge_overlay_alpha_var, 6, 0, 255)

        export_box = ttk.LabelFrame(tab, text="导出")
        export_box.grid(row=1, column=0, sticky="ew")
        export_box.columnconfigure(0, weight=1)

        ttk.Button(export_box, text="导入已有蒙版继续编辑", command=self.load_mask).grid(
            row=0, column=0, sticky="ew", padx=8, pady=(8, 4))
        ttk.Button(export_box, text="保存深度图 / 蒙版 / 前景图", command=self.save_outputs).grid(
            row=1, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Button(export_box, text="保存标定参数 (JSON)", command=self._save_calibration_json).grid(
            row=2, column=0, sticky="ew", padx=8, pady=(0, 8))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _add_scale(self, master, label_text: str, variable, row: int,
                   start: float, end: float, resolution: float = 1.0) -> None:
        ttk.Label(master, text=label_text).grid(row=row, column=0, sticky="w", padx=8)
        tk.Scale(master, from_=start, to=end, orient="horizontal", resolution=resolution,
                 variable=variable, showvalue=True, highlightthickness=0
                 ).grid(row=row + 1, column=0, sticky="ew", padx=8, pady=(0, 6))

    def _add_scale_float(self, master, label_text: str, variable, row: int,
                         start: float, end: float, resolution: float = 0.01) -> None:
        self._add_scale(master, label_text, variable, row, start, end, resolution)

    def _bind_traces(self) -> None:
        self.brush_size_var.trace_add("write", self._on_brush_size_changed)
        self.overlay_alpha_var.trace_add("write", self._on_overlay_alpha_changed)
        self.edge_overlay_alpha_var.trace_add("write", self._on_edge_overlay_alpha_changed)
        self.depth_tolerance_var.trace_add("write", self._on_depth_tolerance_changed)
        self.edge_barrier_var.trace_add("write", self._on_edge_barrier_changed)
        self.fill_radius_var.trace_add("write", self._on_fill_radius_changed)

        self.cam_elevation_var.trace_add("write", lambda *_: self._refresh_reconstruction())
        self.cam_azimuth_var.trace_add("write", lambda *_: self._refresh_reconstruction())
        self.cam_ppu_var.trace_add("write", lambda *_: self._refresh_reconstruction())

        self.dm_invert_var.trace_add("write", lambda *_: self._refresh_reconstruction())
        self.dm_scale_var.trace_add("write", lambda *_: self._refresh_reconstruction())
        self.dm_offset_var.trace_add("write", lambda *_: self._refresh_reconstruction())

        self.recon_subsample_var.trace_add("write", lambda *_: self._refresh_3d_viewer())

        self.bb_width_var.trace_add("write", lambda *_: self._refresh_billboard())
        self.bb_height_var.trace_add("write", lambda *_: self._refresh_billboard())
        self.bb_depth_offset_var.trace_add("write", lambda *_: self._refresh_billboard())
        self.bb_enabled_var.trace_add("write", lambda *_: self._refresh_billboard())
        self.bb_show_wire_var.trace_add("write", lambda *_: self._refresh_billboard())

    # ------------------------------------------------------------------
    # Tab switching
    # ------------------------------------------------------------------

    def _on_tab_changed(self, _event=None) -> None:
        idx = self.notebook.index(self.notebook.select())
        if idx == 2:  # 重建
            self.canvas.set_interaction_mode("pick_floor")
            self._set_status("重建 tab: 点击画布可设定地板 (Y=0)。")
        elif idx == 3:  # 测试
            self._refresh_billboard()
            self.view_var.set("billboard_test")
            self.canvas.set_interaction_mode("billboard")
        else:
            self.canvas.set_interaction_mode("paint")
        self._update_preview_mode()

    # ------------------------------------------------------------------
    # Image / depth workflow
    # ------------------------------------------------------------------

    def open_image(self) -> None:
        file_path = filedialog.askopenfilename(
            title="选择场景图片",
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        if not file_path:
            return

        self.image_path = Path(file_path)
        self.source_image = Image.open(self.image_path).convert("RGB")
        self.depth_image = None
        self.raw_depth_array = None
        self.calibrated_depth = None
        self.mask_image = Image.new("L", self.source_image.size, color=0)
        self.auto_mask_image = self.mask_image.copy()

        w, h = self.source_image.size
        self.camera.cx = w / 2.0
        self.camera.cy = h / 2.0

        self.billboard.base_x = w / 2
        self.billboard.base_y = h * 0.75

        self.image_label.configure(text=str(self.image_path))
        self._push_images_to_canvas(fit_view=True)
        self._set_status("已打开图片。请先到「深度」页计算深度图。")

    def generate_depth(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先打开一张场景图。")
            return

        model_key = self.depth_model_combo.get().split(" - ", 1)[0].strip()
        model_id = MODEL_OPTIONS[model_key]
        self._set_status("准备计算深度图...")

        def worker() -> None:
            try:
                result = self.depth_estimator.generate_depth(
                    self.source_image, model_id=model_id,
                    status=self._set_status_threadsafe)
                self.root.after(0, lambda: self._on_depth_ready(result))
            except Exception as exc:
                self.root.after(0, lambda: self._show_error(str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _on_depth_ready(self, result) -> None:
        self.depth_image = result.image
        self.raw_depth_array = np.array(result.raw_normalized, dtype=np.float64)
        self._recompute_calibrated_depth()
        self._push_images_to_canvas()
        self._set_status("深度图已生成。可切到「重建」「测试」页做实验。")

    def build_mask_from_depth(self) -> None:
        if self.depth_image is None:
            messagebox.showinfo("提示", "请先计算深度图。")
            return
        settings = AutoMaskSettings(threshold=170, near_is_bright=True)
        self.mask_image = build_foreground_mask(self.depth_image, settings)
        self.auto_mask_image = self.mask_image.copy()
        self._push_images_to_canvas()
        self._set_status("已从深度生成初始蒙版。")

    def restore_auto_mask(self) -> None:
        if self.auto_mask_image is None:
            return
        self.mask_image = self.auto_mask_image.copy()
        self._push_images_to_canvas()
        self._set_status("已恢复到自动生成的蒙版。")

    def load_mask(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先打开对应的场景图，再导入蒙版。")
            return
        initial_dir = str(self.image_path.parent) if self.image_path else str(Path.cwd())
        file_path = filedialog.askopenfilename(
            title="选择已有蒙版", initialdir=initial_dir,
            filetypes=[("PNG mask", "*.png"),
                       ("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        if not file_path:
            return
        loaded = Image.open(file_path).convert("L")
        if loaded.size != self.source_image.size:
            messagebox.showerror("错误",
                                 f"蒙版尺寸不一致。\n场景图：{self.source_image.size}\n蒙版：{loaded.size}")
            return
        self.mask_image = loaded
        self.auto_mask_image = loaded.copy()
        self._push_images_to_canvas()
        self._set_status(f"已导入蒙版：{Path(file_path).name}")

    def save_outputs(self) -> None:
        current_mask = self.canvas.get_mask_image()
        if self.source_image is None or current_mask is None:
            messagebox.showinfo("提示", "当前没有可保存的结果。")
            return
        initial_dir = str(self.image_path.parent) if self.image_path else str(Path.cwd())
        output_dir = filedialog.askdirectory(title="选择导出目录", initialdir=initial_dir)
        if not output_dir:
            return

        stem = self.image_path.stem if self.image_path else "scene"
        out = Path(output_dir)
        self.mask_image = current_mask
        fg = apply_mask_to_image(self.source_image, current_mask).convert("RGBA")

        if self.depth_image is not None:
            self.depth_image.save(out / f"{stem}_depth.png", format="PNG")
        current_mask.save(out / f"{stem}_mask.png")
        fg.save(out / f"{stem}_foreground.png", format="PNG")
        self._set_status(f"结果已保存到：{out}")

    # ------------------------------------------------------------------
    # Reconstruction (camera + depth + 3D)
    # ------------------------------------------------------------------

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

    def _refresh_reconstruction(self) -> None:
        self._sync_camera()
        self._recompute_calibrated_depth()
        self._refresh_3d_viewer()
        self._refresh_billboard()

    def _enter_pick_floor(self) -> None:
        self.canvas.set_interaction_mode("pick_floor")
        self._set_status("点击画布选取地板点 (Y=0)...")

    def _on_floor_picked(self, x: float, y: float) -> None:
        if self.calibrated_depth is None:
            self._set_status("请先计算深度图。")
            return

        self._sync_camera()
        floor_d = floor_depth_at_screen(x, y, self.camera)

        h, w = self.calibrated_depth.shape
        sx = max(0, min(w - 1, int(round(x))))
        sy = max(0, min(h - 1, int(round(y))))
        current_d = float(self.calibrated_depth[sy, sx])

        new_offset = self.dm_offset_var.get() + (floor_d - current_d)
        self.dm_offset_var.set(round(new_offset, 4))

        self._set_status(
            f"地板点 ({int(x)}, {int(y)})  "
            f"期望深度={floor_d:.4f}  原深度={current_d:.4f}  "
            f"新偏移={new_offset:.4f}"
        )

    # ------------------------------------------------------------------
    # 3D viewer
    # ------------------------------------------------------------------

    def _open_3d_viewer(self) -> None:
        if self.calibrated_depth is None or self.source_image is None:
            messagebox.showinfo("提示", "请先计算深度图。")
            return
        if self._viewer3d is not None and self._viewer3d.alive:
            self._refresh_3d_viewer()
            return
        self._viewer3d = open_3d_viewer(self.root)
        self._refresh_3d_viewer()

    def _refresh_3d_viewer(self) -> None:
        if self._viewer3d is None or not self._viewer3d.alive:
            return
        if self.calibrated_depth is None or self.source_image is None:
            return
        self._sync_camera()
        sub = max(1, self.recon_subsample_var.get())
        X, Y, Z, colors = reconstruct_points(
            self.source_image, self.calibrated_depth, self.camera, subsample=sub)
        self._viewer3d.update(X, Y, Z, colors)

    # ------------------------------------------------------------------
    # Billboard test
    # ------------------------------------------------------------------

    def _sync_billboard_params(self) -> None:
        self.billboard.width_px = max(1, self.bb_width_var.get())
        self.billboard.height_px = max(1, self.bb_height_var.get())
        self.billboard.depth_offset = self.bb_depth_offset_var.get()
        self.billboard.show_wireframe = self.bb_show_wire_var.get()
        self.billboard.enabled = self.bb_enabled_var.get()

    def _refresh_billboard(self) -> None:
        if self.source_image is None or self.calibrated_depth is None:
            return
        self._sync_billboard_params()
        self._sync_camera()
        result = render_billboard_occlusion(
            self.source_image, self.calibrated_depth, self.billboard,
            camera=self.camera,
            custom_texture=self.billboard_texture)
        self.canvas.set_extra_preview("billboard_test", result)

    def _on_billboard_moved(self, x: float, y: float) -> None:
        self.billboard.base_x = x
        self.billboard.base_y = y
        self._refresh_billboard()

        self._sync_camera()
        floor_d = floor_depth_at_screen(x, y, self.camera)
        self._set_status(
            f"Billboard 基点 ({int(x)}, {int(y)})  "
            f"地板深度={floor_d:.4f}  "
            f"偏移后={floor_d + self.billboard.depth_offset:.4f}"
        )

    def _load_billboard_texture(self) -> None:
        file_path = filedialog.askopenfilename(
            title="选择 Billboard 贴图",
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        if not file_path:
            return
        self.billboard_texture = Image.open(file_path).convert("RGBA")
        self._refresh_billboard()
        self._set_status(f"已加载贴图：{Path(file_path).name}")

    def _reset_billboard_texture(self) -> None:
        self.billboard_texture = None
        self._refresh_billboard()
        self._set_status("已重置为默认贴图。")

    # ------------------------------------------------------------------
    # Export calibration
    # ------------------------------------------------------------------

    def _save_calibration_json(self) -> None:
        initial_dir = str(self.image_path.parent) if self.image_path else str(Path.cwd())
        file_path = filedialog.asksaveasfilename(
            title="保存标定参数", initialdir=initial_dir,
            defaultextension=".json", filetypes=[("JSON", "*.json")])
        if not file_path:
            return
        self._sync_camera()
        data = {
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
        Path(file_path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        self._set_status(f"标定参数已保存到：{file_path}")

    # ------------------------------------------------------------------
    # Canvas / preview plumbing
    # ------------------------------------------------------------------

    def _push_images_to_canvas(self, fit_view: bool = False) -> None:
        self.canvas.set_images(self.source_image, self.depth_image, self.mask_image,
                               fit_view=fit_view)

    def _on_mask_changed(self) -> None:
        self.mask_image = self.canvas.get_mask_image()
        self._set_status("已修改前景蒙版。")

    def _update_preview_mode(self) -> None:
        self.canvas.set_preview_mode(self.view_var.get())

    def _on_overlay_alpha_changed(self, *_args) -> None:
        self.canvas.set_overlay_alpha(int(self.overlay_alpha_var.get()))

    def _on_edge_overlay_toggle(self) -> None:
        self.canvas.set_show_edge_overlay(bool(self.show_edge_overlay_var.get()))

    def _on_edge_overlay_alpha_changed(self, *_args) -> None:
        self.canvas.set_edge_overlay_alpha(int(self.edge_overlay_alpha_var.get()))

    def _sync_brush_mode(self) -> None:
        brush_value = 255 if self.paint_value_var.get() == "add" else 0
        self.canvas.set_brush_value(brush_value)
        self.canvas.set_brush_size(int(self.brush_size_var.get()))

    def _on_brush_size_changed(self, *_args) -> None:
        self.canvas.set_brush_size(int(self.brush_size_var.get()))

    def _sync_tool_mode(self) -> None:
        self.canvas.set_tool_mode(self.tool_mode_var.get())

    def _sync_depth_tolerance(self) -> None:
        self.canvas.set_depth_tolerance(int(self.depth_tolerance_var.get()))

    def _on_depth_tolerance_changed(self, *_args) -> None:
        self._sync_depth_tolerance()

    def _sync_edge_barrier(self) -> None:
        self.canvas.set_edge_barrier_gap(int(self.edge_barrier_var.get()))

    def _on_edge_barrier_changed(self, *_args) -> None:
        self._sync_edge_barrier()

    def _sync_fill_radius(self) -> None:
        self.canvas.set_fill_radius(int(self.fill_radius_var.get()))

    def _on_fill_radius_changed(self, *_args) -> None:
        self._sync_fill_radius()

    def _set_status(self, text: str) -> None:
        self.status_var.set(text)

    def _on_undo_shortcut(self, _event=None) -> None:
        undone = self.canvas.undo()
        if undone:
            self._set_status("已回退上一步画笔操作。")
        else:
            self._set_status("没有可回退的画笔操作。")

    def _set_status_threadsafe(self, text: str) -> None:
        self.root.after(0, lambda: self._set_status(text))

    def _show_error(self, text: str) -> None:
        self._set_status("发生错误。")
        messagebox.showerror("错误", text)

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    SceneDepthEditorApp().run()


if __name__ == "__main__":
    main()
