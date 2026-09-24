---
id: vfx-plates-and-areas
title: 薄片(纸钱)与粒子区域(平板气动 · 接触 · 发射区域 / 范围区域软边界 · 补回)
domain: runtime
type: mechanism
summary: 挂 plate 模块的发射器每颗是一张会翻会弯的薄片(准定常平板气动 + 库仑接触 + 睡眠,无可调系数,尺寸与位移按脚点透视系数折);发射区域(实例 area,纸铺在哪 / 从哪补回)与范围区域(confine.area,关在哪)分开配,都按"粒子正下方地面点"判、烘成权重网格做软边界,没有推回力;补回只由生命周期控制器选点、挑不到不许回收;可燃纸钱绑可燃物模板,见 burn-system
status: active
authority:
  - src/systems/vfx/vfxPlate.ts
  - src/systems/vfx/vfxConfine.ts
  - src/systems/vfx/vfxLifecycle.ts
  - src/systems/vfx/vfxSurface.ts
  - src/systems/vfx/vfxContact.ts
  - src/rendering/vfx/VfxPlateBatchMesh.ts
  - src/rendering/vfx/VfxConfineOverlay.ts
  - src/data/types.ts#VfxPlateDef
triggers:
  paths:
    - "src/systems/vfx/vfxPlate.ts"
    - "src/systems/vfx/vfxConfine.ts"
    - "src/systems/vfx/vfxLifecycle.ts"
    - "src/systems/vfx/vfxSurface.ts"
    - "src/systems/vfx/vfxContact.ts"
    - "src/rendering/vfx/VfxPlateBatchMesh.ts"
    - "src/rendering/vfx/VfxConfineOverlay.ts"
  topics: [纸钱, 薄片, 落叶, 粒子区域, 发射区域, 范围区域, 软边界, 边带, 补回, 限高, 脚踢纸, 起飞]
  tasks: [做纸钱效果, 限定粒子范围, 配粒子区域, 查纸钱飞出框, 查纸钱不动]
verified_by:
  - src/systems/vfx/vfxConfine.test.ts
  - src/systems/vfx/vfxSim.test.ts
  - src/systems/vfx/vfxPlateBurn.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

[[vfx-system]] 里两件经常一起出现的东西:**薄片**(每颗粒子是一张有朝向、会弯的纸,`vfxPlate.ts`)与**粒子区域**
(作者在粒子工作台画的两块多边形,`vfxConfine.ts`)。风场本身见 [[scene-wind]];区域的作者面见 [[vfx-workbench]]「布置」。

## 硬契约(违反即 bug)

- **薄片气动没有可调系数**:法向压差 + 切向摩擦 + 翻转力矩 + 转动阻尼,全由 `terminalSpeed` / `edgeDrag` / `pressureOffset`
  这些物理量推出;接触是库仑摩擦(静摩擦 + 附着 `hold` 顶得住就不动),**不是**每子步乘衰减。静止 0.5 s 入睡,只做便宜的唤醒检查;
  燃着的片强制醒着。尺寸 / 离地高 / 位移 × **脚点透视系数**(与实体移动步长同一根轴),不乘则远处的纸又大又快。
- 薄片只读 `turbulence`、不读 `collision`;渲染是逐顶点投影的条带,受光版 program 只能配条带网格。
- **薄片的贴附面在构造时按原点解一次,`moveAnchor` 不重解**——薄片不该挂在会动的东西上。
- **接触冲量 ≠ 空气速度**:人脚踢纸走运动学接触输入,不是往空气里加风;强风验收要同时看**真实离地高度**、数值有限、会回落——
  别拿"空中补回"或对照位移当起飞证据。
- **两块区域分开配**(制作人 09-13):发射区域 = 实例 `area`(铺在哪、从哪补回);范围区域 = `confine.area`(关在哪,没写用发射区域)。
  出生 / 补回点先在发射区域挑、再按范围区域权重拒绝采样——两块不相交时一张都挑不到(校验器 warning)。群体不吃区域(用 `home.rangeRadius`)。
- **判据是粒子正下方的地面点**落在画面上的位置,不是粒子自己的画面位置(区域是地上的一块;飞得高的纸会画在框线上方,这是对的)。
  surface 补回判出界同样按正下方地面点,不按屏幕位置(否则把飞高误当出界)。
- **软边界,没有推回力、没有硬裁剪**:多边形烘成权重网格(深处 1、边带 `feather` 内 smoothstep 到 0),一个权重管三件事:
  ① 感受到的场景风 × 权重、过 `ceiling` 的上升气流 × 高度权重;② 边带里躺着的片随机淡出、从深处补回,出框(权重 < `CONFINE_EXIT_WEIGHT`)
  快速淡出(普通粒子没有补回,淡完即死);③ 出生 / 补回点按权重拒绝采样。不限定的实例权重恒 1,逐位不变。
- **只有生命周期控制器选补回点**(`vfxLifecycle`),求解器只报"离界"。🔴 限定区域时补回的纸**从低处放**(平着自由下落约 1 s 能落地的高度),
  从高处放会飘好几秒被边带拦不住、半空一张接一张消失。🔴 **挑不到落点不许回收**(隐身留着下个子步再试,每子步有补回上限)——
  回收就是总数一张张漏光。
- 燃着时被挪走的槽位作废、不补回(可燃纸钱,见 [[burn-system]]);躺在植被上的纸取草木**这一帧画出来的**位移([[background-sway]])。

## 已知坑

| 坑 | 症状 |
|---|---|
| 边带内沿在权重网格上取 0.98 等值线 | smoothstep 在 1 附近平,插值误差大过余量,画出一圈噪声;按离框线距离取(`confineDistanceContour`) |
| 旧薄片写了 `motion.stimulus` | 不生效(旧资产映射里薄片不吃刺激);要显式写 `simulation` |
| 草木摆动只作用在渲染 | 碰火判定与火焰段仍用没摆动的位置 |
| 睡着的片照样每帧重算顶点 | 贴地的纸在风里会颤,缓存不掉;省只能降段数 / 数量(`plate.segments` 按屏幕像素定,2 段够) |

代价参考:跑马梁 520 张纸模拟 ≈ 0.3 ms + 顶点填充 ≈ 0.4 ms/帧;限定区域不改变 update 耗时。

## 怎么验证

- `npx vitest run src/systems/vfx/vfxConfine.test.ts src/systems/vfx/vfxSim.test.ts`(权重网格几何、强风里总数不漏、补回飞不过边带、出框淡出、限高、不限定逐位不变)。
- F2「粒子」页每实例一行「深处 / 边带 / 淡出中 / 框外还看得见」,勾「画出粒子区域」叠框线(与编辑器画布同色);
  薄片状态在 `sim.emitters[i].plate.arr`(sleep / contact / hold)。
