---
id: timeline-editor-contracts
title: 过场步骤编辑器(TimelineEditor)契约
domain: editor-tools
type: mechanism
summary: UI/交互改动不得改 StepWidget.to_dict 序列化输出;已有搜索/撤销/剪贴板等能力勿重复造;含一个 PySide takeAt 布局级深坑
status: active
authority:
  - tools/editor/editors/timeline_editor.py
triggers:
  paths: ["tools/editor/editors/timeline_editor.py"]
  topics: [过场编辑器, TimelineEditor, StepWidget, takeAt]
  tasks: [改过场步骤编辑器, 加过场步骤类型或字段]
verified_by:
  - tools/editor/tests/test_cutscene_roundtrip_fidelity.py
last_governed: 2026-07-11
---

## 是什么(一句话)

主编辑器"过场"页:`TimelineEditor`(主面板)/ `StepOutlineFrame`(大纲行,懒建详情)/ `StepWidget`(展开详情表单);2026-07-06 长过场可用性改造后的形态。

## 权威源(读代码从哪进)

`tools/editor/editors/timeline_editor.py`;运行时/剧情编排语义见 runtime 域过场机制卡。

## 硬契约

1. **任何 UI/交互改动不得改 `StepWidget.to_dict()` 的序列化输出**——逐字节往返测试守护;`_set_all_step_collapsed(False)` 必须仍能完整展开(测试靠它走控件路径)。
2. **已有能力勿重复造**:步骤级搜索/过滤+命中跳转、结构操作前整树快照的撤销/重做、跨过场剪贴板、切 kind/present 类型前的清空确认、校验结果落行标记、并行子轨分层编号、展开/滚动态按过场 id 记忆。改造前先盘点再动手。

## 已知坑(改这文件务必记住)

1. **`_relayout_outline_list` 必须保「+ Track」按钮在末尾**:并行布局里除子轨还有常驻按钮,重排/粘贴子轨后要把其它控件补回末尾(用 `is` 比较,不碰可能已析构的 C++ 对象)。
2. **结构操作后必重跑过滤**:凡直接改 `_step_outlines` 的操作都要走 `_refresh_outline_indices_and_zebra`(尾部已调 `_reapply_step_filter_if_active`),否则搜索命中残留已 deleteLater 的悬空引用,导航时崩溃。
3. **重排布局严禁 `takeAt()` 后把同一控件重新 addWidget**(PySide 级深坑):QWidgetItem 所有权交给 Python 包装,其延迟析构会把控件的 `QWidgetPrivate::widgetItem` 清空 → 此后 `updateGeometry()` 打不穿布局项的 heightForWidth 缓存 → 移动/粘贴一次后"展开详情"不再撑高容器,行被压成细条。修法 = C++ 侧同步删建的 `removeWidget`+`insertWidget`。诊断:对比 `layout.sizeHint()`(新)与 `layout.totalSizeHint()`(旧)是否分叉。销毁路径的 takeAt(取出即 deleteLater)无此问题。

## 怎么验证

`tools/editor/tests/test_cutscene_roundtrip_fidelity.py` + 素材审计 + `./dev.sh validate-data`(见 [验证门配方](../recipes/editor-change-verification-gate.md))。
