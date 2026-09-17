#!/usr/bin/env python3
"""主线故事进度核对 · 只读查询。不写任何文件。
（放在 .cursor/skills 下，.claude/skills 同名目录里的 SKILL.md 是指过来的链接。）

    sh scripts/py.sh .claude/skills/mainline-story-progress/scripts/mainline_progress.py <子命令>

子命令：
    doc                      进度文档在哪、最后什么时候写的
    chain [--graph ID]       主图从 initialState 往下走的状态顺序；列出没接进主链的状态
    text ID [--all]          按顺序打印一张对话图 / 一段过场的台词（ID 可以是对话图 id 或过场 id）
    starts ID                谁在启动这张对话图 / 这段过场（区分真接线与预加载清单）
    flag NAME                谁在设置这个标记（has_item_x → 谁给 x；rule_*_acquired → 谁给规矩）
    changed --since TIME     从 TIME 之前最后一个提交到当前工作树，台词 / 接线 / 主图变了什么
    changed --base REV       同上，直接指定基线提交
    check --snapshot PATH    落笔后自检：原有行一行没动、换行没变、新增行没有括号/问号/引号/id/路径
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

REPO = Path(__file__).resolve().parents[4]
if not (REPO / "public" / "assets").is_dir():
    REPO = Path.cwd()
ASSETS = REPO / "public" / "assets"
DLG_DIR = ASSETS / "dialogues" / "graphs"
CUTSCENES = ASSETS / "data" / "cutscenes" / "index.json"
NARRATIVE = ASSETS / "data" / "narrative_graphs.json"
QUESTS = ASSETS / "data" / "quests.json"
SCENES = ASSETS / "scenes"

DOC_REL = Path("故事设计") / "主线故事进度.md"
DOC_CANDIDATES = [
    REPO.parent / "FindingDogStory" / DOC_REL,
    Path("E:/GameDev/FindingDogStory") / DOC_REL,
    Path("H:/FDStory/FindingDogStory") / DOC_REL,
]

STORY_PRESENT = {"showDialogue", "showSubtitle", "showTitle", "showImg"}
STORY_ACTIONS = {
    "showSpeechBubbleAndWait", "showEmoteAndWait", "setThreeFiresVisible",
    "cutsceneSpawnActor", "cutsceneRemoveActor", "setEntityEnabled",
    "persistNpcEntityEnabled", "giveItem", "removeItem", "startCutscene",
    "startDialogueGraph", "emitNarrativeSignal", "playScriptedDialogue",
    "showNotification", "changeScene", "setFlag", "grantRule", "giveRule",
    "openMap", "showSystemNote", "setPlayerAvatar",
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def compact(obj, limit=200) -> str:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s if len(s) <= limit else s[: limit - 1] + "…"


def git(*args, cwd=REPO) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    return r.stdout.decode("utf-8", errors="replace").strip()


def git_show_json(rev: str, path: Path):
    rel = path.relative_to(REPO).as_posix()
    r = subprocess.run(["git", "show", f"{rev}:{rel}"], cwd=REPO, capture_output=True)
    if r.returncode != 0:
        return None
    return json.loads(r.stdout.decode("utf-8"))


# ---------------------------------------------------------------- doc

def resolve_doc() -> Path | None:
    env = os.environ.get("MAINLINE_PROGRESS_DOC")
    cands = ([Path(env)] if env else []) + DOC_CANDIDATES
    for c in cands:
        try:
            if c.is_file():
                return c
        except OSError:
            continue
    return None


def cmd_doc(_args):
    doc = resolve_doc()
    if doc is None:
        print("没找到进度文档。试过：")
        for c in DOC_CANDIDATES:
            print("  ", c)
        print("找制作人要位置，或设环境变量 MAINLINE_PROGRESS_DOC=<路径> 再跑。")
        return 1
    print("进度文档：", doc)
    mtime = datetime.fromtimestamp(doc.stat().st_mtime)
    print("最后写盘：", mtime.strftime("%Y-%m-%d %H:%M"))
    last = git("log", "-1", "--format=%h %ad %s", "--date=format:%Y-%m-%d %H:%M", "--", doc.name, cwd=doc.parent)
    print("最后提交：", last or "（不在 git 里或从未提交）")
    dirty = git("status", "--porcelain", "--", doc.name, cwd=doc.parent)
    print("未提交改动：", "有" if dirty else "无")
    raw = doc.read_bytes()
    print("换行：", "CRLF" if b"\r\n" in raw else "LF", "（改动要保持原样）")
    return 0


# ---------------------------------------------------------------- chain

def find_graph(data, gid):
    def walk(o):
        if isinstance(o, dict):
            if o.get("id") == gid and "states" in o and "transitions" in o:
                return o
            for v in o.values():
                r = walk(v)
                if r is not None:
                    return r
        elif isinstance(o, list):
            for v in o:
                r = walk(v)
                if r is not None:
                    return r
        return None
    return walk(data)


def describe_entry(t) -> str:
    sig = t.get("signal")
    trig = t.get("trigger")
    conds = t.get("conditions") or []
    if trig in ("reactive", "reactiveAll") or sig == "__draft__":
        mode = "条件全满足自动走" if trig == "reactiveAll" else "条件满足自动走"
        return f"{mode}：{compact(conds, 300)}"
    tail = f"  且 {compact(conds, 200)}" if conds else ""
    return f"收到信号「{sig}」{tail}"


def cmd_chain(args):
    data = load(NARRATIVE)
    g = find_graph(data, args.graph)
    if g is None:
        print("没找到叙事图", args.graph)
        return 1
    states = g["states"]
    trans = g.get("transitions") or []
    out: dict[str, list] = {}
    for t in trans:
        out.setdefault(t["from"], []).append(t)
    start = g.get("initialState")
    order, seen, incoming = [], set(), {}
    queue = [start]
    while queue:
        sid = queue.pop(0)
        if sid in seen or sid not in states:
            continue
        seen.add(sid)
        order.append(sid)
        for t in out.get(sid, []):
            incoming.setdefault(t["to"], []).append(t)
            queue.append(t["to"])
    print(f"主图 {args.graph}「{g.get('label', '')}」  initialState = {start}")
    print("主链顺序（进度文档的段落顺序跟这个走）：")
    for i, sid in enumerate(order):
        st = states[sid]
        print(f"  {i:>2}. {sid}「{st.get('label', '')}」")
        for t in incoming.get(sid, []):
            print(f"        ← 从 {t['from']} 进来：{describe_entry(t)}")
        outs = out.get(sid, [])
        if len(outs) > 1:
            print(f"        ⚑ 这里分叉 {len(outs)} 路：{', '.join(x['to'] for x in outs)}")
    rest = [s for s in states if s not in seen]
    if rest:
        print("没接进主链的状态（从 initialState 走不到，不算已落地主线）：")
        for sid in rest:
            print(f"      {sid}「{states[sid].get('label', '')}」")
    return 0


# ---------------------------------------------------------------- text

def speaker_name(sp) -> str:
    if not isinstance(sp, dict):
        return str(sp) if sp else "?"
    kind = sp.get("kind")
    if kind == "player":
        return "主角"
    if kind == "npc":
        return "对话宿主NPC"
    if kind == "literal":
        return sp.get("name") or "旁白"
    if kind == "sceneNpc":
        return f"场景NPC:{sp.get('npcId')}"
    return compact(sp, 60)


def action_line(a, depth=0) -> list[str]:
    pad = "      " + "  " * depth
    t = a.get("type")
    p = a.get("params") or {}
    lines = []
    if t == "runActionsIf":
        lines.append(f"{pad}如果 {compact(p.get('condition'), 220)}：")
        for sub in p.get("actions") or []:
            lines += action_line(sub, depth + 1)
        for sub in p.get("elseActions") or []:
            lines.append(f"{pad}否则：")
            lines += action_line(sub, depth + 1)
    elif t == "playScriptedDialogue":
        lines.append(f"{pad}脚本台词：")
        for ln in p.get("lines") or []:
            lines.append(f"{pad}  {ln.get('speaker', '?')}：{ln.get('text', '')}")
    else:
        lines.append(f"{pad}动作 {t} {compact(p, 160)}")
    return lines


def dump_dialogue(gid: str, graph) -> None:
    print(f"对话图 {gid}  标题：{(graph.get('meta') or {}).get('title', '')}")
    if graph.get("preconditions"):
        print("  前置条件：", compact(graph["preconditions"], 300))
    nodes = graph.get("nodes") or {}
    stack, seen = [graph.get("entry")], set()
    while stack:
        nid = stack.pop()
        if nid is None or nid in seen or nid not in nodes:
            continue
        seen.add(nid)
        n = nodes[nid]
        t = n.get("type")
        nxt = []
        if t == "line":
            items = n.get("lines") or [n]
            print(f"  [{nid}]")
            for it in items:
                print(f"      {speaker_name(it.get('speaker', n.get('speaker')))}：{it.get('text', '')}")
            nxt = [n.get("next")]
            print(f"      → {n.get('next')}")
        elif t == "choice":
            pl = n.get("promptLine")
            print(f"  [{nid}] 选项")
            if pl:
                print(f"      {speaker_name(pl.get('speaker'))}：{pl.get('text', '')}")
            for op in n.get("options") or []:
                extra = f"  条件 {compact(op.get('conditions'), 120)}" if op.get("conditions") else ""
                print(f"      · {op.get('text', '')} → {op.get('next')}{extra}")
                nxt.append(op.get("next"))
        elif t in ("switch", "ownerState", "contextState"):
            host = n.get("wrapperGraphId") or n.get("graphId") or ""
            print(f"  [{nid}] 分支 {t} {host}")
            for c in n.get("cases") or []:
                key = c.get("state") if "state" in c else compact(c.get("conditions"), 200)
                print(f"      · {key} → {c.get('next')}")
                nxt.append(c.get("next"))
            print(f"      · 其余 → {n.get('defaultNext')}")
            nxt.append(n.get("defaultNext"))
        elif t == "runActions":
            print(f"  [{nid}] 执行")
            for a in n.get("actions") or []:
                for ln in action_line(a):
                    print(ln)
            print(f"      → {n.get('next')}")
            nxt = [n.get("next")]
        elif t == "end":
            print(f"  [{nid}] 结束")
        else:
            print(f"  [{nid}] {t} {compact(n, 200)}")
        for x in reversed(nxt):
            if x not in seen:
                stack.append(x)
    unreached = [k for k in nodes if k not in seen]
    if unreached:
        print("  从 entry 走不到的节点（不算落地）：", ", ".join(unreached))


def _track_steps(track):
    if isinstance(track, list):
        return track
    if isinstance(track, dict) and "kind" in track:
        return [track]
    if isinstance(track, dict):
        return track.get("steps") or []
    return []


def _is_story(s) -> bool:
    kind, t = s.get("kind"), s.get("type")
    if s.get("disabled"):
        return False
    if kind == "parallel":
        return any(_is_story(x) for tr in s.get("tracks") or [] for x in _track_steps(tr))
    return (kind == "present" and t in STORY_PRESENT) or (kind == "action" and t in STORY_ACTIONS)


def dump_steps(steps, show_all: bool, depth=1):
    pad = "  " * depth
    skipped = 0

    def flush():
        nonlocal skipped
        if skipped:
            print(f"{pad}…略过 {skipped} 步镜头/移动/等待")
            skipped = 0

    for s in steps or []:
        if s.get("disabled"):
            flush()
            print(f"{pad}（已禁用的一步，不算落地：{s.get('type') or s.get('kind')}）")
            continue
        kind, t = s.get("kind"), s.get("type")
        if not show_all and not _is_story(s):
            skipped += 1
            continue
        flush()
        if kind == "parallel":
            print(f"{pad}〈同时〉")
            for track in s.get("tracks") or []:
                dump_steps(_track_steps(track), show_all, depth + 1)
        elif t == "showDialogue":
            who = s.get("speaker") or s.get("scriptedNpcId") or "（没标说话人）"
            if s.get("speaker") and s.get("scriptedNpcId"):
                who = f"{s['speaker']}/{s['scriptedNpcId']}"
            print(f"{pad}{who}：{s.get('text', '')}")
        elif t == "showSubtitle":
            print(f"{pad}字幕：{s.get('text', '')}")
        elif t == "showTitle":
            print(f"{pad}标题：{s.get('text', '')}")
        elif t == "showImg":
            print(f"{pad}图：{s.get('image', '')}")
        else:
            print(f"{pad}{kind}:{t} {compact(s.get('params', {k: v for k, v in s.items() if k not in ('kind', 'type')}), 160)}")
    flush()


def find_dialogue(gid: str):
    p = DLG_DIR / f"{gid}.json"
    if p.is_file():
        return load(p)
    for f in DLG_DIR.glob("*.json"):
        try:
            d = load(f)
        except Exception:
            continue
        if d.get("id") == gid:
            return d
    return None


def cmd_text(args):
    d = find_dialogue(args.id)
    if d is not None:
        dump_dialogue(args.id, d)
        return 0
    for c in load(CUTSCENES):
        if c.get("id") == args.id:
            print(f"过场 {args.id}  场景：{c.get('targetScene', '')}")
            dump_steps(c.get("steps"), args.all)
            siblings = [x["id"] for x in load(CUTSCENES) if x["id"] != args.id and (x["id"].startswith(args.id + "__") or args.id.startswith(x["id"] + "__"))]
            if siblings:
                print("  ⚠ 同名拆分件：", ", ".join(siblings))
                print("    只有被 starts 查到真接线的那几件才算落地，别把父件和兄弟件一起读。")
            return 0
    print("既不是对话图也不是过场：", args.id)
    return 1


# ---------------------------------------------------------------- starts / flag

def iter_asset_json():
    for f in sorted(ASSETS.rglob("*.json")):
        try:
            yield f, load(f)
        except Exception:
            continue


def walk_with_ancestors(o, path="", anc=()):
    if isinstance(o, dict):
        yield path, o, anc
        for k, v in o.items():
            yield from walk_with_ancestors(v, f"{path}/{k}", anc + (o,))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from walk_with_ancestors(v, f"{path}/{i}", anc)


def owner_of(anc) -> str:
    for a in reversed(anc):
        if isinstance(a, dict) and "id" in a and any(k in a for k in ("polygon", "type", "name", "dialogueGraphId", "onEnter", "onInteract", "conditions")):
            conds = a.get("conditions")
            c = f"  条件 {compact(conds, 200)}" if conds else ""
            return f"{a.get('name') or a.get('label') or ''}（{a['id']}）{c}"
    return ""


def cmd_starts(args):
    target = args.id
    hits = 0
    for f, data in iter_asset_json():
        rel = f.relative_to(REPO).as_posix()
        for path, node, anc in walk_with_ancestors(data):
            t = node.get("type")
            p = node.get("params") if isinstance(node.get("params"), dict) else {}
            hit = None
            if t in ("startCutscene", "playCutscene") and p.get("id") == target:
                hit = t
            elif t == "startDialogueGraph" and p.get("graphId") == target:
                hit = t
            elif node.get("dialogueGraphId") == target:
                hit = "dialogueGraphId（交互即开）"
            elif isinstance(node.get("data"), dict) and node["data"].get("graphId") == target:
                hit = f"{node.get('type', '')} 热点 data.graphId（交互即开）"
            if hit:
                hits += 1
                print(f"· {rel}#{path}  {hit}")
                own = owner_of(anc + (node,)) if ("dialogueGraphId" in node or "data" in node) else owner_of(anc)
                if own:
                    print(f"    挂在：{own}")
    if not hits:
        print(f"没有任何地方启动 {target} —— 它没接线，不算落地。")
        print("（场景里 cutsceneIds 清单只是预加载，不算接线。）")
    return 0


def cmd_flag(args):
    name = args.name
    item = name[len("has_item_"):] if name.startswith("has_item_") else None
    rule = None
    if name.startswith("rule_") and name.endswith("_acquired"):
        rule = name[len("rule_"):-len("_acquired")]
    fragments = set()
    if rule:
        rules_data = load(ASSETS / "data" / "rules.json")
        fragments = {fr["id"] for fr in rules_data.get("fragments") or [] if fr.get("ruleId") == rule}
    hits = 0
    for f, data in iter_asset_json():
        rel = f.relative_to(REPO).as_posix()
        for path, node, anc in walk_with_ancestors(data):
            t = node.get("type")
            p = node.get("params") if isinstance(node.get("params"), dict) else {}
            why = None
            if t in ("setFlag", "addFlagValue") and p.get("key") == name:
                why = f"{t} {compact(p, 120)}"
            elif item and t == "giveItem" and p.get("id") == item:
                why = f"{t} {compact(p, 120)}"
            elif rule and t == "giveRule" and p.get("id") == rule:
                why = f"{t} {compact(p, 120)}"
            elif rule and t == "grantRuleLayer" and p.get("ruleId") == rule:
                why = f"{t} {compact(p, 120)}（只给一层，要看这条规矩几层才算全得）"
            elif rule and t == "giveFragment" and p.get("id") in fragments:
                why = f"{t} {compact(p, 120)}（碎片，要集齐才算全得）"
            if why:
                hits += 1
                print(f"· {rel}#{path}  {why}")
                own = owner_of(anc)
                if own:
                    print(f"    挂在：{own}")
        if rel.endswith("data/shops.json") and item:
            if f'"{item}"' in json.dumps(data, ensure_ascii=False):
                print(f"· {rel}  商店里有卖 {item}（要再确认那家店在主线期间开不开）")
                hits += 1
    if not hits:
        print(f"数据里没有任何地方设置 {name}。")
        print("已查过：setFlag / addFlagValue / giveItem（含任务奖励与各处动作）/ giveRule / grantRuleLayer / giveFragment / 商店。")
        print(f"剩下唯一可能是代码直接设：用 Grep 工具在 src/ 搜 {name}（排除 *.test.ts）；"
              "规矩类标记 rule_<id>_acquired 是 RulesManager 在得到规矩时设的，不算独立来源。都没有 → 挂在它上面的内容玩家拿不到，不算落地。")
    return 0


# ---------------------------------------------------------------- check

FORBIDDEN = [
    ("括号", "（）()【】[]"),
    ("问号", "？?"),
    ("引号", "“”\"「」『』"),
    ("表格/列表/标题符号", "|#"),
]
FORBIDDEN_WORDS = ["state_", "scenario_", "wrap", ".json", "/", "\\", "TODO", "待办", "待补", "本文档", "本段", "注："]


def cmd_check(args):
    import difflib
    doc = resolve_doc()
    if doc is None:
        print("找不到进度文档")
        return 1
    snap = Path(args.snapshot)
    old_raw, new_raw = snap.read_bytes(), doc.read_bytes()
    old_crlf, new_crlf = b"\r\n" in old_raw, b"\r\n" in new_raw
    print("换行：快照", "CRLF" if old_crlf else "LF", "→ 现在", "CRLF" if new_crlf else "LF",
          "✓" if old_crlf == new_crlf else "✗ 换行被改了，全文会变 diff，撤回用 Edit 重写")
    old = old_raw.decode("utf-8").replace("\r\n", "\n").split("\n")
    new = new_raw.decode("utf-8").replace("\r\n", "\n").split("\n")
    removed, added = [], []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += [(i + 1, old[i]) for i in range(i1, i2)]
        if tag in ("replace", "insert"):
            added += [(j + 1, new[j]) for j in range(j1, j2)]
    removed_text = [x for x in removed if x[1].strip()]
    if args.allow_replace:
        print(f"改动的原有行：{len(removed_text)}（制作人点名替换模式：逐条确认每一行都是他让改的，前后都要贴进汇报）")
    else:
        print(f"删除/改动的原有行：{len(removed_text)}", "✓" if not removed_text else "✗ 动了原有的字，撤回重来")
    for ln, t in removed_text:
        print(f"    - 快照第{ln}行：{t[:80]}")
    added_text = [x for x in added if x[1].strip()]
    print(f"新增行：{len(added_text)}（其中不是你写的要在汇报里说明——别人可能同时在改）")
    bad = 0
    for ln, t in added_text:
        hits = [name for name, chars in FORBIDDEN if any(c in t for c in chars)]
        hits += [f"「{w}」" for w in FORBIDDEN_WORDS if w in t]
        if any(ch.isascii() and ch.isalnum() for ch in t):
            hits.append("半角字母/数字")
        mark = "✗ " + "、".join(hits) if hits else "✓"
        bad += bool(hits)
        print(f"    + 第{ln}行 {mark}：{t[:60]}{'…' if len(t) > 60 else ''}")
    print("违禁扫描：", "✓ 干净" if not bad else f"✗ {bad} 行有问题（只扫新增行；原有行不管）")
    return 0 if (args.allow_replace or not removed_text) and not bad and old_crlf == new_crlf else 2


# ---------------------------------------------------------------- changed

def dialogue_texts(g) -> list[str]:
    out = []
    for n in (g.get("nodes") or {}).values():
        for it in (n.get("lines") or ([n] if "text" in n else [])):
            if it.get("text"):
                out.append(it["text"])
        if n.get("promptLine", {}).get("text"):
            out.append(n["promptLine"]["text"])
        for op in n.get("options") or []:
            if op.get("text"):
                out.append(op["text"])
        for _, node, _ in walk_with_ancestors(n.get("actions") or []):
            if node.get("type") == "playScriptedDialogue":
                out += [ln.get("text", "") for ln in (node.get("params") or {}).get("lines") or []]
    return out


def cutscene_texts(c) -> list[str]:
    out = []
    for _, node, anc in walk_with_ancestors(c.get("steps") or []):
        if node.get("disabled") or any(isinstance(a, dict) and a.get("disabled") for a in anc):
            continue
        if node.get("type") in ("showDialogue", "showSubtitle", "showTitle") and node.get("text"):
            who = node.get("speaker") or node.get("scriptedNpcId") or ""
            out.append(f"{who}：{node['text']}" if who else node["text"])
    return out


def quest_texts(q) -> list[str]:
    out = [q.get("title", ""), q.get("description", "")]
    for ob in q.get("objectives") or []:
        out.append(ob.get("text", ""))
    return [x for x in out if x]


def scene_wiring(scene) -> set[tuple]:
    rows = set()
    for kind in ("npcs", "hotspots", "zones"):
        for e in scene.get(kind) or []:
            eid = e.get("id")
            cond = compact(e.get("conditions"), 400) if e.get("conditions") else ""
            if e.get("dialogueGraphId"):
                rows.add((kind, eid, "dialogueGraphId", e["dialogueGraphId"], cond))
            if isinstance(e.get("data"), dict) and e["data"].get("graphId"):
                rows.add((kind, eid, "data.graphId", e["data"]["graphId"], cond))
            for path, node, _ in walk_with_ancestors(e):
                t = node.get("type")
                p = node.get("params") if isinstance(node.get("params"), dict) else {}
                if t in ("startCutscene", "playCutscene"):
                    rows.add((kind, eid, t, p.get("id"), cond))
                elif t == "startDialogueGraph":
                    rows.add((kind, eid, t, p.get("graphId"), cond))
                elif t == "emitNarrativeSignal":
                    rows.add((kind, eid, t, p.get("signal"), cond))
    for path, node, _ in walk_with_ancestors(scene.get("onEnter") or []):
        t = node.get("type")
        p = node.get("params") if isinstance(node.get("params"), dict) else {}
        if t in ("startCutscene", "startDialogueGraph", "emitNarrativeSignal"):
            rows.add(("onEnter", "", t, p.get("id") or p.get("graphId") or p.get("signal"), ""))
    return rows


def git_ls_names(rev: str, directory: Path) -> set[str]:
    rel = directory.relative_to(REPO).as_posix() + "/"
    r = subprocess.run(["git", "-c", "core.quotepath=false", "ls-tree", "-z", "--name-only", rev, rel], cwd=REPO, capture_output=True)
    return {Path(x).name for x in r.stdout.decode("utf-8").split("\0") if x}


def diff_lists(tag, old, new):
    if old is None and new is None:
        return False
    if old is None:
        print(f"  + 新增 {tag}")
        for x in new:
            print(f"      + {x}")
        return True
    if new is None:
        print(f"  - 删除 {tag}")
        return True
    so, sn = set(old), set(new)
    add = [x for x in new if x not in so]
    rem = [x for x in old if x not in sn]
    if not add and not rem:
        return False
    print(f"  ~ {tag}")
    for x in rem:
        print(f"      - {x}")
    for x in add:
        print(f"      + {x}")
    return True


def cmd_changed(args):
    if args.base:
        base = git("rev-parse", args.base)
    elif args.since:
        base = git("rev-list", "-1", f"--before={args.since}", "HEAD")
    else:
        print("--since 和 --base 至少给一个")
        return 1
    if not base:
        print("找不到基线提交：", args.base or args.since)
        return 1
    print("基线提交：", git("log", "-1", "--format=%h %cd %s", "--date=format:%Y-%m-%d %H:%M", base))
    later = git("log", "--format=  %h %cd %s", "--date=format:%Y-%m-%d %H:%M", f"{base}..HEAD")
    print("基线之后的提交（按提交时间；提交晚于写文档不代表内容晚于写文档）：")
    print(later or "  （无）")
    print("对比对象：当前工作树（含未提交改动）")
    print("⚠ 如果写文档那会儿数据本身还没提交，基线会偏早，结果里会混进写文档时已经存在的东西——逐条回数据核实。\n")

    print("【过场台词】")
    old_cs = {c["id"]: c for c in (git_show_json(base, CUTSCENES) or [])}
    new_cs = {c["id"]: c for c in load(CUTSCENES)}
    any_hit = False
    for cid in sorted(set(old_cs) | set(new_cs)):
        o = cutscene_texts(old_cs[cid]) if cid in old_cs else None
        n = cutscene_texts(new_cs[cid]) if cid in new_cs else None
        any_hit |= diff_lists(f"过场 {cid}", o, n)
    print("  （无变化）" if not any_hit else "")

    print("【对话图台词】")
    any_hit = False
    names = {f.name for f in DLG_DIR.glob("*.json")}
    old_names = git_ls_names(base, DLG_DIR)
    for name in sorted(names | old_names):
        path = DLG_DIR / name
        o = git_show_json(base, path) if name in old_names else None
        n = load(path) if name in names else None
        any_hit |= diff_lists(f"对话图 {name[:-5]}", dialogue_texts(o) if o else None, dialogue_texts(n) if n else None)
    print("  （无变化）" if not any_hit else "")

    print("【任务文案】")
    any_hit = False
    old_q = {q["id"]: q for q in (git_show_json(base, QUESTS) or [])}
    new_q = {q["id"]: q for q in load(QUESTS)}
    for qid in sorted(set(old_q) | set(new_q)):
        any_hit |= diff_lists(f"任务 {qid}", quest_texts(old_q[qid]) if qid in old_q else None, quest_texts(new_q[qid]) if qid in new_q else None)
    print("  （无变化）" if not any_hit else "")

    print(f"【主图 {args.graph} 状态与转移】")
    og = find_graph(git_show_json(base, NARRATIVE) or {}, args.graph) or {"states": {}, "transitions": []}
    ng = find_graph(load(NARRATIVE), args.graph) or {"states": {}, "transitions": []}
    o_rows = [f"{k}「{v.get('label', '')}」" for k, v in og["states"].items()] + [f"{t['from']}→{t['to']} {describe_entry(t)}" for t in og["transitions"]]
    n_rows = [f"{k}「{v.get('label', '')}」" for k, v in ng["states"].items()] + [f"{t['from']}→{t['to']} {describe_entry(t)}" for t in ng["transitions"]]
    if not diff_lists("主图", o_rows, n_rows):
        print("  （无变化）")

    print("\n【场景接线（谁启动哪段对话/过场、发哪个信号）】")
    any_hit = False
    old_scene_names = git_ls_names(base, SCENES)
    for f in sorted(SCENES.glob("*.json")):
        o = git_show_json(base, f) if f.name in old_scene_names else None
        try:
            n = load(f)
        except Exception:
            continue
        orows = sorted(scene_wiring(o)) if o else None
        nrows = sorted(scene_wiring(n))
        fmt = lambda rows: None if rows is None else [f"{r[0]}:{r[1]} {r[2]}={r[3]} {r[4]}" for r in rows]
        any_hit |= diff_lists(f"场景 {f.stem}", fmt(orows), fmt(nrows))
    print("  （无变化）" if not any_hit else "")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("doc")
    p = sub.add_parser("chain")
    p.add_argument("--graph", default="flow_xungou_main")
    p = sub.add_parser("text")
    p.add_argument("id")
    p.add_argument("--all", action="store_true", help="过场里镜头/移动/等待也全打出来")
    p = sub.add_parser("starts")
    p.add_argument("id")
    p = sub.add_parser("flag")
    p.add_argument("name")
    p = sub.add_parser("check")
    p.add_argument("--snapshot", required=True, help="开工时复制的文档快照")
    p.add_argument("--allow-replace", action="store_true", help="制作人点名要改原有段落时用：改动行不判错，只列出")
    p = sub.add_parser("changed")
    p.add_argument("--since", help="如 '2026-09-11 20:15'：取这个时间之前最后一个提交当基线")
    p.add_argument("--base", help="直接指定基线提交（优先于 --since）")
    p.add_argument("--graph", default="flow_xungou_main")
    args = ap.parse_args()
    return {"doc": cmd_doc, "chain": cmd_chain, "text": cmd_text, "starts": cmd_starts, "flag": cmd_flag,
            "changed": cmd_changed, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main() or 0)
