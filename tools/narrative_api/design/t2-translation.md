# T2 真实内容书写：拿 v16 写两段

规矩：写不出的地方回 §1/§2 找语义漏洞，**不加语法糖拟合**。
两段都先从 `narrative_graphs.json` 读出真实因果链，再翻译。

---

## 一、开局 → 被赶出茶馆 → 去赌坊

### 数据里的真实链条

```
flow_xungou_main
  state_1(未开始) --[reactive, flag GameConfig_Demo主线剧情==true]--> initial(开局·听书斗嘴)
  initial         --[signal 主线_开局被赶出茶馆]--> state_2(主线开局闲逛A)
  state_2         --[reactive, wrapper_主线_崖墓任务发布.state_2]--> state_3(主线开局闲逛B)
  state_3         --[signal __draft__]--> state_4(去赌坊)        ← 未接线
  state_4         --[signal __draft__]--> s02_beishi             ← 未接线

scenario_听书          listening --[tingshu_kicked]--> kicked_out(broadcast, exit)
wrapper_主线_崖墓任务发布  initial --[主线_第一阶段闲逛完成]--> state_1 --[崖墓任务_发布完成]--> state_2(离开)
wrapper_graph_2(hotspot 主线s1藏钱点A)
                      initial --[崖墓任务_发布完成]--> state_1 --[私有 私有事件完结]--> state_2
街巷_赌坊(npc 赌坊门卫)  初始状态 --[reactive, flow_xungou_main.state_4]--> 主线剧情状态
                      主线剧情状态 --[主线_序章完结]--> 赌场正常状态
```

### v16 写法

```
module 寻狗主线

signal Demo主线开始
signal 听书被赶
signal 第一阶段闲逛完成
signal 崖墓任务发布完成
signal 序章完结
signal 藏钱点事毕 private

extern dialogue 寻狗_听书开场
extern dialogue 寻狗_说书人

// ── 听书这一拍
machine 听书 {
  initial 听书中
  state 听书中     { on 听书被赶 -> 被赶出门 }
  state 被赶出门   {}
}

// ── 崖墓任务发布者（宿主：NPC）
machine 任务发布 {
  initial 未开始
  state 未开始     { on 第一阶段闲逛完成 -> 准备发布 }
  state 准备发布   { on 崖墓任务发布完成 -> 离开 }
  state 离开       {}
}
任务发布 bind npc(崖墓任务发布者).发布进度

// ── 藏钱点（宿主：热点；私有信号定向）
machine 藏钱点 {
  initial 未启用
  state 未启用   { on 崖墓任务发布完成 -> 可用 }
  state 可用     { on 藏钱点事毕 -> 用过了 }
  state 用过了   {}
}
藏钱点 bind hotspot(主线s1藏钱点A).取用

// ── 赌坊门卫（宿主：NPC；读主线的面）
machine 赌坊门卫 {
  initial 初始
  state 初始       { when 主线.去赌坊 -> 主线剧情中 }
  state 主线剧情中 { on 序章完结 -> 赌场正常 }
  state 赌场正常   {}
}
赌坊门卫 bind npc(街巷_赌坊门卫).态度

// ── 主线
machine 主线 {
  initial 未开始
  state 未开始   { on Demo主线开始 -> 开局听书 }
  state 开局听书 { on 听书:被赶出门 -> 闲逛A }          // 观察边，编译器打广播标
  state 闲逛A    { when 任务发布.离开 -> 闲逛B }         // 观察面
  state 闲逛B    { todo -> 去赌坊 }                     // 待接线（见发现 D）
  state 去赌坊   { todo -> 背崖墓尸完成 }
  state 背崖墓尸完成 {}
}

on 听书:被赶出门 -> effects(茶馆收摊)
```

**14 条转移里，这一段用到的连接形式：**
`on 信号` ×5 · `on M:S` 观察边 ×1 · `when M.S` 观察面 ×2 · 私有信号 ×1 · `todo` ×2

---

## 二、码头：水鬼告示板 + 外国人捞箱子

### 数据里的真实链条

