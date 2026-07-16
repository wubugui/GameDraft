<!-- 生成文件,禁止手写;由 agent_docs/_meta/audit.py 重生成 -->

# agent_docs 索引

> 按域 × 类型分组;每行 summary 即'读不读全文'的判断依据。
> 收录标准与治理规则见 [_meta/constitution.md](_meta/constitution.md)。

## runtime

### 规范
- [运行时开发规范](runtime/norms.md) — 运行时(src/)改动的不变量、过程义务、验收门与审批红线(v2 审批稿迁入)

### 机制卡
- [加 Action 四件套](runtime/mechanisms/action-registration-quadruple.md) — 新 action = 运行时 register + actionParamManifest(TS 权威) + 编辑器 ACTION_TYPES/_PARAM_SCHEMAS + validator 认可;参数含实体/场景引用另登记 ENTITY_REF_PARAMS(第五件);DEV 启动一致性审计兜底
- [档案系统解锁语义](runtime/mechanisms/archive-unlock-semantics.md) — 人物档案解锁唯一入口=addArchiveEntry(幂等);lore/doc/book 走声明式条件;totalPages 只认 pages.length
- [角色注册表(characterId 合并)](runtime/mechanisms/character-registry.md) — 角色身份(name/animFile/portraitSlug)一处定义,NpcDef.characterId 引用,实例化时合并且 own 字段赢过注册表
- [过场音频回收契约](runtime/mechanisms/cutscene-audio-reclamation.md) — 过场 SFX 作用域捕获 + 快照音频基线;中断路径停尾音、自然播完保留末拍——cleanup 布尔语义勿回退
- [过场步骤语义(parallel/镜头位/字幕推进)](runtime/mechanisms/cutscene-step-semantics.md) — parallel 是 fork-join 组内无时序;匿名镜头位自动顶掉;showImg 有 kenBurns/zIndex;subtitleAutoAdvance 三态——编排过场先认这套边界
- [调试/游戏内 UI 偏好持久化范式](runtime/mechanisms/debug-ui-persistence.md) — 调试/编辑器 UI 的用户偏好必须落工程文件;传输两种:vite 中间件(游戏内)/QWebChannel bridge(内嵌编辑器);localStorage-only 被用户明确否决(2026-07-07)
- [dialogue:end 负载语义](runtime/mechanisms/dialogue-end-payload.md) — dialogue:end 带 source/willContinue/nestedInGraph;状态恢复只认最外层、只认恰好一次 willContinue=false 的最终 end
- [对话头像(立绘)运行时](runtime/mechanisms/dialogue-portrait-runtime.md) — 双写法——显式 {slug,emotion} 或 emotion-only 跟随说话人按"装扮配置"解析;UI 收到的 portrait 恒带 slug
- [逐 entity 光照/投影阴影/AO](runtime/mechanisms/entity-lighting.md) — 阴影三模式 real/planar/off + 独立色调开关 + 位置驱动光照曲线;方位角双约定与"脚点锚必须与深度图同源"是最大的坑
- [实体显隐四通道合成](runtime/mechanisms/entity-visibility-channels.md) — active = 派生基底 ∧ 条件 ∧ 会话覆盖≠false ∧ !pickedUp;四通道独立存储、实体内单点合成,禁止直接 setEnabled 冲掉运行态
- [背包槽上限与 critical 给予](runtime/mechanisms/inventory-capacity-critical.md) — 背包有槽上限,giveItem 返回值必须消费;关键道具用 critical=true 绕上限,拾取失败走 inventory:full 不消耗热点
- [小游戏会话生命周期](runtime/mechanisms/minigame-session-lifecycle.md) — 小游戏统一走 MinigameSessionManagerBase;start 的异常必须 catch→teardownSession,否则一次抛错 brick 整个子系统
- [信号驱动 5 层编排脊椎](runtime/mechanisms/narrative-signal-spine.md) — 世界→对话(只演+打信号)→scenario子图→主线里程碑图→quest纯镜像;主线叙事图是唯一进度真相源
- [叠图动作 id=句柄、image 才是图引用](runtime/mechanisms/overlay-image-handle-semantics.md) — show/blend/hideOverlayImage 的 id 是图层实例句柄;引用 overlay_images.json 的是 image/fromImage/toImage;校验别搞反
- [parallaxScene 运行时语义](runtime/mechanisms/parallax-scene-runtime.md) — present 步播 parallax_scenes.json 的分层关键帧动画;运行时只认 layers[].keyframes,camera/depth/sourceKeyframes 是编辑器专用被完全忽略
- [位面系统(PlaneReconciler)](runtime/mechanisms/plane-system.md) — 位面=全局一等资产(normal 也是位面),实体归属位面;PlaneReconciler 从叙事状态派生一切、每个边界重派生、零自持久化
- [存读档硬契约](runtime/mechanisms/save-restore-contracts.md) — load 坏档先拒+快照回滚、save/load 返 boolean;读档静默清 zone、清位面 manual override;新游戏=净化 URL 整页 reload
- [scenarios.json 运行时消费语义](runtime/mechanisms/scenario-catalog-semantics.md) — catalog 里 phase 的默认 status 与 outcome 是惰性摆设,真被消费的只有 requires/exposes/manualLineLifecycle/dialogueGraphIds
- [场景 onEnter 揭幕时机契约](runtime/mechanisms/scene-onenter-reveal-timing.md) — loadScene 尾序=scene:ready → 揭幕(onReveal) → onEnter;onEnter 在"已就绪且已揭幕"后执行,里面可安全起可见/长演出
- [气味系统(双层 action/zone)](runtime/mechanisms/smell-system.md) — action 层永远压过 zone 层;zone 气味声明式挂 ZoneDef.smell,SmellSystem 听 zone:enter 驱动,ZoneSystem 不动
- [首启手势门 + 音频解锁快路径](runtime/mechanisms/start-gate-audio-unlock.md) — 「点击开始」遮罩给页面 sticky 激活;AudioManager init 时按 hasBeenActive 直接解锁——救开场首句配音音画同步
- [UI 面板皮肤单一入口](runtime/mechanisms/ui-panel-skin.md) — 全部面板底/边走 PanelSkin.drawPanelBase + SKINS;改观感只动 PanelSkin.ts 一处,禁止在面板里复制 fill+stroke
- [zone 生命周期与上下文契约](runtime/mechanisms/zone-lifecycle-contracts.md) — zone:enter/exit 是声明式触发载体;zone 上下文按参数线程化(executeBatchInZoneContext),禁回退全局栈;位面重注册仅 Exploring

