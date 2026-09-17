# 编辑器可创作内容面 · 参考地图

> 本文是"策划模式"的配套参考:逐面板列出**编辑器实际暴露的可编辑字段、操作能力、以及危险区**——即做内容时能安全操作的范围。
> 这是 2026-06-14 对 `tools/editor/` 等编辑器代码的探查快照;**权威源是编辑器代码本身**,字段若有出入以代码为准。配合 [.cursor/skills/production-mode/SKILL.md](../.cursor/skills/production-mode/SKILL.md) 使用。

危险区的两层含义:
- **重建区(会丢数据)**:编辑器 Apply 时**整体重建**该子结构,只写它认识的字段——AI 手写的其它键,人类在编辑器里开一次面板保存就被抹掉。**绝不能往这些结构塞自定义字段。**
- **盲区(GUI 改不到)**:运行时支持、但编辑器无任何入口的字段——手写能在顶层存活,但人类用 GUI 维护不到。**落到盲区 = 超出编辑器可协作范围,应按 L2 升级或上报,而非闷头手写。**

---

## 三个通用原语(贯穿所有面板)

做内容时能往 `actions` / `conditions` / 文本里放什么,由这三个共享控件决定。

### 动作 `ActionEditor`(`tools/editor/shared/action_editor.py`)
- 挂载点:任务 `acceptActions`/`rewards`、遭遇 `resultActions`/`rewards`、热区 inspect `data.actions`、区域 `onEnter/onStay/onExit`、场景级 `onEnter`、图对话 `runActions`、档案 `firstViewActions`、cutscene action 步、pressure_holds `onComplete`/interrupts、signal_cues `actions`、小游戏 onPick/onPull* 等。
- 类型总数 130(2026-09-03 数,`ACTION_TYPES`;含位面 `activatePlane`/`deactivatePlane`——逃生舱,任务主路径用叙事状态 activePlane 点名);**这个数会漂,权威清单一律以 `ACTION_TYPES` 为准**,不要照抄本文或架构文档的旧表。
- 唯一 DEBUG-only:`setNarrativeState`(普通内容不可新建,改用 narrative 图)。
- **能嵌套子动作**(可无限层):`runActions`、`chooseAction`(每选项)、`randomBranch`(aboveActions/belowActions)、`addDelayedEvent`、`enableRuleOffers`(每槽 resultActions)。
- **有专用复杂表单**的(约 20 个):`setPlayerAvatar`、`setEntityField`、`setSceneEntityPosition`、`moveEntityTo`、`playTrajectory`(轨迹本身在独立的轨迹工作台里做,表单只选资产 / 目标 / 锚点,并能一键打开工作台)、`setHotspotDisplayImage`、`showOverlayImage`/`blendOverlayImage`、`setScenarioPhase`、`startDialogueGraph`、`playScriptedDialogue` 等;大量 id 字段是下拉选择器(scene/item/rule/quest/encounter/cutscene/audio/actor…)。
- 动作内**没有**内嵌条件控件——条件只在外层面板独立编辑。
- 手持光源那三个(2026-09-12):`attachToSocket`(多了可选 `state` = 挂件预设里的状态名)、`setPropState`(切状态 + 可选 `fadeMs`,只作用于灯)、`fadeLight`(场景灯的强度**倍率**渐变,`lightId` 走场景灯选择器)。⚠ `setPropState` **进存档**(手持物的状态是玩法事实),`fadeLight` 只是演出态;所以目前只有 `fadeLight` 在过场白名单里。
- 挂件上的一次性效果(2026-09-15):`playPropVfx`(`effect` 效果资产选择器,与 `playVfx.effect` 同一候选;`target` 演员选择器 / `socket` 按 target 动画包派生的挂点下拉,同 `setPropState`;`point` = 贴图上的点 [u,v] 0..1,带「写」勾选,不勾不写键 = 起火点 → 挂点本身)。效果跟着挂件走、放完自己收、挂件卸下立刻停;演出态(memory)、在过场白名单里。⚠ **只有挂件预设状态 `onEnterActions` 的顶层**可以把 `target`/`socket` 留空(= 这件挂件自己,运行时注入);别处(含 onEnterActions 里嵌在 runActions 等容器中的)留空校验器报 error。效果里有一直发的发射器(有 `spawn.rate` 没 `spawn.duration`,或群体)⇒ 放不完、一直冒到挂件卸下,校验器 warning。
- 火把养成的升级(2026-09-16):`setPropLevel {prop, level}`——`prop` 走**只列配了等级表的挂件预设**那档选择器(`prop_preset_leveled`,候选面 = 校验器接受面),`level` 是整数 spin、**上限跟着选中的 prop 走**(= 它 `levels` 的条数;当前值越界时不夹、留给校验器报)。等级按挂件 id 记、**进存档**(`HeldPropSystem.serialize` 的 levels 桶),所以**不进过场白名单**。危险区:挂件不存在 / 没有 `levels` 表 / 级数不在 1..级数 ⇒ error(运行时都只 log 一行、什么都不改:玩家交了材料、对话也演完了,火把一点没变)。
- 挂件的锁(2026-09-15):`lockPropState`(`target` 演员选择器 / `socket` 按 target 动画包派生的挂点下拉,同 `setPropState`;`lock` 三档下拉:**锁定不灭** `lit`(风压不掉火势、玩家按 T 熄不灭)/ **点不燃** `unlit`(玩家按 T 点不着)/ **解锁** `none`,三个参数都必填)。⚠ **进存档**(锁跟着手持物入档),所以**不在过场白名单里**;`setPropState` 永远不受锁影响。`lock` 缺 / 空 / 不认识的值 ⇒ 运行时当解锁,校验器报 error;锁只对写了「风吹灭」/「玩家操作」的挂件有意义。
- 设当前火种(2026-09-16):`setActiveIgniter`(`item` 必填,**火种选择器**:候选只列 items.json 里写了「火种」`igniter` 块的物品,与校验器接受面同一个函数 `ProjectModel.igniter_item_ids`;不是火种 / 已不存在的值保值、标「仅数据引用」)。背包里火种自带「设为火种」按钮(运行时合成、数据里不写),这条动作是给剧情里替玩家设用的;包里没有这件也设得上,按 T 时提示用完了。⚠ **进存档**(当前火种跟背包一起入档),所以**不在过场白名单里**。`item` 缺 / 空、物品不存在、物品没写 `igniter` ⇒ 运行时 warn 一行、什么都不设,校验器报 error。

