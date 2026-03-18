from __future__ import annotations

import math
import tkinter as tk
from collections import deque
from typing import Callable

from PIL import Image, ImageDraw, ImageFilter, ImageTk

from .mask_utils import apply_mask_to_image


MaskChangedCallback = Callable[[], None]


class EditorCanvas(tk.Canvas):
    def __init__(self, master: tk.Misc, mask_changed: MaskChangedCallback) -> None:
        super().__init__(master, bg="#202020", highlightthickness=0, cursor="crosshair")
        self._mask_changed = mask_changed

        self._source_image: Image.Image | None = None
        self._depth_image: Image.Image | None = None
        self._mask_image: Image.Image | None = None
        self._edge_overlay_image: Image.Image | None = None
        self._preview_mode = "overlay"
        self._overlay_alpha = 110
        self._show_edge_overlay = False
        self._edge_overlay_alpha = 150

        self._zoom = 1.0
        self._min_zoom = 0.1
        self._max_zoom = 8.0
        self._pan_x = 0.0
        self._pan_y = 0.0
        self._fit_pending = False

        self._brush_size = 18
        self._brush_value = 255
        self._depth_tolerance = 20
        self._edge_barrier_gap = 10
        self._fill_radius = 64
        self._tool_mode = "depth_brush"
        self._last_paint_point: tuple[float, float] | None = None
        self._stroke_seed_point: tuple[float, float] | None = None
        self._stroke_reference_depth: float | None = None
        self._last_pan_anchor: tuple[int, int] | None = None
        self._cursor_canvas_pos: tuple[int, int] | None = None
        self._history: list[Image.Image] = []
        self._history_limit = 30

        self._canvas_image_id: int | None = None
        self._empty_text_id: int | None = None
        self._cursor_item_ids: list[int] = []
        self._base_preview_cache: Image.Image | None = None
        self._base_preview_dirty = True
        self._preview_revision = 0
        self._scaled_cache_key: tuple[int, int, int] | None = None
        self._tk_image: ImageTk.PhotoImage | None = None

        self.bind("<Configure>", self._on_resize)
        self.bind("<Motion>", self._on_mouse_move)
        self.bind("<Leave>", self._on_mouse_leave)
        self.bind("<ButtonPress-1>", self._on_left_down)
        self.bind("<B1-Motion>", self._on_left_drag)
        self.bind("<ButtonRelease-1>", self._on_left_up)
        self.bind("<ButtonPress-3>", self._on_right_down)
        self.bind("<B3-Motion>", self._on_right_drag)
        self.bind("<ButtonRelease-3>", self._on_right_up)
        self.bind("<MouseWheel>", self._on_wheel)

    def set_images(
        self,
        source_image: Image.Image | None,
        depth_image: Image.Image | None,
        mask_image: Image.Image | None,
        fit_view: bool = False,
    ) -> None:
        self._source_image = source_image
        self._depth_image = depth_image
        self._mask_image = mask_image.copy() if mask_image is not None else None
        self._history = []
        self._edge_overlay_image = self._build_edge_overlay(depth_image) if depth_image is not None else None
        self._invalidate_preview_cache()
        if fit_view:
            self._fit_pending = True
        self.refresh()

    def get_mask_image(self) -> Image.Image | None:
        if self._mask_image is None:
            return None
        return self._mask_image.copy()

    def set_preview_mode(self, mode: str) -> None:
        self._preview_mode = mode
        self._invalidate_preview_cache()
        self.refresh()

    def set_overlay_alpha(self, alpha: int) -> None:
        self._overlay_alpha = max(0, min(255, alpha))
        self._invalidate_preview_cache()
        self.refresh()

    def set_show_edge_overlay(self, show: bool) -> None:
        self._show_edge_overlay = show
        self._invalidate_preview_cache()
        self.refresh()

    def set_edge_overlay_alpha(self, alpha: int) -> None:
        self._edge_overlay_alpha = max(0, min(255, alpha))
        self._invalidate_preview_cache()
        self.refresh()

    def set_brush_size(self, brush_size: int) -> None:
        self._brush_size = max(1, brush_size)

    def set_brush_value(self, brush_value: int) -> None:
        self._brush_value = 255 if brush_value >= 128 else 0

    def set_tool_mode(self, tool_mode: str) -> None:
        self._tool_mode = tool_mode

    def set_depth_tolerance(self, depth_gap: int) -> None:
        self._depth_tolerance = max(0, depth_gap)

    def set_edge_barrier_gap(self, edge_gap: int) -> None:
        self._edge_barrier_gap = max(0, edge_gap)

    def set_fill_radius(self, fill_radius: int) -> None:
        self._fill_radius = max(1, fill_radius)

    def fit_to_view(self) -> None:
        self._fit_pending = True
        self.refresh()

    def undo(self) -> bool:
        if not self._history or self._mask_image is None:
            return False
        self._mask_image = self._history.pop()
        self._mask_changed()
        self._invalidate_preview_cache()
        self.refresh()
        return True

    def refresh(self) -> None:
        preview = self._get_base_preview()

        if preview is None:
            self._show_empty_placeholder()
            return

        self._hide_empty_placeholder()
        if self._fit_pending:
            self._fit_pending = False
            self._fit_zoom(preview)

        scaled_width = max(1, int(preview.width * self._zoom))
        scaled_height = max(1, int(preview.height * self._zoom))
        cache_key = (self._preview_revision, scaled_width, scaled_height)
        if cache_key != self._scaled_cache_key or self._tk_image is None:
            scaled = preview.resize((scaled_width, scaled_height), Image.Resampling.BILINEAR)
            self._tk_image = ImageTk.PhotoImage(scaled)
            self._scaled_cache_key = cache_key

        if self._canvas_image_id is None:
            self._canvas_image_id = self.create_image(self._pan_x, self._pan_y, image=self._tk_image, anchor="nw")
        else:
            self.coords(self._canvas_image_id, self._pan_x, self._pan_y)
            self.itemconfigure(self._canvas_image_id, image=self._tk_image)

        self._update_cursor_overlay()

    def _invalidate_preview_cache(self) -> None:
        self._base_preview_cache = None
        self._base_preview_dirty = True
        self._scaled_cache_key = None
        self._preview_revision += 1

    def _get_base_preview(self) -> Image.Image | None:
        if self._source_image is None:
            return None
        if self._base_preview_dirty or self._base_preview_cache is None:
            self._base_preview_cache = self._compose_preview()
            self._base_preview_dirty = False
        return self._base_preview_cache

    def _show_empty_placeholder(self) -> None:
        if self._canvas_image_id is not None:
            self.delete(self._canvas_image_id)
            self._canvas_image_id = None
        self._clear_cursor_overlay()
        if self._empty_text_id is None:
            self._empty_text_id = self.create_text(
                self.winfo_width() / 2,
                self.winfo_height() / 2,
                text="打开一张场景图后开始。",
                fill="#c8c8c8",
                font=("Microsoft YaHei UI", 13),
            )
        else:
            self.coords(self._empty_text_id, self.winfo_width() / 2, self.winfo_height() / 2)

    def _hide_empty_placeholder(self) -> None:
        if self._empty_text_id is not None:
            self.delete(self._empty_text_id)
            self._empty_text_id = None

    def _compose_preview(self) -> Image.Image | None:
        if self._source_image is None:
            return None

        if self._preview_mode == "depth" and self._depth_image is not None:
            return self._depth_image.convert("RGB")

        if self._preview_mode == "foreground" and self._mask_image is not None:
            cutout = apply_mask_to_image(self._source_image, self._mask_image)
            checker = Image.new("RGBA", cutout.size, (56, 56, 56, 255))
            return Image.alpha_composite(checker, cutout).convert("RGB")

        preview = self._source_image.convert("RGBA")
        if self._mask_image is None:
            return preview.convert("RGB")

        overlay = Image.new("RGBA", preview.size, (255, 60, 60, 0))
        alpha = self._mask_image.convert("L").point(
            lambda value: int(value * (self._overlay_alpha / 255.0)),
            mode="L",
        )
        overlay.putalpha(alpha)
        composed = Image.alpha_composite(preview, overlay)

        if self._show_edge_overlay and self._edge_overlay_image is not None:
            edge_overlay = self._edge_overlay_image.copy()
            edge_overlay.putalpha(self._edge_overlay_alpha)
            composed = Image.alpha_composite(composed, edge_overlay)

        return composed.convert("RGB")

    def _fit_zoom(self, preview: Image.Image) -> None:
        canvas_width = max(1, self.winfo_width())
        canvas_height = max(1, self.winfo_height())
        ratio_x = canvas_width / preview.width
        ratio_y = canvas_height / preview.height
        self._zoom = max(self._min_zoom, min(ratio_x, ratio_y, 1.0))
        drawn_w = preview.width * self._zoom
        drawn_h = preview.height * self._zoom
        self._pan_x = (canvas_width - drawn_w) / 2
        self._pan_y = (canvas_height - drawn_h) / 2

    def _on_resize(self, _event: tk.Event) -> None:
        if self._source_image is not None and self._zoom <= 1.0:
            self._fit_pending = True
        self.refresh()

    def _on_left_down(self, event: tk.Event) -> None:
        point = self._canvas_to_image(event.x, event.y)
        if point is None:
            return
        self._push_history_state()
        self._stroke_seed_point = point
        self._stroke_reference_depth = self._depth_at_point(point) if self._depth_image else None

        if self._tool_mode == "depth_fill":
            self._apply_depth_fill(point)
            self._last_paint_point = None
            self._stroke_seed_point = None
            self._stroke_reference_depth = None
            return

        self._last_paint_point = point
        self._paint_line(point, point)

    def _on_left_drag(self, event: tk.Event) -> None:
        point = self._canvas_to_image(event.x, event.y)
        if point is None or self._last_paint_point is None:
            return
        self._paint_line(self._last_paint_point, point)
        self._last_paint_point = point

    def _on_left_up(self, _event: tk.Event) -> None:
        self._last_paint_point = None
        self._stroke_seed_point = None
        self._stroke_reference_depth = None

    def _depth_at_point(self, point: tuple[float, float]) -> float | None:
        if self._depth_image is None:
            return None
        w, h = self._depth_image.size
        x, y = int(round(point[0])), int(round(point[1]))
        if x < 0 or x >= w or y < 0 or y >= h:
            return None
        return float(self._depth_image.getpixel((x, y)))

    def _paint_line(self, start: tuple[float, float], end: tuple[float, float]) -> None:
        if self._mask_image is None:
            return

        num_steps = max(1, int(math.hypot(end[0] - start[0], end[1] - start[1])) * 2)
        for i in range(num_steps + 1):
            t = i / num_steps
            cx = start[0] + t * (end[0] - start[0])
            cy = start[1] + t * (end[1] - start[1])
            if self._tool_mode == "normal" or self._depth_image is None:
                self._apply_normal_stamp(cx, cy)
            else:
                self._apply_depth_guided_stamp(cx, cy)

        self._mask_changed()
        self._invalidate_preview_cache()
        self.refresh()

    def _apply_normal_stamp(self, cx: float, cy: float) -> None:
        if self._mask_image is None:
            return
        draw = ImageDraw.Draw(self._mask_image)
        radius = max(1, self._brush_size // 2)
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            fill=self._brush_value,
        )

    def _apply_depth_guided_stamp(self, cx: float, cy: float) -> None:
        if self._mask_image is None or self._depth_image is None:
            return

        center = (int(round(cx)), int(round(cy)))
        center_depth = self._depth_at_point((cx, cy))
        if self._stroke_reference_depth is not None and center_depth is not None:
            if abs(center_depth - self._stroke_reference_depth) > self._edge_barrier_gap:
                return

        pixels = self._collect_depth_connected_pixels(
            center,
            max(1, self._brush_size // 2),
            reference_depth=self._stroke_reference_depth,
        )
        for px, py in pixels:
            self._mask_image.putpixel((px, py), self._brush_value)

    def _apply_depth_fill(self, point: tuple[float, float]) -> None:
        if self._mask_image is None or self._depth_image is None:
            return

        center = (int(round(point[0])), int(round(point[1])))
        pixels = self._collect_depth_connected_pixels(
            center,
            self._fill_radius,
            reference_depth=self._stroke_reference_depth,
        )
        for px, py in pixels:
            self._mask_image.putpixel((px, py), self._brush_value)

        self._mask_changed()
        self._invalidate_preview_cache()
        self.refresh()

    def _collect_depth_connected_pixels(
        self,
        center: tuple[int, int],
        radius: int,
        reference_depth: float | None = None,
    ) -> list[tuple[int, int]]:
        if self._depth_image is None or self._mask_image is None:
            return []

        w, h = self._mask_image.size
        cx, cy = center
        if cx < 0 or cx >= w or cy < 0 or cy >= h:
            return []

        depth_data = self._depth_image.load()
        seed_depth = float(depth_data[cx, cy])
        if reference_depth is None:
            reference_depth = seed_depth
        tolerance = self._depth_tolerance
        barrier = self._edge_barrier_gap
        radius_sq = radius * radius

        queue = deque([(cx, cy)])
        visited: set[tuple[int, int]] = {(cx, cy)}
        accepted: list[tuple[int, int]] = []

        while queue:
            px, py = queue.popleft()
            current_depth = float(depth_data[px, py])

            if abs(current_depth - reference_depth) > tolerance:
                continue

            accepted.append((px, py))

            for nx, ny in ((px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)):
                if nx < 0 or nx >= w or ny < 0 or ny >= h:
                    continue
                if (nx, ny) in visited:
                    continue
                if (nx - cx) * (nx - cx) + (ny - cy) * (ny - cy) > radius_sq:
                    continue

                neighbor_depth = float(depth_data[nx, ny])
                if abs(neighbor_depth - current_depth) > barrier:
                    continue
                if abs(neighbor_depth - reference_depth) > tolerance:
                    continue

                visited.add((nx, ny))
                queue.append((nx, ny))

        return accepted

    def _on_right_down(self, event: tk.Event) -> None:
        self._last_pan_anchor = (event.x, event.y)
        self.configure(cursor="fleur")

    def _on_right_drag(self, event: tk.Event) -> None:
        if self._last_pan_anchor is None:
            return
        dx = event.x - self._last_pan_anchor[0]
        dy = event.y - self._last_pan_anchor[1]
        self._pan_x += dx
        self._pan_y += dy
        self._last_pan_anchor = (event.x, event.y)
        self.refresh()

    def _on_right_up(self, _event: tk.Event) -> None:
        self._last_pan_anchor = None
        self.configure(cursor="crosshair")

    def _on_mouse_move(self, event: tk.Event) -> None:
        self._cursor_canvas_pos = (event.x, event.y)
        self._update_cursor_overlay()

    def _on_mouse_leave(self, _event: tk.Event) -> None:
        self._cursor_canvas_pos = None
        self._clear_cursor_overlay()

    def _on_wheel(self, event: tk.Event) -> None:
        preview = self._get_base_preview()
        if preview is None:
            return

        factor = 1.1 if event.delta > 0 else 0.9
        next_zoom = max(self._min_zoom, min(self._max_zoom, self._zoom * factor))
        if abs(next_zoom - self._zoom) < 1e-6:
            return

        image_x = (event.x - self._pan_x) / self._zoom
        image_y = (event.y - self._pan_y) / self._zoom
        self._zoom = next_zoom
        self._pan_x = event.x - image_x * self._zoom
        self._pan_y = event.y - image_y * self._zoom
        self.refresh()

    def _canvas_to_image(self, x: int, y: int) -> tuple[float, float] | None:
        if self._source_image is None:
            return None

        image_x = (x - self._pan_x) / self._zoom
        image_y = (y - self._pan_y) / self._zoom
        if image_x < 0 or image_y < 0:
            return None
        if image_x >= self._source_image.width or image_y >= self._source_image.height:
            return None
        return image_x, image_y

    def _push_history_state(self) -> None:
        if self._mask_image is None:
            return
        self._history.append(self._mask_image.copy())
        if len(self._history) > self._history_limit:
            self._history.pop(0)

    def _clear_cursor_overlay(self) -> None:
        for item_id in self._cursor_item_ids:
            self.delete(item_id)
        self._cursor_item_ids.clear()

    def _update_cursor_overlay(self) -> None:
        self._clear_cursor_overlay()
        if self._cursor_canvas_pos is None or self._source_image is None:
            return

        point = self._canvas_to_image(*self._cursor_canvas_pos)
        if point is None:
            return

        radius = self._fill_radius if self._tool_mode == "depth_fill" else max(1, self._brush_size // 2)
        radius_px = radius * self._zoom
        cx, cy = self._cursor_canvas_pos
        outline = "#66d9ef" if self._tool_mode != "normal" else "#f8f8f2"
        dash = (4, 2) if self._tool_mode == "depth_fill" else None
        oval_id = self.create_oval(
            cx - radius_px,
            cy - radius_px,
            cx + radius_px,
            cy + radius_px,
            outline=outline,
            width=2,
            dash=dash,
        )
        label_id = self.create_text(
            cx,
            cy - radius_px - 12,
            text=str(radius * 2),
            fill=outline,
            font=("Microsoft YaHei UI", 9),
        )
        self._cursor_item_ids.extend([oval_id, label_id])

    def _build_edge_overlay(self, depth_image: Image.Image | None) -> Image.Image | None:
        if depth_image is None:
            return None

        edge_mask = depth_image.convert("L").filter(ImageFilter.FIND_EDGES)
        edge_mask = edge_mask.point(lambda value: 255 if value >= 20 else 0, mode="L")
        rgba = Image.new("RGBA", depth_image.size, (0, 255, 255, 0))
        rgba.putalpha(edge_mask)
        return rgba

