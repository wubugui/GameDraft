# 评审：Cutscene → Action、唯一 resolveActor、Timeline 迭代计划

**评审对象**：`docs/plan-cutscene-action-timeline.md`  
**评审依据**：当前仓库代码深度分析 + 业界游戏 timeline 系统最佳实践

---

## 一、总体评价

该计划方向正确，抓住了当前代码中最核心的两个架构痛点：

1. **实体解析二元性**：`Game.ts` 中的 `resolveActor`（不含临时实体）与 `CutsceneManager.resolveEntity`（含临时实体）是两套独立的解析路径，导致 Action 在过场上下文中无法命中临时 spawn 出来的实体。
2. **CutsceneManager 的巨型 switch**：`executeOne` 中有 30+ 个 case 分支，其中大量（`set_flag`、`play_bgm`、`switch_scene` 等）本质上是对 `ActionExecutor.executeAwait` 的手动 wrapper，与已有 Action 体系重复。

将这些收编为统一 Action 后再引入 Timeline，符合「先统一执行口、再扩展调度层」的工程节奏。

但计划在多个关键维度存在不足，以下逐点分析。

---

## 二、优点

### 2.1 依赖顺序清晰，防返工思路正确

```
resolveActor（阶段 1）
    → 补 Action + 编辑器/校验（阶段 2）
    → 重写 CutsceneManager + 换 JSON（阶段 3～4）
    → Timeline 运行时（阶段 5）
```

这个依赖链抓准了核心约束：`resolveActor` 必须先合并，否则后续新增的实体操作 Action（如 `moveEntityTo`、`cutsceneSpawnActor`）在 Action 路径下会因找不到临时实体而失败。从当前代码来看：

- `Game.ts:382` 的 `resolveActor` 只查 `player` 和 `sceneManager.getNpcById`
- `CutsceneManager:320-324` 的 `resolveEntity` 先查 `tempActors`、再查 `entityResolver`

合并后统一为一套，确实是所有后续工作的前提。

### 2.2 「不做向后兼容」的决策务实

当前 `cutscenes/index.json` 仅 9 条演出定义，且内容未正式投产。在这个阶段果断抛弃旧 schema 而非双写兼容，可以避免大量 normalize / migration 代码和长期维护负担。

### 2.3 Promise 完成语义统一

计划明确要求「每个 Clip `play(context): Promise<void>`」、「禁止无 Promise 却表示异步的半套语义」。这与当前 `ActionExecutor.executeAwait` 返回 `Promise<void>` 的设计一脉相承，也是当前代码中最成功的架构决策之一（对比早期的 `execute` fire-and-forget 已被标记 deprecated）。

### 2.4 验收清单具体可查

5 条验收条目都是可通过自动化手段（全仓库搜索、类型检查、单元断言）验证的，不是模糊的主观标准。

---

## 三、不足与遗漏

### 3.1 [严重] Timeline 阶段 5 过于粗略——缺乏核心架构决策

阶段 5 是整个计划的最终目标，但目前仅是一张表格加三个「选一种写进规格」。以下关键问题完全没有展开：

#### 3.1.1 时间模型缺失

当前 `CutsceneManager.executeCommands` 是纯 **command-list**（顺序 + parallel 标记），没有「时间轴」概念——不存在「在第 2.5 秒开始 camera_move」这样的绝对时间定位。计划提出「Timeline」但未定义：

- **绝对时间（track-based）** vs **相对时间（await-chain）**？
- 如果是绝对时间，调度器如何处理 `Promise` 完成时间与预定时间的偏差？（例如 `entity_move` 的实际耗时取决于距离和速度，不是固定 duration）
- 如果是相对时间，它与当前 command-list + parallel 有何本质区别？仅仅是多轨道 vs 单轨道？

**建议**：明确 Timeline 采用 **track-based 绝对时间模型**还是 **cue-list 相对时间模型**。对于本项目（2D 点击冒险、叙事驱动），业界实践表明：

- **Unity Timeline** 风格的 track-based 适合精确的镜头语言和动画同步
- **Godot CutsceneDirector** 风格的 await-chain 适合叙事分支和交互式过场

考虑到本项目大量使用 `show_dialogue`（需要等待玩家点击）和 `wait_click`，纯绝对时间模型不合适。建议采用 **混合模型**：顺序 cue-list 作为主干，支持在单个 step 内嵌套固定时长的多轨并行段（类似当前 `parallel` 但更结构化）。

#### 3.1.2 跳过 / 取消 / 快进机制未提及

