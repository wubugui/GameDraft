---
id: footstep-and-spatial-audio
title: 脚步声与空间化音频(帧驱动 + 两级精度 + 可插拔听者)
domain: runtime
type: mechanism
summary: 脚步由动画落脚帧驱动不由计时器,落脚帧住动画包 sockets.json 的 contactSlots(动画浏览页看图标);脚步集一片段一条音效 key 无随机;落脚与出声是两件事;出声只有一份实现(脚步集/两级增益/空间化/句柄回收),跟脚声是玩家落脚事件的延迟重放、走同一条出声路;听者与音频坐标见 audio-listener-space
status: active
authority:
  - src/systems/FootstepSystem.ts
  - src/systems/FollowerFootstepSystem.ts
  - src/data/animationSockets.ts
  - src/rendering/SpriteEntity.ts#isContactFrameAt
  - src/utils/audioSpace.ts
  - src/utils/sceneSpace.ts
  - src/core/Game.ts#resolveAudioListener
  - src/systems/vfx/VfxSystem.ts#sceneToWorld
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
  topics: [脚步, 脚步声, footstep, 空间化, 声像, pan, 听者, listener, 落脚帧, 触地帧, contactSlots, sockets.json, 落脚刺激, sfx:footstep, 地虫, 跟脚声, 跟脚者, 幻听脚步, 有人跟着, setFollowerFootsteps, presenceSfx, 存在声]
  tasks: [加脚步声, 改空间化音频, 改听者, 标落脚帧, 标触地帧, 加移动动画, 给一块地换脚步声, 做跟脚声, 让某个东西跟着玩家走]
verified_by:
  - src/systems/FootstepSystem.test.ts
  - src/systems/FollowerFootstepSystem.test.ts
  - src/systems/AudioManagerSpatializedBypass.test.ts
  - src/systems/FootstepCadence.test.ts
  - src/data/animationSockets.test.ts
  - src/utils/audioSpace.test.ts
  - tools/editor/tests/test_contact_slots.py
  - tools/editor/tests/test_socket_panel_flow.py
  - tools/editor/tests/test_footstep_sets_editor.py
  - tools/editor/tests/test_footstep_validation.py
last_governed: 2026-09-23
---

## 是什么(一句话)

脚步声由**动画落脚帧**驱动(不是计时器);脚步是**有物理位置的声源**:本系统只交出脚点的 M-world 坐标
与配置增益,经 `AudioManager.playSfxAt` 进空间音总线,距离衰减 / 声像 / 崖壁回音全按听者与脚点的几何算
(旧的 `spatialize` 已删)。听者绑定、两级精度、相机视距、透视重整见 [audio-listener-space](audio-listener-space.md);
总线与回音见 [scene-acoustics](scene-acoustics.md)。

## 数据住三处,各管各的(2026-09-08 制作人定调)

| 问题 | 住哪 | 谁编辑 |
|---|---|---|
| **哪一帧落脚** | 动画包 `<bundle>/sockets.json` 的 `contactSlots`(**图集槽位**,升序去重);同文件的 `igniteSlots`(燃烧的点火接触帧)完全同口径 | 「动画浏览」页 → 「挂点 / 落脚帧」区,看着帧图逐帧勾「本帧落脚」(与挂点同一面板、同一份文件、同一份图集指纹) |
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
   理由:(a) 实测两套装扮步频差一倍(常态 walk 循环 1 s、背尸 carry_walk 无 referenceSpeed 恒 2 s),
   任何固定间隔调度都必与其中一套脱节;(b) 播放速率本身是可调量(移动倍率、过场 `playbackSpeed`),
   哪怕拿墙钟做防抖闸也会快放误挡、慢放误放——防抖闸按**动画推进帧数**计。单测锁着
   「同样帧序列,dt 取 0.5 / 16 / 500 ms 响的次数相同」。
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
4. **出声那一半只有一份实现。** 脚点 → 音频解算器(M-world、两级精度、透视重整)→ `playSfxAt`,每一步一个独立 voice;
   听者、坐标与排序约束全在 [audio-listener-space](audio-listener-space.md)。任何"另一种脚步"(跟脚声、将来的幻听)
   都经 `FootstepSystem.playExternalStep` 走这同一条路(脚步集 / 两级增益 / 空间化 / 句柄回收),**不许另起播放路径**
   ——另起一条就会出现"关了空间化顺便变响了"、换地面不换声这类不报错的分叉。
