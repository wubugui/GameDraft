from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

from .models import Artifact, AuditResult, Issue


TOKEN_RE = re.compile(r"[a-zA-Z0-9_\-]+|[\u4e00-\u9fff]{2,}")


def analyze(root: Path, artifacts: list[Artifact], stale_days: int = 45, drift_days: int = 14) -> AuditResult:
    root = root.resolve()
    now = datetime.now()
    issues: list[Issue] = []

    for artifact in artifacts:
        issues.extend(_broken_reference_issues(artifact))
        issues.extend(_metadata_issues(artifact))
        issues.extend(_staleness_issues(root, artifact, now.timestamp(), stale_days))
        issues.extend(_drift_issues(root, artifact, drift_days))

    issues.extend(_overlap_issues(artifacts))
    issues = _dedupe_issues(issues)

    stats = _stats(artifacts, issues)
    return AuditResult(
        root=root.as_posix(),
        generated_at=now.isoformat(timespec="seconds"),
        artifacts=artifacts,
        issues=issues,
        stats=stats,
    )


def _broken_reference_issues(artifact: Artifact) -> list[Issue]:
    out: list[Issue] = []
    for ref in artifact.references:
        if ref.status != "missing":
            continue
        severity = "error" if ref.kind == "markdown_link" else "warn"
        out.append(
            Issue(
                id=_issue_id("broken-ref", artifact.id, ref.line, ref.target or ref.raw),
                severity=severity,
                category="broken-reference",
                artifact_id=artifact.id,
                path=artifact.path,
                line=ref.line,
                title="Reference target is missing",
                evidence=f"`{ref.raw}` resolves to no existing file or directory.",
                suggestion="Fix the path, remove the stale reference, or create/register the missing artifact.",
            )
        )
    return out


def _metadata_issues(artifact: Artifact) -> list[Issue]:
    out: list[Issue] = []
    if artifact.type == "skill":
        if not artifact.trigger_hints:
            out.append(
                Issue(
                    id=_issue_id("missing-trigger", artifact.id),
                    severity="warn",
                    category="missing-metadata",
                    artifact_id=artifact.id,
                    path=artifact.path,
                    line=1,
                    title="Skill has no clear trigger/use condition",
                    evidence="No obvious trigger/use/scope section was detected.",
                    suggestion="Add a short 'when to use / when not to use' section near the top of the skill.",
                )
            )
        text = " ".join([artifact.summary, *artifact.headings, *artifact.trigger_hints]).lower()
        if not any(word in text for word in ("status", "状态", "owner", "负责人", "last verified", "最近验证")):
            out.append(
                Issue(
                    id=_issue_id("missing-lifecycle", artifact.id),
                    severity="info",
                    category="missing-lifecycle",
                    artifact_id=artifact.id,
                    path=artifact.path,
                    line=1,
                    title="Skill has no lifecycle metadata",
                    evidence="No status/owner/last-verified style metadata was detected.",
                    suggestion="Consider adding status, owner, and last verified fields once the registry format is settled.",
                )
            )
    if artifact.type == "workflow_doc" and not artifact.commands and not any(r.status == "ok" for r in artifact.references):
        out.append(
            Issue(
                id=_issue_id("workflow-no-entry", artifact.id),
                severity="info",
                category="weak-workflow-entry",
                artifact_id=artifact.id,
                path=artifact.path,
                line=1,
                title="Workflow document has no obvious executable or linked entry",
                evidence="No command-like line and no resolved internal reference was detected.",
                suggestion="Link the workflow to its script/tool/checklist entry, or mark it as background planning material.",
            )
        )
    return out


def _staleness_issues(root: Path, artifact: Artifact, now_ts: float, stale_days: int) -> list[Issue]:
    if stale_days <= 0 or artifact.modified_ts <= 0:
        return []
    age_days = math.floor((now_ts - artifact.modified_ts) / 86400)
    if age_days < stale_days:
        return []
    severity = "warn" if artifact.type == "skill" else "info"
    return [
        Issue(
            id=_issue_id("stale", artifact.id),
            severity=severity,
            category="stale-candidate",
            artifact_id=artifact.id,
            path=artifact.path,
            line=1,
            title="Artifact has not changed recently",
            evidence=f"Last modified {age_days} days ago: {artifact.modified}.",
            suggestion="Review whether this artifact is still active, should be verified, or should be archived.",
        )
    ]


