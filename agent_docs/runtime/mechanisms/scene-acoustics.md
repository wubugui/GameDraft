---
id: scene-acoustics
title: 场景声学（实时回音）
domain: runtime
type: mechanism
summary: 声学空间→IR→ConvolverNode 的实时回音；v2 几何一律 M-world wu + 全局距离缩放；听者=玩家/相机/实体脚下的 3D 地面点；作者面是独立的声学工作台，游戏只是预览器（dev server 双槽实时联动）；三条硬判据（首回晚于干声时长 / 晚期尾延后 / 不套点源 1/r）
status: active
authority:
  - src/audio/acousticSpace.ts
  - src/audio/SpatialAudioBus.ts
  - src/dev/runtimeAcousticsSync.ts
  - src/core/Game.ts#resolveAudioListener
  - src/systems/AudioManager.ts#playSfxAt
  - public/assets/data/acoustic_spaces.json
  - src/ui/debugAcousticSection.ts
triggers:
  paths:
    - "src/audio/**"
    - "src/dev/runtimeAcousticsSync.ts"
    - "public/assets/data/acoustic_spaces.json"
    - "src/ui/debugAcousticSection.ts"
  topics: [声学, 回音, 混响, 空间音, IR, 冲激响应, ConvolverNode, acousticSpace, distanceScale, 声学联动]
  tasks: [改回音, 加声学空间, 调混响, 场景声学, 改声学联动]
verified_by:
  - src/audio/acousticSpace.test.ts
  - src/audio/acousticSpacesData.test.ts
  - src/dev/runtimeAcousticsSync.test.ts
  - tools/editor/tests/test_acoustic_space_ref.py
  - tools/editor/tests/test_scene_acoustic_field.py
last_governed: 2026-09-08
---

## 是什么（一句话）

场景回音**实时算**，不烘焙：一份「声学空间」→ 冲激响应（IR）→ `ConvolverNode`。
改一个数字立刻重算，毫秒级。

**只做实时，不做离线烘焙**（制作人 2026-09-07 定）：两套实现必然漂移。
同理**作者面只有一个**：独立的声学工作台（见 [[acoustic-workbench]]），游戏是预览器，
**不存在第二条实现路径**——工作台里显示的抽头 / IR 就是运行时 `acousticSpace.ts` 打成的包算的。

## 数据在哪

| 层 | 文件 | 谁写 |
|---|---|---|
| 空间库 | `public/assets/data/acoustic_spaces.json` | **只有**声学工作台（`tools/acoustic_workbench`，原子写 + `.bak`） |
| 场景绑定 | 场景 JSON 的 `acousticSpace` / `acousticListener` | 主编辑器场景属性页的 IdRefSelector |
| 逐条开关 | `audio_config.json` 条目的 `spatial: {wet, dry}` | 手写 / 音频加工台 |
| 联动工作态 | `editor_data/runtime_acoustics.json` + `_status.json` | dev server 槽位，会话态，不进 git / DVC |

缺省（不写 `acousticSpace`）＝没有空间，空间音退化为纯干声。
**一个空间可以强行绑到任何场景上，逻辑上不负责效果对**（制作人 2026-09-08）：
逻辑上一份场景几何一个空间，校验器对「绑定场景 ≠ 作者场景」记 warning 不拦。

## 坐标与单位（v2，2026-09-08 改成世界空间）

**作者面与运行时接口一律是 M-world 的 wu**——与灯位、轨迹同一个坐标系（原点画面中心、
Y 朝上、XZ 地面，`depthConfig.M.R` det=+1）。反射面端点是地面上的 `[x, z]`，`y` 底高程、
`height` 面高；听者 / 声源是**脚下的地面世界点**，耳高 `earHeight`（缺省 141 wu）单独加。

物理只认米，模块内部先换算：**`米 = wu / 88 × distanceScale`**。88 是视觉尺度锚（角色高
150 wu ≈ 1.7 m），不随场景变；`distanceScale` 是每空间一个的**全局距离缩放**——画里可见的
世界只有二三十米宽，而对岸主崖按硬判据要在几百米外，所以反射面**贴着画里的崖壁摆**，
再把整个空间等比放大。立体角项（面积 / L²）对等比缩放不变 ⇒ 缩放只改延迟与空气吸收，
不改强度，这正是"世界变大了"的物理含义。**所有距离一律缩放，包括耳高**（制作人定）。

v1（米 + 屏幕平面 + `anchor`/`wuPerMeter`）已整体迁移（米 × 88，缩放 1，声音与迁移前一致）；
校验器对 v1 字段残留记 **error**——两套坐标系并存，距离整体错 88 倍而不报错。

与视觉几何**解耦**仍是硬规矩：工作台里 3D 展开的场景只是描图参考，几何本身是作者数据。

## 活听者：玩家脚下的 3D 地面点

