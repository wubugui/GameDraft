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
  - src/core/Game.ts#resolveAudioListener
  - src/audio/SpatialAudioBus.ts#playAt
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
  - src/systems/AudioManagerSpatializedBypass.test.ts
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

脚步声由**动画落脚帧**驱动(不是计时器);脚步是**有物理位置的声源**:本系统只交出脚点的 M-world 坐标
与配置增益,经 `AudioManager.playSfxAt` 进空间音总线,距离衰减 / 声像 / 崖壁回音全按听者与脚点的几何算
(2026-09-08 v3 起;旧的 `spatialize` 已删,见 [[scene-acoustics]])。

## 数据住三处,各管各的(2026-09-08 制作人定调)

| 问题 | 住哪 | 谁编辑 |
|---|---|---|
| **哪一帧落脚** | 动画包 `<bundle>/sockets.json` 的 `contactSlots`(**图集槽位**,升序去重) | 「动画浏览」页 → 「挂点 / 落脚帧」区,看着帧图逐帧勾「本帧落脚」(与挂点同一面板、同一份文件、同一份图集指纹) |
| **哪块地用哪套声** | `SceneData.footstepSet` / `ZoneDef.footstepSet`(集 id;zone 覆盖场景) | 场景编辑器 |
| **一套声是什么** | `footstep_sets.json`:`sets[id] = {label?, sfx:{片段名: 音效key}, gainDb?}` + 全局 `clipFallback` / `defaults.gainDb` / `defaults.spatialized` / `spatial` / `listener` | 「脚步集」页 |
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
5. **两级精度,且必须自报在哪一级。** `field` 走行走面真深度,`planar` 按 45° 俯角近似纵深
   (横向仍精确)。没烘过深度的场景(`dev_room`、牛头凼等)仍靠 `planar`;背尸上山那六个场景
   2026-09-08 已烘深度,**必须**走 `field`。几何来自 `Game.buildAudioSceneGeometry`:
   **只要照明载荷在就是 field,不看 `sceneLighting.active`**——按 active 门控会把这六个没配 lighting 块
   的场景全打回 planar,听者 z 差 800 wu(2026-09-08 真机抓到)。
6. **`wuPerQUnit === 1` 一律当可疑值拒绝。** 真值逐场景 154–880;音频侧自己按
   `worldWidth × ppu_work / work.w` 算(与声学工作台同一条式子,逐点 Δ0),`SceneLightingSystem` 无载荷时
   的 `?? 1` 不再参与。拿 1 去算,坐标缩在 ±2 的 q 尺度上,任何参考距离都会让整场声音要么全满幅要么全静音。
7. **推拉镜头用 `zoom / sceneBaseZoom`,不许用可视宽度。**
   `getViewWidth() = screenWidth / (ppu × zoom × worldScale)` 里只有 `screenWidth` 随窗口变,
   用它当视距会让玩家**拉大窗口时全场声音突然变远**。
   实际视距 = `基准视距 × (sceneBaseZoom / zoom) ÷ f`(`f` 见第 12 条)。**基准视距逐场景可调**:
   场景 `acousticListener.backAtBaseZoomWu` > `footstep_sets.json` 的
   `spatial.listenerBackAtBaseZoomWu` > 600。这个数**推不出来**——游戏投影是正交的
   (`sceneSpace.worldToScene` 明确丢掉深度分量),正交相机在无穷远、没有位置,
   所以它是作者约定,只能听着定。
8. **相机听者就是镜头,不叠耳高。** `ear` 到画面中心地面点的距离**恰好等于** `backWu`(单测锁着)。
   `earHeight` 是「人耳离地」,对镜头没有物理意义;叠上去等于把「镜头在中心后方 backWu」与
   「一个人站在镜头位置」两种模型搅在一起——退得越远耳朵飞得越高,而且作者旋钮的读数不再等于
   实际视距(写 600 实测 707 wu)。数学只有 `audioSpace.cameraListener` 一份,`Game` 曾自己抄过
   一遍,2026-09-08 已并回去。
9. **听者只有一个,不写死。** 脚步、试听、场景回音共用 `Game.resolveAudioListener()`:绑定按
   运行时覆盖 > 场景 JSON `acousticListener` > 声学空间 `listenerBinding` > `footstep_sets.json.listener` > 相机
   取;`player` / `entity` 用 contactX/Y 落到行走面抬耳高,目标找不到回落玩家**并在调试状态里标出来**。
   声像在总线里按「声源相对耳朵的方位角」算(正前 = +Z,右 = +X),对相机听者与实体听者同一条式子,
   **没有特例分支**。
   ⚠ `right = up × forward`,**不是** `forward × up`(后者给出 −X,整个声像左右颠倒且不报错)。