### 条件 `ConditionEditor`(`condition_editor.py` + `condition_expr_tree.py`)
- 挂载点:`preconditions`/`completionConditions`/`unlockConditions`/`discoverConditions`/option 门控/dynamicDescriptions/nextQuests 边/热区·区域·NPC conditions 等。
- 5 类叶子:`flag`(key+op `== != > < >= <=`+值,值可插 `[tag:…]`)、`quest`(Inactive/Active/Completed)、`scenario`(scenario+phase+status+可选 outcome)、`scenarioLine`(inactive/active/completed)、`narrative`(graph+state+`reached`)。
- 组合:`all`/`any`/`not`,嵌套深度 ≤32。

### 文本 RichText(`rich_text_field.py` + `tag_catalog.py`)
- 8 种 `[tag:…]`:`string`/`flag`/`item`/`npc`(含 `@context`)/`player`/`quest`/`rule`/`scene`,经"插入引用"对话框生成。
- **`[img:…]` 插图按钮只在档案编辑器**(人物簿/见闻录/杂书匣/书籍 content);其它富文本框只能手打 `[img:短名]`(运行时与校验器认,但 GUI 无引导)。
- 纯文本(不可插 tag):所有 `id` 字段、fragment 的 `ruleId`(只读)。

---

## 场景 / 世界(`scene_editor.py`)

> 位面归属:hotspot/NPC/zone 详情面板均有「位面归属」行(多选自 planes.json,缺省=存在于所有位面;含保值孤儿项)。
> 时段归属:hotspot/NPC/zone **以及场景分组**四处详情面板均有「时段归属」行(多选自 `game_config.dayNight.phases`,写 `phases` 字段;**只在场景勾了「参与日夜循环」时生效**)。缺省是**三级就近取用**——成员自己写的 → 所属分组写的 → 种类缺省(NPC=只在勾了 daylight「街上有人」的那几段;热点/区域=所有时段都在);成员与分组都写了则取**交集**。分组自己缺省=不施加限制(它是异构容器,可能同时装着人和门,不套用 NPC 那条「只在白日」)。**别再用 `conditions` 里的 `{timePhase:…}` 表达分组的时间**——那条在另一层、不吃日夜总闸,且与成员的 NPC 缺省纯 AND 对撞(2026-08-26 前雾津送葬队伍 13 人就是这么死的)。
> 2026-07-18 起:场景编辑器支持撤销/重做(Ctrl+Z,场景内增删改/拖动/gizmo/分组各为一条命令;跨文件重构仍走「重构→撤销上次重构」)、左栏实体树(类型/分组视图+过滤,与画布双向同步)、多选(树 Ctrl/Shift+画布框选;批量拖动/删除/复制/指派分组)。
> 组动作 setGroupEnabled/moveGroupBy 按 group 寻址,作用于当前场景的 NPC / 热区 / **区域三类**——zone 已被消费:`setGroupEnabled` 走组会话通道,zone 随之从 ZoneSystem 注册/反注册(`SceneManager.shouldRegisterZoneWithZoneSystem`);`moveGroupBy` 整体平移 zone 的 polygon(`SceneManager.moveCurrentSceneGroupBy`)。

