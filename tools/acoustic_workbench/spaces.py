# -*- coding: utf-8 -*-
"""声学空间库 ``public/assets/data/acoustic_spaces.json`` 的读写。**本工作台是它唯一的写入者。**

v2 形状（2026-09-08，见 ``src/audio/acousticSpace.ts`` 文件头）：几何一律 M-world wu，
``distanceScale`` 是每空间的全局距离缩放，``authoring.sceneId`` 记它在哪个场景的 3D 展开里摆的。

写盘：整份库原子写（tmp + replace），旧文件留 ``.bak``；LF、2 空格、不排序键、末尾换行。
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPACES_PATH = ROOT / "public" / "assets" / "data" / "acoustic_spaces.json"
SCENES_DIR = ROOT / "public" / "assets" / "scenes"

DEFAULT_WU_PER_METER = 88
DEFAULT_EAR_HEIGHT_WU = 141
#: 运行时听者能绑到谁（与 src/audio/acousticSpace.ts AcousticListenerBinding 同口径）
LISTENER_MODES = {"player", "camera", "entity", "fixed"}
DEFAULT_COMMENT = (
    "声学空间库(v2)。几何一律 M-world wu(原点画面中心、Y 朝上、XZ 地面,与灯位/轨迹同一坐标系);"
    "计算时 米 = wu / 88 × distanceScale。distanceScale 是每空间的全局距离缩放:反射面贴着画里的崖壁摆,"
    "再把整个空间等比放大。authoring.sceneId 是它在哪个场景里摆的(逻辑上一份几何一个空间)。"
    "唯一写入者是声学工作台(tools/acoustic_workbench)。场景用 acousticSpace 字段引用这里的 key。"
)

_ID_BAD = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")


def valid_id(s: str) -> bool:
    """空间 id 是 JSON 键，也会出现在场景 JSON 的 acousticSpace 里：不许路径字符、不许首尾空白。"""
    if not isinstance(s, str) or not s or len(s) > 120:
        return False
    if s != s.strip() or s.startswith("."):
        return False
    return _ID_BAD.search(s) is None


def _num(v, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f and abs(f) != float("inf") else default


def normalize_def(raw: dict) -> dict:
    """把一份工作态定义收成落盘形（键序固定、缺省不落、非法值报错）。

    与运行时 ``AudioManager.loadAcousticSpaces`` 的"结构合法"口径同源：``listener`` 对象 +
    ``reflectors`` 数组；反射面 a/b 二元、height>0、absorb/rough 在 [0,1]。
    """
    if not isinstance(raw, dict):
        raise ValueError("空间定义必须是对象")
    lis = raw.get("listener")
    if not isinstance(lis, dict):
        raise ValueError("缺 listener")
    refl = raw.get("reflectors")
    if not isinstance(refl, list):
        raise ValueError("reflectors 必须是数组")
    out: dict = {}
    label = raw.get("label")
    if isinstance(label, str) and label.strip():
        out["label"] = label.strip()
    au = raw.get("authoring")
    if isinstance(au, dict):
        sid = str(au.get("sceneId") or "").strip()
        a: dict = {"sceneId": sid}
        bg = str(au.get("background") or "").strip()
        if bg:
            a["background"] = bg
        out["authoring"] = a
    ds = _num(raw.get("distanceScale", 1), 0)
    if ds <= 0:
        raise ValueError("distanceScale 必须 > 0")
    out["distanceScale"] = _tidy(ds)
    ear = _num(raw.get("earHeight", DEFAULT_EAR_HEIGHT_WU), -1)
    if ear < 0:
        raise ValueError("earHeight 不能为负")
    out["earHeight"] = _tidy(ear)
    out["listener"] = _point(lis)
    lb = raw.get("listenerBinding")
    if isinstance(lb, dict):
        mode = str(lb.get("mode") or "").strip()
        if mode not in LISTENER_MODES:
            raise ValueError(f"listenerBinding.mode 必须是 {sorted(LISTENER_MODES)} 之一")
        b: dict = {"mode": mode}
        ent = str(lb.get("entityId") or "").strip()
        # entity 没选 NPC 不算坏数据：运行时会回落到玩家并回报 targetMissing；工作台里黄字提醒。
        # 这里若拒绝，作者切到「跟指定 NPC」的那一刻起每次发布 / 保存都会失败，而且失败得很隐蔽。
        if mode == "entity" and ent:
            b["entityId"] = ent
        out["listenerBinding"] = b
    # 有位置的试听声源：v3 是数组；v2 的单个 source（地面点）迁成第一条
    srcs_raw = raw.get("sources")
    if not isinstance(srcs_raw, list) and isinstance(raw.get("source"), dict):
        srcs_raw = [{"id": "声源", **raw["source"]}]
    if isinstance(srcs_raw, list):
        srcs = []
        seen: set[str] = set()
        for i, sp in enumerate(srcs_raw):
            if not isinstance(sp, dict):
                raise ValueError(f"sources[{i}] 不是对象")
            sid_ = str(sp.get("id") or "").strip() or f"声源{i + 1}"
            if sid_ in seen:
                raise ValueError(f"sources 里 id「{sid_}」重复")
            seen.add(sid_)
            one: dict = {"id": sid_}
            lab = sp.get("label")
            if isinstance(lab, str) and lab.strip():
                one["label"] = lab.strip()
            one.update(_point(sp))
            if sp.get("height") is not None:
                hh = _num(sp.get("height"), -1)
                if hh < 0:
                    raise ValueError(f"sources[{i}] 的 height 不能为负")
                one["height"] = _tidy(hh)
            srcs.append(one)
        if srcs:
            out["sources"] = srcs
    dr = raw.get("direct")
    if isinstance(dr, dict):
        d2: dict = {}
        for key, lo in (("refDistanceM", 0.01), ("rolloff", 0.0), ("maxDistanceM", 0.01), ("panWidth", 0.0)):
            if dr.get(key) is not None:
                v = _num(dr.get(key), -1)
                if v < lo or (key == "panWidth" and v > 1):
                    raise ValueError(f"direct.{key} 非法")
                d2[key] = _tidy(v)
        if d2:
            out["direct"] = d2
    rs = []
    for i, r in enumerate(refl):
        if not isinstance(r, dict):
            raise ValueError(f"reflectors[{i}] 不是对象")
        a, b = r.get("a"), r.get("b")
        if not (isinstance(a, list) and len(a) == 2 and isinstance(b, list) and len(b) == 2):
            raise ValueError(f"reflectors[{i}] 的 a/b 必须是二元组")
        h = _num(r.get("height"), 0)
        if h <= 0:
            raise ValueError(f"reflectors[{i}] 的 height 必须 > 0")
        ab = _num(r.get("absorb", 0.1), -1)
        rg = _num(r.get("rough", 0.4), -1)
        if not (0 <= ab <= 1) or not (0 <= rg <= 1):
            raise ValueError(f"reflectors[{i}] 的 absorb/rough 必须在 0..1")
        nr: dict = {}
        rid = r.get("id")
        if isinstance(rid, str) and rid.strip():
            nr["id"] = rid.strip()
        nr["a"] = [_tidy(_num(a[0])), _tidy(_num(a[1]))]
        nr["b"] = [_tidy(_num(b[0])), _tidy(_num(b[1]))]
        if abs(nr["a"][0] - nr["b"][0]) < 1e-6 and abs(nr["a"][1] - nr["b"][1]) < 1e-6:
            raise ValueError(f"reflectors[{i}] 两端重合，镜像退化")
        nr["height"] = _tidy(h)
        nr["absorb"] = _tidy(ab)
        nr["rough"] = _tidy(rg)
        if r.get("y") is not None:
            nr["y"] = _tidy(_num(r.get("y")))
        if r.get("tiltDeg") is not None:
            nr["tiltDeg"] = _tidy(_num(r.get("tiltDeg")))
        rs.append(nr)
    out["reflectors"] = rs
    order = raw.get("order")
    if order is not None:
        out["order"] = 2 if _num(order, 2) >= 2 else 1
    tail = raw.get("tail")
    if isinstance(tail, dict):
        out["tail"] = {"seconds": _tidy(max(0.0, _num(tail.get("seconds"), 0))),
                       "gain": _tidy(max(0.0, _num(tail.get("gain"), 0)))}
    air = raw.get("air")
    if isinstance(air, dict):
        a2: dict = {}
        if air.get("tempC") is not None:
            a2["tempC"] = _tidy(_num(air.get("tempC"), 5))
        if air.get("humidity") is not None:
            a2["humidity"] = _tidy(_num(air.get("humidity"), 70))
        out["air"] = a2
    if raw.get("width") is not None:
        out["width"] = _tidy(min(1.0, max(0.0, _num(raw.get("width"), 0.8))))
    if raw.get("occlusion") is not None:
        out["occlusion"] = bool(raw.get("occlusion"))
    return out


def _point(p: dict) -> dict:
    out = {"x": _tidy(_num(p.get("x"))), "z": _tidy(_num(p.get("z")))}
    if p.get("y") is not None:
        out["y"] = _tidy(_num(p.get("y")))
    return out


def _tidy(v: float):
    """整数就写整数（int 不得漂成 float），否则保留 3 位小数——wu 的千分之一没有意义。"""
    r = round(float(v), 3)
    if abs(r - round(r)) < 1e-9:
        return int(round(r))
    return r


# ---------------------------------------------------------------------------
# 库
# ---------------------------------------------------------------------------

def load_library(path: Path = SPACES_PATH) -> dict:
    if not path.exists():
        return {"_comment": DEFAULT_COMMENT, "spaces": {}}
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("spaces"), dict):
        raise ValueError(f"{path.name} 不是 {{spaces: {{...}}}} 形状")
    return doc


def write_library(doc: dict, path: Path = SPACES_PATH) -> Path:
    """原子写整份库；旧文件留 .bak。LF、2 空格、不排序、末尾换行。"""
    out = {"_comment": doc.get("_comment") or DEFAULT_COMMENT, "spaces": doc.get("spaces") or {}}
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            shutil.copyfile(path, path.with_suffix(path.suffix + ".bak"))
        except OSError:
            pass
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    try:
        from tools.atomic_io import retry_transient
        retry_transient(os.replace, tmp, path)
    except ImportError:
        os.replace(tmp, path)
    return path


def scene_bindings(scenes_dir: Path = SCENES_DIR) -> dict[str, list[str]]:
    """空间 id → 绑定它的场景 id 列表（读场景 JSON，只读）。"""
    out: dict[str, list[str]] = {}
    for p in sorted(scenes_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        sp = d.get("acousticSpace") if isinstance(d, dict) else None
        if isinstance(sp, str) and sp.strip():
            out.setdefault(sp.strip(), []).append(str(d.get("id") or p.stem))
    return out


def list_spaces(path: Path = SPACES_PATH) -> list[dict]:
    lib = load_library(path)
    bound = scene_bindings()
    rows = []
    for sid, sp in lib["spaces"].items():
        au = sp.get("authoring") if isinstance(sp, dict) else None
        rows.append({
            "id": sid,
            "label": (sp.get("label") if isinstance(sp, dict) else "") or "",
            "sceneId": (au or {}).get("sceneId", "") if isinstance(au, dict) else "",
            "background": (au or {}).get("background", "") if isinstance(au, dict) else "",
            "reflectors": len(sp.get("reflectors") or []) if isinstance(sp, dict) else 0,
            "distanceScale": sp.get("distanceScale", 1) if isinstance(sp, dict) else 1,
            "boundBy": bound.get(sid, []),
            "legacy": isinstance(sp, dict) and ("anchor" in sp or "wuPerMeter" in sp),
        })
    return rows


def get_space(sid: str, path: Path = SPACES_PATH) -> dict | None:
    lib = load_library(path)
    sp = lib["spaces"].get(sid)
    return sp if isinstance(sp, dict) else None


def save_space(sid: str, definition: dict, path: Path = SPACES_PATH) -> tuple[Path, dict]:
    if not valid_id(sid):
        raise ValueError(f"非法空间 id: {sid!r}")
    norm = normalize_def(definition)
    lib = load_library(path)
    lib["spaces"][sid] = norm
    return write_library(lib, path), norm


def new_space_def(scene_id: str, background: str = "", label: str = "") -> dict:
    """一个空白空间：没有反射面（作者在 3D 里自己摆），听者在原点地面。"""
    d = {
        "authoring": {"sceneId": scene_id, **({"background": background} if background else {})},
        "distanceScale": 1,
        "earHeight": DEFAULT_EAR_HEIGHT_WU,
        "listener": {"x": 0, "z": 0, "y": 0},
        # 一律写显式：落盘的数据自己说清耳朵跟谁，别靠运行时缺省
        "listenerBinding": {"mode": "player"},
        "reflectors": [],
        "order": 2,
        "tail": {"seconds": 2, "gain": 0.12},
        "air": {"tempC": 5},
        "width": 0.8,
        "occlusion": True,
    }
    if label:
        d["label"] = label
    return d


def create_space(sid: str, scene_id: str, background: str = "", label: str = "",
                 path: Path = SPACES_PATH) -> dict:
    if not valid_id(sid):
        raise ValueError(f"非法空间 id: {sid!r}")
    lib = load_library(path)
    if sid in lib["spaces"]:
        raise FileExistsError(f"空间已存在: {sid}")
    d = new_space_def(scene_id, background, label)
    # 新空间的听者放在出生点脚下，落笔就在人站的地方
    lib["spaces"][sid] = d
    write_library(lib, path)
    return d


def delete_space(sid: str, path: Path = SPACES_PATH) -> bool:
    lib = load_library(path)
    if sid not in lib["spaces"]:
        return False
    del lib["spaces"][sid]
    write_library(lib, path)
    return True


def rename_space(sid: str, to: str, path: Path = SPACES_PATH) -> None:
    """改名。**绑定它的场景不跟改**（场景 JSON 只有主编辑器一个写入者），所以有绑定就拒绝。"""
    if not valid_id(to):
        raise ValueError(f"非法空间 id: {to!r}")
    lib = load_library(path)
    if sid not in lib["spaces"]:
        raise FileNotFoundError(f"空间不存在: {sid}")
    if to in lib["spaces"]:
        raise FileExistsError(f"空间已存在: {to}")
    bound = scene_bindings().get(sid) or []
    if bound:
        raise ValueError(f"「{sid}」被场景 {', '.join(bound)} 绑定着；先在主编辑器里改绑定，或用「复制」")
    new_spaces = {}
    for k, v in lib["spaces"].items():
        new_spaces[to if k == sid else k] = v
    lib["spaces"] = new_spaces
    write_library(lib, path)


def duplicate_space(sid: str, to: str, path: Path = SPACES_PATH) -> dict:
    if not valid_id(to):
        raise ValueError(f"非法空间 id: {to!r}")
    lib = load_library(path)
    src = lib["spaces"].get(sid)
    if not isinstance(src, dict):
        raise FileNotFoundError(f"空间不存在: {sid}")
    if to in lib["spaces"]:
        raise FileExistsError(f"空间已存在: {to}")
    d = json.loads(json.dumps(src))
    lib["spaces"][to] = d
    write_library(lib, path)
    return d


def unique_id(base: str, existing: list[str] | set[str]) -> str:
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"
