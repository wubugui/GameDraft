---
id: held-prop-lights
title: 手持光源(挂件状态机 · 跟随灯 · 运行时灯那一层)
domain: runtime
type: mechanism
summary: 火把/篾条/灯笼是"燃烧物静态图 + 粒子挂载（每个效果挂在贴图上自己的点）+ 程序化燃烧状态 + 自带灯"，帧动画火苗留作能力；灯位与粒子锚点每帧从起火点 / 挂载点（或挂点）解出来，灯作为**运行时灯**加在作者灯之外（作者数据一个字节不动）；闪烁是一个信号 L(t) 同时驱动灯强度与粒子发射率；燃烧强度驱动粒子发射率与新生大小（2/5 次方）、挡风驱动粒子吃风，都不动灯；灯每动一次就重烘整张光照缓存，所以闪烁推送必须限速；状态进入动作只在真进入时执行
status: active
authority:
  - src/systems/heldProp/HeldPropSystem.ts
  - src/systems/heldProp/heldPropSignal.ts
  - src/rendering/SpriteEntity.ts#getAttachmentPointOffsetFromContact
  - src/systems/heldProp/heldPropFlame.ts
  - src/rendering/FireHintMarker.ts
  - src/systems/InventoryManager.ts#consumeIgniterUse
  - public/assets/data/prop_effects.json
  - src/systems/burn/ignitePerformer.ts#modeFor
  - src/systems/graphDialogue/evaluateGraphCondition.ts#isHeldPropLeaf
  - src/rendering/vfx/VfxRenderer.ts#clampBucketToHost
  - src/systems/vfx/VfxSystem.ts#setInstanceSizeScale
  - src/data/propPresets.ts
  - src/core/SceneLightingSystem.ts
  - src/core/ActionRegistry.ts#setPropState
  - public/assets/data/prop_presets.json
triggers:
  paths:
    - "src/systems/heldProp/**"
    - "src/rendering/FireHintMarker.ts"
    - "src/data/propPresets.ts"
    - "public/assets/data/prop_presets.json"
    - "tools/editor/editors/prop_preset_editor.py"
    - "src/data/animationSockets.ts"
    - "tools/editor/shared/animation_sockets.py"
    - "tools/editor/shared/socket_panel.py"
    - "tools/editor/shared/socket_canvas.py"
    - "tools/editor/shared/prop_preview.py"
    - "tools/editor/shared/prop_tryon_canvas.py"
  topics: [火把, 手持光源, 挂件, 灯笼, 跟随灯, 挂点, prop, 挂件状态, 闪烁, fadeLight, 运行时灯, 火势, 快灭提示, heldProp 条件叶]
  tasks: [做火把, 加手持道具, 让灯跟着人走, 吹灭灯, 加挂件状态, 调挂件自带灯]
last_governed: 2026-09-12
---

## 是什么(一句话)

**手上那件东西是一个整体**:一支火把 = 贴图 + 自带的一盏灯 + 自带的火焰效果 + 一串离散状态
(点着 / 护火 / 残炭 / 灭),全部登记在挂件预设里(同支点那条理由:这些是**火把自己的属性**,
不是调用点的属性)。运行时把灯位与效果锚点**每帧从挂点解出来**;动作只切状态名,
连续量(渐变、闪烁、发射率)由运行时算。

**2026-09-15 起火把拆成三层**(制作人定):燃烧物 = 一张静态图(火把 / 篾条可换);
火 = 挂件上的**粒子挂载** `particles: [{effect, point}]`——每条一个粒子效果(`vfx/torch_flame` 等,粒子工作台做)
挂在贴图上的一个点(杆头、杆腰都行;不写点 = 起火点),跟着燃烧物的支点 / 自转 / 缩放 / 镜像走;
燃烧状态 = 程序化连续量(`burn` 燃烧强度、`windShelter` 挡风,随状态渐变,逐帧推成粒子实例倍率)。
被风吹歪、举着走火苗拖在身后,是粒子在世界里模拟出来的。**火把只用粒子**。
**帧动画火苗(`flame`)留作能力**:同一天先做的"复用三把火帧动画 + 程序化倾斜(Froude)"那版,制作人判火把上
效果不好、改粒子,但明确要求这个能力留着——预设基础块写 `flame` 就有,数学在 `heldPropFlame.ts`。
老灯笼走同一套(不写起火点、残炭状态挂 `incense_smoke`、没有帧动画火苗),灯的逐 tick 数值与改造前一致
(真跑对照,见"怎么验证")。

## 权威源(读代码从哪进)

- 数据形状:`propPresets.ts`(`light` / `particles` / `flame` / `firePoint` / `burn` / `windShelter` / `states` / `defaultState` / `persistent`,
  **字段语义以那里的注释为准**);解析与合并也在那里(`resolvePropAttach`)。
- 运行态:`systems/heldProp/HeldPropSystem.ts` —— 干三件事:挂件状态机 / 跟随灯 /
  作者灯的强度倍率渐变(`fadeLight`)。
- 闪烁数学:`heldPropSignal.ts`(纯函数、确定性、不读挂钟)。
- 起火点:`SpriteEntity.getAttachmentPointOffsetFromContact`(与挂件贴图共用 `attachmentTransform`,
  两处数学不许各写一份);燃烧强度 → 大小的 `burnSizeScale` 在 `heldPropSignal.ts`。
- 粒子实例倍率:`VfxSystem.setInstanceRateScale / setInstanceSizeScale / setInstanceWindScale`
  (存在实例上,模拟重建时重新套上);挂在人身上排序:`VfxSystem.setInstanceSortHost` → `VfxRenderer` 的 `VfxSortHost`。
- 帧动画火苗(保留能力):数学 `heldPropFlame.ts`(纯函数),摆位 `SpriteEntity.setAttachmentFlame`,切帧 `Game.loadFlameFrames`。
- 灯怎么进画面:`SceneLightingSystem` 的**运行时灯那一层**(`setDynamicLights` /
  `setLightIntensityScales` / `effectiveLights`)。
