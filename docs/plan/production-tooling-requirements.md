# GameDraft 生产工具需求总表

日期：2026-05-31

## 核心结论

运行时仍以现有 JSON 为唯一权威数据格式，不再推进 CSV/YAML pipeline 迁移。

现有编辑器继续负责具体内容编辑；新增“生产工作台”只负责集中验收、追踪、检查、调试和 GPT 素材生产，不替代编辑器的字段面板。

## 必须守住的原则

- 不维护两套工作流。
- 不让策划手写复杂 JSON。
- 不暴露假按钮、假入口、假功能。
- 任何 GUI 入口都必须能复制问题报告。
- 任何自动检查都不能只在日志里喷一大段原始 JSON。
- 生产状态和运行时状态分开：生产状态只描述制作进度，不写入 runtime schema。

## 当前已落地

### 1. 生产工作台入口

入口：

- `npm run planner:gui`
- `npm run planner:gui`
- `python -m tools.production_workbench <project_root>`
- 主编辑器 `Tools -> External tools (new process) -> Production Workbench`

当前真实页签：

- 剧情单元
- 每日检查
- Graph诊断
- 运行时Debug
- 素材审计
- 素材候选
- 图片工具
- 动画Sheet
- 素材任务
- Codex/GPT

未完成的诊断、模拟、运行时 debug 不在 GUI 里摆假页签。

基础交互约束：

- 所有会变长的 ID/状态候选都走搜索选择器或文件选择器，不用长下拉让人翻。
- 剧情单元加载、Graph 诊断、每日检查、素材扫描、候选扫描、图片处理、动画处理、Codex 执行都必须后台运行，不能卡住窗口。
- 后台任务运行中禁止切换工程或关闭工作台，避免旧线程结果写回到新工程或窗口关闭后继续吐日志。
- 加载中不允许点击当前单元保存、复制、验收、打开源文件等动作，避免误操作旧数据。

### 2. 剧情单元追踪

剧情单元以 `public/assets/data/narrative_graphs.json` 的 `compositions[]` 为边界。

工作台自动汇总：

- composition id / label / description
- mainGraph
- 子 graph
- dialogue blackbox
- quest wrapper
- zone blackbox
- minigame blackbox
- signal
- projection warning
- narrative validation issue

人工追踪字段：

- 显示名
- 类型：主线 / 支线 / 小情景 / 结局 / 系统验证
- 制作状态：未做 / 制作中 / 可玩 / 待验收 / 通过 / 冻结
- 预计小时
- 入口
- 出口
- 验收
- 阻塞
- 素材需求
- 备注
- 验收脚本入口
- 初始 flag / quest / scenario / narrative state
- 执行步骤
- 选择 option
- 期望 signal / narrative state / quest 变化 / scenario 变化
- 存读档复查
- 最近验收结果和备注

保存位置：

`resources/editor_projects/editor_data/production_workbench/story_units.json`

这个文件只保存生产追踪信息，不改 runtime JSON。

### 3. 每日检查

当前检查内容：

- 工程是否有效
- ProjectModel 是否能加载
- narrative graph schema/context 校验
- dialogue graph 结构校验：entry / next / choice / switch / ownerState / contextState 指向、孤儿节点 warning
- 剧情单元是否缺入口、出口、验收、阻塞
- 待验收/通过的剧情单元是否缺验收脚本步骤、期望结果、存读档复查
- 素材引用是否能解析到磁盘文件
- 素材规格轻量检查：图片尺寸是否可读、扩展名和实际格式是否一致
- Python Narrative/editor 关键测试
- 生产工作台 smoke：GUI 主入口、后台加载、报告保存、素材/图片/动画/运行时 Debug 等关键路径
- Python import smoke
- TypeScript Narrative runtime 关键测试

输出要求：

- 按 error / warning / blocker 汇总
- 能复制完整报告
- 输出保持“策划需要知道的问题”口径，不输出原始结构化噪音

### 4. Codex/GPT 能力探针

当前探针确认：

