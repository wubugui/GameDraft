# 策划 Graph 内容操作指南

这套工具只负责 graph 内容：

```text
1. 对话 graph
2. 叙事状态 graph
3. 任务逻辑 / 任务依赖
4. flags / signals / quests 基础登记表
```

不要把道具、规矩、档案、文本、音频、地图、实体、区域、路线等普通数据迁进表里；这些继续走现有编辑器或现有流程。

工具按三类理解：

```text
1. 命令执行 / 内容验收：
   全部从独立 GUI 面板跑。

2. YAML 编辑辅助：
   全部在 VS Code 里用，负责补全、跳转、引用、picker。

3. 运行时 Debug / Trace 定位：
   从模拟结果或 runtime trace 反查到 YAML 源位置。
```

---

## 1. 先判断要改什么

按这个表选文件：

```text
改对话流程：
  authoring/dialogues/**/*.yaml

改叙事状态机 / wrapper graph：
  authoring/narrative/**/*.yaml

改任务条件 / 奖励 / 后续任务：
  authoring/quests/**/*.yaml

新增或说明 flag：
  authoring/tables/flags.csv

新增或说明 signal：
  authoring/tables/signals.csv

新增或修改任务标题、类型、描述：
  authoring/tables/quests.csv
```

不要直接改：

```text
public/assets/**/*.json
artifact/content_pipeline/**
```

---

## 2. 新增一个 flag

打开：

```text
authoring/tables/flags.csv
```

新增一行：

```csv
key,type,owner,meaning,default,notes
铁环小孩_已经获得铁环,bool,npc_ringboy,玩家是否已经拿到铁环,false,
```

字段说明：

```text
key：程序和 graph 里引用的稳定 ID。
type：bool / string / float / int。
owner：归属对象，比如 npc_ringboy、quest.xxx、flow.xxx。
meaning：给人看的说明。
default：默认值。
notes：备注，可空。
```

---

## 3. 新增一个 signal

打开：

```text
authoring/tables/signals.csv
```

新增一行：

```csv
key,owner,meaning,notes
ring_taken,npc_ringboy,滚铁环小孩：玩家拿到铁环,
```

使用原则：

```text
signal 表示“发生了一件事”。
不要把 signal 写成状态名。
推荐写成 ring_taken / board_read_done / pull_success 这种事件。
```

---

## 4. 新增或修改任务基础信息

打开：

```text
authoring/tables/quests.csv
```

新增或修改一行：

```csv
id,group,type,sideType,title,description,notes
支线-归还小孩铁环-归还铁环,支线-铁环,side,commission,归还铁环,把铁环换给小孩。,
```

这里只放任务基础信息。

不要在这张表里写复杂条件、奖励链、后续任务逻辑。那些写在：

```text
authoring/quests/**/*.yaml
```

---

## 5. 改对话 graph

对话 YAML 一般在：

```text
authoring/dialogues/npc/
authoring/dialogues/scenario/
```

基本结构：

```yaml
id: 滚铁环小孩
entry: root
nodes:
  root:
    type: ownerState
    wrapperGraphId: npc_ringboy
    cases:
      - state: after_event
        next: after_evt_choice

  after_evt_choice:
    type: choice
    options:
      - id: snatch
        text: 抢铁环。
        next: opt_snatch_1
```

常见节点：

```text
line：一句或多句台词。
choice：玩家选项。
switch：按条件分支。
runActions：执行动作。
ownerState：按当前 NPC / owner 状态分支。
contextState：按指定 graph 状态分支。
end：结束。
```

改完后一定检查：

```text
1. entry 指向的节点存在。
2. next 指向的节点存在。
3. choice option 的 next 存在。
4. action 里的 flag / signal / questId 已登记。
```

---

## 6. 改叙事状态 graph

叙事 YAML 一般在：

```text
authoring/narrative/
```

基本结构：

```yaml
id: flow_dock_water_monkey
compositionId: dock_water_monkey_ring_flow
owner:
  type: flow
  id: 码头水鬼
initialState: initial
states:
  initial:
    label: 未开始
  done:
    label: 已完成
    broadcastOnEnter: true
transitions:
  - id: t_done
    from: initial
    to: done
    signal: pull_success
```

使用原则：

```text
state 表示“现在处于什么状态”。
signal 表示“发生了什么事件”。
transition 表示“收到事件后从哪个状态切到哪个状态”。
```

---

## 7. 改任务逻辑

任务 YAML 一般在：

```text
authoring/quests/main/
authoring/quests/side/
```

基础结构：

```yaml
id: 支线-归还小孩铁环-归还铁环
preconditions: []
completionConditions: []
rewards: []
nextQuests: []
```

任务标题、描述、类型不要写在这里，写在：

```text
authoring/tables/quests.csv
```

---

## 8. 跑检查

