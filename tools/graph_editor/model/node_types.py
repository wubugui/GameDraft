from enum import Enum, auto
from dataclasses import dataclass, field
from typing import Any


class NodeType(Enum):
    FLAG = auto()
    QUEST = auto()
    ENCOUNTER = auto()
    DIALOGUE_KNOT = auto()
    SCENE = auto()
    HOTSPOT = auto()
    NPC = auto()
    RULE = auto()
    FRAGMENT = auto()
    ITEM = auto()
    ZONE = auto()
    QUEST_GROUP = auto()


NODE_COLORS = {
    NodeType.FLAG: "#F59E0B",
    NodeType.QUEST: "#3B82F6",
    NodeType.ENCOUNTER: "#EF4444",
    NodeType.DIALOGUE_KNOT: "#8B5CF6",
    NodeType.SCENE: "#10B981",
    NodeType.HOTSPOT: "#6EE7B7",
    NodeType.NPC: "#EC4899",
    NodeType.RULE: "#F97316",
    NodeType.FRAGMENT: "#FBBF24",
    NodeType.ITEM: "#14B8A6",
    NodeType.ZONE: "#06B6D4",
    NodeType.QUEST_GROUP: "#325090",
}

NODE_LABELS = {
    NodeType.FLAG: "Flag",
    NodeType.QUEST: "Quest",
    NodeType.ENCOUNTER: "Encounter",
    NodeType.DIALOGUE_KNOT: "Dialogue",
    NodeType.SCENE: "Scene",
    NodeType.HOTSPOT: "Hotspot",
    NodeType.NPC: "NPC",
    NodeType.RULE: "Rule",
    NodeType.FRAGMENT: "Fragment",
    NodeType.ITEM: "Item",
    NodeType.ZONE: "Zone",
    NodeType.QUEST_GROUP: "Quest Group",
}

EDITABLE_TYPES = {
    NodeType.QUEST,
    NodeType.ENCOUNTER,
    NodeType.ITEM,
    NodeType.RULE,
    NodeType.FRAGMENT,
    NodeType.SCENE,
    NodeType.HOTSPOT,
    NodeType.NPC,
    NodeType.ZONE,
}


@dataclass
class NodeData:
    id: str
    node_type: NodeType
    label: str
    source_file: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    dirty: bool = False
