---
id: held-prop-lights
title: 手持光源的灯(运行时灯那一层 · 跟随灯 · 灯位在 M-world 身体外侧 · 闪烁信号与推送限速)
domain: runtime
type: mechanism
summary: 挂件自带灯与配了 follow 的作者灯每帧解出 M-world 灯位,作为运行时灯加在作者灯之外(作者数据一个字节不动),按来源合并(落雷 / 挂件 / 燃烧);灯位只在真 3D 场上解、解不出就不发光;闪烁是一个信号同时驱动灯与火(物理闪烁 / 正弦闪烁两种);灯每推一次整张光照缓存重烘,所以强度变化限速 20 Hz 且必须配抽取滤波;挂件状态机本身见 held-prop-system
status: active
authority:
  - src/systems/heldProp/HeldPropSystem.ts
  - src/systems/heldProp/heldPropSignal.ts
  - src/rendering/SpriteEntity.ts#getAttachmentPointOffsetFromContact
  - src/core/SceneLightingSystem.ts
  - src/core/Game.ts#setDynamicLightsFrom
  - src/data/propPresets.ts
triggers:
  paths:
    - "src/systems/heldProp/heldPropSignal.ts"
    - "src/systems/heldProp/HeldPropSystem.ts"
    - "src/data/animationSockets.ts"
    - "tools/editor/shared/animation_sockets.py"
    - "tools/editor/shared/socket_panel.py"
    - "tools/editor/shared/socket_canvas.py"
    - "tools/editor/editors/prop_preset_blocks.py"
  topics: [手持光源, 跟随灯, 挂件灯, 运行时灯, 动态灯, 闪烁, 物理闪烁, fadeLight, 挂点, 灯位, 灯槽]
  tasks: [让灯跟着人走, 调挂件自带灯, 调闪烁, 查火把不亮]
verified_by:
  - src/systems/heldProp/HeldPropSystem.test.ts
  - src/systems/heldProp/heldPropSignal.test.ts
  - src/rendering/SpriteEntitySocketFacing.test.ts
  - tools/editor/tests/test_prop_flicker_forms.py
last_governed: 2026-09-23
---

## 是什么(一句话)

[[held-prop-system]] 的灯那一半,外加 `LightDef.follow` 的作者跟随灯与 `fadeLight`。灯作为**运行时灯**经
`SceneLightingSystem` 的另一层叠加进 [[scene-lighting]] 的同一次 `packLights`;一切灯位在 M-world(铁律 0,[[coordinate-spaces]])。

## 硬契约(违反即 bug)

- **绝不写作者数据**。跟随灯与渐灭覆盖只住在运行时那一层;`sceneLighting.params` 是作者那份、编辑器实时同步读写它——
  混进去就会被回写成一盏钉在某坐标上的莫名灯。判据:`fadeLight` 跑完那盏作者灯的 JSON 逐字不变。
  配了 `follow` 的作者灯,原件必须从生效列表跳过(否则两份)。`fadeLight` 存的是强度倍率,跟随灯自己再乘一次;倍率是演出态,切场景清空。
- **运行时灯按来源整份替换再合并**(`setDynamicLightsFrom`),次序 = 优先级:**落雷 → 手持 → 燃烧**。灯槽满时按数组次序截断,
  排后面的只丢一行告警。动态灯 id 前缀(`__prop` / `__burn`)不与作者灯撞。
  **任何来源被清空后必须重推一次合并表**:只从来源表里删掉、不重推,光照里还挂着上一次推出去的灯,直到别的来源下次推灯
  (落雷收尾 / 切场景就是这样留下残留雷光,见 [[strike-threat]];代码未修)。
- **灯位只认 M-world,只在真 3D 场上解**:平面近似那份返回的是画面坐标,拿去当灯位不报错、灯静默落到别处——所以此时灯位 null、
  这一帧不发光;粒子锚点可以降级到平面近似,灯不可以。**解不出来就不发光,不回落 `pos`**(目标不在场 / 挂点这帧没标注 / 没几何)。
