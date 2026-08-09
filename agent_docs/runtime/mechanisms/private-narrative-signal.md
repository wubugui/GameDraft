---
id: private-narrative-signal
title: 私有叙事信号(按 owner 定向投递)
domain: runtime
type: mechanism
summary: signals 登记表标 scope:private 的信号只投递给发射方 owner 拥有的 wrapper 图;让 N 个同类实体共用一个信号名和一张发射端对话图
status: active
authority:
  - src/core/NarrativeStateManager.ts
  - src/core/narrativeGraphValidation.ts
triggers:
  paths:
    - "src/core/NarrativeStateManager.ts"
    - "src/core/ActionRegistry.ts"
    - "src/core/narrativeGraphValidation.ts"
    - "public/assets/data/narrative_graphs.json"
  topics: [私有信号, scope, 定向投递, wrapper, 同类实体, 信号命名膨胀]
verified_by:
  - src/core/NarrativeStateManager.test.ts
last_governed: 2026-08-09
---

## 是什么(一句话)

`signals` 登记表里标了 `scope: 'private'` 的信号,**只投递给发射方 owner 所拥有的 wrapper 图**,
不进全局扫描面。

## 它解决的问题

100 个箱子各有各的 wrapper 图(`available → destroyed`)。若用普通信号,每个箱子都要一个
全局信号名(`箱子001_已取`…),**发射端的对话图也得跟着盖 100 份**——因为每份要发不同的名字。
命名面与发射端同时随实体数膨胀。

私有信号之后:**1 条信号名 + 1 张共用对话图 + 100 张 wrapper 图**。对话图无状态、owner 是
调用那一刻带进来的,所以同一张图挂 100 个热点,各推各的。

## 硬契约(违反即 bug)

1. **投递面 = 发射方 owner 拥有的全部 wrapper 图**(`getGraphIdsByOwner`)。不是"主 wrapper"
   ——`getPrimaryGraphByOwner` 那条「多张即歧义」的规则只服务 `@owner` token,与投递无关。
2. **缺 owner 上下文 = fail-loud 丢弃**(`signal.private.noOwner`,error)。**绝不回落成全局广播**
   ——回落会让那一条共用信号名一次推倒全部 100 个箱子,正是本机制要避免的事。
   owner 有但名下无任何图同样响(`signal.private.ownerNoGraph`,error + console.warn,
   2026-08-09 从纯 trace 升级)——场景 onEnter 的 ambient owner 没 wrapper 是最常见的作者错误。
3. **只有实体 owner(npc/hotspot/zone)绑定的图能监听**。白名单常量
   `PRIVATE_SIGNAL_LISTENER_OWNER_TYPES`(narrativeGraphValidation.ts,与批量盖章
   BATCH_ENTITY_KINDS 同口径,Python 两处兜底镜像+对账测试)。判据**不是"ownerType/ownerId
   成对非空"**——现网 flow/scenario 图都带成对 owner,按成对判会全部放行(终审复审 G-2):
   四档发射面产生不了 flow/scenario 发射方,那些监听永远不会触发(死监听);explicit 档还能
   手写 owner 把 N 个实体共用的私有信号定向灌进主线监听面。白名单外监听 = **校验 error**
   (`signal.private.listener.unbound`);白名单只设在校验面,运行时投递不重复设防。
4. **与全局信号同一命名空间,不得重名**。同名两义会让 xref 与作者都要时刻分辨"这是哪个"。
5. **零命中是常态,不报悬垂**。owner 的图不在 from 态时零命中很正常;
   "声明了私有却全项目无人监听"由校验器静态查(`signal.private.unlistened`,warning),比运行时准。

## owner 从哪来

`ActionRegistry` 的 `emitNarrativeSignal` 处理器从 **`ActionHandler` 的第二参 `originContext`** 取
(`actionOrigin.ts` 是唯一判定源,四档优先级 explicit → npcId → origin → ambient)。作者不书写。
全局信号不读这个字段,行为一字不变。

## 已知坑

- **要让剧情知道"某个箱子被拿了",还得另发一条全局信号**。私有信号不进主线监听面是刻意的。
- 发射点若在场景 onEnter 这类没有实体上下文的地方,私有信号必然丢——这是 error 不是兜底。

## 怎么验证

`NarrativeStateManager.test.ts` 的「私有信号」describe:定向投递不惊动兄弟 / 缺 owner fail-loud /
未标 private 照旧全局 / 校验两条。2026-08-09 做过失效探针(收窄与私有判定逐一改坏,对应用例转红)。