```
flow_dock_water_monkey(flow 码头水鬼)
  initial --[board_read_done]--> board_read --[entered]--> waterside_available
          --[pull_success]--> crate_minigame_done(broadcast)

npc_ringboy(npc 滚铁环小孩)
  before_event --[state:flow_dock_water_monkey:crate_minigame_done]--> after_event
                 (onEnter: persistNpcAnimState, persistNpcDisablePatrol)
  after_event --[ring_taken]--> ring_taken(broadcast) --[ring_returned]--> ring_returned

quest_return_ring(quest 归还铁环)
  inactive --[state:npc_ringboy:ring_taken]--> active (onEnter: updateQuest)
  completed ← 没有任何转移进得去（见发现 B）

scenario_码头官差套近乎  pending --[rapport_done]--> done --[rapport_reset]--> pending   ← 纯环
scenario_码头真相        hidden --[truth_revealed]--> revealed(onEnter setFlag)
                                --[truth_jiaobang]--> revealed_jiaobang
scenario_外国人捞箱子     inactive --[foreigner_line_active]--> active
```

### v16 写法

```
module 码头水鬼

signal 看板读完
signal 进了水边
signal 捞起来了
signal 拿了铁环
signal 还了铁环
signal 套上近乎
signal 被骂了
signal 真相揭开
signal 说出叫帮
signal 外国人线激活

extern dialogue 码头看板
extern zone     码头水边
extern minigame 捞箱教学
extern dialogue 滚铁环小孩

// ── 水鬼主线
machine 水鬼线 {
  initial 未开始
  state 未开始   { on 看板读完 -> 读过看板 }
  state 读过看板 { on 进了水边 -> 水边可触发 }
  state 水边可触发 { on 捞起来了 -> 箱子捞起 }
  state 箱子捞起 {}                                  // 源方不声明，被观察即可
}

// ── 滚铁环小孩（宿主：NPC）
machine 铁环小孩 {
  initial 事件前
  state 事件前   { on 水鬼线:箱子捞起 -> 事件后 }      // 观察边
  state 事件后   { on 拿了铁环 -> 铁环已取 }
  state 铁环已取 { on 还了铁环 -> 铁环已还 }
  state 铁环已还 {}
}
铁环小孩 bind npc(滚铁环小孩).事件进度

on 铁环小孩:事件后 -> effects(小孩定住_停巡逻)

// ── 归还铁环这条支线（宿主：任务）
machine 归还铁环 {
  initial 未激活
  state 未激活 { on 铁环小孩:铁环已取 -> 已激活 }
  state 已激活 { on 铁环小孩:铁环已还 -> 已完成 }      // ← 数据里这条不存在
  state 已完成 {}
}
归还铁环 bind quest(支线_归还小孩铁环).进度

on 归还铁环:已激活 -> effects(任务面板_更新)

// ── 官差套近乎：会被打回的一拍（纯环，不计数）
machine 官差套近乎 {
  initial 还没套上
  state 还没套上 { on 套上近乎 -> 套上了 }
  state 套上了   { on 被骂了 -> 还没套上 }             // 回起点，计数不变（§2.2）
}
官差套近乎 bind npc(码头官差).交情

// ── 水鬼真相
machine 水鬼真相 {
  initial 未揭开
  state 未揭开   { on 真相揭开 -> 已揭开 }
  state 已揭开   { on 说出叫帮 -> 认出叫帮 }
  state 认出叫帮 {}
}
on 水鬼真相:已揭开 -> effects(真相揭示_落档)

// ── 外国人捞箱子这条线
machine 外国人线 {
  initial 未激活
  state 未激活 { on 外国人线激活 -> 已激活 }
  state 已激活 {}
}
```

---

## 三、发现

### A ✅ 语言结构性防住了数据里的一个真 bug

`scenario_听书.kicked_out` 标了 `broadcastOnEnter`，会发 `state:scenario_听书:kicked_out`——
**全项目没有任何转移监听它**（主线走的是另一条手写信号 `主线_开局被赶出茶馆`）。
运行时会报 `signal.unlistened` 悬垂告警。

**同一拍有两个名字**：一个是场景出口的自动广播，一个是作者另起的手写信号。

v16 里这不可能发生：连接**就是**观察（`on 听书:被赶出门`），广播那一半由编译器打标，
**根本没有第二个名字可发明**（§6 对照表第二行）。

### B ⚠ 不可达状态，语言不防

`quest_return_ring.completed` 没有任何转移进得去。我在译文里补了
`on 铁环小孩:铁环已还 -> 已完成`——**那是我替作者补的，数据里没有**。

v16 拦不住这个。**这归形式语义 + 静态分析（§5 悬案）**，不是构造缺失。
记一笔：静态分析清单里"不可达状态"要有。

### C ⚠ flag 条件叶：需要你拍板

主线的**入口**是这条：

```
state_1 --[reactive, {"flag": "GameConfig_Demo主线剧情", "value": true}]--> initial
```