### 配方
- [无头画面/逻辑全自动验证](runtime/recipes/headless-visual-verification.md) — 隐藏页 rAF 完全暂停——dev模式+命令通道+rAF pump/forceFrame 出帧截图;含 MessageChannel 让步与合成钟追平配方
- [运行时命令通道(脚本化驱动游戏)](runtime/recipes/runtime-command-channel.md) — HTTP 命令队列驱动 DEV 游戏+读快照断言;测试/操作游戏一律走它,不用 computer-use/点像素

### 决策记录
- [人物档案解锁只走一个动作](runtime/decisions/2026-06-30-archive-unlock-single-action.md) — 人物档案解锁唯一通道=addArchiveEntry;名字匹配、条件自动解锁、unlockConditions 字段全部删除
- [对话立绘构图定稿](runtime/decisions/2026-07-07-dialogue-portrait-composition.md) — VN 式小半身像(240px)压面板前景、底边伸出画面外、暗幕 opt-in;大立绘/默认压暗/垫面板后/底部渐隐均被否
- [位面基建 v3 模型拍板](runtime/decisions/2026-07-05-plane-v3-model.md) — 位面=全局一等资产+实体归属+叙事只点名+对账器重派生;v1(绑任务图)/v2(实体变体表)/接管式小游戏均被否
- [scenarios.json 一等公民系统退役](runtime/decisions/2026-07-15-scenario-firstclass-retirement.md) — 2026-07-13 拍板退役一等公民 scenario 系统;stage-1 数据侧已落地(scenarios.json 清空、码头两线迁 narrative),stage-2 代码删除待做(届时 6→4 条件叶为 approval①)
- [UI 面板美学方向定稿](runtime/decisions/2026-07-05-ui-panel-skin-direction.md) — 民俗草根·极简——暖近黑底+一条素旧木边+小圆角,纯程序化零素材;繁复雕木/符箓/印章金线云纹全被否

## editor-tools

### 规范
- [编辑器/策划工具开发规范](editor-tools/norms.md) — PyQt 编辑器改动的不变量(零丢失往返/真实脏态/唯一写盘口/选择器铁律)、布局纪律、验收门与红线

