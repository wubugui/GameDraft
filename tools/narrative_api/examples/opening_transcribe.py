"""开局 → 去赌坊（composition_3）—— 现有编排的等价转写。

纪律：**一个字节的实质修改都没有**。`__draft__` 原样保留成 todo，
未命名的 state_1/state_2 照抄（不顺手改成可读 id），产出应与现在逐字节相同。

这个文件最值得看的是最后一段：**跨 composition 引用**。
"""
from narrative import System, is_in
from generated import world as W

sys = System.load(PROJECT)

comp = sys.composition("composition_3")     # 现状没有 label / description


# ── 主图：主线_交互点（现状是个未接线的壳）────────────────────
交互点 = comp.main("主线_交互点", label="主线_交互点", owner=None)   # 现状 ownerId 为空
起点   = 交互点.initial("initial")
下一拍 = 交互点.state("state_1")

起点.todo(to=下一拍, id="t_1")      # 现状 signal:"__draft__" ——形状已定、触发未定


# ── 藏钱点（宿主 hotspot，在雾津街头）─────────────────────────
藏钱 = comp.machine("wrapper_graph_2", label="藏钱", owner=W.雾津街头.主线s1藏钱点A)
藏钱_初 = 藏钱.initial("initial")
藏钱_1  = 藏钱.state("state_1")
藏钱_2  = 藏钱.state("state_2")

藏钱_初.on(W.信号.崖墓任务_发布完成, to=藏钱_1, id="t_1")
藏钱_1.on(W.信号.私有事件完结,       to=藏钱_2, id="t_2")   # 全项目唯一一条私有信号


# ── 赌坊门卫（宿主 NPC，在雾津街头）───────────────────────────
#
# ★ 这台机器要读**另一个 composition** 里的图：flow_xungou_main 的 state_4（去赌坊）。
#
#   现状那是 JSON 里两个裸字符串 {"narrative": "flow_xungou_main", "state": "state_4"}，
#   写错任何一个都要到运行时才发现——条件恒假，门卫永远不进主线剧情态，而且不报错。
#
#   这里 W.图.flow_xungou_main.state_4 是**一个符号**：图不存在 / 那一拍不存在，
#   编辑时 IDE 就红线，build 直接失败。手写的图和生成的图靠符号表接上，谁也不用改谁。
去赌坊 = W.图.flow_xungou_main.state_4

赌坊 = comp.machine("街巷_赌坊", label="赌场交互点", owner=W.雾津街头.街巷_赌坊门卫)

# ⚠ 现状 states 的键序是 赌场正常状态 / 主线剧情状态 / 初始状态，而 initial 是「初始状态」。
#    为字节保真，声明序必须照抄键序，initial 单独指定。
赌场正常   = 赌坊.state("赌场正常状态", label="正常状态")
主线剧情中 = 赌坊.state(
    "主线剧情状态", label="主线剧情状态",
    description="主线，关二狗拿了钱最后去了赌场挥霍，引发接下来的剧情。",
)
初始 = 赌坊.state("初始状态", label="初始状态")
赌坊.initial = 初始

初始.when(is_in(去赌坊), to=主线剧情中, id="t_2")             # 现状 trigger:reactive + 条件
主线剧情中.on(W.信号.主线_序章完结, to=赌场正常, id="t_1")


sys.save()
