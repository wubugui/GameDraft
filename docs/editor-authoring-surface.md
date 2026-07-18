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
- 类型总数 102(`ACTION_TYPES`,含位面 `activatePlane`/`deactivatePlane`——逃生舱,任务主路径用叙事状态 activePlane 点名);权威清单以 `ACTION_TYPES` 为准,不要照抄架构文档旧表。
- 唯一 DEBUG-only:`setNarrativeState`(普通内容不可新建,改用 narrative 图)。
- **能嵌套子动作**(可无限层):`runActions`、`chooseAction`(每选项)、`randomBranch`(aboveActions/belowActions)、`addDelayedEvent`、`enableRuleOffers`(每槽 resultActions)。
- **有专用复杂表单**的(约 20 个):`setPlayerAvatar`、`setEntityField`、`setSceneEntityPosition`、`moveEntityTo`、`setHotspotDisplayImage`、`showOverlayImage`/`blendOverlayImage`、`setScenarioPhase`、`startDialogueGraph`、`playScriptedDialogue` 等;大量 id 字段是下拉选择器(scene/item/rule/quest/encounter/cutscene/audio/actor…)。
- 动作内**没有**内嵌条件控件——条件只在外层面板独立编辑。

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
> 2026-07-18 起:场景编辑器支持撤销/重做(Ctrl+Z,场景内增删改/拖动/gizmo/分组各为一条命令;跨文件重构仍走「重构→撤销上次重构」)、左栏实体树(类型/分组视图+过滤,与画布双向同步)、多选(树 Ctrl/Shift+画布框选;批量拖动/删除/复制/指派分组)。
> 组动作 setGroupEnabled/moveGroupBy 按 group 标签寻址,首期只作用于当前场景的 NPC/热区(zone 可挂 group 标签但暂不被组动作消费)。

| 实体 | 可编辑字段 | 操作 |
|---|---|---|
| **场景顶层** | name / worldWidth / worldHeight(可锁宽高比) / worldScale / bgm / filterId / camera.zoom / camera.pixelsPerUnit / playerWalkSpeed / playerRunSpeed / ambientSounds / onEnter(场景级动作) / depthConfig.depth_tolerance + floor_offset / **perspectiveScale(透视缩放:启用开关+基准线表 y×scale+affectsSpeed;画布橙色虚线可拖 y;缺省不写键=不缩放)** | 无"新建场景"入口 |
| **热区 hotspot** | 通用:id / type(inspect/pickup/transition/npc/encounter) / label(富文本) / x / y / interactionRange / **scale / rotation(实例 transform,quad 级真变换;缺省 1/0 不写键;画布 gizmo 可拖)** / **perspectiveScaleEnabled(透视缩放参与,三态下拉;热区缺省不参与)** / **group(分组标签,树右键/多选页指派)** / autoTrigger / cutsceneIds / cutsceneOnly / conditions / conditionHidesEntity / displayImage / collisionPolygon。data 见下 | 增/删、画布拖位置+拖碰撞多边形+transform gizmo |
| **区域 zone** | id / zoneKind(standard/depth_floor) / floorOffsetBoost(仅 depth_floor) / polygon(画布画/拖/插删点) / **group(分组标签)** / conditions / onEnter / onStay / onExit(均仅 standard) | 增/删、画布编辑多边形 |
| **NPC** | id / name / x / y / initialFacing / dialogueGraphId / dialogueGraphEntry / dialogueCameraZoom / interactionRange / **scale / rotation(实例 transform,同热区)** / **perspectiveScaleEnabled(透视缩放参与,三态下拉;NPC 缺省参与、renderRaw 缺省不参与)** / **group(分组标签)** / cutsceneIds / cutsceneOnly / conditions / conditionHidesEntity / animFile / initialAnimState / initialAnimPlayback(speed/reverse/holdFrame/startFrame,进场起播一次性生效,-1=未设) / patrol / collisionPolygon | 增/删、画布拖位置+巡逻折线+transform gizmo |
| **出生点** | key(default 只读) / x / y | 增/删(default 不可删) |

**热区每种 type 的 `data`(均整体重建)**:
- inspect:Actions 模式 `{actions}` 或 图对话模式 `{graphId, entry, actions}`。**`data.text` 无控件、会被丢。**
- pickup:`itemId` / `itemName` / `count` / `isCurrency`
- transition:`targetScene` / `targetSpawnPoint`
- npc:`npcId`;encounter:`encounterId`