`Game.acousticListenerAt`：场景点（玩家 / 相机 / 指定 NPC）→ `utils/sceneSpace.groundWorldAt`
（行走面场反投影，与摆灯**同一份**换算）→ M-world wu 地面点 → `setAcousticListener`。
**不要求统一光影启用**，只要照明载荷（`lighting/<背景>/ground_d.png`）在；没烘过深度的场景
回落平面映射（原点画面中心、屏幕向上当纵深），状态里标 `grounded=false`。
`acousticListener.mode`：`player`（缺省）/ `camera` / `entity` + `entityId`（不在场时回落玩家）/ `fixed`。

**配了 `perspectiveScale` 的场景，这条链上的点会按透视重整**（2026-09-08，制作人定）：
`ground_d` 给的是正交斜平面、纵深不含透视，而画面上人缩小 6.76 倍时声音只降 3.8 dB
甚至方向都反。重整式与判据见 [[footstep-and-spatial-audio]] 硬契约 13。
两个后果记在这里：① **反射面不重整**（作者数据，与视觉几何解耦的硬规矩仍然成立）；
② 因此**音频的世界空间与作者摆反射面的空间在这 6 个场景里不重合**，工作台画听者用状态回传的
`worldOrtho`（未重整），算距离用 `world`/`ear`（已重整），3D 里用淡线连着两者。
`acousticListener.backAtBaseZoomWu` 同时是相机视距与透视基准深度（`f=1` 处离相机多远），
**两处必须同源**，分开取就会「声音的远近与画面的缩放对不上」且不报错。

听者更新看的是**总线上实际挂着的空间**，不是场景绑定——工作台可能正推着别的空间预览，
场景本身可能根本没绑，那时听者也得跟着走。

**空间总线要 `Howler.ctx` 才建得出来**：`setAcousticSpace` / `applyAcousticSpaceDef`
建不出总线时把 (id, def) 记进 `pendingAcoustic`，`updateAcousticListener` 每帧 `flushPendingAcoustic()` 补挂。
不记的话「进场景 → 点一下解锁」之后这个场景永远没有回音而毫无痕迹（2026-09-08 一键拉起游戏时抓到）。
状态回传带 `pendingSpace`，工作台芯片显示「等音频解锁才挂上」，F2 状态行也说。

### 音频保活：这是桌面游戏，不是网页（制作人 2026-09-08 定死）

浏览器那套「没点过页面不出声」「没焦点 / 被盖住就把页面降成后台」一律禁止。两头一起做才是"打开就有声、一直有声"：

- **窗口侧**：开发期游戏页一律开在专用 Chromium 实例（`tools/dev/game_preview.py`：`--autoplay-policy=no-user-gesture-required`
  + 不后台降级三件 + `--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion` + 禁缓存，专用 `--user-data-dir`）；
  发行客户端 `src-tauri/src/main.rs` 给 WebView2 同一套 `WEBVIEW2_ARGS`。
- **运行时侧**（`AudioManager.installAudioKeepAlive`）：`Howler.autoSuspend = false`（缺省 30s 没声音就挂起上下文，叠上后台降级
  就是"播着播着断了，点回去再播一下才续上"）；每秒看一眼上下文——**Howler 到第一个 Howl 才建 ctx**，没有就先 `Howler.volume()`
  借它建出来（实测免手势窗开着 15 秒还「未解锁」就是卡在这）；挂起就 `resume()`（只挂一个在飞，浏览器不放行时它等到手势才落）；
  running 而播放门还关着就直接开门放队列、**不放解锁提示音**。`isAudioAutoUnlocked()`：开页时用探针 AudioContext 判这页是不是
  免手势环境，状态回传 `autoplayAllowed`，工作台据此露出「⧉ 专用窗重开」。
- ⚠ vite HMR 不会让已开的页重跑 `init()`：验这段改动要把预览实例杀掉重开，看 `startedAt` 变了才算新页。

### 重算的两道节流（不做就是每帧掉两帧）

重算一次 IR 实测 6–50ms（随 IR 长度），主线程同步做。移动阈值按空间尺度自适应
（`最近反射面距离 × 0.04 × 代价因子`，钳 2–25m，**按 distanceScale 折成米再比**）；最小间隔 300ms；
超 25ms 预算 `console.warn` 一次。晚期尾缓存 / 尾部裁剪 / 峰值边写边记三处优化不变。
⚠ `buildImpulseResponse` 默认返回拷贝，`transient: true` 才给暂存视图（只给立刻 `set()` 进 AudioBuffer 的热路径）。

## 实时联动：工作台 ↔ 游戏（`src/dev/runtimeAcousticsSync.ts`）

照抄光照那套（dev server 文件槽、不新增端口、超时 + 退避 + 看门狗 + 状态行），但拆成**两个单向槽**：

