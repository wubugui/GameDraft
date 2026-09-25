---
id: scene-hierarchy
title: 场景层级(照 Unity:节点 = GameObject + Transform,激活 / 组件 / 玩家循环)
domain: runtime
type: mechanism
summary: engine2d 的每个 Container 同时是 GameObject 与 Transform——setActive/activeSelf/activeInHierarchy(未激活子树不画、不命中、组件停)、场景根(stage)、Component 生命期(awake/onEnable/start/update/lateUpdate/onDisable/onDestroy)、PlayerLoop、Unity 名字的变换 API(world 读写、setParent 保世界、siblingIndex、find);世界矩阵按版本缓存。普通 Pixi 式用法零改动零开销
status: active
authority:
  - src/engine2d/scene/Container.ts
  - src/engine2d/scene/Component.ts
  - src/engine2d/scene/PlayerLoop.ts
  - src/engine2d/gpu/collect.ts#updateChild
  - src/engine2d/app/Application.ts#init
triggers:
  paths: ["src/engine2d/scene/**"]
  topics: [层级, hierarchy, GameObject, Transform, setActive, activeInHierarchy, 组件, Component, 生命期, PlayerLoop, update, setParent, worldPosition, siblingIndex, 场景根]
  tasks: [把系统改成组件, 按层级组织实体, 用激活代替显隐, 换父节点保持世界位置]
verified_by:
  - src/engine2d/scene/hierarchy.test.ts
last_governed: 2026-09-25
---

## 是什么(一句话)

照 Unity 的场景层级:**每个节点就是一个 GameObject,它自己就是 Transform**;激活、组件、玩家循环、变换 API
都在节点上。建在 engine2d 的 `Container` 上,所以游戏里已有的全部节点天然具备,不用迁移。

## 硬契约

- **激活 ≠ 可见**。`setActive(false)`:整棵子树不渲染(连变换准备与 `onRender` 都跳过)、不参与命中 / 包围盒
  (含滤镜区域)、组件 onDisable 且不再 update。Culler 对它照样判,结果同 Pixi 里 `visible = false` 的节点
  (空盒归一成 (0,0,0,0) 再与 view 比;master 的 NPC / 热点就是这么被剔的),不留隐藏前的旧 `culled`。`visible = false`:只是不画(Pixi 语义,等价 Unity 的 Renderer.enabled),
  节点照样命中测试之外的一切。**"这个东西现在不存在"用 setActive,"存在但先别画"用 visible。**
- **组件只在场景根下活着**。`activeInHierarchy` = 自己与全部祖先 activeSelf **且**最顶上的祖先 `isSceneRoot`
  (Application 的 stage 是;离屏另起的树要自己标)。`removeChild` 而不 `destroy` ⇒ 子树组件 onDisable、不再 update;
  挂回去 ⇒ onEnable。场景内两个父节点之间移动(addChild / setParent)只发 `onTransformParentChanged`,
  不会先 disable 再 enable。
- **组件生命期**(同 Unity):挂上且层级中激活 ⇒ 立刻 `awake` → `onEnable`;下一次玩家循环 tick 先 `start`
  再 `update(dt)` → `lateUpdate(dt)`;`enabled = false` / setActive(false) / 摘出场景 ⇒ `onDisable`;
  `removeComponent` / `component.destroy()` / 节点 `destroy()` ⇒ 活着先 `onDisable`,awake 过再 `onDestroy`。
  钩子抛错就地截住(控制台 error),不影响同帧其他组件、不逃到 ticker(渲染抛错打死主循环那条红线的同族)。
- **玩家循环**:`PlayerLoop.shared` 只遍历活着的组件(onEnable 进表、onDisable 出表),Application 在 ticker 上以
  NORMAL 优先级驱动(渲染是 LOW,之前)。`timeScale` 缩放 update 的 dt(0 = 暂停),`unscaledDeltaTime` 是原值。
  ⚠ 它**不认游戏的世界暂停**(对话 / UI 覆盖态):世界侧组件要随世界暂停,得由组装层按游戏时钟设 timeScale,
  或组件自己读游戏状态——别默认它会停。
- **变换 API 用 Unity 名字、角度用弧度**(与 Pixi 的 rotation 一致;Inspector 里显示度):`localPosition`(= position)、
  `worldPosition` / `worldRotation`(可写)、`lossyScale`、`localToWorldMatrix`、`hasChanged`、`transformPoint` /
  `inverseTransformPoint` / `transformVector` / `transformDirection`(及逆)、`translate(dx, dy, 'self' | 'world')`、`rotate`。
- **换父节点保世界用 `setParent(p, true)`**,别用 Pixi 的 `reparentChild`:后者经 Pixi 的 decompose,镜像节点
  (`scale.x = -1` 的朝向翻转)会被分解成 180° 斜切,之后按 scale.x 符号判朝向的代码全错;`setParent` 精确分解,
  保留缩放符号与 pivot / origin,非等比祖先带来的切变放进 `skew.x`。`reparentChild` 为 Pixi 对照保留原样。
- **世界矩阵按版本缓存**:本地变换或任一祖先变了才重算,算出的值真的变了才升版本(只改 alpha 不连累子孙),
  结果与沿父链现乘逐位相同。`worldTransform` 返回的是缓存本体,**别改它**(改了就是脏缓存)。
- **兄弟顺序 = 渲染先后**(`siblingIndex`、`setAsFirst/LastSibling`);父节点开了 `sortableChildren` 时按 zIndex 另排,
  兄弟序号就不再代表画序。

## 代价

子树里没有组件时,增删子节点 / setActive / 场景根开关都是 O(1)(每个节点记着子树组件数 `_subtreeComponents`);
有组件时按子树里带组件的分支下探。`activeInHierarchy` / `inScene` / `root` 是 O(深度) 现算,不缓存。

## 游戏里已经上层级的结构(2026-09-25)

- **常驻层有名字**:`stage / worldContainer / backgroundLayer / shadowLayer / entityLayer / worldFadeLayer /
  canvasStage / cutsceneOverlay / uiLayer`(= Renderer 字段名),可 `stage.find('worldContainer/entityLayer')`。
- **实体 = GameObject**:玩家 / NPC / 热点的根节点名 `player` / `npc:<id>` / `hotspot:<id>`,各挂一个身份组件
  (`src/entities/entityComponents.ts`:`PlayerComponent` / `NpcComponent` / `HotspotComponent`,基类 `EntityComponent`)。
  从实体子树任一节点反查实体:`node.getComponentInParent(EntityComponent)`。
- **NPC / 热点的在场走 setActive**,读用 `present`(见 [entity-visibility-channels](entity-visibility-channels.md));
  玩家的过场隐藏仍是 visible(玩家始终在场)。
- **逐帧更新顺序没动**:仍由 `Game.tick` 显式编排(世界暂停、状态门控、系统先后都在那里),身份组件不挂 update。
  要把某段逐帧逻辑挪进组件,先让玩家循环跟游戏时钟走(见上面「玩家循环」那条),再逐段迁、逐段对照。

## 怎么验证

`npx vitest run src/engine2d/scene`;运行时看 F2「层级」页(实时树 + Inspector,改动只在运行时、不落盘)。
