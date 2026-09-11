"""开发控制台的工具进程生命周期护栏。

2026-09-09 事故：控制台重开时旧的主编辑器没被回收，孤儿进程拿启动那一刻的旧代码
往现网数据上写（叙事图被抹空、场景字段丢失）。本文件钉住四条契约：
1. 同一工具已在运行（本控制台启动）→ 再启动被拒绝，不开第二份；
2. 上一个控制台留下的孤儿实例 → 启动被拒绝，消息里带 PID 与启动时间；
3. 控制台退出 → 本控制台拉起的工具被礼貌关闭（不是 /F 强杀）；
4. 进程结束 → 跟踪表清掉，之后能再启动。
"""
from __future__ import annotations

import unittest
from datetime import datetime
from unittest.mock import patch

from tools.dev_console import app as console


class _FakePopen:
    def __init__(self, pid: int, alive: bool = True) -> None:
        self.pid = pid
        self._alive = alive
        self.stdout = None

    def poll(self):  # noqa: ANN201
        return None if self._alive else 0

    def wait(self) -> int:
        self._alive = False
        return 0


def _state() -> console.ConsoleState:
    state = console.ConsoleState()
    state.logs = []
    return state


class ToolCmdlineMatchTests(unittest.TestCase):
    def test_matches_both_launcher_shapes_of_the_editor(self) -> None:
        outer = ["E:\\p\\.tools\\venv\\Scripts\\python.exe", "-m", "tools.dev", "editor"]
        inner = ["E:\\p\\.tools\\Python311\\python.exe", "-m", "tools.editor", "E:\\p"]
        self.assertTrue(console.tool_cmdline_matches(outer, "editor"))
        self.assertTrue(console.tool_cmdline_matches(inner, "editor"))

    def test_does_not_confuse_submodules_or_other_tasks(self) -> None:
        validate = ["python", "-m", "tools.editor.validate"]
        dialogue = ["python", "-m", "tools.dev", "dialogue-graph"]
        self.assertFalse(console.tool_cmdline_matches(validate, "editor"))
        self.assertFalse(console.tool_cmdline_matches(dialogue, "editor"))
        self.assertTrue(console.tool_cmdline_matches(dialogue, "dialogue-graph"))
        self.assertFalse(console.tool_cmdline_matches(["python", "-m"], "editor"))


class ToolInstanceRootsTests(unittest.TestCase):
    """事故进程树原样：venv(tools.dev editor) → Py311(tools.dev editor) → venv(tools.editor) → Py311(tools.editor)。"""

    def _tree(self, base: int, root_parent: int = 17888) -> list[dict]:
        t = datetime(2026, 9, 8, 22, 32, 38)
        return [
            {"pid": base, "ppid": root_parent, "argv": ["python", "-m", "tools.dev", "editor"], "started": t},
            {"pid": base + 1, "ppid": base, "argv": ["python", "-m", "tools.dev", "editor"], "started": t},
            {"pid": base + 2, "ppid": base + 1, "argv": ["python", "-m", "tools.editor", "E:\\p"], "started": t},
            {"pid": base + 3, "ppid": base + 2, "argv": ["python", "-m", "tools.editor", "E:\\p"], "started": t},
        ]

    def test_collapses_the_chain_to_its_root_and_reports_start_time(self) -> None:
        roots = console.tool_instance_roots(self._tree(100), "editor", exclude_pids=set())
        self.assertEqual([r["pid"] for r in roots], [100])
        self.assertEqual(roots[0]["started"], "09-08 22:32:38")

    def test_own_children_are_not_orphans_even_when_only_the_root_is_tracked(self) -> None:
        roots = console.tool_instance_roots(self._tree(100), "editor", exclude_pids={100})
        self.assertEqual(roots, [])

    def test_a_second_untracked_chain_is_still_reported(self) -> None:
        procs = self._tree(100) + self._tree(200, root_parent=1)
        roots = console.tool_instance_roots(procs, "editor", exclude_pids={100})
        self.assertEqual([r["pid"] for r in roots], [200])