- 动作:`ActionRegistry` 的 `attachToSocket`(多一个可选 `state`)/ `setPropState` / `fadeLight`。
- 挂点位姿:`SpriteEntity.getSocketPose`(逐帧标注见 [[footstep-and-spatial-audio]] 同一份 sockets.json)。

## 硬契约(违反即 bug)

- **灯位出发点的优先级**:`light.socket`(显式点了人物动画上的挂点)→ 预设 `firePoint`(贴图上的起火点,
  穿过挂件自己的支点 / 自转 / 缩放 / 镜像)→ 挂这件东西的挂点本身。**不写 firePoint 的挂件必须逐位回到
  改造前的那条路**(灯笼的调光是制作人逐项调过的);`getAttachmentPointOffsetFromContact` 在
  "起火点 = 支点"时与 `getSocketOffsetFromContact` 逐位相等(`SpriteEntitySocketFacing.test.ts` 钉着)。
- **灯位与"没写点的粒子挂载"是同一个点(起火点)**,刚体跟燃烧物;写了点的挂载走同一套换算
  (`getAttachmentPointOffsetFromContact` → 身体外侧 M-world,无真 3D 几何退粒子平面近似)。
- **状态的 `particles` 整体替换基础块那一串**(空数组 = 这个状态没有粒子)。旧字段 `vfx` 已删,运行时不读、校验器报错。
- **切状态时同一效果挂同一点的挂载沿用原实例**(点着 → 护火火舌不断);其余旧挂载软停、新挂载新开。
- **挂件上的粒子整团钉在宿主同一侧排序**:挂件画在身前 ⇒ 全在宿主之后画,身后 ⇒ 全在宿主之前画;
  对别的实体照常逐颗按纵深分桶。不钉的话起火点离身体那几 wu 抵不过湍流,朝左举火把时同一团火被人身劈成前后两半
  (2026-09-15 真跑抓到)。宿主在分桶阈值合并时一律保留。
  ⚠ 已知残留:挂件在身后时粒子画在宿主容器之前,而挂件贴图住在宿主容器里 ⇒ 杆头压在火根上。
  要彻底解得把粒子网格塞进实体容器,会过玩家深度滤镜 / NPC 色调滤镜,没做。
- **同一个 L,两个消费口径**:灯吃 20 Hz 区间均值;火吃"热" = `L^(2/5)` 过 50 ms 低通(Heskestad 同一个关系,
  每帧只算一次,`stepFlameHeat`)——粒子挂载的新生大小 × 热,帧动画火苗的高度 × 热。灯这一帧没算
  (状态没有灯 / 无真 3D 几何)时按不吃风的幅度补算,火照样一胀一缩。
- **闪烁不进发射率**。发射率只乘燃烧强度(供了多少燃料)。风把闪烁幅度推到 ±70% 时发射量跟着五六倍涨落,
  举着走火舌断成一串珠子(2026-09-15 真跑抓到,当时是"发射率 = L × 燃烧强度")。
- **在飞的粒子带"锚点相对宿主的位移",不带宿主平移**(`rigCarry` → `moveVfx(..., carry)` → `VfxInstanceSim.moveAnchor`),
  **只对 `motion.followAnchor: "rig"` 的发射器**(火舌 core / halo);`full` 整个跟锚点(余烬红光、炭火),缺省 `none` 不动(烟、火星)。
  ⚠ 第一版对所有发射器都带:熄灭的烟飘出几百 wu 还跟着手一步一晃、余烬红光走路时拖成一串点(2026-09-15 第五轮真跑抓到)。
  相对宿主的那份是动画带出来的:转身翻面、走 / 站换姿势(一跳几十 wu)、逐帧动画换帧(4 tick 一跳 7–15 wu)——真的火把是连续动的;
  不带的话转身原地留约 0.3 秒"鬼火"、换姿势火团挂在杆子半腰、举着走火舌断成珠子(2026-09-15 两轮真跑抓到)。
  宿主在世界里的平移不带:粒子留在空气里,走路的拖尾就是这么来的。
- **燃烧强度 `burn` 乘该状态所有粒子效果的发射率与新生粒子大小**(大小 = burn^0.4,Heskestad 火焰高度关系
  `L_f ∝ Q^(2/5)`;只乘新生粒子,在飞的不跟着缩——火苗变小是新烧出来的火舌变小)。0 = 不再发,在飞的自然烧完。
  ⚠ 自带专门效果的状态(残炭 `torch_ember`)**燃烧强度留缺省 1**:
  写 0 = 那个状态自己的效果一颗不发、burst 出生大小为 0。燃烧强度是给"复用点着那团火、只是弱一点"的状态用的(护火)。
- **新开的粒子实例当场套倍率**(`startParticles` / `swapParticles` / `syncParticles` 补开时),不等下一个 update——否则切到弱火状态头一帧按满强度喷一口。
- **护火 = 挡风比例 `windShelter`**(基础块 / 状态,缺省 0):该状态粒子实例吃场景风 × (1 − windShelter)、
  帧动画火苗的相对气流 × (1 − windShelter)
  (普通粒子与薄片同一处;不碰发射器自己的恒定风、刺激场、airflow 场)。**正弦闪烁的灯(灯笼)不动**——灯对风的敏感度是
  `light.flicker.windAmp`,灯笼的数值是调过的,不许被它连带(真跑:挡风 0.8 与 0 推出去的灯逐位相同);
  **物理闪烁的灯(火把)动**:它读的就是挡过的那股气流,护火 = 火把在风里亮回来(这正是跑马梁"护火"那一拍要的)。
