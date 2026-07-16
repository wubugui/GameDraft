"""Validate [tag:…] embedded references in project data (editor save + Validate Data)."""
from __future__ import annotations

import re
from typing import Any

from ..file_io import read_json
from ..project_model import ProjectModel
from .tag_catalog import TagCatalog

STRING_TAG_RE: re.Pattern[str] = re.compile(
    r"\[tag:string:([^:]+):([^\]]+)\]",
)

_TAG_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("string", STRING_TAG_RE),
    ("flag", re.compile(r"\[tag:flag:([^\]]+)\]")),
    ("item", re.compile(r"\[tag:item:([^\]]+)\]")),
    ("npc", re.compile(r"\[tag:npc:([^\]]+)\]")),
    ("player", re.compile(r"\[tag:player\]")),
    ("quest", re.compile(r"\[tag:quest:([^\]]+)\]")),
    ("rule", re.compile(r"\[tag:rule:([^\]]+)\]")),
    ("scene", re.compile(r"\[tag:scene:([^\]]+)\]")),
]


def scan_refs(text: Any, where: str, model: ProjectModel) -> list[str]:
    if text is None:
        return []
    s = text if isinstance(text, str) else str(text)
    if not s or "[tag:" not in s:
        return []
    cat = TagCatalog(model)
    errs: list[str] = []
    for kind, rx in _TAG_PATTERNS:
        for m in rx.finditer(s):
            if kind == "string":
                payload = f"{m.group(1)}:{m.group(2)}"
            elif kind == "player":
                payload = ""
            else:
                payload = (m.group(1) or "").strip()
            if not cat.validate_exists(kind, payload):
                errs.append(f'{where}: invalid [tag:{kind}] {payload!r}')
    return errs


def walk_action_defs_embedded_refs(
    actions: Any,
    ctx_base: str,
    model: ProjectModel,
    errs: list[str],
) -> None:
    """遍历嵌套 Action 列表，校验嵌入 [tag:…]（台词、延迟/嵌套/runActions、chooseAction 提示与选项文案等）。"""
    if not isinstance(actions, list):
        return
    for ai, act in enumerate(actions):
        if not isinstance(act, dict):
            continue
        t = act.get("type")
        p = act.get("params") if isinstance(act.get("params"), dict) else {}
        prefix = f"{ctx_base}[{ai}]"
        if t == "playScriptedDialogue":
            for li, ln in enumerate(p.get("lines") or []):
                if isinstance(ln, dict):
                    errs.extend(
                        scan_refs(ln.get("speaker"), f"{prefix}.lines[{li}].speaker", model),
                    )
                    errs.extend(
                        scan_refs(ln.get("text"), f"{prefix}.lines[{li}].text", model),
                    )
        elif t == "enableRuleOffers":
            for si, slot in enumerate(p.get("slots") or []):
                if isinstance(slot, dict):
                    walk_action_defs_embedded_refs(
                        slot.get("resultActions"),
                        f"{prefix}.slots[{si}].resultActions",
                        model,
                        errs,
                    )
        elif t == "addDelayedEvent":
            walk_action_defs_embedded_refs(
                p.get("actions"),
                f"{prefix}.actions",
                model,
                errs,
            )
        elif t == "runActions":
            walk_action_defs_embedded_refs(
                p.get("actions"),
                f"{prefix}.actions",
                model,
                errs,
            )
        elif t == "removeCurrency":
            errs.extend(scan_refs(p.get("amount"), f"{prefix}.amount", model))
        elif t == "chooseAction":
            errs.extend(scan_refs(p.get("prompt"), f"{prefix}.prompt", model))
            for oi, opt in enumerate(p.get("options") or []):
                if isinstance(opt, dict):
                    errs.extend(
                        scan_refs(opt.get("text"), f"{prefix}.options[{oi}].text", model),
                    )
                    walk_action_defs_embedded_refs(
                        opt.get("actions"),
                        f"{prefix}.options[{oi}].actions",
                        model,
                        errs,
                    )
        elif t == "randomBranch":
            walk_action_defs_embedded_refs(
                p.get("aboveActions"),
                f"{prefix}.aboveActions",
                model,
                errs,
            )
            walk_action_defs_embedded_refs(
                p.get("belowActions"),
                f"{prefix}.belowActions",
                model,
                errs,
            )


