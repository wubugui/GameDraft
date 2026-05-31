"""Story-unit tracking built on top of narrative compositions.

Runtime JSON remains authoritative for game behavior. This module stores only
production metadata keyed by narrative composition id.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.shared.project_paths import ProjectPaths


SCHEMA_VERSION = 1
PRODUCTION_STATUSES = [
    "未做",
    "制作中",
    "可玩",
    "待验收",
    "通过",
    "冻结",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _workbench_dir(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench"


def story_units_path(project_root: Path) -> Path:
    return _workbench_dir(project_root) / "story_units.json"


@dataclass
class Blocker:
    text: str = ""
    severity: str = "blocker"
    status: str = "open"
    target: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Blocker":
        return cls(
            text=str(data.get("text") or ""),
            severity=str(data.get("severity") or "blocker"),
            status=str(data.get("status") or "open"),
            target=str(data.get("target") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "severity": self.severity,
            "status": self.status,
            "target": self.target,
        }


@dataclass
class AssetNeed:
    text: str = ""
    status: str = "needed"
    target: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AssetNeed":
        return cls(
            text=str(data.get("text") or ""),
            status=str(data.get("status") or "needed"),
            target=str(data.get("target") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "status": self.status,
            "target": self.target,
        }


@dataclass
class AcceptanceScript:
    """Manual/production acceptance script. This never writes runtime JSON."""

    start_entry: str = ""
    setup_flags: list[str] = field(default_factory=list)
    setup_quests: list[str] = field(default_factory=list)
    setup_scenarios: list[str] = field(default_factory=list)
    setup_narrative_states: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    option_choices: list[str] = field(default_factory=list)
    expected_signals: list[str] = field(default_factory=list)
    expected_narrative_states: list[str] = field(default_factory=list)
    expected_quest_changes: list[str] = field(default_factory=list)
    expected_scenario_changes: list[str] = field(default_factory=list)
    save_load_check: str = ""
    last_run_status: str = ""
    last_run_note: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AcceptanceScript":
        return cls(
            start_entry=str(data.get("startEntry") or ""),
            setup_flags=_string_list(data.get("setupFlags")),
            setup_quests=_string_list(data.get("setupQuests")),
            setup_scenarios=_string_list(data.get("setupScenarios")),
            setup_narrative_states=_string_list(data.get("setupNarrativeStates")),
            actions=_string_list(data.get("actions")),
            option_choices=_string_list(data.get("optionChoices")),
            expected_signals=_string_list(data.get("expectedSignals")),
            expected_narrative_states=_string_list(data.get("expectedNarrativeStates")),
            expected_quest_changes=_string_list(data.get("expectedQuestChanges")),
            expected_scenario_changes=_string_list(data.get("expectedScenarioChanges")),
            save_load_check=str(data.get("saveLoadCheck") or ""),
            last_run_status=str(data.get("lastRunStatus") or ""),
            last_run_note=str(data.get("lastRunNote") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "startEntry": self.start_entry,
            "setupFlags": self.setup_flags,
            "setupQuests": self.setup_quests,
            "setupScenarios": self.setup_scenarios,
            "setupNarrativeStates": self.setup_narrative_states,
            "actions": self.actions,
            "optionChoices": self.option_choices,
            "expectedSignals": self.expected_signals,
            "expectedNarrativeStates": self.expected_narrative_states,
            "expectedQuestChanges": self.expected_quest_changes,
            "expectedScenarioChanges": self.expected_scenario_changes,
            "saveLoadCheck": self.save_load_check,
            "lastRunStatus": self.last_run_status,
            "lastRunNote": self.last_run_note,
        }


@dataclass
class StoryUnitRecord:
    composition_id: str
    display_name: str = ""
    unit_type: str = ""
    production_status: str = "未做"
    entry: str = ""
    exit: str = ""
    acceptance: str = ""
    owner_note: str = ""
    blockers: list[Blocker] = field(default_factory=list)
    asset_needs: list[AssetNeed] = field(default_factory=list)
    acceptance_script: AcceptanceScript = field(default_factory=AcceptanceScript)
    manual_estimate_hours: float | None = None
    updated_at: str = ""
    last_checked_at: str = ""
    last_check_result: str = ""

    @classmethod
    def from_dict(cls, composition_id: str, data: dict[str, Any]) -> "StoryUnitRecord":
        estimate = data.get("manualEstimateHours")
        try:
            estimate_value = float(estimate) if estimate not in (None, "") else None
        except (TypeError, ValueError):
            estimate_value = None
        status = str(data.get("productionStatus") or "未做")
        if status not in PRODUCTION_STATUSES:
            status = "未做"
        return cls(
            composition_id=composition_id,
            display_name=str(data.get("displayName") or ""),
            unit_type=str(data.get("type") or ""),
            production_status=status,
            entry=str(data.get("entry") or ""),
            exit=str(data.get("exit") or ""),
            acceptance=str(data.get("acceptance") or ""),
            owner_note=str(data.get("ownerNote") or ""),
            blockers=[
                Blocker.from_dict(x)
                for x in data.get("blockers", [])
                if isinstance(x, dict)
            ],
            asset_needs=[
                AssetNeed.from_dict(x)
                for x in data.get("assetNeeds", [])
                if isinstance(x, dict)
            ],
            acceptance_script=AcceptanceScript.from_dict(
                data.get("acceptanceScript") if isinstance(data.get("acceptanceScript"), dict) else {}
            ),
            manual_estimate_hours=estimate_value,
            updated_at=str(data.get("updatedAt") or ""),
            last_checked_at=str(data.get("lastCheckedAt") or ""),
            last_check_result=str(data.get("lastCheckResult") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "compositionId": self.composition_id,
            "displayName": self.display_name,
            "type": self.unit_type,
            "productionStatus": self.production_status,
            "entry": self.entry,
            "exit": self.exit,
            "acceptance": self.acceptance,
            "ownerNote": self.owner_note,
            "blockers": [x.to_dict() for x in self.blockers],
            "assetNeeds": [x.to_dict() for x in self.asset_needs],
            "acceptanceScript": self.acceptance_script.to_dict(),
            "manualEstimateHours": self.manual_estimate_hours,
            "updatedAt": self.updated_at,
            "lastCheckedAt": self.last_checked_at,
            "lastCheckResult": self.last_check_result,
        }
        return out


@dataclass
class StoryUnitSummary:
    composition_id: str
    label: str
    description: str
    main_graph_id: str
    graph_ids: list[str] = field(default_factory=list)
    states: list[str] = field(default_factory=list)
    signals: list[str] = field(default_factory=list)
    dialogues: list[str] = field(default_factory=list)
    zones: list[str] = field(default_factory=list)
    minigames: list[str] = field(default_factory=list)
    quests: list[str] = field(default_factory=list)
    scenarios: list[str] = field(default_factory=list)
    assets: list[str] = field(default_factory=list)
    projection_warnings: list[str] = field(default_factory=list)
    validation_issues: list[str] = field(default_factory=list)


@dataclass
class StoryUnit:
    record: StoryUnitRecord
    summary: StoryUnitSummary


@dataclass
class StoryUnitWorkspace:
    project_root: Path
    units: list[StoryUnit]
    raw_tracking: dict[str, Any]

    def by_id(self) -> dict[str, StoryUnit]:
        return {u.record.composition_id: u for u in self.units}


def _load_tracking(project_root: Path) -> dict[str, Any]:
    path = story_units_path(project_root)
    if not path.is_file():
        return {"schemaVersion": SCHEMA_VERSION, "units": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schemaVersion": SCHEMA_VERSION, "units": {}}
    if not isinstance(data, dict):
        return {"schemaVersion": SCHEMA_VERSION, "units": {}}
    units = data.get("units")
    if not isinstance(units, dict):
        units = {}
    return {"schemaVersion": SCHEMA_VERSION, "units": units}


def save_story_unit_workspace(workspace: StoryUnitWorkspace) -> Path:
    path = story_units_path(workspace.project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    units: dict[str, Any] = {}
    for unit in workspace.units:
        rec = unit.record
        if not rec.updated_at:
            rec.updated_at = _now_iso()
        units[rec.composition_id] = rec.to_dict()
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "units": units,
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def load_story_unit_workspace(project_root: Path) -> StoryUnitWorkspace:
    project_root = project_root.resolve()
    model = ProjectModel()
    model.load_project(project_root)
    tracking = _load_tracking(project_root)
    records_raw = tracking.get("units") if isinstance(tracking.get("units"), dict) else {}

    projection, issues = _project_narrative_context(model)
    units: list[StoryUnit] = []
    for comp in _composition_list(model.narrative_graphs):
        cid = str(comp.get("id") or "").strip()
        if not cid:
            continue
        raw = records_raw.get(cid) if isinstance(records_raw, dict) else None
        record = StoryUnitRecord.from_dict(cid, raw if isinstance(raw, dict) else {})
        if not record.display_name:
            record.display_name = str(comp.get("label") or cid)
        summary = _summarize_composition(comp, projection, issues)
        units.append(StoryUnit(record=record, summary=summary))
    return StoryUnitWorkspace(project_root=project_root, units=units, raw_tracking=tracking)


def story_unit_completeness_issues(unit: StoryUnit) -> list[str]:
    issues: list[str] = []
    rec = unit.record
    if not rec.entry.strip():
        issues.append("缺入口")
    if not rec.exit.strip():
        issues.append("缺出口")
    if not rec.acceptance.strip():
        issues.append("缺验收")
    open_blockers = [b for b in rec.blockers if b.status != "resolved" and b.text.strip()]
    if open_blockers:
        issues.append(f"阻塞 {len(open_blockers)} 项")
    if rec.production_status in {"可玩", "待验收", "通过"} and issues:
        issues.append("状态已推进但追踪信息未补齐")
    if rec.production_status in {"待验收", "通过"}:
        issues.extend(acceptance_script_issues(unit))
    return issues


def acceptance_script_issues(unit: StoryUnit) -> list[str]:
    rec = unit.record
    script = rec.acceptance_script
    issues: list[str] = []
    if not (script.start_entry.strip() or rec.entry.strip()):
        issues.append("验收脚本缺入口")
    if not (script.actions or script.option_choices):
        issues.append("验收脚本缺执行步骤")
    if not (
        script.expected_signals
        or script.expected_narrative_states
        or script.expected_quest_changes
        or script.expected_scenario_changes
    ):
        issues.append("验收脚本缺期望结果")
    if not script.save_load_check.strip():
        issues.append("验收脚本缺存读档复查")
    return issues


def story_unit_report(unit: StoryUnit) -> str:
    rec = unit.record
    s = unit.summary
    issues = story_unit_completeness_issues(unit)
    lines = [
        f"剧情单元: {rec.display_name or s.label} ({rec.composition_id})",
        f"状态: {rec.production_status}",
        f"类型: {rec.unit_type or '(未填)'}",
        f"入口: {rec.entry or '(未填)'}",
        f"出口: {rec.exit or '(未填)'}",
        f"验收: {rec.acceptance or '(未填)'}",
        f"问题: {', '.join(issues) if issues else '无'}",
        "",
        "涉及内容:",
        f"- Graph: {', '.join(s.graph_ids) or '(无)'}",
        f"- Dialogue: {', '.join(s.dialogues) or '(无)'}",
        f"- Quest: {', '.join(s.quests) or '(无)'}",
        f"- Scenario: {', '.join(s.scenarios) or '(无)'}",
        f"- Zone: {', '.join(s.zones) or '(无)'}",
        f"- Minigame: {', '.join(s.minigames) or '(无)'}",
        f"- Signal: {', '.join(s.signals) or '(无)'}",
    ]
    if rec.blockers:
        lines.append("")
        lines.append("阻塞:")
        for b in rec.blockers:
            if b.text.strip():
                lines.append(f"- [{b.status}/{b.severity}] {b.text}")
    if rec.asset_needs:
        lines.append("")
        lines.append("素材需求:")
        for a in rec.asset_needs:
            if a.text.strip():
                lines.append(f"- [{a.status}] {a.text}")
    script = rec.acceptance_script
    script_issues = acceptance_script_issues(unit)
    lines.append("")
    lines.append("验收脚本:")
    lines.append(f"- 入口: {script.start_entry or rec.entry or '(未填)'}")
    lines.append(f"- 初始 flag: {', '.join(script.setup_flags) or '(无)'}")
    lines.append(f"- 初始 quest: {', '.join(script.setup_quests) or '(无)'}")
    lines.append(f"- 初始 scenario: {', '.join(script.setup_scenarios) or '(无)'}")
    lines.append(f"- 初始 narrative state: {', '.join(script.setup_narrative_states) or '(无)'}")
    lines.append(f"- 执行步骤: {'；'.join(script.actions) or '(未填)'}")
    lines.append(f"- 选择 option: {'；'.join(script.option_choices) or '(无)'}")
    lines.append(f"- 期望 signal: {', '.join(script.expected_signals) or '(无)'}")
    lines.append(f"- 期望 narrative state: {', '.join(script.expected_narrative_states) or '(无)'}")
    lines.append(f"- 期望 quest 变化: {'；'.join(script.expected_quest_changes) or '(无)'}")
    lines.append(f"- 期望 scenario 变化: {'；'.join(script.expected_scenario_changes) or '(无)'}")
    lines.append(f"- 存读档复查: {script.save_load_check or '(未填)'}")
    if script.last_run_status or script.last_run_note:
        lines.append(f"- 最近验收: {script.last_run_status or '(未标记)'} {script.last_run_note}".rstrip())
    lines.append(f"- 脚本问题: {', '.join(script_issues) if script_issues else '无'}")
    return "\n".join(lines)


def _project_narrative_context(model: ProjectModel) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from tools.editor.editors.narrative_state_editor import (
        derive_projection,
        validate_narrative_graphs,
        validate_project_context,
    )

    data = model.narrative_graphs if isinstance(model.narrative_graphs, dict) else {}
    projection = derive_projection(data, model)
    issues = validate_narrative_graphs(data) + validate_project_context(data, model)
    return projection, issues


def _composition_list(data: dict[str, Any]) -> list[dict[str, Any]]:
    comps = data.get("compositions") if isinstance(data, dict) else []
    return [x for x in comps if isinstance(x, dict)]


def _summarize_composition(
    comp: dict[str, Any],
    projection: dict[str, Any],
    validation_issues: list[dict[str, Any]],
) -> StoryUnitSummary:
    cid = str(comp.get("id") or "").strip()
    main = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
    main_graph_id = str(main.get("id") or "").strip()
    summary = StoryUnitSummary(
        composition_id=cid,
        label=str(comp.get("label") or cid),
        description=str(comp.get("description") or ""),
        main_graph_id=main_graph_id,
    )
    _collect_graph(summary, main)
    for el in comp.get("elements", []) or []:
        if not isinstance(el, dict):
            continue
        kind = str(el.get("kind") or "").strip()
        ref_id = str(el.get("refId") or "").strip()
        owner_type = str(el.get("ownerType") or "").strip()
        owner_id = str(el.get("ownerId") or "").strip()
        if kind == "dialogueBlackbox" and ref_id:
            _add_unique(summary.dialogues, ref_id)
        elif kind == "zoneBlackbox" and ref_id:
            _add_unique(summary.zones, ref_id)
        elif kind == "minigameBlackbox" and ref_id:
            _add_unique(summary.minigames, ref_id)
        elif kind == "scenarioSubgraph":
            _add_unique(summary.scenarios, ref_id or owner_id)
        if owner_type == "quest" and owner_id:
            _add_unique(summary.quests, owner_id)
        if owner_type == "scenario" and owner_id:
            _add_unique(summary.scenarios, owner_id)
        graph = el.get("graph") if isinstance(el.get("graph"), dict) else None
        if graph is not None:
            _collect_graph(summary, graph)
        meta = el.get("meta") if isinstance(el.get("meta"), dict) else {}
        for sig in meta.get("emits", []) or []:
            _add_unique(summary.signals, str(sig))
        for command in meta.get("commands", []) or []:
            _add_unique(summary.states, str(command))

    for warning in projection.get("warnings", []) or []:
        if not isinstance(warning, dict):
            continue
        if str(warning.get("compositionId") or "") == cid:
            _add_unique(summary.projection_warnings, _issue_text(warning))
    for issue in validation_issues:
        if _issue_belongs_to_composition(issue, cid):
            _add_unique(summary.validation_issues, _issue_text(issue))
    return summary


def _collect_graph(summary: StoryUnitSummary, graph: dict[str, Any]) -> None:
    gid = str(graph.get("id") or "").strip()
    if gid:
        _add_unique(summary.graph_ids, gid)
    states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
    for sid, state in states.items():
        label = ""
        if isinstance(state, dict):
            label = str(state.get("label") or "")
        _add_unique(summary.states, f"{gid}.{sid}" + (f" ({label})" if label else ""))
    for transition in graph.get("transitions", []) or []:
        if isinstance(transition, dict):
            sig = str(transition.get("signal") or "").strip()
            if sig:
                _add_unique(summary.signals, sig)


def _issue_belongs_to_composition(issue: dict[str, Any], composition_id: str) -> bool:
    target = issue.get("target")
    if isinstance(target, dict) and str(target.get("compositionId") or "") == composition_id:
        return True
    path = str(issue.get("path") or "")
    return bool(composition_id and composition_id in path)


def _issue_text(issue: dict[str, Any]) -> str:
    code = str(issue.get("code") or "issue")
    message = str(issue.get("message") or "")
    severity = str(issue.get("severity") or "")
    return f"{severity}:{code}: {message}".strip(": ")


def _add_unique(items: list[str], value: str) -> None:
    v = value.strip()
    if v and v not in items:
        items.append(v)


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    return []
