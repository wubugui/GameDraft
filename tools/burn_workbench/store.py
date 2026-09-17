# -*- coding: utf-8 -*-
"""燃烧工作台的盘面读写：可燃物**模板** ``public/assets/data/burnables/<id>.json``。

**本工作台是模板唯一的写入者**（玩法口径 A3.8；主编辑器只读显示）。模板和场景没有任何关系——谁用它写在宿主自己身上
（热点 / NPC / 挂件预设 / 轨迹 spawn 规格的 ``burnable: {template, …}``，粒子薄片的 ``plate.burnable``），
那些块归编辑宿主的地方写。工作台**只在改名时**跟着改它们的 ``template`` 值：一次事务，只替换那几个 JSON 字符串值
的字节（其余逐字节不动：缩进、换行、键序、数字写法、转义风格全不碰），写前确认那些文件自确认之后没被别处改过，失败回滚。

形状闸门一律走共享模块 ``tools/editor/shared/burnables.py``（``normalize_burnable``——只收键序、硬拒坏形状、**不改数值**），
落盘口径 ``ensure_ascii=False`` + 2 空格 + 末尾换行 + 不排序键 + LF；就位走 ``tools.atomic_io.retry_transient``
（Windows 上 ``os.replace`` 不原子）。

两个根可以重定向（测试与 ``--selftest`` 指到临时工程，绝不碰真库）：

* ``PROJECT``：读场景 / 图 / 挂件预设 / 玩家动画的工程根，也是改名时跟着改的引用文件所在的根；
* ``DATA``：写模板的工程根（通常与 ``PROJECT`` 相同）。

数值保真：页面是 JS，``2.0`` 进去出来是 ``2``。保存时对「与盘上数值相等」的每个数按盘上的表示回写
（``_preserve_numbers``，与 ``tools/editor/shared/numeric_roundtrip.py`` 同一条规则，只是递归）。
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import Any

from tools.atomic_io import retry_transient
from tools.editor.shared import burnables as B

ROOT = Path(__file__).resolve().parents[2]
#: 读的工程根（场景 / 图 / 预设 / 动画；改名时跟着改的引用文件）
PROJECT: Path = ROOT
#: 写模板的工程根
DATA: Path = ROOT

WRITE_LOCK = threading.RLock()
#: 调用方没有给基线（离线导入 / 测试）：不做"盘上被别处改过"的检查
UNCHECKED = object()
#: 尺寸与图宽高比偏离超过它就提示（挂到手上的挂件是等比缩放、按宽算）
ASPECT_TOLERANCE = 0.02


def serialized(fn):
    """所有写盘操作共用一个临界区（读-比-写不许交错）。"""
    @wraps(fn)
    def wrapped(*a, **k):
        with WRITE_LOCK:
            return fn(*a, **k)
    return wrapped


# ---------------------------------------------------------------------------- 路径 / 小工具

def burn_dir() -> Path:
    return B.burnables_dir(DATA)


def is_real_data() -> bool:
    try:
        return DATA.resolve() == ROOT.resolve()
    except OSError:
        return False


def valid_id(bid: Any) -> bool:
    return B.is_valid_id(bid) and len(bid) <= 120


def asset_path(bid: str) -> Path:
    if not valid_id(bid):
        raise ValueError(f"可燃物模板 id 不合法：{bid!r}（只许字母数字 _ - 与汉字）")
    return burn_dir() / f"{bid}.json"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, path)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _preserve_numbers(new: Any, old: Any) -> Any:
    """``new`` 里与 ``old`` 同位置、数值相等的数按 ``old`` 的表示回写（int / float）；结构不同处原样。"""
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


def _sha(data: bytes | None) -> str | None:
    return hashlib.sha256(data).hexdigest() if data is not None else None


def _rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(PROJECT.resolve()).as_posix()
    except (ValueError, OSError):
        return p.as_posix()


def aspect_deviation(width_cm: Any, height_cm: Any, img_w: Any, img_h: Any) -> float | None:
    """尺寸宽高比相对图宽高比偏了多少（``|尺寸比 / 图比 − 1|``）；拿不到数 = None。"""
    if not all(_is_num(v) and v > 0 for v in (width_cm, height_cm, img_w, img_h)):
        return None
    return abs((width_cm / height_cm) / (img_w / img_h) - 1.0)


# ---------------------------------------------------------------------------- 模板

def list_assets() -> list[dict]:
    """目录清单（按 id 排序）。坏 JSON 也列出来（``error``），别让一个坏文件藏起整批。"""
    out: list[dict] = []
    d = burn_dir()
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
        row.update({
            "label": str(doc.get("label") or ""),
            "image": str(doc.get("image") or ""),
            "mode": str(doc.get("mode") or "spread"),
            "widthCm": doc.get("widthCm") if _is_num(doc.get("widthCm")) else None,
            "heightCm": doc.get("heightCm") if _is_num(doc.get("heightCm")) else None,
            "idMismatch": str(doc.get("id") or "") != p.stem,
        })
        out.append(row)
    return out


def load_asset(bid: str) -> dict | None:
    p = asset_path(bid)
    if not p.is_file():
        return None
    doc = json.loads(p.read_bytes().decode("utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{p.name}：根不是对象")
    return doc


def normalize(doc: Any, file_id: str | None = None) -> tuple[dict, list[str]]:
    """共享闸门（``BurnShapeError`` 是 ``ValueError``）。"""
    return B.normalize_burnable(doc, file_id)


@serialized
def save_asset(doc: Any, base: Any = UNCHECKED) -> tuple[Path, dict, list[str], bool]:
    """归一化 → 原子写。返回 ``(路径, 落盘形, 告警, 真写了没有)``。

    ``base`` = 页面装载时盘上那份：盘上现在既不是它、也不是这次要写的 ⇒ 被别处改过 / 删了，拒绝覆盖。
    内容与盘上逐字节相同就不写（原样重写会替别处的改动做撤销，也会让 vite 白白热更一次）。
    """
    if not isinstance(doc, dict):
        raise ValueError("可燃物模板必须是对象")
    bid = doc.get("id")
    p = asset_path(bid)
    norm, warn = normalize(doc, bid)
    disk = load_asset(bid) if p.is_file() else None
    if base is not UNCHECKED:
        if base is not None and not isinstance(base, dict):
            raise ValueError("保存基线无效，请重新打开这份模板")
        if disk != base and disk != norm:
            what = "删了" if disk is None else "改过"
            raise ValueError(f"「{bid}」在盘上被别处{what}，没覆盖；页面上的改动还在（可以先复制一份保住）")
    if disk is not None:
        norm = _preserve_numbers(norm, disk)
        if B.dumps(norm) == p.read_bytes():
            return p, norm, warn, False
    atomic_write(p, B.dumps(norm))
    return p, norm, warn, True


@serialized
def create_asset(bid: str, image: str, label: str = "", mode: str = "spread", orientation: str = "upright",
                 width_cm: Any = None, height_cm: Any = None) -> tuple[Path, dict]:
    """新建。真实尺寸必填（闸门硬拒缺尺寸）：页面按图的像素比例给初始值、作者确认后才发过来。"""
    p = asset_path(bid)
    if p.exists():
        raise FileExistsError(f"可燃物模板「{bid}」已存在")
    doc: dict = {"id": bid}
    if label.strip():
        doc["label"] = label.strip()
    doc["image"] = image
    doc["widthCm"] = width_cm
    doc["heightCm"] = height_cm
    doc["mode"] = mode
    doc["orientation"] = orientation
    norm, _w = normalize(doc, bid)
    atomic_write(p, B.dumps(norm))
    return p, norm


@serialized
def duplicate_asset(src: str, to: str, working: dict | None = None) -> tuple[Path, dict]:
    """复制。``working`` = 页面上此刻那份（带没存的改动），源文件不动；缺省取盘上那份。"""
    doc = working if isinstance(working, dict) else load_asset(src)
    if doc is None:
        raise FileNotFoundError(f"可燃物模板「{src}」不存在")
    p = asset_path(to)
    if p.exists():
        raise FileExistsError(f"可燃物模板「{to}」已存在")
    doc = copy.deepcopy(doc)
    doc["id"] = to
    norm, _w = normalize(doc, to)
    atomic_write(p, B.dumps(norm))
    return p, norm


def unique_id(base: str) -> str:
    used = {r["id"] for r in list_assets()}
    if base not in used:
        return base
    k = 2
    while f"{base}_{k}" in used:
        k += 1
    return f"{base}_{k}"


# ---------------------------------------------------------------------------- 谁在用（宿主上的 burnable 块）

def template_refs(tid: str) -> list[dict]:
    """引用这份模板的所有宿主（共享闸门 ``refs_of_template`` 扫 ``PROJECT`` 下 ``public/assets/**/*.json``）。"""
    return B.refs_of_template(PROJECT, tid)


# ---------------------------------------------------------------------------- JSON 文本里的字符串值区间（改名只动这几个字节）

_TOKEN_RE = re.compile(
    r'[ \t\r\n]*(?:("(?:[^"\\]|\\.)*")|([{}\[\]:,])|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null))',
    re.S,
)


class _JsonScan:
    """极小的 JSON 扫描器：只为找出"某条路径上的字符串值"在原文里的字符区间（含引号）。形状不对就抛 ``ValueError``。"""

    def __init__(self, text: str, wanted: set[tuple]):
        self.t = text
        self.i = 1 if text.startswith("﻿") else 0
        self.wanted = wanted
        self.found: dict[tuple, tuple[int, int]] = {}

    def tok(self) -> tuple[str, int, int]:
        m = _TOKEN_RE.match(self.t, self.i)
        if not m:
            raise ValueError(f"JSON 在第 {self.i} 个字符处读不懂")
        self.i = m.end()
        if m.group(1) is not None:
            return "s", m.start(1), m.end(1)
        if m.group(2) is not None:
            return m.group(2), m.start(2), m.end(2)
        return "v", m.start(3), m.end(3)

    def value(self, path: tuple) -> None:
        kind, a, b = self.tok()
        if kind == "s":
            if path in self.wanted:
                self.found[path] = (a, b)
            return
        if kind == "v":
            return
        if kind == "{":
            kind, a, b = self.tok()
            if kind == "}":
                return
            while True:
                if kind != "s":
                    raise ValueError(f"JSON 对象的键不是字符串（第 {a} 个字符）")
                key = json.loads(self.t[a:b])
                if self.tok()[0] != ":":
                    raise ValueError(f"JSON 对象的键后面缺冒号（第 {b} 个字符）")
                self.value(path + (key,))
                kind, a, b = self.tok()
                if kind == "}":
                    return
                if kind != ",":
                    raise ValueError(f"JSON 对象里缺逗号（第 {a} 个字符）")
                kind, a, b = self.tok()
        if kind == "[":
            save = self.i
            if self.tok()[0] == "]":
                return
            self.i = save
            idx = 0
            while True:
                self.value(path + (idx,))
                idx += 1
                kind, a, b = self.tok()
                if kind == "]":
                    return
                if kind != ",":
                    raise ValueError(f"JSON 数组里缺逗号（第 {a} 个字符）")
        raise ValueError(f"JSON 在第 {a} 个字符处出现意外的「{self.t[a:b]}」")


def string_value_spans(text: str, paths: list[tuple]) -> dict[tuple, tuple[int, int]]:
    """``text`` 里这些路径上的**字符串值**的字符区间 ``[start, end)``（含引号）。路径元素：键（解码后）/ 下标（int）。
    找不到的路径不在结果里（调用方据此判"引用处变了"）。"""
    sc = _JsonScan(text, {tuple(p) for p in paths})
    sc.value(())
    if sc.t[sc.i:].strip():
        raise ValueError("JSON 末尾还有多余的内容")
    return sc.found


@dataclass
class _FileEdit:
    path: Path
    rel: str
    old: bytes
    new: bytes
    count: int


def _rename_edits(old: str, new: str) -> list[_FileEdit]:
    """按此刻盘上的引用算出每个文件改名后的字节（只替换 ``burnable.template`` 那个值）。算不出来就抛，一个字节不写。"""
    refs = template_refs(old)
    by_file: dict[str, list[dict]] = {}
    for r in refs:
        by_file.setdefault(r["file"], []).append(r)
    edits: list[_FileEdit] = []
    for rel, rows in sorted(by_file.items()):
        p = PROJECT / rel
        raw = p.read_bytes()
        text = raw.decode("utf-8")
        wanted = [tuple(r["path"]) + ("burnable", "template") for r in rows]
        spans = string_value_spans(text, wanted)
        missing = [w for w in wanted if w not in spans]
        if missing:
            raise ValueError(f"{rel}：没找到要改的引用（{'/'.join(map(str, missing[0]))}），文件大概刚被别处改过——没改名，再试一次")
        ascii_only = text.isascii()
        out = text
        for a, b in sorted(spans.values(), reverse=True):
            if json.loads(out[a:b]).strip() != old:
                raise ValueError(f"{rel}：引用值对不上（{out[a:b]}），没改名")
            out = out[:a] + json.dumps(new, ensure_ascii=ascii_only) + out[b:]
        # 核一遍：解析结果 == 原文解析后只把这几处 template 换成新 id
        want = json.loads(text.lstrip("﻿"))
        for w in wanted:
            node = want
            for k in w[:-1]:
                node = node[k]
            node[w[-1]] = new
        if json.loads(out.lstrip("﻿")) != want:
            raise ValueError(f"{rel}：改完的内容核对不上，没改名")
        edits.append(_FileEdit(p, rel, raw, out.encode("utf-8"), len(rows)))
    return edits


def rename_plan(old: str, new: str) -> dict:
    """改名之前给页面确认用：会改哪些文件（每个的内容摘要 + 几处）、模板文件本身的摘要。

    返回 ``{refs, files: [{file, count}], expect: {相对路径: sha256}}``；``expect`` 原样交回 :func:`rename_asset`，
    那边逐个比对——确认之后有文件被别处改过 / 多出新的引用处就拒绝。
    """
    src, dst = asset_path(old), asset_path(new)
    if not src.is_file():
        raise FileNotFoundError(f"可燃物模板「{old}」不存在")
    if old == new:
        raise ValueError("新 id 与旧 id 相同")
    if dst.exists():
        raise FileExistsError(f"可燃物模板「{new}」已存在")
    refs = template_refs(old)
    edits = _rename_edits(old, new)
    expect = {e.rel: _sha(e.old) for e in edits}
    expect[_rel(src)] = _sha(src.read_bytes())
    return {"refs": refs, "files": [{"file": e.rel, "count": e.count} for e in edits], "expect": expect}


@serialized
def rename_asset(old: str, new: str, expect: Any = UNCHECKED) -> dict:
    """改名 = 新模板文件 + 每个引用处的 ``template`` 值 + 删旧文件，一次事务；任何一步失败把写过的原字节写回。

    ``expect`` = :func:`rename_plan` 给的 ``{相对路径: sha256}``：确认之后那些文件（含模板文件本身）被别处改过、
    或多出了新的引用文件 ⇒ 拒绝并说清是哪几个，一个字节不写。返回 ``{path, doc, refsChanged, files}``。
    """
    src, dst = asset_path(old), asset_path(new)
    if not src.is_file():
        raise FileNotFoundError(f"可燃物模板「{old}」不存在")
    if old == new:
        raise ValueError("新 id 与旧 id 相同")
    if dst.exists():
        raise FileExistsError(f"可燃物模板「{new}」已存在")
    src_bytes = src.read_bytes()
    edits = _rename_edits(old, new)
    if expect is not UNCHECKED:
        if not isinstance(expect, dict):
            raise ValueError("改名确认单无效：重新点一次「重命名」")
        now = {e.rel: _sha(e.old) for e in edits}
        now[_rel(src)] = _sha(src_bytes)
        changed = sorted(rel for rel, sha in expect.items()
                         if _sha((PROJECT / rel).read_bytes() if (PROJECT / rel).is_file() else None) != sha)
        added = sorted(rel for rel in now if rel not in expect)
        if changed or added:
            parts = []
            if changed:
                parts.append(f"确认之后被别处改过：{'、'.join(changed)}")
            if added:
                parts.append(f"多出了引用它的文件：{'、'.join(added)}")
            raise ValueError(f"没改名——{'；'.join(parts)}。重新点一次「重命名」看最新的引用处")
    doc = json.loads(src_bytes.decode("utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{src.name}：根不是对象")
    doc["id"] = new
    norm, _w = normalize(doc, new)
    written: list[_FileEdit] = []
    try:
        atomic_write(dst, B.dumps(norm))
        for e in edits:
            atomic_write(e.path, e.new)
            written.append(e)
        retry_transient(os.unlink, src)
    except Exception as e:
        errs: list[str] = []
        for w in reversed(written):
            try:
                atomic_write(w.path, w.old)
            except Exception as e2:  # noqa: BLE001
                errs.append(f"{w.rel} 没写回原样（{type(e2).__name__}: {e2}）")
        try:
            if dst.exists():
                if not src.exists():
                    atomic_write(src, src_bytes)
                retry_transient(os.unlink, dst)
        except Exception as e3:  # noqa: BLE001
            errs.append(f"新模板文件没删掉（{type(e3).__name__}: {e3}）")
        tail = "；".join(errs) if errs else "已回滚，什么都没变"
        raise RuntimeError(f"改名失败（{type(e).__name__}: {e}）；{tail}") from e
    return {"path": dst, "doc": norm, "refsChanged": sum(e.count for e in edits), "files": [e.rel for e in edits]}


@serialized
def delete_asset(bid: str) -> dict:
    """删模板。还有宿主引用它 ⇒ 不删、回 ``refs``（作者先去那些地方关掉可燃或换模板）；没有才删。"""
    p = asset_path(bid)
    refs = template_refs(bid)
    if refs:
        return {"deleted": False, "refs": refs}
    if not p.is_file():
        return {"deleted": False, "refs": []}
    retry_transient(os.unlink, p)
    return {"deleted": True, "refs": []}
