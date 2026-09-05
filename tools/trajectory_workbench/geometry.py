# -*- coding: utf-8 -*-
"""轨迹工作台的场景几何：把一个场景的伪世界 q 空间还原成 3D 世界（wu），给物理与视图用。

## 几何从哪来（只读工程文件，不写任何东西）

几何单一真相源是 ``tools.character_lighting_lab.scene_geometry.Scene``（背景 + ``raw_depth_rg.png``
+ ``depthConfig.M``，``world = R @ q``，**det=+1 游戏约定**）。本模块是它的下游消费者，
不另立一套重建；``lighting.json`` 那套 det=−1 的矩阵一概不碰（见 [[coordinate-spaces]]）。

地面用照明载荷的行走面深度场 ``lighting/<背景基名>/ground_d.png``（条件数最好的一层，
运行时的遮挡脚点 / 影子落地面 / 碰撞反投影全走它）；没有烘过光照的场景退回深度壳本身当地面
（近似，会把墙也当地）。

## 单位与坐标（本模块所有公开量一律 **wu 世界坐标**）

- 画面空间（场景坐标）：wu，画布左上原点、Y 向下 —— NPC 坐标那把尺；
- q 空间：``((px−cx)/ppu, (cy−py)/ppu, d)``，画面中心原点、Y 向上、z 是深度；
- 世界（M-world）：``R @ q``，再乘 ``wuPerQUnit = worldWidth / (native_w / ppu)`` 变成 wu，
  **+Y 向上，XZ 是地面**。

## 碰撞查询（给 :mod:`.bake3d`）

- :meth:`SceneGeometry.ground_height`：世界 XZ → 地面 Y（wu）。由行走面深度场反投影成
  XZ 高度场（栅格化 + 最近邻补洞）；
- :meth:`SceneGeometry.shell_contact`：世界点 → 是否在**深度壳**后面（`q.z > 壳深度`）及该像素的
  世界法线。2.5D 重建只有可见壳一层，所以"飞到前景物体背后"也算撞上——这是"不需要特别精确"
  换来的简单性，文档里写明即可。
"""
from __future__ import annotations

import io
import json
import math
import struct
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from tools.character_lighting_lab.scene_geometry import (
    SCENES_JSON,
    SCENES_RT,
    Scene,
    bake_key,
    scene_backgrounds,
    scene_paths,
)

from .projection import basis_rows_from_R

__all__ = ["SceneGeometry", "list_scenes", "scene_backgrounds_for", "entity_preview", "PUBLIC"]

PUBLIC = SCENES_RT.parents[2]          # public/
WORK_W = 512                           # 与照明载荷同一工作分辨率
HEIGHTFIELD_N = 256


