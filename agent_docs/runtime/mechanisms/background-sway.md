---
id: background-sway
title: 背景草木摆动(离线拆层 · 逐株受迫振子 · 位移图打光 / 不打光同一条路)
domain: runtime
type: mechanism
summary: 原画离线拆成静态底板 + 逐株植被网格(树整株刚转、灌丛草根部钉住弯、石头在底板上永不动,逐像素刚体度让竿刚叶弯);风只给目标弯角,每株 / 每顶点自己解受迫二阶振子;弯角平滑饱和、从原画姿态算起(原画没有风);渲染写一张 UV 位移图,打光与不打光背景都读它、植物动时一格光照不重算;分割全时段共用、底板按时段各补各的;摆幅透视按视深查表;作者面是草木工作台
status: active
authority:
  - src/rendering/backgroundSway.ts
  - src/rendering/lighting/LitBackground.ts
  - tools/character_lighting_lab/sway_field.py
  - src/core/lightingPayloadFiles.ts#LIGHTING_PAYLOAD_OPTIONAL
triggers:
  paths: ["src/rendering/backgroundSway.ts", "src/rendering/lighting/LitBackground.ts", "tools/character_lighting_lab/sway_field.py"]
  topics: [草木摆动, 树摆, 摆动图, sway, 拆层, 底板, 刚体度, 锚点, 整体摆, 波浪尺寸, 叶抖]
  tasks: [让草树动起来, 烘摆动图, 查草木不动, 查草木露底板]
verified_by:
  - src/rendering/backgroundSway.test.ts
  - src/rendering/backgroundSwayWindDirection.test.ts
  - src/rendering/backgroundSwayRigidMesh.test.ts
  - src/rendering/backgroundSwayCoherence.test.ts
  - src/rendering/lighting/LitBackground.sway.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

背景里的草木随 [[scene-wind]] 摆。拆层离线做(`sway_field.py` 烘进 `lighting/<背景基名>/sway.*`,属于照明载荷,统一走
`scene_fields`),作者修分割错在草木工作台([[sway-workbench]])。运行时读 `sway.json` + 底板 / matte / ids / rigid 几张图。

## 硬契约(违反即 bug)

- **🔴 原画没有风**(制作人 09-13 原话连说三遍)。原画里的草木就是无风姿态;画的是**此刻的真实弯角**,从原画姿态算起。
  **不许减掉任何"平均风弯角",不许给原画设"风力"参数**——那是 09-11 为塞进窄补带编出来的假定,造成过"风越大树越不动""纸往左飞树往右倒"。
  真正要解决的只有补带宽度。`backgroundSwayWindDirection.test.ts` 用真 `SwayBackground` 钉着方向。
- **🔴 草木有惯性**:风给的是目标弯角,每株(场是每顶点)解受迫二阶振子(ω₀ ∝ 1/√株高,阻尼含随风长的气动项)。
  不许退回"按当前风速直接摆到位"。子步 1/120 s、一帧最多 8 步;断档(切场景、跳帧)直接摆到目标、不补跑。
- **🔴 弯角平滑饱和,不许硬截断**(`swayBendAngle`,θ = θmax·x/(1+x)):硬截断让阵风峰值与平时双双顶到天花板,差恒为 0,风越大越死。
  叶颤幅度同理。两个植物常数是经验参数(没有逐株刚度数据),改要按其物理含义改。
- **两层,不许回到整张原画 UV 扭曲**(v1 被否:"树干应整体晃,石头不该动"):底板 = 只把植被轮廓往里一条补带补成背景;
  植被层一株一个实例,`plant` 绕根刚转、`field` 根部钉住平滑弯,叶颤只乘叶像素。**逐像素刚体度**(`sway_rigid.png`)让同一株竿刚叶弯;
  它**不**改变株的 `kind`。刚体交界 / 多锚点分界处的网格格子细分,顶点刚体度取细格内最大值,邻格细分的格铺扇形防 T 形缝。
- **作者覆盖**:`wind.waveSize`(株内相距小于它的点一起动,缺省 20 wu)、`instances[].coherent`(整体摆)、`instances[].anchors`
  (刚体部分绕最近锚点转)。作者输入存**原画像素位置**(`sway_overrides.json`),不存实例 id——id 每次重烘都会变。
- **位移软封顶 = 0.8 × 补带 × min(4, max(1, gain.sway))**:增益 1 是安全档(不可能露馅),再往上是作者自己掌握的越界档。
  "摆得大又不露馅"的正路是加宽补带重烘。上限倍数与 F2 滑条上限是同一个数,改一处改两处。
- **🔴 渲染走一张位移图,打光 / 不打光同一条路**(制作人 09-13 定):各株网格渲进离屏 `rgba16float` 图(存"源 uv − 本像素 uv"× 覆盖度),
  读的一方按它回原图取色。打光背景里植物像素取**主光照缓存**的源 uv、露出处取"扣掉植物"那份缓存(同灯同参、输入换成补过的
  原画 / 法线 / albedo / 深度),两份同脏同算——**植物动时一格光照不重算**。位移图在帧尾、光照缓存之前渲,不能放进场景树里渲离屏目标。
- 🔴 **卸载 / 原地重装前先 `detachSway()` 再销毁**,顺序反了 BindGroup 自毁、整局卡死([[pixi-v8-traps]])。
- **分割全时段共用主背景那份,底板按时段各补各的**:夜里露出来的必须是夜景颜色。夜景图必须与白天逐像素对齐;
  只写进**已有照明载荷**的时段目录;打光场景的补图按"这个时段烘没烘几何场"出,与运行时同一判据。
  新增拆层产物要同步 `LIGHTING_PAYLOAD_OPTIONAL` 四处镜像,少一处整批静默不进包(见 [[scene-lighting]])。
- **摆幅透视按视深查表**(`sway.json.depthScale`),不按透视轴(轴外的远山会查错)。**不从深度推自由度**(深度把细枝抹成地面)。
- **与场景风的关系**:共用参数、钟、阵风包络与风向摆动;**湍流是草木自己的两频强迫 × `turbIntensity`**,不是 `sampleSceneWind` 的三维涡矢量
  ——"同一阵风同一拍"成立,"逐点采样同一个风矢量"不成立。
- 纸钱躺在植被上取的是这一帧**画出来的**位移(按三角形插值),不另算公式。

## 已知坑

| 坑 | 症状 |
|---|---|
| `sway.json` 版本与 `sway_field.SWAY_VERSION` 不同步 | 运行时不认这份拆层 |
| 刚体度塞进 matte 的 alpha | 浏览器按 alpha 预乘清掉 RGB,自由度整张归零、草木不动(已拆成单独一张图,别合回去) |
| 时段原画没有照明载荷目录 | 那个时段没有摆动 |
| 竹竿没被分割认成木质 | 整丛走"场"弯;涂刚体或锁死 |
| 隐藏页用定时器采样量摆动 | 帧被节流、振子追不上,量出来是假的;在页面里同步逐帧调 `update` |

## 怎么验证

- `npx vitest run src/rendering/backgroundSway src/rendering/lighting/LitBackground.sway.test.ts`(振子过冲 / 余振 / 子步无关、强风摆幅不归零、
  风向、刚体竿上位移 == 刚体公式、无 T 缝、整体摆 / 锚点 / 波浪尺寸相关性)。
- 预算:整套风(草木 + 纸钱)≤ 2 ms/帧(制作人 09-12);F2「粒子」页同时显示粒子模拟与草木毫秒。
- 取证:`sceneWind.setOverride({gainSway: 0})` 取静止帧再比摆动帧;读位移图 `gl.readPixels(FLOAT)` 对账。
