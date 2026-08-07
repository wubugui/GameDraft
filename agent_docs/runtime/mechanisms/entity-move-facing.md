---
id: entity-move-facing
title: 实体位移的朝向语义(faceTowardMovement)
domain: runtime
type: mechanism
summary: 不勾选=完全不碰朝向(勿回退成"起点偷改一次");需要转身的内部调用必须显式传 true;朝向只有左右镜像,up/down 不存在
status: active
authority:
  - src/entities/Player.ts#moveTo
  - src/entities/Npc.ts#moveTo
  - src/rendering/SpriteEntity.ts#setDirection
  - src/core/ActionRegistry.ts#faceEntity
triggers:
  paths: ["src/entities/Player.ts", "src/entities/Npc.ts", "src/core/ActionRegistry.ts"]
  topics: [朝向, faceTowardMovement, faceEntity, moveEntityTo, jumpEntityTo, 巡逻]
  tasks: [改位移动作, 改朝向, 编排走位]
last_governed: 2026-08-05
---

## 是什么(一句话)

谁有权改实体朝向、什么时候改——位移类动作与 `faceEntity` 之间的抢占规则。

## 权威源(读代码从哪进)

`Player`/`Npc` 的 `moveTo`/`jumpTo`(参数消费点)、`SpriteEntity.setDirection`(左右镜像本体)、
`ActionRegistry` 的 `faceEntity`。

## 硬契约(违反即 bug)

- **`faceTowardMovement` 是二值**:`true` = 位移全程逐帧朝行进方向;**其余一律"完全不碰朝向"**。
  旧实现在不勾选时仍于起步偷改一次,把紧邻的 `faceEntity` 抹成死代码——**勿回退**
  (2026-08-05 制作人拍板)。
- **需要转身的内部调用必须显式传 `true`**(NPC 巡逻、场景组位移原本白嫖那次偷改)。
  直线段里"逐帧朝向"与"起点朝向一次"结果恒等,故这样改零行为差异——**别当成行为回归去"修"**。
- **朝向只有左右镜像**:`setDirection` 丢弃 dy,动画包没有上下朝向;`faceEntity` 的 `direction`
  只认 `left`/`right`(其它值运行时 warn 跳过、validator 报 error)。`faceTarget` 在两实体 x 相同时无效。
- **NPC 与 Player 的朝向存放面不同**:判 NPC 朝向要读其容器的 `scale.x` 符号,
  **不能读 `npc.sprite.facingDirection`**(恒为 right);Player 才是读 `facingDirection`。

## 已知坑

- `faceEntity` 紧接一条勾了 `faceTowardMovement` 的位移,朝向仍被位移覆盖——设计内的抢占,
  不是 bug;想保住 `faceEntity` 的朝向就别勾。

## 怎么验证

页内直驱:朝右站好 → 向左 `moveEntityTo`/`jumpEntityTo`,不勾选须仍为 right、勾选须变 left;
再看一个 ping-pong 巡逻 NPC 在端点是否掉头。真机配方见
[runtime-command-channel](../recipes/runtime-command-channel.md)。
