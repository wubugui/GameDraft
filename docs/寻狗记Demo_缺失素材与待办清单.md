# 寻狗记 Demo · 缺失素材与待办清单

分支：`demo-xungouji`。本清单列出 Demo 内容已接线但素材为占位/缺失的项，以及上线前的工程待办。
素材包审核结论引自 `D:\sucai\GeneratedDemoAssets_20260606\reference_notes\audio_manifest.md` 与 `audio_style_audit.md`。

## 一、完全缺失（已接线为文字/静音占位）

| 项 | 用在哪 | 现状 |
|---|---|---|
| `sfx_06_name_call_far` 远处喊"二狗" | ⑨回程 点位变体（看进山路 p3r/p2r/p1_call）与 forest_name_call interrupt① | 仅字幕台词，无人声。需配音模型或真人录音 |
| `sfx_07_name_call_multi` 多方位喊名 | ⑨回程 forest_name_call interrupt①（多向包围） | 同上 |
| `sfx_08_name_call_near` 贴近确认喊 | ⑨回程 forest_name_call interrupt②（「二狗……？」近声，现用 sfx_abnormal_breath 顶） | 同上 |
| `sfx_09_wrong_name_overlap` 错名重叠 | ⑨回程 wrong 变体（看进山路 p3w_call/p2w，去程喊错反馈） | 同上 |
| 喊魂人声「回来咯——」+ 齐声轻应「回来了」 | ①.5 梦·待死之礼 收束（寻狗_梦待死之礼 n18/n19，与 ⑪ 城隍庙巷中叫魂同款资产） | 仅字幕台词，无人声 |
| `sfx_axiu_tune_far` 小调·远场残缺版 | ①.5 梦 纸停后小调首现（signal_cues.axiu_tune_far） | 现直接复用 sfx_axiu_faint_hum 占位；终版需同旋律的极远、半句、跑调版 |
| 梦境视觉（夜路/农家院/倒头饭特写/盖脸纸特写） | ①.5 梦（现全程黑屏文字剧场代偿） | 盖脸纸"一起一伏→停→颤"特写是该 beat 的 P0 红线画面 |
| 城外土路日景 | ①.5 梦醒（现以旁白代偿，醒来直接回雾津街头） | 可借山路底改日景 |
| 阎王岭山口 X点带/林边热点坐标 | ⑨ 去程（z_X点一、z_越点二/三、hs_X点二/三_林边） | 全宽触发带保证必经过；具体坐标需对照场景背景图用编辑器实测调整 |
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
   跑 `./scripts/push-all.sh`（或先 `.tools/venv/bin/python -m dvc status` 核对）。
3. **旧示例清理（可选）**：`narrative_graphs.json` 里的 `composition_1`（含 4 条 `__draft__` 草稿迁移）是历史示例，
   校验器会一直提示；建议在编辑器里删除。
4. **引擎引导 flag（已报告）**：`xg_prologue_started`（game_config.initialCutsceneDoneFlag 引擎契约）与
   `legacy_iron_box_flow`（旧内容封存开关）是仅存的两个非系统 flag；如需归零，前者要改引擎支持叙事状态判据。
5. **音频接线提醒（⑨ 两段式重构后挂点已变）**：喊名人声到位后，远/多向/近三层挂到
   `pressure_holds.forest_name_call` 的两个 interrupt 与 `寻狗_看进山路` 的回程点位节点（p3r_call/p3w_call/p2r/p2w/p1_call）；
   错名重叠版挂去程喊错反馈（`寻狗_喊名_点二/点三` 的 fb_wrong）。
6. **①.5 梦关提醒**：梦的「不按不走」由 chooseAction 单选项【吃】实现（allowCancel=false），勿加超时或旁路；
   农家院若日后场景化，暖光只能走场景布光，**禁止**使用 Axiu 信号的暖光微尘 VFX（信号防污染纪律）。
7. **⑨ 长按新机制**：`abortOnReleaseFromRatio`（0.72）= 认不准关口不容松手，松手走 `onAborted`（应声分支
   hanming_answered → 逃亡 forest_escape_run → 照常回城，不卡关）。前段松手仍只回落（层2/3容错）。
