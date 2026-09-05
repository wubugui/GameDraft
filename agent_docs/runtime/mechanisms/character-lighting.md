---
id: character-lighting
title: 角色逐像素照明(probe 底光 + 加性实体灯)
domain: runtime
type: mechanism
summary: 只有一条活路径——probe 烘死的 GI 底光 + 与场景同一次打包的加性实体灯 + 与背景同一组显示变换;统一角色路径被 Game 里的常量开关整条关死(留码不删);着色核心单一 GLSL 源,法线必须与 color 同 UV 采样、格边界与运行时 stride 对齐
status: active
authority:
  - src/core/Game.ts#UNIFIED_CHAR_PATH_ENABLED
  - src/core/CharacterLightingSystem.ts
  - src/rendering/CharacterLitSprite.ts
  - src/rendering/charShadeCore.glsl
  - src/rendering/CharacterShadingFilter.ts
  - src/rendering/spriteNormalAtlas.ts
  - src/rendering/lighting/lightingCore.glsl
  - tools/character_lighting_lab/pipeline.py
  - tools/animation_pipeline/bake_normal_atlas.py
triggers:
  paths: ["src/rendering/lighting/**", "src/core/UnifiedCharacterLighting.ts", "src/rendering/charShadeCore.glsl", "src/rendering/CharacterLitSprite.ts", "src/rendering/CharacterShadingFilter.ts", "src/rendering/spriteNormalAtlas.ts", "src/core/CharacterLightingSystem.ts", "tools/character_lighting_lab/**", "tools/animation_pipeline/bake_normal_atlas.py"]
  topics: [角色照明, probe, 法线图集, 伪世界照明, CHAR_FS, 体素卷, 融入场景, 加性灯, 天穹可见性, radianceScale]
last_governed: 2026-09-03
---

## 是什么(一句话)

按角色法线逐像素给玩家 / NPC / 挂件打光。**只有一条活路径**(2026-08-30 起):

```
E = probe 图集查表(q 空间, 烘死的 GI 底光) + 场景实体灯(M-world, wu, 加性)
角色 = color × E → 显示变换
```

底光来自**同一张原画**烘出来的 probe(离线,`tools/character_lighting_lab/`),
灯来自作者摆的实体灯——与场景背景吃**同一次 `packLights`**,
「灯对角色和场景一视同仁」因此是构造性的,不是两处写得像。

场景背景那一半见 [scene-lighting](scene-lighting.md),阴影/遮挡/色调见
[entity-lighting](entity-lighting.md),单位与空间见 [lighting-scale-reference](lighting-scale-reference.md)。

## 权威源(读代码从哪进)

着色核心 `charShadeCore.glsl#shadeCharacterLinear`(运行时与实验室各自注入同一份字符串);
mesh 路径 `CharacterLitSprite.ts`、filter 路径 `CharacterShadingFilter.ts`;
载荷与 probe / 体素卷生命周期 `CharacterLightingSystem.ts`;灯的闭式解共用
`lighting/lightingCore.glsl`。离线端 `character_lighting_lab/`(probe + 深度 + 行走面)
与 `bake_normal_atlas.py`(法线图集)。路径分流点 `Game.litShaderProvider`。

## 硬契约(违反即 bug 的机制约束)

- **灯必须来自场景那次打包的结果,不许角色侧自己再打一遍**。同一份 `PackedLights`
  + 同一个 `wuPerQUnit` 才能保证两边一致;各算各的 = 第二个真相源,而且不报错。
- **三个空间不许混**(实测都不报错,只是画面不对):
  probe / 体素 / 太阳项是**按 q 烘的载荷**,查表用 q 法线;**实体灯一律在 M-world、单位 wu**。
  踩过:N 在 q、L 在 M-world,45° 场景里角色正面 N·L 应为 0.707、
  跨空间算出 **0** —— 身体收不到灯光,脚下地面却被同一盏灯正常照亮。