| 实体 | 可编辑字段 | 操作 |
|---|---|---|
| **场景顶层** | name / worldWidth / worldHeight(可锁宽高比) / worldScale / bgm / filterId / camera.zoom / camera.pixelsPerUnit / playerWalkSpeed / playerRunSpeed / ambientSounds / onEnter(场景级动作) / depthConfig.depth_tolerance + floor_offset / **perspectiveScale(透视缩放:启用开关+近/远端缩放+midStops 中途点表+affectsSpeed;画布橙色箭头拖两端设深度轴,任意方向;缺省不写键=不缩放)** | 无"新建场景"入口 |
| **热区 hotspot** | 通用:id / type(inspect/pickup/transition/npc/encounter) / label(富文本) / x / y / interactionRange / **scale / rotation(实例 transform,quad 级真变换;缺省 1/0 不写键;画布 gizmo 可拖)** / **perspectiveScaleEnabled(透视缩放参与,三态下拉;热区缺省不参与)** / **group(分组标签,树右键/多选页指派)** / **planes(位面归属)** / **phases(时段归属;缺省=所有时段都在)** / autoTrigger / cutsceneIds / cutsceneOnly / conditions / conditionHidesEntity / displayImage / collisionPolygon。data 见下 | 增/删、画布拖位置+拖碰撞多边形+transform gizmo |
| **区域 zone** | id / zoneKind(standard/depth_floor) / floorOffsetBoost(仅 depth_floor) / polygon(画布画/拖/插删点) / **group(分组标签)** / **planes(位面归属)** / **phases(时段归属;缺省=所有时段都在)** / conditions / onEnter / onStay / onExit(均仅 standard) | 增/删、画布编辑多边形 |
| **NPC** | id / name / x / y / initialFacing / dialogueGraphId / dialogueGraphEntry / dialogueCameraZoom / interactionRange / **scale / rotation(实例 transform,同热区)** / **perspectiveScaleEnabled(透视缩放参与,三态下拉;NPC 缺省参与、renderRaw 缺省不参与)** / **group(分组标签)** / **planes(位面归属)** / **phases(时段归属;缺省=只在勾了 daylight「街上有人」的那几段——与热点/区域不同,别照抄)** / cutsceneIds / cutsceneOnly / conditions / conditionHidesEntity / animFile / initialAnimState / initialAnimPlayback(speed/reverse/holdFrame/startFrame,进场起播一次性生效,-1=未设) / patrol / collisionPolygon | 增/删、画布拖位置+巡逻折线+transform gizmo |
| **场景分组 entityGroups** | id / label / **phases(时段归属;缺省=不施加限制,成员各回各自缺省)** / conditions(「整体显影条件」,叙事/任务状态用它;**时间不要写在这里**) / 位置与整体位移(Δx/Δy——分组自身没有坐标,偏移直接烘进每个成员) / 成员列表(只读,由成员的 group 字段派生) | 增/删、画布整组拖动;旧场景只有成员 group 标签时不写 entityGroups,编辑并 Apply 后才升格为显式分组实体 |
| **出生点** | key(default 只读) / x / y | 增/删(default 不可删) |

**热区每种 type 的 `data`(均整体重建)**:
- inspect:Actions 模式 `{actions}` 或 图对话模式 `{graphId, entry, actions}`。**`data.text` 无控件、会被丢。**
- pickup:`itemId` / `itemName` / `count` / `isCurrency`
- transition:`targetScene` / `targetSpawnPoint`
- npc:`npcId`;encounter:`encounterId`

**危险区**
- 重建区:`hotspot.data`(尤其 inspect `data.text`)、`npc.patrol`(只 route/speed/moveAnimState)、`spawnPoint`(只 `{x,y}`)。
- 主动删除:`zone.x/y/width/height/ruleSlots`、`npc.dialogueFile/dialogueKnot`;切 depth_floor 会删 zone 的 onEnter/onStay/onExit。
- 盲区:`backgrounds`(主编辑器不可编辑,只「角色照明实验室」或手写)、`depthConfig` 主体(M/shader/collision/depth_map…只实验室烘焙导出;`tools/scene_depth_editor` 已于 2026-07-23 整体删除)。
- 盲区(2026-09-12 新增):场景顶层 `wind`(场景风:方向/风速/阵风/湍流/粗糙度/粒子与草木两路增益,顶层键手写安全、Apply 保留;游戏里 F2「粒子」页可临时拖风速倍率与两路增益、不落盘,读数抄回 JSON)。见 agent_docs `scene-wind`。
- 粒子布置(2026-09-14 起**不在场景 JSON 里、主编辑器只读**):布置库 `assets/data/vfx_placements.json`(按场景 × 时段外观各一份)的唯一作者面是粒子工作台——布置、锚点、发射区域 `area` / 范围区域 `confine.area`、边带 / 限高都在那里改。主编辑器场景页 vfx 那一栏只剩「显示时段外观」下拉 + 只读摘要 + 「刷新粒子数据」,画布上只读地画出两块区域与锚点(不吃鼠标);效果带光柱(体积光,效果资产 `beams[]`,也在粒子工作台里摆)的,再只读地画光柱的起点、起点→终点中轴与画面轮廓(与运行时同一个凸包,有深度用轨迹工作台那份几何、没有走平面近似)。场景 JSON 里残留旧 `vfx` 键 = 校验器 error(运行时不读),场景页给一个删除按钮。见 agent_docs `vfx-system`「布置」、`vfx-workbench`「布置」。
- 透视缩放深度轴:场景面板启用后画布出现橙色箭头(近端■大→远端○小),拖两端手柄设任意方向的深度轴;等缩放等值线自动垂直于轴。竖直轴=普通上下纵深,斜轴=斜街。
- 透视缩放下的碰撞多边形:可编辑多边形按 authored 空间显示(顶点拖拽/表格写回零换算);参与透视且系数≠1 时另画**只读虚线幽灵轮廓**=运行时实际命中面(authored 多边形绕锚点×f,与 anchorCollisionPolygonToWorld 同口径)。展示图/交互圈/NPC 精灵预览直接按系数缩放。
- 无复制、无列表重排;`anim.json` 场景编辑器内只读(states 等廉价参数去「动画」面板改,图集像素布局靠 video_to_atlas 导出)。

---

## 图对话(`tools/dialogue_graph_editor/`)

