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
  topics: [朝向, faceTowardMovement, faceEntity, moveEntityTo, jumpEntityTo, teleportEntityTo, 巡逻, 瞬移]
  tasks: [改位移动作, 改朝向, 编排走位]
last_governed: 2026-09-03
---

## 是什么(一句话)

谁有权改实体朝向、什么时候改——位移类动作与 `faceEntity` 之间的抢占规则。

## 权威源(读代码从哪进)

`Player`/`Npc` 的 `moveTo`/`jumpTo`(参数消费点)、`SpriteEntity.setDirection`(左右镜像本体)、
`ActionRegistry` 的 `faceEntity`。

## 硬契约(违反即 bug)

- **位移有三档:走 / 跳 / 瞬移**(逐帧行进、抛物到位、一帧到位不切动画)。
  **三者缺省都不碰朝向**——要转身就在旁边显式接一条 `faceEntity`。
  瞬移那一档还要管镜头:**只在镜头此刻真锚在被移动的实体身上时**才补一次相机 snap,
  判据在动作实现里(过场态别抢镜头,那是运镜的活)。
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
- **朝向的存放面差异会改变"叠加旋转"的符号语义**:NPC 的镜像在**外层容器**上、住在旋转的外面
  (`M·R(θ) = R(−θ)·M`,要补符号),Player 的镜像在 sprite 自己的 `scale.x` 里、在旋转的**内层**
  (与不镜像方向一致,补符号反而是 bug)。给实体叠加旋转(轨迹动画、挂点、标签补偿)时
  照抄同族先例会得出"朝左一律取反"的错误结论——那些先例恰好全是"外层"那一档。
  完整口径与补偿落点见 [[entity-trajectory]]。
- **位移不是唯一会写 x/y 的人**:实体被烘焙轨迹驱动时,`moveTo`/`jumpTo` 会抢占轨迹,
  而 `teleportEntityTo` / `persistNpcAt` / `setSceneEntityPosition` / `moveGroupBy` 直写 x/y、**天然不触发**这个钩子,靠各自 handler 里显式的一次 `stopTrajectory` 补上——新写「直接写实体坐标」的动作时要一并补,漏了就是下一帧被轨迹静默盖回去。
  抢占矩阵见 [[entity-trajectory]]。

## 怎么验证

页内直驱:朝右站好 → 向左 `moveEntityTo`/`jumpEntityTo`,不勾选须仍为 right、勾选须变 left;
再看一个 ping-pong 巡逻 NPC 在端点是否掉头。真机配方见
[runtime-command-channel](../recipes/runtime-command-channel.md)。
