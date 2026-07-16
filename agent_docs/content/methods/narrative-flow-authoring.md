---
id: narrative-flow-authoring
title: 事件流程编排工作法(故事→可落地的信号驱动流程)
domain: content
type: method
summary: 把任意规模事件(主线/支线/微任务/遭遇/见闻)拆成信号脊椎上一条流程;正交五关(状态→骨架→实体→地图→位面)+三旋钮定类型;进度走信号不堆flag,单拍落地委托 wire-demo-beat
status: active
triggers:
  tasks: [编叙事流程, 拆剧情, 拆叙事, 加主线, 加支线, 加遭遇, 加见闻, 重构叙事, 做内容, 策划模式]
  topics: [事件即叙事, 叙事编排, 信号脊椎, 位面, 跨flow查询, 三旋钮, production mode, 策划模式]
  paths: ["public/assets/data/narrative_graphs.json", "public/assets/data/quests.json", "public/assets/data/encounters.json", "public/assets/scenes/*.json"]
last_governed: 2026-07-16
last_used: 2026-07-16
---

## 适用时机

任何"涉及事件"的内容——主线/支线/微型任务/小遭遇/复杂见闻——从零编或重构一条事件流程时。
不改玩法走本法;会改玩法设计含义先 gameplay-iteration;纯 L1/L2/L3 数据形状见
[production-mode-workflow](production-mode-workflow.md)。

## 核心公理(先认,违则拆歪)

- **事件=叙事,判据是「事件关联」不是大小**:任何**有事件关联**的叙事——预埋伏笔 / 有后果 / 被门闸 / 被别处读——不论多小,**必须走信号脊椎+状态机**([narrative-signal-spine](../../runtime/mechanisms/narrative-signal-spine.md)),没有"轻量旁路"、越小越不许偷懒。**只有纯孤立 flavor**(不预埋、无后果、没人读、不被门闸)才允许孤立对话。**坑:世界观闲话若预埋了后面的事件(如"阎王岭没了人"预埋林中喊名),就是有事件关联、不是纯 flavor**(①.5散落闲话踩过:先做成孤立、后改回脊椎打信号记"听过·可回响")。
- **类型=同一模型上三个正交旋钮,不是选系统**:①**规模**(state 数,12 里程碑↔2 态微遭遇);②**落位**(挂主图=主线拍 / 独立 composition=支线遭遇见闻);③**呈现面**(quest / encounter / 见闻录 / 无——纯镜像读状态不驱动)。
- **进度真相只有主图/本 flow**;推进走信号,flag 只在 state 的 `onEnterActions` 派生暴露;跨线依赖用 `narrative` 条件叶查任意图状态(一等能力,按图 id 天然命名空间),**不堆全局 flag**。

## 阶段骨架(正交五关;顺序=依赖序非流水线;每关只给目的+完成判据,怎么达成委托 [wire-demo-beat](../recipes/wire-demo-beat.md))

0. **摸状态 + 定三旋钮**——目的:碰数据前把故事拆成里程碑状态并定类型。判据:`state 清单 + 一句话含义 + 流转关系 + 三旋钮(规模/落位/呈现面)`都定了。
1. **建叙事状态机骨架(纯骨架)**——目的:状态清单落成 narrative 图,只搭状态与流转。判据:主图信号驱动能从 initial 走到终态;`__draft__`+`trigger:reactive*` 占位合法;零 setFlag、零 `setNarrativeState` 硬跳。
2. **加实体 + 被叙事引用 + 实体行为自编**——目的:做出每拍要玩家碰的 zone/hotspot/npc 并让叙事引用。判据:触发实体存在、被对应图引用、引用有效;实体自身行为在其面板可往返;迁移/改名/删走 entity_refactor 引擎。
3. **地图**——目的:定空间落点。判据:每拍有场景落点(缺则 map_config 加节点+建 scene)、实体位置图上点选、场景流转接通、素材审计过。
4. **位面**——目的:判哪些拍需整套规则切换并正确设计。判据:仅"整套规则切换"才开且复用 archetype、叙事点名 `activePlane` 派生、大戏入口对话加 `plane` 叶子闸、TS+Python 双校验器口径齐。

## 判断点(现场判,拿证据)

- **三旋钮怎么拧**(核心):规模看事件数;落位看"跑完主线动不动它"(挂主图=主线拍,不挂=支线);呈现面看要玩家怎么看见(清单/遭遇/见闻/隐形背景拍)。
- **进不进位面**:需要整套规则切换(控制器/光照/相机/输入/HUD/交互/显隐)才开;单点变化别开;**单任务专用位面=坏味道**,开新槽=立项。
- **一拍完不完整**:主图里程碑是否由**真实内容**的末态派生信号喂——不是替身桩(见死路)。

## 分工契约

- **形状归策划**(事件长什么样、拆几拍、走哪个呈现面);**接线归 agent**(信号/状态/通道/位面);先给可视化接线地图对齐落点再动手(见 [producer-collab-unknowns](../../meta/methods/producer-collab-unknowns.md))。
- agent 直接改 JSON、跑双校验门、判 L1/L2;L3 缺口、实质改玩法结果、进位面的设计判断由人拍板。

## 已知死路(码头正反标本)

- **一拍两条并行轨**:抽象替身桩满足主图、真实玩法悬在另一条 composition 不驱动主线=进度真相与玩法脱节(码头 `scenario_码头` 抽象三选 vs `flow_dock_water_monkey` 真捞箱)。**真相源必须由真实内容喂**。
- **对话层 setFlag 推进度**(码头滚铁环踩过):对话只"演+打信号",flag 只在 state.onEnterActions 派生。
- **抽象选择替代真实分支**:分支要做成真实状态(怎么捞箱),不是抽象平行体。

## 适用边界(能扛到哪)

- **甜区=中型开放世界**:去中心化 composition + 单一真相 + quest 纯镜像 + reactive 组合 + **跨 flow 查询(一等能力,含模板化 `flow_{{taskId}}`)** + 位面整套切换。
- **两堵墙(越过=立项加固,非硬塞)**:①**主图线性**——要多主线并进/系统涌现才撞;②**读取侧反查工具打磨**(编辑器一眼看清"谁在查图 X 状态")。

## 向下指针

- 运行时模型(5 层脊椎):[narrative-signal-spine](../../runtime/mechanisms/narrative-signal-spine.md)
- 单拍落地配方(动哪 5 处):[wire-demo-beat](../recipes/wire-demo-beat.md)
- 位面正确设法:[plane-system](../../runtime/mechanisms/plane-system.md)
- 实体迁移引擎:[entity-refactor-engine](../mechanisms/entity-refactor-engine.md)
- 表达五通道:[content-expression-channels](../mechanisms/content-expression-channels.md)
- 收尾双校验门:[content-validation-gate](../recipes/content-validation-gate.md)
