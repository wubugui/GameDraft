# GameDraft 策划数据填写说明

本文配合 **GameDraft 主编辑器**使用：说明各页签里**每一项是什么意思、怎么填、容易怎么错**。界面以英文标签为主，文中小标题先写中文含义，必要时括号内写界面上的原名。

---

## 一、每天改完要走的四步

1. **保存全部**（Save All），避免只改界面没写回文件。  
2. **检查数据**（Validate / Tools 菜单或工具栏），先处理所有**红色/错误**，再尽量处理**提醒**。  
3. **试玩**（Run Game 等）走一遍你改的流程。  
4. 多人同时改同一工程前，先说好谁主笔，避免互相覆盖。

---

## 二、到处都会用到的两块：「条件」和「动作」

### 2.1 条件（Conditions）

**是什么**：满足这些条件时，对应内容才会出现、才会亮、或才会判定完成。多条之间一般是**都要满足**（具体以玩法为准，有特例问程序）。

**怎么填**：每一条通常包括：

| 部分 | 含义 | 怎么填 |
|------|------|--------|
| 标记名 | 游戏里记的状态 | 用 **Flags** 页登记过的名字，或符合你们约定的命名；点选比手打更稳。 |
| 比较 | 等于、不等于、大于等 | 一般用「等于」最多；数值型标记才用大于小于。 |
| 比较值 | 真 / 假 或 数字 | 布尔标记填真假；数值标记填数字。 |

**示例**：  
- 只有「教程完成」后才显示某热点：标记选 `tutorial_done`，比较选「等于」，值选「真」。  
- 只有第 3 天以后才解锁：`day_count`（若你们用数值标记记天数）比较选「大于等于」，值填 `3`。

### 2.2 动作（Rewards / Result Actions / actions 等）

**是什么**：某件事发生时**立刻执行**的效果链，例如改标记、给物品、切场景、播音乐等。

**怎么填**：每一个动作先选**类型**，再填该类型需要的参数。**务必用下拉列表里有的类型**，不要自己编英文词。

下面按策划常用程度说明（名称以编辑器下拉为准）：

| 动作类型（界面英文名） | 含义 | 常见参数 | 填写示例 |
|------------------------|------|----------|----------|
| setFlag | 改标记 | key=标记名，value=真/假/数字 | 做完支线：`side_a_done` = 真 |
| giveItem | 给物品 | id=物品编号，count=数量 | 奖励钥匙：`key_temple`，1 |
| removeItem | 扣物品 | id，count | 交出证物：`evidence_letter`，1 |
| giveCurrency / removeCurrency | 加钱 / 扣钱 | amount | 打赏：`50` |
| giveRule / giveFragment | 学会整条规矩 / 只学会一块碎片 | id=规矩或碎片编号 | 从 NPC 学到规矩：`rule_curfew` |
| updateQuest | 推进任务到「已接取/进行中」态 | id=任务编号 | 对话里接任务：`main_03` |
| startEncounter | 进入一场遭遇 | id=遭遇编号 | 踩雷：`enc_bandit_01` |
| playBgm / stopBgm | 播背景乐 / 停背景乐 | id（播时），fadeMs（毫秒渐变） | 进店：`shop_bgm`，1000 |
| playSfx | 音效 | id=音效登记表里的 id | 开锁：`sfx_unlock` |
| endDay | 结束当天 | 无 | 上床睡觉剧情末尾 |
| addArchiveEntry | 解锁档案条目 | bookType + entryId | 解锁人物：`character`，`npc_li` |
| startCutscene | 播一段演出 | id=演出编号 | 开场：`cs_prologue` |
| showEmote | 角色冒情绪气泡 | target=角色 id，emote=表情名 | 路人：`npc_01`，`surprise` |
| playNpcAnimation | 切换实体动画状态 | target、state（与 anim 包内状态名一致） | 图节点 `actions`：`playNpcAnimation`，target `npc_ringboy`，state `boy_cry` |
| openShop | 打开商店界面 | shopId | `shop_general` |
| switchScene / changeScene | 切场景 | targetScene，targetSpawnPoint | 进室内：`room_01`，出生点选列表里有的 |
| showNotification | 屏幕提示 | text，type（如 info / quest） | 「获得了锈铁钥匙」，type `item` |
| fadingZoom | 渐变镜头缩放（与场景 `camera.zoom` 同语义） | zoom，durationMs | 图节点 `actions`：`fadingZoom`，如 zoom `1.15`，durationMs `550` |
| fadingRestoreSceneCameraZoom | 渐变恢复为当前场景 JSON 的 `camera.zoom`（无则 1） | durationMs | 图节点 `actions`：`fadingRestoreSceneCameraZoom` |
| setCameraZoom | 立刻设置镜头缩放（无渐变） | zoom | 少用，多用 fadingZoom |
| restoreSceneCameraZoom | 立刻恢复场景配置的 zoom | 无 | |
| pickup | 当拾取物处理 | itemId，itemName，count，是否钱币 | 与热点捡钱逻辑配套时问程序 |
| shopPurchase / inventoryDiscard | 商店买单 / 丢弃 | 按表单字段 | 多在系统事件里用 |

