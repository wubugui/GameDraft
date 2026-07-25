"""护栏：编辑器代码里的 QTimer.singleShot 必须带 context 对象。

2 参版 ``QTimer.singleShot(msec, callable)`` 排的是一个**没有 receiver 的**独立
QSingleShotTimer，bound method / 闭包又拖住 shiboken 包装器不放；宿主控件被销毁后
定时器照样触发，回调一碰 C++ 方法就
``RuntimeError: Internal C++ object (...) already deleted``。更糟的是 PySide 会把这个
异常沿最近的 Python-override 边界（eventFilter / itemChange）向外抛，于是**下一段
毫不相干的操作**中途炸掉——测试里表现为"错误出现在无关文件"，真实编辑器里表现为
换工程 / 重建页面栈 / 关窗后随手一点就报错。

3 参版 ``QTimer.singleShot(msec, context, callable)`` 是 Qt 为此提供的官方解法：
context 析构时 Qt 自动取消这次回调，存活期行为一字不差。

context 选取原则：谁的析构应该取消这次回调，就用谁——回调只碰 self 就用 self，
只操作某个子控件就用那个子控件（更严格），只为打断局部 QEventLoop 就用那个 loop
（宿主死了也得让 ``exec()`` 退出）。
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]

#: 受本护栏管辖的目录（PySide 桌面工具；命令行脚本不在内）。
_GUARDED_ROOTS = (
    _REPO / "tools" / "editor",
    _REPO / "tools" / "dialogue_graph_editor",
    _REPO / "tools" / "production_workbench",
)


def _is_single_shot(node: ast.Call) -> bool:
    func = node.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "singleShot"
        and isinstance(func.value, ast.Name)
        and func.value.id == "QTimer"
    )


class SingleShotContextParityTests(unittest.TestCase):
    def test_no_context_less_single_shot(self) -> None:
        offenders: list[str] = []
        for root in _GUARDED_ROOTS:
            for path in sorted(root.rglob("*.py")):
                if "__pycache__" in path.parts:
                    continue
                try:
                    tree = ast.parse(path.read_text(encoding="utf-8"))
                except SyntaxError as exc:  # pragma: no cover - 语法错另有门管
                    self.fail(f"{path.relative_to(_REPO)} 解析失败: {exc}")
                for node in ast.walk(tree):
                    if isinstance(node, ast.Call) and _is_single_shot(node):
                        if len(node.args) < 3:
                            offenders.append(
                                f"{path.relative_to(_REPO)}:{node.lineno}"
                            )
        self.assertEqual(
            offenders,
            [],
            "下列 QTimer.singleShot 缺 context 对象（宿主销毁后仍会触发，"
            "详见本文件模块注释）：\n  " + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