- **风吹灭火(火势)**(2026-09-15 制作人定,取代"吹灭只靠作者编节拍"):预设 / 状态 `blowout`(`PropBlowoutDef`)。
  火势 `vitality` 0..1,气流取 `entry.air`(已算挡风与人走动;无真 3D 几何当无风):`u > windSpeed` 每秒掉
  `(u−ws)/ws/drainSeconds`,否则每秒回 `(1−u/ws)/recoverSeconds`。**火势乘在燃烧强度与灯强度上**
  (灯笼没 blowout,火势恒 1,乘法绕开,逐 tick 数值不变)。越过 `emberBelow` / 到 0:`auto`(缺省 true)时
  先 `transition(..., byWind=true)` 切 `emberState` / `outState`(风切的不算点火),再执行 `onEmberActions` / `onOutActions`
  (顶层 playPropVfx 同样自指;发叙事信号放这里——引擎不写死信号名,编辑器信号目录能扫到)。越线触发后要回到线上 0.1 才再武装。
  **控制权三层**:数据(不写 blowout = 吹不灭;状态 `blowout: null` = 这个状态吹不灭)、`lockPropState {lock}`(`lit` 锁定不灭 = 只回不掉 + 玩家熄不了 /
  `unlit` 点不燃 = 玩家点不着 / `none`;入档、切场景带着)、
  `setPropState` 永远优先。**灭了物理不点火**;动作把火从残炭 / 灭里切出来 = 火势回满、重新武装。
  **残炭挡风复燃**(制作人 2026-09-15:"用挡风挡一下就回来了",不另设吹火操作):在 `emberState` 里火势回到 `emberBelow + 0.1`
  ⇒(`auto` 时)`transition(recoverState ?? 'lit', byWind=true)`——风切的,火势不回满,照火势本身往上长。残炭里玩家按住护火键
  **不切状态**,只把气流按 `guardState` 的 `windShelter` 挡(`extraShelter`,`stepAirflow` 取 max)。
  **火势入档、切场景带着**(`serialize` 写 `vitality`,满的不写;`attach` opts.vitality):2026-09-15 前是"派生量不入档",
  制作人定"火把的所有参数都是全局玩法状态"后改。
  火把现值(设计值,没有文献数):吹熄 8 m/s、两倍风速 4 s 灭、无风 3 s 回满、残炭线 0.35、渐变 500 ms。**残炭状态自带 blowout**(整块替换)只把 drainSeconds 放到 10:炭比明火耐风(风给炭供氧、炭灭靠冷却),原来继承 4 s 时 16 m/s 下残炭只撑 1.4 s、粒子池还没攒起来就灭了,等于看不见(2026-09-15 真跑测到)。
- **快被吹灭时时断时续**(2026-09-15 制作人:"要灭的时候看不到明显的状态"):`GutterProcess` 两态(燃着 / 断着),**每帧按此刻占比重判**
  (断转燃速率 1/`GUTTER_REIGNITE_SECONDS` 0.12 s,燃转断按占比 `duty = gutterDuty(火势)` 推:v ≥ 0.75 恒燃,线性降到 v=0 时 0.25)。
  ⚠ 第一版切到燃着时预抽一段时长,火势刚破 0.75 抽到 12 s,之后整段掉到底一次没断——不许预抽。断着:灯 × 0.2(进推送低通之前乘)、
  火苗(发射量 / 新生大小 / 帧动画高度 / 火焰长度)× 0.05。只在有 blowout 的明火状态;残炭、灭、锁定不灭不断。
- **火焰长度**(制作人:"风大和人跑起来的时候火拉得比人还长"):粒子 `life.maxDistance`(工作台可配)——烧完进度取
  `max(活了多久/寿命, 离发射器原点距离/(maxDistance × 实例倍率))`;挂件每帧推倍率 = (燃烧强度 × 火势因子 × 断着)^0.4 × Thomas 风里缩短
  `flameWindFactor(u, D)`(灯是物理闪烁时)。只给火舌核心 / 光晕写,火星与烟照样飘远。
- **物理闪烁灯的连续性**(2026-09-15 真跑抓到三处跳变后):
  ① 切状态的渐变插在**推出去的亮度本身**上(`fadeFromOutput` = 切换那一刻真实亮度 → 目标 = 新状态强度 × 低通闪烁 × 火势因子);原来插基准强度再乘新闪烁,
  点着 → 残炭时残炭大风倍率 4–5 × 未降下的点着强度往上窜、残炭 → 点火时低通里残留 3.9 闪一帧 1.8 倍;换了火的种类低通从头起。
  ② **残炭状态的火势因子按残炭线归一**(`vitalityFactor` = v / emberBelow):进残炭那一刻炭火是满的,掉到 0 暗没;原来直接乘 ≤0.35 的火势,风里一颗炭火都发不出来。
  ③ 挂点回来(站起)灯按 `FLAME_REGROW_SECONDS` 0.3 s(火苗核心一茬寿命)从 0 亮回,不再"亮着一个没火的杆头"。以上都只走物理闪烁那条路,灯笼不碰。
  火把残炭灯草稿 0.05 → 0.008(点着的 8%:炭火的光远不如明火;风里 Ranz–Marshall 倍率 ~4 后 ≈ 将灭火焰的亮度)→ **0.014 / range 160**(制作人:残炭看不清)。`torch_ember` 加了炭头本身的一团红光(`char`:10 wu 柔光、burst 3、full 跟锚点)、炭粒放大加量带 burst(进残炭那一刻不是空的)。
- **玩家按键**(`playerControl`,基础块,只对 target=player 的挂件;优先右手):`PROP_CONTROL_KEYS` T 点火 / 熄灭(点着、护火、**残炭** → outState,
  灭 → litState;残炭算燃着——原来残炭按 T 是满火点火,等于白送一次复燃)、按住 Q 护火(2026-09-15 由 V 改 Q,嗅键挪到 V;litState ↔ guardState,`playerGuarding` 标记只让"玩家按出来的护火"松键切回)。输入经 deps `readPlayerPropInput`
  (Game 只在 Exploring 给;点火键 `consumeKeyJustPressed`——固定步长一帧多 tick 时普通读会一次按键熄了又点)。锁只拦按键(`lit` 熄不了、`unlit` 点不着),
  `setPropState` 不拦。触屏「火」「护火」按钮按 `hasPlayerControl()` 显隐。每帧 `stepPlayerControl` 在所有条目之前跑。
