---
target: save-all-dirty-buckets
date: 2026-08-01
session: task-orchestration-main-integration-review-loop
---

现象: 机制卡仍描述统一 os.replace 与失败时磁盘零变化；实际 writer 已升级为 SHA-256 基线、commit-time fail-if-exists 安装，并在外部竞态替换/原地写/删除时优先保留外部路径状态及 rollback 副本。
证据: tools/editor/file_io.py::StagedJsonWriter.commit；tools/editor/tests/test_dirty_bucket_parity.py 的 expected-absent、replace、in-place、delete 竞态注入测试。
建议: 机制卡将“零变化”细分为无外部并发时完整回滚，以及检测到外部并发时 preservation-first（不覆盖外部、旧版留 .rollback、保存失败且 dirty 保留）。
