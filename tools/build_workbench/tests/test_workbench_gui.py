"""构建工作台的 GUI 冒烟：装得起来、配置能往返、按钮门控对、调度不误触发。

离屏跑（`tools/conftest.py` 已把 QT_QPA_PLATFORM 设成 offscreen）。
这里**不真跑构建**——那要两分多钟且依赖 Rust/ffmpeg；真构建由
`scripts/release.mjs` 那条线自己验。这里只保证工作台这一层不坏。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.build_workbench.builds import BUILD_MARKER  # noqa: E402
from tools.build_workbench.config import AutoBuildConfig, load_config, save_config  # noqa: E402
from tools.build_workbench.console import BuildConsole, infer_severity  # noqa: E402
from tools.build_workbench.tab_builds import BuildsTab  # noqa: E402
from tools.build_workbench.tab_settings import SettingsTab  # noqa: E402
from tools.build_workbench.window import BuildWorkbenchWindow  # noqa: E402


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


def _fake_repo(root: Path) -> Path:
    """伪造一个"看起来像 GameDraft 仓库根"的目录。"""
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "release.mjs").write_text("// stub\n", encoding="utf-8")
    return root


def _make_build(root: Path, name: str, built_at: str, *, verified: bool = True) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "gamedraft.exe").write_bytes(b"MZ")
    (d / BUILD_MARKER).write_text(json.dumps({
        "target": "release", "builtAt": built_at,
        "fileCount": 2, "totalBytes": 2, "verified": verified,
    }), encoding="utf-8")
    return d


class WindowSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = _fake_repo(Path(self._tmp.name))
        self.addCleanup(self._tmp.cleanup)

    def test_三个页签都在(self) -> None:
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        tabs = w.centralWidget()
        self.assertEqual(
            [tabs.tabText(i) for i in range(tabs.count())],
            ["构建", "归档", "自动构建"],
        )

    def test_没配构建根目录时不炸_并说清楚(self) -> None:
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        # 列表为空且给出提示，而不是抛异常
        w._builds.refresh()
        self.assertIn("构建根目录", w._builds._summary.text())

    def test_读得到已有构建(self) -> None:
        builds_root = self.root / "builds"
        _make_build(builds_root, "2026-08-28_0400", "2026-08-28T04:00:00Z")
        _make_build(builds_root, "2026-08-27_0400", "2026-08-27T04:00:00Z", verified=False)
        save_config(self.root, AutoBuildConfig(builds_root=str(builds_root)))

        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        self.assertEqual(w._builds._table.rowCount(), 2)
        # 新的在前
        self.assertEqual(w._builds._table.item(0, 0).text(), "2026-08-28_0400")
        self.assertEqual(w._builds._table.item(1, 4).text(), "未验收")

    def test_自动构建没开时不会到点触发(self) -> None:
        save_config(self.root, AutoBuildConfig(
            enabled=False, builds_root=str(self.root / "builds"),
        ))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        w._tick()  # 关着就该原地返回
        self.assertFalse(w._runner.is_running())

    def test_配置不合法时不会到点触发(self) -> None:
        """开了但没设构建根目录——不能因为"开着"就去构建到一个不存在的地方。"""
        save_config(self.root, AutoBuildConfig(enabled=True, builds_root=""))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        w._tick()
        self.assertFalse(w._runner.is_running())
        self.assertIn("自动构建：关", w._status_label.text())

    def test_开着且合法时会定下一个将来的到期时刻(self) -> None:
        """钉住那个踩过的坑：到期时刻必须是**状态**，而且必须在将来
        （每拍重算的话永远不会到点，自动构建一次都不触发）。"""
        save_config(self.root, AutoBuildConfig(
            enabled=True, builds_root=str(self.root / "builds"),
            schedule_mode="daily", build_at="04:00",
        ))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        self.assertIsNotNone(w._next_due)
        self.assertGreater(w._next_due, datetime.now())
        self.assertIn("下次", w._status_label.text())

    def test_按周一天没选时说清楚而不是静默不干活(self) -> None:
        save_config(self.root, AutoBuildConfig(
            enabled=True, builds_root=str(self.root / "builds"),
            schedule_mode="weekly", weekdays=[],
        ))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        w._tick()
        self.assertFalse(w._runner.is_running())
        # 配置校验会先拦下来（"至少要选一天"），状态栏显示为关
        self.assertIn("自动构建：关", w._status_label.text())


class TrayAndQuitTests(unittest.TestCase):
    """关窗口默认缩托盘——一次误点关闭就等于悄悄停掉自动构建。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = _fake_repo(Path(self._tmp.name))
        self.addCleanup(self._tmp.cleanup)

    def test_关窗口默认不退出而是藏起来(self) -> None:
        save_config(self.root, AutoBuildConfig(minimize_to_tray=True))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w._really_quit)
        if w._tray is None:
            self.skipTest("这个环境没有系统托盘")
        w.show()
        w.close()
        self.assertFalse(w.isVisible())      # 藏了
        self.assertFalse(w._quitting)        # 但没退

    def test_托盘菜单的退出是真退出(self) -> None:
        save_config(self.root, AutoBuildConfig(minimize_to_tray=True))
        w = BuildWorkbenchWindow(self.root)
        if w._tray is None:
            self.skipTest("这个环境没有系统托盘")
        w._really_quit()
        self.assertTrue(w._quitting)

    def test_关掉缩托盘选项后关窗口就是关窗口(self) -> None:
        save_config(self.root, AutoBuildConfig(minimize_to_tray=False))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w.close)
        w.show()
        w.close()
        self.assertFalse(w.isVisible())

    def test_托盘状态跟着调度走(self) -> None:
        save_config(self.root, AutoBuildConfig(
            enabled=True, builds_root=str(self.root / "b"),
            schedule_mode="daily", build_at="04:00",
        ))
        w = BuildWorkbenchWindow(self.root)
        self.addCleanup(w._really_quit)
        if w._tray is None:
            self.skipTest("这个环境没有系统托盘")
        # 缩在托盘里时，这行是唯一看得见调度状况的地方
        self.assertIn("下次", w._tray_status.text())