10. **每一步是一个独立 voice。** `AudioManager.playSfxAt` 每次调用建自己的 BufferSource + 增益 + 声像节点,
   第 N 步的音量 / 声像天然影响不到第 N−1 步(以前走 Howler 时要靠逐 soundId 才做到)。
   没有 AudioContext(音频还没建起来)时退成 `playTransientSfx`(仍是逐 soundId,只是没位置)。
11. **排在 `camera.update(dt)` 之后。** 听者是本帧定稿的相机位姿,实体位置在
    `player.update` / NPC `cutsceneUpdate` / `trajectorySystem.update` 已全部写完。
    排在前面 = 拿上一帧相机配这一帧实体,快速平移镜头时声像拖尾。
12. **两个全局旋钮住在 `defaults`,都是「不写这个键」= 缺省(2026-09-09 制作人要的)。**
    - `defaults.gainDb`:**全局音量缩放**(dB),与每集 `gainDb` 相加后折线性。
      **逐条还可以再乘一个本处音量**:`sfx` 的值写成 `{ id, volume }` 即可(同一条素材挂在
      `walk` 与 `crouchWalk` 上、后者要轻一半)。两级是**相乘**——dB 管「这块地整体多响」,
      本条 volume 管「这个片段相对本集多响」;脚步**不读**素材级 `audio_config` volume,
      基准就是 gainDb。见[逐处音量](per-site-audio-volume.md)。
    - `defaults.spatialized`:**空间化总闸**,缺省 `true`;`false` = 脚步不进空间音总线,
      **就播一个声音**——没有距离衰减 / 声像 / 传播延迟 / 空气低通 / 早期反射 / 晚期尾,
      只吃 `gainDb` 与 sfx 通道音量。用途是「先把脚步素材本身听清楚」:空间化 + 回音一起上时,
      判断选错了 key / 素材太长 / 电平不对非常困难,关掉对比一遍最快。
    - 实现走 `AudioManager.playSfxAt(..., {spatialized:false})` → `playTransientSfx`,
      与「没有 AudioContext」**同一条**退路,所以音量口径天然一致(两边都是 `volume × sfxVolume`);
      另起一条播放路径就会出现「关了空间化顺便变响了」。
    - ⚠ 运行时判据是 `!== false`,**只认真布尔**:写 `0` / `"false"` 判不出来(`0 !== false` 为真),
      作者以为关了其实照旧走总线且无任何报错。校验器对非布尔记 warning,编辑器用勾选框不给数值框。
    - ⚠ 只管**脚步**;环境音 / NPC / 试听声源各有自己的配置,不受这个闸影响。
    - 调试状态里必须报出来(`space.footstepSpatialized` 与每条 `recent[].spatialized`):
      关掉时脚点 `world` / `mode` 仍照常算照常记,不报的话就是「坐标好好的、听感却没有空间感」查不出原因。
13. **🔴 配了 `perspectiveScale` 的场景,音频距离必须吃透视(2026-09-08)。**
    `ground_d` 是烘焙时按 `Y(q)=qy·cosθ−d·sinθ=Yg` 解出的行走面——**一个斜平面,纵深与屏幕 y
    基本线性,不含透视**(实测跑马梁沿透视轴全程 M-world 的 y 分量恒在 0.00~0.21、z 均匀推进,
    沿视线只有 11.4 m)。而 `perspectiveScale` 说同一段路「看着远了 6.76 倍」。两套模型对不上
    的后果是**视听脱节**,实测:跟随镜头下玩家缩到 1/6.76 而声音**一个 dB 不变**;相机顶到边界
    时声音先变大 4 dB 再变小(他先走近画面中心),画面却在单调变远,**方向都能反**。
    重整式(`f ∝ 1/d` 是投影定义式,不是拟合):

    ```
    P_p = [ P_o⊥ + forward × baseDepthWu ] / f      P_o⊥ = P_o − forward·(P_o·forward)
    ```

    深度 `D0/f`、横向 `P_o⊥/f`(远处横向也一起拉开,正是透视);虚拟相机取 M-world 原点——
    对所有点是同一个平移,**不影响任何两点之间的距离**。离地高度在重整**之后**才加
    (远处的人仍是 150 wu 高,只是看着小)。与 `perspectiveAffectsSpeed` 自洽:远处步长 ×f、
    每单位步长的世界距离 ∝1/f,相乘是**恒定的世界速度**。
    ⚠ **只重整由场景坐标解出来的点**(听者 / 玩家 / NPC / 热点)。声学空间的反射面是作者在
    工作台里按听感摆的 M-world 数据,与视觉几何解耦(scene-acoustics 的硬规矩),不动它。
    ⚠ **没配 `perspectiveScale` 的场景 `persp === undefined`,逐位零变化**——全仓 36 个场景
    只有 6 个配了透视线(雾津街头 / 跑马梁 / 崖墓前段1 / test_room_a / teahouse / 牛头凼)。

