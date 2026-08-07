# 叙事信号交叉引用（共享基建）

回答一个问题：**这条信号，谁发的、谁听的。**

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
python3 -m tools.narrative_xref beishi_lg_accepted   # 一条信号的两侧
python3 -m tools.narrative_xref --list               # 全部信号 + 发/听/声明计数
python3 -m tools.narrative_xref --problems           # 只看两侧对不齐的
python3 -m tools.narrative_xref <id> --json          # 给 agent / 脚本
```

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

派生信号 `state:<图>:<状态>` 额外给两样：

- **能让它发生的路**：进入该状态的上游转移 + `setNarrativeState` 强制设状态。
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
