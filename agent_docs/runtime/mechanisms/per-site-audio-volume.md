---
id: per-site-audio-volume
title: 逐处音量(音频引用的对象形态)
domain: runtime
type: mechanism
summary: 每个引用音频 id 的地方都能带 volume;它**替换**素材级音量再乘通道音量;判等/合并/快照一律走 audioCue 助手,别 `ref.id`、别 `a === b`
status: active
authority:
  - src/data/audioCue.ts
  - src/data/types.ts#AudioCueRef
  - tools/editor/shared/audio_cue.py
  - tools/editor/shared/audio_preview_selector.py
triggers:
  paths:
    - "src/data/audioCue.ts"
    - "src/systems/AudioManager.ts"
    - "src/utils/sceneAppearance.ts"
    - "tools/editor/shared/audio_cue.py"
    - "tools/editor/shared/audio_preview_selector.py"
  topics: [音量, volume, 本处音量, BGS, SE, 音频引用, AudioCueRef, 试听]
  tasks: [给某处音效加音量, 加新的音频引用字段, 改音频试听]
verified_by:
  - src/data/audioCue.test.ts
  - src/systems/AudioManagerSiteVolume.test.ts
  - tools/editor/tests/test_audio_site_volume.py
last_governed: 2026-09-09
---

## 是什么(一句话)

一处音频引用可以写成 `"sfx_door"`,也可以写成 `{ "id": "sfx_door", "volume": 0.35 }` ——
后者给**这一个引用点**单独定音量,不影响这条素材在别处的响度。

## 为什么(不是洁癖)

`audio_config` 里那条 `volume` 是**素材级**的("这条录得偏响,登记时先修平")。
但同一条音在不同地方要的响度天然不同——近景推门要满,隔壁当氛围只要一半。
素材级表达不了这件事,以前作者只能复制一条同源素材、改个 id 单独调 volume,
于是音频目录长出一堆 `xxx_quiet` / `xxx_loud`,而且真要整体调一档时得逐条改。

## 权威源(读代码从哪进)

- 运行时解析:`src/data/audioCue.ts`(口径、为什么不用兄弟键,都在头注释里)
- 类型:`src/data/types.ts` 的 `AudioCueRef`
- 编辑器解析/写回:`tools/editor/shared/audio_cue.py`
- 作者面控件:`tools/editor/shared/audio_preview_selector.py`(`with_volume=True`)

**引用点清单以代码为准**,不要抄这里的表。当前覆盖:场景 `bgm` / `ambientSounds`(含
`timeVariants` 各时段)、action `playSfx` / `playBgm` / `playSceneAmbient` 的 `volume` 参数、
`audio_config.systemSfx` 的值、脚步集 `sets[].sfx` 的值、`pressure_holds.holdSfx`、
物件检视 `audio.hoverSfx` / `clickSfx`、台词配音 `voice`(自带 `{id,volume,hold}`)、
`document_reveals.revealSfx`(历史兄弟键 `revealSfxVolume`,唯一的例外形态)。

## 硬契约(违反即 bug)

1. **口径只有一条:替换,不是相乘。**
   `最终线性增益 = clamp01( (本处 volume ?? 素材 volume ?? 1) × 通道音量 )`。
   写成相乘会让"素材已经压到 0.5、这里再写 0.5"变成 0.25,作者按听感调出来的数全废。
   **唯一的例外是脚步**:它根本不读素材级 volume(基准是 `gainDb`),本条 volume 是
   **乘**在 `dbToLin(集 gainDb + 全局 gainDb)` 之上的——dB 管"这块地整体多响",
   volume 管"这个片段相对本集多响"。
2. **`volume: 0` 是合法的静音,绝不能与"没配"合并。**
   `volume || undefined` 这种写法会把作者手配的静音悄悄变回原音量。
3. **判等不能用 `===` / JSON 字面比。** 对象形态每次解析都是新对象,引用比恒判成"变了"。
   `sceneAppearance.sameAppearance` 上踩过:每次时段推进都白赔一次全场景重载(背景闪一下)。
   一律用 `sameAudioCue` / `sameAudioCueList`。
4. **幂等守卫要按 (id, 本处音量) 判。** 只比 id 的话,「同一首曲子换个音量」会被当成
   "已经在播这首了"直接吞掉。`playBgm` 按此判断是否重播;`addAmbient` 更进一步——
   已在播的层**不重播**(避免爆音)但**要认新音量**。
5. **快照要连音量一起存。** 过场音频基线用 `getCurrentBgmCue()` / `getActiveAmbientCues()`,
   不是 `getCurrentBgmId()` / `getActiveAmbientIds()`。只记 id 的话,过场里被停掉的那层
   还原时按素材原音量回来——变响一大截,且只在真机听得出来。
6. **新字段一律用对象形态,别再造兄弟键。** 兄弟键(`bgmVolume`)在"时段变体只覆盖 bgm、
   不覆盖 bgmVolume"这类合并路径上会走散;音量跟着 id 一起走才不会漏。
   `revealSfx` / `revealSfxVolume` 是盘上已有数据的历史包袱,读侧照样过 `cueFromLegacyPair`。

## 作者面契约(编辑器侧)

7. **▶ 试听必须按运行时音量放**,含通道出厂音量(`audio_library.CHANNEL_DEFAULT_VOLUME`,
   跨语言镜像,由测试从 `AudioManager.ts` 抠值比对)。不按运行时口径放的话那一格只是装饰:
   作者调到"听着刚好",进游戏还是不对——这正是本机制诞生的原话("预览声音有个鸡儿用")。
8. **中性值(1)不写键;但盘上写着的中性值、用户没动过时要原样回写。**
   判据是"用户动没动过"(载入时的种子快照),不是"值等不等于中性"。见
   `audio_cue.resolve_volume_for_write`。
9. **写回在原对象上改,未知键原样留着**(`audio_cue.make_cue(..., original)`)。
   对象形态以后会长出 `pan` / `fadeMs`;重建一个只有 id/volume 的新对象 = 静默删字段。
10. **调用点要接控件的 `changed` 而不只是 `value_changed`** ——后者只在 id 变化时发,
    只接它的话「只改了音量」不标脏,切走就丢。

## 已知坑

- `config.systemSfx` 的值现在可能是对象:`a || b || c` 串起来再 `.trim()` 会当场崩
  (对象是真值)。`playAudioUnlockCue` / `previewVolume` 两处都改成了先按 `audioCueId` 挑。
- 脚步集编辑器把"本页不认识的形状"判为只读透传;判据是 `isinstance(raw, (str, dict))`,
  **不能**拿"解析不出 id"当判据——那会把"还没选音效"(空串)也误判成异形数据。
- 场景环境音列表的每一行要同时随行携带 id / 盘上原件 / 本处音量三份;只存 id 的话
  上下移一行音量就不跟着走。换行时给音量控件 `setValue` 必须 `blockSignals`,
  否则换个选中就把上一行的音量写到新行上。

## 怎么验证

`npx vitest run src/data/audioCue.test.ts src/systems/AudioManagerSiteVolume.test.ts` +
`sh scripts/py.sh -m pytest tools/editor/tests/test_audio_site_volume.py`。
改了作者面另跑[验证门](../../editor-tools/recipes/editor-change-verification-gate.md)三件套。
真机判据:同一条素材配在两处不同音量,听起来确实不一样,且过场进出后不变响。
