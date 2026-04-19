"""主窗口：集中 Run 管理 + 4 标签页。"""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QSplitter,
    QTabWidget,
    QVBoxLayout,
    QWidget,
    QPlainTextEdit,
    QMessageBox,
)

from tools.chronicle_sim_v2.core.sim.run_manager import list_runs, create_run
from tools.chronicle_sim_v2.core.sim.run_manager import load_llm_config
from tools.chronicle_sim_v2.gui.app_settings import (
    save_main_window_geometry,
    load_main_window_geometry,
    save_main_tab_index,
    load_main_tab_index,
    save_last_run_path,
    load_last_run_path,
    save_main_splitter_state,
    load_main_splitter_state,
)
from tools.chronicle_sim_v2.gui.idea_library_tab import IdeaLibraryTab
from tools.chronicle_sim_v2.gui.seed_editor_tab import SeedEditorTab
from tools.chronicle_sim_v2.gui.simulation_tab import SimulationTab
from tools.chronicle_sim_v2.gui.chronicle_browser_tab import ChronicleBrowserTab


class MainWindow(QMainWindow):
    # 全局 Run 切换信号，供所有标签页订阅
    run_changed = Signal(object)  # Path | None

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("ChronicleSim v2")
        self.resize(1200, 800)

        self._run_dir: Path | None = None
        self._llm_config: dict = {}

        # 中央标签页
        self.tabs = QTabWidget()

        self.idea_tab = IdeaLibraryTab()
        self.seed_tab = SeedEditorTab()
        self.sim_tab = SimulationTab()
        self.chronicle_tab = ChronicleBrowserTab()

        self.tabs.addTab(self.idea_tab, "设定库")
        self.tabs.addTab(self.seed_tab, "种子编辑")
        self.tabs.addTab(self.sim_tab, "模拟")
        self.tabs.addTab(self.chronicle_tab, "编年史")

        # 底部活动日志 — 可拖拽调整大小
        self.log_panel = QPlainTextEdit()
        self.log_panel.setReadOnly(True)
        self.log_panel.setMinimumHeight(80)
        self.log_panel.setStyleSheet("QPlainTextEdit { font-family: monospace; font-size: 11px; }")

        # 垂直分割器
        splitter = QSplitter(Qt.Vertical)
        splitter.addWidget(self.tabs)
        splitter.addWidget(self.log_panel)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        # 初始比例：日志占约 25% 高度
        splitter.setSizes([600, 200])

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(splitter)
        self.setCentralWidget(central)

        # 顶部 Run 选择栏
        self._setup_run_bar()

        # 连接日志信号
        self.idea_tab.log_signal.connect(self._append_log)
        self.seed_tab.log_signal.connect(self._append_log)
        self.sim_tab.log_signal.connect(self._append_log)
        self.chronicle_tab.log_signal.connect(self._append_log)

        # 订阅全局 Run 切换
        self.idea_tab.run_changed.connect(self._on_run_changed)
        self.seed_tab.run_changed.connect(self._on_run_changed)
        self.sim_tab.run_changed.connect(self._on_run_changed)
        self.chronicle_tab.run_changed.connect(self._on_run_changed)

        # 模拟运行状态
        self.sim_tab.running_changed.connect(self.btn_cancel_sim.setEnabled)

        # 加载上次 Run
        self._restore_last_run()

        # 恢复上次窗口分割比例
        saved = load_main_splitter_state()
        if saved:
            splitter.restoreState(saved)

        self._append_log("ChronicleSim v2 启动 — 请先选择或新建一个 Run")

    def _setup_run_bar(self) -> None:
        """在 tab 上方添加全局 Run 选择栏。"""
        bar = QWidget()
        bar_layout = QHBoxLayout(bar)
        bar_layout.setContentsMargins(4, 2, 4, 2)

        bar_layout.addWidget(QLabel("Run:"))
        self.run_combo = QComboBox()
        self.run_combo.setMinimumWidth(240)
        bar_layout.addWidget(self.run_combo)

        self.btn_new_run = QPushButton("新建 Run")
        self.btn_new_run.clicked.connect(self._new_run)
        bar_layout.addWidget(self.btn_new_run)

        self.btn_refresh_runs = QPushButton("刷新列表")
        self.btn_refresh_runs.clicked.connect(self._refresh_run_combo)
        bar_layout.addWidget(self.btn_refresh_runs)

        self.btn_load_run = QPushButton("打开")
        self.btn_load_run.clicked.connect(self._open_run)
        bar_layout.addWidget(self.btn_load_run)

        self.btn_delete_run = QPushButton("删除")
        self.btn_delete_run.clicked.connect(self._delete_run)
        bar_layout.addWidget(self.btn_delete_run)

        bar_layout.addStretch()

        # 模拟控制按钮
        self.btn_cancel_sim = QPushButton("取消模拟")
        self.btn_cancel_sim.setEnabled(False)
        self.btn_cancel_sim.setStyleSheet("QPushButton { color: red; }")
        self.btn_cancel_sim.clicked.connect(self._cancel_simulation)
        bar_layout.addWidget(self.btn_cancel_sim)

        # 插入到 central layout 的第一个位置
        central_widget = self.centralWidget()
        if central_widget:
            cl = central_widget.layout()
            cl.insertWidget(0, bar)

    def _refresh_run_combo(self) -> None:
        runs = list_runs()
        self.run_combo.clear()
        for r in runs:
            name = r.get("name", r.get("run_id", ""))
            rid = r.get("run_id", "")
            self.run_combo.addItem(name, rid)
        if self.run_combo.count() == 0:
            self.run_combo.addItem("(无可用 Run)", "")

    def _new_run(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "新建 Run", "Run 名称:")
        if not ok or not name.strip():
            return
        run_id, run_dir = create_run(name.strip())
        self._refresh_run_combo()
        self._select_run_by_id(run_id)
        self._append_log(f"创建 run: {name} ({run_id})")

    def _open_run(self) -> None:
        rid = self.run_combo.currentData()
        if not rid:
            self._append_log("没有可选的 Run")
            return
        self._select_run_by_id(rid)

    def _delete_run(self) -> None:
        rid = self.run_combo.currentData()
        if not rid:
            return
        name = self.run_combo.currentText()
        ret = QMessageBox.question(
            self, "确认删除", f"确定删除 Run '{name}'？此操作不可恢复。",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No,
        )
        if ret != QMessageBox.Yes:
            return
        from tools.chronicle_sim_v2.paths import RUNS_DIR
        from tools.chronicle_sim_v2.core.sim.run_manager import delete_run
        delete_run(RUNS_DIR / rid)
        self._refresh_run_combo()
        if self._run_dir and self._run_dir.name == rid:
            self._set_active_run(None)
        self._append_log(f"已删除 run: {name}")

    def _select_run_by_id(self, run_id: str) -> None:
        from tools.chronicle_sim_v2.paths import RUNS_DIR
        run_dir = RUNS_DIR / run_id
        if run_dir.is_dir():
            self._set_active_run(run_dir)
            # 同步 combo 选中项
            idx = self.run_combo.findData(run_id)
            if idx >= 0:
                self.run_combo.setCurrentIndex(idx)
        else:
            self._append_log(f"Run 目录不存在: {run_id}")

    def _set_active_run(self, run_dir: Path | None) -> None:
        """设置当前活动 Run，同步到所有标签页。"""
        self._run_dir = run_dir
        if run_dir:
            save_last_run_path(str(run_dir))
            self._llm_config = load_llm_config(run_dir)
            self._append_log(f"切换到 run: {run_dir.name}")
        # 同步到所有标签页
        self.idea_tab.set_run_dir(run_dir)
        self.seed_tab.set_run_dir(run_dir, self._llm_config)
        self.sim_tab.set_run_dir(run_dir, self._llm_config)
        self.chronicle_tab.set_run_dir(run_dir, self._llm_config)
        self.run_changed.emit(run_dir)

    def _on_run_changed(self, run_dir: Path | None) -> None:
        """任一标签页请求切换 Run 时调用。"""
        self._set_active_run(run_dir)

    def _restore_last_run(self) -> None:
        last = load_last_run_path()
        if last:
            p = Path(last)
            if p.is_dir():
                from tools.chronicle_sim_v2.core.sim.run_manager import load_run_meta
                meta = load_run_meta(p)
                if meta:
                    self._set_active_run(p)
                    self._refresh_run_combo()
                    # 选到当前 Run
                    rid = meta.get("run_id", p.name)
                    idx = self.run_combo.findData(rid)
                    if idx >= 0:
                        self.run_combo.setCurrentIndex(idx)
                    return
        # 没有上次 Run，刷新列表
        self._refresh_run_combo()

    def _cancel_simulation(self) -> None:
        """取消正在运行的模拟。"""
        self.sim_tab._cancel()
        self.btn_cancel_sim.setEnabled(False)

    def _append_log(self, text: str) -> None:
        self.log_panel.appendPlainText(text)

    def closeEvent(self, event) -> None:  # type: ignore
        # 检查未保存的 LLM 配置
        if self.seed_tab._llm_dirty:
            ret = QMessageBox.question(
                self, "未保存的配置",
                "种子编辑器的 LLM 配置已修改但未保存，确定退出？",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if ret != QMessageBox.Yes:
                event.ignore()
                return
        save_main_window_geometry(self)
        save_main_tab_index(self.tabs.currentIndex())
        save_main_splitter_state(splitter.saveState())
        from tools.chronicle_sim_v2.core.world.chroma import release_all_clients
        release_all_clients()
        super().closeEvent(event)
