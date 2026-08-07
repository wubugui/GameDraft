---
id: dialogue-portrait-runtime
title: 对话头像(立绘)运行时
domain: runtime
type: mechanism
summary: 头像跟「装扮配置」走不跟实体走;跟随说话人要求这行的说话人实体解析得出来,UI 收到的 portrait 恒带 slug
status: active
authority:
  - src/systems/GraphDialogueManager.ts#resolvePortrait
  - src/utils/scriptedDialogueSpeaker.ts
  - src/core/Game.ts#resolveScriptedSpeakerEntityForLine
  - src/ui/DialogueUI.ts
triggers:
  paths: ["src/ui/DialogueUI.ts", "src/systems/GraphDialogueManager.ts", "src/utils/scriptedDialogueSpeaker.ts", "public/resources/runtime/images/dialogue_portraits/**"]
  topics: [立绘, 头像, portrait, 对话UI, 换装, 说话人]
last_governed: 2026-08-05
---

## 是什么(一句话)

对话行的 VN 式半身像:行数据可显式指 slug,也可只给 emotion 让运行时按**说话人当前装扮**解析;
构图定稿见
[2026-07-07-dialogue-portrait-composition](../decisions/2026-07-07-dialogue-portrait-composition.md)。

## 权威源(读代码从哪进)

图对话侧 `GraphDialogueManager.resolvePortrait`;脚本台词(过场 / `playScriptedDialogue`)侧的
说话人实体解析 `Game.resolveScriptedSpeakerEntityForLine` + `utils/scriptedDialogueSpeaker.ts`;渲染 `DialogueUI.ts`。

## 硬契约(违反即 bug)

- **核心抽象是「装扮配置」**(动画包 + stateMap + portraitSlug 是一个整体),实体只是
  "当前挂着哪套配置",**头像跟配置走不跟实体走**。NPC 换装经 sceneMemory 入存档、
  重进场景合回 def 的那段是**逐键硬分支**:新增运行时字段必须显式加进对应分支,否则换装不持久。
- **说话人实体解析只有一条口径**(占位 > 显式指定的说话人 id > 旁白不认)。
  凡是"运行时有两条路径消费同一份策划输入"(此处:头顶气泡锚点 vs 立绘跟随),
  **兜底分支必须同源**,否则出现"气泡冒得出来、头像就是不出来"这种最难自证的半瘫状态。
- **UI 收到的 portrait 恒带 slug**——解析在管理器层做完,别在 UI 再解析一遍。
- 多拍节点:节点级 portrait 只作各拍**默认**,拍内自带的覆盖它。
- 立绘 / 气泡 / 压暗三样都靠**整行负载**下发,**脚本对话首句也必须整行 emit**
  (历史 bug:首句只发 speaker/text,把这三样一起摘掉了);压暗本身是 opt-in,默认不压。
- 异步贴图加载必须带 staleness token(防快速翻页贴错脸);缺图静默收起、行回满宽。

## 已知坑

- 查"某某没头像"必须走三层判据:①这行有没有 portrait 字段;②**这行的说话人实体解析得出来吗**;
  ③该实体当前装扮有没有 portraitSlug(运行时会按动画目录名推导,NPC 定义里为空是正常的)。
  只看内联字段必误判。
- 共同拥有一张对话图的多个 NPC,行 speaker 不能用"跟随点击者"那种 kind(会解析成错的人),
  必须显式指名。
- 主角装扮状态不进存档(既有缺口)。

## 怎么验证

命令通道触发对话,读运行时快照的 dialogue 字段判状态;画面取证按
[headless-visual-verification](../recipes/headless-visual-verification.md)。
