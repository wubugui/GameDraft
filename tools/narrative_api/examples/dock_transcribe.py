"""码头水鬼 / 水猴子到铁环流程 —— 现有编排的等价转写。

纪律：**一个字节的实质修改都没有**。现状的毛病（不可达的 completed、
显式的 broadcastOnEnter:false）原样保留，转移 id 照抄，产出的 JSON 应与现在逐字节相同。

引用世界一律走**生成的符号**（`W.*`），不写字符串：拼错是 AttributeError，
传错类型（把 NPC 当热点）是类型错误。符号表由 build 前扫 public/assets/** 生成。
"""
from narrative import System, action, entered
from generated import world as W          # ← 由数据生成，入库，不手改

sys = System.load(PROJECT)

comp = sys.composition(
    "dock_water_monkey_ring_flow",
    label="码头水鬼 / 水猴子到铁环流程",
    description="码头看板、水边触发、捞箱、滚铁环小孩与归还铁环任务的叙事编排画布。",
)

# ── 外部内容（黑盒元素）：声明存在与类型，内容不归这里
#    ref 是**引用**，所以走符号；元素 id（dialogue_dock_board 等）是本图内的**定义**，字符串。
comp.extern("dialogue_dock_board", label="码头看板",     ref=W.对话.码头看板)
comp.extern("zone_waterside",      label="水边触发区",   ref=W.码头白天.new_zone_2)
comp.extern("minigame_crate",      label="捞箱小游戏",   ref=W.小游戏.dock_crate_tutorial)
comp.extern("dialogue_ringboy",    label="滚铁环小孩对话", ref=W.对话.滚铁环小孩)
# kind 不用写了：符号自带类型，DialogueRef / ZoneRef / MinigameRef 各是各


# ── 主图：水鬼线 ───────────────────────────────────────────────
水鬼线 = comp.main("flow_dock_water_monkey", label="小孩滚铁环", owner=W.流程.码头水鬼)

未开始     = 水鬼线.initial("initial", label="未开始", broadcast=False)   # 现状写死 false，照抄
看板初读   = 水鬼线.state("board_read",           label="看板初读")
水边可触发 = 水鬼线.state("waterside_available",  label="水边可触发")
箱子捞起   = 水鬼线.state("crate_minigame_done",  label="箱子捞起")

未开始.on(W.信号.board_read_done,   to=看板初读,   id="t_board_read")
看板初读.on(W.信号.entered,         to=水边可触发, id="t_waterside_available")
水边可触发.on(W.信号.pull_success,  to=箱子捞起,   id="t_crate_done")


# ── 滚铁环小孩（宿主 NPC，实际在 test_room_a）────────────────
铁环小孩 = comp.machine("npc_ringboy", owner=W.test_room_a.npc_ringboy, category="水猴子事件状态")

事件前   = 铁环小孩.initial("before_event", label="事件前")
事件后   = 铁环小孩.state("after_event", label="水猴子事件后", on_enter=[
    # 动作载荷对叙事是不透明的，但**载荷里的世界引用照样走符号**——
    # 这是符号面与不透明面的交界，能类型化的部分不放过。
    action("persistNpcAnimState",     target=W.test_room_a.npc_ringboy, state="boy_stand_ring"),
    action("persistNpcDisablePatrol", npcId=W.test_room_a.npc_ringboy),
])
铁环已取 = 铁环小孩.state("ring_taken",    label="玩家已拿到铁环")
铁环已还 = 铁环小孩.state("ring_returned", label="铁环已归还")

# entered(X) = 观察 X 的进入边。编译器负责两件事：
#   ① 本条转移的 signal 写成 state:flow_dock_water_monkey:crate_minigame_done
#   ② 给 箱子捞起 打上 broadcastOnEnter: true
# 现状这两处是分开手写的两个字符串，对不上不会报错。
事件前.on(entered(箱子捞起),      to=事件后,   id="t_ringboy_after_event")
事件后.on(W.信号.ring_taken,      to=铁环已取, id="t_ring_taken")
铁环已取.on(W.信号.ring_returned, to=铁环已还, id="t_ring_returned")


# ── 归还铁环任务（宿主 quest）─────────────────────────────────
#
# ⚠ 这个任务 id 是「支线-归还小孩铁环-归还铁环」，带连字符，**不是合法 Python 标识符**。
#    生成器的规矩：按一条**单射**规则清洗（- → _），两个 id 洗成同一个符号就**生成失败**，
#    绝不静默合并。符号对象里保留原始 id，落盘写的还是原文。
归还铁环 = comp.machine(
    "quest_return_ring",
    owner=W.任务.支线_归还小孩铁环_归还铁环,
    category="归还铁环任务",
)

未激活 = 归还铁环.initial("inactive", label="未激活")
已激活 = 归还铁环.state("active", label="已激活", on_enter=[
    action("updateQuest", id=W.任务.支线_归还小孩铁环_归还铁环),
])
已完成 = 归还铁环.state("completed", label="已完成")
# ⚠ 现状：没有任何转移进得去 completed。照抄不修——lint 会把它报成「不可达状态」。

未激活.on(entered(铁环已取), to=已激活, id="t_activate_return_ring")


# ── 官差套近乎：纯环（可被骂重置，不计数）─────────────────────
套近乎 = comp.machine(
    "scenario_码头官差套近乎", label="码头·官差套近乎（可被骂重置）",
    owner=W.桥段.码头_官差套近乎, entry="pending", exits=["done"],
)
还没套上 = 套近乎.initial("pending", label="还没套上近乎")
已套上   = 套近乎.state("done",      label="已套上近乎")

还没套上.on(W.信号.dock_guanchai_rapport_done,  to=已套上,   id="t_done")
已套上.on(W.信号.dock_guanchai_rapport_reset,   to=还没套上, id="t_reset")


# ── 水鬼真相 ──────────────────────────────────────────────────
水鬼真相 = comp.machine(
    "scenario_码头真相", label="码头·水鬼真相揭示",
    owner=W.桥段.码头_真相揭示, entry="hidden", exits=["revealed", "revealed_jiaobang"],
)
真相未揭 = 水鬼真相.initial("hidden", label="真相未揭")
真相已揭 = 水鬼真相.state("revealed", label="真相已揭示（任一线）", on_enter=[
    action("setFlag", key=W.旗.码头水鬼真相已揭示, value=True),   # flag 也在符号表里
])
脚帮也揭 = 水鬼真相.state("revealed_jiaobang", label="脚帮线也揭示过")

真相未揭.on(W.信号.dock_truth_revealed,  to=真相已揭, id="t_reveal")
真相已揭.on(W.信号.dock_truth_jiaobang,  to=脚帮也揭, id="t_jiaobang")


# ── 外国人捞箱子（线激活）─────────────────────────────────────
外国人线 = comp.machine(
    "scenario_外国人捞箱子", label="码头·外国人捞箱子（线激活）",
    owner=W.桥段.码头_外国人捞箱子, entry="inactive", exits=["active"],
)
线未激活 = 外国人线.initial("inactive", label="未激活")
线已激活 = 外国人线.state("active",     label="围观线激活")

线未激活.on(W.信号.dock_foreigner_line_active, to=线已激活, id="t_activate")


sys.save()
