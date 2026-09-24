---
id: strike-threat
title: 落雷(strikeThreat:结算与表现分离的一记雷)
domain: runtime
type: mechanism
summary: 一道雷 = 挑靶收靶(结算,写存档)+ 现画的雷/雷自带的灯/定位雷声/闪白/震屏(表现,同一句发车);雷是世界单位大小、运行时现画(不是贴图);灯沿雷身摆、在水面湿地上照出物理反光;落地那一下有冲击风(只进表现)和点火(只点开了「雷劈能点着」的模板);装饰补雷只补表现不碰结算与随机流;无靶落点只落在观测到的真实表面上;会话被打断时静默档只结算不演
status: active
authority:
  - src/core/Game.ts#strikeThreat
  - src/core/Game.ts#fireOneBolt
  - src/core/Game.ts#removeThreatEntity
  - src/systems/strikePresentation.ts
  - src/systems/strikeLight.ts
  - src/core/Game.ts#boltLightSpec
  - src/core/Game.ts#boltImpact
  - src/systems/vfx/vfxBolt.ts
  - src/rendering/vfx/vfxBoltGlsl.ts
  - src/systems/HealthThreatSystem.ts#pickTarget
triggers:
  paths:
    - "src/systems/strikePresentation.ts"
    - "src/systems/strikeLight.ts"
    - "src/systems/vfx/vfxBolt.ts"
    - "src/rendering/vfx/vfxBoltGlsl.ts"
    - "public/assets/data/vfx/lightning_bolt_*.json"
  topics: [落雷, 雷, 雷符, strikeThreat, 雷光, 连劈, visualStrikes, 装饰雷, 落点采样, 雷声]
  tasks: [调雷法技能, 加一种雷, 改落雷落点, 排查雷声或雷光不对]
verified_by:
  - src/systems/HealthThreatPickTarget.test.ts
  - src/systems/strikeLight.test.ts
  - src/systems/strikeLightBolt.test.ts
  - src/systems/vfx/vfxBolt.test.ts
  - src/core/ActionRegistryGameClock.test.ts
  - tools/editor/tests/test_strike_actions_roundtrip.py
last_governed: 2026-09-24
---

## 是什么(一句话)

`strikeThreat` 动作:对周围最凶 / 最近的威胁劈一道(或一串)雷,把它持久收掉;没靶就在玩家附近
**真实地面上**劈一道空雷。画面、光、声、震、闪属于同一道雷,同一句发车。

## 权威源(读代码从哪进)

`Game.strikeThreat`(链、选靶、收靶、装饰补雷)→ `Game.fireOneBolt`(一道雷的全部表现);
选靶 `HealthThreatSystem.pickTarget`;无靶落点 `strikePresentation.ts`;雷光包络 `strikeLight.ts`;
雷形资产 `vfx/lightning_bolt_*.json`;动作参数与会话接线在 `ActionRegistry` 的 `strikeThreat` handler。
雷的长相由雷电样式写进效果的 `bolts[]`(形状参数)与画它的那几层发射器(`appearance.bolt`,粗细 / 光晕),10 道同组 `雷符天雷`、
种子各不同,在粒子工作台「雷电样式」一节改,见 [[vfx-workbench]]。

## 雷本身(2026-09-24 重做:世界单位、现画、对齐参考图)

- **雷是世界单位大小,整个特效在世界空间**(制作人定死):离得近看到的是雷的一截、但一截很粗;不许"镜头近雷就小"。
  雷高一律**出画面顶**(`cloudWu` 3 万 wu,按需往上续算);闪白与震屏留在屏幕级。参考图 `artifact/Design/雷参考/`(20 张室外)。
- **形状** `vfxBolt.ts`(纯函数):大步 OU 大弯 + 尖角折 → 中点细分到 `detailWu`(大尺度收着折);分叉幂律长度、往下往外、不钻地;
  随机数按**全局大步号**取——分几次续算与一次算完逐点相同、长出同一批分叉(画雷那份按镜头续算、灯那份一次算到灯高,两份必须是同一道雷)。
  实例种子混入落点(`boltInstanceSeed`):雷符写死 `effectSeed: 0` 也每处不同。