填完一串动作后，**从上到下依次执行**；若某一步类型写错或参数漏了，可能出现「没反应」或仅控制台报错，以试玩为准。

**NPC 对话与镜头**：与 NPC 交谈时，系统会按该 NPC 的 **`dialogueCameraZoom`**（缺省 1.0）在**开场**渐变拉近，在**整段对话结束**时渐变恢复场景 zoom。图对话中可在对应节点的 **`actions`** 里配置 `fadingZoom` / `fadingRestoreSceneCameraZoom` / `setCameraZoom` 等，用于**对话中途**再推/拉镜头，或与自动行为叠加（按节点内 `actions` 顺序执行）。

---

## 三、Scene（场景）

场景 = 一张可走的地图 + 上面所有点、框、人。

### 3.1 场景整体属性

| 字段 | 含义 | 怎么填 | 示例 |
|------|------|--------|------|
| id | 场景唯一编号 | 全游戏不重复；英文+下划线 | `town_square` |
| name | 显示给玩家看的名字 | 中文 | 「镇口槐树」 |
| worldWidth / worldHeight | 逻辑宽高（世界单位） | 与背景图比例协调；可只填一侧 | 宽 `2400`，高按图自动推 |
| bgm | 背景音乐 | 填音频页里登记的 **bgm 的 id** | `map_country` |
| ambientSounds | 环境音 | 一栏一栏加 **音效 id**（若有此栏） | 蝉鸣一条、风声一条 |
| filterId | 整屏氛围滤镜 | 选 **Filters** 里已有的滤镜 id | `dusk_warm` |
| camera.zoom | 镜头缩放 | 默认 1；大于 1 拉近 | `1.2` |
| camera.ppu（pixelsPerUnit） | 一逻辑单位多少像素 | 一般默认；改分辨率感时问程序 | 默认可不动 |
| worldScale | 整场景视觉缩放 | 1 为默认；小于 1 整张图缩小 | 背景太大想缩小填 `0.85` |
| walkSpeed / runSpeed | 本图走路、跑步速度 | 不填用全局默认 | 雪地难行：走路 `80` |

### 3.2 热点（Hotspot）

热点是地图上可互动的「点」。共用品：**id**（唯一）、**type**、**坐标 x,y**、**interactionRange**（玩家离多近能触发）、**Conditions**（何时出现/可互动）、**label**（部分类型用作提示文字）、**autoTrigger**（踏进范围是否自动触发，慎用）。

**type = inspect（调查）**  
- **text**：调查到的说明正文。  
- **actions**：调查完可执行一串动作（例如改标记、给物品）。  

*示例*：调查井口，`text` 写「井沿刻着模糊的年号。」，动作里 `setFlag`：`read_well_inscription` = 真。

**type = pickup（拾取）**  
- **itemId**：物品表里的 id。  
- **itemName**：背包里显示名，可与物品表一致。  
- **count**：数量。  
- **isCurrency**：勾选表示捡到的是钱（若项目启用）。

*示例*：地上铜板，`item_id_coin`，显示名「铜钱」，`count` 10，勾「钱币」。

