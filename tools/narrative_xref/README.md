# 叙事关系交叉引用（共享基建）

回答两个问题：

- **这条信号，谁发的、谁听的。**
- **这一拍，怎么进来、从这儿去哪、谁在看着它。**

第二个问题的重点在最后一栏：读状态的引用里 **346/370 是转移以外的消费者**（对话分支、
场景实体显隐、章节包、任务、地图节点、档案）——它们在因果图上一条线都没有，改一拍
最容易漏的就是它们。

编辑器面板、调试器窗口、命令行三处共用这一份扫描与口径。界面各做各的（用途不同），
口径只有一份（否则同一条信号在两个工具里显示不一样，人就没法信任何一个）。

## 两个界面各怎么用

### 编辑器（做内容时：改之前先看牵连谁）

叙事状态机页，四个入口都通向同一块面板：

- 工具栏 `信号关系+`
- 信号选择弹窗里每行的 `看关系`
- 转移属性里信号字段旁的 `看关系`
- 校验面板点信号类问题（以前点了没反应，现在落到这条信号上）

面板左边是全部信号（`全部 / 有问题 / 作者信号 / 派生信号 / 未登记` 五个页签；搜索框连
"婆子那段戏发的那个"都能搜到，因为两侧的容器名也在搜索面里）。右边按顺序说六件事：
诊断 → **谁发的** → （派生信号才有）**能让它发生的路** → **谁在听** → 画布上说会发它的盒子 →
谁在读这个状态。

每行都能跳，但分两种：**叙事图内的行按「画布定位」**（就在这一页选中那条转移/状态，不切页）；
对话图 / 场景 / 任务那类按「去看看」（切到那个编辑页，回执同时写进主窗状态栏，因为切页后
面板上那行字你就看不见了）。跳不动的行提前灰掉并说明原因，不让人白点。

面板**只读**：不改数据、不标脏。唯一会写的是未登记信号的 `补登记`（与信号弹窗共用同一个
函数，可 Ctrl+Z）和 `改名 / 删除`（走既有的重构弹窗）。扫描是快照——面板顶部写着几点扫的，
画布改过会亮过期提示；在别的编辑页（图对话、场景…）改过东西，要手动点「重新扫描」。

### 调试器（跑游戏时：刚才那一下怎么没反应）

见 `tools/narrative_debugger/README.md` 的「信号关系」一节。一句话分工：编辑器答
"**我改之前**牵连谁"，调试器答"**这一刻**谁在等、刚才那下谁发的"。

## 命令行

```bash
python3 -m tools.narrative_xref beishi_lg_accepted        # 一条信号的两侧
python3 -m tools.narrative_xref --list                    # 全部信号 + 发/听/声明计数
python3 -m tools.narrative_xref --problems                # 只看两侧对不齐的
python3 -m tools.narrative_xref --state 图id.状态id        # 这一拍：怎么进来 · 去哪 · 谁在看着
python3 -m tools.narrative_xref --states [--problems]     # 全部状态一览
python3 -m tools.narrative_xref <id> --json               # 给 agent / 脚本
```

## 引用要落到「世界里的那个东西」

策划盯的是实体与流程。每条读状态的引用都带 `subject_*`：它管的是**谁**
（`雾津街头的NPC「挑空担的汉子」`，名字取 name/label/title，取不到才退 id）、
**决定它什么**（`出不出现` / `任务算不算数` / `这一章开不开` …），
外加两个判定位：`reached`（要求"到过"还是"正停在"——差别决定调试器敢不敢下断言）与
`negated`（被 `not` 包着，漏掉会把结论说反）。

`场景实体` 的显隐语义读它自己的 `conditionHidesEntity`：true＝条件不满足就藏起来
（"出不出现"），否则只是不能互动。真实工程 371 条引用**全部**落到了具体东西上
（护栏 `test_every_reference_in_the_real_project_resolves_to_something`）。

## 一拍的四栏

`state_card(图, 态)` → 怎么进来（上游转移 / 强制设状态）· 从这儿去哪（出口转移）·
进出会发什么信号 · **谁在看着**（条件叶、对话分支、章节包、任务、地图节点、档案…）。
诊断盖四种：图里没有这个状态（被引用却不存在＝那些条件永远判不成立）、进不来、
没有出口、没人读也不广播。

## 反应式转移的 signal 字段

反应式转移（`reactive*`）靠条件自动走，运行时**根本不看 signal 字段**。但策划确实会在
那儿写名字（真实数据上就有：主线入口 `Demo主线开始`）。算成监听是骗人，只说"没人听"
又会让人对着自己写的名字发懵——所以单列一栏 `reactive_refs` + 一条诊断说清楚。

## 代码里用

```python
from tools.narrative_xref import build_index, from_disk, from_project_model

index = build_index(from_disk(repo_root))      # 调试器 / CLI：磁盘，纯 stdlib
index = build_index(from_project_model(model)) # 编辑器：内存，看得见未保存的编辑
card = index.card("sig_x")                     # 两侧 + 诊断
index.overview()                               # 全部信号（一次扫描，切换零延迟）
```

## 一条信号的两侧到底包含什么

| 侧 | 收哪些 | 不收哪些 |
|---|---|---|
| 发送方 | 对话图动作树、内容资产动作树（场景/任务/遭遇/过场/压力条/档案/小游戏…）、叙事图 state 的 onEnter/onExitActions、`broadcastOnEnter` 派生广播 | 黑盒 `meta.emits`——那是**声明**不是实发，单列一栏 |
| 接收方 | 监听该信号的转移 | 反应式转移（`reactive*` 靠条件自评估，signal 字段是占位）|

**接收方只有转移这一种**：运行时把信号排进 `NarrativeStateManager` 队列，只有 transition 的
`signal` 参与匹配；别的系统听的是 `narrative:stateChanged`（状态变了），不是信号本身。

