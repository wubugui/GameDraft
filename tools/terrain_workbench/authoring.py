# -*- coding: utf-8 -*-
"""地形工作台的作者面逻辑（服务端）。

## 数据（全在 `terrain_compose` 定义的那几层，这里不另起格式）

- 页面上的**工作态** `state = {doc, brush, height}`：`doc` 就是 `terrain.json` 的内容；`brush` / `height` 是与 `doc.grid`
  同网格的两张栅格，走 HTTP 时 base64（brush = u8，height = f32 小端）。文档里的一切坐标都是**网格单位**
  （见 `terrain_compose` 文件头），页面按 wu 显示。
- **保存** = 写作者层（`terrain/terrain.json` + `walk_brush.png` + `height_delta.png`）+ 留一份历史；**不写**游戏读的产物。
- **推给游戏** = 页面此刻的工作态（存没存都算）合成进 `local/terrain_preview/<场景>/`，让在跑的游戏原地换上；资源不动。
- **导出到游戏** = 盘上的作者层合成进资源（`collision.png` / `collision.json` / 各时段 `ground_d.png`），让游戏换回资源。

三条都经 `terrain_compose.export_terrain`——没有第二份合成逻辑。

## 与游戏的槽

`/__gamedraft-api/runtime-terrain`（`src/dev/runtimeTerrainApiPlugin.ts`）：一行 `{rev, sceneId, source, ts}` +
可选的 `probe`（工作台请游戏用**它自己的** `isCollision` 判几个点，回 0/1 串——这是运行时对齐的真判据，
不是页面里再抄一份公式）。路径 / 预览目录 / 文件名 Python 与 TS 各写一份，`tests/test_terrain_workbench.py` 对着断言。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(ROOT))

from tools.atomic_io import retry_transient                                  # noqa: E402
from tools.character_lighting_lab import terrain_compose as tc               # noqa: E402
from tools.character_lighting_lab.scene_geometry import bake_key             # noqa: E402

#: 推给游戏的预览落哪儿（gitignore 的 local/，不归 DVC、不在 public 下所以打包抽不到）；
#: TS 侧 `RUNTIME_TERRAIN_PREVIEW_DIR` 与它对齐（测试断言）
PREVIEW_ROOT = ROOT / "local" / "terrain_preview"
#: 本地草稿（页面每几秒存一次没保存的工作态）：桌面壳是纯内存 profile，不能放 localStorage
DRAFT_ROOT = ROOT / "local" / "terrain_drafts"
DRAFT_MAX_BYTES = 64 * 1024 * 1024
#: 作者层历史（每次保存前留一份；本机撤销记录，.dvcignore 排掉）
HISTORY_DIR = "history"
HISTORY_KEEP = 20
#: 游戏 dev server 上的槽（与 TS 侧 `RUNTIME_TERRAIN_API` 同一字面量）
SLOT_PATH = "/__gamedraft-api/runtime-terrain"
#: 预览目录里游戏会来要的文件（TS 侧 `TERRAIN_PREVIEW_FILES` 同一份名单）
PREVIEW_FILES = ("collision.png", "collision.json", "ground_d.png", "ground_d.json")
WRITER = "terrain_workbench"
#: 探测顺序：devstate 里记的那个优先，再试 launch.json 里列过的几个常用 dev 端口（草木台同款）
_PROBE_PORTS = (5173, 5178, 5174, 5180, 5188)
GAME_PAGE_FRESH_MS = 4000


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def safe_sid(sid: object) -> str:
    """场景 id 要拼进路径（还要整目录删预览）：`..` / 分隔符 / 盘符一律拒。"""
    s = str(sid or "")
    if not s or s in (".", "..") or any(c in s for c in '/\\:*?"<>|\x00'):
        raise ValueError(f"场景不合法：{sid!r}")
    if not (tc.SCENES_JSON / f"{s}.json").is_file():
        raise ValueError(f"场景不存在：{s}")
    return s


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _rel(p: Path) -> str:
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def _unb64(s: str, dtype, shape: tuple[int, int]) -> np.ndarray:
    raw = base64.b64decode(s)
    arr = np.frombuffer(raw, dtype=dtype)
    if arr.size != shape[0] * shape[1]:
        raise ValueError(f"栅格字节数不对：{arr.size} ≠ {shape[0]}×{shape[1]}")
    return arr.reshape(shape).copy()


def doc_sha1(doc: dict) -> str:
    return tc._sha1(json.dumps(doc, ensure_ascii=False, sort_keys=True).encode("utf-8"))


def scene_json(sid: str) -> dict:
    return json.loads((tc.SCENES_JSON / f"{sid}.json").read_text(encoding="utf-8"))


def primary_background(data: dict) -> str:
    bgs = data.get("backgrounds") or []
    return (bgs[0].get("image") if bgs and isinstance(bgs[0], dict) else None) or "background.png"


# ---------------------------------------------------------------------------
# 场景清单 / 描述
# ---------------------------------------------------------------------------
def scenes() -> list[dict]:
    """全部场景 + 地形状态（有没有深度 / 网格 / 自动结果 / 作者层改了什么 / 待导出）。"""
    out: list[dict] = []
    for j in sorted(tc.SCENES_JSON.glob("*.json")):
        data = _read_json(j)
        if not isinstance(data, dict):
            continue
        sid = j.stem
        cfg = data.get("depthConfig") or {}
        depth_ok = bool(cfg) and (tc.SCENES_RT / sid / cfg.get("depth_map", "raw_depth_rg.png")).exists()
        row: dict = {"id": sid, "name": data.get("name") or sid, "depth": depth_ok}
        try:
            doc = tc.load_terrain(sid)
            row["docErr"] = ""
        except ValueError as e:
            doc = tc.default_terrain()
            row["docErr"] = str(e)
        gm = tc.load_collision_meta(sid, cfg)
        row["grid"] = gm.to_dict() if gm else None
        row["auto"] = bool(doc.get("auto"))
        row["regions"] = len(doc.get("regions") or [])
        row["heightOps"] = len(doc.get("heightOps") or [])
        row["brush"] = bool(doc.get("brush"))
        row["height"] = bool(doc.get("height"))
        row["needsExport"] = needs_export(sid, doc) if depth_ok and doc.get("grid") else False
        row["draft"] = (DRAFT_ROOT / f"{sid}.json").is_file()
        out.append(row)
    return out


def marks_for(sid: str, geom) -> list[dict]:
    """作者要看的点：出生点（含命名出生点）、出口热点、跨点的落点 / 站位、NPC。画面点 + 脚下世界点（wu）。"""
    data = scene_json(sid)
    rows: list[dict] = []

    def add(kind: str, mid: str, x: float, y: float, extra: dict | None = None) -> None:
        if not geom.has_depth:
            return
        try:
            w = geom.scene_to_world_ground(float(x), float(y))
        except Exception:  # noqa: BLE001 — 单个点坏了不拖垮整份
            return
        rows.append({"kind": kind, "id": mid, "scene": [float(x), float(y)],
                     "world": [float(w[0]), float(w[1]), float(w[2])], **(extra or {})})

    sp = data.get("spawnPoint")
    if isinstance(sp, dict):
        add("spawn", "spawnPoint", sp.get("x", 0), sp.get("y", 0))
    for key, v in (data.get("spawnPoints") or {}).items():
        if isinstance(v, dict):
            add("spawn", f"spawnPoints[{key}]", v.get("x", 0), v.get("y", 0))
    for hs in data.get("hotspots") or []:
        if not isinstance(hs, dict):
            continue
        rng = float(hs.get("interactionRange") or 50)
        if hs.get("type") == "transition":
            add("exit", str(hs.get("id") or "?"), hs.get("x", 0), hs.get("y", 0), {"range": max(rng, 60.0)})
        elif hs.get("type") == "act_spot":
            d = hs.get("data") or {}
            al, ld = d.get("align"), d.get("landing")
            if isinstance(al, dict):
                add("align", f"{hs.get('id')} 站位", al.get("x", 0), al.get("y", 0), {"range": max(rng, 60.0)})
            if isinstance(ld, dict):
                add("landing", f"{hs.get('id')} 落点", ld.get("x", 0), ld.get("y", 0))
    for n in data.get("npcs") or []:
        if isinstance(n, dict):
            add("npc", str(n.get("id") or "?"), n.get("x", 0), n.get("y", 0))
    return rows


def scene_summary(sid: str, bg: str | None) -> dict:
    """轨迹工作台的场景描述（标定 / 尺寸）+ 地形要的：标记点、网格、时段目录清单、grid 单位换算。"""
    from tools.trajectory_workbench.serve import get_geometry
    sid = safe_sid(sid)
    g = get_geometry(sid, bg)
    s = g.summary()
    s["marks"] = marks_for(sid, g)
    data = scene_json(sid)
    cfg = data.get("depthConfig") or {}
    gm = tc.load_collision_meta(sid, cfg)
    s["grid"] = gm.to_dict() if gm else None
    s["collisionMap"] = cfg.get("collision_map") or "collision.png"
    s["bakeDirs"] = [d.name for d in tc.scene_bake_dirs(sid)]
    s["primaryBakeKey"] = bake_key(primary_background(data))
    return s


# ---------------------------------------------------------------------------
# 工作态 ↔ 作者层
# ---------------------------------------------------------------------------
def layer_state(sid: str) -> dict:
    """盘上的作者层 → 页面工作态（+ 自动结果 + 磁盘产物状态）。"""
    sid = safe_sid(sid)
    doc = tc.load_terrain(sid)
    out: dict = {"doc": doc, "brush": None, "height": None, "auto": None, "disk": disk_state(sid, doc)}
    if not doc.get("grid"):
        return out
    grid = tc.GridMeta.from_dict(doc["grid"])
    brush = tc.load_brush(sid, doc, grid)
    if brush.any():
        out["brush"] = _b64(brush.astype(np.uint8))
    hr = tc.load_height_raster(sid, doc)
    if hr is not None:
        arr, hg, _rng = hr
        if not hg.same(grid):
            arr = tc.resample_nearest(arr.astype(np.float32), hg, grid, 0).astype(np.float32)
        if np.any(np.abs(arr) > 1e-9):
            out["height"] = _b64(arr.astype("<f4"))
    auto = tc.load_auto(sid, doc)
    if auto is not None:
        a_blocked, a_grid = auto
        out["auto"] = {"grid": a_grid.to_dict(), "data": _b64(np.where(a_blocked, 1, 0).astype(np.uint8)),
                       "bakedAt": (doc.get("auto") or {}).get("baked_at")}
    return out


def decode_state(sid: str, state: object) -> tuple[dict, dict]:
    """页面工作态 → (doc, layers)；形状闸门在这里（保存 / 合成 / 推送同一道）。"""
    if not isinstance(state, dict) or not isinstance(state.get("doc"), dict):
        raise ValueError("工作态要是 {doc, brush?, height?}")
    doc = json.loads(json.dumps(state["doc"]))          # 不改调用方那份
    problems = tc.terrain_problems(doc)
    if problems:
        raise ValueError("terrain.json 形状不合法：" + "；".join(problems))
    if not doc.get("grid"):
        raise ValueError("作者层还没有网格（先让烘焙器导出一次深度）")
    grid = tc.GridMeta.from_dict(doc["grid"])
    shape = (grid.grid_height, grid.grid_width)
    layers: dict = {"brush": None, "height": None}
    b = state.get("brush")
    if b:
        arr = _unb64(str(b), np.uint8, shape)
        if int(arr.max()) > tc.BRUSH_BLOCK:
            raise ValueError("笔刷层只能是 0 / 1 / 2")
        layers["brush"] = arr
    hgt = state.get("height")
    if hgt:
        arr = _unb64(str(hgt), "<f4", shape).astype(np.float32)
        if not np.all(np.isfinite(arr)):
            raise ValueError("高度层里有非数")
        layers["height"] = arr
    # 页面不该动这两个引用块；一律按盘上 / 保存结果重算（避免页面带来的旧 sha1 / 旧网格）
    return doc, layers


def compose(sid: str, state: object) -> dict:
    """服务端合成（真相）：blocked / source 两张栅格 + 统计。页面本地也算一份，自检对着这一份断言。"""
    sid = safe_sid(sid)
    doc, layers = decode_state(sid, state)
    blocked, src, grid = tc.compose_collision(sid, doc, layers)
    return {"grid": grid.to_dict(), "blocked": _b64(np.where(blocked, 1, 0).astype(np.uint8)), "src": _b64(src),
            "blockedPct": float(blocked.mean() * 100.0), "cells": int(blocked.size)}


def validate(sid: str, state: object) -> dict:
    """形状闸门 + 连通性（按工作态合成后的碰撞走运行时那条反投影链）。"""
    sid = safe_sid(sid)
    try:
        doc, layers = decode_state(sid, state)
    except ValueError as e:
        return {"ok": True, "problems": [str(e)], "reach": []}
    blocked, _src, grid = tc.compose_collision(sid, doc, layers)
    return {"ok": True, "problems": [], "reach": reach_issues_for(sid, blocked, grid)}


def reach_issues_for(sid: str, blocked: np.ndarray, grid: tc.GridMeta) -> list[str]:
    """连通性判据与 `audit_walkable.reach_issues` 同一份数学，只是碰撞来自内存里的合成结果。"""
    from tools.character_lighting_lab import audit_walkable as aw
    import tempfile
    data = scene_json(sid)
    cfg = data.get("depthConfig")
    if not cfg:
        return []
    # audit_walkable 从磁盘读碰撞：把合成结果落到临时目录、把它的 RUNTIME 指过去（只有 collision 两个文件 + 照明 json 借真目录）
    tmp = Path(tempfile.mkdtemp(prefix="terrain_reach_"))
    try:
        sdir = tmp / sid
        sdir.mkdir(parents=True)
        name = cfg.get("collision_map", "collision.png")
        tc.write_u8_png(sdir / name, np.where(blocked, 255, 0).astype(np.uint8))
        tc._awrite_json(sdir / tc.SIDECAR_FILE, {"version": tc.SIDECAR_VERSION, "collision_map": name, **grid.to_dict()})
        bd = tc.SCENES_RT / sid / "lighting" / bake_key(primary_background(data))
        for f in ("lighting.json", "ground_d.png"):
            if (bd / f).exists():
                (sdir / "lighting" / bd.name).mkdir(parents=True, exist_ok=True)
                shutil.copyfile(bd / f, sdir / "lighting" / bd.name / f)
        bg = tc.SCENES_RT / sid / "background.png"
        if bg.exists():
            try:
                os.symlink(bg, sdir / "background.png")
            except OSError:
                shutil.copyfile(bg, sdir / "background.png")
        old = aw.RUNTIME
        aw.RUNTIME = tmp
        try:
            return aw.reach_issues(tc.SCENES_JSON / f"{sid}.json")
        finally:
            aw.RUNTIME = old
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def disk_state(sid: str, doc: dict | None = None) -> dict:
    """磁盘上游戏读的产物状态：旁挂 / 位图尺寸 / 上次导出对应的作者层指纹 / 待导出。"""
    doc = tc.load_terrain(sid) if doc is None else doc
    side = _read_json(tc.sidecar_path(sid))
    png = tc.SCENES_RT / sid / ((side or {}).get("collision_map") or "collision.png")
    size = None
    if png.exists():
        from PIL import Image
        size = list(Image.open(png).size)
    return {"sidecar": side, "pngSize": size, "needsExport": needs_export(sid, doc) if doc.get("grid") else False,
            "updated": doc.get("updated")}


def needs_export(sid: str, doc: dict | None = None) -> bool:
    """作者层与上次导出对不上（旁挂里记的 terrain_sha1 ≠ 现在的）或产物根本没有。"""
    doc = tc.load_terrain(sid) if doc is None else doc
    side = _read_json(tc.sidecar_path(sid))
    if not side or not (tc.SCENES_RT / sid / (side.get("collision_map") or "collision.png")).exists():
        return True
    got = (side.get("composed") or {}).get("terrain_sha1")
    if not got:
        # 迁移落的旁挂没有指纹：只有作者真改过什么才算待导出
        return bool(doc.get("brush") or doc.get("regions") or doc.get("heightOps") or doc.get("height"))
    return got != doc_sha1(doc)


# ---------------------------------------------------------------------------
# 保存 / 历史 / 草稿
# ---------------------------------------------------------------------------
def keep_history(sid: str, protect: Path | None = None) -> str | None:
    """保存前把当前作者层整套（json + 两张栅格）拷进 `terrain/history/<时间>/`；最多留 HISTORY_KEEP 份。"""
    td = tc.terrain_dir(sid)
    if not (td / tc.TERRAIN_JSON).exists():
        return None
    hd = td / HISTORY_DIR
    name = time.strftime("%Y%m%d-%H%M%S")
    dest = hd / name
    n = 1
    while dest.exists():
        n += 1
        dest = hd / f"{name}_{n}"
    dest.mkdir(parents=True, exist_ok=True)
    for f in (tc.TERRAIN_JSON, tc.BRUSH_FILE, tc.HEIGHT_FILE):
        if (td / f).exists():
            shutil.copyfile(td / f, dest / f)
    olds = sorted([p for p in hd.iterdir() if p.is_dir()], key=lambda p: p.name)
    for p in olds[:-HISTORY_KEEP]:
        if protect is not None and p.resolve() == protect.resolve():
            continue
        shutil.rmtree(p, ignore_errors=True)
    return dest.name


def history(sid: str) -> list[dict]:
    sid = safe_sid(sid)
    hd = tc.terrain_dir(sid) / HISTORY_DIR
    if not hd.is_dir():
        return []
    rows = []
    for p in sorted([q for q in hd.iterdir() if q.is_dir()], key=lambda q: q.name, reverse=True):
        d = _read_json(p / tc.TERRAIN_JSON) or {}
        rows.append({"name": p.name, "updated": d.get("updated"), "regions": len(d.get("regions") or []),
                     "heightOps": len(d.get("heightOps") or []), "brush": (p / tc.BRUSH_FILE).exists(),
                     "height": (p / tc.HEIGHT_FILE).exists()})
    return rows


def restore(sid: str, name: str) -> dict:
    """恢复某一份历史（恢复前当前这份也进历史，所以恢复本身可撤）。`name` 必须是历史目录里的纯目录名。"""
    sid = safe_sid(sid)
    if not name or Path(name).name != name or name in (".", ".."):
        return {"ok": False, "err": f"历史名不合法：{name!r}"}
    src = tc.terrain_dir(sid) / HISTORY_DIR / name
    if not src.is_dir() or not (src / tc.TERRAIN_JSON).is_file():
        return {"ok": False, "err": f"没有这一份历史：{name}"}
    files = {f: (src / f).read_bytes() for f in (tc.TERRAIN_JSON, tc.BRUSH_FILE, tc.HEIGHT_FILE) if (src / f).exists()}
    keep_history(sid, protect=src)
    td = tc.terrain_dir(sid)
    for f in (tc.BRUSH_FILE, tc.HEIGHT_FILE):
        if f not in files and (td / f).exists():
            retry_transient(os.unlink, td / f)
    for f, data in files.items():
        tc._awrite(td / f, data)
    return {"ok": True, "restored": name, "state": layer_state(sid)}


def save(sid: str, state: object, base_updated: str | None = None, force: bool = False) -> dict:
    """写作者层。乐观并发：页面装载时看到的 `updated` ≠ 盘上现在的 ⇒ 拒（别的进程改过），带 force 才盖。"""
    sid = safe_sid(sid)
    doc, layers = decode_state(sid, state)
    cur = tc.load_terrain(sid)
    if not force and base_updated is not None and cur.get("updated") and cur.get("updated") != base_updated:
        return {"ok": False, "err": f"盘上的作者层在 {cur.get('updated')} 被别处改过（你装的是 {base_updated}）——"
                                    f"重新打开场景再改，或带 force 覆盖", "conflict": True, "updated": cur.get("updated")}
    grid = tc.GridMeta.from_dict(doc["grid"])
    # 自动结果块归烘焙器；页面带来的一律换成盘上的那份
    doc["auto"] = cur.get("auto")
    td = tc.terrain_dir(sid)
    keep_history(sid)
    brush = layers.get("brush")
    if brush is not None and brush.any():
        data = tc.write_u8_png(td / tc.BRUSH_FILE, brush)
        doc["brush"] = {"file": tc.BRUSH_FILE, **grid.to_dict(), "sha1": tc._sha1(data)}
    else:
        doc["brush"] = None
        if (td / tc.BRUSH_FILE).exists():
            retry_transient(os.unlink, td / tc.BRUSH_FILE)
    hgt = layers.get("height")
    if hgt is not None and np.any(np.abs(hgt) > 1e-9):
        rng = tc.height_range_for(hgt)
        data = tc.encode_height_raster(hgt, rng)
        tc._awrite(td / tc.HEIGHT_FILE, data)
        doc["height"] = {"file": tc.HEIGHT_FILE, **grid.to_dict(), "range": rng, "sha1": tc._sha1(data)}
    else:
        doc["height"] = None
        if (td / tc.HEIGHT_FILE).exists():
            retry_transient(os.unlink, td / tc.HEIGHT_FILE)
    tc.save_terrain(sid, doc)
    saved = tc.load_terrain(sid)
    return {"ok": True, "updated": saved.get("updated"), "path": _rel(td / tc.TERRAIN_JSON),
            "needsExport": needs_export(sid, saved), "doc": saved}


def _draft_path(sid: str) -> Path:
    return DRAFT_ROOT / f"{safe_sid(sid)}.json"


def draft_get(sid: str) -> dict | None:
    d = _read_json(_draft_path(sid))
    return d if isinstance(d, dict) else None


def draft_put(sid: str, draft: object) -> dict:
    if not isinstance(draft, dict):
        raise ValueError("草稿要是对象")
    raw = json.dumps(draft, ensure_ascii=False).encode("utf-8")
    if len(raw) > DRAFT_MAX_BYTES:
        raise ValueError(f"草稿太大（{len(raw) // 1024 // 1024} MB），没存")
    p = _draft_path(sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_bytes(raw)
    retry_transient(os.replace, tmp, p)
    return {"ok": True, "bytes": len(raw)}


def draft_clear(sid: str) -> dict:
    p = _draft_path(sid)
    if p.is_file():
        retry_transient(os.unlink, p)
        return {"ok": True, "cleared": True}
    return {"ok": True, "cleared": False}


# ---------------------------------------------------------------------------
# 与游戏
# ---------------------------------------------------------------------------
_GAME_BASE: list[str] = []


def _slot_get(base: str, timeout: float = 0.6) -> dict | None:
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(base.rstrip("/") + SLOT_PATH, timeout=timeout) as r:   # noqa: S310 — 本机 dev server
            if r.status != 200:
                return None
            return json.loads(r.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def find_game() -> str:
    """找在跑的游戏 dev server：按槽是否应答实探（devstate 常常是别的端口，草木台踩过）。"""
    from tools.acoustic_workbench import game_link
    if _GAME_BASE and _slot_get(_GAME_BASE[0], 0.4) is not None:
        return _GAME_BASE[0]
    _GAME_BASE.clear()
    cands: list[str] = []
    try:
        d = game_link.discover_game_url(ROOT)
        if d:
            cands.append(d)
    except Exception:  # noqa: BLE001
        pass
    cands += [f"http://127.0.0.1:{p}" for p in _PROBE_PORTS]
    seen: set[str] = set()
    for c in cands:
        c = c.rstrip("/")
        if c in seen:
            continue
        seen.add(c)
        if _slot_get(c, 0.4) is not None:
            _GAME_BASE.append(c)
            return c
    return ""


def page_alive(game: object) -> bool:
    return isinstance(game, dict) and isinstance(game.get("ageMs"), (int, float)) and game["ageMs"] < GAME_PAGE_FRESH_MS


def page_busy(game: object) -> bool:
    return page_alive(game) and game.get("loading") is True            # type: ignore[union-attr]


def link_status() -> dict:
    """游戏在不在、在哪个场景、正在装场景吗、它回的探测结果（运行时对齐用）。"""
    base = find_game()
    got = _slot_get(base) if base else None
    game = got.get("game") if isinstance(got, dict) and isinstance(got.get("game"), dict) else None
    return {"game": base, "alive": bool(base), "page": game, "pageAlive": page_alive(game), "pageBusy": page_busy(game),
            "doc": got.get("doc") if isinstance(got, dict) else None,
            "status": got.get("status") if isinstance(got, dict) else None}


def _slot_post(base: str, body: dict, timeout: float = 2.5) -> dict:
    import urllib.request
    req = urllib.request.Request(base.rstrip("/") + SLOT_PATH, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:                                   # noqa: S310
        return json.loads(r.read().decode("utf-8") or "{}")


def push_to_game(sid: str, source: str) -> dict:
    """告诉在跑的游戏"这个场景的地形变了"：一行 rev + 来源（preview = 从预览目录装，export = 从资源装）。游戏没开不算错。"""
    import urllib.error
    if source not in ("preview", "export"):
        raise ValueError(f"source 只能是 preview / export：{source!r}")
    base = find_game()
    if not base:
        return {"pushed": False, "why": "没找到在跑的游戏（试过 devstate 与 5173/5178/5174/5180/5188）"}
    try:
        got = _slot_post(base, {"sceneId": sid, "writer": WRITER, "source": source})
        game = got.get("game") if isinstance(got.get("game"), dict) else None
        return {"pushed": True, "rev": got.get("rev"), "url": base, "game": game,
                "pageAlive": page_alive(game), "inScene": page_alive(game) and game.get("sceneId") == sid,
                "pageBusy": page_busy(game)}
    except (urllib.error.URLError, OSError, ValueError) as e:
        _GAME_BASE.clear()
        return {"pushed": False, "why": f"{type(e).__name__}: {e}", "url": base}


def push_note(push: dict, sid: str) -> str:
    if not push.get("pushed"):
        return "没送到游戏：%s" % push.get("why")
    rev = push.get("rev")
    game = push.get("game")
    if push.get("inScene"):
        return f"游戏已收到，正在原地换上（第 {rev} 次）"
    if push.get("pageBusy"):
        return f"游戏页正在装场景：装好进到 {sid} 就是这份（第 {rev} 次）"
    if push.get("pageAlive"):
        return f"游戏现在在「{(game or {}).get('sceneId')}」：进到 {sid} 就是这份（第 {rev} 次）"
    return f"dev server 收下了（第 {rev} 次），但没有游戏页开着——开了游戏进 {sid} 再推一次"


_PROBE_SEQ = [0]


def probe_request(sid: str, points: list) -> dict:
    """请游戏用它自己的 `isCollision` 判这些画面点（≤ 256 个）；结果稍后从 `link_status().status` 里读。"""
    import urllib.error
    sid = safe_sid(sid)
    pts = [[float(p[0]), float(p[1])] for p in points if isinstance(p, (list, tuple)) and len(p) == 2][:256]
    base = find_game()
    if not base:
        return {"ok": False, "err": "游戏没在跑"}
    _PROBE_SEQ[0] += 1
    try:
        got = _slot_post(base, {"sceneId": sid, "writer": WRITER, "probeOnly": True,
                                "probe": {"seq": _PROBE_SEQ[0], "sceneId": sid, "points": pts}})
        return {"ok": True, "seq": _PROBE_SEQ[0], "game": got.get("game")}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}"}


def enqueue_switch_scene_via_game(base: str, sid: str) -> dict:
    """经在跑的 dev server 排一条切场景命令（带时间戳、会过期；不直接写队列文件——草木台文档里那条坑）。"""
    import urllib.error
    import urllib.request
    from tools.production_workbench.runtime_command import new_runtime_command
    from tools.sway_workbench.layers import RUNTIME_COMMAND_API
    url = base.rstrip("/") + RUNTIME_COMMAND_API
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:                                    # noqa: S310
            got = json.loads(r.read().decode("utf-8") or "{}")
        cur = got.get("commands") if isinstance(got, dict) and isinstance(got.get("commands"), list) else []
        cmd = new_runtime_command("debugSwitchScene", reason="terrain-workbench: 切到正在编辑的场景",
                                  payload={"sceneId": sid})
        body = json.dumps({"commands": [*cur, cmd]}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2.5) as r:                                    # noqa: S310
            back = json.loads(r.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"ok": False, "detail": f"排不进 dev server 的命令队列：{type(e).__name__}: {e}"}
    if not (isinstance(back, dict) and back.get("ok")):
        return {"ok": False, "detail": f"dev server 没收下切场景命令：{back!r}"[:300]}
    return {"ok": True, "detail": f"已排进 {base} 的命令队列（过一会儿没人取就自动过期）"}


def open_in_game(sid: str) -> dict:
    """让游戏切到这个场景：控制台在就让它拉起 / 切；没有就经 dev server 排命令；都没有就说清楚。"""
    from tools.acoustic_workbench import game_link
    sid = safe_sid(sid)
    ok, msg = game_link.console_open_dev_entry(sid)
    if ok:
        return {"ok": True, "via": "console", "detail": msg}
    base = find_game()
    if not base:
        return {"ok": True, "via": "none", "console": msg, "detail": "dev server 也没在跑，没排切场景命令"}
    q = enqueue_switch_scene_via_game(base, sid)
    return {"ok": True, "via": "queue" if q["ok"] else "none", "console": msg, "detail": q["detail"], "game": base}


# ---------------------------------------------------------------------------
# 推给游戏 / 导出到游戏（后台线程 + 状态轮询）
# ---------------------------------------------------------------------------
_JOB: dict = {"running": False, "kind": "", "scene": "", "log": [], "done": False, "succeeded": False, "err": "",
              "started": 0.0}
_JOB_NAMES = {"push": "推给游戏", "export": "导出到游戏"}
_JOB_LOCK = threading.Lock()


def job_status() -> dict:
    b = dict(_JOB)
    b["log"] = list(_JOB["log"])
    b["elapsed"] = round(time.time() - _JOB["started"], 1) if _JOB["started"] else 0.0
    return b


def preview_root(sid: str) -> Path:
    return PREVIEW_ROOT / safe_sid(sid)


def _start_job(kind: str, sid: str, work, source: str) -> dict:
    if _JOB["running"]:
        return {"ok": False, "err": f"正在{_JOB_NAMES.get(_JOB['kind'], '合成')} {_JOB['scene']}，等它跑完", "busy": True}
    _JOB.clear()
    _JOB.update({"running": True, "kind": kind, "scene": sid, "log": [], "done": False, "succeeded": False,
                 "err": "", "started": time.time()})

    def run() -> None:
        try:
            with _JOB_LOCK:
                result = work(lambda m: _JOB["log"].append(str(m)))
            _JOB["result"] = result
            _JOB["succeeded"] = True
        except Exception as e:                               # noqa: BLE001 — 失败原文回前端
            _JOB["succeeded"] = False
            _JOB["err"] = f"{type(e).__name__}: {e}"
            _JOB["done"] = True
            _JOB["running"] = False
            return
        if kind == "export":
            drop_preview_after_export(sid, lambda m: _JOB["log"].append(str(m)))
        # 通知游戏单独一个 try：送不到不影响合成的成败（产物已经落盘了）
        try:
            push = push_to_game(sid, source)
            _JOB["push"] = push
            _JOB["log"].append(push_note(push, sid))
        except Exception as e:                               # noqa: BLE001
            _JOB["push"] = {"pushed": False, "why": f"{type(e).__name__}: {e}"}
            _JOB["log"].append(f"没送到游戏：{type(e).__name__}: {e}（已经合成好了，游戏里重进一次场景也能看到）")
        finally:
            _JOB["done"] = True
            _JOB["running"] = False

    threading.Thread(target=run, daemon=True, name=f"terrain-{kind}").start()
    return {"ok": True, "started": True}


def push_start(sid: str, state: object) -> dict:
    """推给游戏：页面此刻的工作态合成进预览目录；资源一个字节不动。"""
    sid = safe_sid(sid)
    doc, layers = decode_state(sid, state)
    out = preview_root(sid)

    def work(status) -> dict:
        status(f"合成 {sid} 的碰撞 / 行走面（页面上此刻那份）→ {_rel(out)}")
        r = tc.export_terrain(sid, doc, out_dir=out, layers=layers)
        status(f"碰撞 {r['grid']['grid_width']}×{r['grid']['grid_height']}，阻挡 {r['blocked_pct']:.1f}%；"
               f"行走面 {sum(1 for g in r['ground'] if g.get('edited'))}/{len(r['ground'])} 个时段有修补")
        return r

    return _start_job("push", sid, work, "preview")


def export_start(sid: str) -> dict:
    """导出到游戏：盘上的作者层合成进资源。页面先保存再调它（没存上就不导）。"""
    sid = safe_sid(sid)

    def work(status) -> dict:
        status(f"合成 {sid} 的碰撞 / 行走面（盘上的作者层）→ 资源")
        r = tc.export_terrain(sid)
        status(f"碰撞 {r['grid']['grid_width']}×{r['grid']['grid_height']}，阻挡 {r['blocked_pct']:.1f}%；"
               f"行走面 {sum(1 for g in r['ground'] if g.get('edited'))}/{len(r['ground'])} 个时段有修补")
        issues = []
        try:
            from tools.character_lighting_lab import audit_walkable as aw
            issues = aw.reach_issues(tc.SCENES_JSON / f"{sid}.json")
        except Exception as e:  # noqa: BLE001 — 审计失败不算导出失败
            status(f"连通性审计没跑成：{type(e).__name__}: {e}")
        for it in issues:
            status(f"⚠ {it}")
        r["reach"] = issues
        return r

    return _start_job("export", sid, work, "export")


def drop_preview_after_export(sid: str, log=None) -> None:
    """导出之后预览目录就是多余的：删掉（删不掉不算导出失败）。"""
    d = preview_root(sid)
    if d.is_dir():
        try:
            shutil.rmtree(d)
            if log:
                log(f"已撤掉本机预览 {_rel(d)}（资源里的就是最新的）")
        except OSError as e:
            if log:
                log(f"预览目录删不掉：{e}")


def revoke_preview(sid: str) -> dict:
    """丢弃没保存的改动时撤掉推过的预览：删本机预览目录，并让游戏换回资源那份（不等游戏）。"""
    sid = safe_sid(sid)
    d = preview_root(sid)
    existed = d.is_dir()
    if existed:
        shutil.rmtree(d, ignore_errors=True)
    if existed:
        threading.Thread(target=lambda: push_to_game(sid, "export"), daemon=True, name="terrain-revoke").start()
    return {"ok": True, "revoked": existed}


def check_scene(sid: str) -> dict:
    """命令行 `--check`：形状 + 磁盘一致（旁挂 == 位图）+ 连通性。"""
    sid = safe_sid(sid)
    from tools.character_lighting_lab import audit_depth, audit_walkable
    problems: list[str] = []
    try:
        doc = tc.load_terrain(sid)
    except ValueError as e:
        return {"id": sid, "problems": [str(e)], "reach": []}
    problems += tc.terrain_problems(doc)
    _n, depth_issues = audit_depth.audit_scene(tc.SCENES_JSON / f"{sid}.json")
    problems += depth_issues
    reach = audit_walkable.reach_issues(tc.SCENES_JSON / f"{sid}.json")
    return {"id": sid, "problems": problems, "reach": reach, "needsExport": needs_export(sid, doc) if doc.get("grid") else False}
