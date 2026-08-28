"""构建管理工作台主窗口：把调度、构建、归档三件事串起来。"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QLabel, QMainWindow, QMenu, QMessageBox, QStatusBar, QStyle, QSystemTrayIcon,
    QTabWidget, QWidget,
)

from .archive import find_seven_zip
from .builds import builds_to_archive, archives_to_drop, new_build_dir_name, scan_archives, scan_builds
from .config import BUILD_TARGET, AutoBuildConfig, load_config
from .runner import ArchiveWorker, BuildRequest, BuildRunner, RestoreWorker
from .tab_archive import ArchiveTab
from .tab_builds import BuildsTab
from .tab_settings import SettingsTab

#: 调度轮询间隔。到点判定精确到分钟就够，30 秒的轮询不会让人等太久也不烧 CPU。
_TICK_MS = 30_000


class BuildWorkbenchWindow(QMainWindow):
    def __init__(self, project_root: Path) -> None:
        super().__init__()
        self._project_root = project_root
        self._cfg: AutoBuildConfig = load_config(project_root)
        self._last_auto_build: datetime | None = None
        #: **下次到期时刻**必须记成状态，不能每拍从 `next_run_after` 重算。
        #: 那个函数按定义返回的是"未来的下一次"，每拍重算的话 `now >= 它` 永远不成立，
        #: 自动构建一次都不会触发。记成状态之后，语义也正好是想要的：
        #: 开工作台时定下一个**将来**的点（不补跑错过的），到点构建，构建完再定下一个。
        self._next_due: datetime | None = None
        #: 真退出（走托盘菜单）时置 True；否则关窗口只是缩到托盘
        self._quitting = False
        self._tray: QSystemTrayIcon | None = None
        self._tray_hint_shown = False
        self._workers: list[object] = []  # 拿住引用，别让 QThread 被 GC 掉

        self.setWindowTitle(f"GameDraft 构建管理　·　{project_root}")
        self.resize(1180, 760)

        self._settings = SettingsTab(project_root, self._cfg)
        self._builds = BuildsTab()
        self._archives = ArchiveTab()

        tabs = QTabWidget()
        tabs.addTab(self._builds, "构建")
        tabs.addTab(self._archives, "归档")
        tabs.addTab(self._settings, "自动构建")
        self.setCentralWidget(tabs)

        self._status = QStatusBar()
        self._status_label = QLabel("")
        self._status.addPermanentWidget(self._status_label)
        self.setStatusBar(self._status)

        self._runner = BuildRunner(self)
        self._runner.line.connect(self._builds.console.append)
        self._runner.finished_ok.connect(self._on_build_ok)
        self._runner.finished_fail.connect(self._on_build_fail)

        self._settings.config_changed.connect(self._reload_config)
        self._builds.build_requested.connect(self._build_now)
        self._builds.cancel_btn.clicked.connect(self._runner.cancel)
        self._builds.archive_requested.connect(self._tidy_now)
        self._archives.restore_requested.connect(self._restore)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(_TICK_MS)

        self._setup_tray()
        self._reload_config()

    # ------------------------------------------------------------ 配置

    def _reload_config(self) -> None:
        self._cfg = load_config(self._project_root)
        root = Path(self._cfg.builds_root) if self._cfg.builds_root.strip() else None
        self._builds.set_builds_root(root)
        self._archives.set_archive_root(self._cfg.resolved_archive_root())
        self._settings.load_from(self._cfg)
        self._reschedule()

    def _reschedule(self) -> None:
        """重新定下一次到期时刻。配置变了、构建完了各调一次。"""
        if not self._cfg.enabled or self._cfg.validation_errors():
            self._next_due = None
        else:
            self._next_due = self._cfg.next_run_after(self._last_auto_build, datetime.now())
        self._refresh_next_run()

    def _refresh_next_run(self) -> None:
        if not self._cfg.enabled or self._cfg.validation_errors():
            self._settings.set_next_run(None)
            self._status_label.setText("自动构建：关")
        elif self._next_due is None:
            self._settings.set_next_run(None)
            self._status_label.setText("自动构建：开，但排不出下一次（周几一天都没选？）")
        else:
            self._settings.set_next_run(self._next_due)
            self._status_label.setText(
                f"自动构建：{self._cfg.schedule_text()}　下次 {self._next_due:%m-%d %H:%M}"
            )
        # 每条分支都要同步：缩在托盘里时，那行状态是唯一能看见调度状况的地方
        self._sync_tray_status()

    # ------------------------------------------------------------ 调度

    def _tick(self) -> None:
        self._refresh_next_run()
        if not self._cfg.enabled or self._cfg.validation_errors():
            return
        if self._next_due is None:
            return
        if self._runner.is_running():
            return  # 上一次还没跑完就跳过这一拍，不排队堆积
        now = datetime.now()
        if now < self._next_due:
            return
        self._builds.console.append(f"▶ 到点了，开始自动构建（{now:%Y-%m-%d %H:%M}）")
        self._last_auto_build = now
        self._reschedule()
        self._start_build(auto=True)

    # ------------------------------------------------------------ 构建

    def _build_now(self) -> None:
        self._start_build(auto=False)

    def _start_build(self, *, auto: bool) -> None:
        if self._runner.is_running():
            return
        root_text = self._cfg.builds_root.strip()
        if not root_text:
            QMessageBox.warning(self, "还没设构建根目录", "去「自动构建」页设一个再来。")
            return
        out_dir = Path(root_text) / new_build_dir_name(datetime.now())
        req = BuildRequest(
            project_root=self._project_root,
            out_dir=out_dir,
            # 自动构建只做发行档；dev 档是开发自用的，走主编辑器手动构建
            target=BUILD_TARGET,
            skip_verify=self._cfg.skip_verify,
        )
        self._builds.console.append(
            f"▶ {'自动' if auto else '手动'}构建 → {out_dir}"
        )
        if not self._runner.start(req):
            self._builds.console.append("✖ 启动失败")
            return
        self._builds.set_running(True)

    def _on_build_ok(self, req: BuildRequest) -> None:
        self._builds.set_running(False)
        self._builds.console.append(f"✓ 构建完成：{req.out_dir}")
        self._builds.refresh()
        # 构建完顺手按保留策略整理一次；这是"定期构建 + 定期归档"里的第二半
        self._tidy_now(silent=True)

    def _on_build_fail(self, req: BuildRequest, tail: str) -> None:
        self._builds.set_running(False)
        self._builds.console.append(f"✖ 构建失败：{req.out_dir}")
        if tail:
            self._builds.console.append(tail)
        self._builds.refresh()

    # ------------------------------------------------------------ 归档

    def _tidy_now(self, silent: bool = False) -> None:
        root = Path(self._cfg.builds_root) if self._cfg.builds_root.strip() else None
        arc_root = self._cfg.resolved_archive_root()
        if root is None or arc_root is None:
            if not silent:
                QMessageBox.warning(self, "还没设目录", "构建根目录还没设。")
            return

        stale = builds_to_archive(scan_builds(root), self._cfg.keep_uncompressed)
        if not stale:
            if not silent:
                self._builds.console.append(
                    f"· 没有需要归档的：未压缩构建不超过 {self._cfg.keep_uncompressed} 份"
                )
            self._drop_old_archives(arc_root)
            return

        seven = find_seven_zip(self._cfg.seven_zip_path)
        if not seven:
            self._builds.console.append(
                "✖ 找不到 7z，归档跳过（winget install 7zip.7zip，或去「自动构建」页指定路径）"
            )
            return

        self._builds.console.append(f"▶ 归档 {len(stale)} 份旧构建 → {arc_root}")
        worker = ArchiveWorker(stale, arc_root, seven, self)
        self._workers.append(worker)
        worker.progress.connect(self._builds.console.append)
        worker.done.connect(lambda results: self._on_archive_done(results, arc_root, worker))
        worker.start()

    def _on_archive_done(self, results: list, arc_root: Path, worker: object) -> None:
        ok = sum(1 for r in results if getattr(r, "ok", False))
        self._builds.console.append(f"✓ 归档完成：{ok}/{len(results)} 份")
        for r in results:
            if not getattr(r, "ok", False):
                self._builds.console.append(f"  ✖ {getattr(r, 'message', r)}")
        self._drop_old_archives(arc_root)
        self._builds.refresh()
        self._archives.refresh()
        if worker in self._workers:
            self._workers.remove(worker)

    def _drop_old_archives(self, arc_root: Path) -> None:
        """超出保留份数的归档删掉。`keep_archives == 0` = 永久留档，什么都不删。"""
        doomed = archives_to_drop(scan_archives(arc_root), self._cfg.keep_archives)
        if not doomed:
            return
        from .archive import delete_path
        for a in doomed:
            ok, msg = delete_path(a.path)
            self._builds.console.append(("· " if ok else "✖ ") + msg)
        self._archives.refresh()

    def _restore(self, entry: object) -> None:
        root = Path(self._cfg.builds_root) if self._cfg.builds_root.strip() else None
        if root is None:
            QMessageBox.warning(self, "还没设构建根目录", "还原后的包要放进构建根目录。")
            return
        seven = find_seven_zip(self._cfg.seven_zip_path)
        if not seven:
            QMessageBox.warning(self, "找不到 7z", "装一个再来：winget install 7zip.7zip")
            return
        worker = RestoreWorker(getattr(entry, "path"), root, seven, self)
        self._workers.append(worker)
        worker.progress.connect(self._builds.console.append)
        worker.done.connect(lambda ok, msg: self._on_restore_done(ok, msg, worker))
        worker.start()
        self._builds.console.append(f"▶ 还原 {getattr(entry, 'name', '?')}…")

    def _on_restore_done(self, ok: bool, msg: str, worker: object) -> None:
        self._builds.console.append(("✓ 已还原到 " if ok else "✖ 还原失败：") + msg)
        self._builds.refresh()
        if worker in self._workers:
            self._workers.remove(worker)

    # ------------------------------------------------------------ 收尾

    def wait_for_background_threads(self, timeout_ms: int = 30_000) -> None:
        """等后台线程收干净。

        QThread 仍 running 时随栈析构会让 Qt `qFatal` 掉整个进程，而 `closeEvent`
        那道拦截挡不住 `QApplication.quit()` 和槽函数异常外抛两条路
        （production_workbench 踩过同一个坑，见它的 `main.py`）。
        """
        from PySide6.QtCore import QThread
        for t in self.findChildren(QThread):
            if t.isRunning():
                t.wait(timeout_ms)

    # ------------------------------------------------------------ 托盘

    def _setup_tray(self) -> None:
        """托盘图标 + 菜单。

        调度靠这个进程活着，所以「关窗口」缺省是**缩到托盘**而不是退出——
        一次误点关闭就等于悄悄停掉了自动构建，而且不会有任何提示。
        真要退出走托盘菜单的「退出」。
        """
        if not QSystemTrayIcon.isSystemTrayAvailable():
            self._tray = None
            return
        icon = self.windowIcon()
        if icon.isNull():
            icon = self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        tray = QSystemTrayIcon(icon, self)
        tray.setToolTip("GameDraft 构建管理")

        menu = QMenu()
        act_show = menu.addAction("显示窗口")
        act_show.triggered.connect(self._restore_from_tray)
        act_build = menu.addAction("立即构建")
        act_build.triggered.connect(self._build_now)
        menu.addSeparator()
        self._tray_status = menu.addAction("")
        self._tray_status.setEnabled(False)
        menu.addSeparator()
        act_quit = menu.addAction("退出")
        act_quit.triggered.connect(self._really_quit)

        tray.setContextMenu(menu)
        tray.activated.connect(self._on_tray_activated)
        tray.show()
        self._tray = tray

    def _on_tray_activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._restore_from_tray()

    def _restore_from_tray(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def activate_from_other_instance(self, payload: dict) -> None:
        """有人又启动了一次：把窗口唤到前台。

        如果对面想打开的是**另一个工程**，必须说出来——否则他会对着一个服务于
        别的仓库的工作台以为自己打开对了。单实例是全局的，一次只能服务一个工程。
        """
        self._restore_from_tray()
        other = str((payload or {}).get("projectRoot") or "")
        if other and Path(other) != self._project_root:
            QMessageBox.information(
                self, "已经在跑另一个工程",
                f"构建工作台整个系统只跑一个实例，当前服务的是：\n{self._project_root}\n\n"
                f"你想打开的是：\n{other}\n\n"
                "要切过去的话，先从托盘菜单「退出」，再从那个工程打开。",
            )

    def _really_quit(self) -> None:
        self._quitting = True
        self.close()

    def _sync_tray_status(self) -> None:
        if self._tray is None:
            return
        text = self._status_label.text() or "构建管理"
        self._tray_status.setText(text)
        self._tray.setToolTip(f"GameDraft 构建管理\n{text}")

    # ------------------------------------------------------------ 关闭

    def closeEvent(self, event) -> None:  # noqa: N802
        from PySide6.QtCore import QThread

        # 缩到托盘：不是真的关，所以后台任务照跑，什么都不用问
        if not self._quitting and self._cfg.minimize_to_tray and self._tray is not None:
            event.ignore()
            self.hide()
            if not self._tray_hint_shown:
                self._tray_hint_shown = True
                self._tray.showMessage(
                    "还在后台跑着",
                    "构建管理缩到托盘了——定时构建靠它活着。真要退出走托盘菜单的「退出」。",
                    QSystemTrayIcon.MessageIcon.Information, 5000,
                )
            return

        busy = [t for t in self.findChildren(QThread) if t.isRunning()]
        if self._runner.is_running():
            if QMessageBox.question(
                self, "构建还在跑", "退出会中止正在进行的构建，确定？",
            ) != QMessageBox.StandardButton.Yes:
                event.ignore()
                self._quitting = False
                return
            self._runner.cancel()
        if busy:
            QMessageBox.information(
                self, "还有后台任务", f"{len(busy)} 个归档/还原任务还在跑，等它们结束。",
            )
            event.ignore()
            self._quitting = False
            return
        if self._tray is not None:
            self._tray.hide()
        super().closeEvent(event)