class LaunchToolGuardTests(unittest.TestCase):
    def test_refuses_second_launch_while_own_instance_is_alive(self) -> None:
        state = _state()
        state.tool_processes["editor"] = _FakePopen(4242)  # type: ignore[assignment]
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=[]), \
             patch.object(console.ConsoleState, "_start_process") as start:
            ok, message = state.launch_tool("editor")
        self.assertFalse(ok)
        self.assertIn("4242", message)
        self.assertIn("已在运行", message)
        start.assert_not_called()

    def test_refuses_launch_when_an_orphan_from_a_previous_console_is_running(self) -> None:
        state = _state()
        orphan = [{"pid": 26608, "started": "09-08 22:32:38", "cmd": "python -m tools.editor"}]
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=orphan), \
             patch.object(console.ConsoleState, "_start_process") as start:
            ok, message = state.launch_tool("editor")
        self.assertFalse(ok)
        self.assertIn("26608", message)
        self.assertIn("22:32:38", message)
        self.assertIn("旧代码", message)
        start.assert_not_called()

    def test_launch_registers_process_and_finish_unregisters_it(self) -> None:
        state = _state()
        proc = _FakePopen(555)
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=[]), \
             patch.object(console.ConsoleState, "_start_process", return_value=proc):
            ok, _ = state.launch_tool("editor")
        self.assertTrue(ok)
        self.assertIs(state.tool_processes["editor"], proc)
        # 进程结束：watcher 收尾清跟踪表，之后同名工具能再启动
        state._watch_process("Launch editor", proc, exclusive=False)  # type: ignore[arg-type]
        self.assertNotIn("editor", state.tool_processes)
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=[]), \
             patch.object(console.ConsoleState, "_start_process", return_value=_FakePopen(556)):
            ok, _ = state.launch_tool("editor")
        self.assertTrue(ok)

    def test_unknown_tool_still_rejected(self) -> None:
        ok, message = _state().launch_tool("nope")
        self.assertFalse(ok)
        self.assertIn("Unknown", message)


class StopAndExitTests(unittest.TestCase):
    def test_exit_closes_owned_tools_gracefully_not_forcefully(self) -> None:
        state = _state()
        state.tool_processes["editor"] = _FakePopen(777)  # type: ignore[assignment]
        state.tool_processes["dialogue-graph"] = _FakePopen(778, alive=False)  # type: ignore[assignment]
        closed: list[int] = []
        with patch.object(console.ConsoleState, "_close_process_gracefully", lambda self, pid: closed.append(pid)), \
             patch.object(console.ConsoleState, "_terminate_process_group") as force:
            state.stop_children_on_exit()
        self.assertEqual(closed, [777], "只关活着的、本控制台拉起的工具")
        force.assert_not_called()

    def test_graceful_close_on_windows_posts_wm_close_to_every_visible_window(self) -> None:
        """有窗口就只发 WM_CLOSE（Qt 走 closeEvent 的未保存确认），绝不 taskkill。

        实测 `taskkill /T`（不带 /F）看到进程还有子进程（QtWebEngine 渲染子进程永远在）
        就直接拒绝、连 WM_CLOSE 都不发，所以礼貌关闭必须自己 PostMessage。
        """
        state = _state()
        posted: list[int] = []
        runs: list[list[str]] = []
        with patch.object(console.ConsoleState, "is_windows", new=property(lambda self: True)), \
             patch.object(console.ConsoleState, "_windows_of_process_tree", lambda self, pid: [111, 222]), \
             patch.object(console.ConsoleState, "_post_wm_close", lambda self, hwnd: posted.append(hwnd)), \
             patch.object(console.subprocess, "run", lambda argv, **kw: runs.append(list(argv))):
            state._close_process_gracefully(999)
        self.assertEqual(posted, [111, 222])
        self.assertEqual(runs, [], "有窗口时不许碰 taskkill")

    def test_graceful_close_on_windows_force_kills_only_when_no_window_exists(self) -> None:
        """一个可见窗口都没有 = 还没起来或已在退，没有未保存的东西可丢 → 才强杀整棵树。"""
        state = _state()
        runs: list[list[str]] = []

        def fake_run(argv, **kwargs):  # noqa: ANN001, ANN003
            runs.append(list(argv))

            class R:
                returncode = 0
            return R()

        with patch.object(console.ConsoleState, "is_windows", new=property(lambda self: True)), \
             patch.object(console.ConsoleState, "_windows_of_process_tree", lambda self, pid: []), \
             patch.object(console.subprocess, "run", fake_run):
            state._close_process_gracefully(999)
        self.assertEqual(runs, [["taskkill", "/PID", "999", "/T", "/F"]])

    def test_process_tree_pids_follows_ppid_chain_without_psutil(self) -> None:
        state = _state()
        table = [
            {"pid": 10, "ppid": 1, "argv": [], "started": None},
            {"pid": 11, "ppid": 10, "argv": [], "started": None},
            {"pid": 12, "ppid": 11, "argv": [], "started": None},
            {"pid": 99, "ppid": 1, "argv": [], "started": None},
        ]
        with patch.dict("sys.modules", {"psutil": None}), \
             patch.object(console, "list_python_processes", lambda: table):
            self.assertEqual(state._process_tree_pids(10), {10, 11, 12})

    def test_stop_tool_targets_orphans_when_nothing_is_owned(self) -> None:
        state = _state()
        orphan = [{"pid": 26608, "started": "09-08 22:32:38", "cmd": "python -m tools.editor"}]
        closed: list[int] = []
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=orphan), \
             patch.object(console.ConsoleState, "_scan_tool_instances", return_value={}), \
             patch.object(console.ConsoleState, "_close_process_gracefully", lambda self, pid: closed.append(pid)):
            ok, message = state.stop_tool("editor")
        self.assertTrue(ok)
        self.assertEqual(closed, [26608])
        self.assertIn("1 个", message)

    def test_stop_tool_reports_when_nothing_runs(self) -> None:
        state = _state()
        with patch.object(console.ConsoleState, "find_tool_instances", return_value=[]):
            ok, message = state.stop_tool("editor")
        self.assertFalse(ok)
        self.assertIn("没有在运行", message)