- 能找到 Codex CLI
- `image_generation` feature 可用
- `app-server` 可用
- image generation 结果含 `savedPath`
- token usage 事件可用

用途：

后续 GPT 素材工作台要通过本地 Codex CLI/app-server 调用 GPT agent，而不是 OpenAI API。

### 5. 结构化条件编辑推进

已落地：

- choice option 的 `requireCondition` 使用结构化 ConditionExpr 树。
- switch case 的 `condition` 已从 JSON 文本框改成结构化 ConditionExpr 树。
- dialogue graph 顶层 `preconditions` 已取消外置“附加 JSON”输入框，统一通过条件编辑器填写。
- 条件树覆盖 `flag` / `quest` / `scenario` / `scenarioLine` / `all` / `any` / `not`。

保留：

- 条件编辑器内部仍保留“专家兜底：原始 ConditionExpr 粘贴区”，只用于未来新增条件类型临时兼容；常规制作不依赖它。

### 6. Graph 静态诊断

已落地：

- 生产工作台提供 `Graph诊断` 页签。
- 可按全部或单个 composition 查看。
- 报告覆盖 signal flow、state read、flag/action read-write、quest dependency、dialogue route explain、state direct write 风险、quest/dialogue/scenario/signal 聚合、projection warning、validation issue。
- state direct write 风险会额外标注 owner 边界：同 owner 直接写、跨 owner 直接写、来源/目标 owner 未知。
- 如果运行中浏览器已经上报 runtime snapshot，Graph 诊断报告会附带最新 runtime trace timeline 和 runtime command results。
- 报告可一键复制。

边界：

- 当前是阅读/诊断视图，不做可视化编辑；runtime trace 来自最新 snapshot，不代表历史全量日志。

### 7. 素材规格审计

已落地：

- 生产工作台提供 `素材审计` 页签。
- 扫描 `public/resources/runtime`。
- 输出图片数量、音频数量、总体积、目录分类、实际图片格式、常见尺寸、alpha、动画 sheet、最大图片。
- 通过文件头识别实际格式，不只相信扩展名；可发现 `.png` 实际为 JPEG 的素材。
- 不依赖 Pillow 等外部库，当前支持 PNG / JPEG / WebP / GIF / SVG 的基础尺寸读取。
- 可生成 `风格/命名参考` 报告：按分类抽代表样本，输出常见目录、尺寸、透明倾向、命名词和粗略主色，方便直接贴给 Codex/GPT 作为素材风格上下文。

用途：

- 给后续 GPT 素材工作台生成 prompt 模板、重抽尺寸、alpha 要求、帧动画 sheet 流程提供依据。

### 8. 内置图片工具

已落地：

- 生产工作台提供 `图片工具` 页签。
- 支持单图读取/预览。
- 支持输出格式转换：PNG / JPEG / WebP。
- 支持缩放，可保持比例。
- 支持像素级裁剪：X / Y / W / H。
- 支持在预览图上鼠标拖拽框选裁剪区域，并自动回填 X / Y / W / H，之后仍可用数值做像素级微调。
- 精细裁剪内部以源图像素坐标保存；窗口缩放或预览区域变化不会改变真实裁剪范围。
- 支持自动裁透明空边。
- 支持基础调色：亮度、对比度、饱和度、锐化。
- 输出文件默认限制在当前工程目录内；覆盖现有文件前必须确认。
- 显式选择 PNG / JPEG / WebP 时，输出后缀会自动对齐，避免出现“JPEG 内容但文件名仍是 .png”的错配素材。
- 处理结果可复制，便于交给 Codex 继续定位。

用途：

- GPT 产物落地后，不用跳到外部工具就能做基础加工。
- 支持快速改分辨率、裁掉脏边、转透明 PNG 或白底 JPEG。
- 已接入素材任务执行链和素材候选页：单图可手工处理，候选可批量后处理，Codex/GPT 执行后也可自动生成 `_ready` 后处理副本。

边界：

