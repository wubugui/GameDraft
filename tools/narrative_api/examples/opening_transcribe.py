"""开局 → 去赌坊（composition_3）—— 现有编排的等价转写。

纪律：**一个字节的实质修改都没有**。`__draft__` 原样保留成 todo，
未命名的 state_1/state_2 照抄（不顺手改成可读 id），产出应与现在逐字节相同。
"""
from narrative import System, flow, hotspot, is_in, npc

sys = System.load(PROJECT)

comp = sys.composition("composition_3")     # 现状没有 label / description


# ── 主图：主线_交互点（现状是个未接线的壳）────────────────────
交互点 = comp.main("主线_交互点", label="主线_交互点", owner=flow(None))
起点  = 交互点.initial("initial")
下一拍 = 交互点.state("state_1")

起点.todo(to=下一拍, id="t_1")      # 现状 signal:"__draft__" ——形状已定、触发未定


# ── 藏钱点（宿主 hotspot；第二跳走私有信号）───────────────────
藏钱 = comp.machine("wrapper_graph_2", label="藏钱", owner=hotspot("主线s1藏钱点A"))
藏钱_初 = 藏钱.initial("initial")
藏钱_1  = 藏钱.state("state_1")
藏钱_2  = 藏钱.state("state_2")

藏钱_初.on("崖墓任务_发布完成", to=藏钱_1, id="t_1")
藏钱_1.on("私有事件完结",       to=藏钱_2, id="t_2")     # 全项目唯一一条私有信号


# ── 赌坊门卫（宿主 NPC）───────────────────────────────────────
#
# 这台机器要读**另一个 composition** 里的图：flow_xungou_main 的 state_4（去赌坊）。
# 现状那是 JSON 里两个裸字符串 {"narrative": "flow_xungou_main", "state": "state_4"}，
# 作者写错任何一个都要到运行时才发现（条件恒假，门卫永远不进主线剧情态）。
# 这里是一次编译期解析的引用——图不存在 / 状态不存在，build 直接失败。
主线   = sys.machine("flow_xungou_main")
去赌坊 = 主线.state("state_4")

赌坊 = comp.machine("街巷_赌坊", label="赌场交互点", owner=npc("街巷_赌坊门卫"))

# ⚠ 现状 states 的键序是 赌场正常状态 / 主线剧情状态 / 初始状态，而 initial 是「初始状态」。
#    为字节保真，声明序必须照抄键序，initial 单独指定。
赌场正常   = 赌坊.state("赌场正常状态", label="正常状态")
主线剧情中 = 赌坊.state(
    "主线剧情状态", label="主线剧情状态",
    description="主线，关二狗拿了钱最后去了赌场挥霍，引发接下来的剧情。",
)
初始 = 赌坊.state("初始状态", label="初始状态")
赌坊.initial = 初始

初始.when(is_in(去赌坊), to=主线剧情中, id="t_2")        # 现状 trigger:reactive + 条件
主线剧情中.on("主线_序章完结", to=赌场正常, id="t_1")


sys.save()