7 种节点:`line`(speaker.kind player/npc/literal/sceneNpc + text + 可选多拍 lines[] + next)、`choice`(可选 promptLine + options[id/text/next/requireFlag/costCoins/ruleHintId/disabledClickHint/requireCondition])、`switch`(cases[条件+next] + defaultNext,条件可 AND 内联或结构化树)、`runActions`(next + ActionEditor)、`ownerState`/`contextState`(按叙事图状态分支)、`end`。

- 连边:检查器 `next` 框 + "选…"节点选择器,或**图形画布拖端口连线**。
- 条件:结构化树(5 叶子);switch 的 AND 内联模式只支持 flag/quest/scenario。
- **危险区(重建)**:被打开编辑过的节点 getter 从头重建,丢未知字段;未编辑的节点原样保留。图级 `preconditions` 非 dict 叶子被单独保留。

---

## Cutscene 过场(`timeline_editor.py`)

- 顶层:id / targetScene / targetSpawnPoint / targetX / targetY / restoreState / hideMetaHud(旧 `commands` 被 pop)。
  `hideMetaHud` = 这段过场里连三把火/气味一起淡出;**缺省不写 = 不隐藏**,勾上才写 `true`(不写 `false`)。
- 15 种 present:fadeToBlack / fadeIn / flashWhite / waitTime / waitClick / showTitle / showDialogue(speaker+text+scriptedNpcId) / showImg(id+image) / hideImg / showMovieBar / hideMovieBar / showSubtitle(classic position 或 movie band+align+可选 subtitleVoice/subtitleEmote) / cameraMove(x/y/duration+可选easing,可地图点选) / cameraZoom(scale/duration+可选easing) / showCharacter(visible)。easing 下拉:linear/easeIn/easeOut/easeInOut,缺省=运行时默认曲线。
- 台词两类(showDialogue / showSubtitle)另带「逐字显示」勾选(`typewriter`):**缺省分家**——对白框逐字、字幕整句;**只写偏离缺省的那一侧**(对白框取消勾选写 `false`,字幕勾上写 `true`),回到缺省即删键。
- action 步:type 来自 33 项白名单(`src/data/cutscene_action_allowlist.json`),白名单外+改存档的被拒。
- parallel:tracks[] 可嵌套 present/action/parallel。
- 步骤增删、折叠大纲拖拽重排。
- **危险区**:已知 present 步的 schema 外字段会丢(未知 present type 反而靠 deepcopy 保住)。

---

## 叙事图 narrative_graphs(Web `tools/narrative_editor_web/`)

- compositions(mainGraph + elements:wrapperGraph/scenarioSubgraph/各 blackbox)、states(label/description/initial/broadcastOnEnter/**activePlane 位面点名下拉**/onEnterActions/onExitActions)、transitions(trigger signal/reactive*/conditions/priority;from/to 须画布连线)、signals(作者信号 id/label/notes;派生信号自动生成)。
- 动作经原生 ActionEditor;条件经 ConditionBuilder。
- 危险区:transition from/to 只读(画布改);旧跨图端点不可编辑;state.meta 无 UI。

---

## scenarios / document_reveals / overlay_images(`narrative_data_editors.py`)

- **scenarios**:id / manualLineLifecycle / description / requires(与/或/JSON) / exposeAfterPhase / exposes(flag→值表) / phases(phase名+status+requires,可拖排);`dialogueGraphIds` 只读。**危险区:phase 的 `outcome` 无 UI 且被丢。**
- **document_reveals**:id / blurredImagePath / clearImagePath / revealCondition(5 模式) / animation.durationMs+delayMs / revealedFlag / overlayId / xPercent/yPercent/widthPercent。
- **overlay_images**:短id → 路径。

---

## 玩法系统数据