**危险区**
- 重建区:`hotspot.data`(尤其 inspect `data.text`)、`npc.patrol`(只 route/speed/moveAnimState)、`spawnPoint`(只 `{x,y}`)。
- 主动删除:`zone.x/y/width/height/ruleSlots`、`npc.dialogueFile/dialogueKnot`;切 depth_floor 会删 zone 的 onEnter/onStay/onExit。
- 盲区:`backgrounds`(主编辑器不可编辑,只 Scene Depth Editor 或手写)、`depthConfig` 主体(M/shader/collision/depth_map…只 Scene Depth Editor 导出)。
- 透视缩放下的碰撞多边形:可编辑多边形按 authored 空间显示(顶点拖拽/表格写回零换算);参与透视且系数≠1 时另画**只读虚线幽灵轮廓**=运行时实际命中面(authored 多边形绕锚点×f(y),与 anchorCollisionPolygonToWorld 同口径)。展示图/交互圈/NPC 精灵预览直接按系数缩放。
- 无复制、无列表重排;`anim.json` 场景编辑器内只读(states 等廉价参数去「动画」面板改,图集像素布局靠 video_to_atlas 导出)。

---

## 图对话(`tools/dialogue_graph_editor/`)

7 种节点:`line`(speaker.kind player/npc/literal/sceneNpc + text + 可选多拍 lines[] + next)、`choice`(可选 promptLine + options[id/text/next/requireFlag/costCoins/ruleHintId/disabledClickHint/requireCondition])、`switch`(cases[条件+next] + defaultNext,条件可 AND 内联或结构化树)、`runActions`(next + ActionEditor)、`ownerState`/`contextState`(按叙事图状态分支)、`end`。

- 连边:检查器 `next` 框 + "选…"节点选择器,或**图形画布拖端口连线**。
- 条件:结构化树(5 叶子);switch 的 AND 内联模式只支持 flag/quest/scenario。
- **危险区(重建)**:被打开编辑过的节点 getter 从头重建,丢未知字段;未编辑的节点原样保留。图级 `preconditions` 非 dict 叶子被单独保留。

---

## Cutscene 过场(`timeline_editor.py`)

- 顶层:id / targetScene / targetSpawnPoint / targetX / targetY / restoreState(旧 `commands` 被 pop)。
- 15 种 present:fadeToBlack / fadeIn / flashWhite / waitTime / waitClick / showTitle / showDialogue(speaker+text+scriptedNpcId) / showImg(id+image) / hideImg / showMovieBar / hideMovieBar / showSubtitle(classic position 或 movie band+align+可选 subtitleVoice/subtitleEmote) / cameraMove(x/y/duration+可选easing,可地图点选) / cameraZoom(scale/duration+可选easing) / showCharacter(visible)。easing 下拉:linear/easeIn/easeOut/easeInOut,缺省=运行时默认曲线。
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
| **任务** `quest_editor` | quests.json + questGroups.json | 任务:id/group/type/sideType/title/description/preconditions/completionConditions/acceptActions/rewards/nextQuests(边:目标+bypassPreconditions+条件);分组:id/name/type/parentGroup | 增删、拖拽改父子(带环检测)、无复制;**删 nextQuestId(deprecated)** |
| **遭遇** `encounter_editor` | encounters.json | id/narrative/options(text/type/requiredRuleId/requiredRuleLayers 象理术/conditions/consumeItems/resultActions/resultText) | 增删、选项上下移、生成唯一 id |
| **规矩** `rule_editor` | rules.json | 规矩:id/name/incompleteName/category/三层(text/lockedHint/verified);碎片:id/text/ruleId(只读)/layer/source | 增删;**删旧 verified/description/source...**;空层回填 |
| **物品** `item_editor` | items.json | id/name/type/description/maxStack/buyPrice/dynamicDescriptions(conditions+text) | 增删;dynamicDesc **只能加不能删单条** |
| **商店** `shop_editor` | shops.json | id/name/items(itemId+price 表) | 增删行;price 总会写出 |
| **地图** `map_editor` | map_config.json | sceneId/name/x/y/unlockConditions | 增删、**画布拖坐标** |
| **档案** `archive_editor` | archive/{characters,lore,documents,books}.json | 人物:name/title/unlock/firstViewActions/impressions+knownInfo(条件+文);见闻/文档:title/content(可插图)/source/category;书籍:三级 Book→Page→Entry | 增删条目;**book page 不能删、impressions 只能加不能删;切换未 Apply 会丢** |

- 条件统一 `ConditionEditor`,动作统一 `ActionEditor`,玩家可见文本统一 RichText。

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
