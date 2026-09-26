# -*- coding: utf-8 -*-
"""看着原画修碰撞：地形工作台的**命令行作者面**（给 agent / 批量复查用；桌面工作台照旧是人手的作者面）。

## 这个模块管什么

碰撞在运行时的意思只有一句：**玩家脚底那个画面点（场景坐标）能不能站**。存储上它是一张 M-world XZ 网格
（`collision.png`），运行时拿脚点走一条反投影链（场景坐标 → 行走面深度 → M-world → 落格）去查。所以：

- **判对错只看画面**：把"游戏此刻会挡住哪些画面点"逐点按运行时那条链算出来，红色叠在原画上看——
  屋顶、墙、水、崖外、家具底下是不是红的；路、院坝、台阶面是不是没红。深度只帮着**读懂**这张画
  （哪里是地、哪里是立面 / 悬空），不是碰撞的来源（制作人 2026-09-23：碰撞和深度、遮挡没有关系）。
- **改只做局部补丁**：在画面上圈一块多边形（场景坐标），说它"可走"或"阻挡"，本模块把它按同一条链
  换成网格单位的作者层多边形（`terrain.json` 的 `regions`，与桌面工作台画出来的是同一种东西，人随时能在
  工作台里接着拖顶点），再经唯一合成器 `terrain_compose.export_terrain` 导出。**不重烘、不整张重画**：
  哪里错改哪里，改完只动那一块。
- **圈能站的地方，不圈障碍物的外轮廓**：所有 `walk` 多边形（画上圈的路 / 院坝 / 地板）合起来就是"可走集"，
  可走集以外的整张图由本模块**自动生成**一块阻挡（`art_可走以外`，被可走集围住的空洞另成 `art_可走以外_岛N`），
  每次改多边形都重算。于是漏圈的地方是"该走的走不了"（摆人图上一眼看出空着），而不是"人站到了屋顶上"；
  可走集里面的障碍（桶、摊子、柱子、井）再圈 `block`，阻挡压过可走。
- **写盘走工作台自己的出口**（`authoring.save` → `terrain_compose.export_terrain`），`terrain/` 仍只有地形
  工作台这一个写入者（本模块就是它的一部分），`collision.png` / `collision.json` / `ground_d.png` 仍只从合成器出来。

## 命令

    python -m tools.terrain_workbench.art_review render  <场景> [--variant 夜]   # 原画 + 碰撞红块 + 标记点 + 坐标格
    python -m tools.terrain_workbench.art_review depth   <场景>                  # 深度 / 行走面可视化（读懂画用）
    python -m tools.terrain_workbench.art_review crowd   <场景> [--spacing 90] [--x0 --y0 --x1 --y1]  # 在所有可走处摆人（复查用）
    python -m tools.terrain_workbench.art_review crop    <场景> x0 y0 x1 y1 [--scale 0.8] [--depth] [--overlay] [--variant 夜]
                                                                                  # 局部放大看画（坐标格 / 深度着色 / 碰撞红块）
    python -m tools.terrain_workbench.art_review regions <场景>                  # 列作者层多边形
    python -m tools.terrain_workbench.art_review region  <场景> --id ID --kind walk|block --pts "x,y x,y ..." [--note 说明]
    python -m tools.terrain_workbench.art_review remove  <场景> --id ID
    python -m tools.terrain_workbench.art_review check   <场景>                  # 连通性 + 标记点落没落在阻挡里 + 多边形实现度
    python -m tools.terrain_workbench.art_review probe   <场景> x,y [x,y ...]    # 这几个画面点挡不挡
    python -m tools.terrain_workbench.art_review depthsheet <场景> [--out 路径]   # 深度体检 + 对照图（原画 | 深度 | 朝向 | 行走面）
    python -m tools.terrain_workbench.art_review crowd <场景> --occlusion both   # 第二轮：游戏真实深度遮挡 vs 作者估的遮挡（深度过了体检才用）
    python -m tools.terrain_workbench.art_review pin-screen <场景>               # 重做深度之前：钉住作者多边形的画面轮廓
    python -m tools.terrain_workbench.art_review reanchor   <场景>               # 重做深度之后：按画面轮廓落回新几何

产物落 `local/collision_review/<场景>/`（gitignore，不进资源）。坐标一律**场景坐标**（与 NPC / 热点 / 出生点同尺）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.character_lighting_lab import terrain_compose as tc                 # noqa: E402
from tools.character_lighting_lab.scene_geometry import bake_key                # noqa: E402

OUT_ROOT = ROOT / "local" / "collision_review"
PLAYER_ANIM = ROOT / "public" / "resources" / "runtime" / "animation" / "player_anim"
#: 多边形边的加密步长（场景坐标）：边在网格里会被行走面拉弯，顶点太稀就贴不住画上那条线
DENSIFY_STEP = 12.0
#: 标记点（出生点 / 出口 / NPC）附近多大范围算"脚下"（场景坐标）；落在阻挡格里的要报
MARK_FOOT_RADIUS = 0.0


# ---------------------------------------------------------------------------
# 场景几何：场景坐标 ↔ 碰撞网格（与运行时 SceneDepthSystem.collisionAt 同一条链）
# ---------------------------------------------------------------------------
@dataclass
class SceneGeom:
    sid: str
    scene: dict
    ww: float
    wh: float
    R: np.ndarray
    ppu: float
    cx: float
    cy: float
    dep: np.ndarray            # 行走面深度（work 分辨率，屏幕参数化）
    bake_dir: Path
    art_path: Path

    @property
    def runtime_dir(self) -> Path:
        return tc.SCENES_RT / self.sid

    def scene_to_xz(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """场景坐标 → M-world XZ（网格单位）。逐字对照 `terrain_overlay.collision_mask`。"""
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        U = x / self.ww
        V = y / self.wh
        gh_w, gw_w = self.dep.shape
        px = np.clip(U * gw_w, 0.0, gw_w - 1.001)
        py = np.clip(V * gh_w, 0.0, gh_w - 1.001)
        x0 = np.floor(px).astype(np.int64)
        y0 = np.floor(py).astype(np.int64)
        fx, fy = px - x0, py - y0
        dep = self.dep
        d = (dep[y0, x0] * (1 - fx) * (1 - fy) + dep[y0, x0 + 1] * fx * (1 - fy)
             + dep[y0 + 1, x0] * (1 - fx) * fy + dep[y0 + 1, x0 + 1] * fx * fy)
        sx = U * (2 * self.cx)
        sy = V * (2 * self.cy)
        qx = (sx - self.cx) / self.ppu
        qy = (self.cy - sy) / self.ppu
        R = self.R
        X = R[0, 0] * qx + R[0, 1] * qy + R[0, 2] * d
        Z = R[2, 0] * qx + R[2, 1] * qy + R[2, 2] * d
        return X, Z


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _backgrounds_for(scene: dict, variant: str | None) -> list:
    if variant:
        tv = (scene.get("timeVariants") or {}).get(variant) or {}
        if tv.get("backgrounds"):
            return tv["backgrounds"]
    return scene.get("backgrounds") or []


def load_geom(sid: str, variant: str | None = None) -> SceneGeom:
    if not (tc.SCENES_JSON / f"{sid}.json").is_file():
        raise SystemExit(f"没有这个场景：{sid}（场景 id 是 public/assets/scenes/ 下的文件名）")
    scene = json.loads((tc.SCENES_JSON / f"{sid}.json").read_text(encoding="utf-8"))
    cfg = scene.get("depthConfig")
    if not isinstance(cfg, dict) or not isinstance(cfg.get("M"), dict):
        raise SystemExit(f"{sid}: 没有 depthConfig，场景还没烘过深度，没有碰撞网格")
    bgs = _backgrounds_for(scene, variant)
    img = (bgs[0].get("image") if bgs and isinstance(bgs[0], dict) else None) or "background.png"
    bd = tc.SCENES_RT / sid / "lighting" / bake_key(str(img))
    meta = _read_json(bd / "lighting.json")
    gpng = bd / "ground_d.png"
    if not meta or not gpng.exists() or not isinstance(meta.get("ground_d"), dict):
        raise SystemExit(f"{sid}: {bd.name} 下没有行走面（ground_d），反投影链不通")
    ga = np.asarray(Image.open(gpng).convert("RGB"), np.float32)
    lo, hi = float(meta["ground_d"]["min"]), float(meta["ground_d"]["max"])
    dep = lo + (ga[..., 0] * 256.0 + ga[..., 1]) / 65535.0 * (hi - lo)
    M = cfg["M"]
    ww = float(scene.get("worldWidth") or 0)
    wh = float(scene.get("worldHeight") or 0)
    cx, cy = float(M["cx"]), float(M["cy"])
    if wh <= 0:
        wh = ww * cy / cx
    return SceneGeom(sid=sid, scene=scene, ww=ww, wh=wh, R=np.asarray(M["R"], np.float64), ppu=float(M["ppu"]),
                     cx=cx, cy=cy, dep=dep, bake_dir=bd, art_path=tc.SCENES_RT / sid / str(img))


def load_blocked(sid: str) -> tuple[np.ndarray, tc.GridMeta]:
    """游戏此刻读的碰撞（磁盘产物）。"""
    scene = json.loads((tc.SCENES_JSON / f"{sid}.json").read_text(encoding="utf-8"))
    cfg = scene.get("depthConfig") or {}
    grid = tc.load_collision_meta(sid, cfg)
    if grid is None:
        raise SystemExit(f"{sid}: 没有碰撞网格声明（collision.json）")
    side = _read_json(tc.sidecar_path(sid)) or {}
    png = tc.SCENES_RT / sid / str(side.get("collision_map") or cfg.get("collision_map") or "collision.png")
    blocked = np.asarray(Image.open(png).convert("RGB"), np.uint8)[..., 0] > 127
    return blocked, grid


def blocked_at(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, xs, ys) -> np.ndarray:
    """这些场景点在运行时挡不挡（网格外 = 不挡，与 isCollision 同语义）。"""
    X, Z = g.scene_to_xz(xs, ys)
    gx = np.floor((X - grid.x_min) / grid.cell_size).astype(np.int64)
    gz = np.floor((Z - grid.z_min) / grid.cell_size).astype(np.int64)
    ok = (gx >= 0) & (gx < grid.grid_width) & (gz >= 0) & (gz < grid.grid_height)
    out = np.zeros(np.shape(X), bool)
    out[ok] = blocked[gz[ok], gx[ok]]
    return out


def screen_mask(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, width: int) -> np.ndarray:
    """画面空间的阻挡掩码（width 宽，按世界宽高比取高）：每个像素中心走一遍运行时那条链。"""
    h = max(9, int(round(width * g.wh / g.ww)))
    xs = (np.arange(width) + 0.5) / width * g.ww
    ys = (np.arange(h) + 0.5) / h * g.wh
    X, Y = np.meshgrid(xs, ys)
    return blocked_at(g, blocked, grid, X, Y)


# ---------------------------------------------------------------------------
# 画
# ---------------------------------------------------------------------------
def _font(size: int) -> ImageFont.ImageFont:
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
              "/System/Library/Fonts/PingFang.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _art(g: SceneGeom, width: int) -> tuple[Image.Image, float]:
    im = Image.open(g.art_path).convert("RGB")
    h = int(round(width * g.wh / g.ww))
    im = im.resize((width, h), Image.LANCZOS)
    return im, width / g.ww


def _leaves_scene(hs: dict) -> bool:
    """跨点的动作里有切场景：跳完当拍就走了，落点只是跳的弧线终点，不是站的地方。"""
    acts = (hs.get("data") or {}).get("actions") or []
    return any(isinstance(a, dict) and a.get("type") == "switchScene" for a in acts)


def _marks(g: SceneGeom) -> list[tuple[str, str, float, float, float]]:
    """(种类, id, x, y, 半径) —— 出生点 / 出口 / 跨点落点与站位 / 其它交互热点 / NPC。

    `landing` 要站得住（跳过去就在这儿落地接着走）；跳完切场景的落点记成 `landing_x`，只画不查。
    """
    s = g.scene
    out: list[tuple[str, str, float, float, float]] = []
    sp = s.get("spawnPoint")
    if isinstance(sp, dict):
        out.append(("spawn", "spawnPoint", float(sp.get("x", 0)), float(sp.get("y", 0)), 0.0))
    for k, v in (s.get("spawnPoints") or {}).items():
        if isinstance(v, dict):
            out.append(("spawn", k, float(v.get("x", 0)), float(v.get("y", 0)), 0.0))
    for hs in s.get("hotspots") or []:
        if not isinstance(hs, dict):
            continue
        t = hs.get("type")
        if t == "transition":
            out.append(("exit", str(hs.get("id")), float(hs.get("x", 0)), float(hs.get("y", 0)),
                        max(float(hs.get("interactionRange") or 50), 60.0)))
        elif t == "act_spot":
            d = hs.get("data") or {}
            leaves = _leaves_scene(hs)
            for key, kind in (("align", "align"), ("landing", "landing_x" if leaves else "landing")):
                p = d.get(key)
                if isinstance(p, dict):
                    out.append((kind, f"{hs.get('id')}.{key}", float(p.get("x", 0)), float(p.get("y", 0)), 0.0))
        elif float(hs.get("interactionRange") or 0) > 0:
            out.append(("hotspot", str(hs.get("id")), float(hs.get("x", 0)), float(hs.get("y", 0)),
                        float(hs.get("interactionRange") or 0)))
    for n in s.get("npcs") or []:
        if isinstance(n, dict):
            out.append(("npc", str(n.get("id")), float(n.get("x", 0)), float(n.get("y", 0)), 0.0))
    return out


_MARK_COLORS = {"spawn": (40, 255, 90), "exit": (40, 220, 255), "npc": (255, 150, 40),
                "align": (255, 90, 255), "landing": (255, 255, 60), "landing_x": (190, 190, 120),
                "hotspot": (180, 200, 255)}


def entity_block_polys(g: SceneGeom, include_conditional: bool = True) -> list[tuple[str, list[tuple[float, float]]]]:
    """热点 / NPC 自带的 `collisionPolygon`（运行时与地形碰撞一起挡人）→ 场景坐标多边形。

    与 `src/utils/hotspotCollision.ts#anchorCollisionPolygonToWorld` 同式：局部坐标绕锚点先缩放后旋转，再乘
    透视系数；旧数据（非局部）按世界坐标，有实例变换时同样绕锚点施加。显隐条件不管（按"在场"算）。
    """
    persp = g.scene.get("perspectiveScale")
    try:
        from tools.editor.shared.entity_transform_math import perspective_scale_at
    except ImportError:                                  # pragma: no cover
        perspective_scale_at = None
    out = []
    for kind in ("hotspots", "npcs"):
        for e in g.scene.get(kind) or []:
            poly = e.get("collisionPolygon") if isinstance(e, dict) else None
            if not isinstance(poly, list) or len(poly) < 3:
                continue
            if not include_conditional and e.get("conditions"):
                continue                     # 只在某段剧情里出现的（人群、临时箱堆）：平时不挡，连通性不算它
            ax, ay = float(e.get("x", 0)), float(e.get("y", 0))
            sc = float(e["scale"]) if isinstance(e.get("scale"), (int, float)) and e["scale"] > 0 else 1.0
            rot = math.radians(float(e["rotation"])) if isinstance(e.get("rotation"), (int, float)) else 0.0
            es = perspective_scale_at(persp, ax, ay) if (persp and perspective_scale_at) else 1.0
            local = e.get("collisionPolygonLocal") is True
            transformed = sc != 1 or rot != 0 or es != 1
            pts = []
            for q in poly:
                lx, ly = float(q.get("x", 0)), float(q.get("y", 0))
                if not local:
                    if not transformed:
                        pts.append((lx, ly))
                        continue
                    lx, ly = lx - ax, ly - ay
                vx, vy = lx * sc, ly * sc
                if rot:
                    vx, vy = vx * math.cos(rot) - vy * math.sin(rot), vx * math.sin(rot) + vy * math.cos(rot)
                pts.append((ax + vx * es, ay + vy * es))
            out.append((str(e.get("id")), pts))
    return out


def _draw_entity_polys(dr: ImageDraw.ImageDraw, g: SceneGeom, k: float) -> None:
    """热点 / NPC 自带碰撞（品红实块）+ 触发区（青色虚框 + id）：两者都得在走得到的地上才有意义。"""
    conditional = {eid for eid, _ in entity_block_polys(g)} - {eid for eid, _ in entity_block_polys(g, False)}
    for eid, pts in entity_block_polys(g):
        poly = [(x * k, y * k) for x, y in pts]
        if eid in conditional:          # 只在某段剧情里在场：只描边
            dr.line(poly + poly[:1], fill=(255, 0, 255, 160), width=1)
        else:
            dr.polygon(poly, fill=(255, 0, 255, 60), outline=(255, 0, 255, 230))
    f = _font(12)
    for z in g.scene.get("zones") or []:
        poly = z.get("polygon") if isinstance(z, dict) else None
        if not isinstance(poly, list) or len(poly) < 3:
            continue
        pp = [(float(q.get("x", 0)) * k, float(q.get("y", 0)) * k) for q in poly]
        for a, b in zip(pp, pp[1:] + pp[:1]):
            n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 8))
            for i in range(0, n, 2):
                t0, t1 = i / n, min(1.0, (i + 1) / n)
                dr.line([(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
                         (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)], fill=(0, 255, 255, 220), width=2)
        lx, ly = min(pp, key=lambda q: q[0] + q[1])
        dr.text((lx + 3, ly + 2), str(z.get("id")), fill=(0, 255, 255, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))


def _draw_grid(dr: ImageDraw.ImageDraw, g: SceneGeom, k: float, im_w: int, im_h: int) -> None:
    step = 100.0 if max(g.ww, g.wh) <= 2600 else 200.0
    if max(g.ww, g.wh) <= 900:
        step = 50.0
    f = _font(max(11, int(im_w / 110)))
    x = 0.0
    while x <= g.ww + 1e-6:
        px = x * k
        dr.line([(px, 0), (px, im_h)], fill=(255, 255, 255, 38), width=1)
        if int(round(x)) % int(step * 2) == 0:
            dr.text((px + 2, 2), f"{int(x)}", fill=(255, 255, 255, 220), font=f)
        x += step
    y = 0.0
    while y <= g.wh + 1e-6:
        py = y * k
        dr.line([(0, py), (im_w, py)], fill=(255, 255, 255, 38), width=1)
        if int(round(y)) % int(step * 2) == 0:
            dr.text((2, py + 2), f"{int(y)}", fill=(255, 255, 255, 220), font=f)
        y += step


def _draw_marks(dr: ImageDraw.ImageDraw, g: SceneGeom, k: float, im_w: int,
                bad: set[str] | None = None, font_px: int | None = None) -> None:
    f = _font(font_px or max(12, min(22, int(im_w / 95))))
    for kind, mid, x, y, rng in _marks(g):
        c = _MARK_COLORS.get(kind, (255, 255, 255))
        px, py = x * k, y * k
        r = max(5, int(im_w / 260))
        if rng > 0:
            rr = rng * k
            dr.ellipse((px - rr, py - rr, px + rr, py + rr), outline=c + (200,), width=2)
        shape = dr.rectangle if kind == "npc" else dr.ellipse
        shape((px - r, py - r, px + r, py + r), fill=c + (255,), outline=(0, 0, 0, 255))
        label = mid + (" ✗阻挡" if bad and mid in bad else "")
        dr.text((px + r + 3, py - r - 2), label, fill=c + (255,), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))


def object_volumes(g: SceneGeom, k: float, size: tuple[int, int]) -> list[tuple[str, np.ndarray, np.ndarray, tuple]]:
    """带物体高的阻挡块 → (id, 占地掩码, 轮廓掩码, 包围盒)，画面分辨率（k = 像素 / 场景单位）。

    轮廓 = 占地往上扫 h（每一列：占地里任一点往上 h 以内都被这个物体挡住）。完全不读深度：遮挡是作者按画估的
    （有的图深度整张是错的）。只有 block 且写了 `screen.h` 的块参与；没写 h 的块当"扁的"（不挡人）。
    `screen.h0`（可选）= 下面空着多高：只挡占地往上 h0..h 那一段。**walk** 块带 h0 + h = 有顶的通道
    （门楼 / 过街楼 / 门洞底下的路）：照样能走，站在里面的人 h0 以上被顶挡住、脚边不挡。占地可以伸出画面（画底前景的墙）：先在扩出来的画布上算，再裁回画面。
    """
    import cv2
    w, hh = size
    out = []
    for r in tc.load_terrain(g.sid).get("regions") or []:
        scr = r.get("screen") or {}
        oh = scr.get("h")
        oh0 = scr.get("h0")
        covered = r.get("kind") == "walk" and isinstance(oh0, (int, float)) and oh0 > 0
        if (r.get("kind") != "block" and not covered) or _is_generated(r) or not isinstance(oh, (int, float)) or oh <= 0:
            continue
        pts = region_screen_pts(g, r)
        if not pts:
            continue
        H = int(round(oh * k))
        H0 = int(round(oh0 * k)) if isinstance(oh0, (int, float)) and 0 < oh0 < oh else 0
        arr = np.round(np.array(pts, np.float64) * k).astype(np.int32)
        # 扩出来的画布（不裁到画面）：占地整个在画底以外时，它往上扫 h 仍会盖进画面
        ex0 = int(arr[:, 0].min()) - 1
        ex1 = int(arr[:, 0].max()) + 2
        ey1 = int(arr[:, 1].max()) + 2
        ey0 = int(arr[:, 1].min()) - H - 1
        fp = np.zeros((ey1 - ey0, ex1 - ex0), np.uint8)
        cv2.fillPoly(fp, [arr - np.array([ex0, ey0])], 1)
        # 列向滑窗：sil[y] = fp[y+H0 .. y+H] 里有没有 1（累加和相减，一次算完）
        c = np.vstack([np.zeros((1, fp.shape[1]), np.int32), np.cumsum(fp, axis=0, dtype=np.int32)])
        n = fp.shape[0]
        idx = np.arange(n)
        lo = np.minimum(idx + H0, n)
        top = np.minimum(idx + H + 1, n)
        sil = (c[top] - c[lo]) > 0
        # 裁回画面
        x0, y0 = max(0, ex0), max(0, ey0)
        x1, y1 = min(w, ex1), min(hh, ey1)
        if x1 <= x0 or y1 <= y0:
            continue
        fpc = fp.astype(bool)[y0 - ey0:y1 - ey0, x0 - ex0:x1 - ex0]
        silc = sil[y0 - ey0:y1 - ey0, x0 - ex0:x1 - ex0]
        if not silc.any():
            continue
        out.append((str(r.get("id")), fpc, silc, (x0, y0, x1, y1)))
    return out


def _draw_regions(dr: ImageDraw.ImageDraw, g: SceneGeom, k: float, im_w: int, font_px: int | None = None,
                  skip: set[str] | None = None) -> None:
    """作者层多边形按作者在画上圈的那一圈（`screen.points`）画轮廓 + id。"""
    doc = tc.load_terrain(g.sid)
    f = _font(font_px or max(11, min(20, int(im_w / 110))))
    for r in doc.get("regions") or []:
        note = r.get("screen") or {}
        if skip and r.get("id") in skip:
            continue                       # 草稿要重写这块：只画草稿那一版，免得两条同名轮廓
        if r.get("id") == OUTSIDE_ID:
            continue                       # 生成的外围块没有单圈轮廓：可走集的绿线就是它的边
        pts = note.get("points") if _is_generated(r) else region_screen_pts(g, r)
        if not pts:
            continue
        c = (60, 255, 120) if r["kind"] == "walk" else (255, 60, 60)
        if _is_generated(r):
            c = (255, 160, 60)
        poly = [(float(p[0]) * k, float(p[1]) * k) for p in pts]
        dr.line(poly + [poly[0]], fill=c + (255,), width=2)
        oh = note.get("h") if isinstance(note, dict) else None
        if r["kind"] == "block" and isinstance(oh, (int, float)) and oh > 0:
            # 占地往上抬 h = 估出来的顶面（屋顶 / 桌面）：应该和画上的顶面对得上，对不上就是占地或 h 估错了
            top = [(x, y - oh * k) for x, y in poly]
            for a, b in zip(top, top[1:] + top[:1]):
                seg = math.hypot(b[0] - a[0], b[1] - a[1])
                n = max(1, int(seg / 6))
                for i in range(0, n, 2):
                    t0, t1 = i / n, min(1.0, (i + 1) / n)
                    dr.line([(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
                             (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)], fill=(255, 210, 60, 230), width=1)
        # 标签挂在最靠左上的顶点旁：质心常常落在别的多边形里，一多就认不出谁是谁
        lx, ly = min(poly, key=lambda p: p[0] + p[1])
        dr.text((lx + 3, ly + 1), r["id"], fill=c + (255,), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))


def _variant_names(scene: dict) -> list[str]:
    return [vid for vid, tv in (scene.get("timeVariants") or {}).items() if isinstance(tv, dict) and tv.get("backgrounds")]


def cmd_render(sid: str, variant: str | None, width: int, out: Path | None = None, quiet: bool = False) -> Path:
    g = load_geom(sid, variant)
    blocked, grid = load_blocked(sid)
    im, k = _art(g, width)
    m = screen_mask(g, blocked, grid, im.width)
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    a = np.zeros((im.height, im.width, 4), np.uint8)
    a[m] = (255, 30, 30, 105)
    ov = Image.fromarray(a, "RGBA")
    base = Image.alpha_composite(im.convert("RGBA"), ov)
    dr = ImageDraw.Draw(base, "RGBA")
    _draw_grid(dr, g, k, im.width, im.height)
    bad = {mid for kind, mid, x, y, _ in _marks(g)
           if kind in ("spawn", "landing", "align") and bool(blocked_at(g, blocked, grid, [x], [y])[0])}
    _draw_regions(dr, g, k, im.width)
    _draw_entity_polys(dr, g, k)
    _draw_marks(dr, g, k, im.width, bad)
    dest = out or (OUT_ROOT / sid / f"overlay{('_' + variant) if variant else ''}.png")
    dest.parent.mkdir(parents=True, exist_ok=True)
    base.convert("RGB").save(dest)
    pct = float(m.mean() * 100)
    if not quiet:
        print(json.dumps({"scene": sid, "variant": variant or "", "out": str(dest), "blockedScreenPct": round(pct, 1),
                          "marksOnBlock": sorted(bad), "art": g.art_path.name, "world": [g.ww, g.wh],
                          "variants": _variant_names(g.scene)}, ensure_ascii=False))
    return dest


def _depth_tint(g: SceneGeom, size: tuple[int, int]) -> Image.Image | None:
    """原始深度按行归一着色（凸起发蓝、地面发橙）。

    ⚠ **不作依据**（制作人 2026-09-23：有的图深度整张是错的）。能不能站、东西占多大地、后面挡住了什么，
    一律看画估；这张着色顶多在画面暗到认不出轮廓时瞄一眼，和画对不上就信画。
    """
    raw = tc.SCENES_RT / g.sid / str((g.scene.get("depthConfig") or {}).get("depth_map") or "raw_depth_rg.png")
    if not raw.exists():
        return None
    ra = np.asarray(Image.open(raw).convert("RGB"), np.float32)
    rv = ra[..., 0] * 256 + ra[..., 1]
    lo = np.percentile(rv, 15, axis=1, keepdims=True)
    hi = np.percentile(rv, 99, axis=1, keepdims=True)
    n = np.clip((rv - lo) / np.maximum(1e-6, hi - lo), 0, 1)
    rgb = np.stack([n * 255, n * 120, 255 - n * 255], -1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB").resize(size, Image.BILINEAR)


def _load_draft(path: str) -> dict[str, dict]:
    """草稿：{id: {"kind": "walk"|"block", "pts": "x,y x,y ...", "note": "...", "h": 物体高?, "h0": 下面空着多高?,
    "flat": true?}}（场景坐标；flat = 故意不写 h 的平块，死角地 / 墙后封口）。

    block 的 pts 圈的是物体在**地上的占地**；h 是它从占地往上立多高（画面上的场景单位：房子 = 檐口 / 屋脊到墙脚，
    桌凳 = 面到脚）。h 只用来估遮挡：复查图里站在它后面的人会被它挡住，叠图上画出"占地往上抬 h"的顶面轮廓对照。
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for rid, v in raw.items():
        if isinstance(v, str):
            v = {"kind": "block", "pts": v}
        hh = v.get("h")
        h0 = v.get("h0")
        out[rid] = {"kind": v.get("kind", "block"), "pts": _parse_pts(v["pts"]), "note": v.get("note", ""),
                    "h": float(hh) if isinstance(hh, (int, float)) and hh > 0 else None,
                    "h0": float(h0) if isinstance(h0, (int, float)) and h0 > 0 else None,
                    "flat": bool(v.get("flat"))}
    return out