def list_scenes() -> list[dict]:
    """工程全部场景 + 每张时段背景的几何状态（有没有深度、有没有行走面场）。"""
    out: list[dict] = []
    for j in sorted(SCENES_JSON.glob("*.json")):
        try:
            data = json.loads(j.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — 坏 JSON 不拖垮清单
            continue
        sid = j.stem
        cfg = data.get("depthConfig") or {}
        depth_ok = bool(cfg) and (SCENES_RT / sid / cfg.get("depth_map", "raw_depth_rg.png")).exists()
        bgs = []
        try:
            names = scene_backgrounds(sid)
        except Exception:  # noqa: BLE001
            names = []
        for name in names:
            bgs.append({
                "image": name,
                "exists": (SCENES_RT / sid / name).exists(),
                "ground": (SCENES_RT / sid / "lighting" / bake_key(name) / "ground_d.png").exists(),
            })
        out.append({
            "id": sid,
            "name": data.get("name") or sid,
            "depth": depth_ok,
            "backgrounds": bgs,
            "npcs": len(data.get("npcs") or []),
        })
    return out


def scene_backgrounds_for(sid: str) -> list[str]:
    return scene_backgrounds(sid)


class SceneGeometry:
    """一个场景（一张时段背景）的几何：装载一次，按需重建。"""

    def __init__(self, sid: str, background: str | None = None):
        p = scene_paths(sid)
        self.sid = sid
        self.data: dict = p["data"]
        self.scene = Scene(sid, background)
        self.bg_name: str = self.scene.bg_name
        self.native: tuple[int, int] = self.scene.native
        nw, nh = self.native
        self.world_w = float(self.data.get("worldWidth") or nw)
        wh = self.data.get("worldHeight")
        self.world_h = float(wh) if wh else self.world_w * nh / nw
        self.cfg = self.scene.cfg                      # None = 没有深度
        self.rows = basis_rows_from_R((self.data.get("depthConfig") or {}).get("M", {}).get("R")) if self.cfg else None
        self.R = np.asarray(self.cfg["R"], np.float64) if self.cfg else None
        self.wu_per_q = (self.world_w / (nw / self.cfg["ppu"])) if self.cfg else 1.0
        self.cos_theta = float(self.R[1][1]) if self.R is not None else 1.0
        self.geo: dict | None = None
        self.work: tuple[int, int] = (nw, nh)
        if self.cfg is not None:
            w = min(WORK_W, nw)
            h = max(1, int(round(nh * w / nw)))
            self.work = (w, h)
            self.geo = self.scene.geometry((w, h), normal_sigma=max(0.8, 0.8 * (w / 640.0)))
        self.ground: np.ndarray | None = None          # (h,w) q 深度，work 分辨率
        self.ground_source = "none"
        self._load_ground()
        self._hf: dict | None = None

    # ------------------------------------------------------------ 装载
    @property
    def has_depth(self) -> bool:
        return self.geo is not None

    def _load_ground(self) -> None:
        if self.geo is None:
            return
        bd = SCENES_RT / self.sid / "lighting" / bake_key(self.bg_name)
        png = bd / "ground_d.png"
        meta_p = bd / "lighting.json"
        if png.exists() and meta_p.exists():
            try:
                meta = json.loads(meta_p.read_text(encoding="utf-8"))
                gd = meta.get("ground_d") or {}
                arr = np.asarray(Image.open(png).convert("RGB"), np.float32)
                t = (arr[:, :, 0] * 256.0 + arr[:, :, 1]) / 65535.0
                dep = float(gd["min"]) + t * (float(gd["max"]) - float(gd["min"]))
                if dep.shape != self.geo["depth"].shape:
                    dep = np.asarray(Image.fromarray(dep.astype(np.float32), mode="F")
                                     .resize(self.work, Image.BILINEAR), np.float32)
                self.ground = dep.astype(np.float32)
                self.ground_source = "ground_d"
                return
            except Exception:  # noqa: BLE001 — 载荷坏了就退回壳
                pass
        # 没有行走面场：拿深度壳当地面（近似）
        self.ground = np.asarray(self.geo["depth"], np.float32)
        self.ground_source = "shell"

    # ------------------------------------------------------------ 坐标
    def work_cal(self) -> tuple[float, float, float]:
        g = self.geo or {}
        return float(g.get("ppu", 1.0)), float(g.get("cx", 0.0)), float(g.get("cy", 0.0))

    def scene_to_work_px(self, sx: float, sy: float) -> tuple[float, float]:
        w, h = self.work
        return sx / max(self.world_w, 1e-6) * w, sy / max(self.world_h, 1e-6) * h

    def work_px_to_scene(self, px: float, py: float) -> tuple[float, float]:
        w, h = self.work
        return px / w * self.world_w, py / h * self.world_h

    def _bilinear(self, field: np.ndarray, px: float, py: float) -> float:
        h, w = field.shape
        xi = min(max(px, 0.0), w - 1.001)
        yi = min(max(py, 0.0), h - 1.001)
        x0, y0 = int(math.floor(xi)), int(math.floor(yi))
        fx, fy = xi - x0, yi - y0
        return float(field[y0, x0] * (1 - fx) * (1 - fy) + field[y0, x0 + 1] * fx * (1 - fy)
                     + field[y0 + 1, x0] * (1 - fx) * fy + field[y0 + 1, x0 + 1] * fx * fy)

    def q_to_world(self, qx: float, qy: float, qz: float) -> tuple[float, float, float]:
        r = self.rows
        k = self.wu_per_q
        return (
            (r[0] * qx + r[1] * qy + r[2] * qz) * k,
            (r[3] * qx + r[4] * qy + r[5] * qz) * k,
            (r[6] * qx + r[7] * qy + r[8] * qz) * k,
        )

    def world_to_q(self, wx: float, wy: float, wz: float) -> tuple[float, float, float]:
        r = self.rows
        k = 1.0 / self.wu_per_q
        x, y, z = wx * k, wy * k, wz * k
        return (
            r[0] * x + r[3] * y + r[6] * z,
            r[1] * x + r[4] * y + r[7] * z,
            r[2] * x + r[5] * y + r[8] * z,
        )

    def q_to_work_px(self, qx: float, qy: float) -> tuple[float, float]:
        ppu, cx, cy = self.work_cal()
        return cx + qx * ppu, cy - qy * ppu

    def work_px_to_q(self, px: float, py: float, d: float) -> tuple[float, float, float]:
        ppu, cx, cy = self.work_cal()
        return (px - cx) / ppu, (cy - py) / ppu, d

    def ground_depth_at_scene(self, sx: float, sy: float) -> float:
        px, py = self.scene_to_work_px(sx, sy)
        return self._bilinear(self.ground, px, py)

    def scene_to_world_ground(self, sx: float, sy: float) -> tuple[float, float, float]:
        """画面点 → 该点脚下的地面世界点（wu）。这是"点一下画面得到 3D 地面点"的唯一出口。"""
        px, py = self.scene_to_work_px(sx, sy)
        d = self._bilinear(self.ground, px, py)
        return self.q_to_world(*self.work_px_to_q(px, py, d))

    def world_to_scene(self, wx: float, wy: float, wz: float) -> tuple[float, float]:
        """世界点 → 画面点（正交投影，丢掉深度）。"""
        qx, qy, _qz = self.world_to_q(wx, wy, wz)
        return self.work_px_to_scene(*self.q_to_work_px(qx, qy))

    # ------------------------------------------------------------ 地面高度场（世界 XZ）
    def _heightfield(self) -> dict:
        if self._hf is not None:
            return self._hf
        h, w = self.ground.shape
        ppu, cx, cy = self.work_cal()
        px = np.arange(w, dtype=np.float64)[None, :].repeat(h, 0)
        py = np.arange(h, dtype=np.float64)[:, None].repeat(w, 1)
        q = np.stack([(px - cx) / ppu, (cy - py) / ppu, self.ground.astype(np.float64)], -1)
        pos = (q @ self.R.T) * self.wu_per_q                   # (h,w,3) wu
        X, Y, Z = pos[..., 0].ravel(), pos[..., 1].ravel(), pos[..., 2].ravel()
        n = HEIGHTFIELD_N
        x0, x1 = float(X.min()), float(X.max())
        z0, z1 = float(Z.min()), float(Z.max())
        dx = max((x1 - x0) / (n - 1), 1e-6)
        dz = max((z1 - z0) / (n - 1), 1e-6)
        ix = np.clip(np.round((X - x0) / dx).astype(np.int64), 0, n - 1)
        iz = np.clip(np.round((Z - z0) / dz).astype(np.int64), 0, n - 1)
        acc = np.zeros((n, n), np.float64)
        cnt = np.zeros((n, n), np.float64)
        np.add.at(acc, (iz, ix), Y)
        np.add.at(cnt, (iz, ix), 1.0)
        hf = np.full((n, n), np.nan, np.float64)
        has = cnt > 0
        hf[has] = acc[has] / cnt[has]
        if not has.all():
            from scipy.ndimage import distance_transform_edt
            _dist, idx = distance_transform_edt(~has, return_distances=True, return_indices=True)
            hf = hf[idx[0], idx[1]]
        self._hf = {"hf": hf.astype(np.float64), "x0": x0, "z0": z0, "dx": dx, "dz": dz, "n": n,
                    "bounds": (x0, x1, z0, z1)}
        return self._hf

    def ground_height(self, wx: float, wz: float) -> float:
        """世界 XZ → 地面 Y（wu）。场外钳到边缘。"""
        hf = self._heightfield()
        px = (wx - hf["x0"]) / hf["dx"]
        pz = (wz - hf["z0"]) / hf["dz"]
        return self._bilinear(hf["hf"], px, pz)

    def ground_normal(self, wx: float, wz: float, eps: float = 4.0) -> tuple[float, float, float]:
        """地面法线（有限差分，单位向量，+Y 为主）。"""
        gx = (self.ground_height(wx + eps, wz) - self.ground_height(wx - eps, wz)) / (2 * eps)
        gz = (self.ground_height(wx, wz + eps) - self.ground_height(wx, wz - eps)) / (2 * eps)
        nx, ny, nz = -gx, 1.0, -gz
        ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        return nx / ln, ny / ln, nz / ln

    def ground_bounds(self) -> tuple[float, float, float, float]:
        return self._heightfield()["bounds"]

    # ------------------------------------------------------------ 深度壳
    def shell_contact(self, wx: float, wy: float, wz: float) -> dict | None:
        """世界点是否落在可见深度壳后面。

        返回 ``{pen_wu, normal, px, py, ground_like}``：``pen_wu`` > 0 = 在壳后面（沿视线的深度差，wu）；
        ``normal`` 是该像素的世界法线（单位向量，来自几何重建）；``ground_like`` = 法线朝上
        （这种像素的碰撞交给地面高度场，别在壳这里再算一遍）。出画返回 None。
        """
        qx, qy, qz = self.world_to_q(wx, wy, wz)
        px, py = self.q_to_work_px(qx, qy)
        h, w = self.geo["depth"].shape
        if px < 0 or py < 0 or px > w - 1 or py > h - 1:
            return None
        d = self._bilinear(self.geo["depth"], px, py)
        xi = min(max(int(round(px)), 0), w - 1)
        yi = min(max(int(round(py)), 0), h - 1)
        n = self.geo["normal"][yi, xi]
        nx, ny, nz = float(n[0]), float(n[1]), float(n[2])
        return {
            "pen_wu": (qz - d) * self.wu_per_q,
            "normal": (nx, ny, nz),
            "px": px, "py": py,
            "ground_like": ny > 0.6,
        }

    def shell_depth_wu(self, wx: float, wy: float, wz: float) -> float | None:
        """该世界点视线上的壳深度（wu 尺度的 q.z），出画 None。"""
        qx, qy, _ = self.world_to_q(wx, wy, wz)
        px, py = self.q_to_work_px(qx, qy)
        h, w = self.geo["depth"].shape
        if px < 0 or py < 0 or px > w - 1 or py > h - 1:
            return None
        return self._bilinear(self.geo["depth"], px, py) * self.wu_per_q

    def push_in_front_of_shell(self, wx: float, wy: float, wz: float, margin_wu: float) -> tuple[float, float, float]:
        """把世界点沿视线推到壳前 ``margin_wu`` 处（画面位置不变，只改深度）。"""
        qx, qy, _qz = self.world_to_q(wx, wy, wz)
        px, py = self.q_to_work_px(qx, qy)
        d = self._bilinear(self.geo["depth"], px, py)
        return self.q_to_world(qx, qy, d - margin_wu / self.wu_per_q)

    # ------------------------------------------------------------ 视图产物
    def mesh_bytes(self, stride: int = 2, edge_q: float = 0.55) -> bytes:
        """3D 视图用的三角网（世界 wu + 背景 uv）：
        ``[u32 nverts][u32 nidx][f32 ×5 × nverts: x y z u v][u32 × nidx]``。
        规则网格四边形拆两三角，四角深度跨度 > ``edge_q`` 的四边形丢掉（那是没观测到的深度断裂）。
        与照明实验室 ``stage_mesh`` 同一配方，但一律用 det=+1 的游戏 R，不碰实验室的 det=−1 网格。
        """
        pos = self.geo["pos"]
        dep = self.geo["depth"]
        h, w = dep.shape
        ys = np.arange(0, h, stride)
        xs = np.arange(0, w, stride)
        if ys[-1] != h - 1:
            ys = np.append(ys, h - 1)
        if xs[-1] != w - 1:
            xs = np.append(xs, w - 1)
        P = pos[np.ix_(ys, xs)].astype(np.float32) * np.float32(self.wu_per_q)   # (H,W,3)
        D = dep[np.ix_(ys, xs)]
        H, W = D.shape
        u = (xs.astype(np.float32) + 0.5) / w
        v = (ys.astype(np.float32) + 0.5) / h
        uv = np.stack(np.meshgrid(u, v), -1).astype(np.float32)                    # (H,W,2)
        verts = np.concatenate([P, uv], -1).reshape(-1, 5)
        # 四边形 → 索引
        i00 = (np.arange(H - 1)[:, None] * W + np.arange(W - 1)[None, :])
        i10 = i00 + 1
        i01 = i00 + W
        i11 = i01 + 1
        d00, d10, d01, d11 = D[:-1, :-1], D[:-1, 1:], D[1:, :-1], D[1:, 1:]
        spread = np.maximum.reduce([d00, d10, d01, d11]) - np.minimum.reduce([d00, d10, d01, d11])
        ok = spread <= edge_q
        tri = np.concatenate([
            np.stack([i00[ok], i01[ok], i10[ok]], -1),
            np.stack([i10[ok], i01[ok], i11[ok]], -1),
        ], 0).astype(np.uint32).ravel()
        head = struct.pack("<II", verts.shape[0], tri.shape[0])
        return head + verts.astype("<f4").tobytes() + tri.astype("<u4").tobytes()

    def heightfield_bytes(self) -> bytes:
        """前端用的世界 XZ 地面高度场：``[u32 n][f64 x0 z0 dx dz][f32 × n*n（行=z 列=x）]``。"""
        hf = self._heightfield()
        n = int(hf["n"])
        return (struct.pack("<I", n) + struct.pack("<dddd", hf["x0"], hf["z0"], hf["dx"], hf["dz"])
                + hf["hf"].astype("<f4").tobytes())

    def ground_bytes(self) -> bytes:
        """前端拾取用的行走面场：``[u32 w][u32 h][f32 × w*h 深度 q]``。"""
        h, w = self.ground.shape
        return struct.pack("<II", w, h) + self.ground.astype("<f4").tobytes()

    def shell_bytes(self) -> bytes:
        """前端拾取用的深度壳（可见表面）：与 :meth:`ground_bytes` 同格式。

        作者面用它把控制点放到桌面 / 台阶 / 箱顶上（壳比行走面近的像素 = 有东西立在地面上），
        以及把"抛体会撞到哪"画成障碍层。行走面场之外的第二份场，别拿它当地面。
        """
        dep = np.asarray(self.geo["depth"], np.float32)
        h, w = dep.shape
        return struct.pack("<II", w, h) + dep.astype("<f4").tobytes()

    def summary(self) -> dict:
        """给前端的一次性场景描述（标定 + 尺寸 + 实体清单）。"""
        nw, nh = self.native
        cal = None
        if self.cfg is not None:
            ppu, cx, cy = self.work_cal()
            cal = {
                "R": [list(map(float, r)) for r in self.R.tolist()],
                "ppuNative": float(self.cfg["ppu"]), "cxNative": float(self.cfg["cx"]), "cyNative": float(self.cfg["cy"]),
                "ppuWork": ppu, "cxWork": cx, "cyWork": cy,
                "work": {"w": self.work[0], "h": self.work[1]},
                "wuPerQUnit": self.wu_per_q,
                "cosTheta": self.cos_theta,
                "groundSource": self.ground_source,
                "groundBounds": list(self.ground_bounds()),
                "depthRange": [float(x) for x in self.geo["d_range"]],
            }
        return {
            "id": self.sid,
            "name": self.data.get("name") or self.sid,
            "background": self.bg_name,
            "backgrounds": scene_backgrounds(self.sid),
            "native": {"w": nw, "h": nh},
            "worldWidth": self.world_w, "worldHeight": self.world_h,
            "spawnPoint": self.data.get("spawnPoint"),
            "perspectiveScale": self.data.get("perspectiveScale"),
            "cal": cal,
            "npcs": [entity_summary(self.data, n) for n in (self.data.get("npcs") or []) if isinstance(n, dict)],
        }


# ---------------------------------------------------------------------------
# 实体预览（工作台里的"幽灵"）
# ---------------------------------------------------------------------------

_CHAR_REGISTRY: dict | None = None


def _character_registry() -> dict:
    global _CHAR_REGISTRY
    if _CHAR_REGISTRY is None:
        p = PUBLIC / "assets" / "data" / "character_registry.json"
        reg: dict = {}
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            chars = raw.get("characters") if isinstance(raw, dict) else raw
            rows = chars.values() if isinstance(chars, dict) else (chars or [])
            for c in rows:
                if isinstance(c, dict) and c.get("id"):
                    reg[str(c["id"])] = c
        except Exception:  # noqa: BLE001
            reg = {}
        _CHAR_REGISTRY = reg
    return _CHAR_REGISTRY


def _anchor_of(npc: dict) -> tuple[float, float]:
    a = npc.get("anchor") if isinstance(npc.get("anchor"), dict) else {}
    ax = a.get("x", 0.5)
    ay = a.get("y", 1.0)
    try:
        ax = float(ax)
        ay = float(ay)
    except (TypeError, ValueError):
        ax, ay = 0.5, 1.0
    return min(max(ax, 0.0), 1.0), min(max(ay, 0.0), 1.0)


def entity_summary(scene: dict, npc: dict) -> dict:
    """NPC 的位置 / 名字 / 锚点 / 有没有可预览的图。"""
    anim = npc.get("animFile")
    if not anim:
        ch = npc.get("character")
        if ch and isinstance(_character_registry().get(str(ch)), dict):
            anim = _character_registry()[str(ch)].get("animFile")
    di = npc.get("displayImage") if isinstance(npc.get("displayImage"), dict) else None
    ax, ay = _anchor_of(npc)
    try:
        scale = float(npc.get("scale", 1.0) or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    return {
        "id": str(npc.get("id") or ""),
        "name": str(npc.get("name") or npc.get("id") or ""),
        "x": float(npc.get("x", 0) or 0), "y": float(npc.get("y", 0) or 0),
        "anchor": {"x": ax, "y": ay},
        "scale": scale,
        "hasImage": bool(anim) or bool(di and di.get("image")),
        "facing": str(npc.get("initialFacing") or ""),
    }


def _disk(url: str) -> Path | None:
    u = str(url or "").strip()
    if not u:
        return None
    if u.startswith("/"):
        p = PUBLIC / u.lstrip("/")
    else:
        p = PUBLIC / "resources" / "runtime" / u
    return p if p.is_file() else None


def entity_preview(scene: dict, npc_id: str) -> dict | None:
    """实体首帧 PNG + 世界尺寸 + 锚点：``{png: bytes, worldWidth, worldHeight, anchor, scale, facing}``。

    与运行时同口径：``displayImage``（无 animFile 时）合成单帧；animFile 取 ``idle`` 首帧那一格；
    尺寸：给了 worldWidth/worldHeight 就用，只给一维按图素比推，都没给回落 100 宽。
    玩家没有 NpcDef：返回 150 wu 高的占位轮廓。
    """
    if npc_id == "player":
        img = Image.new("RGBA", (100, 150), (80, 160, 255, 110))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return {"png": buf.getvalue(), "worldWidth": 100.0, "worldHeight": 150.0,
                "anchor": {"x": 0.5, "y": 1.0}, "scale": 1.0, "facing": ""}
    npc = next((n for n in (scene.get("npcs") or []) if isinstance(n, dict) and str(n.get("id")) == npc_id), None)
    if npc is None:
        return None
    ax, ay = _anchor_of(npc)
    scale = entity_summary(scene, npc)["scale"]
    facing = str(npc.get("initialFacing") or "")
    anim = npc.get("animFile")
    if not anim:
        ch = npc.get("character")
        if ch and isinstance(_character_registry().get(str(ch)), dict):
            anim = _character_registry()[str(ch)].get("animFile")
    if anim:
        ap = _disk(anim)
        if ap is None:
            return None
        try:
            a = json.loads(ap.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return None
        sheet = ap.parent / str(a.get("spritesheet") or "atlas.png")
        if not sheet.is_file():
            return None
        img = Image.open(sheet).convert("RGBA")
        cols = int(a.get("cols") or 1)
        cw = int(a.get("cellWidth") or (img.width // max(cols, 1)))
        chh = int(a.get("cellHeight") or img.height)
        states = a.get("states") or {}
        idle = states.get("idle") or (next(iter(states.values())) if states else {})
        frames = (idle or {}).get("frames") or [0]
        fi = int(frames[0]) if frames else 0
        col, row = fi % max(cols, 1), fi // max(cols, 1)
        cell = img.crop((col * cw, row * chh, col * cw + cw, row * chh + chh))
        ww = float(a.get("worldWidth") or 0)
        wh = float(a.get("worldHeight") or 0)
        aspect = chh / max(cw, 1)
        if ww > 0 and wh > 0:
            pass
        elif wh > 0:
            ww = wh / aspect
        elif ww > 0:
            wh = ww * aspect
        else:
            ww, wh = 100.0, 100.0 * aspect
        buf = io.BytesIO()
        cell.save(buf, "PNG")
        return {"png": buf.getvalue(), "worldWidth": ww, "worldHeight": wh,
                "anchor": {"x": ax, "y": ay}, "scale": scale, "facing": facing}
    di = npc.get("displayImage") if isinstance(npc.get("displayImage"), dict) else None
    if di and di.get("image"):
        dp = _disk(str(di["image"]))
        if dp is None:
            return None
        img = Image.open(dp).convert("RGBA")
        ww = float(di.get("worldWidth") or 0)
        wh = float(di.get("worldHeight") or 0)
        aspect = img.height / max(img.width, 1)
        if ww > 0 and wh > 0:
            pass
        elif wh > 0:
            ww = wh / aspect
        elif ww > 0:
            wh = ww * aspect
        else:
            ww, wh = 100.0, 100.0 * aspect
        buf = io.BytesIO()
        img.save(buf, "PNG")
        if str(di.get("facing") or "").lower() == "left" and not facing:
            facing = "left"
        return {"png": buf.getvalue(), "worldWidth": ww, "worldHeight": wh,
                "anchor": {"x": ax, "y": ay}, "scale": scale, "facing": facing}
    return None


def contact_offset_y(preview: dict | None) -> float:
    """锚点 → 接地线的画面偏移（wu，Y 向下为正）：``(1 − anchorY) × 有效世界高``。"""
    if not preview:
        return 0.0
    ay = float(preview["anchor"]["y"])
    return (1.0 - ay) * float(preview["worldHeight"]) * float(preview.get("scale", 1.0))
