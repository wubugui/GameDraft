"""效果资产 ``generator`` 块（雷电样式生成器）的形状闸门：粒子工作台存盘与项目校验器共用这一份。

``generator: {kind: 'lightning', style, seed, group?, built?}`` 是粒子工作台的工作态，**运行时忽略**（同 ``authoring``，
TS 类型 ``VfxGeneratorDef``）。样式库在 ``assets/data/vfx_lightning_styles.json``（唯一写入者：粒子工作台，
见 ``tools/vfx_workbench/lightning.py``）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

#: 与效果 id 同一条护栏（文件名安全、允许中文）
_ID_RE = re.compile(r'^[^\\/:*?"<>|\x00-\x1f]{1,120}$')
STYLE_LIBRARY_FILE = "vfx_lightning_styles.json"


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _valid_id(v: Any) -> bool:
    s = str(v or "")
    return bool(_ID_RE.match(s)) and not s.startswith(".") and s.strip() == s


def generator_problems(g: Any) -> list[str]:
    """``generator`` 块读不懂的地方（空 = 形状没问题）。样式在不在样式库里另查（:func:`style_ids`）。"""
    if not isinstance(g, dict):
        return ["generator 要是对象 {kind, style, seed, group?, built?}"]
    out = []
    if g.get("kind") != "lightning":
        out.append(f"generator.kind 只能是 lightning（收到 {g.get('kind')!r}）")
    if not _valid_id(g.get("style")):
        out.append("generator.style 要是雷电样式的 id")
    seed = g.get("seed")
    if not (_is_num(seed) and int(seed) == seed and 0 <= seed < 2 ** 31):
        out.append("generator.seed 要是 0..2³¹ 的整数")
    for k in ("group", "built"):
        if k in g and not isinstance(g[k], str):
            out.append(f"generator.{k} 要是字符串")
    return out


def style_ids(data_dir: Path) -> set[str] | None:
    """样式库里的样式 id；文件不存在 / 读不懂 = None（调用方据此不报"样式不存在"，改报库本身的问题）。"""
    p = data_dir / STYLE_LIBRARY_FILE
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None
    styles = doc.get("styles") if isinstance(doc, dict) else None
    if not isinstance(styles, list):
        return None
    return {str(s.get("id")) for s in styles if isinstance(s, dict) and s.get("id")}