- **法线的两种读法都对,但用在两个地方,别统一**(2026-08-31 翻案后的定论,**改之前先读完**):
  **角色法线图集读作世界向量时,中性法线 = 世界水平**(角色是直立 quad,其局部轴过 R 之后
  恰好是世界 X/Y/−Z)。所以**灯循环直接用 `n`**,再乘一次 R 就是把每个角色整体仰起一个俯角。
  但 **probe/体素/太阳项的 SH 载荷方向基是 q 空间**(烘焙侧的方向被逐轴各向异性缩放到体素索引,
  若是世界方向这步没有意义),**查表必须传世界法线的 q 坐标 `nQ = Rᵀ·n`**。
  ⚠ 2026-08-31 曾按"两处都原样用 n"改过一轮,当日被审计钉为回归并回滚:实测原样传比 `Rᵀ` 传
  **暗约两成**,与游戏内两次实测吻合;当时"看起来仍匹配"是因为两次测量的地面参照换了、不可比。
  把 q 坐标三元组当世界方向读("朝下斜 45° 被压暗")是那次误诊的来源。**别再翻第三次。**
  两侧口径由 `worldSpaceShading.test.ts` 机械锁死(场景侧与角色侧 probeE 必须同基),
  空间定义见 [coordinate-spaces](coordinate-spaces.md)。
- **重放 / 缓存路径不许吃缺省参数**——进场景的真实时序是灯先到、基后到,所以**每次进场景
  都必然走重放**;标定过的尺度在那条路上落回缺省就是"灯亮、地亮、人不亮",而观感会把人
  指向摆灯参数。这类陷阱的通用形状与判据见
  [lighting-scale-reference](lighting-scale-reference.md) 的已知坑。
- **显示变换必须与背景同一组参数**(`applyDisplay`)。少这一条,ev 一开就是
  "背景很亮、角色漆黑"。
- **E 只出明暗,角色保留自己的颜色**:sprite 像素是美术着色后的 color、不是 albedo,
  拿带场景色的 E 去乘 = 二次着色。反方向补救(在无 E 的素材域把角色往场景色拟合)
  会幂次过冲,那条路已整体拆除,勿重造。
- **着色核心单一真相源**:只改 `charShadeCore.glsl`,禁止在任一 shader 内联重写。
  实验室是调着色参数的唯一入口,一漂移调出来的值到游戏里就是错的**而且不报错**。
- **法线与 color 必须用同一个顶点 UV 采样**。从世界坐标反推 UV 一旦逐帧驱动缺席
  (实测过场态整段跳过)就全身采到边缘列:通体单色 / 镜像换色 / 闪烁。
  镜像由顶点行列式正负判(几何自身事实),不引 uniform。
- **法线图集的格边界必须与运行时的浮点 stride 逐字对齐**(`round(k*w/cols)`,不是整数截断):
  误差随帧序号线性累积 ⇒ 静止角色也逐帧闪、左右朝向法线明显不同。改 `cols/rows/downscale`
  或换图集后**必须重烘**。法线纹理还得**逐帧跟当前图集**——实体会换动画包,绑一次就成了
  "新坐标查旧图"。
- 法线只离线烘、运行时只加载,缺图走平面法线降级;**禁止加载期现场烘焙**(主线程焊死数秒)。
- **probe 载荷低于当前版本直接禁用**;哈希失配(背景重画了没重烘)自 2026-08-30 起
  **不再整份禁用**,改分级降级:几何项照用、光照项标 stale 并在 dev 大声报。
- **重画一张背景 = 必须重烘那张背景的整套载荷**,这是硬约束不是建议。
  重画背景是**内容侧的日常操作**(策划/美术都会做),烘焙却在另一条工具链上,而
  **既有的门一个都抓不到**:素材审计只查存在性、打包照抽不误、真跑一遍也不产生 404。
  唯一会说话的是数据校验里的烘焙条目与发行前的静态新鲜度门
  (见 [build-pipeline](build-pipeline.md))——改完背景就去看那一条,别等进游戏才发现
  (实测有过改完到发现隔了九天的例子)。