- **「快灭了」提示符号**(制作人 2026-09-15:"出现在火附近,是一个符号,不是一行字"):`HeldPropSystem.pushFireHint` 每帧给玩家可操作的那件推
  `HeldFireHint`(起火点场景坐标 + 侧 + 剩余火势 fill + 危险程度 + 往下掉没有 + 残炭),组装层交给 `rendering/FireHintMarker`
  (挂 entityLayer 最前档,与气泡同理由:实体容器带光照 / 遮挡滤镜、会镜像;大小 / 离火距离按宿主身高比例;自己淡入淡出,Game 逐帧 `tick`)。
  **摆位 = 离火舌、杆子、身体那侧都最远**(`hintDirOf` → `pickHintAngle`:杆子 = 起火点→挂点;火舌 = 往上按画面横向相对气流歪;
  离火舌 ±25° / 杆子 ±10° / 身体那侧水平 ±55° 都最远的方向,72 向取样,上次方向余量 ≥10° 且只比最好差 <20° 就不动;符号中心沿该方向离起火点 0.1 身高)。渲染层小角度指数滑、> 90° 淡出再在新处淡入(滑会扫过火舌)。
  ⚠ 前四版都被真跑逐像素测出重叠:①固定人身外侧同高 ⇒ 朝左迎风火舌横拖扫到;②外侧下移 ⇒ 仍扫到符号尖;③按上风侧 ⇒ 上风恰是身体那侧时压在杆子上;④垂直于杆子背着火 ⇒ 走路时另一只手小臂伸到火把头下面被压。
  出的条件:按键受理中(Exploring)、有 blowout、没锁定不灭、没灭、起火点解得出来,火势 < `playerControl.hintBelow`(缺省 0.8,0 = 不出)或在残炭。
  符号 = 火苗轮廓里装着剩下的火(裁多边形到液面,纯函数 `clipPolygonBelow`),往下掉时按危险程度加速跳、琥珀→红;往回长不跳;残炭暗红闪。
  ⚠ 卸下时手上没东西 `update` 整段早退,推 null 必须在 `detach` 里补(测试钉着),否则符号卡在半透明。
- **火种点火**(玩法清单 A3.7「火种」,2026-09-16):当前火种住在**背包**(`InventoryManager.activeIgniter` + 每种火种拆开那份的剩余次数
  `igniterOpened`,入档在 inventory 桶),物品 `ItemDef.igniter {uses?, seconds, windLimit}`;没写 `use` 的火种背包里自动给「设为火种」(动作 `setActiveIgniter`)。
  挂件系统只经三个可选 dep 问它:`igniterStatus` / `consumeIgniterUse` / `onIgniteResult`(**三个都不给 = 旧行为,T 直接点着**——老测试与无背包宿主靠这个)。
  T 在不燃着的状态(灭 / `unlit`)⇒ `beginIgnite`:没设 / 用完 / 边走边按(`hostSpeedMps` > 0.25)不开始不扣;否则**开始那一刻扣一次**,`entry.igniting` 逐帧
  `stepIgnite`(排在 `stepAirflow` 之后,读挡过的 `entry.air`):风 > windLimit / 人动了 ⇒ 失败;满 seconds ⇒ transition 到 litState(非 byWind,火势回满)。
  再按 T = 停手;输入 null(对话 / 演出 / 面板)= 被打断;都算用掉。**按住 Q 在一切非明火状态都挡风**(`extraShelter`,残炭复燃与点火共用)——
  ⚠ 第一版只在点火进行中挡风,玩家先拢手再按 T 那一瞬间气流是没挡的、低通还没降下来,当场判风太大(测试抓到)。
  `hostSpeedMps` 用场景脚点差分(不依赖真 3D 几何),0.1 s 低通,一帧跳 > 50 m/s 当瞬移不算。符号复用 `FireHintMarker`:`mode: igniting`(装的是进度)/ `failed`(红、抖 0.45 s)。
  火把预设新增 `unlit` 状态(`light: null, blowout: null`):背包「拿在手上」挂这个——挂 `out` 会跑它的进入动作冒熄灭烟,而 `blowout: null` 防没点的火把在风里越线切残炭。
- **可燃挂件**(A3.8「可燃物是模板」,2026-09-16):预设写 `burnable: {template, initial?, signals?}` ⇒ 这件挂件是可燃物模板的实例,
  `resolvePropAttach` 对它给空的灯 / 粒子 / 火苗 / 起火点 / 吹熄 / 点火能力,贴图取模板、支点 = 模板握点、大小按模板真实宽 × 预设 `scale`(组装层 `attachSocketView`);
  燃烧由燃烧系统管([[burn-system]]):`isBurning` 问它(`burnablePropBurning` dep)、`detach` 通知它收进包里(`onBurnablePropRemoved`)、`listBurnable()` 每帧给它。
  与火把那一套字段互斥(校验器拦);状态表 / 等级 / 效果块对可燃挂件不读。
- **与燃烧系统的两个方向**(A3.8):①手上燃着 + E ⇒ 点可燃物(燃烧系统原有,`igniterOf`);残炭状态 `igniter.flameLength 5`(文档说残炭能点,数据原来写的 null,按文档对齐);
  ②**引火**:手上灭着 / 没点 + 可燃物正在烧 + E ⇒ 同一个 `IgnitePerformer`,`modeFor` 决定方向(点它优先),瞄 `BurnSystem.relightTarget`(离火头最近的明火格),
  接触帧 `canRelightFrom` 仍真才 `relightPlayerTorch`(不耗火种、不写燃烧事件)。引火不看布置的"玩家能点"/"能点的条件"(不点它)。
  不做的(防误烧剧情道具、防误点):火把一碰可燃物就点着、可燃物的火一碰灭着的火把就点着——都只走 E。
