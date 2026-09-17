---
id: burn-system
title: 燃烧系统(可燃物模板 · 宿主实例化 · 确定性燃烧模拟 · 点火表演 · 离场照推与存档)
domain: runtime
type: mechanism
summary: 可燃物是模板(图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光,和场景无关),热点 / NPC / 演出生成的对象 / 挂件预设身上写 burnable 引用它 = 实例化一次、渲染由实例接管,粒子薄片 plate.burnable 绑它;场景实例进每场景一份事件驱动的确定性模拟(Dijkstra 火线 + 消耗燃烧 + 按体积接触蔓延,挪位 / 出现 / 收掉也是外部事件,活跑 / 重放 / 离场照推逐位相同),手上的挂件单独一份模拟存快照;热点挂两道燃烧滤镜、NPC 与挂件在图像空间画颜色图 + 自发光;玩家点火 = 切 ActionSequence 走到闭式解出的站位、接触帧火头在画面 2D 对准着火点
status: active
authority:
  - src/data/burnables.ts
  - src/systems/burn/BurnSystem.ts
  - src/systems/burn/burnSim.ts
  - src/systems/burn/burnGeometry.ts
  - src/systems/burn/burnAim.ts
  - src/systems/burn/ignitePerformer.ts
  - src/systems/burn/igniteStance.ts
  - src/systems/burn/burnPersistence.ts
  - src/systems/burn/burnLights.ts
  - src/rendering/burn/burnShade.glsl
  - src/rendering/burn/BurnFilters.ts
  - src/rendering/burn/BurnRenderer.ts
  - src/systems/vfx/vfxPlateBurn.ts
  - src/dev/runtimeBurnSync.ts
triggers:
  paths:
    - "src/systems/burn/**"
    - "src/rendering/burn/**"
    - "src/data/burnables.ts"
    - "src/systems/vfx/vfxPlateBurn.ts"
    - "src/dev/runtimeBurnSync.ts"
    - "src/dev/runtimeBurnApiPlugin.ts"
    - "src/ui/debugBurnSection.ts"
    - "public/assets/data/burnables/**"
    - "tools/editor/shared/burnables.py"
  topics: [燃烧, 可燃物, 可燃物模板, 可燃实例, 可燃挂件, 点火, 烧纸, 点香, 点蜡烛, 着火点, 握点, 蔓延, 纸钱引燃, 火焰段, burn 条件叶, igniteBurnable, burnable]
  tasks: [做可燃物, 让实体能烧, 让挂件能烧, 让玩家点火, 让火蔓延, 调燃烧表现, 燃烧存档问题, 动态生成可燃物]
last_governed: 2026-09-16
---

## 是什么(一句话)

玩法口径 `docs/玩法功能需求清单.md` A3.8(制作人 2026-09-16 改定为"模板 + 实例",取代同日早先"可燃物就是热点 + 布置库"那版——
那版把可燃物和场景绑死了,`burn_placements.json` 已删)。

- **可燃物模板**(`public/assets/data/burnables/<id>.json`,id == 文件名):图、**真实尺寸** `widthCm/heightCm`、握点 `grip`、
  燃料、着火点、烧法、粒子、火光。**和场景没有任何关系**,唯一写入者是燃烧工作台([[burn-workbench]])。
- **宿主上写 `burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?}`** = 实例化一次:热点 / NPC(场景 JSON)、
  演出生成的对象(`playTrajectory.spawn.burnable`,= 动态创建)、挂件预设(`prop_presets.json`,= 手上的可燃挂件)。
  **宿主自己的图 / 动画一律失效,渲染由实例接管**:图取模板、按模板真实尺寸画(1 m = 88 wu),宿主自己的位置 / 缩放 / 旋转 / 朝向照乘。
- **粒子薄片**绑 `plate.burnable: {template}`(只能绑面燃烧模板;贴图与大小仍归粒子),见下文"纸钱"。

## 权威源(读代码从哪进)

- 数据形状与缺省:`src/data/burnables.ts`(`BurnableDef` / `BurnableHostDef` / `BurnablePlateBindingDef` / `BURN_DEFAULTS` /
  `resolveBurnable` / `resolveBurnableHost` / `burnableWorldSize`,**字段语义以注释为准**)。Python 形状闸门 `tools/editor/shared/burnables.py`(同口径)。
