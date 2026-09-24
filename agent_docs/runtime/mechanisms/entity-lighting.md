---
id: entity-lighting
title: 场景光环境 / 实体阴影 / 深度遮挡
domain: runtime
type: mechanism
summary: 行走面深度场是遮挡·阴影·碰撞的唯一脚点锚(没场就整体关,不回落拟合直线);阴影一律 planar 剪影但形状量从灯位现算;角色阴影**手动绑灯,禁止自动 resolve**;接触斑与灯无关;深度自比较必须留容差;色调与阴影解耦
status: active
authority:
  - src/rendering/EntityShadow.ts#PlanarEntityShadow
  - src/rendering/EntityLightingFilter.ts
  - src/rendering/DepthOcclusionFilter.ts
  - src/rendering/lightEnv.ts
  - src/rendering/lightEnvCurve.ts
  - src/core/SceneDepthSystem.ts#setGroundDepthField
  - src/core/Game.ts#createShadowImpl
  - src/rendering/entityShadowBinding.ts
  - src/rendering/entityShadowFlags.ts
  - src/rendering/footprintExtent.ts
  - src/rendering/contactAo.ts
  - src/rendering/contactAoSources.ts
  - src/rendering/lighting/probeCpuSampler.ts
  - tools/editor/editors/contact_ao_ui.py
triggers:
  paths: ["src/rendering/*Shadow*", "src/rendering/entityShadowBinding.ts", "src/rendering/footprintExtent.ts", "src/rendering/contactAo.ts", "src/rendering/contactAoSources.ts", "src/rendering/lighting/probeCpuSampler.ts", "tools/editor/editors/contact_ao_ui.py", "tools/editor/shared/contact_ao.py", "src/rendering/lightEnv*", "src/rendering/EntityLightingFilter.ts", "src/rendering/DepthOcclusionFilter.ts", "src/core/SceneDepthSystem.ts"]
  topics: [光照, 阴影, AO, lightEnv, 色调, 遮挡, 行走面深度, ground_d, 阴影绑定, 虚拟灯]
last_governed: 2026-09-23
---

## 是什么(一句话)

场景侧的实体受光表现:投影阴影 + 场景色调融入 / AO + 深度遮挡(角色被场景前景挡住);
角色本体的逐像素受光是另一套,见 [character-lighting](character-lighting.md);
背景本身怎么被灯照亮见 [scene-lighting](scene-lighting.md)。本卡这一套(lightEnv 色调 / AO /
planar 阴影 / 深度遮挡)与它们并存,2026-08-30 的「原画 + 加性灯」改动没有动它。
总开关 `game_config.json` 的 `entityLighting.enabled`。

## 权威源(读代码从哪进)

阴影工厂 `Game.createShadowImpl` → `EntityShadow.ts`;滤镜两支(遮挡 / 光照)共用
`EntityLightingFilter.ts` 顶部的 `IEntityShadingFilter` 驱动接口;光环境解析与位置驱动曲线
在 `lightEnv*.ts`;地面/深度上下文在 `SceneDepthSystem.ts`。

## 硬契约(违反即 bug)

- **行走面深度场(`lighting/ground_d.png`)是脚点的唯一来源**,遮挡 / 阴影落地面 /
  `isCollision` 反投影三处并列适用。传 null = 本场景没烘 → **三者一律关闭**,
  绝不悄悄退回旧的 `floor_depth_A/B` 拟合直线(多层街巷可偏出 200+ 行地面,
  站在可见地面上的站位整块被吞)。
- **遮挡与着色是两个代理,禁止合并**:遮挡用脚深度处的代理体、着色用直立 quad;
  合成一个必回上半身 pop-through。
