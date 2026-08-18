"""就位类文件操作的瞬时失败退避重试（跨平台，为 Windows 而设）。

背景见 `tools/atomic_io.py` 的模块注释：POSIX 的 rename 无条件原子替换，
Windows 的 MoveFileEx 在目标被任何进程持有句柄时抛 EACCES/EPERM/EBUSY——
持有者常常不是我们（dev server watcher / 杀毒 / 索引器）。

这些用例锁的是**边界**，不是"能重试"：
重试只许吃那三个 errno，`os.link` 的 EEXIST（原子建档护栏）与测试惯用的裸 OSError
都必须原样抛出去——磨掉任何一条，save_all 的失败语义就变了。

另有一例锁「编辑器写盘出口用的就是这一份实现」：全仓 8 处原子写共用它，
哪天有人在 file_io 里另抄一份，这里会红。
"""
from __future__ import annotations

import errno
import unittest

from tools.atomic_io import retry_transient as _retry_transient


class RetryTransientTests(unittest.TestCase):
    def test_returns_first_result_without_retrying(self):
        calls = []

        def op(a, b):
            calls.append((a, b))
            return "ok"

        self.assertEqual(_retry_transient(op, 1, 2), "ok")
        self.assertEqual(calls, [(1, 2)])

    def test_retries_transient_errno_then_succeeds(self):
        attempts = {"n": 0}

        def op():
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise PermissionError(errno.EACCES, "target held by another process")
            return "installed"

        self.assertEqual(_retry_transient(op), "installed")
        self.assertEqual(attempts["n"], 3)

    def test_gives_up_and_reraises_the_same_error(self):
        original = OSError(errno.EBUSY, "still busy")

        def op():
            raise original

        with self.assertRaises(OSError) as ctx:
            _retry_transient(op)
        # 抛的必须是**同一个**异常对象：上层按它的 errno/文本决定回滚与报错文案
        self.assertIs(ctx.exception, original)

    def test_eexist_is_never_retried(self):
        """`os.link` 的 EEXIST 是并发抢名时的原子护栏，重试等于把护栏磨掉。"""
        attempts = {"n": 0}

        def op():
            attempts["n"] += 1
            raise FileExistsError(errno.EEXIST, "target appeared")

        with self.assertRaises(FileExistsError):
            _retry_transient(op)
        self.assertEqual(attempts["n"], 1)

    def test_bare_oserror_without_errno_is_never_retried(self):
        """保存类测试注入的就是裸 OSError（errno 为 None）——不能被重试拖慢或吞掉。"""
        attempts = {"n": 0}

        def op():
            attempts["n"] += 1
            raise OSError("注入的 replace 失败")

        with self.assertRaises(OSError):
            _retry_transient(op)
        self.assertEqual(attempts["n"], 1)

    def test_non_oserror_propagates_immediately(self):
        attempts = {"n": 0}

        def op():
            attempts["n"] += 1
            raise ValueError("序列化炸了")

        with self.assertRaises(ValueError):
            _retry_transient(op)
        self.assertEqual(attempts["n"], 1)

    def test_editor_write_path_uses_this_very_implementation(self):
        """全仓原子写共用一份实现——谁在 file_io 里另抄一份，这条会红。"""
        from tools import atomic_io
        from tools.editor import file_io

        self.assertIs(file_io._retry_transient, atomic_io.retry_transient)


if __name__ == "__main__":
    unittest.main()
