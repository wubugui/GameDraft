from __future__ import annotations

import math
from typing import Callable

import numpy as np
from OpenGL.GL import *
from OpenGL.GLU import *
from PIL import Image, ImageDraw, ImageFont, ImageOps
from pyopengltk import OpenGLFrame

TOOL_NONE = "none"
TOOL_BRUSH = "brush"
TOOL_ERASER = "eraser"
TOOL_POLYGON = "polygon"
TOOL_DEPTH_RAISE = "depth_raise"
TOOL_DEPTH_LOWER = "depth_lower"
TOOL_DEPTH_SMOOTH = "depth_smooth"
_DEPTH_TOOLS = (TOOL_DEPTH_RAISE, TOOL_DEPTH_LOWER, TOOL_DEPTH_SMOOTH)


def _image_to_texture(img: Image.Image) -> int:
    """Upload PIL Image (RGBA) to OpenGL texture. Returns tex_id."""
    img = img.convert("RGBA")
    img = img.transpose(Image.FLIP_TOP_BOTTOM)
    arr = np.array(img, dtype=np.uint8)
    tex_id = glGenTextures(1)
    glBindTexture(GL_TEXTURE_2D, tex_id)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, img.width, img.height, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, arr)
    glBindTexture(GL_TEXTURE_2D, 0)
    return int(tex_id)


def _make_default_billboard_image() -> Image.Image:
    """Create a default placeholder billboard (person silhouette)."""
    from PIL import ImageDraw
    w, h = 64, 128
    img = Image.new("RGBA", (w, h), (80, 160, 255, 140))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w - 1, h - 1], outline=(255, 255, 255, 200), width=2)
    cx = w // 2
    head_r = 10
    head_cy = 22
    draw.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
                 fill=(180, 220, 255, 190))
    shoulder_y = 42
    sw, waist_y, ww = 20, 76, 12
    draw.polygon([(cx - sw, shoulder_y), (cx + sw, shoulder_y),
                  (cx + ww, waist_y), (cx - ww, waist_y)],
                 fill=(100, 180, 255, 160))
    leg_w = 6
    draw.rectangle([cx - ww, waist_y, cx - leg_w, h - 3], fill=(70, 150, 240, 150))
    draw.rectangle([cx + leg_w, waist_y, cx + ww, h - 3], fill=(70, 150, 240, 150))
    draw.line([(0, h - 2), (w - 1, h - 2)], fill=(255, 80, 80, 220), width=2)
    return img


def _make_text_texture(text: str, color: tuple[float, float, float]) -> tuple[int, int, int]:
    """Render text to OpenGL texture. Returns (tex_id, width, height) in texels."""
    for path in ("arial.ttf", "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            font = ImageFont.truetype(path, 16)
            break
        except OSError:
            continue
    else:
        font = ImageFont.load_default()
    pad = 2
    bbox = font.getbbox(text)
    w = max(16, bbox[2] - bbox[0] + pad * 2)
    h = max(16, bbox[3] - bbox[1] + pad * 2)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r, g, b = int(color[0] * 255), int(color[1] * 255), int(color[2] * 255)
    draw.text((pad, pad), text, font=font, fill=(r, g, b, 255))
    img = img.transpose(Image.FLIP_TOP_BOTTOM)
    arr = np.array(img, dtype=np.uint8)
    tex_id = glGenTextures(1)
    glBindTexture(GL_TEXTURE_2D, tex_id)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, arr)
    glBindTexture(GL_TEXTURE_2D, 0)
    return int(tex_id), w, h