- 模拟本体:`burnSim.ts`(纯函数、零 Pixi、不读挂钟;事件含 `move / appear / vanish`;快照 `exportSnapshot` / `snapshot` 输入)。
- 几何:`burnGeometry.ts`——实例图在画面上 = 一个仿射 `BurnFrame`(`scene = o + u·du + v·dv` + 立面脚点);
  `burnEntityPlacement`(实体定义 → 摆放,工作台 / 离场同口径)、`burnFrameFromCorners`(量出来的三个角)、9×9 世界映射网格。
- 系统:`BurnSystem.ts`(场景记录 / 对账 / 挪位追踪 / 手上挂件 / 离场照推 / 存读档 / 表现 / 条件叶 / 动作 / 探针)。
- 点火:`burnAim.ts`(火头伸到哪)、`ignitePerformer.ts`(表演状态机 + 站位闭式解)、`igniteStance.ts`(纯数据版站位,工作台打包)。
- 表现:`burnShade.glsl`(**唯一 GLSL 源**)、`BurnFilters.ts`(热点滤镜)、`BurnRenderer.ts`(滤镜宿主 / 纹理宿主两种接法)、`burnLights.ts`。
- 宿主接线(组装层 `Game.ts`):`burnEntityHosts()`(热点 → 滤镜宿主,摆放按定义算;NPC → 纹理宿主,摆放量本体精灵 `SpriteEntity.bodyUvToLayer`)、
  `burnHeldHosts()`(挂件 → 纹理宿主,摆放量 `attachmentUvToLayer`)、`SceneManager.burnableDisplayOf`(热点 / NPC 的展示图换成模板)、
  `attachSocketView`(可燃挂件贴图取模板、支点 = 握点、`scale = widthCm·0.88 / 贴图宽 × 预设 scale`)。
- 纸钱:`vfxPlateBurn.ts`;外部供点发射形状 `external` 在 `vfxSim.ts`。见 [[vfx-system]]。

## 硬契约(违反即 bug)

- **确定性**:事件只由"上一个事件的时刻 + 距离 / 速度 + 风在那一刻的解析值"决定;固定步长的量(吹熄 0.1 s、火苗碰别人 0.25 s)落在**全局** k·h 网格上。
  逐帧活跑 == 一次跑到头的重放 == 离场照推(`burnSim.test.ts`、`BurnSystem.test.ts` 钉着)。**模拟里不许读 `performance.now` / 帧 dt。**
- **场景实例进档的只有外部事件**:点火 / 整体点火 / 熄灭 / 复原 / **挪位** / **出现** / **收掉**(`[t,'i',u,v]|[t,'a']|[t,'x']|[t,'r']|[t,'m',w]|[t,'+']|[t,'-']`)
  + 指纹(模板清洗后 + 燃料网格,**不含摆放**)+ **世界映射表**(`move` 指向其中一份)+ 风钟分段 + 纸钱烧没的槽位。派生量永不进日志。**日志只增不删**。
- **挪位**:在场实例每帧按宿主此刻的摆放算 9×9 世界映射,与**日志里此刻该在的那份**(最后一条 `move` 指向的,不是模拟推到一半的位置——读档后
  模拟还没推到挪位那一刻,拿它比会凭空多记一条)逐点比,差 > 0.5 wu 才算挪:整场**没有任何过去**就直接换(不记事件),有过去就追加一份 + 记 `move`
  (最密 0.1 s 一条)。挪过来的那一刻补查一次"别人此刻的明火碰不碰得到它、它此刻的明火碰得到谁"(火焰碰别人平时只在格子点着那一刻查)。
  表现(粒子出生点 / 火光 / 火焰段)用宿主**此刻**的映射,不等挪位事件。
- **出现 / 收掉**:进场时就在的实体不记"出现";在场时新冒出来的(演出生成)记"出现"(= 一个新的、没点过的实例,再按 `initial` 起火);
  宿主不在了记"收掉"、留成幽灵(重放别人要用),条件叶对它回 null。
- **推不出来 ⇒ 整场收束**:模板指纹变了且它有过去、风变了而有外部事件、有过去的实例连模板都建不出来、离场重建缺世界映射而火还在走——
  整场有过去的切**烧完**(发 burntOut),此刻没点的清成干净;幽灵整条丢。宿主挪了 / 生成 / 收掉**不再**算推不出来。