class SingleInstanceTests(unittest.TestCase):
    """整个系统只跑一个实例。

    两个实例同时跑不是"多开个窗口"这么轻：它们各有一个调度定时器，
    到点会同时起两次构建，抢同一个输出目录。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def test_干净环境下占得住(self) -> None:
        from tools.build_workbench.single_instance import SingleInstanceGuard
        g = SingleInstanceGuard()
        self.assertTrue(g.acquire(), "没人在跑却占不住")
        g.release()

    def test_第二个守卫占不住_这就是单实例本身(self) -> None:
        """核心性质：已经有人在跑时，第二个**当不上主实例**。

        当上了的话两个进程各有一个调度定时器，到点同时起两次构建、
        抢同一个输出目录。
        """
        from tools.build_workbench.single_instance import SingleInstanceGuard
        first = SingleInstanceGuard()
        second = SingleInstanceGuard()
        self.assertTrue(first.acquire())
        try:
            self.assertFalse(second.acquire(), "第二个也占住了——单实例没生效")
        finally:
            second.release()
            first.release()

    def test_释放之后又能占住(self) -> None:
        from tools.build_workbench.single_instance import SingleInstanceGuard
        g1 = SingleInstanceGuard()
        self.assertTrue(g1.acquire())
        g1.release()
        g2 = SingleInstanceGuard()
        self.assertTrue(g2.acquire(), "释放之后应当能重新占住")
        g2.release()

    def test_把对面的工程路径带过来(self) -> None:
        """带过去是为了在服务的是另一个工程时能说出来，而不是让人对着错的仓库发呆。

        **必须真起一个子进程。** 同进程里做不到：客户端那边是阻塞等待，
        而服务端的事件循环正压在它下面的调用栈上——谁也动不了。生产里
        本来就是两个进程，这么测才是测真的。
        """
        import subprocess
        import textwrap
        from tools.build_workbench.single_instance import SingleInstanceGuard

        g = SingleInstanceGuard()
        got: list[dict] = []
        g.activate_requested.connect(got.append)
        self.assertTrue(g.acquire(), "占不住单实例锁（是不是有工作台在跑？）")
        try:
            code = textwrap.dedent(f"""
                import os, sys
                os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
                sys.path.insert(0, {str(_ROOT)!r})
                from pathlib import Path
                from PySide6.QtWidgets import QApplication
                app = QApplication([])
                from tools.build_workbench.single_instance import SingleInstanceGuard
                ok = SingleInstanceGuard.try_notify_existing(Path("D:/别的工程"))
                print("ACK" if ok else "NOACK")
            """)
            proc = subprocess.Popen(
                [sys.executable, "-c", code],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            # 一边泵事件一边等子进程——服务端要在这段时间里把消息读走并回确认
            for _ in range(600):
                self.app.processEvents()
                if proc.poll() is not None and got:
                    break
                self.app.thread().msleep(10)
            out, err = proc.communicate(timeout=30)

            self.assertTrue(got, f"没收到激活请求；子进程输出：{out!r} {err!r}")
            self.assertEqual(got[0].get("projectRoot"), str(Path("D:/别的工程")))
            # 对面拿到确认才算数——它据此报告"已唤到前台"
            self.assertIn("ACK", out, "子进程没收到确认，它会以为没人在跑")
        finally:
            g.release()


class AutostartTests(unittest.TestCase):
    """只测纯逻辑，**不真去改注册表**。"""

    def test_命令行把带空格的路径引起来(self) -> None:
        from tools.build_workbench import autostart
        cmd = autostart.build_command(Path(r"D:\我的 工程"), python_exe=r"C:\py\python.exe")
        self.assertIn('"D:\\我的 工程"', cmd)
        self.assertIn("-m tools.build_workbench", cmd)

    def test_启动方式只有一处_自启与编辑器按钮同源(self) -> None:
        """两处要是各写各的，改入口时很容易只改到一半（自启还用着旧模块名）。"""
        from tools.build_workbench import autostart
        argv = autostart.launch_argv(Path(r"D:\我的 工程"), python_exe=r"C:\py\python.exe")
        self.assertEqual(argv[1:], ["-m", "tools.build_workbench", r"D:\我的 工程"])
        # 注册表那份就是同一个 argv 加引号
        cmd = autostart.build_command(Path(r"D:\我的 工程"), python_exe=r"C:\py\python.exe")
        for part in ("tools.build_workbench", "我的 工程"):
            self.assertIn(part, cmd)

    def test_优先用_pythonw_免得挂个黑窗口(self) -> None:
        from tools.build_workbench import autostart
        real = Path(sys.executable)
        cmd = autostart.build_command(Path("D:/x"), python_exe=str(real))
        if real.with_name("pythonw.exe").is_file():
            self.assertIn("pythonw", cmd)
        else:
            self.assertIn(real.name, cmd)  # 没有 pythonw 就退回 python，不能起不来

    def test_不支持的平台如实报告(self) -> None:
        from tools.build_workbench import autostart
        if autostart.is_supported():
            self.skipTest("这是 Windows，走的是支持路径")
        ok, msg = autostart.set_enabled(Path("D:/x"), True)
        self.assertFalse(ok)
        self.assertIn("不支持", msg)


class SettingsTabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = _fake_repo(Path(self._tmp.name))
        self.addCleanup(self._tmp.cleanup)

    def test_界面与配置往返(self) -> None:
        cfg = AutoBuildConfig(
            enabled=True, schedule_mode="weekly", build_at="22:30",
            every_n_days=4, weekdays=[1, 4],
            builds_root="D:/b", keep_uncompressed=7, keep_archives=12,
            archive_root="E:/a", seven_zip_path="C:/7z.exe", skip_verify=True,
        )
        tab = SettingsTab(self.root, cfg)
        self.addCleanup(tab.deleteLater)
        self.assertEqual(tab.to_config().to_dict(), cfg.to_dict())

    def test_按天与按周互斥显示(self) -> None:
        tab = SettingsTab(self.root, AutoBuildConfig(schedule_mode="daily"))
        self.addCleanup(tab.deleteLater)
        self.assertTrue(tab._every_n_days.isVisibleTo(tab))
        self.assertFalse(tab._weekday_widget.isVisibleTo(tab))

        tab.load_from(AutoBuildConfig(schedule_mode="weekly"))
        self.assertFalse(tab._every_n_days.isVisibleTo(tab))
        self.assertTrue(tab._weekday_widget.isVisibleTo(tab))

    def test_界面上给出人话描述(self) -> None:
        tab = SettingsTab(self.root, AutoBuildConfig(
            schedule_mode="weekly", build_at="22:30", weekdays=[0, 4]))
        self.addCleanup(tab.deleteLater)
        self.assertEqual(tab._sched_summary.text(), "每周周一、周五 22:30")

    def test_没有按小时这种选项(self) -> None:
        """一次构建 569 MB / 两分多钟，按小时排等于一天堆十几 GB —— 这个口子不该存在。"""
        tab = SettingsTab(self.root, AutoBuildConfig())
        self.addCleanup(tab.deleteLater)
        modes = [tab._mode.itemData(i) for i in range(tab._mode.count())]
        self.assertEqual(modes, ["daily", "weekly"])

    def test_没开自动构建时允许存半份配置(self) -> None:
        """慢慢填的过程中不该被校验拦住。"""
        tab = SettingsTab(self.root, AutoBuildConfig(enabled=False, builds_root=""))
        self.addCleanup(tab.deleteLater)
        tab._save()
        self.assertFalse(load_config(self.root).enabled)


class BuildsTabTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def test_没选中时逐项操作按钮是灰的(self) -> None:
        tab = BuildsTab()
        self.addCleanup(tab.deleteLater)
        self.assertFalse(tab._open_btn.isEnabled())
        self.assertFalse(tab._run_btn.isEnabled())
        self.assertFalse(tab._del_btn.isEnabled())

    def test_构建期间禁掉构建与整理_只留中止(self) -> None:
        tab = BuildsTab()
        self.addCleanup(tab.deleteLater)
        tab.set_running(True)
        self.assertFalse(tab.build_btn.isEnabled())
        self.assertFalse(tab.archive_btn.isEnabled())
        self.assertTrue(tab.cancel_btn.isEnabled())
        tab.set_running(False)
        self.assertTrue(tab.build_btn.isEnabled())
        self.assertFalse(tab.cancel_btn.isEnabled())


class ConsoleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = _app()

    def test_等级判定_错误优先(self) -> None:
        self.assertEqual(infer_severity("✖ 验收不通过，不出包"), "error")
        self.assertEqual(infer_severity("  ⚠ 音频未转码"), "warn")
        self.assertEqual(infer_severity("▶ 1/4 抽取内容"), "step")
        self.assertEqual(infer_severity("  ✓ 没有 authoring 残留"), "ok")
        self.assertEqual(infer_severity("  素材：1416 个文件"), "info")

    def test_一行同时像错误和成功时算错误(self) -> None:
        """满屏红等于没有红，但"失败"这个词出现时不能判成 ok。"""
        self.assertEqual(infer_severity("完成，但有 2 个失败"), "error")

    def test_只看问题会滤掉普通行(self) -> None:
        c = BuildConsole()
        self.addCleanup(c.deleteLater)
        c.append("▶ 步骤")
        c.append("✖ 出错了")
        self.assertTrue(c.has_errors())
        c._only_problems.setChecked(True)
        c._rerender()
        self.assertIn("出错了", c._view.toPlainText())
        self.assertNotIn("步骤", c._view.toPlainText())

    def test_超过上限从头丢_不无限涨(self) -> None:
        c = BuildConsole()
        self.addCleanup(c.deleteLater)
        c._MAX_LINES = 10
        for i in range(25):
            c.append(f"line {i}")
        self.assertLessEqual(len(c._lines), 10)
        self.assertIn("line 24", c.to_plain_text())


if __name__ == "__main__":
    unittest.main()
