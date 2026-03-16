from enum import Enum, auto


class EdgeType(Enum):
    WRITES_FLAG = auto()
    READS_FLAG = auto()
    NEXT_QUEST = auto()
    TRIGGERS = auto()
    CONTAINS = auto()
    GIVES = auto()
    CONSUMES = auto()
    SYNTHESIZES = auto()
    TRANSITIONS = auto()
    DIVERTS = auto()
    CHOICE = auto()
    RULE_SLOT = auto()


EDGE_COLORS = {
    EdgeType.WRITES_FLAG: "#F59E0B",
    EdgeType.READS_FLAG: "#94A3B8",
    EdgeType.NEXT_QUEST: "#3B82F6",
    EdgeType.TRIGGERS: "#EF4444",
    EdgeType.CONTAINS: "#D1D5DB",
    EdgeType.GIVES: "#10B981",
    EdgeType.CONSUMES: "#F97316",
    EdgeType.SYNTHESIZES: "#FBBF24",
    EdgeType.TRANSITIONS: "#6EE7B7",
    EdgeType.DIVERTS: "#8B5CF6",
    EdgeType.CHOICE: "#A78BFA",
    EdgeType.RULE_SLOT: "#06B6D4",
}

EDGE_LABELS = {
    EdgeType.WRITES_FLAG: "writes",
    EdgeType.READS_FLAG: "reads",
    EdgeType.NEXT_QUEST: "next",
    EdgeType.TRIGGERS: "triggers",
    EdgeType.CONTAINS: "contains",
    EdgeType.GIVES: "gives",
    EdgeType.CONSUMES: "consumes",
    EdgeType.SYNTHESIZES: "synthesizes",
    EdgeType.TRANSITIONS: "transition",
    EdgeType.DIVERTS: "divert",
    EdgeType.CHOICE: "choice",
    EdgeType.RULE_SLOT: "ruleSlot",
}
