---
id: plane-system
title: 位面系统(PlaneReconciler)
domain: runtime
type: mechanism
summary: 位面=全局一等资产(normal 也是位面),实体归属位面;PlaneReconciler 从叙事状态派生一切、每个边界重派生、零自持久化
status: active
authority:
  - src/systems/PlaneReconciler.ts
  - src/systems/plane/types.ts
  - public/assets/data/planes.json
triggers:
  paths: ["src/systems/PlaneReconciler*", "src/systems/plane/**", "public/assets/data/planes.json"]
  topics: [位面, plane, 漂移, 相机基线, 世界规则切换]
verified_by:
  - src/systems/PlaneReconciler.test.ts
last_governed: 2026-07-11
---

## 是什么(一句话)

同一场景下整套玩法规则(控制器/光照/相机/输入/HUD/交互/实体显隐)按"激活位面"整体切换的基建;叙事图只**点名** `activePlane`,`PlaneReconciler` 把世界对账为 f(激活位面)。

## 权威源(读代码从哪进)

- `src/systems/PlaneReconciler.ts`(唯一新系统,文件头注释即模型说明)
- `src/systems/plane/types.ts` + `public/assets/data/planes.json`(位面资产)
- 五槽钩子散在:Player(漂移)/InteractionSystem(门闸)/SceneManager(派生基底显隐)/Camera(基线)/Game.applyPlaneLightEnvOverride

## 硬契约(违反即 bug)

- **叙事点名、对账器派生**:位面激活状态从叙事状态派生,在每个边界(scene:ready / 读档 / 过场结束 / HMR)重派生,PlaneReconciler 零自持久化。`activatePlane/deactivatePlane` 动作只当逃生舱,主路径永远是叙事状态点名。
- **实体属于位面**:归属标缺省=所有位面共有;行为差异=同位置两个实例各归各位面,没有变体/覆盖机制。实体**全量实例化**、经派生基底通道显隐——勿在加载期过滤,场景内切位面要能现身。
- **恢复场景 zoom 必须走 `Game.getCameraBaselineZoom()`**(位面档 ?? 场景档);对话/演出收尾按裸场景 zoom 渐变会盖掉位面相机档。
- **zone 位面重注册仅限 Exploring**(过场策略栈会吞 onExit 的改存档动作);非 Exploring 挂起,回边沿补刷(pendingZoneRefresh)。
- manual override 在 `save:restoring` 一律清(旧档无位面桶也要覆盖)。
- 直读 `sceneData.zones` 的消费点(如 depth_floor)不经显隐通道,须单独过位面滤。
- 槽封闭:开新槽(新系统性调整维度)=立项,不许顺手加。位面守 archetype 粒度(单任务专用位面是坏味道)。

## 已知坑

- **路线锁防不住对话里的 switchScene**:位面锁场景出口只管走路,"大戏入口"对话图必须自己加闸(条件已有 `plane` 叶子可用,见 evaluateGraphCondition)。
- 实体 `conditions` 默认只锁交互,要隐藏必须 `conditionHidesEntity:true`(见 [entity-visibility-channels](entity-visibility-channels.md))。
- `extends` 环:PlaneReconciler 预剥环处理 + validator 拦环;别依赖"忽略继承"的旧注释。
- 任务逻辑禁裸 setFlag,走信号→叙事图(进度真相源见 [narrative-signal-spine](narrative-signal-spine.md))。
- **位面被多图点名的校验口径 = 合法不报**(同位面多图共用 archetype 是设计常态,后进者胜;见 [2026-07-10 决策卡](../../editor-tools/decisions/2026-07-10-plane-multi-graph-declaration-warning.md))。该口径由**双校验器**执行——TS 权威 `src/core/narrativeGraphValidation.ts::validateActivePlanes`(按位面分组:同位面不报、异位面逐声明处 warning)与 Python `tools/editor/validator.py`;两者口径**必须同轮改齐**,改一处漏另一处会让 web 叙事编辑器持续误报(2026-07-13 踩过:TS 侧仍按旧"全局唯一归属一图"报 error)。

## 怎么验证

`src/systems/PlaneReconciler.test.ts`;真机五断言(显隐翻转/漂移/相机进出跨场景/掉阳气/存读档零残留)用 [runtime-command-channel](../recipes/runtime-command-channel.md) 驱动。

被否的 v1/v2 模型见 [2026-07-05-plane-v3-model](../decisions/2026-07-05-plane-v3-model.md),勿重蹈。
