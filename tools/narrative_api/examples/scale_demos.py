"""五个规模化场景的编排代码 —— 纯示意，不碰项目任何文件。

所有 id、数量、字段名都取自现有数据（2026-08-13 实测）：
  29 场景 / 111 NPC / 117 热点（inspect 73、transition 40、pickup 1）/ 44 zone
  56 台叙事机器，其中绑 NPC 的 6 台、绑热点的 5 台
  rules.json：8 条规矩，层 ∈ {xiang 象, li 理, shu 术}，verified ∈ {unverified, effective, questionable}
"""
from narrative import System, action, cond, entered, hotspot, is_in, npc, signal

sys = System.load(PROJECT)
world = sys.world          # 只读世界数据面（见 S0）


# ════════════════════════════════════════════════════════════════════
# S0  世界查询 API —— 规模化编排的前提
#     不加任何字段。实体已有唯一 id，缺的只是「能问」。
# ════════════════════════════════════════════════════════════════════
#
# 地址是 (场景, id)，不是裸 id：
#   实测跨场景重名 —— NPC 90 个 id 里 16 个重名（new_npc_0 / fx_steam_1..3）、
#   热点 8 个（exit_to_street 这种语义上就该同名的）、zone 3 个。
#   而现有数据里 zone 引用本来就写成场景限定：`码头白天:new_zone_2`。
#   ⇒ 单 id 能唯一定位时可省场景；**歧义时 fail loud，不许挑一个**
#     （同 getPrimaryGraphByOwner 多台时返回 undefined 的口径）。
#
#   world.scenes                          → 29
#   world.npcs                            → 111（跨场景）
#   world.npcs(scene="雾津街头")            → 32
#   world.hotspots(type="inspect")        → 73
#   world.zones / world.items / world.quests / world.dialogues
#   world.rules / world.fragments
#   world.entity("码头白天:new_zone_2")     → 场景限定寻址
#   world.entity("npc_婆子")               → 唯一则返回，重名则报错
#
# 实现上是 ProjectModel 数据面的**只读外观**——它本来就把这些全载进来了。


# ════════════════════════════════════════════════════════════════════
# S1  背尸经过时，世界有反应
#     现状：背尸位面配好了（拖拽/掉体力/不能跑/不能捡），但没有任何 NPC 对此有反应
# ════════════════════════════════════════════════════════════════════

# 分类表写在这里，不是因为"NPC 上缺字段"——是因为
# **分类属于规则，不属于实体**：
#   同一个 NPC 对「背尸围观」是摊贩，对「赌债追讨」可能是债主。
#   给 NPC 挂一个全局 tags 字段 = 强迫全世界共用一套分类法；
#   写在规则旁边则允许多套并存，而且改分类时改动范围就是这条规则。
# 实体 id 唯一且稳定，直接列就是最诚实的写法。

身份表 = {
    "摊贩":  ["npc_零工工头", "npc_茶馆小二", "npc_面摊老板", ...],
    "袍哥":  ["npc_袍哥", "npc_赌坊门卫", ...],
    "官差":  ["npc_码头官差", ...],
    "闲人":  [...],                      # 其余
}

# 每一档身份看见背尸的反应不同——这是唯一需要人来拿主意的地方
背尸反应 = {
    "摊贩": [action("npcReactAvoid", distance=2.0), action("playSfx", id="sfx_退避")],
    "袍哥": [action("emitNarrativeSignal", signal="袍哥_记了一笔")],
    "官差": [action("startDialogueGraph", id="官差_盘问背尸")],
    "闲人": [action("showSpeechBubble", key="bubble_围观背尸")],
}

comp = sys.composition("gen_背尸围观", label="[生成] 背尸经过的人群反应")

with sys.provenance("S1/背尸围观 v1"):          # 产物打戳：可看不可改
    for 身份, npc_ids in 身份表.items():
        for nid in npc_ids:
            m = comp.machine(f"见背尸_{nid}", owner=npc(nid), category="背尸围观")
            没见过 = m.initial("unseen", label="没见过")
            见过   = m.state("seen", label="见过背尸", on_enter=背尸反应[身份])

            # 触发条件：玩家在背尸位面 且 这个 NPC 在场可见
            没见过.when(cond.plane("背尸") & cond.npc_visible(nid), to=见过)

# 产出：约 60 台机器 / 60 条转移 / 4 种反应
# GUI 那边：60 张画布，每张手连一条 reactive 转移 + 手填动作
# 改一档反应：这边改 1 行，那边改 15 张画布


# ════════════════════════════════════════════════════════════════════
# S2  inspect 热点量产（"看一眼就记住"）
#     现状：117 个热点里 73 个是 inspect，只有 5 个在叙事里存在
# ════════════════════════════════════════════════════════════════════

看过了 = signal("看过了", private=True)          # 一条信号服务全部——私有信号按发射方定向

comp2 = sys.composition("gen_看过没看过", label="[生成] inspect 热点的一次性记忆")

def 一次性(宿主, 机器id):
    """16 台同构机器的那个形状（T3 实测：56 台里 16 台长这样）。"""
    m = comp2.machine(机器id, owner=宿主, category="一次性事件")
    未看 = m.initial("unseen", label="没看过")
    已看 = m.state("seen", label="看过了")
    未看.on(看过了, to=已看)
    return m

with sys.provenance("S2/一次性事件 v1"):
    for h in world.hotspots(type="inspect"):        # 实测 73 个
        一次性(hotspot(h.ref), f"看过_{h.ref}")      # h.ref = "场景:id"，见 S0

