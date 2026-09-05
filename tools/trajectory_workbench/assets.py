# -*- coding: utf-8 -*-
"""轨迹资产文件的读写（``public/assets/data/trajectories/<id>.json``）。

**本工作台是这个目录唯一的写入者**：主编辑器只读它给选择器与校验器用，没有脏桶、
没有 Save All 分支、不裁剪"内存里没有"的文件（否则这里刚存的下一次 Save All 就被删）。

一个文件一条轨迹，``id == 文件名``。落盘口径与主编辑器一致：``ensure_ascii=False`` +
2 空格缩进 + 末尾换行 + 不排序键 + LF；就位走 ``tools.atomic_io.retry_transient``
（Windows 上 ``os.replace`` 不原子，见 [[atomic-write-windows]]）。

帧的**相对化**也在这里：烘焙机吐的是烘焙场景里的绝对姿态，写成资产要减去锚点
（``authoring.anchor`` / ``authoring.anchorWorld``），运行时再加上播放锚点。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from tools.atomic_io import retry_transient

from .model import as_number, write_keyframe

ROOT = Path(__file__).resolve().parents[2]
TRAJECTORIES_DIR = ROOT / "public" / "assets" / "data" / "trajectories"

SPACES: tuple[str, ...] = ("screen", "world")

#: 文件名即 id：禁路径分隔符 / Windows 保留字符 / 控制字符；允许中文。
_ID_RE = re.compile(r'^[^\\/:*?"<>|\x00-\x1f]{1,120}$')
_WORLD_ROUND = {"x": 2, "y": 2, "z": 2, "h": 2, "rotation": 2, "scaleX": 4, "scaleY": 4, "alpha": 4}


def valid_id(tid: Any) -> bool:
    s = str(tid or "")
    return bool(_ID_RE.match(s)) and not s.startswith(".") and s.strip() == s


def asset_path(tid: str) -> Path:
    if not valid_id(tid):
        raise ValueError(f"非法轨迹 id: {tid!r}")
    return TRAJECTORIES_DIR / f"{tid}.json"


def dumps(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, path)


def list_assets() -> list[dict]:
    """目录清单（按 id 排序）。坏 JSON 也列出来（``error`` 字段），别让一个坏文件藏起整批。"""
    out: list[dict] = []
    if not TRAJECTORIES_DIR.is_dir():
        return out
    for p in sorted(TRAJECTORIES_DIR.glob("*.json")):
        row: dict = {"id": p.stem, "file": p.name}
        try:
            doc = json.loads(p.read_bytes().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — 清单不能因一个坏文件整批消失
            row["error"] = f"{type(e).__name__}: {e}"
            out.append(row)
            continue
        if not isinstance(doc, dict):
            row["error"] = "根不是对象"
            out.append(row)
            continue
        au = doc.get("authoring") if isinstance(doc.get("authoring"), dict) else {}
        kf = doc.get("keyframes")
        row.update({
            "label": str(doc.get("label") or ""),
            "space": str(doc.get("space") or "screen"),
            "frames": len(kf) if isinstance(kf, list) else 0,
            "sceneId": str(au.get("sceneId") or ""),
            "background": str(au.get("background") or ""),
            "entity": au.get("entity") if isinstance(au.get("entity"), dict) else None,
            "idMismatch": str(doc.get("id") or "") != p.stem,
        })
        out.append(row)
    return out


def load_asset(tid: str) -> dict | None:
    p = asset_path(tid)
    if not p.is_file():
        return None
    doc = json.loads(p.read_bytes().decode("utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{p.name}: 根不是对象")
    return doc


def save_asset(doc: dict) -> Path:
    """整份资产落盘（调用方已烘好帧）。``id`` 决定文件名；键序按 :func:`normalize_asset_order`。"""
    tid = str(doc.get("id") or "")
    p = asset_path(tid)
    atomic_write(p, dumps(normalize_asset_order(doc)))
    return p


def delete_asset(tid: str) -> bool:
    p = asset_path(tid)
    if not p.is_file():
        return False
    retry_transient(os.unlink, p)
    return True


def rename_asset(old: str, new: str) -> Path:
    """改名 = 改文件名 + 改内部 id。目标已存在则拒绝（不静默覆盖别人的资产）。"""
    src = asset_path(old)
    dst = asset_path(new)
    if not src.is_file():
        raise FileNotFoundError(f"轨迹 {old!r} 不存在")
    if dst.exists():
        raise FileExistsError(f"轨迹 {new!r} 已存在")
    doc = load_asset(old) or {}
    doc["id"] = new
    atomic_write(dst, dumps(normalize_asset_order(doc)))
    retry_transient(os.unlink, src)
    return dst


_ORDER = ("id", "label", "space", "keyframes", "worldKeyframes", "source", "authoring")


def normalize_asset_order(doc: dict) -> dict:
    """固定顶层键序（运行时真相在前、工作态在后），未知键原样透传到末尾。"""
    out: dict = {}
    for k in _ORDER:
        if k in doc:
            out[k] = doc[k]
    for k, v in doc.items():
        if k not in out:
            out[k] = v
    if "label" in out and not str(out["label"] or "").strip():
        del out["label"]
    if "worldKeyframes" in out and not out["worldKeyframes"]:
        del out["worldKeyframes"]
    return out


def unique_id(base: str, taken: Any = None) -> str:
    """撞名追 ``_2`` ``_3``；``taken`` 缺省 = 目录里的现有 id。"""
    used = set(taken) if taken is not None else {r["id"] for r in list_assets()}
    if base not in used:
        return base
    n = 2
    while f"{base}_{n}" in used:
        n += 1
    return f"{base}_{n}"


# ---------------------------------------------------------------------------
# 相对化 / 落形
# ---------------------------------------------------------------------------

def relativize_screen_frames(frames_abs: list[dict], anchor: tuple[float, float]) -> list[dict]:
    """烘焙场景绝对帧（计算态或写盘形都行）→ 相对锚点的写盘形帧。

    ``x``/``y``/``sortY`` 同减锚点；``sortY`` 缺省关系（= y）在减完之后由 ``write_keyframe`` 重判。
    """
    ax, ay = float(anchor[0]), float(anchor[1])
    out: list[dict] = []
    for f in frames_abs:
        if not isinstance(f, dict):
            continue
        y = as_number(f.get("y"), 0.0)
        scale = as_number(f.get("scale"), 1.0)
        pose = {
            "atMs": as_number(f.get("atMs"), 0.0),
            "x": as_number(f.get("x"), 0.0) - ax,
            "y": y - ay,
            "rotation": as_number(f.get("rotation"), 0.0),
            "scaleX": as_number(f.get("scaleX"), scale),
            "scaleY": as_number(f.get("scaleY"), scale),
            "alpha": as_number(f.get("alpha"), 1.0),
            "sortY": as_number(f.get("sortY"), y) - ay,
        }
        out.append(write_keyframe(pose))
    return out


def _round(value: float, digits: int) -> float | int:
    r = round(float(value), digits)
    if r == 0:
        return 0
    if r == int(r):
        return int(r)
    return r


def write_world_keyframe(sample: dict, anchor_world: tuple[float, float, float]) -> dict:
    """3D 计算态采样 → 写盘形世界帧（相对锚点；省缺省键；固定键序；恒无 easing）。

    键序 ``atMs, x, y, z, h, rotation, scale|scaleX, scaleY, alpha``；
    ``rotation==0`` / ``alpha==1`` 不写；``scaleX==scaleY`` 合并成 ``scale``（==1 连 scale 都不写）。
    """
    ax, ay, az = anchor_world
    x = _round(as_number(sample.get("x"), 0.0) - ax, _WORLD_ROUND["x"])
    y = _round(as_number(sample.get("y"), 0.0) - ay, _WORLD_ROUND["y"])
    z = _round(as_number(sample.get("z"), 0.0) - az, _WORLD_ROUND["z"])
    h = _round(max(0.0, as_number(sample.get("h"), 0.0)), _WORLD_ROUND["h"])
    rotation = _round(as_number(sample.get("rotation"), 0.0), _WORLD_ROUND["rotation"])
    scale = as_number(sample.get("scale"), 1.0)
    sx = _round(as_number(sample.get("scaleX"), scale), _WORLD_ROUND["scaleX"])
    sy = _round(as_number(sample.get("scaleY"), scale), _WORLD_ROUND["scaleY"])
    alpha = _round(as_number(sample.get("alpha"), 1.0), _WORLD_ROUND["alpha"])
    out: dict = {"atMs": int(round(as_number(sample.get("atMs"), 0.0))), "x": x, "y": y, "z": z, "h": h}
    if rotation != 0:
        out["rotation"] = rotation
    if sx == sy:
        if sx != 1:
            out["scale"] = sx
    else:
        out["scaleX"] = sx
        out["scaleY"] = sy
    if alpha != 1:
        out["alpha"] = alpha
    return out
