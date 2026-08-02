# 任务编排工具

主编辑器入口：`数据编辑 → 叙事编排 → 任务编排`。它直接复用主编辑器的
`ProjectModel`、Scene 页和“全部保存”生命周期。

独立启动方式也继续保留：

```bash
.tools/venv/bin/python -m tools.task_orchestration_editor /Users/dannyteng/AIWork/GameDraft
```

macOS 策划也可以直接双击 `tools/task_orchestration_editor/launch.command`。

它没有自己的项目文件。界面每次都从现有 `narrative_graphs.json`、场景 JSON、
图对话 JSON 和 `quests.json` 反向生成；“应用到内存”只更新 `ProjectModel`，顶部
“全部保存”才通过既有 `ProjectModel.save_all()` 一次性校验并原子写盘。

典型的一次性事件会被编译成项目规定的五层原生信号脊椎：

```
任意前置叙事图.阶段 + 所选任务流 mainGraph.发生前阶段
  → 原生 scenarioSubgraph: locked --reactiveAll--> ready
  → Scene Zone.conditions / NPC.conditions 读取 scenario.ready
  → Zone.onEnter.startDialogueGraph
  → 任务专用对话图的每个可达 end 前 emitNarrativeSignal(内容信号)
  → scenario.ready --内容信号--> done(broadcastOnEnter)
  → 派生信号 state:scenario图:done
  → 所选任务流 mainGraph transition
  → scenario 不再是 ready，NPC 隐藏、Zone 停用
```

如果玩家没触发、任一前置条件先失效，scenario 会从 `ready` 自动进入
`expired`，NPC/Zone 同样失效，不会永久残留。

窗口中的“场景实体布置”页直接复用了既有 `SceneEditor`，可以在地图上新建、拖动 NPC / Hotspot、
绘制 Zone；顶层表单只引用这些实体的原生 ID，不要求策划输入坐标、路径或 JSON。切回“顶层任务编排”
时会先提交 Scene 表单并刷新候选。

安全规则：

- 新事件默认且必须把源对话复制成普通任务专用图；不会向共享对话偷偷插入信号。
- NPC / Hotspot / Zone 已绑定其它对话时默认硬阻断，只有勾选“明确替换”才会窄改原生字段。
- NPC / Hotspot 已有旧 `conditions` 但尚未开启 `conditionHidesEntity` 时硬阻断，避免工具开启该字段后永久改变旧条件语义；先在“场景实体布置”页人工确认即可。
- 同一主图作为前置时，前置阶段会锁定为“发生前阶段”；事件子图不能引用自己作为前置，避免生成永远 locked 的逻辑环。
- Quest 候选排除 repeatable，编译器仍会二次硬校验。
- 原生接线可逐条解绑；Zone 解绑只精确移除对应黑盒里的单条 `reads/emits` 投影。删除事件要求零外部引用和完全标准的四阶段 scenario 骨架；旧编辑器追加过动作、条件、优先级或作者登记时一律拒绝删除。
- 保存前同时检查外部文件变化和“新对话副本被外部抢占”竞争；载入异常时编辑与保存全部锁定。

不会创建 `TaskSpec`、manifest、sidecar、所有权标记或运行时新字段。老 Scene、图对话、叙事状态机、
Quest 编辑器可继续打开、编辑和保存全部产物。
