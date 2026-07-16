---
id: production-mode-workflow
title: 策划模式工作法(做内容/改JSON)
domain: content
type: method
summary: 做内容只写 JSON 的工作形状——入口能力判定 L1/L2/L3、数据实施、双校验门收尾;写不出来就升级/上报,不糊弄
status: active
triggers:
  tasks: [做内容, 改JSON, 加任务, 加对话, 加遭遇, 加演出, 改文案, 策划模式]
  topics: [production mode, 策划模式, 内容生产, L1L2L3]
  paths: ["public/assets/data/**", "public/assets/scenes/*.json", "public/assets/dialogues/graphs/*.json"]
last_governed: 2026-07-11
last_used: 2026-07-04
---

## 适用时机

需求属"做内容":任务/支线/对话/遭遇/规矩/物品/商店/演出/场景交互/档案/地图/小游戏/文案。
本项目是 AI 直接改 JSON、人类只经编辑器维护的协作形态——因此"编辑器可往返"是硬约束。
不改玩法的技术改动走 feature-iteration;会改玩法设计含义的先走 gameplay-iteration。

## 阶段骨架

1. **入口能力检查(阻断式)**——目的:动手前判定需求是 L1/L2/L3。完成判据:能答出
   "改哪些文件、用哪些已注册原语拼出来";答不出即触发升级判定,不得开写。
2. **数据实施**——目的:在编辑器管理的文件内落数据。完成判据:只写编辑器认识的
   字段与结构,所有跨文件引用真实存在。
3. **L2 升级(条件触发)**——目的:缺一个能力原语时最小新增。完成判据:登记面三件套
   齐 + `npx tsc --noEmit` 过 + 明确告知用户改了哪个原语/哪些文件。
4. **收尾校验**——完成判据:素材审计 0 issues + validate-data 0 error,且 warning
   逐条看过(不能"没 error 就当对了")。
5. **汇报**——完成判据:列出改动文件、L2 改动、校验结果、全部 L3 跳过任务及建议。

## 判断点

- **L1/L2/L3 判定**(核心判断):①副作用还是成段演出?②有没有对应已注册 command?
  ③参数在它 schema 里吗?④条件能用条件叶子布尔组合拼出吗?⑤需要运行时算术/跨变量
  取值/集合遍历吗?——④以内是 L1;缺单个原语是 L2;⑤命中或需新子系统是 L3(跳过+汇报)。
- **先证明不是 L1 没拼对**,再动 L2;L2 只加"打通需求所需的最小原语"。
- **盲区即升级信号**:需求落在"运行时支持但编辑器 GUI 改不到"的字段上,按 L2 补编辑器
  支持或上报,不闷头写人类维护不了的 JSON。
- **演出归属**:有时序/相机/淡入淡出/并行 → cutscene;单发反馈(showEmote 等)可作普通 command。

## 分工契约

- agent:直接改 JSON、跑校验门、判 L1/L2、汇报 L3。
- 人类:只经编辑器维护 JSON;L3 缺口、实质改变玩法结果的扩展、既有 action 语义变更由人拍板。

## 已知死路

- 偷改业务代码绕机制、假数据/空实现敷衍、把动作硬塞进不该去的结构——运行时静默跳过或编辑器拒存。
- 在嵌套结构里塞编辑器不认识的字段——人类开一次面板即被抹掉(见往返契约卡"重建区")。
- 把"能 json.loads"当校验通过——两道校验门都不跑等于没验。
- 把一次内容需求扩成大重构。

## 向下指针

- **做叙事/事件内容的 full 能力(涉及事件必载)**:[narrative-flow-authoring](narrative-flow-authoring.md)——事件=叙事、三旋钮定类型、正交五关(状态→骨架→实体→地图→位面)、进度走信号不堆 flag。
- 表达通道与权威清单:[content-expression-channels](../mechanisms/content-expression-channels.md)
- 编辑器可往返硬契约:[editor-roundtrip-contract](../mechanisms/editor-roundtrip-contract.md)
- L2 登记面三件套:[l2-action-primitive-registration](../mechanisms/l2-action-primitive-registration.md)
- 收尾双校验门命令:[content-validation-gate](../recipes/content-validation-gate.md)
- 字段级可编辑地图(权威):`docs/editor-authoring-surface.md`;完整步骤版 skill:`.cursor/skills/production-mode/SKILL.md`
