"""PySide6 production workbench window."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PySide6.QtCore import QPoint, QRect, QThread, QTimer, Qt, QUrl, Signal
from PySide6.QtGui import QCloseEvent, QColor, QDesktopServices, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QSizePolicy,
    QSpinBox,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .asset_audit import AssetAuditReport, audit_asset_specs, classify_asset_path, format_asset_audit_report
from .asset_style_sampler import build_asset_style_reference, format_asset_style_reference_report
from .asset_candidates import (
    AssetCandidateReport,
    REVIEW_STATUSES,
    batch_create_redraw_tasks,
    build_redraw_task_from_candidate,
    format_asset_candidate_redraw_task_report,
    format_asset_candidate_report,
    format_asset_candidate_score_report,
    list_asset_candidates,
    review_status_label,
    save_candidate_review,
    score_asset_candidates,
)
from .asset_tasks import (
    ASSET_CATEGORIES,
    OPERATIONS,
    AssetTask,
    build_asset_task_prompt,
    default_output_dir,
    save_asset_task,
    suggest_task_defaults,
)
from .asset_postprocess import (
    AssetPostprocessOptions,
    format_asset_postprocess_report,
    postprocess_candidates,
)
from .animation_sheet import (
    ComposeSheetOptions,
    SheetGridOptions,
    compose_animation_sheet,
    format_animation_sheet_report,
    inspect_animation_sheet,
    split_animation_sheet,
)
from .codex_asset_runner import format_codex_asset_run_result, run_codex_asset_task
from .codex_probe import format_probe_result, probe_codex
from .console import WorkbenchConsoleDock, WorkbenchConsoleWidget
from .daily_check import DailyCheckReport, format_daily_check_report, run_daily_check
from .graph_diagnostics import (
    GraphDiagnosticsReport,
    build_graph_diagnostics,
    format_graph_diagnostics_report,
)
from .image_tools import (
    ImageEditOptions,
    apply_image_edit,
    inspect_image,
    resolve_output_path,
    resolve_source_path,
)
from .runtime_debug import (
    clear_runtime_debug_snapshot,
    format_runtime_debug_report,
    load_runtime_debug_snapshot,
)
from .runtime_command import (
    ALLOWED_RUNTIME_COMMANDS,
    clear_runtime_command_queue,
    enqueue_runtime_command,
    format_runtime_command_queue_report,
    load_runtime_command_queue,
)
from .report_log import save_workbench_report, workbench_reports_root
from .story_acceptance import (
    check_story_unit_acceptance_script,
    format_acceptance_check_report,
    compare_story_unit_acceptance_to_runtime_snapshot,
    format_acceptance_runtime_compare_report,
)
from .story_acceptance_run import (
    finish_story_acceptance_run,
    start_story_acceptance_run,
)
from .story_units import (
    AssetNeed,
    Blocker,
    PRODUCTION_STATUSES,
    StoryUnit,
    StoryUnitWorkspace,
    acceptance_script_issues,
    load_story_unit_workspace,
    save_story_unit_workspace,
    story_units_path,
    story_unit_completeness_issues,
    story_unit_report,
)
from tools.editor.project_model import ProjectModel


def _repo_root() -> Path:
    return Path.cwd().resolve()


def _is_project_root(path: Path) -> bool:
    return (path / "public" / "assets").is_dir()


def _inline_console_from_dock(dock: WorkbenchConsoleDock, *, minimum_height: int = 160) -> WorkbenchConsoleWidget:
    console = dock.console
    console.setParent(None)
    dock.setProperty("inlineConsole", True)
    dock.setWidget(QWidget(dock))
    console.setMinimumHeight(minimum_height)
    return console


class CropPreviewLabel(QLabel):
    """Image preview that can turn a mouse drag into source-pixel crop bounds."""

    cropSelected = Signal(int, int, int, int)

    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self._pixmap = QPixmap()
        self._crop_pixels: tuple[int, int, int, int] | None = None
        self._drag_start: QPoint | None = None
        self._drag_current: QPoint | None = None
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)

    def set_image_path(self, path: Path) -> bool:
        pixmap = QPixmap(str(path))
        if pixmap.isNull():
            self._pixmap = QPixmap()
            self._crop_pixels = None
            self.setText(f"无法预览:\n{path}")
            self.update()
            return False
        self._pixmap = pixmap
        self._crop_pixels = None
        self._drag_start = None
        self._drag_current = None
        self.setText("")
        self.setToolTip(f"{path}\n拖拽预览图可设置裁剪框，左侧数字可精细微调。")
        self.update()
        return True

    def set_crop_pixels(self, x: int, y: int, width: int, height: int) -> None:
        if self._pixmap.isNull() or width <= 0 or height <= 0:
            self._crop_pixels = None
            self.update()
            return
        source_w = max(1, self._pixmap.width())
        source_h = max(1, self._pixmap.height())
        x = max(0, min(int(x), source_w))
        y = max(0, min(int(y), source_h))
        width = max(1, min(int(width), source_w - x))
        height = max(1, min(int(height), source_h - y))
        self._crop_pixels = (x, y, width, height)
        self.update()

    def clear_crop(self) -> None:
        self._crop_pixels = None
        self._drag_start = None
        self._drag_current = None
        self.update()

    def current_crop_pixels(self) -> tuple[int, int, int, int] | None:
        if self._pixmap.isNull() or self._crop_pixels is None:
            return None
        return self._crop_pixels

    def paintEvent(self, event) -> None:  # noqa: ANN001,N802
        if self._pixmap.isNull():
            super().paintEvent(event)
            return
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#1f1f1f"))
        image_rect = self._image_rect()
        painter.drawPixmap(image_rect, self._pixmap)

        selection = self._active_selection_rect()
        if not selection.isNull():
            painter.fillRect(selection, QColor(255, 196, 64, 48))
            pen = QPen(QColor("#ffc440"))
            pen.setWidth(2)
            painter.setPen(pen)
            painter.drawRect(selection.adjusted(0, 0, -1, -1))

    def mousePressEvent(self, event) -> None:  # noqa: ANN001,N802
        if self._pixmap.isNull() or event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        image_rect = self._image_rect()
        raw_pos = event.position().toPoint()
        if not image_rect.contains(raw_pos):
            return
        pos = self._clamp_to_rect(raw_pos, image_rect)
        self._drag_start = pos
        self._drag_current = pos
        self._crop_pixels = None
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: ANN001,N802
        if self._drag_start is None:
            super().mouseMoveEvent(event)
            return
        self._drag_current = self._clamp_to_rect(event.position().toPoint(), self._image_rect())
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: ANN001,N802
        if self._drag_start is None or event.button() != Qt.MouseButton.LeftButton:
            super().mouseReleaseEvent(event)
            return
        self._drag_current = self._clamp_to_rect(event.position().toPoint(), self._image_rect())
        selection = self._active_selection_rect()
        self._drag_start = None
        self._drag_current = None
        if selection.width() < 2 or selection.height() < 2:
            self._crop_pixels = None
            self.update()
            return
        crop = self._display_rect_to_source_crop(selection)
        self._crop_pixels = crop
        self.cropSelected.emit(*crop)
        self.update()

    def resizeEvent(self, event) -> None:  # noqa: ANN001,N802
        super().resizeEvent(event)
        self.update()

    def _active_selection_rect(self) -> QRect:
        if self._drag_start is not None and self._drag_current is not None:
            return self._rect_from_points(self._drag_start, self._drag_current)
        if self._crop_pixels is not None:
            return self._source_crop_to_display_rect(self._crop_pixels)
        return QRect()

    def _image_rect(self) -> QRect:
        if self._pixmap.isNull():
            return QRect()
        contents = self.contentsRect()
        source_w = max(1, self._pixmap.width())
        source_h = max(1, self._pixmap.height())
        scale = min(contents.width() / source_w, contents.height() / source_h)
        display_w = max(1, round(source_w * scale))
        display_h = max(1, round(source_h * scale))
        return QRect(
            contents.left() + (contents.width() - display_w) // 2,
            contents.top() + (contents.height() - display_h) // 2,
            display_w,
            display_h,
        )

    def _display_rect_to_source_crop(self, rect: QRect) -> tuple[int, int, int, int]:
        image_rect = self._image_rect()
        source_w = max(1, self._pixmap.width())
        source_h = max(1, self._pixmap.height())
        x = round((rect.left() - image_rect.left()) * source_w / image_rect.width())
        y = round((rect.top() - image_rect.top()) * source_h / image_rect.height())
        width = round(rect.width() * source_w / image_rect.width())
        height = round(rect.height() * source_h / image_rect.height())
        x = max(0, min(x, source_w - 1))
        y = max(0, min(y, source_h - 1))
        width = max(1, min(width, source_w - x))
        height = max(1, min(height, source_h - y))
        return x, y, width, height

    def _source_crop_to_display_rect(self, crop: tuple[int, int, int, int]) -> QRect:
        image_rect = self._image_rect()
        if image_rect.isNull():
            return QRect()
        source_w = max(1, self._pixmap.width())
        source_h = max(1, self._pixmap.height())
        x, y, width, height = crop
        scale_x = image_rect.width() / source_w
        scale_y = image_rect.height() / source_h
        return QRect(
            image_rect.left() + round(x * scale_x),
            image_rect.top() + round(y * scale_y),
            max(1, round(width * scale_x)),
            max(1, round(height * scale_y)),
        )

    @staticmethod
    def _rect_from_points(a: QPoint, b: QPoint) -> QRect:
        left = min(a.x(), b.x())
        top = min(a.y(), b.y())
        right = max(a.x(), b.x())
        bottom = max(a.y(), b.y())
        return QRect(left, top, max(1, right - left), max(1, bottom - top))

    @staticmethod
    def _clamp_to_rect(point: QPoint, rect: QRect) -> QPoint:
        if rect.isNull():
            return point
        x = max(rect.left(), min(point.x(), rect.right() + 1))
        y = max(rect.top(), min(point.y(), rect.bottom() + 1))
        return QPoint(x, y)


class SearchPickerDialog(QDialog):
    """Search-first picker for large authoring id lists."""

    def __init__(self, title: str, items: list[dict[str, Any]], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(760, 520)
        self.items = items
        self.selected: dict[str, Any] | None = None

        layout = QVBoxLayout(self)
        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索名称 / id / 场景 / 备注")
        self.search.textChanged.connect(self._populate)
        self.search.returnPressed.connect(self.accept)
        layout.addWidget(self.search)

        body = QSplitter(Qt.Orientation.Horizontal)
        self.list = QListWidget()
        self.list.currentItemChanged.connect(self._show_detail)
        self.list.itemDoubleClicked.connect(lambda _item: self.accept())
        body.addWidget(self.list)
        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        body.addWidget(self.detail)
        body.setSizes([430, 300])
        layout.addWidget(body, 1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self._populate()
        self.search.setFocus(Qt.FocusReason.OtherFocusReason)

    def accept(self) -> None:  # noqa: D401
        item = self.list.currentItem()
        if item is None:
            return
        data = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(data, dict):
            self.selected = data
        super().accept()

    def _populate(self) -> None:
        query = self.search.text().strip().lower()
        words = [word for word in query.split() if word]
        self.list.clear()
        for data in self.items:
            haystack = " ".join([
                str(data.get("value", "")),
                str(data.get("label", "")),
                str(data.get("detail", "")),
                str(data.get("keywords", "")),
            ]).lower()
            if words and not all(word in haystack for word in words):
                continue
            text = str(data.get("label") or data.get("value") or "(未命名)")
            raw_value = data.get("value", "")
            value = "" if raw_value is None else str(raw_value)
            item = QListWidgetItem(f"{text}\n{value}" if value and value != text else text)
            item.setData(Qt.ItemDataRole.UserRole, data)
            self.list.addItem(item)
        if self.list.count() > 0:
            self.list.setCurrentRow(0)
        else:
            self.detail.setPlainText("没有匹配项。")

    def _show_detail(self, current: QListWidgetItem | None, _previous: QListWidgetItem | None) -> None:
        if current is None:
            self.detail.clear()
            return
        data = current.data(Qt.ItemDataRole.UserRole)
        if not isinstance(data, dict):
            self.detail.clear()
            return
        raw_value = data.get("value", "")
        display_value = "" if raw_value is None else raw_value
        lines = [
            f"ID: {display_value}",
            f"名称: {data.get('label', '')}",
        ]
        detail = data.get("detail", "")
        if detail:
            lines.extend(["", detail])
        self.detail.setPlainText("\n".join(lines))


class ReportDialog(QDialog):
    """Non-modal text report window used by GUI actions that also write to the console."""

    def __init__(self, title: str, text: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(860, 620)
        layout = QVBoxLayout(self)
        self.output = QTextEdit()
        self.output.setReadOnly(True)
        self.output.setPlainText(text)
        layout.addWidget(self.output, 1)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.close)
        layout.addWidget(buttons)


class ScenePointPreviewLabel(QLabel):
    """Clickable scene preview that records one point or a path."""

    def __init__(
        self,
        pixmap: QPixmap,
        *,
        coord_width: float,
        coord_height: float,
        allow_path: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._pixmap = pixmap
        self.coord_width = max(1.0, float(coord_width))
        self.coord_height = max(1.0, float(coord_height))
        self.allow_path = allow_path
        self.points: list[tuple[float, float]] = []
        self.setMinimumSize(560, 360)
        self.setCursor(Qt.CursorShape.CrossCursor)

    def clear_points(self) -> None:
        self.points.clear()
        self.update()

    def undo_point(self) -> None:
        if self.points:
            self.points.pop()
            self.update()

    def mousePressEvent(self, event) -> None:  # noqa: ANN001,N802
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        image_rect = self._image_rect()
        if image_rect.isNull() or not image_rect.contains(event.position().toPoint()):
            return
        point = self._display_to_scene_point(event.position().toPoint())
        if not self.allow_path:
            self.points = [point]
        else:
            self.points.append(point)
        self.update()

    def paintEvent(self, event) -> None:  # noqa: ANN001,N802
        if self._pixmap.isNull():
            super().paintEvent(event)
            return
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#171717"))
        image_rect = self._image_rect()
        painter.drawPixmap(image_rect, self._pixmap)
        if not self.points:
            return
        pen = QPen(QColor("#ffcc4d"))
        pen.setWidth(3)
        painter.setPen(pen)
        display_points = [self._scene_to_display_point(x, y) for x, y in self.points]
        for idx, point in enumerate(display_points):
            painter.drawEllipse(point, 5, 5)
            painter.drawText(point + QPoint(8, -8), str(idx + 1))
            if idx > 0:
                painter.drawLine(display_points[idx - 1], point)

    def _image_rect(self) -> QRect:
        if self._pixmap.isNull():
            return QRect()
        contents = self.contentsRect()
        source_w = max(1, self._pixmap.width())
        source_h = max(1, self._pixmap.height())
        scale = min(contents.width() / source_w, contents.height() / source_h)
        display_w = max(1, round(source_w * scale))
        display_h = max(1, round(source_h * scale))
        return QRect(
            contents.left() + (contents.width() - display_w) // 2,
            contents.top() + (contents.height() - display_h) // 2,
            display_w,
            display_h,
        )

    def _display_to_scene_point(self, point: QPoint) -> tuple[float, float]:
        rect = self._image_rect()
        x_ratio = max(0.0, min(1.0, (point.x() - rect.left()) / max(1, rect.width())))
        y_ratio = max(0.0, min(1.0, (point.y() - rect.top()) / max(1, rect.height())))
        return round(x_ratio * self.coord_width, 1), round(y_ratio * self.coord_height, 1)

    def _scene_to_display_point(self, x: float, y: float) -> QPoint:
        rect = self._image_rect()
        dx = rect.left() + round((float(x) / self.coord_width) * rect.width())
        dy = rect.top() + round((float(y) / self.coord_height) * rect.height())
        return QPoint(dx, dy)


class ScenePointPickerDialog(QDialog):
    """Pick one scene coordinate or a path by clicking the scene background."""

    def __init__(
        self,
        project_root: Path,
        scene_id: str,
        scene: dict[str, Any],
        *,
        allow_path: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("点选场景坐标" if not allow_path else "点选场景路径")
        self.resize(860, 640)
        self.selected_points: list[tuple[float, float]] = []

        pixmap, source = _scene_background_pixmap(project_root, scene_id, scene)
        coord_width = pixmap.width() if not pixmap.isNull() else float(scene.get("worldWidth") or 1000)
        coord_height = pixmap.height() if not pixmap.isNull() else float(scene.get("worldHeight") or 800)

        layout = QVBoxLayout(self)
        hint = (
            "点击背景图取一个坐标。"
            if not allow_path
            else "按路线顺序连续点击多个点；至少两个点才能生成路径。"
        )
        layout.addWidget(_hint_label(f"{hint}\n场景: {scene_id}\n背景: {source or '(未找到，使用空白图)'}"))
        self.preview = ScenePointPreviewLabel(
            pixmap,
            coord_width=coord_width,
            coord_height=coord_height,
            allow_path=allow_path,
        )
        layout.addWidget(self.preview, 1)
        layout.addWidget(_button_row([
            ("撤销最后一点", self.preview.undo_point),
            ("清空点", self.preview.clear_points),
        ]))
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def accept(self) -> None:  # noqa: D401
        if not self.preview.points:
            return
        self.selected_points = list(self.preview.points)
        super().accept()


class WorkbenchWindow(QMainWindow):
    def __init__(self, project_root: Path | None = None) -> None:
        super().__init__()
        root = project_root.resolve() if project_root else _repo_root()
        if not _is_project_root(root):
            root = Path(__file__).resolve().parents[2]
        self.project_root = root
        self._console_docks: dict[str, WorkbenchConsoleDock] = {}
        self._tab_console_docks: dict[QWidget, list[WorkbenchConsoleDock]] = {}
        self.setWindowTitle(f"GameDraft 生产工作台 - {self.project_root.name}")
        self.resize(1320, 820)

        central = QWidget(self)
        self.setCentralWidget(central)
        root_layout = QVBoxLayout(central)

        top = QHBoxLayout()
        self._project_label = QLabel(str(self.project_root))
        self._project_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        btn_project = QPushButton("切换工程...")
        btn_project.clicked.connect(self._pick_project)
        btn_reports = QPushButton("打开报告目录")
        btn_reports.clicked.connect(self.open_reports_folder)
        top.addWidget(QLabel("工程:"))
        top.addWidget(self._project_label, 1)
        top.addWidget(btn_reports)
        top.addWidget(btn_project)
        root_layout.addLayout(top)

        self.tabs = QTabWidget()
        self.tabs.currentChanged.connect(self._sync_current_tab_console)
        root_layout.addWidget(self.tabs, 1)

        self.story_tab = StoryUnitTab(self)
        self.daily_tab = DailyCheckTab(self)
        self.graph_tab = GraphDiagnosticsTab(self)
        self.runtime_debug_tab = RuntimeDebugTab(self)
        self.asset_tab = AssetAuditTab(self)
        self.image_tab = ImageToolsTab(self)
        self.animation_sheet_tab = AnimationSheetTab(self)
        self.asset_candidate_tab = AssetCandidateTab(self)
        self.asset_task_tab = AssetTaskTab(self)
        self.codex_tab = CodexProbeTab(self)
        self.tabs.addTab(self.story_tab, "剧情单元")
        self.tabs.addTab(self.daily_tab, "每日检查")
        self.tabs.addTab(self.graph_tab, "Graph诊断")
        self.tabs.addTab(self.runtime_debug_tab, "运行时Debug")
        self.tabs.addTab(self.asset_tab, "素材审计")
        self.tabs.addTab(self.asset_candidate_tab, "素材候选")
        self.tabs.addTab(self.image_tab, "图片工具")
        self.tabs.addTab(self.animation_sheet_tab, "动画Sheet")
        self.tabs.addTab(self.asset_task_tab, "素材任务")
        self.tabs.addTab(self.codex_tab, "Codex/GPT")

        self.register_tab_console(self.story_tab, self.story_tab.summary_dock)
        self.register_tab_console(self.daily_tab, self.daily_tab.output_dock)
        self.register_tab_console(self.graph_tab, self.graph_tab.output_dock)
        self.register_tab_console(self.runtime_debug_tab, self.runtime_debug_tab.output_dock)
        self.register_tab_console(self.asset_tab, self.asset_tab.output_dock)
        self.register_tab_console(self.asset_candidate_tab, self.asset_candidate_tab.output_dock)
        self.register_tab_console(self.image_tab, self.image_tab.output_dock)
        self.register_tab_console(self.animation_sheet_tab, self.animation_sheet_tab.output_dock)
        self.register_tab_console(self.asset_task_tab, self.asset_task_tab.prompt_dock)
        self.register_tab_console(self.codex_tab, self.codex_tab.output_dock)
        self._reload_tabs()
        QTimer.singleShot(0, self._sync_current_tab_console)

    def _pick_project(self) -> None:
        running = self._running_background_thread_names()
        if running:
            self._show_background_task_warning("暂时不能切换工程", running, "切换工程")
            return
        path = QFileDialog.getExistingDirectory(self, "选择 GameDraft 工程", str(self.project_root))
        if not path:
            return
        candidate = Path(path).resolve()
        if not _is_project_root(candidate):
            QMessageBox.warning(self, "无效工程", "请选择包含 public/assets 的 GameDraft 工程根目录。")
            return
        self.project_root = candidate
        self._project_label.setText(str(self.project_root))
        for dock in self._console_docks.values():
            dock.console.set_project_root(self.project_root)
        self.setWindowTitle(f"GameDraft 生产工作台 - {self.project_root.name}")
        self._reload_tabs()

    def console_dock(self, context_id: str, title: str) -> WorkbenchConsoleDock:
        dock = self._console_docks.get(context_id)
        if dock is not None:
            return dock
        dock = WorkbenchConsoleDock(self.project_root, context_id, title, parent=self)
        self._console_docks[context_id] = dock
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, dock)
        dock.hide()
        return dock

    def register_tab_console(self, tab: QWidget, dock: WorkbenchConsoleDock) -> None:
        docks = self._tab_console_docks.setdefault(tab, [])
        if dock not in docks:
            docks.append(dock)
        self._sync_current_tab_console()

    def _sync_current_tab_console(self, _index: int | None = None) -> None:
        current = self.tabs.currentWidget() if hasattr(self, "tabs") else None
        visible = set(self._tab_console_docks.get(current, []))
        for dock in self._console_docks.values():
            if dock.property("inlineConsole"):
                dock.hide()
                continue
            if dock.isFloating() and dock.isVisible():
                continue
            dock.setVisible(dock in visible)

    def open_reports_folder(self) -> None:
        path = workbench_reports_root(self.project_root)
        path.mkdir(parents=True, exist_ok=True)
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(path))):
            QMessageBox.warning(self, "打开失败", f"无法打开报告目录:\n{path}")

    def _reload_tabs(self) -> None:
        self.story_tab.set_project_root(self.project_root)
        self.daily_tab.set_project_root(self.project_root)
        self.graph_tab.set_project_root(self.project_root)
        self.runtime_debug_tab.set_project_root(self.project_root)
        self.asset_tab.set_project_root(self.project_root)
        self.asset_candidate_tab.set_project_root(self.project_root)
        self.image_tab.set_project_root(self.project_root)
        self.animation_sheet_tab.set_project_root(self.project_root)
        self.asset_task_tab.set_project_root(self.project_root)
        self.codex_tab.set_project_root(self.project_root)

    def _running_background_thread_names(self) -> list[str]:
        return [
            thread.__class__.__name__
            for thread in self.findChildren(QThread)
            if thread.isRunning()
        ]

    def _show_background_task_warning(self, title: str, running: list[str], action: str) -> None:
        QMessageBox.information(
            self,
            title,
            f"下面这些后台任务还没结束，先等它们跑完再{action}:\n\n"
            + "\n".join(f"- {name}" for name in running),
        )

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802 - Qt override name.
        running = self._running_background_thread_names()
        if running:
            self._show_background_task_warning("后台任务仍在运行", running, "关闭工作台")
            event.ignore()
            return
        super().closeEvent(event)


@dataclass(frozen=True)
class StoryUnitLoadResult:
    project_root: Path
    workspace: StoryUnitWorkspace | None = None
    message: str = ""


class StoryUnitLoadThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(self, project_root: Path, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.project_root = project_root

    def run(self) -> None:
        try:
            workspace = load_story_unit_workspace(self.project_root)
        except Exception as exc:  # noqa: BLE001 - report story-unit loading failures in the tab.
            self.failed.emit(StoryUnitLoadResult(project_root=self.project_root, message=str(exc)))
            return
        self.completed.emit(StoryUnitLoadResult(project_root=self.project_root, workspace=workspace))


class StoryUnitTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.host = host
        self.project_root = host.project_root
        self.workspace: StoryUnitWorkspace | None = None
        self.current_id = ""
        self.loading_fields = False
        self._story_thread: StoryUnitLoadThread | None = None
        self._picker_model: ProjectModel | None = None
        self._workflow_guide_dialog: ReportDialog | None = None

        layout = QVBoxLayout(self)
        toolbar = QHBoxLayout()
        self.btn_refresh = QPushButton("刷新列表")
        self.btn_save = QPushButton("保存当前单元")
        self.btn_copy = QPushButton("复制当前单元报告")
        self.btn_open_sources = QPushButton("打开相关源")
        self.btn_workflow_guide = QPushButton("操作向导")
        self.btn_self_check = QPushButton("当前单元自检")
        self.btn_check_acceptance = QPushButton("1. 检查脚本")
        self.btn_start_acceptance_run = QPushButton("2. 发送到游戏运行")
        self.btn_compare_runtime = QPushButton("只对比当前快照")
        self.btn_finish_acceptance_run = QPushButton("3. 完成并记录结果")
        self.btn_refresh.clicked.connect(self.reload)
        self.btn_save.clicked.connect(self.save)
        self.btn_copy.clicked.connect(self.copy_current_report)
        self.btn_open_sources.clicked.connect(self.open_current_sources)
        self.btn_workflow_guide.clicked.connect(self.show_planner_workflow_guide)
        self.btn_self_check.clicked.connect(self.show_planner_self_check)
        self.btn_check_acceptance.clicked.connect(self.check_acceptance_script)
        self.btn_start_acceptance_run.clicked.connect(self.start_acceptance_run)
        self.btn_compare_runtime.clicked.connect(self.compare_acceptance_runtime)
        self.btn_finish_acceptance_run.clicked.connect(self.finish_acceptance_run)
        toolbar.addWidget(self.btn_refresh)
        toolbar.addWidget(self.btn_save)
        toolbar.addWidget(self.btn_copy)
        toolbar.addWidget(self.btn_open_sources)
        toolbar.addWidget(self.btn_workflow_guide)
        toolbar.addWidget(self.btn_self_check)
        toolbar.addWidget(self.btn_check_acceptance)
        toolbar.addWidget(self.btn_start_acceptance_run)
        toolbar.addWidget(self.btn_compare_runtime)
        toolbar.addWidget(self.btn_finish_acceptance_run)
        toolbar.addStretch(1)
        layout.addWidget(_scrollable_toolbar(toolbar))
        overview = _hint_label(
            "剧情单元不是新的内容编辑器。它只做三件事："
            "先把一个剧情块登记清楚，再写一条可复现的验收路线，最后把这条路线发给运行中的游戏并对比结果。"
            "具体剧情、对白、状态仍回原编辑器修改。"
        )
        layout.addWidget(overview)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter, 1)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["ID", "名称", "类型", "状态", "问题"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.itemSelectionChanged.connect(self._on_selection_changed)
        splitter.addWidget(self.table)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        form_wrap = QWidget()
        form_layout = QVBoxLayout(form_wrap)
        self.edit_id = QLineEdit()
        self.edit_id.setReadOnly(True)
        self.edit_name = QLineEdit()
        self.edit_type = QLineEdit()
        self.edit_type.setReadOnly(True)
        self.edit_status = QLineEdit()
        self.edit_status.setReadOnly(True)
        self.edit_estimate = QLineEdit()
        self.edit_entry = _text_edit(52)
        self.edit_exit = _text_edit(52)
        self.edit_acceptance = _text_edit(80)
        self.edit_script_entry = _text_edit(46)
        self.edit_script_flags = _text_edit(46)
        self.edit_script_quests = _text_edit(46)
        self.edit_script_scenarios = _text_edit(46)
        self.edit_script_states = _text_edit(46)
        self.edit_script_actions = _text_edit(70)
        self.edit_script_options = _text_edit(46)
        self.edit_script_expected_signals = _text_edit(46)
        self.edit_script_expected_states = _text_edit(46)
        self.edit_script_expected_quests = _text_edit(46)
        self.edit_script_expected_scenarios = _text_edit(46)
        self.edit_script_save_load = _text_edit(55)
        self.edit_script_status = QLineEdit()
        self.edit_script_status.setReadOnly(True)
        self.edit_script_note = _text_edit(55)
        self.edit_blockers = _text_edit(80)
        self.edit_asset_needs = _text_edit(70)
        self.edit_note = _text_edit(70)
        self.edit_name.setPlaceholderText("给策划看的名字；不会改运行时 ID")
        self.edit_type.setPlaceholderText("点右侧按钮选择")
        self.edit_status.setPlaceholderText("点右侧按钮选择")
        self.edit_estimate.setPlaceholderText("可选，例如 2")
        self.edit_entry.setPlaceholderText("玩家怎样进入这个剧情块；也可写 scene:test_scene spawn:door 供验收脚本复用")
        self.edit_exit.setPlaceholderText("剧情结束后应该停在哪里，例如 ringboy_flow.done")
        self.edit_acceptance.setPlaceholderText("一句话写清楚通过标准，例如 发出 ringboy.met 且任务进入 Active")
        self.edit_script_entry.setPlaceholderText("可选；为空就复用上面的“剧情入口”。例：scene:test_scene spawn:door")
        self.edit_script_flags.setPlaceholderText("例：ringboy_seen = false")
        self.edit_script_quests.setPlaceholderText("例：bridge_find_source inactive")
        self.edit_script_scenarios.setPlaceholderText("例：line_a.intro done")
        self.edit_script_states.setPlaceholderText("例：ringboy_flow.intro")
        self.edit_script_actions.setPlaceholderText("每行一步。例：dialogue:ringboy；走完对话；click:10,20")
        self.edit_script_options.setPlaceholderText("例：帮忙")
        self.edit_script_expected_signals.setPlaceholderText("例：ringboy.met")
        self.edit_script_expected_states.setPlaceholderText("例：ringboy_flow.done")
        self.edit_script_expected_quests.setPlaceholderText("例：bridge_find_source accepted")
        self.edit_script_expected_scenarios.setPlaceholderText("例：line_a completed")
        self.edit_script_save_load.setPlaceholderText("例：保存读档后重进场景 slot:2；或写“人工确认”")
        self.edit_blockers.setPlaceholderText("每行一个真正挡住制作/验收的问题")
        self.edit_asset_needs.setPlaceholderText("每行一个素材需求，例如 戒指男孩站立 sprite 64x96")
        self.edit_note.setPlaceholderText("给自己或 Codex 的补充说明")
        for generated_field in [
            self.edit_script_entry,
            self.edit_script_flags,
            self.edit_script_quests,
            self.edit_script_scenarios,
            self.edit_script_states,
            self.edit_script_actions,
            self.edit_script_options,
            self.edit_script_expected_signals,
            self.edit_script_expected_states,
            self.edit_script_expected_quests,
            self.edit_script_expected_scenarios,
            self.edit_script_save_load,
        ]:
            generated_field.setReadOnly(True)

        tracking_group = QGroupBox("1. 这个剧情单元是什么（人工追踪，不改运行时）")
        tracking_form = QFormLayout(tracking_group)
        tracking_form.addRow(_hint_label("先填这里。入口/出口/验收是给人和每日检查看的定义，不是新剧情数据。"))
        tracking_form.addRow("运行时 ID", self.edit_id)
        tracking_form.addRow("显示名", self.edit_name)
        tracking_form.addRow("类型", _line_with_button(self.edit_type, _small_button("选择", self.choose_unit_type)))
        tracking_form.addRow("制作状态", _line_with_button(self.edit_status, _small_button("选择", self.choose_production_status)))
        tracking_form.addRow("预计小时", self.edit_estimate)
        tracking_form.addRow("剧情入口", self.edit_entry)
        tracking_form.addRow("剧情出口", self.edit_exit)
        tracking_form.addRow("通过标准", self.edit_acceptance)

        acceptance_group = QGroupBox("2. 自动验收怎么跑（会按顺序转成 runtime debug 命令）")
        acceptance_form = QFormLayout(acceptance_group)
        acceptance_form.addRow(_hint_label(
            "用法：不要手写 ID。用每行右侧按钮打开搜索选择器，工具会生成可检查、可执行的脚本文本。"
            "点“检查脚本”只查引用和格式；点“发送到游戏运行”才会把命令发给已打开的游戏页面。"
        ))
        self.acceptance_steps_table = QTableWidget(0, 3)
        self.acceptance_steps_table.setHorizontalHeaderLabels(["阶段", "内容", "底层命令"])
        self.acceptance_steps_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.acceptance_steps_table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.acceptance_steps_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.acceptance_steps_table.setMinimumHeight(190)
        acceptance_form.addRow("验收路线", self.acceptance_steps_table)
        acceptance_form.addRow("", _button_row([
            ("生成验收草稿", self.generate_acceptance_draft),
            ("删除选中", self.delete_selected_acceptance_step),
            ("上移", self.move_selected_acceptance_step_up),
            ("下移", self.move_selected_acceptance_step_down),
            ("复制验收路线", self.copy_acceptance_route),
            ("刷新列表", self.refresh_acceptance_steps_table),
        ]))
        acceptance_form.addRow("添加起点", _button_row([
            ("选场景", self.add_entry_scene),
            ("选对话", self.add_entry_dialogue),
            ("清空", lambda: self.clear_generated_field(self.edit_script_entry)),
        ]))
        acceptance_form.addRow("添加前置", _button_row([
            ("加 flag", self.add_setup_flag),
            ("加 quest", self.add_setup_quest),
            ("加 scenario", self.add_setup_scenario),
            ("加 state", self.add_setup_state),
        ]))
        acceptance_form.addRow("添加步骤", _button_row([
            ("切场景", self.add_action_scene),
            ("NPC", self.add_action_npc),
            ("热点", self.add_action_hotspot),
            ("对话", self.add_action_dialogue),
            ("走完对话", self.add_action_advance),
            ("发 signal", self.add_action_signal),
            ("点坐标", self.add_action_click_point),
            ("移动坐标", self.add_action_move_point),
            ("路径", self.add_action_path_points),
            ("等待", self.add_action_wait),
            ("清空", lambda: self.clear_generated_field(self.edit_script_actions)),
        ]))
        acceptance_form.addRow("添加选项", _button_row([
            ("选 option", self.add_option_choice),
            ("清空", lambda: self.clear_generated_field(self.edit_script_options)),
        ]))
        acceptance_form.addRow("添加期望", _button_row([
            ("加 signal", self.add_expected_signal),
            ("加 state", self.add_expected_state),
            ("加 quest", self.add_expected_quest),
            ("加 scenario", self.add_expected_scenario),
        ]))
        acceptance_form.addRow("添加复查", _button_row([
            ("存读档", self.add_save_load_check),
            ("重进场景", self.add_reload_scene_check),
            ("人工确认", self.add_manual_save_load_check),
            ("清空", lambda: self.clear_generated_field(self.edit_script_save_load)),
        ]))

        result_group = QGroupBox("3. 结果、阻塞和素材需求")
        result_form = QFormLayout(result_group)
        result_form.addRow(_hint_label("验收跑完后看这里。失败时直接复制当前单元报告给 Codex。"))
        result_form.addRow("最近验收结果", _line_with_button(self.edit_script_status, _small_button("选择", self.choose_script_status)))
        result_form.addRow("验收备注", self.edit_script_note)
        result_form.addRow("阻塞", self.edit_blockers)
        result_form.addRow("素材需求", self.edit_asset_needs)
        result_form.addRow("选择器", _button_row([
            ("加 zone 到备注", self.add_zone_note),
            ("选已有素材需求", self.add_asset_need_from_picker),
        ]))
        result_form.addRow("备注", self.edit_note)
        form_layout.addWidget(tracking_group)
        form_layout.addWidget(acceptance_group)
        form_layout.addWidget(result_group)
        form_layout.addStretch(1)
        form_scroll = QScrollArea()
        form_scroll.setWidgetResizable(True)
        form_scroll.setWidget(form_wrap)
        right_layout.addWidget(form_scroll, 3)

        self.summary_dock = host.console_dock("story-unit", "Story Unit Summary")
        self.summary = _inline_console_from_dock(self.summary_dock, minimum_height=210)
        self.summary_dock.setProperty("inlineConsole", False)
        right_layout.addWidget(QLabel("自动聚合摘要"))
        right_layout.addWidget(self.summary, 1)
        splitter.addWidget(right)
        splitter.setSizes([520, 780])

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self._invalidate_picker_model()
        self.workspace = None
        self.current_id = ""
        self.table.setRowCount(0)
        self._clear_fields()
        self.summary.setPlainText("正在准备加载剧情单元...")
        self._set_story_loading(True)
        QTimer.singleShot(0, self.reload)

    def reload(self) -> None:
        if self._story_thread is not None and self._story_thread.isRunning():
            self.summary.setPlainText("剧情单元正在加载，请稍等。")
            return
        self._invalidate_picker_model()
        self._set_story_loading(True)
        self.summary.setPlainText("正在加载剧情单元...")
        thread = StoryUnitLoadThread(self.project_root, parent=self)
        self._story_thread = thread
        thread.completed.connect(self._on_story_units_loaded)
        thread.failed.connect(self._on_story_units_failed)
        thread.finished.connect(self._on_story_units_finished)
        thread.start()

    def _on_story_units_loaded(self, result: StoryUnitLoadResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.workspace = result.workspace
        self.current_id = ""
        self.loading_fields = True
        try:
            self._populate_table()
        finally:
            self.loading_fields = False
        if self.table.rowCount() > 0:
            self.table.selectRow(0)
        else:
            self._clear_fields()

    def _on_story_units_failed(self, result: StoryUnitLoadResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.workspace = None
        self.current_id = ""
        self.table.setRowCount(0)
        self._clear_fields()
        text = _with_saved_report_note(self.project_root, "story-units-load-failed", f"剧情单元加载失败:\n{result.message}")
        self.summary.setPlainText(text)

    def _on_story_units_finished(self) -> None:
        if self._story_thread is not None:
            self._story_thread.deleteLater()
            self._story_thread = None
        self._set_story_loading(False)

    def _set_story_loading(self, loading: bool) -> None:
        self.btn_refresh.setEnabled(not loading)
        self._set_story_actions_enabled(not loading and self._current_unit() is not None)

    def _story_action_buttons(self) -> list[QPushButton]:
        return [
            self.btn_save,
            self.btn_copy,
            self.btn_open_sources,
            self.btn_workflow_guide,
            self.btn_self_check,
            self.btn_check_acceptance,
            self.btn_start_acceptance_run,
            self.btn_compare_runtime,
            self.btn_finish_acceptance_run,
        ]

    def _set_story_actions_enabled(self, enabled: bool) -> None:
        for button in self._story_action_buttons():
            button.setEnabled(enabled)

    def _refresh_story_action_buttons(self) -> None:
        loading = self._story_thread is not None and self._story_thread.isRunning()
        self._set_story_actions_enabled(not loading and self._current_unit() is not None)

    def save(self) -> None:
        if self.workspace is None:
            return
        self._save_current_fields()
        unit = self._current_unit()
        if unit is not None and not self._status_gate_allows_save(unit):
            return
        try:
            path = save_story_unit_workspace(self.workspace)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self._populate_table(keep_current=True)
        QMessageBox.information(self, "已保存", f"追踪信息已保存到:\n{path}")

    def _status_gate_allows_save(self, unit: StoryUnit) -> bool:
        status = unit.record.production_status
        if status not in {"待验收", "通过", "冻结"}:
            return True
        problems: list[str] = []
        if not unit.record.entry.strip():
            problems.append("缺入口")
        if not unit.record.exit.strip():
            problems.append("缺出口")
        if not unit.record.acceptance.strip():
            problems.append("缺验收")
        problems.extend(story_unit_completeness_issues(unit))
        try:
            report = check_story_unit_acceptance_script(self.project_root, unit)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"验收脚本无法检查: {exc}")
        else:
            problems.extend(issue.message for issue in report.issues if issue.severity == "error")
        if status in {"通过", "冻结"} and unit.record.acceptance_script.last_run_status != "通过":
            problems.append("最近一次验收结果不是“通过”")
        if not problems:
            return True
        QMessageBox.warning(
            self,
            "状态不能保存",
            "这个剧情单元还不能进入“待验收 / 通过 / 冻结”。\n\n"
            + "\n".join(f"- {p}" for p in problems[:12])
            + ("\n- ..." if len(problems) > 12 else ""),
        )
        return False

    def copy_current_report(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        QApplication.clipboard().setText(story_unit_report(unit))

    def open_current_sources(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        item = _pick_source_item(self, self.project_root, unit)
        if not item:
            return
        path = item.get("path")
        if isinstance(path, Path):
            _open_local_path(self, path, "打开源文件")

    def show_planner_self_check(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        text = _planner_self_check_report(self.project_root, unit)
        display = _with_saved_report_note(self.project_root, f"story-self-check-{unit.record.composition_id}", text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)

    def show_planner_workflow_guide(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        text = _planner_workflow_guide(self.project_root, unit)
        display = _with_saved_report_note(self.project_root, f"story-workflow-{unit.record.composition_id}", text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)
        if self._workflow_guide_dialog is None:
            self._workflow_guide_dialog = ReportDialog("Story Unit Workflow Guide", display, self)
        else:
            self._workflow_guide_dialog.output.setPlainText(display)
        self._workflow_guide_dialog.show()
        self._workflow_guide_dialog.raise_()
        self._workflow_guide_dialog.activateWindow()

    def choose_unit_type(self) -> None:
        item = self._pick_item("选择剧情单元类型", _unit_type_items())
        if item:
            self.edit_type.setText(item["value"])
            self._save_current_fields()

    def choose_production_status(self) -> None:
        item = self._pick_item("选择制作状态", _production_status_items())
        if item:
            self.edit_status.setText(item["value"])
            self._save_current_fields()

    def choose_script_status(self) -> None:
        item = self._pick_item("选择最近验收结果", _script_status_items())
        if item:
            self.edit_script_status.setText(item["value"])
            self._save_current_fields()

    def add_entry_scene(self) -> None:
        line = self._pick_scene_command("选择验收起点场景")
        if line:
            self._set_generated_line(self.edit_script_entry, line)

    def add_entry_dialogue(self) -> None:
        item = self._pick_item("选择验收起点对话", _dialogue_items(self._load_picker_model()))
        if item:
            self._set_generated_line(self.edit_script_entry, f"dialogue:{item['value']}")

    def add_setup_flag(self) -> None:
        model = self._load_picker_model()
        flag = self._pick_item("选择前置 flag", _flag_items(model))
        if not flag:
            return
        value = self._pick_value("选择 flag 初始值", [
            _picker_item("false", "false / 未触发"),
            _picker_item("true", "true / 已触发"),
        ])
        if value:
            self._append_generated_line(self.edit_script_flags, f"{flag['value']} = {value}")

    def add_setup_quest(self) -> None:
        line = self._pick_quest_status_line("选择前置 quest 状态")
        if line:
            self._append_generated_line(self.edit_script_quests, line)

    def add_setup_scenario(self) -> None:
        line = self._pick_scenario_status_line("选择前置 scenario 状态")
        if line:
            self._append_generated_line(self.edit_script_scenarios, line)

    def add_setup_state(self) -> None:
        item = self._pick_item("选择前置 narrative state", _narrative_state_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_states, item["value"])

    def add_action_scene(self) -> None:
        line = self._pick_scene_command("选择要切换到的场景")
        if line:
            self._append_generated_line(self.edit_script_actions, line)

    def add_action_npc(self) -> None:
        item = self._pick_item("选择要交互的 NPC", _npc_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_actions, f"npc:{item['value']}")

    def add_action_hotspot(self) -> None:
        item = self._pick_item("选择要触发的热点", _hotspot_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_actions, f"hotspot:{item['value']}")

    def add_action_dialogue(self) -> None:
        item = self._pick_item("选择要打开的对话", _dialogue_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_actions, f"dialogue:{item['value']}")

    def add_action_advance(self) -> None:
        self._append_generated_line(self.edit_script_actions, "走完对话")

    def add_action_signal(self) -> None:
        item = self._pick_item("选择要主动发出的 signal", _signal_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_actions, f"signal:{item['value']}")

    def add_action_click_point(self) -> None:
        points = self._pick_scene_points("选择要点击的场景", allow_path=False)
        if points:
            x, y = points[0]
            self._append_generated_line(self.edit_script_actions, f"click:{_fmt_point(x, y)}")

    def add_action_move_point(self) -> None:
        points = self._pick_scene_points("选择玩家要移动到的场景点", allow_path=False)
        if points:
            x, y = points[0]
            self._append_generated_line(self.edit_script_actions, f"moveTo x={_fmt_num(x)} y={_fmt_num(y)}")

    def add_action_path_points(self) -> None:
        points = self._pick_scene_points("选择玩家移动路径所在场景", allow_path=True)
        if len(points) >= 2:
            self._append_generated_line(
                self.edit_script_actions,
                "path:" + " -> ".join(_fmt_point(x, y) for x, y in points),
            )

    def add_action_wait(self) -> None:
        value = self._pick_value("选择等待时间", [
            _picker_item("250", "250 ms"),
            _picker_item("500", "500 ms"),
            _picker_item("1000", "1 秒"),
            _picker_item("2000", "2 秒"),
        ])
        if value:
            self._append_generated_line(self.edit_script_actions, f"等待{value}ms")

    def add_option_choice(self) -> None:
        item = self._pick_item("选择对话选项", _dialogue_option_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_options, f"option:{item['value']}")

    def add_expected_signal(self) -> None:
        item = self._pick_item("选择期望 signal", _signal_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_expected_signals, item["value"])

    def add_expected_state(self) -> None:
        item = self._pick_item("选择期望 narrative state", _narrative_state_items(self._load_picker_model()))
        if item:
            self._append_generated_line(self.edit_script_expected_states, item["value"])

    def add_expected_quest(self) -> None:
        line = self._pick_quest_status_line("选择期望 quest 变化")
        if line:
            self._append_generated_line(self.edit_script_expected_quests, line)

    def add_expected_scenario(self) -> None:
        line = self._pick_scenario_status_line("选择期望 scenario 变化")
        if line:
            self._append_generated_line(self.edit_script_expected_scenarios, line)

    def add_save_load_check(self) -> None:
        slot = self._pick_value("选择存档槽位", [
            _picker_item("0", "slot 0"),
            _picker_item("1", "slot 1"),
            _picker_item("2", "slot 2"),
        ])
        if slot:
            self._set_generated_line(self.edit_script_save_load, f"保存读档 slot:{slot}")

    def add_reload_scene_check(self) -> None:
        line = self._pick_scene_command("选择重进场景", include_spawn=False)
        if line:
            self._set_generated_line(self.edit_script_save_load, f"重进场景 {line}")

    def add_manual_save_load_check(self) -> None:
        self._set_generated_line(self.edit_script_save_load, "人工确认存读档")

    def add_zone_note(self) -> None:
        item = self._pick_item("选择相关 zone", _zone_items(self._load_picker_model()))
        if item:
            self._append_plain_line(self.edit_note, f"涉及 zone: {item['value']} ({item.get('detail', '')})")

    def add_asset_need_from_picker(self) -> None:
        item = self._pick_item("选择已有素材作为需求参考", _asset_items(self.project_root))
        if item:
            self._append_plain_line(self.edit_asset_needs, f"参考素材: {item['value']} - {item['label']}")

    def clear_generated_field(self, editor: QTextEdit) -> None:
        editor.clear()
        self._save_current_fields()
        self.refresh_acceptance_steps_table()

    def refresh_acceptance_steps_table(self) -> None:
        self._refresh_acceptance_steps_table()

    def clear_acceptance_steps_list(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        answer = QMessageBox.question(
            self,
            "Clear Acceptance Route",
            "Clear generated acceptance route steps for the current story unit?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        for editor in [
            self.edit_script_entry,
            self.edit_script_flags,
            self.edit_script_quests,
            self.edit_script_scenarios,
            self.edit_script_states,
            self.edit_script_actions,
            self.edit_script_options,
            self.edit_script_expected_signals,
            self.edit_script_expected_states,
            self.edit_script_expected_quests,
            self.edit_script_expected_scenarios,
            self.edit_script_save_load,
        ]:
            editor.clear()
        self._save_current_fields()
        self._refresh_acceptance_steps_table()

    def copy_acceptance_route(self) -> None:
        rows = self._acceptance_step_rows()
        if not rows:
            QApplication.clipboard().setText("当前剧情单元还没有验收路线。")
            return
        lines = ["验收路线:"]
        for index, row in enumerate(rows, start=1):
            lines.append(f"{index}. [{row['phase']}] {row['display']}")
        QApplication.clipboard().setText("\n".join(lines))

    def generate_acceptance_draft(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        if self._acceptance_step_rows():
            QMessageBox.information(self, "已有验收路线", "当前单元已经有验收路线；为避免覆盖，请先手动删除已有路线。")
            return
        draft = _build_acceptance_draft(unit)
        if not draft["startEntry"] and not draft["actions"] and not draft["expectedSignals"] and not draft["expectedStates"]:
            QMessageBox.warning(self, "无法生成草稿", "这个剧情单元缺少 dialogue / signal / state 等可推断信息，请用选择器手动添加。")
            return
        self.edit_script_entry.setPlainText(draft["startEntry"])
        self.edit_script_actions.setPlainText("\n".join(draft["actions"]))
        self.edit_script_expected_signals.setPlainText("\n".join(draft["expectedSignals"]))
        self.edit_script_expected_states.setPlainText("\n".join(draft["expectedStates"]))
        self.edit_script_expected_quests.setPlainText("\n".join(draft["expectedQuests"]))
        self.edit_script_save_load.setPlainText(draft["saveLoadCheck"])
        if not self.edit_type.text().strip():
            self.edit_type.setText(_suggest_unit_type(unit))
        if not self.edit_status.text().strip() or self.edit_status.text().strip() == "未做":
            self.edit_status.setText("制作中")
        if not self.edit_script_status.text().strip():
            self.edit_script_status.setText("未跑")
        self._save_current_fields()
        self._refresh_acceptance_steps_table()
        self.summary.setPlainText(
            "已生成验收草稿。\n"
            "下一步：检查验收路线是否符合你的真实意图，然后点击“1. 检查脚本”。\n\n"
            + "\n".join(f"- {row['display']}" for row in self._acceptance_step_rows())
        )

    def delete_selected_acceptance_step(self) -> None:
        selection = self._selected_acceptance_step()
        if selection is None:
            return
        editor = self._script_editor_by_key(selection["field"])
        if editor is None:
            return
        lines = _text_lines(editor)
        index = int(selection["index"])
        if selection["field"] in {"entry", "saveLoad"}:
            editor.clear()
        elif 0 <= index < len(lines):
            del lines[index]
            editor.setPlainText("\n".join(lines))
        self._save_current_fields()
        self._refresh_acceptance_steps_table()

    def move_selected_acceptance_step_up(self) -> None:
        self._move_selected_acceptance_step(-1)

    def move_selected_acceptance_step_down(self) -> None:
        self._move_selected_acceptance_step(1)

    def _move_selected_acceptance_step(self, direction: int) -> None:
        selection = self._selected_acceptance_step()
        if selection is None or selection["field"] in {"entry", "saveLoad"}:
            return
        editor = self._script_editor_by_key(selection["field"])
        if editor is None:
            return
        lines = _text_lines(editor)
        index = int(selection["index"])
        target = index + direction
        if index < 0 or index >= len(lines) or target < 0 or target >= len(lines):
            return
        lines[index], lines[target] = lines[target], lines[index]
        editor.setPlainText("\n".join(lines))
        self._save_current_fields()
        self._refresh_acceptance_steps_table(select_field=selection["field"], select_index=target)

    def _selected_acceptance_step(self) -> dict[str, Any] | None:
        if not hasattr(self, "acceptance_steps_table"):
            return None
        rows = self.acceptance_steps_table.selectionModel().selectedRows() if self.acceptance_steps_table.selectionModel() else []
        if not rows:
            return None
        item = self.acceptance_steps_table.item(rows[0].row(), 0)
        data = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        return data if isinstance(data, dict) else None

    def _script_editor_by_key(self, field: str) -> QTextEdit | None:
        return {
            "entry": self.edit_script_entry,
            "setupFlags": self.edit_script_flags,
            "setupQuests": self.edit_script_quests,
            "setupScenarios": self.edit_script_scenarios,
            "setupStates": self.edit_script_states,
            "actions": self.edit_script_actions,
            "options": self.edit_script_options,
            "expectedSignals": self.edit_script_expected_signals,
            "expectedStates": self.edit_script_expected_states,
            "expectedQuests": self.edit_script_expected_quests,
            "expectedScenarios": self.edit_script_expected_scenarios,
            "saveLoad": self.edit_script_save_load,
        }.get(field)

    def _refresh_acceptance_steps_table(self, *, select_field: str = "", select_index: int = -1) -> None:
        if not hasattr(self, "acceptance_steps_table"):
            return
        rows = self._acceptance_step_rows()
        self.acceptance_steps_table.setRowCount(0)
        selected_row = -1
        for row, data in enumerate(rows):
            self.acceptance_steps_table.insertRow(row)
            values = [data["phase"], data["display"], data["raw"]]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setData(Qt.ItemDataRole.UserRole, data)
                self.acceptance_steps_table.setItem(row, col, item)
            if data["field"] == select_field and int(data["index"]) == select_index:
                selected_row = row
        self.acceptance_steps_table.resizeColumnsToContents()
        if selected_row >= 0:
            self.acceptance_steps_table.selectRow(selected_row)

    def _acceptance_step_rows(self) -> list[dict[str, Any]]:
        sections: list[tuple[str, str, QTextEdit]] = [
            ("entry", "起点", self.edit_script_entry),
            ("setupFlags", "前置 flag", self.edit_script_flags),
            ("setupQuests", "前置 quest", self.edit_script_quests),
            ("setupScenarios", "前置 scenario", self.edit_script_scenarios),
            ("setupStates", "前置 state", self.edit_script_states),
            ("actions", "步骤", self.edit_script_actions),
            ("options", "选项", self.edit_script_options),
            ("expectedSignals", "期望 signal", self.edit_script_expected_signals),
            ("expectedStates", "期望 state", self.edit_script_expected_states),
            ("expectedQuests", "期望 quest", self.edit_script_expected_quests),
            ("expectedScenarios", "期望 scenario", self.edit_script_expected_scenarios),
            ("saveLoad", "复查", self.edit_script_save_load),
        ]
        rows: list[dict[str, Any]] = []
        for field, phase, editor in sections:
            lines = _text_lines(editor)
            if field in {"entry", "saveLoad"}:
                text = editor.toPlainText().strip()
                if text:
                    rows.append({
                        "field": field,
                        "index": 0,
                        "phase": phase,
                        "display": _acceptance_display_text(field, text),
                        "raw": text,
                    })
                continue
            for index, line in enumerate(lines):
                rows.append({
                    "field": field,
                    "index": index,
                    "phase": phase,
                    "display": _acceptance_display_text(field, line),
                    "raw": line,
                })
        return rows

    def _load_picker_model(self) -> ProjectModel:
        if self._picker_model is not None:
            return self._picker_model
        model = ProjectModel()
        model.load_project(self.project_root)
        self._picker_model = model
        return model

    def _invalidate_picker_model(self) -> None:
        self._picker_model = None

    def _pick_item(self, title: str, items: list[dict[str, Any]]) -> dict[str, Any] | None:
        return _pick_item_dialog(self, title, items, empty_message="没有可选项。请先在原编辑器里创建对应内容。")

    def _pick_value(self, title: str, items: list[dict[str, str]]) -> str:
        item = self._pick_item(title, items)
        return item["value"] if item else ""

    def _pick_scene_command(self, title: str, *, include_spawn: bool = True) -> str:
        model = self._load_picker_model()
        scene = self._pick_item(title, _scene_items(model))
        if not scene:
            return ""
        scene_id = scene["value"]
        if not include_spawn:
            return f"scene:{scene_id}"
        spawn = self._pick_item(f"选择 {scene_id} 的出生点", _spawn_items(model, scene_id))
        if spawn and spawn["value"]:
            return f"scene:{scene_id} spawn:{spawn['value']}"
        return f"scene:{scene_id}"

    def _pick_scene_points(self, title: str, *, allow_path: bool) -> list[tuple[float, float]]:
        model = self._load_picker_model()
        scene_item = self._pick_item(title, _scene_items(model))
        if not scene_item:
            return []
        scene_id = scene_item["value"]
        scene = model.scenes.get(scene_id) if isinstance(model.scenes.get(scene_id), dict) else {}
        dialog = ScenePointPickerDialog(
            self.project_root,
            scene_id,
            scene,
            allow_path=allow_path,
            parent=self,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return []
        return dialog.selected_points

    def _pick_quest_status_line(self, title: str) -> str:
        quest = self._pick_item(title, _quest_items(self._load_picker_model()))
        if not quest:
            return ""
        status = self._pick_value("选择 quest 状态", [
            _picker_item("inactive", "未接 / Inactive"),
            _picker_item("active", "进行中 / Active"),
            _picker_item("completed", "完成 / Completed"),
        ])
        return f"{quest['value']} {status}" if status else ""

    def _pick_scenario_status_line(self, title: str) -> str:
        model = self._load_picker_model()
        scenario = self._pick_item(title, _scenario_items(model))
        if not scenario:
            return ""
        phase_item = self._pick_item(
            "选择 scenario phase",
            [_picker_item("", "不指定 phase", "用于整条 scenario line 状态。")]
            + _scenario_phase_items(model, scenario["value"]),
        )
        if phase_item is None:
            return ""
        status = self._pick_value("选择 scenario 状态", [
            _picker_item("active", "进行中 / active"),
            _picker_item("completed", "完成 / completed"),
            _picker_item("done", "阶段完成 / done"),
            _picker_item("inactive", "未激活 / inactive"),
            _picker_item("pending", "等待 / pending"),
            _picker_item("locked", "锁定 / locked"),
        ])
        if not status:
            return ""
        target = scenario["value"]
        if phase_item["value"]:
            target = f"{target}.{phase_item['value']}"
        return f"{target} {status}"

    def _set_generated_line(self, editor: QTextEdit, line: str) -> None:
        editor.setPlainText(line.strip())
        self._save_current_fields()
        self._refresh_acceptance_steps_table()

    def _append_generated_line(self, editor: QTextEdit, line: str) -> None:
        value = line.strip()
        if not value:
            return
        existing = _text_lines(editor)
        if value not in existing:
            existing.append(value)
        editor.setPlainText("\n".join(existing))
        self._save_current_fields()
        self._refresh_acceptance_steps_table()

    def _append_plain_line(self, editor: QTextEdit, line: str) -> None:
        value = line.strip()
        if not value:
            return
        existing = _text_lines(editor)
        if value not in existing:
            existing.append(value)
        editor.setPlainText("\n".join(existing))
        self._save_current_fields()

    def check_acceptance_script(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        try:
            report = check_story_unit_acceptance_script(self.project_root, unit)
        except Exception as exc:  # noqa: BLE001
            display = _with_saved_report_note(
                self.project_root,
                f"story-acceptance-check-failed-{unit.record.composition_id}",
                f"验收脚本检查失败:\n{exc}",
            )
            self.summary.setPlainText(display)
            QApplication.clipboard().setText(display)
            return
        text = format_acceptance_check_report(report)
        display = _with_saved_report_note(self.project_root, f"story-acceptance-check-{unit.record.composition_id}", text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)

    def start_acceptance_run(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        try:
            sheet = start_story_acceptance_run(self.project_root, unit)
        except Exception as exc:  # noqa: BLE001
            display = _with_saved_report_note(
                self.project_root,
                f"story-acceptance-start-failed-{unit.record.composition_id}",
                f"开始验收运行失败:\n{exc}",
            )
            self.summary.setPlainText(display)
            QApplication.clipboard().setText(display)
            return
        display = _with_saved_report_note(self.project_root, f"story-acceptance-start-{unit.record.composition_id}", sheet.text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)

    def compare_acceptance_runtime(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        try:
            report = compare_story_unit_acceptance_to_runtime_snapshot(self.project_root, unit)
        except Exception as exc:  # noqa: BLE001
            display = _with_saved_report_note(
                self.project_root,
                f"story-acceptance-runtime-failed-{unit.record.composition_id}",
                f"运行时验收对比失败:\n{exc}",
            )
            self.summary.setPlainText(display)
            QApplication.clipboard().setText(display)
            return
        text = format_acceptance_runtime_compare_report(report)
        display = _with_saved_report_note(self.project_root, f"story-acceptance-runtime-{unit.record.composition_id}", text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)

    def finish_acceptance_run(self) -> None:
        unit = self._current_unit()
        if unit is None:
            return
        self._save_current_fields()
        try:
            finish = finish_story_acceptance_run(self.project_root, unit)
        except Exception as exc:  # noqa: BLE001
            display = _with_saved_report_note(
                self.project_root,
                f"story-acceptance-finish-failed-{unit.record.composition_id}",
                f"完成验收运行失败:\n{exc}",
            )
            self.summary.setPlainText(display)
            QApplication.clipboard().setText(display)
            return
        unit.record.acceptance_script.last_run_status = finish.status
        unit.record.acceptance_script.last_run_note = finish.note
        self.edit_script_status.setText(finish.status)
        self.edit_script_note.setPlainText(finish.note)
        try:
            save_story_unit_workspace(self.workspace) if self.workspace is not None else None
        except Exception as exc:  # noqa: BLE001
            display = _with_saved_report_note(
                self.project_root,
                f"story-acceptance-finish-save-failed-{unit.record.composition_id}",
                f"{finish.text}\n\n保存最近验收结果失败:\n{exc}",
            )
            self.summary.setPlainText(display)
            QApplication.clipboard().setText(display)
            return
        self._populate_table(keep_current=True)
        display = _with_saved_report_note(self.project_root, f"story-acceptance-finish-{unit.record.composition_id}", finish.text)
        self.summary.setPlainText(display)
        QApplication.clipboard().setText(display)

    def _populate_table(self, *, keep_current: bool = False) -> None:
        if self.workspace is None:
            return
        selected_id = self.current_id if keep_current else ""
        self.table.setRowCount(0)
        for row, unit in enumerate(self.workspace.units):
            rec = unit.record
            issues = story_unit_completeness_issues(unit)
            self.table.insertRow(row)
            values = [
                rec.composition_id,
                rec.display_name or unit.summary.label,
                rec.unit_type,
                rec.production_status,
                ", ".join(issues) if issues else "无",
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.table.setItem(row, col, item)
            if selected_id and rec.composition_id == selected_id:
                self.table.selectRow(row)
        self.table.resizeColumnsToContents()

    def _on_selection_changed(self) -> None:
        if self.loading_fields:
            return
        self._save_current_fields()
        unit = self._selected_unit()
        if unit is not None:
            self._load_unit(unit)
        else:
            self._clear_fields()
        self._refresh_story_action_buttons()

    def _selected_unit(self) -> StoryUnit | None:
        if self.workspace is None:
            return None
        indexes = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
        if not indexes:
            return None
        row = indexes[0].row()
        if row < 0 or row >= len(self.workspace.units):
            return None
        return self.workspace.units[row]

    def _current_unit(self) -> StoryUnit | None:
        if self.workspace is None or not self.current_id:
            return self._selected_unit()
        for unit in self.workspace.units:
            if unit.record.composition_id == self.current_id:
                return unit
        return None

    def _load_unit(self, unit: StoryUnit) -> None:
        rec = unit.record
        self.loading_fields = True
        try:
            self.current_id = rec.composition_id
            self.edit_id.setText(rec.composition_id)
            self.edit_name.setText(rec.display_name)
            self.edit_type.setText(rec.unit_type)
            self.edit_status.setText(rec.production_status)
            self.edit_estimate.setText("" if rec.manual_estimate_hours is None else str(rec.manual_estimate_hours))
            self.edit_entry.setPlainText(rec.entry)
            self.edit_exit.setPlainText(rec.exit)
            self.edit_acceptance.setPlainText(rec.acceptance)
            script = rec.acceptance_script
            self.edit_script_entry.setPlainText(script.start_entry)
            self.edit_script_flags.setPlainText("\n".join(script.setup_flags))
            self.edit_script_quests.setPlainText("\n".join(script.setup_quests))
            self.edit_script_scenarios.setPlainText("\n".join(script.setup_scenarios))
            self.edit_script_states.setPlainText("\n".join(script.setup_narrative_states))
            self.edit_script_actions.setPlainText("\n".join(script.actions))
            self.edit_script_options.setPlainText("\n".join(script.option_choices))
            self.edit_script_expected_signals.setPlainText("\n".join(script.expected_signals))
            self.edit_script_expected_states.setPlainText("\n".join(script.expected_narrative_states))
            self.edit_script_expected_quests.setPlainText("\n".join(script.expected_quest_changes))
            self.edit_script_expected_scenarios.setPlainText("\n".join(script.expected_scenario_changes))
            self.edit_script_save_load.setPlainText(script.save_load_check)
            self.edit_script_status.setText(script.last_run_status or "未跑")
            self.edit_script_note.setPlainText(script.last_run_note)
            self.edit_blockers.setPlainText("\n".join(b.text for b in rec.blockers if b.text.strip()))
            self.edit_asset_needs.setPlainText("\n".join(a.text for a in rec.asset_needs if a.text.strip()))
            self.edit_note.setPlainText(rec.owner_note)
            self._refresh_acceptance_steps_table()
            self.summary.setPlainText(self._summary_text(unit))
        finally:
            self.loading_fields = False

    def _clear_fields(self) -> None:
        self.loading_fields = True
        try:
            self.current_id = ""
            for widget in [self.edit_id, self.edit_name, self.edit_estimate]:
                widget.clear()
            self.edit_type.clear()
            self.edit_status.clear()
            self.edit_script_status.setText("未跑")
            for widget in [
                self.edit_entry,
                self.edit_exit,
                self.edit_acceptance,
                self.edit_script_entry,
                self.edit_script_flags,
                self.edit_script_quests,
                self.edit_script_scenarios,
                self.edit_script_states,
                self.edit_script_actions,
                self.edit_script_options,
                self.edit_script_expected_signals,
                self.edit_script_expected_states,
                self.edit_script_expected_quests,
                self.edit_script_expected_scenarios,
                self.edit_script_save_load,
                self.edit_script_note,
                self.edit_blockers,
                self.edit_asset_needs,
                self.edit_note,
                self.summary,
            ]:
                widget.clear()
            self._refresh_acceptance_steps_table()
        finally:
            self.loading_fields = False

    def _save_current_fields(self) -> None:
        if self.loading_fields or self.workspace is None or not self.current_id:
            return
        unit = self._current_unit()
        if unit is None:
            return
        rec = unit.record
        rec.display_name = self.edit_name.text().strip()
        rec.unit_type = self.edit_type.text().strip()
        rec.production_status = self.edit_status.text().strip() or "未做"
        rec.entry = self.edit_entry.toPlainText().strip()
        rec.exit = self.edit_exit.toPlainText().strip()
        rec.acceptance = self.edit_acceptance.toPlainText().strip()
        rec.owner_note = self.edit_note.toPlainText().strip()
        script = rec.acceptance_script
        script.start_entry = self.edit_script_entry.toPlainText().strip()
        script.setup_flags = _text_lines(self.edit_script_flags)
        script.setup_quests = _text_lines(self.edit_script_quests)
        script.setup_scenarios = _text_lines(self.edit_script_scenarios)
        script.setup_narrative_states = _text_lines(self.edit_script_states)
        script.actions = _text_lines(self.edit_script_actions)
        script.option_choices = _text_lines(self.edit_script_options)
        script.expected_signals = _text_lines(self.edit_script_expected_signals)
        script.expected_narrative_states = _text_lines(self.edit_script_expected_states)
        script.expected_quest_changes = _text_lines(self.edit_script_expected_quests)
        script.expected_scenario_changes = _text_lines(self.edit_script_expected_scenarios)
        script.save_load_check = self.edit_script_save_load.toPlainText().strip()
        script.last_run_status = self.edit_script_status.text().strip()
        script.last_run_note = self.edit_script_note.toPlainText().strip()
        rec.blockers = [
            Blocker(text=line.strip())
            for line in self.edit_blockers.toPlainText().splitlines()
            if line.strip()
        ]
        rec.asset_needs = [
            AssetNeed(text=line.strip())
            for line in self.edit_asset_needs.toPlainText().splitlines()
            if line.strip()
        ]
        try:
            raw = self.edit_estimate.text().strip()
            rec.manual_estimate_hours = float(raw) if raw else None
        except ValueError:
            rec.manual_estimate_hours = None
        from .story_units import _now_iso  # local helper, intentionally not exported as API

        rec.updated_at = _now_iso()
        self.summary.setPlainText(self._summary_text(unit))

    def _summary_text(self, unit: StoryUnit) -> str:
        s = unit.summary
        parts = [
            f"主图: {s.main_graph_id or '(无)'}",
            f"Graph: {', '.join(s.graph_ids) or '(无)'}",
            f"Dialogue: {', '.join(s.dialogues) or '(无)'}",
            f"Quest: {', '.join(s.quests) or '(无)'}",
            f"Scenario: {', '.join(s.scenarios) or '(无)'}",
            f"Zone: {', '.join(s.zones) or '(无)'}",
            f"Minigame: {', '.join(s.minigames) or '(无)'}",
            f"Signal: {', '.join(s.signals) or '(无)'}",
            "",
            "完整性:",
            ", ".join(story_unit_completeness_issues(unit)) or "无问题",
            "验收脚本:",
            ", ".join(acceptance_script_issues(unit)) or "无问题",
        ]
        if s.projection_warnings:
            parts.extend(["", "Projection warning:", *[f"- {x}" for x in s.projection_warnings]])
        if s.validation_issues:
            parts.extend(["", "Validation issue:", *[f"- {x}" for x in s.validation_issues]])
        return "\n".join(parts)


class DailyCheckThread(QThread):
    progress = Signal(str)
    completed = Signal(object)
    failed = Signal(str)

    def __init__(self, project_root: Path, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.project_root = project_root

    def run(self) -> None:
        try:
            report = run_daily_check(
                self.project_root,
                progress=self.progress.emit,
                run_toolchain_checks=True,
            )
        except Exception as exc:  # noqa: BLE001 - keep the GUI responsive and reportable.
            self.failed.emit(str(exc))
            return
        self.completed.emit(report)


class DailyCheckTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self._daily_thread: DailyCheckThread | None = None
        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_run = QPushButton("运行每日检查")
        self.btn_copy = QPushButton("复制报告")
        self.btn_run.clicked.connect(self.run_check)
        self.btn_copy.clicked.connect(self.copy_report)
        top.addWidget(self.btn_run)
        top.addWidget(self.btn_copy)
        top.addStretch(1)
        layout.addWidget(_scrollable_toolbar(top))
        self.output_dock = host.console_dock("daily-check", "Daily Check Output")
        self.output = _inline_console_from_dock(self.output_dock)
        layout.addWidget(self.output, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.output.clear()

    def run_check(self) -> None:
        if self._daily_thread is not None and self._daily_thread.isRunning():
            QMessageBox.information(self, "每日检查", "每日检查正在运行，请稍等。")
            return
        self.output.clear()
        self.btn_run.setEnabled(False)
        self.btn_run.setText("检查运行中...")
        self.output.append("开始每日检查...")

        thread = DailyCheckThread(self.project_root, self)
        self._daily_thread = thread
        thread.progress.connect(self._on_daily_progress)
        thread.completed.connect(self._on_daily_completed)
        thread.failed.connect(self._on_daily_failed)
        thread.finished.connect(self._on_daily_finished)
        thread.start()

    def _on_daily_progress(self, message: str) -> None:
        self.output.append(message)

    def _on_daily_completed(self, report: DailyCheckReport) -> None:
        text = format_daily_check_report(report)
        self.output.append("\n" + _with_saved_report_note(report.project_root, "daily-check", text))

    def _on_daily_failed(self, message: str) -> None:
        text = f"每日检查执行失败:\n{message}"
        self.output.append("\n" + _with_saved_report_note(self.project_root, "daily-check-failed", text))

    def _on_daily_finished(self) -> None:
        if self._daily_thread is not None:
            self._daily_thread.deleteLater()
            self._daily_thread = None
        self.btn_run.setEnabled(True)
        self.btn_run.setText("运行每日检查")

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())


@dataclass(frozen=True)
class AssetAuditJobResult:
    project_root: Path
    operation: str
    save_report: bool
    payload: object | None = None
    message: str = ""


class AssetAuditThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(
        self,
        project_root: Path,
        operation: str,
        *,
        save_report: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.operation = operation
        self.save_report = save_report

    def run(self) -> None:
        try:
            if self.operation == "audit":
                payload = audit_asset_specs(self.project_root)
            elif self.operation == "style":
                payload = build_asset_style_reference(self.project_root)
            else:
                raise ValueError(f"unknown asset audit operation: {self.operation}")
        except Exception as exc:  # noqa: BLE001 - keep workbench responsive and reportable.
            self.failed.emit(
                AssetAuditJobResult(
                    project_root=self.project_root,
                    operation=self.operation,
                    save_report=self.save_report,
                    message=str(exc),
                )
            )
            return
        self.completed.emit(
            AssetAuditJobResult(
                project_root=self.project_root,
                operation=self.operation,
                save_report=self.save_report,
                payload=payload,
            )
        )


@dataclass(frozen=True)
class GraphDiagnosticsJobResult:
    project_root: Path
    save_report: bool = False
    report: GraphDiagnosticsReport | None = None
    message: str = ""


class GraphDiagnosticsThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(self, project_root: Path, *, save_report: bool = False, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.save_report = save_report

    def run(self) -> None:
        try:
            report = build_graph_diagnostics(self.project_root)
        except Exception as exc:  # noqa: BLE001 - report diagnostics failures in the tab.
            self.failed.emit(
                GraphDiagnosticsJobResult(
                    project_root=self.project_root,
                    save_report=self.save_report,
                    message=str(exc),
                )
            )
            return
        self.completed.emit(
            GraphDiagnosticsJobResult(
                project_root=self.project_root,
                save_report=self.save_report,
                report=report,
            )
        )


class GraphDiagnosticsTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self.report: GraphDiagnosticsReport | None = None
        self._graph_thread: GraphDiagnosticsThread | None = None
        self._ignore_composition_selection = False
        self.output_dock = host.console_dock("graph-diagnostics", "Graph Diagnostics Output")
        self.output = _inline_console_from_dock(self.output_dock)

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_refresh = QPushButton("Refresh Graph Diagnostics")
        self.btn_copy = QPushButton("Copy Report")
        self.btn_open_sources = QPushButton("Open Sources")
        self.edit_composition = _readonly_picker_line("All")
        self.edit_composition.setMinimumWidth(280)
        self.btn_pick_composition = QPushButton("Choose Scope")
        self.btn_all_compositions = QPushButton("All")
        self.btn_refresh.clicked.connect(self.refresh)
        self.btn_copy.clicked.connect(self.copy_report)
        self.btn_open_sources.clicked.connect(self.open_sources)
        self.btn_pick_composition.clicked.connect(self.choose_composition)
        self.btn_all_compositions.clicked.connect(self.clear_composition_filter)
        top.addWidget(self.btn_refresh)
        top.addWidget(QLabel("Composition"))
        top.addWidget(self.edit_composition, 1)
        top.addWidget(self.btn_pick_composition)
        top.addWidget(self.btn_all_compositions)
        top.addWidget(self.btn_open_sources)
        top.addWidget(self.btn_copy)

        self.overview_table = self._diagnostic_table(["Metric", "Value"])
        self.comp_table = self._diagnostic_table(["Composition", "Label", "Status", "Issues", "Signal", "Read", "StateWrite", "ActionRW"])
        self.comp_table.itemSelectionChanged.connect(self._on_comp_row_selected)
        self.flow_table = self._diagnostic_table(["Composition", "Type", "Source", "Target", "Label", "Detail"])
        self.flagrw_table = self._diagnostic_table(["Composition", "Type", "Source", "Target", "Detail"])
        self.route_table = self._diagnostic_table(["Composition", "Type", "Content"])
        self.warning_table = self._diagnostic_table(["Composition", "Type", "Content"])
        self.runtime_table = self._diagnostic_table(["Seq", "Type", "Graph", "Transition", "Summary"])

        self.graph_tabs = QTabWidget()
        self.graph_tabs.addTab(self._table_page("Graph Overview", self.overview_table), "Overview")
        self.graph_tabs.addTab(self._table_page("Composition List", self.comp_table), "Compositions")
        self.graph_tabs.addTab(self._table_page("Signal Flow / State Read", self.flow_table), "Flow")
        self.graph_tabs.addTab(self._table_page("Flag / Action / State Writes", self.flagrw_table), "ReadWrite")
        self.graph_tabs.addTab(self._table_page("Routes and Dependencies", self.route_table), "Routes")
        self.graph_tabs.addTab(self._table_page("Warnings and Validation", self.warning_table), "Warnings")
        self.graph_tabs.addTab(self._table_page("Runtime Trace", self.runtime_table), "Runtime")

        body = QSplitter(Qt.Orientation.Vertical)
        body.addWidget(self.graph_tabs)
        body.addWidget(self.output)
        body.setSizes([500, 180])
        body.setCollapsible(0, False)
        body.setCollapsible(1, False)
        layout.addWidget(_scrollable_toolbar(top))
        layout.addWidget(body, 1)
        self.output.setPlaceholderText("Structured diagnostics are shown above; the raw report stays here for copy/export.")

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.report = None
        _set_picker_line_value(self.edit_composition, [_raw_picker_item("", "All")], "")
        self._clear_tables()
        self.output.setPlainText("点击“刷新 Graph 诊断”读取 signal flow、flag read/write、quest dependency、routes 和 runtime trace。")

    def refresh(self) -> None:
        self.reload(save_report=True)

    def reload(self, *, save_report: bool = False) -> None:
        if self._graph_thread is not None and self._graph_thread.isRunning():
            QMessageBox.information(self, "Graph Diagnostics", "Graph diagnostics are already refreshing.")
            return
        self.btn_refresh.setEnabled(False)
        self.output.setPlainText("Refreshing Graph Diagnostics...")
        self._clear_tables()
        thread = GraphDiagnosticsThread(self.project_root, save_report=save_report, parent=self)
        self._graph_thread = thread
        thread.completed.connect(self._on_graph_diagnostics_completed)
        thread.failed.connect(self._on_graph_diagnostics_failed)
        thread.finished.connect(self._on_graph_diagnostics_finished)
        thread.start()

    def _on_graph_diagnostics_completed(self, result: GraphDiagnosticsJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.report = result.report
        if self.report is None:
            return
        current = _picker_line_value(self.edit_composition, "")
        items = _graph_composition_items(self.report)
        values = {item.get("value") for item in items}
        if current not in values:
            _set_picker_line_value(self.edit_composition, items, "")
        self._render(save_report=result.save_report)

    def _on_graph_diagnostics_failed(self, result: GraphDiagnosticsJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.report = None
        self._clear_tables()
        text = f"Graph diagnostics failed:\n{result.message}"
        if result.save_report:
            text = _with_saved_report_note(self.project_root, "graph-diagnostics-failed", text)
        self.output.setPlainText(text)

    def _on_graph_diagnostics_finished(self) -> None:
        if self._graph_thread is not None:
            self._graph_thread.deleteLater()
            self._graph_thread = None
        self.btn_refresh.setEnabled(True)

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

    def choose_composition(self) -> None:
        if self.report is None:
            return
        if _pick_line_value(self, "Choose Graph Diagnostics Scope", self.edit_composition, _graph_composition_items(self.report)):
            self._render()

    def clear_composition_filter(self) -> None:
        if self.report is None:
            return
        _set_picker_line_value(self.edit_composition, _graph_composition_items(self.report), "")
        self._render()

    def open_sources(self) -> None:
        if self.report is None:
            return
        composition_id = _picker_line_value(self.edit_composition, "")
        composition_id = composition_id.strip() if isinstance(composition_id, str) else ""
        if not composition_id:
            picked = self._pick_composition_for_sources()
            if not picked:
                return
            composition_id = picked
        try:
            workspace = load_story_unit_workspace(self.project_root)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "Open Sources", f"Failed to load story units:\n{exc}")
            return
        unit = workspace.by_id().get(composition_id)
        if unit is None:
            QMessageBox.warning(self, "Open Sources", f"Story unit not found: {composition_id}")
            return
        item = _pick_source_item(self, self.project_root, unit)
        if item and isinstance(item.get("path"), Path):
            _open_local_path(self, item["path"], "Open Source")

    def _pick_composition_for_sources(self) -> str:
        if self.report is None:
            return ""
        item = _pick_item_dialog(self, "Choose Graph Scope for Source Opening", _graph_composition_items(self.report, include_all=False))
        return str(item.get("value") or "") if item else ""

    def _render(self, *, save_report: bool = False) -> None:
        if self.report is None:
            return
        cid = _picker_line_value(self.edit_composition, "")
        cid = cid.strip() if isinstance(cid, str) else ""
        text = format_graph_diagnostics_report(self.report, composition_id=cid or None)
        if save_report:
            category = f"graph-diagnostics-{cid}" if cid else "graph-diagnostics-all"
            text = _with_saved_report_note(self.project_root, category, text)
        self.output.setPlainText(text)
        self._update_graph_tables(composition_id=cid or None)

    def _on_comp_row_selected(self) -> None:
        if self._ignore_composition_selection or self.report is None:
            return
        selection = self.comp_table.selectionModel().selectedRows() if self.comp_table.selectionModel() else []
        if not selection:
            return
        item = self.comp_table.item(selection[0].row(), 0)
        cid = item.text().strip() if item is not None else ""
        if not cid:
            return
        _set_picker_line_value(self.edit_composition, _graph_composition_items(self.report), cid)
        self._render()

    def _update_graph_tables(self, *, composition_id: str | None) -> None:
        if self.report is None:
            return
        selected = [comp for comp in self.report.compositions if not composition_id or comp.composition_id == composition_id]
        if not selected:
            selected = list(self.report.compositions)
            composition_id = None
        self._set_table_rows(self.overview_table, self._overview_rows(selected, composition_id))
        self._set_table_rows(self.comp_table, self._composition_rows(selected))
        self._sync_composition_selection(composition_id)
        self._set_table_rows(self.flow_table, self._flow_rows(selected))
        self._set_table_rows(self.flagrw_table, self._read_write_rows(selected))
        self._set_table_rows(self.route_table, self._route_rows(selected))
        self._set_table_rows(self.warning_table, self._warning_rows(selected))
        self._set_table_rows(self.runtime_table, self._runtime_rows())

    def _overview_rows(self, selected: list[Any], composition_id: str | None) -> list[list[Any]]:
        if self.report is None:
            return []
        rows = [["Composition count", len(self.report.compositions)], ["Filtered", composition_id or "ALL"], ["Visible compositions", len(selected)], ["Signal flow", self.report.trigger_count], ["State read", self.report.read_count], ["State direct write", self.report.state_command_count], ["Action read/write", self.report.action_read_write_count], ["Global warnings", len(self.report.global_warnings)]]
        snapshot = self.report.runtime_snapshot
        if snapshot is None:
            rows.append(["Runtime snapshot", "none"])
        else:
            rows.append(["Runtime snapshot", "ok" if snapshot.ok else "failed"])
            rows.append(["Trace events", len(snapshot.trace or [])])
            rows.append(["Runtime command results", len(snapshot.runtime_command_results or [])])
        return rows

    def _composition_rows(self, comps: list[Any]) -> list[list[Any]]:
        return [[comp.composition_id, comp.label, comp.production_status, comp.issue_count, len(comp.trigger_edges), len(comp.read_edges), len(comp.state_command_edges), len(comp.action_read_write_edges)] for comp in comps] or [["", "No compositions", "", "", "", "", "", ""]]

    def _flow_rows(self, comps: list[Any]) -> list[list[Any]]:
        rows = []
        for comp in comps:
            for edge in comp.trigger_edges:
                rows.append(self._edge_row(comp.composition_id, "signal flow", edge))
            for edge in comp.read_edges:
                rows.append(self._edge_row(comp.composition_id, "state read", edge))
        return rows or [["", "none", "", "", "", "No signal/state edges"]]

    def _read_write_rows(self, comps: list[Any]) -> list[list[Any]]:
        rows = []
        for comp in comps:
            for edge in comp.state_command_edges:
                rows.append([comp.composition_id, "state direct write", edge.get("source", ""), edge.get("target", ""), edge.get("detail", "") or edge.get("label", "")])
            for edge in comp.action_read_write_edges:
                rows.append([comp.composition_id, edge.get("kind", "ref"), edge.get("source", ""), edge.get("target", ""), edge.get("detail", "")])
        return rows or [["", "none", "", "", "No read/write edges"]]

    def _route_rows(self, comps: list[Any]) -> list[list[Any]]:
        rows = []
        for comp in comps:
            for quest in comp.quests:
                rows.append([comp.composition_id, "quest", quest])
            for dialogue in comp.dialogues:
                rows.append([comp.composition_id, "dialogue", dialogue])
            for scenario in comp.scenarios:
                rows.append([comp.composition_id, "scenario", scenario])
            for signal in comp.signals:
                rows.append([comp.composition_id, "signal", signal])
            for route in comp.dialogue_routes:
                rows.append([comp.composition_id, "dialogue route", route])
        return rows or [["", "none", "No route/dependency data"]]

    def _warning_rows(self, comps: list[Any]) -> list[list[Any]]:
        rows = []
        for comp in comps:
            for warning in comp.owner_boundary_warnings:
                rows.append([comp.composition_id, "owner boundary", warning])
            for warning in comp.projection_warnings:
                rows.append([comp.composition_id, "projection", warning])
            for issue in comp.validation_issues:
                rows.append([comp.composition_id, "validation", issue])
        if self.report is not None:
            for warning in self.report.global_warnings:
                rows.append(["<global>", "global", warning])
        return rows or [["", "none", "No warnings"]]

    def _runtime_rows(self) -> list[list[Any]]:
        if self.report is None or self.report.runtime_snapshot is None:
            return [["", "", "", "", "No runtime snapshot"]]
        trace = self.report.runtime_snapshot.trace or []
        rows = [[event.get("seq", ""), event.get("type", ""), event.get("graphId", ""), event.get("transitionId", ""), event.get("message") or event.get("triggerKey") or ""] for event in trace[-80:]]
        return rows or [["", "", "", "", "No runtime trace"]]

    def _edge_row(self, composition_id: str, kind: str, edge: dict[str, Any]) -> list[Any]:
        return [composition_id, kind, edge.get("source", ""), edge.get("target", ""), edge.get("label", ""), edge.get("detail", "")]

    def _table_page(self, label: str, table: QTableWidget) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.addWidget(QLabel(label))
        page_layout.addWidget(table, 1)
        return page

    def _diagnostic_table(self, headers: list[str]) -> QTableWidget:
        table = QTableWidget(0, len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        return table

    def _set_table_rows(self, table: QTableWidget, rows: list[list[Any]]) -> None:
        table.setRowCount(len(rows))
        for row_index, row in enumerate(rows):
            for column_index in range(table.columnCount()):
                value = row[column_index] if column_index < len(row) else ""
                item = QTableWidgetItem(self._diag_value_text(value))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(row_index, column_index, item)
        table.resizeColumnsToContents()

    def _diag_value_text(self, value: Any) -> str:
        if isinstance(value, str):
            text = value
        elif value is None:
            text = ""
        else:
            try:
                text = json.dumps(value, ensure_ascii=False, sort_keys=True)
            except TypeError:
                text = str(value)
        return text if len(text) <= 512 else text[:509] + "..."

    def _sync_composition_selection(self, composition_id: str | None) -> None:
        self._ignore_composition_selection = True
        try:
            self.comp_table.clearSelection()
            if composition_id:
                for row in range(self.comp_table.rowCount()):
                    item = self.comp_table.item(row, 0)
                    if item is not None and item.text() == composition_id:
                        self.comp_table.selectRow(row)
                        break
        finally:
            self._ignore_composition_selection = False

    def _clear_tables(self) -> None:
        for table in [self.overview_table, self.comp_table, self.flow_table, self.flagrw_table, self.route_table, self.warning_table, self.runtime_table]:
            table.setRowCount(0)
_RUNTIME_COMMAND_PAYLOAD_EXAMPLES: dict[str, dict[str, Any]] = {
    "captureSnapshot": {},
    "clearNarrativeTrace": {},
    "emitNarrativeSignal": {"sourceType": "debug", "sourceId": "workbench", "signal": "signal_id"},
    "debugSetNarrativeState": {"graphId": "graph_id", "stateId": "state_id"},
    "setFlag": {"key": "flag_id", "value": True},
    "debugSetQuestStatus": {"questId": "quest_id", "status": 2},
    "debugSetScenarioPhase": {"scenarioId": "scenario_id", "phase": "phase_id", "status": "completed"},
    "debugSetScenarioLineLifecycle": {"scenarioId": "scenario_id", "state": "active"},
    "debugResetScenarioProgress": {"scenarioId": "scenario_id"},
    "debugStartDialogueGraph": {"graphId": "graph_id", "entry": "entry_id", "npcName": "NPC"},
    "debugAdvanceDialogue": {"maxSteps": 24},
    "debugChooseDialogueOption": {"index": 0},
    "debugSwitchScene": {"sceneId": "scene_id", "spawnPoint": "spawn_id"},
    "debugTriggerHotspot": {"hotspotId": "hotspot_id"},
    "debugInteractNpc": {"npcId": "npc_id"},
    "debugWait": {"durationMs": 500},
    "debugSetPlayerPosition": {"x": 320, "y": 240, "snapCamera": True},
    "debugMovePlayerTo": {"x": 320, "y": 240, "speed": 180, "snapCamera": True},
    "debugClick": {"x": 320, "y": 240},
    "debugDrag": {"fromX": 240, "fromY": 240, "toX": 420, "toY": 240, "durationMs": 350},
    "debugSaveGame": {"slot": 2},
    "debugLoadGame": {"slot": 2},
    "debugReloadScene": {},
}


def _runtime_command_payload_example(command_type: str) -> str:
    payload = _RUNTIME_COMMAND_PAYLOAD_EXAMPLES.get(command_type, {})
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _runtime_command_items() -> list[dict[str, Any]]:
    return [
        {
            "value": command_type,
            "label": command_type,
            "detail": _runtime_command_payload_example(command_type),
            "keywords": command_type,
        }
        for command_type in sorted(ALLOWED_RUNTIME_COMMANDS)
    ]


class RuntimeDebugTab(QWidget):
    _MIN_OUTPUT_HEIGHT = 180
    _MIN_VISUAL_HEIGHT = 260

    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self._picker_model: ProjectModel | None = None
        self.output_dock = host.console_dock("runtime-debug", "Runtime Debug Output")
        self.output = _inline_console_from_dock(self.output_dock, minimum_height=self._MIN_OUTPUT_HEIGHT)

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_refresh = QPushButton("Refresh Snapshot")
        self.btn_capture = QPushButton("Request Snapshot")
        self.btn_clear_trace = QPushButton("Clear Trace")
        self.btn_copy = QPushButton("Copy Report")
        self.btn_clear = QPushButton("Clear Snapshot")
        self.btn_queue = QPushButton("Show Queue")
        self.btn_clear_queue = QPushButton("Clear Queue")
        self.btn_refresh.clicked.connect(self.refresh)
        self.btn_capture.clicked.connect(self.request_snapshot)
        self.btn_clear_trace.clicked.connect(self.request_clear_trace)
        self.btn_copy.clicked.connect(self.copy_report)
        self.btn_clear.clicked.connect(self.clear_snapshot)
        self.btn_queue.clicked.connect(self.show_command_queue)
        self.btn_clear_queue.clicked.connect(self.clear_command_queue)
        for button in [self.btn_refresh, self.btn_capture, self.btn_clear_trace, self.btn_copy, self.btn_clear, self.btn_queue, self.btn_clear_queue]:
            top.addWidget(button)
        top.addStretch(1)
        layout.addWidget(_scrollable_toolbar(top))

        self.hint = QLabel("Run the game page, then inspect snapshots, trace, state, and queued runtime commands here.")
        self.hint.setWordWrap(False)
        self.hint.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.hint.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        self.hint.setMaximumHeight(self.hint.sizeHint().height() + 6)
        layout.addWidget(self.hint)

        self.command_box = QGroupBox("Send Runtime Command")
        command_layout = QVBoxLayout(self.command_box)
        command_row = QHBoxLayout()
        self.edit_command_type = _readonly_picker_line("Choose command")
        self.btn_pick_command_type = QPushButton("Choose")
        self.edit_command_reason = QLineEdit("workbench:manual-command")
        self.command_param_widgets: dict[str, QWidget] = {}
        self.command_param_defaults: dict[str, Any] = {}
        self.btn_reset_command_payload = QPushButton("Reset Params")
        self.btn_enqueue_command = QPushButton("Send")
        self.btn_pick_command_type.clicked.connect(self.pick_command_type)
        self.btn_reset_command_payload.clicked.connect(self.reset_command_payload)
        self.btn_enqueue_command.clicked.connect(self.enqueue_selected_command)
        command_row.addWidget(self.edit_command_type, 2)
        command_row.addWidget(self.btn_pick_command_type)
        command_row.addWidget(self.edit_command_reason, 2)
        command_row.addWidget(self.btn_reset_command_payload)
        command_row.addWidget(self.btn_enqueue_command)
        command_layout.addLayout(command_row)
        self.command_param_box = QWidget()
        self.command_param_form = QFormLayout(self.command_param_box)
        self.command_param_form.setContentsMargins(0, 0, 0, 0)
        command_layout.addWidget(self.command_param_box)
        self.set_command_type("captureSnapshot")

        self.visual_tabs = QTabWidget()
        self.visual_tabs.setMinimumHeight(self._MIN_VISUAL_HEIGHT)
        self.overview_table = self._runtime_table(["Field", "Value"])
        self.active_state_table = self._runtime_table(["Graph", "State"])
        self.flag_table = self._runtime_table(["Flag", "Value"])
        self.quest_table = self._runtime_table(["Quest", "Value"])
        self.scenario_table = self._runtime_table(["Scenario", "Value"])
        self.trace_table = self._runtime_table(["Seq", "Type", "Graph", "Summary", "Raw"])
        self.transition_table = self._runtime_table(["Graph", "Transition", "From -> To", "Trigger", "Raw"])
        self.issue_table = self._runtime_table(["Severity", "Code", "Message", "Raw"])
        self.pending_command_table = self._runtime_table(["#", "Type", "Reason", "Payload"])
        self.command_result_table = self._runtime_table(["Status", "Type", "ID", "Message"])

        state_tabs = QTabWidget()
        state_tabs.addTab(self.active_state_table, "Narrative")
        state_tabs.addTab(self.flag_table, "Flags")
        state_tabs.addTab(self.quest_table, "Quests")
        state_tabs.addTab(self.scenario_table, "Scenarios")
        trace_tabs = QTabWidget()
        trace_tabs.addTab(self.trace_table, "Trace")
        trace_tabs.addTab(self.transition_table, "Transitions")
        trace_tabs.addTab(self.issue_table, "Issues")

        self.command_page = QWidget()
        command_page_layout = QVBoxLayout(self.command_page)
        self.command_splitter = QSplitter(Qt.Orientation.Vertical)
        self.command_splitter.addWidget(self.command_box)
        command_tables = QWidget()
        command_tables_layout = QVBoxLayout(command_tables)
        command_tables_layout.addWidget(QLabel("Pending Commands"))
        command_tables_layout.addWidget(self.pending_command_table, 1)
        command_tables_layout.addWidget(QLabel("Recent Results"))
        command_tables_layout.addWidget(self.command_result_table, 1)
        self.command_splitter.addWidget(command_tables)
        self.command_splitter.setSizes([160, 300])
        command_page_layout.addWidget(self.command_splitter, 1)

        self.narrative_eval = QTextEdit()
        self.narrative_eval.setReadOnly(True)
        self.narrative_eval.setMaximumHeight(96)
        overview_page = QWidget()
        overview_layout = QVBoxLayout(overview_page)
        overview_layout.addWidget(QLabel("Snapshot Overview"))
        overview_layout.addWidget(self.overview_table, 1)
        overview_layout.addWidget(QLabel("Dialogue / condition summary"))
        overview_layout.addWidget(self.narrative_eval)
        self.visual_tabs.addTab(overview_page, "Overview")
        self.visual_tabs.addTab(self._widget_page(state_tabs), "State")
        self.visual_tabs.addTab(self._widget_page(trace_tabs), "Trace")
        self.visual_tabs.addTab(self.command_page, "Commands")

        body = QSplitter(Qt.Orientation.Vertical)
        body.addWidget(self.visual_tabs)
        body.addWidget(self.output)
        body.setSizes([520, 180])
        body.setCollapsible(0, False)
        body.setCollapsible(1, False)
        layout.addWidget(body, 1)
        self.output.setPlaceholderText("Structured runtime snapshot data is shown above; raw report stays here for copy/export.")

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self._picker_model = None
        self.reload()

    def ensure_output_space(self) -> None:
        self.output.setMinimumHeight(self._MIN_OUTPUT_HEIGHT)
        self.visual_tabs.setMinimumHeight(self._MIN_VISUAL_HEIGHT)

    def refresh(self) -> None:
        self.reload(save_report=True)

    def reload(self, *, save_report: bool = False) -> None:
        snapshot = load_runtime_debug_snapshot(self.project_root)
        queue = load_runtime_command_queue(self.project_root)
        text = format_runtime_debug_report(snapshot)
        if save_report:
            text = _with_saved_report_note(self.project_root, "runtime-debug-snapshot", text)
        self.output.setPlainText(text)
        self.render_snapshot(snapshot)
        self.render_command_queue(queue)

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

    def clear_snapshot(self) -> None:
        removed = clear_runtime_debug_snapshot(self.project_root)
        text = "Runtime snapshot cleared." if removed else "No runtime snapshot to clear."
        self.output.setPlainText(_with_saved_report_note(self.project_root, "runtime-debug-clear-snapshot", text))
        self._clear_snapshot_tables()

    def request_snapshot(self) -> None:
        report = enqueue_runtime_command(self.project_root, "captureSnapshot", reason="workbench:manual-capture")
        self.output.setPlainText(_with_saved_report_note(self.project_root, "runtime-debug-capture-request", "Snapshot request queued.\n\n" + format_runtime_command_queue_report(report)))
        self.render_command_queue(report)

    def request_clear_trace(self) -> None:
        report = enqueue_runtime_command(self.project_root, "clearNarrativeTrace", reason="workbench:manual-clear-trace")
        self.output.setPlainText(_with_saved_report_note(self.project_root, "runtime-debug-clear-trace-request", "Clear trace request queued.\n\n" + format_runtime_command_queue_report(report)))
        self.render_command_queue(report)

    def show_command_queue(self) -> None:
        report = load_runtime_command_queue(self.project_root)
        text = format_runtime_command_queue_report(report)
        self.output.setPlainText(_with_saved_report_note(self.project_root, "runtime-command-queue", text))
        self.render_command_queue(report)

    def clear_command_queue(self) -> None:
        removed = clear_runtime_command_queue(self.project_root)
        text = "Runtime command queue cleared." if removed else "No runtime command queue to clear."
        self.output.setPlainText(_with_saved_report_note(self.project_root, "runtime-command-queue-clear", text))
        self._set_table_rows(self.pending_command_table, [])

    def set_command_type(self, command_type: str) -> None:
        command_type = command_type.strip()
        if command_type not in ALLOWED_RUNTIME_COMMANDS:
            raise ValueError(f"Unsupported runtime command: {command_type}")
        self.edit_command_type.setText(command_type)
        self.edit_command_type.setProperty("pickerValue", command_type)
        self.reset_command_payload()

    def current_command_type(self) -> str:
        value = _picker_line_value(self.edit_command_type, "captureSnapshot")
        return str(value or "captureSnapshot").strip()

    def pick_command_type(self) -> None:
        if _pick_line_value(self, "Choose runtime command", self.edit_command_type, _runtime_command_items()):
            self.reset_command_payload()

    def reset_command_payload(self) -> None:
        self.rebuild_command_param_form(self.current_command_type())

    def rebuild_command_param_form(self, command_type: str) -> None:
        while self.command_param_form.count():
            item = self.command_param_form.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        self.command_param_widgets = {}
        self.command_param_defaults = dict(_RUNTIME_COMMAND_PAYLOAD_EXAMPLES.get(command_type, {}))
        if not self.command_param_defaults:
            empty = QLabel("This command does not need parameters.")
            self.command_param_form.addRow("Params", empty)
            return
        for name, default in self.command_param_defaults.items():
            widget = self._command_param_widget(name, default)
            self.command_param_widgets[name] = widget
            row = _line_with_button(widget, _small_button("Pick", lambda n=name: self.pick_command_param(n))) if name in {"sceneId", "spawnPoint"} else widget
            self.command_param_form.addRow(name, row)

    def _command_param_widget(self, name: str, default: Any) -> QWidget:
        if isinstance(default, bool):
            check = QCheckBox()
            check.setChecked(default)
            return check
        if isinstance(default, int) and not isinstance(default, bool):
            spin = QSpinBox()
            spin.setRange(-1_000_000, 1_000_000)
            spin.setValue(default)
            return spin
        line = _readonly_picker_line() if name in {"sceneId", "spawnPoint"} else QLineEdit()
        if name not in {"sceneId", "spawnPoint"}:
            line.setText(str(default))
            line.setProperty("pickerValue", str(default))
        return line

    def pick_command_param(self, name: str) -> None:
        widget = self.command_param_widgets.get(name)
        if not isinstance(widget, QLineEdit):
            return
        if name == "sceneId":
            if _pick_line_value(self, "Choose scene", widget, _scene_items(self._load_picker_model())):
                spawn = self.command_param_widgets.get("spawnPoint")
                if isinstance(spawn, QLineEdit):
                    spawn.clear()
                    spawn.setProperty("pickerValue", None)
            return
        if name == "spawnPoint":
            scene_widget = self.command_param_widgets.get("sceneId")
            scene_id = _picker_line_value(scene_widget, "") if isinstance(scene_widget, QLineEdit) else ""
            scene_id = str(scene_id or "").strip()
            if not scene_id:
                QMessageBox.warning(self, "Runtime Command", "Choose sceneId before choosing spawnPoint.")
                return
            _pick_line_value(self, f"Choose {scene_id} spawnPoint", widget, _spawn_items(self._load_picker_model(), scene_id))

    def _load_picker_model(self) -> ProjectModel:
        if self._picker_model is not None:
            return self._picker_model
        model = ProjectModel()
        model.load_project(self.project_root)
        self._picker_model = model
        return model

    def _command_payload_from_widgets(self) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        for name, widget in self.command_param_widgets.items():
            if isinstance(widget, QCheckBox):
                payload[name] = widget.isChecked()
            elif isinstance(widget, QSpinBox):
                payload[name] = widget.value()
            elif isinstance(widget, QDoubleSpinBox):
                payload[name] = widget.value()
            elif isinstance(widget, QLineEdit):
                value = _picker_line_value(widget, widget.text())
                payload[name] = value
        return payload

    def enqueue_selected_command(self) -> None:
        command_type = self.current_command_type()
        payload = self._command_payload_from_widgets()
        report = enqueue_runtime_command(
            self.project_root,
            command_type,
            payload=payload,
            reason=self.edit_command_reason.text().strip() or "workbench:manual-command",
        )
        self.output.setPlainText(_with_saved_report_note(self.project_root, f"runtime-command-{command_type}", format_runtime_command_queue_report(report)))
        self.render_command_queue(report)
    def render_snapshot(self, report: Any) -> None:
        if not report.ok:
            self._set_table_rows(self.overview_table, [["Status", "Unavailable"], ["Path", str(report.path)], ["Reason", report.message or "unknown"]])
            self.narrative_eval.clear()
            self._clear_snapshot_tables(except_overview=True)
            return
        self._set_table_rows(self.overview_table, [["Status", "Available"], ["Path", str(report.path)], ["Source", report.source], ["Captured", report.captured_at], ["Reason", report.reason], ["Scene", report.current_scene_id], ["GameState", report.game_state], ["Active states", len(report.active_states)], ["Flags", len(report.flags)], ["Quests", len(report.quest_state)], ["Scenarios", len(report.scenario_state)], ["Trace events", len(report.trace)], ["Runtime command results", len(report.runtime_command_results)]])
        self.narrative_eval.setPlainText(report.narrative_eval_summary.strip() or "")
        self._set_table_rows(self.active_state_table, [[graph, state] for graph, state in sorted(report.active_states.items())])
        self._set_table_rows(self.flag_table, [[key, value] for key, value in sorted(report.flags.items())])
        self._set_table_rows(self.quest_table, [[key, value] for key, value in sorted(report.quest_state.items())])
        self._set_table_rows(self.scenario_table, [[key, value] for key, value in sorted(report.scenario_state.items())])
        self._set_table_rows(self.trace_table, [self._trace_row(event) for event in report.trace[-80:]])
        self._set_table_rows(self.transition_table, [self._transition_row(item) for item in report.transitions[-80:]])
        self._set_table_rows(self.issue_table, [self._issue_row(issue) for issue in report.issues[-80:]])
        self._set_table_rows(self.command_result_table, [["OK" if item.get("ok") else "FAIL", item.get("type", ""), item.get("id", ""), item.get("message", "")] for item in report.runtime_command_results[-80:]])

    def render_command_queue(self, report: Any) -> None:
        if not report.ok:
            self._set_table_rows(self.pending_command_table, [["!", "Unavailable", "", report.message]])
            return
        self._set_table_rows(self.pending_command_table, [[index + 1, command.get("type", ""), command.get("reason", ""), command] for index, command in enumerate(report.commands)])

    def _runtime_table(self, headers: list[str]) -> QTableWidget:
        table = QTableWidget(0, len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        return table

    def _set_table_rows(self, table: QTableWidget, rows: list[list[Any]]) -> None:
        table.setRowCount(len(rows))
        for row_index, row in enumerate(rows):
            for column_index in range(table.columnCount()):
                value = row[column_index] if column_index < len(row) else ""
                item = QTableWidgetItem(self._runtime_value_text(value))
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                table.setItem(row_index, column_index, item)
        table.resizeColumnsToContents()

    def _runtime_value_text(self, value: Any) -> str:
        if isinstance(value, str):
            text = value
        elif value is None:
            text = ""
        else:
            try:
                text = json.dumps(value, ensure_ascii=False, sort_keys=True)
            except TypeError:
                text = str(value)
        return text if len(text) <= 600 else text[:597] + "..."

    def _clear_snapshot_tables(self, *, except_overview: bool = False) -> None:
        tables = [self.active_state_table, self.flag_table, self.quest_table, self.scenario_table, self.trace_table, self.transition_table, self.issue_table, self.command_result_table]
        if not except_overview:
            tables.insert(0, self.overview_table)
        for table in tables:
            table.setRowCount(0)
        if hasattr(self, "narrative_eval"):
            self.narrative_eval.clear()

    def _trace_row(self, event: dict[str, Any]) -> list[Any]:
        summary = event.get("message") or event.get("transitionId") or event.get("triggerKey") or ""
        if event.get("from") or event.get("to"):
            summary = f"{event.get('from', '?')} -> {event.get('to', '?')} {summary}".strip()
        return [event.get("seq", ""), event.get("type", ""), event.get("graphId", ""), summary, event]

    def _transition_row(self, item: dict[str, Any]) -> list[Any]:
        return [item.get("graphId", ""), item.get("transitionId", ""), f"{item.get('from', '?')} -> {item.get('to', '?')}", item.get("triggerKey", ""), item]

    def _issue_row(self, issue: dict[str, Any]) -> list[Any]:
        return [issue.get("severity", ""), issue.get("code", ""), issue.get("message", ""), issue]

    def _table_page(self, label: str, table: QTableWidget) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.addWidget(QLabel(label))
        page_layout.addWidget(table, 1)
        return page

    def _widget_page(self, widget: QWidget) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.addWidget(widget, 1)
        return page
class AssetAuditTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self.report: AssetAuditReport | None = None
        self._asset_thread: AssetAuditThread | None = None

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_refresh = QPushButton("刷新素材审计")
        self.btn_style = QPushButton("生成风格/命名参考")
        self.btn_copy = QPushButton("复制报告")
        self.btn_refresh.clicked.connect(self.refresh)
        self.btn_style.clicked.connect(self.render_style_reference)
        self.btn_copy.clicked.connect(self.copy_report)
        top.addWidget(self.btn_refresh)
        top.addWidget(self.btn_style)
        top.addWidget(self.btn_copy)
        top.addStretch(1)
        layout.addWidget(_scrollable_toolbar(top))

        self.output_dock = host.console_dock("asset-audit", "Asset Audit Output")
        self.output = _inline_console_from_dock(self.output_dock)
        self.output.setPlaceholderText("审计素材目录、图片尺寸/格式/alpha、动画 sheet 和分类组织。")
        layout.addWidget(self.output, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.report = None
        self.output.setPlainText("点击“刷新素材审计”扫描当前工程素材；点击“生成风格/命名参考”生成给 Codex/GPT 的素材参考。")

    def refresh(self) -> None:
        self.reload(save_report=True)

    def reload(self, *, save_report: bool = False) -> None:
        self._start_asset_job("audit", save_report=save_report)

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

    def render_style_reference(self) -> None:
        self._start_asset_job("style", save_report=True)

    def _start_asset_job(self, operation: str, *, save_report: bool) -> None:
        if self._asset_thread is not None and self._asset_thread.isRunning():
            QMessageBox.information(self, "素材审计", "素材扫描正在运行，请稍等。")
            return
        self._set_busy(True)
        if operation == "style":
            self.output.setPlainText("正在生成素材风格/命名参考...")
        else:
            self.output.setPlainText("正在刷新素材审计...")
        thread = AssetAuditThread(self.project_root, operation, save_report=save_report, parent=self)
        self._asset_thread = thread
        thread.completed.connect(self._on_asset_job_completed)
        thread.failed.connect(self._on_asset_job_failed)
        thread.finished.connect(self._on_asset_job_finished)
        thread.start()

    def _on_asset_job_completed(self, result: AssetAuditJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        if result.operation == "style":
            text = format_asset_style_reference_report(result.payload)  # type: ignore[arg-type]
            category = "asset-style-reference"
        else:
            self.report = result.payload  # type: ignore[assignment]
            text = format_asset_audit_report(self.report)
            category = "asset-audit"
        if result.save_report:
            text = _with_saved_report_note(result.project_root, category, text)
        self.output.setPlainText(text)

    def _on_asset_job_failed(self, result: AssetAuditJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        if result.operation == "style":
            text = f"素材风格/命名参考生成失败:\n{result.message}"
            category = "asset-style-reference-failed"
        else:
            self.report = None
            text = f"素材审计失败:\n{result.message}"
            category = "asset-audit-failed"
        if result.save_report:
            text = _with_saved_report_note(result.project_root, category, text)
        self.output.setPlainText(text)

    def _on_asset_job_finished(self) -> None:
        if self._asset_thread is not None:
            self._asset_thread.deleteLater()
            self._asset_thread = None
        self._set_busy(False)

    def _set_busy(self, busy: bool) -> None:
        self.btn_refresh.setEnabled(not busy)
        self.btn_style.setEnabled(not busy)


@dataclass(frozen=True)
class AssetCandidateListResult:
    project_root: Path
    keep_candidate_id: str = ""
    report: AssetCandidateReport | None = None
    message: str = ""


class AssetCandidateListThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(
        self,
        project_root: Path,
        keep_candidate_id: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.keep_candidate_id = keep_candidate_id

    def run(self) -> None:
        try:
            report = list_asset_candidates(self.project_root)
        except Exception as exc:  # noqa: BLE001 - report candidate failures in the tab.
            self.failed.emit(
                AssetCandidateListResult(
                    project_root=self.project_root,
                    keep_candidate_id=self.keep_candidate_id,
                    message=str(exc),
                )
            )
            return
        self.completed.emit(
            AssetCandidateListResult(
                project_root=self.project_root,
                keep_candidate_id=self.keep_candidate_id,
                report=report,
            )
        )


@dataclass(frozen=True)
class AssetCandidatePostprocessJobResult:
    project_root: Path
    report: object | None = None
    message: str = ""


class AssetCandidatePostprocessThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(
        self,
        project_root: Path,
        candidates: list[object],
        options: AssetPostprocessOptions,
        *,
        overwrite: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.candidates = candidates
        self.options = options
        self.overwrite = overwrite

    def run(self) -> None:
        try:
            report = postprocess_candidates(
                self.project_root,
                self.candidates,  # type: ignore[arg-type]
                self.options,
                overwrite=self.overwrite,
            )
        except Exception as exc:  # noqa: BLE001 - report batch postprocess failures in the tab.
            self.failed.emit(
                AssetCandidatePostprocessJobResult(
                    project_root=self.project_root,
                    message=str(exc),
                )
            )
            return
        self.completed.emit(
            AssetCandidatePostprocessJobResult(
                project_root=self.project_root,
                report=report,
            )
        )


class AssetCandidateTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.host = host
        self.project_root = host.project_root
        self.report: AssetCandidateReport | None = None
        self.loading_review = False
        self._candidate_thread: AssetCandidateListThread | None = None
        self._postprocess_thread: AssetCandidatePostprocessThread | None = None

        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_refresh = QPushButton("刷新候选")
        self.btn_copy = QPushButton("复制候选报告")
        self.btn_open_candidate = QPushButton("打开候选文件")
        self.btn_open_run_dir = QPushButton("打开运行目录")
        self.btn_to_image = QPushButton("载入图片工具")
        self.btn_save_review = QPushButton("保存评审")
        self.btn_keep = QPushButton("标记保留")
        self.btn_reject = QPushButton("标记废弃")
        self.btn_accept = QPushButton("标记采用")
        self.btn_redraw = QPushButton("用备注创建重抽任务")
        self.btn_score = QPushButton("批量评分/排序")
        self.btn_batch_redraw = QPushButton("批量创建重抽任务")
        self.btn_batch_postprocess = QPushButton("批量后处理通过/保留")
        self.btn_refresh.clicked.connect(self.reload)
        self.btn_copy.clicked.connect(self.copy_report)
        self.btn_open_candidate.clicked.connect(self.open_selected_candidate_file)
        self.btn_open_run_dir.clicked.connect(self.open_selected_run_dir)
        self.btn_to_image.clicked.connect(self.load_selected_into_image_tools)
        self.btn_save_review.clicked.connect(lambda _checked=False: self.save_current_review())
        self.btn_keep.clicked.connect(lambda _checked=False: self.save_current_review("keep"))
        self.btn_reject.clicked.connect(lambda _checked=False: self.save_current_review("reject"))
        self.btn_accept.clicked.connect(lambda _checked=False: self.save_current_review("accepted"))
        self.btn_redraw.clicked.connect(self.create_redraw_task)
        self.btn_score.clicked.connect(self.score_candidates)
        self.btn_batch_redraw.clicked.connect(self.batch_create_redraw_tasks)
        self.btn_batch_postprocess.clicked.connect(self.batch_postprocess_candidates)
        top.addWidget(self.btn_refresh)
        top.addWidget(self.btn_copy)
        top.addWidget(self.btn_open_candidate)
        top.addWidget(self.btn_open_run_dir)
        top.addWidget(self.btn_to_image)
        top.addWidget(self.btn_save_review)
        top.addWidget(self.btn_keep)
        top.addWidget(self.btn_reject)
        top.addWidget(self.btn_accept)
        top.addWidget(self.btn_redraw)
        top.addWidget(self.btn_score)
        top.addWidget(self.btn_batch_redraw)
        top.addWidget(self.btn_batch_postprocess)
        top.addStretch(1)
        layout.addWidget(_scrollable_toolbar(top))

        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels(["自动验收", "评审", "文件", "尺寸", "透明", "taskId", "路径", "运行目录"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.itemSelectionChanged.connect(self._render_selection)
        layout.addWidget(self.table, 2)

        review_wrap = QWidget()
        review_form = QFormLayout(review_wrap)
        self.edit_review = _readonly_picker_line()
        self.btn_review = QPushButton("选择")
        self.btn_review.clicked.connect(self.choose_review_status)
        _set_picker_line_value(self.edit_review, _candidate_review_items(), "unreviewed")
        self.edit_review_note = _text_edit(70)
        review_form.addRow("候选评审", _line_with_button(self.edit_review, self.btn_review))
        review_form.addRow("修改/淘汰备注", self.edit_review_note)
        layout.addWidget(review_wrap)

        post_wrap = QWidget()
        post_form = QFormLayout(post_wrap)
        self.edit_post_output_dir = QLineEdit()
        self.edit_post_suffix = QLineEdit("_ready")
        self.edit_post_format = _readonly_picker_line()
        self.btn_post_format = QPushButton("选择")
        self.btn_post_format.clicked.connect(self.choose_post_format)
        _set_picker_line_value(self.edit_post_format, _output_format_items(), "auto")
        post_size = QWidget()
        post_size_lay = QHBoxLayout(post_size)
        post_size_lay.setContentsMargins(0, 0, 0, 0)
        self.spin_post_w = _image_spin()
        self.spin_post_h = _image_spin()
        self.check_post_keep_aspect = QCheckBox("保持比例")
        self.check_post_keep_aspect.setChecked(True)
        post_size_lay.addWidget(QLabel("宽"))
        post_size_lay.addWidget(self.spin_post_w)
        post_size_lay.addWidget(QLabel("高"))
        post_size_lay.addWidget(self.spin_post_h)
        post_size_lay.addWidget(self.check_post_keep_aspect)
        self.check_post_trim = QCheckBox("自动裁透明空边")
        self.check_post_overwrite = QCheckBox("允许覆盖输出")
        post_flags = QWidget()
        post_flags_lay = QHBoxLayout(post_flags)
        post_flags_lay.setContentsMargins(0, 0, 0, 0)
        post_flags_lay.addWidget(self.check_post_trim)
        post_flags_lay.addWidget(self.check_post_overwrite)
        post_form.addRow("后处理输出目录（空=原目录）", self.edit_post_output_dir)
        post_form.addRow("后处理后缀", self.edit_post_suffix)
        post_form.addRow("后处理格式", _line_with_button(self.edit_post_format, self.btn_post_format))
        post_form.addRow("后处理缩放（0=不改）", post_size)
        post_form.addRow("", post_flags)
        layout.addWidget(post_wrap)

        self.output_dock = host.console_dock("asset-candidates", "Asset Candidates Output")
        self.output = _inline_console_from_dock(self.output_dock)
        self.output.setPlaceholderText("这里列出 Codex/GPT 素材任务输出的 savedPath 候选，可一键送到图片工具继续缩放、裁剪、调色。")
        output_splitter = QSplitter(Qt.Orientation.Vertical)
        output_splitter.addWidget(QWidget())
        output_splitter.addWidget(self.output)
        output_splitter.setCollapsible(0, False)
        output_splitter.setCollapsible(1, False)
        layout.addWidget(output_splitter, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.report = None
        self.table.setRowCount(0)
        self.output.setPlainText("点击“刷新候选”读取 Codex/GPT 素材任务输出。")

    def copy_report(self) -> None:
        if self.report is None:
            QApplication.clipboard().setText(self.output.toPlainText())
            return
        QApplication.clipboard().setText(format_asset_candidate_report(self.report))

    def choose_review_status(self) -> None:
        _pick_line_value(self, "选择候选评审状态", self.edit_review, _candidate_review_items())

    def choose_post_format(self) -> None:
        _pick_line_value(self, "选择后处理输出格式", self.edit_post_format, _output_format_items())

    def open_selected_candidate_file(self) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        if not candidate.exists:
            QMessageBox.warning(self, "候选不存在", f"这个候选文件不存在:\n{candidate.resolved_path}")
            return
        _open_path_system(self, candidate.resolved_path, "打开候选文件")

    def open_selected_run_dir(self) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        _open_path_system(self, candidate.run_dir, "打开运行目录")

    def load_selected_into_image_tools(self) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        if not candidate.exists:
            QMessageBox.warning(self, "候选不存在", f"这个候选文件不存在，不能载入图片工具:\n{candidate.resolved_path}")
            return
        self.host.image_tab.load_source_path(candidate.resolved_path, reset_output=True)
        self.host.tabs.setCurrentWidget(self.host.image_tab)

    def save_current_review(self, status: str | None = None) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        selected_id = candidate.candidate_id
        clean_status = status or str(_picker_line_value(self.edit_review, "unreviewed") or "unreviewed")
        try:
            save_candidate_review(
                self.project_root,
                candidate.candidate_id,
                status=clean_status,
                note=self.edit_review_note.toPlainText(),
            )
        except Exception as exc:  # noqa: BLE001
            self.output.setPlainText(
                _with_saved_report_note(
                    self.project_root,
                    "asset-candidate-review-failed",
                    f"保存评审失败:\n{exc}",
                )
            )
            return
        self.reload(keep_candidate_id=selected_id)

    def create_redraw_task(self) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        if not candidate.exists:
            QMessageBox.warning(self, "候选不存在", "候选文件不存在，不能作为重抽参考。")
            return
        self.save_current_review()
        refreshed = self._candidate_by_id(candidate.candidate_id) or candidate
        task = build_redraw_task_from_candidate(refreshed, self.edit_review_note.toPlainText())
        self.host.asset_task_tab.load_task(task)
        self.host.tabs.setCurrentWidget(self.host.asset_task_tab)

    def batch_create_redraw_tasks(self) -> None:
        if self.report is None:
            return
        try:
            report = batch_create_redraw_tasks(
                self.project_root,
                self.report.candidates,
            )
        except Exception as exc:  # noqa: BLE001
            self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidate-redraw-failed", f"批量创建重抽任务失败:\n{exc}"))
            return
        text = format_asset_candidate_redraw_task_report(report)
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidate-redraw", text))

    def score_candidates(self) -> None:
        if self.report is None:
            return
        text = format_asset_candidate_score_report(score_asset_candidates(self.project_root, self.report.candidates))
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidate-score", text))

    def batch_postprocess_candidates(self) -> None:
        if self.report is None:
            return
        if self._postprocess_thread is not None and self._postprocess_thread.isRunning():
            QMessageBox.information(self, "素材候选", "批量后处理正在运行，请稍等。")
            return
        options = AssetPostprocessOptions(
            output_dir=self.edit_post_output_dir.text(),
            suffix=self.edit_post_suffix.text(),
            output_format=str(_picker_line_value(self.edit_post_format, "auto") or "auto"),
            resize_width=self.spin_post_w.value() or None,
            resize_height=self.spin_post_h.value() or None,
            keep_aspect=self.check_post_keep_aspect.isChecked(),
            trim_transparent=self.check_post_trim.isChecked(),
        )
        self.btn_batch_postprocess.setEnabled(False)
        self.btn_batch_postprocess.setText("后处理中...")
        self.output.setPlainText("正在批量后处理候选素材...")
        thread = AssetCandidatePostprocessThread(
            self.project_root,
            list(self.report.candidates),
            options,
            overwrite=self.check_post_overwrite.isChecked(),
            parent=self,
        )
        self._postprocess_thread = thread
        thread.completed.connect(self._on_candidate_postprocess_completed)
        thread.failed.connect(self._on_candidate_postprocess_failed)
        thread.finished.connect(self._on_candidate_postprocess_finished)
        thread.start()

    def _on_candidate_postprocess_completed(self, result: AssetCandidatePostprocessJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        text = format_asset_postprocess_report(result.report)  # type: ignore[arg-type]
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidate-postprocess", text))

    def _on_candidate_postprocess_failed(self, result: AssetCandidatePostprocessJobResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidate-postprocess-failed", f"批量后处理失败:\n{result.message}"))

    def _on_candidate_postprocess_finished(self) -> None:
        if self._postprocess_thread is not None:
            self._postprocess_thread.deleteLater()
            self._postprocess_thread = None
        self.btn_batch_postprocess.setEnabled(True)
        self.btn_batch_postprocess.setText("批量后处理通过/保留")

    def _populate_table(self) -> None:
        self.table.setRowCount(0)
        if self.report is None:
            return
        for row, item in enumerate(self.report.candidates):
            self.table.insertRow(row)
            size = f"{item.width}x{item.height}" if item.width and item.height else "未知"
            alpha = "是" if item.has_alpha is True else ("否" if item.has_alpha is False else "未知")
            values = [
                item.validation_label,
                review_status_label(item.review_status),
                "存在" if item.exists else "缺失",
                size,
                alpha,
                item.task_id,
                item.display_path,
                item.run_dir.name,
            ]
            for col, value in enumerate(values):
                cell = QTableWidgetItem(value)
                cell.setFlags(cell.flags() & ~Qt.ItemFlag.ItemIsEditable)
                cell.setData(Qt.ItemDataRole.UserRole, row)
                self.table.setItem(row, col, cell)
        self.table.resizeColumnsToContents()

    def _render_selection(self) -> None:
        candidate = self._selected_candidate()
        if candidate is None:
            return
        self.loading_review = True
        try:
            _set_picker_line_value(self.edit_review, _candidate_review_items(), candidate.review_status)
            self.edit_review_note.setPlainText(candidate.review_note)
        finally:
            self.loading_review = False
        lines = [
            "素材候选",
            f"自动验收: {candidate.validation_label}",
            f"评审: {review_status_label(candidate.review_status)}",
            f"状态: {'存在' if candidate.exists else '缺失'}",
            f"taskId: {candidate.task_id}",
            f"路径: {candidate.display_path}",
            f"实际路径: {candidate.resolved_path}",
            f"运行目录: {candidate.run_dir}",
        ]
        if candidate.width and candidate.height:
            lines.append(f"尺寸: {candidate.width}x{candidate.height}")
        if candidate.image_format:
            lines.append(f"格式: {candidate.image_format}")
        if candidate.has_alpha is not None:
            lines.append(f"透明: {'是' if candidate.has_alpha else '否'}")
        if candidate.message:
            lines.append(f"说明: {candidate.message}")
        if candidate.validation_message:
            lines.append(f"自动验收说明: {candidate.validation_message}")
        if candidate.review_note:
            lines.append(f"评审备注: {candidate.review_note}")
        self.output.setPlainText("\n".join(lines))

    def _selected_candidate(self):
        if self.report is None:
            return None
        indexes = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
        if not indexes:
            return None
        row = indexes[0].row()
        if row < 0 or row >= len(self.report.candidates):
            return None
        return self.report.candidates[row]

    def _candidate_by_id(self, candidate_id: str):
        if self.report is None:
            return None
        for candidate in self.report.candidates:
            if candidate.candidate_id == candidate_id:
                return candidate
        return None

    def reload(self, *, keep_candidate_id: str = "") -> None:
        if self._candidate_thread is not None and self._candidate_thread.isRunning():
            QMessageBox.information(self, "素材候选", "素材候选正在刷新，请稍等。")
            return
        self.btn_refresh.setEnabled(False)
        self.output.setPlainText("正在刷新素材候选...")
        thread = AssetCandidateListThread(self.project_root, keep_candidate_id, parent=self)
        self._candidate_thread = thread
        thread.completed.connect(self._on_candidate_list_completed)
        thread.failed.connect(self._on_candidate_list_failed)
        thread.finished.connect(self._on_candidate_list_finished)
        thread.start()

    def _on_candidate_list_completed(self, result: "AssetCandidateListResult") -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.report = result.report
        self._populate_table()
        if result.keep_candidate_id and self.report is not None:
            for row, candidate in enumerate(self.report.candidates):
                if candidate.candidate_id == result.keep_candidate_id:
                    self.table.selectRow(row)
                    break
        text = format_asset_candidate_report(self.report)
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidates", text))

    def _on_candidate_list_failed(self, result: "AssetCandidateListResult") -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self.report = None
        self.table.setRowCount(0)
        self.output.setPlainText(_with_saved_report_note(self.project_root, "asset-candidates-failed", f"素材候选读取失败:\n{result.message}"))

    def _on_candidate_list_finished(self) -> None:
        if self._candidate_thread is not None:
            self._candidate_thread.deleteLater()
            self._candidate_thread = None
        self.btn_refresh.setEnabled(True)

class ImageEditThread(QThread):
    completed = Signal(object)
    failed = Signal(str)

    def __init__(
        self,
        project_root: Path,
        options: ImageEditOptions,
        *,
        overwrite: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.options = options
        self.overwrite = overwrite

    def run(self) -> None:
        try:
            self.completed.emit(
                apply_image_edit(
                    self.project_root,
                    self.options,
                    overwrite=self.overwrite,
                )
            )
        except Exception as exc:  # noqa: BLE001 - show processing failures in the tab.
            self.failed.emit(str(exc))


class ImageToolsTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self._syncing_crop = False
        self._image_thread: ImageEditThread | None = None

        layout = QVBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter, 1)

        form_wrap = QWidget()
        form = QFormLayout(form_wrap)

        self.edit_source = QLineEdit()
        self.btn_source = QPushButton("选择...")
        self.btn_source.clicked.connect(self.pick_source)
        source_row = _line_with_button(self.edit_source, self.btn_source)

        self.edit_output = QLineEdit()
        self.btn_output = QPushButton("保存到...")
        self.btn_output.clicked.connect(self.pick_output)
        output_row = _line_with_button(self.edit_output, self.btn_output)

        self.edit_format = _readonly_picker_line()
        self.btn_format = QPushButton("选择")
        self.btn_format.clicked.connect(self.choose_output_format)
        _set_picker_line_value(self.edit_format, _output_format_items(), "auto")

        self.spin_resize_w = _image_spin()
        self.spin_resize_h = _image_spin()
        self.check_keep_aspect = QCheckBox("保持比例")
        self.check_keep_aspect.setChecked(True)
        resize_row = QWidget()
        resize_lay = QHBoxLayout(resize_row)
        resize_lay.setContentsMargins(0, 0, 0, 0)
        resize_lay.addWidget(QLabel("宽"))
        resize_lay.addWidget(self.spin_resize_w)
        resize_lay.addWidget(QLabel("高"))
        resize_lay.addWidget(self.spin_resize_h)
        resize_lay.addWidget(self.check_keep_aspect)

        self.spin_crop_x = _image_spin()
        self.spin_crop_y = _image_spin()
        self.spin_crop_w = _image_spin()
        self.spin_crop_h = _image_spin()
        crop_row = QWidget()
        crop_lay = QHBoxLayout(crop_row)
        crop_lay.setContentsMargins(0, 0, 0, 0)
        for label, spin in [
            ("X", self.spin_crop_x),
            ("Y", self.spin_crop_y),
            ("W", self.spin_crop_w),
            ("H", self.spin_crop_h),
        ]:
            crop_lay.addWidget(QLabel(label))
            crop_lay.addWidget(spin)
        self.btn_clear_crop = QPushButton("清除裁剪")
        self.btn_clear_crop.clicked.connect(self.clear_crop)
        crop_lay.addWidget(self.btn_clear_crop)
        for spin in [self.spin_crop_x, self.spin_crop_y, self.spin_crop_w, self.spin_crop_h]:
            spin.valueChanged.connect(self._sync_crop_preview_from_spins)

        self.check_trim = QCheckBox("自动裁掉透明空边")
        self.spin_brightness = _factor_spin()
        self.spin_contrast = _factor_spin()
        self.spin_saturation = _factor_spin()
        self.spin_sharpness = _factor_spin()

        self.btn_load = QPushButton("读取/预览")
        self.btn_reset = QPushButton("重置参数")
        self.btn_save = QPushButton("生成输出")
        self.btn_copy = QPushButton("复制报告")
        self.btn_load.clicked.connect(self.load_preview)
        self.btn_reset.clicked.connect(self.reset_options)
        self.btn_save.clicked.connect(self.save_image)
        self.btn_copy.clicked.connect(self.copy_report)
        button_row = QWidget()
        button_lay = QHBoxLayout(button_row)
        button_lay.setContentsMargins(0, 0, 0, 0)
        button_lay.addWidget(self.btn_load)
        button_lay.addWidget(self.btn_reset)
        button_lay.addWidget(self.btn_save)
        button_lay.addWidget(self.btn_copy)

        form.addRow("源图片", source_row)
        form.addRow("输出文件", output_row)
        form.addRow("输出格式", _line_with_button(self.edit_format, self.btn_format))
        form.addRow("缩放（0=不改）", resize_row)
        form.addRow("精细裁剪（像素）", crop_row)
        form.addRow("", self.check_trim)
        form.addRow("亮度", self.spin_brightness)
        form.addRow("对比度", self.spin_contrast)
        form.addRow("饱和度", self.spin_saturation)
        form.addRow("锐化", self.spin_sharpness)
        form.addRow("", button_row)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(form_wrap)
        splitter.addWidget(scroll)

        right = QWidget()
        right_lay = QVBoxLayout(right)
        hint = QLabel(
            "用于 GPT 产物落地后的基础加工：格式转换、缩放、像素级裁剪、自动裁透明边和基础调色。"
            "在预览图上直接拖拽可框选裁剪区域，左侧数字可继续精细微调。"
        )
        hint.setWordWrap(True)
        right_lay.addWidget(hint)
        self.preview = CropPreviewLabel("选择一张图片后预览。")
        self.preview.cropSelected.connect(self._apply_crop_from_preview)
        self.preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview.setMinimumSize(480, 320)
        self.preview.setStyleSheet("QLabel { background: #1f1f1f; color: #ddd; border: 1px solid #777; }")
        right_lay.addWidget(self.preview, 2)
        self.output_dock = host.console_dock("image-tools", "Image Tools Output")
        self.output = _inline_console_from_dock(self.output_dock)
        self.output.setPlaceholderText("处理结果、输出路径和错误会显示在这里，可一键复制。")
        output_splitter = QSplitter(Qt.Orientation.Vertical)
        output_splitter.addWidget(QWidget())
        output_splitter.addWidget(self.output)
        output_splitter.setCollapsible(0, False)
        output_splitter.setCollapsible(1, False)
        right_lay.addWidget(output_splitter, 1)
        splitter.addWidget(right)
        splitter.setSizes([500, 820])
        splitter.setCollapsible(0, False)
        splitter.setCollapsible(1, False)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.output.clear()

    def load_source_path(self, source: Path, *, reset_output: bool = False) -> None:
        source = source.resolve()
        self.edit_source.setText(_display_path(self.project_root, source))
        if reset_output or not self.edit_output.text().strip():
            self.edit_output.setText(self._default_output_for_source(source))
        self.load_preview()

    def pick_source(self) -> None:
        path, _filter = QFileDialog.getOpenFileName(
            self,
            "选择源图片",
            str(self.project_root / "public" / "resources" / "runtime"),
            "Images (*.png *.jpg *.jpeg *.webp *.gif *.bmp);;All files (*.*)",
        )
        if not path:
            return
        self.load_source_path(Path(path).resolve())

    def pick_output(self) -> None:
        start = str(self.project_root / "public" / "resources" / "runtime")
        raw = self.edit_output.text().strip()
        if raw:
            try:
                start = str(resolve_output_path(self.project_root, raw, str(_picker_line_value(self.edit_format, "auto") or "auto")))
            except Exception:  # noqa: BLE001
                pass
        path, _filter = QFileDialog.getSaveFileName(
            self,
            "选择输出文件",
            start,
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;WebP (*.webp);;All files (*.*)",
        )
        if path:
            self.edit_output.setText(_display_path(self.project_root, Path(path).resolve()))

    def load_preview(self) -> None:
        try:
            path = resolve_source_path(self.project_root, self.edit_source.text())
            info = inspect_image(path)
        except Exception as exc:  # noqa: BLE001
            self.output.setPlainText(
                _with_saved_report_note(self.project_root, "image-preview-failed", f"读取失败:\n{exc}")
            )
            return
        self._set_crop_spin_limits(info.width, info.height)
        self._show_preview(path)
        self._sync_crop_preview_from_spins()
        self.output.setPlainText(
            "源图片\n"
            f"路径: {info.path}\n"
            f"尺寸: {info.width}x{info.height}\n"
            f"格式: {info.detected_format or '(未知)'}\n"
            f"模式: {info.mode}\n"
            f"透明: {'是' if info.has_alpha else '否'}"
        )

    def choose_output_format(self) -> None:
        _pick_line_value(self, "选择输出格式", self.edit_format, _output_format_items())

    def reset_options(self) -> None:
        for spin in [
            self.spin_resize_w,
            self.spin_resize_h,
            self.spin_crop_x,
            self.spin_crop_y,
            self.spin_crop_w,
            self.spin_crop_h,
        ]:
            spin.setValue(0)
        for spin in [
            self.spin_brightness,
            self.spin_contrast,
            self.spin_saturation,
            self.spin_sharpness,
        ]:
            spin.setValue(1.0)
        self.check_keep_aspect.setChecked(True)
        self.check_trim.setChecked(False)
        self.preview.clear_crop()

    def save_image(self) -> None:
        try:
            options = self._collect_options()
            output_path = resolve_output_path(
                self.project_root,
                options.output_path,
                options.output_format,
            )
        except Exception as exc:  # noqa: BLE001
            self.output.setPlainText(
                _with_saved_report_note(self.project_root, "image-edit-params-failed", f"参数错误:\n{exc}")
            )
            return
        overwrite = False
        if output_path.exists():
            answer = QMessageBox.question(
                self,
                "确认覆盖",
                f"输出文件已存在，是否覆盖？\n{output_path}",
            )
            if answer != QMessageBox.StandardButton.Yes:
                self.output.setPlainText("已取消：没有覆盖现有文件。")
                return
            overwrite = True
        if self._image_thread is not None and self._image_thread.isRunning():
            QMessageBox.information(self, "图片工具", "图片处理正在运行，请稍等。")
            return
        self.btn_save.setEnabled(False)
        self.btn_save.setText("处理中...")
        self.output.setPlainText("正在处理图片...")
        thread = ImageEditThread(self.project_root, options, overwrite=overwrite, parent=self)
        self._image_thread = thread
        thread.completed.connect(self._on_image_edit_completed)
        thread.failed.connect(self._on_image_edit_failed)
        thread.finished.connect(self._on_image_edit_finished)
        thread.start()

    def _on_image_edit_completed(self, result: object) -> None:
        self.edit_output.setText(_display_path(self.project_root, result.output_path))  # type: ignore[attr-defined]
        self._show_preview(result.output_path)  # type: ignore[attr-defined]
        self.output.setPlainText(_with_saved_report_note(self.project_root, "image-edit", result.summary()))

    def _on_image_edit_failed(self, message: str) -> None:
        self.output.setPlainText(_with_saved_report_note(self.project_root, "image-edit-failed", f"处理失败:\n{message}"))

    def _on_image_edit_finished(self) -> None:
        if self._image_thread is not None:
            self._image_thread.deleteLater()
            self._image_thread = None
        self.btn_save.setEnabled(True)
        self.btn_save.setText("生成输出")

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

    def clear_crop(self) -> None:
        self._set_crop_values(0, 0, 0, 0)
        self.preview.clear_crop()

    def _apply_crop_from_preview(self, x: int, y: int, width: int, height: int) -> None:
        self._set_crop_values(x, y, width, height)
        base = self.output.toPlainText().strip()
        note = f"裁剪框已设置: x={x}, y={y}, w={width}, h={height}"
        self.output.setPlainText(f"{base}\n\n{note}" if base else note)

    def _set_crop_values(self, x: int, y: int, width: int, height: int) -> None:
        self._syncing_crop = True
        try:
            self.spin_crop_x.setValue(max(0, int(x)))
            self.spin_crop_y.setValue(max(0, int(y)))
            self.spin_crop_w.setValue(max(0, int(width)))
            self.spin_crop_h.setValue(max(0, int(height)))
        finally:
            self._syncing_crop = False
        self._sync_crop_preview_from_spins()

    def _sync_crop_preview_from_spins(self, *_unused: object) -> None:
        if self._syncing_crop:
            return
        self.preview.set_crop_pixels(
            self.spin_crop_x.value(),
            self.spin_crop_y.value(),
            self.spin_crop_w.value(),
            self.spin_crop_h.value(),
        )

    def _set_crop_spin_limits(self, width: int, height: int) -> None:
        for spin, maximum in [
            (self.spin_crop_x, width),
            (self.spin_crop_w, width),
            (self.spin_crop_y, height),
            (self.spin_crop_h, height),
        ]:
            spin.setMaximum(max(0, int(maximum)))

    def _collect_options(self) -> ImageEditOptions:
        return ImageEditOptions(
            source_path=self.edit_source.text(),
            output_path=self.edit_output.text(),
            output_format=str(_picker_line_value(self.edit_format, "auto") or "auto"),
            resize_width=self.spin_resize_w.value() or None,
            resize_height=self.spin_resize_h.value() or None,
            keep_aspect=self.check_keep_aspect.isChecked(),
            crop_x=self.spin_crop_x.value() or None,
            crop_y=self.spin_crop_y.value() or None,
            crop_width=self.spin_crop_w.value() or None,
            crop_height=self.spin_crop_h.value() or None,
            trim_transparent=self.check_trim.isChecked(),
            brightness=self.spin_brightness.value(),
            contrast=self.spin_contrast.value(),
            saturation=self.spin_saturation.value(),
            sharpness=self.spin_sharpness.value(),
        )

    def _show_preview(self, path: Path) -> None:
        self.preview.set_image_path(path)

    def _default_output_for_source(self, source: Path) -> str:
        try:
            source.parent.relative_to(self.project_root.resolve())
            rel_parent = _display_path(self.project_root, source.parent)
        except ValueError:
            rel_parent = "public/resources/runtime/images/illustrations"
        suffix = source.suffix if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
        return str(Path(rel_parent) / f"{source.stem}_edited{suffix}").replace("\\", "/")


@dataclass(frozen=True)
class AnimationSheetJobResult:
    operation: str
    result: object | None = None
    message: str = ""


class AnimationSheetThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(
        self,
        project_root: Path,
        operation: str,
        *,
        sheet_options: SheetGridOptions | None = None,
        split_output_dir: str = "",
        split_prefix: str = "",
        compose_options: ComposeSheetOptions | None = None,
        overwrite: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.operation = operation
        self.sheet_options = sheet_options
        self.split_output_dir = split_output_dir
        self.split_prefix = split_prefix
        self.compose_options = compose_options
        self.overwrite = overwrite

    def run(self) -> None:
        try:
            if self.operation == "split":
                if self.sheet_options is None:
                    raise ValueError("缺少 Sheet 参数。")
                result = split_animation_sheet(
                    self.project_root,
                    self.sheet_options,
                    self.split_output_dir,
                    prefix=self.split_prefix,
                    overwrite=self.overwrite,
                )
            elif self.operation == "compose":
                if self.compose_options is None:
                    raise ValueError("缺少合成参数。")
                result = compose_animation_sheet(
                    self.project_root,
                    self.compose_options,
                    overwrite=self.overwrite,
                )
            else:
                raise ValueError(f"未知动画 Sheet 操作: {self.operation}")
        except Exception as exc:  # noqa: BLE001 - show processing failures in the tab.
            self.failed.emit(AnimationSheetJobResult(operation=self.operation, message=str(exc)))
            return
        self.completed.emit(AnimationSheetJobResult(operation=self.operation, result=result))


class AnimationSheetTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self._animation_thread: AnimationSheetThread | None = None

        layout = QVBoxLayout(self)
        hint = QLabel(
            "用于稳定处理 GPT/Codex 产出的帧动画：检查 sheet 网格、拆成单帧、把单帧重新合成 sheet。"
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter, 1)

        left = QWidget()
        left_form = QFormLayout(left)
        self.edit_sheet_source = QLineEdit()
        self.btn_pick_sheet = QPushButton("选择...")
        self.btn_pick_sheet.clicked.connect(self.pick_sheet_source)
        left_form.addRow("Sheet 源图", _line_with_button(self.edit_sheet_source, self.btn_pick_sheet))

        grid_row = QWidget()
        grid_lay = QHBoxLayout(grid_row)
        grid_lay.setContentsMargins(0, 0, 0, 0)
        self.spin_sheet_frame_count = _image_spin()
        self.spin_sheet_columns = _image_spin()
        self.spin_sheet_rows = _image_spin()
        for label, spin in [
            ("帧数", self.spin_sheet_frame_count),
            ("列", self.spin_sheet_columns),
            ("行", self.spin_sheet_rows),
        ]:
            grid_lay.addWidget(QLabel(label))
            grid_lay.addWidget(spin)
        left_form.addRow("网格", grid_row)

        size_row = QWidget()
        size_lay = QHBoxLayout(size_row)
        size_lay.setContentsMargins(0, 0, 0, 0)
        self.spin_sheet_frame_w = _image_spin()
        self.spin_sheet_frame_h = _image_spin()
        for label, spin in [("单帧宽", self.spin_sheet_frame_w), ("单帧高", self.spin_sheet_frame_h)]:
            size_lay.addWidget(QLabel(label))
            size_lay.addWidget(spin)
        left_form.addRow("单帧尺寸", size_row)

        self.edit_split_output_dir = QLineEdit("public/resources/runtime/animation/frames")
        self.btn_pick_split_dir = QPushButton("目录...")
        self.btn_pick_split_dir.clicked.connect(self.pick_split_output_dir)
        left_form.addRow("拆帧输出目录", _line_with_button(self.edit_split_output_dir, self.btn_pick_split_dir))

        self.edit_split_prefix = QLineEdit()
        self.check_split_overwrite = QCheckBox("允许覆盖已有帧")
        left_form.addRow("拆帧前缀", self.edit_split_prefix)
        left_form.addRow("", self.check_split_overwrite)

        split_buttons = QWidget()
        split_lay = QHBoxLayout(split_buttons)
        split_lay.setContentsMargins(0, 0, 0, 0)
        self.btn_inspect_sheet = QPushButton("检查 Sheet")
        self.btn_split_sheet = QPushButton("拆成单帧")
        self.btn_inspect_sheet.clicked.connect(self.inspect_sheet)
        self.btn_split_sheet.clicked.connect(self.split_sheet)
        split_lay.addWidget(self.btn_inspect_sheet)
        split_lay.addWidget(self.btn_split_sheet)
        left_form.addRow("", split_buttons)
        splitter.addWidget(left)

        right = QWidget()
        right_form = QFormLayout(right)
        self.edit_frames_dir = QLineEdit("public/resources/runtime/animation/frames")
        self.btn_pick_frames_dir = QPushButton("目录...")
        self.btn_pick_frames_dir.clicked.connect(self.pick_frames_dir)
        right_form.addRow("帧目录", _line_with_button(self.edit_frames_dir, self.btn_pick_frames_dir))

        self.edit_compose_output = QLineEdit("public/resources/runtime/animation/combined.png")
        self.btn_pick_compose_output = QPushButton("保存到...")
        self.btn_pick_compose_output.clicked.connect(self.pick_compose_output)
        right_form.addRow("合成输出", _line_with_button(self.edit_compose_output, self.btn_pick_compose_output))

        compose_grid = QWidget()
        compose_lay = QHBoxLayout(compose_grid)
        compose_lay.setContentsMargins(0, 0, 0, 0)
        self.spin_compose_count = _image_spin()
        self.spin_compose_columns = _image_spin()
        self.spin_compose_padding = _image_spin()
        for label, spin in [
            ("帧数", self.spin_compose_count),
            ("列", self.spin_compose_columns),
            ("间距", self.spin_compose_padding),
        ]:
            compose_lay.addWidget(QLabel(label))
            compose_lay.addWidget(spin)
        right_form.addRow("合成参数", compose_grid)

        self.check_compose_overwrite = QCheckBox("允许覆盖输出 sheet")
        right_form.addRow("", self.check_compose_overwrite)

        compose_buttons = QWidget()
        compose_buttons_lay = QHBoxLayout(compose_buttons)
        compose_buttons_lay.setContentsMargins(0, 0, 0, 0)
        self.btn_compose_sheet = QPushButton("合成 Sheet")
        self.btn_copy_animation_report = QPushButton("复制报告")
        self.btn_compose_sheet.clicked.connect(self.compose_sheet)
        self.btn_copy_animation_report.clicked.connect(self.copy_report)
        compose_buttons_lay.addWidget(self.btn_compose_sheet)
        compose_buttons_lay.addWidget(self.btn_copy_animation_report)
        right_form.addRow("", compose_buttons)
        splitter.addWidget(right)
        splitter.setSizes([640, 640])

        self.output_dock = host.console_dock("animation-sheet", "Animation Sheet Output")
        self.output = _inline_console_from_dock(self.output_dock)
        self.output.setPlaceholderText("检查、拆帧、合成结果会显示在这里，可复制给 Codex 继续修。")
        output_splitter = QSplitter(Qt.Orientation.Vertical)
        output_splitter.addWidget(QWidget())
        output_splitter.addWidget(self.output)
        output_splitter.setCollapsible(0, False)
        output_splitter.setCollapsible(1, False)
        layout.addWidget(output_splitter, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.output.clear()

    def pick_sheet_source(self) -> None:
        path, _filter = QFileDialog.getOpenFileName(
            self,
            "选择动画 Sheet",
            str(self.project_root / "public" / "resources" / "runtime" / "animation"),
            "Images (*.png *.jpg *.jpeg *.webp);;All files (*.*)",
        )
        if not path:
            return
        source = Path(path).resolve()
        self.edit_sheet_source.setText(_display_path(self.project_root, source))
        if not self.edit_split_prefix.text().strip():
            self.edit_split_prefix.setText(source.stem)

    def pick_split_output_dir(self) -> None:
        path = QFileDialog.getExistingDirectory(
            self,
            "选择拆帧输出目录",
            str(self.project_root / "public" / "resources" / "runtime" / "animation"),
        )
        if path:
            self.edit_split_output_dir.setText(_display_path(self.project_root, Path(path).resolve()))

    def pick_frames_dir(self) -> None:
        path = QFileDialog.getExistingDirectory(
            self,
            "选择帧目录",
            str(self.project_root / "public" / "resources" / "runtime" / "animation"),
        )
        if path:
            self.edit_frames_dir.setText(_display_path(self.project_root, Path(path).resolve()))

    def pick_compose_output(self) -> None:
        path, _filter = QFileDialog.getSaveFileName(
            self,
            "选择合成 Sheet 输出",
            str(self.project_root / "public" / "resources" / "runtime" / "animation" / "combined.png"),
            "PNG (*.png);;WebP (*.webp);;JPEG (*.jpg *.jpeg);;All files (*.*)",
        )
        if path:
            self.edit_compose_output.setText(_display_path(self.project_root, Path(path).resolve()))

    def inspect_sheet(self) -> None:
        try:
            report = inspect_animation_sheet(self.project_root, self._sheet_options())
        except Exception as exc:  # noqa: BLE001
            self.output.setPlainText(_with_saved_report_note(self.project_root, "animation-sheet-inspect-failed", f"Sheet 检查失败:\n{exc}"))
            return
        self.output.setPlainText(_with_saved_report_note(self.project_root, "animation-sheet-inspect", format_animation_sheet_report(report)))

    def split_sheet(self) -> None:
        if self._animation_thread is not None and self._animation_thread.isRunning():
            QMessageBox.information(self, "动画 Sheet", "动画 Sheet 处理正在运行，请稍等。")
            return
        self._start_animation_job(
            AnimationSheetThread(
                self.project_root,
                "split",
                sheet_options=self._sheet_options(),
                split_output_dir=self.edit_split_output_dir.text(),
                split_prefix=self.edit_split_prefix.text(),
                overwrite=self.check_split_overwrite.isChecked(),
                parent=self,
            ),
            "正在拆帧...",
        )

    def compose_sheet(self) -> None:
        if self._animation_thread is not None and self._animation_thread.isRunning():
            QMessageBox.information(self, "动画 Sheet", "动画 Sheet 处理正在运行，请稍等。")
            return
        self._start_animation_job(
            AnimationSheetThread(
                self.project_root,
                "compose",
                compose_options=ComposeSheetOptions(
                    frames_dir=self.edit_frames_dir.text(),
                    output_path=self.edit_compose_output.text(),
                    columns=self.spin_compose_columns.value() or None,
                    frame_count=self.spin_compose_count.value() or None,
                    padding=self.spin_compose_padding.value(),
                    output_format="auto",
                ),
                overwrite=self.check_compose_overwrite.isChecked(),
                parent=self,
            ),
            "正在合成 Sheet...",
        )

    def _start_animation_job(self, thread: AnimationSheetThread, message: str) -> None:
        self._animation_thread = thread
        self._set_animation_busy(True)
        self.output.setPlainText(message)
        thread.completed.connect(self._on_animation_job_completed)
        thread.failed.connect(self._on_animation_job_failed)
        thread.finished.connect(self._on_animation_job_finished)
        thread.start()

    def _on_animation_job_completed(self, job: AnimationSheetJobResult) -> None:
        if job.operation == "split":
            if job.result is None:
                return
            result = job.result
            self.edit_frames_dir.setText(_display_path(self.project_root, result.output_dir))  # type: ignore[attr-defined]
            self.output.setPlainText(_with_saved_report_note(self.project_root, "animation-sheet-split", result.summary()))  # type: ignore[attr-defined]
            return
        if job.operation == "compose" and job.result is not None:
            self.output.setPlainText(_with_saved_report_note(self.project_root, "animation-sheet-compose", job.result.summary()))  # type: ignore[union-attr]

    def _on_animation_job_failed(self, job: AnimationSheetJobResult) -> None:
        label = "拆帧" if job.operation == "split" else "合成 Sheet"
        category = "animation-sheet-split-failed" if job.operation == "split" else "animation-sheet-compose-failed"
        self.output.setPlainText(_with_saved_report_note(self.project_root, category, f"{label}失败:\n{job.message}"))

    def _on_animation_job_finished(self) -> None:
        if self._animation_thread is not None:
            self._animation_thread.deleteLater()
            self._animation_thread = None
        self._set_animation_busy(False)

    def _set_animation_busy(self, busy: bool) -> None:
        self.btn_split_sheet.setEnabled(not busy)
        self.btn_compose_sheet.setEnabled(not busy)

    def copy_report(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())

    def _sheet_options(self) -> SheetGridOptions:
        return SheetGridOptions(
            source_path=self.edit_sheet_source.text(),
            frame_count=self.spin_sheet_frame_count.value() or None,
            columns=self.spin_sheet_columns.value() or None,
            rows=self.spin_sheet_rows.value() or None,
            frame_width=self.spin_sheet_frame_w.value() or None,
            frame_height=self.spin_sheet_frame_h.value() or None,
        )


class CodexAssetRunThread(QThread):
    progress = Signal(str)
    completed = Signal(object)
    failed = Signal(str)

    def __init__(
        self,
        project_root: Path,
        task: AssetTask,
        postprocess_options: AssetPostprocessOptions | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.task = task
        self.postprocess_options = postprocess_options

    def run(self) -> None:
        try:
            self.completed.emit(
                run_codex_asset_task(
                    self.project_root,
                    self.task,
                    postprocess_options=self.postprocess_options,
                    progress=self.progress.emit,
                )
            )
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))


@dataclass(frozen=True)
class AssetTaskSuggestionResult:
    project_root: Path
    category: str
    report: AssetAuditReport | None = None
    defaults: dict[str, Any] | None = None
    message: str = ""


class AssetTaskSuggestionThread(QThread):
    completed = Signal(object)
    failed = Signal(object)

    def __init__(self, project_root: Path, category: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.project_root = project_root
        self.category = category

    def run(self) -> None:
        try:
            report = audit_asset_specs(self.project_root)
            defaults = suggest_task_defaults(self.project_root, self.category, report=report)
        except Exception as exc:  # noqa: BLE001 - suggestions should never freeze or crash the GUI.
            self.failed.emit(
                AssetTaskSuggestionResult(
                    project_root=self.project_root,
                    category=self.category,
                    message=str(exc),
                )
            )
            return
        self.completed.emit(
            AssetTaskSuggestionResult(
                project_root=self.project_root,
                category=self.category,
                report=report,
                defaults=defaults,
            )
        )


class AssetTaskTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self.audit_report: AssetAuditReport | None = None
        self._codex_thread: CodexAssetRunThread | None = None
        self._suggestion_thread: AssetTaskSuggestionThread | None = None

        layout = QVBoxLayout(self)
        toolbar = QHBoxLayout()
        self.btn_suggest = QPushButton("按分类建议填充")
        self.btn_generate = QPushButton("生成任务文本")
        self.btn_save = QPushButton("保存任务单")
        self.btn_copy = QPushButton("复制任务文本")
        self.btn_run = QPushButton("执行 Codex 并记录")
        self.btn_suggest.clicked.connect(self.apply_suggestions)
        self.btn_generate.clicked.connect(self.render_prompt)
        self.btn_save.clicked.connect(self.save_task)
        self.btn_copy.clicked.connect(self.copy_prompt)
        self.btn_run.clicked.connect(self.run_codex_task)
        toolbar.addWidget(self.btn_suggest)
        toolbar.addWidget(self.btn_generate)
        toolbar.addWidget(self.btn_save)
        toolbar.addWidget(self.btn_copy)
        toolbar.addWidget(self.btn_run)
        toolbar.addStretch(1)
        layout.addWidget(_scrollable_toolbar(toolbar))

        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter, 1)

        form_wrap = QWidget()
        form = QFormLayout(form_wrap)
        self.edit_title = QLineEdit()
        self.edit_category = _readonly_picker_line()
        self.btn_category = QPushButton("选择")
        self.btn_category.clicked.connect(self.choose_category)
        _set_picker_line_value(self.edit_category, _asset_category_items(), "illustration")
        self.edit_operation = _readonly_picker_line()
        self.btn_operation = QPushButton("选择")
        self.btn_operation.clicked.connect(self.choose_operation)
        _set_picker_line_value(self.edit_operation, _asset_operation_items(), "new")
        self.edit_target = QLineEdit()
        self.btn_target = QPushButton("选择...")
        self.btn_target.clicked.connect(self.pick_target_file)
        self.edit_output_dir = QLineEdit()
        self.btn_output_dir = QPushButton("目录...")
        self.btn_output_dir.clicked.connect(self.pick_output_dir)
        self.spin_width = QSpinBox()
        self.spin_width.setRange(0, 20000)
        self.spin_height = QSpinBox()
        self.spin_height.setRange(0, 20000)
        self.edit_transparent = _readonly_picker_line()
        self.btn_transparent = QPushButton("选择")
        self.btn_transparent.clicked.connect(self.choose_transparent)
        _set_picker_line_value(self.edit_transparent, _transparent_items(), None)
        self.spin_frames = QSpinBox()
        self.spin_frames.setRange(0, 1000)
        self.edit_refs = _text_edit(80)
        self.edit_style = _text_edit(80)
        self.edit_request = _text_edit(120)
        self.edit_acceptance = _text_edit(80)
        self.check_auto_postprocess = QCheckBox("执行后自动生成 _ready 后处理副本（按任务宽高/透明要求）")
        form.addRow("标题", self.edit_title)
        form.addRow("类别", _line_with_button(self.edit_category, self.btn_category))
        form.addRow("操作", _line_with_button(self.edit_operation, self.btn_operation))
        form.addRow("目标文件", _line_with_button(self.edit_target, self.btn_target))
        form.addRow("输出目录", _line_with_button(self.edit_output_dir, self.btn_output_dir))
        form.addRow("宽", self.spin_width)
        form.addRow("高", self.spin_height)
        form.addRow("透明", _line_with_button(self.edit_transparent, self.btn_transparent))
        form.addRow("帧数", self.spin_frames)
        form.addRow("参考素材（每行一个）", _field_with_buttons(self.edit_refs, [("添加参考素材", self.add_reference_asset)]))
        form.addRow("风格约束", self.edit_style)
        form.addRow("具体要求", self.edit_request)
        form.addRow("验收标准", self.edit_acceptance)
        form.addRow("", self.check_auto_postprocess)
        splitter.addWidget(form_wrap)

        self.prompt_dock = host.console_dock("asset-task", "Asset Task Output")
        self.prompt = _inline_console_from_dock(self.prompt_dock)
        splitter.addWidget(self.prompt)
        splitter.setSizes([520, 760])
        splitter.setCollapsible(0, False)
        splitter.setCollapsible(1, False)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root
        self.audit_report = None
        if not self.edit_title.text().strip():
            self.edit_title.setText("新素材任务")
        category = self._current_category()
        _set_picker_line_value(self.edit_category, _asset_category_items(), category)
        self._apply_basic_task_defaults(category)

    def load_task(self, task: AssetTask) -> None:
        normalized = task.normalized()
        self.edit_title.setText(normalized.title)
        _set_picker_line_value(self.edit_category, _asset_category_items(), normalized.category)
        _set_picker_line_value(self.edit_operation, _asset_operation_items(), normalized.operation)
        self.edit_target.setText(normalized.target_path)
        self.edit_output_dir.setText(normalized.output_dir)
        self.spin_width.setValue(normalized.width or 0)
        self.spin_height.setValue(normalized.height or 0)
        _set_picker_line_value(self.edit_transparent, _transparent_items(), normalized.transparent)
        self.spin_frames.setValue(normalized.frame_count or 0)
        self.edit_refs.setPlainText("\n".join(normalized.reference_paths))
        self.edit_style.setPlainText(normalized.style_notes)
        self.edit_request.setPlainText(normalized.request)
        self.edit_acceptance.setPlainText(normalized.acceptance)
        self.render_prompt()

    def apply_suggestions(self) -> None:
        category = self._current_category()
        if self.audit_report is None:
            self._apply_basic_task_defaults(category)
            self._start_suggestion_job(category)
            return
        self._apply_suggestion_defaults(category, self.audit_report)

    def _current_category(self) -> str:
        category = str(_picker_line_value(self.edit_category, "illustration") or "illustration")
        return category if category in ASSET_CATEGORIES else "illustration"

    def _apply_basic_task_defaults(self, category: str) -> None:
        self.edit_output_dir.setText(default_output_dir(category))
        self.render_prompt()

    def _apply_suggestion_defaults(self, category: str, report: AssetAuditReport) -> None:
        try:
            defaults = suggest_task_defaults(
                self.project_root,
                category,
                report=report,
            )
        except Exception:  # noqa: BLE001
            defaults = {}
        self.edit_output_dir.setText(str(defaults.get("outputDir") or ""))
        width = defaults.get("width")
        height = defaults.get("height")
        if isinstance(width, int):
            self.spin_width.setValue(width)
        if isinstance(height, int):
            self.spin_height.setValue(height)
        transparent = defaults.get("transparent")
        _set_picker_line_value(self.edit_transparent, _transparent_items(), transparent)
        refs = defaults.get("referencePaths") or []
        if isinstance(refs, list):
            self.edit_refs.setPlainText("\n".join(str(x) for x in refs[:5]))
        self.render_prompt()

    def _start_suggestion_job(self, category: str) -> None:
        if self._suggestion_thread is not None and self._suggestion_thread.isRunning():
            QMessageBox.information(self, "素材任务建议", "素材库分析正在运行，请稍等。")
            return
        self.btn_suggest.setEnabled(False)
        self.btn_suggest.setText("分析中...")
        self.prompt.setPlainText("正在分析素材库并生成尺寸、透明和参考素材建议...")
        thread = AssetTaskSuggestionThread(self.project_root, category, parent=self)
        self._suggestion_thread = thread
        thread.completed.connect(self._on_suggestion_completed)
        thread.failed.connect(self._on_suggestion_failed)
        thread.finished.connect(self._on_suggestion_finished)
        thread.start()

    def _on_suggestion_completed(self, result: AssetTaskSuggestionResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        if result.category != self._current_category():
            return
        if result.report is not None:
            self.audit_report = result.report
        defaults = result.defaults or {}
        self.edit_output_dir.setText(str(defaults.get("outputDir") or default_output_dir(result.category)))
        width = defaults.get("width")
        height = defaults.get("height")
        if isinstance(width, int):
            self.spin_width.setValue(width)
        if isinstance(height, int):
            self.spin_height.setValue(height)
        _set_picker_line_value(self.edit_transparent, _transparent_items(), defaults.get("transparent"))
        refs = defaults.get("referencePaths") or []
        if isinstance(refs, list):
            self.edit_refs.setPlainText("\n".join(str(x) for x in refs[:5]))
        self.render_prompt()

    def _on_suggestion_failed(self, result: AssetTaskSuggestionResult) -> None:
        if result.project_root.resolve() != self.project_root.resolve():
            return
        self._apply_basic_task_defaults(result.category)
        current = self.prompt.toPlainText().rstrip()
        text = f"素材库分析失败，已保留基础默认值:\n{result.message}"
        if current:
            text = f"{current}\n\n{text}"
        self.prompt.setPlainText(_with_saved_report_note(self.project_root, "asset-task-suggestion-failed", text))

    def _on_suggestion_finished(self) -> None:
        if self._suggestion_thread is not None:
            self._suggestion_thread.deleteLater()
            self._suggestion_thread = None
        self.btn_suggest.setEnabled(True)
        self.btn_suggest.setText("按分类建议填充")

    def render_prompt(self) -> None:
        task = self._collect_task()
        self.prompt.setPlainText(build_asset_task_prompt(task))

    def choose_category(self) -> None:
        if _pick_line_value(self, "选择素材类别", self.edit_category, _asset_category_items()):
            self.apply_suggestions()

    def choose_operation(self) -> None:
        if _pick_line_value(self, "选择素材操作", self.edit_operation, _asset_operation_items()):
            self.render_prompt()

    def choose_transparent(self) -> None:
        if _pick_line_value(self, "选择透明要求", self.edit_transparent, _transparent_items()):
            self.render_prompt()

    def pick_target_file(self) -> None:
        start = _task_file_dialog_start(
            self.project_root,
            self.edit_target.text().strip() or self.edit_output_dir.text().strip(),
        )
        path, _filter = QFileDialog.getSaveFileName(
            self,
            "选择目标文件",
            str(start),
            "Images (*.png *.jpg *.jpeg *.webp);;All files (*.*)",
        )
        if path:
            self.edit_target.setText(_display_path(self.project_root, Path(path).resolve()))
            self.render_prompt()

    def pick_output_dir(self) -> None:
        start = _task_file_dialog_start(self.project_root, self.edit_output_dir.text().strip())
        path = QFileDialog.getExistingDirectory(self, "选择输出目录", str(start))
        if path:
            self.edit_output_dir.setText(_display_path(self.project_root, Path(path).resolve()))
            self.render_prompt()

    def add_reference_asset(self) -> None:
        item = _pick_item_dialog(self, "选择参考素材", _asset_items(self.project_root), empty_message="没有可选素材。")
        if not item:
            return
        _append_text_edit_line(self.edit_refs, str(item.get("value") or ""))
        self.render_prompt()

    def save_task(self) -> None:
        task = self._collect_task()
        try:
            saved = save_asset_task(self.project_root, task)
        except Exception as exc:  # noqa: BLE001
            self.prompt.setPlainText(
                _with_saved_report_note(
                    self.project_root,
                    "asset-task-save-failed",
                    f"素材任务单保存失败:\n{exc}",
                )
            )
            return
        self.prompt.setPlainText(build_asset_task_prompt(saved))
        QMessageBox.information(self, "已保存", "素材任务单已保存到 production_workbench/asset_tasks.jsonl")

    def copy_prompt(self) -> None:
        if not self.prompt.toPlainText().strip():
            self.render_prompt()
        QApplication.clipboard().setText(self.prompt.toPlainText())

    def run_codex_task(self) -> None:
        if self._codex_thread is not None and self._codex_thread.isRunning():
            QMessageBox.information(self, "正在执行", "当前已有一个 Codex 素材任务在执行。")
            return
        task = self._collect_task()
        if not task.request.strip():
            answer = QMessageBox.question(
                self,
                "确认执行",
                "具体要求为空，Codex 很可能不知道要做什么。仍然执行吗？",
            )
            if answer != QMessageBox.StandardButton.Yes:
                return
        self.prompt.setPlainText("Codex 正在执行素材任务，请稍等...\n日志会自动保存到 production_workbench/asset_task_runs。")
        self.btn_run.setEnabled(False)
        self.btn_run.setText("Codex 执行中...")
        postprocess_options = self._auto_postprocess_options(task) if self.check_auto_postprocess.isChecked() else None
        thread = CodexAssetRunThread(self.project_root, task, postprocess_options, self)
        thread.progress.connect(self._on_codex_task_progress)
        thread.completed.connect(self._on_codex_task_completed)
        thread.failed.connect(self._on_codex_task_failed)
        thread.finished.connect(self._on_codex_task_finished)
        self._codex_thread = thread
        thread.start()

    def _on_codex_task_progress(self, message: str) -> None:
        current = self.prompt.toPlainText().rstrip()
        line = f"- {message}"
        self.prompt.setPlainText(f"{current}\n{line}" if current else line)

    def _on_codex_task_completed(self, result: object) -> None:
        text = format_codex_asset_run_result(result)  # type: ignore[arg-type]
        self.prompt.setPlainText(_with_saved_report_note(self.project_root, "asset-task-codex-run", text))

    def _on_codex_task_failed(self, message: str) -> None:
        self.prompt.setPlainText(
            _with_saved_report_note(self.project_root, "asset-task-codex-failed", f"Codex 执行失败:\n{message}")
        )

    def _on_codex_task_finished(self) -> None:
        self.btn_run.setEnabled(True)
        self.btn_run.setText("执行 Codex 并记录")
        if self._codex_thread is not None:
            self._codex_thread.deleteLater()
        self._codex_thread = None

    def _collect_task(self) -> AssetTask:
        refs = [
            line.strip()
            for line in self.edit_refs.toPlainText().splitlines()
            if line.strip()
        ]
        return AssetTask(
            title=self.edit_title.text(),
            category=str(_picker_line_value(self.edit_category, "illustration") or "illustration"),
            operation=str(_picker_line_value(self.edit_operation, "new") or "new"),
            target_path=self.edit_target.text(),
            output_dir=self.edit_output_dir.text(),
            reference_paths=refs,
            width=self.spin_width.value() or None,
            height=self.spin_height.value() or None,
            transparent=_picker_line_value(self.edit_transparent, None),
            frame_count=self.spin_frames.value() or None,
            style_notes=self.edit_style.toPlainText(),
            request=self.edit_request.toPlainText(),
            acceptance=self.edit_acceptance.toPlainText(),
        )

    def _auto_postprocess_options(self, task: AssetTask) -> AssetPostprocessOptions:
        normalized = task.normalized()
        return AssetPostprocessOptions(
            output_dir=normalized.output_dir,
            suffix="_ready",
            output_format="auto",
            resize_width=normalized.width,
            resize_height=normalized.height,
            keep_aspect=not (normalized.width and normalized.height),
            trim_transparent=normalized.transparent is True,
        )


class CodexProbeThread(QThread):
    completed = Signal(object)
    failed = Signal(str)

    def run(self) -> None:
        try:
            self.completed.emit(probe_codex())
        except Exception as exc:  # noqa: BLE001 - show probe failures inside the workbench.
            self.failed.emit(str(exc))


class CodexProbeTab(QWidget):
    def __init__(self, host: WorkbenchWindow) -> None:
        super().__init__(host)
        self.project_root = host.project_root
        self._probe_thread: CodexProbeThread | None = None
        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        self.btn_probe = QPushButton("运行 Codex 能力探针")
        self.btn_copy = QPushButton("复制探针结果")
        self.btn_probe.clicked.connect(self.run_probe)
        self.btn_copy.clicked.connect(self.copy_result)
        top.addWidget(self.btn_probe)
        top.addWidget(self.btn_copy)
        top.addStretch(1)
        layout.addWidget(_scrollable_toolbar(top))
        self.output_dock = host.console_dock("codex-probe", "Codex Probe Output")
        self.output = _inline_console_from_dock(self.output_dock)
        self.output.setPlaceholderText("检查 codex CLI、image_generation、app-server、图片 savedPath 事件和 token 用量事件。")
        layout.addWidget(self.output, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root

    def run_probe(self) -> None:
        if self._probe_thread is not None and self._probe_thread.isRunning():
            QMessageBox.information(self, "Codex 能力探针", "探针正在运行，请稍等。")
            return
        self.btn_probe.setEnabled(False)
        self.btn_probe.setText("探测中...")
        self.output.setPlainText("运行中...")
        thread = CodexProbeThread(self)
        self._probe_thread = thread
        thread.completed.connect(self._on_probe_completed)
        thread.failed.connect(self._on_probe_failed)
        thread.finished.connect(self._on_probe_finished)
        thread.start()

    def _on_probe_completed(self, result: object) -> None:
        text = format_probe_result(result)  # type: ignore[arg-type]
        self.output.setPlainText(_with_saved_report_note(self.project_root, "codex-probe", text))

    def _on_probe_failed(self, message: str) -> None:
        text = f"Codex 能力探针执行失败:\n{message}"
        self.output.setPlainText(_with_saved_report_note(self.project_root, "codex-probe-failed", text))

    def _on_probe_finished(self) -> None:
        if self._probe_thread is not None:
            self._probe_thread.deleteLater()
            self._probe_thread = None
        self.btn_probe.setEnabled(True)
        self.btn_probe.setText("运行 Codex 能力探针")

    def copy_result(self) -> None:
        QApplication.clipboard().setText(self.output.toPlainText())


def _field_with_buttons(editor: QTextEdit, buttons: list[tuple[str, Callable[[], None]]]) -> QWidget:
    box = QWidget()
    layout = QVBoxLayout(box)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.addWidget(editor)
    row = QHBoxLayout()
    row.setContentsMargins(0, 0, 0, 0)
    for label, callback in buttons:
        button = QPushButton(label)
        button.clicked.connect(lambda _checked=False, cb=callback: cb())
        row.addWidget(button)
    row.addStretch(1)
    layout.addLayout(row)
    return box


def _button_row(buttons: list[tuple[str, Callable[[], None]]]) -> QWidget:
    box = QWidget()
    row = QHBoxLayout(box)
    row.setContentsMargins(0, 0, 0, 0)
    for label, callback in buttons:
        button = QPushButton(label)
        button.clicked.connect(lambda _checked=False, cb=callback: cb())
        row.addWidget(button)
    row.addStretch(1)
    return box


def _scrollable_toolbar(row: QHBoxLayout) -> QScrollArea:
    box = QWidget()
    box.setLayout(row)
    row.setContentsMargins(0, 0, 0, 0)
    scroll = QScrollArea()
    scroll.setObjectName("workbenchScrollableToolbar")
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.Shape.NoFrame)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
    scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    scroll.setWidget(box)
    # Keep the toolbar compact while still exposing overflowing buttons.
    scroll.setFixedHeight(box.sizeHint().height() + 18)
    return scroll


def _with_saved_report_note(project_root: Path, category: str, text: str) -> str:
    if not text.strip():
        return text
    try:
        path = save_workbench_report(project_root, category, text)
    except Exception as exc:  # noqa: BLE001 - report display should survive logging failures
        return f"{text}\n\n报告自动保存失败: {exc}"
    return f"{text}\n\n报告已自动保存: {_display_path(project_root, path)}"


def _open_local_path(parent: QWidget, path: Path, title: str) -> bool:
    target = path.resolve()
    if not target.exists():
        QMessageBox.warning(parent, title, f"文件不存在:\n{target}")
        return False
    if target.is_file() and _open_file_in_vscode(target):
        return True
    if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(target))):
        QMessageBox.warning(parent, title, f"无法打开:\n{target}")
        return False
    return True


def _open_path_system(parent: QWidget, path: Path, title: str) -> bool:
    target = path.resolve()
    if not target.exists():
        QMessageBox.warning(parent, title, f"路径不存在:\n{target}")
        return False
    if not QDesktopServices.openUrl(QUrl.fromLocalFile(str(target))):
        QMessageBox.warning(parent, title, f"无法打开:\n{target}")
        return False
    return True


def _open_file_in_vscode(path: Path) -> bool:
    code = shutil.which("code")
    if not code:
        return False
    try:
        subprocess.Popen(  # noqa: S603 - local editor launch with explicit argv
            [code, str(path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    return True


def _small_button(label: str, callback: Callable[[], None]) -> QPushButton:
    button = QPushButton(label)
    button.clicked.connect(lambda _checked=False: callback())
    return button


def _readonly_picker_line(placeholder: str = "点右侧按钮选择") -> QLineEdit:
    line = QLineEdit()
    line.setReadOnly(True)
    line.setPlaceholderText(placeholder)
    return line


def _raw_picker_item(value: Any, label: str = "", detail: str = "", keywords: str = "") -> dict[str, Any]:
    if label:
        label_text = str(label).strip()
    elif value is None:
        label_text = "不指定"
    else:
        label_text = str(value).strip()
    return {
        "value": value,
        "label": label_text,
        "detail": str(detail or "").strip(),
        "keywords": str(keywords or "").strip(),
    }


def _set_picker_line_value(line: QLineEdit, items: list[dict[str, Any]], value: Any) -> None:
    selected = next((item for item in items if item.get("value") == value), None)
    if selected is None:
        selected = _raw_picker_item(value, str(value or ""))
    label = str(selected.get("label") or selected.get("value") or "")
    detail = str(selected.get("detail") or "")
    line.setText(label)
    line.setToolTip(detail)
    line.setProperty("pickerValue", selected.get("value"))


def _pick_item_dialog(
    parent: QWidget,
    title: str,
    items: list[dict[str, Any]],
    *,
    empty_message: str = "没有可选项。",
) -> dict[str, Any] | None:
    if not items:
        QMessageBox.warning(parent, title, empty_message)
        return None
    dialog = SearchPickerDialog(title, items, parent)
    if dialog.exec() != QDialog.DialogCode.Accepted:
        return None
    return dialog.selected


def _picker_line_value(line: QLineEdit, default: Any = "") -> Any:
    value = line.property("pickerValue")
    if value is None and not line.text().strip():
        return default
    return value


def _pick_line_value(parent: QWidget, title: str, line: QLineEdit, items: list[dict[str, Any]]) -> bool:
    if not items:
        QMessageBox.warning(parent, title, "没有可选项。")
        return False
    dialog = SearchPickerDialog(title, items, parent)
    current_value = _picker_line_value(line, None)
    for row, item in enumerate(items):
        if item.get("value") == current_value:
            dialog.list.setCurrentRow(row)
            break
    if dialog.exec() != QDialog.DialogCode.Accepted or dialog.selected is None:
        return False
    _set_picker_line_value(line, items, dialog.selected.get("value"))
    return True


def _output_format_items() -> list[dict[str, Any]]:
    return [
        _raw_picker_item("auto", "按扩展名", "保持输出文件扩展名对应的格式。"),
        _raw_picker_item("png", "PNG（保透明）", "需要透明背景、像素图或 UI 图时优先用。"),
        _raw_picker_item("jpeg", "JPEG（白底）", "不需要透明、偏照片或大背景图时可用。"),
        _raw_picker_item("webp", "WebP", "体积更小，适合网页运行时资源。"),
    ]


def _candidate_review_items() -> list[dict[str, Any]]:
    return [
        _raw_picker_item(status, review_status_label(status), f"candidate review status: {status}")
        for status in REVIEW_STATUSES
    ]


def _asset_category_items() -> list[dict[str, Any]]:
    return [
        _raw_picker_item(category, category, "素材分类；会影响默认目录、尺寸和风格参考。")
        for category in ASSET_CATEGORIES
    ]


def _asset_operation_items() -> list[dict[str, Any]]:
    return [
        _raw_picker_item(operation, operation, "素材任务类型；用于告诉 Codex 是新建、重抽还是修改。")
        for operation in OPERATIONS
    ]


def _transparent_items() -> list[dict[str, Any]]:
    return [
        _raw_picker_item(None, "不指定", "不强制透明要求。"),
        _raw_picker_item(True, "需要透明", "角色、道具、UI 等需要透明底的素材。"),
        _raw_picker_item(False, "不需要透明", "场景背景或不透明插图。"),
    ]


def _unit_type_items() -> list[dict[str, str]]:
    return [
        _picker_item("主线", "主线", "主线推进必经剧情。"),
        _picker_item("支线", "支线", "可选但有完整入口/出口/验收的剧情。"),
        _picker_item("小情景", "小情景", "短互动、局部事件或场景小流程。"),
        _picker_item("结局", "结局", "结局、分支结算或收束段落。"),
        _picker_item("系统验证", "系统验证", "专门用来验证系统能力的流程。"),
    ]


def _production_status_items() -> list[dict[str, str]]:
    details = {
        "未做": "还没开始，不要求入口/出口/验收。",
        "制作中": "正在写内容，可以有 warning，不进入严格验收。",
        "可玩": "内容已有初步入口和出口，但还没正式验收。",
        "待验收": "必须补齐入口、出口、通过标准和验收路线，保存时会严格检查。",
        "通过": "必须最近一次验收通过。",
        "冻结": "通过后冻结，默认不再改。",
    }
    return [_picker_item(status, status, details.get(status, "")) for status in PRODUCTION_STATUSES]


def _script_status_items() -> list[dict[str, str]]:
    return [
        _picker_item("未跑", "未跑", "还没有跑验收。"),
        _picker_item("通过", "通过", "最近一次验收通过。"),
        _picker_item("失败", "失败", "最近一次验收失败，需要复制报告修。"),
        _picker_item("阻塞", "阻塞", "无法验收，存在外部阻塞。"),
    ]


def _graph_composition_items(report: GraphDiagnosticsReport, *, include_all: bool = True) -> list[dict[str, Any]]:
    items = [_raw_picker_item("", "全部", "显示所有剧情单元的 Graph 诊断。")] if include_all else []
    for comp in report.compositions:
        label = f"{comp.label} ({comp.composition_id})"
        detail = f"compositionId: {comp.composition_id}"
        if comp.issue_count:
            detail += f"\n问题数: {comp.issue_count}"
        items.append(_raw_picker_item(comp.composition_id, label, detail, f"{comp.label} {comp.composition_id}"))
    return items


def _pick_source_item(parent: QWidget, project_root: Path, unit: StoryUnit) -> dict[str, Any] | None:
    return _pick_item_dialog(
        parent,
        "打开当前剧情单元相关源文件",
        _story_unit_source_items(project_root, unit),
        empty_message="没有可打开的源文件。",
    )


def _story_unit_source_items(project_root: Path, unit: StoryUnit) -> list[dict[str, Any]]:
    data_root = project_root / "public" / "assets" / "data"
    items: list[dict[str, Any]] = []
    seen_paths: set[Path] = set()

    def add(path: Path, label: str, detail: str, keywords: str = "") -> None:
        if not path.exists():
            return
        resolved = path.resolve()
        if resolved in seen_paths:
            return
        seen_paths.add(resolved)
        display = _display_path(project_root, path)
        item = _raw_picker_item(display, label, f"{detail}\n{display}", keywords)
        item["path"] = resolved
        items.append(item)

    add(
        story_units_path(project_root),
        "剧情单元追踪记录",
        f"compositionId: {unit.record.composition_id}",
        f"story unit {unit.record.composition_id} {unit.record.display_name}",
    )
    graph_keywords = " ".join([unit.record.composition_id, *unit.summary.graph_ids, *unit.summary.signals, *unit.summary.states])
    add(
        data_root / "narrative_graphs.json",
        "Narrative Graph 数据",
        "当前剧情单元的 composition / graph / state / signal 都在这里。",
        graph_keywords,
    )
    for dialogue_id, path in _dialogue_source_paths(project_root).items():
        if dialogue_id in set(unit.summary.dialogues):
            add(
                path,
                f"Dialogue: {dialogue_id}",
                f"dialogue graph: {dialogue_id}",
                f"dialogue {dialogue_id}",
            )
    scenes = _scene_source_records(project_root)
    for scene_id in _story_unit_scene_ids(unit, scenes):
        record = scenes.get(scene_id)
        if record:
            add(
                record["path"],
                f"Scene: {scene_id}",
                f"scene: {scene_id}",
                f"scene {scene_id}",
            )
    if unit.summary.quests:
        add(data_root / "quests.json", "Quest 数据", "涉及 quest: " + ", ".join(unit.summary.quests), " ".join(unit.summary.quests))
    if unit.summary.scenarios:
        add(
            data_root / "scenarios.json",
            "Scenario 数据",
            "涉及 scenario: " + ", ".join(unit.summary.scenarios),
            " ".join(unit.summary.scenarios),
        )
    for asset in unit.summary.assets:
        path = (project_root / asset).resolve()
        if path.exists():
            add(path, f"素材: {Path(asset).name}", f"asset: {asset}", f"asset {asset}")
    return items


def _scene_source_records(project_root: Path) -> dict[str, dict[str, Any]]:
    root = project_root / "public" / "assets" / "scenes"
    out: dict[str, dict[str, Any]] = {}
    if not root.is_dir():
        return out
    from tools.editor.file_io import read_json

    for path in sorted(root.glob("*.json")):
        try:
            data = read_json(path)
        except Exception:  # noqa: BLE001
            data = {}
        if not isinstance(data, dict):
            data = {}
        scene_id = str(data.get("id") or path.stem).strip()
        if scene_id:
            out.setdefault(scene_id, {"path": path, "data": data})
        out.setdefault(path.stem, {"path": path, "data": data})
    return out


def _story_unit_scene_ids(unit: StoryUnit, scene_records: dict[str, dict[str, Any]]) -> list[str]:
    scene_ids: set[str] = set()
    all_text = "\n".join(_story_unit_reference_texts(unit))
    for match in re.finditer(r"\bscene:([^\s,;]+)", all_text):
        scene_id = match.group(1).strip().strip("\"'")
        if scene_id in scene_records:
            scene_ids.add(scene_id)
    for match in re.finditer(r"\b([A-Za-z0-9_\-\u4e00-\u9fff]+)\.([A-Za-z0-9_\-\u4e00-\u9fff]+)", all_text):
        scene_id = match.group(1).strip()
        if scene_id in scene_records:
            scene_ids.add(scene_id)

    npc_ids = set(re.findall(r"\bnpc:([^\s,;]+)", all_text))
    hotspot_ids = set(re.findall(r"\bhotspot:([^\s,;]+)", all_text))
    zone_ids = {str(value).strip() for value in unit.summary.zones if str(value).strip()}
    for scene_id, record in scene_records.items():
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if _scene_contains_any_ref(data, npc_ids=npc_ids, hotspot_ids=hotspot_ids, zone_ids=zone_ids):
            scene_ids.add(scene_id)
    return sorted(scene_ids, key=str.lower)


def _story_unit_reference_texts(unit: StoryUnit) -> list[str]:
    script = unit.record.acceptance_script
    return [
        unit.record.entry,
        unit.record.exit,
        unit.record.acceptance,
        script.start_entry,
        script.save_load_check,
        *script.setup_flags,
        *script.setup_quests,
        *script.setup_scenarios,
        *script.setup_narrative_states,
        *script.actions,
        *script.option_choices,
        *script.expected_signals,
        *script.expected_narrative_states,
        *script.expected_quest_changes,
        *script.expected_scenario_changes,
    ]


def _scene_contains_any_ref(
    scene: dict[str, Any],
    *,
    npc_ids: set[str],
    hotspot_ids: set[str],
    zone_ids: set[str],
) -> bool:
    for npc in scene.get("npcs") or []:
        if isinstance(npc, dict) and str(npc.get("id") or npc.get("npcId") or "").strip() in npc_ids:
            return True
    for hotspot in scene.get("hotspots") or []:
        if isinstance(hotspot, dict) and str(hotspot.get("id") or "").strip() in hotspot_ids:
            return True
    for zone in scene.get("zones") or []:
        if isinstance(zone, dict) and str(zone.get("id") or "").strip() in zone_ids:
            return True
    return False


def _dialogue_source_paths(project_root: Path) -> dict[str, Path]:
    root = project_root / "public" / "assets" / "dialogues" / "graphs"
    out: dict[str, Path] = {}
    if not root.is_dir():
        return out
    from tools.editor.file_io import read_json

    for path in sorted(root.glob("*.json")):
        out.setdefault(path.stem, path)
        try:
            data = read_json(path)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(data, dict):
            graph_id = str(data.get("id") or "").strip()
            if graph_id:
                out.setdefault(graph_id, path)
    return out


def _build_acceptance_draft(unit: StoryUnit) -> dict[str, Any]:
    dialogue = _first_clean(unit.summary.dialogues)
    signal = _first_clean([x for x in unit.summary.signals if not x.startswith("__draft__")])
    state = _preferred_state_ref(unit.summary.states)
    quest = _first_clean(unit.summary.quests)

    actions: list[str] = []
    start_entry = f"dialogue:{dialogue}" if dialogue else ""
    if start_entry:
        actions.append("走完对话")
    elif signal:
        actions.append(f"signal:{signal}")

    expected_signals = [signal] if signal else []
    expected_states = [state] if state else []
    expected_quests = [f"{quest} active"] if quest else []
    return {
        "startEntry": start_entry,
        "actions": actions,
        "expectedSignals": expected_signals,
        "expectedStates": expected_states,
        "expectedQuests": expected_quests,
        "saveLoadCheck": "人工确认存读档",
    }


def _planner_self_check_report(project_root: Path, unit: StoryUnit) -> str:
    rec = unit.record
    script = rec.acceptance_script
    route_rows = _acceptance_rows_from_script(script)
    human_missing = []
    if not rec.unit_type.strip():
        human_missing.append("类型")
    if not rec.production_status.strip():
        human_missing.append("制作状态")
    if not rec.entry.strip():
        human_missing.append("剧情入口")
    if not rec.exit.strip():
        human_missing.append("剧情出口")
    if not rec.acceptance.strip():
        human_missing.append("通过标准")

    lines = [
        "当前单元自检",
        f"剧情单元: {rec.display_name or unit.summary.label} ({rec.composition_id})",
        f"状态: {rec.production_status or '未做'}",
        "",
        "1. 基本信息",
    ]
    if human_missing:
        lines.append("- 需要补: " + ", ".join(human_missing))
    else:
        lines.append("- 已补齐类型、状态、入口、出口、通过标准。")

    lines.extend(["", "2. 验收路线"])
    if route_rows:
        lines.append(f"- 已有 {len(route_rows)} 步。")
        lines.extend(f"- {row}" for row in route_rows[:8])
        if len(route_rows) > 8:
            lines.append(f"- 还有 {len(route_rows) - 8} 步未显示。")
    else:
        lines.append("- 还没有验收路线。")

    lines.extend(["", "3. 脚本检查"])
    static_ok = False
    if route_rows:
        try:
            report = check_story_unit_acceptance_script(project_root, unit)
        except Exception as exc:  # noqa: BLE001
            lines.append(f"- 检查失败: {exc}")
        else:
            static_ok = report.ok
            if report.ok:
                lines.append("- 通过。")
            else:
                lines.append(f"- 未通过: error={report.error_count}, warning={report.warning_count}")
                for issue in report.issues[:8]:
                    lines.append(f"- {issue.severity}: {issue.message}")
                if len(report.issues) > 8:
                    lines.append(f"- 还有 {len(report.issues) - 8} 条问题。")
    else:
        lines.append("- 未检查，因为还没有验收路线。")

    lines.extend(["", "4. 建议下一步"])
    if human_missing:
        lines.append("- 先补齐基本信息，尤其是剧情入口、剧情出口、通过标准。")
    elif not route_rows:
        draft = _build_acceptance_draft(unit)
        if draft["startEntry"] or draft["actions"] or draft["expectedSignals"] or draft["expectedStates"]:
            lines.append("- 点击“生成验收草稿”，然后人工确认路线是否符合真实玩法。")
        else:
            lines.append("- 用选择器手动添加验收起点、执行步骤和期望结果。")
    elif not static_ok:
        lines.append("- 按上面的脚本检查问题，修验收路线；修完再点“1. 检查脚本”。")
    elif rec.production_status in {"未做", "制作中", "可玩"}:
        lines.append("- 可以把制作状态切到“待验收”，然后启动游戏跑验收。")
        lines.append("- 运行 `npm run dev`，打开游戏页面，再点“2. 发送到游戏运行”。")
    elif rec.production_status == "待验收":
        lines.append("- 启动游戏并打开页面，然后点“2. 发送到游戏运行”。")
        lines.append("- 跑完后点“3. 完成并记录结果”。")
    elif rec.production_status in {"通过", "冻结"}:
        lines.append("- 这个单元已经是收口状态；除非要返工，否则不要改验收路线。")
    else:
        lines.append("- 当前状态不明确，先选择制作状态。")

    if script.last_run_status and script.last_run_status != "未跑":
        lines.append(f"- 最近验收结果: {script.last_run_status} {script.last_run_note}".rstrip())
    if rec.blockers:
        open_blockers = [b.text for b in rec.blockers if b.text.strip() and b.status != "resolved"]
        if open_blockers:
            lines.append("- 仍有阻塞: " + "；".join(open_blockers[:3]))
    return "\n".join(lines)


def _planner_workflow_guide(project_root: Path, unit: StoryUnit) -> str:
    rec = unit.record
    route_rows = _acceptance_rows_from_script(rec.acceptance_script)
    missing = []
    if not rec.unit_type.strip():
        missing.append("类型")
    if not rec.production_status.strip():
        missing.append("制作状态")
    if not rec.entry.strip():
        missing.append("剧情入口")
    if not rec.exit.strip():
        missing.append("剧情出口")
    if not rec.acceptance.strip():
        missing.append("通过标准")

    static_ok = False
    static_errors: list[str] = []
    if route_rows:
        try:
            report = check_story_unit_acceptance_script(project_root, unit)
        except Exception as exc:  # noqa: BLE001
            static_errors.append(f"脚本检查失败: {exc}")
        else:
            static_ok = report.ok
            static_errors.extend(issue.message for issue in report.issues if issue.severity == "error")

    actions: list[str] = []
    if missing:
        actions.append("在“1. 这个剧情单元是什么”里补齐: " + "、".join(missing) + "。")
    if not route_rows:
        draft = _build_acceptance_draft(unit)
        if draft["startEntry"] or draft["actions"] or draft["expectedSignals"] or draft["expectedStates"]:
            actions.append("点“生成验收草稿”（草稿可推断），然后检查验收路线是不是符合真实玩法。")
        else:
            actions.append("用选择器添加验收起点、步骤和期望结果；不要手写 ID。")
    elif static_errors:
        actions.append("点“1. 检查脚本”，按错误提示修验收路线。")
    elif rec.acceptance_script.last_run_status in {"失败", "阻塞"}:
        actions.append("先复盘最近一次验收失败/阻塞记录，确认缺的是脚本路线、游戏逻辑还是素材状态。")
        actions.append("复制当前单元报告给 Codex，先处理失败/阻塞原因。")
    elif static_ok and rec.production_status in {"未做", "制作中", "可玩", ""}:
        actions.append("如果内容已经能走通，把“制作状态”选择为“待验收”。")
    elif static_ok and rec.production_status == "待验收":
        actions.append("运行 `npm run dev` 并打开游戏页面。")
        actions.append("点“2. 发送到游戏运行”，到游戏里按路线完成操作。")
        actions.append("回到这里点“3. 完成并记录结果”。")
    elif rec.production_status in {"通过", "冻结"}:
        actions.append("这个单元已经收口；除非返工，否则只看报告，不改路线。")
    else:
        actions.append("先点“当前单元自检”，确认状态和脚本检查结果。")

    if rec.acceptance_script.last_run_status == "通过" and rec.production_status == "待验收":
        actions.append("最近验收已通过，可以把“制作状态”选择为“通过”或“冻结”。")

    lines = [
        "剧情单元操作向导",
        f"单元: {rec.display_name or unit.summary.label} ({rec.composition_id})",
        f"当前状态: {rec.production_status or '未做'} / 最近验收: {rec.acceptance_script.last_run_status or '未跑'}",
        "",
        "下一步:",
    ]
    lines.extend(f"{index}. {action}" for index, action in enumerate(actions, start=1))
    lines.extend([
        "",
        "当前摘要:",
        f"- 基本信息: {'缺 ' + '、'.join(missing) if missing else '已补齐'}",
        f"- 验收路线: {len(route_rows)} 步" if route_rows else "- 验收路线: 还没有",
    ])
    if route_rows:
        lines.append(f"- 脚本检查: {'通过' if static_ok else '未通过'}")
    if static_errors:
        lines.append("- 需要修的脚本错误:")
        lines.extend(f"  {index}. {message}" for index, message in enumerate(static_errors[:5], start=1))
    return "\n".join(lines)


def _acceptance_rows_from_script(script) -> list[str]:  # noqa: ANN001
    rows: list[str] = []
    if script.start_entry.strip():
        rows.append(f"[起点] {_acceptance_display_text('entry', script.start_entry)}")
    for field, phase, values in [
        ("setupFlags", "前置 flag", script.setup_flags),
        ("setupQuests", "前置 quest", script.setup_quests),
        ("setupScenarios", "前置 scenario", script.setup_scenarios),
        ("setupStates", "前置 state", script.setup_narrative_states),
        ("actions", "步骤", script.actions),
        ("options", "选项", script.option_choices),
        ("expectedSignals", "期望 signal", script.expected_signals),
        ("expectedStates", "期望 state", script.expected_narrative_states),
        ("expectedQuests", "期望 quest", script.expected_quest_changes),
        ("expectedScenarios", "期望 scenario", script.expected_scenario_changes),
    ]:
        for value in values:
            rows.append(f"[{phase}] {_acceptance_display_text(field, value)}")
    if script.save_load_check.strip():
        rows.append(f"[复查] {_acceptance_display_text('saveLoad', script.save_load_check)}")
    return rows


def _suggest_unit_type(unit: StoryUnit) -> str:
    label = f"{unit.record.display_name} {unit.summary.description}".lower()
    if unit.summary.quests:
        return "支线"
    if "主线" in label:
        return "主线"
    if "结局" in label:
        return "结局"
    return "小情景"


def _preferred_state_ref(states: list[str]) -> str:
    refs = [_state_ref_from_summary(value) for value in states]
    refs = [ref for ref in refs if ref]
    if not refs:
        return ""
    keywords = ["done", "complete", "completed", "finish", "finished", "end", "returned", "success"]
    for ref in refs:
        lower = ref.lower()
        if any(keyword in lower for keyword in keywords):
            return ref
    return refs[-1]


def _state_ref_from_summary(value: str) -> str:
    text = str(value or "").strip()
    if not text or "." not in text:
        return ""
    return text.split()[0].strip()


def _first_clean(values: list[str]) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _acceptance_display_text(field: str, raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    if field == "entry":
        return f"从这里开始: {text}"
    if field == "setupFlags":
        return f"设置 flag: {text}"
    if field == "setupQuests":
        return f"设置 quest: {text}"
    if field == "setupScenarios":
        return f"设置 scenario: {text}"
    if field == "setupStates":
        return f"设置 narrative state: {text}"
    if field == "actions":
        if text == "走完对话":
            return "走完当前对话"
        if text.startswith("scene:"):
            return f"切换场景: {text.removeprefix('scene:')}"
        if text.startswith("npc:"):
            return f"和 NPC 交互: {text.removeprefix('npc:')}"
        if text.startswith("hotspot:"):
            return f"触发热点: {text.removeprefix('hotspot:')}"
        if text.startswith("dialogue:"):
            return f"打开对话: {text.removeprefix('dialogue:')}"
        if text.startswith("signal:"):
            return f"发 signal: {text.removeprefix('signal:')}"
        if text.startswith("click:"):
            return f"点击坐标: {text.removeprefix('click:')}"
        if text.startswith("moveTo"):
            return f"移动到坐标: {text}"
        if text.startswith("path:"):
            return f"按路径移动: {text.removeprefix('path:')}"
        return text
    if field == "options":
        return f"选择对话选项: {text.removeprefix('option:')}"
    if field == "expectedSignals":
        return f"应该出现 signal: {text}"
    if field == "expectedStates":
        return f"应该到达 state: {text}"
    if field == "expectedQuests":
        return f"quest 应该变化: {text}"
    if field == "expectedScenarios":
        return f"scenario 应该变化: {text}"
    if field == "saveLoad":
        return f"验收后复查: {text}"
    return text


def _picker_item(value: str, label: str = "", detail: str = "", keywords: str = "") -> dict[str, str]:
    value = str(value or "").strip()
    return {
        "value": value,
        "label": str(label or value).strip(),
        "detail": str(detail or "").strip(),
        "keywords": str(keywords or "").strip(),
    }


def _scene_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for scene_id, scene in sorted(model.scenes.items()):
        if not isinstance(scene, dict):
            continue
        name = str(scene.get("name") or scene_id)
        width = scene.get("worldWidth", "")
        height = scene.get("worldHeight", "")
        detail = f"sceneId: {scene_id}"
        if width or height:
            detail += f"\n尺寸: {width} x {height}"
        out.append(_picker_item(scene_id, name, detail, f"scene {scene_id} {name}"))
    return out


def _spawn_items(model: ProjectModel, scene_id: str) -> list[dict[str, str]]:
    scene = model.scenes.get(scene_id) or {}
    out = [_picker_item("", "默认出生点", f"scene: {scene_id}")]
    raw = scene.get("spawnPoints")
    if isinstance(raw, dict):
        for key, point in sorted(raw.items()):
            detail = f"scene: {scene_id}"
            if isinstance(point, dict):
                detail += f"\nx: {point.get('x', '')}\ny: {point.get('y', '')}"
            out.append(_picker_item(str(key), str(key), detail, f"spawn {scene_id} {key}"))
    return out


def _npc_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for scene_id, scene in sorted(model.scenes.items()):
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            npc_id = str(npc.get("id") or npc.get("npcId") or "").strip()
            if not npc_id:
                continue
            label = str(npc.get("label") or npc.get("name") or npc_id)
            detail = f"scene: {scene_id}"
            if npc.get("x") is not None or npc.get("y") is not None:
                detail += f"\nx: {npc.get('x', '')}\ny: {npc.get('y', '')}"
            out.append(_picker_item(npc_id, label, detail, f"npc {scene_id} {npc_id} {label}"))
    return out


def _hotspot_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for scene_id, scene in sorted(model.scenes.items()):
        if not isinstance(scene, dict):
            continue
        for hotspot in scene.get("hotspots") or []:
            if not isinstance(hotspot, dict):
                continue
            hotspot_id = str(hotspot.get("id") or "").strip()
            if not hotspot_id:
                continue
            label = str(hotspot.get("label") or hotspot.get("type") or hotspot_id)
            detail = f"scene: {scene_id}\ntype: {hotspot.get('type', '')}"
            if hotspot.get("x") is not None or hotspot.get("y") is not None:
                detail += f"\nx: {hotspot.get('x', '')}\ny: {hotspot.get('y', '')}"
            data = hotspot.get("data")
            if isinstance(data, dict) and data.get("targetScene"):
                detail += f"\ntargetScene: {data.get('targetScene')}"
            out.append(_picker_item(hotspot_id, label, detail, f"hotspot {scene_id} {hotspot_id} {label}"))
    return out


def _dialogue_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for graph_id in model.all_dialogue_graph_ids():
        out.append(_picker_item(graph_id, graph_id, f"dialogue graph: {graph_id}", f"dialogue {graph_id}"))
    return out


def _dialogue_option_items(model: ProjectModel) -> list[dict[str, str]]:
    from tools.editor.file_io import read_json

    out: list[dict[str, str]] = []
    root = model.dialogues_path / "graphs"
    if not root.is_dir():
        return out
    for path in sorted(root.glob("*.json")):
        try:
            data = read_json(path)
        except Exception:  # noqa: BLE001
            continue
        nodes = data.get("nodes") if isinstance(data, dict) else {}
        if not isinstance(nodes, dict):
            continue
        graph_id = str(data.get("id") or path.stem)
        for node_id, node in nodes.items():
            if not isinstance(node, dict) or node.get("type") != "choice":
                continue
            options = node.get("options") or []
            if not isinstance(options, list):
                continue
            for index, option in enumerate(options):
                if not isinstance(option, dict):
                    continue
                text = _single_line(option.get("text") or option.get("id") or str(index))
                option_id = str(option.get("id") or index)
                detail = f"dialogue: {graph_id}\nnode: {node_id}\noptionId: {option_id}\nindex: {index}"
                out.append(_picker_item(text, text, detail, f"option {graph_id} {node_id} {option_id} {text}"))
    return out


def _zone_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for scene_id, scene in sorted(model.scenes.items()):
        if not isinstance(scene, dict):
            continue
        for zone in scene.get("zones") or []:
            if not isinstance(zone, dict):
                continue
            zone_id = str(zone.get("id") or "").strip()
            if not zone_id:
                continue
            label = str(zone.get("label") or zone.get("name") or zone_id)
            detail = f"scene: {scene_id}\nkind: {zone.get('zoneKind', 'standard')}"
            for key in ("x", "y", "width", "height"):
                if zone.get(key) is not None:
                    detail += f"\n{key}: {zone.get(key)}"
            out.append(_picker_item(zone_id, label, detail, f"zone {scene_id} {zone_id} {label}"))
    return out


def _asset_items(project_root: Path) -> list[dict[str, str]]:
    project_root = project_root.resolve()
    assets_root = project_root / "public" / "resources" / "runtime"
    if not assets_root.is_dir():
        assets_root = project_root / "public"
    if not assets_root.is_dir():
        return []
    out: list[dict[str, str]] = []
    for path in sorted(assets_root.rglob("*")):
        if not path.is_file() or not path.suffix:
            continue
        try:
            rel_path = path.relative_to(project_root).as_posix()
            size_bytes = path.stat().st_size
            category = classify_asset_path(project_root, path)
        except OSError:
            continue
        ext = path.suffix.lower().lstrip(".")
        detail = f"category: {category}\next: {ext}\nbytes: {size_bytes}"
        out.append(_picker_item(
            rel_path,
            path.name,
            detail,
            f"asset {category} {rel_path}",
        ))
    return out


def _signal_items(model: ProjectModel) -> list[dict[str, str]]:
    by_id: dict[str, dict[str, str]] = {}
    data = model.narrative_graphs if isinstance(model.narrative_graphs, dict) else {}
    raw_signals = data.get("signals")
    if isinstance(raw_signals, list):
        for item in raw_signals:
            if not isinstance(item, dict):
                continue
            signal_id = str(item.get("id") or "").strip()
            if not signal_id:
                continue
            by_id[signal_id] = _picker_item(
                signal_id,
                str(item.get("label") or signal_id),
                str(item.get("description") or "signal registry"),
                f"signal {signal_id}",
            )

    def visit_graph(graph: Any, owner: str) -> None:
        if not isinstance(graph, dict):
            return
        graph_id = str(graph.get("id") or owner).strip()
        for transition in graph.get("transitions", []) or []:
            if not isinstance(transition, dict):
                continue
            signal_id = str(transition.get("signal") or "").strip()
            if not signal_id:
                continue
            detail = f"graph: {graph_id}\ntransition: {transition.get('id', '')}"
            by_id.setdefault(signal_id, _picker_item(signal_id, signal_id, detail, f"signal {signal_id} {graph_id}"))

    for graph in data.get("graphs", []) or []:
        visit_graph(graph, "")
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id") or "")
        visit_graph(comp.get("mainGraph"), comp_id)
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            visit_graph(element.get("graph"), comp_id)
            meta = element.get("meta") if isinstance(element.get("meta"), dict) else {}
            for signal_id_raw in meta.get("emits", []) or []:
                signal_id = str(signal_id_raw).strip()
                if signal_id:
                    detail = f"composition: {comp_id}\nelement: {element.get('id', '')}"
                    by_id.setdefault(signal_id, _picker_item(signal_id, signal_id, detail, f"signal {signal_id} {comp_id}"))
    return [by_id[key] for key in sorted(by_id.keys(), key=str.lower)]


def _narrative_state_items(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    data = model.narrative_graphs if isinstance(model.narrative_graphs, dict) else {}

    def visit_graph(graph: Any, owner: str) -> None:
        if not isinstance(graph, dict):
            return
        graph_id = str(graph.get("id") or "").strip()
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        for state_id, state in states.items():
            sid = str(state_id).strip()
            if not graph_id or not sid:
                continue
            label = sid
            if isinstance(state, dict):
                label = str(state.get("label") or sid)
            value = f"{graph_id}.{sid}"
            detail = f"graph: {graph_id}\nstate: {sid}"
            if owner:
                detail += f"\nowner: {owner}"
            out.append(_picker_item(value, label, detail, f"state {value} {label} {owner}"))

    for graph in data.get("graphs", []) or []:
        visit_graph(graph, "")
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        owner = str(comp.get("label") or comp.get("id") or "")
        visit_graph(comp.get("mainGraph"), owner)
        for element in comp.get("elements", []) or []:
            if isinstance(element, dict):
                visit_graph(element.get("graph"), owner)
    return sorted(out, key=lambda item: item["value"].lower())


def _quest_items(model: ProjectModel) -> list[dict[str, str]]:
    return [
        _picker_item(quest_id, label, f"quest: {quest_id}", f"quest {quest_id} {label}")
        for quest_id, label in model.all_quest_ids()
    ]


def _scenario_items(model: ProjectModel) -> list[dict[str, str]]:
    scenarios = model.scenarios_catalog.get("scenarios") if isinstance(model.scenarios_catalog, dict) else []
    by_id: dict[str, dict[str, str]] = {}
    if isinstance(scenarios, list):
        for scenario in scenarios:
            if not isinstance(scenario, dict):
                continue
            scenario_id = str(scenario.get("id") or "").strip()
            if not scenario_id:
                continue
            label = str(scenario.get("title") or scenario.get("name") or scenario_id)
            by_id[scenario_id] = _picker_item(
                scenario_id,
                label,
                str(scenario.get("description") or f"scenario: {scenario_id}"),
                f"scenario {scenario_id} {label}",
            )
    for scenario_id in model.scenario_ids_ordered():
        by_id.setdefault(scenario_id, _picker_item(scenario_id, scenario_id, f"scenario: {scenario_id}"))
    return [by_id[key] for key in sorted(by_id.keys(), key=str.lower)]


def _scenario_phase_items(model: ProjectModel, scenario_id: str) -> list[dict[str, str]]:
    return [
        _picker_item(phase, phase, f"scenario: {scenario_id}\nphase: {phase}", f"scenario phase {scenario_id} {phase}")
        for phase in model.phases_for_scenario(scenario_id)
    ]


def _flag_items(model: ProjectModel) -> list[dict[str, str]]:
    flags = set(model.all_flags())
    try:
        flags.update(model.registry_flag_choices())
    except Exception:  # noqa: BLE001
        pass
    return [
        _picker_item(flag, flag, "flag registry / project reference", f"flag {flag}")
        for flag in sorted(flags, key=str.lower)
        if str(flag).strip()
    ]


def _single_line(value: Any) -> str:
    return " ".join(str(value or "").split())


def _scene_background_pixmap(project_root: Path, scene_id: str, scene: dict[str, Any]) -> tuple[QPixmap, str]:
    path = _resolve_scene_background_path(project_root, scene_id, scene)
    if path is not None:
        pixmap = QPixmap(str(path))
        if not pixmap.isNull():
            return pixmap, _display_path(project_root, path)
    width = int(float(scene.get("worldWidth") or 1000))
    height = int(float(scene.get("worldHeight") or 800))
    pixmap = QPixmap(max(320, min(width, 1600)), max(240, min(height, 1200)))
    pixmap.fill(QColor("#2b2b2b"))
    return pixmap, ""


def _resolve_scene_background_path(project_root: Path, scene_id: str, scene: dict[str, Any]) -> Path | None:
    raw = ""
    backgrounds = scene.get("backgrounds")
    if isinstance(backgrounds, list):
        for item in backgrounds:
            if isinstance(item, dict) and item.get("image"):
                raw = str(item.get("image") or "")
                break
    if not raw:
        raw = str(scene.get("background") or "")
    candidates: list[Path] = []
    if raw:
        normalized = raw.replace("\\", "/")
        if normalized.startswith("/"):
            candidates.append(project_root / "public" / normalized.lstrip("/"))
        else:
            candidates.extend([
                project_root / "public" / "resources" / "runtime" / "scenes" / scene_id / normalized,
                project_root / "public" / "assets" / "scenes" / scene_id / normalized,
                project_root / "public" / "assets" / "scenes" / normalized,
            ])
    candidates.append(project_root / "public" / "resources" / "runtime" / "scenes" / scene_id / "background.png")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _fmt_num(value: float) -> str:
    text = f"{float(value):.1f}"
    return text[:-2] if text.endswith(".0") else text


def _fmt_point(x: float, y: float) -> str:
    return f"{_fmt_num(x)},{_fmt_num(y)}"


def _text_edit(height: int) -> QTextEdit:
    w = QTextEdit()
    w.setAcceptRichText(False)
    w.setMinimumHeight(height)
    return w


def _hint_label(text: str) -> QLabel:
    label = QLabel(text)
    label.setWordWrap(True)
    return label


def _text_lines(widget: QTextEdit) -> list[str]:
    return [line.strip() for line in widget.toPlainText().splitlines() if line.strip()]


def _append_text_edit_line(widget: QTextEdit, line: str) -> None:
    value = str(line or "").strip()
    if not value:
        return
    lines = _text_lines(widget)
    if value not in lines:
        lines.append(value)
    widget.setPlainText("\n".join(lines))


def _task_file_dialog_start(project_root: Path, raw: str) -> Path:
    text = str(raw or "").strip().strip('"')
    if text:
        path = Path(text)
        if not path.is_absolute():
            path = project_root / path
        return path.resolve()
    return (project_root / "public" / "resources" / "runtime").resolve()


def _image_spin() -> QSpinBox:
    spin = QSpinBox()
    spin.setRange(0, 100000)
    spin.setSingleStep(1)
    return spin


def _factor_spin() -> QDoubleSpinBox:
    spin = QDoubleSpinBox()
    spin.setRange(0.0, 3.0)
    spin.setSingleStep(0.05)
    spin.setDecimals(2)
    spin.setValue(1.0)
    return spin


def _line_with_button(line: QLineEdit, button: QPushButton) -> QWidget:
    row = QWidget()
    layout = QHBoxLayout(row)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.addWidget(line, 1)
    layout.addWidget(button)
    return row


def _display_path(project_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return str(path)
