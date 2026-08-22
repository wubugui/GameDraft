"""栈页外壳 `_StackPageHost` 的解包契约 —— 拿错对象会让整条功能**静默全死**。

## 这条为什么值一个测试文件

`MainWindow._stack` 里装的**不是编辑器实例**，是 `_StackPageHost` 包装壳
（`main_window.py:113`，只做了个 layout 包一层，**不转发任何属性**）。
所以：

- `getattr(self._stack.currentWidget(), "_props", None)` → **恒为 None**
- `self._stack.currentWidget() is some_editor` → **恒为 False**

两种写法都不会报错，只会让那条功能**一次都不执行**。仓库里正确的取法是
`_current_editor_instance()`（`main_window.py:1980`，注释里写着「页面外壳
`_StackPageHost` 不算」）。

## 已经付过的代价

1. **审查 P1-29**：F5 不再自动切「运行与预览」页。修法是 `_stack_index_of_page`
   逐页解包（`main_window.py:176` 的注释就是那次留下的）。
2. **2026-08-22**：光照的"双向实时同步"里 `_lighting_sync_panel` 用了
   `currentWidget()` + `getattr(_props)` ⇒ **编辑器那半边一次都没跑过**。
   现场证据：同步槽 `rev=59`、`writer` 59 次全是 `game:*`，从没出现过 `editor:*`；
   而运行时那半边、传输层、回声抑制、退避全是好的。
   同一批还发现 `_poll_cutscene_playback` 用 `currentWidget() is not ed` ⇒
   过场播放头轮询同样静默全死。
3. 两次的共同点：**所有门都是绿的**。纯函数（`needs_publish` /
   `validate_pulled_lighting`）测得很细，而"取到面板"这一步一行覆盖都没有。

所以这份测的不是算法，是**接线**。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_MW = _ROOT / "tools" / "editor" / "main_window.py"


def _source() -> str:
    return _MW.read_text(encoding="utf-8")


def _code_lines(src: str) -> list[tuple[int, str]]:
    """去掉注释与文档串行，只留真正会执行的代码行。"""
    out: list[tuple[int, str]] = []
    in_doc = False
    for i, raw in enumerate(src.splitlines(), 1):
        line = raw.strip()
        # 粗略的三引号跟踪：本文件只需要排除注释/文档，不必是完整的 Python 词法器
        ticks = line.count('"""') + line.count("'''")
        if in_doc:
            if ticks % 2 == 1:
                in_doc = False
            continue
        if ticks % 2 == 1:
            in_doc = True
            continue
        if not line or line.startswith("#"):
            continue
        out.append((i, raw))
    return out


class TestNoRawCurrentWidgetReachIntoEditor:
    """`currentWidget()` 拿到的是外壳；不许拿它去够编辑器的属性或跟实例比。"""

    def test_currentWidget_只允许出现在白名单里(self) -> None:
        """不做花式匹配 —— **直接限制它出现的地方**。

        试过用正则查「getattr(currentWidget())」和「currentWidget() is ed」，
        实测漏：坏代码写成两行（`ed = ...currentWidget()` 再 `getattr(ed, ...)`）
        就绕过去了，而那正是 2026-08-22 事故的真实写法。
        所以判据换成硬的：正确取法是 `_current_editor_instance()`，
        `currentWidget()` 只剩一个合法用途 —— 把**页面控件**（外壳也行，
        因为它会递归搜子树）交给搜索聚光。多一处都要说明理由。
        """
        hits = [(n, l.strip()) for n, l in _code_lines(_source())
                if "self._stack.currentWidget()" in l]
        assert len(hits) == 1, (
            "currentWidget() 拿到的是 _StackPageHost 外壳，够不着编辑器。"
            f"新增用法必须在此说明理由并更新本测试。命中：{hits}")
        # 唯一那处必须在搜索聚光里（它把整个页面控件交给递归搜索，外壳无所谓）
        src = _source()
        i = src.index("def _schedule_search_spotlight")
        # 找下一个**顶层**方法（4 空格缩进）—— 这个函数里有嵌套 def attempt，
        # 用裸 "def " 会把切片截在嵌套函数之前，而调用恰恰在嵌套函数里
        j = src.index("\n    def ", i + 10)
        assert "self._stack.currentWidget()" in src[i:j], (
            "唯一允许的那处不在 _schedule_search_spotlight 里了 —— 重新审一遍")

    def test_两个真实受害者现在都走解包器(self) -> None:
        src = _source()
        for fn in ("_lighting_sync_panel", "_poll_cutscene_playback"):
            i = src.index(f"def {fn}")
            body = src[i:i + 1400]
            assert "_current_editor_instance()" in body, f"{fn} 没走解包器"

    def test_解包器本身还在且按栈下标取实例(self) -> None:
        src = _source()
        i = src.index("def _current_editor_instance")
        body = src[i:i + 500]
        assert "self._stack.currentIndex()" in body
        assert "self._editor_instances[idx]" in body


