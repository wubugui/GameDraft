---
id: scene-acoustics
title: 场景声学（实时回音 + 有位置的声源）
domain: runtime
type: mechanism
summary: 声学空间→IR→ConvolverNode 的实时回音；几何一律 M-world wu + 全局距离缩放；每条空间音 = 直达 + 早期反射 + 晚期尾，走与 Howler 并行的空间音总线；作者面只有声学工作台，游戏是预览器（dev server 双槽实时联动）；三条硬判据（首回晚于干声时长 / 晚期尾延后 / 不套点源 1/r）
status: active
authority:
  - src/audio/acousticSpace.ts
  - src/audio/SpatialAudioBus.ts
  - src/dev/runtimeAcousticsSync.ts
  - src/systems/AudioManager.ts#playSfxAt
  - src/systems/AudioManager.ts#flushPendingAcoustic
  - public/assets/data/acoustic_spaces.json
  - src/ui/debugAcousticSection.ts
triggers:
  paths:
    - "src/audio/**"
    - "src/dev/runtimeAcousticsSync.ts"
    - "public/assets/data/acoustic_spaces.json"
    - "src/ui/debugAcousticSection.ts"
  topics: [声学, 回音, 混响, 空间音, IR, 冲激响应, ConvolverNode, acousticSpace, distanceScale, 声学联动, 直达声, 空间音总线]
  tasks: [改回音, 加声学空间, 调混响, 场景声学, 改声学联动, 给场景绑回音]
verified_by:
  - src/audio/acousticSpace.test.ts
  - src/audio/acousticSpacesData.test.ts
  - src/audio/SpatialAudioBus.test.ts
  - src/dev/runtimeAcousticsSync.test.ts
  - tools/editor/tests/test_acoustic_space_ref.py
  - tools/editor/tests/test_scene_acoustic_field.py
last_governed: 2026-09-23
---

## 是什么（一句话）

场景回音**实时算**，不烘焙：一份「声学空间」→ 冲激响应（IR）→ `ConvolverNode`，改一个数字毫秒级重算。
有物理位置的声音（脚步、雷、试听声源）都经它播：直达声 + 早期反射 + 晚期尾。

**只做实时，不做离线烘焙**（制作人 2026-09-07 定）：两套实现必然漂移。同理**作者面只有一个**：
[声学工作台](../../editor-tools/mechanisms/acoustic-workbench.md)，游戏是预览器；工作台显示的抽头 / IR 就是运行时
`acousticSpace.ts` 打成的包算的，**不存在第二条实现路径**。

## 数据在哪

| 层 | 文件 | 谁写 |
|---|---|---|
| 空间库 | `public/assets/data/acoustic_spaces.json` | **只有**声学工作台（原子写 + `.bak`） |
| 场景绑定 | 场景 JSON 的 `acousticSpace` / `acousticListener` | 主编辑器场景属性页 |
| 逐条开关 | `audio_config.json` 条目的 `spatial: {wet, dry}` | 手写 / 音频加工台 |
| 联动工作态 | `editor_data/runtime_acoustics.json` + `_status.json` | dev server 槽位，会话态，不进 git / DVC |

缺省（不写 `acousticSpace`）＝没有空间，空间音退化为纯干声。**运行时只从场景 JSON 读绑定**——空间库里的
`authoring.sceneId` 只记"作者在哪张图上摆的"，不是绑定。一个空间可以强绑到任何场景（制作人 2026-09-08），
校验器对「绑定场景 ≠ 作者场景」记 warning 不拦。

## 坐标与单位

**作者面与运行时接口一律是 M-world 的 wu**——与灯位、轨迹同一个坐标系。反射面端点是地面上的 `[x, z]`，
`y` 底高程、`height` 面高；听者 / 声源是脚下的地面世界点，耳高单独加。
模型是"平面摆放 + 高度"，不是完整三维：**`tiltDeg ≥ 45` 的面视作水平面**（水面 / 岩檐，此时 `height` 当**宽**用，
镜像在 y 上；`acousticSpace.ts#isHorizontalReflector`），其余是竖直面；遮挡是俯视二维线段求交、逐层衰减不硬剔除。
手写或迁移空间数据时把水平面的 `height` 当面高 = 静默错一整面。

物理只认米，模块内部换算：**`米 = wu / 88 × distanceScale`**。88 是视觉尺度锚（不随场景变）；`distanceScale`
是每空间一个的**全局距离缩放**——画里可见的世界只有二三十米，而对岸主崖按硬判据要在几百米外，所以反射面
**贴着画里的崖壁摆**，再把整个空间等比放大。立体角项对等比缩放不变 ⇒ 缩放只改延迟与空气吸收，不改强度。
**所有距离一律缩放，包括耳高**（制作人定）。v1（米 + 屏幕平面）字段残留校验器记 **error**（两套并存距离整体错 88 倍）。

与视觉几何**解耦**是硬规矩：反射面是作者按听感摆的数据，运行时不从场景几何推导，透视重整也不碰它。
听者解析、两级精度、透视重整与"音频世界 ≠ 光照世界"见 [audio-listener-space](audio-listener-space.md)。

## 三条硬判据（都是踩出来的）

1. **最近反射面的延迟必须大于干声时长**，否则回音压在原声上（猿啼 3 秒 ⇒ 最近面 500 米以上）。
2. **晚期尾必须延后到第一次反射之后**——那段空白正是山谷感的来源。
3. **别硬套点源 `1/r` 衰减**：大反射面走立体角项（面积 / L²）并钳上限。

