---
id: save-all-dirty-buckets
title: save_all 两阶段写与脏桶护栏
domain: editor-tools
type: mechanism
summary: 全部脏桶先落 .tmp 再统一 os.replace(任何失败磁盘零变化);mark_dirty 只认 KNOWN_DIRTY_BUCKETS 登记键;新数据域必须三处同步
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
last_governed: 2026-07-11
---

## 是什么(一句话)

`ProjectModel.save_all` 是全工程唯一写盘出口:按命名脏桶决定写哪些文件,经 `StagedJsonWriter` 两阶段提交保证"要么全成、要么磁盘零变化"。

## 权威源(读代码从哪进)

- `tools/editor/file_io.py` 的 `StagedJsonWriter`(两阶段提交)
- `tools/editor/project_model.py` 的 `KNOWN_DIRTY_BUCKETS` + `save_all` if 链 + `mark_dirty`

## 硬契约

1. **两阶段写**:全部脏桶先序列化落同目录 `.tmp`(任何一个失败 → abort,磁盘零变化),再统一 `os.replace`;删除类副作用(淘汰文件 unlink、暂存桶清空)必须推迟到提交成功之后。
2. **校验前移进 presave 段**:会拦保存的校验(叙事图、planes extends 缺父/成环等)在写盘前跑、零副作用拦截——不允许"写了一半才发现非法"。
3. **脏桶键名护栏**:`mark_dirty` 对未登记键直接 raise;`KNOWN_DIRTY_BUCKETS` 与 save_all if 链一一对应。**新增数据域必须三处同步**:KNOWN_DIRTY_BUCKETS + save_all 分支 + mark_dirty 调用点。
4. **测试打桩缝**:保存类测试拦截写盘用 `tools/editor/tests/save_test_utils.py` 的 `patch_staged_add`,不要再 patch `write_json`(staged 路径不经过它)。

## 已知坑

- 键名拼错的历史真 bug:标 `"quests"`(复数)而 save_all 只认 `"quest"` → Save All 不写文件却清了脏标记,暂存数据无声丢失。护栏 raise 就是为它加的,别绕过。

## 怎么验证

- `tools/editor/tests/test_dirty_bucket_parity.py`:扫全源码 mark_dirty 字面量与 KNOWN_DIRTY_BUCKETS/save_all 分支 parity。
- 改保存路径后跑黄金往返 `test_canvas_roundtrip_safety.py` + [验证门配方](../recipes/editor-change-verification-gate.md)。

相关:[关闭路径契约](close-path-flush-discard.md)、[叙事模板系统](narrative-template-system.md)(全有全无暂存是本机制的客户)。
