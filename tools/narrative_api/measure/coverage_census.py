#!/usr/bin/env python3
"""T3 反向覆盖：现有编排的每个运行时可读特征 → v11 能否表达。

判据不是"字段有没有出现"，是运行时读不读它 + v11 有没有构造承载。
输出三类：EXPR(可表达) / EXCL(判为非状态，刻意排除) / GAP(是状态但表达不了)。
"""
import json, collections, sys

P = "public/assets/data/narrative_graphs.json"
doc = json.load(open(P, encoding="utf-8"))

graphs = []
for c in doc.get("compositions", []):
    if c.get("mainGraph"):
        graphs.append((c["id"], "mainGraph", c["mainGraph"]))
    for el in c.get("elements", []):
        if el.get("graph"):
            graphs.append((c["id"], el.get("kind", "?"), el["graph"]))
for g in doc.get("graphs", []):
    graphs.append(("(toplevel)", "graph", g))

n = collections.Counter()
detail = collections.defaultdict(list)


def hit(k, where=""):
    n[k] += 1
    if where and len(detail[k]) < 6:
        detail[k].append(where)


# ---- 顶层
n["file.schemaVersion"] += 1 if "schemaVersion" in doc else 0
n["file.migrations"] += 1 if doc.get("migrations") else 0
for s in doc.get("signals", []):
    hit("signal.private" if s.get("scope") == "private" else "signal.global", s.get("id", ""))
n["composition"] = len(doc.get("compositions", []))
for c in doc.get("compositions", []):
    if c.get("package"):
        hit("composition.package", c["id"])
    for el in c.get("elements", []):
        hit("element.kind." + str(el.get("kind")), el.get("id", ""))
        if el.get("package"):
            hit("element.package", el.get("id", ""))
        if el.get("refId"):
            hit("element.refId", el.get("id", ""))

# ---- 图
for comp, kind, g in graphs:
    gid = g.get("id", "?")
    n["graph"] += 1
    for f in ("label", "category", "packageId", "entryState", "projectFlags"):
        if g.get(f) is not None:
            hit("graph." + f, gid)
    if g.get("exitStates"):
        hit("graph.exitStates.run" if g.get("run") else "graph.exitStates.plain", gid)
    if g.get("run"):
        hit("graph.run", gid)
        if g["run"].get("repeatable"):
            hit("graph.run.repeatable", gid)
        if g["run"].get("resumable"):
            hit("graph.run.resumable", gid)
        else:
            hit("graph.run.resumable_false", gid)
    ot, oid = g.get("ownerType"), g.get("ownerId")
    hit("owner." + str(ot), f"{gid}")
    # ---- 状态
    for sid, st in (g.get("states") or {}).items():
        n["state"] += 1
        for f in ("label", "description", "broadcastOnEnter", "activePlane", "meta"):
            if st.get(f) is not None:
                hit("state." + f, f"{gid}.{sid}")
        if st.get("onEnterActions"):
            hit("state.onEnterActions", f"{gid}.{sid}")
        if st.get("onExitActions"):
            hit("state.onExitActions", f"{gid}.{sid}")
    # ---- 转移
    for t in g.get("transitions") or []:
        n["transition"] += 1
        tr = t.get("trigger") or "signal"
        hit("trigger." + tr, f"{gid}.{t.get('id')}")
        if t.get("conditions"):
            hit("transition.conditions", f"{gid}.{t.get('id')}")
            if tr == "signal":
                hit("transition.signal+conditions", f"{gid}.{t.get('id')}")
        if t.get("priority") is not None:
            hit("transition.priority", f"{gid}.{t.get('id')}")
        if str(t.get("signal", "")).startswith("state:"):
            hit("transition.on_state_edge", f"{gid}.{t.get('id')}")

# ---- 一个 owner 绑几台机器？（v11 bind 维度的验证）
byowner = collections.Counter()
for comp, kind, g in graphs:
    if g.get("ownerType") in (None, "flow", "system"):
        continue
    byowner[(g.get("ownerType"), g.get("ownerId"))] += 1
multi = {k: v for k, v in byowner.items() if v > 1}

# ---- 条件叶里读叙事的三种读法
leaf = collections.Counter()


def walk(x):
    if isinstance(x, dict):
        if "narrative" in x:
            leaf["reached" if x.get("reached") is True else "current"] += 1
        if "narrativeCount" in x:
            leaf["count" + ("[exit]" if x.get("exitState") else "[all]")] += 1
        if "plane" in x and len(x) <= 2:
            leaf["plane"] += 1
        if "flag" in x:
            leaf["flag"] += 1
        for v in x.values():
            walk(v)
    elif isinstance(x, list):
        for v in x:
            walk(v)


walk(doc)

print("=== 规模 ===")
for k in ("composition", "graph", "state", "transition"):
    print(f"  {k:12s} {n[k]}")
print("\n=== 特征使用面 ===")
for k in sorted(n):
    if k in ("composition", "graph", "state", "transition"):
        continue
    ex = ("  ← " + ", ".join(detail[k][:3])) if detail[k] else ""
    print(f"  {k:34s} {n[k]:5d}{ex}")
print("\n=== 一个 owner 绑多台机器（v11 bind 维度）===")
print(f"  有 owner 的图: {sum(byowner.values())}，涉及 owner: {len(byowner)}，绑>1台的 owner: {len(multi)}")
for k, v in list(multi.items())[:10]:
    print(f"    {k} -> {v}")
print("\n=== 叙事读法（条件叶）===")
for k, v in leaf.most_common():
    print(f"  {k:12s} {v}")
