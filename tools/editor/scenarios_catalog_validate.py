"""scenarios.json 结构校验（编辑器 Apply / 保存工程共用）。"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

from .flag_registry import scenario_exposes_flag_errors
from .scenario_requires_expr import (
    collect_requires_phase_leaves,
    flatten_and_of_phase_strings,
    validate_requires_expr,
)

if TYPE_CHECKING:
    from .project_model import ProjectModel


def scenario_entry_prereq_cycle_among_leaves(
    entry_req: Any,
    phases: dict[str, Any],
    *,
    sid: str,
) -> str | None:
    """
    进线 requires 中引用的 phase，若在同 scenario 的 per-phase requires（纯与链可展开）下
    彼此形成前置有向环，则运行时永远无法进线。保存/校验时报错。
    """
    if entry_req is None:
        return None
    leaves = collect_requires_phase_leaves(entry_req, into=None)
    if len(leaves) < 2:
        return None
    adj: dict[str, list[str]] = {n: [] for n in leaves}
    could_build = True
    for p in leaves:
        pval = phases.get(p)
        if not isinstance(pval, dict):
            continue
        pr = pval.get("requires")
        if pr is None:
            continue
        flat = flatten_and_of_phase_strings(pr)
        if flat is None:
            could_build = False
            break
        for r in flat:
            if r in leaves and r != p:
                adj[r].append(p)
    if not could_build:
        return None
    _WHITE, _GREY, _BLACK = 0, 1, 2
    color: dict[str, int] = {n: _WHITE for n in leaves}

    def _cyc(u: str) -> bool:
        color[u] = _GREY
        for v in adj.get(u, ()):
            if v not in color:
                continue
            if color.get(v) == _GREY:
                return True
            if color.get(v) == _WHITE and _cyc(v):
                return True
        color[u] = _BLACK
        return False

    for n in leaves:
        if color.get(n) == _WHITE and _cyc(n):
            return (
                f"{sid!r} 的 scenario 进线 requires 所引用的 phase 在 per-phase 前置中形成有向环，"
                "无法进线；请调整 requires 或进线条件"
            )
    return None


def validate_scenarios_list(
    scenarios_data: list[Any],
    *,
    flag_registry: dict[str, Any],
    model: ProjectModel,
) -> str | None:
    """校验 scenarios 数组（与 ScenariosCatalogEditor 规则一致）。通过返回 None，否则返回错误说明。"""
    seen: set[str] = set()
    for i, e in enumerate(scenarios_data):
        if not isinstance(e, dict):
            return f"第 {i + 1} 条 scenario 须为 JSON 对象"
        sid = str(e.get("id", "")).strip()
        if not sid:
            return f"第 {i + 1} 条 scenario 的 id 不能为空"
        if sid in seen:
            return f"scenario id 重复：{sid!r}"
        seen.add(sid)
        phases = e.get("phases") if isinstance(e.get("phases"), dict) else {}
        pnames = [str(k) for k in phases.keys()]
        dup_ph = {x for x in pnames if pnames.count(x) > 1}
        if dup_ph:
            return f"{sid!r} 下 phase 名重复：{dup_ph!r}"
        req = e.get("requires")
        if req is not None:
            pset = set(phases.keys())
            err = validate_requires_expr(
                req,
                pset=pset,
                where=f"{sid!r} 的 scenario 进线 requires",
            )
            if err:
                return err
            cyc = scenario_entry_prereq_cycle_among_leaves(req, phases, sid=sid)
            if cyc:
                return cyc
        eat = str(e.get("exposeAfterPhase", "")).strip()
        if eat and eat not in phases:
            return f"{sid!r} 的 exposeAfterPhase {eat!r} 不在 phases 中"
        pset = {str(k) for k in phases.keys()}
        adj: dict[str, list[str]] = {}
        skip_cycle = False
        for pname, pval in phases.items():
            pn = str(pname)
            req_list: list[str] = []
            if isinstance(pval, dict):
                pr = pval.get("requires")
                if pr is not None:
                    err = validate_requires_expr(
                        pr,
                        pset=pset,
                        where=f"{sid!r} 的 phase {pn!r} requires",
                    )
                    if err:
                        return err
                    flat = flatten_and_of_phase_strings(pr)
                    if flat is None:
                        skip_cycle = True
                    else:
                        req_list = flat
            adj[pn] = req_list
        white, grey, black = 0, 1, 2
        color = {n: white for n in adj}

        def _cyc(u: str) -> bool:
            color[u] = grey
            for v in adj.get(u, []):
                if v not in color:
                    continue
                if color.get(v) == grey:
                    return True
                if color.get(v) == white and _cyc(v):
                    return True
            color[u] = black
            return False

        if not skip_cycle:
            for n in adj:
                if color.get(n) == white and _cyc(n):
                    return f"{sid!r} 的 phases.requires 存在循环依赖"
        exp_err = scenario_exposes_flag_errors(
            e.get("exposes"),
            flag_registry or {},
            model,
            scenario_id=sid,
        )
        if exp_err:
            return exp_err
        dg = e.get("dialogueGraphIds")
        if dg is not None:
            if not isinstance(dg, list):
                return f"{sid!r} 的 dialogueGraphIds 须为 JSON 数组"
            stems = set(model.all_dialogue_graph_ids())
            for j, x in enumerate(dg):
                if not isinstance(x, str) or not str(x).strip():
                    return f"{sid!r} 的 dialogueGraphIds[{j}] 须为非空字符串"
                xs = str(x).strip()
                if xs not in stems:
                    return f"{sid!r} 的 dialogueGraphIds 含未知图 id {xs!r}（无 dialogues/graphs/{xs}.json）"
    return None


def validate_scenarios_catalog_for_save(
    catalog: Any,
    *,
    flag_registry: dict[str, Any],
    model: ProjectModel,
) -> str | None:
    """写入磁盘前的 scenarios.json 根对象校验。"""
    if not isinstance(catalog, dict):
        return "scenarios.json：根须为 JSON 对象"
    arr = catalog.get("scenarios")
    if arr is None:
        return "scenarios.json：缺少 scenarios 字段（须为数组）"
    if not isinstance(arr, list):
        return "scenarios.json：scenarios 须为数组"
    return validate_scenarios_list(arr, flag_registry=flag_registry, model=model)
