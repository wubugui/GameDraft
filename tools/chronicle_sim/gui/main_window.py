from __future__ import annotations

import asyncio
import copy
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QThreadPool, Qt, Signal
from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import (
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.layout_compact import tighten
from tools.chronicle_sim.core.simulation.orchestrator import WeekOrchestrator
from tools.chronicle_sim.core.simulation.run_manager import open_database
from tools.chronicle_sim.gui.agent_inspector.inspector_widget import AgentInspectorWidget
from tools.chronicle_sim.gui.async_runnable import CancellableAsyncWorker
from tools.chronicle_sim.gui.error_dialog import show_async_failure
from tools.chronicle_sim.gui.chronicle_tab.chronicle_widget import ChronicleWidget
from tools.chronicle_sim.gui.config_tab.config_widget import ConfigWidget
from tools.chronicle_sim.gui.export_tab.export_widget import ExportWidget
from tools.chronicle_sim.gui.probe_tab.probe_widget import ProbeWidget
from tools.chronicle_sim.core.llm.llm_trace import set_llm_trace_sink


class _ActivityLogBridge(QObject):
    """供工作线程经 Qt 信号把编排器进度投递到主线程日志。"""

    line = Signal(str)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("编年史模拟器")
        self.resize(1320, 840)
        self.setMinimumSize(960, 640)
        geo = app_settings.load_main_window_geometry()
        if geo is not None:
            self.restoreGeometry(geo)

        self._run_dir: Path | None = None
        self._db = None
        self._pool = QThreadPool.globalInstance()
        self._act_log = _ActivityLogBridge()
        self._act_log.line.connect(self.append_activity_log)
        set_llm_trace_sink(lambda m: self._act_log.line.emit(m))

        self._tabs = QTabWidget()
        self._config = ConfigWidget(self)
        self._chronicle = ChronicleWidget(self)
        self._probe = ProbeWidget(self)
        self._export = ExportWidget(self)
        self._inspector = AgentInspectorWidget(self)

        self._tabs.addTab(self._config, "配置控制台")
        self._tabs.addTab(self._chronicle, "编年史浏览器")
        self._tabs.addTab(self._probe, "探针聊天")
        self._tabs.addTab(self._export, "导出面板")
        self._tabs.addTab(self._inspector, "Agent Inspector")

        self._activity_log = QPlainTextEdit()
        self._activity_log.setReadOnly(True)
        self._activity_log.setMaximumHeight(112)
        self._activity_log.setPlaceholderText("活动日志（时间戳）：运行周次、连接测试、生成种子等。")
        self._activity_log.setToolTip("详细说明与报错堆栈也会出现在弹窗「显示详细信息」中。")

        central = QWidget()
        lay = QVBoxLayout(central)
        tighten(lay, margins=(4, 4, 4, 4), spacing=2)
        lay.addWidget(self._tabs, 1)
        lay.addWidget(self._activity_log)
        self.setCentralWidget(central)

        self._config.runChanged.connect(self._on_run_changed)
        self._config.requestRunWeek.connect(self._run_week_async)
        self._config.requestRunWeekRange.connect(self._run_week_range_async)
        self._config.seedApplied.connect(self._refresh_all)
        self._config.activityLog.connect(self.append_activity_log)
        self._chronicle.tierChangeQueued.connect(self._config.refresh_tier_queue_hint)

        self._on_run_changed(self._config.get_run_dir())
        mt = app_settings.load_main_tab_index()
        mt = max(0, min(mt, self._tabs.count() - 1))
        self._tabs.setCurrentIndex(mt)
        self._config.restore_session_prefs()
        self._chronicle.restore_ui_prefs()
        self._export.restore_ui_prefs()
        self._inspector.restore_ui_prefs()

    def append_activity_log(self, msg: str) -> None:
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        self._activity_log.appendPlainText(line)
        sb = self._activity_log.verticalScrollBar()
        sb.setValue(sb.maximum())
        t = self._activity_log.toPlainText()
        lines = t.splitlines()
        if len(lines) > 900:
            self._activity_log.setPlainText("\n".join(lines[-800:]))

    def closeEvent(self, event: QCloseEvent) -> None:
        if self._config.is_long_task_busy():
            QMessageBox.warning(
                self,
                "请稍候",
                "仍有周次模拟或推理/嵌入测试在后台执行，请等待结束或先取消后再关闭窗口。",
            )
            event.ignore()
            return
        app_settings.save_main_window_geometry(self.saveGeometry())
        app_settings.save_main_tab_index(self._tabs.currentIndex())
        self._config.save_session_prefs()
        self._chronicle.save_ui_prefs()
        self._probe.save_ui_prefs()
        self._export.save_ui_prefs()
        self._inspector.save_ui_prefs()
        self._config.persist_open_run_to_db()
        app_settings.save_last_run_path(self._run_dir)
        super().closeEvent(event)

    def _on_run_changed(self, run_dir: Path | None) -> None:
        prev = self._db
        self._run_dir = run_dir
        if run_dir and (run_dir / "run.db").is_file():
            self._db = open_database(run_dir)
        else:
            self._db = None
        if prev is not None and prev is not self._db:
            try:
                prev.close()
            except Exception:
                pass
        self._chronicle.set_database(self._db, run_dir)
        self._probe.set_database(
            self._db,
            run_dir,
            lambda: self._config.get_runtime_llm_config(),
        )
        self._export.set_database(self._db, run_dir)
        self._inspector.set_run_dir(run_dir)

    def _refresh_all(self) -> None:
        self._chronicle.refresh()
        self._export.refresh()

    def _suspend_tabs_for_week_run(self) -> None:
        if self._db is not None:
            try:
                self._db.close()
            except Exception:
                pass
            self._db = None
        rd = self._run_dir
        self._chronicle.set_database(None, rd)
        self._probe.set_database(
            None,
            rd,
            lambda: self._config.get_runtime_llm_config(),
        )
        self._export.set_database(None, rd)
        self._inspector.set_run_dir(rd)

    def _resume_tabs_after_week_run(self) -> None:
        self._config.resume_run_db_after_worker()
        self._on_run_changed(self._config.get_run_dir())

    def _run_week_async(self, week: int) -> None:
        if self._config.is_long_task_busy():
            self.append_activity_log("已有任务在执行，请勿重复点击「运行该周」。")
            return
        if not self._run_dir or not (self._run_dir / "run.db").is_file():
            QMessageBox.warning(self, "提示", "请先创建或打开 run。")
            return

        cancel_flag = threading.Event()

        def _progress(msg: str) -> None:
            self._act_log.line.emit(msg)

        llm_cfg_snap = copy.deepcopy(self._config.get_runtime_llm_config())

        async def _main() -> Any:
            from tools.chronicle_sim.core.storage.db import Database

            db_path = self._run_dir / "run.db"
            backup = self._run_dir / f"._week_{week}_rollback.bak"
            shutil.copy2(db_path, backup)
            try:
                db = Database(db_path)
                try:
                    orch = WeekOrchestrator(
                        db,
                        self._run_dir,
                        llm_cfg_snap,
                        cancel_flag=cancel_flag,
                        progress_log=_progress,
                    )
                    return await orch.run_week(week)
                finally:
                    db.close()
            except BaseException:
                try:
                    shutil.copy2(backup, db_path)
                    self._act_log.line.emit("已用周开始前备份恢复 run.db。")
                except OSError as e:
                    self._act_log.line.emit(f"恢复 run.db 失败：{e}")
                raise
            finally:
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    pass

        progress = QProgressDialog(f"正在运行第 {week} 周…", "取消", 0, 0, self)
        progress.setWindowTitle("编年史模拟")
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)
        progress.setMinimumWidth(440)

        worker = CancellableAsyncWorker(_main())

        def _close_progress() -> None:
            progress.reset()
            progress.close()

        def _done_ok(_result: Any) -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log(f"第 {week} 周：任务已成功结束。")
            self._after_week(week)

        def _done_err(summary: str, detail: str) -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log(f"第 {week} 周：失败 — {summary}")
            self._on_async_worker_error(summary, detail)

        def _done_cancel() -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log(f"第 {week} 周：已取消（若已产生写操作，run.db 已尝试恢复为周开始前备份）。")
            QMessageBox.warning(
                self,
                "已取消",
                "周次模拟已中断。若备份恢复失败，请到配置页「回滚」用快照覆盖 run.db。",
            )

        worker.signals.finished.connect(_done_ok)
        worker.signals.error.connect(_done_err)
        worker.signals.cancelled.connect(_done_cancel)

        def _on_cancel() -> None:
            cancel_flag.set()
            worker.request_cancel()
            self.append_activity_log(f"第 {week} 周：用户请求取消，正在中断…")

        progress.canceled.connect(_on_cancel)
        self._config.set_long_task_busy(True, "week")
        self._suspend_tabs_for_week_run()
        self._config.suspend_run_db_for_worker()
        self.append_activity_log(f"开始运行第 {week} 周（可点进度窗口「取消」）…")
        progress.show()
        self._pool.start(worker)

    def _run_week_range_async(self, week_start: int, week_end: int) -> None:
        if self._config.is_long_task_busy():
            self.append_activity_log("已有任务在执行，已忽略批量周次。")
            return
        if week_end < week_start:
            QMessageBox.warning(self, "提示", "结束周次不能小于起始周次。")
            return
        if not self._run_dir or not (self._run_dir / "run.db").is_file():
            QMessageBox.warning(self, "提示", "请先创建或打开 run。")
            return

        cancel_flag = threading.Event()

        def _progress(msg: str) -> None:
            self._act_log.line.emit(msg)

        llm_cfg_snap = copy.deepcopy(self._config.get_runtime_llm_config())

        async def _main() -> Any:
            from tools.chronicle_sim.core.storage.db import Database

            db_path = self._run_dir / "run.db"
            last_result: dict[str, Any] | None = None
            for wk in range(week_start, week_end + 1):
                if cancel_flag.is_set():
                    raise asyncio.CancelledError()
                backup = self._run_dir / f"._week_{wk}_rollback.bak"
                shutil.copy2(db_path, backup)
                try:
                    db = Database(db_path)
                    try:
                        orch = WeekOrchestrator(
                            db,
                            self._run_dir,
                            llm_cfg_snap,
                            cancel_flag=cancel_flag,
                            progress_log=_progress,
                        )
                        last_result = await orch.run_week(wk)
                    finally:
                        db.close()
                except BaseException:
                    try:
                        shutil.copy2(backup, db_path)
                        self._act_log.line.emit(f"第 {wk} 周失败，已恢复 run.db 至该周开始前。")
                    except OSError as e:
                        self._act_log.line.emit(f"恢复 run.db 失败：{e}")
                    raise
                finally:
                    try:
                        backup.unlink(missing_ok=True)
                    except OSError:
                        pass
            return last_result

        progress = QProgressDialog(
            f"正在批量运行第 {week_start}–{week_end} 周…", "取消", 0, 0, self
        )
        progress.setWindowTitle("编年史模拟")
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)
        progress.setMinimumWidth(440)

        worker = CancellableAsyncWorker(_main())

        def _close_progress() -> None:
            progress.reset()
            progress.close()

        def _done_ok(_result: Any) -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log(f"批量周次 {week_start}–{week_end} 已完成。")
            self._after_week(week_end)

        def _done_err(summary: str, detail: str) -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log(f"批量周次失败 — {summary}")
            self._on_async_worker_error(summary, detail)

        def _done_cancel() -> None:
            _close_progress()
            self._config.set_long_task_busy(False, "")
            self._resume_tabs_after_week_run()
            self.append_activity_log("批量周次已取消。")
            QMessageBox.warning(self, "已取消", "批量运行已中断。")

        worker.signals.finished.connect(_done_ok)
        worker.signals.error.connect(_done_err)
        worker.signals.cancelled.connect(_done_cancel)

        def _on_cancel() -> None:
            cancel_flag.set()
            worker.request_cancel()

        progress.canceled.connect(_on_cancel)
        self._config.set_long_task_busy(True, "week")
        self._suspend_tabs_for_week_run()
        self._config.suspend_run_db_for_worker()
        self.append_activity_log(f"开始批量运行第 {week_start}–{week_end} 周…")
        progress.show()
        self._pool.start(worker)

    def _on_async_worker_error(self, summary: str, detail: str) -> None:
        show_async_failure(self, "运行失败", summary, detail)

    def _after_week(self, week: int) -> None:
        self.append_activity_log(f"第 {week} 周已推进（界面已刷新）。")
        self._refresh_all()
        self._config.reload_run_meta()
        self._config.refresh_tier_queue_hint()
