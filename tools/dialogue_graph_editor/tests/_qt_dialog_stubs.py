"""模态弹窗打桩器（测试共享件）。

离屏跑测试时 `QMessageBox.exec()` **永不返回**：整套测试会停在某个百分比一动不动，
表现得像"变慢"而不是"失败"，很容易被当成环境问题放过（本项目已经被坑过一次，
先怀疑并行抢资源、又怀疑图变多，实际是新加的确认框没打桩）。

所以：任何会点到确认按钮的测试都必须裹在这个上下文里，且它记录下来的文案本身
就是可断言的——「问没问」和「问的是什么」一起验。
"""
from __future__ import annotations

from PySide6.QtWidgets import QMessageBox


class _SilencedBoxes:
    """把模态弹窗打桩成可断言的记录，离屏跑测试不会卡死在 exec()。"""

    def __init__(self, question_answer=QMessageBox.StandardButton.Ok):
        self.info: list[str] = []
        self.warn: list[str] = []
        self.question: list[str] = []
        self._answer = question_answer
        self._orig: dict[str, object] = {}

    def __enter__(self):
        self._orig = {
            "information": QMessageBox.information,
            "warning": QMessageBox.warning,
            "question": QMessageBox.question,
        }
        QMessageBox.information = staticmethod(  # type: ignore[assignment]
            lambda *a, **k: self.info.append(str(a[2]) if len(a) > 2 else "")
        )
        QMessageBox.warning = staticmethod(  # type: ignore[assignment]
            lambda *a, **k: self.warn.append(str(a[2]) if len(a) > 2 else "")
        )

        def _q(*a, **k):
            self.question.append(str(a[2]) if len(a) > 2 else "")
            return self._answer

        QMessageBox.question = staticmethod(_q)  # type: ignore[assignment]
        return self

    def __exit__(self, *exc):
        for name, fn in self._orig.items():
            setattr(QMessageBox, name, fn)
        return False


SilencedBoxes = _SilencedBoxes