def _walk_cutscene_steps_play_scripted_embedded_refs(
    steps: Any,
    ctx_prefix: str,
    model: ProjectModel,
    errs: list[str],
) -> None:
    if not isinstance(steps, list):
        return
    for si, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        kind = step.get("kind")
        if kind == "action":
            p = step.get("params")
            act = {
                "type": step.get("type"),
                "params": p if isinstance(p, dict) else {},
            }
            walk_action_defs_embedded_refs([act], f"{ctx_prefix}[{si}]", model, errs)
        elif kind == "parallel":
            _walk_cutscene_steps_play_scripted_embedded_refs(
                step.get("tracks"),
                f"{ctx_prefix}[{si}].tracks",
                model,
                errs,
            )


def _walk_one_dialogue_graph(stem: str, gdata: Any, model: ProjectModel, errs: list[str]) -> None:
    """校验单份对话图 JSON（来源可为磁盘或暂存内容）内的 [tag:…]。"""
    if not isinstance(gdata, dict):
        return
    nodes = gdata.get("nodes")
    if not isinstance(nodes, dict):
        return
    for nid, node in nodes.items():
        if not isinstance(node, dict):
            continue
        ctx = f"dialogueGraph[{stem}].{nid}"
        ntype = node.get("type")
        if ntype == "line":
            errs.extend(scan_refs(node.get("text"), f"{ctx}.text", model))
            for li, pl in enumerate(node.get("lines") or []):
                if isinstance(pl, dict):
                    errs.extend(scan_refs(pl.get("text"), f"{ctx}.lines[{li}].text", model))
        elif ntype == "choice":
            pl = node.get("promptLine")
            if isinstance(pl, dict):
                errs.extend(scan_refs(pl.get("text"), f"{ctx}.promptLine.text", model))
            for oi, opt in enumerate(node.get("options") or []):
                if isinstance(opt, dict):
                    errs.extend(scan_refs(opt.get("text"), f"{ctx}.options[{oi}].text", model))
                    errs.extend(scan_refs(
                        opt.get("disabledClickHint"),
                        f"{ctx}.options[{oi}].disabledClickHint",
                        model,
                    ))
        elif ntype == "runActions":
            walk_action_defs_embedded_refs(
                node.get("actions"),
                f"{ctx}.actions",
                model,
                errs,
            )


def _walk_dialogue_graphs(model: ProjectModel, errs: list[str]) -> None:
    """全量审计路径：校验磁盘上所有对话图的 [tag:…]。"""
    gd = model.dialogues_path / "graphs"
    if not gd.is_dir():
        return
    for path in sorted(gd.glob("*.json")):
        try:
            gdata = read_json(path)
        except (OSError, ValueError):
            continue
        _walk_one_dialogue_graph(path.stem, gdata, model, errs)


def _walk_staged_dialogue_graphs(model: ProjectModel, errs: list[str]) -> None:
    """保存路径：只校验本次将写盘的暂存对话图内容（审查 P2-③）。

    校验暂存版而非磁盘旧版——staged 新引入的坏 tag 要拦，staged 已修好的不被旧盘面误拦。
    dialogue_stubs（只写新文件）与 dialogue_graph_edits（覆写既有文件）都在此校验。
    """
    for bag_name in ("pending_dialogue_stubs", "pending_dialogue_graph_edits"):
        bag = getattr(model, bag_name, None)
        if not isinstance(bag, dict):
            continue
        for gid, graph in bag.items():
            gid_s = str(gid).strip()
            if gid_s and isinstance(graph, dict):
                _walk_one_dialogue_graph(gid_s, graph, model, errs)


def _walk_books(model: ProjectModel, errs: list[str]) -> None:
    for bi, book in enumerate(model.archive_books):
        if not isinstance(book, dict):
            continue
        bid = book.get("id", bi)
        errs.extend(scan_refs(book.get("title"), f"books[{bid}].title", model))
        for pi, page in enumerate(book.get("pages") or []):
            if not isinstance(page, dict):
                continue
            pfx = f"books[{bid}].pages[{pi}]"
            errs.extend(scan_refs(page.get("title"), f"{pfx}.title", model))
            errs.extend(scan_refs(page.get("content"), f"{pfx}.content", model))
            walk_action_defs_embedded_refs(
                page.get("firstViewActions"), f"{pfx}.firstViewActions", model, errs,
            )
            for ei, ent in enumerate(page.get("entries") or []):
                if not isinstance(ent, dict):
                    continue
                ep = f"{pfx}.entries[{ei}]"
                errs.extend(scan_refs(ent.get("title"), f"{ep}.title", model))
                errs.extend(scan_refs(ent.get("content"), f"{ep}.content", model))
                errs.extend(scan_refs(ent.get("annotation"), f"{ep}.annotation", model))
                walk_action_defs_embedded_refs(
                    ent.get("firstViewActions"), f"{ep}.firstViewActions", model, errs,
                )


