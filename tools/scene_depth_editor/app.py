from __future__ import annotations

import hashlib
import json
import shutil
import sys
import threading
import time
from pathlib import Path

import numpy as np

_QT_UI = sys.platform == "darwin"

if _QT_UI:
    from . import qt_compat as tk
    filedialog = tk.filedialog
    messagebox = tk.messagebox
    ttk = tk.ttk
    ImageTk = None
else:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from PIL import ImageTk


def _make_scrollable(parent, width: int) -> tuple[ttk.Frame, tk.Canvas]:
    """Create a scrollable frame. Returns (interior_frame, canvas)."""
    if _QT_UI:
        from PySide6.QtWidgets import QScrollArea
        from PySide6.QtCore import Qt as _Qt
        area = QScrollArea(parent)
        area.setWidgetResizable(True)
        area.setMinimumWidth(width)
        # 只竖向滚动：禁掉横向滚动条，内容被压到面板宽度内，杜绝数值被裁/横向溢出
        area.setHorizontalScrollBarPolicy(_Qt.ScrollBarAlwaysOff)
        interior = ttk.Frame()
        area.setWidget(interior)
        parent._layout.addWidget(area, 0, 0)
        return interior, area

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
    if _QT_UI:
        return
    widget.bind("<MouseWheel>", lambda e: canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"))
    for c in widget.winfo_children():
        _bind_wheel_recursive(c, canvas)


from PIL import Image, ImageChops

from .calibration import OrthoCamera, reconstruct_points
from .depth_estimator import MODEL_OPTIONS, DepthEstimator
from .reconstruction import (
    DepthMapping, OrthoProjection, WorldHeightMap, apply_depth_mapping,
    inverse_depth_mapping, build_M, encode_depth_rg16, fit_ground_surface,
    generate_screen_collision_overlay, render_billboard_occlusion_2d,
)
from .lighting_debug import (
    FinalGatherResult,
    FinalGatherSettings,
    MISS_BLACK,
    MISS_BORDER_ENVIRONMENT,
    MISS_HIT_NORMALIZED,
    QuadSettings,
    build_quad_samples,
    compute_final_gather,
)
from .hdr_reconstruction import (
    HDRResult,
    HDRSettings,
    PREVIEW_EV_HEATMAP,
    PREVIEW_GAIN_EV,
    PREVIEW_TONE_MAPPED,
    TONE_MAPPER_ACES,
    TONE_MAPPER_LINEAR,
    TONE_MAPPER_REINHARD,
    display_relative_rgba,
    load_gain_ev,
    prepare_linear_source,
    radiance_statistics,
    reconstruct_hdr_from_linear,
    render_hdr_preview,
)
from .workspace_cache import (
    DEPTH_CACHE_KIND,
    HDR_CACHE_KIND,
    array_sha256,
    build_cache_metadata,
    depth_signature,
    hdr_signature,
    load_json,
    save_json_atomic,
    save_npy_atomic,
    validate_cache_metadata,
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
        ".\\.tools\\Python311\\python.exe -m pip install PyOpenGL pyopengltk"
    ) from exc


def _make_photo_image(img: Image.Image):
    if _QT_UI:
        return tk.PhotoImage(img)
    return ImageTk.PhotoImage(img)


def _repo_root() -> Path:
    """GameDraft 仓库根目录（tools 的上一级）。"""
    return Path(__file__).resolve().parent.parent.parent


def _project_paths() -> "ProjectPaths":
    from tools.editor.shared.project_paths import ProjectPaths
    return ProjectPaths(_repo_root())


def _workspace_scenes_dir() -> Path:
    """编辑器工程场景根目录（打开/新建场景对话框默认从此处浏览）。

    迁移后位于 ``resources/editor_projects/editor_data/scene``，由
    :class:`ProjectPaths` 统一暴露。
    """
    from tools.editor.shared.project_paths import (
        DIR_KIND_EDITOR_SCENE_WORKSPACE,
    )
    return _project_paths().default_dir(DIR_KIND_EDITOR_SCENE_WORKSPACE)


def _assert_path_within(path: Path, base: Path) -> Path:
    """安全闸：确保 path 落在 base 目录内，否则抛错。

    本工具的文件增删/写入只允许发生在该场景自己的 workspace 目录内；一旦目标
    越出 base，直接抛错而非擅自处理，杜绝误删/误改其它目录的文件。
    """
    rp = path.resolve()
    rb = base.resolve()
    try:
        rp.relative_to(rb)
    except ValueError:
        raise RuntimeError(f"拒绝操作 workspace 之外的文件：{rp}（限定目录 {rb}）")
    return rp


class SceneDepthEditorApp:
    """Scene depth reconstruction tool.

    Left panel: controls (image, depth, camera, mapping).
    Right panel: OpenGL 3-D mesh viewer with axes and floor grid.
    """

    def __init__(self, project_root: Path | None = None) -> None:
        from tools.editor.shared.project_paths import ProjectPaths
        self._project_root = (project_root or _repo_root()).resolve()
        self._paths = ProjectPaths(self._project_root)

        self.root = tk.Tk()
        self.root.title("场景深度重建工具")
        self.root.geometry("1400x860")
        self.root.minsize(1060, 640)

        self.depth_estimator = DepthEstimator()

        self._scene_path: Path | None = None
        # 绑定的游戏场景 id（来自项目场景选择器）；workspace 按此 id 键入，
        # 保存写 workspace、导出回写 runtime/scenes/<id> + assets/scenes/<id>.json。
        self._bound_scene_id: str | None = None
        self.source_image: Image.Image | None = None
        self.depth_image: Image.Image | None = None
        self.raw_depth_array: np.ndarray | None = None
        self.calibrated_depth: np.ndarray | None = None

        self.camera = OrthoCamera()
        self._camera_center_from_calibration = False
        self.depth_mapping = DepthMapping()

        # 游戏资源导出目录（写入当前场景 editor.json 的 game_export_path）
        self._game_export_path: str | None = None

        # -- tk variables --
        self.status_var = tk.StringVar(value="新建或打开场景开始工作。")
        self.preview_mode_var = tk.StringVar(value="source")
        self.depth_model_var = tk.StringVar(
            value=next(iter(f"{key} - {value}" for key, value in MODEL_OPTIONS.items())),
        )

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

        # Entity final-gather debugger.  This is editor-only state persisted in
        # editor.json; game data/export is intentionally unaffected.
        self.lighting_quad_enabled_var = tk.BooleanVar(value=True)
        self.lighting_show_shaded_var = tk.BooleanVar(value=False)
        self.lighting_show_rays_var = tk.BooleanVar(value=True)
        self.lighting_show_hit_var = tk.BooleanVar(value=True)
        self.lighting_show_exit_var = tk.BooleanVar(value=True)
        self.lighting_show_range_var = tk.BooleanVar(value=True)
        self.lighting_xray_var = tk.BooleanVar(value=True)
        self.lighting_direction_filter_var = tk.StringVar(value="全部方向")
        self.lighting_miss_mode_var = tk.StringVar(value="未命中为黑")
        self.lighting_spp_var = tk.StringVar(value="64")
        self.lighting_calc_height_var = tk.StringVar(value="64")
        self.lighting_ray_limit_var = tk.StringVar(value="1200")
        self.lighting_x_var = tk.DoubleVar(value=0.0)
        self.lighting_y_var = tk.DoubleVar(value=0.0)
        self.lighting_z_var = tk.DoubleVar(value=0.0)
        self.lighting_width_var = tk.DoubleVar(value=0.25)
        self.lighting_height_var = tk.DoubleVar(value=0.55)
        self.lighting_bulge_var = tk.DoubleVar(value=0.0)
        self.lighting_normal_x_var = tk.DoubleVar(value=0.0)
        self.lighting_normal_y_var = tk.DoubleVar(value=0.0)
        self.lighting_normal_z_var = tk.DoubleVar(value=-1.0)
        self.lighting_uniform_scale_var = tk.DoubleVar(value=1.0)
        self.lighting_move_step_var = tk.DoubleVar(value=0.05)
        self.lighting_step_pixels_var = tk.DoubleVar(value=1.5)
        self.lighting_max_distance_var = tk.DoubleVar(value=0.0)
        self.lighting_front_epsilon_var = tk.DoubleVar(value=0.75)
        self.lighting_back_thickness_var = tk.DoubleVar(value=4.0)
        self.lighting_scene_ev_var = tk.DoubleVar(value=0.0)
        self.hdr_gain_scale_var = tk.DoubleVar(value=1.0)
        self.hdr_max_gain_ev_var = tk.DoubleVar(value=3.32)
        self.hdr_display_ev_var = tk.DoubleVar(value=0.0)
        self.hdr_tone_mapper_var = tk.StringVar(value="ACES")
        self.hdr_preview_mode_var = tk.StringVar(value="HDR 映射")
        self.hdr_mesh_preview_var = tk.BooleanVar(value=False)
        self._hdr_gain_ev: np.ndarray | None = None
        self._hdr_result: HDRResult | None = None
        self._hdr_linear_source: np.ndarray | None = None
        self._hdr_source_prepare_ms = 0.0
        self._hdr_gain_source_digest: str | None = None
        self._hdr_expected_gain_source_digest: str | None = None
        self._hdr_gain_enabled = True
        self._hdr_gain_stale = False
        self._hdr_cache_state = "missing"
        self._hdr_cache_reason = "尚未生成 HDR 辐射度缓存"
        self._hdr_cache_metadata: dict | None = None
        self._hdr_cached_radiance: np.ndarray | None = None
        self._hdr_refresh_pending = False
        self._hdr_window: tk.Toplevel | None = None
        self._hdr_photo = None
        self._hdr_label: tk.Label | None = None
        self._lighting_entries: dict[str, object] = {}
        self._lighting_sprite = _make_default_billboard_image()
        try:
            self._lighting_sprite = self._load_project_player_frame()
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            # Standalone distributions may not contain the project's player atlas.
            # The built-in silhouette keeps the debugger usable in that case.
            pass
        self._lighting_result: FinalGatherResult | None = None
        self._lighting_generation = 0
        self._lighting_position_initialized = False
        self._lighting_size_initialized = False
        self._lighting_size_auto = True
        self._depth_cache_state = "missing"
        self._depth_cache_reason = "尚未生成深度缓存"
        self._depth_cache_metadata: dict | None = None
        self._depth_generated_model_id: str | None = None

        self.occlusion_step_var = tk.IntVar(value=10)
        self.occlusion_scale_var = tk.DoubleVar(value=1.0)
        self.occlusion_tolerance_var = tk.DoubleVar(value=0.0)
        self.occlusion_floor_offset_var = tk.DoubleVar(value=0.0)
        self.stretch_factor_var = tk.DoubleVar(value=3.0)
        self.collision_height_var = tk.DoubleVar(value=0.05)
        self.collision_alpha_var = tk.DoubleVar(value=0.3)
        self.ground_height_threshold_var = tk.DoubleVar(value=0.1)
        self._occlusion_uv: list[float] = [0.0, 0.0]
        self._occlusion_sprite: Image.Image | None = None
        self._occlusion_window: tk.Toplevel | None = None
        self._occlusion_photo: ImageTk.PhotoImage | None = None
        self._occlusion_label: tk.Label | None = None
        self._occlusion_display_ratio: float = 1.0
        self._world_height_map: WorldHeightMap | None = None
        self._ground_refresh_pending = False
        # 地面拟合预览（仅测试/可视化，独立窗口，不碰碰撞/导出/运行时）
        self._ground_window = None
        self._ground_label = None
        self._ground_photo = None
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
        left, left_canvas = _make_scrollable(left_outer, width=440)
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
        self.gl_viewer.set_key_action_callback(self._on_lighting_viewport_key)

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
        row = self._build_hdr_section(left, row)
        row = self._build_lighting_debug_section(left, row)
        row = self._build_occlusion_section(left, row)
        row = self._build_collision_edit_section(left, row)
        row = self._build_ground_fit_section(left, row)
        row = self._build_depth_edit_section(left, row)
        row = self._build_export_section(left, row)

        _bind_wheel_recursive(left, left_canvas)

    # ---- Scene section ----

    def _build_scene_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="场景", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        # 项目场景选择器：自动列出 public/assets/scenes/*.json（场景在主编辑器创建）。
        pick_row = ttk.Frame(box); pick_row.grid(row=0, column=0, sticky="ew")
        pick_row.columnconfigure(0, weight=1)
        self.scene_pick_var = tk.StringVar()
        self._scene_picker_combo = ttk.Combobox(
            pick_row, state="readonly", textvariable=self.scene_pick_var)
        self._scene_picker_combo.grid(row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(pick_row, text="刷新", width=5,
                   command=self._refresh_scene_picker).grid(row=0, column=1)

        r1 = ttk.Frame(box); r1.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        r1.columnconfigure(0, weight=1); r1.columnconfigure(1, weight=1)
        ttk.Button(r1, text="打开选中场景", command=self._open_selected_scene).grid(
            row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(r1, text="打开文件夹(遗留)", command=self._open_scene).grid(
            row=0, column=1, sticky="ew", padx=(2, 0))

        r2 = ttk.Frame(box); r2.grid(row=2, column=0, sticky="ew", pady=(4, 0))
        r2.columnconfigure(0, weight=1); r2.columnconfigure(1, weight=1)
        ttk.Button(r2, text="保存场景", command=self._save_scene).grid(
            row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(r2, text="导出游戏数据", command=self._export_for_game).grid(
            row=0, column=1, sticky="ew", padx=(2, 0))

        self._scene_label = ttk.Label(box, text="未打开场景", foreground="#888",
                                      wraplength=260, justify="left")
        self._scene_label.grid(row=3, column=0, sticky="ew", pady=(6, 0))

        ttk.Separator(box, orient="horizontal").grid(row=4, column=0, sticky="ew", pady=6)

        ttk.Button(box, text="导入背景图", command=self._import_background).grid(
            row=5, column=0, sticky="ew")

        self.image_label = ttk.Label(box, text="无背景图", foreground="#888",
                                     wraplength=260, justify="left")
        self.image_label.grid(row=6, column=0, sticky="ew", pady=(4, 0))

        self.thumb_label = ttk.Label(box)
        self.thumb_label.grid(row=7, column=0, pady=(4, 0))

        mode_frame = ttk.Frame(box)
        mode_frame.grid(row=8, column=0, sticky="w", pady=(4, 0))
        ttk.Radiobutton(mode_frame, text="原图", variable=self.preview_mode_var,
                        value="source", command=self._update_thumb).pack(side="left")
        ttk.Radiobutton(mode_frame, text="深度", variable=self.preview_mode_var,
                        value="depth", command=self._update_thumb).pack(side="left", padx=8)

        self._refresh_scene_picker()
        return row + 1

    # ---- 项目场景选择器（按 id 绑定 workspace）----

    def _list_project_scene_ids(self) -> list[str]:
        out: list[str] = []
        try:
            sdir = self._paths.scenes_dir
        except (AttributeError, OSError):
            return out
        if not sdir.is_dir():
            return out
        for p in sorted(sdir.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                sid = str(data.get("id") or p.stem)
            except (json.JSONDecodeError, OSError):
                sid = p.stem
            out.append(sid)
        return out

    def _refresh_scene_picker(self) -> None:
        ids = self._list_project_scene_ids()
        try:
            self._scene_picker_combo.configure(values=ids)
        except Exception:
            return
        if self._bound_scene_id and self._bound_scene_id in ids:
            self.scene_pick_var.set(self._bound_scene_id)
        elif ids and not (self.scene_pick_var.get() or "").strip():
            self.scene_pick_var.set(ids[0])

    def _open_selected_scene(self) -> None:
        sid = (self.scene_pick_var.get() or "").strip()
        if not sid:
            messagebox.showinfo("提示", "请先在下拉框选择一个场景。")
            return
        self._open_scene_by_id(sid)

    def open_scene_by_id_safe(self, scene_id: str) -> None:
        """启动期自动打开场景（失败仅记状态，不抛）。"""
        try:
            self._open_scene_by_id(scene_id)
        except Exception as exc:  # noqa: BLE001
            self._set_status(f"自动打开场景失败: {scene_id} ({exc})")

    def _open_scene_by_id(self, scene_id: str) -> None:
        scene_id = (scene_id or "").strip()
        if not scene_id:
            return
        ws = self._workspace_scenes_root() / scene_id
        ws.mkdir(parents=True, exist_ok=True)
        # 兼容旧版"选目录+输名字"产生的嵌套 workspace（<id>/<id>/）：新版平铺目录
        # 尚无内容而旧嵌套有时，一次性采纳其文件，避免已做好的深度工作被孤立。
        self._adopt_legacy_nested_workspace(ws, scene_id)
        self._scene_path = ws
        self._bound_scene_id = scene_id
        self._reset_state()
        self._scene_label.configure(text=f"场景: {scene_id}")
        self.root.title(f"场景深度重建工具 - {scene_id}")

        # 导出目标固定为该场景的 runtime 媒体目录。
        try:
            self._game_export_path = self._normalize_path_for_config(
                self._paths.scene_runtime_dir(scene_id))
        except (ValueError, OSError):
            self._game_export_path = None

        # workspace 已有的标定 / 编辑器状态。
        scene_json = ws / self._SCENE_JSON
        if scene_json.exists():
            try:
                data = json.loads(scene_json.read_text(encoding="utf-8"))
                self._apply_calibration_data(data.get("calibration", {}))
            except (json.JSONDecodeError, OSError):
                pass
        editor_json = ws / self._EDITOR_JSON
        if editor_json.exists():
            try:
                self._apply_editor_data(
                    json.loads(editor_json.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                pass

        # 背景图单一真源：游戏侧 runtime/scenes/<id>/background.png 为准，workspace
        # 只是深度计算的派生工作副本。打开时总是从游戏侧同步；像素发生变化则把旧
        # depth_cache 置为失效（重命名为 .stale 并不加载），强制重算，杜绝"用旧图旧
        # 深度覆盖主编辑器换过的新背景"。
        # 写入目标固定在本场景 workspace 内（越界即抛错）；从游戏侧只读取背景，不改它。
        bg = _assert_path_within(ws / self._BG_FILENAME, ws)
        try:
            game_bg = self._paths.scene_runtime_dir(scene_id) / "background.png"
        except (ValueError, OSError):
            game_bg = None

        depth_invalidated = False
        if game_bg is not None and game_bg.exists():
            if not bg.exists() or not self._same_image_pixels(game_bg, bg):
                # 失败不静默吞掉——直接抛错，避免带着旧图旧深度继续。
                shutil.copyfile(game_bg, bg)
                cache = ws / self._DEPTH_CACHE
                if cache.exists():
                    cache.replace(_assert_path_within(
                        ws / (self._DEPTH_CACHE + ".stale"), ws))
                    depth_invalidated = True
                meta = ws / self._DEPTH_CACHE_META
                if meta.exists():
                    meta.replace(_assert_path_within(
                        ws / (self._DEPTH_CACHE_META + ".stale"), ws))
        if bg.exists():
            self._load_background(bg)

        depth = ws / self._DEPTH_CACHE
        has_depth = False
        if not depth_invalidated and depth.exists() and self.source_image is not None:
            has_depth = self._load_depth_cache(depth)
            if not has_depth:
                depth.replace(_assert_path_within(
                    ws / (self._DEPTH_CACHE + ".stale"), ws))
                depth_invalidated = True
        elif depth_invalidated:
            self._set_depth_cache_state("stale", "背景图像素已变化")
        else:
            self._set_depth_cache_state("missing", "editor 工程中没有 depth_cache.npy")

        # 无深度时绝不加载碰撞叠层——否则视口只剩一片红色假网格，看起来像整工具坏了
        if has_depth:
            self._load_collision(silent=True)
        else:
            self._world_height_map = None
            self._screen_collision = None
            self._collision_locked = False
            self.gl_viewer.set_collision_data(None)

        self._refresh_scene_picker()
        if depth_invalidated:
            self._set_status(
                f"场景已绑定: {scene_id}（背景已更新，深度已作废。请点「计算深度图」后才能重建/编辑）")
        elif has_depth:
            self._set_status(f"场景已绑定: {scene_id}")
        elif bg.exists():
            self._set_status(
                f"场景已绑定: {scene_id}（尚无深度缓存，请先「计算深度图」）")
        else:
            self._set_status(
                f"场景已绑定: {scene_id}（游戏侧无背景图，请先在主编辑器导入背景图）")
        suffix = self._cache_update_suffix()
        if suffix:
            self._set_status(f"{self.status_var.get()} {suffix}")

    @staticmethod
    def _same_image_pixels(a: Path, b: Path) -> bool:
        """两张图像素是否完全一致（忽略 PNG 编码差异，避免重编码造成的假失效）。"""
        try:
            ia = Image.open(a).convert("RGB")
            ib = Image.open(b).convert("RGB")
        except (OSError, ValueError):
            return False
        if ia.size != ib.size:
            return False
        return ImageChops.difference(ia, ib).getbbox() is None

    def _adopt_legacy_nested_workspace(self, ws: Path, scene_id: str) -> None:
        legacy = ws / scene_id
        if (ws / self._SCENE_JSON).exists():
            return
        if not (legacy / self._SCENE_JSON).exists():
            return
        for fn in (
            self._SCENE_JSON, self._EDITOR_JSON,
            self._DEPTH_CACHE, self._DEPTH_CACHE_META,
            self._HDR_GAIN_CACHE, self._HDR_CACHE, self._HDR_CACHE_META,
            self._BG_FILENAME, "collision.png", "collision_grid.npy",
            "collision_meta.json",
        ):
            src = legacy / fn
            if src.exists():
                # 仅在本场景 workspace 内拷贝（源是其下旧嵌套子目录、目标是平铺目录）；
                # 越界即抛错，拷贝失败也直接抛错，不静默吞掉。
                _assert_path_within(src, ws)
                shutil.copyfile(src, _assert_path_within(ws / fn, ws))

    # ---- Depth estimation section ----

    def _build_depth_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="深度估计", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Label(box, text="模型").grid(row=0, column=0, sticky="w")
        self.depth_model_combo = ttk.Combobox(
            box, state="readonly",
            values=[f"{k} - {v}" for k, v in MODEL_OPTIONS.items()],
            textvariable=self.depth_model_var, width=32)
        self.depth_model_combo.grid(row=1, column=0, sticky="ew", pady=(2, 4))

        ttk.Button(box, text="计算深度图", command=self.generate_depth).grid(
            row=2, column=0, sticky="ew")

        self._depth_cache_label = ttk.Label(
            box,
            text="深度缓存：尚未生成",
            foreground="#d49a34",
            wraplength=390,
        )
        if _QT_UI:
            self._depth_cache_label.setMinimumHeight(54)
        self._depth_cache_label.grid(row=3, column=0, sticky="w", pady=(5, 0))

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
            variable=self.dm_scale_var, showvalue=False, highlightthickness=0,
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
            variable=self.dm_offset_var, showvalue=False, highlightthickness=0,
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

    # ---- HDR radiance reconstruction ----

    _HDR_TONE_LABELS = {
        "ACES": TONE_MAPPER_ACES,
        "Reinhard": TONE_MAPPER_REINHARD,
        "线性截断": TONE_MAPPER_LINEAR,
    }
    _HDR_PREVIEW_LABELS = {
        "HDR 映射": PREVIEW_TONE_MAPPED,
        "EV 热力图": PREVIEW_EV_HEATMAP,
        "gainEV 图": PREVIEW_GAIN_EV,
    }

    def _build_hdr_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="HDR 场景辐射度", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        top = ttk.Frame(box)
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(0, weight=1)
        top.columnconfigure(1, weight=1)
        ttk.Button(
            top, text="打开实时 HDR 预览", command=self._open_hdr_preview,
        ).grid(row=0, column=0, sticky="ew", padx=(0, 3))
        ttk.Checkbutton(
            top, text="HDR 贴到 Mesh", variable=self.hdr_mesh_preview_var,
            command=self._on_hdr_display_changed,
        ).grid(row=0, column=1, sticky="w")

        mode_row = ttk.Frame(box)
        mode_row.grid(row=1, column=0, sticky="ew", pady=(5, 0))
        mode_row.columnconfigure(1, weight=1)
        mode_row.columnconfigure(3, weight=1)
        ttk.Label(mode_row, text="查看").grid(row=0, column=0, sticky="e")
        ttk.Combobox(
            mode_row, state="readonly", values=tuple(self._HDR_PREVIEW_LABELS),
            textvariable=self.hdr_preview_mode_var, width=9,
        ).grid(row=0, column=1, sticky="ew", padx=(4, 8))
        ttk.Label(mode_row, text="映射").grid(row=0, column=2, sticky="e")
        ttk.Combobox(
            mode_row, state="readonly", values=tuple(self._HDR_TONE_LABELS),
            textvariable=self.hdr_tone_mapper_var, width=9,
        ).grid(row=0, column=3, sticky="ew", padx=(4, 0))

        self._slider(box, "场景曝光 sceneExposureEV", self.lighting_scene_ev_var,
                     2, -8.0, 8.0, 0.1)
        self._slider(box, "gainEV 强度", self.hdr_gain_scale_var,
                     4, 0.0, 2.0, 0.05)
        self._slider(box, "局部增益上限 EV", self.hdr_max_gain_ev_var,
                     6, 0.0, 8.0, 0.05)
        self._slider(box, "显示曝光（只影响预览）", self.hdr_display_ev_var,
                     8, -8.0, 8.0, 0.1)

        gain_buttons = ttk.Frame(box)
        gain_buttons.grid(row=10, column=0, sticky="ew", pady=(4, 0))
        gain_buttons.columnconfigure(0, weight=1)
        gain_buttons.columnconfigure(1, weight=1)
        ttk.Button(
            gain_buttons, text="加载 gainEV", command=self._load_hdr_gain_dialog,
        ).grid(row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(
            gain_buttons, text="清除 gainEV", command=self._clear_hdr_gain,
        ).grid(row=0, column=1, sticky="ew", padx=(2, 0))

        ttk.Button(
            box,
            text="更新 HDR 辐射度缓存到 Editor 工程",
            command=self._update_hdr_cache,
        ).grid(row=11, column=0, sticky="ew", pady=(5, 0))

        self._hdr_cache_label = ttk.Label(
            box,
            text="HDR 缓存：尚未生成",
            foreground="#d49a34",
            wraplength=390,
        )
        if _QT_UI:
            self._hdr_cache_label.setMinimumHeight(54)
        self._hdr_cache_label.grid(row=12, column=0, sticky="w", pady=(5, 0))

        self._hdr_gain_label = ttk.Label(
            box, text="gainEV：未加载，当前严格使用零增益", foreground="#888",
            wraplength=390,
        )
        if _QT_UI:
            self._hdr_gain_label.setMinimumHeight(52)
        self._hdr_gain_label.grid(row=13, column=0, sticky="w", pady=(5, 0))
        self._hdr_stats_label = ttk.Label(
            box, text="加载场景后显示 float32 HDR 统计", foreground="#888",
            wraplength=390,
        )
        if _QT_UI:
            self._hdr_stats_label.setMinimumHeight(86)
        self._hdr_stats_label.grid(row=14, column=0, sticky="w", pady=(3, 2))
        return row + 1

    # ---- Entity-lighting debugger ----

    _LIGHTING_MISS_LABELS = {
        "未命中为黑": MISS_BLACK,
        "仅有效命中归一": MISS_HIT_NORMALIZED,
        "边界环境补全": MISS_BORDER_ENVIRONMENT,
    }
    _LIGHTING_DIRECTION_LABELS = {
        "全部方向": "all",
        "只看朝相机": "camera",
        "只看朝背景": "background",
    }

    def _build_lighting_debug_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="角色 Quad｜位置、尺寸与主法线", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        def numeric_entry(frame, label: str, key: str, column: int) -> None:
            frame.columnconfigure(column * 2 + 1, weight=1)
            ttk.Label(frame, text=label).grid(
                row=0, column=column * 2, sticky="e", padx=(0, 4),
            )
            entry = ttk.Entry(frame, width=9)
            entry.grid(
                row=0, column=column * 2 + 1, sticky="ew",
                padx=(0, 10) if column == 0 else (0, 0),
            )
            entry.bind("<Return>", self._commit_lighting_fields)
            self._lighting_entries[key] = entry

        visibility = ttk.Frame(box)
        visibility.grid(row=0, column=0, sticky="ew")
        for column, (text, variable) in enumerate([
            ("角色 Quad", self.lighting_quad_enabled_var),
            ("着色结果", self.lighting_show_shaded_var),
            ("射线", self.lighting_show_rays_var),
        ]):
            ttk.Checkbutton(
                visibility, text=text, variable=variable,
                command=self._on_lighting_view_changed,
            ).grid(row=0, column=column, sticky="w", padx=(0, 5))

        sprite_buttons = ttk.Frame(box)
        sprite_buttons.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        sprite_buttons.columnconfigure(0, weight=1)
        sprite_buttons.columnconfigure(1, weight=1)
        ttk.Button(
            sprite_buttons, text="使用主角帧", command=self._use_player_lighting_sprite,
        ).grid(row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(
            sprite_buttons, text="加载角色贴图", command=self._load_lighting_sprite,
        ).grid(row=0, column=1, sticky="ew", padx=(2, 0))

        ttk.Label(box, text="位置（伪世界）", foreground="#aaa").grid(
            row=2, column=0, sticky="w", pady=(8, 2),
        )
        pos_xy = ttk.Frame(box)
        pos_xy.grid(row=3, column=0, sticky="ew")
        numeric_entry(pos_xy, "X", "x", 0)
        numeric_entry(pos_xy, "Y", "y", 1)
        pos_z_step = ttk.Frame(box)
        pos_z_step.grid(row=4, column=0, sticky="ew", pady=(4, 0))
        numeric_entry(pos_z_step, "Z", "z", 0)
        numeric_entry(pos_z_step, "移动步进", "move_step", 1)

        nudge_buttons = ttk.Frame(box)
        nudge_buttons.grid(row=5, column=0, sticky="ew", pady=(5, 0))
        for column in range(4):
            nudge_buttons.columnconfigure(column, weight=1)
        for column, (text, axis, direction) in enumerate((
            ("X −", "x", -1), ("X +", "x", 1),
            ("Y −", "y", -1), ("Y +", "y", 1),
        )):
            ttk.Button(
                nudge_buttons, text=text,
                command=lambda _checked=False, a=axis, d=direction: (
                    self._nudge_lighting_axis(a, d)
                ),
            ).grid(row=0, column=column, sticky="ew", padx=(0, 3) if column < 3 else 0)
        for column, (text, action) in enumerate((
            ("Z −", lambda: self._nudge_lighting_axis("z", -1)),
            ("Z +", lambda: self._nudge_lighting_axis("z", 1)),
            ("缩小", lambda: self._scale_lighting_uniform(1.0 / 1.1)),
            ("放大", lambda: self._scale_lighting_uniform(1.1)),
        )):
            ttk.Button(nudge_buttons, text=text, command=action).grid(
                row=1, column=column, sticky="ew", pady=(3, 0),
                padx=(0, 3) if column < 3 else 0,
            )

        ttk.Label(box, text="尺寸", foreground="#aaa").grid(
            row=6, column=0, sticky="w", pady=(8, 2),
        )
        size_wh = ttk.Frame(box)
        size_wh.grid(row=7, column=0, sticky="ew")
        numeric_entry(size_wh, "基础宽", "width", 0)
        numeric_entry(size_wh, "基础高", "height", 1)
        bulge_row = ttk.Frame(box)
        bulge_row.grid(row=8, column=0, sticky="ew", pady=(4, 0))
        numeric_entry(bulge_row, "鼓包 0~1", "bulge", 0)

        ttk.Label(box, text="统一缩放").grid(row=9, column=0, sticky="w", pady=(5, 0))
        tk.Scale(
            box, from_=0.1, to=5.0, orient="horizontal", resolution=0.05,
            variable=self.lighting_uniform_scale_var, showvalue=True,
            highlightthickness=0,
        ).grid(row=10, column=0, sticky="ew")
        self._lighting_size_label = ttk.Label(
            box, text="", foreground="#888", wraplength=390,
        )
        if _QT_UI:
            self._lighting_size_label.setMinimumHeight(62)
        self._lighting_size_label.grid(row=11, column=0, sticky="w", pady=(2, 0))

        place_buttons = ttk.Frame(box)
        place_buttons.grid(row=12, column=0, sticky="ew", pady=(5, 0))
        place_buttons.columnconfigure(0, weight=1)
        place_buttons.columnconfigure(1, weight=1)
        ttk.Button(
            place_buttons, text="放到 Mesh 中心", command=self._place_lighting_quad_at_mesh_center,
        ).grid(row=0, column=0, sticky="ew", padx=(0, 2))
        ttk.Button(
            place_buttons, text="按主角游戏尺寸", command=self._match_lighting_player_size,
        ).grid(row=0, column=1, sticky="ew", padx=(2, 0))
        ttk.Button(
            box, text="应用输入值", command=self._commit_lighting_fields,
        ).grid(row=13, column=0, sticky="ew", pady=(4, 0))
        shortcut_label = ttk.Label(
            box,
            text="视图聚焦时：W/S 调 Z，A/D 调 X，Q/E 调 Y，-/+ 缩放",
            foreground="#888", wraplength=390,
        )
        if _QT_UI:
            shortcut_label.setMinimumHeight(58)
        shortcut_label.grid(row=14, column=0, sticky="w", pady=(4, 0))

        ttk.Separator(box, orient="horizontal").grid(
            row=15, column=0, sticky="ew", pady=7,
        )

        ttk.Label(
            box,
            text="主法线（相机局部：X 向右、Y 向上、Z 向场景内）",
            foreground="#aaa",
            wraplength=390,
        ).grid(row=16, column=0, sticky="w", pady=(0, 3))
        normal_xy = ttk.Frame(box)
        normal_xy.grid(row=17, column=0, sticky="ew")
        numeric_entry(normal_xy, "NX", "normal_x", 0)
        numeric_entry(normal_xy, "NY", "normal_y", 1)
        normal_z_buttons = ttk.Frame(box)
        normal_z_buttons.grid(row=18, column=0, sticky="ew", pady=(4, 0))
        normal_z_buttons.columnconfigure(1, weight=1)
        normal_z_buttons.columnconfigure(2, weight=1)
        ttk.Label(normal_z_buttons, text="NZ").grid(row=0, column=0, sticky="e", padx=(0, 4))
        normal_z_entry = ttk.Entry(normal_z_buttons, width=9)
        normal_z_entry.grid(row=0, column=1, sticky="ew", padx=(0, 4))
        normal_z_entry.bind("<Return>", self._commit_lighting_fields)
        self._lighting_entries["normal_z"] = normal_z_entry
        ttk.Button(
            normal_z_buttons, text="恢复朝向相机", command=self._reset_lighting_main_normal,
        ).grid(row=0, column=2, sticky="ew")
        self._lighting_normal_label = ttk.Label(
            box,
            text="",
            foreground="#888",
            wraplength=390,
        )
        if _QT_UI:
            self._lighting_normal_label.setMinimumHeight(58)
        self._lighting_normal_label.grid(row=19, column=0, sticky="w", pady=(3, 2))

        # Sampling and ray filters are separate groups.  Keeping them out of the
        # transform group prevents the dense controls from collapsing into one
        # unreadable panel on the minimum supported window size.
        box = ttk.LabelFrame(parent, text="实体光照采样", padding=6)
        box.grid(row=row + 1, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        sampling = ttk.Frame(box)
        sampling.grid(row=0, column=0, sticky="ew")
        sampling.columnconfigure(1, weight=1)
        sampling.columnconfigure(3, weight=1)
        ttk.Label(sampling, text="SPP").grid(row=0, column=0, sticky="e")
        ttk.Combobox(
            sampling, state="readonly", values=("16", "32", "64", "128", "256", "512"),
            textvariable=self.lighting_spp_var, width=6,
        ).grid(row=0, column=1, sticky="w", padx=(2, 8))
        ttk.Label(sampling, text="计算高度").grid(row=0, column=2, sticky="e")
        ttk.Combobox(
            sampling, state="readonly", values=("32", "48", "64", "96", "128"),
            textvariable=self.lighting_calc_height_var, width=6,
        ).grid(row=0, column=3, sticky="w", padx=(2, 0))

        miss_row = ttk.Frame(box)
        miss_row.grid(row=1, column=0, sticky="ew", pady=(5, 0))
        ttk.Label(miss_row, text="Miss").grid(row=0, column=0, sticky="e")
        ttk.Combobox(
            miss_row, state="readonly", values=tuple(self._LIGHTING_MISS_LABELS),
            textvariable=self.lighting_miss_mode_var,
        ).grid(row=0, column=1, sticky="ew", padx=(4, 0))
        miss_row.columnconfigure(1, weight=1)

        march = ttk.Frame(box)
        march.grid(row=2, column=0, sticky="ew", pady=(5, 0))
        numeric_entry(march, "步长 px", "step", 0)
        numeric_entry(march, "最大距离", "max_distance", 1)

        shell = ttk.Frame(box)
        shell.grid(row=3, column=0, sticky="ew", pady=(5, 0))
        numeric_entry(shell, "前容差 px", "front", 0)
        numeric_entry(shell, "后厚度 px", "back", 1)
        ttk.Button(
            box, text="一键计算光照", command=self._calculate_entity_lighting,
        ).grid(row=4, column=0, sticky="ew", pady=(7, 0))

        box = ttk.LabelFrame(parent, text="射线显示与计算结果", padding=6)
        box.grid(row=row + 2, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)
        filters = ttk.Frame(box)
        filters.grid(row=0, column=0, sticky="ew")
        for column, (text, variable) in enumerate([
            ("命中", self.lighting_show_hit_var),
            ("出屏", self.lighting_show_exit_var),
            ("最大距离", self.lighting_show_range_var),
            ("透视", self.lighting_xray_var),
        ]):
            ttk.Checkbutton(
                filters, text=text, variable=variable,
                command=self._on_lighting_ray_filter_changed,
            ).grid(row=0, column=column, sticky="w", padx=(0, 4))

        filter_row = ttk.Frame(box)
        filter_row.grid(row=1, column=0, sticky="ew", pady=(5, 0))
        filter_row.columnconfigure(1, weight=1)
        ttk.Label(filter_row, text="方向").grid(row=0, column=0, sticky="e")
        direction_combo = ttk.Combobox(
            filter_row, state="readonly", values=tuple(self._LIGHTING_DIRECTION_LABELS),
            textvariable=self.lighting_direction_filter_var,
        )
        direction_combo.grid(row=0, column=1, sticky="ew", padx=(4, 8))
        ttk.Label(filter_row, text="上限").grid(row=0, column=2, sticky="e")
        limit_combo = ttk.Combobox(
            filter_row, state="readonly", values=("200", "500", "1200", "3000"),
            textvariable=self.lighting_ray_limit_var, width=6,
        )
        limit_combo.grid(row=0, column=3, sticky="w", padx=(4, 0))

        ray_legend = ttk.Label(
            box,
            text="绿=命中｜橙=出屏｜紫=最大距离；青框=原始 Quad",
            foreground="#888",
            wraplength=390,
        )
        if _QT_UI:
            ray_legend.setMinimumHeight(54)
        ray_legend.grid(row=2, column=0, sticky="w", pady=(6, 0))
        self._lighting_metrics_label = ttk.Label(
            box, text="尚未计算", foreground="#888", wraplength=390,
        )
        if _QT_UI:
            self._lighting_metrics_label.setMinimumHeight(58)
        self._lighting_metrics_label.grid(row=3, column=0, sticky="w", pady=(3, 2))
        self._sync_lighting_entries()
        self._update_hdr_gain_label()
        self._update_depth_cache_label()
        self._update_hdr_cache_label()
        return row + 3

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

    # ---- Ground-fit (auto collision) section ----

    def _build_ground_fit_section(self, parent, row: int) -> int:
        box = ttk.LabelFrame(parent, text="地面拟合预览（仅测试）", padding=6)
        box.grid(row=row, column=0, sticky="ew", pady=(0, 8))
        box.columnconfigure(0, weight=1)

        ttk.Button(box, text="拟合非平面地面并预览",
                   command=self._open_ground_fit_preview).grid(
            row=0, column=0, sticky="ew")
        ttk.Button(box, text="多边形地面标定（试验）",
                   command=self._open_ground_calib).grid(
            row=1, column=0, sticky="ew", pady=(4, 0))
        self._slider(box, "离地高度上限(着色)", self.ground_height_threshold_var,
                     2, 0.01, 2.0, 0.01)

        self._ground_fit_label = ttk.Label(
            box, text="仅测试/可视化，不改碰撞/导出/运行时。\n"
                      "「预览」=离地高度着色；「多边形标定」=框地面→补全完整地面深度。",
            foreground="#888", wraplength=300, justify="left")
        self._ground_fit_label.grid(row=4, column=0, sticky="w", pady=(4, 0))

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
            box, text="选中工具后左键直接涂抹", foreground="#888")
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
        self.depth_model_var.trace_add(
            "write", lambda *_: self._on_depth_model_changed(),
        )
        for v in (self.cam_elevation_var, self.cam_azimuth_var, self.cam_ppu_var,
                  self.dm_invert_var, self.dm_scale_var, self.dm_offset_var,
                  self.subsample_var):
            v.trace_add("write", lambda *_: self._on_depth_configuration_changed())

        self.billboard_scale_var.trace_add("write", lambda *_: self._schedule_refresh())

        self.billboard_scale_var.trace_add("write", lambda *_: self._on_billboard_scale_changed())
        self.stretch_factor_var.trace_add("write", lambda *_: self._on_stretch_factor_changed())
        self.collision_height_var.trace_add("write", lambda *_: self._on_collision_height_changed())
        self.ground_height_threshold_var.trace_add("write", lambda *_: self._on_ground_threshold_changed())
        self.brush_radius_var.trace_add("write", lambda *_: self.gl_viewer.set_brush_radius(
            self.brush_radius_var.get()))
        for v in (self.lighting_spp_var, self.lighting_calc_height_var,
                  self.lighting_miss_mode_var):
            v.trace_add("write", lambda *_: self._invalidate_lighting_result())
        for v in (self.lighting_direction_filter_var, self.lighting_ray_limit_var):
            v.trace_add("write", lambda *_: self._on_lighting_ray_filter_changed())
        self.lighting_uniform_scale_var.trace_add(
            "write", lambda *_: self._on_lighting_uniform_scale_changed(),
        )
        for variable in (
            self.lighting_scene_ev_var,
            self.hdr_gain_scale_var,
            self.hdr_max_gain_ev_var,
        ):
            variable.trace_add("write", lambda *_: self._invalidate_hdr_radiance())
        for variable in (
            self.hdr_display_ev_var,
            self.hdr_tone_mapper_var,
            self.hdr_preview_mode_var,
        ):
            variable.trace_add("write", lambda *_: self._on_hdr_display_changed())
        self._refresh_pending = False

    def _on_depth_configuration_changed(self) -> None:
        self._invalidate_lighting_result()
        self._schedule_refresh()

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
    _DEPTH_CACHE_META = "depth_cache_meta.json"
    _HDR_GAIN_CACHE = "radiance_gain_ev.npy"
    _HDR_CACHE = "radiance_cache.npy"
    _HDR_CACHE_META = "radiance_cache_meta.json"
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
        self._camera_center_from_calibration = False
        self.gl_viewer.clear_mesh()
        self.gl_viewer.set_collision_data(None)
        self.gl_viewer.set_billboard_enabled(False)
        self.gl_viewer.clear_lighting_debug()
        self._lighting_result = None
        self._lighting_generation += 1
        self._lighting_position_initialized = False
        self._lighting_size_initialized = False
        self._lighting_size_auto = True
        self._hdr_gain_ev = None
        self._hdr_result = None
        self._hdr_linear_source = None
        self._hdr_source_prepare_ms = 0.0
        self._hdr_gain_source_digest = None
        self._hdr_expected_gain_source_digest = None
        self._hdr_gain_enabled = True
        self._hdr_gain_stale = False
        self._hdr_cached_radiance = None
        self._hdr_cache_metadata = None
        self._set_hdr_cache_state("missing", "editor 工程中没有 radiance_cache.npy")
        self._depth_cache_metadata = None
        self._depth_generated_model_id = None
        self._set_depth_cache_state("missing", "editor 工程中没有 depth_cache.npy")
        self.lighting_scene_ev_var.set(0.0)
        self.hdr_gain_scale_var.set(1.0)
        self.hdr_max_gain_ev_var.set(3.32)
        self.hdr_display_ev_var.set(0.0)
        self.hdr_tone_mapper_var.set("ACES")
        self.hdr_preview_mode_var.set("HDR 映射")
        self.hdr_mesh_preview_var.set(False)
        self.lighting_x_var.set(0.0)
        self.lighting_y_var.set(0.0)
        self.lighting_z_var.set(0.0)
        self.lighting_width_var.set(0.25)
        self.lighting_height_var.set(0.55)
        self.lighting_bulge_var.set(0.0)
        self.lighting_normal_x_var.set(0.0)
        self.lighting_normal_y_var.set(0.0)
        self.lighting_normal_z_var.set(-1.0)
        self.lighting_move_step_var.set(0.05)
        self.lighting_uniform_scale_var.set(1.0)
        self._sync_lighting_entries()
        self._update_hdr_gain_label()
        self.image_label.configure(text="无背景图")
        self._thumb_photo = None
        self.thumb_label.configure(image="")
        self.mesh_info_label.configure(text="")

    def _current_depth_model_id(self) -> str:
        label = self.depth_model_var.get() or self.depth_model_combo.get()
        key = label.split(" - ", 1)[0].strip()
        return str(MODEL_OPTIONS.get(key, key))

    def _set_depth_cache_state(self, state: str, reason: str) -> None:
        self._depth_cache_state = state
        self._depth_cache_reason = reason
        self._update_depth_cache_label()

    def _update_depth_cache_label(self) -> None:
        if not hasattr(self, "_depth_cache_label"):
            return
        if self._depth_cache_state == "fresh":
            size_mib = (
                np.asarray(self.raw_depth_array, dtype=np.float32).nbytes
                / (1024.0 * 1024.0)
                if self.raw_depth_array is not None else 0.0
            )
            text = (
                "✓ 深度缓存有效｜background + "
                f"{self._depth_generated_model_id or self._current_depth_model_id()}｜"
                f"{self._DEPTH_CACHE} float32 {size_mib:.1f} MiB"
            )
            color = "#58b86b"
        else:
            text = f"⚠ 深度缓存需要更新：{self._depth_cache_reason}"
            color = "#d49a34"
        self._depth_cache_label.configure(text=text, foreground=color)

    def _expected_depth_signature(self, shape: tuple[int, int]) -> dict | None:
        source_digest = self._source_image_digest()
        if source_digest is None:
            return None
        return depth_signature(
            background_sha256=source_digest,
            model_id=self._current_depth_model_id(),
            shape=shape,
        )

    def _load_depth_cache(self, path: Path) -> bool:
        if self.source_image is None or not path.exists():
            self._depth_cache_metadata = None
            self._depth_generated_model_id = None
            self._set_depth_cache_state("missing", "editor 工程中没有 depth_cache.npy")
            return False
        try:
            cached = np.load(str(path), allow_pickle=False)
        except (OSError, ValueError) as exc:
            self._depth_cache_metadata = None
            self._depth_generated_model_id = None
            self._set_depth_cache_state("stale", f"深度缓存无法读取：{exc}")
            return False
        expected_shape = (self.source_image.height, self.source_image.width)
        if cached.shape != expected_shape:
            self._set_depth_cache_state(
                "stale", f"缓存尺寸 {cached.shape} 与背景 {expected_shape} 不一致",
            )
            return False
        cached_f32 = np.asarray(cached, dtype=np.float32)
        meta_path = path.parent / self._DEPTH_CACHE_META
        metadata = load_json(meta_path)
        self._depth_cache_metadata = metadata
        signature = metadata.get("signature", {}) if isinstance(metadata, dict) else {}
        model_id = signature.get("model_id") if isinstance(signature, dict) else None
        self._depth_generated_model_id = str(model_id) if model_id else None
        expected_signature = self._expected_depth_signature(expected_shape)
        if expected_signature is None:
            self._set_depth_cache_state("stale", "当前软件没有背景图来源指纹")
        else:
            validation = validate_cache_metadata(
                metadata,
                kind=DEPTH_CACHE_KIND,
                expected_signature=expected_signature,
                array=cached_f32,
            )
            self._set_depth_cache_state(
                "fresh" if validation.fresh else "stale", validation.reason,
            )
        self.raw_depth_array = cached_f32.astype(np.float64)
        self.depth_image = Image.fromarray(
            (self.raw_depth_array * 255).clip(0, 255).astype(np.uint8), "L",
        )
        self._recompute_calibrated_depth()
        self._update_thumb()
        self._refresh_3d()
        return True

    def _write_depth_cache(self) -> bool:
        if self._scene_path is None or self.raw_depth_array is None:
            return False
        value = np.asarray(self.raw_depth_array, dtype=np.float32)
        cache_path = self._scene_path / self._DEPTH_CACHE
        save_npy_atomic(cache_path, value)
        source_digest = self._source_image_digest()
        if source_digest is None or self._depth_generated_model_id is None:
            self._set_depth_cache_state(
                "stale", "缺少生成模型来源；请重新计算深度图",
            )
            return False
        signature = depth_signature(
            background_sha256=source_digest,
            model_id=self._depth_generated_model_id,
            shape=value.shape,
        )
        metadata = build_cache_metadata(
            kind=DEPTH_CACHE_KIND,
            signature=signature,
            array=value,
        )
        save_json_atomic(self._scene_path / self._DEPTH_CACHE_META, metadata)
        self._depth_cache_metadata = metadata
        expected = self._expected_depth_signature(value.shape)
        validation = validate_cache_metadata(
            metadata,
            kind=DEPTH_CACHE_KIND,
            expected_signature=expected or signature,
            array=value,
        )
        self._set_depth_cache_state(
            "fresh" if validation.fresh else "stale", validation.reason,
        )
        if not validation.fresh:
            self._set_status(f"深度缓存需要更新：{validation.reason}")
        return validation.fresh

    def _cache_update_suffix(self) -> str:
        if self.source_image is None:
            return ""
        pending: list[str] = []
        if self._depth_cache_state != "fresh":
            pending.append("深度")
        if self._hdr_cache_state != "fresh":
            pending.append("HDR")
        if not pending:
            return ""
        return f"（需要更新：{'、'.join(pending)}缓存）"

    def _on_depth_model_changed(self) -> None:
        if self.raw_depth_array is None:
            self._update_depth_cache_label()
            return
        if self._depth_cache_metadata is None:
            self._set_depth_cache_state("stale", "旧缓存缺少来源/模型元数据")
            return
        expected = self._expected_depth_signature(self.raw_depth_array.shape)
        if expected is None:
            return
        validation = validate_cache_metadata(
            self._depth_cache_metadata,
            kind=DEPTH_CACHE_KIND,
            expected_signature=expected,
            array=np.asarray(self.raw_depth_array, dtype=np.float32),
        )
        self._set_depth_cache_state(
            "fresh" if validation.fresh else "stale", validation.reason,
        )
        if not validation.fresh:
            self._set_status(f"深度模型已变化；缓存需要更新：{validation.reason}")

    def _workspace_scenes_root(self) -> Path:
        from tools.editor.shared.project_paths import (
            DIR_KIND_EDITOR_SCENE_WORKSPACE,
        )
        return self._paths.default_dir(DIR_KIND_EDITOR_SCENE_WORKSPACE)

    def _workspace_scenes_initialdir(self) -> str:
        d = self._workspace_scenes_root()
        return str(d) if d.is_dir() else str(self._project_root)

    def _editor_data_initialdir(self) -> str:
        from tools.editor.shared.project_paths import DIR_KIND_EDITOR_DATA
        d = self._paths.default_dir(DIR_KIND_EDITOR_DATA)
        return str(d) if d.is_dir() else str(self._project_root)

    def _game_export_picker_initialdir(self) -> str:
        if self._game_export_path:
            resolved = self._resolve_game_export_dir()
            if resolved is not None and resolved.parent.is_dir():
                return str(resolved.parent)
        # 迁移后场景媒体导出目标统一在 public/resources/runtime/scenes 下
        from tools.editor.shared.project_paths import DIR_KIND_RUNTIME_SCENES
        d = self._paths.default_dir(DIR_KIND_RUNTIME_SCENES)
        return str(d if d.is_dir() else self._project_root)

    def _normalize_path_for_config(self, p: Path) -> str:
        p = p.resolve()
        try:
            rel = p.relative_to(self._project_root)
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
            p = self._project_root / p
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
        # 迁移后场景 JSON 走 public/assets/scenes/<id>.json，而媒体走
        # public/resources/runtime/scenes/<id>/。
        try:
            scene_json_path = self._paths.scene_json_path(scene_id)
        except ValueError as exc:
            return False, str(exc)
        return True, str(scene_json_path)

    def _prepare_scene_data_for_export(
        self, scene_json_path: Path, scene_id: str
    ) -> tuple[dict, bool]:
        """合并式加载可写入游戏的场景 JSON 对象。

        权属划分：``name`` / ``worldWidth`` / ``worldHeight`` / ``camera`` /
        ``spawnPoint`` 等由**主编辑器**拥有——文件已存在时一律原样保留，深度导出
        只负责 ``depthConfig``（调用方在返回后写入）、媒体文件，以及把
        ``backgrounds[0].image`` 对齐到 ``background.png``。
        仅当场景 JSON 原本不存在 / 损坏时，才回退补一份最小骨架（深度工具独立
        创建场景的兜底）。

        返回 (scene_data, repaired)。repaired=True 表示新建/修复了文件或改动了
        关键字段，会提示用户。"""
        data: dict = {}
        existed = False
        repaired = False

        if scene_json_path.exists():
            try:
                raw = json.loads(scene_json_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    data = raw
                    existed = True
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

        # id 始终对齐。
        if data.get("id") != scene_id:
            data["id"] = scene_id
            repaired = True

        # backgrounds[0].image 始终对齐到 background.png（保留其余字段与额外图层）。
        bgs = data.get("backgrounds")
        if (not isinstance(bgs, list) or len(bgs) == 0
                or not isinstance(bgs[0], dict) or not bgs[0].get("image")):
            data["backgrounds"] = [{"image": "background.png", "x": 0, "y": 0}]
            repaired = True
        elif bgs[0].get("image") != "background.png":
            first_fixed = dict(bgs[0])
            first_fixed["image"] = "background.png"
            data["backgrounds"] = [first_fixed] + list(bgs[1:])
            repaired = True

        if existed:
            # 主编辑器拥有的字段（name/world/camera/spawn）一律不动。
            return data, repaired

        # —— 文件原本不存在 / 损坏：补最小骨架 ——
        data.setdefault("name", str(scene_id))
        if not (isinstance(data.get("worldWidth"), (int, float)) and data["worldWidth"] > 0):
            data["worldWidth"] = int(img_w)
        if not (isinstance(data.get("worldHeight"), (int, float)) and data["worldHeight"] > 0):
            data["worldHeight"] = int(img_h)
        cam = data.get("camera")
        if not isinstance(cam, dict):
            data["camera"] = {"zoom": 1.0, "pixelsPerUnit": 1.0}
        else:
            cam.setdefault("zoom", 1.0)
            cam.setdefault("pixelsPerUnit", 1.0)
        sp = data.get("spawnPoint")
        if not isinstance(sp, dict) or "x" not in sp or "y" not in sp:
            data["spawnPoint"] = {
                "x": round(img_w / 2.0, 1),
                "y": round(img_h * 0.85, 1),
            }
        return data, True

    def _new_scene(self) -> None:
        path = filedialog.askdirectory(
            title="选择新场景文件夹位置",
            initialdir=self._workspace_scenes_initialdir())
        if not path:
            return
        name = tk.simpledialog.askstring("新建场景", "场景名称:", parent=self.root)
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
            initialdir=self._editor_data_initialdir())
        if not path:
            return
        scene_dir = Path(path)
        if not scene_dir.is_dir():
            return
        self._scene_path = scene_dir
        # 遗留文件夹模式：与游戏场景 id 脱钩，导出走 game_export_path / 手选。
        self._bound_scene_id = None
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
        has_depth = self._load_depth_cache(depth)

        if has_depth:
            self._load_collision(silent=True)
        else:
            self._world_height_map = None
            self._screen_collision = None
            self._collision_locked = False
            self.gl_viewer.set_collision_data(None)

        if has_depth:
            self._set_status(f"场景已打开: {scene_dir.name}")
        elif self.source_image is not None:
            self._set_status(
                f"场景已打开: {scene_dir.name}（尚无有效深度，请先「计算深度图」）")
        else:
            self._set_status(f"场景已打开: {scene_dir.name}")
        suffix = self._cache_update_suffix()
        if suffix:
            self._set_status(f"{self.status_var.get()} {suffix}")

    def _save_scene(self) -> None:
        if self._scene_path is None:
            messagebox.showinfo("提示", "请先新建或打开一个场景。")
            return
        d = self._scene_path
        d.mkdir(parents=True, exist_ok=True)

        scene_data = {"calibration": self._collect_calibration_data()}
        (d / self._SCENE_JSON).write_text(
            json.dumps(scene_data, indent=2, ensure_ascii=False), encoding="utf-8")

        if self._hdr_gain_ev is not None:
            self._hdr_gain_source_digest = self._source_image_digest()
            self._hdr_expected_gain_source_digest = self._hdr_gain_source_digest
            self._hdr_gain_enabled = True
            save_npy_atomic(
                d / self._HDR_GAIN_CACHE,
                np.asarray(self._hdr_gain_ev, dtype=np.float32),
            )

        if self.source_image is not None:
            self._write_hdr_cache()

        (d / self._EDITOR_JSON).write_text(
            json.dumps(self._collect_editor_data(), indent=2, ensure_ascii=False),
            encoding="utf-8")

        if self.raw_depth_array is not None:
            self._write_depth_cache()

        self._save_collision(silent=True)

        self._set_status(f"场景已保存: {d.name} {self._cache_update_suffix()}")

    def _import_background(self) -> None:
        if self._scene_path is None:
            messagebox.showinfo("提示", "请先新建或打开一个场景。")
            return
        if self._bound_scene_id:
            messagebox.showinfo(
                "提示",
                "绑定项目模式下，背景图由主编辑器统一管理（单一真源）。\n"
                "请在主编辑器导入/更换背景图后，回到本工具重新打开该场景。")
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
        self._set_depth_cache_state("stale", "背景图像素已变化")
        self._set_status(
            f"背景图已导入: {Path(path).name} {self._cache_update_suffix()}",
        )

    def _load_background(self, path: Path) -> None:
        self.source_image = Image.open(path).convert("RGB")
        w, h = self.source_image.size
        # A saved scene calibration is authoritative.  Only a scene without a
        # calibrated principal point falls back to the image centre.
        if not self._camera_center_from_calibration:
            self.camera.cx = w / 2.0
            self.camera.cy = h / 2.0
        self.gl_viewer.set_calibration_camera(self.camera)
        self.image_label.configure(text=f"{path.name}  ({w} x {h})")
        self._update_thumb()
        self._occlusion_uv = [w / 2.0, h * 0.8]
        self._hdr_result = None
        self._hdr_linear_source = None
        self._hdr_source_prepare_ms = 0.0
        self._load_workspace_hdr_gain()
        self._load_workspace_hdr_cache()
        self._schedule_hdr_refresh()

    # ---- Scene data collect / apply ----

    def _collect_editor_data(self) -> dict:
        data = {
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
            "hdr_radiance": {
                "scene_exposure_ev": self.lighting_scene_ev_var.get(),
                "gain_ev_scale": self.hdr_gain_scale_var.get(),
                "max_gain_ev": self.hdr_max_gain_ev_var.get(),
                "display_exposure_ev": self.hdr_display_ev_var.get(),
                "tone_mapper": self._HDR_TONE_LABELS.get(
                    self.hdr_tone_mapper_var.get(), TONE_MAPPER_ACES,
                ),
                "preview_mode": self._HDR_PREVIEW_LABELS.get(
                    self.hdr_preview_mode_var.get(), PREVIEW_TONE_MAPPED,
                ),
                "mesh_preview": self.hdr_mesh_preview_var.get(),
                "gain_enabled": self._hdr_gain_enabled and self._hdr_gain_ev is not None,
                "gain_source_sha256": self._hdr_gain_source_digest,
            },
            "lighting_debug": {
                "position": [
                    self.lighting_x_var.get(),
                    self.lighting_y_var.get(),
                    self.lighting_z_var.get(),
                ],
                "position_initialized": self._lighting_position_initialized,
                "width": self.lighting_width_var.get(),
                "height": self.lighting_height_var.get(),
                "size_initialized": self._lighting_size_initialized,
                "size_auto": self._lighting_size_auto,
                "uniform_scale": self.lighting_uniform_scale_var.get(),
                "move_step": self.lighting_move_step_var.get(),
                "bulge": self.lighting_bulge_var.get(),
                "main_normal_local": [
                    self.lighting_normal_x_var.get(),
                    self.lighting_normal_y_var.get(),
                    self.lighting_normal_z_var.get(),
                ],
                "samples_per_pixel": int(self.lighting_spp_var.get()),
                "calculation_height": int(self.lighting_calc_height_var.get()),
                "step_pixels": self.lighting_step_pixels_var.get(),
                "max_distance": self.lighting_max_distance_var.get(),
                "front_epsilon_pixels": self.lighting_front_epsilon_var.get(),
                "back_thickness_pixels": self.lighting_back_thickness_var.get(),
                "scene_exposure_ev": self.lighting_scene_ev_var.get(),
                "miss_mode": self._LIGHTING_MISS_LABELS.get(
                    self.lighting_miss_mode_var.get(), MISS_BLACK,
                ),
                "show_quad": self.lighting_quad_enabled_var.get(),
                "show_shaded": self.lighting_show_shaded_var.get(),
                "show_rays": self.lighting_show_rays_var.get(),
                "show_hit": self.lighting_show_hit_var.get(),
                "show_exit": self.lighting_show_exit_var.get(),
                "show_range": self.lighting_show_range_var.get(),
                "xray": self.lighting_xray_var.get(),
                "direction_filter": self._LIGHTING_DIRECTION_LABELS.get(
                    self.lighting_direction_filter_var.get(), "all",
                ),
                "ray_limit": int(self.lighting_ray_limit_var.get()),
            },
        }
        # game_export_path 仅遗留文件夹模式才需要记忆；绑定项目时导出目标由场景 id
        # 推出，不再写入——存在的旧值会在下次保存时随之清除。
        if not self._bound_scene_id:
            data["game_export_path"] = self._game_export_path
        return data

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
            # set() 不一定触发 checkbox command，显式同步到 GL
            self.gl_viewer.set_billboard_enabled(bool(bb["enabled"]))
            if bb["enabled"] and self.gl_viewer._billboard_tex_id is None:
                self.gl_viewer.load_billboard_texture(None)
        if "scale" in bb:
            self.billboard_scale_var.set(bb["scale"])
            self.gl_viewer.set_billboard_scale(float(bb["scale"]))
        occ = data.get("occlusion", {})
        for k, var in [("step", self.occlusion_step_var),
                       ("scale", self.occlusion_scale_var),
                       ("tolerance", self.occlusion_tolerance_var),
                       ("floor_offset", self.occlusion_floor_offset_var)]:
            if k in occ:
                var.set(occ[k])
        hdr = data.get("hdr_radiance", {})
        if not isinstance(hdr, dict):
            hdr = {}
        legacy_lighting = data.get("lighting_debug", {})
        legacy_scene_ev = (
            legacy_lighting.get("scene_exposure_ev", 0.0)
            if isinstance(legacy_lighting, dict) else 0.0
        )
        hdr_numeric = (
            ("scene_exposure_ev", self.lighting_scene_ev_var, legacy_scene_ev, -16.0, 16.0),
            ("gain_ev_scale", self.hdr_gain_scale_var, 1.0, 0.0, 8.0),
            ("max_gain_ev", self.hdr_max_gain_ev_var, 3.32, 0.0, 16.0),
            ("display_exposure_ev", self.hdr_display_ev_var, 0.0, -16.0, 16.0),
        )
        for key, variable, default, minimum, maximum in hdr_numeric:
            try:
                value = float(hdr.get(key, default))
            except (TypeError, ValueError):
                value = float(default)
            variable.set(max(minimum, min(maximum, value)))
        tone_labels_by_code = {value: label for label, value in self._HDR_TONE_LABELS.items()}
        preview_labels_by_code = {value: label for label, value in self._HDR_PREVIEW_LABELS.items()}
        tone_code = hdr.get("tone_mapper", TONE_MAPPER_ACES)
        preview_code = hdr.get("preview_mode", PREVIEW_TONE_MAPPED)
        self.hdr_tone_mapper_var.set(tone_labels_by_code.get(tone_code, "ACES"))
        self.hdr_preview_mode_var.set(preview_labels_by_code.get(preview_code, "HDR 映射"))
        self.hdr_mesh_preview_var.set(bool(hdr.get("mesh_preview", False)))
        self._hdr_gain_enabled = bool(hdr.get("gain_enabled", True))
        digest = hdr.get("gain_source_sha256")
        self._hdr_expected_gain_source_digest = digest if isinstance(digest, str) else None
        lighting = data.get("lighting_debug", {})
        if isinstance(lighting, dict):
            position = lighting.get("position")
            if isinstance(position, (list, tuple)) and len(position) == 3:
                try:
                    x, y, z = (float(value) for value in position)
                except (TypeError, ValueError):
                    pass
                else:
                    self.lighting_x_var.set(x)
                    self.lighting_y_var.set(y)
                    self.lighting_z_var.set(z)
                    self._lighting_position_initialized = bool(
                        lighting.get("position_initialized", True)
                    )
            main_normal = lighting.get("main_normal_local")
            if isinstance(main_normal, (list, tuple)) and len(main_normal) == 3:
                try:
                    normal = np.asarray(main_normal, dtype=np.float64)
                    normal_length = float(np.linalg.norm(normal))
                except (TypeError, ValueError):
                    normal_length = 0.0
                if np.isfinite(normal_length) and normal_length >= 1e-6:
                    normal /= normal_length
                    self.lighting_normal_x_var.set(float(normal[0]))
                    self.lighting_normal_y_var.set(float(normal[1]))
                    self.lighting_normal_z_var.set(float(normal[2]))
            numeric_fields = (
                ("width", self.lighting_width_var, 0.001, None),
                ("height", self.lighting_height_var, 0.001, None),
                ("uniform_scale", self.lighting_uniform_scale_var, 0.1, 5.0),
                ("move_step", self.lighting_move_step_var, 0.0001, None),
                ("bulge", self.lighting_bulge_var, 0.0, 1.0),
                ("step_pixels", self.lighting_step_pixels_var, 0.1, None),
                ("max_distance", self.lighting_max_distance_var, 0.0, None),
                ("front_epsilon_pixels", self.lighting_front_epsilon_var, 0.0, None),
                ("back_thickness_pixels", self.lighting_back_thickness_var, 0.0, None),
            )
            for key, variable, minimum, maximum in numeric_fields:
                if key not in lighting:
                    continue
                try:
                    value = float(lighting[key])
                except (TypeError, ValueError):
                    continue
                if minimum is not None:
                    value = max(minimum, value)
                if maximum is not None:
                    value = min(maximum, value)
                variable.set(value)
            if "width" in lighting or "height" in lighting:
                self._lighting_size_initialized = bool(
                    lighting.get("size_initialized", True)
                )
                self._lighting_size_auto = bool(lighting.get("size_auto", False))
            if "samples_per_pixel" in lighting:
                try:
                    spp = max(1, int(lighting["samples_per_pixel"]))
                    self.lighting_spp_var.set(str(spp))
                except (TypeError, ValueError):
                    pass
            if "calculation_height" in lighting:
                try:
                    calc_height = max(8, int(lighting["calculation_height"]))
                    self.lighting_calc_height_var.set(str(calc_height))
                except (TypeError, ValueError):
                    pass
            miss_mode = lighting.get("miss_mode")
            miss_labels_by_code = {
                value: label for label, value in self._LIGHTING_MISS_LABELS.items()
            }
            if miss_mode in miss_labels_by_code:
                self.lighting_miss_mode_var.set(miss_labels_by_code[miss_mode])
            boolean_fields = (
                ("show_quad", self.lighting_quad_enabled_var),
                ("show_shaded", self.lighting_show_shaded_var),
                ("show_rays", self.lighting_show_rays_var),
                ("show_hit", self.lighting_show_hit_var),
                ("show_exit", self.lighting_show_exit_var),
                ("show_range", self.lighting_show_range_var),
                ("xray", self.lighting_xray_var),
            )
            for key, variable in boolean_fields:
                if key in lighting:
                    variable.set(bool(lighting[key]))
            direction = lighting.get("direction_filter")
            direction_labels_by_code = {
                value: label for label, value in self._LIGHTING_DIRECTION_LABELS.items()
            }
            if direction in direction_labels_by_code:
                self.lighting_direction_filter_var.set(direction_labels_by_code[direction])
            if "ray_limit" in lighting:
                try:
                    self.lighting_ray_limit_var.set(str(max(1, int(lighting["ray_limit"]))))
                except (TypeError, ValueError):
                    pass
            self._sync_lighting_entries()
        # 绑定项目时导出目标由 id 推出（调用方已设好），忽略文件里的旧 game_export_path。
        if not self._bound_scene_id:
            if data.get("game_export_path"):
                self._game_export_path = str(data["game_export_path"])
            else:
                self._game_export_path = None
        self._sync_viewer_from_vars()
        self._on_lighting_view_changed()

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
                self.root.after(0, lambda: self._on_depth_done(result, model_id))
            except Exception as exc:
                # 必须先取出消息：except 块结束后 exc 会被解绑，延迟到主线程的 lambda 里再读会 NameError
                msg = str(exc)
                self.root.after(0, lambda: self._show_error(msg))

        threading.Thread(target=worker, daemon=True).start()

    def _on_depth_done(self, result, model_id: str | None = None) -> None:
        self._invalidate_lighting_result()
        self.depth_image = result.image
        self.raw_depth_array = np.array(result.raw_normalized, dtype=np.float64)
        self._depth_generated_model_id = str(model_id or self._current_depth_model_id())
        if self._scene_path is not None:
            self._write_depth_cache()
            stale = self._scene_path / (self._DEPTH_CACHE + ".stale")
            if stale.exists():
                try:
                    stale.unlink()
                except OSError:
                    pass
            stale_meta = self._scene_path / (self._DEPTH_CACHE_META + ".stale")
            if stale_meta.exists():
                try:
                    stale_meta.unlink()
                except OSError:
                    pass
        self._recompute_calibrated_depth()
        self.preview_mode_var.set("depth")
        self._update_thumb()
        self._collision_locked = False
        self._refresh_3d()
        # 新深度出来后再挂已保存的碰撞；没有则保留刚从网格生成的草稿
        self._load_collision(silent=True)
        self._set_status("深度图已生成并缓存。左键拖=旋转；选编辑工具后左键直接涂抹。")

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
        self._schedule_hdr_refresh()
        self._world_xz_cache = None

        self._cached_mesh_xyz = (X, Y, Z)
        self._initialize_lighting_position_from_mesh()
        self._initialize_lighting_size_from_player()
        self._refresh_lighting_quad()
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
        self._thumb_photo = _make_photo_image(thumb)
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

    # ==================================================================
    # HDR scene radiance
    # ==================================================================

    def _current_hdr_settings(self) -> HDRSettings:
        tone_mapper = self._HDR_TONE_LABELS.get(
            self.hdr_tone_mapper_var.get(), TONE_MAPPER_ACES,
        )
        return HDRSettings(
            scene_exposure_ev=max(-16.0, min(16.0, self.lighting_scene_ev_var.get())),
            gain_ev_scale=max(0.0, self.hdr_gain_scale_var.get()),
            max_gain_ev=max(0.0, self.hdr_max_gain_ev_var.get()),
            display_exposure_ev=max(-16.0, min(16.0, self.hdr_display_ev_var.get())),
            tone_mapper=tone_mapper,
        )

    def _source_image_digest(self) -> str | None:
        if self.source_image is None:
            return None
        digest = hashlib.sha256()
        digest.update(f"{self.source_image.mode}:{self.source_image.size}".encode("ascii"))
        digest.update(self.source_image.tobytes())
        return digest.hexdigest()

    def _current_hdr_signature(self) -> dict | None:
        if self.source_image is None:
            return None
        settings = self._current_hdr_settings()
        return hdr_signature(
            background_sha256=self._source_image_digest() or "",
            gain_sha256=(
                array_sha256(np.asarray(self._hdr_gain_ev, dtype=np.float32))
                if self._hdr_gain_ev is not None else None
            ),
            shape=(self.source_image.height, self.source_image.width, 3),
            scene_exposure_ev=settings.scene_exposure_ev,
            gain_ev_scale=settings.gain_ev_scale,
            max_gain_ev=settings.max_gain_ev,
            reference_white_nits=settings.reference_white_nits,
        )

    def _set_hdr_cache_state(self, state: str, reason: str) -> None:
        self._hdr_cache_state = state
        self._hdr_cache_reason = reason
        self._update_hdr_cache_label()

    def _update_hdr_cache_label(self) -> None:
        if not hasattr(self, "_hdr_cache_label"):
            return
        if self._hdr_cache_state == "fresh":
            size_mib = (
                self._hdr_cached_radiance.nbytes / (1024.0 * 1024.0)
                if self._hdr_cached_radiance is not None else 0.0
            )
            text = (
                f"✓ HDR 缓存有效｜{self._HDR_CACHE}｜"
                f"float32 {size_mib:.1f} MiB｜"
                "当前背景 + gainEV + HDR 物理标定"
            )
            color = "#58b86b"
        else:
            text = f"⚠ HDR 缓存需要更新：{self._hdr_cache_reason}"
            color = "#d49a34"
        self._hdr_cache_label.configure(text=text, foreground=color)

    def _effective_hdr_gain(self) -> np.ndarray:
        if self.source_image is None:
            return np.zeros((0, 0), dtype=np.float32)
        if self._hdr_gain_ev is None:
            gain = np.zeros(
                (self.source_image.height, self.source_image.width), dtype=np.float32,
            )
        else:
            gain = np.asarray(self._hdr_gain_ev, dtype=np.float32)
        settings = self._current_hdr_settings()
        return np.clip(
            gain * np.float32(max(0.0, settings.gain_ev_scale)),
            0.0,
            max(0.0, settings.max_gain_ev),
        ).astype(np.float32)

    def _decorate_hdr_result_stats(self, result: HDRResult) -> None:
        linear_mib = (
            self._hdr_linear_source.nbytes / (1024.0 * 1024.0)
            if self._hdr_linear_source is not None else 0.0
        )
        gain_mib = (
            self._hdr_gain_ev.nbytes / (1024.0 * 1024.0)
            if self._hdr_gain_ev is not None else 0.0
        )
        result.stats["linear_source_megabytes"] = float(linear_mib)
        result.stats["gain_megabytes"] = float(gain_mib)
        result.stats["working_set_megabytes"] = float(
            linear_mib + gain_mib + result.stats["data_megabytes"]
        )

    def _hdr_result_from_cached_radiance(self, radiance: np.ndarray) -> HDRResult:
        started = time.perf_counter()
        value = np.asarray(radiance, dtype=np.float32)
        effective_gain = self._effective_hdr_gain()
        stats = radiance_statistics(
            value, self._current_hdr_settings().reference_white_nits,
        )
        stats["gain_ev_min"] = float(np.min(effective_gain)) if effective_gain.size else 0.0
        stats["gain_ev_max"] = float(np.max(effective_gain)) if effective_gain.size else 0.0
        stats["gain_coverage_percent"] = (
            float(np.mean(effective_gain > 1e-4) * 100.0) if effective_gain.size else 0.0
        )
        stats["source_preparation_ms"] = 0.0
        stats["radiance_update_ms"] = 0.0
        stats["reconstruction_ms"] = 0.0
        stats["cache_load_ms"] = float((time.perf_counter() - started) * 1000.0)
        result = HDRResult(value, effective_gain, stats)
        self._decorate_hdr_result_stats(result)
        return result

    def _refresh_hdr_cache_validation(self) -> None:
        if self._hdr_cached_radiance is None:
            self._set_hdr_cache_state("missing", "editor 工程中没有 radiance_cache.npy")
            return
        signature = self._current_hdr_signature()
        if signature is None:
            self._set_hdr_cache_state("stale", "当前软件没有背景图来源指纹")
            return
        validation = validate_cache_metadata(
            self._hdr_cache_metadata,
            kind=HDR_CACHE_KIND,
            expected_signature=signature,
            array=self._hdr_cached_radiance,
        )
        self._set_hdr_cache_state(
            "fresh" if validation.fresh else "stale", validation.reason,
        )

    def _load_workspace_hdr_cache(self) -> None:
        self._hdr_cache_metadata = None
        self._hdr_cached_radiance = None
        if self._scene_path is None or self.source_image is None:
            self._set_hdr_cache_state("missing", "尚未打开 editor 场景工程")
            return
        path = self._scene_path / self._HDR_CACHE
        if not path.exists():
            self._set_hdr_cache_state("missing", "editor 工程中没有 radiance_cache.npy")
            return
        try:
            value = np.load(str(path), allow_pickle=False)
        except (OSError, ValueError) as exc:
            self._set_hdr_cache_state("stale", f"HDR 缓存无法读取：{exc}")
            return
        if value.dtype != np.float32:
            self._set_hdr_cache_state("stale", f"HDR 缓存 dtype 必须是 float32，当前为 {value.dtype}")
            return
        expected_shape = (self.source_image.height, self.source_image.width, 3)
        if value.shape != expected_shape:
            self._set_hdr_cache_state(
                "stale", f"缓存尺寸 {value.shape} 与场景 {expected_shape} 不一致",
            )
            return
        self._hdr_cached_radiance = np.asarray(value, dtype=np.float32)
        self._hdr_cache_metadata = load_json(self._scene_path / self._HDR_CACHE_META)
        self._refresh_hdr_cache_validation()
        if self._hdr_cache_state == "fresh":
            self._hdr_result = self._hdr_result_from_cached_radiance(
                self._hdr_cached_radiance,
            )

    def _write_hdr_cache(self) -> bool:
        if self._scene_path is None or self.source_image is None:
            return False
        result = self._current_hdr_result()
        signature = self._current_hdr_signature()
        if result is None or signature is None:
            return False
        value = np.asarray(result.radiance_nits, dtype=np.float32)
        save_npy_atomic(self._scene_path / self._HDR_CACHE, value)
        metadata = build_cache_metadata(
            kind=HDR_CACHE_KIND,
            signature=signature,
            array=value,
        )
        save_json_atomic(self._scene_path / self._HDR_CACHE_META, metadata)
        self._hdr_cached_radiance = value
        self._hdr_cache_metadata = metadata
        self._set_hdr_cache_state("fresh", "缓存与当前软件参数一致")
        return True

    def _update_hdr_cache(self) -> None:
        if self._scene_path is None or self.source_image is None:
            messagebox.showinfo("提示", "请先打开场景并加载背景图。")
            return
        try:
            saved = self._write_hdr_cache()
        except (OSError, ValueError) as exc:
            self._show_error(f"HDR 缓存写入失败：{exc}")
            return
        if saved:
            self._set_status(
                f"HDR float32 辐射度已缓存到 editor 工程：{self._HDR_CACHE}",
            )

    def _current_hdr_result(self) -> HDRResult | None:
        if self.source_image is None:
            return None
        if self._hdr_result is None:
            if self._hdr_cache_state == "fresh" and self._hdr_cached_radiance is not None:
                self._hdr_result = self._hdr_result_from_cached_radiance(
                    self._hdr_cached_radiance,
                )
                return self._hdr_result
            if self._hdr_linear_source is None:
                started = time.perf_counter()
                self._hdr_linear_source = prepare_linear_source(self.source_image)
                self._hdr_source_prepare_ms = (time.perf_counter() - started) * 1000.0
            self._hdr_result = reconstruct_hdr_from_linear(
                self._hdr_linear_source,
                self._hdr_gain_ev,
                self._current_hdr_settings(),
            )
            self._hdr_result.stats["source_preparation_ms"] = self._hdr_source_prepare_ms
            self._hdr_result.stats["reconstruction_ms"] = (
                self._hdr_source_prepare_ms
                + self._hdr_result.stats["radiance_update_ms"]
            )
            self._decorate_hdr_result_stats(self._hdr_result)
        return self._hdr_result

    def _invalidate_hdr_radiance(self) -> None:
        self._hdr_result = None
        if self.source_image is not None:
            self._refresh_hdr_cache_validation()
            if self._hdr_cache_state != "fresh":
                self._set_status(f"HDR 缓存需要更新：{self._hdr_cache_reason}")
        self._invalidate_lighting_result()
        self._schedule_hdr_refresh()

    def _on_hdr_display_changed(self) -> None:
        self._schedule_hdr_refresh()
        if self._lighting_result is not None:
            self._refresh_lighting_quad()

    def _schedule_hdr_refresh(self) -> None:
        if self._hdr_refresh_pending:
            return
        self._hdr_refresh_pending = True
        self.root.after(35, self._refresh_hdr_views)

    def _refresh_hdr_views(self) -> None:
        self._hdr_refresh_pending = False
        result = self._current_hdr_result()
        if result is None:
            if hasattr(self, "_hdr_stats_label"):
                self._hdr_stats_label.configure(text="加载场景后显示 float32 HDR 统计")
            return
        settings = self._current_hdr_settings()
        mode = self._HDR_PREVIEW_LABELS.get(
            self.hdr_preview_mode_var.get(), PREVIEW_TONE_MAPPED,
        )
        stats = result.stats
        self._hdr_stats_label.configure(
            text=(
                f"辐射度 {stats['data_megabytes']:.1f} MiB｜"
                f"工作集 {stats['working_set_megabytes']:.1f} MiB｜"
                f"准备 {stats['source_preparation_ms']:.1f} ms｜"
                f"更新 {stats['radiance_update_ms']:.1f} ms｜"
                f"p50 {stats['luminance_p50_nits']:.1f} nit｜"
                f"p95 {stats['luminance_p95_nits']:.1f} nit｜"
                f"max {stats['luminance_max_nits']:.1f} nit\n"
                f">100 nit {stats['above_100_nits_percent']:.1f}%｜"
                f">1000 nit {stats['above_1000_nits_percent']:.2f}%｜"
                f"gain 覆盖 {stats['gain_coverage_percent']:.2f}%"
            )
        )
        if self.hdr_mesh_preview_var.get() and self.calibrated_depth is not None:
            mesh_image = render_hdr_preview(result, settings, mode, include_scale=False)
            self.gl_viewer.set_mesh_texture(mesh_image)
        elif self.source_image is not None and self.calibrated_depth is not None:
            self.gl_viewer.set_mesh_texture(self.source_image)

        if self._hdr_window is None or not self._hdr_window.winfo_exists():
            return
        preview = render_hdr_preview(result, settings, mode, include_scale=True)
        max_w, max_h = 1200, 820
        ratio = min(max_w / preview.width, max_h / preview.height, 1.0)
        if ratio < 1.0:
            preview = preview.resize(
                (max(1, int(preview.width * ratio)), max(1, int(preview.height * ratio))),
                Image.Resampling.LANCZOS,
            )
        self._hdr_photo = _make_photo_image(preview)
        if self._hdr_label is not None:
            self._hdr_label.configure(image=self._hdr_photo)
        self._hdr_window.geometry(f"{preview.width}x{preview.height}")

    def _open_hdr_preview(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先加载场景背景图。")
            return
        if self._hdr_window is not None and self._hdr_window.winfo_exists():
            self._hdr_window.focus_force()
            self._refresh_hdr_views()
            return
        win = tk.Toplevel(self.root)
        win.title("HDR 场景辐射度｜float32 数据的 SDR 可视化")
        self._hdr_window = win
        self._hdr_label = tk.Label(win)
        self._hdr_label.pack(fill="both", expand=True)
        win.protocol("WM_DELETE_WINDOW", self._close_hdr_preview)
        self._refresh_hdr_views()
        win.focus_force()

    def _close_hdr_preview(self) -> None:
        if self._hdr_window is not None:
            self._hdr_window.destroy()
        self._hdr_window = None
        self._hdr_label = None
        self._hdr_photo = None

    def _load_hdr_gain_dialog(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先加载场景背景图。")
            return
        path = filedialog.askopenfilename(
            title="加载正式 gainEV 产品",
            filetypes=[
                ("gainEV", "*.npy *.png *.tif *.tiff"),
                ("All files", "*.*"),
            ],
        )
        if not path:
            return
        try:
            self._hdr_gain_ev = load_gain_ev(
                path,
                (self.source_image.height, self.source_image.width),
                image_max_gain_ev=self.hdr_max_gain_ev_var.get(),
            )
        except (OSError, ValueError) as exc:
            self._show_error(f"gainEV 加载失败：{exc}")
            return
        self._hdr_gain_source_digest = self._source_image_digest()
        self._hdr_expected_gain_source_digest = self._hdr_gain_source_digest
        self._hdr_gain_enabled = True
        self._hdr_gain_stale = False
        self._update_hdr_gain_label()
        self._invalidate_hdr_radiance()
        self._set_status(f"已加载正式 gainEV：{Path(path).name}")

    def _clear_hdr_gain(self) -> None:
        self._hdr_gain_ev = None
        self._hdr_gain_source_digest = None
        self._hdr_expected_gain_source_digest = None
        self._hdr_gain_enabled = False
        self._hdr_gain_stale = False
        self._update_hdr_gain_label()
        self._invalidate_hdr_radiance()
        self._set_status("已清除当前 gainEV；HDR 严格使用零局部增益。")

    def _update_hdr_gain_label(self) -> None:
        if not hasattr(self, "_hdr_gain_label"):
            return
        if self._hdr_gain_stale:
            text = "gainEV：背景像素已变化，旧产品已禁用（文件仍保留）"
        elif self._hdr_gain_ev is None:
            text = "gainEV：未加载，当前严格使用零增益"
        else:
            size_mib = self._hdr_gain_ev.nbytes / (1024.0 * 1024.0)
            text = (
                f"gainEV：{self._hdr_gain_ev.shape[1]}×{self._hdr_gain_ev.shape[0]} "
                f"float32 {size_mib:.1f} MiB｜原始峰值 {float(np.max(self._hdr_gain_ev)):.2f} EV"
            )
        self._hdr_gain_label.configure(text=text)

    def _load_workspace_hdr_gain(self) -> None:
        self._hdr_gain_ev = None
        self._hdr_gain_source_digest = None
        self._hdr_gain_stale = False
        if self._scene_path is None or self.source_image is None:
            self._update_hdr_gain_label()
            return
        if not self._hdr_gain_enabled:
            self._update_hdr_gain_label()
            return
        path = self._scene_path / self._HDR_GAIN_CACHE
        if not path.exists():
            self._update_hdr_gain_label()
            return
        current_digest = self._source_image_digest()
        if (
            self._hdr_expected_gain_source_digest
            and current_digest != self._hdr_expected_gain_source_digest
        ):
            self._hdr_gain_stale = True
            self._update_hdr_gain_label()
            return
        try:
            self._hdr_gain_ev = load_gain_ev(
                path, (self.source_image.height, self.source_image.width),
            )
        except (OSError, ValueError):
            self._hdr_gain_stale = True
            self._update_hdr_gain_label()
            return
        self._hdr_gain_source_digest = current_digest
        self._update_hdr_gain_label()

    # ==================================================================
    # Entity final-gather debugger
    # ==================================================================

    def _load_player_manifest(self) -> dict:
        manifest_path = (
            self._project_root
            / "public/resources/runtime/animation/player_anim/anim.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("主角动画配置不是 JSON 对象")
        return manifest

    def _load_project_player_frame(self) -> Image.Image:
        atlas_path = self._project_root / "public/resources/runtime/animation/player_anim/atlas.png"
        manifest = self._load_player_manifest()
        atlas = Image.open(atlas_path).convert("RGBA")
        cols = max(1, int(manifest["cols"]))
        rows = max(1, int(manifest["rows"]))
        frame_index = int(manifest.get("states", {}).get("idle", {}).get("frames", [0])[0])
        cell_w, cell_h = atlas.width // cols, atlas.height // rows
        column, row = frame_index % cols, frame_index // cols
        return atlas.crop((
            column * cell_w, row * cell_h,
            (column + 1) * cell_w, (row + 1) * cell_h,
        ))

    def _use_player_lighting_sprite(self) -> None:
        try:
            self._lighting_sprite = self._load_project_player_frame()
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            self._show_error(f"无法加载主角帧：{exc}")
            return
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        self._set_status("实体光照调试已使用主角 idle 帧。")

    def _load_lighting_sprite(self) -> None:
        path = filedialog.askopenfilename(
            title="选择角色 RGBA 贴图",
            filetypes=[("Image files", "*.png *.webp *.bmp"), ("All files", "*.*")],
        )
        if not path:
            return
        try:
            self._lighting_sprite = Image.open(path).convert("RGBA")
        except (OSError, ValueError) as exc:
            self._show_error(f"无法加载角色贴图：{exc}")
            return
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        self._set_status(f"实体光照调试贴图：{Path(path).name}")

    def _sync_lighting_entries(self) -> None:
        values = {
            "x": self.lighting_x_var.get(),
            "y": self.lighting_y_var.get(),
            "z": self.lighting_z_var.get(),
            "width": self.lighting_width_var.get(),
            "height": self.lighting_height_var.get(),
            "bulge": self.lighting_bulge_var.get(),
            "normal_x": self.lighting_normal_x_var.get(),
            "normal_y": self.lighting_normal_y_var.get(),
            "normal_z": self.lighting_normal_z_var.get(),
            "move_step": self.lighting_move_step_var.get(),
            "step": self.lighting_step_pixels_var.get(),
            "max_distance": self.lighting_max_distance_var.get(),
            "front": self.lighting_front_epsilon_var.get(),
            "back": self.lighting_back_thickness_var.get(),
        }
        for key, value in values.items():
            entry = self._lighting_entries.get(key)
            if entry is None:
                continue
            entry.delete(0, "end")
            entry.insert(0, f"{value:.5g}")
        self._update_lighting_size_label()
        self._update_lighting_normal_label()

    def _commit_lighting_fields(self, _event=None, *, silent: bool = False) -> bool:
        variables = {
            "x": self.lighting_x_var,
            "y": self.lighting_y_var,
            "z": self.lighting_z_var,
            "width": self.lighting_width_var,
            "height": self.lighting_height_var,
            "bulge": self.lighting_bulge_var,
            "normal_x": self.lighting_normal_x_var,
            "normal_y": self.lighting_normal_y_var,
            "normal_z": self.lighting_normal_z_var,
            "move_step": self.lighting_move_step_var,
            "step": self.lighting_step_pixels_var,
            "max_distance": self.lighting_max_distance_var,
            "front": self.lighting_front_epsilon_var,
            "back": self.lighting_back_thickness_var,
        }
        parsed: dict[str, float] = {}
        try:
            for key in variables:
                parsed[key] = float(self._lighting_entries[key].get())
        except (ValueError, KeyError):
            self._sync_lighting_entries()
            if not silent:
                self._show_error("实体光照参数必须是有效数字。")
            return False
        parsed["width"] = max(0.001, parsed["width"])
        parsed["height"] = max(0.001, parsed["height"])
        parsed["bulge"] = max(0.0, min(1.0, parsed["bulge"]))
        parsed["move_step"] = max(0.0001, parsed["move_step"])
        parsed["step"] = max(0.1, parsed["step"])
        parsed["max_distance"] = max(0.0, parsed["max_distance"])
        parsed["front"] = max(0.0, parsed["front"])
        parsed["back"] = max(0.0, parsed["back"])
        normal = np.array([
            parsed["normal_x"], parsed["normal_y"], parsed["normal_z"],
        ], dtype=np.float64)
        normal_length = float(np.linalg.norm(normal))
        if not np.isfinite(normal_length) or normal_length < 1e-6:
            self._sync_lighting_entries()
            if not silent:
                self._show_error("主法线不能是零向量，且三个分量必须为有限数值。")
            return False
        normal /= normal_length
        parsed["normal_x"], parsed["normal_y"], parsed["normal_z"] = normal.tolist()
        for key, variable in variables.items():
            variable.set(parsed[key])
        self._lighting_position_initialized = True
        self._lighting_size_initialized = True
        self._lighting_size_auto = False
        self._sync_lighting_entries()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        return True

    def _current_quad_settings(self) -> QuadSettings:
        uniform_scale = max(0.1, min(5.0, self.lighting_uniform_scale_var.get()))
        return QuadSettings(
            foot_world=(
                self.lighting_x_var.get(),
                self.lighting_y_var.get(),
                self.lighting_z_var.get(),
            ),
            width=max(0.001, self.lighting_width_var.get() * uniform_scale),
            height=max(0.001, self.lighting_height_var.get() * uniform_scale),
            bulge_ratio=max(0.0, self.lighting_bulge_var.get()),
            main_normal_local=(
                self.lighting_normal_x_var.get(),
                self.lighting_normal_y_var.get(),
                self.lighting_normal_z_var.get(),
            ),
            calculation_height=max(8, int(self.lighting_calc_height_var.get())),
        )

    def _current_gather_settings(self) -> FinalGatherSettings:
        miss_mode = self._LIGHTING_MISS_LABELS.get(
            self.lighting_miss_mode_var.get(), MISS_BLACK,
        )
        return FinalGatherSettings(
            samples_per_pixel=max(1, int(self.lighting_spp_var.get())),
            step_pixels=max(0.1, self.lighting_step_pixels_var.get()),
            max_distance=max(0.0, self.lighting_max_distance_var.get()),
            front_epsilon_pixels=max(0.0, self.lighting_front_epsilon_var.get()),
            back_thickness_pixels=max(0.0, self.lighting_back_thickness_var.get()),
            scene_exposure_ev=self.lighting_scene_ev_var.get(),
            miss_mode=miss_mode,
            visual_ray_budget=3000,
        )

    def _player_display_size_world(self) -> tuple[float, float]:
        manifest = self._load_player_manifest()
        display_width = float(manifest["worldWidth"])
        display_height = float(manifest["worldHeight"])
        if display_width <= 0.0 or display_height <= 0.0:
            raise ValueError("主角 worldWidth/worldHeight 必须大于零")
        ppu = max(1.0, self.cam_ppu_var.get())
        return display_width / ppu, display_height / ppu

    def _update_lighting_size_label(self) -> None:
        if not hasattr(self, "_lighting_size_label"):
            return
        scale = max(0.1, min(5.0, self.lighting_uniform_scale_var.get()))
        width = max(0.001, self.lighting_width_var.get() * scale)
        height = max(0.001, self.lighting_height_var.get() * scale)
        ppu = max(1.0, self.cam_ppu_var.get())
        mode = "主角尺寸自动换算" if self._lighting_size_auto else "手动基础尺寸"
        self._lighting_size_label.configure(
            text=(
                f"最终 {width:.4g} × {height:.4g} world｜"
                f"投影约 {width * ppu:.0f} × {height * ppu:.0f} px｜{mode}"
            )
        )

    def _normalized_lighting_main_normal(self) -> np.ndarray:
        normal = np.array([
            self.lighting_normal_x_var.get(),
            self.lighting_normal_y_var.get(),
            self.lighting_normal_z_var.get(),
        ], dtype=np.float64)
        length = float(np.linalg.norm(normal))
        if not np.isfinite(length) or length < 1e-6:
            return np.array([0.0, 0.0, -1.0], dtype=np.float64)
        return normal / length

    def _update_lighting_normal_label(self) -> None:
        if not hasattr(self, "_lighting_normal_label"):
            return
        nx, ny, nz = self._normalized_lighting_main_normal()
        self._lighting_normal_label.configure(
            text=(
                f"归一化 N = ({nx:+.3f}, {ny:+.3f}, {nz:+.3f})｜"
                "只改变光照；黄色箭头显示伪世界方向"
            )
        )

    def _reset_lighting_main_normal(self) -> None:
        self.lighting_normal_x_var.set(0.0)
        self.lighting_normal_y_var.set(0.0)
        self.lighting_normal_z_var.set(-1.0)
        self._sync_lighting_entries()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        self._set_status("角色主法线已恢复为朝向相机；Quad 几何位置与朝向未改变。")

    def _match_lighting_player_size(self) -> None:
        try:
            width, height = self._player_display_size_world()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self._show_error(f"无法读取主角游戏尺寸：{exc}")
            return
        self.lighting_width_var.set(width)
        self.lighting_height_var.set(height)
        self.lighting_uniform_scale_var.set(1.0)
        self.lighting_move_step_var.set(max(0.0001, 10.0 / max(1.0, self.cam_ppu_var.get())))
        self._lighting_size_initialized = True
        self._lighting_size_auto = True
        self._sync_lighting_entries()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        self._set_status("角色 Quad 已按主角 worldWidth/worldHeight 匹配当前深度相机。")

    def _initialize_lighting_size_from_player(self) -> None:
        if self._cached_mesh_xyz is None:
            return
        if self._lighting_size_initialized and not self._lighting_size_auto:
            return
        try:
            width, height = self._player_display_size_world()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return
        self.lighting_width_var.set(width)
        self.lighting_height_var.set(height)
        self.lighting_move_step_var.set(max(0.0001, 10.0 / max(1.0, self.cam_ppu_var.get())))
        self._lighting_size_initialized = True
        self._lighting_size_auto = True
        self._sync_lighting_entries()

    def _on_lighting_uniform_scale_changed(self) -> None:
        if not hasattr(self, "gl_viewer"):
            return
        self._update_lighting_size_label()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()

    def _nudge_lighting_axis(self, axis: str, direction: int) -> None:
        variable = {
            "x": self.lighting_x_var,
            "y": self.lighting_y_var,
            "z": self.lighting_z_var,
        }.get(axis)
        if variable is None:
            return
        entry = self._lighting_entries.get("move_step")
        if entry is not None:
            try:
                step = max(0.0001, float(entry.get()))
            except ValueError:
                step = self.lighting_move_step_var.get()
            self.lighting_move_step_var.set(step)
        else:
            step = self.lighting_move_step_var.get()
        variable.set(variable.get() + (1 if direction >= 0 else -1) * step)
        self._lighting_position_initialized = True
        self._sync_lighting_entries()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()
        self._set_status(
            "角色 Quad："
            f"X={self.lighting_x_var.get():.4g} "
            f"Y={self.lighting_y_var.get():.4g} "
            f"Z={self.lighting_z_var.get():.4g}"
        )

    def _scale_lighting_uniform(self, factor: float) -> None:
        scale = self.lighting_uniform_scale_var.get() * float(factor)
        self.lighting_uniform_scale_var.set(max(0.1, min(5.0, scale)))

    def _on_lighting_viewport_key(self, keysym: str) -> bool:
        if not self.lighting_quad_enabled_var.get() or self.edit_tool_var.get() != TOOL_NONE:
            return False
        key = keysym.lower()
        movements = {
            "a": ("x", -1), "d": ("x", 1),
            "q": ("y", -1), "e": ("y", 1),
            "w": ("z", -1), "s": ("z", 1),
        }
        if key in movements:
            axis, direction = movements[key]
            self._nudge_lighting_axis(axis, direction)
            return True
        if key in ("-", "_"):
            self._scale_lighting_uniform(1.0 / 1.1)
            return True
        if key in ("+", "="):
            self._scale_lighting_uniform(1.1)
            return True
        return False

    def _refresh_lighting_quad(self) -> None:
        if self.source_image is None or self.calibrated_depth is None:
            return
        try:
            projection = self._build_M()
            quad = build_quad_samples(
                self._lighting_sprite, projection, self._current_quad_settings(),
            )
        except (ValueError, TypeError):
            return
        if self.lighting_show_shaded_var.get() and self._lighting_result is not None:
            image = display_relative_rgba(
                self._lighting_result.shaded_linear_hdr,
                self._lighting_result.quad.alpha,
                self._current_hdr_settings(),
            )
            corners = self._lighting_result.quad.corners_world
            main_normal = self._lighting_result.quad.main_normal_world
        else:
            image = Image.fromarray(
                np.round(np.clip(quad.rgba, 0.0, 1.0) * 255.0).astype(np.uint8), "RGBA",
            )
            corners = quad.corners_world
            main_normal = quad.main_normal_world
        self.gl_viewer.set_lighting_quad(
            corners,
            image,
            enabled=self.lighting_quad_enabled_var.get(),
            surface_world=quad.points_world,
            main_normal_world=main_normal,
        )

    def _place_lighting_quad_at_mesh_center(self) -> None:
        if self._cached_mesh_xyz is None:
            self._set_status("请先生成深度 Mesh。")
            return
        X, Y, Z = self._cached_mesh_xyz
        self.lighting_x_var.set(float(np.median(X)))
        self.lighting_y_var.set(float(np.median(Y)))
        self.lighting_z_var.set(float(np.median(Z)))
        self.lighting_move_step_var.set(max(0.0001, 10.0 / max(1.0, self.cam_ppu_var.get())))
        self._lighting_position_initialized = True
        self._sync_lighting_entries()
        self._invalidate_lighting_result()
        self._refresh_lighting_quad()

    def _initialize_lighting_position_from_mesh(self) -> None:
        if self._lighting_position_initialized or self._cached_mesh_xyz is None:
            return
        X, Y, Z = self._cached_mesh_xyz
        self.lighting_x_var.set(float(np.median(X)))
        self.lighting_y_var.set(float(np.median(Y)))
        self.lighting_z_var.set(float(np.median(Z)))
        self.lighting_move_step_var.set(max(0.0001, 10.0 / max(1.0, self.cam_ppu_var.get())))
        self._lighting_position_initialized = True
        self._sync_lighting_entries()

    def _invalidate_lighting_result(self) -> None:
        self._lighting_generation += 1
        self._lighting_result = None
        self.gl_viewer.clear_lighting_rays()
        if hasattr(self, "_lighting_metrics_label"):
            self._lighting_metrics_label.configure(text="参数已变化，请重新计算。")

    def _calculate_entity_lighting(self) -> None:
        if self.source_image is None or self.calibrated_depth is None:
            messagebox.showinfo("提示", "请先加载背景并生成有效深度 Mesh。")
            return
        if not self._commit_lighting_fields(silent=True):
            self._show_error("实体光照参数无效。")
            return
        token = self._lighting_generation
        source = self.source_image.copy()
        depth = np.asarray(self.calibrated_depth, dtype=np.float32).copy()
        sprite = self._lighting_sprite.copy()
        projection = self._build_M()
        quad_settings = self._current_quad_settings()
        gather_settings = self._current_gather_settings()
        hdr_result = self._current_hdr_result()
        if hdr_result is None:
            self._show_error("HDR 场景辐射度尚未准备好。")
            return
        # Trace the unclipped linear HDR field.  Tone mapping is display-only and
        # never fed back into the ray marcher.
        scene_radiance = hdr_result.radiance_relative.copy()
        self._set_status(
            f"正在计算实体光照：{gather_settings.samples_per_pixel} SPP...",
        )

        def worker() -> None:
            try:
                result = compute_final_gather(
                    source, depth, sprite, projection, quad_settings, gather_settings,
                    scene_radiance=scene_radiance,
                )
            except Exception as exc:
                message = str(exc)
                self.root.after(0, lambda: self._on_lighting_failed(token, message))
                return
            self.root.after(0, lambda: self._on_lighting_done(token, result))

        threading.Thread(target=worker, daemon=True).start()

    def _on_lighting_failed(self, token: int, message: str) -> None:
        if token != self._lighting_generation:
            return
        self._show_error(f"实体光照计算失败：{message}")

    def _on_lighting_done(self, token: int, result: FinalGatherResult) -> None:
        if token != self._lighting_generation:
            return
        self._lighting_result = result
        self.lighting_show_shaded_var.set(True)
        self.gl_viewer.set_lighting_rays(
            result.ray_origins_world,
            result.ray_endpoints_world,
            result.ray_fates,
            result.ray_toward_background,
        )
        self._refresh_lighting_quad()
        self._on_lighting_ray_filter_changed()
        metrics = result.metrics
        fates = metrics.get("fates_percent", {})
        self._lighting_metrics_label.configure(
            text=(
                f"{metrics.get('seconds', 0.0):.2f}s｜"
                f"{metrics.get('ray_count', 0):,} rays｜"
                f"hit {float(fates.get('hit', 0.0)):.1f}%｜"
                f"exit {float(fates.get('exit', 0.0)):.1f}%｜"
                f"range {float(fates.get('range', 0.0)):.1f}%"
            ),
        )
        self._set_status("实体光照计算完成；可切换着色、射线类型、方向与透视显示。")

    def _on_lighting_view_changed(self) -> None:
        self.gl_viewer.set_lighting_quad_enabled(self.lighting_quad_enabled_var.get())
        self.gl_viewer.set_lighting_ray_visibility(self.lighting_show_rays_var.get())
        self._refresh_lighting_quad()
        self._on_lighting_ray_filter_changed()

    def _on_lighting_ray_filter_changed(self) -> None:
        direction = self._LIGHTING_DIRECTION_LABELS.get(
            self.lighting_direction_filter_var.get(), "all",
        )
        try:
            limit = int(self.lighting_ray_limit_var.get())
        except ValueError:
            limit = 1200
        self.gl_viewer.set_lighting_ray_filters(
            show_hit=self.lighting_show_hit_var.get(),
            show_exit=self.lighting_show_exit_var.get(),
            show_range=self.lighting_show_range_var.get(),
            direction_filter=direction,
            limit=limit,
            xray=self.lighting_xray_var.get(),
        )
        self.gl_viewer.set_lighting_ray_visibility(self.lighting_show_rays_var.get())

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
        if tool in (TOOL_BRUSH, TOOL_ERASER):
            self._set_status("碰撞编辑: 左键涂抹  右键拖=旋转  中键拖=平移  选「无」后左键拖=旋转")
        elif tool == TOOL_POLYGON:
            self._set_status("多边形: 左键加点  右键单击/Enter=闭合  Esc=取消  右键拖=旋转")
        elif tool in _DEPTH_TOOLS:
            self._set_status("深度编辑: 左键涂抹  右键拖=旋转  中键拖=平移  选「无」后左键拖=旋转")
        else:
            self._set_status("导航: 左键拖=旋转  右键/中键拖=平移  滚轮=缩放")

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

    # ==================================================================
    # Ground fit → auto collision
    # ==================================================================

    # ---- 地面拟合预览：仅测试/可视化；不写碰撞、不写导出、不碰运行时 ----

    def _open_ground_fit_preview(self) -> None:
        if self._cached_mesh_xyz is None or self.source_image is None:
            self._set_status("请先加载背景图并生成深度")
            return
        if self._ground_window is not None and self._ground_window.winfo_exists():
            self._ground_window.focus_force()
            self._refresh_ground_fit_preview()
            return
        win = tk.Toplevel(self.root)
        win.title("地面拟合预览  绿=贴地 红=凸起  (仅测试，不改任何数据)")
        self._ground_window = win
        self._ground_label = tk.Label(win)
        self._ground_label.pack(fill="both", expand=True)
        win.protocol("WM_DELETE_WINDOW", self._close_ground_fit_preview)
        self._refresh_ground_fit_preview()
        win.focus_force()

    def _close_ground_fit_preview(self) -> None:
        if self._ground_window is not None:
            self._ground_window.destroy()
            self._ground_window = None
            self._ground_label = None

    def _refresh_ground_fit_preview(self) -> None:
        if self._cached_mesh_xyz is None or self.source_image is None:
            return
        if self._ground_window is None or not self._ground_window.winfo_exists():
            return
        X, Y, Z = self._cached_mesh_xyz
        _G, _x0, _z0, _cell, height_above = fit_ground_surface(X, Y, Z)
        hi = max(1e-6, self.ground_height_threshold_var.get())
        h = np.clip(height_above / hi, 0.0, 1.0)
        rgba = np.zeros((h.shape[0], h.shape[1], 4), dtype=np.uint8)
        rgba[..., 0] = (h * 255).astype(np.uint8)          # 红 = 凸起
        rgba[..., 1] = ((1.0 - h) * 255).astype(np.uint8)  # 绿 = 贴地
        rgba[..., 2] = 0
        rgba[..., 3] = 130
        small = Image.fromarray(rgba, "RGBA")
        big = small.resize(self.source_image.size, Image.Resampling.BILINEAR)
        base = self.source_image.convert("RGBA")
        result = Image.alpha_composite(base, big).convert("RGB")
        self._show_ground_image(result)

        ground_ratio = float(np.mean(h < 0.5)) * 100.0
        if hasattr(self, "_ground_fit_label") and self._ground_fit_label.winfo_exists():
            self._ground_fit_label.configure(
                text=f"非平面地面已拟合(仅测试)。贴地占比≈{ground_ratio:.0f}%，"
                     f"上限 {hi:.2f}。绿=贴地、红=凸起；不改碰撞/导出。")

    def _show_ground_image(self, img: Image.Image) -> None:
        max_w, max_h = 1200, 800
        ratio = min(max_w / img.width, max_h / img.height, 1.0)
        disp = img.resize((int(img.width * ratio), int(img.height * ratio)),
                          Image.Resampling.LANCZOS)
        win = self._ground_window
        if win is not None and win.winfo_exists():
            win.geometry(f"{disp.width}x{disp.height}")
        self._ground_photo = tk.PhotoImage(disp)
        if self._ground_label is not None:
            self._ground_label.configure(image=self._ground_photo)

    def _on_ground_threshold_changed(self) -> None:
        # 仅当预览窗口打开时即时重算着色；不触碰碰撞/导出
        if self._ground_window is None or not self._ground_window.winfo_exists():
            return
        if self._ground_refresh_pending:
            return
        self._ground_refresh_pending = True
        self.root.after(80, self._do_ground_threshold_refresh)

    def _do_ground_threshold_refresh(self) -> None:
        self._ground_refresh_pending = False
        self._refresh_ground_fit_preview()

    # ---- 多边形地面标定（试验，独立 PySide 窗口；不碰碰撞/导出/运行时） ----

    def _open_ground_calib(self) -> None:
        if self.source_image is None or self.calibrated_depth is None:
            self._set_status("请先加载背景图并生成深度")
            return
        try:
            from .ground_calib import GroundCalibDialog
        except Exception as exc:
            self._show_error(f"地面标定窗口加载失败：{exc}")
            return
        self._ground_calib_dlg = GroundCalibDialog(
            self.source_image, self.calibrated_depth)
        self._ground_calib_dlg.show()
        self._set_status("多边形地面标定（试验）：左键画地面、右键闭合、点「计算」")

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
        if e.keysym.lower() in ("w", "a", "s", "d", "q", "e", "-", "_", "+", "="):
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
        self._invalidate_lighting_result()
        self._set_depth_cache_state("stale", "深度已在软件内编辑，尚未保存到缓存")
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

        # 绑定了游戏场景 id：导出目标确定，无需手选文件夹。
        if self._bound_scene_id:
            try:
                dst_path = self._paths.scene_runtime_dir(self._bound_scene_id)
                dst_path.mkdir(parents=True, exist_ok=True)
                scene_json_path = self._paths.scene_json_path(self._bound_scene_id)
            except (ValueError, OSError) as exc:
                messagebox.showerror("错误", f"无法解析场景 {self._bound_scene_id} 的导出路径：{exc}")
                return

        if dst_path is None:
            resolved = self._resolve_game_export_dir()
            if resolved is not None and resolved.is_dir():
                ok, msg_or_json = self._validate_export_target(resolved)
                if ok:
                    dst_path = resolved
                    scene_json_path = Path(msg_or_json)

        if dst_path is None:
            picked = filedialog.askdirectory(
                title="选择场景媒体目录（必须位于 public/resources/runtime/scenes/<id>；场景 JSON 写到 public/assets/scenes/<id>.json）",
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

        # 背景图单一真源：绑定项目时由主编辑器拥有，深度导出不回写，避免用工作副本
        # 覆盖游戏背景（遗留文件夹模式仍按旧逻辑写出自带的背景图）。
        if not self._bound_scene_id:
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

        self._occlusion_photo = _make_photo_image(display)
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
        if "cx" in cam or "cy" in cam:
            self._camera_center_from_calibration = True
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
        name = tk.simpledialog.askstring("保存 Preset", "请输入 Preset 名称:", parent=self.root)
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
    import argparse

    parser = argparse.ArgumentParser(description="场景深度重建工具")
    parser.add_argument(
        "--project", dest="project", default=None,
        help="GameDraft 工程根目录（缺省自动定位仓库根）。")
    parser.add_argument(
        "--scene", dest="scene", default=None,
        help="启动后自动打开的场景 id（来自 public/assets/scenes/<id>.json）。")
    args, _ = parser.parse_known_args()

    project_root = Path(args.project).resolve() if args.project else None
    app = SceneDepthEditorApp(project_root=project_root)
    if args.scene:
        app.open_scene_by_id_safe(args.scene)
    app.run()


if __name__ == "__main__":
    main()