**type = transition（切场景）**  
- **targetScene**：目标场景 id。  
- **targetSpawnPoint**：目标场景出生点 key；空或默认表示用场景默认出生点；也可用「在场景里选出生点」按钮对齐。

*示例*：进屋，`targetScene` = `inn_1f`，出生点在 `inn_1f` 里建一个叫 `from_street` 的出生点，这里选它。

**type = npc（碰上 NPC）**  
- **npcId**：必须对上本场景 **NPC 列表里某个 NPC 的 id**，才会和那个人对话。

*示例*：和掌柜说话，场所里已有 NPC id `inn_keeper`，热点里 `npcId` 也必须填 `inn_keeper`。

**type = encounter（遭遇）**  
- **encounterId**：**Encounter** 页里某条遭遇的 id。

*示例*：踩进暗巷触发战斗，填 `enc_dark_alley`。

### 3.3 NPC（站立角色）

| 字段 | 含义 | 怎么填 | 示例 |
|------|------|--------|------|
| id | 唯一 | 场景内不重复 | `npc_blacksmith` |
| name | 显示名 | | 「王铁匠」 |
| x, y | 站立位置 | 在画布上拖 | |
| dialogueGraphId | 图对话资源 id | 对应 `assets/dialogues/graphs/<id>.json`（不含路径与后缀） | `茶馆瞎子李` |
| dialogueGraphEntry | 可选入口节点 id | 从该节点开始推进；不填则用图内默认入口 | `warn_ch` |
| dialogueCameraZoom | 进入对话时镜头渐变缩放到该值（与场景 `camera.zoom` 同语义） | 缺省 `1.0`；结束对话由游戏自动恢复场景 zoom | `1.15` |
| interactionRange | 对话距离 | | `60` |
| animFile | 动画包 | 选 **Animation** 页里那种 `xxx_anim` 对应路径 | 选列表里的 |

### 3.4 区域（Zone）

简单多边形范围（无矩形专用字段），用于「点落在闭合边界内」触发效果；顶点顺序为边界走向，**首尾不重复**存储同一点（运行时按顺序连边，末点回到首点作闭合）。

| 字段 | 含义 | 示例 |
|------|------|------|
| id | 唯一 | `zone_inn_danger` |
| polygon | 顶点数组，每项 `{ "x", "y" }`，至少 3 个点 | 场景编辑器画布拖动 / 侧栏顶点表；图编辑器 Zone 页同结构表格 |
| Conditions | 区域生效前提 | 仅夜间：`night_time` 为真 |
| onEnter / onStay / onExit | 进入时、停留在区内每帧、离开时执行的动作列表 | 进雾区：`playSfx`，或 `setFlag` |
| 区内规矩 | 不在 Zone 上挂槽位；在 `onEnter` 用 `enableRuleOffers`（`params.slots` 与旧 `ruleSlots` 条目形状相同）、`onExit` 用 `disableRuleOffers` | |

### 3.5 出生点（Spawn Point）

| 字段 | 含义 | 示例 |
|------|------|------|
| key | 别的场景跳转时写的「点名」 | 留空常表示默认；或 `from_mountain` |
| x, y | 玩家落下位置 | |

热点「切场景」里选的出生点，必须在这里**已经存在**对应 key。

---

## 四、Quest（任务与分组）

### 4.1 分组（Group）

| 字段 | 含义 | 示例 |
|------|------|------|
| id | 分组唯一 id | `main_ch1` |
| name | 界面显示分组名 | 「第一章·离乡」 |
| type | main=主线，side=支线 | 主线 |
| parentGroup | 上级分组 id | 留空为顶层；子章节指向上级 |

**示例**：`main_ch2` 的 `parentGroup` 填 `main_story`，任务面板会呈树状。

### 4.2 单个任务（Quest）

