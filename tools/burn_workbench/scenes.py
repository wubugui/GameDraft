# -*- coding: utf-8 -*-
"""燃烧工作台要读的工程数据（只读，一个字节都不写）：模板的「用在哪」、场景视图（背景 / 可燃实体 / 几何）、
站位能不能站、玩家动画、能点火的挂件预设、粒子效果 id、原画候选、原画代理。

模板和场景没有关系：场景只在「用在哪」点开一个场景实体引用时出现（只读场景视图），所以这里只描述**开了可燃的实体**
（热点 / NPC 的 ``burnable`` 块 + 实体 transform + 透视 / 朝向要用的原始字段）。透视与朝向的口径在页面
``viewer/preview.js`` 的 ``entityPerspective`` / ``entityFacingLeft``（照 ``Hotspot.ts`` / ``Npc.ts``），这里只给原始字段。

读的根是 ``store.PROJECT``（测试 / 自检指到临时工程）。场景几何（照明载荷的行走面 / 深度壳）走轨迹工作台那份
``get_geometry``——它的路径钉在真工程上，所以只有 ``PROJECT`` 就是真工程时才给 ``cal``；临时工程一律按
没有载荷的平面空间（与游戏 ``createPlanarVfxSpace`` 同一条）。

站位判定与游戏 ``IgnitePerformer`` 的 ``isWalkable`` 同口径：场景边界 + ``SceneDepthSystem.isCollision``；
本地这一半用 ``tools/character_lighting_lab/audit_walkable.py`` 的反投影（那份是 ``./dev.sh audit-walkable``
的裁决基准，逐行对齐 ``isCollision``），不另写。联动游戏时页面再发 ``walkProbe`` 以游戏自己的判定为准。
"""
from __future__ import annotations

import io
import json
import threading
from pathlib import Path, PurePosixPath
from typing import Any

from tools.burn_workbench import store

_IMG_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
_FILE_EXT = {**_IMG_EXT, ".json": "application/json; charset=utf-8"}
DEFAULT_ANIM = "/resources/runtime/animation/player_anim/anim.json"
#: 模板原画的候选根（与校验器 ``url_to_disk(kind=media)`` 同口径：媒体必须落在 public/resources/runtime 下）
MEDIA_URL_PREFIX = "/resources/runtime/"


def public_dir() -> Path:
    return store.PROJECT / "public"


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None


def _safe_id(sid: Any) -> bool:
    return isinstance(sid, str) and bool(sid) and not sid.startswith(".") and not any(c in sid for c in '\\/:*?"<>|\x00')


def scenes_dir() -> Path:
    return public_dir() / "assets" / "scenes"


def scene_doc(sid: str) -> dict | None:
    if not _safe_id(sid):
        return None
    d = _read_json(scenes_dir() / f"{sid}.json")
    return d if isinstance(d, dict) else None


def url_to_public_path(url: str) -> Path | None:
    """``/resources/...`` / ``/assets/...`` 运行时 URL → ``public/`` 下的文件；拼不出 public 内的路径 = None。"""
    if not isinstance(url, str) or not url.startswith(("/resources/", "/assets/")):
        return None
    rel = PurePosixPath(url.split("?", 1)[0].lstrip("/"))
    if any(part in ("..", "") for part in rel.parts):
        return None
    base = public_dir().resolve()
    p = (base / Path(*rel.parts)).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        return None
    return p


def media_image_file(url: str) -> Path | None:
    """模板原画 URL → 盘上文件（只认 ``/resources/runtime/`` 下的图；与校验器同口径）。不合法 / 不存在 = None。"""
    if not isinstance(url, str) or not url.startswith(MEDIA_URL_PREFIX):
        return None
    p = url_to_public_path(url)
    if p is None or p.suffix.lower() not in _IMG_EXT or not p.is_file():
        return None
    return p


def public_file(url: str) -> tuple[bytes, str] | None:
    """原画 / 动画 JSON 代理：只放行 public 下的图片与 JSON。"""
    p = url_to_public_path(url)
    if p is None or p.suffix.lower() not in _FILE_EXT or not p.is_file():
        return None
    return p.read_bytes(), _FILE_EXT[p.suffix.lower()]