5. **两个全局旋钮住在 `defaults`,都是「不写这个键」= 缺省(2026-09-09 制作人要的)。**
    - `defaults.gainDb`:**全局音量缩放**(dB),与每集 `gainDb` 相加后折线性。
      **逐条还可以再乘一个本处音量**:`sfx` 的值写成 `{ id, volume }` 即可(同一条素材挂在
      `walk` 与 `crouchWalk` 上、后者要轻一半)。两级是**相乘**——dB 管「这块地整体多响」,
      本条 volume 管「这个片段相对本集多响」;脚步**不读**素材级 `audio_config` volume,
      基准就是 gainDb。见[逐处音量](per-site-audio-volume.md)。
    - `defaults.spatialized`:**空间化总闸**,缺省 `true`;`false` = 脚步不进空间音总线,就播一个干声
      (用途:先把素材本身听清楚)。实现与"没有音频上下文"走**同一条**退路,音量口径天然一致。
    - ⚠ 运行时判据是 `!== false`,**只认真布尔**:写 `0` / `"false"` 判不出来(`0 !== false` 为真),
      作者以为关了其实照旧走总线且无任何报错。校验器对非布尔记 warning,编辑器用勾选框不给数值框。
    - ⚠ 只管**脚步**;环境音 / NPC / 试听声源各有自己的配置,不受这个闸影响。
    - 调试状态里必须报出来(`space.footstepSpatialized` 与每条 `recent[].spatialized`):
      关掉时脚点 `world` / `mode` 仍照常算照常记,不报的话就是「坐标好好的、听感却没有空间感」查不出原因。
6. **🔴 落脚与出声是两件事,群体刺激只接落脚(2026-09-16)。**
    `FootstepSystem.tryEmit` 先判落脚(可见 / 按帧防抖 / 显式登记的移动片段),通过就发
    `deps.onContact`(原始场景脚点 `contactX/contactY`),**之后**才走声音(音频解锁、`setEnabled`、
    脚步集、音效 key、`resolveWorld`)。`Game` 在 `onContact` 里经 `vfxSystem.sceneToWorld` 发
    `sfx:footstep` 的 fear 场。
    - 曾经把刺激挂在 `playAt` 里、直接用音频坐标:茶馆(配了透视线)实测说书人第一步的刺激点
      离脚边虫群 607–633 wu(半径 220),虫群不惊——那份坐标做过透视纵深重整,是音频专用的(见 [audio-listener-space](audio-listener-space.md))。
      **不许靠加大半径掩盖**,范围和方向都会错。
    - 同时它还被 `getSpatialContext` 的音频解锁门控连带:没解锁时虫群对脚步毫无反应。
    - 调试状态 `recentContacts` 记每次落脚(不论响没响),与 `recent` 对照分清「没落脚」和「落了脚但没响」。
    - 帧号跟踪不再因音频没解锁而暂停:解锁那一刻不会把当前帧当「新片段第一步」补发一声。

## 跟脚声 = 玩家落脚事件的延迟重放(2026-09-21 拆出)

「后头好像有人跟着走」不是一个音源,是**你走他才走**。`FollowerFootstepSystem` 接
`FootstepSystem.onContact`(帧驱动的那一条),延迟 d 之后经
`FootstepSystem.playExternalStep` 在**玩家当时那个脚点**上播一步。开关是动作
`setFollowerFootsteps`(叙事状态 / zone / 对话图都能调),**与扣血正交**。