- 当前是基础后处理工具，不做图层、笔刷、蒙版和局部重绘。
- 单图处理在 `图片工具` 页签；批量后处理在 `素材候选` 页签；动画 sheet 拆帧/合帧在 `动画Sheet` 页签。
- 更重的绘制、蒙版、局部重绘仍交给 GPT agent 或专业绘图工具。

### 9. GPT 素材候选版本

已落地：

- 生产工作台提供 `素材候选` 页签。
- `素材候选` 不在工作台启动时同步扫描运行记录；进入页签后点击 `刷新候选` 后台读取，避免打开工具时被历史候选数量卡住。
- 扫描 `production_workbench/asset_task_runs/*/summary.json` 中的 `eventSummary.savedPaths`。
- 对存在的图片读取尺寸、格式和透明通道。
- 对缺失文件明确标记，避免误以为生成成功。
- 可显示 Codex 执行后的自动验收结果：未验收 / 验收通过 / 验收警告 / 验收失败。
- 自动验收问题会直接显示在候选报告里，例如尺寸不符、透明不符、sheet 无法解释。
- 可记录候选评审状态：未评审 / 保留 / 废弃 / 采用。
- 可记录候选修改/淘汰备注。
- 候选报告可复制。
- 选中候选后可一键载入 `图片工具`，继续做格式转换、缩放、裁剪、调色等后处理。
- 可用候选和备注自动填充一张 `redraw` 素材任务单，减少重抽时重复写 prompt。
- 可批量把自动验收失败/警告，或人工标记保留/废弃的候选创建为 `redraw` 素材任务单；任务单会继承候选路径、尺寸、透明、参考图和评审/验收问题。
- 可批量生成候选交付评分/排序报告；评分只基于文件存在、自动验收、人工评审、尺寸/透明信息，不判断美术质量。
- 可对自动验收通过，或人工标记保留/采用的候选批量执行后处理预设。
- 批量后处理支持输出目录、输出后缀、格式转换、缩放、保持比例、自动裁透明空边和覆盖开关。

用途：

- Codex/GPT 生成素材后，不需要去日志里翻 `savedPath`。
- Codex/GPT 生成素材后，不需要再打开 `output-validation.txt` 才知道哪张失败。
- 支持快速比较同一任务多版输出，先挑图，再后处理。
- 支持用规则评分先过滤缺失、验收失败、人工废弃候选，减少人工看图负担。
- 支持把“这版哪里不对”沉淀为备注，并直接进入单张或批量重抽任务单。
- 支持把“这版能用”的候选批量加工成可交付版本。
- 给后续批量执行、收藏/废弃标记、自动后处理流水线打基础。

边界：

- 当前是候选查看和后处理入口，不是完整素材 DAM。
- 批量评分当前是规则化交付风险排序，不是美术质量评分；最终采用仍需人工看图。
- 批量重抽当前只创建任务单，不会自动批量执行 Codex；这是生产保护策略，避免连环生成污染素材库。
- 批量后处理可在候选页手动触发；单次 Codex 执行可勾选自动对 savedPath 生成 `_ready` 后处理副本。

### 10. 动画 Sheet 工具

已落地：

- 生产工作台提供 `动画Sheet` 页签。
- 支持检查 sheet 网格：整图尺寸、columns、rows、单帧宽高、帧数、透明通道。
- 支持按 columns/rows、单帧宽高，或可整除的帧数推断网格。
- 支持把 sheet 拆成 `frame_001.png` 这类单帧 PNG。
- 支持从帧目录重新合成 sheet。
- 支持合成时指定列数、帧数和帧间距。
- 拆帧和合成输出都限制在当前工程目录内，覆盖前需要明确勾选。
- 报告可复制，便于把“帧尺寸不一致 / 网格无法整除”等问题交给 Codex 修。

用途：

- GPT/Codex 产出帧动画后，不用人工猜每帧尺寸。
- 支持先拆帧检查，再重抽坏帧，最后重新合成稳定 sheet。
- 给后续“生成后自动检查动画 sheet 规格”打基础。

边界：

- 当前不做逐帧播放预览。
- 当前不做自动补间、骨骼动画或复杂 atlas metadata 生成。
- 当前合成要求帧尺寸一致；尺寸不一致时会直接报错，避免产出不稳定 sheet。

