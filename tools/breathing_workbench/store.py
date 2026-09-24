# -*- coding: utf-8 -*-
"""呼吸工作台的盘面读写:呼吸图资产 ``public/assets/data/breathing/<id>.json``。

**本工作台是呼吸图资产唯一的写入者**(主编辑器只读显示;剧情里用哪张图、什么时候演什么,写在对话图 / 叙事图自己的动作里)。

一份资产里只有两样归工作台改:

* ``params``:表演参数预设(键、名称、范围的唯一真相源是 ``src/data/breathingParams.json``);
* ``label``:给人看的名字。

``size`` / ``layers`` / ``fields`` / ``rig`` 是离线拆层工具烘出来的(分层图、位移场、骨架常数、位移上限),
**工作台不改**——保存时这几块必须与盘上逐值相同,不同就拒绝(改了它们画面就不再和位移场对得上)。

落盘口径 ``ensure_ascii=False`` + 2 空格 + 末尾换行 + 不排序键 + LF;就位走 ``tools.atomic_io.retry_transient``
(Windows 上 ``os.replace`` 不原子)。数值保真:页面是 JS,``2.0`` 进去出来是 ``2``,保存时对「与盘上数值相等」的数
按盘上的表示回写(与燃烧台同一条规则)。

两个根可以重定向(测试与 ``--selftest`` 指到临时工程,绝不碰真库):``PROJECT``(读)与 ``DATA``(写)。
"""
from __future__ import annotations

import json
import os
import re
import threading
from functools import wraps
from pathlib import Path
from typing import Any

from tools.atomic_io import retry_transient

ROOT = Path(__file__).resolve().parents[2]
PROJECT: Path = ROOT
DATA: Path = ROOT

SCHEMA_REL = "src/data/breathingParams.json"
BREATHING_REL = "public/assets/data/breathing"

WRITE_LOCK = threading.RLock()
UNCHECKED = object()
_ID_RE = re.compile(r"^[A-Za-z0-9_\-一-鿿]{1,120}$")
#: 烘焙产物:工作台不许改的块
BAKED_KEYS = ("size", "layers", "fields", "rig")
KEY_ORDER = ("id", "label", "size", "layers", "fields", "rig", "params")


def serialized(fn):
    @wraps(fn)
    def wrapped(*a, **k):
        with WRITE_LOCK:
            return fn(*a, **k)
    return wrapped


def breathing_dir() -> Path:
    return DATA / BREATHING_REL


def is_real_data() -> bool:
    try:
        return DATA.resolve() == ROOT.resolve()
    except OSError:
        return False


def valid_id(bid: Any) -> bool:
    return isinstance(bid, str) and bool(_ID_RE.match(bid))


def asset_path(bid: str) -> Path:
    if not valid_id(bid):
        raise ValueError(f"呼吸图 id 不合法:{bid!r}(只许字母数字 _ - 与汉字)")
    return breathing_dir() / f"{bid}.json"


def dumps(doc: dict) -> bytes:
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, path)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _preserve_numbers(new: Any, old: Any) -> Any:
    if isinstance(new, dict) and isinstance(old, dict):
        for k, v in new.items():
            if k in old:
                new[k] = _preserve_numbers(v, old[k])
        return new
    if isinstance(new, list) and isinstance(old, list):
        for i, v in enumerate(new):
            if i < len(old):
                new[i] = _preserve_numbers(v, old[i])
        return new
    if _is_num(new) and _is_num(old) and float(new) == float(old) and type(new) is not type(old):
        return old
    return new


# ---------------------------------------------------------------------------- 参数表

def schema() -> dict:
    """``src/data/breathingParams.json`` 原文(运行时、工作台页面、主编辑器共用的那一份)。"""
    return json.loads((PROJECT / SCHEMA_REL).read_bytes().decode("utf-8"))


def param_defs() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for g in schema().get("groups") or []:
        for p in g.get("params") or []:
            out[str(p["key"])] = p
    return out