## 已知坑

- **发声体挂在 `setInteractionSetter` 上,不是 `rebuildEntityShadows`**:后者被
  `isLightingEnabled` 门控,而目标关卡六个场景根本没有光照载荷。挂错地方就是「静默没有」。
- **zone 事件对脚步没用**:`ZoneSystem.update` 只对**玩家**做 point-in-polygon,
  那两个事件天生只描述玩家。任意实体查区必须直接用 `isPointInPolygon` 按脚点算
  (`ZoneSystem.getZones()` 给区表)。
- **脚点必须用 `contactX/contactY`,不是 `x/y`**:NPC 可配锚点,轨迹飞行期间 `contactY` 是落点。
- **直达声参数住在声学空间的 `direct`(声学米:参考距离 / 衰减 / 最远 / 声像宽),不在 `footstep_sets.json`**:
  `spatial.refDistanceWu / rolloff / maxDistanceWu / panWidth` 已不再被读,只剩 `listenerBackAtBaseZoomWu` 与
  `planarDepthScale` 有用。相机听者站在画面后方 `backWu` 处,所以 `direct.maxDistanceM` 得显著大于它折成的米数
  (600 wu ≈ 6.8 m × 距离缩放),否则连脚下的声音都判成听不见。
  ⚠ **透视场景要按最远处重算这条**:视距 = `基准 ÷ f`,跑马梁远端 f=0.25 ⇒ 2400 wu ≈ 27 m,
  已经吃掉 `maxDistanceM` 缺省 40 的一大半。
- **音频的世界空间 ≠ 光照的 M-world(只在配了透视线的 6 个场景)**:透视重整后的坐标是**音频专用**的,
  与摆灯 / 阴影用的那份不重合。两边不许互相借用坐标点。作者面(声学工作台)画听者用状态回传里的
  `worldOrtho`(未重整,与那张 3D 展开同空间),抽头与距离仍看运行时算出来的那份——
  两个位置在 3D 里用淡线连着,连线长度就是「透视把听者推了多远」。
- **⚠ 现有 5 个声学空间是在不含透视的坐标下调的**:透视重整改变了玩家在空间里的位置,
  跑马梁这种强透视场景(6.76×)的回音听感会变,需要作者在工作台里重听重调。
  画面中部(f≈1)变化很小,两端最明显。
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

- 单测:`npx vitest run src/utils/audioSpace.test.ts src/systems/FootstepSystem.test.ts src/systems/FootstepCadence.test.ts src/systems/AudioManagerSpatializedBypass.test.ts src/data/animationSockets.test.ts`
- 编辑器:`pytest tools/editor/tests/test_contact_slots.py tools/editor/tests/test_socket_panel_flow.py tools/editor/tests/test_footstep_sets_editor.py tools/editor/tests/test_footstep_validation.py`
- 真机(**听感判不了,靠调试状态判**):`window.__gameDevAPI.getFootstepDebugState()`
  给出 `recent`(时刻/发声体/脚步集/片段/帧/音效 key/配置增益/脚点世界坐标 `world`/精度级别)、
  `emitterState`(每个发声体此刻的片段/帧/是否落脚帧)与 `space`(听者绑定与级别)。
  判据:走路时 `frame` 只出现在落脚帧上且交替、同一块地 `audioId` 恒定、
  `world[0]` 随左右移动单调变化、`mode` 在有照明载荷的场景里是 `field`、站着不动 `recent` 不增长;
  出没出声看 `AudioManager.getRecentOutputPeakDb()`(或 F2 声学页的主输出行)。
  无头驱动走路:`__game.fixedTickMode = true` + 对 window 派发 `KeyD` keydown + `await __game.debugStepTicks(180, 16.667)`
  (触摸轴 `setTouchMoveAxes` 不驱动玩家)。
- 落脚帧改动后重跑 `sh scripts/py.sh -m tools.animation_pipeline.contact_frames` 对账。
