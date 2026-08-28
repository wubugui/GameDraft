"""「自动构建」页：调度配置 + 开关 + 下次构建时刻。"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QTime, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QLabel,
    QLineEdit, QMessageBox, QPushButton, QSpinBox, QTimeEdit, QVBoxLayout, QWidget,
)

from . import autostart
from .archive import find_seven_zip
from .config import WEEKDAY_NAMES, AutoBuildConfig, save_config


class SettingsTab(QWidget):
    """改完点「保存」才生效。调度器读的是保存后的那份。"""

    config_changed = Signal()

    def __init__(self, project_root: Path, cfg: AutoBuildConfig, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._project_root = project_root
        self._cfg = cfg

        # ---- 调度 ----
        self._enabled = QCheckBox("开启自动构建")
        self._enabled.setToolTip(
            "只在这个工作台开着时生效——关掉窗口就不再构建。\n"
            "（这是你选的方案：不注册系统计划任务。）"
        )

        self._mode = QComboBox()
        self._mode.addItem("每隔几天", "daily")
        self._mode.addItem("每周固定几天", "weekly")
        self._mode.currentIndexChanged.connect(self._sync_mode_widgets)

        # 粒度只到天：一次构建 569 MB、两分多钟，按小时排等于一天堆十几 GB
        self._every_n_days = QSpinBox()
        self._every_n_days.setRange(1, 60)
        self._every_n_days.setSuffix(" 天一次")
        self._every_n_days.setSpecialValueText("每天")
        self._every_n_days.valueChanged.connect(self._refresh_summary)

        self._weekday_boxes: list[QCheckBox] = []
        wd_row = QHBoxLayout()
        for i, name in enumerate(WEEKDAY_NAMES):
            cb = QCheckBox(name)
            cb.toggled.connect(self._refresh_summary)
            self._weekday_boxes.append(cb)
            wd_row.addWidget(cb)
        wd_row.addStretch(1)
        self._weekday_widget = QWidget()
        self._weekday_widget.setLayout(wd_row)

        self._build_at = QTimeEdit()
        self._build_at.setDisplayFormat("HH:mm")
        self._build_at.setToolTip("缺省凌晨四点——那会儿机器多半闲着")
        self._build_at.timeChanged.connect(self._refresh_summary)

        self._sched_summary = QLabel()
        self._sched_summary.setStyleSheet("color:#7fc7ff;")

        sched = QFormLayout()
        sched.addRow(self._enabled)
        sched.addRow("方式", self._mode)
        self._every_row = QLabel("频率")
        sched.addRow(self._every_row, self._every_n_days)
        self._weekday_row = QLabel("周几")
        sched.addRow(self._weekday_row, self._weekday_widget)
        sched.addRow("几点", self._build_at)
        sched.addRow("", self._sched_summary)
        sched_box = QGroupBox("什么时候构建")
        sched_box.setLayout(sched)

        # ---- 位置 ----
        self._builds_root = QLineEdit()
        self._builds_root.setPlaceholderText("每次构建落在 <这个目录>/<时间戳>/")
        pick_builds = QPushButton("选…")
        pick_builds.clicked.connect(lambda: self._pick_dir(self._builds_root, "构建根目录"))
        builds_row = QHBoxLayout()
        builds_row.addWidget(self._builds_root, 1)
        builds_row.addWidget(pick_builds)

        self._archive_root = QLineEdit()
        self._archive_root.setPlaceholderText("留空 = <构建根目录>/archive")
        pick_arc = QPushButton("选…")
        pick_arc.clicked.connect(lambda: self._pick_dir(self._archive_root, "归档目录"))
        arc_row = QHBoxLayout()
        arc_row.addWidget(self._archive_root, 1)
        arc_row.addWidget(pick_arc)

        loc = QFormLayout()
        loc.addRow("构建根目录", builds_row)
        loc.addRow("归档目录", arc_row)
        loc_box = QGroupBox("放哪")
        loc_box.setLayout(loc)

        # ---- 留档 ----
        self._keep_uncompressed = QSpinBox()
        self._keep_uncompressed.setRange(1, 99)
        self._keep_uncompressed.setSuffix(" 份")
        self._keep_uncompressed.setToolTip("保留几份可直接跑的构建；再旧的转成 7z 归档")

        self._keep_archives = QSpinBox()
        self._keep_archives.setRange(0, 999)
        self._keep_archives.setSpecialValueText("不限（永久留档）")
        self._keep_archives.setSuffix(" 份")

        self._seven_zip = QLineEdit()
        self._seven_zip.setPlaceholderText("留空 = 自动找（PATH + 常见安装位置）")
        self._7z_status = QLabel()

        self._skip_verify = QCheckBox("验收不过也照样出包")
        self._skip_verify.setToolTip(
            "缺省关着：不把已知有缺陷的包留进档案。\n"
            "打开后构建标记里会记 verified:false，包不会假装自己验过。"
        )

        # ---- 常驻 ----
        self._minimize_to_tray = QCheckBox("关窗口时缩到托盘（不退出）")
        self._minimize_to_tray.setToolTip(
            "缺省开着。定时构建靠这个窗口活着，一次误点关闭就等于停掉了自动化。\n"
            "真要退出走托盘菜单的「退出」。"
        )
        self._autostart = QCheckBox("开机自动启动")
        self._autostart.setToolTip(
            "写当前用户的启动项（HKCU\\...\\Run），不需要管理员。\n"
            "随时能在「任务管理器 → 启动应用」里看到并禁用。"
        )
        self._autostart.toggled.connect(self._on_autostart_toggled)
        self._autostart_status = QLabel()
        self._autostart_status.setWordWrap(True)

        resident = QFormLayout()
        resident.addRow(self._minimize_to_tray)
        resident.addRow(self._autostart)
        resident.addRow("", self._autostart_status)
        resident_hint = QLabel(
            "调度只在工作台开着时生效——所以「开机自启 + 缩托盘」这两项一起开，"
            "定期构建才是真的无人值守。"
        )
        resident_hint.setWordWrap(True)
        resident_hint.setStyleSheet("color:#8a857c;")
        resident.addRow(resident_hint)
        resident_box = QGroupBox("常驻")
        resident_box.setLayout(resident)

        keep = QFormLayout()
        keep.addRow("未压缩保留", self._keep_uncompressed)
        keep.addRow("归档保留", self._keep_archives)
        keep.addRow("7z 路径", self._seven_zip)
        keep.addRow("", self._7z_status)
        keep.addRow(self._skip_verify)
        keep_box = QGroupBox("留档与归档")
        keep_box.setLayout(keep)

        # ---- 底部 ----
        self._next_run = QLabel()
        self._next_run.setStyleSheet("color:#8fd694;")
        save_btn = QPushButton("保存")
        save_btn.clicked.connect(self._save)
        bottom = QHBoxLayout()
        bottom.addWidget(self._next_run, 1)
        bottom.addWidget(save_btn)

        lay = QVBoxLayout(self)
        lay.addWidget(sched_box)
        lay.addWidget(loc_box)
        lay.addWidget(keep_box)
        lay.addWidget(resident_box)
        lay.addStretch(1)
        lay.addLayout(bottom)

        self.load_from(cfg)

    # ------------------------------------------------------------ 读写

    def load_from(self, cfg: AutoBuildConfig) -> None:
        self._cfg = cfg
        self._enabled.setChecked(cfg.enabled)
        idx = self._mode.findData(cfg.schedule_mode)
        self._mode.setCurrentIndex(idx if idx >= 0 else 0)
        h, m = (cfg.build_at.split(":") + ["0"])[:2]
        self._build_at.setTime(QTime(int(h), int(m)))
        self._every_n_days.setValue(cfg.every_n_days)
        for i, cb in enumerate(self._weekday_boxes):
            cb.setChecked(i in cfg.weekdays)
        self._builds_root.setText(cfg.builds_root)
        self._archive_root.setText(cfg.archive_root)
        self._keep_uncompressed.setValue(cfg.keep_uncompressed)
        self._keep_archives.setValue(cfg.keep_archives)
        self._seven_zip.setText(cfg.seven_zip_path)
        self._skip_verify.setChecked(cfg.skip_verify)
        self._minimize_to_tray.setChecked(cfg.minimize_to_tray)
        self._sync_mode_widgets()
        self._refresh_7z_status()
        self._refresh_autostart_status()

    def to_config(self) -> AutoBuildConfig:
        return AutoBuildConfig(
            enabled=self._enabled.isChecked(),
            schedule_mode=str(self._mode.currentData()),
            build_at=self._build_at.time().toString("HH:mm"),
            every_n_days=self._every_n_days.value(),
            weekdays=[i for i, cb in enumerate(self._weekday_boxes) if cb.isChecked()],
            builds_root=self._builds_root.text().strip(),
            keep_uncompressed=self._keep_uncompressed.value(),
            keep_archives=self._keep_archives.value(),
            archive_root=self._archive_root.text().strip(),
            seven_zip_path=self._seven_zip.text().strip(),
            skip_verify=self._skip_verify.isChecked(),
            minimize_to_tray=self._minimize_to_tray.isChecked(),
        )

    def set_next_run(self, when: datetime | None) -> None:
        if when is None:
            self._next_run.setText("自动构建未开启")
        else:
            self._next_run.setText(f"下次构建：{when:%Y-%m-%d %H:%M}")

    # ------------------------------------------------------------ 内部

    def _sync_mode_widgets(self) -> None:
        daily = self._mode.currentData() == "daily"
        self._every_n_days.setVisible(daily)
        self._every_row.setVisible(daily)
        self._weekday_widget.setVisible(not daily)
        self._weekday_row.setVisible(not daily)
        self._refresh_summary()

    def _refresh_summary(self) -> None:
        """把当前选择翻译成一句人话，免得"每隔 3 天 04:00"要在脑子里拼。"""
        self._sched_summary.setText(self.to_config().schedule_text())

    def _refresh_autostart_status(self) -> None:
        """自启是**立即生效**的系统状态，不跟「保存」走——所以它的显示直接读注册表，
        而不是读配置。配置里存一份"用户想要什么"反而会和现实脱节。"""
        if not autostart.is_supported():
            self._autostart.setEnabled(False)
            self._autostart_status.setText("这个平台暂不支持开机自启动")
            self._autostart_status.setStyleSheet("color:#8a857c;")
            return
        on = autostart.is_enabled_for(self._project_root)
        self._autostart.blockSignals(True)
        self._autostart.setChecked(on)
        self._autostart.blockSignals(False)
        other = autostart.current_command()
        if on:
            self._autostart_status.setText("✓ 已注册（任务管理器 → 启动应用 里可见）")
            self._autostart_status.setStyleSheet("color:#8fd694;")
        elif other:
            # 指向别的检出时必须说出来，否则会以为"开着"的是这一份
            self._autostart_status.setText(f"⚠ 启动项指向另一个工程：{other}")
            self._autostart_status.setStyleSheet("color:#ffc46b;")
        else:
            self._autostart_status.setText("")

    def _on_autostart_toggled(self, on: bool) -> None:
        ok, msg = autostart.set_enabled(self._project_root, on)
        if not ok:
            QMessageBox.warning(self, "改不了开机自启", msg)
        self._refresh_autostart_status()

    def _refresh_7z_status(self) -> None:
        found = find_seven_zip(self._seven_zip.text().strip())
        if found:
            self._7z_status.setText(f"✓ 用这个：{found}")
            self._7z_status.setStyleSheet("color:#8fd694;")
        else:
            self._7z_status.setText("✖ 找不到 7z —— 归档功能不可用（winget install 7zip.7zip）")
            self._7z_status.setStyleSheet("color:#ff6b6b;")

    def _pick_dir(self, field: QLineEdit, title: str) -> None:
        chosen = QFileDialog.getExistingDirectory(self, title, field.text().strip())
        if chosen:
            field.setText(str(Path(chosen)))

    def _save(self) -> None:
        cfg = self.to_config()
        # 只在"要开自动构建"时才拦——没开的话允许存半份配置，慢慢填
        if cfg.enabled:
            errs = cfg.validation_errors()
            if errs:
                QMessageBox.warning(
                    self, "还不能开自动构建",
                    "\n".join(f"· {e}" for e in errs),
                )
                return
        save_config(self._project_root, cfg)
        self._cfg = cfg
        self._refresh_7z_status()
        self.config_changed.emit()