- **当前场景世界映射补齐之前不推**(钟照走,齐了按时刻追上;宿主一直给不出摆放最多等 2 s)。
- **离场的场景留在内存里继续推**;读档后有火在走的离场场景后台重建(实体清单走 `sceneBurnables`:场景 JSON + 这个场景记着的 `spawnedNpcs`),
  用**时间线号**作废(读档 / 销毁),**不随**进出场景变。
- **场景 onEnter 期间(模板还在路上)来的动作排队**,建好后按调用时的钟记。
- **跨可燃物接触按体积**(立着的纵深半厚 = 半宽、躺着的 = 0,`contactGap`)。**消耗燃烧只有"芯"点得着**;灭了风点不着。
- **着色器双线性混的是四格各自的阶段结果**,且只混有燃料的格。
- **手上的可燃挂件**(key = `人|挂点`):单独一份模拟,每帧 `setLiveWorld`(不记事件、立面过拿着它的人的接地点、浮力永远朝真实的上方),
  存**快照**(`BurnItemSnapshot` + 快照之后还没处理的事件)。三种来路:挂上时先接**暂存**(切场景整批卸下 / 读档)→ 再接**包里那根**(按挂件 id)→ 否则新的一根(按 `initial` 起火)。
  **收起来**(`HeldPropSystem.detach` → `onBurnablePropRemoved`)= 熄灭 + 记成包里那根(烧完的不记);模板指纹变了而它烧过 ⇒ 起点烧完。
  **不与场景实例互相碰着**(同火把规矩,只走按 E);**燃着就算手上有火**:`heldIgniterOf`(火头 = 明火格 uv 重心)给点火表演、火焰段进 `setFireSources('burn')` 点纸钱;
  没在烧没烧完 ⇒ `heldRelightTipOf` / `relightHeld` 能从燃着的东西上引火。`HeldPropSystem.isBurning` 对可燃挂件问燃烧系统(`heldProp` 条件叶的 `burning` 也读它)。
  可燃挂件与火把那一套(灯 / 粒子挂载 / 火苗 / 起火点 / 玩家操作 / 吹熄 / 点火能力 / 燃料 / 效果块 / 等级 / 状态表)互斥:`resolvePropAttach` 对它一律给空,校验器拦。
- **渲染两种接法**(`BurnRenderer`):
  - **滤镜宿主**(热点):展示图 Sprite 滤镜链 `[密度模糊, 燃烧材质, 深度+光照, 燃烧自发光]`,片元场景坐标经"场景 → 图 uv"仿射。相机 uniform 由组装层在相机定稿后推。
  - **纹理宿主**(NPC / 挂件):角色逐像素光照 mesh 出图、滤镜挂不进去 ⇒ 每帧在**图像空间**把"模板图 × 燃烧材质"画进颜色图、自发光画进另一张;
    NPC 本体把光照 shader 的颜色源换成颜色图(UV 照旧取帧纹理)、挂件直接换贴图(**渲染纹理与模板图同尺寸**,否则支点 / 起火点 / 站位几何全变),
    自发光是加法混合的兄弟精灵(被容器上的深度遮挡一起挡)。Pixi 渲染器**按需现取**(组装期应用还没初始化,真跑抓到过一次整条不画)。
  - 都只在"烧过"(状态 ≠ 没点)时挂。燃烧场纹理 RGBA8 NEAREST,上传 ≤ 20 Hz。
- **火光**:动态灯按来源合并(`prop` 在前、`burn` 在后),≤ 6 盏、推送 ≤ 20 Hz + 低通,物理闪烁;只在真 3D 场上发。离场清空。
- **点火表演**:目标是**实体 id**(热点或 NPC,`InteractionSystem.setIgniteProbe(entityId)`,`burn:igniteRequested {targetId}`);
  站位 = 着火点 − 接触帧火头偏移(不动点迭代);朝着火点那一侧优先,站不了换另一侧,都不行原地点并 dev 告警。
  手上的火:火把优先(`HeldPropSystem.igniterOf`),其次燃着的可燃挂件;引火同理。接触那一刻火还燃着才点;被抢状态 / 切场景 / 读档 ⇒ 收掉不点。