- 阴影实现**一律 planar 剪影**(角色 mask 剪影 + 剪影上模糊)。`shadowMode` 的
  `real`/`planar` 现已同义(另一条延迟阴影实现已于 2026-08-22 物理删除,别再去找它清理);
  planar 的方位角是**屏幕约定**(影朝 `az+180` 铺地),调参按这个读。
  角色是**一个片**,没有真实几何可投 —— 逐像素与重建面求交会把形状啃烂,这条是用户红线。
  ⚠ 但 **cast 的四边形已不是"把剪影平移一下"的平行四边形**(2026-08-22 起):
  长度吃**地面各向异性**(只取投屏角度、扔掉模长的话,横着倒的影子会恒短一截)、
  点光头端**散开**、迎光截面按方位**压窄**(代替"另画一张侧面剪影")。
  这三个形状量都是**从灯位与场景基现算**的,不新增作者字段、不做逐像素求交,
  所以不撞上面那条红线;把它们当成"没实现"或"应该删掉"重报是错的。
  剪影上的变半径抽样**必须 clamp 在当前帧框内**,越界就是"剪影被整张图集横扫成条纹"的复发路径。
- **深度自比较必须留容差**。凡是拿两张不同来源/不同分辨率的深度做"我被挡住了吗"的判断,
  容差为 0 就是自比较噪声逐像素穿零:两张图的采样栅格对不齐,差值是**有周期的锯齿**,
  于是平地上接近一半的像素被判成"被前景遮住",相邻像素还来回翻转 —— 画面上是等周期条纹,
  **零报错、零日志**。踩法很隐蔽:多数场景的容差是有值的,漏配的那批是被遗忘、不是设计,
  所以"别的场景好好的"完全不构成反证。**新场景补齐容差,别去改判据。**
- **角色阴影必须手动绑定光源,系统不自动 resolve**(制作人 2026-08-20 定死)。
  数据面 `EntityShadowBinding[]`:`'light:<灯id>'` 绑场景灯 / `'virtual'` 虚拟灯
  (只影响影子**不照亮**角色) / `'none'` 不投影;挂在 `NpcDef.shadowBindings`、
  `HotspotDef.shadowBindings`、`SceneData.playerShadowBindings`,
  运行时由 `setEntityShadow` Action 覆盖(**不入存档,切场景即清**,它是演出态)。
  解算是**纯函数、逐帧幂等**(`resolveBoundShadow`):没有槽位分配、没有时间低通、
  没有身份匹配。绑到不存在的灯 = 没有影子,**不回落挑最近的一盏**。
  (这条管**投影剪影**。接触 AO 的方向另有「按光照」选项且是缺省,制作人 2026-09-24 定,见下「接触 AO」两条。)
  没配绑定的实体走原来的手调单影(存量数据零变化)。
  · 已删(2026-08-20,勿复活):能流模型 resolver(`resolveShadowLights`/`sampleFluxLum`)、
    按光源身份绑槽 + 时间低通、F2「影子跟灯」旋钮。被否的理由是作者既看不懂也改不动,
    换盏灯就全变,演出上完全没有抓手。
- **接触斑与灯无关**(制作人 2026-09-02 定死):脚底接触斑浓度只认 `env.shadow.contact`
  (场景 / 全局 lightEnv,缺省 0.75,2026-09-24 前是 0.5;实体 `contactAo.darkness` 可覆盖),永远由主 planar 实例常驻画;绑定路径只接管投影剪影,
  extra 槽接触斑恒 0,`ShadowCastSolution` 里**没有** contact 字段。2026-08-22 曾耦合成
  「绑定灯照度份额 × 0.5」,玩家离绑定灯超过射程就整颗消失且无报错,已删勿复活。
  另注:接触斑是乘法压暗,地面显示值越黑反差越小(filmic 暗部脚趾 / 夜原画),
  "看不见"先用像素采样分清"没画"还是"画了看不见"。
- **接触 AO 与投影是两个开关,接触 AO 缺省开**(制作人 2026-09-23 定):NPC 的 `castShadow`
  只管投影(手调单影 + 绑定剪影),接触 AO 只认 `contactAo.enabled`(缺省开、显式 false 才关);
  两个都关才不建阴影实例。判定唯一处 `entityShadowFlags.npcShadowFlags` / `playerShadowFlags`。
  此前 `castShadow:false` 连接触斑一起关,雾津街头送葬队为了不投错方向的影子关了投影,
  站在灯前的亮地上脚下什么都没有、像飘着。热区展示图的 `castShadow` 仍是合并开关(不是角色,没拆)。
