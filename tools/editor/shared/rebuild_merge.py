"""重建区"未知键透传"助手——去所有权化的统一模式。

编辑器 Apply 重建某个子结构时,不再抹掉它不认识的键:凡不在 managed 集合里的
原有键原样带过(顺序:重建键在前、未知键按原序附后)。managed 集合 = 该面板
**编辑的全部键**(无论本次是否写入)——用户清空某字段时它必须真的消失,不能被
"保留"复活;deprecated 键也应列入 managed(维持编辑器主动清理的既有职责)。

对话图节点与过场 present 步不适用本模式(各有独立契约与专属测试,单独治理)。
"""

from __future__ import annotations

from typing import Any


def merge_preserving_unknown(old: Any, built: dict, managed: set[str]) -> dict:
    """built 优先;old 中不属于 managed 的键透传附后。old 非 dict 时原样返回 built。"""
    if not isinstance(old, dict):
        return built
    extras = {k: v for k, v in old.items() if k not in managed and k not in built}
    if not extras:
        return built
    return {**built, **extras}
