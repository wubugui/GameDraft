from __future__ import annotations

import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from PIL import Image

from .depth_estimator import MODEL_OPTIONS, DepthEstimator
from .editor_canvas import EditorCanvas
from .mask_utils import apply_mask_to_image, build_foreground_mask, AutoMaskSettings


class SceneDepthEditorApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("场景深度蒙版编辑工具")
        self.root.geometry("1200x820")
        self.root.minsize(1000, 680)

        self.depth_estimator = DepthEstimator()

        self.image_path: Path | None = None
        self.source_image: Image.Image | None = None
        self.depth_image: Image.Image | None = None
        self.mask_image: Image.Image | None = None
        self.auto_mask_image: Image.Image | None = None

        self.status_var = tk.StringVar(value="打开场景图后先计算深度图，再用深度约束画笔或局部填充精修。")
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

        self._build_ui()
        self.brush_size_var.trace_add("write", self._on_brush_size_changed)
        self.overlay_alpha_var.trace_add("write", self._on_overlay_alpha_changed)
        self.edge_overlay_alpha_var.trace_add("write", self._on_edge_overlay_alpha_changed)
        self.depth_tolerance_var.trace_add("write", self._on_depth_tolerance_changed)
        self.edge_barrier_var.trace_add("write", self._on_edge_barrier_changed)
        self.fill_radius_var.trace_add("write", self._on_fill_radius_changed)
        self.root.bind_all("<Control-z>", self._on_undo_shortcut)
        self.root.bind_all("<Control-Z>", self._on_undo_shortcut)

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

        status_bar = ttk.Label(self.root, textvariable=self.status_var, padding=(12, 4))
        status_bar.grid(row=1, column=0, columnspan=2, sticky="ew")

        top_actions = ttk.Frame(control_frame)
        top_actions.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        top_actions.columnconfigure(0, weight=1)
        top_actions.columnconfigure(1, weight=1)
        ttk.Button(top_actions, text="打开场景图", command=self.open_image).grid(
            row=0, column=0, sticky="ew", padx=(0, 4)
        )
        ttk.Button(top_actions, text="适配画布", command=self.canvas.fit_to_view).grid(
            row=0, column=1, sticky="ew", padx=(4, 0)
        )

        self.image_label = ttk.Label(
            control_frame,
            text="未选择图片",
            wraplength=260,
            justify="left",
        )
        self.image_label.grid(row=1, column=0, sticky="ew", pady=(0, 8))

        notebook = ttk.Notebook(control_frame)
        notebook.grid(row=2, column=0, sticky="nsew")

        depth_tab = ttk.Frame(notebook, padding=8)
        depth_tab.columnconfigure(0, weight=1)
        notebook.add(depth_tab, text="深度")

        edit_tab = ttk.Frame(notebook, padding=8)
        edit_tab.columnconfigure(0, weight=1)
        notebook.add(edit_tab, text="画笔")

        preview_tab = ttk.Frame(notebook, padding=8)
        preview_tab.columnconfigure(0, weight=1)
        notebook.add(preview_tab, text="预览/导出")

        depth_box = ttk.LabelFrame(depth_tab, text="深度图")
        depth_box.grid(row=0, column=0, sticky="ew")
        depth_box.columnconfigure(0, weight=1)

        ttk.Label(depth_box, text="模型").grid(row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        self.depth_model_combo = ttk.Combobox(
            depth_box,
            state="readonly",
            values=[f"{key} - {value}" for key, value in MODEL_OPTIONS.items()],
            width=34,
        )
        self.depth_model_combo.current(0)
        self.depth_model_combo.grid(row=1, column=0, sticky="ew", padx=8, pady=(0, 8))

        ttk.Button(depth_box, text="计算深度图", command=self.generate_depth).grid(
            row=2, column=0, sticky="ew", padx=8, pady=(0, 8)
        )
        ttk.Button(depth_box, text="从深度生成初始蒙版", command=self.build_mask_from_depth).grid(
            row=3, column=0, sticky="ew", padx=8, pady=(0, 8)
        )
        ttk.Button(depth_box, text="恢复到初始蒙版", command=self.restore_auto_mask).grid(
            row=4, column=0, sticky="ew", padx=8, pady=(0, 8)
        )

        edit_box = ttk.LabelFrame(edit_tab, text="手工精修")
        edit_box.grid(row=0, column=0, sticky="ew")
        edit_box.columnconfigure(0, weight=1)

        ttk.Label(edit_box, text="绘制内容").grid(row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        ttk.Radiobutton(
            edit_box,
            text="添加前景",
            variable=self.paint_value_var,
            value="add",
            command=self._sync_brush_mode,
        ).grid(row=1, column=0, sticky="w", padx=8, pady=(0, 4))
        ttk.Radiobutton(
            edit_box,
            text="擦除前景",
            variable=self.paint_value_var,
            value="erase",
            command=self._sync_brush_mode,
        ).grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))

        ttk.Label(edit_box, text="工具模式").grid(row=3, column=0, sticky="w", padx=8, pady=(8, 4))
        ttk.Radiobutton(
            edit_box,
            text="普通画笔",
            variable=self.tool_mode_var,
            value="normal",
            command=self._sync_tool_mode,
        ).grid(row=4, column=0, sticky="w", padx=8, pady=(0, 4))
        ttk.Radiobutton(
            edit_box,
            text="深度约束画笔",
            variable=self.tool_mode_var,
            value="depth_brush",
            command=self._sync_tool_mode,
        ).grid(row=5, column=0, sticky="w", padx=8, pady=(0, 4))
        ttk.Radiobutton(
            edit_box,
            text="深度局部填充（单击）",
            variable=self.tool_mode_var,
            value="depth_fill",
            command=self._sync_tool_mode,
        ).grid(row=6, column=0, sticky="w", padx=8, pady=(0, 4))

        self._add_scale(edit_box, "画笔大小", self.brush_size_var, 7, 1, 200)
        self._add_scale(edit_box, "深度容差", self.depth_tolerance_var, 9, 0, 80)
        self._add_scale(edit_box, "边界阻断阈值", self.edge_barrier_var, 11, 0, 80)
        self._add_scale(edit_box, "局部填充半径", self.fill_radius_var, 13, 4, 256)

        preview_box = ttk.LabelFrame(preview_tab, text="预览")
        preview_box.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        preview_box.columnconfigure(0, weight=1)

        for row_idx, (text, value) in enumerate(
            [
                ("原图 + 蒙版", "overlay"),
                ("深度图", "depth"),
                ("前景扣图预览", "foreground"),
            ]
        ):
            ttk.Radiobutton(
                preview_box,
                text=text,
                variable=self.view_var,
                value=value,
                command=self._update_preview_mode,
            ).grid(row=row_idx, column=0, sticky="w", padx=8, pady=(8 if row_idx == 0 else 0, 4))

        self._add_scale(preview_box, "蒙版透明度", self.overlay_alpha_var, 3, 0, 255)
        ttk.Checkbutton(
            preview_box,
            text="显示深度边界辅助线",
            variable=self.show_edge_overlay_var,
            command=self._on_edge_overlay_toggle,
        ).grid(row=5, column=0, sticky="w", padx=8, pady=(4, 4))
        self._add_scale(preview_box, "边界辅助线透明度", self.edge_overlay_alpha_var, 6, 0, 255)

        export_box = ttk.LabelFrame(preview_tab, text="导出")
        export_box.grid(row=1, column=0, sticky="ew")
        export_box.columnconfigure(0, weight=1)

        ttk.Button(export_box, text="导入已有蒙版继续编辑", command=self.load_mask).grid(
            row=0, column=0, sticky="ew", padx=8, pady=(8, 4)
        )
        ttk.Button(export_box, text="保存深度图 / 蒙版 / 前景图", command=self.save_outputs).grid(
            row=1, column=0, sticky="ew", padx=8, pady=(4, 8)
        )

        self._sync_brush_mode()
        self._sync_tool_mode()
        self._sync_depth_tolerance()
        self._sync_edge_barrier()
        self._sync_fill_radius()
        self._update_preview_mode()
        self._on_edge_overlay_toggle()

    def _add_scale(
        self,
        master: ttk.LabelFrame,
        label_text: str,
        variable,
        row: int,
        start: float,
        end: float,
        resolution: float = 1.0,
    ) -> None:
        ttk.Label(master, text=label_text).grid(row=row, column=0, sticky="w", padx=8)
        scale = tk.Scale(
            master,
            from_=start,
            to=end,
            orient="horizontal",
            resolution=resolution,
            variable=variable,
            showvalue=True,
            highlightthickness=0,
        )
        scale.grid(row=row + 1, column=0, sticky="ew", padx=8, pady=(0, 6))

    def open_image(self) -> None:
        file_path = filedialog.askopenfilename(
            title="选择场景图片",
            filetypes=[
                ("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                ("All files", "*.*"),
            ],
        )
        if not file_path:
            return

        self.image_path = Path(file_path)
        self.source_image = Image.open(self.image_path).convert("RGB")
        self.depth_image = None
        self.mask_image = Image.new("L", self.source_image.size, color=0)
        self.auto_mask_image = self.mask_image.copy()

        self.image_label.configure(text=str(self.image_path))
        self._push_images_to_canvas(fit_view=True)
        self._set_status("已打开图片。请先计算深度图，再用深度约束画笔或局部填充精修。")

    def build_mask_from_depth(self) -> None:
        if self.depth_image is None:
            messagebox.showinfo("提示", "请先计算深度图。")
            return
        settings = AutoMaskSettings(threshold=170, near_is_bright=True)
        self.mask_image = build_foreground_mask(self.depth_image, settings)
        self.auto_mask_image = self.mask_image.copy()
        self._push_images_to_canvas()
        self._set_status("已从深度生成初始蒙版，可继续用画笔精修。")

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
                    self.source_image,
                    model_id=model_id,
                    status=self._set_status_threadsafe,
                )
                self.root.after(0, lambda: self._on_depth_ready(result.image))
            except Exception as exc:
                self.root.after(0, lambda: self._show_error(str(exc)))

        threading.Thread(target=worker, daemon=True).start()

    def _on_depth_ready(self, depth_image: Image.Image) -> None:
        self.depth_image = depth_image
        self._push_images_to_canvas()
        self._set_status("深度图已生成，可切到“深度图”预览查看。")

    def load_mask(self) -> None:
        if self.source_image is None:
            messagebox.showinfo("提示", "请先打开对应的场景图，再导入蒙版。")
            return

        initial_dir = str(self.image_path.parent) if self.image_path else str(Path.cwd())
        file_path = filedialog.askopenfilename(
            title="选择已有蒙版",
            initialdir=initial_dir,
            filetypes=[
                ("PNG mask", "*.png"),
                ("Image files", "*.png *.jpg *.jpeg *.webp *.bmp"),
                ("All files", "*.*"),
            ],
        )
        if not file_path:
            return

        loaded_mask = Image.open(file_path).convert("L")
        if loaded_mask.size != self.source_image.size:
            messagebox.showerror(
                "错误",
                f"蒙版尺寸与当前场景图不一致。\n场景图尺寸：{self.source_image.size}\n蒙版尺寸：{loaded_mask.size}",
            )
            return

        self.mask_image = loaded_mask
        self.auto_mask_image = loaded_mask.copy()
        self._push_images_to_canvas()
        self._set_status(f"已导入蒙版并载入编辑：{Path(file_path).name}")

    def restore_auto_mask(self) -> None:
        if self.auto_mask_image is None:
            return
        self.mask_image = self.auto_mask_image.copy()
        self._push_images_to_canvas()
        self._set_status("已恢复到自动生成的蒙版。")

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
        output_path = Path(output_dir)
        self.mask_image = current_mask
        foreground = apply_mask_to_image(self.source_image, current_mask).convert("RGBA")
        foreground_path = output_path / f"{stem}_foreground.png"

        if self.depth_image is not None:
            self.depth_image.save(output_path / f"{stem}_depth.png", format="PNG")
        current_mask.save(output_path / f"{stem}_mask.png")
        foreground.save(foreground_path, format="PNG")

        self._set_status(f"结果已保存到：{output_path}，前景图为带透明通道的 PNG。")

    def _push_images_to_canvas(self, fit_view: bool = False) -> None:
        self.canvas.set_images(
            self.source_image,
            self.depth_image,
            self.mask_image,
            fit_view=fit_view,
        )

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