- **耐久(燃料)**(玩法清单 A3.7「火把养成」,2026-09-16):预设基础块 `fuel {seconds, windFactor?, outState?, onSpentActions?}`;
  不写 = 烧不完(随身那根)。`stepFuel` 排在 `stepAirflow` 之后(要挡过风的气流):**燃着才烧**、残炭 ×`PROP_FUEL_EMBER_RATE` 0.3、
  每秒 `1 + windFactor × u` 再 × 效果块的 `fuelRate`;剩下「快烧完了」那一段(满燃料的 20%,**但最多 15 秒**——四分钟的火把不该最后五十秒都在打蔫)起 `fuelFactor` 线性收到 0
  (火苗与灯一起变小变暗,与 `vitalityFactor` 并列相乘);扣到 0 ⇒ `transition(outState, byWind=true)` + `onSpentActions`(只写"包里那根没了")。
  **手上那根由系统自己拿掉**:等「灭」的进入动作与 `onSpentActions` 两条 promise 都跑完(`spentActionsDone`)、
  且这件挂件的一次性效果都放完(`oneShots` 空)才 `detach`——⚠ 内容里写 `detachFromSocket` 会把烧完那口烟同帧掐掉
  (2026-09-16 真跑抓到:`playVfx` 确实播了,下一帧实例已被卸载收走)。要留烧焦的杆子在手上写 `fuel.keepInHandWhenSpent: true`。
  **烧了一半的记在挂件 id 上**(`fuels`):收进包里再拿出来接着烧那一根,烧完才忘掉(包里下一根是满的)。拿在手上那根的燃料写在 `held[].fuel`,
  收着的写在 `fuels`,两处都入档。⚠ 第一版只把燃料放在 entry 上,一收一拿就白送一根新的(自测抓到)。
- **护火只能走不能跑**(`playerControl.guardBlocksRun`,缺省 true):`playerGuardBlocksRun()` → 组装层喂 `Player.setHeldPropMovement`
  (与位面 / 姿态两层修饰相乘,任一禁跑即禁跑)。**这是护火省燃料的代价**——燃料按挡过风的气流算,护火每秒确实省,
  但一段路要多走时间,一段路烧掉的燃料没省;只有站着扛一阵风时护火才是纯赚(制作人 2026-09-16 定的「乙案」)。
- **效果块**(`prop_effects.json` + 预设 `effects: [id]`,至多 `PROP_EFFECTS_MAX` 2 块):临时火把**比脾气不比数值**。
  数值类是**倍率**、几块相乘(`applyPropEffects` 纯函数,乘灯的亮度/范围、燃烧强度、吹熄那一套、火头长度;`propEffectFuelRate` 乘燃料速率);
  行为类并集:`fields`(燃着时在火头放 `fear` / `attract` 场,组装层转给 `VfxSystem.emitField` 的 handle 制,群体按 tag 权重反应)
  与 `tags`(进 `statusOf().effects`,`heldProp` 条件叶的 `effect` 认 id 也认 tag)。⚠ 场只有在**有物种认那个 tag** 时才有反应:`torch:招` / `torch:呛` / `torch:香` / `torch:艾` 已写进 `bat_cliff`(蝙蝠)、`teahouse_lamp_moths`(飞蛾)、`teahouse_floor_roaches`、`teahouse_table_flies` 的 attitude / stimulus 权重(粒子工作台写的);新加 tag 记得同样给物种配权重,否则场放了等于没放。查不到的块跳过、超过两块的不算(都记一行)。
- **等级**(预设 `levels: [{label, image?, effects?, note?}]`,第 1 项 = 出厂样子):`getPropLevel` / `setPropLevel`(动作 `setPropLevel`),
  **按挂件 id 记、进存档**——收在包里也算数;等级的 `effects` 叠在预设自己的 `effects` 前面(仍受 2 块上限)。
  `resolveWith` 是三处(挂上 / 切状态 / 升级)唯一的解析口径:等级换图 → `resolvePropAttach` → 效果块倍率。
  内容侧用 `propLevel` 条件叶问(与拿没拿在手上无关,物品描述按等级变就靠它;叙事图校验放行,因为 `setPropLevel` 会发 `heldProp:changed`)。
- **手持挂件是全局玩法状态**(制作人 2026-09-15 定):`statusOf(target)` 给每件的 `{socket, prop, state, burning, vitality, lock}`
  (`burning` = 当前状态 `resolved.light` 强度 > 0:点着 / 护火 / 残炭真、灭假;渐灭到灭的那 400 ms 已经算灭)。
  条件叶 `{heldProp, socket?, prop?, propState?, burning?, vitalityOp?+vitality?, lock?}`(`evaluateGraphCondition`,ctx `getHeldProps`)——同一件同时满足写了的每项。
  **谁叫醒它**:`deps.onHeldChanged` 在挂上 / 卸下 / 切状态 / 锁变了 / 火势跨过 `VITALITY_NOTIFY_STEP` 0.05 一档时调,Game 发 `heldProp:changed`,
  `NarrativeStateManager` 与 `flag:changed` 走同一个微任务合批重评 reactive(不每帧唤醒)。叙事图校验(TS `narrativeGraphValidation` + 叙事页 Python 兜底 `_is_condition_shape`)因此放行 heldProp——posture / timePhase / vfxState 没有唤醒事件,仍不放行。区域条件每帧自己求值,不靠事件。**不镜像成 flag**:
  崖墓风口区域原来读 `torch_lit` flag(物品点火时 setFlag),已迁到这条叶子、flag 删掉——物理吹灭 / 按键熄灭时 flag 不会跟着变,读 flag 必错。
- **挂点这一帧没了(蹲下)⇒ 粒子挂载与一次性效果当场硬停**,挂点回来挂载从新位置重开(一次性的不重开)。与挂件贴图 / 灯同生同灭;
  原来是 `continue`,人蹲下火把没了、火还在半空烧(2026-09-15 制作人抓到)。
