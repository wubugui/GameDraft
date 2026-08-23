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
import weakref
from contextlib import contextmanager
from typing import TYPE_CHECKING

from PySide6.QtGui import QUndoCommand, QUndoStack

if TYPE_CHECKING:  # pragma: no cover - 仅类型提示
    from .scene_editor import SceneEditor


#: 本进程里活着的全部**场景撤销栈持有者**。用弱引用，页销毁后自动掉出。
#:
#: 成员不限于 `SceneUndoController` —— 新画布的 `SceneDocument` 持自己的 QUndoStack，
#: 同样要进来。判据是鸭子协议：有 `notice_external_scene_write(sid)` 即可。
#: **漏登记的后果是最危险的一种**：在一个画布改数据，到另一个画布按 Ctrl+Z 会用
#: 它的旧快照把改动静默回滚，且 redo 找不回。
_LIVE_CONTROLLERS: "weakref.WeakSet" = weakref.WeakSet()


def register_undo_owner(owner) -> None:
    """把一个撤销栈持有者登记进跨页知会。构造时调一次即可（弱引用，不必注销）。"""
    _LIVE_CONTROLLERS.add(owner)


def broadcast_external_scene_write(sid: str, *, origin: object = None) -> None:
    """知会**除 origin 外**的所有场景页：某个场景被它们栈外的力量改了。

    并存期（新老两个场景页同时活着）的核心防线。两个页各自持整场景快照、改同一份
    模型 dict，若不互相知会：在 A 页按 Ctrl+Z 会把 B 页刚做的改动**静默回滚，
    而且 redo 找不回**——因为 A 的 before 快照是在 B 改之前拍的。

    代价说清楚：**切页 = 另一个页的撤销栈清空**。这是并存期的必然代价，也是
    语义诚实的——总好过两个栈互撤。
    """
    sid = str(sid or "")
    if not sid:
        return
    for ctrl in list(_LIVE_CONTROLLERS):
        if ctrl is origin:
            continue
        try:
            ctrl.notice_external_scene_write(sid)
        except RuntimeError:
            # 宿主页已析构，但 Python 侧的控制器还没被 gc 掉：碰它的 QUndoStack
            # 会抛 "Internal C++ object already deleted"。这类僵尸直接摘掉。
            # **只吞 RuntimeError**——别的异常是真问题，必须冒出来。
            _LIVE_CONTROLLERS.discard(ctrl)


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
        # 并存期（新老两个场景页同时活着）必须互相知会，见 broadcast_external_scene_write
        _LIVE_CONTROLLERS.add(self)

    def _push(self, sid: str, cmd: QUndoCommand) -> None:
        """**唯一的入栈出口**：入栈后知会其它场景页。

        两个场景页各自持整场景快照，改同一份模型 dict。若不知会，在 A 页
        Ctrl+Z 会把 B 页的改动**静默回滚，且 redo 找不回** —— 与
        `notice_external_scene_write` 挡的是同一类事故，只是来源从"背景直写"
        变成了"另一个页"。
        """
        self.stack.push(cmd)
        broadcast_external_scene_write(sid, origin=self)

    # ---- 快照原语 ----------------------------------------------------------

    def _scene_snapshot(self, sid: str) -> dict | None:
        sc = self._editor._model.scenes.get(sid)
        return copy.deepcopy(sc) if isinstance(sc, dict) else None

    def flush_pending_as_command(self, label: str = "应用属性编辑") -> bool:
        """把未应用的 staging 编辑提交进模型，并作为独立命令入栈。

        替代离开路径上的裸 `_commit_pending_scene_edits()`：语义相同（提交），
        额外保证这次提交本身可撤销。restoring / 嵌套 capture 中降级为纯提交。
        """
        ed = self._editor
        if self.restoring:
            return True
        props = getattr(ed, "_props", None)
        if props is None or not props.is_pending_dirty():
            return True
        sid = ed._current_scene_id or ""
        if not sid or ed._model.scenes.get(sid) is None or self._depth > 0:
            return bool(ed._commit_pending_scene_edits())
        before = self._scene_snapshot(sid)
        if not ed._commit_pending_scene_edits():
            return False
        after = self._scene_snapshot(sid)
        if before != after:
            self._push(sid, SceneSnapshotCommand(ed, sid, label, before, after))
        return True

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
            # 调用方若要在失败时完全跳过 body，应在进入 capture 前显式调用并检查
            # flush_pending_as_command。这里仍 fail-safe：提交被拒时不制造错误快照。
            if not self.flush_pending_as_command():
                yield
                return
        before = self._scene_snapshot(sid)
        self._depth += 1
        try:
            yield
        finally:
            self._depth -= 1
            if not self.restoring:
                props = getattr(ed, "_props", None)
                blocked = bool(
                    props is not None
                    and getattr(props, "_group_commit_blocked", False)
                )
                committed = False if blocked else bool(ed._commit_pending_scene_edits())
                if committed and self._depth == 0:
                    after = self._scene_snapshot(sid)
                    if before != after:
                        self._push(
                            sid, SceneSnapshotCommand(ed, sid, label, before, after))

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
        if not ed._commit_pending_scene_edits():
            return
        after = self._scene_snapshot(sid)
        if before != after:
            self._push(sid, SceneSnapshotCommand(ed, sid, label, before, after))

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
