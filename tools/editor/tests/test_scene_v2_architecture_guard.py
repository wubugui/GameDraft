"""**架构不许退化** —— 这是本次重建唯一靠机器守的不变量。

方案书 §6.2「风险二」：样板税是这套架构唯一无法用工具消除的成本，也是最容易被
赶工绕过的地方。老画布本身就是这么长出来的。预言是：

> 第 3 个月，有人为了赶工在 Tool 里直接写了一行 `ent["x"] = new_x`，代码评审
> 放过去了。半年后新画布退化成老画布，只是文件名不一样。

止损写在方案书里的原话是：**一条 CI 静态检查**。它比任何文档、任何 review 清单
都管用，因为**它不依赖人的记性**。这条检查本身就是"根因不再是口头约定"的物证。

## 检查什么

工具层与图元层**禁止对场景数据做下标赋值**（`something[...] = ...`）。
写入必须经命令（`build_change_fields_command` → `Document.push`）。

命令层与文档层是**允许**写的 —— 它们本来就是写入的唯一出口，白名单在此。
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
V2 = REPO / "tools/editor/editors/scene_v2"

#: **允许**写数据的模块 —— 它们就是那条唯一的写入路。
_WRITE_ALLOWED = {
    "commands.py",          # 命令基类：`target[key] = value` 是它的职责
    "commands_structure.py",  # 增删名册
}

#: 这些模块是"只读 + 构造命令"，一行写入都不许有。
_WRITE_FORBIDDEN = (
    "tools.py", "tools_builtin.py", "tools_structure.py",
    "tools_transform.py", "tools_overlays.py",
    "items.py", "entity_items.py", "content_items.py",
    "view.py", "sorting.py", "overlays.py",
)


#: 从 Document 拿出来的东西就是**场景数据本身**，写它 = 绕过命令层。
_DOC_READERS = frozenset({"entity", "model_entity", "write_target", "scene"})


def _tainted_names(fn: ast.AST) -> set[str]:
    """本函数里**持有场景数据**的名字。

    两个来源：
    1. 函数参数 —— 工具/图元收到的 `ent` / `sc` / `target` 都是模型 dict 的引用；
    2. 从 Document 的读方法拿到的返回值（`doc.entity(...)` 等）。

    刻意**不**把所有局部变量都当成安全：那样 `ent = doc.entity(ref)` 之后写
    `ent["x"] = 1` 会被放过 —— 而那正是最典型的违规写法。
    反过来也不把所有非局部都当成违规：视图写自己的图元账
    （`self._items[key] = item`）是它的本职，与场景数据无关。
    """
    names: set[str] = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.arg) and node.arg != "self":
            names.add(node.arg)
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            func = node.value.func
            called = func.attr if isinstance(func, ast.Attribute) else (
                func.id if isinstance(func, ast.Name) else "")
            if called in _DOC_READERS:
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        names.add(t.id)
    return names


def _offending_subscript_writes(path: Path) -> list[str]:
    """找出"写进场景数据"的下标赋值。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        tainted = _tainted_names(fn)
        for node in ast.walk(fn):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not isinstance(target, ast.Subscript):
                    continue
                base = target.value
                if isinstance(base, ast.Name) and base.id in tainted:
                    out.append(f"{path.name}:{node.lineno} in {fn.name}()")
    return out


