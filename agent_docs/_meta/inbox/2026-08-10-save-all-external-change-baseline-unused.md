---
target: save-all-dirty-buckets
date: 2026-08-10
session: 音频加工台 key 台账重构
---

现象: 卡里的失败语义③「检测到外部并发改动 → preservation-first」是**真的成立**的(基线由
`ProjectModel._load` 统一登记、`save_all` 在 project_model.py:1077 调 `expect_unchanged`、
保存前还有 `detect_external_changes` 弹窗),但卡里没说这套闸有多脆:**任何「顺手重读一下磁盘」
的代码只要走 `_load`,就会把基线刷成磁盘现值,这道 fail-closed 的闸当场变成静默覆盖**。
本次给 audio_config 加跨进程重读时正是这么踩的——写完自测全绿,靠对抗复审的离屏复现才发现
「加了同步反而把外部写入盖掉」,比不同步更糟。
证据: `tools/editor/project_model.py:604` —— `_load` 里 `self._file_baselines[...] = sha256(blob)`;
`:1071-1077` save_all 注册 `expect_unchanged`;`:645` `detect_external_changes` 按同一份基线判。
本次的正确写法:新增 `audio_config_differs_on_disk()` 用 `path.read_bytes()` 直接比对(**不碰基线**),
只有真要把内存换成磁盘版时才走 `_load`;护栏
`tools/editor/tests/test_audio_config_external_resync.py::test_peeking_at_disk_never_touches_the_external_change_baseline`。
第二条同源坑:面板表格是开工程时的一次性快照(`AudioEditor` 全类无 showEvent / 无 data_changed 订阅),
只换模型不换表格,面板反而判脏,下一次 Save All 用陈旧表格把刚同步进来的值写回去;
护栏 `::AudioPanelResyncTests::test_external_src_survives_a_following_save_all_flush`。
建议: 卡里补一条已知坑——**「重读磁盘」和「基线」是一对,分开动必出事**:重读前先问「这次要不要
把内存换掉」,不换就绝不能走 `_load`;换了就必须同时把**会覆写这份内存的 UI**(表格/表单快照)一起
重铺,否则 Save All 那条无差别 `flush_to_model` 会把旧快照写回去。这两条合起来才是一次完整的跨进程同步。
