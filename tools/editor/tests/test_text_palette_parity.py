"""语义色板：Python 兜底表必须与 TS 权威 `src/core/textStyle.ts` 逐条一致。

镜像清单必须配**语义级** parity（editor-tools norms 不变量 8）：这里不只比条数，
连 id / label / color 三项都逐条比。两边任一处改了另一处没跟，这条就红。

顺带锁住"标记语法"本身：`[c:id]` / `[/c]` 的正则在两侧必须同形，否则编辑器认为合法的
写法运行时解析不出来（或反过来，校验器放行了运行时会警告的写法）。
"""
from __future__ import annotations

import re
from pathlib import Path

from tools.editor.shared.text_palette import DEFAULT_TEXT_PALETTE, inspect_style_markup

TS = Path(__file__).resolve().parents[3] / "src" / "core" / "textStyle.ts"


def _ts_default_palette() -> list[dict]:
    src = TS.read_text(encoding="utf-8")
    block = re.search(
        r"export const DEFAULT_TEXT_PALETTE:[^=]*=\s*\[(.*?)\];",
        src,
        re.S,
    )
    assert block, "textStyle.ts 里找不到 DEFAULT_TEXT_PALETTE"
    out = []
    for m in re.finditer(
        r"\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)',\s*color:\s*'([^']+)'\s*\}",
        block.group(1),
    ):
        out.append({"id": m.group(1), "label": m.group(2), "color": m.group(3)})
    return out


def test_default_palette_matches_ts() -> None:
    assert _ts_default_palette() == DEFAULT_TEXT_PALETTE


def test_markup_regex_same_shape_as_ts() -> None:
    src = TS.read_text(encoding="utf-8")
    assert r"/\[c:([A-Za-z0-9_-]+)\]/g" in src, "TS 侧开标记正则变了，Python 侧要同步"
    assert "const CLOSE_TOKEN = '[/c]';" in src, "TS 侧闭标记变了，Python 侧要同步"


def test_inspect_matches_ts_tolerance_rules() -> None:
    """容错口径与 TS 的 inspectStyleMarkup 一致：未知 id、多余闭合、未闭合各自单独报。"""
    ids = {"emphasis"}
    assert inspect_style_markup("前[c:emphasis]中[/c]后", ids) == {
        "unknown_ids": [], "stray_closes": 0, "unclosed": 0, "malformed": [],
    }
    assert inspect_style_markup("[c:nope]x[/c]", ids)["unknown_ids"] == ["nope"]
    assert inspect_style_markup("x[/c]", ids)["stray_closes"] == 1
    assert inspect_style_markup("[c:emphasis]x", ids)["unclosed"] == 1
    # 嵌套：内层闭合不该被算成多余
    assert inspect_style_markup("[c:emphasis]a[c:emphasis]b[/c]c[/c]", ids) == {
        "unknown_ids": [], "stray_closes": 0, "unclosed": 0, "malformed": [],
    }
    # 非 ASCII slug 的 id：两侧都要单列出来（不闭合时其余三项全过、剥不掉）
    assert inspect_style_markup("[c:强调]很重要", ids)["malformed"] == ["强调"]