- **probe 烘焙的降方差三件套**(2026-09-01 制作人定位「高分位不收敛」后从
  lighting-rebuild 分支补课):① NEE+full-MIS(nee.py,发光体第二方向采样器,
  阈值 `probe_nee_threshold` 按**本管线**辐射标度取 1.0,分支的 4.0 是它
  200-1200 标度的值);② 逐样本亮度钳 `probe_clamp`(有偏,缺省关);
  ③ **自适应细化**(高 DC 方差格 4x spp 独立流重采、按样本数加权合并,无偏)。
  实测破屋(最恶劣,动态范围 3789x)图集孪生 p90:110% -> 26%,能量比 0.998。
  3D 联合双边滤波留作应急选项但**缺省关**:三版 sigma 口径(线性/log/SVGF方差)
  要么偏能量 +8% 要么加跑间方差 —— 收敛只许走采样,不许走抹。
- **skyao 体采样必须用节点口径**(`c01×(N−1)`):烘焙格点是 `linspace(x0,x1,n)`,端点在盒
  边界。抄体素卷 `sampleVol3` 的格心口径(`c01×N−0.5`)= 系统性偏移 (u−0.5) 格,盒中心零、
  边缘半格 —— 不报错,只在陡变区(墙缘)显出 0.05~0.1 的 V 错(2026-09-01 制作人抓出)。
  probeE/verify/_trilinear 全是节点口径,以它们为准。
- **有场景对照的调试档必须过显示链**(V 灰度档=eOnly 同课):场景侧调试输出写进 RT 后被
  LitBackground 做显示变换,角色裸值直出=凭空暗一档+半透明边缘一圈黑圈,看着像采样 bug
  (2026-09-01 又踩一次)。纯读数的取证子档(盒坐标/原始矩/色带)刻意保持裸值,注释写明。
- **「纯E」审计档必须用乘 skyao 之前的 E**(`EgiPure` 快照):场景侧 uDebug==8 是纯 E,
  角色侧拿乘过 V 的 E 去比就是双重衰减 —— 白天开阔处 V≈0.9 看不出,夜里墙边(V 低)
  直接把人和棺材压黑,看着像「同一处地面白、角色黑」的数据事故(2026-09-01 制作人抓到)。
  正常渲染路径不受影响,只有 GI体 audit 档走快照。
- **lit quad 的世界坐标不许从 screen 反推,必须由 CPU 每帧喂 local→世界 的仿射**。
  角色挂在**带滤镜的容器**下,Pixi 会先把子树渲进一张按包围盒对齐的临时 RT ——
  那一趟里 shader 见到的 screen 是**临时 RT 的局部坐标**,凡是 `(screen − 相机位移) / 相机缩放`
  这类世界重建全被整体平移。**`gl_Position` 不受影响 ⇒ 画面位置一直是对的,只有采样位置错**,
  且误差随镜头/包围盒漂 ⇒ 表现为"角色强度怎么调都和场景对不齐"(实测偏 500+ wu)。
  这条对**任何**放在滤镜容器里、又依赖屏幕→世界反推的着色都成立。
- **lit quad 的世界坐标必须含外层实体容器**(`SpriteEntity.setLitParentTransform`):
  「container.x/y = 场景世界」这条契约只对 Player 成立;Npc 把 sprite.container 挂在自己
  container 下(local 恒 0,0)。漏了外层,**全部 NPC** 的 lit quad 拿 (0,0) 采 probe ——
  素色浮在画面上;静态 NPC 永不换帧,创建时同步一次错值后再无暴露机会(2026-09-01 门卫黑影)。
  Npc 在位置/缩放(setFacing/applyInstanceTransform)/重建四处推;挂件 lit 同一套合成。
- **probe 查询必须过 A7 折叠**(`probeQueryN`,受 `fold` 参数门控,全场景载荷 fold=1):
  朝相机的射线立刻出画、只拿到逃逸辐射(缺省是地板色,不再是绝对零,但仍远低于场景),
  E(朝相机) 因此被系统性饿死(实测雾津街头同一点
  E(-z)=0.21 vs E(+z)=2.72,差 13x)。角色法线恰恰全朝相机、场景面全朝上/纵深 ——
  同一份 probe「场景亮、角色黑」不是数据坏,是方向半球被饿死(2026-09-01)。
  RT 路径的 A7 是逐射线折;probe 版折**查询法线**,同一条假设:镜头背后统计上镜像可见场景。
