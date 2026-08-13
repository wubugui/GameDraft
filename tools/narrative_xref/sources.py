"""扫描的数据来源：编辑器内存（含未保存暂存）与磁盘（调试器 / CLI / agent）。

两个来源产出**同一种** :class:`XrefSource`，扫描器本身对来源一无所知——这是编辑器与
调试器能共用一套口径的关键。parity 测试拿真实工程逐条比对两侧结果，漂了就红：
``tools/editor/tests/test_signal_xref_bridge.py::SignalXrefSourceParityTests
::test_model_source_matches_disk_source_on_the_real_project``
（放在编辑器测试里，因为它要真的构造 ProjectModel）。

发射面登记表 :data:`ASSET_SPECS` 的键必须与
``tools/editor/shared/narrative_catalog._EMIT_SOURCE_ATTRS`` 完全一致（parity 测试锁定）。
本表比那张多的是**文件位置**——目录口径只需要"扫哪些内存集合"，本模块还要能把命中
指回磁盘上的具体文件与 JSON 指针，否则清单点不动、跳不过去。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# 模式：
#   whole    —— 模型属性就是整份文件的根（quests.json / pressure_holds.json…）
#   perScene —— {场景键: 场景文档}，每个键一份文件 scenes/<键>.json
#   minigame —— {实例 id: 文档}，每个实例一份文件 <family>/<id>.json（index.json 登记）
ASSET_SPECS: dict[str, dict[str, str]] = {
    "scenes": {"mode": "perScene", "kind": "scene", "label": "场景"},
    "quests": {"mode": "whole", "kind": "quest", "path": "quests.json", "label": "任务"},
    "encounters": {"mode": "whole", "kind": "encounter", "path": "encounters.json", "label": "遭遇"},
    "cutscenes": {"mode": "whole", "kind": "cutscene", "path": "cutscenes/index.json", "label": "过场"},
    "pressure_holds": {"mode": "whole", "kind": "pressureHold", "path": "pressure_holds.json", "label": "临场长按"},
    "signal_cues": {"mode": "whole", "kind": "signalCue", "path": "signal_cues.json", "label": "信号 Cue"},
    "archive_characters": {"mode": "whole", "kind": "archiveCharacter", "path": "archive/characters.json", "label": "档案·人物"},
    "archive_books": {"mode": "whole", "kind": "archiveBook", "path": "archive/books.json", "label": "档案·书"},
    "archive_documents": {"mode": "whole", "kind": "archiveDocument", "path": "archive/documents.json", "label": "档案·文书"},
    "archive_lore": {"mode": "whole", "kind": "archiveLore", "path": "archive/lore.json", "label": "档案·见闻"},
    "water_minigames_instances": {"mode": "minigame", "kind": "minigame", "family": "water_minigames", "label": "水域小游戏"},
    "sugar_wheel_instances": {"mode": "minigame", "kind": "minigame", "family": "sugar_wheel", "label": "转盘小游戏"},
    "paper_craft_instances": {"mode": "minigame", "kind": "minigame", "family": "paper_craft", "label": "扎纸小游戏"},
    "object_examine_instances": {"mode": "minigame", "kind": "minigame", "family": "object_examine", "label": "物件检视"},
}

# 主编辑器只加载不保存的数据面：目录/清单要看得见它发的信号，重构则拒绝改写它
# （与 signal_refactor.READONLY_SOURCES 同源，parity 测试锁定）。
READONLY_ATTRS = frozenset({"object_examine_instances"})

# **条件面比发射面宽**：`{narrative,state}` 叶、活计计数叶、生命周期动作还会出现在
# 地图节点可见性、图鉴解锁、物品动态描述、章节清单…里。这张表镜像
# `signal_refactor.CONDITION_EXTRA_SOURCES`（parity 测试锁定），只扫**引用**不扫发射
# ——把它们算进发射面会与 emitted_signal_ids 的权威口径打架。
#
# `pointer_prefix`：模型属性是文件内的某个子树时（map_nodes 就是 map_config.json 的
# nodes 数组），指针要补回那一段，否则跳转落到文件根上的错位置。
CONDITION_EXTRA_SPECS: dict[str, dict[str, str]] = {
    "narrative_packages": {"path": "narrative_packages.json", "kind": "narrativePackage", "label": "章节包"},
    "map_nodes": {"path": "map_config.json", "kind": "mapNode", "label": "地图节点", "subtree": "nodes"},
    "quest_groups": {"path": "questGroups.json", "kind": "questGroup", "label": "任务组"},
    "items": {"path": "items.json", "kind": "item", "label": "物品"},
    # ⚠ 属性名是 rules_data（rules.json 载入到该属性），不是 rules——写错会 getattr 兜
    # None 静默跳过整张表，与 signal_refactor 踩过的是同一个坑。
    "rules_data": {"path": "rules.json", "kind": "rule", "label": "规矩"},
    "shops": {"path": "shops.json", "kind": "shop", "label": "商店"},
    "document_reveals": {"path": "document_reveals.json", "kind": "documentReveal", "label": "文档揭示"},
    "smell_profiles": {"path": "smell_profiles.json", "kind": "smellProfile", "label": "气味"},
    # 气泡台词本的 `lineSets[].when` 是**表现层读状态**的主通道（BubbleChatterSystem 逐帧
    # 按 when 挑人开口）。不登记 = 查"谁读这个状态"时整条气泡通道隐形，而那正是"世界对
    # 玩家有反应"最主要的外显面。模型属性存的是整份文档（不是子树），故无 subtree。
    "bubble_lines": {"path": "bubble_lines.json", "kind": "bubbleLineSet", "label": "气泡台词"},
    "game_config": {"path": "game_config.json", "kind": "gameConfig", "label": "全局配置"},
}

_ASSETS_PREFIX = "public/assets"
_DATA_PREFIX = f"{_ASSETS_PREFIX}/data"
_SCENES_PREFIX = f"{_ASSETS_PREFIX}/scenes"
_DIALOGUE_PREFIX = f"{_ASSETS_PREFIX}/dialogues/graphs"
NARRATIVE_FILE = f"{_DATA_PREFIX}/narrative_graphs.json"


@dataclass(frozen=True)
class DialogueDoc:
    graph_id: str
    file: str
    doc: dict[str, Any]


@dataclass(frozen=True)
class AssetDoc:
    """一份可能内嵌动作树的内容资产文档（pointer 相对 ``root``，root 即文件根）。"""

    attr: str
    kind: str
    item_id: str          # perScene / minigame 模式下是场景/实例 id；whole 模式为空
    label: str            # 人话类别名（'任务' / '场景'…）
    file: str             # 仓库相对路径
    root: Any
    readonly: bool = False
    # False = 只扫「引用」不扫「发射」：条件面比发射面宽，把这些算进发射会与
    # narrative_catalog.emitted_signal_ids 的权威口径打架。
    scan_emits: bool = True
    # root 是文件内子树时的指针前缀（map_config.json 的 nodes），跳转要靠它落对位置
    pointer_prefix: str = ""


@dataclass
class XrefSource:
    origin: str           # 'model' | 'disk'
    narrative: dict[str, Any] = field(default_factory=dict)
    narrative_file: str = NARRATIVE_FILE
    dialogues: list[DialogueDoc] = field(default_factory=list)
    assets: list[AssetDoc] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# 编辑器内存来源（含未保存暂存）
# --------------------------------------------------------------------------- #

def from_project_model(model: Any) -> XrefSource:
    """从 ProjectModel 建来源：看得见**未保存的编辑**（这正是编辑器要的）。

    对话图不常驻内存，取用优先级（暂存编辑 > 模板桩 > 磁盘）直接复用
    ``signal_refactor`` 的既有实现，避免第二份暂存优先级逻辑跟着漂。
    """
    from tools.editor.shared.signal_refactor import _dialogue_graph_ids, _load_dialogue_doc

    narrative = getattr(model, "narrative_graphs", None)
    src = XrefSource(origin="model", narrative=narrative if isinstance(narrative, dict) else {})

    for gid in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid)
        if isinstance(doc, dict):
            src.dialogues.append(DialogueDoc(gid, f"{_DIALOGUE_PREFIX}/{gid}.json", doc))

    for attr, spec in ASSET_SPECS.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        readonly = attr in READONLY_ATTRS
        mode = spec["mode"]
        if mode == "whole":
            src.assets.append(AssetDoc(attr, spec["kind"], "", spec["label"],
                                       f"{_DATA_PREFIX}/{spec['path']}", root, readonly))
        elif mode == "perScene":
            if isinstance(root, dict):
                for key, doc in root.items():
                    src.assets.append(AssetDoc(attr, spec["kind"], str(key), spec["label"],
                                               f"{_SCENES_PREFIX}/{key}.json", doc, readonly))
        elif mode == "minigame":
            family = spec["family"]
            files = _minigame_files_from_index(getattr(model, f"{family}_index", None))
            if isinstance(root, dict):
                for iid, doc in root.items():
                    name = files.get(str(iid), f"{iid}.json")
                    src.assets.append(AssetDoc(attr, spec["kind"], str(iid), spec["label"],
                                               f"{_DATA_PREFIX}/{family}/{name}", doc, readonly))

    for attr, spec in CONDITION_EXTRA_SPECS.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        prefix = ""
        if spec.get("subtree") and getattr(model, "_map_config_is_object", False):
            prefix = f"/{spec['subtree']}"
        src.assets.append(AssetDoc(
            attr, spec["kind"], "", spec["label"], f"{_DATA_PREFIX}/{spec['path']}", root,
            False, scan_emits=False, pointer_prefix=prefix,
        ))
    return src


# --------------------------------------------------------------------------- #
# 磁盘来源（调试器 / CLI / agent）
# --------------------------------------------------------------------------- #

def from_disk(project_root: Path | str) -> XrefSource:
    """从工程磁盘建来源：纯 stdlib、只读，不碰 PySide / ProjectModel / 编辑器模块。

    磁盘路径一律由上面那几个**仓库相对**常量拼出来——它们同时也是给编辑器跳转引擎的
    定位串，一处定义两处用，绝不会出现"扫的是这个文件、跳的是那个文件"。
    """
    root = Path(project_root)
    src = XrefSource(origin="disk", narrative=_read_json(root / NARRATIVE_FILE, {}))
    if not isinstance(src.narrative, dict):
        src.narrative = {}

    graphs_dir = root / _DIALOGUE_PREFIX
    if graphs_dir.is_dir():
        for path in sorted(graphs_dir.glob("*.json")):
            doc = _read_json(path, None)
            if isinstance(doc, dict):
                src.dialogues.append(DialogueDoc(path.stem, f"{_DIALOGUE_PREFIX}/{path.stem}.json", doc))

    for attr, spec in ASSET_SPECS.items():
        readonly = attr in READONLY_ATTRS
        mode = spec["mode"]
        if mode == "whole":
            rel = f"{_DATA_PREFIX}/{spec['path']}"
            doc = _read_json(root / rel, None)
            if doc is not None:
                src.assets.append(AssetDoc(attr, spec["kind"], "", spec["label"], rel, doc, readonly))
        elif mode == "perScene":
            scenes_dir = root / _SCENES_PREFIX
            if scenes_dir.is_dir():
                for path in sorted(scenes_dir.glob("*.json")):
                    doc = _read_json(path, None)
                    if isinstance(doc, dict):
                        src.assets.append(AssetDoc(attr, spec["kind"], path.stem, spec["label"],
                                                   f"{_SCENES_PREFIX}/{path.stem}.json", doc, readonly))
        elif mode == "minigame":
            family = spec["family"]
            files = _minigame_files_from_index(_read_json(root / _DATA_PREFIX / family / "index.json", None))
            for iid, name in sorted(files.items()):
                rel = f"{_DATA_PREFIX}/{family}/{name}"
                doc = _read_json(root / rel, None)
                if isinstance(doc, dict):
                    src.assets.append(AssetDoc(attr, spec["kind"], iid, spec["label"], rel, doc, readonly))

    for attr, spec in CONDITION_EXTRA_SPECS.items():
        rel = f"{_DATA_PREFIX}/{spec['path']}"
        doc = _read_json(root / rel, None)
        if doc is None:
            continue
        prefix = ""
        subtree = spec.get("subtree")
        if subtree and isinstance(doc, dict):
            # 模型侧存的是子树（map_nodes），磁盘侧也只能取同一棵，否则两个来源扫出的
            # 指针对不上（parity 测试会红）。
            doc = doc.get(subtree)
            prefix = f"/{subtree}"
            if doc is None:
                continue
        src.assets.append(AssetDoc(
            attr, spec["kind"], "", spec["label"], rel, doc, False,
            scan_emits=False, pointer_prefix=prefix,
        ))
    return src


def _minigame_files_from_index(index: Any) -> dict[str, str]:
    """小游戏族 index.json（[{id, file}]）→ {实例 id: 文件名}。"""
    out: dict[str, str] = {}
    if not isinstance(index, list):
        return out
    for row in index:
        if not isinstance(row, dict):
            continue
        iid = str(row.get("id") or "").strip()
        name = row.get("file")
        if iid and isinstance(name, str) and name.endswith(".json"):
            out[iid] = name
    return out


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default
