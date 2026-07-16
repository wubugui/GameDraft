"""叙事状态机「整理分组」注册表：编辑器专用，运行时永不加载。

这是纯给作者在编辑器里整理左侧「编排列表」（compose）与「子图导航」（子图）用的分组
标签，**绝不能进 narrative_graphs.json**——它与 wrapper 子图上那个会写进 JSON、驱动运行时
``owner.wrapper.category.*`` 校验的 ``category``「分类备注」字段完全无关、互不干扰。

物理隔离在单独文件 ``public/assets/data/narrative_categories.json`` 里（与
``narrative_templates.json`` 同性质：运行时 / 内容校验器永远看不到它），因此分类信息天然
不可能污染运行时状态机或任何输出数据。

形状::

    {
      "schemaVersion": 1,
      "compositions": { "<compositionId>": "分类名" },
      "subgraphs":    { "<compositionId>": { "<elementId>": "分类名" } }
    }

- 分类名自由文本；分类集合从 values 派生，无独立注册表（轻量档）。空/未指派 = 无该 key。
- key 一律排序输出：本文件只由 ``normalize_categories_file`` 写盘，排序保证
  load→normalize→save 逐字节幂等（与「不排序业务数据键」无冲突——这里 key 是 id，无作者语义）。
- 悬垂条目（compose/元素删除后残留的 id）的清理放在 web 侧（对 web 内存里的实时数据 prune），
  以避开「新建但尚未保存 narrative_graphs」时被误删的保存时序陷阱。
"""
from __future__ import annotations

from typing import Any

SCHEMA_VERSION = 1


def default_categories_file() -> dict[str, Any]:
    """空注册表（缺文件/损坏时的容错默认）。"""
    return {"schemaVersion": SCHEMA_VERSION, "compositions": {}, "subgraphs": {}}


def _clean_str(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _normalize_assign(raw: Any) -> dict[str, str]:
    """{id: name} → 丢空 key/空 name、strip、按 key 排序的确定性 dict。"""
    out: dict[str, str] = {}
    if isinstance(raw, dict):
        for key, name in raw.items():
            k = _clean_str(key)
            n = _clean_str(name)
            if k and n:
                out[k] = n
    return {k: out[k] for k in sorted(out)}


def normalize_categories_file(value: Any) -> dict[str, Any]:
    """容错归一为标准形状（缺失/损坏 → 空注册表），key 排序、丢空值。"""
    compositions_raw: Any = {}
    subgraphs_raw: Any = {}
    if isinstance(value, dict):
        compositions_raw = value.get("compositions")
        subgraphs_raw = value.get("subgraphs")

    compositions = _normalize_assign(compositions_raw)

    subgraphs: dict[str, dict[str, str]] = {}
    if isinstance(subgraphs_raw, dict):
        for comp_id, assign in subgraphs_raw.items():
            cid = _clean_str(comp_id)
            if not cid:
                continue
            normalized = _normalize_assign(assign)
            if normalized:  # 丢掉空内层，保持整洁
                subgraphs[cid] = normalized
    subgraphs = {cid: subgraphs[cid] for cid in sorted(subgraphs)}

    return {
        "schemaVersion": SCHEMA_VERSION,
        "compositions": compositions,
        "subgraphs": subgraphs,
    }
