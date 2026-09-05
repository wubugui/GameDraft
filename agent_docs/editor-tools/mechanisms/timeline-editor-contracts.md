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
  - tools/editor/tests/test_cutscene_step_disable.py
  - tools/editor/tests/test_cutscene_validation_report.py
last_governed: 2026-08-05
---

## 是什么(一句话)

主编辑器"过场"页:主面板 + 大纲行(懒建详情)+ 展开详情表单三层;运行时/剧情编排语义见 runtime 域过场机制卡。

## 权威源(读代码从哪进)

`tools/editor/editors/timeline_editor.py`。

## 硬契约

1. **任何 UI/交互改动不得改 `StepWidget.to_dict()` 的序列化输出**——逐字节往返测试守护;"全部展开"必须仍能完整展开(测试靠它走控件路径)。
2. **禁用态是大纲行的状态,不是表单字段**(2026-08-12):开关在 `StepOutlineFrame`
   (行上「禁」按钮 + 步菜单),`StepWidget` 只负责**带着走**(`to_dict` 重建整份 dict,
   不显式续写就静默抹掉——批量对白对话框展开行同理)。禁用写 `disabled: true`,
   启用**删键**不写 `false`。构造期回填按钮状态必须 `blockSignals`,否则"打开即脏"。
   新建/继承模板的句子一律 `pop("disabled")`——新内容不许生来就是禁用的。
3. **已有能力勿重复造**:步骤级搜索/过滤 + 命中跳转、结构操作前整树快照的撤销/重做、跨过场剪贴板、切类型前的清空确认、并行子轨分层编号、展开/滚动态按过场 id 记忆——改造前先盘点再动手。
   **校验侧现有:可见可点跳的问题清单 + 逐行归因(含参数引用类问题)+ 层级步号**。
   此前逐行通道**不扫参数引用**,而现网唯一在报的恰是这一类 ⇒ 问题只在状态区出个条数、
   正文只活在 tooltip 里,**用户眼中是"报了问题但看不见问题"**;别再当"没有"去重造,
   也别以为落行标记天然覆盖全部问题类型——**逐行通道扫哪几类是显式开关,加校验类别时要一起开**。

## 已知坑(改这文件务必记住)

1. **重排大纲列表必须保「+ Track」按钮在末尾**:并行布局里除子轨还有常驻按钮,重排/粘贴后要把其它控件补回末尾(用 `is` 比较,不碰可能已析构的 C++ 对象)。
2. **结构操作后必重跑过滤**:凡直接改大纲列表的操作都要走统一的重排索引入口(尾部会重放过滤),否则搜索命中残留已 deleteLater 的悬空引用,导航时崩溃。
3. **"用户手势 → 坐标"的断言一律别用等值比较**(测试纪律,画布类编辑器通用):
   经视图变换换算出来的增量,**基准量级不同就不是同一个浮点数**
   (`(160+96.1)-160 = 96.10000000000002` 而 `(100+96.1)-100 = 96.1`)。
   这类断言**单跑绿、整套红**——前面任何一条用例改了画布缩放就翻车,查起来极贵。
   一律按容差比。
4. **重排布局严禁 `takeAt()` 后把同一控件重新 addWidget**(PySide 级深坑):QWidgetItem 所有权交给 Python 包装,其延迟析构会把控件的 `widgetItem` 清空 → 此后 `updateGeometry()` 打不穿布局项的 heightForWidth 缓存 → 移动/粘贴一次后"展开详情"不再撑高容器,行被压成细条。修法 = C++ 侧同步删建的 `removeWidget`+`insertWidget`。诊断:看 `layout.sizeHint()`(新)与 `layout.totalSizeHint()`(旧)是否分叉。销毁路径的 takeAt(取出即 deleteLater)无此问题。

## 怎么验证

`tools/editor/tests/test_cutscene_roundtrip_fidelity.py` + 素材审计 + `./dev.sh validate-data`(见 [验证门配方](../recipes/editor-change-verification-gate.md))。
