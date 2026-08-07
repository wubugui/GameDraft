"""叙事信号交叉引用（谁发 / 谁听）的共享基建。

一条信号的两侧永远只有一份口径，编辑器与调试器共用它：

    from tools.narrative_xref import build_index, from_disk, from_project_model

    index = build_index(from_disk(project_root))   # 调试器 / CLI / agent
    index = build_index(from_project_model(model)) # 编辑器（看得见未保存的编辑）
    card = index.card("beishi_lg_accepted")        # 两侧 + 诊断

界面各做各的：编辑器要的是「改之前先看清牵连、点一下跳过去」，调试器要的是「这一刻
谁在等、刚才谁发的」。共享的是扫描与口径，不共享界面。
"""

from .model import (
    CHANNEL_ASSET,
    CHANNEL_BROADCAST,
    CHANNEL_DIALOGUE,
    CHANNEL_NARRATIVE_ACTION,
    CHANNEL_UPSTREAM,
    DIAG_BROADCAST_OFF,
    DIAG_DECLARED_ONLY,
    DIAG_DRAFT,
    DIAG_NO_EMITTER,
    DIAG_NO_LISTENER,
    DIAG_ORPHAN,
    DIAG_UNREGISTERED,
    DRAFT_SIGNAL,
    Declaration,
    Diagnostic,
    Emitter,
    KIND_AUTHOR,
    KIND_DERIVED,
    KIND_DRAFT,
    KIND_UNKNOWN,
    Listener,
    SignalCard,
    StateRead,
    derived_signal_key,
    is_derived,
    parse_derived,
)
from .phrases import condition_parts, describe_condition, describe_conditions
from .scan import GraphMeta, SignalIndex, build_index
from .sources import ASSET_SPECS, XrefSource, from_disk, from_project_model

__all__ = [
    "ASSET_SPECS",
    "CHANNEL_ASSET",
    "CHANNEL_BROADCAST",
    "CHANNEL_DIALOGUE",
    "CHANNEL_NARRATIVE_ACTION",
    "CHANNEL_UPSTREAM",
    "DIAG_BROADCAST_OFF",
    "DIAG_DECLARED_ONLY",
    "DIAG_DRAFT",
    "DIAG_NO_EMITTER",
    "DIAG_NO_LISTENER",
    "DIAG_ORPHAN",
    "DIAG_UNREGISTERED",
    "DRAFT_SIGNAL",
    "Declaration",
    "Diagnostic",
    "Emitter",
    "GraphMeta",
    "KIND_AUTHOR",
    "KIND_DERIVED",
    "KIND_DRAFT",
    "KIND_UNKNOWN",
    "Listener",
    "SignalCard",
    "SignalIndex",
    "StateRead",
    "XrefSource",
    "build_index",
    "condition_parts",
    "derived_signal_key",
    "describe_condition",
    "describe_conditions",
    "from_disk",
    "from_project_model",
    "is_derived",
    "parse_derived",
]