最推荐使用独立 GUI：

```powershell
npm run planner:gui
```

或者双击：

```text
tools/planner_gui/start_planner_gui.cmd
```

打开后按按钮操作：

```text
1. 一键完整检查
2. 刷新诊断列表
3. 模拟默认流程
4. 选择模拟案例
```

GUI 只做验收和调试，不在里面编辑内容。

```text
改内容：
  点“打开 authoring 源目录”，然后回 VS Code 改 YAML。

看问题：
  在“问题列表”里看 error/warning，可以复制选中问题或复制全部问题。

看命令输出：
  在“命令日志”里看彩色日志，可以复制选中、复制全部。
  每次运行命令都会自动保存日志到 logs 目录。
  “保存日志...”只是手动另存一份。

跑低频命令：
  Build / Validate 在右侧“Build”分页。
  刷新诊断在“问题列表”分页。
  Signal / Flag / Quest / Dialogue / Runtime Trace 统一在“关系诊断”分页查看。
  Content Index / Trace Resolve 也在“关系诊断”分页。
  其它低频命令在“其它命令”下拉里。

新建 YAML：
  在“命令执行”下拉里选“新建 ... YAML 模板...”。
  只输入显示名称，不输入 id。
  工具会自动生成不重名机器 id。
  id 用来给系统引用，显示名称用 title/name/meta.title 保存给人看。
  然后选择模板和具体保存位置。
  dialogue 放在 authoring/dialogues 下。
  narrative 放在 authoring/narrative 下。
  quest 放在 authoring/quests 下。

看模拟结果：
  GUI 默认只显示摘要，包括路线、选择、状态变化、事件数量和诊断数量。
  完整 JSON 留在 artifact/content_pipeline/simulation_result.json。
```

如果要用 VS Code 扩展，也可以打开：

推荐从 VS Code 打开：

```text
Game Authoring: Open Planner Dashboard
```

如果命令面板里搜不到这个命令，说明 VS Code 扩展还没有启动。让工具负责人先做其中一种：

```text
开发模式：
  Run and Debug -> Run GameDraft Authoring Tools -> F5

本机安装：
  npm --prefix tools/vscode-game-authoring run install:local
```

然后点：

```text
Build Content
Refresh Diagnostics
Run Full Check
```

如果不用工作台，也可以在终端运行：

每次改完，先跑：

```powershell
npm run content:build
```

如果想跑完整检查：

```powershell
npm run content:check
```

常用命令：

```powershell
npm run content:diagnostics-json
npm run content:simulate
npm run content:runtime-compatibility
```

但策划验收优先从 GUI 跑；命令行主要给工具负责人排查用。

---

## 9. 看错误怎么修

常见错误：

```text
flag.undeclared：
  graph 里用了未登记的 flag。
  去 authoring/tables/flags.csv 加一行。

signal.undeclared：
  graph 里用了未登记的 signal。
  去 authoring/tables/signals.csv 加一行。

quest.undeclared：
  graph/action 里引用了未登记的 quest。
  去 authoring/tables/quests.csv 加一行，并确认 quest YAML 存在。

dialogue.node.targetMissing：
  next 指向了不存在的节点。
  修 next 或补节点。

action.param.required：
  action 缺必要参数。
  按提示补 params。

action.flag.valueType：
  setFlag 的 value 类型和 flags.csv 里声明的 type 不一致。
  bool 就写 true/false，string 就写文本。
```

warning 不一定要马上修，但要能解释。

error 必须修完才能发布。

---

## 10. 做一次对话路线模拟

如果有模拟用例，可以跑：

```powershell
npm run content:simulate -- authoring/simulations/ringboy_snatch_route.json
```

看这几项：

```text
ok: true
blocked: []
route: 走过哪些 dialogue node
diff: flags / quests / narrative / inventory 发生了什么变化
events: action 和 signal 的详细过程
```

如果 `blocked` 不是空，说明路线走不通。

---

## 11. 发布前确认

发布前必须满足：

```text
1. npm run content:check 通过。
2. diagnostics 没有 error。
3. runtime-compatibility ok: true。
4. ownership warning 是预期的。
5. runtime preview 里内容表现正确。
```

不要手改生成文件。

如果发现生成结果不对，回到 `authoring/` 修改源文件。

---

## 12. 最短流程

日常只记这一版：

```text
1. 运行 npm run planner:gui，或双击 tools/planner_gui/start_planner_gui.cmd。
2. 从 GUI 打开 authoring 源目录，回 VS Code 改 YAML 或 registry 表。
3. 不改 public/assets 和 artifact。
4. 点“一键完整检查”。
5. 看“问题列表”，有 error 就按提示修。
6. 用“模拟默认流程”或“选择模拟案例”检查关键路线。
8. 确认 runtime preview 正确后再发布。
```
