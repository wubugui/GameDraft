---
id: swarm-flock
title: 鸟群 / 虫群(群体模拟 · 表演态)
domain: runtime
type: mechanism
summary: 鸟群绕受控者盘旋是 boids + 盘旋目标 + 连续恐惧值的同一套公式,放虫只是加恐惧源;模拟跑在俯视模拟平面再压回场景坐标;纯表演不入档、切场景即散;贴图运行时 Canvas 现画不吃素材
status: active
authority:
  - src/systems/swarm/swarmSim.ts
  - src/systems/swarm/SwarmSystem.ts
  - src/systems/swarm/swarmTextures.ts
triggers:
  paths: ["src/systems/swarm/**"]
  topics: [鸟群, 虫群, 群体模拟, boids, 粒子, 放虫, swarm, flock]
  tasks: [改鸟群行为, 加群体表演, 加粒子表演]
verified_by:
  - src/systems/swarm/swarmSim.test.ts
last_governed: 2026-09-07
---

## 是什么(一句话)

玩家周围一群鸟盘旋、放虫惊飞、虫散尽再回来的氛围层表演(玩法文档 B5);
数学在 `swarmSim.ts`(可单测),显示与生命周期在 `SwarmSystem.ts`。

## 权威源(读代码从哪进)

- `swarmSim.ts`:`stepFlock` 一个函数就是全部行为——三条群体规则 + 盘旋目标 + 高度弹簧 +
  恐惧(暴露度涨 / 定速退)+ 扑翼相位。`stepBugs` 是阻力 + 布朗扰动 + 寿命。
- `SwarmSystem.ts`:`spawnFlock / clearFlock / releaseBugs`、每帧子步推进、显示对象摆放。
- 动作登记:`spawnBirdFlock / clearBirdFlock / releaseBugs`(全部可选参数,`memory` 档)。

## 硬契约(违反即 bug)

- **模拟平面 ≠ 场景平面**:模拟在俯视 (x, z) 上算真圆,z = 场景 y / `depthSquash`;
  渲染时 `worldY = z·depthSquash`,屏幕 y = worldY − h。别在场景平面上直接跑 boids,
  一圈会是竖椭圆。
- **恐惧是连续量,没有状态机**:惊飞 / 拉远 / 散开 / 回巢全是 fear 混进参数的连续输出。
  想调"惊多久回来"改 `fearDecay`,想调"多容易惊"改 `fearRadius`/`fearRise`,
  别加 if(bugs.length) 之类的硬切。
- **前后排序按脚下地面点**:每只鸟 / 每只虫都是 `entityLayer` 的独立子节点,
  `entitySortFootY = worldY`(不是屏幕 y);影子在 `shadowLayer`。
- **表演态**:serialize 恒空桶,deserialize / `scene:beforeUnload` 整批作废;
  鸟不跟玩家跨场景。
- **贴图现画、系统自持**:`createSwarmTextures` 用 Canvas 2D 画,首次放鸟/放虫才建,
  `destroy` 先摘显示对象后销毁纹理(顺序反了触发 BindGroup 自毁,见 pixi-v8-traps)。
- 渲染层未注入(`setLayers` 之前)放鸟 / 放虫是 no-op + console.warn,不伪装成功。

## 已知坑

- 帧间隔过长(切标签页回来)会让 boid 积分炸掉:`update` 按 1/30s 拆子步,单帧最多补 0.1s。
- `swarmTextures.ts` 需要 DOM(canvas),单测只测 `swarmSim.ts`。

## 怎么验证

`npx vitest run src/systems/swarm`(盘旋稳定 / 跟随 / 惊飞-回巢 / 恐惧连续 / 可复现);
真机:dev 命令通道 `debugExecuteAction {type:'spawnBirdFlock'}` 再 `{type:'releaseBugs'}`,
看鸟先绕再散再回,影子随高度变淡。
