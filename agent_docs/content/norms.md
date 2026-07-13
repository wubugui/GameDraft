---
id: content-norms
title: 内容制作规范(策划模式)
domain: content
type: norm
summary: 做内容/改JSON 的三红线、机制通道铁律、题材文案铁律、双校验门与红线
status: active
triggers:
  paths: ["public/assets/data/**", "public/assets/dialogues/**", "public/assets/scenes/**", "public/assets/cutscenes/**"]
  topics: [策划模式, 内容, JSON, 台词, 题材, 文案]
  tasks: [做内容, 写任务, 写对话, 配演出, 写文案, 改JSON]
last_governed: 2026-07-11
---

# 内容制作规范(策划模式)

适用:一切做内容/只改 JSON 的工作(任务、支线、对话、遭遇、规矩、物品、商店、演出、
场景交互、档案、地图、小游戏、文案)。工作形状见
[methods/production-mode-workflow.md](methods/production-mode-workflow.md)。

## 不变量

**三红线**
1. **代码默认只读、只写 JSON**;唯一例外是 L2 新增能力原语(走登记面三件套并上报,
   见 [mechanisms/l2-action-primitive-registration.md](mechanisms/l2-action-primitive-registration.md))。
2. **写不出来就升级/上报,不糊弄**:禁偷改业务代码绕机制、禁假数据/空实现敷衍、
   禁把动作硬塞进不该去的结构。
3. **JSON 必须保持"编辑器可往返"**:agent 直接改 JSON,人类仍只通过编辑器维护——
   格式契约、重建区/盲区/deprecated 纪律、跨文件引用与 `[tag:…]` 有效性必须成立
   (细则见 [mechanisms/editor-roundtrip-contract.md](mechanisms/editor-roundtrip-contract.md))。

**机制通道唯一**
4. 行为走 command、成段演出走 cutscene(内禁改存档、只用白名单 action)、条件走统一
   条件叶子、对话分支走图对话 graph、玩家可见文本走 `[tag:…]`
   (权威清单指针见 [mechanisms/content-expression-channels.md](mechanisms/content-expression-channels.md))。

**题材/文案铁律**
5. **西南口音**:所有角色对白只能西南官话渝都腔,禁您/俺/儿化音/哩等北方腔
   (细则见 [mechanisms/chongqing-dialect-voice.md](mechanisms/chongqing-dialect-voice.md))。
6. **每拍可玩**:demo 每一拍必须真·可玩(玩家动手),不准降成播字/过场;写拍先答
   "玩家这一拍动手做什么"。
7. **写实中透异常**:本作民俗志怪的一切美术/文案落写实底子,严禁玄幻发光、魔幻奇观、
   血红巨裂口式表现。
8. **冷信号纪律**:阿秀信号(香粉味/小调)只在濒死/定点显形,禁温情化、禁泛滥
   (系统常驻≠信号常见)。

**玩法设计铁律**(制作人拍板)
9. 机制必须高频占用玩家注意力(持续自我再生的误差,只有玩家的手能抹平);
   "设好就不管/闭眼玩"与"系统替玩家做"是废案红线。

## 过程义务

1. **开工先认权威**:寻狗 demo 内容以四权威源为准、废弃归档一律死档勿信
   (见 [decisions/2026-06-27-xungouji-doc-authority.md](decisions/2026-06-27-xungouji-doc-authority.md))。
2. L2 升级完成后明确报告动了哪些登记面;L3 跳过的任务收尾统一汇报。
3. 每次改完 JSON 必过双校验门,warning 逐条看;校验抓不到的自己当心
   (对话图内部 next 连边、素材文件存在性)。
4. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

- `python -m tools.editor.shared.asset_reference_audit . --strict` 零问题;
- `./dev.sh validate-data` 零 error 且警告数不增加;
- 命令与盲区细节见 [recipes/content-validation-gate.md](recipes/content-validation-gate.md)——
  **不能"没 error 就当对了"**。

## 红线

- 内容(物件名/规矩名/NPC/任务 ID/对话文本)硬编码进代码;
- cutscene 内改存档;
- 写 deprecated 字段、往重建区塞自定义字段;
- 落到盲区字段闷头手写不上报(那是 L2 升级信号);
- 北方腔台词、玄幻化表现;
- 保存会被编辑器 raise 拒绝的 JSON 落盘。