| 路径 | 方向 | 内容 |
|---|---|---|
| `/__gamedraft-api/runtime-acoustics` | 工作台 → 游戏 | 正在编辑的空间定义 + 要预览的空间 id + 试听请求 `{seq, sfxId}`；`rev` 服务端自增 |
| `/__gamedraft-api/runtime-acoustics-status` | 游戏 → 工作台 | 场景 / 绑定与实际挂着的空间 / 已套用 rev / 听者（场景点 + 世界点 + grounded）/ 抽头前 24 / 耗时 / 音频是否解锁；整份覆盖，2s 心跳 |

- 游戏只吃 `writer ≠ 我 && rev > 已见` 且 5 分钟内新鲜的文档；**不看场景**（强绑允许）。
- **试听靠序号**：`probe.seq` 比记住的大就播一次；**第一次看到文档只记不播**（刷新页面不重放）；
  漏看的序号不补播。音频没解锁（`AudioManager.isAudioUnlocked`：见过一次 running 即算，别只看
  `ctx.state`——Howler autoSuspend 会把它挂起）回报「没播出去」。
- **换场景后重新套用**：`setAudioApplier` 把总线换成场景绑定后调 `sync.onSceneChanged()` 归零
  `lastSeenRev`，下一拍若文档仍新鲜就重套——作者在游戏里走到别的场景，听到的仍是工作台里正在调的那份。
- 工作台关掉后游戏保留最后一份工作态，换场景即回到场景绑定（文档过期后不再重套）。
- **状态槽按页存**：几个游戏页（作者旧页签 + 新拉起的预览窗）同时回传时各写各的（vite 端 `{pages: {writer: doc}}`），
  GET 挑 6 秒内有心跳里**最新开的**那页当 `doc`，其余进 `pages`；状态带 `bootId`（= 运行时命令队列的 `targetBootId`，
  工作台切场景只指挥那一页）、`href` / `startedAt` / `autoplayAllowed`。

## F2「声学」页只剩状态与试听

`debugAcousticSection.ts`：状态行（场景 / 挂着谁 / 距离缩放 / 抽头 / 重算耗时 / 阈值）、听者世界坐标与米数、
联动状态行、四个干声试听键、抽头表。**没有画布、没有滑条、没有存盘**——2026-09-08 撤掉，
两个作者面必然漂，而且游戏里根本看不出"这几条线对着画里哪座崖"。

## 三条硬判据（都是踩出来的）

1. **最近反射面的延迟必须大于干声时长**，否则回音压在原声上（猿啼 3 秒 ⇒ 最近面 500 米以上）。
   工作台按每条干声给「放得下 ✓ / ✗」。
2. **晚期尾必须延后到第一次反射之后**——那段空白正是山谷感的来源。
3. **别硬套点源 `1/r` 衰减**：走立体角项（面积/L²）并钳上限。

物理只管两件事：延迟 `2d/c`（`c = 331.3 + 0.606×℃`）与空气对高频的吸收随距离增大（远 = 发闷，不是变轻）。

## 模型：平面摆放 + 高度（不是完整三维）

反射面 = 地面上的线段 + 高度 + 底高程。`tiltDeg >= 45` 视作**水平面**（水面 / 岩檐，`height` 当宽），
镜像在 y 上；竖直面覆盖 `[y, y+height]`，反射点高度取声源与耳朵的中点钳到面的上下边缘（头顶的崖壁比平齐的远）。
遮挡是俯视二维线段求交（听者→面中点、声源→面中点两条线取重的；一层去七成，不硬剔除，`occlusion: false` 可关）。
每个抽头带 `hit`（反射点，wu）——工作台在 3D 里画路径用。

## v3（2026-09-08）：每一条空间音都是有物理位置的声源

制作人原话：「有物理 listener、有各种坐标、有物理反射、有声音空间，声源没有物理位置？」——v2 只有"自己喊"。v3：

- **听者只有一个**（`Game.resolveAudioListener`，`AudioListenerSnapshot`）：脚步、试听、场景回音全用它。绑定按优先级：
  运行时覆盖（动作 `setAudioListener` / 调试命令）> 场景 JSON `acousticListener` > 空间 `listenerBinding` >
  `footstep_sets.json` 的 `listener` > 相机。`player` / `entity` 用 **contactX/Y**（不是 x/y）落到行走面再抬耳高；
  `camera` 是画面中心地面点抬耳高再沿视线反方向退 `listenerBackAtBaseZoomWu × (基准 zoom / 当前 zoom)`；
  `fixed` 钉在作者摆的听者上。状态回传 `listener = {scene, world(地面), ear, forward, grounded, mode, from, targetMissing}`。
  ⚠ 场景几何走 `buildAudioSceneGeometry`：**只要照明载荷在就是 field**，不看 `sceneLighting.active`
  （六个崖墓 / 跑马梁没配 lighting 块；按 active 门控它们全退成平面近似，听者 z 差 800 wu）。