### 11. GPT 素材任务单

已落地：

- 生产工作台提供 `素材任务` 页签。
- 支持结构化填写类别、操作、目标文件、输出目录、宽高、透明、帧数、参考素材、风格约束、具体要求、验收标准。
- 可根据素材审计结果按分类填充常见尺寸、透明需求、参考素材和默认输出目录。
- 可生成可复制的 Codex/GPT agent 任务文本。
- 可保存任务记录到 `resources/editor_projects/editor_data/production_workbench/asset_tasks.jsonl`。
- 可通过 `执行 Codex 并记录` 调用本地 Codex CLI。
- 可勾选 `执行后自动生成 _ready 后处理副本`，Codex 产出 savedPath 后会按任务宽高和透明要求生成后处理副本。
- 每次执行会保存 prompt、stdout、stderr、规范化 JSONL 事件、last message 和 summary。
- 执行过程中 GUI 会追加阶段进度：保存 prompt、启动 Codex、进程结束、事件解析、自动后处理、summary 写入。
- 执行报告会提取 savedPath、model、token 用量摘要等线索，便于后续验收和复盘；原始 JSONL 事件只落盘，不直接塞进日常 GUI 报告。
- 每次执行会在 run summary 中保存任务规格快照，避免后续无法知道当时要求的宽高、透明、帧数。
- 每次执行后会自动生成 `output-validation.txt`，检查 savedPath 是否存在、尺寸是否符合任务、透明通道是否符合任务。
- 勾选自动后处理时，每次执行后会生成 `postprocess.txt`，并把后处理输出路径写入 run summary。
- 对 animation / animation_sheet / 带 frameCount 的输出，会尝试按帧数解释 sheet，生成网格和单帧尺寸验收结果。

边界：

- 当前执行链使用 Codex CLI `exec --json`，不是 app-server 实时 UI。
- 当前实时进度是 Codex CLI 阶段进度，不是 app-server token/图片生成逐帧流式 UI。
- savedPath/model/tokenUsage 依赖 Codex JSONL 事件；如果某次执行没有这些事件，工具会保留原始日志但无法凭空推断。
- 当前已经能在 `素材候选` 中查看 savedPath、手动载入图片工具、创建单张/批量重抽任务、批量后处理通过/保留候选，也能在 Codex 执行后自动做基础输出验收，并可选自动生成 `_ready` 后处理副本。
- 后续如果 Codex app-server 暴露稳定接口，可再升级为 app-server 级细粒度实时进度；当前生产链已覆盖 CLI 执行、产物回收、基础验收和生成后处理流水线。

## 收口核对

### 1. Narrative State 编辑器修复

已完成：

- `contextState` 图选择 bug：保存时使用当前显示的 graphId，不能读旧 `currentData`。
- 普通内容编辑中弱化或隐藏 `setNarrativeState`，保留到 Debug/修复入口。
- dialogue graph 条件编辑中的 `flag` / `quest` / `scenario` / `scenarioLine` / `all` / `any` / `not` 已有结构化 GUI。

已验证：

- Python 编辑器校验和 TypeScript runtime 校验使用同一批核心 blocking/warning 语义；关键测试覆盖 warning 不阻断、error 阻断保存。

不改：

- 不改 `narrative_graphs.json` schema。
- 不改 runtime `NarrativeStateManager` 核心语义。

### 2. 完整每日检查链

每日检查要继续纳入：

- runtime TS 测试关键集
- Python 编辑器测试关键集
- narrative graph 校验
- dialogue graph 校验（已接入轻量结构检查）
- save/load/re-enter 状态一致性 smoke（已接入 `SaveManager` 层：存档系统状态、读档分发状态、按存档 sceneId 重进场景）
- asset reference audit
- 素材规格检查（已接入尺寸/格式轻量检查）
- story unit 生产追踪完整性

目标：

每天打开工作台点一次，能知道“今天还能不能继续做内容”。