物理只管两件事：延迟 `2d/c`（声速随气温）与空气对高频的吸收随距离增大（远 = 发闷，不是变轻）。

## 声源与总线（`SpatialAudioBus`，与 Howler 并行）

- **不碰 Howler 私有节点**，走原生 Web Audio 并行通道，汇入 Howler 主增益（因此被总音量管住）。
  每个 voice 三部分：**直达声**（传播延迟、参考距离衰减、被竖直面横挡就闷、方位决定声像、空气低通；参数住空间
  `direct`，声学米）、**早期反射**（镜像声源法，按声源格子缓存 IR，LRU）、**晚期尾**（与声源无关，全空间一条）。
- **每个 owner 一条子总线**（含"无 owner"），闪避增益作用在子总线出口；子总线共享解码与 IR 缓冲，**不共享卷积节点**
  （不同 owner 的尾巴要能分开收）。见 [audio-mix-and-ownership](audio-mix-and-ownership.md)。
- **听者一动，老的格子 / 尾巴"退役"而不是立刻拔线**：在飞的声音还等着它几秒后的回音，最后一个用它的 voice 走完才断。
- **超出直达最远距离只丢直达、反射照走**（对岸崖顶的声源本就只该听到回音）；连反射都没有才整条不播。
- **换空间（id 变）= 停掉所有在飞空间音、释放全部子总线**；重推同一个 id 不停。
- **重算双节流**：移动阈值按空间尺度自适应（按距离缩放折成米再比）+ 最小间隔；直达声逐声音现算不受节流。
  `buildImpulseResponse` 默认返回拷贝，`transient: true` 的暂存视图只给立刻写进 AudioBuffer 的热路径。
- **IR 确定性**：固定种子，禁用 `Math.random`。
- **出声证据**是主输出上的电平峰值（只量空间音总线），"播放函数返回了"不算。
- 环境底噪与自带回音的素材**不许标 `spatial`**。

## 实时联动：工作台 ↔ 游戏（`src/dev/runtimeAcousticsSync.ts`，DEV 门控）

照光照联动那套（dev server 文件槽、不新增端口、超时 + 退避 + 状态行），拆成**两个单向槽**：
工作台 → 游戏（正在编辑的空间定义、预览 id、试听请求）；游戏 → 工作台（场景 / 挂着的空间 / 听者 / 抽头 / 耗时 / 解锁 / 峰值）。

- 游戏只吃 `writer ≠ 我 && rev > 已见` 且新鲜的文档，结构合法才套用；**不看场景**（强绑允许）。
- **试听靠递增序号**：第一次看到文档只记不播（刷新不重放），漏看的不补播；没真起播不推进"已播"。
- **换场景后重新套用**：`lastSeenRev` 归零，文档仍新鲜就重套——作者走到别的场景听到的仍是工作台里正在调的那份。
- **状态槽按页存**：几个游戏页同时回传时挑最新开的那页当"游戏"，切场景命令带 `targetBootId` 只指挥那一页。
- F2「声学」页只剩状态与试听，**没有画布、没有存盘**（两个作者面必然漂）。

## 已知坑

- **哪个场景挂回音空间是制作人的决定,diff 里看到 `acousticSpace` 行被删不等于误删,别自行补回**。
  跑马梁**本就不该有回音空间**(2026-09-23 制作人明确:删是对的);09-14 曾把它当"丢失"补回、09-23 治理又把它的删除
  当复发上报,两次都是错判。拿不准某个场景的删除是不是有意,问制作人,不要凭 git 历史推断。
  字段缺失时运行时不报错、不回落,那个场景只是没有回音。两条自检(`test_acoustic_space_ref` / `test_scene_acoustic_field`)
  只校验"挂了的能解析",不管哪些场景该挂。
- 空间总线要音频上下文才建得出来：`setAcousticSpace` 建不出来时记成待挂，每帧 `flushPendingAcoustic()` 补挂并强制重算听者。
- **"换空间才 stopAll"**：两个场景共用同一空间 id、或都没空间时，切场景**不停**在飞的空间音（无 owner 的粒子事件音、威胁存在声会带进新场景）；
  脚步靠自己的发声体清理停。
- 工作台推来的工作态会**写进内存里的空间库**：本次会话后续绑定该 id 的场景都用工作态而非盘上数据；
  `getAcousticSpaceDef` 返回库内引用，要改先深拷贝。
- `air.humidity` 不参与计算（吸收表写死）；`authoring` / `sources` 运行时不读（工作台用）。
- 早期 IR 每格独立做峰值归一，不同格子响度不严格一致。立体声渲染不了仰角；遮挡只看竖直面。
- 移动的长音（跟着 NPC 走的循环音）没做：直达 / 反射在起播时定死。
- 不支持手机端（制作人 2026-09-07）。

## 校验

- `validator.check_acoustic_space_ref`：未知空间 id **error**；作者场景 ≠ 绑定场景 **warning**。
- `validator.check_acoustic_space_defs`：v1 残留 / `distanceScale ≤ 0` **error**；作者场景不存在 **warning**。
- `acousticSpacesData.test.ts` 拿**线上那份**库跑三条硬判据。

## 怎么验证

`npx vitest run src/audio src/dev` + `sh scripts/py.sh -m pytest tools/editor/tests/test_acoustic_space_ref.py tools/editor/tests/test_scene_acoustic_field.py`。
真机：起游戏 dev + 声学工作台，看工作台芯片"已套用 #N"、试听后峰值回传绿字；F2「声学」页状态行报挂着的空间与抽头。