### 机制卡
- [_PARAM_SCHEMAS 是控件清单不是必填集](editor-tools/mechanisms/action-param-schemas-vs-required.md) — 给 action 加"可选"参数时,叙事编辑器的 Python 兜底校验默认把 _PARAM_SCHEMAS 每项当必填拦保存——必须显式覆盖 required
- [转盘氛围脚本编辑器](editor-tools/mechanisms/atmosphere-script-editor.md) — 递归指令列表编辑器(RPGMaker-event 式,非 DSL/树);复用 ActionEditor 的范式不复用控件;to_list 输出必须与独立轻量运行时逐字段一致
- [关闭路径的 Discard 中和与 flush 门控](editor-tools/mechanisms/close-path-flush-discard.md) — 主窗口关闭 = 逐页 confirm_close → 统一 flush_to_model;Discard 必须把 UI 回滚到模型值,flush 必须门控真实变更,否则被放弃的编辑复活或零编辑伪脏
- [图对话编辑器](editor-tools/mechanisms/dialogue-graph-editor.md) — 独立包内嵌主编辑器的图对话编辑;分层架构 + 表单形状保真回写 + 语义零变化时原样字节回写;往返探针是改 inspector 的必跑门
- [画布/表单编辑器数据零丢失范式](editor-tools/mechanisms/editor-data-sync-paradigm.md) — 单一真相源 + 即时入脏 + commit-on-leave + 懒回写按身份;门控只认 pending 信号的路径(deselect/新增/点空白)是静默丢编辑的惯性破口
- [信号发射源权威口径(emitted_signal_ids)](editor-tools/mechanisms/emitted-signal-catalog.md) — 哪些容器算"实发信号":对话图+内容资产动作树+叙事图 onEnter/onExitActions+broadcastOnEnter 派生;blackbox meta.emits 只是声明不算实发;悬垂监听/空声明全 warning
- [json_lang「JSON=语言」工具链(schema 索引器 + LSP)](editor-tools/mechanisms/json-lang-schema-tooling.md) — 把数据 JSON 当语言:运行时=解释器、编辑器=IDE、JSON=源码;从权威代码现场重算 schema 供 IDE/LSP 补全与查错;方向永远代码→schema,out/ 不入库,只咨询不裁决
- [主窗口编辑器接入钩子(鸭子协议)](editor-tools/mechanisms/mainwindow-editor-hooks.md) — 主窗门控靠 getattr 鸭子协议调 flush_to_model/confirm_close/reload_refs_from_model——新编辑器缺钩子不报错、静默漏网,接入时必须逐项对齐
- [叙事状态机编辑器(PySide 壳 + React Flow)](editor-tools/mechanisms/narrative-state-editor.md) — 唯一非原生 PyQt 编辑器;三方校验中 Python 兜底必须是 TS 权威的子集、两步保存、dist 是独立产物(重建≠页面刷新)、落盘字节级幂等
- [叙事状态机模板系统](editor-tools/mechanisms/narrative-template-system.md) — 填 taskId 一键派生任务;模板文件编辑器专用运行时永不加载、{{taskId}}__ 信号构造性防撞名、盖章三产物全有全无暂存
- [数值往返保真(preserve_numeric_repr)](editor-tools/mechanisms/numeric-roundtrip-fidelity.md) — Qt 数值控件会把"打开即保存"变成 int→float 漂移/clamp 丢值/默认 0 盖掉运行时默认——未改动的数值键必须按原始表示回写
- [位面编辑器槽继承 UI 语义](editor-tools/mechanisms/plane-editor-slot-inheritance.md) — dict 槽用"显式配置此槽"闸门——不勾=不写键(继承)、勾且空 {} 是合法的整槽覆盖原语;解析口径与运行时 expandExtends 靠 parity 测试锁定
- [save_all 两阶段写与脏桶护栏](editor-tools/mechanisms/save-all-dirty-buckets.md) — 全部脏桶先落 .tmp 再统一 os.replace(任何失败磁盘零变化);mark_dirty 只认 KNOWN_DIRTY_BUCKETS 登记键;新数据域必须三处同步
- [共享选择器控件的保值契约](editor-tools/mechanisms/shared-widget-value-fidelity.md) — IdRefSelector 等共享控件被约 40 处调用点依赖——未知/悬垂值必须保值展示而非静默顶替或清空;一处控件破坏 = 全编辑器数据面污染
- [过场步骤编辑器(TimelineEditor)契约](editor-tools/mechanisms/timeline-editor-contracts.md) — UI/交互改动不得改 StepWidget.to_dict 序列化输出;已有搜索/撤销/剪贴板等能力勿重复造;含一个 PySide takeAt 布局级深坑