- **延迟按步间隔的比例给**(`delayPercent`,缺省 50 = 半步),不是固定毫秒:
  步间隔本身随装扮差一倍(硬契约 1 的实测),固定毫秒必与其中一套贴成回声。
  它同时决定**距离**——那一声落在你 d 秒前站的地方,所以走得快离得远、拐弯沿着你走过的路线,
  **不需要再配「身后多远」**。
- **触发口只有落脚事件**:站着不动没有落脚帧 ⇒ 没有跟脚声。这是结构,不是判断。
- **排队走 `GameClock`**,且回调有**两道闸**:到点闸(`nowMs() >= dueAt`)+ 世代闸。
  `cancelAll()` 是**立刻兑现**不是丢弃,只靠世代闸的话读档那一刻会凭空响一串脚步。
- **开关进档、在途不进档**:这一段有 `setRetryCheckpoint`,不进档 = 死一次跟脚声没了且无报错。
- 换场景:跟脚者**跟着玩家走**(开关不清),但在途那一步作废(脚点属于上一张图)。
  所以「他跟到哪为止」必须由作者显式写 OFF(跑马梁写在「闻到香火」)。

## 已知坑

- **🔴 `healthThreat.presenceSfx` 不是用来做跟脚声的**。2026-09-21 之前跑马梁正是这么干的:
  `soundInterval: 0.8` 固定间隔 + 已删除的 `soundBehindPlayer: 85`(把声源钉在玩家行进方向后方)。
  四个病:与步频脱节(听着是节拍器)、站着不动照响、不吃脚步集(换地面不换声)、
  且把「有人跟着你」与「扣血」焊死在同一个实体上——`duringPresentation` 要在两段里取反,
  于是同一个东西被迫拆成**两个热点**(制作人原话:"有病啊,为啥要做两个")。
  `presenceSfx` 现在只剩「这东西在**它自己待的地方**按间隔发的声」(喘息/拖曳/嗡鸣)。
- **发声体挂在 `setInteractionSetter` 上,不是 `rebuildEntityShadows`**:后者被
  `isLightingEnabled` 门控,而目标关卡六个场景根本没有光照载荷。挂错地方就是「静默没有」。
- `FootstepSystem.setEnabled` / `unregisterEmitter` 生产代码无调用者(只有测试用):看着像开关,实际恒开。
- **zone 事件对脚步没用**:`ZoneSystem.update` 只对**玩家**做 point-in-polygon,
  那两个事件天生只描述玩家。任意实体查区必须直接用 `isPointInPolygon` 按脚点算
  (`ZoneSystem.getZones()` 给区表)。
- **脚点必须用 `contactX/contactY`,不是 `x/y`**:NPC 可配锚点,轨迹飞行期间 `contactY` 是落点。
- **直达声参数住在声学空间的 `direct`(声学米),不在 `footstep_sets.json`**:`spatial` 里只剩
  `listenerBackAtBaseZoomWu` 与 `planarDepthScale` 还被读,其余旧 wu 参数是死键。
- **🔴 现网 `defaults.spatialized` 是 `false`**(09-11 起):脚步(含跟脚声)整条绕开空间总线——没有距离衰减、
  没有声像、没有回音,NPC 脚步多远都一样响。调空间听感前先看这个闸;测试里"现网没这个键"的注释已过时。
- **跟脚者要单独给集增益**:它吃的是全局 `defaults.gainDb`(玩家轻步口径)+ 集增益 + 动作增益,不单给就比玩家自己的
  脚步还轻、被夜里风声床整个盖住(跑马梁 09-23"听不到身后的脚步"主因就是这个,不是代码)。
  另外它只在作者打开的那一段响(`fireStops` 还会让它在有火时停)——编排上开得太短同样听不到。
  真"身后"方位要另立项:相机听者在几百 wu 外,几十 wu 的错位听不出声像。