- **probe/valid 纹理必须走平铺布局**(`CharacterLightingSystem.probeTiling` + GLSL `probeTexel`,
  每行 T 颗、T 为 4 的倍数):老布局「1 颗 1 行」在 MC 均匀网格 P≈12 万颗时高度直接超
  GPU `MAX_TEXTURE_SIZE`(16384),Pixi **不报错**,采样静默全黑 —— 盘上 E 全对、
  实机角色漆黑,giStrength 拨到 16 都无反应(2026-09-01 实锤)。改密度前先算 T·H。
- **逃逸辐射缺省是地板色,不是纯黑**(`escape.DEFAULT_ESCAPE = floor 0.3`,2026-09-02):
  probe 网格贴着辐射壳摆,半个球面是近距离亮面、另一半纯黑逃逸 ⇒ 半球反差实测 18~49x;
  L2 辐照度的截断残差(A₄ 项)≈总能量 3~5%,反差 50x 时压过背光侧真值,截负后翻成暗绿伪色
  (深潭绝地沟壑带)。朝亮侧 L2 没问题(合成 200x 反差 1.03~1.05),问题全在背光谷底——即下一条
  "阶数"的事;不是 NEE、不是收敛(关 NEE / 换种子都不变)、不是框架(SH vs bins 方向扇形相关 0.998)。
  地板色只垫有逃逸射线的格(沟壑被几何包死的格逃逸 0%,对它们无效,靠 L4)。地板色 =
  场景辐射中位 x0.3、画面平均色度的常色,烘焙时 `resolve_escape` 解析成 color 写进
  baked_params(校验按记录复现)。剂量单调:0→0.1→0.3 症状 4.87→4.19→3.30%,p95 103.7→86.8→68.6%。
  显式 `black` 仍可选;`scene_derived`(挑像素猜天)与它无关,照旧禁用为缺省。
- **probe 查询点沿 q 法线偏 `0.525 x 最小格距`**(GLSL `probeE` 与 `parity.query_bias_wu`
  同一常量 `const.PROBE_QUERY_NORMAL_BIAS`,改一处必须改两处,有测试钉住):DDGI self-shadow
  bias 的 N 项。薄面两侧 probe 混投的漏光降 25~80%,亮度中位/p95 同步小降。粗暴 virtual
  offset(把**捕获点**沿视向推离壳面 0.12~0.25wu)实测反而全面变差(6.9~8.8% 症状、中位
  26~34%)—— 捕获点离开它该代表的表面,别再试。
- **probe 纵向密度 4 格/角色高**(`probe_cells_per_char_y=4.0`,2026-09-02,原 2.0):平坦区
  格级斑块经双种子孪生分解 **87% 是网格分辨率误差、13% 是噪声**(skyao 75/25),spp、
  去噪、细化天花板只有那 13~25%;纵向加倍把平坦低通残差 58.1→42.2%、亮度中位 17.8→14.6%。
  `probe_max` 随之 40 万。3D 双边滤波仍缺省关(三版 sigma 口径都偏能量/加方差)。
- **正式基 = 八面体(octahedral),两档 8×8(缺省,64 方向 512B/颗)与 16×16(256 方向 2KB/颗)**
  (制作人 2026-09-02 拍板;烘焙 `probe_bin_ob`,载荷 `probes.bin_ob`,运行时 `shading.mode=3` +
  GLSL `uBinOb`,老载荷缺字段按 8 处理)。**必须做接缝环绕**(`octa_wrap` / GLSL `octaIdx`:越边 =
  沿边镜像的内侧 texel,角落走对角):地板法线在 q 空间恰好压在接缝上(世界"上"经 M 后 n.x≈0、
  n.z<0,折叠得 p=(±0.5,1.0) 落在图边界),没有环绕时 0.32° 的法线抖动就让取值跳 1.77×,
  破屋平地板整片硬边斑驳(2026-09-02 定位;修后该景平地板相邻像素硬跳变 891 对→0 对)。
  三处同一套规则(python / 运行时 GLSL / 查看器),有测试钉死。修完接缝后实测(真实网格 256spp):
  深潭绝地 8×8 中位 13.1%/p95 63% → 16×16 10.9%/38%;破屋 13.7%/96% → 11.9%/90%;
  城隍庙夜 15.1%/79% → 13.4%/63%;mountain_pass 12.0%/44% → 10.8%/43%。只有高反差/深谷场景
  值得 16×16(4 倍存储),其余 8×8 够用。SH('l2' 槽)与 L1+Geomerics 保留为对照/回退档。
