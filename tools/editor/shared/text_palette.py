"""语义色板（`[c:<id>]…[/c]`）的编辑器侧读取与标记检查。

**权威是 game_config.json 的 `textPalette`**（同一份数据运行时也在读），本文件不定义色板内容；
`DEFAULT_TEXT_PALETTE` 只是 game_config 没配这个键时的兜底，必须与
`src/core/textStyle.ts` 的 `DEFAULT_TEXT_PALETTE` 逐条一致——由
`tools/editor/tests/test_text_palette_parity.py` 锁死，改一边测试就会红。
"""
from __future__ import annotations

import re
from typing import Iterable

# 与 src/core/textStyle.ts 的 DEFAULT_TEXT_PALETTE 逐条对齐（parity 测试锁定）
DEFAULT_TEXT_PALETTE: list[dict] = [
    {"id": "emphasis", "label": "强调", "color": "#ffcc66"},
    {"id": "danger", "label": "危险", "color": "#b0644a"},
    {"id": "rule", "label": "规矩", "color": "#ffaa44"},
    {"id": "clue", "label": "线索", "color": "#8fae72"},
    {"id": "item", "label": "物件", "color": "#ddccaa"},
    {"id": "dim", "label": "弱化", "color": "#8e867a"},
]

ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_OPEN_RE = re.compile(r"\[c:([A-Za-z0-9_-]+)\]")
_TOKEN_RE = re.compile(r"\[c:([A-Za-z0-9_-]+)\]|\[/c\]")
CLOSE_TOKEN = "[/c]"


def load_text_palette(model) -> list[dict]:
    """工程当前生效的色板；game_config 没配或配得全非法时回落到内置（与运行时同语义）。"""
    cfg = getattr(model, "game_config", None)
    raw = cfg.get("textPalette") if isinstance(cfg, dict) else None
    out: list[dict] = []
    if isinstance(raw, list):
        for e in raw:
            if not isinstance(e, dict):
                continue
            eid = str(e.get("id") or "").strip()
            color = str(e.get("color") or "").strip()
            if not ID_RE.match(eid) or not re.match(r"^#[0-9a-fA-F]{6}$", color):
                continue
            out.append({"id": eid, "label": str(e.get("label") or eid), "color": color})
    return out or [dict(e) for e in DEFAULT_TEXT_PALETTE]


def palette_ids(model) -> set[str]:
    return {e["id"] for e in load_text_palette(model)}


def has_style_markup(text: str) -> bool:
    return "[c:" in text or CLOSE_TOKEN in text


def strip_style_markup(text: str) -> str:
    """去掉全部样式标记只留正文（与 TS 的 stripStyleMarkup 同语义）。"""
    if not has_style_markup(text):
        return text
    return _OPEN_RE.sub("", text).replace(CLOSE_TOKEN, "")


def inspect_style_markup(text: str, valid_ids: Iterable[str]) -> dict:
    """结构性检查：未知 id / 多余闭合 / 未闭合。与 TS 的 inspectStyleMarkup 同语义。"""
    valid = set(valid_ids)
    unknown: list[str] = []
    malformed: list[str] = []
    stray = 0
    depth = 0
    if not has_style_markup(text):
        return {"unknown_ids": [], "stray_closes": 0, "unclosed": 0, "malformed": []}
    # `[c:强调]` 这类非 ASCII slug 的 id 正则根本认不出来 → 不闭合时三项检查全过、
    # 剥标记也剥不掉，最后原样糊给玩家。必须单列出来。
    for m in re.finditer(r"\[c:([^\]]*)\]", text):
        if not ID_RE.match(m.group(1)) and m.group(1) not in malformed:
            malformed.append(m.group(1))
    for m in _TOKEN_RE.finditer(text):
        if m.group(1) is not None:
            depth += 1
            if m.group(1) not in valid and m.group(1) not in unknown:
                unknown.append(m.group(1))
        elif depth > 0:
            depth -= 1
        else:
            stray += 1
    return {"unknown_ids": unknown, "stray_closes": stray, "unclosed": depth,
            "malformed": malformed}


def wrap_with_color(text: str, palette_id: str) -> str:
    """把一段文字裹上色标记；空选区返回一对空标记（光标停中间由调用方处理）。"""
    return f"[c:{palette_id}]{text}{CLOSE_TOKEN}"


def count_palette_id_uses(project_root, palette_id: str) -> dict[str, int]:
    """全工程扫 `[c:<id>]` 的出现次数，返回 {相对路径: 次数}（只列有命中的文件）。

    色板 id 和实体 id 一样是被内容大量引用的 id，但它没有重构引擎。改名/删除前至少要
    告诉策划"这一下会打断多少处"——否则那些 `[c:旧id]` 会在**下一次**编辑别的数据时
    才以「未知语义色板」的形式炸出来，而且那时只能逐条手改。
    """
    from pathlib import Path

    root = Path(project_root)
    needle = f"[c:{palette_id}]"
    out: dict[str, int] = {}
    for base in (root / "public" / "assets",):
        if not base.is_dir():
            continue
        for f in base.rglob("*.json"):
            try:
                text = f.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            n = text.count(needle)
            if n:
                out[str(f.relative_to(root))] = n
    return out
