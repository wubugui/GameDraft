"""Standalone window and save lifecycle for the task orchestration editor."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QStatusBar,
    QToolBar,
    QTabWidget,
)

from tools.editor.project_model import ProjectModel
from tools.editor.editors.scene_editor import SceneEditor

from .compiler import pending_dialogue_stub_conflicts
from .editor import TaskOrchestrationEditor


class TaskOrchestrationWindow(QMainWindow):
    """Standalone host retained alongside the main-editor integrated page."""

    def __init__(self, model: ProjectModel | None = None, parent: Any | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("GameDraft · 任务编排")
        self.resize(1440, 900)
        self._model = model or ProjectModel()
        self._unsafe_load_anomalies: list[str] = []
        self._stale_projection_reason = ""
        self._switching_workspace_tab = False
        self._workspace_tabs = QTabWidget(self)
        self._editor = TaskOrchestrationEditor(self._model, self._workspace_tabs)
        self._scene_editor = SceneEditor(self._model, self._workspace_tabs)
        self._workspace_tabs.addTab(self._editor, "顶层任务编排")
        self._workspace_tabs.addTab(self._scene_editor, "场景实体布置")
        self._editor.status_message.connect(self._show_status)
        self._editor.scene_layout_requested.connect(self._open_scene_layout)
        self._wire_task_safety_protocol()
        self._workspace_tabs.currentChanged.connect(self._on_workspace_tab_changed)
        self.setCentralWidget(self._workspace_tabs)
        self.setStatusBar(QStatusBar(self))
        self._project_label = QLabel("未打开工程", self)
        self.statusBar().addPermanentWidget(self._project_label)
        self._build_toolbar()
        self._model.dirty_changed.connect(self._on_dirty_changed)
        if self._model.project_path is not None:
            root = Path(self._model.project_path)
            self._project_label.setText(str(root))
            self.setWindowTitle(f"GameDraft · 任务编排 · {root.name}")
            self._unsafe_load_anomalies = list(getattr(self._model, "load_anomalies", None) or [])
            self._workspace_tabs.setEnabled(not self._unsafe_load_anomalies)

    @property
    def model(self) -> ProjectModel:
        return self._model

    @property
    def editor(self) -> TaskOrchestrationEditor:
        return self._editor

    def _build_toolbar(self) -> None:
        toolbar = QToolBar("工程", self)
        toolbar.setMovable(False)
        self.addToolBar(Qt.ToolBarArea.TopToolBarArea, toolbar)
        open_action = QAction("打开工程", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.choose_project)
        save_action = QAction("全部保存", self)
        save_action.setShortcut(QKeySequence.StandardKey.Save)
        save_action.triggered.connect(self.save_all)
        reload_action = QAction("丢弃并重载", self)
        reload_action.setShortcut(QKeySequence.StandardKey.Refresh)
        reload_action.triggered.connect(self.reload_project)
        toolbar.addAction(open_action)
        toolbar.addAction(save_action)
        toolbar.addSeparator()
        toolbar.addAction(reload_action)
        toolbar.addSeparator()
        concurrency = QLabel("同一工程请勿与旧编辑器并发修改后同时保存", toolbar)
        concurrency.setToolTip(
            "工具能阻断磁盘文件在打开后发生的外部变化，但无法读取另一个进程尚未写盘的表单草稿。"
        )
        toolbar.addWidget(concurrency)

    def load_project(self, path: Path) -> bool:
        if self._model.project_path is not None and not self._guard_projection_safety("重载或切换工程"):
            return False
        root = Path(path).resolve()
        if not (root / "public" / "assets").is_dir():
            QMessageBox.warning(self, "不是 GameDraft 工程", f"目录缺少 public/assets：\n{root}")
            return False
        try:
            self._model.load_project(root)
        except Exception as error:
            QMessageBox.critical(
                self,
                "打开失败",
                f"工程载入失败，已保留打开前的全部内存状态：\n\n{error}",
            )
            return False
        self._rebuild_workspace_editors()
        self._stale_projection_reason = ""
        self._project_label.setText(str(root))
        self.setWindowTitle(f"GameDraft · 任务编排 · {root.name}")
        self._unsafe_load_anomalies = list(getattr(self._model, "load_anomalies", None) or [])
        if self._unsafe_load_anomalies:
            self._workspace_tabs.setEnabled(False)
            QMessageBox.warning(
                self,
                "工程载入有异常：编辑与保存已锁定",
                "检测到现有数据异常。为避免把降级载入结果写回，当前工程只显示项目路径，"
                "不能应用或保存；请先用原工具修复后重载：\n\n"
                + "\n".join(self._unsafe_load_anomalies[:20]),
            )
        else:
            self._workspace_tabs.setEnabled(True)
        self._show_status("工程已载入；界面由现有原生数据反向生成")
        return True

    def choose_project(self) -> None:
        start = str(self._model.project_path or Path.cwd())
        selected = QFileDialog.getExistingDirectory(self, "选择包含 public/assets 的工程根目录", start)
        if not selected:
            return
        target = Path(selected).resolve()
        if not (target / "public" / "assets").is_dir():
            QMessageBox.warning(self, "不是 GameDraft 工程", f"目录缺少 public/assets：\n{target}")
            return
        if not self._confirm_discard_or_save("打开另一工程"):
            return
        self.load_project(target)

    def reload_project(self) -> bool:
        if not self._guard_projection_safety("丢弃并重载"):
            return False
        path = self._model.project_path
        if path is None:
            return False
        # SceneEditor keeps property widgets/canvas edits in staging until its
        # close hook flushes them.  Flush before checking model.is_dirty so a
        # reload can never bypass those edits and silently discard them.
        if not self._scene_editor.confirm_close(self):
            return False
        if self._model.is_dirty or self._editor.has_pending_changes():
            answer = QMessageBox.question(
                self,
                "丢弃内存改动",
                "将丢弃本窗口尚未保存的全部原生数据改动，然后从磁盘重载。继续吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            if answer != QMessageBox.StandardButton.Yes:
                return False
        return self.load_project(Path(path))

    def save_all(self) -> bool:
        if self._model.project_path is None:
            QMessageBox.warning(self, "无法保存", "请先打开工程。")
            return False
        if not self._guard_projection_safety("保存"):
            return False
        if self._unsafe_load_anomalies:
            QMessageBox.critical(
                self,
                "保存已阻断：载入异常",
                "当前工程载入时存在异常，不能证明内存是磁盘数据的完整映像。"
                "请先用原工具修复，再点击“丢弃并重载”。",
            )
            return False
        try:
            if not self._scene_editor.flush_to_model():
                raise RuntimeError("场景实体布置页仍有未通过校验的编辑")
            self._editor.flush_to_model(for_save_all=True)
        except Exception as error:
            QMessageBox.warning(
                self,
                "保存已阻断：表单尚未应用",
                f"{error}\n\n本次没有写盘；表单和内存改动都仍保留。",
            )
            return False
        stub_conflicts = pending_dialogue_stub_conflicts(self._model)
        if stub_conflicts:
            QMessageBox.critical(
                self,
                "保存已阻断：对话副本 ID 被外部占用",
                "以下任务专用对话原本应是新文件，但现在磁盘上已经存在。"
                "若继续，ProjectModel 会跳过副本却保存其引用，因此本次严格阻断：\n\n"
                + "\n".join(stub_conflicts[:20])
                + "\n\n请更换副本 ID，或丢弃并重载后核对外部文件。",
            )
            return False
        try:
            changed = list(self._model.detect_external_changes() or [])
        except Exception as error:
            QMessageBox.critical(
                self,
                "保存已阻断",
                "无法确认磁盘文件是否被外部修改；本次没有写盘，内存改动仍保留。\n\n"
                f"{error}",
            )
            return False
        if changed:
            preview = "\n".join(changed[:20])
            more = f"\n…共 {len(changed)} 个文件" if len(changed) > 20 else ""
            answer = QMessageBox.question(
                self,
                "保存已阻断：检测到外部修改",
                "以下目标文件在本窗口打开后被其它进程修改。为避免覆盖，不能强行保存：\n\n"
                f"{preview}{more}\n\n是否丢弃本窗口改动并从磁盘重载？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            if answer == QMessageBox.StandardButton.Yes:
                return self.load_project(Path(self._model.project_path))
            return False
        try:
            dirty = sorted(getattr(self._model, "_dirty", set()))
            self._model.save_all()
        except Exception as error:
            QMessageBox.critical(
                self,
                "保存失败",
                "ProjectModel 的校验或两阶段写入拒绝了提交。磁盘不会留下半套文件；"
                "内存改动仍保留。\n\n"
                f"{error}",
            )
            return False
        self._editor.reload_refs_from_model()
        self._show_status("已通过同一个 ProjectModel.save_all 原子保存" + (f"：{'、'.join(dirty)}" if dirty else ""))
        return True

    def _confirm_discard_or_save(self, action: str) -> bool:
        if not self._guard_projection_safety(action):
            return False
        if not self._scene_editor.confirm_close(self):
            return False
        if not self._editor.confirm_close(self):
            return False
        if not self._model.is_dirty:
            return True
        answer = QMessageBox.question(
            self,
            action,
            "当前有尚未保存的原生数据改动。",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if answer == QMessageBox.StandardButton.Save:
            return self.save_all()
        return answer == QMessageBox.StandardButton.Discard

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802 - Qt API
        if self._confirm_discard_or_save("关闭任务编排工具"):
            event.accept()
        else:
            event.ignore()

    def _on_dirty_changed(self, dirty: bool) -> None:
        title = self.windowTitle().removesuffix(" ●")
        self.setWindowTitle(title + (" ●" if dirty else ""))

    def _show_status(self, message: str) -> None:
        self.statusBar().showMessage(str(message), 6000)

    def _pending_dialogue_stub_conflicts(self) -> list[str]:
        """Compatibility seam retained for existing callers/tests."""
        return pending_dialogue_stub_conflicts(self._model)

    def _rebuild_workspace_editors(self) -> None:
        old_editor = self._editor
        old_scene = self._scene_editor
        self._workspace_tabs.blockSignals(True)
        try:
            self._workspace_tabs.removeTab(self._workspace_tabs.indexOf(old_editor))
            self._workspace_tabs.removeTab(self._workspace_tabs.indexOf(old_scene))
            old_editor.deleteLater()
            old_scene.deleteLater()
            self._editor = TaskOrchestrationEditor(self._model, self._workspace_tabs)
            self._scene_editor = SceneEditor(self._model, self._workspace_tabs)
            self._workspace_tabs.addTab(self._editor, "顶层任务编排")
            self._workspace_tabs.addTab(self._scene_editor, "场景实体布置")
            self._editor.status_message.connect(self._show_status)
            self._editor.scene_layout_requested.connect(self._open_scene_layout)
            self._wire_task_safety_protocol()
            self._workspace_tabs.setCurrentWidget(self._editor)
        finally:
            self._workspace_tabs.blockSignals(False)

    def _open_scene_layout(self, scene_id: str, entity_kind: str, entity_id: str) -> None:
        self._workspace_tabs.setCurrentWidget(self._scene_editor)
        if scene_id:
            self._scene_editor.select_scene_by_id(scene_id)
        if not entity_id:
            return
        selector = getattr(self._scene_editor, f"select_{entity_kind}_by_id", None)
        if callable(selector):
            selector(entity_id, scene_id)

    def _on_workspace_tab_changed(self, index: int) -> None:
        if self._switching_workspace_tab or index != self._workspace_tabs.indexOf(self._editor):
            return
        try:
            if not self._scene_editor.flush_to_model():
                raise RuntimeError("场景实体布置页有尚未通过校验的修改")
        except Exception as error:
            QMessageBox.warning(self, "不能离开场景布置", str(error))
            self._switching_workspace_tab = True
            try:
                self._workspace_tabs.setCurrentWidget(self._scene_editor)
            finally:
                self._switching_workspace_tab = False
            return
        self._editor.refresh_reference_candidates_preserving_draft()

    def _wire_task_safety_protocol(self) -> None:
        self._editor.set_host_prepare_native_mutation(
            self._prepare_task_native_mutation,
        )
        self._editor.set_host_native_publish_failure(
            self._on_task_native_publish_failed,
        )
        self._editor.native_domains_changed.connect(
            self._on_task_native_domains_changed,
        )

    def _prepare_task_native_mutation(self) -> bool:
        if not self._guard_projection_safety("继续应用任务编排"):
            return False
        try:
            ok = self._scene_editor.flush_to_model()
        except Exception as error:
            QMessageBox.warning(self, "任务编排准备失败", str(error))
            return False
        if not ok:
            QMessageBox.warning(
                self,
                "任务编排准备失败",
                "场景实体布置页仍有未通过校验的修改；原修改已保留。",
            )
            return False
        return True

    def _on_task_native_domains_changed(self, raw_domains: object) -> None:
        domains = {
            str(domain)
            for domain in (
                raw_domains if isinstance(raw_domains, (set, list, tuple)) else []
            )
        }
        if "scene" not in domains:
            return
        try:
            self._scene_editor.reload_from_model()
        except Exception as error:  # noqa: BLE001 — stale Scene must fail closed
            self._lock_stale_projection(f"SceneEditor 重载失败：{error}")
            QMessageBox.critical(
                self,
                "任务已应用，但场景页重载失败",
                "为避免场景旧表单覆盖任务编排生成的数据，保存、关闭与重载均已锁定。"
                f"\n\n{error}",
            )

    def _on_task_native_publish_failed(
        self,
        domains: set[str],
        error: Exception,
    ) -> None:
        if "scene" in domains:
            self._lock_stale_projection(f"SceneEditor 重载通知失败：{error}")

    def _lock_stale_projection(self, reason: str) -> None:
        self._stale_projection_reason = str(reason)
        self._scene_editor.setEnabled(False)
        self._editor.setEnabled(False)

    def _guard_projection_safety(self, action: str) -> bool:
        publish_domains = self._editor.native_publish_failure_domains()
        if not self._stale_projection_reason and not publish_domains:
            return True
        details = self._stale_projection_reason
        if publish_domains:
            details += (
                ("\n" if details else "")
                + "Task 发布失败域："
                + "、".join(sorted(publish_domains))
                + "："
                + self._editor.native_publish_failure_reason()
            )
        QMessageBox.critical(
            self,
            f"{action}已阻断：编辑页数据投影失效",
            "任务编排已经改动原生内存，但无法证明场景页已同步。为避免旧表单覆盖或"
            f"丢失数据，当前窗口只保留现场。\n\n{details}",
        )
        return False
