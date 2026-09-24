---
id: held-prop-system
title: 手持挂件系统(预设即整体 · 离散状态机 · 火势 / 燃料 / 火种 / 玩家按键 · 效果块与等级 · 入档)
domain: runtime
type: mechanism
summary: 手上那件东西是一个整体(贴图 + 粒子挂载 + 可选帧动画火苗 + 自带灯 + 一串离散状态),全登记在挂件预设;动作只切状态名,连续量(燃烧强度、挡风、火势、燃料、闪烁)由系统逐帧派生;风吹灭(火势)、T/Q 按键、火种、耐久、效果块、等级都挂在同一条切状态的路上;"在烧"= 此刻真的有火;进入动作只在真进入时执行;玩法事实入档、表现每个边界重派生;可燃挂件与这一整套互斥、归燃烧系统;灯那一层见 held-prop-lights
status: active
authority:
  - src/systems/heldProp/HeldPropSystem.ts
  - src/data/propPresets.ts
  - src/systems/heldProp/heldPropFlame.ts
  - src/rendering/FireHintMarker.ts
  - src/systems/InventoryManager.ts#consumeIgniterUse
  - public/assets/data/prop_presets.json
  - public/assets/data/prop_effects.json
  - src/systems/graphDialogue/evaluateGraphCondition.ts#isHeldPropLeaf
  - src/core/ActionRegistry.ts#setPropState
  - tools/editor/shared/prop_preview.py#iter_prop_preset_action_lists
triggers:
  paths:
    - "src/systems/heldProp/HeldPropSystem.ts"
    - "src/systems/heldProp/heldPropFlame.ts"
    - "src/data/propPresets.ts"
    - "public/assets/data/prop_presets.json"
    - "public/assets/data/prop_effects.json"
    - "src/rendering/FireHintMarker.ts"
    - "tools/editor/editors/prop_preset_editor.py"
    - "tools/editor/editors/prop_preset_blocks.py"
    - "tools/editor/shared/prop_preview.py"
    - "tools/editor/shared/prop_tryon_canvas.py"
  topics: [火把, 挂件, 灯笼, 挂件状态, 火势, 吹灭, 残炭, 护火, 火种, 燃料, 耐久, 效果块, 等级, playPropVfx, lockPropState, heldProp 条件叶, propLevel, 快灭提示, 驱群]
  tasks: [做火把, 加手持道具, 加挂件状态, 调火把耐风, 调燃料, 加效果块, 让火把驱赶虫群]
verified_by:
  - src/systems/heldProp/HeldPropSystem.test.ts
  - src/rendering/FireHintMarker.test.ts
  - tools/editor/tests/test_prop_blowout_and_lock.py
  - tools/editor/tests/test_prop_fuel_effects_levels.py
  - tools/editor/tests/test_play_prop_vfx_action.py
  - tools/editor/tests/test_prop_burnable_block.py
last_governed: 2026-09-23
---

## 是什么(一句话)

一支火把 = 燃烧物静态图 + 挂在贴图点上的**粒子挂载** `particles:[{effect, point}]` + 可选帧动画火苗 `flame`(保留能力,火把上用粒子)
+ 自带灯 + 离散状态(点着 / 护火 / 残炭 / 灭 / 没点)。这些是**火把自己的属性**,不是调用点的属性,全在预设里;字段语义以
`propPresets.ts` 注释为准。玩法事实只有「谁 / 挂点 / 哪件 / 状态 / 锁 / 火势 / 燃料 / 等级」,其余逐帧派生。
灯位、闪烁、推送限速见 [[held-prop-lights]];燃烧物模板实例化的**可燃挂件**见 [[burn-system]]。

## 硬契约(违反即 bug)

- **覆盖次序**:动作显式参数 > 状态 > 预设;贴图整体替换;状态里写 `light / blowout / igniter: null` = "这个状态没有",不写 = 沿用基础块;
  状态的 `particles` 整体替换基础那一串。`resolveWith`(挂上 / 切状态 / 升级)是唯一解析口径:等级换图 → 解析 → 效果块倍率。
- **粒子挂载**:切状态时同效果同点的沿用原实例(火舌不断),其余旧的软停、新的新开;**卸下硬停**(离手的火把不许挂着一串没来源的火星);
  挂点这一帧没了(蹲下)也硬停、回来重开。新开的实例**当场**套倍率(不然弱火状态头一帧按满强度喷一口)。
  锚点解不出来就等,**绝不用 [0,0,0] 顶替**。在飞粒子带"锚点相对宿主的位移"只对 `followAnchor: rig`。
