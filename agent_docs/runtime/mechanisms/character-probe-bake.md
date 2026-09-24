---
id: character-probe-bake
title: 角色 probe 底光的烘焙参数与方向基选型
domain: runtime
type: mechanism
summary: 角色 GI 底光 probe 的烘焙端与运行时查表端必须同一套规则:正式基八面体(接缝环绕三处同规则)、SH 逐通道去环、逃逸缺省地板色、收敛只许走采样不许走抹、查询沿法线偏同一常量、A7 只折一头;改任一参数前先读这里的已否路线
status: active
authority:
  - tools/character_lighting_lab/pipeline.py
  - tools/character_lighting_lab/escape.py#DEFAULT_ESCAPE
  - tools/character_lighting_lab/dering.py
  - tools/character_lighting_lab/const.py#PROBE_QUERY_NORMAL_BIAS
  - tools/character_lighting_lab/estimators.py#octa_wrap
  - src/rendering/CharacterShadingFilter.ts
  - src/core/CharacterLightingSystem.ts#probeTiling
  - src/core/lightingPayloadFiles.ts#DEFAULT_PROBE_MODE
triggers:
  paths: ["tools/character_lighting_lab/**", "src/rendering/CharacterShadingFilter.ts", "src/core/lightingPayloadFiles.ts"]
  topics: [probe, 球谐, SH, 八面体, octahedral, 去环, dering, 逃逸辐射, NEE, 自适应细化, probe 密度, skyao, A7 折叠, 角色底光]
  tasks: [烘角色 probe, 调烘焙参数, 改 probe 查表, 换 probe 基]
verified_by:
  - tools/character_lighting_lab/tests/test_mc_bake.py
last_governed: 2026-09-23
---

## 是什么(一句话)

角色底光的 probe 由 `tools/character_lighting_lab` 离线烘(与场景几何场同目录),运行时在
`CharacterShadingFilter.ts` 的 GLSL 里查表(mesh 路径复用)。**烘焙端、运行时、实验室查看器三处**
对同一份载荷的方向基、插值、偏移必须同一套规则——口径漂一点,角色就系统性偏亮/偏暗且不报错。
着色怎么用这个 E 见 [character-lighting](character-lighting.md)。

## 权威源(读代码从哪进)

烘焙缺省参数与每项取值的实测理由都写在 `pipeline.py` 的参数表注释里(**以它为准,这里不抄数**);
逃逸 `escape.py`、去环 `dering.py`、八面体环绕 `estimators.octa_wrap`、查询偏移常量 `const.py`;
运行时查表 `probeE` / `probeEvalFlat` / `octaIdx` / `probeTexel`;mode→图集表 `lightingPayloadFiles.ts`。

## 硬契约(违反即 bug)

- **正式基 = 八面体(`shading.mode=3`)**,缺省 8×8,只有高反差 / 深谷场景值得 16×16(4 倍存储)
  (制作人 2026-09-02 拍板)。SH 线性('l2' 槽,`probe_sh_lmax` 缺省 2、L4 按需)与 L1+Geomerics 非线性
  是**对照 / 回退档**。"换八面体偏亮 1.5×"的真身是双线性重建在谷底越冲,不是基选错了。
- **八面体必须做接缝环绕**(越边 = 沿边镜像的内侧 texel,角落走对角),python / 运行时 GLSL / 查看器
  **三处同一规则**,有测试钉。地板法线在 q 里恰好压在接缝上,没有环绕时 0.3° 的法线抖动就让取值跳近 2 倍,
  平地板整片硬边斑驳。
- **SH 逐颗去环是烘焙必做工序**,且**三通道各自**满足非负、三通道共窗保色度:运行时逐通道截负遇负瓣就翻色
  (红先归零剩翡翠绿);只按亮度去环挡不住单通道下潜。全局温和窗 / 插值后再截负都更糟。
  L1 图集取**去环之前**的系数(去环窗是给线性 L2/L4 防截负的,会削 L1 向量)。