### 3. 剧情单元验收脚本

已完成基础生产追踪：

- 每个剧情单元都有独立验收脚本字段。
- 字段覆盖入口、初始 flag/quest/scenario/narrative state、执行步骤、option、期望 signal/state/quest/scenario、存读档复查。
- 保存到 `story_units.json`，不写 runtime JSON。
- 复制当前报告时会带上验收脚本摘要和缺项。
- 每日检查会对 `待验收` / `通过` 的剧情单元检查脚本完整性。
- `剧情单元` 页签提供 `检查验收脚本` 按钮，可静态检查脚本里的 dialogue / graph / state / signal / quest / scenario / scene 引用是否存在。
- `剧情单元` 页签提供 `对比运行时快照` 按钮，可把期望 signal / narrative state / quest / scenario 和最新 runtime snapshot 对照。
- `剧情单元` 页签提供 `开始验收运行` 按钮，会清空旧 runtime snapshot，把可解析的 `setupFlags` / `setupQuests` / `setupScenarios` / `setupNarrativeStates` 转成 DEV runtime 命令，通知运行中浏览器应用前置状态，然后清 runtime trace。
- `startEntry` 会在清 trace 后、ready 快照前转成 runtime 命令执行；例如 `scene:test_scene`、`dialogue:ringboy`、`npc:npc_ringboy`、`hotspot:poster`。
- `开始验收运行` 也会尝试把可解析的 `actions` / `optionChoices` 转成运行时驱动命令，例如 `scene:test_scene`、`signal:ringboy.met`、`hotspot:poster`、`npc:npc_ringboy`、`dialogue:ringboy`、`走完对话`、`option:1`、`option:帮忙`。
- 验收脚本动作已支持基础时空和自由探索驱动：`等待500ms` / `wait:1s`、`player:100,200 snap:false`、`moveTo x=120 y=240 speed:220`、`path:100,200 -> 120,240 -> 160,260 speed:220 waitBetween:250`、`click:10,20`、`drag:10,20 -> 30,40 duration:250ms`。
- `存读档复查` 已支持基础自动命令：包含“保存读档 / 存读档 / save/load”的文本会执行 `debugSaveGame -> wait -> debugLoadGame`；包含“重进 / re-enter / reload scene”的文本会执行 `debugReloadScene`；默认使用测试槽位 2，也可写 `slot:1`。
- `剧情单元` 页签提供 `完成验收并对比` 按钮，会读取最新 runtime snapshot、对比期望、回填最近验收结果和备注。
- `完成验收并对比` 会检查自动存读档/重进场景命令结果；只有明确写“人工 / 手动 / manual”的复查项才保留为人工确认。
- 检查结果自动复制到剪贴板，便于交给 Codex 或贴到 issue。
- 每日检查的 TS 工具链已经包含 `SaveManager` 存读档/重进场景 smoke：确认系统状态能进入存档、读档能分发状态，并用存档里的 sceneId 调用重进场景入口。

当前已达到：

- 把脚本和 simulator/browser 操作对接，做到真正一键驱动游戏操作。
- 从运行结果沉淀失败复现报告和自动定位建议：验收运行单、完成对比报告、runtime trace、runtime command results 都可复制给 Codex。
- 已能通过 runtime API 自动执行基础“保存 -> 读档 -> 重进场景 -> 再抓 runtime snapshot”链路；重复触发/美术表现等需要写成明确期望或人工确认。

最终每个剧情单元至少要能记录、检查并运行：

- 从哪个入口进入
- 需要设置哪些初始 flag / quest / scenario / narrative state
- 执行哪个对话 / 区域 / 交互
- 选择哪个 option
- 期望发出哪个 signal
- 期望进入哪个 narrative state
- 期望 quest/scenario 怎么变化
- 保存读档重进后是否仍正确

这个属于生产验收，不等同于运行时状态。

### 4. Graph 诊断视图

必须做成可复制、可筛选的阅读诊断，不做复杂可视化编辑。

已完成部分：

