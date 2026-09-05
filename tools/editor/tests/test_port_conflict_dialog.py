"""启动游戏端口冲突预检的护栏(探测真实性 + 主窗门控 + 弹窗构造)。

覆盖三层:
1. tools/dev/game.describe_port_occupants 对**真实监听 socket** 的探测
   (本测试进程自己 listen,断言能查到自己的 PID 与进程信息);
2. 主窗 `_start_game_backend` 的门控:端口被占且用户取消 → 一个 QProcess 都不起;
   用户选「结束占用进程」且端口真释放 → 继续启动(护栏从启动入口进,
   不是"手动把系统摆到断言点");
3. PortConflictDialog 离屏构造:详情文案、默认焦点在取消、系统/自身 PID 拦杀。

真实杀进程路径(taskkill/SIGTERM)不在这里跑——测试不能杀自己;
`stop_dev_ports` 被替换成"关掉测试自己开的 socket",断言的是
「以复探端口空闲为准」的 fail-safe 门控,而非 taskkill 本身。
"""
from __future__ import annotations

import os
import socket
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication, QDialog

from tools.dev.game import (
    PortOccupant, describe_port_occupants, wait_ports_free,
)
from tools.editor.shared.port_conflict_dialog import PortConflictDialog
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _listen_localhost() -> tuple[socket.socket, int]:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    return srv, srv.getsockname()[1]


class TestDescribePortOccupants(unittest.TestCase):
    def test_probe_finds_own_listener_and_frees_after_close(self) -> None:
        srv, port = _listen_localhost()
        try:
            occupants = describe_port_occupants(port)
            self.assertEqual([o.pid for o in occupants], [os.getpid()])
            occ = occupants[0]
            self.assertEqual(occ.port, port)
            # psutil 在编辑器 venv 里是登记依赖:进程名/父链应能取到
            self.assertTrue(occ.name)
            self.assertTrue(occ.parent_chain)
            self.assertIn(f"PID {os.getpid()}", occ.parent_chain[0])
        finally:
            srv.close()
        self.assertTrue(wait_ports_free((port,), timeout=5.0))
        self.assertEqual(describe_port_occupants(port), [])


class TestPortConflictDialogConstruct(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_details_and_cancel_is_default(self) -> None:
        occ = PortOccupant(
            port=5173, pid=4242, name="node.exe",
            cmdline="node vite --port 5173", username="dev\\wubugui",
            started_at="2026-09-03 10:00:00",
            parent_chain=["node.exe(PID 4242)", "cmd.exe(PID 77)"],
        )
        dlg = PortConflictDialog(5173, [occ])
        self.addCleanup(dlg.deleteLater)
        text = dlg._detail_text
        for expected in ("PID 4242", "node.exe", "node vite --port 5173",
                        "dev\\wubugui", "2026-09-03 10:00:00", "cmd.exe(PID 77)"):
            self.assertIn(expected, text)
        self.assertTrue(dlg._kill_btn.isEnabled())
        # 杀进程不可逆:回车不能落在「结束进程」上
        self.assertFalse(dlg._kill_btn.isDefault())

    def test_detail_gaps_are_labeled_not_guessed(self) -> None:
        occ = PortOccupant(port=5173, pid=4242, detail_error="psutil 不可用(x)")
        dlg = PortConflictDialog(5173, [occ])
        self.addCleanup(dlg.deleteLater)
        self.assertIn("取不到", dlg._detail_text)
        self.assertIn("psutil 不可用", dlg._detail_text)

    def test_protected_pids_disable_kill(self) -> None:
        for pid in (4, os.getpid()):
            dlg = PortConflictDialog(5173, [PortOccupant(port=5173, pid=pid)])
            self.addCleanup(dlg.deleteLater)
            self.assertFalse(dlg._kill_btn.isEnabled(), f"PID {pid} 应拦杀")


class TestStartGameBackendGate(unittest.TestCase):
    """门控从启动入口 `_start_game_backend` 进(带真实占用 socket)。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _window(self, root: Path):
        from tools.editor.main_window import MainWindow
        write_minimal_loadable_project(root)
        win = MainWindow()
        win._model.load_project(root)
        # _start_game_backend 只要求 package.json 存在
        (root / "package.json").write_text("{}\n", encoding="utf-8")
        self.addCleanup(win.deleteLater)
        return win

    def test_cancel_blocks_start_and_kill_path_starts(self) -> None:
        import tools.editor.main_window as mw

        srv, port = _listen_localhost()
        self.addCleanup(srv.close)
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            started: list[tuple] = []
            with patch.object(mw, "_GAME_DEV_PORT", port), \
                    patch.object(mw.QProcess, "start",
                                 lambda self_, *a, **k: started.append(a)):
                # 用户取消 → 不起任何进程
                with patch.object(PortConflictDialog, "exec",
                                  return_value=QDialog.DialogCode.Rejected):
                    win._start_game_backend(open_when_ready=True)
                self.assertIsNone(win._game_proc)
                self.assertEqual(started, [])

                # 预热路径不弹窗(exec 被调是失败),静默跳过
                with patch.object(PortConflictDialog, "exec",
                                  side_effect=AssertionError("预热不应弹窗")):
                    win._start_game_backend(open_when_ready=False)
                self.assertIsNone(win._game_proc)
                self.assertEqual(started, [])

                # 用户选「结束占用进程」:杀口被替换为关掉测试自己的 socket,
                # 复探端口空闲后应继续启动
                with patch.object(PortConflictDialog, "exec",
                                  return_value=QDialog.DialogCode.Accepted), \
                        patch("tools.dev.game.stop_dev_ports",
                              side_effect=lambda ports: srv.close()):
                    win._start_game_backend(open_when_ready=True)
                self.assertIsNotNone(win._game_proc)
                self.assertEqual(len(started), 1)

    def test_kill_that_fails_to_free_port_blocks_start(self) -> None:
        import tools.editor.main_window as mw

        srv, port = _listen_localhost()
        self.addCleanup(srv.close)
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            started: list[tuple] = []
            with patch.object(mw, "_GAME_DEV_PORT", port), \
                    patch.object(mw.QProcess, "start",
                                 lambda self_, *a, **k: started.append(a)), \
                    patch.object(PortConflictDialog, "exec",
                                 return_value=QDialog.DialogCode.Accepted), \
                    patch("tools.dev.game.stop_dev_ports",
                          side_effect=lambda ports: None), \
                    patch("tools.dev.game.wait_ports_free",
                          side_effect=lambda ports, timeout=3.0: False), \
                    patch.object(mw.QMessageBox, "warning") as warn:
                win._start_game_backend(open_when_ready=True)
            self.assertIsNone(win._game_proc)
            self.assertEqual(started, [])
            warn.assert_called_once()


if __name__ == "__main__":
    unittest.main()
