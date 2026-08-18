---
id: atomic-write-windows
title: 原子写在 Windows 上不原子(就位类调用必须退避重试)
domain: meta
type: mechanism
summary: 「写 .tmp 再 os.replace 就位」在 Windows 上是概率性失败的;全仓 18 处就位点统一走 tools/atomic_io，只吃三个瞬时 errno、绝不重试 EEXIST
status: active
authority:
  - tools/atomic_io.py
  - tools/editor/file_io.py
triggers:
  paths: ["tools/**"]
  topics: [原子写, os.replace, shutil.move, 存盘, Windows, 跨平台]
  tasks: [改保存路径, 加存盘出口, 排查保存偶发失败]
verified_by:
  - tools/editor/tests/test_atomic_write_retry.py
last_governed: 2026-08-17
---

## 是什么(一句话)

POSIX 的 `rename(2)` 无条件原子替换,Windows 的 `MoveFileEx(REPLACE_EXISTING)` **不是**——
于是「写临时文件 + 就位」这个到处在用的原子写范式,在 Windows 上是**概率性失败**的。

## 权威源(读代码从哪进)

`tools/atomic_io.py`(`retry_transient`,全仓唯一实现);典型消费方看
`tools/editor/file_io.py`(工程唯一写盘出口的两阶段提交)。

## 硬契约(违反即 bug)

- **一切就位类调用走 `retry_transient`**:`os.replace` / `os.rename` / `shutil.move`。
  裸调用等于把一次「等 1 毫秒就好了」变成用户可见的保存失败。
- **只吃 `EACCES`/`EPERM`/`EBUSY`**。放宽这个集合会踩掉两类语义:
  - `os.link` 的 `EEXIST` 是「并发抢同名」的**原子建档护栏**,重试等于把护栏磨掉;
  - `ENOSPC`/`EROFS` 重试一万次也没用,早抛早报错。
  另:保存类测试惯用裸 `OSError("...")` 注入失败(`errno` 为 `None`),也必须不重试,
  否则那些锁失败语义的探针会被拖慢或吞掉。
- **不改任何失败语义**:重试用尽后抛的是**同一个异常对象**,调用方的回滚/报错原样成立
  (编辑器侧即 [save-all-dirty-buckets](../../editor-tools/mechanisms/save-all-dirty-buckets.md)
  的三层失败)。
- **不是加平台分支**:POSIX 上第一次调用就成功,一次都不重试。为某个 OS 写 `if sys.platform`
  会让另一个 OS 上的同类失败继续静默。

## 已知坑

- **持有句柄的往往不是我们**:vite dev server 的 watcher 盯着 `public/assets/data/**`、
  杀毒软件正在扫刚写出的文件、Windows 搜索索引器插一脚——所以"我明明没开着它"不成立。
- **症状极难归因**:单跑不复现、机器一忙才炸。本仓有一处因此被当成"环境性存量失败"
  躺了很久(`npm test` 长期非 0),真相是动画工作台的存盘出口会**丢一次编辑**。
  凡是"偶发保存失败/偶发测试红"且栈里有 rename,先怀疑这条。
- **`shutil.move` 也算**:即便目标不可能预先存在(UUID 目录、`_unique_dest`),
  **源**被持有同样抛 `EACCES`。

## 怎么验证

`tools/editor/tests/test_atomic_write_retry.py` 锁边界(重试哪几个 errno、EEXIST 与裸
`OSError` 绝不重试、抛的是同一异常对象、编辑器写盘出口用的就是这一份实现)。
真机判据:同一测试**单跑绿、连着跑红**就是它;修完连跑三轮验稳。