这是业界 cutscene 系统的核心需求。当前代码中 `CutsceneManager` 没有 skip 能力——一旦启动只能等播完。计划完全没有讨论：

- **Skip**：玩家按下跳过键后，如何将所有副作用（`set_flag`、`giveItem` 等）即时执行而跳过等待/动画？
- **Cancel**：在 `destroyed` 时如何安全中断正在 `await` 的 Promise 链？（当前代码通过 `this.destroyed` 标志位检查，但 `Promise` 本身无法被取消）
- **Fast-forward**：是否需要加速播放能力？

**建议**：在阶段 5 规格中增加「跳过策略」小节。常见做法是为每个 Action 标记 `skippable` 属性：
- 副作用类（`setFlag`、`giveItem`）：skip 时立即执行
- 演出类（`fadeToBlack`、`cameraMove`）：skip 时立即跳到终态
- 等待类（`waitClick`、`showDialogue`）：skip 时立即 resolve

#### 3.1.3 多轨道并行的 JSON schema 未定义

当前 `parallel` 标记是 **后附式**（第 N+1 条标记 `parallel: true` 表示与第 N 条并行），这种设计在当前简单场景下可用，但存在明显问题：

- 3 条以上并行时语义模糊（第 3 条 parallel 是与第 1 条还是第 2 条并行？实际代码是全部并行）
- 无法表达「A 和 B 并行完成后，再与 C 并行」这样的 fork-join 拓扑

计划提到「并行轨 `Promise.all`」但没有给出 JSON 结构。

**建议**：定义显式的并行组结构，例如：

```json
{
  "kind": "parallel",
  "tracks": [
    [{ "type": "cameraMove", "params": { "x": 300, "y": 300, "duration": 1500 } }],
    [{ "type": "fadingZoom", "params": { "zoom": 1.3, "durationMs": 1500 } }]
  ]
}
```

或采用 track-id 引用的多轨道结构。

### 3.2 [中等] 「纯演出」Action 与「世界副作用」Action 的边界未定义

计划说「删除 `executeOne` 中所有世界侧 case；世界侧仅 `actionExecutor.executeAwait`」，但同时说「若演出不全收进 Action，则保留极少 `present` 步骤类型」。这个「二选一」没有给出判断标准。

从当前代码分析，有一类操作处于灰色地带：

| 操作 | 当前实现 | 是否适合收编为 Action |
|------|----------|---------------------|
| `fade_black` / `fade_in` | `CutsceneRenderer.fadeToBlack` | 灰色——纯视觉，但可能需要 Action 路径也能调用（对话中渐黑） |
| `show_title` | `CutsceneRenderer.showTitle` | 灰色——纯视觉 |
| `show_dialogue` | `CutsceneRenderer.showDialogueBox` + 等待点击 | 灰色——需要输入等待，且与 `DialogueUI` 重复 |
| `camera_move` / `camera_zoom` | `CutsceneRenderer.cameraMove/cameraZoom` | 灰色——已有 `fadingZoom` Action，但 `cameraMove` 尚未 |
| `show_img` / `hide_img` | `CutsceneRenderer.showImg/hideImg` | 灰色——已有 `showOverlayImage` Action（百分比布局），但 cover 模式的 `showImg` 尚未 |
| `show_movie_bar` / `hide_movie_bar` | `CutsceneRenderer.showMovieBar/hideMovieBar` | 可以收编 |

实际上，`fadeWorldToBlack` 和 `fadeWorldFromBlack` 已经作为 Action 注册在 `ActionRegistry.ts:465-481`，证明视觉操作收编为 Action 是可行的。

**建议**：明确规定 **全部收编为 Action**，不保留 `present` 步骤类型。理由：
1. 已有先例（`fadeWorldToBlack` 已是 Action）
2. 消除「两套调度入口」的维护负担
3. 对话/热区/任务奖励中也可能需要调用这些视觉效果（如对话中渐黑已经在用 `fadeWorldToBlack` Action）

### 3.3 [中等] `cutsceneSpawnActor` / `cutsceneRemoveActor` 的生命周期管理未设计

计划提到要将 `entity_spawn` / `entity_remove` 收编为 Action（`cutsceneSpawnActor` / `cutsceneRemoveActor`），但未讨论关键问题：

