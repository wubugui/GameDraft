"""粒子布置库 ``public/assets/data/vfx_placements.json`` 的读取与形状闸门（编辑器 / 校验器 / 粒子工作台共用这一份）。

**三件正交的东西**（2026-09-13 制作人定）：

* 效果资产 ``assets/data/vfx/<id>.json``：只有效果本身（发射器），**不绑场景、不绑时段**；
* 布置库（本文件管的这份）：某个效果放在**哪个场景、哪套时段外观**里、锚点在哪、发射区域 / 范围区域怎么圈；
* 刺激场：运行时事件，不落盘。

布置按「场景 × 时段外观」各配各的，**互不继承、没配就没有**：

.. code-block:: json

    {
      "_comment": "…",
      "scenes": {
        "跑马梁": {
          "base": [ {"id": "纸钱_山顶", "effect": "paper_money", "anchor": {...}, "area": [...], "confine": {...}} ],
          "variants": { "夜": [ ... ] }
        }
      }
    }

``base`` = 场景顶层外观（没单列成时段变体的那些时段），``variants[<时段 id>]`` = ``timeVariants[<时段 id>]``
那套外观。运行时取哪一份与 ``resolveSceneAppearance(scene, phase).phase`` 同一个判据（空串 = base）。

**唯一写入者是粒子工作台**（``tools/vfx_workbench``）；主编辑器只读（场景画布上显示区域、playVfx /
条件叶的实例候选、校验）——没有脏桶、不进 Save All。两个写入者的下场是互删。

本模块零 Qt 依赖。落盘口径与主编辑器一致：``ensure_ascii=False`` + 2 空格缩进 + 末尾换行 + 不排序键 + LF。
``normalize_*`` **只收束键序、硬拒不合法形状，绝不改数值**（int 不许漂成 float）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from .vfx_confine import is_polygon

LIBRARY_PARTS = ("public", "assets", "data", "vfx_placements.json")
#: 游戏侧 URL（与 ``src/core/projectPaths.ts`` 的 ``vfxPlacements`` 同值）
LIBRARY_URL = "/assets/data/vfx_placements.json"
#: base 在 API / 运行时里用空串表示（与 ``ResolvedSceneAppearance.phase`` 同口径）
BASE = ""

_COMMENT = (
    "世界空间粒子的布置库。效果资产（assets/data/vfx/）只有效果本身，不绑场景、不绑时段；"
    "这里记它放在哪个场景、哪套时段外观里。base = 场景顶层外观，variants[时段] = timeVariants[时段] 那套外观，"
    "各配各的、互不继承、没配就没有。唯一写入者是粒子工作台（tools/vfx_workbench），主编辑器只读。"
)

_TOP_ORDER = ("_comment", "scenes")
_SCENE_ORDER = ("base", "variants")
#: 实例键序（与 ``src/data/types.ts`` 的 ``VfxInstanceDef`` 逐字同序）
INSTANCE_ORDER = ("id", "effect", "anchor", "seed", "countScale", "autoStart", "conditions", "area", "confine")
_ANCHOR_ORDER = ("x", "y", "h", "surface")
_CONFINE_ORDER = ("area", "feather", "ceiling")
_SURFACES = ("ground", "shell")


def library_path(project_root: Path) -> Path:
    return Path(project_root).joinpath(*LIBRARY_PARTS)


def empty_library() -> dict:
    return {"_comment": _COMMENT, "scenes": {}}


def dumps(doc: Any) -> bytes:
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def load_library(project_root: Path) -> tuple[dict, str]:
    """读盘上的布置库。返回 ``(文档, 错误)``：文件不存在 = 空库、无错误；读不懂 = 空库 + 错误文本
    （调用方决定怎么报——校验器报 error，编辑器画布只是什么都不画）。"""
    p = library_path(project_root)
    if not p.is_file():
        return empty_library(), ""
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as exc:
        return empty_library(), f"vfx_placements.json 读不懂（{type(exc).__name__}: {exc}）"
    if not isinstance(doc, dict):
        return empty_library(), "vfx_placements.json 的根不是对象"
    if not isinstance(doc.get("scenes"), dict):
        return empty_library(), "vfx_placements.json 缺 scenes 表"
    return doc, ""


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

def scene_entry(lib: dict, scene_id: str) -> dict:
    scenes = lib.get("scenes") if isinstance(lib, dict) else None
    ent = scenes.get(scene_id) if isinstance(scenes, dict) else None
    return ent if isinstance(ent, dict) else {}


def rows_for(lib: dict, scene_id: str, phase: str) -> list[dict]:
    """某场景某套时段外观的实例（``phase`` 空串 = base）。只返回 dict 行，原对象不拷贝。"""
    ent = scene_entry(lib, scene_id)
    if phase == BASE:
        raw = ent.get("base")
    else:
        variants = ent.get("variants")
        raw = variants.get(phase) if isinstance(variants, dict) else None
    return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []


def phases_in_library(lib: dict, scene_id: str) -> list[str]:
    """布置库里这个场景配过的时段外观键（base 在前，其余按库里的顺序）。"""
    ent = scene_entry(lib, scene_id)
    out: list[str] = []
    if isinstance(ent.get("base"), list):
        out.append(BASE)
    variants = ent.get("variants")
    if isinstance(variants, dict):
        out.extend(str(k) for k in variants.keys())
    return out


def scene_phase_keys(scene_doc: dict | None) -> list[str]:
    """一个场景**能有**的时段外观键：base + ``timeVariants`` 的键（按场景 JSON 里的顺序）。"""
    out = [BASE]
    tv = (scene_doc or {}).get("timeVariants")
    if isinstance(tv, dict):
        out.extend(str(k) for k in tv.keys())
    return out


def iter_rows(lib: dict) -> Iterator[tuple[str, str, int, dict]]:
    """``(场景 id, 时段键, 下标, 行)``，覆盖整个库。"""
    scenes = lib.get("scenes") if isinstance(lib, dict) else None
    if not isinstance(scenes, dict):
        return
    for sid, _ent in scenes.items():
        for ph in phases_in_library(lib, str(sid)):
            for i, row in enumerate(rows_for(lib, str(sid), ph)):
                yield str(sid), ph, i, row


def instance_ids_for_scene(lib: dict, scene_id: str) -> list[str]:
    """本场景各时段外观里出现过的实例 id（去重、首次出现序）。

    ``playVfx {instanceId}`` 与条件叶 ``vfx`` 按 id 找**当前在场**的实例：白天和夜里各摆一份同 id 的，
    动作 / 条件两个时段都认；只在夜里摆的，白天里找不到（运行时 log 一句，条件叶读到「不在场」）。"""
    seen: dict[str, None] = {}
    for ph in phases_in_library(lib, scene_id):
        for row in rows_for(lib, scene_id, ph):
            iid = str(row.get("id") or "").strip()
            if iid:
                seen.setdefault(iid, None)
    return list(seen)


def resolve_appearance_phase(scene_doc: dict | None, time_phase: str | None) -> str:
    """某个**真实时段**下场景用哪套时段外观（``BASE`` = 基底）。

    与 ``src/utils/sceneAppearance.ts`` 的 ``resolveSceneAppearance(scene, phase).phase`` 逐条同判据：
    场景 ``dayNight.enabled === true`` 且 ``timeVariants[时段]`` 存在（空对象也算存在——TS 里 ``{}`` 为真）
    才用那套，否则一律基底。时段为空（编辑器画布「全部时段」）= 基底。"""
    sc = scene_doc if isinstance(scene_doc, dict) else {}
    tp = str(time_phase or "").strip()
    if not tp:
        return BASE
    dn = sc.get("dayNight")
    if not (isinstance(dn, dict) and dn.get("enabled") is True):
        return BASE
    tv = sc.get("timeVariants")
    v = tv.get(tp) if isinstance(tv, dict) else None
    # JS 真值：只有 undefined / null / false / 0 / '' 为假（Python 的空 dict / 空 list 为假，这里不能照搬）
    js_falsy = v is None or v is False or v == "" or (
        isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0)
    return BASE if js_falsy else tp


def phase_label(phase: str, scene_doc: dict | None, day_night_phases: list[dict] | None) -> str:
    """给人看的时段外观名。base 列出它实际覆盖哪些时段（没开日夜 = 全天）。"""
    labels = {str(p.get("id")): str(p.get("label") or p.get("id")) for p in (day_night_phases or [])
              if isinstance(p, dict) and p.get("id")}
    if phase != BASE:
        lab = labels.get(phase)
        return f"{lab}（{phase}）" if lab and lab != phase else phase
    sc = scene_doc or {}
    if not (isinstance(sc.get("dayNight"), dict) and sc["dayNight"].get("enabled") is True):
        return "基底（全天：本场景没开日夜）"
    tv = sc.get("timeVariants") if isinstance(sc.get("timeVariants"), dict) else {}
    rest = [labels.get(pid, pid) for pid in labels if pid not in tv]
    return f"基底（{'、'.join(rest)}）" if rest else "基底（每个时段都单列了外观，基底永远用不到）"


# ---------------------------------------------------------------------------
# 形状闸门
# ---------------------------------------------------------------------------

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _order(d: dict, keys: tuple[str, ...]) -> dict:
    """已知键按序在前，未知键原样透传到末尾（往返零丢失）。"""
    out: dict = {k: d[k] for k in keys if k in d}
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


def normalize_instance(row: Any, where: str) -> dict:
    """一条布置实例的形状闸门。``where`` 用在报错里（例：``跑马梁 · 夜 · 纸钱_山顶``）。"""
    if not isinstance(row, dict):
        raise ValueError(f"{where}: 实例不是对象")
    out = dict(row)
    iid = str(out.get("id") or "").strip()
    if not iid:
        raise ValueError(f"{where}: 实例缺 id（运行时按 id 建表，空 id 整条跳过）")
    out["id"] = iid
    eff = str(out.get("effect") or "").strip()
    if not eff:
        raise ValueError(f"{where}: 实例「{iid}」缺 effect")
    out["effect"] = eff
    if "timePhases" in out:
        raise ValueError(
            f"{where}: 实例「{iid}」带着 timePhases——布置已按时段外观分开放（base / variants），"
            "要只在夜里出现就只摆在夜那一份里")
    a = out.get("anchor")
    if not isinstance(a, dict) or not _is_num(a.get("x")) or not _is_num(a.get("y")):
        raise ValueError(f"{where}: 实例「{iid}」的 anchor 要有画面点 x / y（场景坐标 wu）")
    a = dict(a)
    if "h" in a and not _is_num(a["h"]):
        raise ValueError(f"{where}: 实例「{iid}」的 anchor.h 要是数（离表面高度 wu）")
    if "surface" in a and a["surface"] not in _SURFACES:
        raise ValueError(f"{where}: 实例「{iid}」的 anchor.surface 只能是 ground / shell")
    out["anchor"] = _order(a, _ANCHOR_ORDER)
    if "seed" in out and not _is_num(out["seed"]):
        raise ValueError(f"{where}: 实例「{iid}」的 seed 要是数")
    if "countScale" in out and (not _is_num(out["countScale"]) or float(out["countScale"]) <= 0):
        raise ValueError(f"{where}: 实例「{iid}」的 countScale 要是 > 0 的数")
    if "autoStart" in out and not isinstance(out["autoStart"], bool):
        raise ValueError(f"{where}: 实例「{iid}」的 autoStart 要是布尔")
    if "conditions" in out and not isinstance(out["conditions"], list):
        raise ValueError(f"{where}: 实例「{iid}」的 conditions 要是数组")
    if "area" in out and not is_polygon(out["area"]):
        raise ValueError(f"{where}: 实例「{iid}」的发射区域 area 要是 ≥3 个 [x, y] 的多边形")
    if "confine" in out:
        c = out["confine"]
        if not isinstance(c, dict):
            raise ValueError(f"{where}: 实例「{iid}」的 confine 要是对象")
        c = dict(c)
        if "area" in c and not is_polygon(c["area"]):
            raise ValueError(f"{where}: 实例「{iid}」的范围区域 confine.area 要是 ≥3 个 [x, y] 的多边形")
        if "feather" in c and (not _is_num(c["feather"]) or float(c["feather"]) < 0):
            raise ValueError(f"{where}: 实例「{iid}」的 confine.feather 要是 ≥ 0 的数（边带宽 wu）")
        if "ceiling" in c and (not _is_num(c["ceiling"]) or float(c["ceiling"]) <= 0):
            raise ValueError(f"{where}: 实例「{iid}」的 confine.ceiling 要是 > 0 的数（限高 wu）")
        if "area" not in c and "area" not in out:
            raise ValueError(
                f"{where}: 实例「{iid}」限定了粒子区域（confine）却既没有范围区域也没有发射区域——运行时整条忽略")
        out["confine"] = _order(c, _CONFINE_ORDER)
    return _order(out, INSTANCE_ORDER)


def _normalize_rows(raw: Any, where: str) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError(f"{where}: 要是实例数组")
    rows = [normalize_instance(r, where) for r in raw]
    ids = [r["id"] for r in rows]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"{where}: 实例 id 重复 {dup}（同一场景同一套时段外观里 id 必须唯一）")
    return rows


def normalize_library(doc: Any) -> dict:
    """整份布置库的形状闸门。空的时段 / 空场景整条剥掉（没配 = 没有，不留空壳）。"""
    if not isinstance(doc, dict):
        raise ValueError("布置库的根不是对象")
    scenes = doc.get("scenes")
    if scenes is None:
        scenes = {}
    if not isinstance(scenes, dict):
        raise ValueError("布置库的 scenes 要是对象（键 = 场景 id）")
    out_scenes: dict = {}
    for sid, ent in scenes.items():
        sid = str(sid)
        if not sid.strip():
            raise ValueError("布置库里有空的场景 id")
        if not isinstance(ent, dict):
            raise ValueError(f"{sid}: 要是 {{base, variants}} 对象")
        e = dict(ent)
        if "base" in e:
            rows = _normalize_rows(e["base"], f"{sid} · 基底")
            if rows:
                e["base"] = rows
            else:
                e.pop("base")
        if "variants" in e:
            vs = e["variants"]
            if not isinstance(vs, dict):
                raise ValueError(f"{sid}: variants 要是对象（键 = 时段 id）")
            nv: dict = {}
            for ph, raw in vs.items():
                ph = str(ph)
                if not ph.strip():
                    raise ValueError(f"{sid}: variants 里有空的时段 id（基底写在 base 里）")
                rows = _normalize_rows(raw, f"{sid} · {ph}")
                if rows:
                    nv[ph] = rows
            if nv:
                e["variants"] = nv
            else:
                e.pop("variants")
        e = _order(e, _SCENE_ORDER)
        if "base" in e or "variants" in e or any(k not in _SCENE_ORDER for k in e):
            out_scenes[sid] = e
    out = dict(doc)
    out["_comment"] = str(doc.get("_comment") or _COMMENT)
    out["scenes"] = out_scenes
    return _order(out, _TOP_ORDER)


def set_rows(lib: dict, scene_id: str, phase: str, rows: list[dict]) -> dict:
    """返回替换了某场景某时段外观实例表的**新**库（不改入参）。空表 = 删掉那一份。"""
    new = json.loads(json.dumps(lib, ensure_ascii=False)) if isinstance(lib, dict) else empty_library()
    scenes = new.setdefault("scenes", {})
    ent = scenes.setdefault(scene_id, {})
    if phase == BASE:
        if rows:
            ent["base"] = rows
        else:
            ent.pop("base", None)
    else:
        vs = ent.setdefault("variants", {})
        if rows:
            vs[phase] = rows
        else:
            vs.pop(phase, None)
        if not vs:
            ent.pop("variants", None)
    if not ent:
        scenes.pop(scene_id, None)
    return new