## 私有信号（`scope`）与宿主身份

注册表标了 `scope: 'private'` 的信号**只投递给发射方 owner 拥有的 wrapper 图**，缺 owner
上下文当场丢弃、**不回落成全局广播**（机制卡 `agent_docs/runtime/mechanisms/private-narrative-signal.md`）。
所以卡上两样东西必须看得见，否则一条私有信号与全局信号在界面上一模一样：

- **卡片的 `scope` / `private`**：从 `signals[].scope` 原样带出，**不替作者补默认值**——
  未登记的信号根本没有这一栏，硬填 `global` 会让"没登记"和"登记了是全局"长成同一个样子。
- **发射行的 `ownerType` / `ownerId`（`ownerBound`）**：私有信号按发射方 owner 定向，
  而 owner 绝大多数是发射点上下文隐式带进来的（`actionOrigin` 四档，作者不书写、静态扫不出来）；
  发射点上那对参数是**唯一写在数据里、静态看得见**的宿主身份，卡上标成「带宿主身份：<类型>:<id>」。
  ⚠ 判据是"两个都填了"，与运行时逐字一致（`ActionRegistry` 的
  `paramOwnerType && paramOwnerId ? … : origin…`）：只填一个运行时**整对丢弃**退回 origin 档，
  照单显示半对参数等于告诉作者"定向已经钉好了"。护栏
  `test_owner_binding_predicate_matches_the_runtime_typescript` 对着 TS 原文锁。

> 运行时侧的另一半（谁能听）在校验器：无 owner 绑定的图监听私有信号 = error
> （`signal.private.listener.unbound`），声明了没人听 = warning（`signal.private.unlistened`）。
> 本模块**刻意不复制**那两条判定——再造一份就是第二个会漂的口径。

派生信号 `state:<图>:<状态>` 额外给两样：

- **能让它发生的路**：进入该状态的上游转移 + `setNarrativeState` 强制设状态。每条都带
  `wired`：**占位信号的转移运行时拒发**，那条路走不到，界面必须与真能走的路分开画
  （全都没接线时另出一条 `unreachable` 诊断）。判据是共享的
  `model.transition_is_unwired(signal, trigger)`——调试器 `Transition.is_unwired` 直接调它，
  各写一份的后果就是同一份数据在两个工具里给出相反答案（2026-08-07 审查坐实过）。
  ⚠ 反应式转移（`reactive*`）的 signal 恒是占位、线接在 conditions 上，**不算没接线**。
  只说"进入时自动发"等于没回答"谁让它发的"。
  ⚠ 初始状态**不算**一条路：注册图 / `startNarrativeRun` / `resetNarrativeRun` 都是直接
  set activeStates，不走 `enterState`、**不广播**——初始状态勾了「进入时广播」是白勾，
  这种情况单出一条诊断说明。
- **谁在读这个状态**：条件叶、活计计数叶、图对话 ownerState/contextState 分支、活计生命周期
  动作（start/reset/revert/activate）对该状态的引用。五种形状与
  `signal_refactor._walk_narrative_refs` 对齐；其中 `setNarrativeState` 例外——它真的会
  `enterState`（因而会广播），所以归到上面那栏「能让它发生的路」，不算"读"。广播只被
  条件消费时"没人听"是已知噪声，列出来就不会被当成漏接线
  （见 `agent_docs/editor-tools/mechanisms/emitted-signal-catalog.md` 已知坑）。

## 每条定位都能跳

**文件里的行**（对话图 / 场景 / 任务 / 过场 / 档案…）带 `file` + `pointer` + `anchors`，
形状与 `tools/json_lang/search.py` 的命中完全一致，可以直接喂给主编辑器既有的
`navigate_to_search_hit()`——对话图落到节点、场景落到实体、过场落到步骤，全套复用。

**叙事图里的行**（广播状态 / 状态动作 / 上游转移 / 监听转移 / 黑盒声明）另带编排·图·状态·
转移·元素 id，走**画布定位**：narrative_graphs.json 的文件级跳转只认 `states/<id>`，
转移那种指针落不到点，会退化成"打开了叙事状态机页"——而你本来就在那一页。

## 口径护栏（镜子必须配对账，见 editor-tools norms §8）

`tools/narrative_xref/tests/test_narrative_xref.py`：

- `test_asset_specs_mirror_catalog_registry` —— 发射面 ≡ `narrative_catalog._EMIT_SOURCE_ATTRS`。
- `test_condition_face_mirrors_the_refactor_engine` —— 引用面 ≡ `signal_refactor.CONDITION_SOURCES ∪ READONLY_SOURCES`
  （条件面比发射面宽：地图/物品/规矩/章节包…都可能读状态）。
- `test_reference_shapes_mirror_the_refactor_engine` —— 五种引用形状**语义级**对账：
  同一份合成数据，与 `signal_refactor._walk_narrative_refs` 认出同样多的引用。
- `test_real_project_matches_catalog_emitted_signal_ids` —— 真实工程逐条对账发射侧。
- `test_real_project_every_location_is_resolvable` —— 每条定位在真实工程里都解得出来。

跨工具口径（另两处）：

- `tools/editor/tests/test_signal_xref_bridge.py::SignalXrefSourceParityTests::test_model_source_matches_disk_source_on_the_real_project`
  —— 编辑器内存来源与磁盘来源逐条相同。
- `tools/narrative_debugger/tests/test_signal_xref_window.py::test_mcp_signal_info_says_the_same_thing_as_the_window`
  —— MCP 给 agent 的两侧与策划屏幕上的一致（含派生信号：上游因果不算发射）。

```bash
.tools/venv/bin/python -m pytest tools/narrative_xref/tests -q
```
