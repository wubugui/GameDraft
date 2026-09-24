---
id: scene-wind
title: 场景风(一份空气速度场 · 一个钟 · 阵风 · 各消费者读哪份)
domain: runtime
type: mechanism
summary: 场景 JSON 的 wind 是空气的速度场(不是加速度):对数廓线平均风 + 顺流推进的阵风 + 风向摆动 + 共享的无散度涡,唯一实现在 sampleSceneWind(CPU);组装层一份参数一个钟(SceneWindState,世界暂停时不走),粒子 / 挂件 / 草木同读,消费者只乘自己的增益;脚本阵风与 F2 倍率只进运行时那份——燃烧读的是作者那份,所以同一阵风吹得灭火把吹不灭蜡烛;风速是玩法量(火把能不能活),画面观感用 gain 解耦;草木摆动见 background-sway
status: active
authority:
  - src/utils/sceneWind.ts
  - src/data/windGust.ts
  - src/data/types.ts#SceneWindDef
  - src/core/ActionRegistry.ts#sceneWindGust
triggers:
  paths: ["src/utils/sceneWind.ts", "src/data/windGust.ts"]
  topics: [风, 场景风, 阵风, sceneWindGust, 湍流, 涡, wind, 风速倍率, 吹灭]
  tasks: [给场景加风, 调风力, 加阵风演出, 调火把在风里能活多久]
verified_by:
  - src/utils/sceneWind.test.ts
  - src/utils/sceneWindTurbulence.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

场景 JSON 的 `wind` 描述**空气的速度** u(x, t)(M-world、wu/s)。组装层持有**一份**参数 + **一个钟**(`SceneWindState`),
粒子、手持挂件、背景草木从同一处读——一阵风过来纸钱掀起、火把一暗、枝叶一甩是同一拍。
消费者:普通粒子与纸钱见 [[vfx-plates-and-areas]]、火把火势见 [[held-prop-system]]、燃烧见 [[burn-system]]、草木见 [[background-sway]]。

## 硬契约(违反即 bug)

- **风是速度,不是加速度**。受力方按自己的气动参数"感受"它;直接加到粒子上的加速度是发射器私有的 `motion.wind`(与场景风无关)。
- **唯一实现**:`sampleSceneWind` = 平均风(近地对数廓线,z0 = `roughness`)+ 阵风包络 + 风向摆动 + 湍流,纯函数、热路径零分配、不读挂钟;
  需要风的地方一律调它,不许在 shader 或别处另写一份。返回值**不含消费者倍率**(粒子乘 `gain.vfx`,草木乘 `gain.sway`)。
- **近地对数廓线是"躺着的纸大多不动"的来源**,别拿"吹动阈值"去凑。**阵风顺流推进**(τ = t − 顺风距离 / 平均风速),是扫过场景的。
- **🔴 湍流是一片共享的涡**(制作人 09-12:"真实的风至少会在原地打圈"):若干无散度随机波叠加,随平均风推进;
  同一处的两个消费者拿到同一个涡。**消费方不许再叠自己的噪声、不许按粒子种子错开噪声时间轴**(纸钱曾因此"全场一个方向、很死"),
  竖直分量不许丢。逆风占比 > 0 是"有涡"的判据。发射器的 `motion.turbulence` 是作者摆的局部抖动,另一回事、会叠加。
- **一个钟**:`time` 从进场景起计、切场景清零,只在场景有风时走,**世界暂停时不走**([[world-pause-and-game-clock]])。
  各消费者再起自己的钟 = 不同拍。风在背景装载钩子里按新场景重设(打光 / 不打光两条路都要),卸载时清空。
- 场景没配风、风速不为正或方向没有水平分量 ⇒ `params` 为 null(草木不动、火把只回不掉)。
- **阵风** `sceneWindGust`:后发覆盖前发;替换、切场景、过场结束、演出会话收尾都会解除等待并恢复环境音;要求场景有非零作者风;
  参数校验与 Python 共用 `windGustErrors`。
- **三份读法(最容易踩的交叉点)**:

  | 消费者 | 风从哪来 | 含阵风 / F2 倍率 |
  |---|---|---|
  | 挂件火势 / 物理闪烁 / 火苗倾斜 / 火种点火 | 运行时 `params` + 风钟,wu/s ÷ 88 = m/s | 含 |
  | 燃烧:消耗燃烧吹熄、火线顺流、燃烧火光闪烁 | 作者那份 `resolveSceneWind(scene.wind)` + 风钟映射 | **不含** |
  | 粒子 / 纸钱 | 运行时 `params` × `gain.vfx` × 实例吃风倍率 | 含 |
  | 草木 | 运行时 `params` × `gain.sway` | 含(但湍流另算,见 background-sway) |

  这是现状:改它就是改玩法口径,先对齐玩法清单。
- **冲击风 `WindBlast`**(落雷落地那一下,`SceneWindState.addBlast`,参数在效果 `bolts[].impact.blast`):中心往外、带一点往上,
  (1 − r/半径)² 衰减、几十毫秒起风后 (1−u)² 收掉,离地几个人高以上没有。**只进表现**:吃场景风的粒子(一般粒子与薄片)与草木摇曳读它;
  **不进 `sampleSceneWind`**——挂件火势、燃烧、吹灭读不到它(那是玩法)。它有**自己的钟** `blastTime`(一直走、切场景清零),
  不借风钟:燃烧存档把风钟分段映射进了记录,动风钟会让读档对不上。
- **风速是玩法量**:火把能活多久由火把头处的真实气流决定,画面"风有多大"用 `gain.vfx / gain.sway` 解耦(牛头凼:风速 6000 wu/s、
  两路增益 0.15,才让"没升级的火把护着也灭、升级件护着能活"分得开)。调画面别动 `speed`,调玩法别动 gain。

## 已知坑

| 坑 | 症状 |
|---|---|
| **阵风 / F2 风速倍率直接改 `speed`** | `speed` 同时是冻结湍流的平移速度与阵风相位的推进速度:进场越久(t 越大),阵风起落那一小段里涡场与阵风相位瞬移 Δspeed·t,涡乱跳(代码缺陷,未修;风速越大越明显) |
| 燃烧读不到阵风与 F2 倍率 | 脚本阵风吹得灭火把、吹不灭蜡烛 / 香;F2 调风速倍率时蜡烛纹丝不动 |
| 没烘几何场的场景 | 挂件没有相对气流,火势只回不掉——风吹不灭火把;燃烧在平面近似里照样按作者风吹熄 |
| 改场景 `wind` 块任何字段 | 燃烧按整块 JSON 做指纹:哪怕只调了草木增益,有外部事件的场景读档时整场切成烧完(见 burn-system) |
| 两个演出会话交叠 | 会话收尾无条件清阵风,A 结束会清掉 B 后发的那阵 |

## 怎么验证

- `npx vitest run src/utils/sceneWind.test.ts src/utils/sceneWindTurbulence.test.ts`。
- 真机 `?mode=dev&devScene=跑马梁`:读 `window.__game.sceneWind`(`authored` / `overrides` / `time` / `gustSnapshot`)。
  F2「粒子」页四根滑条(风速倍率 / 粒子增益 / 湍流强度 / 草木增益)是**临时覆盖、不落盘**,读数抄回场景 JSON。
- 涡的取证:统计在动的纸的速度方向与平均风夹角、竖直速度、路径长 / 净位移;逆风占比 > 0 才有涡。