- **声源 = M-world 里的一个发声点**（`AudioManager.playSfxAt(id, at, {volume, onEnd})`；`at = null` 自己喊）。
  每个 voice 三部分（`SpatialAudioBus.playAt`）：**直达声**（`directPath`：延迟 d/c、参考距离衰减 `ref/(ref+rolloff·(d−ref))`、
  被竖直面横挡就闷、方位角决定声像、空气低通）、**早期反射**（`collectTaps` 带 `source`，镜像声源法，按声源格子缓存 IR，
  格子 = 听者重算阈值，LRU 4）、**晚期尾**（与声源无关，全空间一条卷积器，起点在自己喊的首回之后）。
  直达参数住在空间 `direct {refDistanceM, rolloff, maxDistanceM, panWidth}`（声学米，缺省 7 / 1 / 40 / 0.7）。
- **脚步就是这样的声源**：`FootstepSystem` 只交出脚点世界坐标 + 配置增益，`playAt` 进总线；旧的 `spatialize`
  （wu 制参考距离 / 声像）删了，`footstep_sets.json.spatial` 只剩 `listenerBackAtBaseZoomWu` / `planarDepthScale` 有用。
- **试听声源**：空间 `sources[]`（id / 地面点 / 发声高度，缺省耳高）由工作台摆；试听 `probe.at` 带发声点，游戏从那里播。
- **出声证据**：`AudioManager` 在 `Howler.masterGain` 上挂 AnalyserNode，每 100ms 记峰值；状态回传 `outputPeakDb`
  （最近 3 秒）。工作台按试听后 2.6 秒看它：没数就红字。"播放函数返回 true" 不算证据——2026-09-08 试听全哑就是这么漏的。
- 🔴 **Howler 在第一个 Howl 上会关掉重建 AudioContext**（`_unlockAudio`：sampleRate ≠ 44100 就 `unload()`）。
  建在旧 ctx 上的总线从此全哑不报错。两道防：保活先 `_unlockAudio()` 逼它稳定（只逼一次——44.1k 设备上每次调用
  都会再挂一组 document 监听）；`ensureSpatialBus` 见 ctx 关了 / 换了就重建重挂，并把最近喂过的听者立刻喂回去。
- **听者一动，老的早期反射格子 / 尾巴不许立刻拔线**：在飞的声音还等着它 2 秒后的回音。格子带 `users` 引用计数，
  作废只是「退役」，最后一个用它的 voice 走完才 `disconnect`（`SpatialAudioBus.test.ts` 钉着这条）。
- **方位角在听者系里算**：`collectTaps` / `directPath` 接 `forward`，`azimuthIn` 把世界偏移转到听者的右 / 前轴；
  今天所有场景 R 的偏航为 0 所以等于世界 +Z，但别再让它悄悄依赖这一点。ITD：右边来的**右耳先到**。
- **超出 `direct.maxDistanceM` 只是直达声不播，反射照走**——对岸崖顶那个声源本来就只该听到回音；
  什么都没得播（没反射面）才真不起播，`onStart` 不回调，试听序号不推进。
- **进场时机**：`setAudioApplier` 的强制重算跑在照明载荷之前（拿的是上一个场景的场）；载荷落地的 `onReady` 再强制
  一次。听者更新排在 `camera.update` 之后、脚步之前（拿本帧定稿的相机与实体）。音频没解锁时脚步**不排队**（解锁那一刻
  按过时的位置一齐放出来），`playSfxAt` 门关着直接丢。

## 运行时接线

```
                       ┌─→ dryGain ─────────────┐
BufferSource ─→ vol ──┤                         ├─→ Howler.masterGain
                       └─→ wetGain → Convolver ─┘
```

一个场景一个 Convolver；不碰 Howler 内部节点；环境底噪与自带回音的素材**不许标 `spatial`**。

## 校验

- `validator.check_acoustic_space_ref`：未知键 **error**；作者场景 ≠ 绑定场景 **warning**。
- `validator.check_acoustic_space_defs`：v1 残留 / `distanceScale ≤ 0` **error**；作者场景不存在 **warning**。
- `acousticSpacesData.test.ts` 拿**线上那份**库跑判据（首回区间 / 远回 / 抽头数 / v2 形状）。

## 已知边界

- 立体声输出渲染不了仰角，`tap.elevation` 只用于诊断与水平面判定。
- 遮挡只看竖直面。早期反射按声源格子量化（格子 = 听者重算阈值）：同一格里的声源共用一条 IR。
- 移动的长音（循环环境音跟着 NPC 走）没做：直达 / 反射在 voice 起播时定死，一次性短音够用，循环音要分段重播。
- 不支持手机端（制作人 2026-09-07）。