def image_size(url: str) -> list[int] | None:
    p = url_to_public_path(url)
    if p is None or not p.is_file():
        return None
    try:
        from PIL import Image
        with Image.open(p) as im:
            return [int(im.width), int(im.height)]
    except Exception:  # noqa: BLE001
        return None


def _bg_file(sid: str, data: dict) -> Path | None:
    bgs = data.get("backgrounds") if isinstance(data.get("backgrounds"), list) else []
    img = bgs[0].get("image") if bgs and isinstance(bgs[0], dict) else None
    name = str(img or "background.png").replace("\\", "/")
    if name.startswith("/"):
        return url_to_public_path(name)
    rel = PurePosixPath(name)
    if any(part == ".." for part in rel.parts):
        return None
    return public_dir() / "resources" / "runtime" / "scenes" / sid / Path(*rel.parts)


def _world_size(sid: str, data: dict) -> tuple[float, float]:
    ww = data.get("worldWidth")
    wh = data.get("worldHeight")
    bw = bh = None
    bg = _bg_file(sid, data)
    if bg is not None and bg.is_file():
        try:
            from PIL import Image
            with Image.open(bg) as im:
                bw, bh = im.width, im.height
        except Exception:  # noqa: BLE001
            pass
    w = float(ww) if isinstance(ww, (int, float)) and ww > 0 else float(bw or 1600)
    if isinstance(wh, (int, float)) and wh > 0:
        h = float(wh)
    elif bw and bh:
        h = w * bh / bw
    else:
        h = w * 9 / 16
    return w, h


def _uses_real_geometry() -> bool:
    try:
        return store.PROJECT.resolve() == store.ROOT.resolve()
    except OSError:
        return False


