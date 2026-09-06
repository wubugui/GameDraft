"""Generate the two player-facing Markdown books from the current route and map index.

Writes only FOLLOW_ALONG.md and README.md beside this script. Never changes the
route, atlas data, game data, images, or any runtime session; no network access.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCENES = {
    "雾津街头": ("雾津街头", "street"), "test_room_b": ("后巷", "alley"),
    "码头白天": ("码头", "dock"), "河边": ("河边", "river"),
    "bridge_underpass": ("桥下", "bridge"), "mountain_pass": ("山路", "mountain"),
    "temple_exterior": ("庙前院", "temple-yard"), "temple": ("城隍庙内", "temple-hall"),
    "teahouse": ("茶馆", "teahouse"),
}
OUTCOMES = {
    "ow_tally": {"fair": "拓清工票，按实结账"},
    "ow_water": {"repaired": "捞出阻水箱，修好低岸"},
    "ow_coat": {"returned": "保留工衣痕迹，交还周三"},
    "ow_watch": {"patched": "修好备用梆，交给丁四"},
    "ow_paper": {"remade": "在工台重做纸人"},
    "ow_incense": {"sheltered": "查风、挡缝，再复查灰盘"},
    "ow_stove": {"repaired": "修街头冷灶并试火"},
    "ow_sugar": {"eaten": "归还小钩后问目击；糖画自己吃，留下木签"},
    "ow_notice": {"luo": "请罗伯念告示"},
    "ow_bolt": {"sugar_stick": "用糖画木签挑闩，省下薄篾"},
}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    route = load(HERE / "route.json")
    markers = load(HERE / "marker-index.json")
    app_text = (HERE / "app-data.js").read_text(encoding="utf-8")
    app = json.loads(app_text.split("=", 1)[1].strip().rstrip(";"))
    strings = load(ROOT / "public/assets/data/strings.json")

    def resolve(text: str) -> str:
        return re.sub(r"\[tag:string:([^:]+):([^\]]+)\]",
                      lambda m: str(strings.get(m[1], {}).get(m[2], m[0])), str(text))

    items = {x["id"]: resolve(x.get("name", x["id"])) for x in load(ROOT / "public/assets/data/items.json")}
    quest_names = {q["id"]: resolve(q.get("title", q["id"])) for q in load(ROOT / "public/assets/data/quests.json")}
    atlas_entities = {e["markerId"]: e for s in app["atlas"]["scenes"] for e in s["entities"]}
    steps = route["steps"]
    by_id = {s["id"]: s for s in steps}
    positions = {s["id"]: i for i, s in enumerate(steps)}
    if len(by_id) != len(steps):
        raise ValueError("Duplicate route step IDs")
    ledger = route["finalLedger"]

    def scene_name(sid: str) -> str:
        return SCENES.get(sid, (sid, sid))[0]

    def map_link(sid: str) -> str:
        name, slug = SCENES.get(sid, (sid, sid))
        return f"[{name}编号图](maps/{slug}.png)"

    def marker(sid: str, eid: str) -> str:
        mid = sid + "::" + eid
        if mid not in markers:
            raise ValueError("Missing map marker: " + mid)
        m = markers[mid]
        return f"**{m['code']} {resolve(m['name'])}**"

    def step_markers(s: dict) -> str:
        return "、".join(marker(s["sceneId"], e["id"]) for e in s.get("entities", [])) or "原地查看任务页／摸囊"

    def inventory_text(bag: dict) -> str:
        return "、".join(f"{items.get(k, k)}×{v}" for k, v in bag.items() if v) or "空囊"

    def clock_text(clock: dict) -> str:
        before_day, after_day = clock["routeDayBefore"], clock["routeDayAfter"]
        before, after = clock["before"], clock["after"]
        if before_day != after_day:
            return f"开局当天 {before} → 次日 {after}"
        return f"{before} → {after}" if before != after else f"{after}（不走时）"

    def exit_entities(s: dict) -> list[dict]:
        return [e for e in s.get("entities", [])
                if atlas_entities.get(e["markerId"], {}).get("kind") == "exit"]

    def next_text(s: dict) -> str:
        nxt = s.get("next", {})
        if not nxt.get("stepId"):
            return "当前25项到此核对完成，可保存游戏；无需再找出口。"
        following = by_id[nxt["stepId"]]
        text = f"第 {following['id']} 步，{scene_name(following['sceneId'])} → {step_markers(following)}。"
        exits = exit_entities(s)
        if exits:
            return f"本步由 {marker(s['sceneId'], exits[0]['id'])} 出场；接着做{text}"
        # The next exit is a later numbered step, not an instruction to skip intervening work.
        for later in steps[positions[s["id"]]+1:]:
            if later["sceneId"] != s["sceneId"]:
                break
            exits = exit_entities(later)
            if exits:
                text += f" 本段做至第 {later['id']} 步，再走 {marker(s['sceneId'], exits[0]['id'])} 离开。"
                break
        return text

    shopping = "；".join(f"{items[x['itemId']]}×{x['count']}（{x['cost']}文）" for x in route["shopping"])
    intro = [
        "# 雾津开放世界：照图走完当前25项",
        "",
        f"这是一条共 **{len(steps)} 步**的固定路线，覆盖当前已接入的 **{ledger['complexCount']} 个复杂事件＋{ledger['simpleCount']} 个短支线**。完成的是这25项开放世界内容，不是游戏主线结局。",
        "",
        "[打开交互图册](index.html) · [返回图册说明](README.md)",
        "",
        "从“开放雾津”的全新试玩开始：街头11:00、0文、空囊。第1步先歇到次日07:00；此后本路线在这一天18:00收尾。旧存档、额外消费或不同分支不能直接套用本账。",
        "",
        "每一步先看地图编号，再靠近目标确认屏幕上的 E 提示。人物会巡逻，编号标岗位附近；不要把另一个时段的同名人物当成当前在场。需要蹲取时，保持按住 C 再按 E；注视时保持按住 X 再按 E。I 开摸囊，Tab 开任务页，Esc 退界面。",
        "",
        "**本路线不点包子铺、不进赌坊，不顺手推进其他主线。** 饭用杨嫂饭包，糖画自己吃；不要把主线列表仍有任务当成这25项没清完。",
        "",
        f"按表操作总收入 **{ledger['coinsEarned']}文**、购物 **{ledger['coinsSpent']}文**、结余 **{ledger['coins']}文**。唯一购物清单：{shopping}。",
        "",
        "## 固定选择",
        "",
        "| 事件 | 本路线选法 |",
        "|---|---|",
    ]
    for qid, outcome in route["branchChoices"].items():
        intro.append(f"| {quest_names.get(qid, qid)} | {OUTCOMES.get(qid, {}).get(outcome, outcome)} |")
    intro += ["", "先还小钩即可问到小满的目击，因此糖画能留给自己吃出木签。已有一碗糨糊时不能再熬；第一碗用于纸人后，再熬第二碗挡庙门。不要选择借浆炉煮饭。", ""]
    book = intro
    covered = []
    for chapter in route["chapters"]:
        chapter_steps = [by_id[sid] for sid in chapter["stepIds"]]
        chapter_scenes = list(dict.fromkeys(s["sceneId"] for s in chapter_steps))
        book += [f"## {chapter['id']} · {chapter['title']}", "",
                 "本章地图：" + " · ".join(map_link(sid) for sid in chapter_scenes), ""]
        for step in chapter_steps:
            covered.append(step["id"])
            options = " → ".join(f"“{resolve(o['text'])}”" for o in step.get("options", []))
            if not options:
                options = "无额外对话选项；按上方按键、摸囊或小游戏操作。"
            operation = resolve(step["operation"])
            navigation = step.get("navigation", {}).get("instruction", "").strip()
            # Preserve every navigation instruction, avoiding a duplicate when already prefixed to operation.
            if navigation and operation.startswith(navigation):
                operation = operation[len(navigation):].strip()
            delta = step["delta"]
            gains = {k: v for k, v in delta.get("items", {}).items() if v > 0}
            spent = {k: -v for k, v in delta.get("items", {}).items() if v < 0}
            material = []
            if gains:
                material.append("得到 " + inventory_text(gains))
            if spent:
                material.append("用去／交出 " + inventory_text(spent))
            coin_delta = delta.get("coins", 0)
            coins = f"{'+' if coin_delta > 0 else ''}{coin_delta}文" if coin_delta else "不变"
            book += [f"### {step['id']} · {step['title']}", "",
                     f"**位置：**{scene_name(step['sceneId'])}｜{step_markers(step)}", ""]
            if navigation:
                book += [f"**怎么靠近：**{navigation}", ""]
            book += [operation, "", f"- **选项顺序：**{options}",
                     f"- **看到这些再继续：**{resolve(step['visibleCheck'])}",
                     f"- **钱、材料、时刻：**铜钱{coins}，现有 **{step['inventoryAfter']['coins']}文**；{'；'.join(material) or '材料不变'}；{clock_text(step['clock'])}。",
                     f"- **囊中核对：**{inventory_text(step['inventoryAfter']['items'])}。",
                     f"- **下一步与出口：**{next_text(step)}"]
            completed = step.get("completedQuestIds", [])
            if completed:
                names = "、".join(quest_names.get(q, q) for q in completed)
                book.append(f"- **本步记成：**{names}；累计 {step['completedCount']}/25 项。")
            for note in step.get("notes", []):
                note = (note.replace("routeDay=1", "路线当天").replace("state_2", "当前自由活动阶段")
                        .replace("主线_吃饭点A", "包子铺"))
                book.append(f"- **留意：**{note}")
            book.append("")
    if covered != [s["id"] for s in steps]:
        raise ValueError("Chapters do not cover the route exactly once in order")
    book += ["## 收尾核对", "",
             f"任务页应完成当前25项；余额 **{ledger['coins']}文**。最后留存：{inventory_text(ledger['items'])}。",
             "", "茶馆不在这条固定路线里，需要另查人物去处时可看 " + map_link("teahouse") + "。", "",
             "## 核对范围", "",
             "目前已核对原生任务、选项、材料账和日程，部分操作有之前的实机记录，也检查了关键接近路线。整条80步从新开局连续走到底仍未完成实机验收；这里是照做路线与检查表，不冒充完整通关录像。小游戏没发出预期物品时留在该步重试；余额或材料不符时先停下核对，别硬套后续步骤。", "",
             "<details>", "<summary>查看数据来源与重建方法</summary>", "",
             "步骤与账本来自 [route.json](route.json)，编号来自 [marker-index.json](marker-index.json)，名字取当前游戏物品和任务文案。背景是游戏实际引用的原画，编号是原生世界坐标；静态图不代表所有班次人物同时站在场上。", "",
             "```powershell", "python artifact/OpenWorld/WalkthroughAtlas/build_route_book.py", "```", "",
             "这条命令只重建本文与 README，不修改路线、游戏数据、图片或存档。", "", "</details>", ""]
    (HERE / "FOLLOW_ALONG.md").write_text("\n".join(book), encoding="utf-8")

    readme = ["# 雾津图册与逐步攻略", "",
              "[打开交互图册](index.html) · [开始80步照走攻略](FOLLOW_ALONG.md)", "",
              f"图册覆盖当前已接入的 **{ledger['complexCount']}个复杂事件＋{ledger['simpleCount']}个短支线，共25项**。按攻略固定选择走完这些事件，保留原主线；这不是主线结局攻略。地图编号、任务步骤和人物时段可以互相对照。", "",
              "## 在这台电脑打开", "",
              "资源已在本机时，不需要联网。先在仓库根目录运行：", "",
              "```powershell", "python -m http.server 5182 --bind 127.0.0.1", "```", "",
              "若 Windows 的 python 命令不可用，可用项目解释器替代：", "",
              "```powershell", ".tools/venv/Scripts/python.exe -m http.server 5182 --bind 127.0.0.1", "```", "",
              "然后打开 [本地图册](http://127.0.0.1:5182/artifact/OpenWorld/WalkthroughAtlas/index.html)。保留终端运行，结束时按 Ctrl+C。这个服务只打开图册；游戏仍由原来的游戏开发服运行。", "",
              "## 从哪里开始", "",
              "游戏使用“开放雾津”全新试玩入口：街头11:00、0文、空囊。攻略第一步歇到次日07:00，在这一天18:00收尾。地图中 NPC 标的是岗位与巡逻附近，必须结合时段找人；不要把各班次的人当成同时在场。", "",
              "不要点主线包子铺或进赌坊，不做额外购物，不丢弃或提前消耗路线材料。小游戏失败在原步骤重试，看到物品和完成提示再继续。", "",
              "## 地图索引", "", "| 场景 | 编号图 |", "|---|---|"]
    for sid in SCENES:
        readme.append(f"| {scene_name(sid)}{'（可选查阅）' if sid == 'teahouse' else ''} | {map_link(sid)} |")
    readme += ["", "## 本路线的选择与账", "",
               "拓工票按实结账；捞箱修岸；保留工衣归还；纸人重做；庙门挡风；街头修灶；修备用梆交丁四。小钩归还后问目击，糖画自己吃留签；告示请罗伯念；木签用来挑闩。", "",
               f"总收入 **{ledger['coinsEarned']}文**，购物 **{ledger['coinsSpent']}文**，最后 **{ledger['coins']}文**。只买：{shopping}。其他需要的东西从路线中的零活获得。", "",
               f"最后留下：{inventory_text(ledger['items'])}。背包最多占 {ledger['maxUsedInventorySlots']}/{ledger['inventorySlotLimit']} 格。", "",
               "## 已核对到哪里", "",
               "任务、选项、日程、材料与钱数已按当前游戏数据核对；有部分实机操作和关键接近路线记录。完整80步从新开局连续走通尚未验完，不能把材料账当作整段实机通关证明。静态图使用实际游戏背景与坐标，不重现运行时灯光或人物每一刻的位置。", "",
               "目前还不是最初要求的10个复杂事件＋20条短支线：尚缺3个复杂事件和2条短支线，新增内容以项目后续更新为准。", "",
               "<details>", "<summary>文件与更新方式</summary>", "",
               "- [交互图册](index.html)：按步骤查地图和编号。",
               "- [完整攻略](FOLLOW_ALONG.md)：逐步操作、精确选项、完成信号、钱物与时刻。",
               "- [路线与账本](route.json)、[编号表](marker-index.json)：当前攻略来源。",
               "- [重建脚本](build_route_book.py)：只重建两份说明；路线或编号更新后可再次运行。", "",
               "```powershell", "python artifact/OpenWorld/WalkthroughAtlas/build_route_book.py", "```", "",
               "地图图片由图册制图流程生成；本脚本不生成或修改图片。", "", "</details>", ""]
    (HERE / "README.md").write_text("\n".join(readme), encoding="utf-8")
    print(json.dumps({"steps": len(steps), "chapters": len(route["chapters"]),
                      "navigationInstructions": sum(bool(s.get("navigation", {}).get("instruction")) for s in steps),
                      "outputs": ["FOLLOW_ALONG.md", "README.md"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
