"""所有面向用户的错误信息同步写入 stderr，便于从控制台/cmd 排障。"""
from __future__ import annotations

import sys
import traceback
from datetime import datetime
from typing import Any, Callable


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_line(message: str) -> None:
    print(f"[{_ts()}] [ChronicleSim] {message}", file=sys.stderr, flush=True)


def log_block(title: str, body: str) -> None:
    log_line(title)
    for ln in (body or "").rstrip().splitlines():
        print(ln, file=sys.stderr, flush=True)


def log_exception(context: str, exc: BaseException) -> None:
    log_line(context)
    traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
    sys.stderr.flush()


def log_async_failure_dialog(window_title: str, summary: str, detail: str) -> None:
    log_line(f"[弹窗·失败] {window_title}: {summary}")
    if (detail or "").strip():
        print(detail.rstrip(), file=sys.stderr, flush=True)
        sys.stderr.flush()


def log_messagebox_critical(title: str, text: str, *, exc: BaseException | None = None) -> None:
    if exc is not None:
        log_exception(f"[弹窗·严重] {title}: {text}", exc)
    else:
        log_line(f"[弹窗·严重] {title}: {text}")


def log_messagebox_warning(title: str, text: str) -> None:
    log_line(f"[弹窗·警告] {title}: {text}")


_orig_excepthook: Callable[..., Any] | None = None


def install_stderr_excepthook() -> None:
    global _orig_excepthook
    if _orig_excepthook is not None:
        return
    _orig_excepthook = sys.excepthook

    def _hook(typ: type, value: BaseException, tb: Any) -> None:
        try:
            log_line(f"未捕获异常（同步 stderr）：{typ.__name__}: {value}")
            sys.stderr.flush()
        except Exception:
            pass
        if _orig_excepthook is not None:
            _orig_excepthook(typ, value, tb)

    sys.excepthook = _hook
