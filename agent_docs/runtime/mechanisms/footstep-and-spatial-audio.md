---
id: footstep-and-spatial-audio
title: 脚步声与空间化音频(帧驱动 + 两级精度 + 可插拔听者)
domain: runtime
type: mechanism
summary: 脚步由动画落脚帧驱动不由计时器,落脚帧住动画包 sockets.json 的 contactSlots(动画浏览页看图标);脚步集一片段一条音效 key 无随机;空间量一律在 M-world(wu)算;八个场景没有 depthConfig 必须两级降级;听者可设成任意目标且推拉镜头必须用 zoom 比值不是可视宽度
status: active
authority:
  - src/systems/FootstepSystem.ts
  - src/data/animationSockets.ts
  - src/rendering/SpriteEntity.ts#isContactFrameAt
  - src/utils/audioSpace.ts
  - src/utils/sceneSpace.ts
  - src/core/Game.ts#buildFootstepSpatialContext
  - public/assets/data/footstep_sets.json
  - tools/editor/shared/socket_panel.py
triggers:
  paths:
    - "src/systems/FootstepSystem.ts"
    - "src/data/animationSockets.ts"
    - "src/utils/audioSpace.ts"
    - "src/utils/sceneSpace.ts"
    - "public/assets/data/footstep_sets.json"
    - "tools/editor/editors/footstep_sets_editor.py"
    - "tools/editor/shared/socket_panel.py"
    - "tools/editor/shared/animation_sockets.py"
    - "tools/animation_pipeline/contact_frames.py"
  topics: [脚步, 脚步声, footstep, 空间化, 声像, pan, 听者, listener, 落脚帧, 触地帧, contactSlots, sockets.json]
  tasks: [加脚步声, 改空间化音频, 改听者, 标落脚帧, 标触地帧, 加移动动画, 给一块地换脚步声]
verified_by:
  - src/systems/FootstepSystem.test.ts
  - src/systems/FootstepCadence.test.ts
  - src/data/animationSockets.test.ts
  - src/utils/audioSpace.test.ts
  - tools/editor/tests/test_contact_slots.py
  - tools/editor/tests/test_socket_panel_flow.py
  - tools/editor/tests/test_footstep_sets_editor.py
  - tools/editor/tests/test_footstep_validation.py
last_governed: 2026-09-08
---

## 是什么(一句话)

脚步声由**动画落脚帧**驱动(不是计时器)、按**发声体与听者在 M-world 里的三维关系**算出
增益与声像,经 `AudioManager.playTransientSfx` 的**逐 soundId** 通道播出。

## 数据住三处,各管各的(2026-09-08 制作人定调)

| 问题 | 住哪 | 谁编辑 |
|---|---|---|
| **哪一帧落脚** | 动画包 `<bundle>/sockets.json` 的 `contactSlots`(**图集槽位**,升序去重) | 「动画浏览」页 → 「挂点 / 落脚帧」区,看着帧图逐帧勾「本帧落脚」(与挂点同一面板、同一份文件、同一份图集指纹) |
| **哪块地用哪套声** | `SceneData.footstepSet` / `ZoneDef.footstepSet`(集 id;zone 覆盖场景) | 场景编辑器 |
| **一套声是什么** | `footstep_sets.json`:`sets[id] = {label?, sfx:{片段名: 音效key}, gainDb?}` + 全局 `clipFallback` / `defaults.gainDb` / `spatial` / `listener` | 「脚步集」页 |
| **音效 key 本身** | `audio_config.json` sfx 区(与其它音效同一张表) | Audio 页 / 音频加工台 |

**一个片段一条 key,确定性播放。没有随机轮换、没有变速/音量抖动。** 地面换了声音就换,
靠 zone 切集,不靠在一个集里掷骰子。曾经的 `variants` 数组 / `pitchJitter` / `gainJitterDb` /
`contactFrames` 已全部删除;校验器对残留的旧键报 warning。

## 权威源(读代码从哪进)

`FootstepSystem`(触发) → `SpriteEntity.isContactFrameAt`(帧 → 槽位 → contactSlots) →
`audioSpace.ts`(听者/距离/声像) → `sceneSpace.ts`(坐标换算)。
sidecar 解析在 `animationSockets.ts::parseSocketSet`(与 Python `animation_sockets.py` 镜像)。

## 硬契约(违反即 bug)

