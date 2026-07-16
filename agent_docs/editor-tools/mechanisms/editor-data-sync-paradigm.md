---
id: editor-data-sync-paradigm
title: 画布/表单编辑器数据零丢失范式
domain: editor-tools
type: mechanism
summary: 单一真相源 + 即时入脏 + commit-on-leave + 懒回写按身份;门控只认 pending 信号的路径(deselect/新增/点空白)是静默丢编辑的惯性破口
status: active
authority:
  - tools/editor/editors/scene_editor.py#_commit_pending_scene_edits
triggers:
  paths: ["tools/editor/editors/*"]
  topics: [commit-on-leave, 单一真相源, 数据丢失, staging, Apply]
  tasks: [改画布编辑器, 改表单编辑器, 加编辑器字段]
verified_by:
  - tools/editor/tests/test_canvas_roundtrip_safety.py
  - tools/editor/tests/test_form_editor_persistence.py
last_governed: 2026-07-11
---

## 是什么(一句话)

全部画布/表单编辑器统一的数据同步范式(2026-06-20 全量重构确立),目的是"编辑在任何离开路径上都不丢":别再退回"只 Apply 才落库"的割裂写法。

## 权威源(读代码从哪进)

- 样板实现:`tools/editor/editors/scene_editor.py`(staging 解析器、`_mark_canvas_edit`、`_commit_pending_scene_edits`)
- 设计文档:`artifact/Design/canvas-editor-architecture-2026-06-20.md`

## 硬契约

1. **单一真相源**:实体几何/位置,画布渲染、动画定时器、保存读同一处解析器(编辑中读 staging、其它读模型);定时器不得直读已提交模型,否则精灵被周期性拍回旧位。
2. **编辑即时入脏**:画布手势走统一入口(mark_dirty + 未应用提示),不攒到 Apply。
3. **commit-on-leave**:切条目/切场景前提交 staging;`confirm_close` 让关闭/切工程门控先提交;Apply 重建列表后用 id 重定位 + `_suppress` 防递归。
4. **画布是模型投影**:数值框改坐标要让图元跟随;画布项原地更新而非删-重建。
5. **懒回写按身份不按行号**:延迟写回认实体 dict 身份(owner 引用),防删除/重排串台。

## 已知坑(审查证实的系统性破口)

- commit-on-leave 若以 `_pending_dirty` 为唯一门控:不置脏的控件、清脏的路径(deselect、"+新增"、点画布空白)= 静默丢编辑——加新离开路径时必须先过提交。
- 以表单为真相源做 commit-on-leave:表单与模型脱节(拖拽后/残留旧值)时会反向污染模型。
- 新建 id 用 `len(列表)` 命名的家族:删中间项后再新建必撞 id。

## 怎么验证

- 黄金往返 `test_canvas_roundtrip_safety.py`(真实工程全 JSON 加载→save_all→重载语义零变化)+ `test_form_editor_persistence.py`(编辑→切条目/Save All 不丢)。
- 盲区与流程探针见 [验证门配方](../recipes/editor-change-verification-gate.md)。
