"""场景编辑器撤销/重做控制器（P1，设计见 artifact/Design/场景编辑器Unity对齐-调研与影响半径-2026-07-17.md）。

命令模型对齐图对话编辑器 `_GraphStructureSnapshotCmd`（快照命令 + push 时首次 redo 跳过），
但按场景编辑器的 staging 双层结构收敛为「提交边界」语义：

- staging（当前编辑实体）与模型（其余实体）是两层真相，命令快照只认模型层；
- 任何 capture 进入前，先把未应用的 staging 提交为独立命令（flush_pending_as_command），
  保证每一次模型变更恰好落在一条命令里，不会被后续操作的 before 快照静默吞并；
- capture 嵌套（如 polygon 提交 handler 内部触发 item_selected 的 commit-on-leave）时，
  内层只做低层提交、不入栈——变更折叠进外层命令；
- 命令回放（restoring）期间一切 flush/capture 短路，杜绝「undo 过程中 push」。

快照 = copy.deepcopy(scene dict)：int/float 表示原样保留（数值往返保真），未知键随
deepcopy 完整往返（零丢失）。跨文件的重构操作（迁移/改名/安全删除）不入本栈——它们走
entity_refactor journal，执行后本栈清空，防止快照撤销跨过跨文件状态产生半份回退。
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from typing import TYPE_CHECKING

from PySide6.QtGui import QUndoCommand, QUndoStack

if TYPE_CHECKING:  # pragma: no cover - 仅类型提示
    from .scene_editor import SceneEditor


class SceneSnapshotCommand(QUndoCommand):
    """单场景整份快照命令：undo/redo = 场景 dict 回灌 + 编辑器按需重载。"""

    def __init__(
        self,
        editor: "SceneEditor",
        scene_id: str,
        label: str,
        before: dict | None,
        after: dict | None,
    ):
        super().__init__(label)
        self._editor = editor
        self._sid = scene_id
        self._before = before
        self._after = after
        # push 时 Qt 会立即调一次 redo()；调用方已就地完成本次变更，首次跳过
        # （与图对话编辑器 _GraphStructureSnapshotCmd 同法）。
        self._first_redo_skipped = False

    def redo(self) -> None:
        if not self._first_redo_skipped:
            self._first_redo_skipped = True
            return
        self._editor._apply_scene_snapshot(self._sid, self._after)

    def undo(self) -> None:
        self._editor._apply_scene_snapshot(self._sid, self._before)


class SceneUndoController:
    """持有 QUndoStack 并提供「提交边界」捕获原语。"""

    UNDO_LIMIT = 100

    def __init__(self, editor: "SceneEditor"):
        self._editor = editor
        self.stack = QUndoStack(editor)
        self.stack.setUndoLimit(self.UNDO_LIMIT)
        self._depth = 0
        self.restoring = False

    # ---- 快照原语 ----------------------------------------------------------

    def _scene_snapshot(self, sid: str) -> dict | None:
        sc = self._editor._model.scenes.get(sid)
        return copy.deepcopy(sc) if isinstance(sc, dict) else None

    def flush_pending_as_command(self, label: str = "应用属性编辑") -> None:
        """把未应用的 staging 编辑提交进模型，并作为独立命令入栈。

        替代离开路径上的裸 `_commit_pending_scene_edits()`：语义相同（提交），
        额外保证这次提交本身可撤销。restoring / 嵌套 capture 中降级为纯提交。
        """
        ed = self._editor
        if self.restoring:
            return
        props = getattr(ed, "_props", None)
        if props is None or not props.is_pending_dirty():
            return
        sid = ed._current_scene_id or ""
        if not sid or ed._model.scenes.get(sid) is None or self._depth > 0:
            ed._commit_pending_scene_edits()
            return
        before = self._scene_snapshot(sid)
        ed._commit_pending_scene_edits()
        after = self._scene_snapshot(sid)
        if before != after:
            self.stack.push(SceneSnapshotCommand(ed, sid, label, before, after))

    @contextmanager
    def capture(self, label: str, *, commit_before: bool = True):
        """把一段模型写入包成一条命令：进入时（可选）先 flush pending，出口统一
        提交 staging 并按 before/after diff 入栈；无变更不入栈。"""
        ed = self._editor
        sid = ed._current_scene_id or ""
        if self.restoring or not sid or ed._model.scenes.get(sid) is None:
            yield
            return
        if commit_before:
            self.flush_pending_as_command()
        before = self._scene_snapshot(sid)
        self._depth += 1
        try:
            yield
        finally:
            self._depth -= 1
            if not self.restoring:
                ed._commit_pending_scene_edits()
                if self._depth == 0:
                    after = self._scene_snapshot(sid)
                    if before != after:
                        self.stack.push(
                            SceneSnapshotCommand(ed, sid, label, before, after))

    def complete_deferred(
        self, sid: str, label: str, before: dict | None,
    ) -> None:
        """完结「按下时捕获 before」的延迟命令（拖拽手势专用）。

        live 拖拽期间坐标被连续写进 staging，release 时 staging 已是新值——
        before 必须取在手势起点（SceneCanvas.item_drag_press），这里补提交 + after 快照。
        """
        ed = self._editor
        if self.restoring or before is None:
            return
        if sid != (ed._current_scene_id or ""):
            return
        if self._depth > 0:
            # 理论防御：手势 release 落在某个 capture 内时只低层提交，折叠进外层命令
            ed._commit_pending_scene_edits()
            return
        ed._commit_pending_scene_edits()
        after = self._scene_snapshot(sid)
        if before != after:
            self.stack.push(SceneSnapshotCommand(ed, sid, label, before, after))

    def notice_external_scene_write(self, sid: str) -> None:
        """未命令化的模型直写（背景导入的文件副作用、picker 对话框写他场景等）发生后调用：
        若栈内存在针对该场景的命令，整栈清空——整场景快照命令跨过这类直写做 undo/redo
        会把直写静默回滚且 redo 找不回（审查 P1-A）。与跨文件重构清栈同法。"""
        if self.restoring:
            return
        sid = str(sid or "")
        if not sid:
            return
        for i in range(self.stack.count()):
            cmd = self.stack.command(i)
            if getattr(cmd, "_sid", "") == sid:
                self.stack.clear()
                return

    def clear(self) -> None:
        """跨文件重构（迁移/改名/安全删除/journal 撤销）后调用：快照撤销不得
        跨过引用网改写产生的多文件状态。"""
        self.stack.clear()