- runtime `NarrativeStateManager.debugSnapshot()` 已暴露 `recentTrace` 结构化时间线。
- trace 覆盖 signal received/ignored/broadcast、trigger queue/start/end、transition applied、state changed、lifecycle actions start/end/failed、runtime issue。
- `window.__gameDevAPI.getNarrativeDebugSnapshot()` 可读取该 trace。
- F2 Debug 面板的叙事区会展示最近 runtime trace。
- Narrative Editor Web 的 PreviewPanel 会展示 Runtime Trace。
- 生产工作台可读取 runtime snapshot，并能用剧情单元验收脚本对比最新 trace/state。

当前状态：

- 生产工作台已经能通过 DEV runtime command 驱动可解析的剧情单元操作；小游戏/自由探索可用通用 `click` / `drag` 坐标命令覆盖基础验收。
- runtime trace 已能被验收脚本读取对比；可解析的入口、前置状态、场景切换、signal、hotspot、npc、dialogue、option、等待、玩家坐标、玩家移动、点击、拖拽可以自动执行。

需要视图：

- signal flow（已接入）
- flag read/write（已接入基础 action/condition 扫描）
- quest dependency（已接入）
- dialogue route explain（已接入基础 route 摘要）
- runtime trace timeline（已接入最新 snapshot）
- owner 边界与跨 owner 写入风险（state direct write 已接入；其它读写边可继续细化）

### 5. 运行时 Debug

需要集中入口：

- 当前 narrative state 快照
- 当前 quest/scenario/flag 快照
- 最近 signal / action trace
- 当前可交互对象状态
- 一键复制事故报告

重点不是“看起来酷”，而是出问题时能快速复现和定位。

当前已补：

- `recentTrace` 已提供最近 signal / transition / action / issue 时间线。
- `clearNarrativeDebugTrace()` 已暴露给 `window.__gameDevAPI`，便于复现前清空旧 trace。
- Vite dev server 提供 `/__gamedraft-api/runtime-debug-snapshot`，运行中浏览器会把 runtime snapshot 写到 `resources/editor_projects/editor_data/production_workbench/runtime_debug_snapshot.json`。
- Vite dev server 提供 `/__gamedraft-api/runtime-command`，生产工作台可写入 DEV-only runtime 命令队列。
- 运行中浏览器会轮询 runtime 命令队列，并只执行白名单 debug 命令：`captureSnapshot`、`clearNarrativeTrace`、`emitNarrativeSignal`、`debugSetNarrativeState`、`setFlag`、`debugSetQuestStatus`、`debugSetScenarioPhase`、`debugSetScenarioLineLifecycle`、`debugResetScenarioProgress`、`debugStartDialogueGraph`、`debugAdvanceDialogue`、`debugChooseDialogueOption`、`debugSwitchScene`、`debugTriggerHotspot`、`debugInteractNpc`、`debugWait`、`debugSetPlayerPosition`、`debugMovePlayerTo`、`debugClick`、`debugDrag`、`debugSaveGame`、`debugLoadGame`、`debugReloadScene`。
- `setFlag` 命令会按 flag registry 判断可写 key 和 bool/float/string 类型，避免 debug 命令写坏运行时状态。
- 生产工作台提供 `运行时Debug` 页签，可读取最新快照并生成可复制事故报告。
- `运行时Debug` 页签可请求 runtime 立即抓快照、清空 Narrative trace、查看/清空命令队列。
- 事故报告会展示最近一次 runtime command 执行结果；命令失败时不用再去浏览器 console 里翻。
- 生产工作台的 `剧情单元` 页签可将当前剧情单元验收脚本和最新快照对比。
- 生产工作台的 `剧情单元` 页签可执行半自动验收运行：开始时清旧快照、应用可解析的前置 flag/quest/scenario/narrative state、通知 runtime 清 trace、驱动可解析的 scene/signal/hotspot/npc/dialogue/advance/option/wait/player position/player move/player path/click/drag/save/load/reload scene，结束时对比快照并回填最近验收结果。
- 事故报告包含 current scene、GameState、narrative active states、flag/quest/scenario 计数、runtime trace、recent transitions、runtime issues、dialogue/condition summary。