但注意：**这条转移的 `signal` 字段作者写的是 `Demo主线开始`**（trigger=reactive 时被忽略）。
**作者本意就是"一个事件"，实现成了"轮询一个 flag"。**

而且全项目叙事转移里 **flag 条件叶只出现这一次**，读的还是个配置开关（不是玩法状态）。

⇒ 按 v16 §1.1 封闭性写成 `on Demo主线开始 -> 开局听书`，由配置那边在开机时发信号。
**这段上 §4.9（没有外部状态读取）站得住。**

**但你早先说过"flag 还是要包含进来，因为 flag 是更底层的状态表达"。**
现在证据是：叙事**转移**只读了一次 flag，且那次该是信号；flag 被大量读的地方是**对话与其它系统**的条件，
不是叙事机器。所以有个决定要下：

- **甲**：flag 留在叙事系统外，叙事不读 flag（现 v16 立场，本段成立）
- **乙**：flag 是叙事记忆的第二种形态（非结构化、命令式写），语言要为它开口

我倾向甲，因为乙会破 §1.4「只有当前态可写」——`setFlag` 是命令式写记忆。
但这条你说过话，我不替你改。

### D ⚠⚠ 真缺口候选：**"这里待接线"没法表达**

数据里三条转移用 `__draft__`：

```
主线.闲逛B --[__draft__]--> 去赌坊
主线.去赌坊 --[__draft__]--> 背崖墓尸完成
主线_交互点.initial --[__draft__]--> state_1
```

`__draft__` 是运行时**拒绝发射**的保留信号（`refusing to emit draft signal`）。
所以这两条永远不会触发——**主线实际在"闲逛B"之后就断了**。

作者的处境是真实的：**形状已经想好，触发还没定。**他有三个选择：

| 做法 | 代价 |
|---|---|
| 先不写这条转移 | 图的形状丢了，看不出打算怎么走 |
| 写个假信号 | **和"信号改名后遗留的悬垂发射端"长得一模一样**——静态分析分不出是故意还是漏 |
| 现状：`__draft__` 魔法字符串 | 意图藏在一个字符串约定里，不在类型里 |

**判据过一遍**：
- ①领域语义里有这一项吗？**没有**——"还没想好"不是世界里的事，是**创作过程**的事 ⇒ 语言层，不是领域层
- ②非宏可消去吗？**可消去**——写个没人发的信号就是它

⇒ **不是表达力缺口，是"说清楚这是故意的"的缺口。**

跟规格里 §5 那句「明确不提供，**非遗漏**」是同一个形状：
真正的需求是**让静态检查说"这是有意的占位"，而不是"这是悬垂"**。

⇒ 建议加一个**语言层**标记 `todo`（不是领域构造）：
它编译得过、恒不触发、**静态分析单独归一类**（"待接线 N 处"），不混进悬垂告警。
现状的 `__draft__` 就是它，只是意图写在魔法字符串里而不是语言里。

### E ✅ 纯环 vs 轮次，v16 正好区分

`scenario_码头官差套近乎` 是 `pending → done → pending` 的**纯环**（label 写着"可被骂重置"）。
它不是 run 图，所以现在**不计数**。

v16 §2.2 把这件事变成**显式选择**：
- 写成纯环（现状）：`on 被骂了 -> 还没套上`，计数不变
- 写成可重复：`repeatable` + `done`，能问"套上过几回"

现状那份数据看不出作者选了哪个——因为旧模型里非 run 图**根本没得选**。

### F 记一笔：`exitStates` 在非 run 图上确实只是调试边界

`scenario_听书`/`码头`/`码头真相`/`官差套近乎` 都声明了 `exitStates`，但它们都不是 run 图，
运行时只在 `canRemoteEnterState`（debug setState / dev warp）里用它。v16 §4.12 判定成立。

---

## 四、结论

**两段都写出来了，没有加一条语法糖。**

| 发现 | 性质 | 处置 |
|---|---|---|
| A 听书广播无人听 | 数据里的真 bug | 语言结构性防住 ✅ |
| B `completed` 不可达 | 静态分析缺口 | 进 §5 悬案的分析清单 |
| C flag 条件叶 | **待拍板** | 甲/乙二选一 |
| D `__draft__` 待接线 | **语言层缺口** | 建议加 `todo` 标记 |
| E 纯环 vs 轮次 | v16 优于现状 | ✅ |
| F 非 run 图的 exitStates | 判定坐实 | ✅ |

**领域层构造集不变（十二个）。**D 是语言层的第三项（`module` · 类型 · id/label 之后）。