### 配方
- [改编辑器后的验证门](editor-tools/recipes/editor-change-verification-gate.md) — 三件套(全量测试+素材审计+validate-data)+ 已知盲区对策 + "输出字节不变"强验收法;解释器 .tools/venv + offscreen

### 决策记录
- [氛围脚本编辑器独立实现(不复用 ActionEditor 控件)](editor-tools/decisions/2026-07-01-atmosphere-script-standalone.md) — 转盘氛围脚本用递归指令列表独立编辑器;复用 ActionEditor 的范式不复用控件;氛围 op 不并入通用 action 系统
- [下拉 vs 弹窗选择器边界](editor-tools/decisions/2026-07-11-dropdown-vs-popup-selector.md) — 只有很短的枚举列表才允许下拉;其它引用/大候选集/视觉资产选择一律弹窗选择器(2026-07-11 拍板)
- [位面被多图点名的校验口径](editor-tools/decisions/2026-07-10-plane-multi-graph-declaration-warning.md) — 同一位面被多张叙事图点名完全合法不报;仅多图点名不同位面才 warning;勿回退成"全局唯一"error
- [模板盖章产物全有全无暂存](editor-tools/decisions/2026-07-10-template-stamp-all-or-nothing.md) — 盖章三产物(合并叙事图+镜像quest+对话桩)一并暂存 ProjectModel、零磁盘写,Save All 一处落盘;放弃/崩溃=三样全无

## content

### 规范
- [内容制作规范(策划模式)](content/norms.md) — 做内容/改JSON 的三红线、机制通道铁律、题材文案铁律、双校验门与红线

### 工作法
- [事件流程编排工作法(故事→可落地的信号驱动流程)](content/methods/narrative-flow-authoring.md) — 把任意规模事件(主线/支线/微任务/遭遇/见闻)拆成信号脊椎上一条流程;正交五关(状态→骨架→实体→地图→位面)+三旋钮定类型;进度走信号不堆flag,单拍落地委托 wire-demo-beat
- [策划模式工作法(做内容/改JSON)](content/methods/production-mode-workflow.md) — 做内容只写 JSON 的工作形状——入口能力判定 L1/L2/L3、数据实施、双校验门收尾;写不出来就升级/上报,不糊弄

### 机制卡
- [渝都口音对白契约(细则与查证源)](content/mechanisms/chongqing-dialect-voice.md) — 全部角色对白只能西南官话渝都腔(重庆非成都),禁您/俺/儿化/哩;钦定词逐字照用;写/审台词前先查 docs/重庆话语料库.md
- [内容表达五通道(权威清单在哪)](content/mechanisms/content-expression-channels.md) — 内容 JSON 表达游戏行为只有五条权威通道(command/cutscene/条件/图对话/[tag:]),绕过的写法运行时被静默跳过或编辑器拒存
- [编辑器可往返硬契约](content/mechanisms/editor-roundtrip-contract.md) — agent 写的 JSON 必须让人类仍能用编辑器打开并原样存回——格式/文件范围/重建区/deprecated/引用有效五组契约,违反即丢数据或整工程存不了
- [实体迁移/改名/删除走重构引擎(勿手搓引用网)](content/mechanisms/entity-refactor-engine.md) — 场景实体(npc/hotspot/zone/出生点)的迁移/改名/删除不要手改 JSON 引用网——调 entity_refactor 引擎,引用机械改写+报告+可撤销;裸 id 运行时按当前场景解析、断了静默跳过
- [L2 能力原语登记面(action 三件套)](content/mechanisms/l2-action-primitive-registration.md) — 一条可用 Action = 运行时注册 + 编辑器可配 + 校验认可,缺一视为未完成;含嵌套/异步/可选参数三个已知坑与审批边界
- [文本引用系统([tag:…])](content/mechanisms/text-ref-tag-system.md) — 玩家可见文本统一经 resolveText 解析 [tag:…];存档永远存 raw、JIT 解析;扩展须运行时+编辑器三件套一致;引用目标不存在则整工程存不了

