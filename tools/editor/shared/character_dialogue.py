"""NPC 生效对话图的**唯一**解析口径（编辑器侧）。

运行时权威是 `src/data/characterRegistry.ts#applyCharacterDefaults`；本模块是它在编辑器
侧的镜像，由 `tools/editor/tests/test_character_dialogue_parity.py` 逐用例锁死。

为什么不直接用 `ProjectModel.character_field`：那个 helper 是**逐键 own-first**，
而对话图与入口必须**成对继承** —— 摆放覆盖了 `dialogueGraphId` 时，角色的
`dialogueGraphEntry` 绝不能跟过来（entry 是"某张图内部的节点名"，套到另一张图上会
静默落到错误/不存在的入口）。逐键合并会算出错误答案，故单开一个函数。

**凡是"按谁挂了这张图反查 NPC"的地方都必须走这里**，否则继承来的图看不见——
`agent_docs/runtime/mechanisms/character-registry.md` 已记这一坑（"注册表外的消费方
享受不到运行时合并"，编辑器画布 sprite 消失即此症）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


def resolve_npc_dialogue_graph(
    npc: Mapping[str, Any],
    character_registry: Mapping[str, Mapping[str, Any]] | None,
) -> tuple[str, str]:
    """→ (生效 dialogueGraphId, 生效 dialogueGraphEntry)；都可能是空串。

    与运行时逐条对齐：
    - 摆放就地写了非空 `dialogueGraphId` → 图用自己的，**entry 也只认自己的**（不继承）。
    - 摆放没写图 → 图从角色继承；entry 优先用摆放自己的，缺省再从角色继承。
    - 无 `characterId` / 悬垂引用 → 只看摆放自身（与运行时"原样返回"一致）。
    """
    own_graph = str(npc.get("dialogueGraphId") or "").strip()
    own_entry = str(npc.get("dialogueGraphEntry") or "").strip()
    if own_graph:
        return own_graph, own_entry

    cid = str(npc.get("characterId") or "").strip()
    if not cid or not character_registry:
        return "", own_entry
    ch = character_registry.get(cid)
    if not isinstance(ch, Mapping):
        return "", own_entry

    ch_graph = str(ch.get("dialogueGraphId") or "").strip()
    if not ch_graph:
        return "", own_entry
    ch_entry = str(ch.get("dialogueGraphEntry") or "").strip()
    return ch_graph, (own_entry or ch_entry)


def npc_uses_graph(
    npc: Mapping[str, Any],
    graph_id: str,
    character_registry: Mapping[str, Mapping[str, Any]] | None,
) -> bool:
    """这个摆放（含从角色继承的）是不是挂着 `graph_id`。反查类调用点统一用它。"""
    gid = (graph_id or "").strip()
    if not gid:
        return False
    return resolve_npc_dialogue_graph(npc, character_registry)[0] == gid


def load_character_registry(project_root: Path) -> dict[str, dict]:
    """给只拿得到 `project_root`（不经 ProjectModel）的调用点用的轻量读取。

    读不到 / 格式坏一律返回空表——注册表缺失时行为回落成"只看摆放自身"，
    与运行时空注册表 = no-op 的既有契约一致，不抛异常。
    """
    path = project_root / "public" / "assets" / "data" / "character_registry.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    out: dict[str, dict] = {}
    for c in (raw.get("characters") if isinstance(raw, dict) else None) or []:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or "").strip()
        if cid:
            out[cid] = c
    return out