# 产出：73 台机器。GUI 那边：73 张画布。
# 而且这 73 台的**信号只有一条**，不是 73 条——命名面不随实体数膨胀。


# ════════════════════════════════════════════════════════════════════
# S3  规矩的知识网（象理术）
#     现状：8 条规矩 × 层 ∈ {xiang, li, shu}，共 11 个 (规矩,层) 对；5 条 fragment 教它们
# ════════════════════════════════════════════════════════════════════

comp3 = sys.composition("gen_规矩知识", label="[生成] 规矩三层的掌握进度")

with sys.provenance("S3/规矩知识网 v1"):
    知识 = {}
    for r in world.rules:                              # 直接读 rules.json，不复制一份
        for layer in r.layers:                         # xiang / li / shu
            m = comp3.machine(f"知_{r.id}_{layer}", category=f"规矩·{r.category}")
            没听过 = m.initial("unknown",      label="没听过")
            听说过 = m.state("unverified",     label="听说过（未验证）")
            立住了 = m.state("effective",      label="立住了（有效）")
            存疑   = m.state("questionable",   label="存疑")

            # 每条 fragment 是一个教学来源；fragment 自己发信号，这里只监听
            for frag in world.fragments_for(r.id, layer):
                没听过.on(f"学到_{frag.id}", to=听说过)

            听说过.on(f"验证_{r.id}_{layer}", to=立住了)
            听说过.on(f"证伪_{r.id}_{layer}", to=存疑)
            知识[(r.id, layer)] = m

    # 组合门：知道哪几条才推得出新的一条 —— 这是一张表，不是一堆手连的边
    推论表 = [
        ("rule_ghost_verified", [("rule_no_go_night", "xiang"), ("rule_ghost_origin", "xiang")]),
        ("rule_zhenshi_sizhang", [("rule_drowned_corpse", "xiang"), ("rule_zombie_fire", "xiang")]),
    ]
    for 结论id, 前提 in 推论表:
        m = 知识[(结论id, "xiang")]
        前提成立 = cond.all(is_in(知识[k].state("effective")) for k in 前提)
        m.state("unknown").when(前提成立, to=m.state("unverified"))

# 产出：11 台机器（规矩涨到 40 条时是 ~60 台）+ 2 条组合门
# 关键不是台数，是**推论表就是源**：表改了重 build，不会出现"表和图对不上"


# ════════════════════════════════════════════════════════════════════
# S4  横切规则 —— 这一个 GUI 结构上装不下
#     "在任何场景，玩家在人前动手 ⇒ 周围袍哥记一笔、摊贩态度降一档"
# ════════════════════════════════════════════════════════════════════

comp4 = sys.composition("gen_人前动手", label="[生成] 横切规则·人前动手")

人前动手 = signal("玩家在人前动手")

def 横切规则(规则名, 触发信号, 适用于, 反应, 半径=3.0):
    """一条规则 × 一个实体集合 ⇒ N 条边，但源头只有这一处。"""
    with sys.provenance(f"S4/{规则名} v1"):
        for nid in 适用于:
            m = comp4.machine(f"{规则名}_{nid}", owner=npc(nid), category="横切规则")
            平静 = m.initial("calm", label="没事")
            记住 = m.state("reacted", label="有反应", on_enter=反应(nid))
            平静.on(触发信号, to=记住, guard=cond.near(nid, 半径))

横切规则(
    "人前动手", 人前动手,
    适用于=身份表["袍哥"] + 身份表["摊贩"],
    反应=lambda nid: [action("emitNarrativeSignal", signal=f"目击_{nid}")],
)

# —— 这一段的要害不在行数，在**它是一条规则**：
#    GUI 那边只能把它拆散塞进每一张相关的图里，拆完之后
#      · 它不再是一条规则，是散落 N 处的 N 条边
#      · 改一次要改 N 处
#      · 没有任何地方记着这 N 条本是一条 —— 半年后自己都认不出
#      · 漏改一处 = 某个街区不生效，且不报错
#    这边：改一次 = 改这一处；provenance 戳记着这 N 条来自哪条规则。


# ════════════════════════════════════════════════════════════════════
# S5  章节收尾断言 —— 不产内容，只做检查
# ════════════════════════════════════════════════════════════════════

def 章节体检(章节):
    图 = sys.machines(package=章节)

    # ① 可重复的活计必须有失败出口，不能只有"干成了"
    for m in 图:
        if m.repeatable:
            assert len(m.dones) >= 2, f"{m.id} 只有一种结局，玩家半路撂挑子无处可去"

    # ② 待接线必须清零才能发版
    未接 = [(m.id, t.id) for m in 图 for t in m.transitions if t.is_todo]
    assert not 未接, f"还有 {len(未接)} 条待接线：{未接[:5]}"

    # ③ 每一拍都得进得去（现状 quest_return_ring.completed 就进不去）
    for m in 图:
        孤儿 = [s for s in m.states if s is not m.initial_state and not m.edges_into(s)]
        assert not 孤儿, f"{m.id} 有进不去的拍：{[s.id for s in 孤儿]}"

    # ④ 发了没人听的信号（现状 scenario_听书:kicked_out 就是）
    for m in 图:
        for s in m.states:
            if s.is_observed and not sys.observers_of(s):
                print(f"⚠ {m.id}.{s.id} 广播了但没人听")

# 这四条在 GUI 那边，每一条都得做成一个专门功能（narrative_xref 就是这么来的）
