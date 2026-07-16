---
id: shared-widget-value-fidelity
title: 共享选择器控件的保值契约
domain: editor-tools
type: mechanism
summary: IdRefSelector 等共享控件被约 40 处调用点依赖——未知/悬垂值必须保值展示而非静默顶替或清空;一处控件破坏 = 全编辑器数据面污染
status: active
authority:
  - tools/editor/shared/id_ref_selector.py
  - tools/editor/shared/qt_combo_wheel_guard.py
triggers:
  paths: ["tools/editor/shared/id_ref_selector.py", "tools/editor/shared/action_editor.py", "tools/editor/shared/qt_combo_wheel_guard.py"]
  topics: [IdRefSelector, 悬垂引用, select_only, 保值, 滚轮误改]
  tasks: [改共享选择器控件, 把裸输入框换成选择器]
last_governed: 2026-07-11
---

## 是什么(一句话)

`tools/editor/shared/` 下的选择器控件是全编辑器复用件,它们对"数据里已有但候选清单里没有的值"的处理方式,决定了打开旧数据是否安全。

## 权威源(读代码从哪进)

- `tools/editor/shared/id_ref_selector.py`(id 引用选择器)
- `tools/editor/shared/action_editor.py`(`FilterableTypeCombo(select_only)` 的未知值注入)
- `tools/editor/shared/qt_combo_wheel_guard.py`(全局滚轮误改防护,`__main__.py` 安装)

## 硬契约

1. **未知值保值**:候选清单里找不到当前值时,必须保留原值展示(标记为未知即可),**禁止**静默顶替成第一候选或清空——这曾是 P0(悬垂引用一开面板即被改写,约 40 调用点受影响);在控件层修一次覆盖全部调用点,是最高杠杆位。
2. **select_only 组合框接旧数据**:把裸输入换成 `FilterableTypeCombo(select_only=True)` 时,未知旧值以「(数据) 」前缀条目注入候选,保证旧值不因换控件而丢。
3. **候选一律取自 ProjectModel 的 id-provider**(all_scene_ids 等),不自建清单;选定父项后刷新子候选(选 scene 刷 spawn、选 actor 刷动画 state)。控件目录见 `.cursor/skills/editor-tools-iteration/SKILL.md` §2.1。

## 已知坑

- 滚轮误改:主编辑器有全局 combo 滚轮 guard,但 QSpinBox 不在防护内、独立小工具(未走 `tools/editor/__main__.py` 启动)未安装——评估滚轮风险时别以为全覆盖。
- 未登记 flag 的数值条件曾被 bool 化(类型查询兜底到 "bool")——涉及 flag 类型推断的控件要考虑未登记键。

## 怎么验证

- `tools/editor/tests/test_action_condition_data_safety.py`(悬垂/未知值保值场景);改控件后跑黄金往返 + [验证门配方](../recipes/editor-change-verification-gate.md)。