- **熄灭冒烟是「灭」状态的进入动作,不是粒子挂载**(制作人 2026-09-15 定):`out` 的 `onEnterActions` 里一条
  `playPropVfx {effect: torch_snuff_smoke}`(粒子工作台做的:余烬红光 1.2 s + 迸几点火星 + 一口烟 + 3 s 细烟,约 5 s 放完)。
  `playPropVfx` 播的是**一次性效果**:跟着挂件走(锚点、排序宿主、带粒子规则与粒子挂载同一套)、放完自己收
  (`VfxSystem` oneShot 实例看 `VfxInstanceSim.finished`)、切状态不停、卸下当场散;不吃燃烧强度 / 闪烁 / 挡风。
  状态进入动作里**顶层**的 `playPropVfx` 不写 target / socket = 这件挂件自己(`runEnterActions` 注入;嵌套在控制流里的要写全)。
  挂载与一次性的分界:**这个状态持续多久就冒多久**的(火舌、残炭)挂 `particles`;**进入那一下发生一次**的(熄灭那口烟)走进入动作。
  读档 / 切场景重挂不执行进入动作 ⇒ 读档读到灭着的火把不会再冒一次烟,这是对的。
- **进入动作只在真进入时执行**:`setPropState` 真的切换 / `attachToSocket` 动作挂上;**读档与切场景的
  自动重挂不执行**(否则一读档"点火"的声音与信号再来一遍)。`setPropState` 动作的 Promise 覆盖进入动作
  的完成时间(`setStateAwait`)。同一挂点一帧内切换超过 8 次拒绝(状态动作互相切的死循环)。
  `setPropState` / `attachToSocket` 目前不在过场白名单里——若将来进白名单,进入动作也必须全在白名单内
  (校验器按这个条件查),否则状态动作就是绕过"过场内禁改存档"的口子。

- **绝不写作者数据**。跟随灯与渐灭覆盖只住在运行时那一层;`sceneLighting.params` 是作者那份,
  编辑器实时同步(`dev/runtimeLightingSync.ts`)读写的就是它 —— 一盏跟着玩家走的灯若混进去,
  会被回写进场景 JSON,作者下次打开看到一盏钉在某坐标上的莫名灯。
  实测判据:`fadeLight` 跑完之后那盏作者灯的 JSON **逐字不变**。
- **配了 `LightDef.follow` 的作者灯,原件必须从生效列表里跳过**,否则同一盏灯有两份
  (一份钉在作者写的 `pos` 上不动)。
- **运行时灯排在生效列表最前面**。`packLights` 超过灯槽上限时按数组顺序截断、带影灯也按顺序取,
  而手上举着的那盏按定义是离玩家最近、最该生效的一盏 —— 排在后面会让它在灯摆满的场景里
  被第一个丢掉,而且只有一行告警。
- **解不出来就不发光,不回落 `pos`**。目标不在场 / 挂点这一帧没标注 / 场景没有几何 ⇒
  这一帧这盏灯不存在。回落 = 一盏灯莫名钉在半空,比不亮更难查。
- **灯位与效果锚点分两个坐标系解**(`sceneToLightWorld` / `sceneToVfxWorld`)。灯位只认 M-world:
  粒子空间不是真 3D(照明载荷没到 / 没烘,退平面近似)时 `sceneToLightWorld` 返回 null;
  效果锚点照旧走粒子空间。原来两者共用 `vfxSystem.sceneToWorld`,平面近似那份返回的是**画面坐标**,
  拿去当灯位不报错、只是灯静默落到别处(铁律 0)。`HeldPropSystem.test.ts` 钉着。
- **闪烁必须是一个信号**。`L(t)` 同时驱动灯强度与火的大小(粒子新生大小 / 帧动画火苗高度,都按 2/5 次方)。
  两处各摇随机数 ⇒ "灯在闪、火苗不动"的穿帮。两种来源:
  - **物理闪烁**(`flicker.kind: flame | ember`,火把,2026-09-15):`PhysicalFlicker`,作者只填燃烧面直径(米)。
    明火自己"喘" `f = 1.5/√D`(Cetegen & Ahmed;10 cm ≈ 4.7 Hz,慢长快塌锯齿,幅度缺省 ±0.1——积分辐射看不出喘频,取小),
    气流压过浮力速度 `√(gD)` 就喘不起来(`1/(1+u²/gD)`);风把火吹短 ⇒ 亮度 × `(√(u²+gD)/√(gD))^−0.21`(Thomas 横风火焰长度),
    跟着阵风起落、**以无风为基准**(作者填的强度 = 无风亮度)。**再乘湍流**:相对均方根无风 0.1 → 大风 0.25(按 `u²/(gD+u²)`),
    一阶噪声、角频率 `max(1.5/√D, 0.2·u/D)`(横风绕火把头脱涡,12 m/s ⇒ 24 Hz)——湍流扩散火焰辐射波动沿视线可达 100%、
    频谱 f^−5/3(Faeth/Gore 组),整团火是十几个涡叠的 ⇒ 取 25%(估计值)。⚠ 第一版没这一项,大风里喘被压掉、长度项又只随风慢变,
    制作人真跑:"光感觉他就没有闪"。炭火不喘、风吹更亮(Ranz–Marshall 传质),风里再加 1 Hz、10% 的慢明暗。
    气流 = `entry.air`(场景风 − 宿主速度,× (1 − 挡风),80 ms 低通),与帧动画火苗倾斜同一份——火苗往哪倒、灯多暗读同一股风。
    ⚠ 之前火把用正弦 `amp 0.2 / hz 7 / windAmp 0.8`:跑马梁风里幅度顶到 ±80%、75% 能量在 7 Hz 以上(7/16.9/36.6 Hz),
    制作人原话"闪的太快、和火焰完全对不上"。研究记录与对比图:这次会话的 flicker_research(没入库)。
  - **正弦闪烁**(不写 `kind`,灯笼):`flameOutput(t, amp, hz, seed)`,作者填相对幅度与频率;灯笼按它逐项调过,数值锁死。
- **闪烁的推送必须限速**(`FLICKER_PUSH_HZ`)。灯每推一次 = `SceneLightingPass` 重烘一次整张
  光照缓存(全屏 RGBA16F 一遍)。位置死区拦不住闪烁:强度每帧都越过 1% 阈值。
  位置动了与灯的增减**不受限速**(那是玩家看得见的因果)。