class ToolsAndItemsMustNotWriteDataTests(unittest.TestCase):
    """工具与图元只准读 + 构造命令。"""

    def test_no_subscript_writes_outside_the_command_layer(self) -> None:
        offences: list[str] = []
        for name in _WRITE_FORBIDDEN:
            path = V2 / name
            if not path.exists():
                continue
            offences += _offending_subscript_writes(path)
        self.assertEqual(
            offences, [],
            "新画布的工具/图元层出现了绕过命令层的写入：\n  "
            + "\n  ".join(offences)
            + "\n写入必须经 build_change_fields_command → Document.push。"
              "\n（方案书 §6.2 风险二：这条检查不依赖人的记性，是架构不退化的唯一保证）")

    def test_the_guard_actually_has_files_to_check(self) -> None:
        """反向断言：别让这条检查因为文件改名而变成空跑的假护栏。"""
        present = [n for n in _WRITE_FORBIDDEN if (V2 / n).exists()]
        self.assertGreaterEqual(
            len(present), 8,
            f"待检查的模块只剩 {present} —— 疆域缩水了，护栏形同虚设")

    def test_the_guard_can_actually_catch_something(self) -> None:
        """自检：喂一段违规代码，它必须报出来。

        没有这条的话，`_offending_subscript_writes` 哪天写错成永远返回空，
        上面那条断言会永远绿。
        """
        import tempfile
        src = (
            "def bad(ent):\n"
            "    ent['x'] = 1\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad.py"
            p.write_text(src, encoding="utf-8")
            self.assertTrue(_offending_subscript_writes(p),
                            "护栏抓不到最典型的违规写法")

    def test_the_guard_catches_writes_to_a_document_read(self) -> None:
        """最典型的违规：把 Document 读出来的实体就地改掉。"""
        import tempfile
        src = (
            "def bad(self, ref):\n"
            "    ent = self._doc.entity(ref)\n"
            "    ent['x'] = 1\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "bad2.py"
            p.write_text(src, encoding="utf-8")
            self.assertTrue(_offending_subscript_writes(p),
                            "护栏放过了 `ent = doc.entity(...)` 之后的就地写入")

    def test_the_guard_allows_building_local_payloads(self) -> None:
        """构造命令参数（本地 dict）不该被误报 —— 那不是"写数据"。"""
        import tempfile
        src = (
            "def ok():\n"
            "    vals = {}\n"
            "    vals['x'] = 1\n"
            "    return vals\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ok.py"
            p.write_text(src, encoding="utf-8")
            self.assertEqual(_offending_subscript_writes(p), [],
                             "误报：攒命令参数被当成了绕过命令层的写入")

    def test_the_guard_allows_the_view_to_keep_its_own_ledger(self) -> None:
        """视图写自己的图元账是本职 —— 与场景数据无关，不该被误报。"""
        import tempfile
        src = (
            "def ok(self, key, item):\n"
            "    self._items[key] = item\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ledger.py"
            p.write_text(src, encoding="utf-8")
            self.assertEqual(_offending_subscript_writes(p), [],
                             "误报：视图维护自己的图元账被当成了写场景数据")


class WriteLayerIsExplicitTests(unittest.TestCase):
    def test_command_layer_is_the_only_allowed_writer(self) -> None:
        for name in _WRITE_ALLOWED:
            self.assertTrue((V2 / name).exists(),
                            f"白名单里的 {name} 不存在 —— 白名单过期了")

    def test_forbidden_and_allowed_do_not_overlap(self) -> None:
        self.assertEqual(set(_WRITE_FORBIDDEN) & _WRITE_ALLOWED, set())


class DocumentIsTheOnlyArbiterTests(unittest.TestCase):
    """`write_target` 只准有一处实现。"""

    def test_only_document_defines_write_target(self) -> None:
        hits = [p.name for p in V2.glob("*.py")
                if "def write_target" in p.read_text(encoding="utf-8")]
        self.assertEqual(hits, ["document.py"],
                         "写入裁决出现了第二处实现 —— 那正是老画布的根因")

    def test_tools_never_call_mark_dirty_directly(self) -> None:
        """标脏归命令 —— 工具自己标脏 = 又一条"要记得做"的约定。"""
        offences = []
        for name in _WRITE_FORBIDDEN:
            path = V2 / name
            if path.exists() and "mark_dirty(" in path.read_text(encoding="utf-8"):
                offences.append(name)
        self.assertEqual(offences, [], f"这些模块自己标脏了：{offences}")


if __name__ == "__main__":
    unittest.main()
