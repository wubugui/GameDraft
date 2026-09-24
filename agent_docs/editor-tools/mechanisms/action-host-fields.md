---
id: action-host-fields
title: 动作宿主字段登记面
domain: editor-tools
type: mechanism
summary: "哪个 JSON 字段装着动作列表"在工具侧散在十来张手写清单里(校验器调用点 / 嵌入引用 / 信号发射面三表 / flag 与任务引用扫描 / 改名级联…),只有信号发射面三表互相对账;新宿主漏登哪张,那张背后的检查就对它整片缺席且零报错
status: active
authority:
  - tools/editor/validator.py#_walk_action_defs
  - tools/editor/shared/ref_validator.py#validate_all_embedded_refs
  - tools/editor/shared/narrative_catalog.py#_EMIT_SOURCE_ATTRS
  - tools/editor/shared/signal_refactor.py#EMIT_SOURCE_BUCKETS
  - tools/narrative_xref/sources.py#ASSET_SPECS
triggers:
  paths: ["tools/editor/validator.py", "tools/editor/shared/ref_validator.py", "tools/editor/shared/narrative_catalog.py", "tools/editor/shared/signal_refactor.py", "tools/narrative_xref/sources.py"]
  tasks: [新增带动作列表的字段, 新数据域带动作, 新小游戏动作钩子]
  topics: [动作宿主, 动作扫描面, 发射面, EMIT_SOURCE_BUCKETS, 宿主清单]
verified_by:
  - tools/editor/tests/test_signal_refactor.py
  - tools/editor/tests/test_held_prop_editor_surfaces.py
last_governed: 2026-09-23
---

## 是什么(一句话)

动作列表可以挂在二十多类数据字段上(场景 / 热区 / 区域事件、任务与遭遇奖励、对话图节点、叙事状态进入动作、
过场、压力条、信号提示、各小游戏钩子、物品用途、线索采集、挂件预设状态、档案首看、全局配置…)。
**"哪些字段是宿主"没有唯一登记表**,每个工具各抄一份;加一个新宿主字段 = 手工逐张登记。

## 权威源(读代码从哪进)

- 校验器:`_walk_action_defs` 的各处**手写调用点**(按数据类型分散在各 `_validate_*` 里)。
- 嵌入引用:`ref_validator.validate_all_embedded_refs` 的手写宿主列表。
- 信号发射面三表:`narrative_catalog._EMIT_SOURCE_ATTRS`、`signal_refactor.EMIT_SOURCE_BUCKETS`(+ 只读面
  `READONLY_SOURCES`、条件面 `CONDITION_EXTRA_SOURCES`)、`narrative_xref.sources.ASSET_SPECS`——**三表互相对账**。
- 其余手写清单(**无对账**):图对话改名级联、flag 引用扫描、任务引用扫描、动作登记表页、全工程 flag 汇总、叙事页资产遍历。

## 硬契约

- 新宿主字段至少登记:校验器调用点、嵌入引用、信号发射面三表;再逐张核上面"无对账"那批——漏哪张,
  那张背后的功能(改名级联 / 引用计数 / flag 汇总…)对它就**静默少算**。
- 动作树下钻一律读 [容器槽位登记表](../../runtime/mechanisms/action-registration-registry-surfaces.md);
  宿主清单只管"从哪个字段进",不要在宿主遍历里再手写容器分支。
- 只读数据面(主编辑器只加载不保存的宿主)进 `READONLY_SOURCES`:扫描要看得见,重构必须拒绝改写。
- 方向:最终应让 `EMIT_SOURCE_BUCKETS` 成为"动作宿主域"的唯一入口,其余清单读它或配对账(editor-tools 不变量 8)。
  在那之前,**新增宿主时顺手给碰到的手写清单补对账,别再多抄一份**。

## 已知坑(2026-09-23 探针实测)

- 下列宿主里的动作 `validate-data` **完全不检查**(未知类型 / 引用 / flag / 容器下钻全缺席),运行时却真执行:
  压力条的中止收场动作、糖画转盘实例的几组充能动作、全局配置里玩家动作的落空动作。
  叙事图状态的进入动作也不走校验器(由 TS 叙事校验与叙事页保存兜底负责)。
- 全局配置在信号表里只登记成**条件面**:它的动作里发出的信号在信号目录与改名级联里都看不见。
- 手写清单已各自漂开过:flag / 任务引用扫描漏过线索注册表,flag 汇总曾不扫物品用途,叙事页资产遍历漏物品 / 线索 / 挂件预设。
- 宿主字段表键写错**零报错**(`getattr` 兜 None 静默跳过整份数据);`test_refactor_source_tables_resolve*` 逐键断言,
  新表照这个样子配。

## 怎么验证

往新宿主里塞一条未知类型 / 悬垂引用 / 发信号的动作,分别看 `validate-data`、信号关系面板、改名级联是否都看得见它;
`test_signal_refactor.py` 的发射面对账;样板 `test_held_prop_editor_surfaces.py` 的"去掉登记即红"写法。
