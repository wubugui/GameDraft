"""Static acceptance-script checks for story units.

This is a production safety layer, not runtime state. It verifies that the
manual acceptance script points at real project ids before a unit is marked
ready for review.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from tools.editor.project_model import ProjectModel

from .runtime_debug import RuntimeDebugSnapshotReport, load_runtime_debug_snapshot
from .story_acceptance_commands import (
    save_load_check_requests_reload,
    save_load_check_requests_save_load,
    save_slot_from_text,
)
from .story_units import StoryUnit, acceptance_script_issues


@dataclass(frozen=True)
class AcceptanceCheckIssue:
    severity: str
    code: str
    message: str
    field: str = ""


@dataclass(frozen=True)
class AcceptanceCheckReport:
    composition_id: str
    display_name: str
    ok: bool
    issues: list[AcceptanceCheckIssue] = field(default_factory=list)
    checked_items: list[str] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "warning")


def check_story_unit_acceptance_script(
    project_root: Path,
    unit: StoryUnit,
    *,
    model: ProjectModel | None = None,
    include_completeness: bool = True,
) -> AcceptanceCheckReport:
    model = model or _load_model(project_root)
    indexes = _AcceptanceIndexes.from_model(model)
    issues: list[AcceptanceCheckIssue] = []
    checked: list[str] = []
    script = unit.record.acceptance_script

    def add(severity: str, code: str, message: str, field: str = "") -> None:
        issues.append(AcceptanceCheckIssue(severity, code, message, field))

    if include_completeness:
        for item in acceptance_script_issues(unit):
            add("error", "acceptance.required", item, "acceptanceScript")

    for field, values in [
        ("setupNarrativeStates", script.setup_narrative_states),
        ("expectedNarrativeStates", script.expected_narrative_states),
    ]:
        for raw in values:
            state_ref = _parse_graph_state_ref(raw)
            if state_ref is None:
                add("warning", "acceptance.state.unparsed", f"{field}: 无法识别 graph.state：{raw}", field)
                continue
            graph_id, state_id = state_ref
            checked.append(f"state:{graph_id}.{state_id}")
            states = indexes.graph_states.get(graph_id)
            if states is None:
                add("error", "acceptance.graph.missing", f"{field}: narrative graph 不存在：{graph_id}", field)
            elif state_id not in states:
                add("error", "acceptance.state.missing", f"{field}: narrative state 不存在：{graph_id}.{state_id}", field)

    for raw in script.expected_signals:
        signal = _first_identifier(raw)
        if not signal:
            add("warning", "acceptance.signal.unparsed", f"expectedSignals: 无法识别 signal：{raw}", "expectedSignals")
            continue
        checked.append(f"signal:{signal}")
        if signal not in indexes.signals:
            add("error", "acceptance.signal.missing", f"expectedSignals: signal 不存在：{signal}", "expectedSignals")

    for field, values, known, label in [
        ("setupQuests", script.setup_quests, indexes.quests, "quest"),
        ("expectedQuestChanges", script.expected_quest_changes, indexes.quests, "quest"),
        ("setupScenarios", script.setup_scenarios, indexes.scenarios, "scenario"),
        ("expectedScenarioChanges", script.expected_scenario_changes, indexes.scenarios, "scenario"),
    ]:
        for raw in values:
            item_id = _first_identifier(raw)
            if not item_id:
                add("warning", f"acceptance.{label}.unparsed", f"{field}: 无法识别 {label} id：{raw}", field)
                continue
            checked.append(f"{label}:{item_id}")
            if item_id not in known:
                add("error", f"acceptance.{label}.missing", f"{field}: {label} 不存在：{item_id}", field)

    for raw in script.setup_flags:
        flag = _first_identifier(raw)
        if not flag:
            add("warning", "acceptance.flag.unparsed", f"setupFlags: 无法识别 flag：{raw}", "setupFlags")
            continue
        checked.append(f"flag:{flag}")
        if flag not in indexes.flags:
            add("warning", "acceptance.flag.unknown", f"setupFlags: flag 未在现有数据中发现：{flag}", "setupFlags")

    for field, values in [("actions", script.actions), ("optionChoices", script.option_choices)]:
        for raw in values:
            for dialogue_id in _extract_prefixed_refs(raw, ["dialogue", "dialogueGraph"]):
                checked.append(f"dialogue:{dialogue_id}")
                if dialogue_id not in indexes.dialogues:
                    add("error", "acceptance.dialogue.missing", f"{field}: dialogue graph 不存在：{dialogue_id}", field)
            for graph_id in _extract_prefixed_refs(raw, ["narrative", "graph"]):
                checked.append(f"graph:{graph_id}")
                if graph_id not in indexes.graph_states:
                    add("error", "acceptance.graph.missing", f"{field}: narrative graph 不存在：{graph_id}", field)
            for scene_id in _extract_prefixed_refs(raw, ["scene"]):
                checked.append(f"scene:{scene_id}")
                if scene_id not in indexes.scenes:
                    add("error", "acceptance.scene.missing", f"{field}: scene 不存在：{scene_id}", field)

    ok = not any(issue.severity == "error" for issue in issues)
    return AcceptanceCheckReport(
        composition_id=unit.record.composition_id,
        display_name=unit.record.display_name or unit.summary.label,
        ok=ok,
        issues=issues,
        checked_items=_unique(checked),
    )


def format_acceptance_check_report(report: AcceptanceCheckReport) -> str:
    lines = [
        "剧情单元验收脚本检查: " + ("通过" if report.ok else "未通过"),
        f"剧情单元: {report.display_name} ({report.composition_id})",
        f"error={report.error_count}, warning={report.warning_count}",
        "",
    ]
    if report.checked_items:
        lines.append("已检查引用:")
        lines.extend(f"- {item}" for item in report.checked_items)
        lines.append("")
    if not report.issues:
        lines.append("无问题。")
        return "\n".join(lines)
    lines.append("问题:")
    for issue in report.issues:
        field = f" [{issue.field}]" if issue.field else ""
        lines.append(f"- {issue.severity}{field} {issue.code}: {issue.message}")
    return "\n".join(lines)


@dataclass(frozen=True)
class AcceptanceRuntimeCheck:
    status: str
    field: str
    expected: str
    actual: str = ""
    message: str = ""


@dataclass(frozen=True)
class AcceptanceRuntimeCompareReport:
    composition_id: str
    display_name: str
    ok: bool
    runtime_ok: bool
    snapshot_path: Path
    captured_at: str = ""
    reason: str = ""
    checks: list[AcceptanceRuntimeCheck] = field(default_factory=list)
    message: str = ""

    @property
    def pass_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "pass")

    @property
    def fail_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "fail")

    @property
    def warning_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "warning")

    @property
    def manual_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "manual")


def compare_story_unit_acceptance_to_runtime_snapshot(
    project_root: Path,
    unit: StoryUnit,
    *,
    runtime_report: RuntimeDebugSnapshotReport | None = None,
) -> AcceptanceRuntimeCompareReport:
    """Compare one story unit's expected outcomes with the latest runtime snapshot.

    This does not drive the game. It answers a narrower production question:
    "Given the latest browser runtime snapshot, did the tracked acceptance
    expectations show up in state/trace?"
    """
    runtime = runtime_report or load_runtime_debug_snapshot(project_root)
    checks: list[AcceptanceRuntimeCheck] = []
    script = unit.record.acceptance_script

    def add(status: str, field: str, expected: str, actual: str = "", message: str = "") -> None:
        checks.append(AcceptanceRuntimeCheck(status, field, expected, actual, message))

    if not runtime.ok:
        add("fail", "runtimeSnapshot", "可读取的运行时快照", str(runtime.path), runtime.message)
        return AcceptanceRuntimeCompareReport(
            composition_id=unit.record.composition_id,
            display_name=unit.record.display_name or unit.summary.label,
            ok=False,
            runtime_ok=False,
            snapshot_path=runtime.path,
            checks=checks,
            message=runtime.message,
        )

    auto_fields = 0
    for raw in script.expected_signals:
        auto_fields += 1
        signal = _first_identifier(raw)
        if not signal:
            add("warning", "expectedSignals", raw, "", "无法识别 signal id")
            continue
        if _runtime_signal_seen(runtime, signal):
            add("pass", "expectedSignals", signal, "runtime trace 命中")
        else:
            add(
                "fail",
                "expectedSignals",
                signal,
                _runtime_trigger_summary(runtime),
                "最新 trace 里没有看到这个 signal",
            )

    for raw in script.expected_narrative_states:
        auto_fields += 1
        state_ref = _parse_graph_state_ref(raw)
        if state_ref is None:
            add("warning", "expectedNarrativeStates", raw, "", "无法识别 graph.state")
            continue
        graph_id, state_id = state_ref
        actual = runtime.active_states.get(graph_id)
        if actual == state_id:
            add("pass", "expectedNarrativeStates", f"{graph_id}.{state_id}", f"当前 {graph_id}.{actual}")
        elif _runtime_state_visited(runtime, graph_id, state_id):
            add(
                "warning",
                "expectedNarrativeStates",
                f"{graph_id}.{state_id}",
                f"当前 {graph_id}.{actual or '(无)'}",
                "trace 曾进入该状态，但最新 active state 已经变成别的状态",
            )
        else:
            add(
                "fail",
                "expectedNarrativeStates",
                f"{graph_id}.{state_id}",
                f"当前 {graph_id}.{actual or '(无)'}",
                "当前状态和最近 trace 都没有命中",
            )

    for raw in script.expected_quest_changes:
        auto_fields += 1
        quest_id = _first_identifier(raw)
        if not quest_id:
            add("warning", "expectedQuestChanges", raw, "", "无法识别 quest id")
            continue
        want = _expected_quest_status(raw)
        actual_raw = runtime.quest_state.get(quest_id)
        actual = _quest_status_label(actual_raw)
        if want is None:
            if actual_raw is not None and actual != "Inactive":
                add("pass", "expectedQuestChanges", raw, f"{quest_id}={actual}")
            else:
                add("fail", "expectedQuestChanges", raw, f"{quest_id}={actual}", "没有看到 quest 进入非 inactive 状态")
        elif actual == want:
            add("pass", "expectedQuestChanges", raw, f"{quest_id}={actual}")
        else:
            add("fail", "expectedQuestChanges", raw, f"{quest_id}={actual}", f"期望 {want}")

    for raw in script.expected_scenario_changes:
        auto_fields += 1
        expected = _parse_expected_scenario(raw)
        if expected is None:
            add("warning", "expectedScenarioChanges", raw, "", "无法识别 scenario id")
            continue
        actual = _runtime_scenario_actual(runtime, expected)
        if _scenario_expectation_met(expected, actual):
            add("pass", "expectedScenarioChanges", raw, actual or "(命中)")
        else:
            add("fail", "expectedScenarioChanges", raw, actual or "(无)", _scenario_expectation_message(expected))

    if script.save_load_check.strip():
        _compare_save_load_check(script.save_load_check, runtime, add)

    if auto_fields == 0:
        add("warning", "acceptanceScript", "至少一个可自动对比的期望项", "", "没有 expected signal/state/quest/scenario")

    ok = not any(check.status == "fail" for check in checks)
    return AcceptanceRuntimeCompareReport(
        composition_id=unit.record.composition_id,
        display_name=unit.record.display_name or unit.summary.label,
        ok=ok,
        runtime_ok=True,
        snapshot_path=runtime.path,
        captured_at=runtime.captured_at,
        reason=runtime.reason,
        checks=checks,
    )


def _compare_save_load_check(
    raw: str,
    runtime: RuntimeDebugSnapshotReport,
    add: Callable[[str, str, str, str, str], None],
) -> None:
    text = raw.strip()
    if not text:
        return
    if _has_any_word(text, ["人工", "手动", "manual"]):
        add("manual", "saveLoadCheck", text, "", "存读档复查标记为人工确认")
        return

    wants_save_load = save_load_check_requests_save_load(text)
    wants_reload = save_load_check_requests_reload(text)
    if not wants_save_load and not wants_reload:
        add("manual", "saveLoadCheck", text, "", "无法识别为自动存读档/重进场景复查")
        return

    results = runtime.runtime_command_results
    if not results:
        add("warning", "saveLoadCheck", text, "", "没有 runtime command results，无法确认存读档/重进是否执行")
        return

    slot = save_slot_from_text(text) or 2
    if wants_save_load:
        save_ok = _runtime_command_ok(results, "debugSaveGame")
        load_ok = _runtime_command_ok(results, "debugLoadGame")
        if save_ok and load_ok:
            add("pass", "saveLoadCheck", f"保存读档 slot:{slot}", "debugSaveGame/debugLoadGame")
        else:
            add(
                "fail",
                "saveLoadCheck",
                f"保存读档 slot:{slot}",
                _runtime_command_status_text(results, ["debugSaveGame", "debugLoadGame"]),
                "保存或读档 runtime command 未成功",
            )
    if wants_reload:
        reload_ok = _runtime_command_ok(results, "debugReloadScene")
        if reload_ok:
            add("pass", "saveLoadCheck", "重进场景", "debugReloadScene")
        else:
            add(
                "fail",
                "saveLoadCheck",
                "重进场景",
                _runtime_command_status_text(results, ["debugReloadScene"]),
                "重进场景 runtime command 未成功",
            )


def _runtime_command_ok(results: list[dict[str, Any]], command_type: str) -> bool:
    return any(str(item.get("type") or "") == command_type and bool(item.get("ok")) for item in results)


def _runtime_command_status_text(results: list[dict[str, Any]], command_types: list[str]) -> str:
    wanted = set(command_types)
    parts = []
    for item in results:
        typ = str(item.get("type") or "")
        if typ not in wanted:
            continue
        status = "OK" if item.get("ok") else "FAIL"
        msg = str(item.get("message") or "")
        parts.append(f"{typ}:{status}{f'({msg})' if msg else ''}")
    return ", ".join(parts) or "未看到对应 runtime command"


def _has_any_word(raw: str, words: list[str]) -> bool:
    text = raw.lower()
    return any(word.lower() in text for word in words)


def format_acceptance_runtime_compare_report(report: AcceptanceRuntimeCompareReport) -> str:
    lines = [
        "剧情单元运行时验收对比: " + ("通过" if report.ok else "未通过"),
        f"剧情单元: {report.display_name} ({report.composition_id})",
        f"快照: {report.snapshot_path}",
    ]
    if report.captured_at:
        lines.append(f"时间: {report.captured_at}")
    if report.reason:
        lines.append(f"触发: {report.reason}")
    lines.extend([
        f"pass={report.pass_count}, fail={report.fail_count}, warning={report.warning_count}, manual={report.manual_count}",
        "",
    ])
    if report.message:
        lines.extend(["说明:", report.message, ""])
    if not report.checks:
        lines.append("没有可对比项。")
        return "\n".join(lines)
    for title, status in [
        ("通过", "pass"),
        ("未通过", "fail"),
        ("警告", "warning"),
        ("需要人工复查", "manual"),
    ]:
        group = [check for check in report.checks if check.status == status]
        if not group:
            continue
        lines.append(title + ":")
        for check in group:
            actual = f"；实际: {check.actual}" if check.actual else ""
            message = f"；说明: {check.message}" if check.message else ""
            lines.append(f"- [{check.field}] 期望: {check.expected}{actual}{message}")
        lines.append("")
    return "\n".join(lines).rstrip()


@dataclass(frozen=True)
class _AcceptanceIndexes:
    graph_states: dict[str, set[str]]
    signals: set[str]
    dialogues: set[str]
    quests: set[str]
    scenarios: set[str]
    scenes: set[str]
    flags: set[str]

    @classmethod
    def from_model(cls, model: ProjectModel) -> "_AcceptanceIndexes":
        graph_states, signals = _narrative_indexes(model.narrative_graphs)
        signals.update(_string_ids(model.narrative_graphs.get("signals") if isinstance(model.narrative_graphs, dict) else []))
        flags = set(model.all_flags())
        registry = model.flag_registry
        if isinstance(registry, dict):
            for key in registry.keys():
                if str(key).strip():
                    flags.add(str(key).strip())
            raw_flags = registry.get("flags")
            if isinstance(raw_flags, list):
                flags.update(_string_ids(raw_flags))
            elif isinstance(raw_flags, dict):
                flags.update(str(k).strip() for k in raw_flags.keys() if str(k).strip())
        return cls(
            graph_states=graph_states,
            signals=signals,
            dialogues=set(model.all_dialogue_graph_ids()),
            quests={qid for qid, _label in model.all_quest_ids()},
            scenarios=set(model.scenario_ids_ordered()),
            scenes=set(model.scenes.keys()),
            flags=flags,
        )


def _load_model(project_root: Path) -> ProjectModel:
    model = ProjectModel()
    model.load_project(project_root.resolve())
    return model


def _narrative_indexes(data: dict[str, Any]) -> tuple[dict[str, set[str]], set[str]]:
    graph_states: dict[str, set[str]] = {}
    signals: set[str] = set()

    def visit_graph(graph: Any) -> None:
        if not isinstance(graph, dict):
            return
        gid = str(graph.get("id") or "").strip()
        if not gid:
            return
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        graph_states.setdefault(gid, set()).update(str(sid).strip() for sid in states.keys() if str(sid).strip())
        for transition in graph.get("transitions", []) or []:
            if isinstance(transition, dict):
                signal = str(transition.get("signal") or "").strip()
                if signal:
                    signals.add(signal)

    if not isinstance(data, dict):
        return graph_states, signals
    for graph in data.get("graphs", []) or []:
        visit_graph(graph)
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        visit_graph(comp.get("mainGraph"))
        for element in comp.get("elements", []) or []:
            if isinstance(element, dict):
                visit_graph(element.get("graph"))
                meta = element.get("meta") if isinstance(element.get("meta"), dict) else {}
                for signal in meta.get("emits", []) or []:
                    if str(signal).strip():
                        signals.add(str(signal).strip())
    return graph_states, signals


def _string_ids(value: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                raw = item.get("id")
            else:
                raw = item
            text = str(raw or "").strip()
            if text:
                out.add(text)
    return out


def _parse_graph_state_ref(raw: str) -> tuple[str, str] | None:
    text = str(raw or "").strip()
    match = re.search(r"([0-9A-Za-z_\-\u4e00-\u9fff]+)\.([0-9A-Za-z_\-\u4e00-\u9fff]+)", text)
    if match:
        return match.group(1), match.group(2)
    match = re.search(r"graph=([0-9A-Za-z_\-\u4e00-\u9fff]+)\s+state=([0-9A-Za-z_\-\u4e00-\u9fff]+)", text)
    if match:
        return match.group(1), match.group(2)
    return None


def _first_identifier(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    match = re.match(r"([0-9A-Za-z_.\-\u4e00-\u9fff]+)", text)
    return match.group(1).strip(" .:-") if match else ""


def _extract_prefixed_refs(raw: str, prefixes: list[str]) -> list[str]:
    refs: list[str] = []
    prefix_re = "|".join(re.escape(p) for p in prefixes)
    pattern = re.compile(rf"(?:{prefix_re})\s*:\s*([0-9A-Za-z_.\-\u4e00-\u9fff]+)", re.IGNORECASE)
    for match in pattern.finditer(str(raw or "")):
        refs.append(match.group(1).strip())
    return refs


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            out.append(value)
            seen.add(value)
    return out


def _runtime_signal_seen(report: RuntimeDebugSnapshotReport, signal: str) -> bool:
    for event in [*report.trace, *report.transitions]:
        if _event_has_signal(event, signal):
            return True
    return False


def _event_has_signal(event: dict[str, Any], signal: str) -> bool:
    for key in ["triggerKey", "signal", "event", "key"]:
        if str(event.get(key) or "").strip() == signal:
            return True
    payload = event.get("payload")
    if isinstance(payload, dict):
        if _event_has_signal(payload, signal):
            return True
        source = payload.get("source")
        if isinstance(source, dict) and _event_has_signal(source, signal):
            return True
    return False


def _runtime_trigger_summary(report: RuntimeDebugSnapshotReport) -> str:
    triggers: list[str] = []
    for event in [*report.trace, *report.transitions]:
        trigger = str(event.get("triggerKey") or event.get("signal") or "").strip()
        if trigger:
            triggers.append(trigger)
    unique = _unique(triggers)
    if not unique:
        return "最近 trace 没有 triggerKey"
    return "最近 trigger: " + ", ".join(unique[-8:])


def _runtime_state_visited(report: RuntimeDebugSnapshotReport, graph_id: str, state_id: str) -> bool:
    for event in [*report.trace, *report.transitions]:
        if str(event.get("graphId") or "").strip() != graph_id:
            continue
        if str(event.get("to") or event.get("stateId") or "").strip() == state_id:
            return True
    return False


def _expected_quest_status(raw: str) -> str | None:
    text = str(raw or "").lower()
    if any(word in text for word in ["completed", "complete", "done", "完成", "已完成"]):
        return "Completed"
    if any(word in text for word in ["inactive", "未接", "未激活", "关闭"]):
        return "Inactive"
    if any(word in text for word in ["accepted", "accept", "active", "接取", "进行", "激活"]):
        return "Active"
    return None


def _quest_status_label(value: Any) -> str:
    if value is None:
        return "Inactive"
    if isinstance(value, bool):
        return "Active" if value else "Inactive"
    if isinstance(value, int):
        return {0: "Inactive", 1: "Active", 2: "Completed"}.get(value, str(value))
    text = str(value).strip()
    if text in {"0", "Inactive", "inactive"}:
        return "Inactive"
    if text in {"1", "Active", "active", "accepted"}:
        return "Active"
    if text in {"2", "Completed", "completed", "done"}:
        return "Completed"
    return text or "Inactive"


@dataclass(frozen=True)
class _ExpectedScenario:
    scenario_id: str
    phase: str = ""
    status: str | None = None


def _parse_expected_scenario(raw: str) -> _ExpectedScenario | None:
    text = str(raw or "").strip()
    first = _first_identifier(text)
    if not first:
        return None
    scenario_id = first
    phase = ""
    if "." in first:
        scenario_id, phase = first.split(".", 1)
    return _ExpectedScenario(
        scenario_id=scenario_id.strip(),
        phase=phase.strip(),
        status=_expected_scenario_status(text),
    )


def _expected_scenario_status(raw: str) -> str | None:
    text = str(raw or "").lower()
    if any(word in text for word in ["inactive", "pending", "未激活", "未开始", "待定"]):
        return "pending"
    if any(word in text for word in ["completed", "complete", "完成", "已完成"]):
        return "completed"
    if any(word in text for word in ["done", "达成"]):
        return "done"
    if any(word in text for word in ["active", "进行", "激活"]):
        return "active"
    if any(word in text for word in ["locked", "锁定"]):
        return "locked"
    return None


def _runtime_scenario_actual(report: RuntimeDebugSnapshotReport, expected: _ExpectedScenario) -> str:
    state = report.scenario_state
    sid = expected.scenario_id
    phase = expected.phase
    if not isinstance(state, dict):
        return ""

    scenarios = state.get("scenarios")
    if isinstance(scenarios, dict):
        phases = scenarios.get(sid)
        if isinstance(phases, dict):
            if phase:
                value = phases.get(phase)
                status = _scenario_status_from_value(value)
                if status:
                    return f"{sid}.{phase}={status}"
            else:
                summary = _scenario_phase_summary(sid, phases, expected.status)
                if summary:
                    return summary

    lifecycle = state.get("lineLifecycle")
    if isinstance(lifecycle, dict):
        value = str(lifecycle.get(sid) or "").strip()
        if value:
            return f"{sid} lifecycle={value}"

    direct = state.get(sid)
    if isinstance(direct, dict):
        direct_status = _scenario_status_from_value(direct)
        if direct_status:
            return f"{sid}={direct_status}"
        lifecycle_value = str(direct.get("lifecycle") or "").strip()
        if lifecycle_value:
            return f"{sid} lifecycle={lifecycle_value}"

    if _contains_key_recursive(state, sid):
        return f"{sid} 存在于 scenarioState"
    return ""


def _scenario_expectation_met(expected: _ExpectedScenario, actual: str) -> bool:
    if not actual:
        return False
    if expected.status is None:
        return True
    haystack = actual.lower()
    want = expected.status.lower()
    if want == "completed":
        return "completed" in haystack
    if want == "pending":
        return "pending" in haystack or "inactive" in haystack
    return want in haystack


def _scenario_expectation_message(expected: _ExpectedScenario) -> str:
    if expected.status:
        return f"期望 {expected.scenario_id}{'.' + expected.phase if expected.phase else ''} 为 {expected.status}"
    return f"期望看到 {expected.scenario_id} 的 scenario 变化"


def _scenario_phase_summary(sid: str, phases: dict[Any, Any], want_status: str | None) -> str:
    if want_status:
        for phase, value in phases.items():
            status = _scenario_status_from_value(value)
            if status and status.lower() == want_status.lower():
                return f"{sid}.{phase}={status}"
    pieces: list[str] = []
    for phase, value in phases.items():
        status = _scenario_status_from_value(value)
        if status:
            pieces.append(f"{phase}={status}")
    if not pieces:
        return ""
    return f"{sid}: " + ", ".join(pieces[:6])


def _scenario_status_from_value(value: Any) -> str:
    if isinstance(value, dict):
        raw = value.get("status")
        if raw is not None:
            return str(raw).strip()
    if isinstance(value, str):
        return value.strip()
    return ""


def _contains_key_recursive(value: Any, target: str) -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).strip() == target:
                return True
            if _contains_key_recursive(child, target):
                return True
    elif isinstance(value, list):
        for child in value:
            if _contains_key_recursive(child, target):
                return True
    else:
        try:
            return str(value).strip() == target
        except Exception:  # noqa: BLE001
            return False
    return False
