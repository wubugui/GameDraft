"""Author the first two events into the project's native, editor-owned JSON.

This is a one-shot authoring aid, not a runtime format. Subsequent editing remains
in the normal editors. IDs from the earlier three errands are preserved.
"""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "public/assets"


def read(path):
    return json.loads((ASSETS / path).read_text(encoding="utf-8"))


def write(path, data):
    (ASSETS / path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


strings = read("data/strings.json")
strings.setdefault("owFirst", {})


def txt(key, value):
    strings["owFirst"][key] = value
    return f"[tag:string:owFirst:{key}]"


def state(graph, name, reached=False):
    result = {"narrative": graph, "state": name}
    if reached:
        result["reached"] = True
    return result


def any_of(*conditions):
    return {"any": list(conditions)}


def all_of(*conditions):
    return {"all": list(conditions)}


def neg(condition):
    return {"not": condition}


def act(kind, **params):
    return {"type": kind, "params": params}


def emit(signal):
    return act("emitNarrativeSignal", signal=signal)


def give(item, count=1):
    return act("giveItem", id=item, count=count, critical=True)


def has(item):
    return {"flag": "has_item_" + item}


def transition(source, target, signal, *conditions):
    result = {"id": f"{source}_{target}_{signal}", "from": source, "to": target, "signal": signal}
    if conditions:
        result["conditions"] = list(conditions)
    return result


def graph(gid, label, states, transitions, owner_type="flow", owner_id=None):
    mapped = {}
    for i, (key, spec) in enumerate(states.items()):
        title, actions = spec if isinstance(spec, tuple) else (spec, [])
        mapped[key] = {"id": key, "label": title, "meta": {"editor": {"x": i % 4 * 270, "y": i // 4 * 180}}}
        if actions:
            mapped[key]["onEnterActions"] = actions
    return {"id": gid, "label": label, "ownerType": owner_type, "ownerId": owner_id or gid,
            "initialState": "initial", "states": mapped, "transitions": transitions}


def wrapper(g, x, y):
    return {"id": g["id"] + "_element", "kind": "wrapperGraph", "label": g["label"],
            "refId": "", "x": x, "y": y, "ownerType": g["ownerType"], "ownerId": g["ownerId"], "graph": g,
            "meta": {"emits": [], "reads": [], "commands": []}}


T = "flow_ow_tally"
P = "flow_ow_tally_trace"
C = "flow_ow_tally_count"
W = "flow_ow_tally_witness"
K = "flow_ow_knife"
L = "flow_ow_rope_loan"
t_done = any_of(*(state(T, s, True) for s in ["done", "fair", "witness", "compromise"]))
t_fair = any_of(*(state(T, s, True) for s in ["done", "fair", "witness"]))
found = state(T, "found")
rubbed = state(P, "rubbed", True)
counted = state(C, "seen", True)
witnessed = state(W, "seen", True)

data = read("data/narrative_graphs.json")
tally_comp = next(c for c in data["compositions"] if c["mainGraph"]["id"] == T)
old_done = deepcopy(tally_comp["mainGraph"]["states"]["done"])


def settle(amount, rope=False):
    actions = [act("removeItem", id="ow_tally", count=1), act("giveCurrency", amount=amount)]
    if rope:
        actions.append(emit("ow_rope_loan"))
    return actions


tally_comp.update(label="工票上的两笔账", description="C01：先拾票、先问账或先看货；拓票 / 核实货堆与目击 / 折中结算。保留旧存档状态。")
tally_comp["mainGraph"] = graph(T, "工票上的两笔账", {
    "initial": "尚未涉入",
    "accepted": "听说两笔账",
    "found": ("工票在手，可自行决定查法", [give("ow_tally")]),
    "done": "旧存档：已经公平结清",
    "fair": ("以拓痕核清两担", settle(12, True)),
    "witness": ("以垛脚与目击核清两担", settle(10, True)),
    "compromise": ("按一担半折中结清", settle(5)),
}, [
    transition("initial", "accepted", "ow_tally_accept"),
    transition("initial", "accepted", "ow_tally_count"),
    transition("initial", "found", "ow_tally_find"),
    transition("accepted", "found", "ow_tally_find"),
    transition("found", "fair", "ow_tally_fair", rubbed, has("ow_tally")),
    transition("found", "witness", "ow_tally_witness_settle", witnessed, has("ow_tally")),
    transition("found", "compromise", "ow_tally_compromise", has("ow_tally")),
])
tally_comp["mainGraph"]["states"]["done"] = old_done
tally_comp["elements"] = [
    wrapper(graph(P, "工票压痕", {"initial": "未拓票", "rubbed": ("炭粉显出第二笔", [act("removeItem", id="ow_charcoal", count=1)])},
                  [transition("initial", "rubbed", "ow_tally_rub", found, has("ow_tally"), has("ow_charcoal"))], "hotspot", "ow_tally_pickup"), 0, 420),
    wrapper(graph(C, "垛脚装货记号", {"initial": "未辨认", "seen": "看清两次落垛"},
                  [transition("initial", "seen", "ow_tally_count")], "hotspot", "ow_tally_stack"), 320, 420),
    wrapper(graph(W, "邓幺的目击", {"initial": "尚未核实", "seen": "货堆与目击互相印证"},
                  [transition("initial", "seen", "ow_tally_witness", counted)], "npc", "ow_deng"), 640, 420),
    wrapper(graph(L, "周三借出的缆绳", {"initial": "还未借出", "given": ("缆绳已经借出", [give("ow_rope")])},
                  [transition("initial", "given", "ow_rope_loan", t_fair)], "npc", "ow_zhou"), 960, 420),
]
knife_comp = {"id": K + "_composition", "label": "罗伯的篾刀", "description": "S07：先问或先发现，蹲取后归还；提供拓票与修补材料。", "elements": [],
    "mainGraph": graph(K, "罗伯的篾刀", {
        "initial": "还没留意", "accepted": "知道工位少了刀",
        "carrying": ("从工位下取回篾刀", [give("ow_knife")]),
        "done": ("篾刀归位", [act("removeItem", id="ow_knife", count=1), give("ow_charcoal", 3), give("ow_bamboo", 2)]),
    }, [transition("initial", "accepted", "ow_knife_accept"),
        transition("initial", "carrying", "ow_knife_take"),
        transition("accepted", "carrying", "ow_knife_take"),
        transition("carrying", "done", "ow_knife_return", has("ow_knife"))])}
data["compositions"] = [c for c in data["compositions"] if c["id"] != knife_comp["id"]] + [knife_comp]
for sig, label in {
    "ow_tally_rub": "在背包中拓清工票", "ow_tally_count": "观察垛脚记号", "ow_tally_witness": "核对邓幺的目击",
    "ow_tally_fair": "持拓票结清", "ow_tally_witness_settle": "据目击结清", "ow_tally_compromise": "接受折中结算",
    "ow_knife_accept": "听说篾刀丢失", "ow_knife_take": "蹲下取出篾刀", "ow_knife_return": "篾刀归还罗伯",
    "ow_rope_loan": "周三出借缆绳",
}.items():
    if not any(s["id"] == sig for s in data["signals"]):
        data["signals"].append({"id": sig, "label": label})

dg = read("dialogues/graphs/开放世界_街坊.json")
nodes = dg["nodes"]


def line(node_id, prose, next_id="end", npc=True):
    nodes[node_id] = {"type": "line", "speaker": {"kind": "npc"} if npc else {"kind": "literal", "name": "旁白"},
                      "text": txt(node_id, prose), "next": next_id}


def run(node_id, actions, next_id="end"):
    nodes[node_id] = {"type": "runActions", "actions": actions, "next": next_id}


def switch(node_id, cases, default):
    nodes[node_id] = {"type": "switch", "cases": [{"condition": c, "next": n} for c, n in cases], "defaultNext": default}


def option(key, prose, next_id, condition=None, hint=None):
    out = {"id": key, "text": txt(key, prose), "next": next_id}
    if condition is not None:
        out["requireCondition"] = condition
    if hint:
        out["disabledClickHint"] = txt(key + "_disabled", hint)
    return out


def choice(node_id, options):
    nodes[node_id] = {"type": "choice", "options": options}


# NPC hub has a stable, short conversation about the problem, not a list of all
# undiscovered clues. Only the active bowl favour is added to Zhou's hub.
for key in list(nodes):
    if key.startswith("zhou_menu_"):
        del nodes[key]
zhou_options = [option("tally_case_option", "你那张工票，到底咋回事？", "tally_case"),
                option("tally_rope_option", "那截缆绳能借我不？", "rope_case", t_fair, "工钱还没核清，周三得留着绳子接活。"),
                option("zhou_day_new", "你啥时辰在哪点？", "zhou_day"),
                option("zhou_road_new", "附近的路咋走？", "zhou_road"),
                option("zhou_end_new", "走了，你忙。", "end")]
switch("zhou_menu", [(state("flow_ow_bowl", "accepted"), "zhou_menu_bowl")], "zhou_menu_plain")
choice("zhou_menu_plain", zhou_options)
choice("zhou_menu_bowl", [option("bowl_collect_new", "杨嫂让我来取碗。", "bowl_collect")] + zhou_options)
switch("zhou", [(state(T, "compromise"), "tally_world_compromise"), (state(T, "done"), "tally_world_legacy"), (t_fair, "tally_world_fair")], "zhou_hello")
line("tally_world_legacy", "上回那笔账结清了。你要借绳子就开口，别去水边空手摸。", "zhou_menu")
switch("rope_case", [(state(L, "given"), "rope_already")], "rope_borrow")
line("rope_already", "绳子已经在你那里了。接头有毛边那截，别拿去吃力。")
line("rope_borrow", "拿去。你帮我结清过工钱，我记着；往水边走，先找个牢靠地方系。", "rope_borrow_emit")
run("rope_borrow_emit", [emit("ow_rope_loan")])
line("tally_world_compromise", "一担半的钱拿到了。少的那点算我吃亏；等哈我还得多扛一趟。", "zhou_menu")
line("tally_world_fair", "两担就是两担，账总算掰清楚了。你拿走的那截缆绳有用，别往烂木桩上系。", "zhou_menu")
switch("tally_case", [(t_done, "tally_finished"), (found, "tally_decision"), (state(T, "accepted"), "tally_pending")], "tally_offer")
line("tally_offer", "我扛了两担，账上只认一担半。工票落在码头缆绳边了。纸折过，莫一见朱点就认账。", "tally_offer_emit")
line("tally_pending", "先找缆绳边那张票。想核实就看货垛脚底的记号，再问邓幺；罗伯的炭条也能拓纸上的压痕。")
line("tally_finished", "这笔已经结了。账上的字改得了，扛过的那一趟又抹不掉。", "zhou_menu")
line("tally_find", "折角纸片压在缆绳下面。摊开有两行浅痕，朱点却只压住一行。你把工票收好，没撕开折口。", "tally_find_emit", npc=False)
# Old terminal stays loadable; superseded conversation nodes have no external
# entry references and are removed instead of leaving dead routes in the editor.
for obsolete in ["tally_return", "tally_return_emit", "zhou_night", "zhou_thanks"]:
    nodes.pop(obsolete, None)
choice("tally_decision", [
    option("tally_show_trace", "拓痕在这里，照两担结。", "tally_fair_line", rubbed, "工票还没拓清。罗伯卖炭条，也正缺人找回篾刀；有炭条后在背包里使用工票。"),
    option("tally_show_witness", "垛脚记号和邓幺的话对得上。", "tally_witness_line", witnessed, "先观察码头货堆的垛脚，再找邓幺核对。邓幺只认亲眼见过的那一趟。"),
    option("tally_take_less", "一担半就一担半，先把钱拿到。", "tally_compromise_confirm"),
    option("tally_continue", "我再查查，票先留我这里。", "tally_more"),
])
line("tally_more", "拓痕跟看垛脚，两条路挑一条走得通就行。邓幺白天在街口或码头，傍晚回后巷。")
line("tally_fair_line", "底下这笔压痕还在！那就照两担算。十二文给你，另拿一截旧缆绳走，水边捞东西用得上。", "tally_fair_emit")
run("tally_fair_emit", [emit("ow_tally_fair")])
line("tally_witness_line", "邓幺认下第二趟，账就赖不掉。十文给你，那截缆绳也拿去。他帮我开了口，我还欠他一碗茶。", "tally_witness_emit")
run("tally_witness_emit", [emit("ow_tally_witness_settle")])
line("tally_compromise_confirm", "只结一担半，我能分你五文。少的钱得我另扛一趟补上，今晚就抽不出空帮你。想清楚没有？", "tally_compromise_choice")
choice("tally_compromise_choice", [option("tally_confirm_less", "拿五文，就这么结。", "tally_compromise_emit"), option("tally_reconsider", "算了，票先不交。", "end")])
run("tally_compromise_emit", [emit("ow_tally_compromise")])

# Two-step observation requires using the actual posture, not a dialogue option
# claiming that the player looked. A passed check is a record of the real action.
switch("tally_stack", [(counted, "tally_stack_known"), ({"posture": "gaze"}, "tally_stack_seen")], "tally_stack_hint")
line("tally_stack_hint", "上层麻袋的朱点被绳子遮住了。站定注视垛脚，才能分清泥印压着哪道刻痕。", npc=False)
line("tally_stack_seen", "两排垛脚各有一道新擦痕，后排的湿泥压在前排脚印上。货是分两趟落下的；最后一趟是谁看见的，还得问人。", "tally_stack_emit", npc=False)
run("tally_stack_emit", [emit("ow_tally_count")])
line("tally_stack_known", "两排新痕，一前一后。邓幺送货经常经过这边，或许看见过第二趟。", npc=False)
nodes["deng_menu"]["options"] = [o for o in nodes["deng_menu"]["options"] if o["id"] != "tally_ask_deng"]
nodes["deng_menu"]["options"].insert(0, option("tally_ask_deng", "周三那两趟货，你看见没有？", "tally_deng"))
switch("tally_deng", [(witnessed, "tally_deng_known"), (counted, "tally_deng_seen")], "tally_deng_hint")
line("tally_deng_hint", "我记得有一趟落了雨。空口说两趟，货栈不认；你看哈码头垛脚，泥印还没扫。", "tally_offer_emit")
line("tally_deng_seen", "前排干，后排湿？那就对了。下雨那趟我让过路，周三肩头还压着担子。你把这句话带给他，我认。", "tally_deng_emit")
run("tally_deng_emit", [emit("ow_tally_witness")])
line("tally_deng_known", "落雨那一担我亲眼看见的。前排干货、后排湿货，别把两趟搅成一趟。")

# Luo's short favour is independently discoverable and has a trading alternative.
nodes["luo_menu"]["options"] = [o for o in nodes["luo_menu"]["options"] if o["id"] not in ["knife_ask", "luo_shop_option"]]
nodes["luo_menu"]["options"][:0] = [option("knife_ask", "工位上少了啥子？", "knife_case"), option("luo_shop_option", "买点炭条、篾片。", "luo_shop")]
run("luo_shop", [act("openShop", shopId="ow_luo_supplies")])
switch("knife_case", [(state(K, "done"), "knife_done"), (state(K, "carrying"), "knife_return"), (state(K, "accepted"), "knife_pending")], "knife_offer")
line("knife_offer", "篾刀滑到铺边案板底下了，站起看不见。我这腰弯不落去，你蹲下帮我摸出来，刀刃朝外，莫抓错。", "knife_offer_emit")
run("knife_offer_emit", [emit("ow_knife_accept")])
line("knife_pending", "就在泡篾条那边的案板底下。蹲下，捏住木柄，别拿手心去碰刃口。")
switch("knife_pickup", [(any_of(state(K, "carrying"), state(K, "done")), "knife_empty"), ({"posture": "crouch"}, "knife_take")], "knife_pickup_hint")
line("knife_pickup_hint", "案板底下露出一点木柄，横梁把视线挡住了。得蹲下，才能够到里面。", npc=False)
line("knife_take", "蹲到横梁下面，刀柄就在右手边。你捏住木柄往外抽，刀刃擦过石板，没碰着手。", "knife_take_emit", npc=False)
run("knife_take_emit", [emit("ow_knife_take")])
line("knife_empty", "案板底下只剩些细篾屑，刀已经取出来了。", npc=False)
line("knife_return", "正是这把！炭条拿三支，拓字、记号都用得上；再拿两片薄篾，门闩、纸架上都能垫。", "knife_return_emit")
run("knife_return_emit", [emit("ow_knife_return")])
line("knife_done", "刀归了位，活才接得起。炭条用光了来买，莫拿湿炭往纸上糊。")

items = read("data/items.json")
tally = next(i for i in items if i["id"] == "ow_tally")
tally.update(name=txt("tally_name", "折角工票"), description=txt("tally_desc", "朱点只压住一行，折口下面还有浅痕。有炭条时，可在背包里拓清。也可保留原票，去码头看垛脚、找邓幺核账。"),
    dynamicDescriptions=[{"conditions": [rubbed], "text": txt("tally_rubbed_desc", "炭粉拓出了被折口遮住的第二笔：两次落垛、两担工钱。可直接交给周三据此核账。")}],
    use={"label": txt("tally_use", "拓清压痕"), "consume": False,
         "conditions": [found, neg(rubbed), has("ow_charcoal")],
         "disableHint": txt("tally_use_hint", "需一支炭条，且这张票还没拓过。罗伯有卖；帮他取回篾刀也能拿到。"),
         "actions": [emit("ow_tally_rub")], "resultText": txt("tally_use_result", "把炭条横着轻扫折口，第二笔渐渐显出来。不是半担，是整整一担。炭条磨尽，压痕留在了票上。")})
new_items = [
    {"id": "ow_charcoal", "name": txt("charcoal_name", "细炭条"), "type": "consumable", "maxStack": 10,
     "description": txt("charcoal_desc", "罗伯削下来的干炭条。可拓出工票浅痕，或给木料留下记号；每次拓票用一支。")},
    {"id": "ow_bamboo", "name": txt("bamboo_name", "薄篾片"), "type": "consumable", "maxStack": 10,
     "description": txt("bamboo_desc", "宽窄匀净的薄篾片，能垫闩、补纸架。把它带到需要修补的物件旁。")},
    {"id": "ow_knife", "name": txt("knife_name", "罗伯的篾刀"), "type": "key", "maxStack": 1,
     "description": txt("knife_desc", "刀柄磨出了指印，刃口朝外才不伤人。罗伯等着它接着做工。")},
    {"id": "ow_rope", "name": txt("rope_name", "结实的旧缆绳"), "type": "key", "maxStack": 1,
     "description": txt("rope_desc", "周三借出的短缆绳，捻股还紧实。可作水边捞取的系绳，或捆稳背运的东西；用前仍得看落脚处。")},
]
new_ids = {i["id"] for i in new_items}
items = [i for i in items if i["id"] not in new_ids] + new_items
shops = read("data/shops.json")
shops = [s for s in shops if s["id"] != "ow_luo_supplies"] + [{"id": "ow_luo_supplies", "name": txt("luo_shop_name", "罗伯的工料"),
    "items": [{"itemId": "ow_charcoal", "price": 2}, {"itemId": "ow_bamboo", "price": 3}]}]

dock = read("scenes/码头白天.json")
pickup = next(h for h in dock["hotspots"] if h["id"] == "ow_tally_pickup")
pickup["conditions"] = [any_of(state(T, "initial"), state(T, "accepted"))]
dock["hotspots"] = [h for h in dock["hotspots"] if h["id"] != "ow_tally_stack"] + [{
    "id": "ow_tally_stack", "type": "inspect", "label": txt("stack_label", "货堆下的垛脚"),
    "x": 1500, "y": 1021.4, "interactionRange": 85, "planes": ["normal"],
    "data": {"graphId": "开放世界_街坊", "entry": "tally_stack"}}]
alley = read("scenes/test_room_b.json")
# Reuse the authored workbench location; this is an interaction change, not an
# entity rename, move, or copy. Its existing references remain valid.
bamboo = next(h for h in alley["hotspots"] if h["id"] == "ow_bamboo")
bamboo["label"] = txt("knife_spot_label", "泡篾条的案板底下")
bamboo["data"] = {"graphId": "开放世界_街坊", "entry": "knife_pickup"}


def marker(scene, kind, entity, label="查看"):
    return [{"kind": "mapMarker", "sceneId": scene}, {"kind": "worldMarker", "sceneId": scene, "entityKind": kind, "entityId": entity, "label": label, "offscreenArrow": True}]


schedule_data = read("data/npc_schedules.json")
schedules = schedule_data["schedules"]
zhou_schedule = next(s for s in schedules if s["characterId"] == "ow_zhou")
zhou_schedule["entries"] = [e for e in zhou_schedule["entries"] if not (e["from"] == "18:00" and e["scene"] == "码头白天")]
for entry in zhou_schedule["entries"]:
    if entry["from"] == "18:00" and entry["scene"] == "雾津街头":
        entry["conditions"] = [neg(state(T, "compromise"))]
zhou_schedule["entries"].insert(0, {"from": "18:00", "to": "20:00", "scene": "码头白天", "conditions": [state(T, "compromise")]})


def npc_guidance(npc):
    out = []
    entries = next(s for s in schedules if s["characterId"] == npc)["entries"]
    resting_scene = next(e["scene"] for e in entries if e["scene"])
    for entry in entries:
        a, b = [sum(int(v) * m for v, m in zip(entry[k].split(":"), [60, 1])) for k in ["from", "to"]]
        after = {"flag": "minutes_of_day", "op": ">=", "value": a}
        before = {"flag": "minutes_of_day", "op": "<", "value": b}
        conditions = ([after, before] if a < b else [any_of(after, before)]) + entry.get("conditions", [])
        if entry["scene"]:
            for m in marker(entry["scene"], "npc", npc, "交谈"):
                m["conditions"] = conditions
                out.append(m)
        else:
            for m in marker(resting_scene, "hotspot", "ow_rest", "等到明早"):
                m["conditions"] = conditions
                out.append(m)
            out.append({"kind": "sceneHint", "sceneId": resting_scene, "text": txt(npc + "_rest_hint", "人已歇下。可到歇脚处等到明早。"), "conditions": conditions})
    return out


def objective(oid, prose, complete, guidance, available=None, optional=False):
    result = {"id": oid, "text": txt(oid, prose), "completeWhen": [complete]}
    if guidance:
        result["guidance"] = guidance
    if available is not None:
        result["availableWhen"] = [available]
    if optional:
        result["optional"] = True
    return result


quests = read("data/quests.json")
quest = next(q for q in quests if q["id"] == "ow_tally")
quest.update(title=txt("tally_title", "工票上的两笔账"), description=txt("tally_quest_desc", "周三扛了两担，账上却只有一担半。可拓票，也可查货堆、问目击；证据不足时仍能折中，但少算的钱和帮手都要有个去处。"),
    preconditions=[neg(state(T, "initial"))], completionConditions=[t_done], autoFocus=True,
    objectives=[
        objective("tally_find_obj", "取出码头缆绳旁的工票", any_of(state(T, "found", True), t_done), marker("码头白天", "hotspot", "ow_tally_pickup")),
        objective("tally_trace_obj", "用炭条拓票（背包中使用工票）", rubbed, npc_guidance("ow_luo"), all_of(found, neg(has("ow_charcoal"))), True),
        objective("tally_trace_ready_obj", "在背包中使用工票，拓清压痕", rubbed, [], all_of(found, has("ow_charcoal")), True),
        objective("tally_count_obj", "注视码头垛脚，分清两次落货", counted, marker("码头白天", "hotspot", "ow_tally_stack"), neg(t_done), True),
        objective("tally_witness_obj", "找邓幺核对最后一趟货", witnessed, npc_guidance("ow_deng"), counted, True),
        objective("tally_return_obj", "与周三决定这笔账怎样结", t_done, npc_guidance("ow_zhou"), found),
    ])
quests = [q for q in quests if q["id"] != "ow_knife"] + [{"id": "ow_knife", "group": "xungou", "type": "side", "autoFocus": True,
    "title": txt("knife_title", "罗伯的篾刀"), "description": txt("knife_quest_desc", "罗伯的刀卡在后巷案板底下。蹲下取回交给他，可换得炭条和薄篾片。"),
    "preconditions": [neg(state(K, "initial"))], "completionConditions": [state(K, "done", True)], "rewards": [], "nextQuests": [],
    "objectives": [objective("knife_get_obj", "蹲下取出案板底的篾刀", state(K, "carrying", True), marker("test_room_b", "hotspot", "ow_bamboo")),
                   objective("knife_return_obj", "把篾刀交给罗伯", state(K, "done", True), npc_guidance("ow_luo"), state(K, "carrying", True))]}]
for obj in next(q for q in quests if q["id"] == "ow_bowl")["objectives"]:
    if obj["id"] == "bowl_collect_obj":
        obj["guidance"] = npc_guidance("ow_zhou")

for path, value in [("data/narrative_graphs.json", data), ("dialogues/graphs/开放世界_街坊.json", dg),
                    ("data/items.json", items), ("data/shops.json", shops), ("scenes/码头白天.json", dock),
                    ("scenes/test_room_b.json", alley), ("data/quests.json", quests), ("data/strings.json", strings),
                    ("data/npc_schedules.json", schedule_data)]:
    write(path, value)
print("Authored C01 and S07 into native data; execution/round-trip/world validation still required.")