- **画法** `vfxBoltGlsl.ts`:逐段按 erf 卷积高斯(接缝无缝)、加性;粗细 = √(世界宽 × 透视 × 像素/场景)² + (屏幕下限)²
  (远了芯不细过几个像素——强光晕开)。按段剔除与挑细分级,不按落点剔除。
- **雷自带的灯**(`bolts[].light`,`Game.boltLightSpec`):落点一盏点光 + 沿雷身折线一段一条**线光**(`kind: 'line'`,主干 ≤8 段 + 最长 2 根分叉)
  + 天上一记平行光;三种都打反光位,**落在哪都照出物理反光**(没画区域的地方用全局缺省材质 + 细节法线,见 [[scene-lighting]]「镜面反光」)。
  ⚠ **雷的一切不许按场景调**(制作人 09-24:「这些雷电不能是场景特调,都是任意地方随机位置放的」):灯的强度、落点层、
  地面反光都是全局一套;验收抓**随机落点**,不是只抓参考图那一个落点。灯在雷**真出现的那一拍**点亮
  (`playVfx` 的 `onStart`),不在发车时。**灯与声不 cull**:雷劈在画外照样亮、照样响(制作人:「光照和声音都要有」)。
- **落地那一下**(`bolts[].impact`,`Game.boltImpact`,与灯同一拍):
  - 冲击风 `blast`(`SceneWindState.addBlast`):**只进表现**——吃场景风的粒子(纸钱、烟尘)与草木摇曳;手持挂件 / 燃烧 / 吹灭**不吃**(那是玩法)。
  - 点火 `igniteRadiusWu`:落点竖直往上同高的一段胶囊里,**只点模板开了「雷劈能点着」`lightningIgnites` 的**(燃烧工作台逐模板开,缺省关);
    场景里的还过宿主那道门(`playerIgnite: false` / 能点的条件没满足的不点);手上的、纸钱薄片同样按模板开关。会进存档。见 [[burn-system]]。
- **落点那几层**(作者层,不归样式):落点光团、火星、焦烟、扬尘 + 碎石(`debris_chips` 图集)/ 砂粒 / 泥土喷溅 / 尘团(`onSurface: ground`)
  + 水花 / 水雾 / 水面电弧(`onSurface: water`,落在表面材质区的水面上时换这一套)。改完用工作台「把别的层同步给同组」抄给 10 道。

## 硬契约(违反即 bug)

- **结算与表现分离**:选靶与收靶只在权威链里发生;`visualStrikes` 系列补的装饰雷**不选靶、不收靶、
  不消耗权威链的随机数**(独立种子)。改表现参数不许改变"劈了谁"。
- **每道雷独立走完整规则**:现取玩家位置、排除本链已劈过的靶再挑——整链复用一个靶 = "几道雷打同一个地方"。
  连劈是几何分布:第 2 道起每道掷一次,掷不中整链停。
- **选靶看定义上的峰值攻击力**,不看此刻读数(举着火时普通鬼读数恒 0,会一个靶都挑不出)。
- **收靶走实体显隐的持久通道**,不另开"杀死"语义;威胁的在场判定绑在同一判据上,实体一关伤害自停。
  因为写存档,不进过场白名单。
- **无靶落点只落在观测到的表面上**:从保留原始像素的严格深度壳样本里抽,缺省只收"壳命中 ≈ 地面 + 地面被观测 +
  碰撞**明确**为空地"的点;给了表面范围区才开放非地面物体表面。碰撞未知 ≠ 空地。半径 / 最小距离 / 间距都是
  **M-world 三维距离**(透视大小 ≠ 世界距离);只有间距可以放宽,半径、表面、视口永不放宽;缺几何 / 越界 / 未知表面
  一律跳过并出声告警,**禁止**平面回退或拿深度分位猜天空。坡度只约束表现候选,不改玩家碰撞语义。真实靶子直接用原位置,不经这些限制。
- **表面目录按粒子空间缓存,在揭幕闸里预热**:第一道雷不许吃全表扫描;缓存键含碰撞判据的函数身份,
  所以那个判据必须是稳定的只读字段,不能每次现造闭包。
