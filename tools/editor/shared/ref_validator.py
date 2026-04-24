"""Validate [tag:…] embedded references in project data (editor save + Validate Data)."""
from __future__ import annotations

import re
from typing import Any

from ..file_io import read_json
from ..project_model import ProjectModel
from .tag_catalog import TagCatalog

STRING_TAG_RE: re.Pattern[str] = re.compile(
    r"\[tag:string:([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)\]",
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


def scan_refs(text: str | None, where: str, model: ProjectModel) -> list[str]:
    if not text or "[tag:" not in text:
        return []
    cat = TagCatalog(model)
    errs: list[str] = []
    for kind, rx in _TAG_PATTERNS:
        for m in rx.finditer(str(text)):
            if kind == "string":
                payload = f"{m.group(1)}:{m.group(2)}"
            elif kind == "player":
                payload = ""
            else:
                payload = (m.group(1) or "").strip()
            if not cat.validate_exists(kind, payload):
                errs.append(f'{where}: invalid [tag:{kind}] {payload!r}')
    return errs


def _walk_dialogue_graphs(model: ProjectModel, errs: list[str]) -> None:
    gd = model.dialogues_path / "graphs"
    if not gd.is_dir():
        return
    for path in sorted(gd.glob("*.json")):
        stem = path.stem
        try:
            gdata = read_json(path)
        except (OSError, ValueError):
            continue
        if not isinstance(gdata, dict):
            continue
        nodes = gdata.get("nodes")
        if not isinstance(nodes, dict):
            continue
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
            for ei, ent in enumerate(page.get("entries") or []):
                if not isinstance(ent, dict):
                    continue
                ep = f"{pfx}.entries[{ei}]"
                errs.extend(scan_refs(ent.get("title"), f"{ep}.title", model))
                errs.extend(scan_refs(ent.get("content"), f"{ep}.content", model))
                errs.extend(scan_refs(ent.get("annotation"), f"{ep}.annotation", model))


def validate_all_embedded_refs(model: ProjectModel) -> list[str]:
    errs: list[str] = []
    for i, it in enumerate(model.items):
        iid = it.get("id", i)
        errs.extend(scan_refs(it.get("name"), f"items[{iid}].name", model))
        errs.extend(scan_refs(it.get("description"), f"items[{iid}].description", model))
        for di, d in enumerate(it.get("dynamicDescriptions") or []):
            if isinstance(d, dict):
                errs.extend(scan_refs(d.get("text"), f"items[{iid}].dynamicDescriptions[{di}].text", model))
    for i, q in enumerate(model.quests):
        qid = q.get("id", i)
        errs.extend(scan_refs(q.get("title"), f"quests[{qid}].title", model))
        errs.extend(scan_refs(q.get("description"), f"quests[{qid}].description", model))
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
    for i, e in enumerate(model.encounters):
        if not isinstance(e, dict):
            continue
        eid = e.get("id", i)
        errs.extend(scan_refs(e.get("narrative"), f"encounters[{eid}].narrative", model))
        for oi, opt in enumerate(e.get("options") or []):
            if isinstance(opt, dict):
                errs.extend(scan_refs(opt.get("text"), f"encounters[{eid}].options[{oi}].text", model))
                errs.extend(scan_refs(opt.get("resultText"), f"encounters[{eid}].options[{oi}].resultText", model))
    scenarios = model.scenarios_catalog.get("scenarios") or [] if isinstance(model.scenarios_catalog, dict) else []
    for i, s in enumerate(scenarios):
        if not isinstance(s, dict):
            continue
        sid = s.get("id", i)
        errs.extend(scan_refs(s.get("description"), f"scenarios[{sid}].description", model))
        errs.extend(scan_refs(s.get("exposeAfterPhase"), f"scenarios[{sid}].exposeAfterPhase", model))
    for i, sh in enumerate(model.shops):
        if isinstance(sh, dict):
            errs.extend(scan_refs(sh.get("name"), f"shops[{sh.get('id', i)}].name", model))
    for i, n in enumerate(model.map_nodes):
        if isinstance(n, dict):
            errs.extend(scan_refs(n.get("name"), f"map_nodes[{i}].name", model))
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
    for i, d in enumerate(model.archive_documents):
        if not isinstance(d, dict):
            continue
        did = d.get("id", i)
        errs.extend(scan_refs(d.get("name"), f"documents[{did}].name", model))
        errs.extend(scan_refs(d.get("content"), f"documents[{did}].content", model))
        errs.extend(scan_refs(d.get("annotation"), f"documents[{did}].annotation", model))
    _walk_books(model, errs)
    if isinstance(model.strings, dict):
        for cat, sub in model.strings.items():
            if not isinstance(sub, dict):
                continue
            for key, val in sub.items():
                errs.extend(scan_refs(val, f"strings.{cat}.{key}", model))
    for ci, cut in enumerate(model.cutscenes):
        if not isinstance(cut, dict):
            continue
        cid = cut.get("id", ci)
        for si, step in enumerate(cut.get("steps") or []):
            if not isinstance(step, dict):
                continue
            errs.extend(scan_refs(step.get("text"), f"cutscenes[{cid}].steps[{si}].text", model))
    for sid, sc in model.scenes.items():
        if not isinstance(sc, dict):
            continue
        for hi, hs in enumerate(sc.get("hotspots") or []):
            if not isinstance(hs, dict):
                continue
            hid = hs.get("id", hi)
            errs.extend(scan_refs(hs.get("label"), f"scenes[{sid}].hotspots[{hid}].label", model))
            data = hs.get("data") or {}
            if isinstance(data, dict) and hs.get("type") == "inspect":
                errs.extend(scan_refs(data.get("text"), f"scenes[{sid}].hotspots[{hid}].data.text", model))
        for ni, npc in enumerate(sc.get("npcs") or []):
            if isinstance(npc, dict):
                errs.extend(scan_refs(npc.get("name"), f"scenes[{sid}].npcs[{ni}].name", model))
    _walk_dialogue_graphs(model, errs)
    errs.extend(_string_ref_cycle_errors(model))
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


def validate_refs_for_save(model: ProjectModel) -> str | None:
    errs = validate_all_embedded_refs(model)
    if not errs:
        return None
    return "嵌入引用校验失败:\n" + "\n".join(errs[:80]) + (f"\n… 共 {len(errs)} 条" if len(errs) > 80 else "")
