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
| `sfx_litiangou_shout`+`sfx_charm_light` 断喝/符光 | ⑨回程 李天狗救场（断喝 + 桃木符光散煞） | 仅文字演出，无音效。需一声压场断喝 + 符光"啪"散开的脆响 |
| 喊魂人声「回来咯——」+ 齐声轻应「回来了」 | ①.5 梦·待死之礼 收束（寻狗_梦待死之礼 n18/n19，与 ⑪ 城隍庙巷中叫魂同款资产） | 仅字幕台词，无人声 |
| `sfx_axiu_tune_far` 小调·远场残缺版 | ①.5 梦 纸停后小调首现（signal_cues.axiu_tune_far） | 现直接复用 sfx_axiu_faint_hum 占位；终版需同旋律的极远、半句、跑调版 |
| 梦境视觉（夜路/农家院/倒头饭特写/盖脸纸特写） | ①.5 梦（现全程黑屏文字剧场代偿） | 盖脸纸"一起一伏→停→颤"特写是该 beat 的 P0 红线画面 |
| 城外土路日景 | ①.5 梦醒（现以旁白代偿，醒来直接回雾津街头） | 可借山路底改日景 |
| 阎王岭山口 X点带/林边热点坐标 | ⑨ 去程（z_X点一、z_越点二/三、hs_X点二/三_林边） | 全宽触发带保证必经过；具体坐标需对照场景背景图用编辑器实测调整 |
| 关二狗道士装行走帧 | ⑫终幕（出城时换装） | 现只有单帧立绘（`player_taoist_anim`），未接 setPlayerAvatar；终幕用演出代偿 |
| 新场景深度/碰撞图 | 8 个新场景（雾津街头/灵堂/婆子家院/枯井/义庄/城隍庙夜/城门口/阎王岭山口） | 无遮挡关系、无墙体碰撞（仅大物件热区多边形）。用 `tools/scene_depth_editor` 逐场景生成 |
| 李天狗立绘（破道袍·灰头土脸） | ⑨回程 出山口救场（寻狗_李天狗 对话图） | 比叫花子还破的真道士，与关二狗的假道袍正好穿帮对照（§74 妖护人反讽）。无立绘，现需新建 |
| 出山口夜雾 视觉 | ⑨回程 命悬一线 / 李天狗救场 | 半身没进雾、冷东西从雾里伸出缠脚踝；需夜雾+林边氛围层 |
| 桃木符光 VFX | ⑨回程 李天狗断喝散煞那一下 | "啪"地把冷东西散开的一道桃木/符光，配断喝同步 |
| 路祭酒肉道具 | ⑨回程 不应声分支 路标边一摊路祭（供野鬼的酒肉） | 关二狗破"路祭不能动"规矩坐下吃喝的道具特写，无素材 |

> ✅ **背尸②崖墓 美术/音效已落地（2026-06-27 核实，订正前一版误记）**：临江崖墓背景 `background_cliff_tomb_day_hires_v1.png`、崖墓尸 `cliff_tomb_preserved_corpse_v1.png`、鬼打墙音效 `sfx_guidaoqiang_loop` / `sfx_guidaoqiang_corpse_breath` **均已入库、非占位**。唯 **打照面 overlay `scare_closeup`** 仍待换崖墓尸特写图（见记忆 scare-closeup-art-pending）。

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
8. **李天狗登场戏 · 系绳失灵变体（L2，唯一碰代码处）**：出山口"命悬一线"这场是死亡系绳机制核心的一次反转——
   香粉味照例冒头要把人拽回，却被一股更冲更"正"的气息当头压灭，系绳头一次没接住。signal_death_tether 的 cue
   需做一个起头就被掐断的变体，HP 恢复改由李天狗救场脚本接管。`HealthSystem` 需留"本次 tether 被外部接管"
   的口子（按 L2 最小新增，唯一允许的代码改动）；应声分支（没忍住→直接被拖命悬）与不应声分支（撑过认不准→
   路祭嘚瑟挑衅后被拖）两条引子都收束到这同一处必见救场。