| 字段 | 含义 | 怎么填 |
|------|------|--------|
| id | 任务唯一 id | `q_find_dog` |
| group | 所属分组 id | 必须选已有分组 |
| type | main / side | |
| sideType | 支线细分（errand 跑腿 / inquiry 问询 / investigation 调查 / commission 委托） | 可空 |
| title / description | 标题与详情 | 玩家任务列表里看到 |
| Preconditions | 接任务条件 | 例如先完成某标记 |
| Completion Conditions | 完成条件 | 例如某标记为真且持有某物品（物品条件若未在编辑器暴露则问程序） |
| Rewards | 完成奖励动作列表 | 见第二节 |
| NextQuests（后继） | 完成后可接的下一批任务 | 每一行：**目标**任务 id + **边条件**（满足才给下一环）+ 可选「跳过前置」 |
| nextQuestId（旧版） | 单一后继 | 尽量用 NextQuests；若仍填，目标须存在 |

**示例**：`q_01` 完成后，若 `killed_boss` 为真则接 `q_02a`，否则接 `q_02b`：做两条 NextQuests，边条件分别写不同标记。

---

## 五、Encounter（遭遇）

整段遭遇一个 **narrative**（大段叙事/开场白），下面多条 **Option**（选项）。

### 遭遇本体

| 字段 | 示例 |
|------|------|
| id | `enc_bandit_block` |
| narrative | 「三个汉子拦住去路……」 |

### 每个选项（Option）

| 字段 | 含义 | 示例 |
|------|------|------|
| text | 按钮上的字 | 「交钱消灾」 |
| type | general=普通；rule=与「规矩」相关；special=特殊 | `general` |
| requiredRuleId | 需要已学会某条规矩才出现 | `rule_trade_custom` |
| Conditions | 该选项亮不亮 | `money_500` 为真 |
| consumeItems | **若界面未显示**：需要扣物品时问程序或沿用旧数据格式 | `[{id:'coin',count:50}]` 一类 |
| resultText | 选完后追加说明 | 「他们让开了一条路。」 |
| Result Actions | 选完后执行的动作 | `removeCurrency` 50，`setFlag` `paid_bandit` |

---

## 六、Cutscene（演出）

| 字段 | 含义 |
|------|------|
| id | 演出编号，供任务/动作 `startCutscene` 引用 |

**Commands** 自上而下执行。每条可选 **parallel（并行）**：勾选表示可与「下一条」同时进行（具体以程序支持为准）。

常用命令与参数（名称均为界面英文下拉）：

| 命令 | 作用 | 参数怎么填 |
|------|------|------------|
| fade_black / fade_in | 黑屏渐隐 / 渐显 | duration 秒 |
| flash_white | 白光闪 | duration |
| wait_time | 单纯等 | duration 秒 |
| wait_click | 等玩家点一下 | 无 |
| set_flag | 改标记 | key，value |
| show_title | 大标题 | text，duration |
| show_dialogue | 字幕式对白 | speaker，text |
| play_bgm / stop_bgm / play_sfx | 音频 | id 在 Audio 页；fadeMs 可选 |
| camera_move | 镜头移动 | x，y，duration |
| camera_zoom | 镜头缩放 | scale，duration |
| switch_scene / change_scene | 切场景 | sceneId，spawnPoint |
| show_img / hide_img | 立绘/大图 | id（图层名），image 路径 |
| show_movie_bar / hide_movie_bar | 遮幅 | heightPercent |
| show_subtitle | 底部小字 | text，duration |
| entity_move | 实体走路 | target（如 player 或 NPC id），x，y，speed |
| entity_anim | 播动画 | target，animation（状态名） |
| entity_face | 朝向 | target，faceTarget（另一实体 id） |
| entity_spawn / entity_remove | 生出 / 移除实体 | id，name，位置等 |
| entity_emote | 气泡 | target，emote，duration |
| entity_visible | 显隐 | target，visible |
| execute_action | 执行「任务同款」的一条动作 | 若界面不展开参数，请复制别的演出里同类写法或问程序 |

**示例**：开场黑屏 1 秒 → 显示标题「三天前」2 秒 → `wait_click` → `fade_in` 并进下一句对白。

---

## 七、Item（物品）

| 字段 | 含义 | 示例 |
|------|------|------|
| id | 全游戏唯一 | `herb_mint` |
| name | 显示名 | 「薄荷」 |
| type | consumable 消耗品；key 关键道具 | |
| description | 背包说明 | |
| maxStack | 最大堆叠 | `99` |
| buyPrice | 商店参考价；0 或不填表示不单卖 | `10` |
| Dynamic Descriptions | 多条「条件 + 不同说明」 | 标记 `identified` 真时显示鉴定后文本 |