| 面板 | 文件 | 可编辑字段(节选) | 操作 / 危险区 |
|---|---|---|---|
| **位面** `plane_editor` | planes.json | id/label/movement(driftX/driftY/speedScale/allowRun)/interaction(canPickup/canInteractHotspots/canTalkNpcs)/camera.zoom/healthDrainPerSec/lighting(专家 JSON) | 增删;**normal 拒删、id 只读**;数值往返保真(6 位小数) |
| **任务** `quest_editor` | quests.json + questGroups.json | 任务:id/group/type/sideType/title/description/preconditions/completionConditions/acceptActions/rewards/nextQuests(边:目标+bypassPreconditions+条件)/objectives(id/文案/可选/完成条件 completeWhen/显示条件 visibleConditions/本目标引导)/guidance/announce/autoFocus;分组:id/name/type/parentGroup | 增删、拖拽改父子(带环检测)、无复制;**删 nextQuestId(deprecated)** |
| **遭遇** `encounter_editor` | encounters.json | id/narrative/options(text/type/requiredRuleId/requiredRuleLayers 象理术/conditions/consumeItems/resultActions/resultText) | 增删、选项上下移、生成唯一 id |
| **规矩** `rule_editor` | rules.json | 规矩:id/name/incompleteName/category/三层(text/lockedHint/verified);碎片:id/text/ruleId(只读)/layer/source | 增删;**删旧 verified/description/source...**;空层回填 |
| **物品** `item_editor` | items.json | id/name/type/description/maxStack/buyPrice/**icon**(资源路径选择器,自动入 runtime/images/icons)/dynamicDescriptions(conditions+text)/tags/use(背包里主动使用:label/consume 三态/disableHint/resultText/conditions/actions);**火种** `igniter`(「火种」折叠块,勾「是火种」才写对象:一份能点几次 `uses`(整数 ≥1,新勾时为 1 不写键 = 缺省 1)·点着要多久 `seconds`(秒,>0)·风限 `windLimit`(m/s,>0,火把头风超过就点不着);没写 use 的火种背包里**自动**给「设为火种」按钮,use 区与火种区都有一行提示;写了 use 就按 use 走、不给这枚按钮,提示变红) | 增删;dynamicDesc **只能加不能删单条**;icon 留空即删字段,背包退回文字显示。**火种危险区**:运行时不清洗这一块——`seconds` / `windLimit` 缺或不是 >0 的数 ⇒ 一按就点着 / 风再大也不灭(error);`uses` 不是 ≥1 的整数 ⇒ 运行时向下取整、<1 当 1(error);`igniter` 不是对象(true 之类)⇒ 当火种却读不出参数(error),写成 null/false ⇒ 当不是火种(warning);不认识的键 ⇒ warning;既写 igniter 又写 use ⇒ warning(不给「设为火种」)。表单往返:没动的键原样回吐盘上值(坏值、int/float 表示、不认识的键、键序都不改),勾掉「是火种」= 删键 |
| **商店** `shop_editor` | shops.json | id/name/items(itemId+price 表) | 增删行;price 总会写出 |
| **挂件预设** `prop_preset_editor` | prop_presets.json | id/label/贴图(单张或多帧)/支点 anchorX·Y/自转/缩放/吃不吃光(三态);**火焰**(起火点 `firePoint` [x,y] 贴图归一化·看得见的火苗 `flame`{image 图集·cols·frames·fps·height 满火一格高 wu}·燃烧强度 `burn` 0..1(帧动画火苗高度,**以及该状态全部粒子挂载**的发射率 × burn、新生粒子大小 × (burn × 闪烁)^0.4,缺省 1)·挡风比例 `windShelter` 0..1(护火:火苗倾斜的气流与**全部粒子挂载吃的场景风**都乘 1−挡风,缺省 0);burn / 挡风都**不改灯的数值**(但物理闪烁读的气流是挡过风的,见下));**自带光源**(挂点·偏移·色温或颜色·强度·作用半径·软化半径·投不投影·闪烁 `flicker` 两种写法,「种类」下拉切:**明火(物理)** `{kind:"flame", diameter 燃烧面直径 m, puffAmp 喘的幅度 0..1 不写=0.1}` / **炭火(物理)** `{kind:"ember", diameter}`(火把用)/ **正弦(老写法)** `{amp, hz, windAmp}`(灯笼用,逐项调过、别改种类);切种类 = 写上这一种的键、删掉另一种的键,闪烁控件整块没动过就原样回吐磁盘那块);**粒子挂载** `particles`(契约 v3,取代旧 `vfx`:每行 = 效果资产选择器 + 可选挂点 x/y + 在预览上点选,可增删上下移;挂点不写 = 起火点,再没有 = 挂点本身;跟着支点/自转/缩放/镜像走);**状态表**(点着/护火/残炭/灭:每态各自的贴图·摆放·灯·**粒子挂载(两态:沿用基础块 / 本状态自己的列表,可为空)**·**起火点覆盖·burn·挡风 windShelter·进入时动作 `onEnterActions`**;进入时动作里可用 `playPropVfx` 在这件挂件上播效果,顶层的 target/socket 留空 = 这件挂件;**风吹灭 `blowout` 三态(沿用基础块 / 这个状态吹不灭 `null` / 这个状态自己的一块,整块替换)**)+ 初始状态;**风吹灭** `blowout`(基础块「风吹灭」块,勾「风能吹灭」才写键:吹熄风速 `windSpeed` m/s·掉速 `drainSeconds`(两倍吹熄风速下几秒从满到底)·回速 `recoverSeconds`(无风几秒回满)三个必填 > 0;可选 残炭线 `emberBelow` 0..1(带「写」)·残炭状态 `emberState`/灭状态 `outState`/**挡风复燃回到** `recoverState`(本预设状态名下拉,不写 = ember / out / lit;复燃 = 残炭里挡住风(护火 / 风停)、火势回到残炭线上方一截时自动切回,没写残炭线或不勾自动切状态时不生效)·「越线自动切状态」`auto`(勾着不写键,不勾写 false = 只执行越线动作)·渐变 `fadeMs`(不写 = 500);越线动作 `onEmberActions`/`onOutActions`(同进入时动作的动作列表,顶层 `playPropVfx` 留空 target/socket = 这件挂件,要推剧情就放 `emitNarrativeSignal`,算实发信号));**玩家操作** `playerControl`(只在基础块,勾「玩家可操作(T 点火/熄灭,按住 Q 护火)」写对象:点火 / 护火 / 熄灭切到的状态 `litState`/`guardState`/`outState`(下拉,不写 = lit / guarding / out)·熄灭 / 点火渐变 `extinguishFadeMs`/`igniteFadeMs`(不写 = 400 / 250)·**快灭提示线** `hintBelow` 0..1(带「写」;火势掉到这以下火边出快灭符号,残炭时一直出;0 = 不提示;不写 = 0.8));persistent(手持物,入档);**有试挂预览**(可切状态看;画起火点青色斜十字 + 按当前状态 burn×满火高度画第 0 帧火苗 + 每个粒子挂点一个小圆点标效果 id(粒子本身不模拟,去粒子工作台 / 游戏里看);「点选起火点」在图上点/拖设置,状态自己覆盖了起火点就写那个状态,否则写基础块;粒子挂载行尾「点选」写那一条的挂点);**耐久(燃料)** `fuel`(只在基础块,勾「有耐久」才写键 = 临时火把、烧完就没;不写 = 没有耐久(随身那根旧纤藤)。能烧几秒 `seconds` 必填 > 0·风里烧得快 `windFactor`(带「写」,每秒烧掉 1 + 它 × **挡过风之后**的气流 m/s,不写 = 0.1)·烧完切到 `outState`(本预设状态名下拉,不写 = 跟 blowout.outState,再没有 = out)·烧完之后 `onSpentActions`(同越线动作的动作列表:临时火把在这里 detachFromSocket + removeItem 把自己收掉));**效果块(脾气)** `effects`(只在基础块,每行一个效果块选择器 + 一行只读摘要「这一块乘了什么」,可增删上下移;至多 2 块,**与等级带的合起来算**,超了不拦、亮红字 + 校验器 error);**等级** `levels`(只在基础块,嵌套主从列表:左列「第 N 级 + 名字」、右侧 名字 `label` 必填 / 贴图 `image`(资源选择器,不填 = 沿用基础块那张) / 效果块 `effects`(同上,与预设自己那串合起来算上限) / 备注 `note`;**顺序就是等级**,给上移/下移;不写 = 这根不能升级(恒第 1 级));**玩家操作**里多一档 `guardBlocksRun`(三态:不写 = 缺省 true 护着火只能走不能跑) | 粒子挂载、火焰、灯与状态表四块默认折叠·懒建;状态里的"灯"是**三态**(沿用基础块 / 本态没有灯 / 本态自己一盏),别做成两态;灯的数值在游戏 F2「挂点」页调好回填(编辑器里凭空填不准)。**火焰 / 粒子危险区**:`flame.image` 空或 `flame.height` ≤0 ⇒ 运行时**整块作废、火苗不画**(不报错);**旧 `vfx` 字段已删**——写了运行时不读、那团效果根本不放,校验器报 error「已由 particles 取代」;`particles` 里非对象 / `effect` 空的条目运行时**逐条丢弃**,`point` 形状坏当没写;**状态写了 `particles` 键(哪怕 `[]`)就整体替换基础块那一串**,没写键才沿用;`burn` 乘的是该状态**全部**粒子挂载,所以只给复用点着那团火、烧得弱的状态调(护火 = 同一个火焰效果 × 0.75),自己挂了专门效果的状态(残炭 / 熄灭那口烟)留缺省 1——**状态上写 burn 0 = 它自己的效果一个粒子都不发、爆散按大小 0 出生**;`burn`/`windShelter` 按 `Number()` 强转,`null` 是 0 不是没写(burn:null=火灭),非数 ⇒ 当没写(沿用上一层,最终 burn 1 / 挡风 0);`windShelter` 与灯的「吃风」`flicker.windAmp` 是两件事,别拿它调灯(物理闪烁不读 windAmp:气流 = 火把处场景风 − 人走动,× (1 − 挡风),挡风在这里**会**让明火灯亮回来);**闪烁危险区**:`kind` 只认严格的 `"flame"`/`"ember"`,别的值运行时静默按正弦解析(没 amp/hz 就整块丢,校验器报 error);物理写法 `diameter` 不是 > 0 的数 ⇒ 整块丢、灯不闪(error);写了 kind 又写 amp/hz/windAmp、炭火写 puffAmp、puffAmp 越界/非数 ⇒ warning;状态灯的 `flicker` **整块替换**基础块那块(不逐项合并,不写 = 沿用);`firePoint` 形状坏 ⇒ 当没写(灯位/没写挂点的粒子/火苗全从挂点本身出),越界 ⇒ 夹到 0..1;`flame` **只在基础块**,写在状态里运行时不读;`onEnterActions` **只在状态里**(基础块写了不执行),只在真的切换进该状态 / attachToSocket 挂上的初始状态时执行,读档重挂与切场景重挂**不执行**;进入动作与物件用途同一条动作校验链,若哪天 `setPropState`/`attachToSocket` 进了过场白名单,进入动作里任何白名单外的动作校验器报 error。火苗高度与挂件 `scale` 无关。**风吹灭 / 玩家操作危险区**:`blowout` 三个必填量任一缺 / ≤0 / 非数 ⇒ 基础块**整块丢掉 = 吹不灭**、状态里**当没写沿用基础块**(error);基础块 `blowout` 不是对象(含 null)⇒ error(null 只在状态里 = 这个状态吹不灭);`emberBelow` 越界夹 0..1、状态名不在本预设 states 里(运行时只 log、不切,只执行越线动作;`recoverState` 对不上 = 挡住风也不复燃)、`auto` 非布尔、`fadeMs` < 0 ⇒ warning;**灭状态自己写一块 blowout ⇒ warning(灭了不再算火势,写了不生效)**;`onEmberActions` 写了却没写 `emberBelow` ⇒ warning(永远不执行);越线动作走与进入时动作同一条动作校验链;`playerControl` 不是对象 ⇒ error、切到的状态不在 states 里 / 渐变 < 0 / `hintBelow` 越界(运行时夹 0..1)或读不出数(当没写 = 0.8) ⇒ warning、写在状态里 ⇒ warning(运行时只读基础块)。**火把养成危险区**:`fuel.seconds` 不是 > 0 的数 ⇒ 运行时**整块 fuel 当没写** = 这根变成烧不完的(error);`fuel.outState` 不在 states 里 ⇒ 烧完切不过去、火把看着还燃着(warning);`effects` / `levels[*].effects` 里的 id 不在 prop_effects.json ⇒ 运行时跳过这一块、这支火把的脾气就没了(error);合起来超过 2 块 ⇒ 运行时只认前两块(error);同一块写两遍 ⇒ 倍率连乘两次(warning);`levels[i].label` 空 ⇒ 运行时**这一条整条不算一级**、级数变少、`setPropLevel` / `propLevel` 从此越界(error);`levels` 为空数组 ⇒ 当不能升级(warning);`guardBlocksRun` 非布尔 ⇒ 当没写按 true(warning);**`fuel` / `effects` / `levels` 写在状态里运行时不读**(warning) |
| **挂件效果块** `prop_effects_editor` | prop_effects.json | id/名字 `label`(必填)/备注 `note`;**倍率**(全是乘数,1 = 不改,每项带「写」勾选,不勾 = 不写键):火旺 `burn`·烧得快 `fuelRate`·火头长 `igniterFlame`·光 `light`{亮度 `intensity`·照多远 `range`}·抗风 `wind`{吹熄风速 `windSpeed`·掉得慢 `drainSeconds`·回得快 `recoverSeconds`·残炭线 `emberBelow`};**对世界的影响** `fields`(每行:种类下拉 驱 `fear` / 招 `attract`·标签 `tag`(手打,与粒子群体认的标签对得上才有用,同 `emitVfxField.tag`)·半径 `radius` wu·强度 `strength`,可增删上下移);**标签** `tags`(手打列表,`heldProp` 条件叶的「效果块」写 id 或写这里的标签都命中) | 主从列表 + 即改即写模型(同「气味 Profile」,无 Apply 按钮;Ctrl+S 统一落盘)。改名会**一并改写**挂件预设里的 `effects` / `levels[*].effects` 与内容里 `heldProp` 条件叶的 `effect` 引用(写成**标签**的不跟着 id 改——标签由这一块自己的 `tags` 管);还被用着的不许删(左下角实时列出「用它的挂件预设」;「查引用」按钮再扫全工程条件叶——那一半要读盘上所有对话图,故不挂在选中事件上,改名 / 删除无论如何都跑全量)。危险区:数值**只收 > 0**——0 / 负数 / 写成串一律**当没写这一项**(作者想「把亮度按到 0」,得到的是「亮度一点没变」,画面上完全看不出来),校验器对 ≤ 0 报 error、对 = 1 报 warning(写了等于没写);`label` 空 ⇒ 运行时回落成 id(error);`fields` 一条里四项缺一 / 半径与强度不是 > 0 的数 ⇒ **整条跳过**,虫子照旧不躲不来(error);不认识的键运行时静默丢掉(warning);一支火把至多挂 2 块(上限在挂件预设页那边提示 + 校验) |
| **地图** `map_editor` | map_config.json | sceneId/name/x/y/unlockConditions | 增删、**画布拖坐标** |
| **档案** `archive_editor` | archive/{characters,lore,slang,documents,books}.json | 人物:name/title/unlock/firstViewActions/impressions+knownInfo(条件+文);见闻/文档:title/content(可插图)/source/category;**怪话册:title/content/example/source/note/category+分类与集齐评语**;书籍:三级 Book→Page→Entry | 增删条目;**book page 不能删、impressions 只能加不能删;切换未 Apply 会丢** |

- 条件统一 `ConditionEditor`,动作统一 `ActionEditor`,玩家可见文本统一 RichText。
- 条件树叶子类型(`condition_expr_tree`):Flag / 任务 / Scenario 阶段 / Scenario 线 / 叙事状态 / 活计计数 / 激活位面 / 玩家姿态 / 时段 / **手持挂件** `heldProp`(2026-09-15) / **挂件等级** `propLevel`(2026-09-16,火把养成)。挂件等级叶 = 「这根挂件升到第几级」(读存档里的等级,与拿没拿在手上无关,收在包里也算;物品描述按等级变、升级对话的前置都写它):**挂件** `propLevel`(必填,弹窗选择器,**只列配了等级表的预设**)·**op**(下拉 == != < <= > >=,不写 = `>=`)·**value**(整数 spin,上限跟着选中的挂件走)。危险区:挂件不存在 ⇒ error;挂件没有 `levels` 表 ⇒ warning(运行时恒第 1 级,这条比较不是恒真就是恒假);`op` 不认识 / `value` 非数 ⇒ error;比的级数超出 1..级数 ⇒ warning。挂件预设改名会跟改条件叶里的 `propLevel`。`heldProp` 的新增三项(2026-09-16)危险区:`fuelOp` / `fuel` 落单或越界 ⇒ error;`effect` 既不是效果块 id 也不是任何一块的标签 ⇒ warning(恒为假)。手持挂件叶 = 「这个人身上**有一件**挂件同时满足写了的每一项」(读实时世界状态,不是 flag;手上没东西 ⇒ 假):**谁手上** `heldProp`(必填,弹窗选择器:player + 全工程 NPC + 过场临时演员 + 轨迹生成对象)·**挂点** `socket`(可筛选下拉,候选按那个人的动画包挂点派生、取不到可手打)·**挂件** `prop`(挂件预设弹窗选择器)·**状态** `propState`(下拉:选了挂件列它的 states,没选列全工程状态名)·**燃着** `burning`(不限 / 燃着 / 没燃)·**火势** `vitalityOp` + `vitality`(运算符 < <= > >= + 0..1,一对一起写,不限 = 两个都不写)·**燃料** `fuelOp` + `fuel`(与火势同一套:运算符 + 0..1,一对一起写;没配耐久的挂件恒 1)·**效果块** `effect`(弹窗选择器,候选 = prop_effects.json 的效果块 id **∪** 它们的标签——运行时两样都命中,所以「手上拿的是驱虫的火把」不用点名是哪一支)·**锁** `lock`(不限 / 锁定不灭 / 点不燃 / 没上锁);没选的项一律不写键。「手上没有燃着的东西」= 否定(not) + 本叶子选燃着。危险区:`prop` 不在预设表、`propState` 不在该预设 states、`lock` / `vitalityOp` 不认识、`vitality` 非数或越界、运算符与阈值落单 ⇒ error(运行时恒假或当没写);人找不到、没选挂件时状态名全工程都没有、`burning` 非布尔 ⇒ warning。挂件预设改名会跟改条件叶里的 `prop`。⚠ 叙事图(叙事状态机页)的条件不收这类叶子(TS 权威 `narrativeGraphValidation` 只认 narrative/flag/quest/scenario/scenarioLine/plane/narrativeCount)。

---

## 配置 / 系统 / 小游戏

| 面板 | 文件 | 可编辑 | 危险区 |
|---|---|---|---|
| **game_config** | game_config.json | initialScene/initialQuest/fallbackScene/initialCutscene/initialCutsceneDoneFlag/viewport/windowSize/startupFlags | 盲区:playerAvatar(独立编辑器)/entityPixelDensityMatch(*) |
| **strings** | strings.json | 分类树 + 键(值 str/number/bool,str 富文本) | **不能删键/分类**;数组叶子被压成字符串 |
| **audio** | audio_config.json | bgm/ambient/sfx(id+src 文件选择)/systemSfx(key→sfx id) | 每条只写 `{src}`,volume/loop 等会被丢 |
| **filter** | filters/*.json | id(=文件名,只读)/matrix[20]/alpha | id 不可改名(只能删建) |
| **flag_registry** | flag_registry.json | static(key+valueType)/patterns(id/prefix/suffix/idSource/valueType) | **`migrations`/`runtime` 块 GUI 完全不暴露**(原样保留,需手改) |
| **action_registry** | (无文件) | 只读汇总视图 | — |
| **动画包** | runtime/animation/*/anim.json | states 表(name/frames/frameRate/loop/refSpeed=步速匹配基准·留空不参与)/worldWidth/worldHeight | 图集布局(cols/rows/cell/atlasFrames)只读,改布局回产线重导;refSpeed 仅移动类状态有意义 |
| **pressure_holds** | pressure_holds.json | id/prompt/releaseHint/fillSeconds/decayPerSecond/holdSfx/barColor/interrupts(atRatio/resetToRatio/abort+ActionEditor)/onComplete | barColor/holdSfx 裸输入 |
| **signal_cues** | signal_cues.json | id/description/actions | — |
| **水域小游戏** | water_minigames/index+实例 | label/spotId/surface(location/time/weather)/bounds/waterBottom/entities(category/sprite/pos/depth/displaySize/hitRadius/motion/pull/valueTier/cue/hint/onPick/onPullSuccess/onPullFail);**有画布** | displaySize/hitRadius 留空=按品类默认(不写键) |
| **转盘小游戏** | sugar_wheel/index+实例 | 外观资源/分格指针校准/蓄力曲线/物理停针(12 项)/beforeCharge(条件+动作)/speechAnchors/sectors(actions)/atmosphereGroups;**有画布** | speechMaxVisible 被删;payload 须合法 JSON |
| **扎纸小游戏** | paper_craft/index+实例 | 实例 label/backgroundImage;订单 title/desc/correctPaper/合格分/警告分/targetHint/finishQuestion/onSuccess·Warn·BadActions;部件 label/score/tags/image;槽位 label/可选/坐标/accepts;纸色 label/score/tint/tags;收尾 label/score/tags。实例/订单及各子集合均可增删·重排;**槽位有画布** | 盲区:几乎无(高级字段已补齐) |

**小游戏通用**:`index.json` 登记 `{id,label,file}` + 各实例独立文件;实例内 `id` 必须 == index 行 id;删实例不清理盘上旧 `<id>.json`(需手动清/走 DVC)。

---

## 给策划模式的一句话准则

场景顶层 + hotspot/npc/zone 的**顶层**键手写安全(Apply 保留);但 **hotspot.data、npc.patrol、spawnPoint、被编辑的对话节点、scenario.phase、已知 present 步、音频条目** 是"重建区",只能写编辑器认识的字段。需求一旦落到**盲区**(cameraX/cameraY、migrations/runtime、扎纸高级字段、非档案 `[img:]` 等),即超出编辑器可协作范围 → 按 L2 升级(补编辑器支持)或上报,不要闷头写人类维护不了的 JSON。
