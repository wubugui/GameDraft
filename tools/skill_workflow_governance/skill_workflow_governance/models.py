from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


def posix(path: Path) -> str:
    return path.as_posix()


@dataclass
class Reference:
    raw: str
    kind: str
    line: int
    target: str | None = None
    status: str = "unresolved"
    resolved_to: str | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Artifact:
    id: str
    type: str
    title: str
    path: str
    source: str
    summary: str = ""
    agent: str = "shared"
    modified: str = ""
    modified_ts: float = 0.0
    size: int = 0
    headings: list[str] = field(default_factory=list)
    trigger_hints: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    references: list[Reference] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["references"] = [r.to_dict() for r in self.references]
        return data


@dataclass
class Issue:
    id: str
    severity: str
    category: str
    artifact_id: str
    path: str
    line: int
    title: str
    evidence: str
    suggestion: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AuditResult:
    root: str
    generated_at: str
    artifacts: list[Artifact]
    issues: list[Issue]
    stats: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "generated_at": self.generated_at,
            "artifacts": [a.to_dict() for a in self.artifacts],
            "issues": [i.to_dict() for i in self.issues],
            "stats": self.stats,
        }
