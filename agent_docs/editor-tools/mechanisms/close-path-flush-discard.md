---
id: close-path-flush-discard
title: 关闭路径的 Discard 中和与 flush 门控
domain: editor-tools
type: mechanism
summary: 主窗口关闭 = 逐页 confirm_close → 统一 flush_to_model;Discard 必须把 UI 回滚到模型值,flush 必须门控真实变更,否则被放弃的编辑复活或零编辑伪脏
status: active
authority:
  - tools/editor/main_window.py#_flush_editors_to_model
triggers:
  paths: ["tools/editor/main_window.py", "tools/editor/editors/*"]
  topics: [confirm_close, Discard, flush_to_model, 伪脏, 关闭路径]
  tasks: [改编辑器关闭或保存流程, 给编辑器加确认弹窗]
verified_by:
  - tools/editor/tests/test_close_path_flow.py
last_governed: 2026-07-11
---

## 是什么(一句话)

主窗口关闭/切工程对所有面板执行「逐页 `confirm_close` → 统一 `flush_to_model`」;这个顺序衍生出两条族性契约(覆盖全部约 12 个编辑器),任一面板违反即丢数据或伪脏。

## 权威源(读代码从哪进)

- `tools/editor/main_window.py` 的 closeEvent → `_flush_editors_to_model`(顺序定义处)
- 各编辑器自己的 `confirm_close` / `flush_to_model` 实现

## 硬契约

1. **Discard 必须中和**:`confirm_close` 的 Discard 分支必须把 UI 回滚到模型值(调本编辑器的重填方法:`_on_select(当前项)` / `_load()` / `_refresh()` 之类)。因为 Discard 之后还会统一 flush,flush 按「UI≠模型」判脏——不中和就把被放弃的编辑重新提交。
2. **flush 必须门控真实变更**:`flush_to_model` 要么门控在本编辑器自己的 pending/dirty 信号上,要么做写回前后内容 diff;**绝不能无条件 `mark_dirty`**,否则「打开啥都没动直接关」也弹保存。
3. **flush 语义特殊的面板别照抄通用中和**:图对话 tab 的 Discard 走 `discard_unsaved_changes()`(它的 flush 语义是直接写盘);叙事状态机编辑器 Discard 走整页 reload(markSaved 只清标志,内容 diff 仍会重提交);rule 编辑器重填须包 `_suppress_commit`(其碎片选择槽会在重填中先提交)。

## 已知坑

- 离屏探针下 QWebEngine 类编辑器(叙事)会因页面未渲染回吐空文档而"看似伪脏"——离屏假象,真机干净加载时门控放行,别当 bug 去修。

## 怎么验证

- `tools/editor/tests/test_close_path_flow.py`:编辑 → Discard → flush → 断言模型不变。
- 伪脏定位法:离屏构造 MainWindow,拦截 `ProjectModel.mark_dirty` 打调用栈,逐 editor 跑 `flush_to_model(for_save_all=True)`,看谁在零编辑时标脏。

相关:[save_all 两阶段写与脏桶](save-all-dirty-buckets.md)、[主窗口编辑器接入钩子](mainwindow-editor-hooks.md)。