- **限速就必须配抽取滤波:推区间均值,不推当帧瞬时值。** 三个分量在 7 / 16.9 / 36.6 Hz,
  20 Hz 瞬时采样的 Nyquist 只有 10 Hz ⇒ 上面两个谐波**折叠**成 1~2 Hz 的慢晃、谷底被削
  (实测:RMS 偏离真值 10.8%、单次跳变达基准 20%、真值区间 [7.30,10.70] 被压成 [7.87,10.70])。
  只把频率调高不划算——要真正无混叠得 >73 Hz,那等于每帧都推,省下的全吐回去。
  **火那一路仍吃逐帧真值**(只过 50 ms 火焰响应低通,不受推送率限制):眼睛从火苗读爆裂、从光圈读呼吸。
  ⚠ **物理闪烁的灯不走区间均值**:位置一动每帧都推、窗口每帧重开 ⇒ 走路时推的是没平均的逐帧值,24 Hz 湍流原样上屏
  (2026-09-15 真跑:站着像火光、一走就一帧一跳)。改成推之前先过一阶低通 `flameLLight`(τ = 推送间隔 / 2,与区间均值等效噪声带宽相同),
  站着 / 走路读同一个信号,只是走路推得勤。正弦闪烁(灯笼)照旧区间均值,数值不动。
- **死区基准只在真推出去之后才更新**。限速跳过的帧必须留着"还欠一次推"的账,
  否则那一次变化永远发不出去(症状:闪烁偶尔卡住一档)。
- **渐灭到"没有灯"的状态时,灯的形状要留着上一盏**,强度插值到 0 之后才撤。
  直接换成 `null` 会让逐帧那段整体跳过 ⇒ `fadeMs` 算了发不出去,画面第一帧就黑。
- **`setState` 只切离散状态**;燃烧物贴图与粒子没有淡入淡出(纹理换不了半张),`fadeMs` 作用于**灯强度与
  燃烧强度 `burn`**(同一个钟、线性)——粒子发射率与新生大小因此连续过渡。要"渐变的燃烧物贴图"才需要多配中间状态。
- **切状态时上一批效果软停**(不再发射、在飞的飞完),**卸下时硬停**。反过来:切状态硬停 =
  空中火星凭空消失;卸下软停 = 火把离手了半空还挂着一串没来源的火星。
- **手持物(`persistent`)入档的只有玩法事实**(谁、哪个挂点、哪支、什么状态);贴图 / 灯 / 粒子
  全是派生表现,切场景与读档各重派生一次(与 [[plane-system]] 对账器同形状)。
  演出挂件(缺省)不入档;**玩家身上的演出挂件跨场景保留**(既有语义:组装层只收 NPC 的挂件)。
- **跨 await 拍世代号**:贴图异步加载回来时世界可能已经换了(读档 / 切场景 / 已被卸下),
  刚挂上的就是孤儿,当场收掉(见 [[teardown-ordering]])。

## 能点火的挂件(2026-09-16,见 [[burn-system]])

- 预设 / 状态 `igniter: {flameLength?}`(厘米,缺省 20);状态写 `igniter: null` = 这个状态点不了(火把残炭)。
  **能点火 = 当前状态合并后有 igniter 且此刻真的在烧**——`HeldPropSystem.isBurning`:这个状态有灯 **且** 燃烧强度 > 0 **且** 火势 > 0
  **且** 不在时断时续的断档里;`igniterOf(target)` 优先右手。起火点 = `firePoint`(没写 = 支点)。
  ⚠ 只看「有没有灯」不够(制作人 2026-09-16:「要检测的是火,不是火头」):火把灭着 / 被吹到火势 0 / 这个状态不供燃料时,
  画面上明明没有火却能点着东西、还会点着纸钱。`statusOf` 的 `burning` 与火焰段(`igniterFireSegments`)用的是同一个判据。
- 火头每帧是一段火焰(`igniterFireSegments`):从起火点沿"浮力 √(gL) + 火头处相对气流"伸 flameLength,粗 = 物理闪烁直径 / 2(缺省 5 cm),
  组装层交给粒子系统(`setFireSources('heldProp')`)——可燃纸钱碰到会着。
- **动态灯按来源合并**:组装层 `setDynamicLightsFrom(owner, lights)`,挂件是 `prop`、燃烧是 `burn`(`prop` 在前)。挂件系统不再独占 `setDynamicLights`。

## 已知坑(都实测过,都不报错)