- **临时实体的所有权**：当前由 `CutsceneManager.tempActors` 持有，`cleanup()` 时统一销毁。如果 spawn/remove 变为 Action，谁持有 `tempActors` Map？仍然是 `CutsceneManager`？那 Action handler 需要反向依赖 `CutsceneManager`（当前 `ActionRegistryDeps` 已经依赖它，所以可行，但需要明确）。
- **临时实体与场景实体的 ID 冲突**：如果临时实体 ID 与场景 NPC ID 相同会怎样？当前 `resolveEntity` 先查临时表再查场景，意味着临时实体会「遮蔽」同 ID 场景实体。计划提到「是否强制前缀如 `__cut_*` 可选」，但这个决策影响编辑器和校验逻辑，不应推迟。
- **跨场景的临时实体**：如果过场中 `change_scene` 切换了场景，临时实体是否保留？当前实现中 `tempActors` 不受场景切换影响（因为挂在 `cutsceneOverlay` 上），但新架构下需要明确。

**建议**：
1. 临时实体仍由 `CutsceneManager` 管理，但 spawn/remove Action handler 通过 `ActionRegistryDeps` 中的函数代理调用
2. 强制临时实体 ID 不可与任何场景 NPC ID 冲突——编辑器校验时检查
3. 明确临时实体在 `change_scene` 后的行为（建议：保留到 cutscene 结束的 cleanup）

### 3.4 [中等] 编辑器迁移策略缺失

计划在阶段 2 提到「`action_editor.py` 的 `ACTION_TYPES`、`_PARAM_SCHEMAS` 同步」，在阶段 4 提到「JSON 一次性重写」，但完全没有讨论 **`cutscene_editor.py` 本身的改造**。

当前 `cutscene_editor.py` 是一个完整的命令列表编辑器（977 行），有自己的 `COMMAND_TYPES`、`_CMD_PARAMS`、`CommandWidget` 等。如果过场 step 全部变为 `ActionDef`，这个编辑器需要重大改造——或者直接复用 `ActionRow` 作为每个 step 的编辑组件。

**建议**：在阶段 3 中增加编辑器改造的具体方案：
- 复用 `action_editor.py` 中的 `ActionRow` 组件
- 删除 `COMMAND_TYPES` 和 `_CMD_PARAMS`（改用 `ACTION_TYPES` + `_PARAM_SCHEMAS`）
- 保留过场级元数据编辑（`targetScene`、`restoreState` 等）
- 保留并行组编辑能力（需要新 UI：在 ActionRow 列表中支持分组）

### 3.5 [低] `show_dialogue` / `show_subtitle` 的等待机制与 DialogueUI 的关系未厘清

当前过场中的 `show_dialogue` 使用 `CutsceneRenderer.showDialogueBox`——这是一套独立于 `DialogueUI` 的简陋对话框实现（固定大小、无打字机效果、无头像）。而正式对话走 `DialogueUI`（有打字机效果、选项、日志记录等）。

如果将 `show_dialogue` 收编为 Action，需要决定：
- 是继续用 `CutsceneRenderer` 的简陋实现？
- 还是统一走 `playScriptedDialogue` Action（已有）走 `DialogueManager` → `DialogueUI`？

从当前 `cutscenes/index.json` 来看，大量过场的核心就是连续 `show_dialogue`。如果这些改为 `playScriptedDialogue`，可以复用打字机效果和对话日志，但需要处理状态机冲突（过场时 GameState 是 `Cutscene`，而对话需要 `Dialogue`）。

**建议**：在阶段 0 规格冻结时明确 `show_dialogue` 的目标实现。推荐统一走 `playScriptedDialogue`，状态机上 `Cutscene` 状态允许嵌套对话 UI。

### 3.6 [低] 阶段 0 「规格冻结」缺乏输出物定义

阶段 0 只列了 3 个表格项，但没有说明：
- 输出物是什么？（一份新的 schema JSON 文件？一段 TypeScript 接口定义？）
- 谁来 review？
- 冻结后如何处理后续发现的 schema 不足？

**建议**：阶段 0 的输出物应该是：
1. `src/data/types.ts` 中新的 `CutsceneDef` / `CutsceneStep` 接口定义（代码即规格）
2. 一份示例 JSON（将现有 `prologue_opening` 按新 schema 重写）
3. `resolveActor` 优先级的代码注释

---

## 四、与业界实践的对照

### 4.1 Unity Timeline 模式

Unity Timeline 采用 **track-based 绝对时间模型**：每个对象一条轨道，关键帧按时间轴放置。适合精确的动画同步和摄影机语言。

当前项目的演出以叙事对话为主（大量 `show_dialogue` + `wait_click`），玩家交互会打断时间流。纯 track-based 模型不适合本项目，因为无法预知对话持续时长。

