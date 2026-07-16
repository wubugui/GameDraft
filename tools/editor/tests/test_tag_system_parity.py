"""三方 [tag:…] 系统 parity 护栏（FIX-1：根因2「手工镜像清单无语义 parity」合拢）。

玩家可见文本的 `[tag:kind:…]` 引用系统是又一处三方手工镜像，此前零 parity 护栏：
- 运行时 `src/core/resolveText.ts` 的 `TAG_*` 正则 —— 真正会被解析展开的 tag 种类；
- 校验器 `tools/editor/shared/ref_validator.py` 的 `_TAG_PATTERNS` —— 保存/校验时据此
  扫描并验证 tag 引用目标存在；
- 目录 `tools/editor/shared/tag_catalog.py` 的 kinds（`list_by_kind` / `search` 默认清单）
  —— 编辑器 RichText 选择器据此列出可插入的 tag 种类。

任一处新增/删除 tag 种类而漏同步：
- 运行时能解析、校验器不认 → 合法 tag 被 ref 校验漏检或误报；
- 运行时能解析、目录没有 → 编辑器无法插入该 tag；
- 目录/校验器有、运行时无 → 幻影 tag，运行时原样输出到玩家眼前。

三源独立取值后名集合三方比对。
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _runtime_tag_kinds() -> set[str]:
    """resolveText.ts 的 `const TAG_* = /\\[tag:KIND…/` 声明里的 kind。"""
    text = (REPO / "src/core/resolveText.ts").read_text("utf-8")
    return set(re.findall(r"const\s+TAG_\w+\s*=\s*/\\\[tag:([a-z]+)", text))


def _ref_validator_tag_kinds() -> set[str]:
    from tools.editor.shared.ref_validator import _TAG_PATTERNS
    return {str(kind) for kind, _rx in _TAG_PATTERNS}


def _tag_catalog_kinds() -> set[str]:
    """tag_catalog.py 中 search() 的默认 kinds 清单（编辑器可插入 tag 的权威枚举）。"""
    text = (REPO / "tools/editor/shared/tag_catalog.py").read_text("utf-8")
    m = re.search(r"kinds\s*=\s*kinds\s+or\s*\[([^\]]*)\]", text)
    assert m, "未能在 tag_catalog.py 定位 search() 的默认 kinds 清单"
    return set(re.findall(r'"([a-z]+)"', m.group(1)))


def _tag_catalog_dispatch_kinds() -> set[str]:
    """tag_catalog.list_by_kind() 的 `if/elif kind == "…"` 分支（实际派发的 kind）。"""
    text = (REPO / "tools/editor/shared/tag_catalog.py").read_text("utf-8")
    i = text.index("def list_by_kind")
    end = text.index("def search", i)
    body = text[i:end]
    return set(re.findall(r'kind\s*==\s*"([a-z]+)"', body))


def test_tag_kinds_three_way_parity() -> None:
    runtime = _runtime_tag_kinds()
    refval = _ref_validator_tag_kinds()
    catalog = _tag_catalog_kinds()

    assert runtime, "未能从 resolveText.ts 解析出任何 TAG_* 种类"

    missing_in_refval = sorted(runtime - refval)
    missing_in_catalog = sorted(runtime - catalog)
    assert not missing_in_refval, (
        f"运行时可解析但 ref_validator._TAG_PATTERNS 缺失（tag 引用校验漏检）：{missing_in_refval}"
    )
    assert not missing_in_catalog, (
        f"运行时可解析但 tag_catalog 缺失（编辑器无法插入该 tag）：{missing_in_catalog}"
    )

    phantom_refval = sorted(refval - runtime)
    phantom_catalog = sorted(catalog - runtime)
    assert not phantom_refval, (
        f"ref_validator 有运行时不认的幻影 tag 种类：{phantom_refval}"
    )
    assert not phantom_catalog, (
        f"tag_catalog 有运行时不认的幻影 tag 种类（写出后原样吐给玩家）：{phantom_catalog}"
    )


def test_tag_catalog_default_list_matches_dispatch() -> None:
    """目录内部一致：search() 默认清单必须与 list_by_kind() 派发分支一致。"""
    default = _tag_catalog_kinds()
    dispatch = _tag_catalog_dispatch_kinds()
    assert default == dispatch, (
        "tag_catalog.search() 默认 kinds 与 list_by_kind() 派发分支不一致："
        f"仅默认清单={sorted(default - dispatch)} 仅派发={sorted(dispatch - default)}"
    )
