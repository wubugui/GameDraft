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
last_governed: 2026-07-11
---

## 是什么(一句话)

内容数据里表达"游戏做什么/何时做"只有五条机制强制的通道;通道外的写法在运行时被静默跳过、或被编辑器/校验器拒绝。

## 权威源(读代码从哪进)

清单一律以代码为准,架构文档的表会漂移:

- **command 清单**:`tools/editor/shared/action_editor.py` 的 `ACTION_TYPES`(参数权威在 TS 侧 `actionParamManifest.ts`)。
- **条件叶子清单**:`src/systems/graphDialogue/evaluateGraphCondition.ts`(曾是 5 叶,后加 `plane` 成 6 叶——别抄任何旧表)。
- **cutscene 可用 action**:`src/data/cutscene_action_allowlist.json`。

## 硬契约

1. **一切游戏行为走 command** `{ "type": ..., "params": ... }`,唯一执行链是 ActionExecutor。
   未注册的 type 运行时不执行、校验器报 error。
2. **成段演出走 cutscene**(有时序/相机/淡入淡出/并行)。cutscene 内**禁改存档**
   (setFlag/giveItem 等副作用放 `startCutscene` 外层),且只能用白名单 action。
   *例外*:单发反馈(showEmote / playScriptedDialogue / playNpcAnimation)可作普通 command。
3. **一切条件走统一条件表达式**:6 类叶子(flag / quest / scenario / scenarioLine /
   narrative / plane)+ `all/any/not` 组合;运行时布尔/数值状态以 FlagStore 为唯一存储。
4. **对话分支走图对话 graph JSON**(line/choice/switch/runActions/end;选项可
   requireFlag / requireCondition / costCoins 门控),不另造分支结构。
5. **玩家可见文本走 `[tag:…]` 引用**(见 [text-ref-tag-system](text-ref-tag-system.md))。

## 已知坑

- command 常见挂载点:任务 `acceptActions`/`rewards`、遭遇 `options[].resultActions`/`rewards`、
  热区 `data.actions`、区域 `onEnter/onStay/onExit`、图对话 `runActions`、`addDelayedEvent.params.actions`。
  挂错位置不报错但不生效。
- 缺通道能力时不要硬塞,那是 L2/L3 升级信号(见 [production-mode-workflow](../methods/production-mode-workflow.md))。

## 怎么验证

`./dev.sh validate-data` 抓未登记 type、跨文件引用断裂;主编辑器打开对应面板能选到/显示即通道正确。