- **四个实例倍率**:发射率 = 燃烧强度(**闪烁不进发射率**,否则风里火舌断成珠子);新生大小 = burn^0.4 × 热;吃风 = 1 − 挡风;
  火焰长度 = (…)^0.4 × Thomas 横风缩短。自带专门效果的状态(残炭)燃烧强度留 1,写 0 = 那个状态一颗不发。
- **进入动作只在真进入时执行**(`setPropState` 真切换 / `attachToSocket` 动作挂上);读档与切场景的自动重挂**不执行**(否则点火声与信号再来一遍)。
  同一挂点一帧切换超过 8 次拒绝。**进入动作 / 越线动作的顶层 `playPropVfx` 不写 target / socket = 这件挂件自己**,嵌套在控制流里的要写全。
  **持续多久冒多久**的(火舌、残炭)挂 `particles`;**进入那一下发生一次**的(熄灭那口烟)走进入动作里的一次性效果。
- **挂件预设里会执行的动作列表不止一处**(状态进入、基础 / 状态的风吹灭越线动作、燃料烧完动作):编辑器侧扫描面一律从
  `iter_prop_preset_action_lists` 取,别手写一份(它目前漏了 `fuel.onSpentActions`,见治理库外待办)。
- **风吹灭(火势 v)**:气流取挂件处的相对气流(场景风 − 宿主速度,× (1 − 挡风));`u > windSpeed` 掉、否则回;越过 `emberBelow` / 到 0
  切 `emberState` / `outState`(风切的**不算点火**,火势不回满)再跑越线动作。越线要回到线上 0.1 才再武装。**物理不点火**:灭了只能靠火种 / 动作 / 引火;
  动作从残炭 / 灭切出来 = 火势回满。残炭里挡住风、火势回到线上一截 ⇒ 复燃(风切的)。锁 `lockPropState`:`lit` 只回不掉且玩家熄不了,
  `unlit` 点不着;`setPropState` 永远优先。
- **快灭时时断时续**:燃着 / 断着两态每帧按火势占比重判(不许预抽一段时长);断着时灯 × 0.2、火苗 × 0.05;只在有 blowout 的明火状态。
- **"在烧" = 此刻真的有火**(`isBurning`,制作人 09-16:"要检测的是火,不是火头"):当前状态有灯 **且** 燃烧强度 > 0 **且** 火势 > 0
  **且** 不在断档里;可燃挂件改问燃烧系统。点火能力、火焰段、`statusOf().burning`、条件叶都用它。提示符号与效果场故意用"当前状态有灯"(免得一闪一闪)。
- **玩家按键**(只 target=player,输入只在 Exploring 给、按"消费"读,见 [[game-state-handoff]]):T 点 / 熄(残炭算燃着 = T 捂灭),按住 Q 护火;
  锁只拦按键。**护火是玩家手上的姿势**:`playerGuarding` 不入档,跨场景 / 读档重挂时按"此刻还按着 Q"重新认领,
  否则会卡在护火态、`guardBlocksRun` 一直禁跑;动作摆出来的护火(不按 Q)不受影响。**护火只能走不能跑**(护火省燃料的代价,制作人 09-16 乙案)。
  同一帧先收 Q 的挡风、再判点火(Q+T 同按首帧即生效);非明火状态按住 Q 都挡风(残炭复燃与点火共用)。
- **「快灭了」提示是火边的一个符号,不是一行字**(制作人 09-15):挂 entityLayer 最前档、不进实体容器(容器带光照 / 遮挡滤镜且会镜像);
  摆位 = 离火舌、杆子、身体那侧**都最远**的方向(`pickHintAngle`,带回滞)。固定人身外侧 / 按上风侧 / 垂直杆子背着火四版都被真跑测出与火舌或手臂重叠,别退回。
  卸下时 `update` 整段早退,推 null 必须在 `detach` 里补,否则符号卡在半透明。
- **火种**(物品 `igniter`,当前火种在背包):开始点的那一刻扣一次;点火期间风超过该火种 `windLimit`、人在动、再按 T、输入被打断都算没点着。
  三个火种 dep 都不给 = 旧行为(T 直接点着)。
