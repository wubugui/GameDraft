---
id: save-all-dirty-buckets
title: save_all 两阶段写与脏桶护栏
domain: editor-tools
type: mechanism
summary: 唯一写盘出口:先落 .tmp 再统一就位,stage 失败磁盘零变化、commit 失败按基线回滚、外部竞态 preservation-first;mark_dirty 只认登记键,新数据域三处同步
status: active
authority:
  - tools/editor/file_io.py#StagedJsonWriter
  - tools/editor/project_model.py#KNOWN_DIRTY_BUCKETS
triggers:
  paths: ["tools/editor/project_model.py", "tools/editor/file_io.py"]
  topics: [save_all, mark_dirty, 脏桶, StagedJsonWriter, 写盘]
  tasks: [给编辑器加新数据域, 改保存路径, 写保存相关测试]
verified_by:
  - tools/editor/tests/test_dirty_bucket_parity.py
last_governed: 2026-08-05
---

## 是什么(一句话)

`ProjectModel.save_all` 是全工程唯一写盘出口:按命名脏桶决定写哪些文件,经 `StagedJsonWriter` 两阶段提交。

## 权威源(读代码从哪进)

- `tools/editor/file_io.py` 的 `StagedJsonWriter`(两阶段提交、SHA-256 基线、rollback)
- `tools/editor/project_model.py` 的 `KNOWN_DIRTY_BUCKETS` + `save_all` if 链 + `mark_dirty`

## 硬契约

1. **失败语义分三层,别再当"任何失败都磁盘零变化"**:①stage 阶段(全部脏桶先落同目录 `.tmp`)任一失败 → abort,磁盘零变化;②commit 阶段失败 → 已就位的按 SHA-256 基线回滚,被换走的旧版留在同目录 `.rollback` 副本;③**检测到外部并发改动 → preservation-first**:不覆盖外部内容、旧版留 `.rollback`、本次保存判失败且脏标记保留。删除类副作用(淘汰文件 unlink、暂存桶清空)必须推迟到提交成功之后。
2. **校验前移进 presave 段**:会拦保存的校验(叙事图、planes extends 缺父/成环等)在写盘前跑、零副作用拦截——不允许"写了一半才发现非法"。
3. **脏桶键名护栏**:`mark_dirty` 对未登记键直接 raise;`KNOWN_DIRTY_BUCKETS` 与 save_all if 链一一对应。**新增数据域必须三处同步**:登记 + save_all 分支 + mark_dirty 调用点。
4. **测试打桩缝**:保存类测试拦截写盘用 `tools/editor/tests/save_test_utils.py` 的 `patch_staged_add`,不要再 patch `write_json`(staged 路径不经过它)。

## 已知坑

- **就位那几下在 Windows 上会瞬时失败**(目标/源被 dev server watcher、杀毒、索引器持有句柄):
  `os.replace`/`os.link` 一律经 `retry_transient` 重试,失败语义三层不变——
  见 [atomic-write-windows](../../meta/mechanisms/atomic-write-windows.md)。
- 键名拼错的历史真 bug:标 `"quests"`(复数)而 save_all 只认 `"quest"` → Save All 不写文件却清了脏标记,暂存数据无声丢失。护栏 raise 就是为它加的,别绕过。

## 怎么验证

- `tools/editor/tests/test_dirty_bucket_parity.py`:mark_dirty 字面量↔登记表↔save_all 分支 parity,**外加 commit 失败与外部竞态(expected-absent / replace / 原地写 / 删除)的失败注入用例——这些探针锁的是契约 1,别为跑得快删掉**。
- 改保存路径后跑黄金往返 `test_canvas_roundtrip_safety.py` + [验证门配方](../recipes/editor-change-verification-gate.md)。

相关:[关闭路径契约](close-path-flush-discard.md)、[叙事模板系统](narrative-template-system.md)(全有全无暂存是本机制的客户)。