def _walk_water_minigames_embedded_refs(model: ProjectModel, errs: list[str]) -> None:
    """扫描 water_minigames JSON 树中的字符串叶子（cue/hint/动作参数中的 [tag:…]）。"""
    bag = getattr(model, "water_minigames_instances", None)
    if not isinstance(bag, dict):
        return

    def walk(obj: Any, ctx: str) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                walk(v, f"{ctx}.{k}")
        elif isinstance(obj, list):
            for i, it in enumerate(obj):
                walk(it, f"{ctx}[{i}]")
        elif isinstance(obj, str):
            errs.extend(scan_refs(obj, ctx, model))

    for iid, doc in bag.items():
        if not isinstance(doc, dict):
            continue
        walk(doc, f"water_minigames[{iid}]")


def _walk_sugar_wheel_embedded_refs(model: ProjectModel, errs: list[str]) -> None:
    """扫描 sugar_wheel 实例 JSON 中的字符串叶子（含 Action 参数里的 [tag:…]）。"""
    bag = getattr(model, "sugar_wheel_instances", None)
    if not isinstance(bag, dict):
        return

    def walk(obj: Any, ctx: str) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                walk(v, f"{ctx}.{k}")
        elif isinstance(obj, list):
            for i, it in enumerate(obj):
                walk(it, f"{ctx}[{i}]")
        elif isinstance(obj, str):
            errs.extend(scan_refs(obj, ctx, model))

    for iid, doc in bag.items():
        if not isinstance(doc, dict):
            continue
        walk(doc, f"sugar_wheel[{iid}]")