- **雷声在落点、走音频解算器**(约人耳高,保留采样表面偏移),不用灯高、不用粒子的 M-world——见
  [audio-listener-space](audio-listener-space.md)。会话内起的雷带 owner,不被本会话自己的闪避压;句柄登记进账本,打断即停。
- **声部 / 粒子上限缺省 0 = 不抢停**,每道自然放完;给正数才启用"超出停最老的"。雷声要完整放完,
  混音验收看**叠音峰值**,不能只看单声起播。
- **静默档**:会话已快进时整链同步走完——结算照做,一道雷不放、不等间隔。连劈间隔里才被打断的靠 `abort()` 掐掉余下。
- **雷光是一组运行时灯(M-world)**:点光 + 线光 + 平行光共用确定性包络、主闪那帧必推、之后限速;单槽后发接管;合成灯表时排最前,
  灯槽满不被挤掉。效果没写 `bolts[].light` 时退回旧的单点光。场景没有光照空间时雷光这层不出,**必须出声告警**。
- **冲击风与点火只在 `fireOneBolt` 里发**(表现同步的那一拍,epoch 闸与灯同一个);装饰补雷也发冲击风,点火照模板开关——
  装饰雷劈在开了开关的草垛上一样会点着(它在画面上确实劈下来了)。
- 间隔、雷柱软停、闪白淡出都吃游戏时钟(开背包雷停在半空)。

## 已知坑

- **收雷光不重推灯表**:会话归位与切场景只清雷光 rig 并删 `strike` 来源,`clear()` 返回的"需要推一次空表"被忽略。
  切场景时场景光照自己清动态灯所以没事;被过场 / 小游戏 / 死亡 / 顶替打断时若雷光正亮,**最后一帧雷光会留在场景光照里**,
  直到手持灯或燃烧下次推灯表。
- 连劈等待后以"粒子空间还在"当"没换场景"的判据:没粒子空间的场景里只有第一道会结算,后续连收靶一起被截断;
  普通(非会话)批里的连劈也没有执行器世代闸——死亡时游戏时钟兑现在途等待,那一道会立刻落下并收靶。
- 动作 / 方法注释说"闪白与震屏不在这里"已过时:`flashAlpha` / `shakeAmplitude` 会让**每道雷**各闪各震。
- 闪白是单槽:落雷登记的清闪白会清掉**当时任何人的**闪白;独立 `screenFlash` 动作不收 scope、不入账。
- 无靶时返回值的 x/y 是逻辑随机点,不是画面上实际落雷的表面点(返回值目前只给测试 / 调试)。
- `fireOneBolt` 里"雷柱是光柱必须软停"的长注释与现资产不符(现有雷形资产都没有光柱,是一次性 burst);
  软停现在只是保险,但会在雷光时长处截断将来加的按速率发射器。
- **参考图的整体明暗不能拿来一个个场景调灯**:09-24 把雷身线光调到 ×3 对齐河边,跑马梁 / 码头(深夜原画很暗)直接曝成白一片;
  灯的强度按参考图的**多数场景**定一套,个别场景的差异交样式参数给制作人调(工作台「雷的灯」那一组)。

## 怎么验证

`npx vitest run src/systems/HealthThreatPickTarget.test.ts src/systems/strikeLight.test.ts src/systems/strikeLightBolt.test.ts src/systems/vfx/vfxBolt.test.ts src/core/ActionRegistryGameClock.test.ts`
+ `sh scripts/py.sh -m pytest tools/editor/tests/test_strike_actions_roundtrip.py`(编辑器往返,含音量精度)。
真机带 `seed` 复现:连劈落点各不相同、装饰雷不改收靶结果、放到一半开背包雷停住、打断后 `getAudioDuck` 回 1 且无残留雷光。
雷形逐帧验收看画面,不靠参数推断:整图取景对着参考图抓(场景全图入镜、隐去 UI 与主角、直接调 `fireOneBolt`
不走结算),20 张室外图逐张并排看;抓图脚本的做法见 [[vfx-workbench]]「雷电样式」。会话语义见 [detached-performance-session](detached-performance-session.md)。