**启示**：计划中应明确放弃纯绝对时间模型，采用事件驱动的顺序模型。

### 4.2 Godot CutsceneDirector 模式

Godot 社区的 CutsceneDirector 模式使用 `await` 链 + 信号，与当前 `CutsceneManager` 的 `async/await` + `Promise` 风格高度相似。这种模式的优势是：

- 天然支持「等待玩家输入」类操作
- 代码可读性好（顺序阅读即可理解流程）
- 易于添加分支逻辑

当前项目已经在用这种模式，计划的重构方向（统一到 `executeAwait`）是在此基础上的正确演进。

**启示**：Timeline 不一定要引入全新的调度模型，而是在现有 await-chain 基础上增加 **多轨道并行段** 和 **条件跳转** 能力即可。

### 4.3 GDevelop Cinematic Sequencer

GDevelop 的 PR (#8305) 引入了 `CinematicSequence` / `CinematicSequenceTrack` / `CinematicSequenceKeyframe` 三层结构。这比本项目的需求更重（面向通用游戏引擎的关键帧动画）。

**启示**：本项目不需要关键帧插值系统。过场的核心是「有序执行一系列动作」，辅以并行分组。

### 4.4 通用最佳实践

| 实践 | 当前代码状态 | 计划覆盖 |
|------|------------|---------|
| 统一执行口（单一入口执行所有动作） | 部分——ActionExecutor 是统一入口，但 CutsceneManager 有自己的 switch | 是（阶段 2-3） |
| 统一实体解析 | 否——两套 | 是（阶段 1） |
| 可跳过 | 否——无 skip | **否** |
| 可取消 / 安全中断 | 部分——`destroyed` 标志位 | **否** |
| 编辑器所见即所得预览 | 部分——有 Play 按钮 | **否** |
| 数据校验与编辑器一致 | 部分——cutscene 有自己的 COMMAND_TYPES | 是（阶段 2） |
| 并行组结构化 | 否——后附式 parallel 标记 | **模糊** |
| 分支 / 条件跳转 | 否——纯线性 | 提及但未展开 |

---

## 五、修改建议汇总

### 高优先级

1. **阶段 5 拆分为 5a（数据模型）和 5b（调度器实现）**，在 5a 中明确：
   - 时间模型选型（建议：await-chain 主干 + 结构化并行段）
   - 新的 JSON schema（含并行组结构）
   - skip / cancel / fast-forward 策略

2. **在阶段 0 中增加 skip 机制的规格**——这影响 Action 接口设计（是否需要 `skipTo()` 方法或 `skippable` 属性），必须在 Action 补全之前确定。

3. **明确「纯演出全部收编为 Action」**——消除 `present` 步骤类型的不确定性，当前已有 `fadeWorldToBlack` 等视觉 Action 的先例。

### 中优先级

4. **在阶段 3 中增加编辑器改造方案**——`cutscene_editor.py` 需要从 `COMMAND_TYPES` 切换到复用 `ActionRow`。

5. **在阶段 1 中明确临时实体 ID 冲突策略**——建议编辑器校验时检查临时 ID 不与场景 NPC ID 重复。

6. **在阶段 0 中明确 `show_dialogue` 的目标实现**——建议统一走 `playScriptedDialogue` Action。

7. **并行组 JSON schema 具体化**——从当前后附式 `parallel` 标记改为显式分组结构。

### 低优先级

8. **阶段 0 输出物定义**——明确产出 TypeScript 接口 + 示例 JSON + 代码注释。

9. **增加「Timeline 与 Cutscene 关系」的推荐选项**——计划列了 A/B 两个选项但没有推荐。建议选 A（Timeline 替代当前 steps 循环），因为保留两套调度入口违反计划自身「不长期并存两套」的原则。

10. **考虑 `AbortController` / `CancellationToken` 模式**——用于安全取消正在执行的 Promise 链，替代当前的 `destroyed` 标志位轮询。

---

## 六、结论

该计划在方向上完全正确，阶段 1-4 的设计质量较高，依赖顺序合理。主要问题在于 **阶段 5（Timeline）过于粗略**，缺乏时间模型选型、skip/cancel 机制、并行组结构等关键架构决策。此外，编辑器迁移和 `show_dialogue` 的目标实现等细节需要在规格冻结阶段就确定，否则会在实现阶段产生返工。

建议在开始编码前，先将阶段 0 和阶段 5 的规格补充完整，产出 TypeScript 接口定义和示例 JSON 作为「可编译的规格文档」。