- **(已降为对照档)L1(4 系数)+ Geomerics 非线性重建**(制作人 2026-09-02 拍板;`lighting.json shading.mode=1`,
  运行时 `probeEvalFlat` mode 1 与 `estimators.probe_eval_l1_geomerics` 同式:R0=c0·Y00,R1=½·Y1·(c_x,c_y,c_z),
  q=½(1+R̂1·n),r=|R1|/R0,p=1+2r,a=(1−r)/(1+r),E=R0·(a+(1−a)(p+1)q^p))。理由:**永不为负,不出暗绿**
  (深潭绝地症状 0.00%);代价明知:单叶模型摊平高频场(同景 p95 438%、漏光 20.7%,L4 是 50%/0.27%)。
  **L1 图集取去环之前的系数**(`l1_pre`):去环窗是给线性 L2/L4 防截负的,会削 L1 向量。
  查看器 mode 1 先在系数域合成四分账再非线性求值。'l2' 槽(L2/L4 线性)保留作对照与回退。
- **probe 球谐阶数选项 2/4('l2' 槽)**(`probe_sh_lmax=4`,2026-09-02;`lighting.json probes.sh_k`
  告诉运行时 'l2' 槽的列数,GLSL `uShK` 驱动循环上限,老载荷缺字段按 9 处理):同一批 1024 根射线上,
  贴壳格朝上真值只占总能量 0.6~1.8%,L2 只给到真值 0.30(0~0.80),L4 0.79,L6 0.92,L8 0.98;
  整场景低分辨率对决 L2→L4 症状 5.98→1.09%、p95 66→54。八面体 8x8 近邻在谷底 1.03 但正常格
  角度量化 0.85~1.75,**双线性**重建在谷底越到 1.42——这就是此前"换 BIN 偏亮 1.5x"的真身。
  非线性 L1 / ZH3 幻觉是单叶模型,谷底同样归零。基函数三处同值同序(estimators.sh_basis /
  运行时 shY / 查看器 shY+shYJ),python 侧 Gram 矩阵测试钉常数。
- **SH 逐颗去环是烘焙必做工序**(`dering.py`,Sloan 窗 `w_l=1/(1+λl²(l+1)²)`,逐颗二分最小 λ
  使**三通道各自**重建 ≥ -1e-3·DC,三通道共窗保 DC 色度):运行时逐通道 `max(E,0)` 截负遇到
  负瓣就翻色(红先归零剩翡翠)。亮度窗不够——亮度非负挡不住单通道下潜(深潭绝地伪色
  2.14% vs 逐通道 0.83%,亮度精度零损失);环纹像素 4.71→0.04%。全局温和窗要吃 6~8 个点
  亮度中位偏差,不干;插值后再截负更糟。
- **体素卷永不预载**,开 RT 才拉、切离即卸。换卷 / 换 probe 图集纹理时**先重挂滤镜再销毁
  旧纹理**,顺序反了会永久烧毁滤镜(见 [pixi-v8-traps](pixi-v8-traps.md))。
- 时段换原画 = 换一整套烘焙目录(按第一层背景图名索引),**夜的 probe 要单独烘**。

## 已停用:统一角色路径(留码不删,别当缺陷重报)

`Game.ts` 的 `UNIFIED_CHAR_PATH_ENABLED = false` 把整条路关死,所有场景一律走上面那条。
理由:那条路的环境项是**合成天光 × 天穹可见性**,是给"被运行时重打光的场景"配套的;
原画不再被重打光之后,它不对应任何东西(见 [scene-lighting](scene-lighting.md))。

连带**当前无消费者**(读代码时别被误导):`UnifiedCharacterShader.ts` /
`UnifiedCharacterLighting.ts` 整份、`GiBouncePass` 的反弹网格、3D 天穹可见性网格、
`SceneLightingDef` 的 `radianceScale` / `characterShape` / `giGain`、以及**角色侧的雾**
——雾目前只作用于背景,角色不吃,开雾场景里角色会"贴"在雾前面。

