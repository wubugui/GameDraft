"""工具层 —— 手势的归属地，也是**唯一**构造命令的地方。

镜像 Tiled 的 `AbstractTool` / `ToolManager`。工具的铁律两条：

1. **工具不写数据。** 它只构造命令交给 Document。手势期间的实时反馈由视图
   预览（工具持自己的拖动状态），数据直到 release 才由命令写入一次。
   这样"拖到一半按 Esc 退不回原处"没有发生的余地 —— 数据压根没被改过。
2. **命中在工具里，用白名单。** 只有 `EntityItem` 且可见可用才算。
   覆盖物、内容贴图、参考框**默认就不参与**，不需要每加一个新覆盖物就去
   改一次命中代码（老画布正是这么一处处加 `isinstance` 排除的）。

工具之间**互不依赖**，所以可以一个一个做、一个一个验收。
"""
from __future__ import annotations

from typing import Iterable

from PySide6.QtCore import QObject, QPointF, Qt, Signal

from .changes import EntityRef
from .items import EntityItem

__all__ = ["AbstractTool", "ToolManager"]


class AbstractTool(QObject):
    """一个编辑工具（选择、移动、创建、多边形编辑…）。

    生命周期：`activated` → 若干次鼠标/键盘回调 → `deactivated`。
    默认实现全部为空，子类只覆盖自己关心的那几个。
    """

    #: 工具想让宿主刷新状态栏提示时发它
    status_text_changed = Signal(str)

    #: 供 `ToolManager` 做动作组与提示；子类覆盖
    tool_id = "abstract"
    display_name = "工具"
    status_hint = ""

    def __init__(self, document, renderer, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._doc = document
        self._renderer = renderer
        self._active = False
        #: 上一次方向键微移作用的选择（用于判断能不能并进同一条命令）
        self._nudge_sel: tuple = ()

    # ---- 生命周期 ----------------------------------------------------------

    @property
    def is_active(self) -> bool:
        return self._active

    def activate(self) -> None:
        self._active = True
        self.on_activated()
        if self.status_hint:
            self.status_text_changed.emit(self.status_hint)

    def deactivate(self) -> None:
        """**必须**能安全地在手势中途被调用：切工具不该留下半个手势。"""
        self.cancel_gesture()
        self._active = False
        self.on_deactivated()

    def on_activated(self) -> None:
        """子类钩子。"""

    def on_deactivated(self) -> None:
        """子类钩子。"""

    # ---- 输入（宿主画布转发过来）------------------------------------------

    def mouse_pressed(self, scene_pos: QPointF, button, modifiers) -> bool:
        """返回 True 表示"我处理了"，宿主不再做默认行为。"""
        return False

    def mouse_moved(self, scene_pos: QPointF, buttons, modifiers) -> bool:
        return False

    def mouse_released(self, scene_pos: QPointF, button, modifiers) -> bool:
        return False

    def mouse_double_clicked(self, scene_pos: QPointF, button, modifiers) -> bool:
        """**双击必须是一等公民。**

        老画布把双击插点写进了提示却没接线，长期没人发现 —— 因为画布的双击/右键
        路径**完全没有测试**。这里把它列进基类接口，就是为了让"有没有接"变成
        一个能被断言的问题。
        """
        return False

    #: 方向键微移的步长（世界单位）。按住 Shift 走 `NUDGE_STEP_FAST`。
    NUDGE_STEP = 1.0
    NUDGE_STEP_FAST = 10.0

    def key_pressed(self, key, modifiers) -> bool:
        """选择级快捷键在**基类**统一处理，工具只覆盖自己特有的那些。

        Esc / Delete / Ctrl+D / 方向键都不属于任何一个工具 —— 它们作用在
        "当前选择"上。放进基类是为了让"换个工具就没法删了"不可能发生：
        这几条此前一个调用点都没有（`delete_selected` / `duplicate_selected`
        是公开方法却没人调，状态栏还写着"方向键微移"），全靠这一处兑现。
        """
        if key == Qt.Key.Key_Escape and self.cancel_gesture():
            return True
        if key in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            return self._delete_selection()
        if (key == Qt.Key.Key_D
                and modifiers & Qt.KeyboardModifier.ControlModifier):
            return self._duplicate_selection()
        step = (self.NUDGE_STEP_FAST
                if modifiers & Qt.KeyboardModifier.ShiftModifier
                else self.NUDGE_STEP)
        delta = _NUDGE_DIR.get(key)
        if delta is not None:
            return self._nudge_selection(delta[0] * step, delta[1] * step)
        return False

    # 这三个是"作用在选择上"的动作，实现住在 tools_structure / tools_transform。
    # **函数级延迟导入**：那两个模块反过来要 import 本模块的 `AbstractTool`，
    # 模块级导入会成环。（把动作搬到基类文件里也能破环，但那样"增删"与"位移"
    # 的规则就散在两处了。）

    def _delete_selection(self) -> bool:
        from .tools_structure import delete_selected
        return delete_selected(self._doc)

    def _duplicate_selection(self) -> bool:
        from .tools_structure import duplicate_selected
        return duplicate_selected(self._doc)

    def _nudge_selection(self, dx: float, dy: float) -> bool:
        """方向键微移。连按由**命令合并**收成一条撤销记录。

        换了选择就起一条新命令 —— 否则"挪 A、改选 B、再挪 B"会并成一条，
        撤销一次把两个实体都退回去。
        """
        from .tools_transform import translate_entities
        sel = tuple(self._doc.selection)
        if not sel:
            return False
        mergeable = sel == self._nudge_sel
        self._nudge_sel = sel
        return translate_entities(self._doc, sel, dx, dy,
                                  mergeable=mergeable, label="微移")

    def cancel_gesture(self) -> bool:
        """中止进行中的手势并**原样回到起点**。返回是否真的中止了什么。

        因为工具不写数据，"回到起点"只是丢掉自己的拖动状态 + 让视图重画 ——
        不需要像老画布那样反算增量再回灌（那正是"Esc 退不回原处、坐标被截断成
        一位小数"的来源）。
        """
        return False

    # ---- 命中（白名单，统一出口）------------------------------------------

    def entities_at(self, scene_pos: QPointF, items: Iterable) -> list[EntityItem]:
        """落点下的实体图元，按 z 从高到低。**只认 `EntityItem`**。

        覆盖物（选中框、手柄、工具预览）与内容贴图不在白名单里，所以它们
        **结构上**不可能抢走点击 —— 不必逐个 isinstance 排除。
        """
        hits = [
            it for it in items
            if isinstance(it, EntityItem) and it.isVisible() and it.isEnabled()
        ]
        # z 相等时按**命中面积从小到大**兜底。装饰层图元的 z 全是同一个常量
        # （`Z_DECOR_BASE`），只按 z 排的话次序取决于图元账的迭代顺序 ——
        # 那是"上次谁被重建过"的副产物，同一个落点两次点击可能选中不同实体。
        # 面积小者优先也符合直觉：叠在大区域上的小把手应该先被选中。
        hits.sort(key=lambda it: (-it.zValue(), _pick_area(it)))
        return hits

    def hits_at(self, scene_pos: QPointF, items: Iterable) -> list[EntityItem]:
        """落点**真正命中**的实体图元（形状判定 + 手抖容差），次序同 `entities_at`。"""
        tol = self._renderer.pick_tolerance_world()
        return [it for it in self.entities_at(scene_pos, items)
                if it.pick_contains(scene_pos, tol)]

    def refs_at(self, scene_pos: QPointF, items: Iterable) -> list[EntityRef]:
        return [it.ref for it in self.entities_at(scene_pos, items)]


#: 方向键 → 单位位移
_NUDGE_DIR = {
    Qt.Key.Key_Left: (-1.0, 0.0),
    Qt.Key.Key_Right: (1.0, 0.0),
    Qt.Key.Key_Up: (0.0, -1.0),
    Qt.Key.Key_Down: (0.0, 1.0),
}


def _pick_area(item) -> float:
    try:
        rect = item.pick_rect()
    except Exception:      # 图元刚被移除等边界情况，不该让点选整条路径崩掉
        return float("inf")
    return abs(rect.width() * rect.height())


class ToolManager(QObject):
    """当前工具的持有者。同一时刻**恰好一个**工具是活的。

    互斥由这里保证，不靠 `QActionGroup` 的副作用 —— 动作组只负责 UI 的按钮状态，
    真正的"谁在处理输入"必须有一个明确的持有者，否则切工具时会出现两个工具
    都收到 release 的错位。
    """

    tool_changed = Signal(object)
    status_text_changed = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._tools: list[AbstractTool] = []
        self._current: AbstractTool | None = None

    def register(self, tool: AbstractTool) -> AbstractTool:
        self._tools.append(tool)
        tool.status_text_changed.connect(self.status_text_changed)
        return tool

    @property
    def tools(self) -> tuple[AbstractTool, ...]:
        return tuple(self._tools)

    @property
    def current(self) -> AbstractTool | None:
        return self._current

    def select(self, tool: AbstractTool | str | None) -> None:
        """切换当前工具。**先 deactivate 旧的再 activate 新的**，顺序不可颠倒 ——
        反过来会让旧工具的 `cancel_gesture` 在新工具已经接管输入之后才跑。"""
        target = self._resolve(tool)
        if target is self._current:
            return
        if self._current is not None:
            self._current.deactivate()
        self._current = target
        if target is not None:
            target.activate()
        self.tool_changed.emit(target)

    def _resolve(self, tool: AbstractTool | str | None) -> AbstractTool | None:
        if tool is None or isinstance(tool, AbstractTool):
            return tool
        for t in self._tools:
            if t.tool_id == tool:
                return t
        raise KeyError(f"未登记的工具：{tool}")

    # ---- 输入转发 ----------------------------------------------------------

    def mouse_pressed(self, pos, button, modifiers) -> bool:
        return bool(self._current and self._current.mouse_pressed(pos, button, modifiers))

    def mouse_moved(self, pos, buttons, modifiers) -> bool:
        return bool(self._current and self._current.mouse_moved(pos, buttons, modifiers))

    def mouse_released(self, pos, button, modifiers) -> bool:
        return bool(self._current and self._current.mouse_released(pos, button, modifiers))

    def mouse_double_clicked(self, pos, button, modifiers) -> bool:
        return bool(
            self._current and self._current.mouse_double_clicked(pos, button, modifiers))

    def key_pressed(self, key, modifiers) -> bool:
        return bool(self._current and self._current.key_pressed(key, modifiers))

    def cancel_gesture(self) -> bool:
        return bool(self._current and self._current.cancel_gesture())