class TestStackPageHostReallyWraps:
    """真建一次外壳，坐实"属性不转发"这条 —— 免得将来有人给它加了转发、
    上面那些禁令就变成无谓的洁癖（那时该改的是这份测试，不是绕过它）。"""

    def test_外壳不转发内容物的属性(self) -> None:
        pytest.importorskip("PySide6")
        from PySide6.QtWidgets import QApplication, QStackedWidget, QWidget

        from tools.editor.main_window import _StackPageHost

        app = QApplication.instance() or QApplication([])
        assert app is not None

        class _FakeEditor(QWidget):
            def __init__(self) -> None:
                super().__init__()
                self._props = object()

        ed = _FakeEditor()
        host = _StackPageHost(ed)
        stack = QStackedWidget()
        stack.addWidget(host)
        stack.setCurrentIndex(0)

        # 这两条就是那两次事故的机理，逐条钉住
        assert stack.currentWidget() is host
        assert stack.currentWidget() is not ed
        assert getattr(stack.currentWidget(), "_props", None) is None
        assert ed._props is not None          # 属性确实在编辑器身上


def _function_body(src: str, name: str) -> str:
    """取一个方法的**完整**函数体（到下一个同缩进的 def 为止）。

    ⚠ 不要写成 `src[i:i+3000]` 这种定长窗口：函数一长，窗口尾巴外的分支就
      静默地不再被检查了 —— 测试还是绿的，但它已经不看那一半了。
      实测踩过：给这一拍加了选中同步之后，`needs_publish` 被挤出 3000 字，
      "发"那半边的守卫当场失效。
    """
    i = src.index("def " + name)
    indent = len(src[:i].rsplit(chr(10), 1)[-1])
    rest = src[i:]
    for line_start in range(1, len(rest)):
        if rest[line_start - 1] != chr(10):
            continue
        line = rest[line_start:rest.find(chr(10), line_start)]
        if line.strip().startswith(("def ", "class ")) and (
                len(line) - len(line.lstrip()) <= indent):
            return rest[:line_start]
    return rest


class TestLightingSyncTickIsReachable:
    """光照同步那条 tick 的**接线**：取面板这一步必须真的取得到。

    只测纯函数是不够的 —— 上一次就是纯函数全绿、接线全死。
    """

    def test_取面板走的是解包器且判据齐全(self) -> None:
        src = _source()
        i = src.index("def _lighting_sync_panel")
        body = src[i:src.index("def _tick_lighting_sync")]
        assert "self._current_editor_instance()" in body
        # 三道判据一个都不能少：有面板、有同步钩子、有场景 id
        assert 'getattr(ed, "_props", None)' in body
        assert "sync_lighting_snapshot" in body
        assert "current_scene_id" in body

    def test_场景面板确实提供了同步钩子(self) -> None:
        """接线的另一头：面板必须有 tick 要调的那五个方法。缺一个就是静默半死。"""
        panel_src = (_ROOT / "tools" / "editor" / "editors"
                     / "scene_editor.py").read_text(encoding="utf-8")
        for hook in ("current_scene_id", "set_sync_status", "sync_lighting_snapshot",
                     "sync_busy", "apply_synced_lighting"):
            assert f"def {hook}(" in panel_src, f"场景面板缺同步钩子 {hook}"

    def test_tick_两个方向都在(self) -> None:
        src = _source()
        body = _function_body(src, "_tick_lighting_sync")
        assert "plan_apply" in body, "收：没有套用对面的分支"
        assert "needs_publish" in body, "发：没有发布本地改动的分支"
        assert ".publish(" in body
