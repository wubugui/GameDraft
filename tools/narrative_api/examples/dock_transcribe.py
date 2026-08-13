"""码头水鬼 / 水猴子到铁环流程 —— 现有编排的等价转写。

纪律：**一个字节的实质修改都没有**。现状的毛病（不可达的 completed、
显式的 broadcastOnEnter:false）原样保留，转移 id 照抄，产出的 JSON 应与现在逐字节相同。
"""
from narrative import System, action, entered, flow, npc, quest, scenario

sys = System.load(PROJECT)

comp = sys.composition(
    "dock_water_monkey_ring_flow",
    label="码头水鬼 / 水猴子到铁环流程",
    description="码头看板、水边触发、捞箱、滚铁环小孩与归还铁环任务的叙事编排画布。",
)

# ── 外部内容（黑盒元素）：声明存在与类型，内容不归这里
comp.extern("dialogue_dock_board", kind="dialogue", label="码头看板",     ref="码头看板")
comp.extern("zone_waterside",      kind="zone",     label="水边触发区",   ref="码头白天:new_zone_2")
comp.extern("minigame_crate",      kind="minigame", label="捞箱小游戏",   ref="dock_crate_tutorial")
comp.extern("dialogue_ringboy",    kind="dialogue", label="滚铁环小孩对话", ref="滚铁环小孩")


# ── 主图：水鬼线 ───────────────────────────────────────────────
水鬼线 = comp.main("flow_dock_water_monkey", label="小孩滚铁环", owner=flow("码头水鬼"))

未开始     = 水鬼线.initial("initial", label="未开始", broadcast=False)   # 现状写死了 false，照抄
看板初读   = 水鬼线.state("board_read",           label="看板初读")
水边可触发 = 水鬼线.state("waterside_available",  label="水边可触发")
箱子捞起   = 水鬼线.state("crate_minigame_done",  label="箱子捞起")

未开始.on("board_read_done",   to=看板初读,   id="t_board_read")
看板初读.on("entered",         to=水边可触发, id="t_waterside_available")
水边可触发.on("pull_success",  to=箱子捞起,   id="t_crate_done")


# ── 滚铁环小孩（宿主 NPC）─────────────────────────────────────
铁环小孩 = comp.machine("npc_ringboy", owner=npc("npc_ringboy"), category="水猴子事件状态")

事件前   = 铁环小孩.initial("before_event", label="事件前")
事件后   = 铁环小孩.state("after_event", label="水猴子事件后", on_enter=[
    action("persistNpcAnimState",     target="npc_ringboy", state="boy_stand_ring"),
    action("persistNpcDisablePatrol", npcId="npc_ringboy"),
])
铁环已取 = 铁环小孩.state("ring_taken",    label="玩家已拿到铁环")
铁环已还 = 铁环小孩.state("ring_returned", label="铁环已归还")

# entered(X) = 观察 X 的进入边。编译器负责两件事：
#   ① 本条转移的 signal 写成 state:flow_dock_water_monkey:crate_minigame_done
#   ② 给 箱子捞起 打上 broadcastOnEnter: true
# 现状这两处是分开手写的两个字符串，对不上不会报错。
事件前.on(entered(箱子捞起),  to=事件后,   id="t_ringboy_after_event")
事件后.on("ring_taken",       to=铁环已取, id="t_ring_taken")
铁环已取.on("ring_returned",  to=铁环已还, id="t_ring_returned")


# ── 归还铁环任务（宿主 quest）─────────────────────────────────
归还铁环 = comp.machine(
    "quest_return_ring",
    owner=quest("支线-归还小孩铁环-归还铁环"),
    category="归还铁环任务",
)

未激活 = 归还铁环.initial("inactive", label="未激活")
已激活 = 归还铁环.state("active", label="已激活", on_enter=[
    action("updateQuest", id="支线-归还小孩铁环-归还铁环"),
])
已完成 = 归还铁环.state("completed", label="已完成")
# ⚠ 现状：没有任何转移进得去 completed。照抄不修——lint 会把它报成「不可达状态」。

未激活.on(entered(铁环已取), to=已激活, id="t_activate_return_ring")


# ── 官差套近乎：纯环（可被骂重置，不计数）─────────────────────
套近乎 = comp.machine(
    "scenario_码头官差套近乎", label="码头·官差套近乎（可被骂重置）",
    owner=scenario("码头_官差套近乎"), entry="pending", exits=["done"],
)
还没套上 = 套近乎.initial("pending", label="还没套上近乎")
已套上   = 套近乎.state("done",      label="已套上近乎")

还没套上.on("dock_guanchai_rapport_done",  to=已套上,   id="t_done")
已套上.on("dock_guanchai_rapport_reset",   to=还没套上, id="t_reset")


# ── 水鬼真相 ──────────────────────────────────────────────────
水鬼真相 = comp.machine(
    "scenario_码头真相", label="码头·水鬼真相揭示",
    owner=scenario("码头_真相揭示"), entry="hidden", exits=["revealed", "revealed_jiaobang"],
)
真相未揭 = 水鬼真相.initial("hidden", label="真相未揭")
真相已揭 = 水鬼真相.state("revealed", label="真相已揭示（任一线）", on_enter=[
    action("setFlag", key="码头水鬼真相已揭示", value=True),
])
脚帮也揭 = 水鬼真相.state("revealed_jiaobang", label="脚帮线也揭示过")

真相未揭.on("dock_truth_revealed",  to=真相已揭, id="t_reveal")
真相已揭.on("dock_truth_jiaobang",  to=脚帮也揭, id="t_jiaobang")


# ── 外国人捞箱子（线激活）─────────────────────────────────────
外国人线 = comp.machine(
    "scenario_外国人捞箱子", label="码头·外国人捞箱子（线激活）",
    owner=scenario("码头_外国人捞箱子"), entry="inactive", exits=["active"],
)
线未激活 = 外国人线.initial("inactive", label="未激活")
线已激活 = 外国人线.state("active",     label="围观线激活")

线未激活.on("dock_foreigner_line_active", to=线已激活, id="t_activate")


sys.save()