9. ✅ **已落地·新对话图 `寻狗_李天狗.json`**：李天狗救场后的全段对话已单独成图、`met_litiangou` flag 已写入、终幕城门钩子已挂。注意人物分寸：李天狗纯克制（只嗅·只问一句·
   只撂一句劝·不追·不作法·不点破），关二狗对他是鲁钝式无视（自顾自摸包敷衍、没反应过来险情），痞气只放在他走后/独处。
   "教训女妖"是关二狗吹牛注水（当年只是跟人群起哄看热闹），不是真私仇——念气救他靠帕子包不认人，绝不能写成报应。
   时间线锚"几年前"（凡涉及桃溪浩劫处一律"几年前"，不写"十多年前"）。结尾钩子挂⑫城门汇合，条件=新 flag
   `met_litiangou`（已见李天狗）。
10. ✅ **已落地·新规矩"路祭不能动"**：已登记进规矩数据（`rule_no_touch_offering`）；违规判定接好。

### 2026-06-27 · 背尸②崖墓重铸 / 鬼打墙 / 搜集行头 落地后新增

11. **背尸②崖墓内部命名待改名（收尾）**：场景重铸为崖墓后，内部 id 仍是旧冥婚版残留——scene id `庄家灵堂`、zone `z_灵堂进场`、信号 `lingtang_intro_entered`、scenario 状态 `at_lingtang`。**玩家可见文案/名称已全转崖墓口径**；这些纯内部标签改了会断对话/zone/集成测试引用，需连同 `XungouMainFlowIntegration.test.ts` 一起改名。
12. **鬼打墙 真·空间循环 ✅ 已落地（2026-06-28）**：已从 PressureHold 长按升级为**玩家真走动的空间循环**——`寻狗_背尸` 在发力(carry PH)+香粉+不唱魂后**交控权**给玩家（`setFlag beishi_carrying`）；崖墓场景 `庄家灵堂` 加 `z_鬼打墙` 区 + `崖墓口` snap-back spawn，玩家往崖下走入区 → `startDialogueGraph 寻狗_鬼打墙`（staged by `guidaoqiang_loops`：绕回原地×2 各 `switchScene` 同场景 snap-back 崖墓口 + 第3次豁出去坠崖 → `triggerDeathTether` → `emit beishi_fled`）；走鬼打墙时 `hs_女尸`/`T_出灵堂` 隐藏（困住玩家、走不脱）。**保 `scenario_背尸` 信号契约**：try1/try2 仍由 `carry_bride_corpse` PH 发、scent 由对话发、fled 改由 `寻狗_鬼打墙` 发（黑盒声明已同步 dlg_02/dlg_guidaoqiang）。运行时实测：loop staging（`guidaoqiang_loops` 0→1、switch 命中 ==2）+ 坠崖 climax（系绳回血 15→60 + 清 `beishi_carrying`）全绿、0 console error。**剩余可选**：snap-back 可加一瞬黑闪/`sfx` 强化"绕回"的错位感；旧 `guidaoqiang_escape` PressureHold 条目保留未删（可清理）。
13. **搜集行头 真·空间采集 ✅ 已落地（2026-06-28）**：已从"对话内 choice 菜单"改为**世界空间采集**——`寻狗_围观竞争` 改为门庭若市观察 hub（看人堆 → 指路满城淘 → 凑齐回来披上）；雾津街头新增 3 处淘货热点（街角当铺 `hs_当铺道袍`→`寻狗_淘道袍`、庙会摊 `hs_庙会罗盘`→`寻狗_淘罗盘`、城东先生 `hs_城东桃木`→`寻狗_淘桃木`），各 `giveItem`（新增物品 `daopao`/`luopan`/`taomu_sword`）+ `setFlag got_xingtou_*`，采集后热点隐藏；凑齐 3 件回人堆 hub → dress 分支 `emit outfit_bought` → `scenario_向导 outfitted`。玩家须在街上走到 3 处分别淘、再回 hub 披上（非菜单一键）。**剩余可选升级**：① 把 3 处淘货点真散到更多场景（茶馆/码头/丧家遗物…）做"满城淘"；② 淘货热点与人堆 hub 目前 label-only，可补当铺/庙会摊/城东摊 sprite 美术。
