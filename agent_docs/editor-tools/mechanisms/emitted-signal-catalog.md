---
id: emitted-signal-catalog
title: 信号发射源权威口径(emitted_signal_ids)
domain: editor-tools
type: mechanism
summary: 哪些容器算"实发信号":对话图+内容资产动作树+叙事图 onEnter/onExitActions+broadcastOnEnter 派生,外加配置里写信号名、系统代发的面(血量威胁 / 可燃宿主);blackbox meta.emits 只是声明不算实发;悬垂监听/空声明全 warning
status: active
authority:
  - tools/editor/shared/narrative_catalog.py#emitted_signal_ids
  - tools/editor/validator.py
  - tools/narrative_editor_web/src/NarrativeEditorApp.tsx
  - tools/narrative_xref/README.md
triggers:
  paths: ["tools/editor/shared/narrative_catalog.py", "tools/narrative_editor_web/**", "tools/narrative_xref/**"]
  topics: [悬垂监听, emitted_signal_ids, 信号目录, TaskBusPanel, meta.emits, danglingSignalNoEmit, 悬垂发射, 信号关系, xref]
last_governed: 2026-09-23
---

## 是什么(一句话)

全项目"已发射信号"目录的唯一权威口径:`narrative_catalog.emitted_signal_ids`(创作/校验期内存计算,非落盘产物);网页 TaskBusPanel 与 validator 悬垂检查都以它为准。

## 权威源(读代码从哪进)

`tools/editor/shared/narrative_catalog.py` 的 `emitted_signal_ids`(扫描)与 `_derived_broadcast_signals`(派生);消费方 `tools/editor/validator.py` 与网页 `NarrativeEditorApp.tsx`。

**"按信号反查两侧(谁发 / 谁听)"只有一个入口:共享扫描引擎 `tools/narrative_xref`**——
它把两侧连同派生信号的上游因果、条件叶的读状态算成一份可跳转的索引,
**编辑器的信号关系面板 / 叙事调试器窗 / MCP 信号查询三处共用它**,别再各写一份扫描。
本卡的口径与它有 parity 测试对账,口径分叉即 bug。

## 硬契约

- **实发四源**(深遍动作树认 `emitNarrativeSignal`,容器无关):①对话图 `graphs/*.json`(逐文件读盘);②内容资产动作树(登记面 `_EMIT_SOURCE_ATTRS`,与改名 / xref 的发射面表三方对账——新宿主怎么登见 [动作宿主字段登记面](action-host-fields.md));③叙事图 states 的 onEnter/onExitActions(运行时真执行);④派生广播——仅 `broadcastOnEnter===true` 的 state 产 `state:<图id>:<状态id>`。
- **另有不是动作树形状的实发面**,在同一趟深遍里逐层问:血量威胁配置里的信号、宿主身上可燃配置的信号
  (`burnable.signals`,热点 / NPC / 挂件预设 / 轨迹生成物规格;运行时由燃烧系统真发)。
  新增这类"配置里写信号名、系统代发"的面,**目录、xref、改名级联三处要用同一个探测函数**(照 `health_refs.health_signal_fields` /
  `narrative_catalog.burnable_host_signal_fields` 的样子写一个),口径才天然一致。
- **blackbox `meta.emits` 不算实发**(是声明):单独收成 declared_emits,驱动"声明了没人真发"检查。
- 监听侧"有人发"集合 = 实发 ∪ declared_emits,网页与 CLI validator 必须同口径(parity 即契约);悬垂监听是 **warning**(放行"先接线后写对话")。

## 已知坑

- meta.emits 会**压掉**监听侧的悬垂警告,自己却持续报空声明——黑盒声明不是修悬垂的办法。
- 对话图逐文件读盘:未保存的编辑不进目录;目录一次性算好,非实时。
- 全局配置只登记成**条件面**:它的动作(玩家动作落空时那组)里若发信号,目录与改名级联都看不见。
- **flow 状态广播只被条件叶子消费时,运行时红条与静态 unused 检查仍会报"没人听"**——这两处口径只认 transition 监听、不数条件叶子读。属已知噪声,非数据 bug(勿据此乱改数据);**要确认是不是真没人听,去信号关系面板**,它会同时列出读状态的地方。

## 怎么验证

`./dev.sh validate-data` 看悬垂监听 warning;网页 TaskBusPanel 与 CLI 结果应一致;
`sh scripts/py.sh -m tools.narrative_xref --problems` 一眼看出两侧对不齐的信号;
单条信号用命令通道 emitNarrativeSignal 实发核对。