- **灯位出发点**:`light.socket` → 预设 `firePoint`(穿过挂件自己的支点 / 自转 / 缩放 / 镜像)→ 挂点本身;然后按宿主脚点重建直立面、
  按前后关系外推到**身体外侧**,离身距离与身体厚度按**精灵格宽的比例**取(属于实体,不属于场景 q 尺——按 q 尺放大过,夜街转身灯高差 205 wu)。
  不写 firePoint 的挂件必须逐位回到老路(灯笼调光是逐项调过的)。`light.offset` 是世界 wu。NPC 转身只翻外层容器,偏移必须乘外层变换。
- **强度口径与普通场景点光同一把尺**(打包处统一折 wuPerQ²,挂件专属补偿已撤),标定见 [[lighting-scale-reference]]。
- **闪烁必须是一个信号** L(t),同时驱动灯强度与火的大小(按 2/5 次方),两处各摇随机数 = "灯在闪、火苗不动":
  - **物理闪烁**(`flicker.kind: flame | ember`,火把):作者只填燃烧面直径;喘频 `1.5/√D`,横风按 Thomas 关系吹短变暗(以无风为基准),
    叠湍流(相对均方根随 `u²/(gD+u²)` 从 0.1 到 0.25);炭火不喘、风吹更亮。气流与火苗倾斜读同一股挡过风的相对气流。
  - **正弦闪烁**(不写 kind,灯笼):作者填幅度与频率,数值锁死。**护火(挡风)不动正弦灯**,只动物理闪烁灯(护火 = 火把在风里亮回来)。
- **推送限速**:位置动了 / 灯数变了立刻推;只有强度变时 ≤ 20 Hz——每推一次 = 整张光照缓存重烘。
  **限速必须配抽取滤波**:正弦灯推区间均值(瞬时采样会把高谐波折叠成慢晃),物理闪烁灯推之前过一阶低通(否则走路时每帧推、湍流原样上屏)。
  火那一路吃逐帧真值,不受推送率限制。死区基准只在真推出去之后更新(否则那次变化永远发不出去)。
- **切状态的渐变插在推出去的亮度本身上**(切换那一刻真实亮度 → 新目标),不是插基准再乘新闪烁;渐灭到"没有灯"的状态时保留上一盏的形状、
  强度到 0 再撤——直接置 null 第一帧就黑。挂点回来(站起)灯从 0 亮回。

## 已知坑

| 坑 | 症状 |
|---|---|
| 当前原画没烘几何场 | 举着火把一点光都没有(挂件与粒子照旧);会出声,每场景一次。夜里不亮先查夜图目录有没有 `geometry.json` |
| 挂上了、灯亮着,火把图看不见 | 查挂点 `front`:缺省**身前**,显式 `false` 才身后;标注按朝右标,画面朝左时前后互换(制作人 09-14 定死);画面朝向 = 内层 facing × 外层镜像 |
| 挂点名拼错 | 不发光、不起效果,只报一条带可选名单的警告 |
| "关了灯画面没变" | 先确认那盏灯在视野里 |
| 限速后灯的摆幅小于作者写的 `amp` | 20 Hz 均值只保留约 0.65;这是观感 × 帧时的取舍,F2「挂点」页可换档看 |

代价参考(09-12 雾津街头夜):举火把站着限速后 +0.9 ms/帧,走路 +4.2 ms(位置每帧动,限速管不到)。

## 怎么验证

- `npx vitest run src/systems/heldProp src/rendering/SpriteEntitySocketFacing.test.ts`(灯位与效果共享世界锚点、平面近似不发光、灯在人物外侧、朝向)。
- 真机判据顺序不能颠倒:先确认 `__game.sceneLighting.active` 与 `__game.vfxSystem.currentSpace.kind === 'field'`,
  再读 `__game.sceneLighting.effectiveLights()`(找 `__prop` 那盏)。画面 A/B 框住玩家附近量均值(全屏均值会被稀释)。
- **动这套灯必须做灯笼逐 tick 对照**:改之前在旧代码上抓确定性基线(跑马梁夜,有场景风),包 `applySceneDynamicLights` 逐 tick 记
  `__prop` 那盏全字段;抓之前把风钟、待机计时、动画钟、朝向、按键归零;改完同脚本重抓逐字 diff。同一页不能重跑(限速计时器跨挂载保留)。