---

## 八、Rule（规矩与碎片）

**Rules 表**：一条完整规矩。

| 字段 | 含义 | 选项说明 |
|------|------|----------|
| id | 唯一 | |
| name | 玩家看到的规矩名 | |
| incompleteName | 未集齐碎片时的名称 | 可空 |
| category | ward / taboo / jargon / streetwise | 忌讳、禁忌、黑话、世故（文案包装用） |
| description | 正文 | |
| source | 来历说明 | 「听码头老李说的」 |
| sourceType | npc / fragment / experience | |
| verified | unverified / effective / questionable | 未验证、有效、可疑 |
| fragmentCount | 与碎片收集相关总数提示 | 数字 |

**Fragments 表**：粘在规矩上的小段落。

| 字段 | 含义 |
|------|------|
| id | 唯一 |
| text | 碎片文案 |
| ruleId | 属于哪条规矩 |
| index | 排序序号 |
| source | 可选出处 |

*示例*：规矩 `rule_night_trade`，碎片 3 条，`index` 0、1、2。

---

## 九、Shop（商店）

| 字段 | 含义 |
|------|------|
| id / name | 店编号、店名 |
| Items 表 | 每行 itemId（物品表）+ price（售价） |

*示例*：`shop_inn` 卖馒头 `item_mantou` 价 `2`。

---

## 十、Map（大地图节点）

| 字段 | 含义 | 示例 |
|------|------|------|
| sceneId | 点进去进哪张场景 | `map_world_forest` |
| name | 地图上显示名 | 「黑风林」 |
| x, y | 大地图上的点位置 | 拖或填数 |
| unlockConditions | 该点何时出现 | `explored_signpost` 为真 |

---

## 十一、Archive（档案）

### Characters（人物）

- **id / name / title**：编号、姓名、头衔。  
- **unlockConditions**：档案条目何时解锁。  
- **Impressions / Known Info**：多条「条件 + 文本」——满足条件时多显示一句印象或情报。

### Lore（轶闻）

- **id / title / content / source**，**category**：legend / geography / folklore / affairs。  
- **unlockConditions**：何时在轶闻簿里可见。

### Documents（文档）

- **id / name / content / annotation**（批注），**discoverConditions**：何时被「搜到」。

### Books（书册）

- **id / title / totalPages**。  
- **Pages**：每页 **pageNum**，**title**，**content**，**illustration**（插图在工程插图目录里选），**unlockConditions**（该页何时可读）。

---

## 十二、Dialogue（图对话）

- 运行时对话内容为 **`public/assets/dialogues/graphs/*.json`**：节点（文本/选项）、条件、`actions`（与上文 Action 表一致，经 `ActionExecutor` 执行）。
- 场景 **NPC** 上填 **`dialogueGraphId`**（及可选 **`dialogueGraphEntry`**），与图文件名/入口节点对应。
- 节点条件、选项条件均基于 **FlagStore**（及数据里约定的比较方式）；改标记用 **`setFlag`** 等 Action，须与 **Flags** 登记表一致。
- **NPC 对话时的动画**：停巡逻与朝向由系统处理；需要换站立或表情时在对应节点的 **`actions`** 里加 **`playNpcAnimation`**（target 为 npc id，state 与 `animFile` 内状态名一致）。一般放在该分支入口节点上，避免重复。未执行 `playNpcAnimation` 时，精灵仍保持进入对话前的当前状态。
- 仓库中的 **`.ink`** 若存在，仅作编剧归档，**不参与**运行时加载；以图 JSON 为准。
- **对话模拟**（若有工具）：用来走分支查漏；最终以游戏内为准。

---

## 十三、Audio（音频）

三个页：**bgm / sfx / ambient**。每行：

| 列 | 含义 |
|----|------|
| id | 游戏里、`playBgm` 等引用的名字 |
| src | 音频文件路径，一般从工程已有 wav 里选 |

填完 **Apply**；可用 **播放** 试听到不到文件。

---

## 十四、Filters（滤镜）

