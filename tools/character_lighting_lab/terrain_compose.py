# -*- coding: utf-8 -*-
"""地形（碰撞 / 可走区 / 行走面修补）的**唯一合成器**。

## 为什么要有这个模块（2026-09-14）

碰撞与行走面此前只有烘焙器一个产出方，作者只能在实验室里用**屏幕空间**笔刷改，而且那几张笔刷层
只躺在 git 忽略的 `out/` 里——崖墓前段1 / 崖墓正式的碰撞就靠它们定，却只存在一台机器上。
地形工作台（`tools/terrain_workbench`）接管作者面之后，数据分成三层：

    烘焙器的自动结果（auto）  ⊕  作者层（笔刷 / 多边形 / 高度增量）  →  游戏读的产物

- **作者层**住 `public/resources/runtime/scenes/<id>/terrain/`（DVC，与 `sway_paint.png` 同一待遇），
  地形工作台是它唯一的写入者；烘焙器只写 `auto` 那一份（`record_auto`）。
- **合成只有这一份实现**：实验室导出（`pipeline.export_scene_depth` / `export_runtime`）与工作台的
  「导出到游戏」/「推给游戏」都调 :func:`export_terrain`。重烘一次、作者手动标定一次，作者层原样叠回去。
- **游戏读的**：`collision.png`（红通道 255 = 阻挡，不变）+ **`collision.json` 旁挂**（网格原点 / 格大小 /
  宽高；取代场景 JSON 里的 `depthConfig.collision`，工作台从此不碰场景 JSON），以及各时段目录里的
  `lighting/<背景基名>/ground_d.png`（行走面深度，屏幕参数化，运行时读法一个字节不改）。

## 坐标

作者层一律 **M-world XZ，网格单位**（`depthConfig.M.R`，det=+1，**没乘 wu/q**——运行时 `isCollision` 就是拿
`R·(qx, qy, d)` 直接落格的，碰撞网格的 `x_min / cell_size` 全在这个单位里；轨迹 / 粒子那几台显示的 wu = 这个 × `wuPerQUnit`）。
多边形顶点、羽化、高度增量与压平高度也都是网格单位；工作台页面按 wu 显示、存盘时除回去。
烘焙器的行走面网格是 det=−1 的实验室世界，`export_scene_depth` 翻 Z 之后再交给 :func:`record_auto`——本模块不认识实验室坐标。
格子判定与运行时 `SceneDepthSystem.isCollision` 同口径：`gx = floor((wx − x_min) / cell)`，
所以"格子 (i, j) 的中心"= `(x_min + (i + 0.5)·cell, z_min + (j + 0.5)·cell)`，多边形按**格心在不在多边形内**栅格化。

## 合成规则

- 碰撞：`可走 = (auto可走 ∪ 笔刷可走 ∪ 多边形可走) − (笔刷阻挡 ∪ 多边形阻挡)`——**阻挡压过可走**，
  与来源无关、与顺序无关（沿用实验室笔刷的既有约定）。auto 网格之外的格子按运行时语义算"没数据 = 可走"。
- 行走面：`Y(x,z) = Y基底(x,z) + Δ(x,z)`，Δ = 高度增量栅格（双线性）+ 多边形操作（压平到某高度 / 整块抬高，
  带羽化）。基底是烘焙器导出时留在各时段目录里的 `ground_base.png`；合成后**对每条屏幕射线重新求交**写回
  `ground_d.png`，Δ 恒 0 的像素逐字节不动（无修补时 `ground_d == ground_base`）。
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'

TERRAIN_VERSION = 1
TERRAIN_DIR = 'terrain'
TERRAIN_JSON = 'terrain.json'
AUTO_FILE = 'collision_auto.png'
BRUSH_FILE = 'walk_brush.png'
HEIGHT_FILE = 'height_delta.png'
GROUND_BASE_FILE = 'ground_base.png'
SIDECAR_FILE = 'collision.json'
SIDECAR_VERSION = 1
#: 高度增量栅格的编码量程（wu）：u16 = round(Δ / range × 32768 + 32768)
HEIGHT_RANGE_DEFAULT = 1.0        # 高度增量栅格的缺省量程(网格单位;存盘时按内容放大)
#: 笔刷层的值（红通道）
BRUSH_AUTO, BRUSH_WALK, BRUSH_BLOCK = 0, 1, 2
REGION_KINDS = ('walk', 'block')
HEIGHT_OP_KINDS = ('flatten', 'offset')
#: 合成来源位（工作台的检视要说"这一格谁决定的"）
SRC_AUTO_WALK, SRC_AUTO_BLOCK, SRC_BRUSH_WALK, SRC_BRUSH_BLOCK, SRC_REGION_WALK, SRC_REGION_BLOCK = 0, 1, 2, 3, 4, 5
SRC_OUTSIDE = 6


# ---------------------------------------------------------------- 原子写
def _awrite(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    from tools.atomic_io import retry_transient
    retry_transient(os.replace, tmp, dest)


def _awrite_json(dest: Path, doc: dict, indent: int = 2) -> None:
    _awrite(dest, (json.dumps(doc, ensure_ascii=False, indent=indent) + '\n').encode('utf-8'))


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def _sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()[:12]


# ---------------------------------------------------------------- 网格
@dataclass(frozen=True)
class GridMeta:
    """世界 XZ 栅格（网格单位 = 没乘 wu/q 的 M-world）。与运行时 `depthConfig.collision` 逐字段同名。"""
    x_min: float
    z_min: float
    cell_size: float
    grid_width: int
    grid_height: int

    @staticmethod
    def from_dict(d: dict) -> 'GridMeta':
        return GridMeta(float(d['x_min']), float(d['z_min']), float(d['cell_size']),
                        int(d['grid_width']), int(d['grid_height']))

    def to_dict(self) -> dict:
        return asdict(self)

    def centers(self) -> tuple[np.ndarray, np.ndarray]:
        """(X, Z) 两张 (gh, gw) 的格心坐标。"""
        xs = self.x_min + (np.arange(self.grid_width, dtype=np.float64) + 0.5) * self.cell_size
        zs = self.z_min + (np.arange(self.grid_height, dtype=np.float64) + 0.5) * self.cell_size
        X, Z = np.meshgrid(xs, zs)
        return X, Z

    def cell_of(self, wx: np.ndarray, wz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """世界 → 格索引（floor，与运行时 `wrWorldXZToCell` 同式）。"""
        gx = np.floor((np.asarray(wx, np.float64) - self.x_min) / self.cell_size).astype(np.int64)
        gz = np.floor((np.asarray(wz, np.float64) - self.z_min) / self.cell_size).astype(np.int64)
        return gx, gz

    def inside(self, gx: np.ndarray, gz: np.ndarray) -> np.ndarray:
        return (gx >= 0) & (gx < self.grid_width) & (gz >= 0) & (gz < self.grid_height)

    def same(self, other: 'GridMeta') -> bool:
        return (abs(self.x_min - other.x_min) < 1e-9 and abs(self.z_min - other.z_min) < 1e-9
                and abs(self.cell_size - other.cell_size) < 1e-12
                and self.grid_width == other.grid_width and self.grid_height == other.grid_height)


def read_u8_png(path: Path) -> np.ndarray:
    """单通道 / RGB 的红通道，uint8。⚠ 不用 `convert('L')`：亮度加权会把 R=2 压成 1。"""
    im = Image.open(path)
    if im.mode in ('L', 'P', '1'):
        return np.asarray(im.convert('L'), np.uint8)
    return np.asarray(im.convert('RGB'), np.uint8)[..., 0]


def write_u8_png(path: Path, arr: np.ndarray) -> bytes:
    data = _png_bytes(Image.fromarray(np.ascontiguousarray(arr, dtype=np.uint8), 'L'))
    _awrite(path, data)
    return data


def resample_nearest(src: np.ndarray, src_grid: GridMeta, dst_grid: GridMeta, fill: int) -> np.ndarray:
    """按目标格心在源网格里取最近格；落在源网格外的填 `fill`。"""
    if src_grid.same(dst_grid):
        return src.copy()
    X, Z = dst_grid.centers()
    gx, gz = src_grid.cell_of(X, Z)
    ok = src_grid.inside(gx, gz)
    out = np.full((dst_grid.grid_height, dst_grid.grid_width), fill, src.dtype)
    out[ok] = src[gz[ok], gx[ok]]
    return out


def points_in_polygon(px: np.ndarray, pz: np.ndarray, poly: list) -> np.ndarray:
    """射线法，向量化。边上的点按"进"算不稳定，作者面用格心采样，边落在格心上的概率可以忽略。"""
    pts = np.asarray(poly, np.float64)
    if pts.ndim != 2 or len(pts) < 3:
        return np.zeros(np.shape(px), bool)
    x = np.asarray(px, np.float64)
    z = np.asarray(pz, np.float64)
    inside = np.zeros(x.shape, bool)
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, zi = pts[i]
        xj, zj = pts[j]
        cond = (zi > z) != (zj > z)
        with np.errstate(divide='ignore', invalid='ignore'):
            xcross = (xj - xi) * (z - zi) / (zj - zi) + xi
        inside ^= cond & (x < xcross)
        j = i
    return inside


def rasterize_polygon(points: list, grid: GridMeta) -> np.ndarray:
    X, Z = grid.centers()
    return points_in_polygon(X, Z, points)


# ---------------------------------------------------------------- 作者层文件
def terrain_dir(sid: str) -> Path:
    return SCENES_RT / sid / TERRAIN_DIR


def sidecar_path(sid: str) -> Path:
    return SCENES_RT / sid / SIDECAR_FILE


def default_terrain(grid: GridMeta | None = None) -> dict:
    return {
        'version': TERRAIN_VERSION,
        'grid': grid.to_dict() if grid else None,
        'auto': None,
        'brush': None,
        'regions': [],
        'height': None,
        'heightOps': [],
        'updated': None,
    }


def load_terrain(sid: str) -> dict:
    """`terrain/terrain.json`；没有 = 空白作者层（网格待定）。形状坏了直接抛，不静默当空白。"""
    p = terrain_dir(sid) / TERRAIN_JSON
    if not p.exists():
        return default_terrain()
    doc = json.loads(p.read_text(encoding='utf-8'))
    problems = terrain_problems(doc)
    if problems:
        raise ValueError(f'{p}: ' + '；'.join(problems))
    return doc


def terrain_problems(doc: object) -> list[str]:
    """形状闸门（工作台保存 / 校验器共用）。返回问题清单，空 = 合法。"""
    out: list[str] = []
    if not isinstance(doc, dict):
        return ['terrain.json 须为对象']
    if doc.get('version') != TERRAIN_VERSION:
        out.append(f'version 须为 {TERRAIN_VERSION}')
    grid = doc.get('grid')
    if grid is not None:
        try:
            g = GridMeta.from_dict(grid)
            if g.cell_size <= 0 or g.grid_width <= 0 or g.grid_height <= 0:
                out.append('grid 的 cell_size / grid_width / grid_height 须为正')
            if g.grid_width * g.grid_height > 4_000_000:
                out.append('grid 太大（超过 400 万格）')
        except (KeyError, TypeError, ValueError):
            out.append('grid 缺字段或不是数')
    for key in ('auto', 'brush', 'height'):
        v = doc.get(key)
        if v is not None:
            if not isinstance(v, dict) or not isinstance(v.get('file'), str):
                out.append(f'{key} 须为 {{file, ...}}')
            elif key in ('auto', 'height'):
                try:
                    GridMeta.from_dict(v)
                except (KeyError, TypeError, ValueError):
                    out.append(f'{key} 缺网格字段')
    regs = doc.get('regions')
    if not isinstance(regs, list):
        out.append('regions 须为数组')
    else:
        seen: set[str] = set()
        for i, r in enumerate(regs):
            tag = f'regions[{i}]'
            if not isinstance(r, dict):
                out.append(f'{tag} 须为对象')
                continue
            rid = r.get('id')
            if not isinstance(rid, str) or not rid:
                out.append(f'{tag} 缺 id')
            elif rid in seen:
                out.append(f'{tag} id 重复：{rid}')
            else:
                seen.add(rid)
            if r.get('kind') not in REGION_KINDS:
                out.append(f'{tag} kind 须为 walk / block')
            pts = r.get('points')
            if (not isinstance(pts, list) or len(pts) < 3
                    or any(not (isinstance(p, list) and len(p) == 2
                                and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p)) for p in pts)):
                out.append(f'{tag} points 须为 ≥3 个 [x, z]')
    ops = doc.get('heightOps')
    if not isinstance(ops, list):
        out.append('heightOps 须为数组')
    else:
        seen = set()
        for i, r in enumerate(ops):
            tag = f'heightOps[{i}]'
            if not isinstance(r, dict):
                out.append(f'{tag} 须为对象')
                continue
            rid = r.get('id')
            if not isinstance(rid, str) or not rid:
                out.append(f'{tag} 缺 id')
            elif rid in seen:
                out.append(f'{tag} id 重复：{rid}')
            else:
                seen.add(rid)
            if r.get('kind') not in HEIGHT_OP_KINDS:
                out.append(f'{tag} kind 须为 flatten / offset')
            if not isinstance(r.get('value'), (int, float)) or not math.isfinite(r.get('value')):
                out.append(f'{tag} value 须为数（wu）')
            pts = r.get('points')
            if not isinstance(pts, list) or len(pts) < 3:
                out.append(f'{tag} points 须为 ≥3 个 [x, z]')
            f = r.get('feather', 0)
            if not isinstance(f, (int, float)) or f < 0:
                out.append(f'{tag} feather 须为 ≥0 的数（wu）')
    return out


def save_terrain(sid: str, doc: dict) -> None:
    problems = terrain_problems(doc)
    if problems:
        raise ValueError('terrain.json 形状不合法：' + '；'.join(problems))
    doc = dict(doc)
    doc['updated'] = time.strftime('%Y-%m-%d %H:%M:%S')
    _awrite_json(terrain_dir(sid) / TERRAIN_JSON, doc)


def record_auto(sid: str, blocked: np.ndarray, grid: GridMeta) -> dict:
    """烘焙器导出时留下自动结果（游戏网格，255 = 阻挡）。作者层其余部分一个字节不动。
    作者层还没定网格时，网格就取自动结果的。"""
    doc = load_terrain(sid)
    data = write_u8_png(terrain_dir(sid) / AUTO_FILE, np.where(blocked, 255, 0).astype(np.uint8))
    doc['auto'] = {'file': AUTO_FILE, **grid.to_dict(), 'sha1': _sha1(data),
                   'baked_at': time.strftime('%Y-%m-%d %H:%M:%S')}
    if doc.get('grid') is None:
        doc['grid'] = grid.to_dict()
    save_terrain(sid, doc)
    return doc


def load_auto(sid: str, doc: dict) -> tuple[np.ndarray, GridMeta] | None:
    a = doc.get('auto')
    if not a:
        return None
    p = terrain_dir(sid) / a['file']
    if not p.exists():
        return None
    return read_u8_png(p) > 127, GridMeta.from_dict(a)


def load_brush(sid: str, doc: dict, grid: GridMeta, layers: dict | None = None) -> np.ndarray:
    """笔刷层（与 doc.grid 同网格；不同就最近邻重采样，网格外 = 自动）。``layers['brush']`` 给了就用页面上那份。"""
    empty = np.zeros((grid.grid_height, grid.grid_width), np.uint8)
    if layers is not None and layers.get('brush') is not None:
        arr = np.asarray(layers['brush'], np.uint8)
        if arr.shape != empty.shape:
            raise ValueError(f'笔刷层 {arr.shape[::-1]} ≠ 网格 {grid.grid_width}x{grid.grid_height}')
        return arr
    b = doc.get('brush')
    if not b:
        return empty
    p = terrain_dir(sid) / b['file']
    if not p.exists():
        return empty
    arr = read_u8_png(p)
    src_grid = GridMeta.from_dict(b) if 'cell_size' in b else grid
    if arr.shape != (src_grid.grid_height, src_grid.grid_width):
        raise ValueError(f'{p} 尺寸 {arr.shape[::-1]} ≠ 声明 {src_grid.grid_width}x{src_grid.grid_height}')
    return resample_nearest(arr, src_grid, grid, BRUSH_AUTO)


# ---------------------------------------------------------------- 碰撞合成
def compose_collision(sid: str, doc: dict | None = None, layers: dict | None = None) -> tuple[np.ndarray, np.ndarray, GridMeta]:
    """→ (blocked bool (gh,gw), source uint8 (gh,gw), grid)。"""
    doc = load_terrain(sid) if doc is None else doc
    if not doc.get('grid'):
        raise ValueError(f'{sid}: 地形作者层还没有网格（先让烘焙器导出一次深度，或迁移）')
    grid = GridMeta.from_dict(doc['grid'])
    gh, gw = grid.grid_height, grid.grid_width
    auto = load_auto(sid, doc)
    if auto is None:
        auto_blocked = np.zeros((gh, gw), bool)          # 没有自动结果 = 全可走（运行时"没数据"的语义）
        src = np.full((gh, gw), SRC_OUTSIDE, np.uint8)
    else:
        a_blocked, a_grid = auto
        # 255 = 阻挡；auto 网格外的格子 → 值 2 = "没数据"
        raw = resample_nearest(np.where(a_blocked, 1, 0).astype(np.uint8), a_grid, grid, 2)
        auto_blocked = raw == 1
        src = np.where(raw == 2, SRC_OUTSIDE, np.where(auto_blocked, SRC_AUTO_BLOCK, SRC_AUTO_WALK)).astype(np.uint8)
    walk = ~auto_blocked
    brush = load_brush(sid, doc, grid, layers)
    bw, bb = brush == BRUSH_WALK, brush == BRUSH_BLOCK
    rw = np.zeros((gh, gw), bool)
    rb = np.zeros((gh, gw), bool)
    for r in doc.get('regions') or []:
        m = rasterize_polygon(r['points'], grid)
        if r['kind'] == 'walk':
            rw |= m
        else:
            rb |= m
    walk = (walk | bw | rw) & ~(bb | rb)
    src[bw] = SRC_BRUSH_WALK
    src[rw] = SRC_REGION_WALK
    src[bb] = SRC_BRUSH_BLOCK
    src[rb] = SRC_REGION_BLOCK
    return ~walk, src, grid


def write_collision(sid: str, blocked: np.ndarray, grid: GridMeta, out_dir: Path | None = None,
                    collision_map: str = 'collision.png', provenance: dict | None = None) -> dict:
    """`collision.png` + `collision.json` 落到运行时目录（缺省）或预览目录。"""
    dest = out_dir if out_dir is not None else SCENES_RT / sid
    png = write_u8_png(dest / collision_map, np.where(blocked, 255, 0).astype(np.uint8))
    meta = {'version': SIDECAR_VERSION, 'collision_map': collision_map, **grid.to_dict(),
            'composed': {'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'png_sha1': _sha1(png), **(provenance or {})}}
    _awrite_json(dest / SIDECAR_FILE, meta)
    return meta


def load_collision_meta(sid: str, cfg: dict | None = None, base: Path | None = None) -> GridMeta | None:
    """运行时同一条优先级：旁挂 `collision.json` 先，没有再退回 `depthConfig.collision`。"""
    base = base if base is not None else SCENES_RT / sid
    p = base / SIDECAR_FILE
    if p.exists():
        d = json.loads(p.read_text(encoding='utf-8'))
        return GridMeta.from_dict(d)
    col = (cfg or {}).get('collision')
    if col:
        return GridMeta.from_dict(col)
    return None


# ---------------------------------------------------------------- 行走面（高度修补）
def decode_ground_png(path: Path, lo: float, hi: float) -> np.ndarray:
    arr = np.asarray(Image.open(path).convert('RGB'), np.float32)
    t = (arr[..., 0] * 256.0 + arr[..., 1]) / 65535.0
    return (lo + t * (hi - lo)).astype(np.float32)


def encode_ground(d: np.ndarray) -> tuple[bytes, float, float]:
    """与 `pipeline.export_runtime` 逐字同式（min/max 不加 eps）。"""
    lo, hi = float(d.min()), float(d.max())
    n16 = np.round((d - lo) / max(hi - lo, 1e-6) * 65535).astype(np.uint16)
    rg = np.zeros(d.shape + (3,), np.uint8)
    rg[..., 0] = n16 >> 8
    rg[..., 1] = n16 & 0xFF
    return _png_bytes(Image.fromarray(rg)), lo, hi


def scene_background_names(sid: str) -> list[str]:
    """顶层背景 + 各时段变体的第一层背景（只在开了 dayNight 时算变体；与 `scene_geometry.scene_backgrounds` 同口径，
    这里自己读 `SCENES_JSON` 是为了测试能把根目录换掉）。"""
    data = json.loads((SCENES_JSON / f'{sid}.json').read_text(encoding='utf-8'))
    bgs = data.get('backgrounds') or []
    out = [(bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png']
    if (data.get('dayNight') or {}).get('enabled'):
        for v in (data.get('timeVariants') or {}).values():
            vb = (v or {}).get('backgrounds') or []
            img = vb[0].get('image') if vb and isinstance(vb[0], dict) else None
            if isinstance(img, str) and img.strip() and img not in out:
                out.append(img)
    return out


def scene_bake_dirs(sid: str) -> list[Path]:
    """本场景全部时段原画的烘焙目录（有 lighting.json 的才算）。"""
    from tools.character_lighting_lab.scene_geometry import bake_key
    out = []
    for bg in scene_background_names(sid):
        d = SCENES_RT / sid / 'lighting' / bake_key(bg)
        if (d / 'lighting.json').exists():
            out.append(d)
    return out


def record_ground_base(bake_dir: Path, ground_png: bytes, lo: float, hi: float) -> None:
    """烘焙器导出行走面时把**未修补**的那份留在旁边（`ground_base.png` + lighting.json.ground_base）。"""
    _awrite(bake_dir / GROUND_BASE_FILE, ground_png)
    lj = bake_dir / 'lighting.json'
    meta = json.loads(lj.read_text(encoding='utf-8'))
    meta['ground_base'] = {'min': lo, 'max': hi}
    _awrite(lj, (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))


def ensure_ground_base(bake_dir: Path) -> bool:
    """没有基底的老载荷：把现在的 `ground_d.png` 当基底记下来（迁移 / 首次修补前调用）。返回是否新建。"""
    if (bake_dir / GROUND_BASE_FILE).exists():
        return False
    lj = bake_dir / 'lighting.json'
    meta = json.loads(lj.read_text(encoding='utf-8'))
    gd = meta['ground_d']
    record_ground_base(bake_dir, (bake_dir / 'ground_d.png').read_bytes(), float(gd['min']), float(gd['max']))
    return True


def scene_frame(sid: str, bake_dir: Path) -> dict:
    """合成行走面要的标定：work 标定（lighting.json.cal / work）、R（depthConfig.M.R，det=+1）、wu/q。"""
    data = json.loads((SCENES_JSON / f'{sid}.json').read_text(encoding='utf-8'))
    cfg = data.get('depthConfig') or {}
    meta = json.loads((bake_dir / 'lighting.json').read_text(encoding='utf-8'))
    bgs = data.get('backgrounds') or []
    bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
    nw, nh = Image.open(SCENES_RT / sid / bg_name).size
    world_w = float(data.get('worldWidth') or nw)
    ppu_nat = float(cfg['M']['ppu'])
    return {
        'R': np.asarray(cfg['M']['R'], np.float64),
        'wu_per_q': world_w / (nw / ppu_nat),
        'cal': {'ppu': float(meta['cal']['ppu']), 'cx': float(meta['cal']['cx']), 'cy': float(meta['cal']['cy'])},
        'work': (int(meta['work']['w']), int(meta['work']['h'])),
        'meta': meta,
    }


def build_heightfield(ground: np.ndarray, cal: dict, R: np.ndarray, wu_per_q: float, n: int = 256) -> dict:
    """行走面深度（屏幕参数化）→ 世界 XZ 高度场（栅格化 + 最近邻补洞）。与轨迹台 `SceneGeometry._heightfield` 同式。"""
    h, w = ground.shape
    px = np.arange(w, dtype=np.float64)[None, :].repeat(h, 0)
    py = np.arange(h, dtype=np.float64)[:, None].repeat(w, 1)
    q = np.stack([(px - cal['cx']) / cal['ppu'], (cal['cy'] - py) / cal['ppu'], ground.astype(np.float64)], -1)
    pos = (q @ R.T) * wu_per_q
    X, Y, Z = pos[..., 0].ravel(), pos[..., 1].ravel(), pos[..., 2].ravel()
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
        _d, idx = distance_transform_edt(~has, return_distances=True, return_indices=True)
        hf = hf[idx[0], idx[1]]
    return {'hf': hf, 'x0': x0, 'z0': z0, 'dx': dx, 'dz': dz, 'n': n}


def _bilinear(field: np.ndarray, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    h, w = field.shape
    xi = np.clip(px, 0.0, w - 1.001)
    yi = np.clip(py, 0.0, h - 1.001)
    x0 = np.floor(xi).astype(np.int64)
    y0 = np.floor(yi).astype(np.int64)
    fx, fy = xi - x0, yi - y0
    return (field[y0, x0] * (1 - fx) * (1 - fy) + field[y0, x0 + 1] * fx * (1 - fy)
            + field[y0 + 1, x0] * (1 - fx) * fy + field[y0 + 1, x0 + 1] * fx * fy)


def hf_sample(hf: dict, X: np.ndarray, Z: np.ndarray) -> np.ndarray:
    return _bilinear(hf['hf'], (X - hf['x0']) / hf['dx'], (Z - hf['z0']) / hf['dz'])


def decode_height_png(path: Path, rng: float) -> np.ndarray:
    """`height_delta.png`（RG16 有符号，量程 ±rng，**网格单位**）→ float32。"""
    arr = np.asarray(Image.open(path).convert('RGB'), np.float32)
    return (((arr[..., 0] * 256.0 + arr[..., 1]) - 32768.0) / 32768.0 * rng).astype(np.float32)


def load_height_raster(sid: str, doc: dict, layers: dict | None = None) -> tuple[np.ndarray, GridMeta, float] | None:
    """高度增量栅格（网格单位；与 doc.grid 同网格）。``layers['height']`` 给了就用页面上那份（推给游戏）。"""
    if layers is not None and layers.get('height') is not None:
        arr = np.asarray(layers['height'], np.float32)
        grid = GridMeta.from_dict(doc['grid'])
        if arr.shape != (grid.grid_height, grid.grid_width):
            raise ValueError(f'高度层 {arr.shape[::-1]} ≠ 网格 {grid.grid_width}x{grid.grid_height}')
        return arr, grid, float(np.abs(arr).max())
    hgt = doc.get('height')
    if not hgt:
        return None
    p = terrain_dir(sid) / hgt['file']
    if not p.exists():
        return None
    rng = float(hgt.get('range', HEIGHT_RANGE_DEFAULT))
    delta = decode_height_png(p, rng)
    g = GridMeta.from_dict(hgt) if 'cell_size' in hgt else GridMeta.from_dict(doc['grid'])
    if delta.shape != (g.grid_height, g.grid_width):
        raise ValueError(f'{p} 尺寸 {delta.shape[::-1]} ≠ 声明 {g.grid_width}x{g.grid_height}')
    return delta, g, rng


def height_range_for(delta: np.ndarray) -> float:
    """存栅格用的量程：按内容定（±max·1.25），下限 `HEIGHT_RANGE_DEFAULT`；RG16 的分辨率 = 量程 / 32768。"""
    return float(max(HEIGHT_RANGE_DEFAULT, float(np.abs(delta).max()) * 1.25))


def encode_height_raster(delta: np.ndarray, rng: float) -> bytes:
    u = np.clip(np.round(np.asarray(delta, np.float64) / rng * 32768.0 + 32768.0), 0, 65535).astype(np.uint16)
    rg = np.zeros(delta.shape + (3,), np.uint8)
    rg[..., 0] = u >> 8
    rg[..., 1] = u & 0xFF
    return _png_bytes(Image.fromarray(rg))


def has_height_edits(sid: str, doc: dict, layers: dict | None = None) -> bool:
    if doc.get('heightOps'):
        return True
    r = load_height_raster(sid, doc, layers)
    return r is not None and bool(np.any(np.abs(r[0]) > 1e-9))


def polygon_edge_distance(X: np.ndarray, Z: np.ndarray, points: list) -> np.ndarray:
    """每个点到多边形**边**的最短距离（无符号，与输入同单位）。"""
    P = np.asarray(points, np.float64)
    n = len(P)
    best = np.full(X.shape, np.inf)
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        ab = b - a
        L2 = float(ab @ ab)
        if L2 < 1e-12:
            d2 = (X - a[0]) ** 2 + (Z - a[1]) ** 2
        else:
            tt = np.clip(((X - a[0]) * ab[0] + (Z - a[1]) * ab[1]) / L2, 0.0, 1.0)
            d2 = (X - (a[0] + tt * ab[0])) ** 2 + (Z - (a[1] + tt * ab[1])) ** 2
        best = np.minimum(best, d2)
    return np.sqrt(best)


def make_delta_fn(sid: str, doc: dict, hf: dict, grid: GridMeta, k: float = 1.0, layers: dict | None = None):
    """Δ 的求值器，**吃 wu 坐标、回 wu 高度**；文档里的一切（栅格 / 多边形 / 羽化 / 高度值）都是网格单位，
    这里按 ``k = wu / 网格单位`` 换算（碰撞网格是运行时 `isCollision` 里没乘 wu 的 M-world，见文件头）。

    栅格与各操作只准备一次——射线扫描要调它几百次，每次读盘是几十秒的差别。
    """
    r = load_height_raster(sid, doc, layers)
    ops = [(op, float(op.get('feather', 0) or 0)) for op in (doc.get('heightOps') or [])]
    k = float(k) if k else 1.0

    def delta_at(X_wu: np.ndarray, Z_wu: np.ndarray) -> np.ndarray:
        X = np.asarray(X_wu, np.float64) / k
        Z = np.asarray(Z_wu, np.float64) / k
        delta = np.zeros(X.shape, np.float64)                 # 网格单位
        if r is not None:
            arr, g, _rng = r
            px = (X - g.x_min) / g.cell_size - 0.5
            pz = (Z - g.z_min) / g.cell_size - 0.5
            ok = (px > -0.5) & (px < g.grid_width - 0.5) & (pz > -0.5) & (pz < g.grid_height - 0.5)
            delta[ok] = _bilinear(arr.astype(np.float64), px[ok], pz[ok])
        for op, feather in ops:
            inside = points_in_polygon(X, Z, op['points'])
            if not inside.any():
                continue
            if feather > 0:
                # 羽化：到多边形边的距离（解析、连续）→ 0..1 权重。⚠ 别用格子距离场：羽化只有两格宽时
                # 距离场只有两级台阶，抬出来的是梯田不是坡
                wgt = np.where(inside, np.clip(polygon_edge_distance(X, Z, op['points']) / feather, 0.0, 1.0), 0.0)
            else:
                wgt = inside.astype(np.float64)
            if op['kind'] == 'flatten':
                target = float(op['value']) - (hf_sample(hf, X_wu, Z_wu) / k + delta)
                delta = delta + target * wgt
            else:
                delta = delta + float(op['value']) * wgt
        return delta * k

    return delta_at


def height_delta_at(sid: str, doc: dict, hf: dict, X: np.ndarray, Z: np.ndarray, grid: GridMeta,
                    k: float = 1.0, layers: dict | None = None) -> np.ndarray:
    """Δ（wu）一次性求值，X / Z 是 wu（多次求值用 `make_delta_fn`）。"""
    return make_delta_fn(sid, doc, hf, grid, k, layers)(X, Z)


def compose_ground(sid: str, doc: dict, base: np.ndarray, frame: dict, layers: dict | None = None) -> np.ndarray:
    """基底行走面（屏幕参数化深度）⊕ Δ(x,z) → 新行走面。Δ 为 0 的像素原样返回。"""
    grid = GridMeta.from_dict(doc['grid'])
    R, k, cal = frame['R'], float(frame['wu_per_q']), frame['cal']
    h, w = base.shape
    hf = build_heightfield(base, cal, R, k)
    px = np.arange(w, dtype=np.float64)[None, :].repeat(h, 0)
    py = np.arange(h, dtype=np.float64)[:, None].repeat(w, 1)
    qx = (px - cal['cx']) / cal['ppu']
    qy = (cal['cy'] - py) / cal['ppu']
    t = base.astype(np.float64).copy()

    def world(tt):
        X = (R[0, 0] * qx + R[0, 1] * qy + R[0, 2] * tt) * k
        Y = (R[1, 0] * qx + R[1, 1] * qy + R[1, 2] * tt) * k
        Z = (R[2, 0] * qx + R[2, 1] * qy + R[2, 2] * tt) * k
        return X, Y, Z

    delta_at = make_delta_fn(sid, doc, hf, grid, k, layers)
    X, Y, Z = world(t)
    d0 = delta_at(X, Z)
    edit = np.abs(d0) > 1e-6
    if not edit.any():
        return base
    # 修补后的面可能有台阶(压平一块、抬高一块):沿射线**从前往后扫**，取第一次落到面下的位置
    # (= 最前面那张面,与"可见表面"同一取法;台阶的立面像素落在立面上),再二分收敛。
    # 牛顿法在台阶边缘会来回跳(实测)。扫描范围按 Δ 的量程定;
    # 要扫的像素 = 被修补像素及其邻域(射线斜着穿过修补区的那些)。
    dydt = abs(R[1, 2] * k)
    Xh, Zh = np.meshgrid(hf['x0'] + np.arange(hf['n']) * hf['dx'], hf['z0'] + np.arange(hf['n']) * hf['dz'])
    amp = float(max(np.abs(delta_at(Xh, Zh)).max(), np.abs(d0).max(), 1.0))
    rng_q = (amp * 1.25 + 2.0) / max(dydt, 1e-6)
    from scipy.ndimage import binary_dilation
    margin_px = int(math.ceil(rng_q * cal['ppu'])) + 2
    cand = binary_dilation(edit, np.ones((2 * margin_px + 1, 2 * margin_px + 1), bool))
    idx = np.nonzero(cand)
    qx_c, qy_c, t0 = qx[idx], qy[idx], t[idx]

    def surf_gap(tt, sel=None):
        sqx = qx_c if sel is None else qx_c[sel]
        sqy = qy_c if sel is None else qy_c[sel]
        Xc = (R[0, 0] * sqx + R[0, 1] * sqy + R[0, 2] * tt) * k
        Yc = (R[1, 0] * sqx + R[1, 1] * sqy + R[1, 2] * tt) * k
        Zc = (R[2, 0] * sqx + R[2, 1] * sqy + R[2, 2] * tt) * k
        return Yc - (hf_sample(hf, Xc, Zc) + delta_at(Xc, Zc))

    n_steps = 192
    n_bisect = 14
    lo = t0 - rng_q
    step = (2.0 * rng_q) / (n_steps - 1)
    t_hit = t0.copy()
    found = np.zeros(t0.shape, bool)
    prev_t = lo.copy()
    prev_g = surf_gap(lo)
    for i in range(1, n_steps):
        cur_t = lo + step * i
        g = surf_gap(cur_t)
        cross = ~found & (prev_g > 0) & (g <= 0)
        if cross.any():
            a, b = prev_t[cross], cur_t[cross]
            for _ in range(n_bisect):
                m = 0.5 * (a + b)
                above = surf_gap(m, cross) > 0
                a = np.where(above, m, a)
                b = np.where(above, b, m)
            t_hit[cross] = 0.5 * (a + b)
            found |= cross
        prev_t, prev_g = cur_t, g
        if found.all():
            break
    out = base.astype(np.float32).copy()
    # 只写回真的变了的:没扫到交点的保持基底;交点仍在原处(差异只是二分的分辨率)的也不写——
    # 不然 Δ 为 0 的邻域像素会被改掉最后几位,"别处一个像素都不动"就不成立了
    tol = max(8.0 * step / (2 ** n_bisect), 1e-6)
    changed = found & (np.abs(t_hit - t0) > tol)
    out[idx[0][changed], idx[1][changed]] = t_hit[changed].astype(np.float32)
    return out


def write_ground(bake_dir: Path, ground: np.ndarray, out_dir: Path | None = None) -> dict:
    """写 `ground_d.png`；缺省改运行时目录里的 lighting.json.ground_d，预览目录则写 `ground_d.json`。"""
    png, lo, hi = encode_ground(ground)
    if out_dir is None:
        _awrite(bake_dir / 'ground_d.png', png)
        lj = bake_dir / 'lighting.json'
        meta = json.loads(lj.read_text(encoding='utf-8'))
        meta['ground_d'] = {'min': lo, 'max': hi}
        _awrite(lj, (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
    else:
        _awrite(out_dir / 'ground_d.png', png)
        _awrite_json(out_dir / 'ground_d.json', {'min': lo, 'max': hi,
                                                 'work': {'w': int(ground.shape[1]), 'h': int(ground.shape[0])}})
    return {'min': lo, 'max': hi, 'sha1': _sha1(png)}


def export_ground(sid: str, doc: dict | None = None, out_dir: Path | None = None,
                  layers: dict | None = None) -> list[dict]:
    """每个时段目录：基底 ⊕ Δ → ground_d。没有修补时 ground_d 逐字节等于基底。"""
    doc = load_terrain(sid) if doc is None else doc
    rows = []
    for bd in scene_bake_dirs(sid):
        ensure_ground_base(bd)
        meta = json.loads((bd / 'lighting.json').read_text(encoding='utf-8'))
        gb = meta.get('ground_base') or meta['ground_d']
        base_png = (bd / GROUND_BASE_FILE).read_bytes()
        dest_dir = (out_dir / 'ground' / bd.name) if out_dir is not None else None
        if not has_height_edits(sid, doc, layers):
            if dest_dir is None:
                if (bd / 'ground_d.png').read_bytes() != base_png:
                    _awrite(bd / 'ground_d.png', base_png)
                    meta['ground_d'] = {'min': gb['min'], 'max': gb['max']}
                    _awrite(bd / 'lighting.json', (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
            else:
                _awrite(dest_dir / 'ground_d.png', base_png)
                _awrite_json(dest_dir / 'ground_d.json', {'min': gb['min'], 'max': gb['max'],
                                                          'work': {'w': int(meta['work']['w']), 'h': int(meta['work']['h'])}})
            rows.append({'dir': bd.name, 'edited': False})
            continue
        base = decode_ground_png(bd / GROUND_BASE_FILE, float(gb['min']), float(gb['max']))
        frame = scene_frame(sid, bd)
        composed = compose_ground(sid, doc, base, frame, layers)
        info = write_ground(bd, composed, dest_dir)
        rows.append({'dir': bd.name, 'edited': True, **info})
    return rows


# ---------------------------------------------------------------- 总出口
def export_terrain(sid: str, doc: dict | None = None, out_dir: Path | None = None,
                   collision_map: str | None = None, layers: dict | None = None) -> dict:
    """合成 + 落盘。`out_dir` 给了就是「推给游戏」的预览目录（资源一个字节不动），否则写资源。"""
    doc = load_terrain(sid) if doc is None else doc
    if collision_map is None:
        data = json.loads((SCENES_JSON / f'{sid}.json').read_text(encoding='utf-8'))
        collision_map = ((data.get('depthConfig') or {}).get('collision_map')) or 'collision.png'
    blocked, src, grid = compose_collision(sid, doc, layers)
    prov = {'terrain_sha1': _sha1(json.dumps(doc, ensure_ascii=False, sort_keys=True).encode('utf-8')),
            'regions': len(doc.get('regions') or []),
            'auto_sha1': (doc.get('auto') or {}).get('sha1')}
    meta = write_collision(sid, blocked, grid, out_dir, collision_map, prov)
    ground = export_ground(sid, doc, out_dir, layers)
    return {'collision': meta, 'blocked_pct': float(blocked.mean() * 100.0), 'ground': ground,
            'grid': grid.to_dict()}


def source_names() -> dict[int, str]:
    return {SRC_AUTO_WALK: '自动·可走', SRC_AUTO_BLOCK: '自动·阻挡', SRC_BRUSH_WALK: '笔刷·可走',
            SRC_BRUSH_BLOCK: '笔刷·阻挡', SRC_REGION_WALK: '多边形·可走', SRC_REGION_BLOCK: '多边形·阻挡',
            SRC_OUTSIDE: '自动网格外（按可走）'}