| 坑 | 症状 |
|---|---|
| **当前这张原画没烘几何场** | 整套光照禁用 ⇒ **举着火把一点光都没有**,挂件贴图与粒子照旧;这条降级**会出声**(按场景报一次,带烘焙命令)。⚠ 2026-09-14 之前"场景 JSON 没写 `lighting` 块"也会走到这里(崖墓前段1 等 6 个场景),那条已改成按缺省块打光,见 [[scene-lighting]] 硬契约第一条。**夜里不亮先查夜图的目录**:时段原画各有各的 `lighting/<背景基名>/`,只烘了 probe、没烘 `geometry.json` 一样不亮(崖墓前段 / 跑马梁 / 牛头凼的夜曾经就是这样) |
| 挂点名拼错 | 每帧 `getSocketLocalPose` 返回 null ⇒ 不发光、不起效果、**零报错**。现在会报一条带可选挂点名单的警告(只报不拒:读档时序下实体可能还没进场) |
| **挂上了、灯也亮着,火把图却看不见** | 先查挂点那一格的 `front`。身后的挂件 `setChildIndex(0)` 排在身体后面,手贴腰侧的帧上会被**整个**挡住(玩家 idle 离屏合成只露 1.6%),而灯只看"这一格标没标"、不看前后 ⇒ 有光没火把。2026-09-14 之前 `front` 缺省是**身后**,玩家包 41 格一格没勾就是这样;现在**缺省身前、只有显式 `front:false` 才是身后**(TS `socketPoseToLocal` / Python `pose_is_front` 同口径,parity 测试钉着),编辑器挂点面板也会按「挂件预览」把挂件真画出来(身后=被挡住+虚线框)。**标注一律按朝右(图集画的方向)标,画面朝左时运行时前后互换**(制作人 2026-09-14 定死,`socketFrontForFacing` / `socket_front_for_facing`):朝右身前的火把,人转过去朝左就到身后。⚠ 画面朝向 = 内层 `facingX` × **外层镜像**:NPC 转身只翻外层容器(内层恒 +1),精灵从 `setLitParentTransform` 推进来的外层 `sx` 符号知道自己朝哪边——只看 `facingX` 的话 NPC 前后不换 |
| NPC 朝左时挂件灯落在身体另一侧 | 挂件灯位 = 接地点 + 挂点偏移。偏移若取 `getSocketPose`(本容器局部)就漏了外层变换:NPC 转身只翻外层容器,局部位姿不变号。现在走 `SpriteEntity.getSocketOffsetFromContact`(先乘外层缩放含镜像、再转外层旋转,与 `Npc._contactOffset` 同口径),`SpriteEntitySocketFacing.test.ts` 钉着 |
| 预设 id 拼错 | 曾留下一条"幽灵条目"占着那个挂点、还会随 `persistent` 进存档。现在直接不登记 |
| **"关了灯画面没变"** | 先确认那盏灯**在不在视野里**。实测雾津街头某机位上只有 `lamp_1` 在画面内,单独关掉其余 7 盏全屏均值纹丝不动(9.91) |
| 拿蝙蝠验"举火把把群轰散" | 灯确实进了恐惧场,但场按 `(1−r/R)²` 衰减:实测 127 wu 外稳态恐惧只到 **0.086**,而 `fleeThreshold` 是 0.25 ⇒ 群始终 `airborne`,**不惊散**。要"举火把轰散"得靠得更近或调物种权重 |
| 拿 `light: null` 当"灭" | 见上面硬契约那条(渐灭发不出去);这条 2026-09-12 修掉了,别回退成"直接置 null" |

## 标定参考(实测,不是设计值)

| 量 | 实测 |
|---|---|
| 火把灯 `intensity` | ⚠ **9 是 2026-09-12 旧口径下的数,已作废**:2026-09-14 挂件灯改成与普通场景点光同一把尺(打包处统一折 `wuPerQUnit²`,撤了挂件专属补偿)后,制作人把灯笼重调到 lit 0.15 / guarding 0.45 / ember 0.09;两支新火把的起始值(火把 0.1 / 护火 0.08,纤藤火把 0.09 / 0.07)是照这把尺给的草稿,等制作人调 |
| 闪烁(正弦,灯笼口径) | `amp 0.2 / hz 7` ⇒ 强度比值区间 **0.864 ~ 1.162**、均值 0.977;同种子同 `t` 串逐位可复现 |
| 闪烁(物理,火把 D = 0.1 m) | 喘 4.74 Hz;浮力速度 0.99 m/s;10 m/s 横风亮度 × 0.62、喘剩 1%;护火(气流 ×0.2 ⇒ 2 m/s)× 0.86。离线用跑马梁风(speed 800)算推给光照的亮度:点着均值 0.63、变异系数 ~20%;护火 0.86、~19%;无风 1.0、10% |
| 跟随灯的代价(2026-09-12,雾津街头夜,1024×768@1.86) | 举着火把**站着**:限速前 +3.9 ms/帧(73/80 帧在重烘),限速后 **+0.9 ms**(实测推送率 18.3 Hz);**走路**:限速前 +6.3 ms,限速后 **+4.2 ms**(位置每帧都动,限速管不到它) |
| 灯槽 | 跟随灯占一个静态灯槽(上限 24)。作者灯已经摆满的场景里再举火把会触发"丢弃"告警 |
| **推送率的观感代价** | 窗口均值把高谐波滤掉 ⇒ 灯的摆幅小于作者写的 `amp`。实测 20 Hz **保留 0.65**(作者写 0.2、灯只摆 ±0.13);30 Hz ≈0.79(重算帧 1/2)、40 Hz ≈0.85(2/3)、≥73 Hz ≈1.0(等于不限速)。**这是观感 × 帧时的取舍,没有正确答案**——F2「挂点」页可以当场换档看动的,定了再改常量。火那一路(新生大小)吃逐帧真值,爆裂感在粒子上是全的 |

## 怎么验证

- 单元:`heldPropSignal` 是纯函数(确定性可直接断言);粒子侧的锚点跟随在 `vfxSim` 的现有测试域里。
- 真机(判据顺序**不能颠倒**):先确认 `__game.sceneLighting.active === true`
  与 `__game.vfxSystem.currentSpace.kind === 'field'`,否则灯与几何判据全是空成立;
  再读 `__game.sceneLighting.effectiveLights()`(找 `__prop` 前缀那盏)、
  `__game.heldPropSystem.debugSnapshot()`、`__game.vfxSystem.debugSnapshot()`。
  驱动与取帧走 [[runtime-command-channel]] + [[headless-visual-verification]]。
- 画面 A/B 要**框住玩家附近**量均值:全屏均值会被一盏小灯稀释(实测 31→54 与 17→23.7 同一件事)。
- F2「挂点」页:按预设挂(带灯的自动走手持挂件系统)、切状态、读灯强度 —— 数调好抄回挂件预设页。
- **动这套系统必须做灯笼逐 tick 对照**(2026-09-15 起的做法):改代码**之前**在旧代码上真跑抓一份
  确定性基线(跑马梁夜——有场景风,风那一路才跑得到;雾津街头 JSON 里没有 `wind` 块、风恒 0),
  包一层 `applySceneDynamicLights` 记每次推送,逐 tick 采 `effectiveLights()` 里 `__prop` 那盏全字段;
  抓之前把场景风钟、待机节目计时、动画钟、朝向、按键归零,否则"载入到开抓隔了多久"会让数据漂。
  改完用**同一个脚本**重抓逐字 diff(判灯只看灯字段与推送,不看读内部字段名的诊断段)。
  同一页不能重跑:推送限速计时器跨挂载保留。
