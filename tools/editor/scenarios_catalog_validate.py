"""scenarios.json 结构校验（编辑器 Apply / 保存工程共用）。"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

from .flag_registry import scenario_exposes_flag_errors
from .scenario_requires_expr import (
    flatten_and_of_phase_strings,
    validate_requires_expr,
)

if TYPE_CHECKING:
    from .project_model import ProjectModel


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
            err = validate_requires_expr(
                req,
                pset=set(phases.keys()),
                where=f"{sid!r} 的 scenario 进线 requires",
            )
            if err:
                return err
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
