"""模拟标签页：周控制 + 进度 + NPC 状态面板 + 活动日志。"""
from __future__ import annotations

import asyncio
from pathlib import Path

# 相对 Run 根目录，UTF-8 追加写入（与界面活动日志一致）
ACTIVITY_LOG_REL = Path("logs") / "activity.log"

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QTextCursor
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QProgressBar,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim_v2.gui.async_runnable import CancellableAsyncWorker
from tools.chronicle_sim_v2.core.world.fs import read_json, write_json
from tools.chronicle_sim_v2.core.world.seed_reader import read_all_agents
from tools.chronicle_sim_v2.core.sim.run_manager import load_run_meta


class SimulationTab(QWidget):
    log_signal = Signal(str)
    run_changed = Signal(object)
    running_changed = Signal(bool)  # 模拟运行状态变化
    # 工作线程里的协程只能通过信号更新 UI（否则 Qt 会崩溃）
    sim_progress_signal = Signal(int)
    sim_status_signal = Signal(str)
    sim_spins_signal = Signal(int)
    sim_refresh_npc_signal = Signal()
    sim_running_done_signal = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._run_dir: Path | None = None
        self._llm_config: dict = {}
        self._worker: CancellableAsyncWorker | None = None
        self._running = False

        layout = QVBoxLayout(self)

        # === 控制区 ===
        ctrl_layout = QHBoxLayout()
        self.btn_run_week = QPushButton("运行本周")
        self.btn_run_week.clicked.connect(self._run_week)
        ctrl_layout.addWidget(self.btn_run_week)

        self.btn_run_range = QPushButton("运行范围")
        self.btn_run_range.clicked.connect(self._run_range)
        ctrl_layout.addWidget(self.btn_run_range)

        ctrl_layout.addWidget(QLabel("从:"))
        self.from_spin = QSpinBox()
        self.from_spin.setRange(1, 999)
        self.from_spin.setValue(1)
        ctrl_layout.addWidget(self.from_spin)

        ctrl_layout.addWidget(QLabel("到:"))
        self.to_spin = QSpinBox()
        self.to_spin.setRange(1, 999)
        self.to_spin.setValue(1)
        ctrl_layout.addWidget(self.to_spin)

        ctrl_layout.addStretch()
        layout.addLayout(ctrl_layout)

        # === 进度条 ===
        self.progress_bar = QProgressBar()
        self.progress_bar.setTextVisible(True)
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        # === 状态标签 ===
        self.status_label = QLabel("就绪")
        self.status_label.setStyleSheet("QLabel { font-weight: bold; }")
        layout.addWidget(self.status_label)

        # === NPC 面板（与种子编辑一致：Tier=等级、生命状态；可编辑并保存到 world/agents）===
        npc_outer = QVBoxLayout()
        npc_toolbar = QHBoxLayout()
        npc_toolbar.addWidget(QLabel("NPC:"))
        self.btn_save_npc = QPushButton("保存 Tier / 生命状态")
        self.btn_save_npc.setToolTip("将表格中的等级与生命状态写回 world/agents/*.json（与种子编辑页「保存 Tier」相同含义）")
        self.btn_save_npc.clicked.connect(self._save_npc_tiers)
        npc_toolbar.addWidget(self.btn_save_npc)
        npc_toolbar.addStretch()
        npc_outer.addLayout(npc_toolbar)

        self.npc_table = QTableWidget()
        self.npc_table.setColumnCount(5)
        self.npc_table.setHorizontalHeaderLabels(["ID", "名称", "Tier", "生命状态", "位置"])
        hdr = self.npc_table.horizontalHeader()
        hdr.setStretchLastSection(True)
        hdr.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        npc_outer.addWidget(self.npc_table)
        layout.addLayout(npc_outer, 1)

        # === 活动日志 ===
        layout.addWidget(QLabel("活动日志:"))
        self.progress_log = QTextEdit()
        self.progress_log.setReadOnly(True)
        self.progress_log.setStyleSheet("QTextEdit { font-family: monospace; font-size: 11px; }")
        layout.addWidget(self.progress_log)

        # 与主窗口底部日志同源；此处同步显示模拟过程（工作线程经信号排队到主线程）
        self.log_signal.connect(self._append_activity_log, Qt.QueuedConnection)

        self.sim_progress_signal.connect(self.progress_bar.setValue, Qt.QueuedConnection)
        self.sim_status_signal.connect(self.status_label.setText, Qt.QueuedConnection)
        self.sim_spins_signal.connect(self._set_both_week_spins, Qt.QueuedConnection)
        self.sim_refresh_npc_signal.connect(self._refresh_npc_table, Qt.QueuedConnection)
        self.sim_running_done_signal.connect(self._on_sim_running_done, Qt.QueuedConnection)

    def _set_both_week_spins(self, value: int) -> None:
        self.from_spin.setValue(value)
        self.to_spin.setValue(value)

    def _on_sim_running_done(self) -> None:
        self._set_running(False)

    def set_run_dir(self, run_dir: Path | None, llm_config: dict | None = None) -> None:
        self._run_dir = run_dir
        if llm_config is not None:
            self._llm_config = llm_config
        if run_dir:
            meta = load_run_meta(run_dir)
            if meta:
                current = meta.get("current_week", 0)
                self.from_spin.setValue(current + 1)
                self.to_spin.setValue(current + 1)
            self._refresh_npc_table()
            self._load_activity_log_from_disk()
        else:
            self.npc_table.setRowCount(0)
            self.progress_log.clear()
        self._update_npc_save_enabled()

    def _activity_log_path(self) -> Path | None:
        if not self._run_dir:
            return None
        return self._run_dir / ACTIVITY_LOG_REL

    def _load_activity_log_from_disk(self) -> None:
        path = self._activity_log_path()
        if not path or not path.is_file():
            self.progress_log.clear()
            return
        try:
            self.progress_log.setPlainText(path.read_text(encoding="utf-8"))
        except OSError:
            self.progress_log.clear()
            return
        self.progress_log.moveCursor(QTextCursor.MoveOperation.End)

    def _persist_activity_line(self, text: str) -> None:
        path = self._activity_log_path()
        if not path:
            return
        payload = text if text.endswith("\n") else text + "\n"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(payload)
        except OSError:
            pass

    def _update_npc_save_enabled(self) -> None:
        self.btn_save_npc.setEnabled(bool(self._run_dir) and not self._running)

    def _append_activity_log(self, text: str) -> None:
        self.progress_log.moveCursor(QTextCursor.MoveOperation.End)
        self.progress_log.insertPlainText(text)
        if not text.endswith("\n"):
            self.progress_log.insertPlainText("\n")
        self.progress_log.moveCursor(QTextCursor.MoveOperation.End)
        self._persist_activity_line(text)

    def _refresh_npc_table(self) -> None:
        if not self._run_dir:
            return
        agents = read_all_agents(self._run_dir)
        self.npc_table.setRowCount(0)
        for i, a in enumerate(agents):
            self.npc_table.insertRow(i)
            aid = a.get("id", a.get("name", "?"))
            name = a.get("name", a.get("id", "?"))
            tier = a.get("current_tier", a.get("tier", a.get("suggested_tier", "B")))
            life = a.get("life_status", "alive")
            loc = a.get("current_location", a.get("location_hint", ""))
            id_item = QTableWidgetItem(str(aid))
            id_item.setFlags(id_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.npc_table.setItem(i, 0, id_item)
            name_item = QTableWidgetItem(str(name))
            name_item.setFlags(name_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.npc_table.setItem(i, 1, name_item)

            tier_combo = QComboBox()
            tier_combo.addItems(["S", "A", "B", "C"])
            tier_combo.setCurrentText(str(tier).upper())
            tier_combo.setEnabled(not self._running)
            self.npc_table.setCellWidget(i, 2, tier_combo)

            life_combo = QComboBox()
            life_combo.addItems(["alive", "dead", "missing"])
            life_combo.setCurrentText(str(life))
            life_combo.setEnabled(not self._running)
            self.npc_table.setCellWidget(i, 3, life_combo)

            loc_item = QTableWidgetItem(str(loc))
            loc_item.setFlags(loc_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.npc_table.setItem(i, 4, loc_item)

        self._update_npc_save_enabled()

    def _save_npc_tiers(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        changed = 0
        for row in range(self.npc_table.rowCount()):
            aid_item = self.npc_table.item(row, 0)
            if not aid_item:
                continue
            aid = aid_item.text()
            tier_combo = self.npc_table.cellWidget(row, 2)
            life_combo = self.npc_table.cellWidget(row, 3)
            if not isinstance(tier_combo, QComboBox) or not isinstance(life_combo, QComboBox):
                continue
            agent_file = f"world/agents/{aid}.json"
            data = read_json(self._run_dir, agent_file)
            if not data:
                continue
            new_tier = tier_combo.currentText()
            new_life = life_combo.currentText()
            old_tier = str(data.get("current_tier", data.get("tier", "B")))
            old_life = str(data.get("life_status", "alive"))
            if str(new_tier).upper() == old_tier.upper() and new_life == old_life:
                continue
            data["current_tier"] = new_tier
            data["tier"] = new_tier
            data["life_status"] = new_life
            write_json(self._run_dir, agent_file, data)
            changed += 1
        if changed:
            self.log_signal.emit(f"已保存 {changed} 个 NPC 的 Tier / 生命状态")
        else:
            self.log_signal.emit("NPC：无 Tier/生命状态 变更")

    def _set_running(self, running: bool) -> None:
        """锁定/解锁控件。"""
        self._running = running
        self.btn_run_week.setEnabled(not running)
        self.btn_run_range.setEnabled(not running)
        self.from_spin.setEnabled(not running)
        self.to_spin.setEnabled(not running)
        self.progress_bar.setVisible(running)
        if not running:
            self.progress_bar.setValue(0)
        self._set_npc_combos_enabled(not running)
        self._update_npc_save_enabled()
        self.running_changed.emit(running)

    def _set_npc_combos_enabled(self, enabled: bool) -> None:
        for row in range(self.npc_table.rowCount()):
            for col in (2, 3):
                w = self.npc_table.cellWidget(row, col)
                if w is not None:
                    w.setEnabled(enabled)

    def _run_week(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先在顶部选择一个 Run")
            return
        week = self.from_spin.value()
        self.log_signal.emit(f"开始模拟第 {week} 周...")
        self.status_label.setText(f"运行第 {week} 周...")
        self._set_running(True)

        async def _do():
            try:
                from tools.chronicle_sim_v2.core.sim.orchestrator import WeekOrchestrator
                orch = WeekOrchestrator(self._run_dir, self._llm_config, progress_log=self.log_signal.emit)
                result = await orch.run_week(week)
                self.log_signal.emit(f"\n第 {week} 周完成: {result}")
                self.sim_spins_signal.emit(week + 1)
                self.sim_status_signal.emit("就绪")
                self.sim_refresh_npc_signal.emit()
            except Exception as e:
                self.log_signal.emit(f"\n错误: {e}")
                self.sim_status_signal.emit(f"错误: {e}")
            finally:
                self.sim_running_done_signal.emit()

        self._worker = CancellableAsyncWorker(_do())
        self._worker.signals.error.connect(self._on_worker_error)
        self._worker.signals.cancelled.connect(self._on_worker_cancelled)
        from PySide6.QtCore import QThreadPool
        QThreadPool.globalInstance().start(self._worker)

    def _run_range(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先在顶部选择一个 Run")
            return
        start = self.from_spin.value()
        end = max(self.to_spin.value(), start)
        self.log_signal.emit(f"开始模拟: 周 {start} - {end}")
        self.status_label.setText(f"运行周 {start} - {end}...")
        self._set_running(True)

        self._worker = CancellableAsyncWorker(self._do_range(start, end))
        self._worker.signals.error.connect(self._on_worker_error)
        self._worker.signals.cancelled.connect(self._on_worker_cancelled)
        from PySide6.QtCore import QThreadPool
        QThreadPool.globalInstance().start(self._worker)

    def _do_range(self, start: int, end: int):
        """返回一个 coroutine，供 CancellableAsyncWorker 执行。"""
        async def _do():
            try:
                total = end - start + 1
                for idx, w in enumerate(range(start, end + 1), 1):
                    self.sim_progress_signal.emit(idx * 100 // total)
                    self.sim_status_signal.emit(f"第 {w} 周 ({idx}/{total})...")
                    self.log_signal.emit(f"\n===== 第 {w} 周 =====")
                    try:
                        from tools.chronicle_sim_v2.core.sim.orchestrator import WeekOrchestrator
                        orch = WeekOrchestrator(
                            self._run_dir, self._llm_config, progress_log=self.log_signal.emit
                        )
                        result = await orch.run_week(w)
                        self.log_signal.emit(f"第 {w} 周完成: {result}")
                        self.sim_spins_signal.emit(w + 1)
                    except asyncio.CancelledError:
                        self.log_signal.emit(f"\n第 {w} 周被取消")
                        break
                    except Exception as e:
                        self.log_signal.emit(f"第 {w} 周失败: {e}")
                        break
                self.log_signal.emit("\n全部完成")
                self.sim_status_signal.emit("就绪")
                self.sim_refresh_npc_signal.emit()
            finally:
                self.sim_running_done_signal.emit()

        return _do()

    def _cancel(self) -> None:
        if self._worker:
            self._worker.request_cancel()
        self.log_signal.emit("取消请求已发送")
        self._set_running(False)

    def _on_worker_error(self, summary: str, detail: str) -> None:
        self.log_signal.emit(f"模拟错误: {summary}")
        self.log_signal.emit(detail)
        self.status_label.setText(f"错误: {summary}")
        self._set_running(False)

    def _on_worker_cancelled(self) -> None:
        self.log_signal.emit("模拟已取消")
        self.status_label.setText("已取消")
        self._set_running(False)
