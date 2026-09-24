<!-- 生成文件,禁止手写;由 agent_docs/_meta/audit.py 重生成 -->

# agent_docs 索引

> 按域 × 类型分组;每行 summary 即'读不读全文'的判断依据。
> 收录标准与治理规则见 [_meta/constitution.md](_meta/constitution.md)。

## runtime

### 规范
- [运行时开发规范](runtime/norms.md) — 运行时(src/)改动的不变量、过程义务、验收门与审批红线(v2 审批稿迁入)

### 机制卡
- [加 Action 的登记面](runtime/mechanisms/action-registration-registry-surfaces.md) — 新 action 要同步的登记面分必填(运行时注册 / TS 参数清单 / 编辑器登记与持久化分类 / 校验器)与条件性(容器槽位 / 实体引用 / 内容 id 引用 / 宿主语境分类表);漏哪一处的报错通道各不相同,有的四条门全绿只有一条编辑器测试红,有的哪里都不红
- [档案系统解锁语义](runtime/mechanisms/archive-unlock-semantics.md) — 人物档案解锁唯一入口=addArchiveEntry(幂等);lore/doc/book 走声明式条件;totalPages 只认 pages.length
- [听者与音频坐标(单一听者 / 两级精度 / 相机视距 / 透视重整)](runtime/mechanisms/audio-listener-space.md) — 全游戏只有一个听者,绑定走一条优先级链;所有发声点经唯一的音频解算器落到 M-world(field/planar 自报级别);相机听者视距用 zoom 比值不用可视宽度且不叠耳高;配了透视线的场景音频坐标要透视重整,因此与光照/粒子那份 M-world 不重合,两边不许互借坐标
- [混音状态与声音归属(总音量 / 玩家偏好 / 演出闪避 / owner)](runtime/mechanisms/audio-mix-and-ownership.md) — AudioManager 是唯一出口与唯一混音状态持有者;玩家偏好落 settings 不进存档,演出压低走闪避层不许动偏好;混音是持续状态(活实例逐个跟随),声音按 owner 归属、owner 退役一次收干净
- [背景草木摆动(离线拆层 · 逐株受迫振子 · 位移图打光 / 不打光同一条路)](runtime/mechanisms/background-sway.md) — 原画离线拆成静态底板 + 逐株植被网格(树整株刚转、灌丛草根部钉住弯、石头在底板上永不动,逐像素刚体度让竿刚叶弯);风只给目标弯角,每株 / 每顶点自己解受迫二阶振子;弯角平滑饱和、从原画姿态算起(原画没有风);渲染写一张 UV 位移图,打光与不打光背景都读它、植物动时一格光照不重算;分割全时段共用、底板按时段各补各的;摆幅透视按视深查表;作者面是草木工作台
- [呼吸图(一张静帧实时在呼吸的叠图 · 离线拆层 + 位移场 · 表演模拟 · 叠图同一套句柄 · 参数实时可改)](runtime/mechanisms/breathing-overlay.md) — 盖脸纸那类「一张静帧实时在呼吸」的叠图:资产 = 离线拆好的几层(底图 / 胸口 / 贴脸的纸 / 垂帘)+ 两张 RGBA16F 位移场 + 骨架常数 + 表演参数预设(assets/data/breathing/<id>.json,呼吸工作台唯一写者);运行时一张自建 Mesh + breathingShade.glsl 每帧反查源点重合几层,挂在叠图同一张 images 表、同一套 id 句柄(hideOverlayImage / 过场 cleanup 都收得掉);BreathingPerformance 是唯一的表演模拟(胸口升余弦、纸按吸/呼窗口贴/飞 + 二阶弹簧、纸比胸口晚走延迟缓冲、渐弱 / 假停 / 猛吸冲量解回弹),走游戏时钟吃暂停闸;三个动作 showBreathingOverlay / breathingPerform(wait = 等渐弱走完 / 猛吸结束)/ setBreathingParams(可渐变);参数表唯一真相源 src/data/breathingParams.json(运行时、工作台、主编辑器共用)
- [打包管线(只读抽取 · dev/发行双档 · 产物验收门)](runtime/mechanisms/build-pipeline.md) — 打包只从开发树只读抽取,绝不改动开发数据;裁剪一律写成"不抽取";清单=JSON引用闭包+传递闭包+id约定+显式规则(光照载荷按载荷自己的 shading.mode 展开,文件名表与运行时共用一份);输出目录是每次传的参数、不进配置;静态清单证明不了完备——release.mjs 默认无头真跑每个场景反向核对清单(scene_sweep),verify 再做开发树→产物的光照载荷平价
- [燃烧系统(可燃物模板 · 宿主实例化 · 确定性燃烧模拟 · 点火表演 · 离场照推与存档)](runtime/mechanisms/burn-system.md) — 可燃物是模板(图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光,和场景无关),热点 / NPC / 演出生成物 / 挂件预设身上写 burnable 引用它 = 实例化一次、渲染由实例接管,粒子薄片 plate.burnable 绑它;场景实例进每场景一份事件驱动的确定性模拟(活跑 / 重放 / 离场照推逐位相同,挪位 / 出现 / 收掉也是外部事件),推不出来 ⇒ 整场切烧完;手上的挂件单独一份模拟存快照;燃烧读的是作者那份场景风(不含阵风);玩家点火 = 走到闭式解出的站位、接触帧火头对准着火点
- [画布(场景之外那张屏幕空间的面)](runtime/mechanisms/canvas-stage.md) — 叠图/文档揭示/实体/特效四类 item 共用一张有序表与一个 order 顺序空间;kind 前缀就是"句柄永不互访"那条解耦的落地形式;画布实体与特效一律不吃场景光照,特效自带第二套 VfxSystem 并逐实例一个宿主
- [角色逐像素照明(probe 底光 + 加性实体灯)](runtime/mechanisms/character-lighting.md) — 只有一条活路径——probe 烘死的 GI 底光 + 与场景同一次打包的加性实体灯 + 与背景同一组显示变换;统一角色路径被 Game 里的常量开关整条关死(留码不删);着色核心单一 GLSL 源,法线必须与 color 同 UV 采样、格边界与运行时 stride 对齐;probe 烘焙与方向基见 character-probe-bake
- [角色 probe 底光的烘焙参数与方向基选型](runtime/mechanisms/character-probe-bake.md) — 角色 GI 底光 probe 的烘焙端与运行时查表端必须同一套规则:正式基八面体(接缝环绕三处同规则)、SH 逐通道去环、逃逸缺省地板色、收敛只许走采样不许走抹、查询沿法线偏同一常量、A7 只折一头;改任一参数前先读这里的已否路线
- [角色注册表(characterId 合并)](runtime/mechanisms/character-registry.md) — 角色身份(name/animFile/portraitSlug)一处定义,NpcDef.characterId 引用,实例化时合并且 own 字段赢过注册表
- [加条件叶的登记面](runtime/mechanisms/condition-leaf-registration-surfaces.md) — 新条件叶要同步运行时求值 / 叙事校验放行口径 / 条件树编辑器 / 分支守卫 / 校验器 / json_lang / 叙事关联人话 / 引用改名跟随;漏哪一面都不报错,只是该叶在那一面恒假、配不出或改名后悬垂
- [坐标空间总表(屏幕→场景 wu→像素栅格→伪世界 q→M-world)](runtime/mechanisms/coordinate-spaces.md) — 全项目六个坐标空间的单位/原点/住户/权威源与逐条可验判据;两个 M(det ±1)、两套像素栅格(比例非恒定 4)、着色在 M-world 而 march 在 q——混用一律不报错只是效果不对
- [过场音频回收契约](runtime/mechanisms/cutscene-audio-reclamation.md) — 过场 SFX 作用域捕获 + 快照音频基线;中断路径停尾音、自然播完保留末拍——cleanup 布尔语义勿回退
- [过场步骤语义(parallel/镜头位/运镜/字幕推进)](runtime/mechanisms/cutscene-step-semantics.md) — 入场三态(就地开演/搬人/跨场景必落人);parallel 是 fork-join 组内无时序;匿名镜头位自动顶掉;运镜受相机夹紧约束、跳过快进到编排终姿;subtitleAutoAdvance 三态;typewriter 缺省按台词面分家
- [日夜循环与 NPC 日程(时刻不自流逝 · 离场宽限集)](runtime/mechanisms/day-night-npc-schedule.md) — 时刻只由动作推进;phases 三级就近取用(实体→分组→种类缺省)且分组不套 NPC 的白日缺省;transition 决定 NPC 换班演不演离场;leaving/arriving 宽限集是"绝不当着玩家的面消失"的唯一实现,判定点只挂 NPC 不进 entityInPlane
- [死亡与重试检查点](runtime/mechanisms/death-and-retry-checkpoint.md) — 耗尽→冻结世界→说明卡→"从安全点重试 / 回主菜单";检查点是一份完整存档快照,只在安全窗口拍、动作只登记请求不等;enterDeath 的收摊顺序(先打断会话再 cancelPending 再兑现时钟)是硬契约;死亡闸把任何"还回探索态"钉回 Dead
- [调试/编辑器偏好与「游戏↔编辑器活数据」的持久化范式](runtime/mechanisms/debug-ui-persistence.md) — 按内容性质分三档:调试/编辑器偏好落 editor_data;游戏↔编辑器的活数据交换也走 editor_data 但必须按"对讲机"设计(服务端版本号+writer+新鲜期);工程数据游戏侧一律不写。玩家设置不归本卡。localStorage 已彻底清退
- [脱手演出会话（技能/天气这类跑在玩家背后的演出）](runtime/mechanisms/detached-performance-session.md) — runActionsDetached 开的是第二条时间线；任何系统都能强制打断，打断＝跳过演出+补齐结算+按账本归位
- [dialogue:end 负载语义](runtime/mechanisms/dialogue-end-payload.md) — dialogue:end 带 source/willContinue/nestedInGraph;状态恢复只认最外层、只认恰好一次 willContinue=false 的最终 end,且只在状态仍是 Dialogue 时恢复
- [对白版式档(屏底/屏顶/气泡/第一人称)与只画选项](runtime/mechanisms/dialogue-layout-styles.md) — 对白外观是一个版式档枚举,四层取值(拍 > 节点 > 图 > 缺省 bottom);选项跟提示句/图级的版式走;第一人称档三处渲染共用一份画法;提示句为空时只画选项;加档要同步 TS 类型、编辑器手工镜像与 parity 测试
- [对话图 owner 归属(四档优先级与注入点登记面)](runtime/mechanisms/dialogue-owner-origin.md) — ownerState 认谁当 owner 由唯一判定源按四档优先级裁;每条能开对话图的路径都必须显式线程化来源上下文,漏注入无红字、只是静默走 missingWrapperNext
- [对话头像(立绘)运行时](runtime/mechanisms/dialogue-portrait-runtime.md) — 头像跟「装扮配置」走不跟实体走;跟随说话人要求这行的说话人实体解析得出来,UI 收到的 portrait 恒带 slug
- [台词配音通道(voice/autoAdvance · 跨拍留声)](runtime/mechanisms/dialogue-voice-channel.md) — 全部台词面共用一条单声道配音通道;默认跟本拍停、hold 留声给后面、声明跟随配音的那拍接管并收尾
- [显示链:逻辑视口 · 等比信箱 · 宿主窗口(4:3 标准)](runtime/mechanisms/display-viewport-and-window.md) — 标准视口 1024×768(4:3)定义在 game_config.viewport;app.screen 恒为它,显示只许等比缩放(Renderer.layoutMount 在 #game-stage 里放最大同比例盒);windowSize 只是宿主窗口期望尺寸,编辑器 F5 与 exe(main.rs 启动时读同一份 JSON)按它开窗;三个布局元素的尺寸规则只住在 index.html
- [文档揭示是「一个入口三态」,且自己一张显示层](runtime/mechanisms/document-reveal-three-states.md) — revealDocument 三态(条件不满足出模糊图/未揭示播动画/已揭示瞬时出清晰图)+force 只跳条件;显示层键是 documentId、与叠图句柄两张表永不互访;收图走 hideDocument
- [场景光环境 / 实体阴影 / 深度遮挡](runtime/mechanisms/entity-lighting.md) — 行走面深度场是遮挡·阴影·碰撞的唯一脚点锚(没场就整体关,不回落拟合直线);阴影一律 planar 剪影但形状量从灯位现算;角色阴影**手动绑灯,禁止自动 resolve**;接触斑与灯无关;深度自比较必须留容差;色调与阴影解耦
- [实体位移的朝向语义(faceTowardMovement)](runtime/mechanisms/entity-move-facing.md) — 不勾选=完全不碰朝向(勿回退成"起点偷改一次");需要转身的内部调用必须显式传 true;朝向只有左右镜像,up/down 不存在
- [实体轨迹动画(烘焙式 · 独立资产)运行时语义](runtime/mechanisms/entity-trajectory.md) — 一条轨迹一个资产文件、帧相对**曲线原点**(作者摆的参考点,不是第一帧);曲线没有锚点,播放位置在播放时给(at 位置引用:数字 / 实体此刻位置 / 场景曲线插槽 / 曲线上的点,含播放头 current);位置引用只认场景曲线(相对曲线是资源、每次播放一个实例,不许引用);运动对象是场景实体(target)或播放时临时生成的图片 / 角色模板(spawn,keep = 播完留下成场景实体进存档);场景曲线可原地播、相对曲线必须给位置;世界空间资产开播时只用 depthConfig.M.R 做一次线性投影;烘出的帧恒不写 easing;一实体一驱动,跳过=一步落终态;轨迹不驱动相机,镜头跟曲线走 = cameraFollowActor 的 at 引用播放头;音效关键点 cues 按时间轴触发(不带位置,跳过/被停不补声)
- [实体显隐四通道合成](runtime/mechanisms/entity-visibility-channels.md) — 四个独立通道(派生基底/条件/会话覆盖/拾取位)在实体内单点合成;任何一方只写自己的通道,禁止直接 setEnabled 冲掉运行态
- [脚步声与空间化音频(帧驱动 + 两级精度 + 可插拔听者)](runtime/mechanisms/footstep-and-spatial-audio.md) — 脚步由动画落脚帧驱动不由计时器,落脚帧住动画包 sockets.json 的 contactSlots(动画浏览页看图标);脚步集一片段一条音效 key 无随机;落脚与出声是两件事;出声只有一份实现(脚步集/两级增益/空间化/句柄回收),跟脚声是玩家落脚事件的延迟重放、走同一条出声路;听者与音频坐标见 audio-listener-space
- [游戏状态机与控制权交接(进出 Exploring)](runtime/mechanisms/game-state-handoff.md) — GameState 只有一个写入口、状态变了才同步通知唯一旁听席;Exploring 是唯一"玩家有控制权"的态,主循环一大批系统只挂在它的分支上——"只在探索态做 / 收尾硬写回探索态"是一族静默 bug 的共同形态
- [血量·威胁·护火(夜间生存的伤害链)](runtime/mechanisms/health-and-threat.md) — 血量有两条写入通道——玩法伤害走 applyDamage(护盾/下限/耗尽→系绳或死亡),编排置数走 setHealth(永不致死);威胁按距离扣血、有火即驱退;"演出态"= 非 Exploring,普通动作批期间普通威胁冻结;player_health / player_fire_protected 是派生 flag 只读
- [手持光源的灯(运行时灯那一层 · 跟随灯 · 灯位在 M-world 身体外侧 · 闪烁信号与推送限速)](runtime/mechanisms/held-prop-lights.md) — 挂件自带灯与配了 follow 的作者灯每帧解出 M-world 灯位,作为运行时灯加在作者灯之外(作者数据一个字节不动),按来源合并(落雷 / 挂件 / 燃烧);灯位只在真 3D 场上解、解不出就不发光;闪烁是一个信号同时驱动灯与火(物理闪烁 / 正弦闪烁两种);灯每推一次整张光照缓存重烘,所以强度变化限速 20 Hz 且必须配抽取滤波;挂件状态机本身见 held-prop-system
- [手持挂件系统(预设即整体 · 离散状态机 · 火势 / 燃料 / 火种 / 玩家按键 · 效果块与等级 · 入档)](runtime/mechanisms/held-prop-system.md) — 手上那件东西是一个整体(贴图 + 粒子挂载 + 可选帧动画火苗 + 自带灯 + 一串离散状态),全登记在挂件预设;动作只切状态名,连续量(燃烧强度、挡风、火势、燃料、闪烁)由系统逐帧派生;风吹灭(火势)、T/Q 按键、火种、耐久、效果块、等级都挂在同一条切状态的路上;"在烧"= 此刻真的有火;进入动作只在真进入时执行;玩法事实入档、表现每个边界重派生;可燃挂件与这一整套互斥、归燃烧系统;灯那一层见 held-prop-lights
- [背包槽上限与 critical 给予](runtime/mechanisms/inventory-capacity-critical.md) — 背包有槽上限,giveItem 返回值必须消费;关键道具用 critical=true 绕上限,拾取失败走 inventory:full 不消耗热点
- [运行时摆灯的可视化手柄(聚光靶点/锥角、面光尺寸/朝向)](runtime/mechanisms/light-authoring-gizmos.md) — 判据只有一条——三维朝向/尺寸必须能拖,标量数字框就够;聚光靶点落行走面(正向求交要粗扫+二分),面光正面判据必须用真视线不能写 n.z<0;面板兜底值要与 packLights 逐字对齐
- [光照参数的空间与单位(世界空间 wu ↔ 伪世界 q)](runtime/mechanisms/lighting-scale-reference.md) — 灯摆在世界空间、单位 wu(与 NPC/热区/spawn 同尺,角色高 150 wu 恒定);shader 里 march 走伪世界 q,两者差一个逐场景的 wuPerQUnit,transform 只在打包处折一次
- [小游戏会话生命周期](runtime/mechanisms/minigame-session-lifecycle.md) — 小游戏统一走 MinigameSessionManagerBase;start 的异常必须 catch→teardownSession,否则一次抛错 brick 整个子系统
- [叙事调试器桥与断点闸](runtime/mechanisms/narrative-debugger-bridge.md) — 断点闸把叙事队列停住;停住期间"冻的是什么"和"谁能放行"各有一条会静默死锁的坑
- [信号驱动 5 层编排脊椎](runtime/mechanisms/narrative-signal-spine.md) — 世界→对话(只演+打信号)→scenario子图→主线里程碑图→quest镜像+一个玩家意图槽;主线叙事图是唯一进度真相源
- [物件检视场景(物理单位制 + 伪形体)](runtime/mechanisms/object-examine-scene.md) — 一张静帧撑起的可看场景;长度类参数一律真实单位并由实例声明物理标尺,alpha 只给边界、形体要另烘高度场
- [可选资源存在性探测(content-type 判据)](runtime/mechanisms/optional-asset-probe.md) — 本仓库 dev server 上文件不存在不是 404 而是 200+HTML;可选 sidecar 一律走 loadOptionalJson,判据看 content-type 不看状态码
- [叠图动作 id=句柄、image 才是图引用](runtime/mechanisms/overlay-image-handle-semantics.md) — show/blend/hideOverlayImage 的 id 是图层实例句柄;引用 overlay_images.json 的是 image/fromImage/toImage;校验别搞反。文档揭示 2026-09-12 已与这套解耦,不再有句柄
- [parallaxScene 运行时语义](runtime/mechanisms/parallax-scene-runtime.md) — 运行时只播 layers[].keyframes,camera/depth/sourceKeyframes 是编辑器工作态被完全忽略;烘出的帧必须 linear
- [逐处音量(音频引用的对象形态)](runtime/mechanisms/per-site-audio-volume.md) — 每个引用音频 id 的地方都能带 volume;它**替换**素材级音量再乘通道音量;判等/合并/快照一律走 audioCue 助手,别 `ref.id`、别 `a === b`
- [Pixi v8 静默陷阱](runtime/mechanisms/pixi-v8-traps.md) — 一批"写法看着对、行为静默错"的引擎事实:渲染抛一次异常=整局死透(ticker 再不排帧)、没写 #version 300 es 的源按 GLSL ES 1.00 编、clear 不认 target、BindGroup 见死即自毁、滤镜容器里 screen 是临时 RT 局部坐标、解码期预乘吃掉 alpha 数据、leading 裁末行、Container 无 hitArea 恒不命中
- [位面系统(PlaneReconciler)](runtime/mechanisms/plane-system.md) — 位面=全局一等资产(normal 也是位面),实体归属位面;PlaneReconciler 从叙事状态派生一切、每个边界重派生、零自持久化
- [私有叙事信号(按 owner 定向投递)](runtime/mechanisms/private-narrative-signal.md) — signals 登记表标 scope:private 的信号只投递给发射方 owner 拥有的 wrapper 图;让 N 个同类实体共用一个信号名和一张发射端对话图
- [运行时持久化(存档/玩家设置)落文件,不落浏览器存储](runtime/mechanisms/runtime-persistence.md) — 存档与玩家偏好一律经 PersistentStore 落本地文件;三后端 Tauri>dev server>内存;localStorage 只剩一次性迁移读取;内存降级必须让 UI 说实话
- [存读档硬契约](runtime/mechanisms/save-restore-contracts.md) — load 坏档先拒+快照回滚、save 返 Promise<boolean>(落盘是文件 I/O);查询走内存镜像保持同步;读档静默清 zone、清位面 manual override;新游戏=净化 URL 整页 reload
- [scenarios.json 运行时消费语义(退役中)](runtime/mechanisms/scenario-catalog-semantics.md) — 一等公民 scenario 已数据侧退役、零数据喂养;新内容一律走 narrative scenario_* 子图,别把活儿写进 Scenarios 面板
- [场景声学（实时回音 + 有位置的声源）](runtime/mechanisms/scene-acoustics.md) — 声学空间→IR→ConvolverNode 的实时回音；几何一律 M-world wu + 全局距离缩放；每条空间音 = 直达 + 早期反射 + 晚期尾，走与 Howler 并行的空间音总线；作者面只有声学工作台，游戏是预览器（dev server 双槽实时联动）；三条硬判据（首回晚于干声时长 / 晚期尾延后 / 不套点源 1/r）
- [场景背景受光(原画 + 加性实体灯)](runtime/mechanisms/scene-lighting.md) — 原画就是最终的光照,运行时只把作者摆的实体灯加上去(乘在**烘出来的 albedo 贴图**上);天光与太阳的运行时加光项已删,「夜」靠换一张夜原画;两级 RT 缓存,稳态每帧零光照计算
- [场景 onEnter 揭幕时机契约](runtime/mechanisms/scene-onenter-reveal-timing.md) — loadScene 尾序=scene:ready → 揭幕前闸(限时,遮罩下做完会卡帧的准备) → 揭幕(onReveal) → onEnter;初始进场同样先遮罩后揭幕;主 tick 必须先于任何场景装载挂载
- [场景风(一份空气速度场 · 一个钟 · 阵风 · 各消费者读哪份)](runtime/mechanisms/scene-wind.md) — 场景 JSON 的 wind 是空气的速度场(不是加速度):对数廓线平均风 + 顺流推进的阵风 + 风向摆动 + 共享的无散度涡,唯一实现在 sampleSceneWind(CPU);组装层一份参数一个钟(SceneWindState,世界暂停时不走),粒子 / 挂件 / 草木同读,消费者只乘自己的增益;脚本阵风与 F2 倍率只进运行时那份——燃烧读的是作者那份,所以同一阵风吹得灭火把吹不灭蜡烛;风速是玩法量(火把能不能活),画面观感用 gain 解耦;草木摆动见 background-sway
- [气味系统(双层 action/zone)](runtime/mechanisms/smell-system.md) — action 层永远压过 zone 层;zone 气味声明式挂 ZoneDef.smell,SmellSystem 听 zone:enter 驱动,ZoneSystem 不动
- [播放门、音频解锁与保活(这是桌面游戏,不是网页)](runtime/mechanisms/start-gate-audio-unlock.md) — 浏览器"没点过不出声 / 没焦点就降级"一律禁止——宿主窗口带免手势与不后台降级开关、运行时关 autoSuspend 每秒保活;首启遮罩给 sticky 激活让 init 时直接解锁;没解锁时普通播放排队、有位置的声音直接丢
- [落雷(strikeThreat:结算与表现分离的一记雷)](runtime/mechanisms/strike-threat.md) — 一道雷 = 挑靶收靶(结算,写存档)+ 粒子/雷光/定位雷声/闪白/震屏(表现,同一句发车);装饰补雷只补表现不碰结算与随机流;无靶落点只落在观测到的真实表面上;会话被打断时静默档只结算不演
- [系统音效事件表(横切,挂在音频管理器上)](runtime/mechanisms/system-sfx-event-table.md) — 系统音效统一挂音频管理器的事件映射表、不在各功能自己的 manager 里;判"某功能有没有声音"必须先读那张表,靠 grep 功能模块必漏、必做出双响
- [拆除顺序与世代作废](runtime/mechanisms/teardown-ordering.md) — 拆一局/拆一个场景是强排序不是清单;跨 await 的异步流程靠世代号自杀,不靠"记得取消"
- [UI 组件层(窗体/按钮/滚动区)](runtime/mechanisms/ui-component-layer.md) — 面板不再各自手搭遮罩·标题栏·滚动·按钮,统一走 src/ui/components;重绘用 attach 不用 open、量高前必须摘 mask、行内点击必须消费
- [UI 面板皮肤单一入口](runtime/mechanisms/ui-panel-skin.md) — 面板底/边只经 PanelSkin 的 createPanel(有木框)或 drawPanelBase(只有底+细边);拿木框皮肤调 drawPanelBase 会静默丢框;「暗角」实为一层均匀黑纱,暗底配色是连着它一起量的
- [光柱 / 体积光(效果资产里的 beams[] · 美术可控 · 一次求弦 · 不照角色)](runtime/mechanisms/vfx-beams.md) — 粒子效果里与 emitters 并列的 beams[];3D 截面视锥(矩形或正 3–8 边形,不许圆)/ 2D 画面光带两模式;片元一次解析求弦、弦中点采样一次,不步进;亮度乘在显示空间;不照角色、不进光照缓存;整道光柱按落点当一个实体排;没有寿命(只有开关 + 淡入淡出),所以一次性效果带光柱永远不自收;形状判据一份契约 JSON 三方共用;制作人砍掉的一长串 VLB 功能别加回来
- [薄片(纸钱)与粒子区域(平板气动 · 接触 · 发射区域 / 范围区域软边界 · 补回)](runtime/mechanisms/vfx-plates-and-areas.md) — 挂 plate 模块的发射器每颗是一张会翻会弯的薄片(准定常平板气动 + 库仑接触 + 睡眠,无可调系数,尺寸与位移按脚点透视系数折);发射区域(实例 area,纸铺在哪 / 从哪补回)与范围区域(confine.area,关在哪)分开配,都按"粒子正下方地面点"判、烘成权重网格做软边界,没有推回力;补回只由生命周期控制器选点、挑不到不许回收;可燃纸钱绑可燃物模板,见 burn-system
- [粒子渲染(lit / tone / unlit 三条着色路 · 按水平纵深分桶 · 首帧不卡的三件事)](runtime/mechanisms/vfx-rendering.md) — 粒子一批一张网格、按"水平视线纵深"在实体之间分桶;着色逐视图三选一(有载荷 lit / 要受光没载荷 tone / lit:false),lit 原样拼接角色那段实体灯循环、吃场景同一次 packLights,受光倍率来自场景 lightFactors.particles(天气压暗 envDim 自动跟);只有漫反射,水/尘靠 emissive 或 lit:false;所有粒子 GL 程序开局后台编、揭幕前闸里等编完并跑完预热——任何一帧可见画面不许同步编 shader / 补跑预热
- [世界空间粒子 / 群体系统(效果资产 · 布置 · 实例生命周期 · 确定性模拟)](runtime/mechanisms/vfx-system.md) — 一套粒子系统,群体只是挂了行为模块的发射器;模拟只在 M-world/wu、定步长、带种子逐位可复现;三件正交的东西(全局效果资产 / 按场景×时段外观分份的布置库 / 运行时刺激场),效果与布置唯一写者是粒子工作台;表演态不入档;平面近似下几何判据全空成立、载荷到了靠自愈整场重建;墙是薄壳;发射器行为由 simulation 显式选择(旧资产按固定映射解释);临时实例的种子、一次性实例的收尸、自愈重建会散掉临时实例是三个常踩的坑。着色/分桶/首帧代价见 vfx-rendering,光柱见 vfx-beams,薄片与区域见 vfx-plates-and-areas
- [世界暂停与游戏时钟](runtime/mechanisms/world-pause-and-game-clock.md) — 开面板/菜单=冻结整个游戏；演出时间一律吃 GameClock 而非 setTimeout，暂停期间原地不动
- [zone 生命周期与上下文契约](runtime/mechanisms/zone-lifecycle-contracts.md) — 触发载体两路(进出即触发 / 按键才触发);zone 上下文按参数线程化(executeBatchInZoneContext),禁回退全局栈;位面重注册仅 Exploring

### 配方
- [无头画面/逻辑全自动验证](runtime/recipes/headless-visual-verification.md) — 隐藏页 rAF 完全暂停——dev模式+命令通道+rAF pump/forceFrame 出帧截图;含 MessageChannel 让步与合成钟追平配方
- [运行时命令通道(脚本化驱动游戏)](runtime/recipes/runtime-command-channel.md) — HTTP 命令队列驱动 DEV 游戏+读快照断言;测试/操作游戏一律走它,不用 computer-use/点像素

### 决策记录
- [人物档案解锁只走一个动作](runtime/decisions/2026-06-30-archive-unlock-single-action.md) — 人物档案解锁唯一通道=addArchiveEntry;名字匹配、条件自动解锁、unlockConditions 字段全部删除
- [对话立绘构图定稿](runtime/decisions/2026-07-07-dialogue-portrait-composition.md) — VN 式半身像(360px,以代码为准)压面板前景、底边伸出画面外、暗幕 opt-in;大立绘/默认压暗/垫面板后/底部渐隐均被否
- [曝光逐场景独立调,不做全局对齐](runtime/decisions/2026-08-21-per-scene-exposure.md) — display（ev/tonemap/对比/饱和/lift）留在场景 JSON 里逐场景调;不把 albedo 标定接进背景、不提全局曝光层——精度不是这个项目要的东西
- [光影一律物理推导,不许拟合](runtime/decisions/2026-08-23-physical-derivation-over-fitting.md) — 渲染量要能积出来/推出来;拟合与启发式一律不收,中间量也不许借用物理量的名字
- [位面基建 v3 模型拍板](runtime/decisions/2026-07-05-plane-v3-model.md) — 位面=全局一等资产+实体归属+叙事只点名+对账器重派生;v1(绑任务图)/v2(实体变体表)/接管式小游戏均被否
- [scenarios.json 一等公民系统退役](runtime/decisions/2026-07-15-scenario-firstclass-retirement.md) — 2026-07-13 拍板退役一等公民 scenario 系统;stage-1 数据侧已落地(scenarios.json 清空、码头两线迁 narrative),stage-2 代码删除待做(届时 6→4 条件叶为 approval①)
- [场景光照路线定稿(三代沿革:辐射还原 → 统一光影 → 原画 + 加性灯)](runtime/decisions/2026-07-21-scene-radiance-restoration-pipeline.md) — 【2026-08-30 现行】原画就是最终的光照,运行时只加实体灯,夜靠换夜原画;前两代(离线绝对辐射还原 / 整体运行时重打光)均已被否,理由与仍然继承的几条都在本卡
- [UI 面板美学方向定稿](runtime/decisions/2026-07-05-ui-panel-skin-direction.md) — 民俗草根·做旧木框——纸纹底+厚木条外框+内侧暗金细线;标题界面是海报、不走这套皮

## editor-tools

### 规范
- [编辑器/策划工具开发规范](editor-tools/norms.md) — PyQt 编辑器改动的不变量(零丢失往返/真实脏态/唯一写盘口/选择器铁律)、布局纪律、验收门与红线

### 机制卡
- [声学工作台(独立桌面应用 · 场景 3D 展开 · 游戏只是预览器)](editor-tools/mechanisms/acoustic-workbench.md) — 回音几何唯一的作者面与唯一写入者;把场景按深度在世界空间展开成 3D,反射面/听者/声源贴着画里的崖壁摆,Unity 式漫游与 gizmo;抽头与 IR import 运行时同一份打包;经 dev server 双槽实时推给游戏预览、试听在游戏里播且要有出声证据;M-world 是左手系,相机基按左手搭并有投影/对齐两类自证;--selftest 是交互层回归门
- [动作宿主字段登记面](editor-tools/mechanisms/action-host-fields.md) — "哪个 JSON 字段装着动作列表"在工具侧散在十来张手写清单里(校验器调用点 / 嵌入引用 / 信号发射面三表 / flag 与任务引用扫描 / 改名级联…),只有信号发射面三表互相对账;新宿主漏登哪张,那张背后的检查就对它整片缺席且零报错
- [_PARAM_SCHEMAS 是控件清单不是必填集](editor-tools/mechanisms/action-param-schemas-vs-required.md) — action 参数清单三处镜像语义各不同;required/optional 的唯一权威是 actionParamManifest.ts,编辑器侧的 schema 只决定建哪些控件
- [转盘氛围脚本编辑器](editor-tools/mechanisms/atmosphere-script-editor.md) — 递归指令列表编辑器(RPGMaker-event 式,非 DSL/树);复用 ActionEditor 的范式不复用控件;to_list 输出必须与独立轻量运行时逐字段一致
- [音频加工台与 audio_config 的写入面](editor-tools/mechanisms/audio-workbench-config-write.md) — 唯一一个非主编辑器却会写游戏音频配置的工具(那份 JSON 双进程共写);加工指纹只是缓存键、成品字节哈希才是身份,状态一律由磁盘反算
- [呼吸工作台(独立桌面应用 · 只改呼吸图的表演参数 · 页内跑同一份模拟 / 着色 / 呼吸声 · 对话图那段原样演 · 出片 · 资产唯一写入者)](editor-tools/mechanisms/breathing-workbench.md) — 呼吸图资产 assets/data/breathing/<id>.json 唯一的作者面与写入者,只许改 params 与 label(size / layers / fields / rig 是离线拆层产物,保存时逐值比对、改了拒存);页内预览打包运行时 BreathingPerformance / breathingParams / breathingOverlays / breathingUniforms / breathSynth 本体、着色拼 breathingShade.glsl,页面里没有第二份模拟;「用在哪」从对话图抽出用到这张图的那一段线性时间轴原样演(渐弱等停住、猛吸、收掉);图 + 按钮 + 曲线钉在顶上、参数在下面滚;参数文本可复制 / 套用;推给游戏(拖参数时跑着的游戏里跟着变)/ 导出到游戏(写盘)命名照定案;出片用同一份代码逐帧读回 → 循环 GIF + 接触表 / 剧情 MP4
- [燃烧工作台(独立桌面应用 · 只编可燃物模板、和场景无关 · 页内跑同一份燃烧模拟与着色 · 模板唯一写入者)](editor-tools/mechanisms/burn-workbench.md) — 可燃物模板（burnables/<id>.json：图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光）唯一的作者面与写入者，没有"先选场景"；原画视图是主视图（按真实尺寸在平面空间摆一个实例预览，火线速度就是准的）；「用在哪」只读列出所有宿主，点场景实体开只读场景视图（各实体按自己的 transform 摆、同一个模拟、左右点火站位与能不能站）；改名一次事务跟着改所有宿主上的 template 值（只动那几个值的字节、确认后被改过就拒绝、失败回滚），删除有引用就拒绝；页内预览打包运行时 burnSim / burnGeometry / burnAim / igniteStance / burnShadeParams 本体、着色拼 burnShade.glsl；推给游戏走联动协议 v2
- [画布手势期间的布局与命中区纪律](editor-tools/mechanisms/canvas-gesture-safety.md) — 鼠标事件里改布局 = 必现崩溃(队列连接不是解药,要带 context 的单发定时器);屏幕像素定尺的命中区一律留在成员包围盒之外,护栏要断净空余量而不是"没被罩住"
- [关闭路径的 Discard 中和与 flush 门控](editor-tools/mechanisms/close-path-flush-discard.md) — 主窗口关闭 = 逐页 confirm_close → 统一 flush_to_model;Discard 必须把 UI 回滚到模型值,flush 必须门控真实变更,否则被放弃的编辑复活或零编辑伪脏
- [图对话编辑器](editor-tools/mechanisms/dialogue-graph-editor.md) — 独立包内嵌主编辑器的图对话编辑;分层架构 + 表单形状保真回写 + 语义零变化时原样字节回写;往返探针是改 inspector 的必跑门
- [画布/表单编辑器数据零丢失范式](editor-tools/mechanisms/editor-data-sync-paradigm.md) — 单一真相源 + 即时入脏 + commit-on-leave + 懒回写按身份;门控只认 pending 信号的路径(deselect/新增/点空白)是静默丢编辑的惯性破口
- [信号发射源权威口径(emitted_signal_ids)](editor-tools/mechanisms/emitted-signal-catalog.md) — 哪些容器算"实发信号":对话图+内容资产动作树+叙事图 onEnter/onExitActions+broadcastOnEnter 派生,外加配置里写信号名、系统代发的面(血量威胁 / 可燃宿主);blackbox meta.emits 只是声明不算实发;悬垂监听/空声明全 warning
- [json_lang「JSON=语言」工具链(schema 索引器 + LSP)](editor-tools/mechanisms/json-lang-schema-tooling.md) — 把数据 JSON 当语言:运行时=解释器、编辑器=IDE、JSON=源码;从权威代码现场重算 schema 供 IDE/LSP 补全与查错;方向永远代码→schema,out/ 不入库,只咨询不裁决
- [主窗口编辑器接入钩子(鸭子协议)](editor-tools/mechanisms/mainwindow-editor-hooks.md) — 主窗门控靠 getattr 鸭子协议调 flush_to_model/confirm_close/reload_refs_from_model/commit_pending_on_leave/editor_undo——缺钩子不报错、静默漏网,签名跑偏同样静默,接入时必须逐项对齐
- [叙事状态机编辑器(PySide 壳 + React Flow)](editor-tools/mechanisms/narrative-state-editor.md) — 唯一非原生 PyQt 编辑器;三方校验中 Python 兜底必须是 TS 权威的子集、两步保存、dist 是独立产物(重建≠页面刷新)、落盘字节级幂等
- [叙事状态机模板系统](editor-tools/mechanisms/narrative-template-system.md) — 填 taskId 一键派生任务;模板文件编辑器专用运行时永不加载、{{taskId}}__ 信号构造性防撞名、盖章产物全有全无暂存;抽取是整树子串替换故误伤检测必须三层、批量盖章 plan/apply 必须对账现实
- [数值往返保真(preserve_numeric_repr)](editor-tools/mechanisms/numeric-roundtrip-fidelity.md) — Qt 数值控件会把"打开即保存"变成 int→float 漂移/clamp 丢值/默认 0 盖掉运行时默认——未改动的数值键必须按原始表示回写
- [位面编辑器槽继承 UI 语义](editor-tools/mechanisms/plane-editor-slot-inheritance.md) — dict 槽用"显式配置此槽"闸门——不勾=不写键(继承)、勾且空 {} 是合法的整槽覆盖原语;解析口径与运行时 expandExtends 靠 parity 测试锁定
- [save_all 两阶段写与脏桶护栏](editor-tools/mechanisms/save-all-dirty-buckets.md) — 唯一写盘出口:先落 .tmp 再统一就位,stage 失败磁盘零变化、commit 失败按基线回滚、外部竞态 preservation-first;mark_dirty 只认登记键,新数据域的同步点不止三处;重读磁盘会刷掉外部改动基线
- [场景画布的图元 part 表与内容层 z](editor-tools/mechanisms/scene-canvas-item-parts-and-z.md) — 一个实体在画布上是一束图元,清单唯一真相是 PART_TABLE;新建/重建的图元默认可见必须重贴 presence;内容层 z 按运行时排序规则的 Python 镜像实时派名次,不是写死层表
- [新场景画布(Document–View–Command)](editor-tools/mechanisms/scene-canvas-v2-document-view-command.md) — 新画布只有一条写入路——工具构造命令、Document 唯一裁决写哪份、命令自己发变更事件;没有 staging 第二层真相,所以"写错副本/撤销撤一半/点一下变脏"没有发生的余地
- [场景编辑器的三条视图轴(过场 / 位面 / 时段)](editor-tools/mechanisms/scene-view-filter-axes.md) — 过场轴决定实体存不存在,位面与时段轴决定已加载实体显不显;后两条必须合成一个判定再落显隐,分开各贴各的会互相冲掉
- [共享选择器控件的保值契约](editor-tools/mechanisms/shared-widget-value-fidelity.md) — IdRefSelector 等共享控件被约 40 处调用点依赖——未知/悬垂值必须保值展示而非静默顶替或清空,候选去重不得让一部分数据在 UI 上不可达,严格选择器的候选面必须等于校验器同上下文的放行面(逐个宿主面核);一处控件破坏 = 全编辑器数据面污染
- [草木工作台(抠植被 · 标刚体 · 推给游戏 / 导出到游戏)](editor-tools/mechanisms/sway-workbench.md) — 背景草木拆层的作者面:自动分割打底 + 手涂四层(补植被 / 加刚体 / 减刚体 / 锁死)+ 锚点 / 整体摆 → sway_paint.png 与 sway_overrides.json 是烘焙的输入;推给游戏 = 页面此刻那份(存没存都算)烘进 local/ 预览、游戏原地换上、资源不动,导出到游戏 = 先存盘再烘进资源;烘焙只有 sway_field 一份,进程内按内容哈希缓存让推送约 1 秒;涂层是手工劳动,三道数据安全闸不许绕过;"✔ 已换上"要等游戏心跳确认
- [地形工作台(碰撞 · 可走区 · 行走面修补 · 推给游戏 / 导出到游戏)](editor-tools/mechanisms/terrain-workbench.md) — 碰撞 / 可走区 / 行走面的唯一作者面:烘焙器只留自动结果(collision_auto.png),作者层(多边形 / 笔刷 / 高度增量)住 runtime/scenes/<id>/terrain/,唯一合成器 terrain_compose 把两者合成 collision.png + collision.json 旁挂 + 各时段 ground_d.png;推给游戏 = 页面此刻那份合成进 local/ 预览、游戏原地换上、资源不动,导出到游戏 = 先存盘再合成进资源;运行时对齐靠游戏用自己的 isCollision 答探测;文档一律网格单位(没乘 wu/q 的 M-world)
- [过场步骤编辑器(TimelineEditor)契约](editor-tools/mechanisms/timeline-editor-contracts.md) — UI/交互改动不得改 StepWidget.to_dict 序列化输出;已有搜索/撤销/剪贴板等能力勿重复造;含一个 PySide takeAt 布局级深坑
- [轨迹工作台(独立桌面应用 · 画面/世界两种空间 · 烘成独立资产)](editor-tools/mechanisms/trajectory-workbench.md) — 轨迹资产唯一的作者面与唯一写入者;曲线没有锚点(播放位置在播放时给),只有一种曲线两种配置(场景曲线绑作者场景 / 相对曲线不绑),命名插槽是曲线暴露给场景的站位;加载任一场景(可把 q 空间还原成 3D 伪世界)拉线/抛体,保存=烘一次再原子写盘(保存即迁移老锚点资产);世界空间物理与地面高度场+深度壳碰撞、控制点是 {x,z,h};投影与运行时同一份金标;桌面壳零浏览器缓存
- [粒子工作台(独立桌面应用 · 页内跑同一份运行时模拟 · 效果资产与布置库唯一写入者)](editor-tools/mechanisms/vfx-workbench.md) — 效果资产与布置库(场景 × 时段外观)唯一的作者面与写入者;页内跑的是打包进来的运行时 vfxSim 本体、喂的输入与游戏同形;相机与 gizmo 经 /vendor 原样复用轨迹台那两份;保存与推给游戏都只带"真改了的那几份"(scoped),盘上被外部改过拒写;效果改名 / 删除查全部外部引用(挂件预设、playVfx / playPropVfx、可燃物模板);光柱在这里摆(原画视图真预览);燃烧用的外部给点与可燃模板在这里配;雷的长相是雷电样式库(参数化、可换样式,生成物按哈希分目录),在这里改、预览、生成并套用;主编辑器只显示;桌面壳零缓存
- [控件丢弃：摘 parent 之前必须先 hide](editor-tools/mechanisms/widget-teardown-orphan-window.md) — 对可见控件直接 setParent(None) 会让它变成一个真顶层窗口并被 Qt 显示出来（屏幕中央光速开关的小窗）；销毁走 discard_widget/discard_layout_widgets，重新安家走 detach_widget 且必须同回合安家

### 配方
- [看原画修碰撞(圈可走 · 自动封外面 · 摆人复查 · 局部迭代)](editor-tools/recipes/collision-from-art.md) — 碰撞按原画在 3D 里判"脚点下面的地能不能站",不依赖深度(有的图深度是错的);物体按占地圈(前沿接地线、后沿用顶面下移物体高估),物体后面被挡住的地按连续性估;圈可走集、其余自动封死、集内障碍另圈阻挡;每次只改错的那一块(不重烘不重画);check 管落点 / 连通 / 交互 / 触发区 / 孤岛,摆人图管"站没站错",再交独立子代理摆人复查;摆在屋顶上的 NPC / 热点 / 触发区是旧布局遗留,挪到它脚下的地上
- [改编辑器后的验证门](editor-tools/recipes/editor-change-verification-gate.md) — 三件套(全树测试+素材审计+validate-data)+ 挂死 / worker 被打死分流 + 测试环境硬规矩 + 已知盲区对策(布局塌陷三形、入口三件) + "输出字节不变"强验收;双树对照用 worktree 不用 stash,跨机绿灯必须在验收机重放
- [对活着的编辑器进程取证](editor-tools/recipes/live-editor-forensics.md) — 编辑器"某页白/黑/卡/打不开"而离屏复现全绿时,故障只存在于那个跑了几小时的进程里——去问它(活栈/页面报错/渲染子进程/CPU 增量/窗口像素),别再复现;数据整块消失先查旧代码孤儿进程

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
- [实体迁移/改名/删除走重构引擎(勿手搓引用网)](content/mechanisms/entity-refactor-engine.md) — 场景实体(npc/hotspot/zone/出生点)的迁移/改名/删除/复制不要手改 JSON 引用网——调 entity_refactor 引擎,引用机械改写+报告+可撤销;裸 id 运行时按当前场景解析、断了静默跳过
- [L2 能力原语登记面](content/mechanisms/l2-action-primitive-registration.md) — 策划模式唯一允许的代码改动;一条可用 Action 要同步多个登记面(完整清单以 runtime 的登记面卡为准,别只做编辑器那一面),含嵌套/异步/可选参数三个已知坑与审批边界
- [文本引用系统([tag:…])](content/mechanisms/text-ref-tag-system.md) — 玩家可见文本统一经 resolveText 解析 [tag:…];存档永远存 raw、JIT 解析;扩展须运行时+编辑器三件套一致;引用目标不存在则整工程存不了

### 配方
- [内容收尾双校验门(命令与盲点)](content/recipes/content-validation-gate.md) — 每次改完内容 JSON 必跑的两条命令(素材审计 + validate-data)、退出码语义、以及校验抓不到要自己当心的盲点
- [配一个信号驱动拍子(动哪5处)](content/recipes/wire-demo-beat.md) — 给寻狗 demo 接一拍主线/支线内容,最少动 5 处(场景/对话图/叙事子图/主图/引用素材);含 scenarios.json 撞名坑与各层纪律

### 决策记录
- [阿秀信号冷框架(非温情守护)](content/decisions/2026-06-27-axiu-signal-cold-framing.md) — 香粉味+跑调小调=阿秀死时盲目"不撒手"念气,只认物(帕子包)不认人;无单一确立beat;全部温情守护旧稿作废
- [背尸第一单重排(义庄拦活取代工头派活)](content/decisions/2026-07-12-beishi-first-job-yizhuang-reorchestration.md)〔superseded〕 — 第一单(路倒)=自由空挡→打哈欠找活→义庄门口被拦接活→自己找尸→背回;工头改为路倒交付后专职派淹尸单;取代旧"工头顺序派两尸"编排
- [开场背尸重设计(日常铺垫反衬诡异)](content/decisions/2026-06-22-beishi-mundane-eerie-redesign.md)〔superseded〕 — 开场背尸=先做混子糊口零活(零工背尸_done 闸门)铺日常基线,再让背阿秀逐拍崩坏;三个演出增量被否勿复活
- [神仙顶写实冰川设定与"写实中透异常"原则](content/decisions/2026-07-04-shenxianding-realistic-glacier.md) — 神仙顶=真实雪山+真实冰川+远看只一点点的裂缝,严禁玄幻发光/血红巨裂口;上位原则:民俗志怪=写实中透异常
- [气味系统设计定位(常驻≠常见)](content/decisions/2026-06-27-smell-system-position.md) — 气味做成常驻可学习的值驱动感官机制;铁律=系统常驻不等于香粉味常见,香粉味仍是阿秀专属的稀有冷读数
- [寻狗 demo 文档权威与死档清单](content/decisions/2026-06-27-xungouji-doc-authority.md) — 故事仓冲突按总纲「正典优先级」裁(制作人当次审批的设定对账 > 游戏总纲 > 其余 Demo制作资料 > 阿秀/故事设计);Demo完整流程只管拍号↔s-id 映射;废弃归档一律死档
- [寻狗记题材调性锚点(五来源合体)](content/decisions/2026-06-25-xungouji-genre-anchor.md) — 寻狗记=45°冒险RPG骨架+民俗志怪血肉的有意合体;五喜好来源共同脊椎=规矩禁忌;09-18 基调中的基调=俗的怪、静的怕(怪按聊斋写);关二狗声口=文才+周星驰

## asset-pipeline

### 规范
- [素材管线规范](asset-pipeline/norms.md) — 素材生产的源一致性、程序驱动 agent 裁判、目视验收义务、许可与格式红线

### 工作法
- [对抗验收拆帧法](asset-pipeline/methods/adversarial-frame-decomposition.md) — 把连续内容分解成帧的通用工作形状——先定验收疆域(重放忠实于源/不引入源外的漂移抖动/接缝干净),再靠对抗验证+智能循环收敛;稳定靠锚不靠固定框;不绑动画
- [对抗验收抠图法](asset-pipeline/methods/adversarial-matting.md) — 把主体从背景分离的通用工作形状——先定验收疆域(无残留/不多扣/主体完整/真空隙保留),再靠对抗验证+智能循环收敛;手法只作可选提示,不绑动画
- [烤入背景人物活化工作法](asset-pipeline/methods/baked-figure-activation.md) — 把画在场景原画里的人物做成会动实体:原画底+局部擦人+overlay 呼吸;逐人棋盘格+场内 zoom 双验收
- [角色动画生产工作法](asset-pipeline/methods/character-animation-production.md) — 从"要一个会动的角色"到入库验收的全程形状:正侧面源确认→批次准备(人批)→整批生成→统一验收→程序产出→预览验收;重生只认 clip/非正侧面/画风整体漂移三因且须人批

### 机制卡
- [统一动画资源工作台(tools/anim_preview)](asset-pipeline/mechanisms/anim-preview-tool.md) — 人工审查驱动的 A→H 版本图、R 多动作实时装配、Agent 结构化接口和游戏真实渲染终验
- [动画/静态阶段适配器与旧一键产线(tools/animation_pipeline)](asset-pipeline/mechanisms/animation-pipeline.md) — 工作台 E/F/G/R/H/H_STATIC 的无覆盖确定性适配器；旧 build_character 产线保留兼容但不定义新人工 R 语义
- [对话立绘管线](asset-pipeline/mechanisms/dialogue-portrait-pipeline.md) — 立绘素材生产契约:多表情大图与单姿态立绘集两条合法路径、模型直出必须去角标、flood-fill 灰底结构上无镂空、dehalo 已内建、产物 gitignored 改前必备份
- [抠图路线与判读铁律](asset-pipeline/mechanisms/matting-toolbox.md) — 仓库四条抠图路线的入口与适用域;halo 根因=无 despill;量化指标不可单独裁决(halo 误报白发、多扣须源级测)
- [场景烘焙产物的下游契约(深度/碰撞)](asset-pipeline/mechanisms/scene-bake-downstream.md) — 导出 depthConfig 等于第一次给场景装墙——必跑 audit-walkable;出生点落墙=玩家冻结,NPC 落墙多为有意;废字段下线要扫三类静默下游
- [场景背景重打光工作台](asset-pipeline/mechanisms/scene-relight-tool.md) — 把白天原画确定性地重打光成时段/天气变体背景图的离线工作台;它只读几何烘焙产物、不自己烘;每张时段原画都要各烘一套角色照明载荷
- [动画产物契约(atlas.png + anim.json + normal.png)](asset-pipeline/mechanisms/sprite-atlas-anim-contract.md) — 一切动画素材的产出格式硬契约:0基帧、一角色一图集均匀网格、底中脚锚、每边≤2048、离线法线图、animFile 存完整 URL、人工字段并回
- [单帧静态动画包(一张图 → 能当 NPC 用)](asset-pipeline/mechanisms/static-single-frame-bundle.md) — 一张透明 PNG 打成 1 格图集 + 单 idle state 的动画包；紧裁使格底=脚、worldHeight=角色本体身高；占位标记与身高标定是换正式包不跳尺寸的唯一凭据

### 配方
- [环境动效素材配方(热气/灯光/窗帘/呼吸人物)](asset-pipeline/recipes/ambient-fx-production.md) — LibTV 出黑底/洋红底静图→fx_build.py 程序化循环→网格图集→装饰 NPC 放置(renderRaw/不可交互/脚锚)
- [纯色底色键抠图配方](asset-pipeline/recipes/colorkey-matting.md) — 洋红/纯色底出图→无 halo 抠图:逐图测键色、YCbCr 色度距离、un-mix、despill、补洞铁坑、三底质检
- [fal 生成配方(示意图/插画、多向动画帧、音效)](asset-pipeline/recipes/fal-generation.md) — 本项目走 fal 出图/出视频/出音效的实测口径——gpt-image-2.5 出示意图与转面、角色新图的参照喂法;多向动画"图出静帧、视频出动作",整张直出帧表不成立;音效用 seed-audio-1.0(长得像 TTS 但不是),先量起爆点再入库
- [LibTV 出图项目配方(模型选型与坑)](asset-pipeline/recipes/libtv-image-generation.md) — 本项目用 LibTV CLI 出素材的实测配方:禁生成透明底(灰底优先/洋红可)、干净 cwd 铁律、三模型选型、悠船 V8.1 三连坑、prompt 换底写法
- [过场视差分层素材装配配方](asset-pipeline/recipes/parallax-layer-assembly.md) — LibTV 分层图→归一 1672×941→zIndex 层序→装配 parallax_scenes.json;方图先裁 16:9 带再缩
- [音效外采与入库配方](asset-pipeline/recipes/sfx-external-sourcing.md) — OpenGameArt/BigSoundBank/Freesound 三渠道下载法 + 许可署名义务 + ogg 必转码 + 入库三件套;生成音效的新批次目录/只换 src/先剪前摇再做响度
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

### 机制卡
- [agent 存放面地图(知识真源 vs 客户端壳)](meta/mechanisms/agent-surface-map.md) — 各 AI 客户端目录都是曝光/执行壳而非存放面;只有 agent-docs-cli 薄壳自动维护,其余镜像靠人工、已经漂了
- [原子写在 Windows 上不原子(就位类调用必须退避重试)](meta/mechanisms/atomic-write-windows.md) — 「写 .tmp 再 os.replace 就位」在 Windows 上是概率性失败的;全仓就位点统一走 tools/atomic_io(实现只许有一处)，只吃三个瞬时 errno、绝不重试 EEXIST
- [桌面窗口一律禁缓存(Qt WebEngine 壳 / 游戏预览 Chromium / 发行版 WebView2)](meta/mechanisms/desktop-window-no-cache.md) — 制作人 2026-09-08 定死——借 web 技术做的游戏不是网页,任何桌面窗口不留任何缓存(HTTP / V8 code / GPU shader / Qt pipeline);Qt 壳只走一个口径入口,Chromium 开关必须在 WebEngine 初始化前设,清缓存是异步的、边清边载会吊死
- [挑项目 Python 的入口](meta/mechanisms/project-interpreter-entrypoint.md) — 凡"自己挑 Python 解释器"的入口都各写过一份候选表、各漏各的;shell 侧唯一实现源是 scripts/py.sh,Node 侧还没有那一份;挑错的后果是整批静默空转,不报错

### 配方
- [异地/新机 DVC 资源还原(勿用裸 dvc pull)](meta/recipes/dvc-oss-restore.md) — 大文件还原/推送钦定路径 = tools.dev pull / push(内部走 sync-dvc-cache.py);裸 dvc pull 在慢速直连下必挂、裸 dvc push 对 OSS 必失败,都不是网络问题
- [多会话共用主工作树 / 另开 worktree 的操作口径](meta/recipes/shared-tree-and-worktrees.md) — 主工作树常年有多个会话并行改且堆着别人未提交的改动——莫名的失败先当别人的、禁 git stash、add -A 前先认真实基线;另开 worktree 要补 venv 与 DVC junction、dev server 在 worktree 里看不见改动
- [Windows 上的开发入口与从零重建环境](meta/recipes/windows-dev-environment.md) — Windows 上 dev.sh/bootstrap.sh 起不来,任务一律走 venv python -m tools.dev;重建环境的运行时全在 DVC 的 vendor_archives 里(py3.11 必须、pip 要 PYTHONUTF8=1、node 解到 .tools/node)