def cmd_crop(sid: str, box: tuple[float, float, float, float], scale: float, depth: bool, overlay: bool,
             variant: str | None, draft: str | None, out: str | None, grid_lines: bool = True) -> Path:
    """局部放大：原画（可叠深度着色 / 游戏此刻的碰撞红块）+ 50/100 坐标格 + 标记点 + 已有多边形 + 草稿多边形。

    画多边形前先用它把那一片看清楚，坐标直接从格子上读；`--draft` 把还没落盘的多边形画上去对一对。
    """
    from PIL import ImageOps
    g = load_geom(sid, variant)
    x0, y0, x1, y1 = box
    if not scale:
        # 缺省把这一块铺到约 1100 像素宽：小场景（800 宽的庙堂）自动放大，大图的一块也不会糊
        scale = max(0.3, min(4.0, 1100.0 / max(1.0, x1 - x0)))
    full_w = int(round(g.ww * scale))
    im, k = _art(g, full_w)
    # 夜景 / 暗调原画按局部拉一下对比度再看（只为看清，不改任何东西）
    sub = im.crop((int(x0 * k), int(y0 * k), int(math.ceil(x1 * k)), int(math.ceil(y1 * k))))
    lo_hi = ImageOps.autocontrast(sub, cutoff=1)
    im.paste(lo_hi, (int(x0 * k), int(y0 * k)))
    base = im.convert("RGBA")
    if depth:
        t = _depth_tint(g, im.size)
        if t is not None:
            base = Image.blend(im, t, 0.45).convert("RGBA")
    if overlay:
        blocked, grid = load_blocked(sid)
        m = screen_mask(g, blocked, grid, im.width)
        a = np.zeros((im.height, im.width, 4), np.uint8)
        a[m[:im.height, :im.width]] = (255, 30, 30, 95)
        base = Image.alpha_composite(base, Image.fromarray(a, "RGBA"))
    dr = ImageDraw.Draw(base, "RGBA")
    _draw_regions(dr, g, k, im.width, font_px=12, skip=set(_load_draft(draft)) if draft else None)
    _draw_entity_polys(dr, g, k)
    if draft:
        f = _font(13)
        fill = Image.new("RGBA", base.size, (0, 0, 0, 0))
        fd = ImageDraw.Draw(fill, "RGBA")
        for rid, d in _load_draft(draft).items():
            if d["kind"] == "block":
                fd.polygon([(x * k, y * k) for x, y in d["pts"]], fill=(255, 40, 160, 70))
        base = Image.alpha_composite(base, fill)
        dr = ImageDraw.Draw(base, "RGBA")
        for rid, d in _load_draft(draft).items():
            poly = [(x * k, y * k) for x, y in d["pts"]]
            c = (60, 255, 120) if d["kind"] == "walk" else (255, 60, 200)
            dr.line(poly + [poly[0]], fill=c + (255,), width=2)
            if d["kind"] == "block" and d.get("h"):
                # 占地往上抬 h = 估出来的顶面：对着画上的屋顶 / 桌面看，对不上就是占地或 h 估错了
                top = [(x, y - d['h'] * k) for x, y in poly]
                for a, b in zip(top, top[1:] + top[:1]):
                    n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 6))
                    for i in range(0, n, 2):
                        t0, t1 = i / n, min(1.0, (i + 1) / n)
                        dr.line([(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
                                 (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)], fill=(255, 210, 60, 240), width=1)
            for p in poly:
                dr.ellipse((p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2), fill=c + (255,))
            lx, ly = min(poly, key=lambda p: p[0] + p[1])
            dr.text((lx + 3, ly + 1), rid, fill=c + (255,), font=f, stroke_width=2, stroke_fill=(0, 0, 0, 255))
    _draw_marks(dr, g, k, im.width, font_px=12)
    crop = base.crop((int(x0 * k), int(y0 * k), int(math.ceil(x1 * k)), int(math.ceil(y1 * k))))
    cd = ImageDraw.Draw(crop, "RGBA")
    f = _font(13)
    # 格线疏密跟着放大倍数走：每格至少 ~22 像素，标签每 4 格一个——格子太密会盖住画
    step = next(s_ for s_ in (10.0, 25.0, 50.0, 100.0, 200.0, 500.0) if s_ * k >= 22)
    if not grid_lines:
        step = 1e9                      # --no-grid：高倍放大时格子会盖住画
    lab = step * (2 if step * k >= 45 else 4)
    if step == 10.0:
        lab = 50.0
    x = math.floor(x0 / step + 1) * step
    while x < x1:
        px = (x - x0) * k
        major = int(round(x)) % int(lab) == 0
        cd.line([(px, 0), (px, crop.height)], fill=(255, 255, 0, 130 if major else 50), width=1)
        if major:
            cd.text((px + 2, 2), str(int(x)), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
        x += step
    y = math.floor(y0 / step + 1) * step
    while y < y1:
        py = (y - y0) * k
        major = int(round(y)) % int(lab) == 0
        cd.line([(0, py), (crop.width, py)], fill=(255, 255, 0, 130 if major else 50), width=1)
        if major:
            cd.text((2, py + 2), str(int(y)), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
        y += step
    tag = f"{int(x0)}_{int(y0)}_{int(x1)}_{int(y1)}" + ("_d" if depth else "") + ("_o" if overlay else "")
    dest = Path(out) if out else OUT_ROOT / sid / f"crop_{tag}{('_' + variant) if variant else ''}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    crop.convert("RGB").save(dest)
    print(json.dumps({"scene": sid, "out": str(dest), "size": list(crop.size)}, ensure_ascii=False))
    return dest


def cmd_apply(sid: str, draft: str) -> int:
    """草稿里的多边形一次落盘（同 id 替换），只导出一次；逐块报实现度。"""
    g = load_geom(sid)
    d = _load_draft(draft)
    for rid in d:
        if rid == OUTSIDE_ID or rid.startswith(OUTSIDE_ID + "_"):
            raise SystemExit(f"{rid} 是自动生成的，不能手写")
        if d[rid]["kind"] not in tc.REGION_KINDS:
            raise SystemExit(f"{rid}: kind 只能是 walk / block")
    doc = tc.load_terrain(sid)
    regions = [r for r in (doc.get("regions") or []) if r.get("id") not in d]
    for rid, v in d.items():
        regions.append(_make_region(g, rid, v["kind"], v["pts"], v["note"], v.get("h"), v.get("h0"), v.get("flat")))
    res = _save_and_export(sid, regions)
    blocked, grid = load_blocked(sid)
    regions = tc.load_terrain(sid).get("regions") or []
    low = 0
    for r in regions:
        if r["id"] in d or r["id"] == OUTSIDE_ID:
            ratio = region_realized(g, blocked, grid, r, regions)
            sp = region_screen_pts(g, r) if not _is_generated(r) else None
            floor = ratio_floor(cells_thick(grid, r["points"])) if (sp is not None and r["id"] != OUTSIDE_ID) else 0.9
            small = floor is None
            flag = "" if ratio is None or ratio >= (floor or 0.9) else ("  (比网格细，仅参考)" if small else "  ⚠ 实现不足")
            if small and flag:
                print(f"{r['id']:<24} {r['kind']:<6} {ratio:.3f}{flag}")
                continue
            low += bool(flag)
            print(f"{r['id']:<24} {r['kind']:<6} {'' if ratio is None else f'{ratio:.3f}'}{flag}")
    print(json.dumps({"scene": sid, "applied": len(d), **res}, ensure_ascii=False))
    return 1 if low else 0


def cmd_depth(sid: str, width: int) -> Path:
    """行走面深度（屏幕参数化）+ 原始深度的着色图，并排。

    ⚠ **不作依据**：有的图深度整张是错的（崖墓系列标定塌成平面等）。修碰撞只看画，这张图只在排查
    "某块多边形实现度低"时看行走面是不是把几个画面点压进了同一格。
    """
    g = load_geom(sid)
    im, _k = _art(g, width)
    h = im.height
    dep = g.dep
    dn = (dep - np.nanpercentile(dep, 2)) / max(1e-9, np.nanpercentile(dep, 98) - np.nanpercentile(dep, 2))
    dn = np.clip(dn, 0, 1)
    # 等深线：行走面上等深线的疏密就是"地往里走得快还是慢"，断开 / 挤成一团 = 立面或断崖
    lines = (np.abs(((dn * 24) % 1.0) - 0.5) < 0.06)
    rgb = np.stack([dn * 255, (1 - np.abs(dn - 0.5) * 2) * 200, (1 - dn) * 255], -1).astype(np.uint8)
    rgb[lines] = (255, 255, 255)
    gimg = Image.fromarray(rgb, "RGB").resize((width, h), Image.NEAREST)
    raw = tc.SCENES_RT / sid / str((g.scene.get("depthConfig") or {}).get("depth_map") or "raw_depth_rg.png")
    panels = [im, Image.blend(im, gimg, 0.55)]
    if raw.exists():
        ra = np.asarray(Image.open(raw).convert("RGB"), np.float32)
        rv = ra[..., 0] * 256 + ra[..., 1]
        rv = (rv - np.percentile(rv, 1)) / max(1e-9, np.percentile(rv, 99) - np.percentile(rv, 1))
        rv = np.clip(rv, 0, 1)
        rimg = Image.fromarray((np.stack([rv, rv, rv], -1) * 255).astype(np.uint8), "RGB").resize((width, h))
        panels.append(rimg)
    sheet = Image.new("RGB", (width, h * len(panels)))
    for i, p in enumerate(panels):
        sheet.paste(p, (0, i * h))
    dest = OUT_ROOT / sid / "depth.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest)
    print(json.dumps({"scene": sid, "out": str(dest), "panels": ["原画", "行走面深度着色+等深线", "原始深度"][:len(panels)]},
                     ensure_ascii=False))
    return dest


# ---------------------------------------------------------------------------
# 运行时深度（第二轮用：深度已按原画标定、对照图过了之后才作依据）
# ---------------------------------------------------------------------------
#: 与 `src/core/SceneDepthSystem.ts` 的 LAB_OCCLUSION_BIAS 同值：精灵深度往相机方向让一点，脚边不自遮
RUNTIME_FOOT_BIAS = 0.045


@dataclass
class RuntimeDepth:
    """游戏遮挡用的那张场景深度（`depthConfig.depth_map` 按 `depth_mapping` 解码，q 单位，原生分辨率）。"""
    d: np.ndarray
    nw: int
    nh: int
    tol: float
    floor_offset: float
    dps: float        # 直立 quad 的深度梯度 = tanθ / ppu（每原生像素）
    theta: float


def load_runtime_depth(g: SceneGeom) -> RuntimeDepth | None:
    cfg = g.scene.get("depthConfig") or {}
    p = tc.SCENES_RT / g.sid / str(cfg.get("depth_map") or "raw_depth_rg.png")
    dm = cfg.get("depth_mapping") or {}
    if not p.exists() or "scale" not in dm:
        return None
    a = np.asarray(Image.open(p).convert("RGB"), np.float64)
    v = (a[..., 0] * 256.0 + a[..., 1]) / 65535.0
    if dm.get("invert"):
        v = 1.0 - v
    d = v * float(dm["scale"]) + float(dm.get("offset", 0.0))
    theta = math.atan2(-g.R[1, 2], g.R[1, 1])
    dps = float((cfg.get("shader") or {}).get("depth_per_sy") or math.tan(theta) / g.ppu)
    return RuntimeDepth(d=d, nw=d.shape[1], nh=d.shape[0], tol=float(cfg.get("depth_tolerance", 0.05)),
                        floor_offset=float(cfg.get("floor_offset", 0.0)), dps=dps, theta=theta)


def ground_depth_at(g: SceneGeom, x: float, y: float) -> float:
    """脚点的行走面深度（与运行时 sampleGroundField 同一张 ground_d，双线性）。"""
    gh_w, gw_w = g.dep.shape
    px = min(max(x / g.ww * gw_w, 0.0), gw_w - 1.001)
    py = min(max(y / g.wh * gh_w, 0.0), gh_w - 1.001)
    x0, y0 = int(px), int(py)
    fx, fy = px - x0, py - y0
    d = g.dep
    return float(d[y0, x0] * (1 - fx) * (1 - fy) + d[y0, x0 + 1] * fx * (1 - fy)
                 + d[y0 + 1, x0] * (1 - fx) * fy + d[y0 + 1, x0 + 1] * fx * fy)


def depth_occlusion(g: SceneGeom, rd: RuntimeDepth, foot: tuple[float, float], box: tuple[int, int, int, int],
                    k: float) -> np.ndarray:
    """站在 `foot`（场景坐标）的人，画布上 `box`=(ox, oy, w, h) 这块精灵里哪些像素被**游戏的深度遮挡**挡住。

    与 `DepthOcclusionFilter` 同式：精灵每个像素当作立在脚点上的直立板，
    spriteDepth = 脚点行走面深度 + dps·(syTex − syTexFoot) + floor_offset − bias，场景深度 + 容差 < spriteDepth 即被挡。
    """
    ox, oy, w, h = box
    xs = (ox + np.arange(w) + 0.5) / k
    ys = (oy + np.arange(h) + 0.5) / k
    px = np.clip((xs / g.ww * rd.nw).astype(np.int64), 0, rd.nw - 1)
    py_f = ys / g.wh * rd.nh
    py = np.clip(py_f.astype(np.int64), 0, rd.nh - 1)
    scene = rd.d[py[:, None], px[None, :]]
    foot_sy = foot[1] / g.wh * rd.nh
    sprite = (ground_depth_at(g, *foot) + rd.dps * (py_f - foot_sy) + rd.floor_offset - RUNTIME_FOOT_BIAS)[:, None]
    inside = ((xs >= 0) & (xs < g.ww))[None, :] & ((ys >= 0) & (ys < g.wh))[:, None]
    return (scene + rd.tol < sprite) & inside


def up_facing(d: np.ndarray, ppu: float, theta: float, sigma: float = 1.5) -> np.ndarray:
    """逐像素表面朝上的余弦（1 = 水平地面，0 = 竖直立面）。与烘焙器 `pipeline.up_dot_field` 同式。
    深度成常数（标定塌成平面）时处处 = sinθ。"""
    from scipy.ndimage import gaussian_filter
    ds = gaussian_filter(d, sigma) if sigma > 0 else d
    dqx = np.gradient(ds, axis=1) * ppu
    dqy = -np.gradient(ds, axis=0) * ppu
    return (dqy * math.cos(theta) + math.sin(theta)) / np.sqrt(dqx * dqx + dqy * dqy + 1.0)


def cmd_depthsheet(sid: str, width: int, out: str | None = None) -> dict:
    """深度体检 + 交付对照图：原画 | 运行时深度（红近蓝远）| 朝向（白 = 朝上的地，黑 = 竖直立面）| 行走面高度。

    数值（JSON）：俯角、作者可走区上的路面坡度中位、可走区以外表面偏离竖直的中位、深度是否塌成常数。
    **塌平的判据**：整张朝向图近乎一个灰（处处 ≈ sinθ）/ 深度几乎没有起伏 —— 这时深度不能当第二轮的依据。
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.cm as cm
    import cv2
    g = load_geom(sid)
    rd = load_runtime_depth(g)
    if rd is None:
        raise SystemExit(f"{sid}: 没有运行时深度图（depthConfig.depth_map / depth_mapping）")
    im, k = _art(g, width)
    size = im.size
    # 朝向在 512 宽的工作分辨率上算（与烘焙器同尺度），再放大
    ww = 512
    wh = max(8, int(round(ww * rd.nh / rd.nw)))
    dw = np.asarray(Image.fromarray(rd.d.astype(np.float32), "F").resize((ww, wh), Image.BILINEAR), np.float64)
    up = up_facing(dw, g.ppu * ww / rd.nw, rd.theta)
    walk = np.zeros((wh, ww), np.uint8)
    for r in tc.load_terrain(sid).get("regions") or []:
        if r.get("kind") != "walk" or _is_generated(r):
            continue
        pts = region_screen_pts(g, r)
        if pts:
            cv2.fillPoly(walk, [np.round(np.array([[x / g.ww * ww, y / g.wh * wh] for x, y in pts])).astype(np.int32)], 1)
    walk = walk.astype(bool)
    from scipy.ndimage import binary_dilation, binary_erosion
    wall = binary_erosion(~binary_dilation(walk, iterations=3), iterations=2)
    gw = binary_erosion(walk, iterations=2)
    stats = {"scene": sid, "pitchDeg": round(math.degrees(rd.theta), 2),
             "depthStd": round(float(np.std(dw)), 4),
             "upStd": round(float(np.std(up)), 4)}
    if gw.any():
        stats["groundSlopeMedianDeg"] = round(math.degrees(math.acos(float(np.clip(np.median(up[gw]), -1, 1)))), 1)
    if wall.any():
        stats["wallOffVerticalMedianDeg"] = round(math.degrees(math.asin(float(np.clip(np.median(np.abs(up[wall])), 0, 1)))), 1)
    # 塌平：朝向处处 ≈ sinθ（一块正对相机的斜板）或深度几乎没有起伏
    stats["collapsed"] = bool(stats["upStd"] < 0.05 or stats["depthStd"] < 1e-3)

    def tile(arr_rgb: np.ndarray, label: str) -> Image.Image:
        t = Image.fromarray(arr_rgb.astype(np.uint8), "RGB").resize(size, Image.BILINEAR)
        dr = ImageDraw.Draw(t)
        dr.rectangle([0, 0, size[0], 30], fill=(0, 0, 0))
        dr.text((8, 3), label, fill=(255, 255, 255), font=_font(20))
        return t

    lo, hi = np.percentile(dw, 1), np.percentile(dw, 99)
    dn = np.clip((dw - lo) / max(hi - lo, 1e-9), 0, 1)
    Yg = None
    gd = g.dep
    qy = (g.cy - (np.arange(gd.shape[0])[:, None] + 0.5) / gd.shape[0] * 2 * g.cy) / g.ppu
    Yg = qy * math.cos(rd.theta) - gd * math.sin(rd.theta)
    yn = (Yg - np.nanmin(Yg)) / max(float(np.nanmax(Yg) - np.nanmin(Yg)), 1e-9)
    art = im.convert("RGB").copy()
    dr = ImageDraw.Draw(art)
    dr.rectangle([0, 0, size[0], 30], fill=(0, 0, 0))
    dr.text((8, 3), f"{sid} 原画", fill=(255, 255, 255), font=_font(20))
    tiles = [art,
             tile(cm.turbo(1 - dn)[..., :3] * 255, f"运行时深度(红近蓝远) 俯角 {stats['pitchDeg']}°"
                  + ("  ⚠ 塌平" if stats["collapsed"] else "")),
             tile(np.repeat((np.clip(up, 0, 1) * 255)[..., None], 3, -1), "朝向(白=朝上的地 黑=竖直立面)"),
             tile(cm.viridis(yn)[..., :3] * 255, "行走面高度")]
    sheet = Image.new("RGB", (size[0] * len(tiles), size[1]))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * size[0], 0))
    dest = Path(out) if out else OUT_ROOT / sid / "depthsheet.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest)
    stats["out"] = str(dest)
    print(json.dumps(stats, ensure_ascii=False))
    return stats


# ---------------------------------------------------------------------------
# 摆人（复查用）
# ---------------------------------------------------------------------------
def _player_frame() -> tuple[Image.Image, float] | None:
    """玩家 idle 第一帧（裁到不透明包围盒，脚底对齐底边）+ 帧对应的世界高。拿不到就回 None（退回剪影）。"""
    anim = _read_json(PLAYER_ANIM / "anim.json")
    atlas = PLAYER_ANIM / "atlas.png"
    if not anim or not atlas.exists():
        return None
    try:
        sheet = Image.open(atlas).convert("RGBA")
        cols, rows = int(anim["cols"]), int(anim["rows"])
        fw, fh = sheet.width // cols, sheet.height // rows
        fr = int(anim["states"]["idle"]["frames"][0])
        cell = sheet.crop(((fr % cols) * fw, (fr // cols) * fh, (fr % cols + 1) * fw, (fr // cols + 1) * fh))
        # 世界高 150 wu 对应整格高（底中脚锚）；裁掉透明边之后按比例换
        wh = float(anim.get("worldHeight") or 150)
        bbox = cell.getbbox()
        if not bbox:
            return None
        crop = cell.crop((bbox[0], bbox[1], bbox[2], fh))
        return crop, wh * crop.height / fh
    except (KeyError, ValueError, OSError):
        return None


def cmd_crowd(sid: str, variant: str | None, width: int, spacing: float, seed: int,
              box: tuple[float, float, float, float] | None = None, out: str | None = None,
              occlusion: str = "h") -> Path:
    """在**游戏此刻判为可走**的所有画面点上摆人：按间距撒点（带抖动），每点一个角色，脚点 = 撒的点。

    复查看的是「有没有人站在屋顶 / 墙上 / 水里 / 崖外 / 桌子里」，以及「明明是路却一个人都没有」。
    角色按场景透视系数缩放（与运行时同一套 perspective_scale_at）。`box` 给了就只在那一片撒、只出那一片的图
    （大场景整张缩下来人太小，看不清脚踩在哪儿）。

    `occlusion`：人被挡掉哪一截按什么算——
    - `h`（缺省）：作者估的物体占地 + 高（`object_volumes`），不读深度；
    - `depth`：**游戏真实的深度遮挡**（`depth_occlusion`，与运行时同式）——深度按原画标定、`depthsheet` 过了才用；
    - `both`：画真实深度遮挡，同时算作者估的那份，两份差得多的人在脚底画品红圈、坐标列进输出（`disagree`）——
      这些点要么物体占地 / 高估错了、要么"物体后面的地"不该开 / 该开、要么深度那一块是错的，回画上判是哪一样。
      另外**脚被深度挡住**的人（脚底一截被遮 = 游戏里他会像站在东西里面 / 后面的坑里）画红圈，列进 `feetHidden`。
    """
    from tools.editor.shared.entity_transform_math import perspective_scale_at
    if occlusion not in ("h", "depth", "both"):
        raise SystemExit(f"--occlusion 只认 h / depth / both，收到 {occlusion!r}")
    g = load_geom(sid, variant)
    rd = load_runtime_depth(g) if occlusion != "h" else None
    if occlusion != "h" and rd is None:
        raise SystemExit(f"{sid}: 没有运行时深度图，--occlusion {occlusion} 用不了")
    blocked, grid = load_blocked(sid)
    bx0, by0, bx1, by1 = box or (0.0, 0.0, g.ww, g.wh)
    if box:
        # 同样的出图宽度只给这一片：人按比例放大
        width = int(round(width * g.ww / max(1.0, bx1 - bx0)))
    im, k = _art(g, width)
    rng = np.random.default_rng(seed)
    pts: list[tuple[float, float]] = []
    y = by0 + spacing * 0.5
    row = 0
    while y < by1:
        x = bx0 + spacing * (0.25 if row % 2 else 0.75)
        while x < bx1:
            jx = x + rng.uniform(-0.3, 0.3) * spacing
            jy = y + rng.uniform(-0.3, 0.3) * spacing
            if bx0 <= jx < bx1 and by0 <= jy < by1 and 0 <= jx < g.ww and 0 <= jy < g.wh:
                pts.append((jx, jy))
            x += spacing
        y += spacing * 0.8
        row += 1
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    ok = ~blocked_at(g, blocked, grid, xs, ys)
    walk = [(float(a), float(b)) for a, b, o in zip(xs, ys, ok) if o]
    frame = _player_frame()
    base = im.convert("RGBA")
    vols = object_volumes(g, k, im.size)
    hidden = 0
    disagree: list[list[float]] = []
    feet_hidden: list[list[float]] = []
    # 画的顺序按 y 从远到近，近处的人压住远处的人（与游戏同一种深度排序直觉）
    persp = g.scene.get("perspectiveScale")
    for (x, y) in sorted(walk, key=lambda p: p[1]):
        f = perspective_scale_at(persp, x, y) if persp else 1.0
        if frame is not None:
            fimg, fwh = frame
            hpx = max(6, int(round(fwh * f * k)))
            wpx = max(3, int(round(fimg.width * hpx / fimg.height)))
            sprite = fimg.resize((wpx, hpx), Image.LANCZOS)
            ox, oy = int(round(x * k - wpx / 2)), int(round(y * k - hpx))
            # 脚点落在某个物体的轮廓里（占地往上那一截）= 人站在它后面：它挡住的那部分身子不画
            fx, fy = int(x * k), int(y * k)
            occ = None
            for _vid, _fp, sil, (vx0, vy0, vx1, vy1) in vols:
                if vx0 <= fx < vx1 and vy0 <= fy < vy1 and sil[fy - vy0, fx - vx0]:
                    if occ is None:
                        occ = np.zeros((hpx, wpx), bool)
                    ax0, ay0 = max(ox, vx0), max(oy, vy0)
                    ax1, ay1 = min(ox + wpx, vx1), min(oy + hpx, vy1)
                    if ax1 > ax0 and ay1 > ay0:
                        occ[ay0 - oy:ay1 - oy, ax0 - ox:ax1 - ox] |= sil[ay0 - vy0:ay1 - vy0, ax0 - vx0:ax1 - vx0]
            if rd is not None:
                docc = depth_occlusion(g, rd, (x, y), (ox, oy, wpx, hpx), k)
                body = np.asarray(sprite)[..., 3] > 8
                n_body = max(1, int(body.sum()))
                fh = float(((occ if occ is not None else np.zeros_like(body)) & body).sum()) / n_body
                fd = float((docc & body).sum()) / n_body
                feet = body.copy()
                feet[: int(hpx * 0.85)] = False          # 脚底那一截（最下 15%）
                if feet.any() and float((docc & feet).sum()) / max(1, int(feet.sum())) > 0.5:
                    feet_hidden.append([round(x, 1), round(y, 1)])
                if occlusion == "both" and abs(fh - fd) > 0.25:
                    disagree.append([round(x, 1), round(y, 1), round(fh, 2), round(fd, 2)])
                occ = docc
            if occ is not None and occ.any():
                hidden += 1
                sa = np.asarray(sprite).copy()
                sa[..., 3][occ] = 0
                sprite = Image.fromarray(sa, "RGBA")
            base.alpha_composite(sprite, (ox, oy))
        else:
            hpx = max(6, int(round(150 * f * k)))
            dr = ImageDraw.Draw(base, "RGBA")
            dr.rounded_rectangle((x * k - hpx * 0.18, y * k - hpx, x * k + hpx * 0.18, y * k), radius=int(hpx * 0.15),
                                 fill=(20, 20, 30, 230))
    dr = ImageDraw.Draw(base, "RGBA")
    # 脚底点：绿 = 从出生点走得到；橙 = 能站但走不到（孤岛）——两种都要看画对不对，橙的还要问"该不该连上"
    lab, _w, keep, sxr = walk_components(g, blocked, grid, max(4.0, g.ww / 400.0))
    for (x, y) in walk:
        r = max(2, int(width / 500))
        i = min(lab.shape[0] - 1, max(0, int(y * sxr)))
        j = min(lab.shape[1] - 1, max(0, int(x * sxr)))
        near = lab[max(0, i - 1):i + 2, max(0, j - 1):j + 2]
        near = near[near > 0]
        reach_here = bool(keep[lab[i, j]]) if lab[i, j] > 0 else bool(len(near) and keep[near].any())
        c = (60, 255, 90, 255) if reach_here else (255, 150, 30, 255)
        dr.ellipse((x * k - r, y * k - r, x * k + r, y * k + r), fill=c)
    for (x, y, *_r) in disagree:                      # 品红圈：作者估的遮挡与游戏深度遮挡对不上
        r = max(6, int(width / 160))
        dr.ellipse((x * k - r, y * k - r, x * k + r, y * k + r), outline=(255, 0, 255, 255), width=3)
    for (x, y) in feet_hidden:                        # 红圈：游戏里脚被挡住
        r = max(8, int(width / 130))
        dr.ellipse((x * k - r, y * k - r, x * k + r, y * k + r), outline=(255, 40, 40, 255), width=3)
    _draw_entity_polys(dr, g, k)
    _draw_marks(dr, g, k, im.width, font_px=12 if box else None)
    if box:
        base = base.crop((int(bx0 * k), int(by0 * k), int(math.ceil(bx1 * k)), int(math.ceil(by1 * k))))
        cd = ImageDraw.Draw(base, "RGBA")
        f = _font(13)
        for x in range(int(math.ceil(bx0 / 100.0)) * 100, int(bx1) + 1, 100):
            cd.text(((x - bx0) * k + 2, 2), str(x), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
        for y in range(int(math.ceil(by0 / 100.0)) * 100, int(by1) + 1, 100):
            cd.text((2, (y - by0) * k + 2), str(y), fill=(255, 255, 0, 255), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
    tag = f"_{int(bx0)}_{int(by0)}_{int(bx1)}_{int(by1)}" if box else ""
    otag = "" if occlusion == "h" else f"_{occlusion}"
    dest = Path(out) if out else OUT_ROOT / sid / f"crowd{tag}{('_' + variant) if variant else ''}{otag}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    base.convert("RGB").save(dest)
    print(json.dumps({"scene": sid, "variant": variant or "", "out": str(dest), "people": len(walk),
                      "sampled": len(pts), "spacing": round(spacing, 1), "behindObjects": hidden,
                      "objectsWithHeight": len(vols), "occlusion": occlusion,
                      **({"feetHidden": feet_hidden} if rd is not None else {}),
                      **({"disagree": disagree} if occlusion == "both" else {})}, ensure_ascii=False))
    return dest


# ---------------------------------------------------------------------------
# 改（作者层多边形）
# ---------------------------------------------------------------------------
def _parse_pts(s: str) -> list[tuple[float, float]]:
    out = []
    for tok in s.replace(";", " ").split():
        a, b = tok.split(",")
        out.append((float(a), float(b)))
    if len(out) < 3:
        raise SystemExit("多边形至少 3 个点：--pts \"x,y x,y x,y\"")
    return out


def _densify(pts: list[tuple[float, float]], step: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        seg = math.hypot(x1 - x0, y1 - y0)
        m = max(1, int(math.ceil(seg / step)))
        for j in range(m):
            t = j / m
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    return out


def _state_with_regions(sid: str, regions: list[dict]) -> dict:
    from tools.terrain_workbench import authoring
    st = authoring.layer_state(sid)
    doc = st["doc"]
    doc["regions"] = regions
    return {"doc": doc, "brush": st.get("brush"), "height": st.get("height")}


def _save_and_export(sid: str, regions: list[dict], clear_brush: bool = False) -> dict:
    from tools.terrain_workbench import authoring
    g = load_geom(sid)
    before = OUT_ROOT / sid / "before.png"
    if not before.exists():
        # 第一次落盘前把改前的样子留一张（以后落盘都不再覆盖）：回报给制作人要改前 / 改后两张
        cmd_render(sid, None, 1200, out=before, quiet=True)
    regions = _with_outside(g, regions)
    cur = tc.load_terrain(sid)
    state = _state_with_regions(sid, regions)
    if clear_brush:
        state["brush"] = None
    r = authoring.save(sid, state, base_updated=cur.get("updated"))
    if not r.get("ok"):
        raise SystemExit("保存失败：" + str(r.get("err")))
    exp = tc.export_terrain(sid)
    return {"saved": r.get("path"), "blockedPct": round(exp["blocked_pct"], 2)}


def _to_grid(g: SceneGeom, pts: list[tuple[float, float]]) -> list[list[float]]:
    """画面多边形（场景坐标）→ 网格单位多边形：先按 DENSIFY_STEP 加密，逐点走运行时那条链。"""
    dense = _densify(pts, DENSIFY_STEP)
    X, Z = g.scene_to_xz([p[0] for p in dense], [p[1] for p in dense])
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(X, Z)]


def _fingerprint(points: list) -> str:
    """网格多边形的指纹：`screen` 记着它是按哪一版 points 圈的——人在桌面工作台里拖过顶点，指纹就对不上了。"""
    a = np.asarray(points, np.float64)
    return f"{len(a)}:{a.sum():.3f}:{(a * a).sum():.1f}" if a.size else "0"


def _make_region(g: SceneGeom, rid: str, kind: str, pts: list[tuple[float, float]], note: str,
                 h: float | None = None, h0: float | None = None, flat: bool = False) -> dict:
    grid_pts = _to_grid(g, pts)
    # 画面上圈的那一圈（场景坐标）原样留着：复查图按它画轮廓，人也读得懂这块是按画上哪儿圈的。
    # 运行时与合成器只认 points（网格单位），这一键谁都不读；`of` = 它对应的那一版 points 的指纹。
    scr = {"points": [[round(x, 1), round(y, 1)] for x, y in pts], "note": note, "of": _fingerprint(grid_pts)}
    if kind == "block" and flat and not h:
        scr["flat"] = True           # 故意不写 h 的平块（死角地 / 墙后封口）：`check` 的 blocksWithoutH 不再列它
    covered = kind == "walk" and h and h0 and 0 < h0 < h
    if (kind == "block" and h) or covered:
        # 物体高（场景坐标，画面上从占地往上立多高）：只给复查图估遮挡用，运行时与合成器都不读。
        # walk 带 h0 + h = 有顶的通道（门楼 / 过街楼底下的路）：能走，但站在里面的人 h0 以上被顶挡住
        scr["h"] = round(float(h), 1)
        if h0 and 0 < h0 < h:
            scr["h0"] = round(float(h0), 1)
    return {"id": rid, "kind": kind, "points": grid_pts, "screen": scr}


class _Inverse:
    """网格单位 → 画面点（场景坐标）的反查：行走面是画面上的高度场，正向映射几乎处处单射，
    在画面上密铺一层采样点、按 XZ 找最近邻就够了（误差 ≈ 采样步长）。"""
    _cache: dict[tuple[str, str], "_Inverse"] = {}

    def __init__(self, g: SceneGeom):
        from scipy.spatial import cKDTree
        step = max(2.0, max(g.ww, g.wh) / 900.0)
        xs = np.arange(step / 2, g.ww, step)
        ys = np.arange(step / 2, g.wh, step)
        X, Y = np.meshgrid(xs, ys)
        GX, GZ = g.scene_to_xz(X.ravel(), Y.ravel())
        self.sx, self.sy = X.ravel(), Y.ravel()
        self.tree = cKDTree(np.stack([GX, GZ], -1))

    @classmethod
    def of(cls, g: SceneGeom) -> "_Inverse":
        key = (g.sid, str(g.bake_dir))
        if key not in cls._cache:
            cls._cache[key] = cls(g)
        return cls._cache[key]

    def __call__(self, points: list) -> list[tuple[float, float]]:
        _d, idx = self.tree.query(np.asarray(points, np.float64))
        return [(float(self.sx[i]), float(self.sy[i])) for i in np.atleast_1d(idx)]


def region_screen_pts(g: SceneGeom, reg: dict) -> list[tuple[float, float]] | None:
    """这块在画面上的轮廓。`screen` 与 points 对得上就用作者圈的那一圈；对不上（人在工作台里拖过）或压根没有
    （工作台里新画的）就把网格多边形反投回画面。"""
    scr = reg.get("screen") or {}
    pts = scr.get("points")
    if pts and (scr.get("of") is None or scr.get("of") == _fingerprint(reg.get("points") or [])):
        return [(float(p[0]), float(p[1])) for p in pts]
    if scr.get("generated"):
        return None
    gp = reg.get("points") or []
    return _Inverse.of(g)(gp) if len(gp) >= 3 else None


def _is_generated(reg: dict) -> bool:
    rid = str(reg.get("id") or "")
    return bool((reg.get("screen") or {}).get("generated")) or rid == OUTSIDE_ID or rid.startswith(OUTSIDE_ID + "_岛")


def _walk_polys(g: SceneGeom, regions: list[dict]) -> list[list[tuple[float, float]]]:
    """可走集：全部 walk 多边形（生成的不算；工作台里画的 / 拖过的一并反投回画面算进来）。"""
    return [p for r in regions if r.get("kind") == "walk" and not _is_generated(r)
            for p in [region_screen_pts(g, r)] if p]


def _block_polys(g: SceneGeom, regions: list[dict]) -> list[list[tuple[float, float]]]:
    return [p for r in regions if r.get("kind") == "block" and not _is_generated(r)
            for p in [region_screen_pts(g, r)] if p]


def _union_mask(g: SceneGeom, polys: list[list[tuple[float, float]]], step: float, pad: float = 0.0) -> np.ndarray:
    """可走集在画面上的栅格（每格 step 场景单位）。`pad` = 往画外多留多少：作者贴画边的块往画外多画一截
    （卡片规矩），这截要留在可走集里——否则生成的外围块在画边那一格里会压过它（画边那一溜被判成阻挡）。"""
    import cv2
    w = int(math.ceil((g.ww + 2 * pad) / step)) + 1
    h = int(math.ceil((g.wh + 2 * pad) / step)) + 1
    m = np.zeros((h, w), np.uint8)
    for pts in polys:
        arr = np.round((np.array(pts, np.float64) + pad) / step).astype(np.int32)
        cv2.fillPoly(m, [arr], 1)
    return m


def _outside_regions(g: SceneGeom, walk: list[list[tuple[float, float]]]) -> list[dict]:
    """可走集以外 → 阻挡多边形。

    外面那一大块 = 外框（比世界大一圈）挖掉可走集的每一块外轮廓：一个多边形，外框左上角到每个洞各拉一条
    零宽的桥（去一趟回一趟，射线法下成对抵消）。被可走集围住的空洞（比如四面是路的一个街区）另成一块
    简单多边形——人在工作台里也拖得动它。可走集彼此重叠没关系：先在画面上栅格求并，再取轮廓。
    """
    import cv2
    if not walk:
        return []
    step = max(1.0, max(g.ww, g.wh) / 2000.0)
    margin = max(g.ww, g.wh) * 0.02
    # 可走集栅格往画外留出 margin（比外框小一点，让外框仍把可走集整个包住）
    pad = margin * 0.9
    m = _union_mask(g, walk, step, pad)
    contours, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return []
    hier = hier[0]
    f0 = (-margin, -margin)
    frame = [f0, (g.ww + margin, -margin), (g.ww + margin, g.wh + margin), (-margin, g.wh + margin), f0]
    flat: list[tuple[float, float]] = list(frame)
    rings_out: list[list[tuple[float, float]]] = []
    islands: list[list[tuple[float, float]]] = []
    for c, hrow in zip(contours, hier):
        c = cv2.approxPolyDP(c, 0.75, True)
        ring = [(float(p[0][0]) * step - pad, float(p[0][1]) * step - pad) for p in c]
        if len(ring) < 3:
            continue
        if hrow[3] < 0:
            rings_out.append(ring)
        elif cv2.contourArea(c) * step * step >= MIN_HOLE_AREA:
            islands.append(ring)
        # 更小的洞是两块 walk 边刚好对上时栅格化留下的缝（1–3 单位）：那本来就该能走，不生成阻挡
    for ring in rings_out:
        i0 = min(range(len(ring)), key=lambda i: (ring[i][0] - f0[0]) ** 2 + (ring[i][1] - f0[1]) ** 2)
        r = ring[i0:] + ring[:i0]
        flat += r + [r[0], f0]
    out = [{"id": OUTSIDE_ID, "kind": "block", "points": _to_grid(g, flat),
            "screen": {"generated": True, "rings": [[[round(x, 1), round(y, 1)] for x, y in r] for r in rings_out],
                       "note": "自动生成：可走集（全部 walk 多边形）以外的整张图。别手改，改 walk 多边形它会跟着重算"}}]
    for i, ring in enumerate(islands, 1):
        out.append({"id": f"{OUTSIDE_ID}_岛{i}", "kind": "block", "points": _to_grid(g, ring),
                    "screen": {"generated": True, "points": [[round(x, 1), round(y, 1)] for x, y in ring],
                               "note": "自动生成：被可走集围住的空洞"}})
    return out


#: 自动生成的"可走集以外"阻挡块的 id（岛：`<id>_岛N`）
OUTSIDE_ID = "art_可走以外"
#: 被可走集围住、比这还小的洞（场景单位²，约 30×30）不当岛：是两块 walk 拼缝的栅格化碎渣
MIN_HOLE_AREA = 900.0


def _with_outside(g: SceneGeom, regions: list[dict]) -> list[dict]:
    """去掉旧的生成块，按当前可走集重算一遍接在后面。"""
    keep = [r for r in regions if not _is_generated(r)]
    return keep + _outside_regions(g, _walk_polys(g, keep))


def _inside_any(X: np.ndarray, Y: np.ndarray, polys: list[list[tuple[float, float]]]) -> np.ndarray:
    m = np.zeros(X.shape, bool)
    for p in polys:
        m |= tc.points_in_polygon(X, Y, [list(q) for q in p])
    return m


def realized_ratio(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, kind: str,
                   pts: list[tuple[float, float]], carve: list[list[tuple[float, float]]] | None = None) -> float:
    """这块多边形里（画面点）有多少比例在运行时真的是它要的状态。1.0 = 全实现。

    walk 多边形里被作者另圈了 block 的那部分（`carve`）不算——那是有意挖掉的障碍。
    """
    xs0 = min(p[0] for p in pts)
    xs1 = max(p[0] for p in pts)
    ys0 = min(p[1] for p in pts)
    ys1 = max(p[1] for p in pts)
    step = max(2.0, min(xs1 - xs0, ys1 - ys0) / 40.0)
    X, Y = np.meshgrid(np.arange(xs0 + step / 2, xs1, step), np.arange(ys0 + step / 2, ys1, step))
    inside = tc.points_in_polygon(X, Y, [list(p) for p in pts])
    inside &= (X >= 0) & (X < g.ww) & (Y >= 0) & (Y < g.wh)      # 贴画边的块往画外多画的那截不算
    if carve:
        inside &= ~_inside_any(X, Y, carve)
    if not inside.any():
        return 1.0
    b = blocked_at(g, blocked, grid, X[inside], Y[inside])
    want_block = kind == "block"
    return float((b == want_block).mean())


def cells_thick(grid: tc.GridMeta, grid_pts: list) -> float:
    """这块多边形在碰撞网格里**真实厚度**几格：min(最小外接矩形短边, 4·面积/周长)，按网格单位算。

    外接框短边会把一段斜着的细墙当成大块（外接框很大、墙只有两三格厚）；最小外接矩形管斜，4A/P 管 L 形 / 凹形。
    """
    import cv2
    a = np.asarray(grid_pts, np.float32)
    if len(a) < 3:
        return 0.0
    (_c, (w, h), _ang) = cv2.minAreaRect(a)
    area = abs(float(cv2.contourArea(a)))
    per = float(cv2.arcLength(a, True))
    t = min(min(w, h), 4.0 * area / per if per > 0 else 0.0)
    return t / grid.cell_size


def cells_across(g: SceneGeom, grid: tc.GridMeta, pts: list[tuple[float, float]]) -> float:
    """这块画面多边形在碰撞网格里横竖各跨几格（取小的那个）。

    网格一格在画面上大约几十个场景单位：比两三格还小的东西（柱子、单个桶）栅格化后只剩一两格甚至零格，
    实现度天生上不去——那不是圈错了，是网格分辨率就这么粗。这种块的实现度只作参考。
    """
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    h = 8.0
    X, Z = g.scene_to_xz([cx - h, cx + h, cx, cx], [cy, cy, cy - h, cy + h])
    per_x = math.hypot(X[1] - X[0], Z[1] - Z[0]) / (2 * h)       # 网格单位 / 场景单位
    per_y = math.hypot(X[3] - X[2], Z[3] - Z[2]) / (2 * h)
    return min((max(xs) - min(xs)) * per_x, (max(ys) - min(ys)) * per_y) / grid.cell_size


#: 比这更窄（格数）的多边形不按实现度报警
MIN_CELLS_FOR_RATIO = 5.0


def ratio_floor(cells: float) -> float | None:
    """实现度及格线随块的大小走：栅格化的误差集中在边上一圈（≈ 半格 × 周长），块越小占比越大。
    < 5 格宽只作参考（None）；5–10 格 0.8；再大 0.9。"""
    if cells < MIN_CELLS_FOR_RATIO:
        return None
    return 0.8 if cells < 10 else 0.9


def region_realized(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, reg: dict,
                    regions: list[dict] | None = None) -> float | None:
    """按作者在画上圈的那一圈（`screen`）算实现度；生成的外围块算的是"可走集以外的画面点有多少真挡住了"。"""
    regions = regions if regions is not None else (tc.load_terrain(g.sid).get("regions") or [])
    scr = (reg.get("screen") or {})
    if scr.get("generated") and reg.get("id") == OUTSIDE_ID:
        walk = _walk_polys(g, regions)
        step = max(4.0, min(g.ww, g.wh) / 150.0)
        X, Y = np.meshgrid(np.arange(step / 2, g.ww, step), np.arange(step / 2, g.wh, step))
        out = ~_inside_any(X, Y, walk)
        if not out.any():
            return 1.0
        return float(blocked_at(g, blocked, grid, X[out], Y[out]).mean())
    if _is_generated(reg):
        return None
    pts = region_screen_pts(g, reg)
    if not pts:
        return None
    carve = _block_polys(g, regions) if reg.get("kind") == "walk" else None
    return realized_ratio(g, blocked, grid, reg["kind"], pts, carve)


def cmd_region(sid: str, rid: str, kind: str, pts_s: str, note: str, h: float | None = None) -> None:
    if kind not in tc.REGION_KINDS:
        raise SystemExit("--kind 只能是 walk / block")
    if rid == OUTSIDE_ID or rid.startswith(OUTSIDE_ID + "_"):
        raise SystemExit(f"{rid} 是自动生成的（可走集以外），改 walk 多边形它会跟着重算")
    g = load_geom(sid)
    pts = _parse_pts(pts_s)
    doc = tc.load_terrain(sid)
    regions = [r for r in (doc.get("regions") or []) if r.get("id") != rid]
    replaced = len(regions) != len(doc.get("regions") or [])
    reg = _make_region(g, rid, kind, pts, note, h)
    regions.append(reg)
    res = _save_and_export(sid, regions)
    blocked, grid = load_blocked(sid)
    regions = tc.load_terrain(sid).get("regions") or []
    ratio = region_realized(g, blocked, grid, reg, regions)
    outside = next((r for r in regions if r.get("id") == OUTSIDE_ID), None)
    o_ratio = region_realized(g, blocked, grid, outside, regions) if outside else None
    print(json.dumps({"scene": sid, "region": rid, "kind": kind, "replaced": replaced, **res,
                      "realized": round(ratio, 3),
                      **({"outsideRealized": round(o_ratio, 3)} if o_ratio is not None else {})}, ensure_ascii=False))
    if ratio < 0.9:
        print(f"⚠ 这块只实现了 {ratio:.0%}：多半是这一带行走面把好几个画面点压进了同一格，"
              f"或者被别的阻挡多边形 / 笔刷压住了（阻挡压过可走）。看 render 图对一下。")


def footprint_from_outline(pts: list[tuple[float, float]], h: float, step: float = 1.0
                           ) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """画面轮廓 → (占地, 占地后面被挡住的那片)，都是场景坐标多边形（取最大的一块外轮廓）。

    轮廓 S = 占地 F 往上扫 h（竖直线段的闵可夫斯基和），反过来 F = S ∩ (S 往下平移 h)：一个画面点属于占地，
    当且仅当它往上 h 那一点也还在轮廓里。纯画面几何，不读深度。后面那片 = S − F，能不能走由作者按连续性判。
    """
    import cv2
    arr = np.array(pts, np.float64)
    x0, y0 = arr.min(axis=0) - 2
    x1, y1 = arr.max(axis=0) + 2
    w = int(np.ceil((x1 - x0) / step)) + 1
    hh = int(np.ceil((y1 - y0) / step)) + 1
    S = np.zeros((hh, w), np.uint8)
    cv2.fillPoly(S, [np.round((arr - [x0, y0]) / step).astype(np.int32)], 1)
    H = int(round(h / step))
    down = np.zeros_like(S)
    if H < hh:
        down[H:] = S[:hh - H]
    F = S & down
    behind = S & (1 - F)

    def ring(mask: np.ndarray) -> list[tuple[float, float]]:
        cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cs:
            return []
        c = max(cs, key=cv2.contourArea)
        c = cv2.approxPolyDP(c, 1.5 / step, True)
        return [(round(float(q[0][0]) * step + x0, 1), round(float(q[0][1]) * step + y0, 1)) for q in c]

    return ring(F), ring(behind.astype(np.uint8))


def cmd_footprint(sid: str, rid: str, h: float, out: str | None) -> None:
    """把一块"按画面轮廓圈的"阻挡算成"占地 + h"草稿（写到 out，不落盘）：先 `crop --draft` 对画看，再 `apply`。

    后面被挡住的那片不自动处理——按连续性判：该走就留着（它会落进可走集），不该走另圈一块 `flat` 封口。
    """
    g = load_geom(sid)
    reg = next((r for r in tc.load_terrain(sid).get("regions") or [] if r.get("id") == rid), None)
    if reg is None:
        raise SystemExit(f"没有这块：{rid}")
    pts = region_screen_pts(g, reg)
    if not pts:
        raise SystemExit(f"{rid} 没有画面轮廓")
    fp, behind = footprint_from_outline(pts, h)
    if len(fp) < 3:
        raise SystemExit(f"{rid}: h={h} 比轮廓还高，算不出占地")
    note = (reg.get("screen") or {}).get("note", "")
    draft = {rid: {"kind": "block", "h": h, "pts": " ".join(f"{x:g},{y:g}" for x, y in fp),
                   "note": (note + f"(占地 = 轮廓往下平移 {h:g} 与轮廓的交)").strip()}}
    dest = Path(out) if out else OUT_ROOT / sid / f"footprint_{rid}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    bx = [q[0] for q in behind] or [0]
    by = [q[1] for q in behind] or [0]
    print(json.dumps({"scene": sid, "id": rid, "h": h, "draft": str(dest), "footprintPts": len(fp),
                      "behind": {"box": [min(bx), min(by), max(bx), max(by)], "pts": " ".join(f"{x:g},{y:g}" for x, y in behind)},
                      "next": "crop --draft 对画看黄虚线是否对上顶面 → apply；behind 那片按连续性判，不该走就另圈 flat 封口"},
                     ensure_ascii=False))


def cmd_brush_clear(sid: str) -> None:
    """清掉旧碰撞笔刷层（整层）。整场照原画重圈之后，旧笔刷只剩坏处：它的阻挡格压过 walk 多边形、
    在可走区里留一粒粒卡脚的格子，而它的可走格早被自动生成的外围块盖掉了。清之前那份在 terrain/history/ 里。"""
    doc = tc.load_terrain(sid)
    if not doc.get("brush"):
        print(json.dumps({"scene": sid, "brush": "本来就没有"}, ensure_ascii=False))
        return
    res = _save_and_export(sid, list(doc.get("regions") or []), clear_brush=True)
    print(json.dumps({"scene": sid, "brush": "已清（旧层留在 terrain/history/）", **res}, ensure_ascii=False))


def cmd_pin_screen(sid: str) -> None:
    """**重做深度之前**跑:把每块作者多边形在画面上的轮廓钉进 `screen.points`（按**当前**几何）。

    作者多边形存的是网格单位（M-world XZ），深度一重做（换标定 / 换俯角），同一个网格点就落到画面别处去了；
    画面上哪里是路不随深度变，所以画面轮廓才是作者真正圈的东西。命令行圈的块本来就带着这圈；
    桌面工作台里画的 / 拖过的没有（或对不上），这里按当前几何反投回画面补上。已经对得上的不动。
    """
    from tools.terrain_workbench import authoring
    doc = tc.load_terrain(sid)
    g = load_geom(sid)
    regions = list(doc.get("regions") or [])
    pinned = []
    for r in regions:
        if _is_generated(r):
            continue
        scr = dict(r.get("screen") or {})
        if scr.get("points") and scr.get("of") == _fingerprint(r.get("points") or []):
            continue
        pts = region_screen_pts(g, r)
        if not pts:
            raise SystemExit(f"{r.get('id')}: 反投不回画面（网格点不足 3 个）")
        scr["points"] = [[round(x, 1), round(y, 1)] for x, y in pts]
        scr["of"] = _fingerprint(r.get("points") or [])
        r["screen"] = scr
        pinned.append(r.get("id"))
    if pinned:
        r = authoring.save(sid, _state_with_regions(sid, regions), base_updated=doc.get("updated"))
        if not r.get("ok"):
            raise SystemExit("保存失败：" + str(r.get("err")))
    print(json.dumps({"scene": sid, "pinned": pinned, "regions": len(regions)}, ensure_ascii=False))


def cmd_reanchor(sid: str) -> None:
    """**重做深度之后**跑（重烘 + 导出深度之后）：按画面轮廓把作者多边形重新落到新几何上。

    导出深度时合成器沿用作者层原来的网格声明、作者多边形也还是旧几何下的网格点 —— 深度没变时这正确
    （重烘不丢作者层），深度重做了就整片错位，而且不报错（碰撞照样合成、照样导出）。这里：
    网格换成新烘的自动结果那套 → 每块非生成的多边形按 `screen.points` 走**新**的反投影链重新落格 →
    外围块重算 → 导出 → 网格扩到盖住整张画（`grid --fit`）。

    笔刷层 / 高度修补是网格栅格，没有画面轮廓可依，遇到就停下（先在工作台里改成多边形）。
    重做深度前没跑 `pin-screen`、有块缺画面轮廓的也停下。
    """
    from tools.terrain_workbench import authoring
    doc = tc.load_terrain(sid)
    if doc.get("brush"):
        raise SystemExit(f"{sid}: 有碰撞笔刷层（网格栅格，没有画面轮廓），没法随深度重投 —— 先在地形工作台里改成多边形")
    if doc.get("height") or doc.get("heightOps"):
        raise SystemExit(f"{sid}: 有行走面高度修补（网格栅格 / 网格操作），没法随深度重投 —— 先在地形工作台里清掉再重做")
    auto = doc.get("auto")
    if not auto:
        raise SystemExit(f"{sid}: 还没有自动结果（先重烘并导出深度）")
    missing = [r.get("id") for r in doc.get("regions") or []
               if not _is_generated(r) and not (r.get("screen") or {}).get("points")]
    if missing:
        raise SystemExit(f"{sid}: 这些块没有画面轮廓：{missing} —— 重做深度前要先跑 pin-screen")
    g = load_geom(sid)
    regions = []
    for r in doc.get("regions") or []:
        if _is_generated(r):
            continue
        scr = r.get("screen") or {}
        pts = [(float(p[0]), float(p[1])) for p in scr["points"]]
        regions.append(_make_region(g, r["id"], r["kind"], pts, scr.get("note", ""),
                                    h=scr.get("h"), h0=scr.get("h0"), flat=bool(scr.get("flat"))))
    new_grid = tc.GridMeta.from_dict(auto).to_dict()
    st = authoring.layer_state(sid)
    state = {"doc": st["doc"], "brush": None, "height": None}
    state["doc"]["grid"] = new_grid
    state["doc"]["regions"] = regions
    r = authoring.save(sid, state, base_updated=doc.get("updated"))
    if not r.get("ok"):
        raise SystemExit("保存失败：" + str(r.get("err")))
    res = _save_and_export(sid, regions)
    print(json.dumps({"scene": sid, "reanchored": [x["id"] for x in regions], "grid": new_grid, **res},
                     ensure_ascii=False))
    cmd_grid_fit(sid)


def cmd_grid_fit(sid: str) -> None:
    """把碰撞网格扩到盖住整张画（所有时段外观的画面）。

    运行时对网格外一律当"不挡"（`collisionAt` 回 null → `isCollision` false）：烘焙时网格只按行走面有效区取范围，
    画面边上常有一条带子落在网格外——那里画多边形也挡不住（`check` 报孤岛 / 外围块实现不足）。
    扩网格不是重烘：格子大小与对齐不变（原来的格一一对上），只在四周补格；自动结果在补出来的格里算"没数据"
    （可走），作者多边形照常栅格化进去；旧笔刷 / 高度栅格按新网格重采样（补出来的格 = 不改）。
    """
    from tools.terrain_workbench import authoring
    doc = tc.load_terrain(sid)
    old = tc.GridMeta.from_dict(doc["grid"])
    xs, zs = [], []
    for vid in [None] + _variant_names(json.loads((tc.SCENES_JSON / f"{sid}.json").read_text(encoding="utf-8"))):
        try:
            gv = load_geom(sid, vid)
        except SystemExit:
            continue
        st = max(2.0, max(gv.ww, gv.wh) / 500.0)
        X, Y = np.meshgrid(np.arange(0, gv.ww + st, st).clip(0, gv.ww), np.arange(0, gv.wh + st, st).clip(0, gv.wh))
        GX, GZ = gv.scene_to_xz(X, Y)
        xs += [float(GX.min()), float(GX.max())]
        zs += [float(GZ.min()), float(GZ.max())]
    c = old.cell_size
    ox1 = old.x_min + old.grid_width * c
    oz1 = old.z_min + old.grid_height * c
    add_l = max(0, math.ceil((old.x_min - min(xs)) / c + 1e-9))
    add_r = max(0, math.ceil((max(xs) - ox1) / c + 1e-9))
    add_t = max(0, math.ceil((old.z_min - min(zs)) / c + 1e-9))
    add_b = max(0, math.ceil((max(zs) - oz1) / c + 1e-9))
    if not (add_l or add_r or add_t or add_b):
        print(json.dumps({"scene": sid, "grid": "已经盖住整张画", **old.to_dict()}, ensure_ascii=False))
        return
    new = tc.GridMeta(x_min=old.x_min - add_l * c, z_min=old.z_min - add_t * c, cell_size=c,
                      grid_width=old.grid_width + add_l + add_r, grid_height=old.grid_height + add_t + add_b)
    st = authoring.layer_state(sid)
    state = {"doc": st["doc"], "brush": None, "height": None}
    state["doc"]["grid"] = new.to_dict()
    if st.get("brush"):
        b = np.frombuffer(__import__("base64").b64decode(st["brush"]), np.uint8).reshape(old.grid_height, old.grid_width)
        state["brush"] = __import__("base64").b64encode(
            tc.resample_nearest(b, old, new, tc.BRUSH_AUTO).astype(np.uint8).tobytes()).decode("ascii")
    if st.get("height"):
        h = np.frombuffer(__import__("base64").b64decode(st["height"]), "<f4").reshape(old.grid_height, old.grid_width)
        state["height"] = __import__("base64").b64encode(
            tc.resample_nearest(h.astype(np.float32), old, new, 0).astype("<f4").tobytes()).decode("ascii")
    r = authoring.save(sid, state, base_updated=tc.load_terrain(sid).get("updated"))
    if not r.get("ok"):
        raise SystemExit("保存失败：" + str(r.get("err")))
    # 外围块按新网格重算（它的外框比世界大一圈，本来就盖得到，重存一次让实现度按新网格算）
    res = _save_and_export(sid, list(tc.load_terrain(sid).get("regions") or []))
    print(json.dumps({"scene": sid, "grid": f"{old.grid_width}x{old.grid_height} → {new.grid_width}x{new.grid_height}",
                      "added": {"left": add_l, "right": add_r, "top": add_t, "bottom": add_b}, **res}, ensure_ascii=False))


def cmd_move(sid: str, what: str, xy: str) -> None:
    """挪一个标记的坐标（改场景 JSON，只动那两个数，别的字节不动）。

    `what`：`npc:<id>` / `hotspot:<id>` / `spawn:<spawnPoint 或 spawnPoints 的键>` / `align:<热点 id>` /
    `landing:<热点 id>` / `zone:<id>`（触发区整体平移，给的是新的中心点，大小形状不变）。
    """
    path = tc.SCENES_JSON / f"{sid}.json"
    raw = path.read_text(encoding="utf-8")
    scene = json.loads(raw)
    if json.dumps(scene, indent=2, ensure_ascii=False) + "\n" != raw:
        raise SystemExit(f"{path.name} 不是标准格式（indent=2 / ensure_ascii=False / 末尾换行），往返会改动无关字节——先别用本命令")
    kind, _, key = what.partition(":")
    nx, ny = (float(v) for v in xy.split(","))
    target = None
    if kind in ("npc", "hotspot", "align", "landing", "zone"):
        coll = {"npc": "npcs", "zone": "zones"}.get(kind, "hotspots")
        target = next((e for e in scene.get(coll) or [] if isinstance(e, dict) and e.get("id") == key), None)
        if target is not None and kind in ("align", "landing"):
            target = (target.get("data") or {}).get(kind)
    elif kind == "spawn":
        target = scene.get("spawnPoint") if key == "spawnPoint" else (scene.get("spawnPoints") or {}).get(key)
    if not isinstance(target, dict):
        raise SystemExit(f"找不到 {what}")
    if kind == "zone":
        poly = target.get("polygon") or []
        cx = sum(float(q["x"]) for q in poly) / len(poly)
        cy = sum(float(q["y"]) for q in poly) / len(poly)
        before = [(q["x"], q["y"]) for q in poly]
        for q in poly:
            q["x"] = round(float(q["x"]) + nx - cx, 1)
            q["y"] = round(float(q["y"]) + ny - cy, 1)
        after = [(q["x"], q["y"]) for q in poly]
    else:
        before = (target.get("x"), target.get("y"))

        def _like(orig, v: float):
            # 保持原字段的数字风格：原来写整数、新值也是整数就写整数（别把 415 写成 415.0）
            return int(v) if isinstance(orig, int) and not isinstance(orig, bool) and float(v).is_integer() else v

        target["x"], target["y"] = _like(target.get("x"), nx), _like(target.get("y"), ny)
        after = (target["x"], target["y"])
    path.write_bytes((json.dumps(scene, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps({"scene": sid, "moved": what, "from": before, "to": after}, ensure_ascii=False))


def cmd_remove(sid: str, rid: str) -> None:
    doc = tc.load_terrain(sid)
    regions = [r for r in (doc.get("regions") or []) if r.get("id") != rid]
    if len(regions) == len(doc.get("regions") or []):
        raise SystemExit(f"没有这块：{rid}")
    res = _save_and_export(sid, regions)
    print(json.dumps({"scene": sid, "removed": rid, **res}, ensure_ascii=False))


def cmd_regions(sid: str) -> None:
    doc = tc.load_terrain(sid)
    g = load_geom(sid)
    blocked, grid = load_blocked(sid)
    regions = doc.get("regions") or []
    for r in regions:
        scr = (r.get("screen") or {}).get("points")
        ratio = region_realized(g, blocked, grid, r, regions)
        print(json.dumps({"id": r["id"], "kind": r["kind"], "generated": _is_generated(r),
                          **({"h": (r.get("screen") or {}).get("h")}
                             if r["kind"] == "block" or (r.get("screen") or {}).get("h0") else {}),
                          **({"h0": (r.get("screen") or {}).get("h0")} if (r.get("screen") or {}).get("h0") else {}),
                          "note": (r.get("screen") or {}).get("note", ""),
                          "screen": None if r.get("id") == OUTSIDE_ID else scr,
                          "realized": None if ratio is None else round(ratio, 3)}, ensure_ascii=False))
    print(json.dumps({"brush": bool(doc.get("brush")), "regions": len(doc.get("regions") or [])}, ensure_ascii=False))


def _hotspot_offers_interaction(h: dict) -> bool:
    """与运行时 `src/utils/hotspotInteraction.ts#hotspotOffersPlayerInteraction` 同一判据：
    空的 inspect（没图对话 / 没正文 / 没动作——过场冒泡锚点、占位）玩家按不了 E，不算要走过去的东西。
    跨点（act_spot）有动词就算。"""
    t = h.get("type")
    d = h.get("data") or {}

    def _s(v) -> bool:
        return isinstance(v, str) and bool(v.strip())

    if t == "inspect":
        return _s(d.get("graphId")) or _s(d.get("text")) or bool(d.get("actions"))
    if t == "pickup":
        return _s(d.get("itemId"))
    if t == "transition":
        return _s(d.get("targetScene"))
    if t == "encounter":
        return _s(d.get("encounterId"))
    if t == "npc":
        return _s(d.get("npcId"))
    if t == "act_spot":
        return bool(d.get("verbs"))
    return False


def _character_graphs() -> dict[str, str]:
    """角色注册表里每个角色的对话图（场景 NPC 没写 `dialogueGraphId` 时运行时从这里继承）。"""
    d = _read_json(ROOT / "public" / "assets" / "data" / "character_registry.json") or {}
    chars = d.get("characters", d) if isinstance(d, dict) else d
    items = chars.values() if isinstance(chars, dict) else chars
    return {str(c.get("id")): str(c.get("dialogueGraphId")) for c in items or []
            if isinstance(c, dict) and isinstance(c.get("dialogueGraphId"), str) and c["dialogueGraphId"].strip()}


def _interactables(g: SceneGeom) -> list[tuple[str, str, float, float, float]]:
    """玩家要走过去按 E 的东西：(种类, id, x, y, 交互半径)。纯挂威胁 / 纯装饰（半径 0、无对话）的不算，
    空 inspect（运行时不给 E）也不算。"""
    out = []
    reg = _character_graphs()
    for n in g.scene.get("npcs") or []:
        if not isinstance(n, dict):
            continue
        rng = float(n.get("interactionRange") or 0)
        graph = n.get("dialogueGraphId") or reg.get(str(n.get("characterId") or ""))
        if rng > 0 and (graph or n.get("dialogueFile") or n.get("interactActions") or n.get("acts")):
            out.append(("npc", str(n.get("id")), float(n.get("x", 0)), float(n.get("y", 0)), rng))
    for h in g.scene.get("hotspots") or []:
        if not isinstance(h, dict):
            continue
        rng = float(h.get("interactionRange") or 0)
        if h.get("type") == "transition":
            rng = max(rng, 60.0)
        if rng > 0 and _hotspot_offers_interaction(h):
            out.append((f"hotspot:{h.get('type')}", str(h.get("id")), float(h.get("x", 0)), float(h.get("y", 0)), rng))
    return out


def walk_components(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, step: float
                    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """画面空间的可走连通块：(labels, walk, keep 每块是否从出生点 / 场内跳跃落点走得到, 每场景单位多少格)。

    玩家是在场景坐标里一步步挪、每步问一次碰撞，所以"走不走得到"就该在画面空间里泛洪——不是在网格里
    （网格里相邻的两格在画上可能隔着一道墙的立面）。热点 / NPC 自带的碰撞多边形与地形一起挡人。
    """
    import cv2
    from scipy import ndimage
    w = max(16, int(round(g.ww / step)))
    m = screen_mask(g, blocked, grid, w)
    sy = m.shape[0] / g.wh
    sx = m.shape[1] / g.ww
    ent = np.zeros(m.shape, np.uint8)
    for _eid, pts in entity_block_polys(g, include_conditional=False):
        cv2.fillPoly(ent, [np.round(np.array([(x * sx, y * sy) for x, y in pts])).astype(np.int32)], 1)
    walk = ~m & (ent == 0)
    lab, _n = ndimage.label(walk)
    keep = np.zeros(lab.max() + 1, bool)
    for kind, _mid, x, y, _ in _marks(g):
        if kind not in ("spawn", "landing"):
            continue
        i = min(m.shape[0] - 1, max(0, int(y * sy)))
        j = min(m.shape[1] - 1, max(0, int(x * sx)))
        if lab[i, j] > 0:
            keep[lab[i, j]] = True
    return lab, walk, keep, sx


def reachable_screen(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, step: float) -> tuple[np.ndarray, float]:
    """画面空间里从出生点（及场内跳跃落点）走得到的可走区。"""
    lab, _walk, keep, sx = walk_components(g, blocked, grid, step)
    return keep[lab], sx


def _small_islands(g: SceneGeom, lab: np.ndarray, keep: np.ndarray, sx: float) -> list[str]:
    """没到孤岛门槛、但确实能站又走不到的碎片（桌缝、画底单格）：只作参考，摆人图上的橙点能在这里对上号。"""
    from scipy import ndimage
    if lab.max() == 0:
        return []
    min_area = max(2500.0, 0.001 * g.ww * g.wh) * sx * sx
    sizes = np.bincount(lab.ravel())
    out = []
    for idx, sl in enumerate(ndimage.find_objects(lab), 1):
        if sl is None or keep[idx] or sizes[idx] >= min_area:
            continue
        cy = (sl[0].start + sl[0].stop) / 2 / sx
        cx = (sl[1].start + sl[1].stop) / 2 / sx
        out.append(f"({cx:.0f},{cy:.0f}) 约 {sizes[idx] / sx / sx:.0f}")
    return out


def _islands(g: SceneGeom, lab: np.ndarray, keep: np.ndarray, sx: float) -> list[str]:
    """能站但从出生点走不到的整块地（孤岛）。摆人图照样会在上面站满人，只有这里看得出来。

    太小的碎渣（多边形边上栅格化的毛刺）不报：面积门槛 = max(50×50, 画面 0.1%)。
    """
    from scipy import ndimage
    if lab.max() == 0:
        return []
    min_area = max(2500.0, 0.001 * g.ww * g.wh) * sx * sx
    out = []
    objs = ndimage.find_objects(lab)
    sizes = np.bincount(lab.ravel())
    for idx, sl in enumerate(objs, 1):
        if sl is None or keep[idx] or sizes[idx] < min_area:
            continue
        y0, y1 = sl[0].start / sx, sl[0].stop / sx
        x0, x1 = sl[1].start / sx, sl[1].stop / sx
        out.append(f"孤岛 ({x0:.0f},{y0:.0f})-({x1:.0f},{y1:.0f}) 约 {sizes[idx] / sx / sx:.0f} 平方单位：能站但从出生点走不到")
    return out


def _zones_unreachable(g: SceneGeom, reach: np.ndarray, sx: float) -> list[str]:
    """触发区（`zones`）整块落在走不到的地方 = 它永远不会触发。"""
    out = []
    hh, ww_ = reach.shape
    for z in g.scene.get("zones") or []:
        poly = z.get("polygon") if isinstance(z, dict) else None
        if not isinstance(poly, list) or len(poly) < 3:
            continue
        pts = [[float(q.get("x", 0)), float(q.get("y", 0))] for q in poly]
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        i0, i1 = int(max(0, min(ys) * sx)), int(min(hh, max(ys) * sx + 1))
        j0, j1 = int(max(0, min(xs) * sx)), int(min(ww_, max(xs) * sx + 1))
        if i1 <= i0 or j1 <= j0:
            out.append(f"触发区 {z.get('id')} 在画外")
            continue
        yy, xx = np.mgrid[i0:i1, j0:j1]
        inside = tc.points_in_polygon((xx + 0.5) / sx, (yy + 0.5) / sx, pts)
        if not (reach[i0:i1, j0:j1] & inside).any():
            out.append(f"触发区 {z.get('id')} 整块走不到（它永远不会触发）")
    return out


def cmd_check(sid: str) -> int:
    from tools.terrain_workbench import authoring
    r = authoring.check_scene(sid)
    g = load_geom(sid)
    blocked, grid = load_blocked(sid)
    bad = [f"{kind} {mid} ({x:.0f},{y:.0f}) 落在阻挡里" for kind, mid, x, y, _ in _marks(g)
           if kind in ("spawn", "landing", "align") and bool(blocked_at(g, blocked, grid, [x], [y])[0])]
    under = []
    doc = tc.load_terrain(sid)
    regions = doc.get("regions") or []
    fine = []
    for reg in regions:
        ratio = region_realized(g, blocked, grid, reg, regions)
        if ratio is not None and ratio < 0.9:
            sp = region_screen_pts(g, reg)
            floor = ratio_floor(cells_thick(grid, reg["points"])) if (sp is not None and reg["id"] != OUTSIDE_ID) else 0.9
            if floor is None:
                fine.append(f"{reg['id']} {ratio:.0%}")
            elif ratio < floor:
                under.append(f"多边形 {reg['id']}（{reg['kind']}）只实现了 {ratio:.0%}（这么大的块及格线 {floor:.0%}）")
    # 要走过去按 E 的东西：交互半径里至少有一处"从出生点走得到"的可走点
    step = max(4.0, g.ww / 400.0)
    lab, _walk, keep, sx = walk_components(g, blocked, grid, step)
    reach = keep[lab]
    islands = _islands(g, lab, keep, sx)
    crumbs = _small_islands(g, lab, keep, sx)
    zones = _zones_unreachable(g, reach, sx)
    unreach = []
    hh, ww_ = reach.shape
    for kind, mid, x, y, rng in _interactables(g):
        i0, i1 = int(max(0, (y - rng) * sx)), int(min(hh, (y + rng) * sx + 1))
        j0, j1 = int(max(0, (x - rng) * sx)), int(min(ww_, (x + rng) * sx + 1))
        if i1 <= i0 or j1 <= j0:
            unreach.append(f"{kind} {mid} ({x:.0f},{y:.0f}) 在画外")
            continue
        yy, xx = np.mgrid[i0:i1, j0:j1]
        disk = ((xx + 0.5) / sx - x) ** 2 + ((yy + 0.5) / sx - y) ** 2 <= rng * rng
        if not (reach[i0:i1, j0:j1] & disk).any():
            # 给个最近的走得到的点：多半是"人摆在了墙面 / 屋顶上"，挪到墙脚那块地上（x 尽量不变）
            ry, rx = np.nonzero(reach)
            hint = ""
            if len(rx):
                px = (rx + 0.5) / sx
                py = (ry + 0.5) / sx
                d2 = (px - x) ** 2 + (py - y) ** 2 * 1.0
                i = int(np.argmin(d2))
                hint = f"；最近走得到的点 ({px[i]:.0f},{py[i]:.0f})，离 {math.sqrt(d2[i]):.0f}"
            if not hint:
                hint = "；出生点全落在阻挡里，先修出生点"
            unreach.append(f"{kind} {mid} ({x:.0f},{y:.0f}) 交互半径 {rng:.0f} 内没有走得到的地方{hint}")
    # 各时段原画的行走面不同 ⇒ 同一张碰撞网格投到画上会差一点：差得多要分别看图
    variants = []
    base_mask = screen_mask(g, blocked, grid, 400)
    for vid, tv in (g.scene.get("timeVariants") or {}).items():
        if not isinstance(tv, dict) or not tv.get("backgrounds"):
            continue
        try:
            gv = load_geom(sid, vid)
        except SystemExit:
            continue
        if gv.bake_dir == g.bake_dir:
            continue
        mv = screen_mask(gv, blocked, grid, 400)
        variants.append({"variant": vid, "diffPct": round(float((mv != base_mask).mean() * 100), 2)})
    doc_brush = bool(doc.get("brush"))
    # 没写物体高的阻挡块：扁的东西（死角地、水、崖外）本来就不该写；立着的东西忘写 h，摆人图就不会把它后面的人抠掉——
    # 这里只列出来，逐个过一眼"它是不是立着的"
    no_h = [r["id"] for r in regions if r.get("kind") == "block" and not _is_generated(r)
            and not (r.get("screen") or {}).get("flat")
            and not (isinstance((r.get("screen") or {}).get("h"), (int, float)) and (r.get("screen") or {}).get("h") > 0)]
    # 画面落在碰撞网格外的比例：那里运行时一律当"不挡"，画多边形也挡不住——先 `grid --fit`
    gm = screen_mask(g, np.ones_like(blocked), grid, 400)
    outside_pct = round(float((~gm).mean() * 100), 2)
    out = {"scene": sid, "problems": r.get("problems", []), "reach": r.get("reach", []), "marksOnBlock": bad,
           "interactUnreachable": unreach, "zoneUnreachable": zones, "islands": islands, "smallIslands": crumbs,
           "underRealized": under,
           "finerThanGrid": fine, "variantDiff": variants, "variants": _variant_names(g.scene),
           "brushLayer": doc_brush, "offGridPct": outside_pct, "blocksWithoutH": no_h,
           "needsExport": r.get("needsExport")}
    if outside_pct > 0.5 and (islands or under):
        out["hint"] = f"画面有 {outside_pct}% 落在碰撞网格外（运行时当不挡），孤岛 / 实现不足多半是它：先 grid --fit"
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 1 if any(out[k] for k in FAILING_KEYS) else 0


#: check 里任何一项不空都算没过（退出码 1）；smallIslands / finerThanGrid / variantDiff / brushLayer / offGridPct /
#: blocksWithoutH 只作参考
FAILING_KEYS = ("problems", "reach", "marksOnBlock", "interactUnreachable", "zoneUnreachable", "islands", "underRealized")


def connected(g: SceneGeom, blocked: np.ndarray, grid: tc.GridMeta, a: tuple[float, float], b: tuple[float, float],
              seals: list[tuple[float, float, float, float]] | None = None, step: float | None = None) -> bool | None:
    """a、b 两个画面点在"游戏此刻的碰撞"里走不走得通（画面空间 4 邻接泛洪，实体自带碰撞一起挡）。

    `seals` = 临时加的阻挡矩形（场景坐标 x0,y0,x1,y1），只在这次计算里生效——把院门 / 门洞堵上再问
    "墙外走不走得进墙里"，就是薄墙漏缝检查。任一点本身不可走回 None。
    """
    import cv2
    from scipy import ndimage
    st = step or max(2.0, g.ww / 800.0)
    w = max(16, int(round(g.ww / st)))
    m = screen_mask(g, blocked, grid, w)
    sy = m.shape[0] / g.wh
    sx = m.shape[1] / g.ww
    ent = np.zeros(m.shape, np.uint8)
    for _eid, pts in entity_block_polys(g, include_conditional=False):
        cv2.fillPoly(ent, [np.round(np.array([(x * sx, y * sy) for x, y in pts])).astype(np.int32)], 1)
    walk = ~m & (ent == 0)
    for x0, y0, x1, y1 in seals or []:
        walk[max(0, int(y0 * sy)):int(np.ceil(y1 * sy)), max(0, int(x0 * sx)):int(np.ceil(x1 * sx))] = False
    lab, _n = ndimage.label(walk)

    def at(pt):
        i = min(m.shape[0] - 1, max(0, int(pt[1] * sy)))
        j = min(m.shape[1] - 1, max(0, int(pt[0] * sx)))
        if lab[i, j] > 0:
            return lab[i, j]
        # 点落在墙 / 物体上：取 SNAP 场景单位以内最近的可走点（门的标记点常摆在门脸墙上）
        r = max(1, int(SNAP * sx))
        i0, i1 = max(0, i - r), min(m.shape[0], i + r + 1)
        j0, j1 = max(0, j - r), min(m.shape[1], j + r + 1)
        sub = lab[i0:i1, j0:j1]
        ys, xs = np.nonzero(sub)
        if not len(ys):
            return 0
        d = (ys + i0 - i) ** 2 + (xs + j0 - j) ** 2
        n = int(np.argmin(d))
        return sub[ys[n], xs[n]]

    la, lb = at(a), at(b)
    if la == 0 or lb == 0:
        return None
    return bool(la == lb)


#: `connected` 的点落在不可走处时，往外找最近可走点的半径（场景单位）
SNAP = 40.0


def cmd_connected(sid: str, a: str, b: str, seals: list[str]) -> int:
    g = load_geom(sid)
    blocked, grid = load_blocked(sid)
    pa = tuple(float(v) for v in a.split(","))
    pb = tuple(float(v) for v in b.split(","))
    rects = [tuple(float(v) for v in r.split(",")) for r in seals]
    r = connected(g, blocked, grid, pa, pb, rects)
    msg = {None: f"有一点周围 {SNAP:.0f} 以内都不可走", True: "连通", False: "不连通"}[r]
    print(json.dumps({"scene": sid, "a": pa, "b": pb, "seals": rects, "result": msg}, ensure_ascii=False))
    return 0 if r is not None else 1


def cmd_probe(sid: str, pts: list[str]) -> None:
    g = load_geom(sid)
    blocked, grid = load_blocked(sid)
    xs, ys = [], []
    for t in pts:
        a, b = t.split(",")
        xs.append(float(a))
        ys.append(float(b))
    b = blocked_at(g, blocked, grid, xs, ys)
    for x, y, v in zip(xs, ys, b):
        print(f"({x:.0f},{y:.0f})\t{'阻挡' if v else '可走'}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="art_review")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("render"); p.add_argument("sid"); p.add_argument("--variant"); p.add_argument("--width", type=int, default=1600)
    p.add_argument("--out", help="输出路径（缺省 local/collision_review/<场景>/overlay.png；复查者用自己的目录，别覆盖修复者的图）")
    p = sub.add_parser("depth"); p.add_argument("sid"); p.add_argument("--width", type=int, default=1200)
    p = sub.add_parser("depthsheet", help="深度体检 + 交付对照图(原画 | 深度 | 朝向 | 行走面) + 路面坡度 / 立面垂直度 / 是否塌平")
    p.add_argument("sid"); p.add_argument("--width", type=int, default=800); p.add_argument("--out")
    p = sub.add_parser("crowd"); p.add_argument("sid"); p.add_argument("--variant"); p.add_argument("--width", type=int, default=1600)
    p.add_argument("--occlusion", choices=("h", "depth", "both"), default="h",
                   help="人被挡掉哪一截按什么算:h = 作者估的物体高(缺省,不读深度) / depth = 游戏真实深度遮挡 / both = 两份对比")
    p.add_argument("--spacing", type=float, default=0.0); p.add_argument("--seed", type=int, default=0)
    for b in ("x0", "y0", "x1", "y1"):
        p.add_argument(f"--{b}", type=float)
    p.add_argument("--out")
    p = sub.add_parser("crop"); p.add_argument("sid")
    for b in ("x0", "y0", "x1", "y1"):
        p.add_argument(b, type=float)
    p.add_argument("--scale", type=float, default=0.0); p.add_argument("--depth", action="store_true",
                                                                                  help="叠深度着色（不作依据：有的图深度是错的）")
    p.add_argument("--overlay", action="store_true"); p.add_argument("--variant"); p.add_argument("--draft")
    p.add_argument("--out"); p.add_argument("--no-grid", action="store_true", help="不画坐标格（高倍放大看细节时）")
    p = sub.add_parser("apply"); p.add_argument("sid"); p.add_argument("draft")
    p = sub.add_parser("regions"); p.add_argument("sid")
    p = sub.add_parser("region"); p.add_argument("sid"); p.add_argument("--id", required=True)
    p.add_argument("--kind", required=True); p.add_argument("--pts", required=True); p.add_argument("--note", default="")
    p.add_argument("--h", type=float, help="物体高（场景单位）：block 的 pts 是占地，h 是它往上立多高，只给复查图估遮挡")
    p = sub.add_parser("remove"); p.add_argument("sid"); p.add_argument("--id", required=True)
    p = sub.add_parser("brush"); p.add_argument("sid"); p.add_argument("--clear", action="store_true", required=True)
    p = sub.add_parser("grid"); p.add_argument("sid"); p.add_argument("--fit", action="store_true", required=True)
    p = sub.add_parser("pin-screen", help="重做深度之前：把作者多边形的画面轮廓钉住（按当前几何）"); p.add_argument("sid")
    p = sub.add_parser("reanchor", help="重做深度之后：按画面轮廓把作者多边形重新落到新几何上"); p.add_argument("sid")
    p = sub.add_parser("move"); p.add_argument("sid"); p.add_argument("what"); p.add_argument("xy")
    p = sub.add_parser("footprint", help="按画面轮廓圈的阻挡块 → 占地 + h 草稿（不落盘）")
    p.add_argument("sid"); p.add_argument("--id", required=True); p.add_argument("--h", type=float, required=True)
    p.add_argument("--out")
    p = sub.add_parser("check"); p.add_argument("sid")
    p = sub.add_parser("probe"); p.add_argument("sid"); p.add_argument("pts", nargs="+")
    p = sub.add_parser("connected", help="两个画面点走不走得通；--seal 临时堵一个矩形（堵上院门再问墙外进不进得了院 = 薄墙漏缝检查）")
    p.add_argument("sid"); p.add_argument("a"); p.add_argument("b")
    p.add_argument("--seal", action="append", default=[], help="x0,y0,x1,y1（场景坐标），可给多个")
    a = ap.parse_args()
    if a.cmd == "render":
        cmd_render(a.sid, a.variant, a.width, Path(a.out) if a.out else None)
    elif a.cmd == "depth":
        cmd_depth(a.sid, a.width)
    elif a.cmd == "depthsheet":
        cmd_depthsheet(a.sid, a.width, a.out)
    elif a.cmd == "crowd":
        g = load_geom(a.sid, a.variant)
        box = None
        if any(v is not None for v in (a.x0, a.y0, a.x1, a.y1)):
            box = (a.x0 or 0.0, a.y0 or 0.0, a.x1 if a.x1 is not None else g.ww, a.y1 if a.y1 is not None else g.wh)
        area = (box[2] - box[0]) * (box[3] - box[1]) if box else g.ww * g.wh
        # 缺省密度：每张图约 350 个撒点（可走的才摆人）——再密人身子叠成一片，只剩脚底圆点能看；框一片时同样多撒点铺满那一片
        spacing = a.spacing or max(20.0, math.sqrt(area / 350.0))
        cmd_crowd(a.sid, a.variant, a.width, spacing, a.seed, box, a.out, a.occlusion)
    elif a.cmd == "crop":
        cmd_crop(a.sid, (a.x0, a.y0, a.x1, a.y1), a.scale, a.depth, a.overlay, a.variant, a.draft, a.out,
                 grid_lines=not a.no_grid)
    elif a.cmd == "apply":
        return cmd_apply(a.sid, a.draft)
    elif a.cmd == "regions":
        cmd_regions(a.sid)
    elif a.cmd == "region":
        cmd_region(a.sid, a.id, a.kind, a.pts, a.note, a.h)
    elif a.cmd == "remove":
        cmd_remove(a.sid, a.id)
    elif a.cmd == "brush":
        cmd_brush_clear(a.sid)
    elif a.cmd == "grid":
        cmd_grid_fit(a.sid)
    elif a.cmd == "pin-screen":
        cmd_pin_screen(a.sid)
    elif a.cmd == "reanchor":
        cmd_reanchor(a.sid)
    elif a.cmd == "move":
        cmd_move(a.sid, a.what, a.xy)
    elif a.cmd == "footprint":
        cmd_footprint(a.sid, a.id, a.h, a.out)
    elif a.cmd == "check":
        return cmd_check(a.sid)
    elif a.cmd == "probe":
        cmd_probe(a.sid, a.pts)
    elif a.cmd == "connected":
        return cmd_connected(a.sid, a.a, a.b, a.seal)
    return 0


if __name__ == "__main__":
    sys.exit(main())