class SceneGLViewer(OpenGLFrame):
    """Tkinter-embeddable OpenGL viewer for reconstructed scene meshes.

    Left-drag: orbit,  Right/Middle-drag: pan,  Scroll: zoom.
    """

    def __init__(self, master, **kw):
        super().__init__(master, **kw)
        self.animate = 16

        # Mesh GPU data
        self._vertices: np.ndarray | None = None
        self._colors: np.ndarray | None = None
        self._uvs: np.ndarray | None = None
        self._indices: np.ndarray | None = None
        self._vbo_vert = 0
        self._vbo_color = 0
        self._vbo_uv = 0
        self._ibo = 0
        self._index_count = 0
        self._gl_ready = False
        self._data_dirty = False
        self._wireframe = False

        # Mesh texture
        self._mesh_tex_id: int = 0
        self._mesh_tex_pending: Image.Image | None = None

        # Orbit camera
        self._azimuth = 135.0
        self._elevation = 25.0
        self._distance = 5.0
        self._center = np.array([0.0, 0.5, 0.0], dtype=np.float64)

        # Mouse tracking
        self._last_mx = 0
        self._last_my = 0

        # Visual helpers
        self._grid_extent = 3.0
        self._grid_major = 1.0
        self._grid_minor = 0.25
        self._axes_length = 2.0

        # Visibility toggles
        self._show_grid = True
        self._show_axes = True
        self._show_labels = True

        # Mesh stats (for status display)
        self.vertex_count = 0
        self.tri_count = 0

        # Text texture cache for axis labels
        self._label_cache: dict[str, tuple[int, int, int]] = {}

        # Billboard: standing on Y=0, movable with WASD
        self._billboard_tex_id: int | None = None
        self._billboard_pos = np.array([0.0, 0.0], dtype=np.float64)
        self._billboard_enabled = False
        self._billboard_width = 0.25
        self._billboard_height = 0.5
        self._billboard_scale = 1.0
        self._billboard_move_step = 0.1
        self._billboard_moved_cb: Callable[[float, float], None] | None = None
        self._billboard_pending_image: Image.Image | None = None

        # Calibration camera for axes (X=image right, Y=image up, Z=depth)
        self._calib_camera = None

        # Collision grid overlay
        self._collision_mask: np.ndarray | None = None
        self._collision_x_min: float = 0.0
        self._collision_z_min: float = 0.0
        self._collision_cell: float = 1.0
        self._collision_y: float = 0.0
        self._show_collision = True

        # Editing tools
        self._edit_tool: str = TOOL_NONE
        self._brush_radius: float = 0.1
        self._polygon_verts: list[tuple[float, float]] = []
        self._mouse_xz: tuple[float, float] | None = None
        self._on_edit_cb: Callable[[str, list, float], None] | None = None
        self._on_edit_end_cb: Callable[[], None] | None = None
        self._editing_active: bool = False

        # Depth editing
        self._depth_edit_cb: Callable | None = None
        self._depth_edit_end_cb: Callable | None = None

        self.bind("<ButtonPress-1>", self._btn1_down)
        self.bind("<B1-Motion>", self._btn1_drag)
        self.bind("<ButtonRelease-1>", self._btn1_up)
        self.bind("<ButtonPress-3>", self._btn3_down)
        self.bind("<B3-Motion>", self._btn3_drag)
        self.bind("<ButtonPress-2>", self._btn2_down)
        self.bind("<B2-Motion>", self._btn2_drag)
        self.bind("<MouseWheel>", self._on_scroll)
        self.bind("<Motion>", self._on_motion)
        self.bind("<Escape>", self._on_escape)

    # ------------------------------------------------------------------
    # OpenGL lifecycle
    # ------------------------------------------------------------------

    def initgl(self):
        glClearColor(0.11, 0.11, 0.14, 1.0)
        glEnable(GL_DEPTH_TEST)
        glDepthFunc(GL_LEQUAL)
        glEnable(GL_BLEND)
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)
        glEnable(GL_LINE_SMOOTH)
        glHint(GL_LINE_SMOOTH_HINT, GL_NICEST)

        bufs = glGenBuffers(4)
        self._vbo_vert = int(bufs[0])
        self._vbo_color = int(bufs[1])
        self._vbo_uv = int(bufs[2])
        self._ibo = int(bufs[3])
        self._gl_ready = True

        if self._data_dirty:
            self._upload()

    def redraw(self):
        w = max(1, self.winfo_width())
        h = max(1, self.winfo_height())
        glViewport(0, 0, w, h)
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)

        glMatrixMode(GL_PROJECTION)
        glLoadIdentity()
        aspect = w / h
        extent = self._distance * 0.6
        glOrtho(-extent * aspect, extent * aspect, -extent, extent, 0.01, 500.0)

        glMatrixMode(GL_MODELVIEW)
        glLoadIdentity()
        el = math.radians(self._elevation)
        az = math.radians(self._azimuth)
        eye_x = self._center[0] + self._distance * math.cos(el) * math.cos(az)
        eye_y = self._center[1] + self._distance * math.sin(el)
        eye_z = self._center[2] + self._distance * math.cos(el) * math.sin(az)
        gluLookAt(eye_x, eye_y, eye_z,
                  self._center[0], self._center[1], self._center[2],
                  0.0, 1.0, 0.0)

        if self._data_dirty and self._gl_ready:
            self._upload()
        if self._mesh_tex_pending is not None and self._gl_ready:
            self._upload_mesh_texture()
        if self._billboard_pending_image is not None and self._gl_ready:
            self._upload_billboard_texture()

        if self._show_grid:
            self._draw_grid()
        if self._show_axes or self._show_labels:
            self._draw_axes()
        self._draw_mesh()
        if self._show_collision and self._collision_mask is not None:
            self._draw_collision()
        if self._billboard_enabled and self._billboard_tex_id is not None:
            self._draw_billboard()
        self._draw_edit_overlay()

    # ------------------------------------------------------------------
    # Floor grid (Y = 0)
    # ------------------------------------------------------------------

    def _draw_grid(self):
        ext = self._grid_extent
        major = self._grid_major
        minor = self._grid_minor if self._grid_minor > 0 else major / 4

        verts = []
        colors = []

        n_minor = int(ext / minor) if minor > 1e-6 else 0
        for i in range(-n_minor, n_minor + 1):
            v = i * minor
            if major > 1e-6 and (abs(v % major) < 1e-4 or abs(v % major - major) < 1e-4):
                continue
            c = (0.20, 0.20, 0.20, 0.30)
            verts.extend([(-ext, 0, v), (ext, 0, v), (v, 0, -ext), (v, 0, ext)])
            colors.extend([c, c, c, c])

        n_major = int(ext / major) if major > 1e-6 else 0
        for i in range(-n_major, n_major + 1):
            v = i * major
            cv = 0.42 if i == 0 else 0.30
            a = 0.55 if i == 0 else 0.45
            c = (cv, cv, cv, a)
            verts.extend([(-ext, 0, v), (ext, 0, v), (v, 0, -ext), (v, 0, ext)])
            colors.extend([c, c, c, c])

        if not verts:
            return
        v_arr = np.array(verts, dtype=np.float32)
        c_arr = np.array(colors, dtype=np.float32)
        glLineWidth(1.0)
        glEnableClientState(GL_VERTEX_ARRAY)
        glEnableClientState(GL_COLOR_ARRAY)
        glVertexPointer(3, GL_FLOAT, 0, v_arr)
        glColorPointer(4, GL_FLOAT, 0, c_arr)
        glDrawArrays(GL_LINES, 0, len(verts))
        glDisableClientState(GL_VERTEX_ARRAY)
        glDisableClientState(GL_COLOR_ARRAY)

    # ------------------------------------------------------------------
    # Coordinate axes (X=image right, Y=image up, Z=depth)
    # ------------------------------------------------------------------

    def _get_axis_vectors(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return (x_dir, y_dir, z_dir) for axes. Uses calibration camera if set."""
        if self._calib_camera is not None:
            right, up, vd = self._calib_camera.axes()
            return right, up, vd
        return (
            np.array([1.0, 0.0, 0.0]),
            np.array([0.0, 1.0, 0.0]),
            np.array([0.0, 0.0, 1.0]),
        )

    def _draw_axes(self):
        L = self._axes_length
        tick = self._grid_major
        ts = max(0.02, L * 0.02)
        xd, yd, zd = self._get_axis_vectors()

        def tip(axis: str):
            d = xd if axis == "x" else (yd if axis == "y" else zd)
            return (d[0] * L, d[1] * L, d[2] * L)

        if self._show_axes:
            glLineWidth(2.5)
            glBegin(GL_LINES)
            glColor3f(0.92, 0.22, 0.22)
            glVertex3f(0, 0, 0)
            glVertex3fv(tip("x"))
            glColor3f(0.22, 0.90, 0.22)
            glVertex3f(0, 0, 0)
            glVertex3fv(tip("y"))
            glColor3f(0.22, 0.40, 0.95)
            glVertex3f(0, 0, 0)
            glVertex3fv(tip("z"))
            glEnd()

            ah = ts * 3
            aw = ts * 1.5
            self._draw_arrow_dir(*tip("x"), xd, ah, aw, (0.92, 0.22, 0.22))
            self._draw_arrow_dir(*tip("y"), yd, ah, aw, (0.22, 0.90, 0.22))
            self._draw_arrow_dir(*tip("z"), zd, ah, aw, (0.22, 0.40, 0.95))

            if tick >= 1e-6:
                glLineWidth(1.2)
                glBegin(GL_LINES)
                nt = int(L / tick)
                for i in range(1, nt + 1):
                    v = i * tick
                    glColor3f(0.92, 0.22, 0.22)
                    p = xd * v
                    glVertex3f(p[0] - yd[0] * ts, p[1] - yd[1] * ts, p[2] - yd[2] * ts)
                    glVertex3f(p[0] + yd[0] * ts, p[1] + yd[1] * ts, p[2] + yd[2] * ts)
                    glColor3f(0.22, 0.90, 0.22)
                    p = yd * v
                    glVertex3f(p[0] - xd[0] * ts, p[1] - xd[1] * ts, p[2] - xd[2] * ts)
                    glVertex3f(p[0] + xd[0] * ts, p[1] + xd[1] * ts, p[2] + xd[2] * ts)
                    glColor3f(0.22, 0.40, 0.95)
                    p = zd * v
                    glVertex3f(p[0] - yd[0] * ts, p[1] - yd[1] * ts, p[2] - yd[2] * ts)
                    glVertex3f(p[0] + yd[0] * ts, p[1] + yd[1] * ts, p[2] + yd[2] * ts)
                glEnd()
                glLineWidth(1.0)

        if self._show_labels:
            eye = np.array([
                self._center[0] + self._distance * math.cos(math.radians(self._elevation)) * math.cos(math.radians(self._azimuth)),
                self._center[1] + self._distance * math.sin(math.radians(self._elevation)),
                self._center[2] + self._distance * math.cos(math.radians(self._elevation)) * math.sin(math.radians(self._azimuth)),
            ], dtype=np.float64)
            label_scale = max(0.03, L * 0.08)

            def fmt(v):
                if abs(v - round(v)) < 1e-6:
                    return str(int(round(v)))
                return f"{v:.1f}"

            if tick >= 1e-6:
                nt = int(L / tick)
                for i in range(0, nt + 1):
                    v = i * tick
                    if i == 0:
                        self._draw_label(eye, np.array([0.0, 0.0, 0.0]), "0", (0.9, 0.9, 0.9), label_scale)
                    else:
                        self._draw_label(eye, (xd * v).astype(np.float64), fmt(v), (0.92, 0.22, 0.22), label_scale)
                        self._draw_label(eye, (yd * v).astype(np.float64), fmt(v), (0.22, 0.90, 0.22), label_scale)
                        self._draw_label(eye, (zd * v).astype(np.float64), fmt(v), (0.22, 0.40, 0.95), label_scale)

            self._draw_label(eye, (xd * L * 1.15).astype(np.float64), "X", (0.92, 0.22, 0.22), label_scale * 1.2)
            self._draw_label(eye, (yd * L * 1.15).astype(np.float64), "Y", (0.22, 0.90, 0.22), label_scale * 1.2)
            self._draw_label(eye, (zd * L * 1.15).astype(np.float64), "Z", (0.22, 0.40, 0.95), label_scale * 1.2)

    def _draw_label(self, eye: np.ndarray, pos: np.ndarray, text: str,
                    color: tuple[float, float, float], scale: float) -> None:
        """Draw text label as billboard quad at pos, facing camera."""
        key = f"{text}_{color[0]:.2f}_{color[1]:.2f}_{color[2]:.2f}"
        if key not in self._label_cache:
            tid, tw, th = _make_text_texture(text, color)
            self._label_cache[key] = (tid, tw, th)
        tex_id, tw, th = self._label_cache[key]

        v = eye - pos
        n = np.linalg.norm(v)
        if n < 1e-12:
            return
        v = v / n
        up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        if abs(np.dot(v, up)) > 0.99:
            up = np.array([1.0, 0.0, 0.0], dtype=np.float64)
        r = np.cross(up, v)
        r = r / (np.linalg.norm(r) + 1e-12)
        u = np.cross(v, r)
        u = u / (np.linalg.norm(u) + 1e-12)
        asp = th / max(1, tw)
        hw, hh = scale, scale * asp
        corners = [
            pos - r * hw - u * hh,
            pos + r * hw - u * hh,
            pos + r * hw + u * hh,
            pos - r * hw + u * hh,
        ]
        glEnable(GL_TEXTURE_2D)
        glBindTexture(GL_TEXTURE_2D, tex_id)
        glColor4f(1.0, 1.0, 1.0, 1.0)
        glBegin(GL_QUADS)
        glTexCoord2f(1, 0)
        glVertex3fv(corners[0])
        glTexCoord2f(0, 0)
        glVertex3fv(corners[1])
        glTexCoord2f(0, 1)
        glVertex3fv(corners[2])
        glTexCoord2f(1, 1)
        glVertex3fv(corners[3])
        glEnd()
        glBindTexture(GL_TEXTURE_2D, 0)
        glDisable(GL_TEXTURE_2D)

    def _draw_arrow_dir(self, tx: float, ty: float, tz: float,
                        dx: np.ndarray, ah: float, aw: float, color: tuple) -> None:
        """Draw arrow tip at (tx,ty,tz) pointing along direction d."""
        d = np.asarray(dx, dtype=np.float64)
        if np.linalg.norm(d) < 1e-12:
            return
        d = d / np.linalg.norm(d)
        base = np.array([tx, ty, tz]) - d * ah
        up = np.array([0.0, 1.0, 0.0])
        if abs(np.dot(d, up)) > 0.99:
            up = np.array([1.0, 0.0, 0.0])
        r = np.cross(up, d)
        r = r / (np.linalg.norm(r) + 1e-12)
        u = np.cross(d, r)
        u = u / (np.linalg.norm(u) + 1e-12)
        tip = np.array([tx, ty, tz])
        v0 = base + r * aw
        v1 = base - r * aw
        glBegin(GL_TRIANGLES)
        glColor3f(*color)
        glVertex3fv(tip)
        glVertex3fv(v0)
        glVertex3fv(v1)
        glEnd()

    # ------------------------------------------------------------------
    # Collision grid overlay on Y=0
    # ------------------------------------------------------------------

    def _draw_collision(self):
        mask = self._collision_mask
        if mask is None:
            return
        cs = self._collision_cell
        x0 = self._collision_x_min
        z0 = self._collision_z_min
        y = np.float32(self._collision_y)

        rows, cols = np.nonzero(mask)
        if rows.size == 0:
            return

        xs = (x0 + cols * cs).astype(np.float32)
        zs = (z0 + rows * cs).astype(np.float32)
        n = xs.size

        quads = np.empty((n * 4, 3), dtype=np.float32)
        quads[0::4, 0] = xs
        quads[0::4, 2] = zs
        quads[1::4, 0] = xs + cs
        quads[1::4, 2] = zs
        quads[2::4, 0] = xs + cs
        quads[2::4, 2] = zs + cs
        quads[3::4, 0] = xs
        quads[3::4, 2] = zs + cs
        quads[:, 1] = y

        glDepthMask(GL_FALSE)
        glEnableClientState(GL_VERTEX_ARRAY)
        glVertexPointer(3, GL_FLOAT, 0, quads)

        glDepthFunc(GL_LEQUAL)
        glColor4f(0.85, 0.15, 0.15, 0.45)
        glDrawArrays(GL_QUADS, 0, n * 4)

        glDepthFunc(GL_GREATER)
        glColor4f(0.85, 0.15, 0.15, 0.20)
        glDrawArrays(GL_QUADS, 0, n * 4)

        glDisableClientState(GL_VERTEX_ARRAY)
        glDepthFunc(GL_LEQUAL)
        glDepthMask(GL_TRUE)

    # ------------------------------------------------------------------
    # Mesh rendering (VBO)
    # ------------------------------------------------------------------

    def _draw_mesh(self):
        if self._index_count == 0:
            return

        if self._wireframe:
            glPolygonMode(GL_FRONT_AND_BACK, GL_LINE)

        use_tex = self._mesh_tex_id > 0

        glEnableClientState(GL_VERTEX_ARRAY)
        glBindBuffer(GL_ARRAY_BUFFER, self._vbo_vert)
        glVertexPointer(3, GL_FLOAT, 0, None)

        if use_tex:
            glEnable(GL_TEXTURE_2D)
            glBindTexture(GL_TEXTURE_2D, self._mesh_tex_id)
            glColor4f(1.0, 1.0, 1.0, 1.0)
            glEnableClientState(GL_TEXTURE_COORD_ARRAY)
            glBindBuffer(GL_ARRAY_BUFFER, self._vbo_uv)
            glTexCoordPointer(2, GL_FLOAT, 0, None)
        else:
            glEnableClientState(GL_COLOR_ARRAY)
            glBindBuffer(GL_ARRAY_BUFFER, self._vbo_color)
            glColorPointer(3, GL_FLOAT, 0, None)

        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self._ibo)
        glDrawElements(GL_TRIANGLES, self._index_count, GL_UNSIGNED_INT, None)

        glBindBuffer(GL_ARRAY_BUFFER, 0)
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0)
        glDisableClientState(GL_VERTEX_ARRAY)

        if use_tex:
            glDisableClientState(GL_TEXTURE_COORD_ARRAY)
            glBindTexture(GL_TEXTURE_2D, 0)
            glDisable(GL_TEXTURE_2D)
        else:
            glDisableClientState(GL_COLOR_ARRAY)

        if self._wireframe:
            glPolygonMode(GL_FRONT_AND_BACK, GL_FILL)

    # ------------------------------------------------------------------
    # Billboard (fixed-orientation quad in world space)
    # ------------------------------------------------------------------

    def _draw_billboard(self) -> None:
        """Draw billboard as a quad on the Y=0 ground plane in world space.

        The quad lies in the YZ plane (width along Z, height along Y)
        and faces the X direction (depth).  Position (x, z) is world X/Z.
        """
        if self._billboard_tex_id is None or not self._gl_ready:
            return

        s = max(0.01, self._billboard_scale)
        hw = self._billboard_width / 2 * s
        hh = self._billboard_height * s

        bx = self._billboard_pos[0]
        bz = self._billboard_pos[1]

        glEnable(GL_TEXTURE_2D)
        glBindTexture(GL_TEXTURE_2D, self._billboard_tex_id)
        glColor4f(1.0, 1.0, 1.0, 1.0)
        glBegin(GL_QUADS)
        glTexCoord2f(0, 0)
        glVertex3f(bx, 0.0, bz - hw)
        glTexCoord2f(1, 0)
        glVertex3f(bx, 0.0, bz + hw)
        glTexCoord2f(1, 1)
        glVertex3f(bx, hh, bz + hw)
        glTexCoord2f(0, 1)
        glVertex3f(bx, hh, bz - hw)
        glEnd()
        glBindTexture(GL_TEXTURE_2D, 0)
        glDisable(GL_TEXTURE_2D)

    def on_key(self, keysym: str) -> bool:
        """Handle WASD for billboard movement on the Y=0 ground plane.

        W/S: move along world Z.
        A/D: move along world X.
        """
        if not self._billboard_enabled:
            return False
        step = self._billboard_move_step
        k = keysym.lower()
        if k == "w":
            self._billboard_pos[1] -= step
        elif k == "s":
            self._billboard_pos[1] += step
        elif k == "a":
            self._billboard_pos[0] -= step
        elif k == "d":
            self._billboard_pos[0] += step
        else:
            return False
        if self._billboard_moved_cb:
            self._billboard_moved_cb(self._billboard_pos[0], self._billboard_pos[1])
        return True

    def _upload(self):
        if self._vertices is None:
            self._index_count = 0
            self._data_dirty = False
            return

        v_bytes = self._vertices.tobytes()
        c_bytes = self._colors.tobytes()
        i_bytes = self._indices.tobytes()

        glBindBuffer(GL_ARRAY_BUFFER, self._vbo_vert)
        glBufferData(GL_ARRAY_BUFFER, len(v_bytes), v_bytes, GL_STATIC_DRAW)

        glBindBuffer(GL_ARRAY_BUFFER, self._vbo_color)
        glBufferData(GL_ARRAY_BUFFER, len(c_bytes), c_bytes, GL_STATIC_DRAW)

        if self._uvs is not None:
            uv_bytes = self._uvs.tobytes()
            glBindBuffer(GL_ARRAY_BUFFER, self._vbo_uv)
            glBufferData(GL_ARRAY_BUFFER, len(uv_bytes), uv_bytes, GL_STATIC_DRAW)

        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, self._ibo)
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, len(i_bytes), i_bytes, GL_STATIC_DRAW)

        self._index_count = len(self._indices)
        self._data_dirty = False

    def _upload_mesh_texture(self):
        img = self._mesh_tex_pending
        self._mesh_tex_pending = None
        if img is None:
            return
        img = img.convert("RGB")
        arr = np.array(img, dtype=np.uint8)
        if self._mesh_tex_id > 0:
            glDeleteTextures([self._mesh_tex_id])
        tex_id = glGenTextures(1)
        glBindTexture(GL_TEXTURE_2D, tex_id)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE)
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE)
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB, img.width, img.height, 0,
                     GL_RGB, GL_UNSIGNED_BYTE, arr)
        glBindTexture(GL_TEXTURE_2D, 0)
        self._mesh_tex_id = int(tex_id)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_mesh(self, X: np.ndarray, Y: np.ndarray, Z: np.ndarray,
                 colors: np.ndarray, *, auto_fit: bool = True) -> None:
        """Build triangle mesh from grid arrays (output of reconstruct_points)."""
        h, w = X.shape
        verts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=-1).astype(np.float32)

        if colors.ndim == 3:
            cols = colors.reshape(-1, 3).astype(np.float32)
        else:
            cols = np.full((verts.shape[0], 3), 0.7, dtype=np.float32)

        j_idx, i_idx = np.meshgrid(np.arange(w), np.arange(h))
        u = (j_idx.ravel() / max(w - 1, 1)).astype(np.float32)
        v = (i_idx.ravel() / max(h - 1, 1)).astype(np.float32)
        uvs = np.column_stack([u, v]).astype(np.float32)

        r, c = np.meshgrid(np.arange(h - 1), np.arange(w - 1), indexing="ij")
        tl = (r * w + c).ravel()
        tr = tl + 1
        bl = tl + w
        br = bl + 1
        indices = np.column_stack([tl, bl, br, tl, br, tr]).ravel().astype(np.uint32)

        self._vertices = verts
        self._colors = cols
        self._uvs = uvs
        self._indices = indices
        self._data_dirty = True

        self.vertex_count = len(verts)
        self.tri_count = len(indices) // 3
        if auto_fit:
            self._auto_fit()

    def set_mesh_texture(self, image: Image.Image) -> None:
        self._mesh_tex_pending = image

    def clear_mesh(self):
        self._vertices = None
        self._colors = None
        self._indices = None
        self._data_dirty = True
        self._index_count = 0
        self.vertex_count = 0
        self.tri_count = 0

    def set_wireframe(self, on: bool):
        self._wireframe = on

    def set_show_grid(self, on: bool):
        self._show_grid = on

    def set_show_axes(self, on: bool):
        self._show_axes = on

    def set_show_labels(self, on: bool):
        self._show_labels = on

    def set_show_collision(self, on: bool):
        self._show_collision = on

    def set_collision_data(self, mask: np.ndarray | None,
                           x_min: float = 0.0, z_min: float = 0.0,
                           cell_size: float = 1.0,
                           y_level: float = 0.0) -> None:
        if mask is None:
            self._collision_mask = None
            return
        self._collision_mask = mask
        self._collision_x_min = x_min
        self._collision_z_min = z_min
        self._collision_cell = cell_size
        self._collision_y = y_level

    def set_calibration_camera(self, camera) -> None:
        """Set OrthoCamera for axes (X=image right, Y=image up, Z=depth)."""
        self._calib_camera = camera

    def load_billboard_texture(self, path: str | None = None) -> None:
        """Load billboard from image path, or use default if path is None."""
        if path is None:
            self._billboard_pending_image = _make_default_billboard_image()
        else:
            self._billboard_pending_image = Image.open(path).convert("RGBA")

    def set_billboard_enabled(self, on: bool) -> None:
        self._billboard_enabled = on

    def set_billboard_pos(self, x: float, z: float) -> None:
        self._billboard_pos[0] = x
        self._billboard_pos[1] = z

    def set_billboard_scale(self, scale: float) -> None:
        self._billboard_scale = max(0.01, float(scale))

    def get_billboard_scale(self) -> float:
        return self._billboard_scale

    def set_billboard_moved_callback(self, cb: Callable[[float, float], None] | None) -> None:
        self._billboard_moved_cb = cb

    def _upload_billboard_texture(self) -> None:
        if self._billboard_pending_image is None:
            return
        if self._billboard_tex_id is not None:
            glDeleteTextures([self._billboard_tex_id])
        self._billboard_tex_id = _image_to_texture(self._billboard_pending_image)
        self._billboard_pending_image = None

    def _auto_fit(self):
        if self._vertices is None or len(self._vertices) == 0:
            return
        vmin = self._vertices.min(axis=0)
        vmax = self._vertices.max(axis=0)
        center = (vmin + vmax) / 2.0
        extent = float(np.linalg.norm(vmax - vmin))

        self._center = center.astype(np.float64)
        self._distance = max(0.5, extent * 0.8)
        self._billboard_pos[0] = float(center[0])
        self._billboard_pos[1] = float(center[2])

        self._grid_extent = max(1.0, extent * 0.6)
        half = max(0.25, round(self._grid_extent / 8, 2))
        self._grid_major = half
        self._grid_minor = half / 4
        self._axes_length = max(0.5, extent * 0.35)

    # ------------------------------------------------------------------
    # Mouse interaction
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Editing public API
    # ------------------------------------------------------------------

    def set_edit_tool(self, tool: str) -> None:
        if tool != self._edit_tool:
            self._polygon_verts.clear()
        self._edit_tool = tool

    def set_brush_radius(self, r: float) -> None:
        self._brush_radius = max(0.001, r)

    def set_collision_edit_callback(self, cb: Callable | None) -> None:
        self._on_edit_cb = cb

    def set_collision_edit_end_callback(self, cb: Callable | None) -> None:
        self._on_edit_end_cb = cb

    def set_depth_edit_callback(self, cb: Callable | None) -> None:
        self._depth_edit_cb = cb

    def set_depth_edit_end_callback(self, cb: Callable | None) -> None:
        self._depth_edit_end_cb = cb

    # ------------------------------------------------------------------
    # Screen → world XZ (on collision Y-plane)
    # ------------------------------------------------------------------

    def _screen_to_xz(self, mx: int, my: int) -> tuple[float, float] | None:
        w = max(1, self.winfo_width())
        h = max(1, self.winfo_height())
        ndc_x = (2.0 * mx / w) - 1.0
        ndc_y = 1.0 - (2.0 * my / h)

        az = math.radians(self._azimuth)
        el = math.radians(self._elevation)
        fwd = np.array([
            -math.cos(el) * math.cos(az),
            -math.sin(el),
            -math.cos(el) * math.sin(az),
        ])
        up_hint = np.array([0.0, 1.0, 0.0])
        right = np.cross(fwd, up_hint)
        rn = np.linalg.norm(right)
        if rn < 1e-12:
            return None
        right /= rn
        up = np.cross(right, fwd)
        up /= np.linalg.norm(up)

        extent = self._distance * 0.6
        aspect = w / h
        origin = (self._center
                  + ndc_x * extent * aspect * right
                  + ndc_y * extent * up)
        if abs(fwd[1]) < 1e-12:
            return None
        t = (self._collision_y - origin[1]) / fwd[1]
        return (float(origin[0] + t * fwd[0]),
                float(origin[2] + t * fwd[2]))

    # ------------------------------------------------------------------
    # Edit overlay drawing
    # ------------------------------------------------------------------

    def _draw_edit_overlay(self) -> None:
        if self._edit_tool in (TOOL_BRUSH, TOOL_ERASER) and self._mouse_xz:
            self._draw_brush_cursor()
        if self._edit_tool == TOOL_POLYGON and self._polygon_verts:
            self._draw_polygon_preview()
        if self._edit_tool in _DEPTH_TOOLS and self._mouse_xz:
            self._draw_depth_brush_cursor()

    def _draw_brush_cursor(self) -> None:
        cx, cz = self._mouse_xz              # type: ignore[misc]
        y = self._collision_y
        r = self._brush_radius
        glDisable(GL_DEPTH_TEST)
        glLineWidth(2.0)
        if self._edit_tool == TOOL_BRUSH:
            glColor4f(0.2, 1.0, 0.2, 0.8)
        else:
            glColor4f(1.0, 0.3, 0.3, 0.8)
        glBegin(GL_LINE_LOOP)
        for i in range(32):
            a = 2.0 * math.pi * i / 32
            glVertex3f(cx + r * math.cos(a), y, cz + r * math.sin(a))
        glEnd()
        glEnable(GL_DEPTH_TEST)

    def _draw_depth_brush_cursor(self) -> None:
        cx, cz = self._mouse_xz                  # type: ignore[misc]
        y = self._collision_y
        r = self._brush_radius
        glDisable(GL_DEPTH_TEST)
        glLineWidth(2.0)
        if self._edit_tool == TOOL_DEPTH_RAISE:
            glColor4f(0.3, 0.5, 1.0, 0.8)
        elif self._edit_tool == TOOL_DEPTH_LOWER:
            glColor4f(1.0, 0.4, 0.2, 0.8)
        else:
            glColor4f(0.3, 0.9, 0.9, 0.8)
        glBegin(GL_LINE_LOOP)
        for i in range(32):
            a = 2.0 * math.pi * i / 32
            glVertex3f(cx + r * math.cos(a), y, cz + r * math.sin(a))
        glEnd()
        glEnable(GL_DEPTH_TEST)

    def _draw_polygon_preview(self) -> None:
        y = self._collision_y
        glDisable(GL_DEPTH_TEST)
        glLineWidth(2.0)
        glColor4f(1.0, 1.0, 0.0, 0.9)
        glBegin(GL_LINE_STRIP)
        for vx, vz in self._polygon_verts:
            glVertex3f(vx, y, vz)
        glEnd()
        if self._mouse_xz:
            mx, mz = self._mouse_xz
            last = self._polygon_verts[-1]
            first = self._polygon_verts[0]
            glBegin(GL_LINES)
            glColor4f(1.0, 1.0, 0.0, 0.5)
            glVertex3f(last[0], y, last[1])
            glVertex3f(mx, y, mz)
            glVertex3f(mx, y, mz)
            glVertex3f(first[0], y, first[1])
            glEnd()
        glPointSize(6.0)
        glBegin(GL_POINTS)
        glColor4f(1.0, 1.0, 0.0, 1.0)
        for vx, vz in self._polygon_verts:
            glVertex3f(vx, y, vz)
        glEnd()
        glEnable(GL_DEPTH_TEST)

    # ------------------------------------------------------------------
    # Mouse interaction
    # ------------------------------------------------------------------

    @staticmethod
    def _ctrl_held(e) -> bool:
        return bool(e.state & 0x4)

    def _btn1_down(self, e):
        self._last_mx, self._last_my = e.x, e.y
        if self._ctrl_held(e) and self._edit_tool in (TOOL_BRUSH, TOOL_ERASER):
            xz = self._screen_to_xz(e.x, e.y)
            if xz and self._on_edit_cb:
                action = "brush" if self._edit_tool == TOOL_BRUSH else "erase"
                self._on_edit_cb(action, [xz], self._brush_radius)
            self._editing_active = True
        elif self._ctrl_held(e) and self._edit_tool == TOOL_POLYGON:
            xz = self._screen_to_xz(e.x, e.y)
            if xz:
                self._polygon_verts.append(xz)
            self._editing_active = True
        elif self._ctrl_held(e) and self._edit_tool in _DEPTH_TOOLS:
            xz = self._screen_to_xz(e.x, e.y)
            if xz and self._depth_edit_cb:
                self._depth_edit_cb(self._edit_tool, xz, self._brush_radius)
            self._editing_active = True
        else:
            self._editing_active = False

    def _btn1_drag(self, e):
        if self._editing_active and self._edit_tool in (TOOL_BRUSH, TOOL_ERASER):
            xz = self._screen_to_xz(e.x, e.y)
            if xz and self._on_edit_cb:
                action = "brush" if self._edit_tool == TOOL_BRUSH else "erase"
                self._on_edit_cb(action, [xz], self._brush_radius)
            self._last_mx, self._last_my = e.x, e.y
        elif self._editing_active and self._edit_tool in _DEPTH_TOOLS:
            xz = self._screen_to_xz(e.x, e.y)
            if xz and self._depth_edit_cb:
                self._depth_edit_cb(self._edit_tool, xz, self._brush_radius)
            self._last_mx, self._last_my = e.x, e.y
        else:
            dx = self._last_mx - e.x
            dy = self._last_my - e.y
            self._last_mx, self._last_my = e.x, e.y
            self._pan(dx, dy)

    def _btn1_up(self, e):
        if self._editing_active:
            if self._edit_tool in (TOOL_BRUSH, TOOL_ERASER):
                if self._on_edit_end_cb:
                    self._on_edit_end_cb()
            elif self._edit_tool in _DEPTH_TOOLS:
                if self._depth_edit_end_cb:
                    self._depth_edit_end_cb()
        self._editing_active = False

    def _btn3_down(self, e):
        if self._ctrl_held(e) and self._edit_tool == TOOL_POLYGON and self._polygon_verts:
            if len(self._polygon_verts) >= 3 and self._on_edit_cb:
                self._on_edit_cb("polygon", list(self._polygon_verts), 0.0)
            self._polygon_verts.clear()
            if self._on_edit_end_cb:
                self._on_edit_end_cb()
        else:
            self._last_mx, self._last_my = e.x, e.y

    def _btn3_drag(self, e):
        dx = self._last_mx - e.x
        dy = self._last_my - e.y
        self._last_mx, self._last_my = e.x, e.y
        self._azimuth += dx * 0.4
        self._elevation = max(-89.0, min(89.0, self._elevation - dy * 0.3))

    def _btn2_down(self, e):
        self._last_mx, self._last_my = e.x, e.y

    def _btn2_drag(self, e):
        dx = self._last_mx - e.x
        dy = self._last_my - e.y
        self._last_mx, self._last_my = e.x, e.y
        self._pan(dx, dy)

    def _on_motion(self, e):
        if self._edit_tool != TOOL_NONE:
            self._mouse_xz = self._screen_to_xz(e.x, e.y)

    def _on_escape(self, e):
        if self._edit_tool == TOOL_POLYGON:
            self._polygon_verts.clear()

    def _pan(self, dx, dy):
        speed = self._distance * 0.0015
        az = math.radians(self._azimuth)
        rx, rz = -math.sin(az), math.cos(az)
        self._center[0] -= dx * rx * speed
        self._center[2] -= dx * rz * speed
        self._center[1] += dy * speed

    def _on_scroll(self, e):
        factor = 0.9 if e.delta > 0 else 1.1
        self._distance = max(0.05, min(200.0, self._distance * factor))