def _num(v: Any, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _entity_row(e: dict, kind: str) -> dict | None:
    """一个开了可燃的场景实体：id / 显示名 / transform / 透视与朝向要用的原始字段 / 宿主上的 burnable 块（只读）。"""
    host = e.get("burnable")
    if not isinstance(host, dict) or not isinstance(host.get("template"), str) or not host["template"].strip():
        return None
    di = e.get("displayImage") if isinstance(e.get("displayImage"), dict) else None
    return {
        "id": str(e.get("id") or ""),
        "kind": kind,
        "label": str(e.get("label") or e.get("name") or ""),
        "x": _num(e.get("x")), "y": _num(e.get("y")),
        "scale": e.get("scale"), "rotation": e.get("rotation"), "anchor": e.get("anchor"),
        "interactionRange": _num(e.get("interactionRange")),
        # 透视：热点只有 === true 才吃（Hotspot.setPerspectiveScale）；NPC = perspectiveScaleEnabled ?? !renderRaw（Npc.setPerspectiveScale）
        "perspectiveScaleEnabled": e.get("perspectiveScaleEnabled"),
        "renderRaw": e.get("renderRaw"),
        # 朝向：热点 displayImage.facing；NPC initialFacing
        "displayFacing": di.get("facing") if di else None,
        "initialFacing": e.get("initialFacing") if kind == "npc" else None,
        "conditions": len(e.get("conditions") or []) if isinstance(e.get("conditions"), list) else 0,
        "template": host["template"].strip(),
        "host": host,
    }


def scene_summary(sid: str) -> dict:
    """场景视图要的描述：尺寸、背景、开了可燃的实体（热点 / NPC）、风、透视、几何标定。"""
    data = scene_doc(sid)
    if data is None:
        raise FileNotFoundError(f"场景「{sid}」不存在")
    ww, wh = _world_size(sid, data)
    entities: list[dict] = []
    for key, kind in (("hotspots", "hotspot"), ("npcs", "npc")):
        for e in data.get(key) or []:
            if isinstance(e, dict):
                row = _entity_row(e, kind)
                if row is not None:
                    entities.append(row)
    out: dict = {
        "id": sid,
        "name": str(data.get("name") or sid),
        "worldWidth": ww, "worldHeight": wh,
        # 游戏判站位用的边界是场景 JSON 里写的值（没写 = 那一侧不挡）
        "boundsWidth": data.get("worldWidth") if isinstance(data.get("worldWidth"), (int, float)) else None,
        "boundsHeight": data.get("worldHeight") if isinstance(data.get("worldHeight"), (int, float)) else None,
        "hasBackground": bool(_bg_file(sid, data) and _bg_file(sid, data).is_file()),
        "wind": data.get("wind") if isinstance(data.get("wind"), dict) else None,
        "perspectiveScale": data.get("perspectiveScale") if isinstance(data.get("perspectiveScale"), dict) else None,
        "hasDepthConfig": bool(data.get("depthConfig")),
        "entities": entities,
        "cal": None,
        "calNote": "",
    }
    if not data.get("depthConfig"):
        out["calNote"] = "场景没有深度：按平面空间模拟（与游戏没有载荷时同一条）"
    elif not _uses_real_geometry():
        out["calNote"] = "临时工程没有照明载荷：按平面空间模拟"
    else:
        try:
            from tools.trajectory_workbench.serve import get_geometry
            g = get_geometry(sid, None)
            if g.has_depth and g.ground is not None:
                s = g.summary()
                out["cal"] = s.get("cal")
                out["worldWidth"], out["worldHeight"] = float(s["worldWidth"]), float(s["worldHeight"])
            else:
                out["calNote"] = "场景深度 / 行走面没烘：按平面空间模拟（游戏里载荷到之前也是这样）"
        except Exception as e:  # noqa: BLE001 — 几何坏了不拖垮整份描述
            out["calNote"] = f"场景几何装不上（{type(e).__name__}: {e}）：按平面空间模拟"
    return out


def geometry_bytes(sid: str, kind: str) -> bytes | None:
    if not _uses_real_geometry() or scene_doc(sid) is None:
        return None
    from tools.trajectory_workbench.serve import get_geometry
    g = get_geometry(sid, None)
    if not g.has_depth:
        return None
    if kind == "ground":
        return g.ground_bytes()
    if kind == "shell":
        return g.shell_bytes()
    return None


_bg_lock = threading.Lock()
_bg_cache: dict = {}


def scene_background(sid: str, width: int) -> tuple[bytes, str] | None:
    data = scene_doc(sid)
    if data is None:
        return None
    f = _bg_file(sid, data)
    if f is None or not f.is_file():
        return None
    width = max(64, min(int(width or 1600), 4096))
    key = (str(f), f.stat().st_mtime_ns, width)
    with _bg_lock:
        hit = _bg_cache.get(key)
    if hit:
        return hit, "image/png"
    from PIL import Image
    with Image.open(f) as im:
        img = im.convert("RGB")
        if img.width > width:
            img = img.resize((width, max(1, round(img.height * width / img.width))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG", compress_level=3)
    data_b = buf.getvalue()
    with _bg_lock:
        if len(_bg_cache) > 8:
            _bg_cache.clear()
        _bg_cache[key] = data_b
    return data_b, "image/png"


# ---------------------------------------------------------------------------- 用在哪

def refs_detail(tid: str) -> list[dict]:
    """「用在哪」：共享闸门 ``refs_of_template`` 的每一条 + 给人看的名字（场景名 / 实体显示名 / 挂件名 / 路径串）。

    场景实体（``hotspot`` / ``npc``）带 ``scene`` / ``sceneName`` / ``entity`` / ``entityLabel``，页面据此开只读场景视图。
    """
    refs = store.template_refs(tid)
    scene_cache: dict[str, dict | None] = {}
    presets = _read_json(public_dir() / "assets" / "data" / "prop_presets.json")
    out: list[dict] = []
    for r in refs:
        row = dict(r)
        row["where"] = "".join(f"[{p}]" if isinstance(p, int) else (f".{p}" if i else str(p)) for i, p in enumerate(r["path"]))
        if r.get("kind") in ("hotspot", "npc") and r.get("scene"):
            sid = r["scene"]
            if sid not in scene_cache:
                scene_cache[sid] = scene_doc(sid)
            sc = scene_cache[sid]
            row["sceneName"] = str((sc or {}).get("name") or sid)
            node: Any = sc
            try:
                for k in r["path"]:
                    node = node[k]
            except (KeyError, IndexError, TypeError):
                node = None
            if isinstance(node, dict):
                row["entityLabel"] = str(node.get("label") or node.get("name") or "")
        elif r.get("kind") == "prop" and isinstance(presets, dict):
            pre = presets.get(r.get("prop"))
            row["label"] = str(pre.get("label") or "") if isinstance(pre, dict) else ""
        out.append(row)
    return out


# ---------------------------------------------------------------------------- 站位能不能站

def walk_check(sid: str, points: list) -> dict:
    """画面点站不站得了（本地）：``{results: [True/False/None], source, note}``。

    与游戏同口径：出了场景 JSON 写的边界 = 站不了；否则 ``!isCollision``。游戏在这些情形里 ``isCollision`` 恒为假
    （没有深度 / 没有碰撞网格 / 行走面没烘 / 碰撞图尺寸不对被整份拒用），本地照样判"站得了"并在 note 里说清；
    只有读数据时抛了异常才是 ``None``（未判）。
    """
    data = scene_doc(sid)
    pts = [p for p in (points or [])][:256]
    if data is None:
        return {"results": [None] * len(pts), "source": "none", "note": f"场景「{sid}」读不到"}
    bw = data.get("worldWidth") if isinstance(data.get("worldWidth"), (int, float)) else None
    bh = data.get("worldHeight") if isinstance(data.get("worldHeight"), (int, float)) else None

    def in_bounds(x: float, y: float) -> bool:
        if x < 0 or y < 0:
            return False
        if bw is not None and x > bw:
            return False
        if bh is not None and y > bh:
            return False
        return True

    def coords(p: Any) -> tuple[float, float] | None:
        if isinstance(p, (list, tuple)) and len(p) >= 2 and all(isinstance(v, (int, float)) for v in p[:2]):
            return float(p[0]), float(p[1])
        return None

    blocked_at = None
    note = ""
    cfg = data.get("depthConfig")
    if not cfg:
        note = "场景没有深度：游戏里没有碰撞，只挡边界"
    elif not _uses_real_geometry():
        note = "临时工程：只判边界"
    else:
        try:
            from tools.character_lighting_lab.audit_walkable import _scene_geometry
            g = _scene_geometry(sid, data, cfg)
            if isinstance(g, str):
                note = {"NO_COLLISION": "没有碰撞网格：游戏里只挡边界"}.get(g, f"{g}：游戏里这时也只挡边界")
            else:
                blocked_at = g.blocked_at
                note = "本地碰撞（与 isCollision 同一条反投影）"
        except Exception as e:  # noqa: BLE001
            return {"results": [None] * len(pts), "source": "error", "note": f"本地碰撞读不出来：{type(e).__name__}: {e}"}
    res: list = []
    for p in pts:
        c = coords(p)
        if c is None:
            res.append(None)
            continue
        if not in_bounds(*c):
            res.append(False)
            continue
        if blocked_at is None:
            res.append(True)
            continue
        try:
            res.append(blocked_at(c[0], c[1]) is not True)
        except Exception:  # noqa: BLE001
            res.append(None)
    return {"results": res, "source": "local", "note": note}


# ---------------------------------------------------------------------------- 玩家 / 挂件 / 效果 / 图

def game_config() -> dict:
    d = _read_json(public_dir() / "assets" / "data" / "game_config.json")
    return d if isinstance(d, dict) else {}


def _rel_to_manifest(manifest: str, ref: str) -> str:
    """与 ``resolvePathRelativeToAnimManifest`` 同式（给 serve 找图集像素尺寸用）。"""
    r = (ref or "").strip()
    if not r or r.startswith(("/assets/", "/resources/")):
        return r
    base = manifest.rsplit("/", 1)[0]
    part = r[2:] if r.startswith("./") else r
    joined = f"{base}/{part}".replace("//", "/")
    return joined if joined.startswith("/") else "/" + joined


def player_data() -> dict:
    cfg = game_config()
    pa = cfg.get("playerAvatar") if isinstance(cfg.get("playerAvatar"), dict) else {}
    acts = cfg.get("playerActs") if isinstance(cfg.get("playerActs"), dict) else {}
    anim_url = str(pa.get("animManifest") or DEFAULT_ANIM)
    out: dict = {"animUrl": anim_url, "anim": None, "sockets": None, "sheetSize": None,
                 "stateMap": pa.get("stateMap") if isinstance(pa.get("stateMap"), dict) else {},
                 "ignite": acts.get("ignite") if isinstance(acts.get("ignite"), dict) else {}, "errors": []}
    p = url_to_public_path(anim_url)
    anim = _read_json(p) if p else None
    if not isinstance(anim, dict):
        out["errors"].append(f"玩家动画包读不到：{anim_url}")
        return out
    out["anim"] = anim
    sheet = _rel_to_manifest(anim_url, str(anim.get("spritesheet") or ""))
    out["sheetSize"] = image_size(sheet) if sheet else None
    sp = url_to_public_path(anim_url.rsplit("/", 1)[0] + "/sockets.json")
    sockets = _read_json(sp) if sp and sp.is_file() else None
    out["sockets"] = sockets if isinstance(sockets, dict) else None
    if out["sockets"] is None:
        out["errors"].append("玩家动画包没有 sockets.json：挂点没标，站位解不出来")
    return out


def _preset_images(pre: dict) -> list[str]:
    imgs: list[str] = []
    for blk in [pre] + [s for s in (pre.get("states") or {}).values() if isinstance(s, dict)]:
        if isinstance(blk.get("image"), str) and blk["image"].strip():
            imgs.append(blk["image"].strip())
        for x in blk.get("images") or []:
            if isinstance(x, str) and x.strip():
                imgs.append(x.strip())
    return list(dict.fromkeys(imgs))


def igniter_presets() -> list[dict]:
    """``prop_presets.json`` 里写了 ``igniter``（基础块或任一状态）的预设 + 贴图像素尺寸。"""
    doc = _read_json(public_dir() / "assets" / "data" / "prop_presets.json")
    out: list[dict] = []
    if not isinstance(doc, dict):
        return out
    for pid, pre in doc.items():
        if not isinstance(pre, dict):
            continue
        states = pre.get("states") if isinstance(pre.get("states"), dict) else {}
        has = isinstance(pre.get("igniter"), dict) or any(isinstance(s, dict) and isinstance(s.get("igniter"), dict) for s in states.values())
        if not has:
            continue
        out.append({"id": str(pid), "label": str(pre.get("label") or ""), "def": pre,
                    "sizes": {u: image_size(u) for u in _preset_images(pre)}})
    return out


def effect_ids() -> list[dict]:
    d = public_dir() / "assets" / "data" / "vfx"
    out: list[dict] = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        doc = _read_json(p)
        ems = doc.get("emitters") if isinstance(doc, dict) and isinstance(doc.get("emitters"), list) else []
        ext = any(isinstance(e, dict) and isinstance(e.get("spawn"), dict) and isinstance(e["spawn"].get("shape"), dict)
                  and e["spawn"]["shape"].get("kind") == "external" for e in ems)
        out.append({"id": p.stem, "label": str(doc.get("label") or "") if isinstance(doc, dict) else "", "external": ext})
    return out


def image_candidates() -> dict:
    """模板原画的候选：``public/resources/runtime`` 下全部图（与校验器的媒体口径同一个面，一张不少）。

    返回 ``{images: [url…], used: {url: [模板 id…]}, worldSizes: {url: [宽, 高]}}``：``used`` = 已经有模板在用的
    （选图弹窗排前面）；``worldSizes`` = 场景热点展示图写过的世界尺寸（wu，新建模板时据此给初始真实尺寸）。
    """
    base = public_dir() / "resources" / "runtime"
    images: list[str] = []
    if base.is_dir():
        for p in base.rglob("*"):
            if p.suffix.lower() in _IMG_EXT and p.is_file():
                images.append("/" + p.relative_to(public_dir()).as_posix())
    images.sort()
    used: dict[str, list[str]] = {}
    for row in store.list_assets():
        if row.get("image"):
            used.setdefault(row["image"], []).append(row["id"])
    sizes: dict[str, list[float]] = {}
    d = scenes_dir()
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            data = _read_json(p)
            if not isinstance(data, dict):
                continue
            for h in data.get("hotspots") or []:
                di = h.get("displayImage") if isinstance(h, dict) else None
                if not isinstance(di, dict) or not isinstance(di.get("image"), str):
                    continue
                w, hh = di.get("worldWidth"), di.get("worldHeight")
                if di["image"] not in sizes and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (w, hh)):
                    sizes[di["image"]] = [float(w), float(hh)]
    return {"images": images, "used": used, "worldSizes": sizes}
