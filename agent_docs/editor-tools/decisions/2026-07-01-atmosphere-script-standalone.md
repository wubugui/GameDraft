---
id: atmosphere-script-standalone
title: 氛围脚本编辑器独立实现(不复用 ActionEditor 控件)
domain: editor-tools
type: decision
summary: 转盘氛围脚本用递归指令列表独立编辑器;复用 ActionEditor 的范式不复用控件;氛围 op 不并入通用 action 系统
status: active
triggers:
  topics: [氛围脚本, ActionEditor 复用, 糖画转盘]
last_governed: 2026-07-11
---

## 背景(一段)

糖画转盘的旋转氛围脚本(`atmosphereGroups[].{start,spinning,slowing,stop}`)需要结构化编辑,op 集(say/pick/wait/chance/when_near_sector)跑在独立轻量运行时 `src/systems/sugarWheel/sugarWheelAtmosphere.ts` 上,含 wheel 专属语义(近扇区条件、池抽取),通用 action 系统没有对应物。

## 决定(一句)

用 RPGMaker-event 式可嵌套递归指令列表实现独立编辑器(`atmosphere_script_editor.py`),**复用 ActionEditor 的范式(rows + set_data/to_list/changed),不复用那个控件**。

## 被否方案(列表,防翻案)

- 直接复用 `ActionEditor` 控件——它死绑 `ACTION_TYPES`,无法承载 wheel 专属 op。
- 把氛围 op 注册进真 action 系统再用 ActionEditor——要动运行时(L3 级改动),且氛围运行时刻意轻量,已否决。
- 文本 DSL / 树形编辑——对策划不如逐行指令列表直观,未采用。