1. **🔴 绑帧,不绑时间——一处都不许有时间量参与判断。** 触发是
   `framesBetween(上一帧, 本帧, 帧数)` + 落脚帧命中,与 `frameRate` /
   `playbackSpeed` / `referenceSpeed` 全无关。
   理由有两层:
   (a) 实测两套装扮步频差一倍且互不相同——常态 `walk` 16 帧 @8fps + `referenceSpeed=50`,
   默认 walkSpeed=100 把倍率顶到 `LOCOMOTION_RATE_MAX=2` ⇒ 循环 1.000 s;
   背尸 `carry_walk` 12 帧 @6fps、**无 referenceSpeed** ⇒ 恒 1 倍速 ⇒ 循环 2.000 s,
   完全不跟速度走。任何固定间隔调度都必然与至少一套脱节。
   (b) **播放速率本身就是可调量**(`applyLocomotionSpeed`、过场的 `playbackSpeed`),
   所以哪怕只是拿墙钟做个防抖闸也是错的:快放时误挡、慢放时误放。
   踩过:第一版用 90ms 最小间隔挡抖动,已改为按**动画推进帧数**计的闸
   (`framesSinceStep`)。`nowMs` 现在只给调试记录打时间戳,**不参与任何判断**。
   单测里有一条「同样的帧序列,dt 取 0.5ms / 16ms / 500ms 响的次数必须相同」锁着这条。
   **音频侧绝不为节奏去改动画数据**(`referenceSpeed` 之类归动画,踩过一次被制作人叫停)。
2. **🔴 落脚帧是看着图标的,住 sockets.json,按图集槽位;没标一律不响。**
   `SpriteEntity.isContactFrameAt(frame)`:当前片段第 `frame` 帧画的是哪一格 ∈ `contactSlots`。
   按槽位不按片段帧下标:同一格在几个片段里复用(背尸包 walk/run/carry_walk 共用 12 格)只标一次,
   片段帧序改了标注不漂。**没有「按帧数猜 0 与中点」的兜底**——猜出来的 `walk:[0,8]` 与真值
   `[3,11]` 差半步,声音响在脚还在空中的时候,而且没有任何报错。
   `sh scripts/py.sh -m tools.animation_pipeline.contact_frames` 从原画量贴地像素给**建议值**
   (`--write` 落盘,走编辑器同一套读写);最终以人在动画浏览页看图为准。
   指纹对不上(重导出图集)⇒ 整份 stale ⇒ 挂件不挂、脚步不响,校验器报 error。
3. **🔴 只有显式登记过的片段才是移动片段。** 判据:出现在某个集的 `sfx` 里,
   或出现在 `clipFallback` 里。**绝不许有「最后兜底到 walk」这种隐式回落**——
   那会让 `idle` 也查到音效,于是**站着不动每秒响一声脚步**。这条是真机抓出来的:
   当时 36 条单测全绿(测试配置里从没出现过 `idle`)。
4. **空间量一律在 M-world(wu)里算。** 场景坐标(2D、画布左上原点、y 向下)只是**输入**,
   q 空间只是**场景几何的来源**,两者都必须先过 `sceneSpace` 转到 M-world 才参与计算。
   换算只有一份实现(`src/utils/sceneSpace.ts`),`LightSpace` 已改为委托它。
5. **两级精度,且必须自报在哪一级。** 全仓 36 个场景里 **8 个没有 `depthConfig`**
   (`dev_room` + 跑马梁/崖墓入口/崖墓前段/崖墓前段1/崖墓后段/崖墓正式/牛头凼),
   而后七个正是背尸上山这一关的全部场景。`field` 走行走面真深度,`planar` 按 45°
   俯角近似纵深(横向仍精确)。只写 `field` 一条路 = **在最需要它的关卡里静默失效**。
6. **`wuPerQUnit === 1` 一律当可疑值拒绝。** 真值逐场景 154–880;
   `SceneLightingSystem` 无载荷时 `?? 1` 静默回落。拿 1 去算,坐标缩在 ±2 的 q 尺度上,
   任何按 wu 定的参考距离都会让整场声音要么全满幅要么全静音。同族事故在光照侧已出过两次。
7. **推拉镜头用 `zoom / sceneBaseZoom`,不许用可视宽度。**
   `getViewWidth() = screenWidth / (ppu × zoom × worldScale)` 里只有 `screenWidth` 随窗口变,
   用它当视距会让玩家**拉大窗口时全场声音突然变远**。
8. **听者不写死。** `camera`(缺省) / `player` / `npc` / `fixed` 四种;目标找不到回落相机
   **并在调试状态里标出来**。声像取「方向在听者横轴上的投影」,对相机听者与实体听者是
   同一条式子——相机听者的 `right` 恰好是 M-world 的 +X(屏幕右),自然退化成「看到在左就听在左」,
   **没有特例分支**。
   ⚠ `right = up × forward`,**不是** `forward × up`(后者给出 −X,整个声像左右颠倒且不报错)。
9. **逐 soundId,绝不组级。** `AudioManager.playSfx` 的音量是 **Howl 组级**(不传 soundId,
   同 id 共用缓存 Howl),第 N 步设的音量会**追溯改掉还在响的第 N−1 步**。
   脚步必须走 `playTransientSfx`。同理 `pan` 也一律带 sid:组级 `_stereo`/`_pos`
   会被该 Howl 的所有后续实例继承**且再也清不掉**。
10. **排在 `camera.update(dt)` 之后。** 听者是本帧定稿的相机位姿,实体位置在
    `player.update` / NPC `cutsceneUpdate` / `trajectorySystem.update` 已全部写完。
    排在前面 = 拿上一帧相机配这一帧实体,快速平移镜头时声像拖尾。

## 已知坑

- **发声体挂在 `setInteractionSetter` 上,不是 `rebuildEntityShadows`**:后者被
  `isLightingEnabled` 门控,而目标关卡六个场景根本没有光照载荷。挂错地方就是「静默没有」。
- **zone 事件对脚步没用**:`ZoneSystem.update` 只对**玩家**做 point-in-polygon,
  那两个事件天生只描述玩家。任意实体查区必须直接用 `isPointInPolygon` 按脚点算
  (`ZoneSystem.getZones()` 给区表)。
- **脚点必须用 `contactX/contactY`,不是 `x/y`**:NPC 可配锚点,轨迹飞行期间 `contactY` 是落点。
- **`maxDistanceWu` 必须显著大于 `listenerBackAtBaseZoomWu`**:相机听者站在画面后方那么远,
  画面正中的声源距离听者也有 `backWu`。max 比它小 = 连脚下的声音都判成听不见。
- **只标了落脚帧、一个挂点都没有的 sockets.json 是合法的**,`save_socket_set` 只在
  两样都空时才删文件;校验器也不把它当「空壳」。会走路的包大多就是这种文件。
- **F2 调试注入临时挂点时要把 `contactSlots` 带过去**(`debugSocketSection.ts`),
  否则一开调试挂点脚步就没了。
- **`src/authoring/` 被 `import.meta.env.DEV` 整条门控**,玩法路径不能 import 它——
  这就是把换算从 `lightSpace.ts` 下沉到 `src/utils/sceneSpace.ts` 的原因(不是重构洁癖)。
- **`framesBetween` 取最短方向**来区分「正向绕一圈」与「反向退一帧」。代价:一帧内正向
  推进超过 n/2 会被读成反向。真实播放到不了那个速度(要求单帧 `dt × fps × speed > n/2`),
  但改动时要知道这条取舍在。
- **worktree 里改 .ts 后 vite 可能发旧内容**:实测本次真机验证时服务持续返回旧模块,
  重启 vite(`--force`)才生效。表现是「代码改了、真机行为不变」,极易误判成没修好。

## 怎么验证

- 单测:`npx vitest run src/utils/audioSpace.test.ts src/systems/FootstepSystem.test.ts src/systems/FootstepCadence.test.ts src/data/animationSockets.test.ts`
- 编辑器:`pytest tools/editor/tests/test_contact_slots.py tools/editor/tests/test_socket_panel_flow.py tools/editor/tests/test_footstep_sets_editor.py tools/editor/tests/test_footstep_validation.py`
- 真机(**听感判不了,靠调试状态判**):`window.__gameDevAPI.getFootstepDebugState()`
  给出 `recent`(时刻/发声体/脚步集/片段/帧/音效 key/增益/声像/距离/精度级别)、
  `emitterState`(每个发声体此刻的片段/帧/是否落脚帧)与 `space`(听者与级别)。
  判据:走路时 `frame` 只出现在落脚帧上且交替、同一块地 `audioId` 恒定、
  `pan` 随左右移动穿过零点、站着不动 `recent` 不增长。
- 落脚帧改动后重跑 `sh scripts/py.sh -m tools.animation_pipeline.contact_frames` 对账。