def _drift_issues(root: Path, artifact: Artifact, drift_days: int) -> list[Issue]:
    if drift_days <= 0 or artifact.type not in {"skill", "workflow_doc", "agent_rules"}:
        return []
    out: list[Issue] = []
    for ref in artifact.references:
        if ref.status != "ok" or not ref.resolved_to:
            continue
        target = root / ref.resolved_to
        if not target.is_file():
            continue
        try:
            delta_days = math.floor((target.stat().st_mtime - artifact.modified_ts) / 86400)
        except OSError:
            continue
        if delta_days >= drift_days:
            out.append(
                Issue(
                    id=_issue_id("drift", artifact.id, ref.line, ref.resolved_to),
                    severity="warn",
                    category="drift-risk",
                    artifact_id=artifact.id,
                    path=artifact.path,
                    line=ref.line,
                    title="Referenced artifact is newer than this rule/workflow",
                    evidence=f"`{ref.resolved_to}` is about {delta_days} days newer than this file.",
                    suggestion="Check whether the skill/workflow still describes the current implementation.",
                )
            )
    return out


def _overlap_issues(artifacts: list[Artifact]) -> list[Issue]:
    skills = [a for a in artifacts if a.type == "skill"]
    out: list[Issue] = []
    for i, left in enumerate(skills):
        for right in skills[i + 1 :]:
            score = _similarity(left, right)
            if score < 0.52:
                continue
            out.append(
                Issue(
                    id=_issue_id("overlap", left.id, right.id),
                    severity="info",
                    category="possible-overlap",
                    artifact_id=left.id,
                    path=left.path,
                    line=1,
                    title="Two skills may overlap",
                    evidence=f"`{left.path}` and `{right.path}` have token overlap score {score:.2f}.",
                    suggestion="Compare triggers and decide whether they should be split more clearly, merged, or cross-linked.",
                )
            )
    return out


def _similarity(left: Artifact, right: Artifact) -> float:
    lt = _tokens(" ".join([left.title, left.summary, *left.trigger_hints]))
    rt = _tokens(" ".join([right.title, right.summary, *right.trigger_hints]))
    if not lt or not rt:
        return 0.0
    inter = sum((lt & rt).values())
    union = sum((lt | rt).values())
    return inter / union if union else 0.0


def _tokens(text: str) -> Counter[str]:
    tokens = [t.lower().strip("-_") for t in TOKEN_RE.findall(text)]
    stop = {"the", "and", "for", "with", "this", "that", "skill", "mode", "use", "when", "file", "json", "md"}
    return Counter(t for t in tokens if len(t) >= 2 and t not in stop)


def _stats(artifacts: list[Artifact], issues: list[Issue]) -> dict[str, object]:
    by_type = Counter(a.type for a in artifacts)
    by_severity = Counter(i.severity for i in issues)
    by_category = Counter(i.category for i in issues)
    return {
        "artifact_count": len(artifacts),
        "issue_count": len(issues),
        "by_type": dict(sorted(by_type.items())),
        "by_severity": dict(sorted(by_severity.items())),
        "by_category": dict(sorted(by_category.items())),
    }


def _dedupe_issues(issues: list[Issue]) -> list[Issue]:
    seen: set[str] = set()
    out: list[Issue] = []
    order = {"error": 0, "warn": 1, "info": 2}
    for issue in sorted(issues, key=lambda x: (order.get(x.severity, 9), x.path, x.line, x.category, x.id)):
        if issue.id in seen:
            continue
        seen.add(issue.id)
        out.append(issue)
    return out


def _issue_id(*parts: object) -> str:
    raw = ".".join(str(p) for p in parts if p is not None)
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", raw).strip("-").lower()