# ---------------------------------------------------------------------------- 资产

def list_assets() -> list[dict]:
    out: list[dict] = []
    d = breathing_dir()
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        row: dict = {"id": p.stem}
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
        size = doc.get("size") if isinstance(doc.get("size"), list) else None
        row.update({"label": str(doc.get("label") or ""), "size": size,
                    "base": str((doc.get("layers") or {}).get("base") or "") if isinstance(doc.get("layers"), dict) else "",
                    "idMismatch": str(doc.get("id") or "") != p.stem})
        out.append(row)
    return out


def load_asset(bid: str) -> dict | None:
    p = asset_path(bid)
    if not p.is_file():
        return None
    doc = json.loads(p.read_bytes().decode("utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{p.name}:根不是对象")
    return doc


def _pair(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and all(_is_num(x) for x in v)


def normalize(doc: Any, file_id: str | None = None) -> tuple[dict, list[str]]:
    """形状闸门:只收键序、硬拒坏形状、**不改数值**。返回 ``(落盘形, 告警)``;坏形状抛 ``ValueError``。

    与运行时 ``resolveBreathingOverlay`` 同口径(运行时拒的这里也拒);参数越界、未知参数键在运行时是夹紧 / 丢弃,
    这里是告警(不拒存,盘上已有的未知键原样保留,别悄悄吃掉)。
    """
    if not isinstance(doc, dict):
        raise ValueError("呼吸图必须是对象")
    bid = doc.get("id")
    if not valid_id(bid):
        raise ValueError(f"id 不合法:{bid!r}")
    if file_id is not None and bid != file_id:
        raise ValueError(f"id「{bid}」与文件名「{file_id}」不一致")
    warn: list[str] = []
    size = doc.get("size")
    if not (_pair(size) and size[0] > 0 and size[1] > 0):
        raise ValueError("size 必须是 [宽, 高](正数)")
    layers = doc.get("layers")
    if not isinstance(layers, dict) or not isinstance(layers.get("base"), str) or not layers["base"].strip():
        raise ValueError("layers.base 必填(底图路径)")
    for k, v in layers.items():
        if k not in ("base", "body", "sheet", "flap"):
            warn.append(f"layers 里有不认识的层「{k}」(运行时不读)")
        elif not isinstance(v, str):
            raise ValueError(f"layers.{k} 必须是路径字符串")
    fields = doc.get("fields")
    if not isinstance(fields, dict) or not isinstance(fields.get("file"), str) or not fields["file"].strip() \
            or not _is_num(fields.get("width")) or not _is_num(fields.get("height")) or fields["width"] <= 0 or fields["height"] <= 0:
        raise ValueError("fields 需要 file / width / height")
    rig = doc.get("rig")
    if not isinstance(rig, dict):
        raise ValueError("rig 必填")
    for k in ("pxPerMm", "flapLengthPx", "shade"):
        if not _is_num(rig.get(k)):
            raise ValueError(f"rig.{k} 必须是数")
    for k in ("root", "rootDisp", "flapNormal", "lampDir"):
        if not _pair(rig.get(k)):
            raise ValueError(f"rig.{k} 必须是 [x, y]")
    lim = rig.get("limits")
    if not isinstance(lim, dict) or not all(_is_num(lim.get(k)) and lim[k] > 0 for k in ("sheetMm", "ventMm", "cranMm")):
        raise ValueError("rig.limits 需要 sheetMm / ventMm / cranMm(正数)")
    params = doc.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("params 必须是对象(参数名 → 数值)")
    defs = param_defs()
    ordered: dict = {}
    for k in defs:
        if k in params:
            ordered[k] = params[k]
    for k, v in params.items():
        if k not in defs:
            warn.append(f"params 里有不认识的参数「{k}」(运行时丢弃;原样保留)")
            ordered[k] = v
    for k, v in ordered.items():
        if not _is_num(v):
            raise ValueError(f"params.{k} 必须是数(现为 {v!r})")
        d = defs.get(k)
        if d and not (d["min"] <= v <= d["max"]):
            warn.append(f"「{d['label']}」= {v} 超出 {d['min']}~{d['max']}(运行时夹紧)")
    out: dict = {}
    for k in KEY_ORDER:
        if k == "params":
            out["params"] = ordered
        elif k == "label":
            if isinstance(doc.get("label"), str) and doc["label"]:
                out["label"] = doc["label"]
        elif k in doc:
            out[k] = doc[k]
    for k, v in doc.items():
        if k not in out and k not in KEY_ORDER:
            warn.append(f"不认识的字段「{k}」(运行时不读;原样保留)")
            out[k] = v
    return out, warn


@serialized
def save_asset(doc: Any, base: Any = UNCHECKED) -> tuple[Path, dict, list[str], bool]:
    """归一化 → 原子写。返回 ``(路径, 落盘形, 告警, 真写了没有)``。

    * 烘焙产物(``size`` / ``layers`` / ``fields`` / ``rig``)与盘上不同 ⇒ 拒绝(工作台只改参数与名字);
    * ``base`` = 页面装载时盘上那份:盘上现在既不是它、也不是这次要写的 ⇒ 被别处改过 / 删了,拒绝覆盖;
    * 内容与盘上逐字节相同就不写。
    """
    if not isinstance(doc, dict):
        raise ValueError("呼吸图必须是对象")
    bid = doc.get("id")
    p = asset_path(bid)
    norm, warn = normalize(doc, bid)
    disk = load_asset(bid) if p.is_file() else None
    if disk is None:
        raise ValueError(f"「{bid}」盘上没有:新呼吸图由离线拆层工具烘出来,工作台不新建")
    changed = [k for k in BAKED_KEYS if norm.get(k) != disk.get(k)]
    if changed:
        raise ValueError(f"「{bid}」的 {'/'.join(changed)} 是烘焙产物,工作台不改(只改表演参数与名字)")
    if base is not UNCHECKED:
        if base is not None and not isinstance(base, dict):
            raise ValueError("保存基线无效,请重新打开这张呼吸图")
        if disk != base and disk != norm:
            raise ValueError(f"「{bid}」在盘上被别处改过,没覆盖;页面上的改动还在")
    norm = _preserve_numbers(norm, disk)
    if dumps(norm) == p.read_bytes():
        return p, norm, warn, False
    atomic_write(p, dumps(norm))
    return p, norm, warn, True


def media_file(url: str) -> Path | None:
    """``/resources/…`` → ``public/resources/…``(只放行落在 public 下、存在的文件)。"""
    if not isinstance(url, str) or not url.startswith("/resources/"):
        return None
    p = (PROJECT / "public" / url.lstrip("/")).resolve()
    try:
        p.relative_to((PROJECT / "public").resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def check_asset(bid: str) -> tuple[list[str], list[str]]:
    """``--check`` 与页面体检共用:返回 ``(错误, 告警)``。错误 = 运行时这张图起不来。"""
    errs: list[str] = []
    try:
        doc = load_asset(bid)
    except Exception as e:  # noqa: BLE001
        return [f"读不了:{type(e).__name__}: {e}"], []
    if doc is None:
        return ["不存在"], []
    try:
        norm, warn = normalize(doc, bid)
    except ValueError as e:
        return [str(e)], []
    for k, url in norm["layers"].items():
        if k in ("base", "body", "sheet", "flap") and url and media_file(url) is None:
            errs.append(f"layers.{k} 的图不存在:{url}")
    f = norm["fields"]
    fp = media_file(f["file"])
    if fp is None:
        errs.append(f"位移场文件不存在:{f['file']}")
    else:
        want = int(f["width"]) * int(f["height"]) * 4 * 2 * 2
        if fp.stat().st_size != want:
            errs.append(f"位移场大小不对:{fp.stat().st_size} 字节,{f['width']}×{f['height']} 两张 RGBA16F 应为 {want}")
    return errs, warn
