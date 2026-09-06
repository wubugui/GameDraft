"""对话图「备用入口」的唯一收集面。

图自己的 `entry` 只是**默认入口**，不是唯一入口：运行时
`GraphDialogueManager.startDialogueGraph` 只要拿到存在的 `params.entry` 就从那里开演
（`src/systems/GraphDialogueManager.ts` 的 `params.entry?.trim() && raw.nodes[...]`），
所以一张图被多个来源各从不同节点进入是**一等设计**，不是接线错误。

会传 entry 的来源（逐条对着运行时读代码，别照抄文档）：

- NPC 摆放 / 角色注册表：`dialogueGraphEntry`（`InteractionCoordinator.ts` 的
  `entry: npc.def.dialogueGraphEntry`，继承规则见 `character_dialogue.resolve_npc_dialogue_graph`）
- inspect 热区的图对话模式：`data.graphId` + **`data.entry`**（`InteractionCoordinator.ts`
  的 `entry: data.entry?.trim()`）——注意键名与 NPC 那套**不同**
- 任何动作列表里的 `startDialogueGraph`：`params.graphId` + `params.entry`
  （`ActionRegistry.ts` 注册处，参数表 `['graphId','entry',…]`）

⚠ **这份键名清单是唯一登记面**：主校验器（`tools/editor/validator.py`）与图对话编辑器
（`tools/dialogue_graph_editor/graph_document.py`）都必须从这里取根，不许各写各的。
两边分家正是 2026-08-07 那次误报的根因——`主线_藏钱` 的 n_2 是码头白天藏钱点 B 的真入口，
validator 只认 `dialogueGraphEntry` 这组键名收不到它，编辑器干脆一个备用入口都不看，
于是两处一起把「另一个入口」报成流程孤儿。

对话图内部的 `startDialogueGraph` 也属于动作面。通过共享引用目录读取有效图，
包括暂存新增/编辑并排除暂存删除；编辑器与校验器使用同一套入口根。
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .character_dialogue import resolve_npc_dialogue_graph
from .dialogue_graph_refs import dialogue_graph_document, dialogue_graph_ids

START_DIALOGUE_GRAPH_ACTION = "startDialogueGraph"


def _add(overrides: dict[str, set[str]], graph_id: Any, entry: Any) -> None:
    gid = str(graph_id or "").strip()
    ent = str(entry or "").strip()
    if gid and ent:
        overrides.setdefault(gid, set()).add(ent)


def _scan_actions(node: Any, overrides: dict[str, set[str]]) -> None:
    """递归找 `startDialogueGraph` 动作；动作可以埋在任意容器的任意深度。"""
    if isinstance(node, dict):
        if node.get("type") == START_DIALOGUE_GRAPH_ACTION:
            params = node.get("params")
            if isinstance(params, dict):
                _add(overrides, params.get("graphId"), params.get("entry"))
        for value in node.values():
            _scan_actions(value, overrides)
    elif isinstance(node, list):
        for value in node:
            _scan_actions(value, overrides)


def collect_dialogue_graph_entry_overrides(model: Any) -> dict[str, set[str]]:
    """图 id → 该图被外部指定过的备用入口节点集合（不含图自己的 `entry`）。

    传 `ProjectModel`；缺字段的模型（测试替身）一律当空处理，不抛。
    """
    overrides: dict[str, set[str]] = {}
    registry = getattr(model, "character_registry", {}) or {}

    for scene in (getattr(model, "scenes", {}) or {}).values():
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            # 角色级绑定的图/入口不在就地字段上，只读原始键会漏收。
            gid, entry = resolve_npc_dialogue_graph(npc, registry)
            _add(overrides, gid, entry)
        for hotspot in scene.get("hotspots") or []:
            if not isinstance(hotspot, dict):
                continue
            data = hotspot.get("data") if isinstance(hotspot.get("data"), dict) else {}
            # 图对话模式的热区用的是 graphId/entry；dialogueGraphId/Entry 是另一套写法，两者都收。
            _add(overrides, data.get("graphId"), data.get("entry"))
            _add(overrides, data.get("dialogueGraphId"), data.get("dialogueGraphEntry"))

    # 角色注册表自身的绑定（没有任何摆放继承它时也算一个入口来源）。
    for character in registry.values():
        if isinstance(character, Mapping):
            _add(overrides, character.get("dialogueGraphId"), character.get("dialogueGraphEntry"))

    # 动作面：场景 / 任务 / 过场 / 叙事图里的 startDialogueGraph 都可能带 entry。
    for container in (
        getattr(model, "scenes", {}) or {},
        getattr(model, "quests", []) or [],
        getattr(model, "cutscenes", []) or [],
        getattr(model, "narrative_graphs", {}) or {},
    ):
        _scan_actions(container, overrides)

    for graph_id in dialogue_graph_ids(model):
        _scan_actions(dialogue_graph_document(model, graph_id), overrides)

    return overrides


def graph_entry_roots(
    nodes: Mapping[str, Any],
    own_entry: str,
    graph_keys: Iterable[str],
    overrides: Mapping[str, set[str]] | None,
) -> set[str]:
    """可达性分析的根集合＝图自己的 entry ＋ 所有指向本图的备用入口（只保留真实存在的节点）。

    `graph_keys` 传该图的全部可能 id（文件名 stem、`meta.id`、`id` 字段）——各处引用它的
    写法不统一，少传一个就会漏掉一批备用入口。
    """
    roots: set[str] = set()
    entry = str(own_entry or "").strip()
    if entry in nodes:
        roots.add(entry)
    if not overrides:
        return roots
    for key in graph_keys:
        k = str(key or "").strip()
        if not k:
            continue
        roots |= {e for e in overrides.get(k, set()) if e in nodes}
    return roots