class SnapshotToolsTests(unittest.TestCase):
    def test_tools_status_marks_owned_and_orphan_instances(self) -> None:
        state = _state()
        state.tool_processes["editor"] = _FakePopen(4242)  # type: ignore[assignment]
        scan = {"dialogue-graph": [{"pid": 9001, "started": "09-08 22:32:38", "cmd": ""}]}
        with patch.object(console.ConsoleState, "_scan_tool_instances", return_value=scan):
            status = state.tools_status()
        self.assertEqual(status["editor"], {"running": True, "owned": True, "pid": 4242, "started": None})
        self.assertEqual(status["dialogue-graph"]["running"], True)
        self.assertEqual(status["dialogue-graph"]["owned"], False)
        self.assertEqual(status["dialogue-graph"]["pid"], 9001)
        self.assertEqual(status["workbench"]["running"], False)

    def test_snapshot_with_tools_carries_the_status_map(self) -> None:
        state = _state()
        with patch.object(console.ConsoleState, "_scan_tool_instances", return_value={}):
            data = state.snapshot_with_tools(0)
        self.assertIn("tools", data)
        self.assertIn("editor", data["tools"])

    def test_startup_warning_names_orphans(self) -> None:
        state = _state()
        scan = {"editor": [{"pid": 26608, "started": "09-08 22:32:38", "cmd": ""}]}
        with patch.object(console.ConsoleState, "_scan_tool_instances", return_value=scan):
            state.warn_about_orphans_on_startup()
        texts = [entry["text"] for entry in state.logs]
        self.assertTrue(any("26608" in t and "主编辑器" in t for t in texts), texts)


class RealProcessScanSmokeTests(unittest.TestCase):
    def test_list_python_processes_sees_this_interpreter(self) -> None:
        """真扫一次：至少能看见当前测试进程自己（pid/ppid/argv 结构完整）。"""
        import os

        procs = console.list_python_processes()
        me = [p for p in procs if p["pid"] == os.getpid()]
        self.assertEqual(len(me), 1, "进程枚举必须能看见自己，否则孤儿检测形同虚设")
        self.assertIsInstance(me[0]["argv"], list)
        self.assertIsInstance(me[0]["ppid"], int)


if __name__ == "__main__":
    unittest.main()
