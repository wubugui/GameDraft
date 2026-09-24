---
id: dialogue-layout-styles
title: 对白版式档(屏底/屏顶/气泡/第一人称)与只画选项
domain: runtime
type: mechanism
summary: 对白外观是一个版式档枚举,四层取值(拍 > 节点 > 图 > 缺省 bottom);选项跟提示句/图级的版式走;第一人称档三处渲染共用一份画法;提示句为空时只画选项;加档要同步 TS 类型、编辑器手工镜像与 parity 测试
status: active
authority:
  - src/utils/dialogueSpeakerSide.ts#DialogueLayoutStyle
  - src/utils/dialogueSpeakerSide.ts#resolveDialogueLayout
  - src/rendering/firstPersonDialogue.ts
  - src/systems/GraphDialogueManager.ts#emitChoicesForNode
  - src/ui/DialogueUI.ts#setChoicesOnly
  - tools/editor/shared/action_editor.py#DIALOGUE_LAYOUT_CHOICES
triggers:
  paths: ["src/utils/dialogueSpeakerSide.ts", "src/rendering/firstPersonDialogue.ts", "src/ui/DialogueUI.ts", "src/ui/ActionChoiceUI.ts", "src/rendering/CutsceneRenderer.ts", "src/systems/GraphDialogueManager.ts"]
  topics: [对白版式, layout, defaultLayout, 第一人称, firstPerson, 气泡对白, 屏顶对话框, 选项版式, 只画选项, 字幕式]
  tasks: [加版式档, 改对话框外观, 做第一视角路口]
verified_by:
  - src/systems/dialogueLayoutTiers.test.ts
  - src/rendering/dialogueGeometryParity.test.ts
  - src/rendering/firstPersonDialogue.test.ts
last_governed: 2026-09-23
---

## 是什么(一句话)

"这句对白长什么样"是一个**版式档**枚举(档名与语义以 `DialogueLayoutStyle` 的注释为准),
不设 = `bottom` = 历史行为逐像素不变;制作人 2026-09-22 定调"就是对话和选项加一个样式,别另造轮子"
——新外观一律**加档**,不另起一套对话 UI。

## 权威源(读代码从哪进)

枚举、宽松解析与各档语义:`utils/dialogueSpeakerSide.ts`。第一人称档的几何与画法:
`rendering/firstPersonDialogue.ts`(常规对话框 / 过场对白框 / 动作选项条三处共用)。
选项的版式口径:`GraphDialogueManager.emitChoicesForNode`。编辑器侧下拉:`action_editor.py` 的
`DIALOGUE_LAYOUT_CHOICES`(图编辑器复用同一个下拉)。

## 硬契约(违反即 bug)

- **四层取值:拍 > 节点 > 图级 `defaultLayout` > 缺省 bottom**。节点级下发到各拍(拍自带的不覆盖),
  图级最后兜底;顺序由 `dialogueLayoutTiers.test.ts` 钉着。
- **选项跟版式走**:`dialogue:choices` 载荷带 `layout`,取 `promptLine.layout ?? 图级 defaultLayout`;
  动作选项(`chooseAction`)自带 `layout` 参数。前三档选项位置固定不随版式移动,第一人称档换成屏底横排。
- **第一人称档的排版只定义一次**:三处渲染都读 `firstPersonDialogue.ts`,别在某一处复刻常量;
  过场对白框本身是常规对话框的手工复刻,几何常量靠 `dialogueGeometryParity.test.ts` 逐项比对。
  进出第一人称经 `ui:firstPerson` 通知 HUD 收起屏底读数(三把火与气味留着)。
- **提示句无台词 = 只画选项**(2026-09-21 制作人:选项下面不许垫空框):框、正文层、立绘收起,
  选项摞贴屏底;下一句台词进来原样恢复。只动可见性,不拆不建。
- **加一档要同步的面**:TS 类型 + 宽松解析、各渲染处、编辑器下拉(**手工镜像**,漏了策划就选不到)、
  parity / 分层测试。缺省档不写进 JSON。

## 已知坑

- **编辑器顶层下拉回不到 bottom**:行节点 / 提示句的下拉是"顶层口径",选 bottom = 不写键;
  于是图级 `defaultLayout` 设了非 bottom 之后,单独一行**没法**再指定回屏底
  (2026-09-22 远眺图因此改成逐行设 firstPerson)。要混排就别用图级缺省。
- 第一人称画面要配铺满窗口的叠图(`showOverlayImage` 的 `fill`,见
  [overlay-image-handle-semantics](overlay-image-handle-semantics.md)),百分比叠图窗口一变就对不上。
- 立绘与说话人解析不归本卡,见 [dialogue-portrait-runtime](dialogue-portrait-runtime.md)。

## 怎么验证

`npx vitest run src/systems/dialogueLayoutTiers.test.ts src/rendering/dialogueGeometryParity.test.ts src/rendering/firstPersonDialogue.test.ts`;
画面取证按 [headless-visual-verification](../recipes/headless-visual-verification.md),
一张图级 firstPerson 的对话图里走到 choice 节点,确认选项横排、无木框。
