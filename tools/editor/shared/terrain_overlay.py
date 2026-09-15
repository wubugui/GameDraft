# -*- coding: utf-8 -*-
"""场景页「地形 / 碰撞」块的只读数据源：摘要 + 画布叠加用的碰撞掩码。

主编辑器对地形**只显示**（2026-09-14 制作人定：碰撞 / 可走区 / 行走面全在地形工作台里改，它是
`runtime/scenes/<id>/terrain/` 的唯一写者，`collision.png` / `collision.json` / `ground_d.png` 由它合成）。
这里读的是**游戏读的产物**（与运行时同一条反投影链：画面点 → 行走面深度 → M-world → 碰撞格），
所以画布上画出来的红块就是玩家会撞上的那些——不是作者层，不是"预计"。

不 import 编辑器以外的东西（numpy / PIL 都是编辑器现成依赖）；不写任何文件。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image


def _bake_dir(runtime_dir: Path, scene: dict) -> Path:
    bgs = scene.get("backgrounds") or []
    img = (bgs[0].get("image") if bgs and isinstance(bgs[0], dict) else None) or "background.png"
    base = str(img).replace("\\", "/").rsplit("/", 1)[-1]
    key = base[:base.rfind(".")] if base.rfind(".") > 0 else base
    return runtime_dir / "lighting" / key


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def terrain_summary(runtime_dir: Path, scene: dict) -> dict:
    """给块里那段摘要用：网格 / 阻挡比例 / 作者层状态 / 待导出。缺什么就说缺什么，不抛。"""
    cfg = scene.get("depthConfig") if isinstance(scene.get("depthConfig"), dict) else None
    out: dict = {"depth": bool(cfg), "grid": None, "blockedPct": None, "sidecar": False, "sizeOk": None,
                 "terrain": None, "needsExport": None, "problems": []}
    if not cfg:
        out["problems"].append("没有 depthConfig：场景还没烘过深度，没有碰撞网格")
        return out
    side = _read_json(runtime_dir / "collision.json")
    col = side if side else (cfg.get("collision") if isinstance(cfg.get("collision"), dict) else None)
    out["sidecar"] = bool(side)
    png = runtime_dir / (str((side or {}).get("collision_map") or cfg.get("collision_map") or "collision.png"))
    if col:
        try:
            out["grid"] = {k: col[k] for k in ("x_min", "z_min", "cell_size", "grid_width", "grid_height")}
        except KeyError:
            out["problems"].append("碰撞网格声明缺字段")
    if png.exists() and out["grid"]:
        arr = np.asarray(Image.open(png).convert("RGB"), np.uint8)[..., 0]
        out["sizeOk"] = arr.shape == (int(col["grid_height"]), int(col["grid_width"]))
        if not out["sizeOk"]:
            out["problems"].append(f"碰撞图 {arr.shape[1]}x{arr.shape[0]} ≠ 声明 {col['grid_width']}x{col['grid_height']}（运行时整份拒用）")
        out["blockedPct"] = float((arr > 127).mean() * 100.0)
    elif out["grid"]:
        out["problems"].append(f"缺 {png.name}")
    tj = _read_json(runtime_dir / "terrain" / "terrain.json")
    if isinstance(tj, dict):
        out["terrain"] = {"updated": tj.get("updated"), "regions": len(tj.get("regions") or []),
                          "heightOps": len(tj.get("heightOps") or []), "brush": bool(tj.get("brush")),
                          "height": bool(tj.get("height")), "auto": bool(tj.get("auto"))}
        got = ((side or {}).get("composed") or {}).get("terrain_sha1") if side else None
        if got:
            import hashlib
            cur = hashlib.sha1(json.dumps(tj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:12]
            out["needsExport"] = cur != got
        else:
            out["needsExport"] = bool(tj.get("brush") or tj.get("regions") or tj.get("heightOps") or tj.get("height"))
    return out


def collision_mask(runtime_dir: Path, scene: dict, width: int = 512) -> np.ndarray | None:
    """画面空间的阻挡掩码（bool，`width` 宽、按世界宽高比取高）：逐像素走运行时那条链。

    与 `SceneDepthSystem.isCollision` 同式：世界 → 原生像素（按 cx/cy 半幅）→ q（Y 翻）→ `R·(qx, qy, d)`
    → floor 落格；网格外 = 不阻挡。拿不到任何一样（深度 / 行走面 / 碰撞）就回 None。
    """
    cfg = scene.get("depthConfig") if isinstance(scene.get("depthConfig"), dict) else None
    if not cfg or not isinstance(cfg.get("M"), dict):
        return None
    side = _read_json(runtime_dir / "collision.json")
    col = side if side else (cfg.get("collision") if isinstance(cfg.get("collision"), dict) else None)
    if not col:
        return None
    png = runtime_dir / (str((side or {}).get("collision_map") or cfg.get("collision_map") or "collision.png"))
    bd = _bake_dir(runtime_dir, scene)
    meta = _read_json(bd / "lighting.json")
    gpng = bd / "ground_d.png"
    if not (png.exists() and meta and gpng.exists() and isinstance(meta.get("ground_d"), dict)):
        return None
    try:
        blocked = np.asarray(Image.open(png).convert("RGB"), np.uint8)[..., 0] > 127
        gw, gh = int(col["grid_width"]), int(col["grid_height"])
        if blocked.shape != (gh, gw):
            return None
        ga = np.asarray(Image.open(gpng).convert("RGB"), np.float32)
        lo, hi = float(meta["ground_d"]["min"]), float(meta["ground_d"]["max"])
        dep = lo + (ga[..., 0] * 256.0 + ga[..., 1]) / 65535.0 * (hi - lo)
        M = cfg["M"]
        R = np.asarray(M["R"], np.float64)
        ppu, cx, cy = float(M["ppu"]), float(M["cx"]), float(M["cy"])
        ww = float(scene.get("worldWidth") or 0)
        wh = float(scene.get("worldHeight") or 0)
        if ww <= 0:
            return None
        if wh <= 0:
            wh = ww * (2 * cy) / (2 * cx)
        w = max(16, int(width))
        h = max(9, int(round(w * wh / ww)))
        # 画面采样点（像素中心）→ 世界 → work 像素（双线性取行走面深度）→ 原生像素 → q
        u = (np.arange(w, dtype=np.float64) + 0.5) / w
        v = (np.arange(h, dtype=np.float64) + 0.5) / h
        U, V = np.meshgrid(u, v)
        gh_w, gw_w = dep.shape
        px = np.clip(U * gw_w, 0.0, gw_w - 1.001)
        py = np.clip(V * gh_w, 0.0, gh_w - 1.001)
        x0 = np.floor(px).astype(np.int64)
        y0 = np.floor(py).astype(np.int64)
        fx, fy = px - x0, py - y0
        d = (dep[y0, x0] * (1 - fx) * (1 - fy) + dep[y0, x0 + 1] * fx * (1 - fy)
             + dep[y0 + 1, x0] * (1 - fx) * fy + dep[y0 + 1, x0 + 1] * fx * fy)
        sx = U * (2 * cx)
        sy = V * (2 * cy)
        qx = (sx - cx) / ppu
        qy = (cy - sy) / ppu
        X = R[0, 0] * qx + R[0, 1] * qy + R[0, 2] * d
        Z = R[2, 0] * qx + R[2, 1] * qy + R[2, 2] * d
        gx = np.floor((X - float(col["x_min"])) / float(col["cell_size"])).astype(np.int64)
        gz = np.floor((Z - float(col["z_min"])) / float(col["cell_size"])).astype(np.int64)
        ok = (gx >= 0) & (gx < gw) & (gz >= 0) & (gz < gh)
        out = np.zeros((h, w), bool)
        out[ok] = blocked[gz[ok], gx[ok]]
        return out
    except (KeyError, TypeError, ValueError, OSError):
        return None


def collision_overlay_rgba(mask: np.ndarray, alpha: int = 96) -> bytes:
    """掩码 → RGBA 字节（红，阻挡处 alpha=alpha，其余 0），给 QImage 用（行优先、无 padding）。"""
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = 64
    rgba[..., 2] = 64
    rgba[..., 3] = np.where(mask, alpha, 0).astype(np.uint8)
    return rgba.tobytes()
