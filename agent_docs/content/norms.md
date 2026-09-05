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
last_governed: 2026-08-05
---

# 内容制作规范(策划模式)

适用:一切做内容/只改 JSON 的工作。工作形状见
[production-mode-workflow](methods/production-mode-workflow.md)。

## 不变量

**三红线**
1. **代码默认只读、只写 JSON**;唯一例外是 L2 新增能力原语
   ([l2-action-primitive-registration](mechanisms/l2-action-primitive-registration.md))。
2. **写不出来就升级/上报,不糊弄**:禁偷改业务代码绕机制、禁假数据/空实现敷衍、
   禁把动作硬塞进不该去的结构。
3. **JSON 必须保持"编辑器可往返"**:agent 直接改 JSON,人类仍只经编辑器维护
   ([editor-roundtrip-contract](mechanisms/editor-roundtrip-contract.md))。

**机制通道唯一**
4. 行为走 command、成段演出走 cutscene(内禁改存档、只用白名单 action)、条件走统一
   条件表达式、对话分支走图对话 graph、玩家可见文本走 `[tag:…]`。**通道外的写法运行时
   被静默跳过、或被编辑器/校验器拒存**
   ([content-expression-channels](mechanisms/content-expression-channels.md))。

**题材/文案铁律**
5. **西南口音**:所有角色对白只能西南官话渝都腔,禁北方腔
   ([chongqing-dialect-voice](mechanisms/chongqing-dialect-voice.md))。
6. **每拍可玩**:demo 每一拍玩家必须真动手,不准降成播字/过场。
7. **写实中透异常**:民俗志怪落写实底子,严禁玄幻发光/魔幻奇观式表现。
8. **冷信号纪律**:阿秀信号(香粉味/小调)只在濒死/定点显形;系统常驻≠信号常见。

**玩法设计铁律**(制作人拍板)
9. 机制必须高频占用玩家注意力——**判据是"持续自我再生的误差,只有玩家的手能抹平"**;
   "设好就不管/闭眼玩"与"系统替玩家做"是废案红线(只满足"高频点击"不算,刷点击条/QTE 已被否)。

## 过程义务

1. **开工先认权威**:寻狗 demo 内容以四权威源为准、废弃归档一律死档勿信
   ([文档权威决策](decisions/2026-06-27-xungouji-doc-authority.md))。
2. L2 升级完成后报告动了哪些登记面;L3 跳过的任务收尾统一汇报。
3. **偏差记录义务**:发现现实与本库文档打架或超出,收尾向 `agent_docs/_meta/inbox/`
   丢一条三行偏差记录(零门槛,格式见该目录 README)。

## 验收门

素材引用审计 + 全量数据校验两道,每次改完 JSON 必跑;判据=审计零问题、`validate-data`
零 error 且警告数不增加,warning 逐条看——**不能"没 error 就当对了"**。
命令、退出码与校验盲点见 [content-validation-gate](recipes/content-validation-gate.md)。

## 红线

- 内容(物件名/规矩名/NPC/任务 ID/对话文本)硬编码进代码;
- cutscene 内改存档;
- 写 deprecated 字段、往重建区塞自定义字段;
- 落到编辑器盲区字段闷头手写不上报(那是 L2 升级信号);
- 保存会被编辑器 raise 拒绝的 JSON 落盘。

> **本域最贵的失败形状:写了、存下了、跑起来什么也没发生**(2026-09-03 盲重建逐点核过)。
> 它分两档,**判读方式不同**:
>
> - **连一句控制台输出都没有**的一档:给不存在的规矩/层发放、接受一个不存在的任务
>   (会写进一条悬空状态)、几个档案子域的加载 `catch` 是空的(数据一坏,那本册子**悄悄变空**)、
>   过场步骤的"禁用"标记写成非严格布尔值时**照常播放**、不匹配任何已知模式的 `[tag:…]` 串
>   **原样显示给玩家**。这一档**靠看控制台是发现不了的**,只能靠校验门和真跑。
> - **只有控制台告警**的一档(对不看控制台的作者等同于静默):未登记/类型不符的 flag 追加、
>   非建议值的 phase status、未知的实体运行时字段。
>
> 还有一类是**写了但根本没人读**的字段(任务的分组与支线类型、规矩层的锁定提示、
> 物品标签等)——它们有的还有 error 级校验守着,**校验通过 ≠ 它有用**。
> 拿不准某个键到底有没有消费者,以 `src/data/types.ts` 与其消费方为准,别以编辑器有没有那一栏为准。