- **着火点摆在靠玩家那一侧的下沿**(站位由火头偏移反解,火头贴地时着火点在中腰会让人站到物体后面)。
- **没定义着火点 ⇒ 火头伸到燃料重心、整体点燃**;定义了 ⇒ 离火头最近的那个点。
- **不写 flag**;状态变化发宿主块里配的叙事信号(owner:场景实体 = 实体 id、类型 hotspot / npc;挂件 = 拿着它的人,`player` 类型 player)+ `burn:changed {sceneId|null, target, socket?, from, to}`。
- **条件叶** `{burn, burnSocket?, burnScene?, burnState}`:写了 `burnSocket` = 这个人这个挂点上的可燃挂件;否则场景实体(`burnScene` 缺省当前场景;
  别的场景没装过定义层时先回 null、后台装好再发 `burn:changed` 叫醒)。**动作** `igniteBurnable {target, socket?, point?}` / `extinguishBurnable` / `resetBurnable {target, socket?}`:改存档、不进过场白名单。
- **动态创建**:`spawn.burnable` 生成的 NpcDef 带 `burnable`(玩家能点的给 60 wu 交互范围),`keep` 留下的进 `sceneMemory.spawnedNpcs`、照常烧照常进档。
- **纸钱**:参数全取模板(`resolvePlateBurnParams(template)`):引燃时间、火焰长度、焦黑 / 发光、火苗粒子(`from: flame` 的槽,发射率 × 燃着面积 / refArea)、火光(每平方米强度 × 燃着面积)。
  **从被火碰到的那一边烧过去**,一张纸烧完 = 片宽(cm)/ (逆流 + (顺流 − 逆流)·max(0, 扫的方向·上))。不跑燃料网格(几百张跑网格超预算)。
  薄片绑的模板由 `VfxSystem` 装效果时一起装(`burnTemplates` 交给模拟);没有薄片绑模板的效果不多等一拍。

## 存档形状(v2)

`{v: 2, clock, scenes: {sid: {visits, wind, items: {key: {b, fp, st, base, ev, w: [[324 个数]…]}}, plates}}, held: {"人|挂点": {p, b, fp, st, s, ev?}}, pocket: {挂件id: …}}`。
v1(布置库时代)整桶不认(燃烧状态回到没点,log 一行)。

## 怎么验证

- `npx vitest run src/systems/burn src/dev/runtimeBurnSync.test.ts src/systems/vfx`。
- 真跑:`?mode=dev&devScene=test_room_a`(样例:热点 `burn_demo_paper` / `_paper_2` / `_candle` / `_incense`、NPC `burn_demo_figure`、挂件预设 `burn_demo_xiang`)。
  - 手上拿线香:`__game.attachToSocketFromAction('player','right_hand',[],{prop:'burn_demo_xiang'})`;点着 `__game.burnSystem.igniteBurnable('player','right_hand')`;
    点火表演 `__game.ignitePerformer.start('burn_demo_candle')`;收起 `__game.detachFromSocketFromAction('player','right_hand')`。
  - 动态生成:`__game.spawnTrajectoryActor({kind:'image', id:'dyn', keep:true, burnable:{template:'candle_red', initial:'burning'}}, {x, y})`。
  - 读档:`saveManager.capturePayload()` + `loadPayload()`(**别用 `save(slot)`,那是玩家的三个槽**)。
  - 纹理宿主方向:`__game.renderer.app.renderer.extract.pixels(__game.burnRenderer.entries.get('s:<id>').albedo)` 看烧黑的行在哪。
  - ⚠ Browser pane 与子代理共用,调用带 `tabId`;场景加载完(`stateController.currentState === 'Exploring'`)之前别操作。

## 已知边界

- 读档后离场的场景里**从没点过又没有世界映射**的实例(从没进过那个场景)在进场补上映射之前点不着、也不被蔓延到。
- 自发光不走显示变换(自发光本来就不吃场景曝光)。
- 挂件是等比缩放:模板尺寸与图的宽高比不一致时挂在手上按宽算(工作台里偏离 > 2% 会提示)。
- 一路走着的可燃 NPC 在场景有过去之后每 0.1 s 记一条挪位(存档会随走动变长)。
- 玩家点火动画:`player_anim` 的 `ignite` 片段 `[0, 69, 70, 71, 71, 72, 0]` 8 fps,接触帧 = 槽位 71;图集加不了行(2048 贴图闸)。
