---
id: content-expression-channels
title: 内容表达五通道(权威清单在哪)
domain: content
type: mechanism
summary: 内容 JSON 表达游戏行为只有五条权威通道(command/cutscene/条件/图对话/[tag:]),绕过的写法运行时被静默跳过或编辑器拒存
status: active
authority:
  - tools/editor/shared/action_editor.py#ACTION_TYPES
  - src/systems/graphDialogue/evaluateGraphCondition.ts
  - src/data/cutscene_action_allowlist.json
  - src/core/actionParamManifest.ts#ACTION_PARAM_MANIFEST
triggers:
  paths: ["public/assets/data/**", "public/assets/scenes/*.json", "public/assets/dialogues/graphs/*.json"]
  topics: [command, action, cutscene, 条件, 对话图, ACTION_TYPES]
  tasks: [做内容, 写动作, 写条件, 编演出]
last_governed: 2026-08-05
---

## 是什么(一句话)

内容数据里表达"游戏做什么/何时做"只有五条机制强制的通道;通道外的写法在运行时被静默跳过、或被编辑器/校验器拒绝。

## 权威源(读代码从哪进)

**清单只以代码为准,本卡与架构文档都不复制表**(条件叶子已两度扩容,任何旧表都是错的):

- **command 清单**:`action_editor.py` 的 `ACTION_TYPES`;参数权威在 TS 侧 `actionParamManifest.ts`。
- **条件叶子清单**:`evaluateGraphCondition.ts`。
- **cutscene 可用 action**:`src/data/cutscene_action_allowlist.json`。

## 硬契约

1. **一切游戏行为走 command** `{ type, params }`,唯一执行链是 ActionExecutor;未注册的
   type 运行时不执行、校验器报 error。
2. **成段演出走 cutscene**(有时序/相机/淡入淡出/并行):内**禁改存档**(setFlag/giveItem
   等副作用放 `startCutscene` 外层),且只能用白名单 action。*例外*:单发反馈
   (showEmote 类)可作普通 command。
3. **一切条件走统一条件表达式**:已登记叶子 + `all/any/not` 组合,不另造运算符;
   运行时布尔/数值状态以 FlagStore 为唯一存储。
4. **对话分支走图对话 graph JSON**,不另造分支结构。
5. **玩家可见文本走 `[tag:…]` 引用**(见 [text-ref-tag-system](text-ref-tag-system.md))。

## 已知坑

- **command 挂错位置不报错、也不生效**:必须挂在引擎真会执行的字段上(任务/遭遇/热区/
  区域/图对话/延迟事件各有其位),换个结构照抄挂点前先确认它会被执行。
- **条件引用一个不存在的叙事图 ⇒ 该条件恒为 false,不抛异常**:玩家侧不崩、无告警,
  只有 dev 运行时打一条红。真实后果是那些分支**永远走不到**,而且看起来"游戏好好的"。
  所以写条件时引用的叙事图/状态必须自证存在;dev 运行时那条红是唯一的现场信号,别当噪音略过。
- 缺通道能力时不要硬塞,那是 L2/L3 升级信号(见 [production-mode-workflow](../methods/production-mode-workflow.md))。

## 怎么验证

`./dev.sh validate-data` 抓未登记 type、跨文件引用断裂;主编辑器打开对应面板能选到/显示即通道正确。
