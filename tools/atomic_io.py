"""就位类文件操作的瞬时失败退避重试（跨平台，为 Windows 而设）。

## 为什么需要

POSIX 的 ``rename(2)`` **无条件原子替换**：目标正被别的进程打开也照换。
Windows 的 ``MoveFileEx(REPLACE_EXISTING)`` 不是——目标被**任何**进程持有句柄时
直接抛 ``EACCES``/``EPERM``/``EBUSY``。而持有者往往根本不是我们：

- vite dev server 的 watcher 刚读完 ``public/assets/data/**`` 还没关句柄；
- 杀毒软件正在扫这个刚写出来的文件；
- Windows 搜索索引器插了一脚。

于是「写临时文件 + ``os.replace`` 就位」这个到处都在用的原子写范式，在 Windows 上
**不是原子的，是概率性失败的**。症状极难归因：单跑不复现、机器一忙才炸，
非常容易被当成"环境问题"放着——本仓库就有一处这样躺了很久
（见 ``agent_docs/_meta/inbox/2026-08-17-windows-rename-over-existing-file-is-transient.md``）。

## 用法

    from tools.atomic_io import retry_transient
    ...
    retry_transient(os.replace, tmp, path)

## 边界（改这里前先读）

- **只吃 ``EACCES``/``EPERM``/``EBUSY``**。其余一律原样抛：
  - ``os.link`` 的 ``EEXIST`` 是「并发抢同名」的**原子建档护栏**，重试等于把护栏磨掉；
  - ``ENOSPC``/``EROFS`` 这类重试一万次也没用，早抛早报错；
  - 测试惯用的裸 ``OSError("...")`` ``errno`` 为 ``None``，同样不重试——
    保存类测试靠它注入失败，被重试拖慢或吞掉就测不出东西了。
- **不改任何失败语义**：重试用尽后抛的是**同一个异常对象**，调用方的回滚/报错照旧。
- POSIX 上第一次调用就成功，一次都不会重试（纯零成本）。
"""
from __future__ import annotations

import errno
import time
from typing import Callable, TypeVar

T = TypeVar("T")

#: 只有这几个 errno 算「再等一下也许就好了」
TRANSIENT_ERRNOS = frozenset(
    e for e in (getattr(errno, name, None) for name in ("EACCES", "EPERM", "EBUSY"))
    if e is not None
)

#: 退避阶梯（秒）；总计约 0.39s，超过就认命抛出去
RETRY_DELAYS_S = (0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2)


def retry_transient(op: Callable[..., T], *args, **kwargs) -> T:
    """跑 ``op(*args, **kwargs)``；仅在 Windows 瞬时错误上退避重试，其余原样抛。"""
    for delay in (*RETRY_DELAYS_S, None):
        try:
            return op(*args, **kwargs)
        except OSError as e:
            if delay is None or e.errno not in TRANSIENT_ERRNOS:
                raise
            time.sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover
