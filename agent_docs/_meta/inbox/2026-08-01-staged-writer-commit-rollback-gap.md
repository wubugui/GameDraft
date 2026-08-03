---
target: save-all-dirty-buckets
date: 2026-08-01
session: dialogue-file-safety-followup
---

现象: 机制卡声称任一保存失败均「磁盘零变化」，但原 StagedJsonWriter.commit 逐个 os.replace，提交期第 N 个失败会永久留下前 N-1 个新版文件。
证据: tools/editor/file_io.py 旧 commit 无备份/回滚；tools/editor/tests/test_dirty_bucket_parity.py::test_commit_replace_failure_rolls_back_writes_and_delete 现用失败注入锁定修复后契约。
建议: 机制卡将「两阶段」明确拆为 stage 失败与 commit 失败，并要求 commit 回滚注入探针长期保留。