重启这条路之前必须先读回来的三条(都是实测,重犯代价高):
- `radianceScale` **不许手填**:它描述这张原画的性质、不是美术意图。缺省由烘焙期反解的
  场景反射率 ÷ 角色图集实测反射率算出(角色基准 **0.0381**,实测 109 张图集 3081 万像素的
  中位线性亮度)。通用图形学的「典型反射率 0.25」对这套暗色民俗恐怖美术**差 6.5 倍**,
  照它填会系统性偏暗到 1/6.5,怎么调灯都救不回来——错的是尺度不是光。
- **两条路径的同名参数含义不同,禁止互相继承**:旧 probe 载荷里的 `flatten`/`bulge` 是给
  旧着色模型调的(雾津街头带 `flatten: 1.0`),喂进按 N·L 算的新模型 = 法线整个压平、
  方向性全丢(实测法线调试视图一片扁平橄榄色)。
- 3D 天穹可见性网格必须 `texelFetch` **手写三线性**(按 Z 切片平铺,硬件过滤会跨切片串色);
  `lcSkyLight` 内部已含半球项,调用方别再乘一遍(踩过:整场景暗到 0.6 倍)。

## 已知坑

- **实验室查看器与运行时是两份手抄,全仓没有任何机械 parity 闸**。着色核心本身是单一
  GLSL 源,但查看器侧的 probe 查表/着色入口是**另一份复制**,已知它与运行时的法线口径
  不一致。实验室又是调着色参数的唯一入口 ⇒ **口径漂一点,在实验室调出来的值到游戏里
  就是错的、而且不报错**。改任一侧必须手工核对另一侧。
- **`shading.beta` 是补偿不是修复**:它是为了补"角色比紧邻地面暗一大截"抬起来的,
  而当时的采样位置本身是错的(上面那条临时 RT 的坑)。**别把已落盘的 beta 当成标定结论引用**。

- `bulge` 旋钮只偏移采样点深度、**不改法线**(法线是离线从 alpha 烘死的固定鼓包 profile)
  ——一个控件承诺了两种未同步的语义。
- 烘焙把落在实体内的 probe 原点吸附到最近自由体素,运行时却按规则格点插值、载荷不带真实
  probe 位置——两套位置语义并存。
- 实验室的「场景EV」只进参数与 manifest、**不进烘焙计算路径**,调它不改辐射。
- 用调试面板改世界尺寸后,系统内的场景世界宽高不跟着更新(只在载荷装载时写一次),脚点会漂。
- 法线图这类**「alpha 当数据用」的纹理**必须走非默认装载通道,否则解码期就被预乘毁掉
  (见 [pixi-v8-traps](pixi-v8-traps.md))。
- ⚠ **`extract.pixels` 读不了浮点 RT**(RGBA16F 取出来全是 0 且不报错)。

## 怎么验证

`renderer.extract.pixels` 逐通道对账(mesh 路径 extract 拿到的才是真着色像素,filter 路径不是)。
⚠ **位置类取证必须整舞台抽取**:`extract.pixels({target: 某个 mesh})` 的隔离渲染会把目标
平移到包围盒原点,**一切依赖 screen / 世界重建的输出在隔离抽取下全是假的**
(踩过三轮"方向无关 / spp 无关"的错误结论,全由此来)。
⚠ **页内手动喂帧参数是污染源**:游戏主循环喂进来的相机参数带分辨率/DPR 修正,
在控制台里手动传"看起来对"的裸容器坐标,会把角色的世界脚点系统性写歪上百 wu,
表现成"灯照人的位置与光晕位置对不上"。页内验光照要么**让主循环自己跑**(先恢复 rAF),
要么照抄主循环那一处的实参。读 GPU 真值用 `gl.getUniform`,别信 JS 侧镜像变量与日志。
健康判据 = 法线可视化下**两朝向整体色调对称、帧均值≈中性**;旧口径「两朝向 R 互补即正确」
只在被预乘污染的场里成立,**勿再引用**。静止连拍多帧应纹丝不动。画面取证走
[headless-visual-verification](../recipes/headless-visual-verification.md)。
