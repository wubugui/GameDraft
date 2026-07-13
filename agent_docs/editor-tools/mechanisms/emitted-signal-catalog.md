---
id: emitted-signal-catalog
title: 信号发射源权威口径(emitted_signal_ids)
domain: editor-tools
type: mechanism
summary: 哪些容器算"实发信号":对话图+内容资产动作树+叙事图 onEnter/onExitActions+broadcastOnEnter 派生;blackbox meta.emits 只是声明不算实发;悬垂监听/空声明全 warning
status: active
authority:
  - tools/editor/shared/narrative_catalog.py#emitted_signal_ids
  - tools/editor/validator.py
  - tools/narrative_editor_web/src/NarrativeEditorApp.tsx
triggers:
  paths: ["tools/editor/shared/narrative_catalog.py", "tools/narrative_editor_web/**"]
  topics: [悬垂监听, emitted_signal_ids, 信号目录, TaskBusPanel, meta.emits, danglingSignalNoEmit, 悬垂发射]
last_governed: 2026-07-13
---

## 是什么(一句话)

全项目"已发射信号"目录的唯一权威口径:`narrative_catalog.emitted_signal_ids`(创作/校验期
内存计算,非落盘产物);网页 TaskBusPanel 与 validator 悬垂检查都以它为准。

## 权威源(读代码从哪进)

`tools/editor/shared/narrative_catalog.py` 的 `emitted_signal_ids`(扫描)与
`_derived_broadcast_signals`(派生);消费方 `tools/editor/validator.py`(悬垂监听
warning)与 `NarrativeEditorApp.tsx`(danglingEmitDeclared / danglingSignalNoEmit)。

## 硬契约

- **实发四源**(深遍动作树认 `type=='emitNarrativeSignal'`,容器无关):①对话图
  `graphs/*.json`(逐文件读盘);②内容资产动作树(scenes/quests/encounters/cutscenes/
  pressure_holds/signal_cues/archive_*/小游戏实例,登记面 `_EMIT_SOURCE_ATTRS`);
  ③**叙事图 states 的 onEnter/onExitActions**(运行时 `NarrativeStateManager.runActions`
  真执行,2026-07-13 修复前曾漏扫致悬垂误报);④派生广播——仅 `broadcastOnEnter===true`
  的 state 产 `state:<图id>:<状态id>`。
- **blackbox `meta.emits` 不算实发**(是声明):单独收成 declared_emits,驱动
  `danglingEmitDeclared`(声明了没人真发)检查。
- 监听侧"有人发"集合 = 实发 ∪ declared_emits,网页与 CLI validator 必须同口径(parity
  即契约);悬垂监听是 **warning**(放行"先接线后写对话")。

## 已知坑

- meta.emits 会**压掉**监听侧的 danglingSignalNoEmit 警告,自己却持续报空声明——黑盒
  声明不是修悬垂的办法。
- 对话图逐文件读盘:未保存的编辑不进目录;目录在 loadAuthoringCatalog 时算一次,非实时。
- **flow 状态广播只被条件叶子消费时,运行时红条(signal.unlistened)与静态
  state.broadcast.unused 都会报**——两侧口径都只认 transition 监听,不数条件叶子读。
  按现行口径属已知噪声,非数据 bug(勿据此乱改数据)。

## 怎么验证

`./dev.sh validate-data` 看悬垂监听 warning;网页叙事编辑器 TaskBusPanel(📡/📣)与
CLI 结果应一致;单条信号用命令通道 emitNarrativeSignal 实发核对。