边界：

- 当前是“工作台写 DEV 命令队列 -> 运行中浏览器轮询执行 -> 自动上报快照 -> 工作台读取文件”，不是 Python GUI 直接控制浏览器点击。
- 只有可解析的前置状态会自动写入 runtime；解析不了的 `setup*` 行会进入运行单 warning，仍需人工处理。
- 当前是通过 runtime API 驱动游戏，不是浏览器自动化框架；普通等待、坐标传送、直线走到点位、多段路径、点击、拖拽、基础保存/读档/重进场景已经可自动化。复杂小游戏策略仍需写成可验收的坐标步骤或人工确认。

### 6. GPT 素材工作台

前提：

- 用户不能访问 API。
- 素材生产主要靠 GPT agent。
- 工具必须直接调用本地 Codex/GPT agent 能力。

必须支持：

- 准确描述要改什么（已做任务单）
- 快速重抽（已做任务单入口、Codex CLI 执行记录、候选评审、基于候选创建单张/批量 redraw 任务；批量执行保持人工确认以保护素材库）
- 快速改分辨率（已做宽高字段、内置图片工具和 Codex 执行后可选自动后处理）
- 快速稳定产出帧动画 sheet（已做帧数/operation 字段、sheet 检查/拆帧/合帧，Codex 输出验收会按 frameCount 检查 sheet 网格）
- 同时支持静态物件：场景、角色、道具、UI 图标、文档图、氛围图
- 能读取当前素材规格、尺寸、命名、组织形式和风格参考
- 能把生成结果保存到正确目录
- 能记录 prompt、修订说明、模型、token 用量、输出文件路径（CLI 执行链已做基础记录，候选页可读取 savedPath，summary 保存任务快照）
- 能对生成后的图片做基础后处理：转格式、缩放、裁剪、自动裁透明边、基础调色
- 能对生成结果做自动基础验收：文件存在、尺寸、透明、动画 sheet 网格
- 能把可用候选批量后处理成可交付版本：转格式、缩放、自动裁透明边

第一步不是直接做大 GUI，而是先做素材库审计：

- 统计素材目录结构（已做）
- 统计图片尺寸、格式、透明通道（已做）
- 按场景/角色/道具/动画/文档/音频分类（已做基础分类）
- 抽样查看风格、主色和命名规律（已做基础版）
- 读取 Codex/GPT 生成候选 savedPath（已做基础版）
- 动画 sheet 检查、拆帧、合帧（已做基础版）
- Codex 执行完成后自动生成输出验收报告（已做基础版）
- Codex 执行完成后可选自动生成 `_ready` 后处理副本（已做基础版）
- 候选页批量后处理通过/保留候选（已做基础版）
- 候选页批量创建 redraw 重抽任务单（已做基础版）
- 再决定 GPT 素材工作台的信息架构

### 7. 策划操作指南

需要按“能一步一步跟着做”写，不写工具实现细节。

最低指南：

- 打开工程
- 打开生产工作台
- 每天先跑每日检查
- 选择剧情单元
- 填入口、出口、验收
- 去现有编辑器改具体内容
- 回工作台刷新
- 复制问题报告给 Codex
- 素材缺口如何登记
- 验收通过后如何标状态

### 8. 不再推进的方向

以下方向暂时停止：

- CSV 导表生产管线
- YAML graph 管线
- VS Code YAML LSP 主入口
- pipeline-owned / legacy-owned 双工作流
- Graph 可视化编辑器替代现有编辑器

原因：

当前项目没有足够复杂的结构数据需要导表；维护两套工作流会拖垮制作。现阶段必须围绕现有编辑器和 runtime JSON 做生产化。

## 验收口径

一个功能算完成，必须满足：

- GUI 中有明确入口。
- 不需要策划手写复杂 JSON。
- 出错信息能复制。
- 输出不是原始噪音。
- 有最小自动测试或 smoke 检查。
- 不破坏 runtime JSON schema。
- 不引入第二套内容生产权威。
