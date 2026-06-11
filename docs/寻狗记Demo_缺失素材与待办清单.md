# 寻狗记 Demo · 缺失素材与待办清单

分支：`demo-xungouji`。本清单列出 Demo 内容已接线但素材为占位/缺失的项，以及上线前的工程待办。
素材包审核结论引自 `D:\sucai\GeneratedDemoAssets_20260606\reference_notes\audio_manifest.md` 与 `audio_style_audit.md`。

## 一、完全缺失（已接线为文字/静音占位）

| 项 | 用在哪 | 现状 |
|---|---|---|
| `sfx_06_name_call_far` 远处喊"二狗" | ⑨夜路喊名 第一声（scenario_送货.night_call1） | 仅字幕台词，无人声。需配音模型或真人录音 |
| `sfx_07_name_call_multi` 多方位喊名 | ⑨夜路喊名（可加在 night_call2） | 同上 |
| `sfx_08_name_call_near` 贴近确认喊 | ⑨夜路喊名 第二声（night_call2 现用 sfx_abnormal_breath 顶） | 同上 |
| `sfx_09_wrong_name_overlap` 错名重叠 | ⑨夜路喊名（增强用，未接线） | 同上 |
| 关二狗道士装行走帧 | ⑫终幕（出城时换装） | 现只有单帧立绘（`player_taoist_anim`），未接 setPlayerAvatar；终幕用演出代偿 |
| 新场景深度/碰撞图 | 8 个新场景（雾津街头/灵堂/婆子家院/枯井/义庄/城隍庙夜/城门口/阎王岭山口） | 无遮挡关系、无墙体碰撞（仅大物件热区多边形）。用 `tools/scene_depth_editor` 逐场景生成 |

## 二、占位中（能跑，终版需替换）

| 项 | 用在哪 | 审核结论 |
|---|---|---|
| `bgm_placeholder_dread_piano.mp3` | 枯井土地庙 BGM | 候选曲，需终版 `bgm_01_well_low_dread_loop` |
| `bgm_placeholder_low_tension.mp3` | 阎王岭山口 BGM | 候选曲，需终版 `bgm_02_forest_hold_pressure_loop` |
| `bgm_placeholder_dark_shadows.mp3` | 城隍庙夜 BGM | 候选曲，需终版 `bgm_03_chenghuang_lamp_dread_loop` |
| `sfx_axiu_faint_hum`（部落笛） | Axiu 信号·确立档（axiu_full） | 审核判定气质不符：需"跑调女声轻哼"族 |
| `sfx_axiu_tiny_signal`（水晶钟） | Axiu 信号·轻触档（axiu_hint） | 同上，需同族短版 |
| `sfx_force_swallowed_thud` | ①背尸力被吞、⑩四样落地 | 预告片式 impact，需闷实肉感 thud |
| `sfx_abnormal_breath` | ⑨喊声凑近、⑩反扑 | 西式怪物喘息，需干而近的人声吸气 |
| `sfx_hold_pressure_loop` | 长按交互氛围底 | 通用恐怖底噪，需"林中死寂+呼吸+低压" |
| `sfx_well_cry_stop` | ⑦枯井叫声骤停 | 西式怪叫，需"似小孩似狗"的写实哭叫+硬切 |
| `amb_01_street_murmur_loop` | 雾津街头（现用旧"人声闹市"凑） | 需中式老街人声 |
| `amb_02_teahouse_loop` | 茶馆（现用旧 teahouse_roomtone） | 需中式茶馆环境 |
| 条件可用组（amb_04/06、sfx_02/04/11/12/13/17/22） | 码头/义庄/各吓点 | 可先用，终版按 audit 表替换 |

## 三、工程待办

1. **实机全流程目检**：状态机层联调已由 `XungouMainFlowIntegration.test.ts` 覆盖（全信号序列→12 里程碑）；
   视觉/演出/长按手感需开可见窗口跑一遍（后台标签 rAF 节流会卡演出，务必前台运行）。
2. **DVC 资源推送**：`public/resources/runtime` 下新增的入库素材（场景背景/动画包/插画/音频）未进 DVC。
   跑 `.\push-all.cmd`（或先 `python -m dvc status` 核对）。
3. **旧示例清理（可选）**：`narrative_graphs.json` 里的 `composition_1`（含 4 条 `__draft__` 草稿迁移）是历史示例，
   校验器会一直提示；建议在编辑器里删除。
4. **引擎引导 flag（已报告）**：`xg_prologue_started`（game_config.initialCutsceneDoneFlag 引擎契约）与
   `legacy_iron_box_flow`（旧内容封存开关）是仅存的两个非系统 flag；如需归零，前者要改引擎支持叙事状态判据。
5. **音频接线提醒**：喊名人声到位后，挂到 `scenario_送货.night_call1/night_call2` 的 onEnterActions（playSfx）即可，
   不用动任何对话图。
