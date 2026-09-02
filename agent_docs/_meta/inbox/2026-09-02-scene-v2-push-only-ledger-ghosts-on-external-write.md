---
target: scene-canvas-v2-document-view-command
date: 2026-09-02
session: scene_v2「删掉的热点还画在画布上、再删提示没有此实体、重开才消失」根因调查与修复
---

现象: 卡上「并存期」说"切页时按模型重载"——实际 `_refresh_scene_page_on_activate` 只挂在 `_show_stack_page`(跳转/历史)上,手点导航树切页(`_on_nav_tree_current_changed`)不经过它;且 `notice_external_scene_write` 两侧都只清撤销栈不重投影。新画布图元账本是纯 push 的,外部直写(老画布删除/快照撤销、点选器、Task)不发事件 ⇒ 幽灵图元:还能点中、`_apply_presence` 对查不到的实体一律显示、再删走安全删除报"场景里没有 hotspot"。同根的第二条:在面板改 id,命令只带旧 ref ⇒ 实体从画布消失,撤销按旧 id 找不到人静默无效。
证据: `tools/editor/tests/test_scene_page_reload_on_nav.py`(从导航树 setCurrentItem 进)、`test_scene_v2_external_writes.py`(老画布按钮删 → 新画布账本)、`test_scene_v2_panel_bridge.py::IdChangeFollowsTheLedgerTests`、`test_scene_v2_document.py::IdentityFollowsTheCommandTests`;修法在 `main_window._on_stack_page_changed`、`SceneDocument.notice_external_scene_write`(清栈 + `notify_reloaded`)、`ChangeEntityFieldsCommand._follow_identity`。
建议: 卡的「并存期」一节改成两道防线各写清楚(切页重载挂 `currentChanged`;外部写入 → 文档层 `SceneReloaded`),「已知坑」补两条:纯 push 账本对不发事件的写入零感知(`_apply_presence` 还会把幽灵强制可见);改 id 是换身份,命令 ref 必须跟随、事件旧新两个 ref 都带。老画布侧刻意**不**做写入即重投影:`_load_scene` 会 flush pending 成命令再广播,会把新画布的栈清掉——老画布只靠切页重载。