### 配方
- [内容收尾双校验门(命令与盲点)](content/recipes/content-validation-gate.md) — 每次改完内容 JSON 必跑的两条命令(素材审计 + validate-data)、退出码语义、以及校验抓不到要自己当心的盲点
- [配一个信号驱动拍子(动哪5处)](content/recipes/wire-demo-beat.md) — 给寻狗 demo 接一拍主线/支线内容,最少动 5 处(场景/对话图/叙事子图/主图/引用素材);含 scenarios.json 撞名坑与各层纪律

### 决策记录
- [阿秀信号冷框架(非温情守护)](content/decisions/2026-06-27-axiu-signal-cold-framing.md) — 香粉味+跑调小调=阿秀死时盲目"不撒手"念气,只认物(帕子包)不认人;无单一确立beat;全部温情守护旧稿作废
- [背尸第一单重排(义庄拦活取代工头派活)](content/decisions/2026-07-12-beishi-first-job-yizhuang-reorchestration.md) — 第一单(路倒)=自由空挡→打哈欠找活→义庄门口被拦接活→自己找尸→背回;工头改为路倒交付后专职派淹尸单;取代旧"工头顺序派两尸"编排
- [开场背尸重设计(日常铺垫反衬诡异)](content/decisions/2026-06-22-beishi-mundane-eerie-redesign.md) — 开场背尸=先做混子糊口零活(零工背尸_done 闸门)铺日常基线,再让背阿秀逐拍崩坏;三个演出增量被否勿复活
- [神仙顶写实冰川设定与"写实中透异常"原则](content/decisions/2026-07-04-shenxianding-realistic-glacier.md) — 神仙顶=真实雪山+真实冰川+远看只一点点的裂缝,严禁玄幻发光/血红巨裂口;上位原则:民俗志怪=写实中透异常
- [气味系统设计定位(常驻≠常见)](content/decisions/2026-06-27-smell-system-position.md) — 气味做成常驻可学习的值驱动感官机制;铁律=系统常驻不等于香粉味常见,香粉味仍是阿秀专属的稀有冷读数
- [寻狗 demo 文档权威与死档清单](content/decisions/2026-06-27-xungouji-doc-authority.md) — 主线权威=Demo完整流程_2026.06.05.md(显示编号≠实现s-id,以其总览表映射为准);废弃归档下与列名旧稿勿据此创作勿回写
- [寻狗记题材调性锚点(五来源合体)](content/decisions/2026-06-25-xungouji-genre-anchor.md) — 寻狗记=45°冒险RPG骨架+民俗志怪血肉的有意合体;五喜好来源共同脊椎=规矩禁忌;调性悲情志怪,非港式喜剧非文艺压抑;关二狗声口=文才+周星驰

## asset-pipeline

### 规范
- [素材管线规范](asset-pipeline/norms.md) — 素材生产的源一致性、程序驱动 agent 裁判、目视验收义务、许可与格式红线

### 工作法
- [对抗验收拆帧法](asset-pipeline/methods/adversarial-frame-decomposition.md) — 把连续内容分解成帧的通用工作形状——先定验收疆域(重放忠实于源/不引入源外的漂移抖动/接缝干净),再靠对抗验证+智能循环收敛;稳定靠锚不靠固定框;不绑动画
- [对抗验收抠图法](asset-pipeline/methods/adversarial-matting.md) — 把主体从背景分离的通用工作形状——先定验收疆域(无残留/不多扣/主体完整/真空隙保留),再靠对抗验证+智能循环收敛;手法只作可选提示,不绑动画
- [烤入背景人物活化工作法](asset-pipeline/methods/baked-figure-activation.md) — 把画在场景原画里的人物做成会动实体:原画底+局部擦人+overlay 呼吸;逐人棋盘格+场内 zoom 双验收
- [角色动画生产工作法](asset-pipeline/methods/character-animation-production.md) — 从"要一个会动的角色"到入库验收的全程形状:源确认→生成→程序产出→agent 裁决→升级阶梯→预览验收

