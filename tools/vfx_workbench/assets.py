# -*- coding: utf-8 -*-
"""粒子效果资产文件的读写（``public/assets/data/vfx/<id>.json``）。

**本工作台是这个目录唯一的写入者**（与 ``assets/data/trajectories/`` 完全同模式）：主编辑器只读它
给选择器候选与校验器用，没有脏桶、没有 Save All 分支、不裁剪"内存里没有"的文件——否则这里刚存的
下一次 Save All 就被删（见 [[save-all-dirty-buckets]] 的已知坑）。

一个文件一条效果，``id == 文件名``。落盘口径与主编辑器一致：``ensure_ascii=False`` + 2 空格缩进 +
末尾换行 + 不排序键 + LF；就位走 ``tools.atomic_io.retry_transient``（Windows 上 ``os.replace``
不原子，见 [[atomic-write-windows]]）。

``normalize_effect`` 是这一层的形状闸门：**只收束键序、剥空容器，绝不改数值**（int 不许漂成
float——那是 norms 的「数值表示保真」）。硬拒的四条与 ``src/data/types.ts`` 的 VFX 一节逐条对应：
``spawn.max < 1``（池子空的发射器在运行时静默什么都不发）、``appearance.sizeWu <= 0``（渲染出
零面积的片）、``collision.onHit.emitter`` 指向不存在的发射器（``vfxSim.findEmitter`` 返回 null，
撞击子发射静默消失）、``subOnly`` 同时带 ``behavior``（子发射器不自己发，群体状态机永远推不动）。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from tools.atomic_io import retry_transient

ROOT = Path(__file__).resolve().parents[2]
VFX_DIR = ROOT / "public" / "assets" / "data" / "vfx"

#: 文件名即 id：禁路径分隔符 / Windows 保留字符 / 控制字符；允许中文。与轨迹资产同一条护栏。
_ID_RE = re.compile(r'^[^\\/:*?"<>|\x00-\x1f]{1,120}$')
#: 发射器 id 会进 `onHit.emitter` 与状态回传，必须是紧凑标识（允许中文，不许空白 / 点 / 斜杠）。
_EMITTER_ID_RE = re.compile(r'^[^\s./\\:*?"<>|\x00-\x1f]{1,60}$')

#: 顶层键序（运行时真相在前、工作态在后）
_ORDER = ("id", "label", "emitters", "authoring")
#: 发射器键序（与 types.ts 的 VfxEmitterDef 逐字同序）
_EMITTER_ORDER = ("id", "offset", "subOnly", "appearance", "spawn", "motion", "life", "collision", "behavior", "sound")
#: 各模块的键序（同上，按 types.ts）
_MODULE_ORDER = {
    "appearance": ("animFile", "image", "state", "restState", "frameRate", "sizeWu", "sizeJitter",
                   "sizeOverLife", "alphaOverLife", "tint", "blend", "lit", "emissive",
                   "stretchByVelocity", "faceVelocity", "softEdgeWu", "spin"),
    "spawn": ("max", "rate", "burst", "shape", "speed", "direction", "spread", "duration"),
    "motion": ("gravity", "drag", "wind", "buoyancy", "turbulence", "maxSpeed", "stimulus"),
    "life": ("seconds",),
    "collision": ("ground", "shell", "restitution", "friction", "radiusWu", "onHit"),
    "behavior": ("cruise", "max", "maxAccel", "minAltitude", "senseRadius", "separation", "accel",
                 "orbit", "home", "attitude", "initialState", "wingFlap", "speedJitter", "wander",
                 "startlePulse"),
    "sound": ("loop", "start", "hit"),
}
_AUTHORING_ORDER = ("sceneId", "background", "anchor", "note")
_ANCHOR_ORDER = ("x", "y", "h", "surface")

_RESPONSES = ("none", "kill", "bounce", "stick", "slide")
_FLOCK_STATES = ("roosting", "airborne", "fleeing", "returning")
_BLENDS = ("normal", "add")


# ---------------------------------------------------------------------------
# id 护栏 / 路径
# ---------------------------------------------------------------------------

def valid_id(eid: Any) -> bool:
    s = str(eid or "")
    return bool(_ID_RE.match(s)) and not s.startswith(".") and s.strip() == s


def asset_path(eid: str) -> Path:
    if not valid_id(eid):
        raise ValueError(f"非法效果 id: {eid!r}")
    return VFX_DIR / f"{eid}.json"


def dumps(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, path)


# ---------------------------------------------------------------------------
# 形状收束
# ---------------------------------------------------------------------------

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _order(d: dict, keys: tuple[str, ...]) -> dict:
    """按 keys 排序已有键，未知键原样透传到末尾（往返零丢失：表单没显示的键也留着）。"""
    out: dict = {}
    for k in keys:
        if k in d:
            out[k] = d[k]
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


def _curve(v: Any, where: str) -> list:
    """``VfxCurve``：``[t01, value]`` 关键点。形状不对直接拒（运行时会读出 NaN 并静默把粒子画没）。"""
    if not isinstance(v, list) or not v:
        raise ValueError(f"{where}: 曲线要是非空的 [[t, v], …] 数组")
    out = []
    for kp in v:
        if not (isinstance(kp, list) and len(kp) == 2 and _is_num(kp[0]) and _is_num(kp[1])):
            raise ValueError(f"{where}: 关键点要是 [t, v] 两个数，收到 {kp!r}")
        out.append([kp[0], kp[1]])
    return out


def _vec3(v: Any, where: str) -> list:
    if not (isinstance(v, list) and len(v) == 3 and all(_is_num(x) for x in v)):
        raise ValueError(f"{where}: 要是三个数的向量，收到 {v!r}")
    return list(v)


def _pair(v: Any, where: str) -> list:
    if not (isinstance(v, list) and len(v) == 2 and all(_is_num(x) for x in v)):
        raise ValueError(f"{where}: 要是两个数的区间，收到 {v!r}")
    return list(v)


def _appearance(ap: Any, where: str, warn: list[str]) -> dict:
    if not isinstance(ap, dict):
        raise ValueError(f"{where}: 缺 appearance")
    size = ap.get("sizeWu")
    if not _is_num(size) or size <= 0:
        raise ValueError(f"{where}.appearance.sizeWu 必须 > 0（收到 {size!r}）")
    if not str(ap.get("animFile") or "").strip() and not str(ap.get("image") or "").strip():
        warn.append(f"{where}: 外观既没有 animFile 也没有 image，游戏里装不到贴图（会跳过这个发射器）")
    out = dict(ap)
    for k in ("sizeOverLife", "alphaOverLife"):
        if k in out:
            out[k] = _curve(out[k], f"{where}.appearance.{k}")
    for k in ("sizeJitter",):
        if k in out:
            out[k] = _pair(out[k], f"{where}.appearance.{k}")
    if "tint" in out:
        out["tint"] = _vec3(out["tint"], f"{where}.appearance.tint")
    if "blend" in out and out["blend"] not in _BLENDS:
        raise ValueError(f"{where}.appearance.blend 只能是 {_BLENDS}，收到 {out['blend']!r}")
    if "emissive" in out:
        if not _is_num(out["emissive"]) or not (0.0 <= float(out["emissive"]) <= 1.0):
            raise ValueError(f"{where}.appearance.emissive 必须是 0..1（收到 {out['emissive']!r}）")
        if out.get("lit") is False:
            warn.append(f"{where}: 关了受光（lit=false）时 emissive 没有意义，渲染会忽略它")
    if isinstance(out.get("spin"), dict) and "rate" in out["spin"]:
        out["spin"] = dict(out["spin"])
        out["spin"]["rate"] = _pair(out["spin"]["rate"], f"{where}.appearance.spin.rate")
    return _order(out, _MODULE_ORDER["appearance"])


def _spawn(sp: Any, where: str) -> dict:
    if not isinstance(sp, dict):
        raise ValueError(f"{where}: 缺 spawn")
    mx = sp.get("max")
    if not _is_num(mx) or mx < 1:
        raise ValueError(f"{where}.spawn.max 必须 ≥ 1（池容量，收到 {mx!r}）")
    out = dict(sp)
    if "speed" in out:
        out["speed"] = _pair(out["speed"], f"{where}.spawn.speed")
    if "direction" in out:
        out["direction"] = _vec3(out["direction"], f"{where}.spawn.direction")
    shape = out.get("shape")
    if isinstance(shape, dict):
        kind = shape.get("kind")
        if kind not in ("point", "sphere", "disc", "box", "line"):
            raise ValueError(f"{where}.spawn.shape.kind 未知：{kind!r}")
        shape = dict(shape)
        if kind in ("sphere", "disc") and not _is_num(shape.get("radius")):
            raise ValueError(f"{where}.spawn.shape.radius 要是数")
        if kind == "box":
            shape["size"] = _vec3(shape.get("size"), f"{where}.spawn.shape.size")
        if kind == "line":
            shape["to"] = _vec3(shape.get("to"), f"{where}.spawn.shape.to")
        out["shape"] = shape
    return _order(out, _MODULE_ORDER["spawn"])


def _motion(mo: Any, where: str) -> dict:
    out = dict(mo)
    if "wind" in out:
        out["wind"] = _vec3(out["wind"], f"{where}.motion.wind")
    if isinstance(out.get("turbulence"), dict):
        t = dict(out["turbulence"])
        if not _is_num(t.get("strength")) or not _is_num(t.get("scale")) or t["scale"] <= 0:
            raise ValueError(f"{where}.motion.turbulence 要有 strength 与 scale>0")
        out["turbulence"] = t
    if "stimulus" in out:
        st = out["stimulus"]
        if not isinstance(st, dict):
            raise ValueError(f"{where}.motion.stimulus 须为对象 {{fear/attract, accel}}")
        st = dict(st)
        if not _is_num(st.get("accel")) or float(st["accel"]) < 0:
            raise ValueError(f"{where}.motion.stimulus.accel 须为非负数（wu/s²）")
        for key in ("fear", "attract"):
            if key not in st:
                continue
            tbl = st[key]
            if not isinstance(tbl, dict) or not tbl:
                raise ValueError(f"{where}.motion.stimulus.{key} 须为非空的「标签 → 权重」表")
            for tag, w in tbl.items():
                if not str(tag).strip():
                    raise ValueError(f"{where}.motion.stimulus.{key} 有空标签")
                if not _is_num(w):
                    raise ValueError(f"{where}.motion.stimulus.{key}[{tag!r}] 权重须为数值")
            st[key] = dict(tbl)
        if "fear" not in st and "attract" not in st:
            raise ValueError(f"{where}.motion.stimulus 至少要有 fear 或 attract 一张表，否则一个场也不认")
        out["stimulus"] = _order(st, ("fear", "attract", "accel"))
    return _order(out, _MODULE_ORDER["motion"])


def _life(li: Any, where: str) -> dict:
    out = dict(li)
    if "seconds" in out:
        out["seconds"] = _pair(out["seconds"], f"{where}.life.seconds")
        if out["seconds"][0] <= 0 or out["seconds"][1] < out["seconds"][0]:
            raise ValueError(f"{where}.life.seconds 要是 [下限>0, 上限≥下限]，收到 {out['seconds']!r}")
    return _order(out, _MODULE_ORDER["life"])


def _collision(co: Any, where: str) -> dict:
    out = dict(co)
    for k in ("ground", "shell"):
        if k in out and out[k] not in _RESPONSES:
            raise ValueError(f"{where}.collision.{k} 只能是 {_RESPONSES}，收到 {out[k]!r}")
    if isinstance(out.get("onHit"), dict):
        oh = dict(out["onHit"])
        if not str(oh.get("emitter") or "").strip():
            raise ValueError(f"{where}.collision.onHit 要指一个同效果内的发射器 id")
        if not _is_num(oh.get("count")) or oh["count"] < 1:
            raise ValueError(f"{where}.collision.onHit.count 必须 ≥ 1")
        out["onHit"] = oh
    return _order(out, _MODULE_ORDER["collision"])


def _behavior(be: Any, where: str) -> dict:
    if not isinstance(be, dict):
        raise ValueError(f"{where}.behavior 要是对象")
    for k in ("cruise", "max", "maxAccel", "minAltitude", "senseRadius", "separation"):
        if not _is_num(be.get(k)):
            raise ValueError(f"{where}.behavior.{k} 要是数（wu / wu/s / wu/s²）")
    acc = be.get("accel")
    if not isinstance(acc, dict) or not all(_is_num(acc.get(k)) for k in ("separation", "alignment", "cohesion")):
        raise ValueError(f"{where}.behavior.accel 要有 separation / alignment / cohesion 三个加速度上限")
    orbit = be.get("orbit")
    if not isinstance(orbit, dict) or not _is_num(orbit.get("radius")) or not _is_num(orbit.get("height")):
        raise ValueError(f"{where}.behavior.orbit 要有 radius 与 height")
    home = be.get("home")
    if not isinstance(home, dict) or not all(_is_num(home.get(k)) for k in ("nestRadius", "rangeRadius", "startleRadius")):
        raise ValueError(f"{where}.behavior.home 要有 nestRadius / rangeRadius / startleRadius")
    at = be.get("attitude")
    if not isinstance(at, dict) or not isinstance(at.get("fear"), dict):
        raise ValueError(f"{where}.behavior.attitude.fear 要是 标签→权重 的表")
    out = dict(be)
    att = dict(at)
    if "reactionDelay" in att:
        att["reactionDelay"] = _pair(att["reactionDelay"], f"{where}.behavior.attitude.reactionDelay")
    for k in ("fearDecay", "fleeThreshold", "calmSeconds"):
        if k in att and not _is_num(att[k]):
            raise ValueError(f"{where}.behavior.attitude.{k} 要是数")
    out["attitude"] = att
    if "initialState" in out and out["initialState"] not in _FLOCK_STATES:
        raise ValueError(f"{where}.behavior.initialState 只能是 {_FLOCK_STATES}")
    return _order(out, _MODULE_ORDER["behavior"])


def _emitter(em: Any, idx: int, warn: list[str]) -> dict:
    if not isinstance(em, dict):
        raise ValueError(f"emitters[{idx}] 不是对象")
    eid = str(em.get("id") or "").strip()
    if not _EMITTER_ID_RE.match(eid):
        raise ValueError(f"emitters[{idx}]: 非法发射器 id {em.get('id')!r}（不许空 / 空白 / 点 / 斜杠）")
    where = f"发射器「{eid}」"
    out = dict(em)
    out["id"] = eid
    if "offset" in out:
        out["offset"] = _vec3(out["offset"], f"{where}.offset")
    sub = bool(out.get("subOnly"))
    if sub:
        out["subOnly"] = True
    else:
        out.pop("subOnly", None)
    if sub and isinstance(out.get("behavior"), dict):
        raise ValueError(f"{where}: subOnly 的子发射器不能带 behavior（群体状态机永远推不动它）")
    out["appearance"] = _appearance(out.get("appearance"), where, warn)
    out["spawn"] = _spawn(out.get("spawn"), where)
    for key, fn in (("motion", _motion), ("life", _life), ("collision", _collision)):
        if isinstance(out.get(key), dict):
            out[key] = fn(out[key], where)
        elif key in out:
            raise ValueError(f"{where}.{key} 要是对象")
    if "behavior" in out:
        out["behavior"] = _behavior(out["behavior"], where)
    if isinstance(out.get("sound"), dict):
        out["sound"] = _order(dict(out["sound"]), _MODULE_ORDER["sound"])
    if not sub and not _is_num(out["spawn"].get("rate")) and not _is_num(out["spawn"].get("burst")) \
            and "behavior" not in out:
        warn.append(f"{where}: 既没有 rate 也没有 burst、也不是群体 —— 运行时一个粒子都不会发")
    return _order(out, _EMITTER_ORDER)


def _anchor(a: Any) -> dict:
    if not isinstance(a, dict) or not _is_num(a.get("x")) or not _is_num(a.get("y")):
        raise ValueError("authoring.anchor 要有画面点 x / y")
    out = dict(a)
    if "h" in out and not _is_num(out["h"]):
        raise ValueError("authoring.anchor.h 要是数（离表面高度 wu）")
    if "surface" in out and out["surface"] not in ("ground", "shell"):
        raise ValueError("authoring.anchor.surface 只能是 ground / shell")
    return _order(out, _ANCHOR_ORDER)


def normalize_effect(doc: Any, warnings: list[str] | None = None) -> dict:
    """效果资产的形状闸门：键序收束 + 硬拒不合法形状。**不改任何数值**。

    ``warnings`` 给"能存但作者大概不想要"的事（没有贴图、发射器一个粒子都不会发……）。
    """
    warn = warnings if warnings is not None else []
    if not isinstance(doc, dict):
        raise ValueError("效果文档的根不是对象")
    eid = str(doc.get("id") or "").strip()
    if not valid_id(eid):
        raise ValueError(f"非法效果 id: {doc.get('id')!r}")
    raw = doc.get("emitters")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise ValueError("emitters 要是数组")
    out: dict = dict(doc)
    out["id"] = eid
    emitters = [_emitter(e, i, warn) for i, e in enumerate(raw)]
    ids = [e["id"] for e in emitters]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        raise ValueError(f"发射器 id 重复：{sorted(dup)}")
    for e in emitters:
        oh = (e.get("collision") or {}).get("onHit")
        if isinstance(oh, dict) and oh.get("emitter") not in ids:
            raise ValueError(f"发射器「{e['id']}」的 onHit 指向不存在的发射器「{oh.get('emitter')}」")
    if not emitters:
        warn.append("这份效果还没有发射器，游戏里什么都不会画")
    out["emitters"] = emitters
    label = str(out.get("label") or "").strip()
    if label:
        out["label"] = label
    else:
        out.pop("label", None)
    au = out.get("authoring")
    if isinstance(au, dict):
        au = dict(au)
        for k in ("sceneId", "background", "note"):
            if k in au:
                s = str(au[k] or "").strip()
                if s:
                    au[k] = s
                else:
                    au.pop(k, None)
        if "anchor" in au:
            au["anchor"] = _anchor(au["anchor"])
        if au:
            out["authoring"] = _order(au, _AUTHORING_ORDER)
        else:
            out.pop("authoring", None)
    elif "authoring" in out:
        out.pop("authoring", None)
    return _order(out, _ORDER)


# ---------------------------------------------------------------------------
# 磁盘操作
# ---------------------------------------------------------------------------

def list_assets() -> list[dict]:
    """目录清单（按 id 排序）。坏 JSON 也列出来（``error`` 字段），别让一个坏文件藏起整批。"""
    out: list[dict] = []
    if not VFX_DIR.is_dir():
        return out
    for p in sorted(VFX_DIR.glob("*.json")):
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
        ems = doc.get("emitters") if isinstance(doc.get("emitters"), list) else []
        au = doc.get("authoring") if isinstance(doc.get("authoring"), dict) else {}
        row.update({
            "label": str(doc.get("label") or ""),
            "emitters": [str(e.get("id") or "") for e in ems if isinstance(e, dict)],
            "flock": any(isinstance(e, dict) and isinstance(e.get("behavior"), dict) for e in ems),
            "sceneId": str(au.get("sceneId") or ""),
            "background": str(au.get("background") or ""),
            "idMismatch": str(doc.get("id") or "") != p.stem,
        })
        out.append(row)
    return out


def load_asset(eid: str) -> dict | None:
    p = asset_path(eid)
    if not p.is_file():
        return None
    doc = json.loads(p.read_bytes().decode("utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{p.name}: 根不是对象")
    return doc


def save_asset(doc: dict) -> tuple[Path, dict, list[str]]:
    """归一化 → 原子写盘。返回 (路径, 落盘形, 告警)。"""
    warn: list[str] = []
    norm = normalize_effect(doc, warn)
    p = asset_path(norm["id"])
    atomic_write(p, dumps(norm))
    return p, norm, warn


def delete_asset(eid: str) -> bool:
    p = asset_path(eid)
    if not p.is_file():
        return False
    retry_transient(os.unlink, p)
    return True


def rename_asset(old: str, new: str) -> Path:
    """改名 = 改文件名 + 改内部 id。目标已存在则拒绝（不静默覆盖别人的资产）。"""
    src = asset_path(old)
    dst = asset_path(new)
    if not src.is_file():
        raise FileNotFoundError(f"效果 {old!r} 不存在")
    if dst.exists():
        raise FileExistsError(f"效果 {new!r} 已存在")
    doc = load_asset(old) or {}
    doc["id"] = new
    atomic_write(dst, dumps(normalize_effect(doc)))
    retry_transient(os.unlink, src)
    return dst


def duplicate_asset(src_id: str, new_id: str) -> tuple[Path, dict]:
    doc = load_asset(src_id)
    if doc is None:
        raise FileNotFoundError(f"效果 {src_id!r} 不存在")
    if asset_path(new_id).exists():
        raise FileExistsError(f"效果 {new_id!r} 已存在")
    doc = json.loads(json.dumps(doc, ensure_ascii=False))
    doc["id"] = new_id
    p, norm, _w = save_asset(doc)
    return p, norm


def unique_id(base: str, taken: Any = None) -> str:
    """撞名追 ``_2`` ``_3``；``taken`` 缺省 = 目录里的现有 id。"""
    used = set(taken) if taken is not None else {r["id"] for r in list_assets()}
    if base not in used:
        return base
    n = 2
    while f"{base}_{n}" in used:
        n += 1
    return f"{base}_{n}"


def new_effect(eid: str, label: str = "", scene_id: str = "", background: str = "") -> dict:
    """一份能直接跑的空效果：一个最小发射器（有池、有速率、有尺寸），作者从它改起。"""
    doc: dict = {
        "id": eid,
        "emitters": [{
            "id": "main",
            "appearance": {"image": "/resources/runtime/images/vfx/dust.png", "sizeWu": 6,
                           "alphaOverLife": [[0, 0], [0.2, 1], [1, 0]], "lit": True},
            "spawn": {"max": 40, "rate": 8, "shape": {"kind": "sphere", "radius": 20}, "speed": [10, 30]},
            "motion": {"drag": 0.6},
            "life": {"seconds": [1.5, 3]},
        }],
    }
    if label.strip():
        doc["label"] = label.strip()
    au: dict = {}
    if scene_id.strip():
        au["sceneId"] = scene_id.strip()
    if background.strip():
        au["background"] = background.strip()
    if au:
        doc["authoring"] = au
    return normalize_effect(doc)
