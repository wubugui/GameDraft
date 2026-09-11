"""Shared Qt WebEngine page: forwards page errors to the editor log, drops known noise."""
from __future__ import annotations

import sys

_RESIZE_OBSERVER_NOISE = "ResizeObserver loop"


try:
    from PySide6.QtWebEngineCore import QWebEnginePage
except ImportError:  # pragma: no cover
    QWebEnginePage = None  # type: ignore[assignment,misc]


if QWebEnginePage is not None:

    class QuietWebEnginePage(QWebEnginePage):
        """页面 console 的 error/warning 转进编辑器 stderr;info/log 不转,免得刷屏。

        ⚠ **PySide6 的默认实现一个字都不转发**(6.11 实测:`console.error` 与未捕获异常
        在 stderr 上都没有任何输出;库里那句"编辑器把 console 转进日志面板"、
        以及靠 `js:` 前缀查页面报错的老手法,在这个版本上已经不成立)。
        少了这条,内嵌页出错的表现就是**纯黑一片、日志里什么都没有**——2026-09-08 游戏
        预览窗那次黑屏(缓存烂掉导致模块 SyntaxError)整整一屏日志里连一行线索都没有,
        就是这么来的。所以这里必须显式打出来,而不是 `super()` 了事。

        info/log 级不转是有意的:游戏页每帧都可能 log,开发者控制台只留最近若干条,
        刷屏会把真正的报错顶掉(见 live-editor-forensics)。
        """

        def javaScriptConsoleMessage(
            self,
            level,
            message: str,
            line_number: int,
            source_id: str,
        ) -> None:
            if message and _RESIZE_OBSERVER_NOISE in message:
                return
            try:
                levels = QWebEnginePage.JavaScriptConsoleMessageLevel
                if level == levels.InfoMessageLevel:
                    return
                tag = "warn" if level == levels.WarningMessageLevel else "error"
            except Exception:  # pragma: no cover - 枚举形状变了也不该吞掉消息
                tag = "js"
            try:
                sys.stderr.write(f"js:{tag}: {message}  @{source_id}:{line_number}\n")
                sys.stderr.flush()
            except Exception:  # pragma: no cover - 控制台编码/句柄异常不该拖垮页面
                pass

else:  # pragma: no cover

    class QuietWebEnginePage:  # type: ignore[no-redef]
        pass
