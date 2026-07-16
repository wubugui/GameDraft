---
id: dialogue-portrait-runtime
title: 对话头像(立绘)运行时
domain: runtime
type: mechanism
summary: 双写法——显式 {slug,emotion} 或 emotion-only 跟随说话人按"装扮配置"解析;UI 收到的 portrait 恒带 slug
status: active
authority:
  - src/systems/GraphDialogueManager.ts#resolvePortrait
  - src/ui/DialogueUI.ts
triggers:
  paths: ["src/ui/DialogueUI.ts", "src/systems/GraphDialogueManager.ts", "public/resources/runtime/images/dialogue_portraits/**"]
  topics: [立绘, 头像, portrait, 对话UI, 换装]
last_governed: 2026-07-11
---

## 是什么(一句话)

对话行的 VN 式半身像:素材约定 `dialogue_portraits/<slug>/<slug>_<emotion>.png`(9 表情固定),行数据可显式指 slug,也可只给 emotion 让运行时按说话人当前"装扮配置"解析。

## 权威源(读代码从哪进)

- 解析:`GraphDialogueManager.resolvePortrait`(player 侧 provider 经 setPlayerPortraitSlugProvider 注入)
- 渲染:`DialogueUI.ts`;scripted 对话链路在 ActionRegistry 逐行 parse + Game.resolveScriptedLineExtras

## 硬契约(违反即 bug)

- **核心抽象是「装扮配置」**:`{动画包, stateMap, portraitSlug}` 是一个整体,实体只是"当前挂着哪套配置",**头像跟配置走不跟实体走**。NPC 换装=setEntityField 打两条(animFile+portraitSlug),经 sceneMemory 入存档、重进场景经 `applyNpcRuntimeOverride` 合回 def——该函数是**逐键硬分支**,新运行时字段必须显式加进对应类型分支,否则换装不持久。
- 双写法:`portrait:{slug,emotion}` 显式;`portrait:{emotion}` 跟随说话人(npc/sceneNpc→Npc.currentPortraitSlug;player→Game.currentPlayerPortraitSlug;literal/未配置=不显)。**UI 收到的 portrait 恒带 slug**——解析在管理器层做完,别在 UI 再解析。
- 多拍节点:节点级 portrait 作各拍默认、拍内自带覆盖。
- 立绘/气泡/压暗三样都靠 `dialogue:line` 整行负载(portrait/speakerEntity/dim);**scripted 对话首句也必须整行 emit**(历史 bug:首句只发 speaker/text 摘掉了这三样)。
- 压暗是 opt-in:`startDialogueGraph`/`playScriptedDialogue` 的 `dimBackground=true` 才压,默认不压。
- 异步 loadTexture 必须带 staleness token(防快速翻页贴错脸);缺图静默收起,旁白/无头像行回满宽。

## 已知坑

- 共同拥有一张对话图的多个 NPC,行 speaker 不能 `kind:npc`(跟随点击者会解析成错的人),必须 `kind:sceneNpc` 显式指名。
- 主角装扮状态不进存档(已知既有缺口,截至 2026-07-11 未修)。
- 构图参数(240px 小立绘、压面板前景、底边出画)是用户四轮反馈定稿,勿"顺手优化",见 [2026-07-07-dialogue-portrait-composition](../decisions/2026-07-07-dialogue-portrait-composition.md)。

## 怎么验证

命令通道触发对话,读 `runtime_debug_snapshot.json` 的 dialogue 字段判状态;画面取证按 [headless-visual-verification](../recipes/headless-visual-verification.md)。
