---
id: mainwindow-editor-hooks
title: 主窗口编辑器接入钩子(鸭子协议)
domain: editor-tools
type: mechanism
summary: 主窗门控靠 getattr 鸭子协议调 flush_to_model/confirm_close/reload_refs_from_model/commit_pending_on_leave/editor_undo——缺钩子不报错、静默漏网,签名跑偏同样静默,接入时必须逐项对齐
status: active
authority:
  - tools/editor/main_window.py#_refresh_page_reference_candidates
  - tools/editor/main_window.py#_refresh_open_pages_after_disk_change
  - tools/editor/main_window.py#_commit_leaving_page
  - tools/editor/shared/action_editor.py#bump_reference_refresh_epoch
  - tools/editor/project_model.py#KNOWN_DIRTY_BUCKETS
triggers:
  paths: ["tools/editor/main_window.py", "tools/editor/editors/*"]
  topics: [新编辑器接入, reload_refs_from_model, commit_pending_on_leave, 鸭子协议, 跨面板刷新, editor_undo, 只读镜像, 外置工具同步, 重读资产]
  tasks: [新增编辑器面板, 给编辑器加跨域 id 选择器]
verified_by:
  - tools/editor/tests/test_cross_page_reference_refresh.py
  - tools/editor/tests/test_flush_hook_parity.py
  - tools/editor/tests/test_trajectory_disk_sync.py
last_governed: 2026-09-11
---

## 是什么(一句话)

主窗口对各面板的保存/关闭/刷新/撤销门控全部经 getattr 鸭子调用——**钩子缺失不是错误而是静默跳过**,这是"新编辑器漏保存 / 候选过期"整族 bug 的系统性根因。

## 权威源(读代码从哪进)

`tools/editor/main_window.py` 的全部钩子调用点(closeEvent、save_all 前 flush、切页提交/刷新、Edit→Undo 转发);`tools/editor/project_model.py` 的 load / save_all / 脏桶登记。

## 硬契约(新编辑器接入清单)

1. 注册页面 + 在 `project_model.py` 对齐 load / save 分支 / 命名脏桶(见 [save_all 与脏桶](save-all-dirty-buckets.md))。
2. **凡持本地脏态的编辑器必须有 `flush_to_model`(门控真实变更)与 `confirm_close`(Discard 中和)**(契约见 [关闭路径卡](close-path-flush-discard.md))。缺 flush = Save All 静默跳过整个面板(踩过:改帧率后 git 零 diff,用户以为存上了);现由 parity 护栏拦,豁免须显式登记。
   **签名也是契约的一部分**:钩子形参必须能按主窗调用点的实参调用。只查"钩子存不存在"的
   parity 抓不到签名跑偏——而关窗路径上一次 TypeError 就等于所有收尾(逐页 flush、"未保存
   改动"询问、几何保存、子进程回收)全被跳过,且 PySide 对事件循环派发的 `closeEvent` 只把
   traceback 打到 stderr 就继续,窗口照关、进程不失败,**没人会发现**。护栏必须按
   `inspect.signature().bind` 判,并锚定调用点防空转(样板见 `test_flush_hook_parity.py`)。
3. **有引用他域 id 的顶层选择器就必须有 `reload_refs_from_model()`**:重拉候选(缓存跳过 + 保留当前值),**不重置表单字段**。根因:选择器候选是静态快照,不切页重拉就看不见别处新增的 id。内嵌 ActionEditor 不必手写(切页有子控件兜底扫描);开时 live 拉取的选择器天然新鲜。
4. **staging 型编辑器(有「应用」按钮)必须有 `commit_pending_on_leave()`**:切页前把未应用编辑提交进模型,否则"配好了在别处看不到";返回 False = 有闸拦住,主窗只提示不阻断切页。**别指望主窗拿 `flush_to_model` 兜底**——图对话页 flush 即写盘、叙事页会走 JS 往返弹校验窗,切页触发是灾难,所以这条是显式 opt-in。
5. 局部撤销走鸭子钩子 `editor_undo` / `editor_redo`;`ProjectModel.undo_stack` 只是无钩子时的回落,其 `push_edit` 全库零调用者——别以为它在替你记录编辑。
6. **别的进程写的只读镜像(轨迹资产、audio_config、图对话目录…)同步是两步,顺序不能反**:
   ① 重读磁盘换掉 `ProjectModel` 里的镜像 → ② `_refresh_open_pages_after_disk_change()` 让已打开的页**重建**候选
   (当前页立刻,其余页只清水位等切过去)。只做 ① 的表现最像"没 bug":菜单点了、状态栏说重读了 N 条,下拉里就是没有
   刚存的东西——候选是 `_rebuild_params()` 那一刻的快照,而 `set_project_context` 在 model/scene 未变时短路。
   自动路径(主窗回到前台 / 外置进程退出,`_dialogue_external_processes` 那张监视表)**必须在镜像真变了才重建**,
   否则每激活一次窗口白冻一下;起外置工具时别忘了把 `Popen` 登记进那张表,不然自动路径根本不会跑。
   重扫函数要能被反复调用:每次重扫前先清掉自己上一轮记进 `load_anomalies` 的告警,不然同一个坏文件会越记越多。

## 已知坑

- 契约 4 尚未普及:只有场景编辑器实现,item 编辑器有 Apply 却没钩子(未 Apply 的编辑切页即丢)——接新 staging 面板照契约补,别假定同类已接。
- `_editor_instances` 与 stack 页前缀必须对齐(末尾浏览页不入列表):插页顺序错 → 鸭子调用打到错的编辑器。
- 已有 showEvent/data_changed 自刷新的面板别再叠 `reload_refs_from_model` → 双重刷新。
- `ActionEditor.reload_refs_from_model()` 是**真重建**(候选是构建期快照):幂等但不便宜,靠 `bump_reference_refresh_epoch()` 一轮去重;钩子里手写 `set_data(to_list())` 会绕过去重被重建两遍。
- 重建走 `set_data(to_list())` = 让表单自己往返一次:**往返不保真的 action 会在"刷新候选"这个纯读操作里被静默改写**。
  加复合控件(位置引用那种)时往返测试是这条路的前提,不是可选项。
- 兜底扫描只碰**最外层** ActionEditor:重建会销毁嵌套子编辑器 → 对已销毁 C++ 对象调方法即 `RuntimeError`;枚举 `ReferencePickerField` 必须排在重建**之后**,否则拿到待删控件。
- **模态框/弹出层开着时销毁控件树 = 进程级红线**:栈上便捷弹窗随 parent 析构被 `free` → 整个编辑器 SIGABRT(不是崩一个控件,是全部未保存编辑一起没),而定时器不受模态阻塞、会在 `exec()` 的嵌套循环里照常触发。闸必须设在"销毁"这一层(`reference_rebuild_is_safe_now`),判焦点挡不住(应用失活时 `focusWidget()` 即 None)。**任何新的定时/异步控件重建都要先过这道闸。**
- 因模态/焦点/异常跳过刷新时**不许记水位**,否则"跳过一次"被固化成永久陈旧。
- 拆栈期间 `removeWidget` 自身会发 `currentChanged`:不屏蔽就会给正在销毁的页提交 staging、并把水位写回刚清空的表。

## 怎么验证

`pytest tools/editor/tests/test_cross_page_reference_refresh.py`(候选真刷新/重建幂等/一轮去重/离开页提交)、`test_flush_hook_parity.py`、`test_all_editors_construct.py`。流程探针从"编辑 → 切页/关闭 → 断言模型"进;模型层全绿不代表门控接对了。