- **逃逸辐射缺省地板色,不是纯黑**(场景辐射中位 × 比例、画面平均色度,烘时解析成颜色记进 baked_params):
  贴壳格半球反差极大,截断残差会压过背光侧真值翻成暗绿伪色。被几何包死、逃逸为 0 的格对它免疫,靠基的阶数。
  `scene_derived`(挑像素猜天)禁止做缺省。
- **收敛只许走采样,不许走抹**:NEE+MIS(发光体阈值按**本管线**辐射标度定,抄外部分支的值会漏中亮像素)+
  自适应细化(高方差格独立流重采、按样本数加权合并,无偏)。逐样本亮度钳有偏、缺省关;3D 联合双边滤波
  三版 sigma 口径要么偏能量要么加方差,缺省关、仅留应急。
- **查询点沿 q 法线偏 `PROBE_QUERY_NORMAL_BIAS × 最小格距`**(DDGI self-shadow bias 的 N 项),GLSL 与
  `parity.query_bias_wu` 同一常量,改一处必须改两处(测试从 GLSL 文本解析比对)。
  ⛔ 把**捕获点**沿视向推离壳面(virtual offset)实测全面变差——捕获点离开它该代表的表面,别再试。
- **纵向密度是平坦区斑块的主因**(孪生分解:网格分辨率误差远大于噪声),加 spp / 去噪只动小头;
  改密度同时看载荷上限 `probe_max`。
- **A7 折叠只折一头**:运行时 `probeQueryN` 把朝相机的查询法线折进观测半空间(载荷 `fold=1`)——否则
  E(朝相机)被逃逸饿死,而角色法线恰恰全朝相机("场景亮、角色黑"不是数据坏)。烘焙侧的
  `probe_fold_escape` 缺省关;两头都折 = 双重计数。
- **skyao 体采样用节点口径**(`c01×(N−1)`,烘焙格点是含端点的 linspace);抄体素卷的格心口径
  (`c01×N−0.5`)系统性偏半格,只在墙缘显出 V 错。
- **probe / valid 纹理走平铺布局**(每行 T 颗、T 为 4 的倍数):老的「1 颗 1 行」在十万级 probe 时高度超
  GPU `MAX_TEXTURE_SIZE`,Pixi **不报错、采样静默全黑**——盘上 E 全对、实机角色漆黑、倍率拨满无反应。
  改密度前先算 T·H。
- **「纯E」审计档必须用乘 skyao 之前的 E**(`EgiPure`):场景侧对应档是纯 E,角色侧拿乘过 V 的去比是双重
  衰减,夜里墙边人被压黑、像"同一处地面白角色黑"的数据事故。正常渲染路径不受影响。

## 已知坑

- **实验室查看器与运行时是两份手抄的 probe 查表 / 着色入口,没有机械 parity 闸**(只有接缝环绕与查询偏移
  两处有测试),已知查看器把图集法线当 q 用、与运行时 `nQ` 口径不一致。实验室又是调烘焙初值的入口 ⇒
  改任一侧必须手工核对另一侧。
- 烘焙把落在实体内的 probe 原点吸附到最近自由体素,运行时却按规则格点插值、载荷不带真实位置——两套位置语义并存。
- 实验室的「场景EV」只进参数与 manifest、**不进烘焙计算**,调它不改辐射。
- 阶数 / 基 / 去环 / 逃逸 / 密度这几项的取证数字(症状率、p95、能量比)都在 `pipeline.py` 与 `escape.py` 的注释里,
  重新选型前先读完,那几条被否的路线都有实测。

## 怎么验证

`sh scripts/py.sh -m pytest tools/character_lighting_lab/tests/test_mc_bake.py -p no:cacheprovider`
(基函数常数、去环非负、逃逸缺省、接缝环绕三处一致、查询偏移与 GLSL 同值)。
改运行时查表后再过 `npx vitest run src/rendering/lighting/worldSpaceShading.test.ts`。