- **滤镜 id** 与场景 **filterId**、滤镜文件名一致。  
- 需要「调色盘」级调整时用「打开滤镜工具」；本页可改矩阵数字，一般策划用工具更直观。

---

## 十五、Animation（序列帧动画）

| 字段 | 含义 | 示例 |
|------|------|------|
| spritesheet | 整张贴图路径 | 选工程内图 |
| cols / rows | 横向格数、竖向格数 | 4×4 |
| worldWidth / worldHeight | 在游戏里占位大小 | |
| States | 每行：状态名 name；frames 如 `[0,1,2,3]`；frameRate；loop 是否循环 | `walk`，`[0,1,2,3]`，`8`，真 |

NPC **animFile** 选这里登记过的动画包路径。

---

## 十六、Strings（文案表）

树状 **Key / Value**：给界面用的成段字；可带 `{变量}` 占位（黄字提示）。改键名要同步程序，**只改显示字最稳妥**。

---

## 十七、Config（全局配置）

| 字段 | 含义 |
|------|------|
| initialScene | 新游戏第一张场景 |
| initialQuest | 开局自动处于进行中的任务（若有） |
| fallbackScene | 出错或缺场景时的退路 |
| initialCutscene | 首次进游戏可播的演出 id |
| initialCutsceneDoneFlag | 标记「开场演出播过了」，避免每次进都播 |
| startupFlags | 开局强制写入的一组标记与值（表格式添加） |

*示例*：`startupFlags` 里 `map_unlocked`=真，用于跳过开场后仍解锁地图。

---

## 十八、Flags（标记登记）

- **Static**：固定名字的标记；可为每个标记选 **bool** 或 **float** 类型（影响默认值与比较方式）。  
- **Patterns**：一批「按规则拼出来的标记名」，用于场景、热点 id 拼 key 等；复杂规则用界面里说明或问程序。  
- 作用：统一命名、方便检查数据时扫错别字；**不会**代替你在条件里真的去改标记值。

---

## 十九、Actions（动作总览）

不按场景分页，而是**列出全工程里填过的所有动作**，并写清来自哪个任务/遭遇/热点。用来：**搜某个任务奖励有没有漏配、搜全图谁在给某标记**。

---

## 二十、检查数据（Validate）策划怎么解读

- **报错**：断层引用（场景 id、任务 id、物品 id、遭遇 id、规矩 id 等对不上）必须改。  
- **提醒**：常为标记不在登记表、对话/配置里写了未登记标记、滤镜 id 缺失、NPC 对话文件找不到等；尽量修，减少上线后「无响应」。  
- 检查**不能保证**演出每一条命令在游戏里都支持完备；**最终以试玩为准**。

---

## 二十一、图对话页签（流程图编辑器）

主编辑器 **图对话** 页编辑 `public/assets/dialogues/graphs/*.json`。右侧表单与中间**流程图**同一套数据：从节点**右侧圆点**拖线到目标节点即可改 `next` / 选项 `next` / `switch` 分支；**右键连线**可断开。画布快捷键：**F** 适应窗口，**A** 自动布局。节点坐标与「缺失目标」的幽灵占位块位置写入 `editor_data/dialogue_flow_layout.json`（嵌套格式含 `nodes` / `ghosts`），**不参与**游戏运行时加载。**Actions** 页中 **startDialogueGraph** 可「前往来源」跳到本页并打开对应图文件。

---

## 二十二、界面英文标签速查

| 界面标签 | 中文含义 |
|----------|----------|
| Scene | 场景 |
| Quest | 任务 |
| Encounter | 遭遇 |
| Cutscene | 演出 |
| Item | 物品 |
| Rule | 规矩 |
| Shop | 商店 |
| Map | 大地图 |
| Archive | 档案 |
| Dialogue | 对话 |
| 图对话 | 图对话 JSON / 流程图 |
| Audio | 音频 |
| Filters | 滤镜 |
| Animation | 动画 |
| Strings | 文案表 |
| Config | 全局配置 |
| Flags | 标记登记 |
| Actions | 动作总览 |

若某字段在编辑器里**找不到**，可能是版本未做界面或走 JSON 手工维护——把需求给程序，不要硬猜英文键名。
