"""
滤镜工具 - Python + PIL 实现，与游戏 ColorMatrix 格式一致
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageTk

from .paths import filters_json_dir, project_root_from_filter_package
from .presets import BUILTIN_PRESETS, IDENTITY

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:
    tk = None

TOOL_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = project_root_from_filter_package()
FILTERS_DIR = filters_json_dir(PROJECT_ROOT)
CUSTOM_PRESETS_FILE = TOOL_DIR / "custom_presets.json"
FILTER_ID_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")


def _load_custom_presets() -> dict[str, list[float]]:
    if not CUSTOM_PRESETS_FILE.exists():
        return {}
    try:
        with open(CUSTOM_PRESETS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if isinstance(v, list) and len(v) == 20}
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _save_custom_presets(presets: dict[str, list[float]]) -> None:
    try:
        with open(CUSTOM_PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(presets, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def apply_color_matrix(img: Image.Image, matrix: list[float], alpha: float = 1.0) -> Image.Image:
    """应用 5x4 色彩矩阵，与 PixiJS ColorMatrixFilter 一致"""
    arr = np.array(img.convert("RGBA"), dtype=np.float32) / 255.0
    h, w = arr.shape[:2]
    pixels = arr.reshape(-1, 4)
    m = np.array(matrix, dtype=np.float32).reshape(4, 5)
    ones = np.ones((pixels.shape[0], 1))
    pixels_aug = np.concatenate([pixels, ones], axis=1)
    out = np.clip((m @ pixels_aug.T).T, 0, 1)
    if alpha < 1:
        out = out * alpha + pixels * (1 - alpha)
    out = (np.clip(out, 0, 1) * 255).astype(np.uint8)
    return Image.fromarray(out.reshape(h, w, 4), mode="RGBA").convert("RGB")


def _matmul(a: list[float], b: list[float]) -> list[float]:
    """4x5 色彩矩阵乘法，与 PixiJS 一致"""
    ma = np.array(a, dtype=np.float32).reshape(4, 5)
    mb = np.array(b, dtype=np.float32).reshape(4, 5)
    ext = np.array([[0, 0, 0, 0, 1]], dtype=np.float32)
    mb5 = np.vstack([mb, ext])
    r = ma @ mb5
    return r[:, :5].flatten().tolist()


def matrix_brightness(m: list[float], v: float) -> list[float]:
    b = [v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, 1, 0]
    return _matmul(m, b)


def matrix_contrast(m: list[float], v: float) -> list[float]:
    t = 0.5 * (1 - v)
    c = [v, 0, 0, 0, t, 0, v, 0, 0, t, 0, 0, v, 0, t, 0, 0, 0, 1, 0]
    return _matmul(m, c)


def matrix_saturate(m: list[float], v: float) -> list[float]:
    s = 1 - v
    lr, lg, lb = 0.2126, 0.7152, 0.0722
    sat = [
        lr * s + v, lg * s, lb * s, 0, 0,
        lr * s, lg * s + v, lb * s, 0, 0,
        lr * s, lg * s, lb * s + v, 0, 0,
        0, 0, 0, 1, 0,
    ]
    return _matmul(m, sat)


def matrix_hue(m: list[float], deg: float) -> list[float]:
    import math
    c = math.cos(deg * math.pi / 180)
    s = math.sin(deg * math.pi / 180)
    lr, lg, lb = 0.213, 0.715, 0.072
    hue = [
        lr + c * (1 - lr) - s * lr, lg - c * lg - s * lg, lb - c * lb + s * (1 - lb), 0, 0,
        lr - c * lr + s * 0.143, lg + c * (1 - lg) + s * 0.14, lb - c * lb - s * 0.283, 0, 0,
        lr - c * lr - s * (1 - lr), lg - c * lg + s * lg, lb + c * (1 - lb) + s * lb, 0, 0,
        0, 0, 0, 1, 0,
    ]
    return _matmul(m, hue)


PRESET_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_\u4e00-\u9fa5-]+$")


class FilterToolApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("滤镜工具 - 渝都卫")
        self.root.geometry("1000x700")
        self.root.minsize(800, 550)

        self.source: Image.Image | None = None
        self.current_matrix = IDENTITY.copy()
        self.alpha_val = 1.0
        self.custom_presets: dict[str, list[float]] = _load_custom_presets()
        self.status_var = tk.StringVar(value="加载图片后调节参数，保存为 JSON 供游戏使用")

        self._build_ui()

    def _build_ui(self) -> None:
        self.root.columnconfigure(1, weight=1)
        self.root.rowconfigure(0, weight=1)

        left = ttk.Frame(self.root, padding=10)
        left.grid(row=0, column=0, sticky="ns")
        left.columnconfigure(0, weight=1)

        ttk.Button(left, text="加载图片", command=self._load_image).grid(row=0, column=0, sticky="ew", pady=(0, 8))

        ttk.Label(left, text="预制").grid(row=1, column=0, sticky="w", pady=(8, 4))
        preset_f = ttk.Frame(left)
        preset_f.grid(row=2, column=0, sticky="ew", pady=(0, 4))
        for name, (label, _) in BUILTIN_PRESETS.items():
            ttk.Button(preset_f, text=label, command=lambda n=name: self._apply_builtin_preset(n)).pack(side=tk.LEFT, padx=(0, 4))

        self.custom_preset_frame = ttk.Frame(left)
        self.custom_preset_frame.grid(row=3, column=0, sticky="ew", pady=(0, 4))
        self._refresh_custom_preset_buttons()

        add_f = ttk.Frame(left)
        add_f.grid(row=4, column=0, sticky="ew", pady=(4, 8))
        self.preset_name_var = tk.StringVar(value="")
        ttk.Entry(add_f, textvariable=self.preset_name_var, width=10).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(add_f, text="添加当前为预制", command=self._add_custom_preset).pack(side=tk.LEFT)

        ttk.Label(left, text="参数").grid(row=5, column=0, sticky="w", pady=(8, 4))
        self.brightness_var = tk.DoubleVar(value=1.0)
        self.contrast_var = tk.DoubleVar(value=1.0)
        self.saturation_var = tk.DoubleVar(value=1.0)
        self.hue_var = tk.DoubleVar(value=0.0)

        def mk_slider(row: int, var: tk.DoubleVar, label: str, from_: float, to: float):
            ttk.Label(left, text=label).grid(row=row, column=0, sticky="w")
            s = ttk.Scale(left, from_=from_, to=to, variable=var, orient=tk.HORIZONTAL, command=lambda _: self._refresh_preview())
            s.grid(row=row + 1, column=0, sticky="ew", pady=(0, 4))

        mk_slider(6, self.brightness_var, "亮度 1.0", 0.2, 2.0)
        mk_slider(8, self.contrast_var, "对比度 1.0", 0.2, 2.0)
        mk_slider(10, self.saturation_var, "饱和度 1.0", 0, 2.0)
        mk_slider(12, self.hue_var, "色相 0", -180, 180)

        ttk.Label(left, text="保存").grid(row=14, column=0, sticky="w", pady=(12, 4))
        save_f = ttk.Frame(left)
        save_f.grid(row=15, column=0, sticky="ew")
        self.filter_id_var = tk.StringVar(value="")
        ttk.Entry(save_f, textvariable=self.filter_id_var, width=16).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(save_f, text="保存滤镜", command=self._save_filter).pack(side=tk.LEFT)

        ttk.Label(self.root, textvariable=self.status_var, padding=(12, 4)).grid(
            row=1, column=0, columnspan=2, sticky="ew"
        )

        canvas_f = ttk.Frame(self.root, padding=(0, 8, 8, 8))
        canvas_f.grid(row=0, column=1, sticky="nsew")
        canvas_f.rowconfigure(0, weight=1)
        canvas_f.columnconfigure(0, weight=1)
        self.canvas = tk.Canvas(canvas_f, bg="#1a1a2e")
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self._photo: ImageTk.PhotoImage | None = None

    def _load_image(self) -> None:
        path = filedialog.askopenfilename(
            title="选择图片",
            filetypes=[("图片", "*.png *.jpg *.jpeg *.webp *.bmp"), ("全部", "*.*")],
        )
        if not path:
            return
        try:
            self.source = Image.open(path).convert("RGB")
            self.status_var.set(f"已加载: {Path(path).name}")
            self._refresh_preview()
        except Exception as e:
            messagebox.showerror("加载失败", str(e))

    def _apply_builtin_preset(self, name: str) -> None:
        _, matrix = BUILTIN_PRESETS[name]
        self.current_matrix = [float(x) for x in matrix]
        self.brightness_var.set(1.0)
        self.contrast_var.set(1.0)
        self.saturation_var.set(1.0)
        self.hue_var.set(0.0)
        self._refresh_preview()

    def _apply_custom_preset(self, name: str) -> None:
        self.current_matrix = self.custom_presets[name].copy()
        self.brightness_var.set(1.0)
        self.contrast_var.set(1.0)
        self.saturation_var.set(1.0)
        self.hue_var.set(0.0)
        self._refresh_preview()

    def _refresh_custom_preset_buttons(self) -> None:
        for w in self.custom_preset_frame.winfo_children():
            w.destroy()
        if not self.custom_presets:
            ttk.Label(self.custom_preset_frame, text="(无自定义预制)", foreground="gray").pack(anchor=tk.W)
        else:
            for name in sorted(self.custom_presets.keys()):
                row = ttk.Frame(self.custom_preset_frame)
                row.pack(side=tk.TOP, fill=tk.X, pady=1)
                ttk.Button(row, text=name, command=lambda n=name: self._apply_custom_preset(n)).pack(side=tk.LEFT, padx=(0, 4))
                ttk.Button(row, text="删", width=2, command=lambda n=name: self._remove_custom_preset(n)).pack(side=tk.LEFT)

    def _add_custom_preset(self) -> None:
        name = self.preset_name_var.get().strip()
        if not name:
            self.status_var.set("请输入预制名称")
            return
        if not PRESET_NAME_PATTERN.match(name):
            self.status_var.set("名称只能包含字母、数字、下划线、中文、连字符")
            return
        if name in BUILTIN_PRESETS:
            self.status_var.set(f"「{name}」与内置预制重名")
            return
        m = self._get_current_matrix()
        self.custom_presets[name] = m
        _save_custom_presets(self.custom_presets)
        self._refresh_custom_preset_buttons()
        self.preset_name_var.set("")
        self.status_var.set(f"已添加预制: {name}")

    def _remove_custom_preset(self, name: str) -> None:
        if name in self.custom_presets:
            del self.custom_presets[name]
            _save_custom_presets(self.custom_presets)
            self._refresh_custom_preset_buttons()
            self.status_var.set(f"已删除预制: {name}")

    def _get_current_matrix(self) -> list[float]:
        m = self.current_matrix[:]
        m = matrix_brightness(m, self.brightness_var.get())
        m = matrix_contrast(m, self.contrast_var.get())
        m = matrix_saturate(m, self.saturation_var.get())
        h = self.hue_var.get()
        if abs(h) > 0.5:
            m = matrix_hue(m, h)
        return m

    def _refresh_preview(self) -> None:
        if self.source is None:
            return
        m = self._get_current_matrix()
        out = apply_color_matrix(self.source, m, self.alpha_val)
        self._display_image(out)

    def _display_image(self, img: Image.Image) -> None:
        self.root.update_idletasks()
        cw = max(self.canvas.winfo_width(), 100)
        ch = max(self.canvas.winfo_height(), 100)
        img.thumbnail((cw, ch), Image.Resampling.LANCZOS)
        self._photo = ImageTk.PhotoImage(img)
        self.canvas.delete("all")
        self.canvas.create_image(cw // 2, ch // 2, image=self._photo)

    def _on_canvas_resize(self, event: tk.Event) -> None:
        if self.source is not None:
            self._refresh_preview()

    def _save_filter(self) -> None:
        fid = self.filter_id_var.get().strip()
        if not fid:
            self.status_var.set("请输入滤镜 ID")
            return
        if not FILTER_ID_PATTERN.match(fid):
            self.status_var.set("filterId 只能包含字母、数字、下划线、连字符")
            return
        m = self._get_current_matrix()
        FILTERS_DIR.mkdir(parents=True, exist_ok=True)
        path = FILTERS_DIR / f"{fid}.json"
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"id": fid, "matrix": m, "alpha": self.alpha_val}, f, ensure_ascii=False, indent=2)
            self.status_var.set(f"已保存: {path.relative_to(PROJECT_ROOT)}")
        except OSError as e:
            messagebox.showerror("保存失败", str(e))


def main() -> None:
    if tk is None:
        print("需要 tkinter")
        sys.exit(1)
    try:
        import numpy
    except ImportError:
        print("请安装: pip install numpy pillow")
        sys.exit(1)
    app = FilterToolApp()
    app.root.mainloop()
