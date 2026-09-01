"""子进程随父进程一起死(Windows Job Object)。

## 为什么需要

本地工具经常 `subprocess.Popen` 起长任务(烘焙一个场景 3 分钟、装 torch 几分钟)。
父进程退出时,**子进程默认活下来** —— 于是:

- 关掉窗口以为停了,`pipeline.py` 还在后台吃 CPU、继续往 `out/` 和 `runtime/` 里写;
- 再开一次窗口重烘同一个场景 ⇒ **两个进程并发写同一批产物,而且都合法**,
  谁最后写完谁赢,产物是两次运行的混合体。这个坑本仓库真踩过。

`atexit` / 信号处理挡不住这个:任务管理器硬杀、崩溃、`TaskStop` 都不会执行它们。
Windows 上唯一可靠的是 **Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**:
job 句柄随父进程一起被内核关闭,内核**主动杀光** job 里的所有进程,无论父进程怎么死。

## 用法

    from tools.child_jobs import spawn

    p = spawn([sys.executable, '-u', 'pipeline.py', ...], stdout=subprocess.PIPE, ...)

其它平台上 `spawn` 就是 `subprocess.Popen` 的透传(POSIX 有 pgid/prctl 那套,
本项目的桌面工具只在 Windows 上跑,不为没有的需求写代码)。
"""
from __future__ import annotations

import subprocess
import sys
import threading

_JOB = None
_JOB_FAILED = False
_JOB_LOCK = threading.Lock()      # serve.py 的工作线程与请求线程都会 spawn,首启并发要串行
_K32 = None                       # kernel32 只加载一次:spawn 每次重建会白白拉长无保护窗口

# winnt.h
_JobObjectExtendedLimitInformation = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001


def _k32():
    """kernel32,带 restype 声明(Win64 句柄默认按 c_int 截断是潜在雷,声明堵死)。"""
    global _K32
    if _K32 is None:
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.OpenProcess.restype = wintypes.HANDLE
        _K32 = k
    return _K32


def _winerr(what: str):
    import ctypes
    # ⚠ 不要写 OSError(get_last_error(), ...):第一参是 errno 语义,Win32 码 5 会被
    #   显示成 [Errno 5] EIO 之类的错话。WinError 才按 Win32 码格式化。
    e = ctypes.WinError(ctypes.get_last_error())
    e.strerror = f'{what}: {e.strerror}'
    return e


def _ensure_job():
    """惰性建一个"父死子亡"的 job;失败返回 None(降级成普通 Popen,并且**出声**)。"""
    global _JOB, _JOB_FAILED
    if _JOB is not None or _JOB_FAILED:
        return _JOB
    if sys.platform != 'win32':
        _JOB_FAILED = True
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [('ReadOperationCount', ctypes.c_ulonglong),
                        ('WriteOperationCount', ctypes.c_ulonglong),
                        ('OtherOperationCount', ctypes.c_ulonglong),
                        ('ReadTransferCount', ctypes.c_ulonglong),
                        ('WriteTransferCount', ctypes.c_ulonglong),
                        ('OtherTransferCount', ctypes.c_ulonglong)]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', wintypes.LARGE_INTEGER),
                        ('PerJobUserTimeLimit', wintypes.LARGE_INTEGER),
                        ('LimitFlags', wintypes.DWORD),
                        ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t),
                        ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.POINTER(ctypes.c_ulong)),
                        ('PriorityClass', wintypes.DWORD),
                        ('SchedulingClass', wintypes.DWORD)]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', JOBOBJECT_BASIC_LIMIT_INFORMATION),
                        ('IoInfo', IO_COUNTERS),
                        ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t),
                        ('PeakProcessMemoryUsed', ctypes.c_size_t),
                        ('PeakJobMemoryUsed', ctypes.c_size_t)]

        k32 = _k32()
        job = k32.CreateJobObjectW(None, None)
        if not job:
            raise _winerr('CreateJobObjectW 失败')
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = k32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            raise _winerr('SetInformationJobObject 失败')
        _JOB = job
        return _JOB
    except Exception as exc:                        # noqa: BLE001
        # ⚠ 必须出声:静默降级的话,"关了窗口还在烘"这个症状就完全无迹可循。
        print(f'[child-jobs] 建不出 Job Object({exc});子进程将**不会**随父进程退出 —— '
              f'关窗口后请自行确认没有残留的 python 进程', file=sys.stderr, flush=True)
        _JOB_FAILED = True
        return None


def spawn(cmd, **kwargs) -> subprocess.Popen:
    """起一个**随父进程一起死**的子进程。参数与 `subprocess.Popen` 一致。"""
    proc = subprocess.Popen(cmd, **kwargs)
    with _JOB_LOCK:
        job = _ensure_job()
    if job is None:
        if sys.platform == 'win32':
            # ⚠ 本模块自己的规矩:静默降级完全无迹可循。_JOB_FAILED 闩住之后
            #   建 job 那条只报一次,这里保证**每一次** spawn 都出声。
            print(f'[child-jobs] pid {proc.pid} 无 Job Object 保护;它不会随父进程退出',
                  file=sys.stderr, flush=True)
        return proc
    try:
        import ctypes
        k32 = _k32()
        # Popen 拿到的是句柄的整数值;需要一个带 SET_QUOTA|TERMINATE 权限的句柄
        h = k32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, proc.pid)
        if not h:
            raise _winerr('OpenProcess 失败')
        try:
            if not k32.AssignProcessToJobObject(job, h):
                raise _winerr('AssignProcessToJobObject 失败')
        finally:
            k32.CloseHandle(h)
    except Exception as exc:                        # noqa: BLE001
        print(f'[child-jobs] pid {proc.pid} 没能加进 job({exc});它不会随父进程退出',
              file=sys.stderr, flush=True)
    return proc