def validate_all_embedded_refs(
    model: ProjectModel, dirty: set[str] | None = None,
) -> list[str]:
    """扫描全工程数据里的 [tag:…] 引用。

    ``dirty=None``（全量审计，Validate Data 菜单/CLI）：扫描每个数据域，含磁盘上
    所有对话图。``dirty`` 为脏桶集合（保存前收口，审查 P2-③）：只扫本次将写盘的域，
    对话图只扫暂存内容——盘上其它域的历史坏 tag 不再锁死无关域的保存。
    """
    def want(bucket: str) -> bool:
        return dirty is None or bucket in dirty

    errs: list[str] = []
    if want("item"):
        for i, it in enumerate(model.items):
            iid = it.get("id", i)
            errs.extend(scan_refs(it.get("name"), f"items[{iid}].name", model))
            errs.extend(scan_refs(it.get("description"), f"items[{iid}].description", model))
            for di, d in enumerate(it.get("dynamicDescriptions") or []):
                if isinstance(d, dict):
                    errs.extend(scan_refs(d.get("text"), f"items[{iid}].dynamicDescriptions[{di}].text", model))
    if want("quest"):
        for i, q in enumerate(model.quests):
            qid = q.get("id", i)
            errs.extend(scan_refs(q.get("title"), f"quests[{qid}].title", model))
            errs.extend(scan_refs(q.get("description"), f"quests[{qid}].description", model))
            walk_action_defs_embedded_refs(
                q.get("acceptActions"), f"quests[{qid}].acceptActions", model, errs,
            )
            walk_action_defs_embedded_refs(q.get("rewards"), f"quests[{qid}].rewards", model, errs)
    if want("rules"):
        rules = model.rules_data.get("rules", []) if isinstance(model.rules_data, dict) else []
        for i, r in enumerate(rules):
            if not isinstance(r, dict):
                continue
            rid = r.get("id", i)
            errs.extend(scan_refs(r.get("name"), f"rules[{rid}].name", model))
            errs.extend(scan_refs(r.get("incompleteName"), f"rules[{rid}].incompleteName", model))
            layers = r.get("layers")
            if isinstance(layers, dict):
                for lk in ("xiang", "li", "shu"):
                    lob = layers.get(lk)
                    if isinstance(lob, dict):
                        errs.extend(scan_refs(
                            lob.get("text"), f"rules[{rid}].layers.{lk}.text", model,
                        ))
                        errs.extend(scan_refs(
                            lob.get("lockedHint"), f"rules[{rid}].layers.{lk}.lockedHint", model,
                        ))
        frags = model.rules_data.get("fragments", []) if isinstance(model.rules_data, dict) else []
        for i, f in enumerate(frags):
            if not isinstance(f, dict):
                continue
            fid = f.get("id", i)
            errs.extend(scan_refs(f.get("text"), f"fragments[{fid}].text", model))
            errs.extend(scan_refs(f.get("source"), f"fragments[{fid}].source", model))
    if want("encounter"):
        for i, e in enumerate(model.encounters):
            if not isinstance(e, dict):
                continue
            eid = e.get("id", i)
            errs.extend(scan_refs(e.get("narrative"), f"encounters[{eid}].narrative", model))
            for oi, opt in enumerate(e.get("options") or []):
                if isinstance(opt, dict):
                    errs.extend(scan_refs(opt.get("text"), f"encounters[{eid}].options[{oi}].text", model))
                    errs.extend(scan_refs(opt.get("resultText"), f"encounters[{eid}].options[{oi}].resultText", model))
                    walk_action_defs_embedded_refs(
                        opt.get("resultActions"),
                        f"encounters[{eid}].options[{oi}].resultActions",
                        model,
                        errs,
                    )
            walk_action_defs_embedded_refs(e.get("rewards"), f"encounters[{eid}].rewards", model, errs)
    if want("scenarios"):
        scenarios = model.scenarios_catalog.get("scenarios") or [] if isinstance(model.scenarios_catalog, dict) else []
        for i, s in enumerate(scenarios):
            if not isinstance(s, dict):
                continue
            sid = s.get("id", i)
            errs.extend(scan_refs(s.get("description"), f"scenarios[{sid}].description", model))
            errs.extend(scan_refs(s.get("exposeAfterPhase"), f"scenarios[{sid}].exposeAfterPhase", model))
    if want("shop"):
        for i, sh in enumerate(model.shops):
            if isinstance(sh, dict):
                errs.extend(scan_refs(sh.get("name"), f"shops[{sh.get('id', i)}].name", model))
    if want("map"):
        for i, n in enumerate(model.map_nodes):
            if isinstance(n, dict):
                errs.extend(scan_refs(n.get("name"), f"map_nodes[{i}].name", model))
    if want("archive"):
        for i, ch in enumerate(model.archive_characters):
            if not isinstance(ch, dict):
                continue
            cid = ch.get("id", i)
            errs.extend(scan_refs(ch.get("name"), f"characters[{cid}].name", model))
            errs.extend(scan_refs(ch.get("title"), f"characters[{cid}].title", model))
            for ii, im in enumerate(ch.get("impressions") or []):
                if isinstance(im, dict):
                    errs.extend(scan_refs(im.get("text"), f"characters[{cid}].impressions[{ii}].text", model))
            for ki, kn in enumerate(ch.get("knownInfo") or []):
                if isinstance(kn, dict):
                    errs.extend(scan_refs(kn.get("text"), f"characters[{cid}].knownInfo[{ki}].text", model))
            walk_action_defs_embedded_refs(
                ch.get("firstViewActions"), f"characters[{cid}].firstViewActions", model, errs,
            )
        lore = model.archive_lore
        lore_entries: list[dict[str, Any]] = []
        if isinstance(lore, list):
            lore_entries = [x for x in lore if isinstance(x, dict)]
        elif isinstance(lore, dict):
            lore_entries = [x for x in (lore.get("entries") or []) if isinstance(x, dict)]
        for i, e in enumerate(lore_entries):
            lid = e.get("id", i)
            errs.extend(scan_refs(e.get("title"), f"lore[{lid}].title", model))
            errs.extend(scan_refs(e.get("content"), f"lore[{lid}].content", model))
            errs.extend(scan_refs(e.get("source"), f"lore[{lid}].source", model))
            walk_action_defs_embedded_refs(e.get("firstViewActions"), f"lore[{lid}].firstViewActions", model, errs)
        for i, d in enumerate(model.archive_documents):
            if not isinstance(d, dict):
                continue
            did = d.get("id", i)
            errs.extend(scan_refs(d.get("name"), f"documents[{did}].name", model))
            errs.extend(scan_refs(d.get("content"), f"documents[{did}].content", model))
            errs.extend(scan_refs(d.get("annotation"), f"documents[{did}].annotation", model))
            walk_action_defs_embedded_refs(d.get("firstViewActions"), f"documents[{did}].firstViewActions", model, errs)
        _walk_books(model, errs)
    if want("strings"):
        if isinstance(model.strings, dict):
            for cat, sub in model.strings.items():
                if not isinstance(sub, dict):
                    continue
                for key, val in sub.items():
                    errs.extend(scan_refs(val, f"strings.{cat}.{key}", model))
        errs.extend(_string_ref_cycle_errors(model))
    if want("cutscene"):
        for ci, cut in enumerate(model.cutscenes):
            if not isinstance(cut, dict):
                continue
            cid = cut.get("id", ci)
            for si, step in enumerate(cut.get("steps") or []):
                if not isinstance(step, dict):
                    continue
                errs.extend(scan_refs(step.get("text"), f"cutscenes[{cid}].steps[{si}].text", model))
                errs.extend(scan_refs(step.get("speaker"), f"cutscenes[{cid}].steps[{si}].speaker", model))
            _walk_cutscene_steps_play_scripted_embedded_refs(
                cut.get("steps"), f"cutscenes[{cid}].steps", model, errs,
            )
    if want("scene"):
        for sid, sc in model.scenes.items():
            if not isinstance(sc, dict):
                continue
            walk_action_defs_embedded_refs(
                sc.get("onEnter"),
                f"scenes[{sid}].onEnter",
                model,
                errs,
            )
            for hi, hs in enumerate(sc.get("hotspots") or []):
                if not isinstance(hs, dict):
                    continue
                hid = hs.get("id", hi)
                errs.extend(scan_refs(hs.get("label"), f"scenes[{sid}].hotspots[{hid}].label", model))
                data = hs.get("data") or {}
                if isinstance(data, dict) and hs.get("type") == "inspect":
                    errs.extend(scan_refs(data.get("text"), f"scenes[{sid}].hotspots[{hid}].data.text", model))
                if isinstance(data, dict):
                    walk_action_defs_embedded_refs(
                        data.get("actions"),
                        f"scenes[{sid}].hotspots[{hid}].data.actions",
                        model,
                        errs,
                    )
            for zi, zone in enumerate(sc.get("zones") or []):
                if not isinstance(zone, dict):
                    continue
                zid = zone.get("id", zi)
                for ev in ("onEnter", "onStay", "onExit"):
                    walk_action_defs_embedded_refs(
                        zone.get(ev),
                        f"scenes[{sid}].zones[{zid}].{ev}",
                        model,
                        errs,
                    )
            for ni, npc in enumerate(sc.get("npcs") or []):
                if isinstance(npc, dict):
                    errs.extend(scan_refs(npc.get("name"), f"scenes[{sid}].npcs[{ni}].name", model))
    if want("water_minigames"):
        _walk_water_minigames_embedded_refs(model, errs)
    if want("sugar_wheel"):
        _walk_sugar_wheel_embedded_refs(model, errs)
    if dirty is None:
        # 全量审计：校验磁盘上所有对话图。
        _walk_dialogue_graphs(model, errs)
    elif "dialogue_stubs" in dirty or "dialogue_graph_edits" in dirty:
        # 保存收口：只校验本次将写盘的暂存对话图（按暂存版，非磁盘旧版）。
        _walk_staged_dialogue_graphs(model, errs)
    return errs


def _string_ref_cycle_errors(model: ProjectModel) -> list[str]:
    """Detect cycles among strings.* entries that reference each other via [tag:string:cat:key].

    Only top-level category + one key level participate (same as TagCatalog / scan_refs).
    """
    strings = model.strings
    if not isinstance(strings, dict):
        return []
    nodes: set[str] = set()
    edges: dict[str, list[str]] = {}
    for cat, sub in strings.items():
        if not isinstance(sub, dict):
            continue
        for key, val in sub.items():
            if not isinstance(val, str):
                continue
            nid = f"{cat}:{key}"
            nodes.add(nid)
            refs: list[str] = []
            for m in STRING_TAG_RE.finditer(val):
                refs.append(f"{m.group(1)}:{m.group(2)}")
            edges[nid] = refs
    if not nodes:
        return []
    color: dict[str, int] = {n: 0 for n in nodes}
    path_stack: list[str] = []
    errs: list[str] = []

    def visit(u: str) -> None:
        color[u] = 1
        path_stack.append(u)
        for v in edges.get(u, []):
            if v not in nodes:
                continue
            if color[v] == 0:
                visit(v)
            elif color[v] == 1:
                i = path_stack.index(v)
                chain = path_stack[i:] + [v]
                errs.append(
                    "strings.json 存在 string 引用环: " + " -> ".join(chain),
                )
        path_stack.pop()
        color[u] = 2

    for n in sorted(nodes):
        if color[n] == 0:
            visit(n)
    return errs


def validate_refs_for_save(
    model: ProjectModel, dirty: set[str] | None = None,
) -> str | None:
    """保存前的嵌入引用校验。

    ``dirty`` 传入本次脏桶集合时按脏桶收口——只校验将写盘的域，盘上无关域的历史坏
    tag 不再锁死保存（审查 P2-③）。缺省 None 保持全量校验（既有调用方兼容）。
    """
    errs = validate_all_embedded_refs(model, dirty)
    if not errs:
        return None
    return "嵌入引用校验失败:\n" + "\n".join(errs[:80]) + (f"\n… 共 {len(errs)} 条" if len(errs) > 80 else "")