- **离开 Exploring 时由状态旁听席"收腿"**(`Player.settleLocomotion`):非探索态下 `update` 停了但演出分支仍推
  精灵动画,不收的话人钉在原地走路动画照转、落脚帧照命中、脚步(与跟脚声)连响数秒。有脚本位移或动画归别人时不碰。
  **NPC 侧同类问题未查**。见 [game-state-handoff](game-state-handoff.md)。
- **只标了落脚帧(或点火接触帧)、一个挂点都没有的 sockets.json 是合法的**,`save_socket_set` 只在
  挂点 / 落脚帧 / 点火接触帧**三样都空**时才删文件;校验器也不把它当「空壳」。会走路的包大多就是这种文件。
  图集指纹 stale 时两种接触帧照样可勾(重标保存即刷新指纹),不是禁用。
- **F2 调试注入临时挂点时要把 `contactSlots` / `igniteSlots` 带过去**(`debugSocketSection.ts`),
  否则一开调试挂点脚步(与点火)就没了。
- **`src/authoring/` 被 `import.meta.env.DEV` 整条门控**,玩法路径不能 import 它——
  这就是把换算从 `lightSpace.ts` 下沉到 `src/utils/sceneSpace.ts` 的原因(不是重构洁癖)。
- **`framesBetween` 取最短方向**来区分「正向绕一圈」与「反向退一帧」。代价:一帧内正向
  推进超过 n/2 会被读成反向。真实播放到不了那个速度(要求单帧 `dt × fps × speed > n/2`),
  但改动时要知道这条取舍在。
- worktree 里改 .ts 后 vite 可能发旧模块,重启 vite(`--force`)才生效——「代码改了、真机行为不变」先怀疑这个。

## 怎么验证

- 单测:`npx vitest run src/utils/audioSpace.test.ts src/systems/FootstepSystem.test.ts src/systems/FootstepCadence.test.ts src/systems/FollowerFootstepSystem.test.ts src/systems/AudioManagerSpatializedBypass.test.ts src/data/animationSockets.test.ts`
- 编辑器:`pytest tools/editor/tests/test_contact_slots.py tools/editor/tests/test_socket_panel_flow.py tools/editor/tests/test_footstep_sets_editor.py tools/editor/tests/test_footstep_validation.py`
- 真机(**听感判不了,靠调试状态判**):`window.__gameDevAPI.getFootstepDebugState()`
  给出 `recent`(时刻/发声体/脚步集/片段/帧/音效 key/配置增益/脚点世界坐标 `world`/精度级别)、
  `emitterState`(每个发声体此刻的片段/帧/是否落脚帧)、`space`(听者绑定与级别),
  以及跟脚声那一半:`followers`(开着哪几位、各自参数)、`lastStepIntervalMs`(量到的步间隔)、
  `pendingSteps`(在途几步)、`recentFollowerSteps`(每一声的脚点/片段/延迟/响没响)。
  跟脚声判据:玩家走时 `recentFollowerSteps` 增长且 `delayMs ≈ lastStepIntervalMs × delayPercent%`、
  站住后最多再多一条就停、`recent` 里对应多出 `emitterId: follower:<id>` 的行。
  ⚠ `recentFollowerSteps[].atGameMs`(游戏时钟)与 `recent[].atMs`(FootstepSystem 自己累加的 dt)
  **不同零点、不可相减**——相减会得出“跟脚声响在玩家落脚之前”这种不可能的结论(真机踩过)。

  判据:走路时 `frame` 只出现在落脚帧上且交替、同一块地 `audioId` 恒定、
  `world[0]` 随左右移动单调变化、`mode` 在有照明载荷的场景里是 `field`、站着不动 `recent` 不增长;
  出没出声看 `AudioManager.getRecentOutputPeakDb()`(或 F2 声学页的主输出行)。
  无头驱动走路:`__game.fixedTickMode = true` + 对 window 派发 `KeyD` keydown + `await __game.debugStepTicks(180, 16.667)`
  (触摸轴 `setTouchMoveAxes` 不驱动玩家)。
- 落脚帧改动后重跑 `sh scripts/py.sh -m tools.animation_pipeline.contact_frames` 对账。