- **耐久**:燃着才烧,残炭慢烧、风大烧得快;最后一段(≤ 15 s)火苗与灯一起收;烧完切 outState(不算点火)+ `onSpentActions`,
  **等进入动作、烧完动作与这件挂件的一次性效果都放完才由系统自己卸下**——内容里写 `detachFromSocket` 会把最后那口烟同帧掐掉。
  烧了一半的记在挂件 id 上(收进包再拿出来接着烧)。
- **效果块**(`prop_effects.json`,每件至多 2 块,等级的块叠在前):数值类相乘、行为类取并集——`fields` 在火头放刺激场
  (**驱群靠这个**,如 `torch:fire`,不是靠灯光),`tags` 进条件叶。新 tag 要给认它的物种配权重,否则放了等于没放。
- **状态进条件与叙事**:`heldProp` 叶(socket / prop / propState / burning / vitality / lock / effect)与 `propLevel` 叶;
  挂上 / 卸下 / 切状态 / 锁变 / 火势每跨 0.05 一档发 `heldProp:changed`,叙事 reactive 合批重评(所以叙事图放行 heldProp)。
  **不镜像成 flag**(物理吹灭时 flag 不会跟着变)。
- **入档的只有玩法事实**:`persistent` 预设的 target / socket / prop / state + 锁 + 火势(< 1)+ 燃料,另有 `levels`、包里的 `fuels`。
  读档先清空、恢复等级与燃料、再按事实重挂(不执行进入动作)。跨 await 的贴图挂载按世代号作废孤儿([[teardown-ordering]])。
  预设 id 不在表里不登记(免得幽灵条目占挂点还进档);挂点名拼错只报不拒。
- **可燃挂件**(预设写 `burnable`)与灯 / 粒子 / 火苗 / 起火点 / 按键 / 吹熄 / 点火能力 / 燃料 / 效果块 / 等级 / 状态表**互斥**,解析时一律给空,校验器拦。

## 已知坑

| 坑 | 症状 |
|---|---|
| 燃尽的火把卸不下来 | 等一次性效果放完才卸;那口烟装不到 / 建不出模拟时实例永不 finished、也不被兜底收(见 vfx-system) |
| 未烘几何场的场景 | 没有相对气流 ⇒ 火势只回不掉,风吹不灭火把 |
| 阵风 / F2 倍率只进挂件侧 | 同一阵风吹得灭火把、吹不灭燃烧系统的蜡烛(见 scene-wind 三份读法) |
| 玩家身上的非 persistent 挂件 | 跨场景保留,但不入档——读档就没了;`attach` 时的显式覆盖(歪着拿)读档后回到预设样子 |
| `ActionSequence`(点火走位)不在世界暂停闸里 | 走位途中风可能把火吹灭,接触帧就不点(暂停闸覆盖哪些状态见 [[world-pause-and-game-clock]];翻背包 / 说明卡期间火势、燃料、风都停) |
| "护火 / 点火"只是挂件状态 | 主角没有专用护火 / 点火身体动画:点火片段复用蹲姿帧,护火走 idle/walk。别把挂件状态名当成身体动作已完成 |
| 背包「拿在手上」挂成 `out`(灭) | `out` 的进入动作会冒一口熄灭烟;没点的火把挂 `unlit`(`light: null, blowout: null`,后者防风里越线切残炭),`prop_presets.json` 里的火把都带这个状态 |
| 源码头注释写"火势不入档""残炭时 T 点火" | 注释过时,以 `serialize` 与 `stepPlayerControl` 为准 |
| 升级件的抗风只放大一点点 | 阵风 + 高度差让气流离散度 > 25%,场景风怎么调都分不开"护着也灭 / 护着能活";升级数值以 `prop_effects.json` 为准(牛头凼 oiled 抗风 ×2) |

## 怎么验证

- `npx vitest run src/systems/heldProp src/rendering/FireHintMarker.test.ts`(进入动作 / 风吹灭 / 玩家按键 / 火种 / 耐久 / 入档 / 粒子挂载 / 一次性效果 / 帧动画火苗 各组)。
- 编辑器侧:`sh scripts/py.sh -m pytest tools/editor/tests -q -p no:cacheprovider -k "prop"`。
- 真机:`window.__game.heldPropSystem.debugSnapshot()`、`statusOf('player')`;F2「挂点」页可按预设挂、切状态。