### 机制卡
- [统一动画资源工作台(tools/anim_preview)](asset-pipeline/mechanisms/anim-preview-tool.md) — 人工审查驱动的 A→H 版本图、R 多动作实时装配、Agent 结构化接口和游戏真实渲染终验
- [动画/静态阶段适配器与旧一键产线(tools/animation_pipeline)](asset-pipeline/mechanisms/animation-pipeline.md) — 工作台 E/F/G/R/H/H_STATIC 的无覆盖确定性适配器；旧 build_character 产线保留兼容但不定义新人工 R 语义
- [对话立绘管线](asset-pipeline/mechanisms/dialogue-portrait-pipeline.md) — 立绘 3×3 表情图→切片抠图的契约:flood-fill 灰底结构上无镂空、dehalo 已内建、产物 gitignored 改前必备份
- [抠图路线与判读铁律](asset-pipeline/mechanisms/matting-toolbox.md) — 仓库四条抠图路线的入口与适用域;halo 根因=无 despill;量化指标不可单独裁决(halo 误报白发、多扣须源级测)
- [动画产物契约(atlas.png + anim.json)](asset-pipeline/mechanisms/sprite-atlas-anim-contract.md) — 一切动画素材的产出格式硬契约:0基帧、一角色一图集均匀网格、底中脚锚、每边≤2048、animFile 存完整 URL、编辑边界

### 配方
- [环境动效素材配方(热气/灯光/窗帘/呼吸人物)](asset-pipeline/recipes/ambient-fx-production.md) — LibTV 出黑底/洋红底静图→fx_build.py 程序化循环→网格图集→装饰 NPC 放置(renderRaw/不可交互/脚锚)
- [纯色底色键抠图配方](asset-pipeline/recipes/colorkey-matting.md) — 洋红/纯色底出图→无 halo 抠图:逐图测键色、YCbCr 色度距离、un-mix、despill、补洞铁坑、三底质检
- [LibTV 出图项目配方(模型选型与坑)](asset-pipeline/recipes/libtv-image-generation.md) — 本项目用 LibTV CLI 出素材的实测配方:禁生成透明底(灰底优先/洋红可)、干净 cwd 铁律、三模型选型、悠船 V8.1 三连坑、prompt 换底写法
- [过场视差分层素材装配配方](asset-pipeline/recipes/parallax-layer-assembly.md) — LibTV 分层图→归一 1672×941→zIndex 层序→装配 parallax_scenes.json;方图先裁 16:9 带再缩
- [音效外采与入库配方](asset-pipeline/recipes/sfx-external-sourcing.md) — OpenGameArt/BigSoundBank/Freesound 三渠道下载法 + 许可署名义务 + ogg 必转码 + 入库三件套
- [拆配音词级对齐配方](asset-pipeline/recipes/voice-split-whisper-align.md) — 把整段配音按字幕拆条必须用 whisper 词级时间戳定刀位;纯静音检测会被口播偏词骗

### 决策记录
- [持械位移动作必须单图生视频](asset-pipeline/decisions/2026-07-02-armed-locomotion-single-image-gen.md) — 持械+位移(走/跑)state 生成必须单图生视频(Seedance);动作迁移被否——会把手中道具甩掉
- [烤入背景人物活化技术路线](asset-pipeline/decisions/2026-07-04-baked-patron-activation-route.md) — 定稿=原画底+局部擦人+多边形保留抠图+只向上呼吸;被否=空背景底/形态学开运算/对称sin/nebula单独抠人
- [素材产线程序驱动、agent 当裁判](asset-pipeline/decisions/2026-07-04-program-drives-agent-judges.md) — 产线主入口是确定性程序;agent 只做 QA 语义裁决/异常/配方作者;被否=agent 逐条驱动整条管线
- [重扣源必须=游戏当前源](asset-pipeline/decisions/2026-07-10-reprocess-source-must-match-shipped.md) — 重扣/重生成已上线素材,源以 shipped atlas.meta.json 的 packMode/source 查证;videos_stabilized 被否(更晃+过时,已删)

## meta

### 规范
- [跨域工作规范](meta/norms.md) — 任务分类闸门、四个存放面边界、列举型以代码为准、偏差记录义务

### 工作法
- [制作人协作法(先访谈对齐再出稿)](meta/methods/producer-collab-unknowns.md) — 系统设计类工作先访谈补齐 unknowns 再出方案;参照物>描述;禁最佳实践填空

### 配方
- [异地/新机 DVC 资源还原(勿用裸 dvc pull)](meta/recipes/dvc-oss-restore.md) — 大文件资源还原钦定路径 = ./dev.sh pull(oss2 SDK+多线程+断点续传);裸 dvc pull/fetch 在慢速直连下必挂(dvc-oss 异步栈把 connect_timeout 当总超时且不认代理)
