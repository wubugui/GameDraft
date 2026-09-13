"""F5「运行游戏」的引导态护栏：**停在标题界面**，不直接开一局主线。

为什么要测：编辑器与游戏之间只靠一个 URL query 串对齐，两边都没有类型约束——
参数名在 TS 侧改掉、或哪天有人把 `_run_game` 的缺省清空，表现都是"按 F5 直接进主线"，
不报错、不失败，只有人肉玩一遍才看得出来。所以这里断三件事：

1. F5 / Play 这条（不带 launch_params）加载的 URL 真带上了停标题参数；
2. Ctrl+F5 开发模式**不**被这条缺省污染（dev 直达是另一条路，停标题会把它废掉）；
3. 参数名/取值与 `src/core/EventBridge.ts` 的 TITLE_BOOT_PARAM、
   `tools/build/build_config.json` 的 release.bootQuery 三处同源。
"""
from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication

from tools.editor.tests.save_test_utils import (
    repo_root_from_tests, write_minimal_loadable_project,
)


# ⚠ 桩一律用普通函数,不用 MagicMock:PySide6 连信号时会扫接收者类字典里每个可调用物的
# `_slots`,MagicMock 对任意属性都回子 Mock → C++ 侧当 list 读 → access violation。
def _true(_self) -> bool:
    return True


class _StubGameBrowser:
    """只顶 `_run_game` 里那道存在性门；ready 分支不会碰它的任何方法。"""

    def show_message(self, *_a, **_k) -> None:
        pass

    def is_webengine_available(self) -> bool:
        return False


class TestRunGameStartsAtTitle(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _window_and_urls(self, root: Path):
        """造一个「dev server 已就绪」的主窗，返回 (win, 记录加载 URL 的 list)。"""
        from tools.editor.main_window import MainWindow

        write_minimal_loadable_project(root)
        (root / "package.json").write_text("{}\n", encoding="utf-8")
        win = MainWindow()
        win._model.load_project(root)
        self.addCleanup(win.deleteLater)
        win._game_server_ready = True
        win._last_vite_dev_url = "http://127.0.0.1:5173/"
        # `_run_game` 只把 `_game_browser` 当"页面已建好"的存在性门（ready 分支下
        # 真正加载 URL 的是 `_focus_game_tab_and_load`，本测试打桩拦住）。
        # 走 `win.load_project` 去建真页面会把全部编辑器面板连同 LSP/预热一起拉起来，
        # 与本测试要断的引导参数无关，这里只补这一个门。
        win._game_browser = _StubGameBrowser()
        return win

    def _load_urls_for(self, call) -> list[str]:
        import tools.editor.main_window as mw

        urls: list[str] = []

        def _record(self_, url=None, extra_params: str = "") -> None:
            target = (url or "http://127.0.0.1:5173/").rstrip("/") + "/"
            urls.append(target + ("?" + extra_params if extra_params else ""))

        with TemporaryDirectory() as td:
            win = self._window_and_urls(Path(td) / "p")
            with patch.object(mw.MainWindow, "_save_all", _true), \
                    patch.object(mw.MainWindow, "_is_game_backend_running", _true), \
                    patch.object(mw.MainWindow, "_focus_game_tab_and_load", _record):
                call(win)
        return urls

    def test_f5_boots_to_title_screen(self) -> None:
        urls = self._load_urls_for(lambda win: win._run_game())
        self.assertEqual(len(urls), 1, urls)
        self.assertIn("screen_title=1", urls[0])

    def test_dev_mode_run_is_not_diverted_to_title(self) -> None:
        """Ctrl+F5 要直达 dev 路由：停标题会排在 dev 分支之前，把它整条废掉。"""
        urls = self._load_urls_for(lambda win: win._run_game_dev())
        self.assertEqual(len(urls), 1, urls)
        self.assertIn("mode=dev", urls[0])
        self.assertNotIn("screen_title", urls[0])

    def test_preview_launch_params_untouched(self) -> None:
        """带了 launch_params 的直达路径（过场/小游戏预览）不吃这条缺省。"""
        urls = self._load_urls_for(
            lambda win: win._run_game(launch_params="mode=dev&play_cutscene=x"),
        )
        self.assertEqual(urls, ["http://127.0.0.1:5173/?mode=dev&play_cutscene=x"])

    def test_param_name_matches_game_and_release_build(self) -> None:
        from tools.editor.main_window import _TITLE_BOOT_LAUNCH_PARAMS

        repo = repo_root_from_tests()
        bridge = (repo / "src" / "core" / "EventBridge.ts").read_text(encoding="utf-8")
        m = re.search(r"TITLE_BOOT_PARAM\s*=\s*'([^']+)'", bridge)
        self.assertIsNotNone(m, "EventBridge.ts 里找不到 TITLE_BOOT_PARAM")
        self.assertEqual(_TITLE_BOOT_LAUNCH_PARAMS, f"{m.group(1)}=1")

        cfg = json.loads(
            (repo / "tools" / "build" / "build_config.json").read_text(encoding="utf-8"),
        )
        release_q = cfg["targets"]["release"]["bootQuery"]
        self.assertEqual(_TITLE_BOOT_LAUNCH_PARAMS, release_q)


if __name__ == "__main__":
    unittest.main()
