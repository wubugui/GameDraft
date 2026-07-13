---
id: mainwindow-editor-hooks
title: 主窗口编辑器接入钩子(鸭子协议)
domain: editor-tools
type: mechanism
summary: 主窗门控靠 getattr 鸭子协议调 flush_to_model/confirm_close/reload_refs_from_model——新编辑器缺钩子不报错、静默漏网,接入时必须逐项对齐
status: active
authority:
  - tools/editor/main_window.py#reload_refs_from_model
  - tools/editor/project_model.py#KNOWN_DIRTY_BUCKETS
triggers:
  paths: ["tools/editor/main_window.py", "tools/editor/editors/*"]
  topics: [新编辑器接入, reload_refs_from_model, 鸭子协议, 跨面板刷新]
  tasks: [新增编辑器面板, 给编辑器加跨域 id 选择器]
last_governed: 2026-07-11
---

## 是什么(一句话)

主窗口对各面板的保存/关闭/刷新门控全部经 getattr 鸭子调用——钩子缺失不是错误而是静默跳过,这是"新编辑器漏保存/候选过期"类 bug 的系统性根因(审查实证:曾有两个编辑器因缺钩子漏网)。

## 权威源(读代码从哪进)

- `tools/editor/main_window.py`:钩子调用点(closeEvent、save_all 前 flush、`_stack.currentChanged` → 激活页 `reload_refs_from_model`)
- `tools/editor/project_model.py`:load / save_all / 脏桶登记

## 硬契约(新编辑器接入清单)

1. 在 `main_window.py` 注册页面 + 在 `project_model.py` 对齐 load / save 分支 / 命名脏桶(见 [save_all 与脏桶](save-all-dirty-buckets.md))。
2. 实现 `flush_to_model`(门控真实变更)与 `confirm_close`(Discard 中和)——契约见 [关闭路径卡](close-path-flush-discard.md)。
3. **有引用他域 id 的顶层选择器就必须实现 `reload_refs_from_model()`**:只 `set_items` 重拉候选(set_items 自带缓存跳过 + 保留当前值),**不要**重置表单字段。根因:`IdRefSelector.set_items` 是静态快照,别处新增的 id 不切页重拉就看不见;FlagPickerDialog 与 ActionEditor 是开时 live 拉取,不用加。
4. 走 staging 暂存的编辑器照 item 编辑器样板补齐 staging 钩子,Apply 就地写 entry 保未知键。

## 已知坑

- `_editor_instances` 与 stack 页前缀对齐(末尾的浏览页不入列表)——插页顺序错了鸭子调用会打到错的编辑器。
- 已有 showEvent + data_changed 自刷新的面板不要再叠加 reload_refs_from_model(双重刷新)。

## 怎么验证

- 离屏构造冒烟:`QT_QPA_PLATFORM=offscreen .tools/venv/bin/python -m unittest tools.editor.tests.test_all_editors_construct`。
- 流程探针:编辑 → 切页/关闭 → 断言模型;模型层测试全绿不代表门控接对了(审查教训:425 测试全绿但流程层零覆盖)。