- **接触 AO 的作者面**(制作人 2026-09-24 定):「勾接触 AO 就有;明暗、大小能调,参数都要可以调」;
  **方向 AO 缺省也开**(同日改口:「所有 npc 默认都开方向 ao,包括主角」,此前缺省只有简单 AO),显式 false 才关。
  热区展示图(道具)没有作者面,Game 给它们固定 `{directional:false}`(简单 AO),不跟角色的缺省走。
  数据 = NPC `contactAo` / 场景 `playerContactAo`(`ContactAoDef`:
  `enabled` `directional` `dirSource` `darkness` `size` `spread` `dirStrength` `dirLength` `dirConeDeg`)。
  明暗 / 大小不写 = 跟随场景光环境 `shadow.contact` / `contactSize`(光照曲线可按位置变);其余不写 = 缺省
  (`src/rendering/contactAo.ts`,编辑器镜像 `tools/editor/shared/contact_ao.py`,对账测试钉着)。
  解析唯一处 `resolveContactAo`;编辑器控件 `contact_ao_ui.ContactAoEditor`(NPC 表单与场景的玩家那一块共用,
  明暗 / 大小数值框拉到最小 = 「场景值 x」(跟随场景),框里显示此刻跟到的值);校验器 `_npc_contact_ao_issues`
  (类型 + 与运行时钳位同口径的区间)。
