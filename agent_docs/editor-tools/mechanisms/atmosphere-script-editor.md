---
id: atmosphere-script-editor
title: 转盘氛围脚本编辑器
domain: editor-tools
type: mechanism
summary: 递归指令列表编辑器(RPGMaker-event 式,非 DSL/树);复用 ActionEditor 的范式不复用控件;to_list 输出必须与独立轻量运行时逐字段一致
status: active
authority:
  - tools/editor/editors/atmosphere_script_editor.py
  - src/systems/sugarWheel/sugarWheelAtmosphere.ts
triggers:
  paths: ["tools/editor/editors/atmosphere_script_editor.py", "tools/editor/editors/sugar_wheel_editor.py"]
  topics: [氛围脚本, 糖画转盘, atmosphereGroups]
  tasks: [改转盘氛围脚本编辑器, 加氛围指令 op]
verified_by:
  - tools/editor/tests/test_sugar_wheel_atmosphere_preserve.py
last_governed: 2026-07-11
---

## 是什么(一句话)

糖画转盘 `atmosphereGroups[].{start,spinning,slowing,stop}` 的编辑器:每条指令一行、`chance`/`when_near_sector` 在行下缩进挂 then/else 子列表的递归控件,挂在转盘编辑器四个阶段标签页里。

## 权威源(读代码从哪进)

- 编辑器:`tools/editor/editors/atmosphere_script_editor.py`(AtmosphereScriptEditor)
- 消费方:`src/systems/sugarWheel/sugarWheelAtmosphere.ts`(**独立轻量运行时,不是 ActionExecutor**)

## 硬契约

1. `to_list()` 产出的 step 结构必须与运行时逐字段一致(pool/text/durationMs/slot/sec/p/sectorId/degBuffer/then/else),数据格式不变。
2. **复用 ActionEditor 的范式(rows + set_data/to_list/changed),不复用那个控件**——取舍与被否方案见 [决策记录](../decisions/2026-07-01-atmosphere-script-standalone.md),别再纠结 DSL/树/并入 action 系统。
3. `say` 的「随机抽池」与「固定台词」靠 `〔池〕xxx` 标记项区分,读回靠文本比对而非 currentIndex;改名文案池必须经 `_rename_pool_refs` 递归传播到引用它的步骤。

## 已知坑

- 氛围 op 与通用 action 语义不同(`when_near_sector`/`pick` 是 wheel 专属)——别把它们登进 `ACTION_TYPES` 或让 ConditionEditor 管。

## 怎么验证

`tools/editor/tests/test_sugar_wheel_atmosphere_preserve.py`(真盘 read==stored 全等)+ 黄金往返 `test_canvas_roundtrip_safety.py`。