- **接触阴影 = 胶囊 AO,在 M-world wu 里算,尺度绝不按帧宽取**(2026-09-24,制作人要"带方向性的 AO,像 3D 胶囊体 AO"):
  角色 = 竖直胶囊:轴在剪影贴地那一截中心、往镜头反方向退一个半径(剪影最低行是脚最靠镜头的前沿);
  半径 = 贴地那一截半宽 × 大小(作者参数 size)(`footprintExtent.footprintOf`:第一次用到某帧时 CPU 读一次帧底像素、
  从**最低的不透明行**往上 `CONTACT_BAND` 取范围、按帧缓存);高 = 帧高换算的世界高。地面片元用行走面深度场
  还原成 M-world(wu,铁律 0)后算两部分:
  ① 无方向 = 竖直圆柱对地面点的余弦加权遮蔽 `(asin(r/x)/π)·h²/(h²+x²)`(推导,贴身体表面归一到 1),
  h 只取身高的「晕开」比例(作者参数 spread)——这一层画在已打好光的画面上分不出环境光与灯光,全高的 1/x 长尾
  会把整片灯光压暗(送葬队离线实测);制作人 2026-09-24 选的是「能调明暗、大小就行」,没做按原画占比拆环境光;
  ② 有方向(「方向 AO」开着才有,缺省开)= 沿"指向光"方向的胶囊锥形软阴影(半影锥角 dirConeDeg),
  沿影子方向在拖尾长度 dirLength 内淡出、乘方向浓度 dirStrength。遮挡在射线上取**两直线最近点 + 正对胶囊
  底/腰/顶三点**,取最大(`capsuleDirOcc`)。只取最近点(原 Quilez 写法)在光近乎平行于胶囊轴时病态:
  只有恰在顶部高度掠过的一窄带拿到半影,仰角 84°~89° 时脚下画出一条宽几 px、长约一个身高的横线(真机);
  光近头顶时半影其实由胶囊顶给。片子覆盖范围按半影宽 0.5·t/k 扩(锥角调大时不在边上切直边)。
  行走面深度场在接触片里**手写双线性**取(与 CPU `sampleGroundField` 同口径):RG16 打包值不能交给硬件插值,
  纹理只能 nearest,直接取的话地面点按约 10 屏幕 px 一级阶梯还原,脚下画出方块硬边(2026-09-24 真机)。
  ⚠ EntityShadow 的几段 shader **没有 `#version 300 es`**,Pixi 按 WebGL1 兼容头编译:texelFetch / textureSize /
  ivec 的 clamp / 位运算 / 数组构造式一律不能用——用了整段编译失败、接触 AO 一点不画,TS 与单测照样全绿
  (同日真机踩过)。纹理尺寸走 uniform、在纹素中心用 texture() 取。`EntityShadow.glslCompat.test.ts` 锁着。
  **只画在地面上**:片元看到的若不是地面(场景深度比行走面深度近,墙/桶/屋顶挡着)就淡掉——从容差开始、
  再近 `CONTACT_GROUND_FEATHER` 才完全不画(一刀切在深度图比原画宽的灯杆旁挖一圈硬边,真机实测锣手脚边被挖),
  判据与 cast 前景遮挡同一个、同一份容差(`setDepthParams` 一并广播)。不判的话身后木桶、墙面、前景瓦面都被压暗。
  参数经真机复验收紧过一轮:近场 0.35 / 软度 0.4 / 拖尾 1.2 那版 13 人叠成一片暗雾、读成"火光被调暗"。
  **方向来源是作者选项 `dirSource`**,缺省 `lighting`(按光照)= **跟角色身上的光一致**(制作人 2026-09-24:
  先是「默认最近的灯,但只是一个选项」,同日定成「ao 方向本来就和间接光强度要一致」):
  间接光一路 + 每盏实体灯一路,**各投各的胶囊软影、按各自照到脚下地面的量加权**(`contactAoSources.ts`)。
  · 间接光那一路 = probe 在胸口的**上半球来光一阶矩**:竖直 = 法线朝上的照度 E(up),水平 = E 从朝上往该方向
    倾斜的变化率(倾斜时半球边界 cos=0、边界项为零,这就是 ∫上半球 L·ω 的水平分量,不假设分布)。E(n) 用的是
    角色间接光那个函数(`probeCpuSampler`,与 `probeE × skyao blend` 逐行同式,**含 A7 折叠**)——probe 缺朝相机侧
    与头顶的信息,间接光与影子缺得一致,就不会"人被照的方向与影子倒的方向对不上"。四面均匀 → 竖直向上 →
    脚下居中一团、没有方向倾向。
  · 灯那几路 = 与角色同一次 `packLights`,逐 kind 与 shader 同式算脚下地面(法线朝上)的照度;shader 里**逐像素
    朝灯位**(站在灯下走过去影子逐像素跟着转)。离得远的灯照度自然小,**不设门槛 / 过渡带 / 回退**。
  · 权重 = 这一路的地面照度 × 与角色着色同一组倍率(间接 / 直接)÷ 总和;片元只算最强 4 路、占比不低于
    `MIN_CONTACT_AO_SOURCE_SHARE`(2%),每路先减去 max(被挤掉那一路, 2% × 总和)(排名交替 / 跨下限时进出的
    那路恰为 0)。不设下限时权重 2e-5 的一路也把接触片撑到它的半影范围:真机 15 人 7.6M 屏幕像素、填充 2.7 ms/帧。
    看不见的实体不算(影子本来就藏)。
  · 角色没走 probe 受光(无载荷 / 只借几何)时它也不吃实体灯,退场景主光——与它那时的色调受光一致。
  踩过的路别再走(同日一条条被真机否掉):**挑最近一盏**——照不到人的远灯被选中(白天全员选一两千 wu 外的
  light_1)、按 d ≤ range 硬截又把真照着人的 lamp_4 剔掉(`range` 是软衰减尺度不是边界)、两盏灯之间 / 进出
  照亮范围方向瞬间翻 120°~170°;**把几路方向加成一个方向**——两盏灯在两侧相加抵消成一团、一强一弱指向谁都
  不是的中间方向,真实是两道影;**探针用全球面一阶矩**——地面反光最亮,探针方向指向地平线以下(雾津街头夜
  97.9% 的点被钳到 25° 下限),胶囊 AO 挡的只是从上方射到地面的光;**探针亮度用、方向另编(竖直 / 主光)**——
  两个量不是同一份数据说的,制作人当场否("最后要出怪事")。方向 AO **不封 80° 顶**(只钳下限 25°):
  灯下 / 均匀天光时方向就在正上方,封顶会让水平朝向过头顶瞬间反向。开关灯 / 切时段 / 拿起火把是当帧切换(事件)。
  `binding` = 跟阴影绑定(绑灯朝灯、虚拟灯朝它,全是 `'none'` 只画①,没配绑定退场景主光;不看 `castShadow`);
  `scene` = 场景光环境主方向(`env.key`)。这两档只有一路、权重 1。
  ⚠ 缺省档是**有意的例外**:投影剪影仍是 2026-08-20 定死的"只认手动绑定、不回落挑最近的一盏";这里只给
  接触 AO 用,浓度上限只认作者的明暗(各路按照度分这份浓度),而且是摆在明面上随时能换的选项。
  解在 `Game.contactAoParams` → `contactAoSources.indirectUpperMoment` / `lightGroundSources` /
  `resolveContactAoSources`,另两档 `entityShadowBinding.resolveBindingLightDir` / `lightDirFromShadowScreenAngle`
  (屏幕约定 → 世界,是投屏的逆,测试钉着)。探针 CPU 查表输入由 `CharacterLightingSystem.indirectProbeData` 给。
  ⚠ 顺带观察(未改,已进 inbox):A7 折叠的理由"朝相机被饿死 13×"在当前烘焙里不成立,45° 俯角下世界正上方
  的查表整个被折成背相机那半球——这是角色受光的事,不在本卡改。
  踩过的路别再走:按**帧宽**缩放的圆斑(37 套图集里宽从脚宽的 0.69 到 3.9 倍,切得紧的被脚整个盖住,
  "开了等于没开");逐片元横向抽样剪影(窄鞋、拐杖被打成竖条纹);直接取帧底那一截(103 套图集里
  29 套有脚离帧底 > 6% 帧高的帧);圆柱内部按 1、轴放在脚尖线上(脚前一块硬边黑盘子)。
  `CONTACT_BAND` 取 12% 帧高:迈步时后脚在画面上更高,6% 只包得住前脚(送葬队 13 人里 6 人实测)。
  读不到像素(资源不是可绘制图像 / 帧旋转)时退回整帧宽并 console.warn 一次(每张图集)。
  **图集装好前的空占位纹理(没有 resource)是过渡态**:不缓存、不出声;同一个源连续约 5 秒拿不到资源才出声
  (每次冷启动都误报过一次)。
  编辑器两个画布的接触阴影预览读 `shared/light_env_visual.contact_preview_axes`(同一组系数,对账测试钉着)。
  ⚠ 茶馆两份场景(`contactSize` 0.12)与梦_夜路曲线(0.1~0.55)的 `contactSize` 是在旧的帧宽模型下调的,
  新模型下它们的含义变了(倍率基准从帧宽换成了帧高 + 实际脚宽),数值没动,等制作人看过再定。
- **色调独立于阴影**:`toneEnabled` 与 `shadowMode` 解耦,`off` 不连带关色调。
- **`lightEnvCurve` 必须原地写回 `currentLightEnv`**:阴影实例与 shadowField 持引用逐帧读,
  换对象引用会静默失联。

## 已知坑

- F2 滑块必须 `noRefresh` + 就地 sync,否则点按钮 / 切模式滑块复位;F2 只改
  `currentLightEnv`,不进存档。
- 未做,勿当缺陷重报:灯光方向场(`shadowField.ts` 只留了接口)、点光、多角色阴影 RT 并集。

## 怎么验证

`./dev.sh audit-depth`(场景 JSON depthConfig / 运行时深度+碰撞图 / 资产尺寸三处落点一致性);
画面对错肉眼难判,取证走 [headless-visual-verification](../recipes/headless-visual-verification.md);
看形状退化用 darkness=1.0 + 关 AO + 低 elevation。
