"""在场景地图上直接点选实体（NPC / 热点）的弹窗选择器。

**为什么不能是下拉**：全工程实体近 200 个，横跨几十个场景，塞进一个 QComboBox 违反
选择器铁律（大候选集一律弹窗）；更硬的是**同 id 跨场景重名**——`npc_dream_old_man`
在梦_农家院 / 梦_里屋 / 梦_饭屋 各有一个摆放，拉平去重后另外两个**根本选不到**。

所以本弹窗的返回值是 `(场景 id, 实体 id)` 二元组：选实体这个动作本来就是「在某个场景里
点某个人」，场景是这次选择的一半，不是另配的过滤条件。

刻意**排除 zone**：`all_scene_entity_ids()` 把 zone 也算实体，但运行时 `resolveEmoteTarget`
只认「过场演员 / NPC / player / 当前场景热点」——放 zone 进来等于放行一种"配了完全没反应"
的写法。
"""
from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPen
from shiboken6 import isValid as shiboken_is_valid
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QGraphicsEllipseItem,
    QGraphicsItem,
    QGraphicsSimpleTextItem,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .. import theme
from ..project_model import ProjectModel
from .dialog_geometry import remember_dialog_geometry
from .move_entity_map_picker import WorldPointPickView

ENTITY_KIND_NPC = "npc"
ENTITY_KIND_HOTSPOT = "hotspot"

# 画布标记色：与 move_entity_map_picker 同风格（底图是照片/厚涂背景，走固定高对比色，
# 不走 theme 的面板语义文字色——那套是给面板文字定的）。
_NPC_FILL = QColor(80, 160, 255, 215)
_HOTSPOT_FILL = QColor(255, 190, 90, 215)
_MARKER_EDGE = QPen(QColor(20, 20, 24, 220), 0)
_SELECTED_RING = QPen(QColor(255, 70, 90, 240), 0)
_HOVER_EDGE = QPen(QColor(255, 255, 255, 235), 0)
_LABEL_FILL = QColor(245, 245, 245)
_LABEL_SELECTED_FILL = QColor(255, 120, 140)
#: 没命中筛选的标记压到这个透明度（仍可点，只是让眼睛先看命中的那些）
_DIMMED_ALPHA = 55

_VALUE_ROLE = Qt.ItemDataRole.UserRole


def _npc_display_label(model: ProjectModel, npc: dict) -> str:
    """NPC 显示名：就地 name 优先，缺省从角色注册表继承（与运行时合并口径一致）。"""
    name = str(npc.get("name") or "").strip()
    if name:
        return name
    cid = str(npc.get("characterId") or "").strip()
    if cid:
        ch = (getattr(model, "character_registry", None) or {}).get(cid)
        if isinstance(ch, dict):
            inherited = str(ch.get("name") or "").strip()
            if inherited:
                return inherited
    return str(npc.get("id") or "")


def scene_speaker_entities(model: ProjectModel, scene_id: str) -> list[dict]:
    """某场景里可当头顶闲聊说话人的实体行：NPC + 热点，按场景声明序。

    每行 ``{"kind", "id", "label", "x", "y"}``。坏元素（非 dict / 缺 id）直接跳过，
    不改写、不报错——数据只读透传是编辑器侧的通用约束。
    """
    rows: list[dict] = []
    scenes = getattr(model, "scenes", None) or {}
    sc = scenes.get(scene_id)
    if not isinstance(sc, dict):
        return rows

    def _num(v: object) -> float:
        try:
            return float(v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 0.0

    for npc in sc.get("npcs") or []:
        if not isinstance(npc, dict):
            continue
        eid = str(npc.get("id") or "").strip()
        if not eid:
            continue
        rows.append({
            "kind": ENTITY_KIND_NPC, "id": eid,
            "label": _npc_display_label(model, npc),
            "x": _num(npc.get("x")), "y": _num(npc.get("y")),
        })
    for hs in sc.get("hotspots") or []:
        if not isinstance(hs, dict):
            continue
        eid = str(hs.get("id") or "").strip()
        if not eid:
            continue
        label = str(hs.get("label") or hs.get("name") or hs.get("type") or eid).strip() or eid
        rows.append({
            "kind": ENTITY_KIND_HOTSPOT, "id": eid, "label": label,
            "x": _num(hs.get("x")), "y": _num(hs.get("y")),
        })
    return rows


class SceneEntityPickView(WorldPointPickView):
    """场景底图 + 实体标记；左键点最近的实体即选中（不在任何实体附近＝不改选择）。"""

    entityPicked = Signal(str)

    #: 实体多到这个数以上就不再默认铺满标签——雾津街头有 53 个，全铺就是一团糊字，
    #: 反而比不画更难认人。超过阈值时只给「选中 / 悬停 / 命中筛选」的那几个上名字。
    LABEL_ALL_MAX = 16

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._rows: list[dict] = []
        self._dots: dict[str, QGraphicsEllipseItem] = {}
        self._labels: dict[str, QGraphicsSimpleTextItem] = {}
        self._selected: str = ""
        self._hovered: str = ""
        #: None＝没在筛选（全部算命中）；否则是命中筛选的实体 id 集合
        self._match: set[str] | None = None
        #: 首次显示前的 fitInView 是按"还没布局的小尺寸"算的，会开窗就是一张错缩放的图
        self._fitted_once = False
        self.setMouseTracking(True)

    def showEvent(self, event) -> None:  # noqa: ANN001 - 与基类签名一致
        super().showEvent(event)
        if not self._fitted_once:
            self._fitted_once = True
            self.fit_scene()

    def set_entities(self, rows: list[dict]) -> None:
        self._rows = list(rows)
        self._hovered = ""
        self._redraw_entities()

    def selected_entity(self) -> str:
        return self._selected

    def select_entity(self, entity_id: str, *, reveal: bool = False) -> None:
        """外部（列表 / 回填初值）设选中；不发 entityPicked，避免与调用方互相回弹。"""
        self._selected = str(entity_id or "")
        self._apply_emphasis()
        if reveal:
            self.reveal_entity(self._selected)

    def set_match_filter(self, matched: set[str] | None) -> None:
        """筛选联动：命中的照常画，没命中的压暗——地图跟着下面那个筛选框走。"""
        self._match = matched
        self._apply_emphasis()

    def reveal_entity(self, entity_id: str) -> None:
        dot = self._dots.get(str(entity_id or ""))
        if dot is not None:
            self.ensureVisible(dot, 60, 60)

    # ---- 绘制 --------------------------------------------------------------

    def _clear_entity_items(self) -> None:
        """丢掉上一批标记。

        ⚠ 这些图元**可能已经被 C++ 侧销毁**：换场景走的是 `setup_from_scene_json`
        → `clear_visual()` → `QGraphicsScene.clear()`，那一下整场图元全删，Python 包装器
        只剩空壳。碰空壳会抛 RuntimeError，而这异常发生在 Qt 槽里会被吞掉——表现是
        "地图从此一个标记都没有、实体列表还停在上一个场景"，且因为字典没清干净，
        之后每次重画都再炸一次，不可恢复。所以必须先验活、且**先清字典再谈别的**。
        """
        gfx = self.scene()
        for bag in (self._dots, self._labels):
            items = list(bag.values())
            bag.clear()
            for it in items:
                if gfx is None or not shiboken_is_valid(it):
                    continue
                if it.scene() is gfx:
                    gfx.removeItem(it)

    def _redraw_entities(self) -> None:
        # 先清（哪怕没有场景可画）：字典留着旧的一批空壳，下次重画照样碰死指针
        self._clear_entity_items()
        gfx = self.scene()
        if gfx is None:
            return
        rr = max(2.0, self.marker_radius_world())
        for row in self._rows:
            eid = str(row.get("id") or "")
            x, y = float(row.get("x") or 0.0), float(row.get("y") or 0.0)
            dot = QGraphicsEllipseItem(x - rr, y - rr, rr * 2, rr * 2)
            dot.setBrush(QBrush(_NPC_FILL if row.get("kind") == ENTITY_KIND_NPC else _HOTSPOT_FILL))
            dot.setPen(_MARKER_EDGE)
            dot.setZValue(40.0)
            dot.setCursor(Qt.CursorShape.PointingHandCursor)
            dot.setToolTip(f"{row.get('label') or eid}（{eid}）")
            gfx.addItem(dot)

            text = QGraphicsSimpleTextItem(str(row.get("label") or eid))
            text.setBrush(QBrush(_LABEL_FILL))
            # 标签不跟画布缩放：世界宽两千多、视口才几百，跟着缩就是一排看不清的糊点
            text.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
            theme.set_graphics_text_font(text, theme.FONT_ROLE_CANVAS_MICRO)
            text.setPos(x + rr, y - rr)
            text.setZValue(46.0)
            gfx.addItem(text)
            self._dots[eid] = dot
            self._labels[eid] = text
        self._apply_emphasis()

    def _apply_emphasis(self) -> None:
        """按「选中 / 悬停 / 命中筛选」重算每个标记的强调态（不重建图元）。"""
        label_all = len(self._rows) <= self.LABEL_ALL_MAX
        rr = max(2.0, self.marker_radius_world())
        for row in self._rows:
            eid = str(row.get("id") or "")
            dot, text = self._dots.get(eid), self._labels.get(eid)
            if dot is None or text is None:
                continue
            picked = bool(eid) and eid == self._selected
            hovered = bool(eid) and eid == self._hovered
            matched = self._match is None or eid in self._match
            base = _NPC_FILL if row.get("kind") == ENTITY_KIND_NPC else _HOTSPOT_FILL
            fill = QColor(base)
            if not matched:
                fill.setAlpha(_DIMMED_ALPHA)
            dot.setBrush(QBrush(fill))
            dot.setPen(_SELECTED_RING if picked else (_HOVER_EDGE if hovered else _MARKER_EDGE))
            dot.setZValue(45.0 if picked else (44.0 if hovered else 40.0))
            r = rr * (1.5 if picked else 1.0)
            x, y = float(row.get("x") or 0.0), float(row.get("y") or 0.0)
            dot.setRect(x - r, y - r, r * 2, r * 2)
            text.setPos(x + r, y - r)
            text.setBrush(QBrush(_LABEL_SELECTED_FILL if picked else _LABEL_FILL))
            text.setZValue(47.0 if picked or hovered else 46.0)
            text.setVisible(picked or hovered or (matched and (label_all or self._match is not None)))

    # ---- 交互 --------------------------------------------------------------

    def _nearest_entity(self, wx: float, wy: float) -> str:
        """够得着的最近实体 id；一个都够不着返回空串。"""
        reach = max(6.0, self.marker_radius_world() * 2.5)
        best_id, best_d2 = "", None
        for row in self._rows:
            dx = float(row.get("x") or 0.0) - wx
            dy = float(row.get("y") or 0.0) - wy
            d2 = dx * dx + dy * dy
            if best_d2 is None or d2 < best_d2:
                best_id, best_d2 = str(row.get("id") or ""), d2
        if best_d2 is None or best_d2 > reach * reach:
            return ""
        return best_id

    def _handle_left_pick_world(self, wx: float, wy: float) -> None:
        """左键：选中最近的实体。够不着任何实体时**保持原选择**——空白处误点不该清空。"""
        best_id = self._nearest_entity(wx, wy)
        if not best_id:
            return
        self.select_entity(best_id)
        self.entityPicked.emit(best_id)

    def mouseMoveEvent(self, event) -> None:  # noqa: ANN001 - 与基类签名一致
        # 悬停出名字：标签铺不满时，鼠标扫过就能认人（不必先点中）
        sp = self.mapToScene(event.pos())
        hit = self._nearest_entity(sp.x(), sp.y())
        if hit != self._hovered:
            self._hovered = hit
            self._apply_emphasis()
        super().mouseMoveEvent(event)


class SceneEntityPickerDialog(QDialog):
    """左选场景、右在地图上点实体；返回 (场景 id, 实体 id)。"""

    def __init__(
        self,
        model: ProjectModel,
        *,
        current_scene: str = "",
        current_entity: str = "",
        parent: QWidget | None = None,
        title: str = "选择场景实体",
        geometry_key: str = "scene_entity_picker",
    ) -> None:
        super().__init__(parent)
        self._model = model
        self.setWindowTitle(title)
        self.setMinimumSize(760, 480)
        self.resize(1080, 680)
        self._scene_id = str(current_scene or "").strip()
        self._entity_id = str(current_entity or "").strip()
        self._loading = False

        root = QVBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # --- 左：场景 ---
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        self._scene_filter = QLineEdit()
        self._scene_filter.setPlaceholderText("筛选场景…")
        self._scene_filter.setClearButtonEnabled(True)
        self._scene_filter.textChanged.connect(lambda _t: self._refill_scenes())
        ll.addWidget(self._scene_filter)
        self._scene_list = QListWidget()
        self._scene_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._scene_list.currentItemChanged.connect(self._on_scene_changed)
        ll.addWidget(self._scene_list, 1)

        # --- 右：地图 + 实体列表 ---
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        self._view = SceneEntityPickView()
        self._view.entityPicked.connect(self._on_canvas_picked)
        rl.addWidget(self._view, 3)

        tip = QLabel(
            "左键点标记选中实体，鼠标扫过出名字；中键拖动平移，Ctrl+滚轮缩放。"
            "蓝＝NPC，橙＝热点；下方筛选会把没命中的标记压暗。"
        )
        tip.setStyleSheet(theme.semantic_text_css("faint"))
        tip.setWordWrap(True)
        rl.addWidget(tip)

        self._entity_filter = QLineEdit()
        self._entity_filter.setPlaceholderText("筛选实体名 / id…")
        self._entity_filter.setClearButtonEnabled(True)
        self._entity_filter.textChanged.connect(lambda _t: self._refill_entities())
        rl.addWidget(self._entity_filter)
        self._entity_list = QListWidget()
        self._entity_list.setAlternatingRowColors(True)
        self._entity_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._entity_list.currentItemChanged.connect(self._on_entity_row_changed)
        self._entity_list.itemDoubleClicked.connect(lambda _i: self._accept_current())
        rl.addWidget(self._entity_list, 2)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([240, 840])
        root.addWidget(splitter, 1)

        self._summary = QLabel("")
        self._summary.setWordWrap(True)
        root.addWidget(self._summary)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        buttons.accepted.connect(self._accept_current)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)
        self._ok_button = buttons.button(QDialogButtonBox.StandardButton.Ok)

        remember_dialog_geometry(self, geometry_key)
        self._refill_scenes()
        self._sync_summary()

    # ---- 结果 --------------------------------------------------------------

    def selected(self) -> tuple[str, str]:
        """(场景 id, 实体 id)；两者恒同时有值或同时为空。"""
        return (self._scene_id, self._entity_id) if self._entity_id else ("", "")

    # ---- 场景列表 ----------------------------------------------------------

    def _refill_scenes(self) -> None:
        query = self._scene_filter.text().strip().casefold()
        scenes = getattr(self._model, "scenes", None) or {}
        self._loading = True
        self._scene_list.clear()
        for sid in sorted(scenes.keys()):
            rows = scene_speaker_entities(self._model, sid)
            sc = scenes.get(sid)
            display = str((sc or {}).get("name") or "").strip() if isinstance(sc, dict) else ""
            # 也按实体名/id 过滤：想找"那个婆子在哪个场景"时不用一个个点过去
            haystack = "\n".join(
                [sid, display] + [f"{r['id']}\n{r['label']}" for r in rows]).casefold()
            if query and query not in haystack:
                continue
            label = f"{sid}（{display}）" if display and display != sid else sid
            item = QListWidgetItem(f"{label}   ({len(rows)})")
            item.setData(_VALUE_ROLE, sid)
            self._scene_list.addItem(item)
            if sid == self._scene_id:
                self._scene_list.setCurrentItem(item)
        self._loading = False
        if self._scene_list.currentItem() is None and self._scene_list.count() > 0:
            self._scene_list.setCurrentRow(0)
        else:
            self._reload_scene_view()

    def _on_scene_changed(self, cur: QListWidgetItem | None, _prev: QListWidgetItem | None) -> None:
        if self._loading or cur is None:
            return
        sid = str(cur.data(_VALUE_ROLE) or "")
        if sid == self._scene_id:
            self._reload_scene_view()
            return
        self._scene_id = sid
        # 换场景＝原来那个实体不在这张图上了，选择作废（留着会写出"场景与实体对不上"的数据）
        self._entity_id = ""
        self._reload_scene_view()

    def _reload_scene_view(self) -> None:
        rows = scene_speaker_entities(self._model, self._scene_id) if self._scene_id else []
        if self._scene_id:
            self._view.setup_from_scene_json(self._model, self._scene_id)
        else:
            self._view.clear_visual()
        self._view.set_entities(rows)
        self._view.select_entity(self._entity_id)
        self._view.fit_scene()
        self._refill_entities()
        self._sync_summary()

    # ---- 实体列表 ----------------------------------------------------------

    def _refill_entities(self) -> None:
        query = self._entity_filter.text().strip().casefold()
        rows = scene_speaker_entities(self._model, self._scene_id) if self._scene_id else []
        matched: set[str] = set()
        self._loading = True
        self._entity_list.clear()
        for row in rows:
            eid = str(row.get("id") or "")
            label = str(row.get("label") or eid)
            kind = "NPC" if row.get("kind") == ENTITY_KIND_NPC else "热点"
            if query and query not in f"{eid}\n{label}".casefold():
                continue
            matched.add(eid)
            item = QListWidgetItem(f"[{kind}] {label}  ({eid})" if label != eid else f"[{kind}] {eid}")
            item.setData(_VALUE_ROLE, eid)
            self._entity_list.addItem(item)
            if eid == self._entity_id:
                self._entity_list.setCurrentItem(item)
        self._loading = False
        # 地图跟着筛选走：没命中的压暗，命中的直接把名字铺出来
        self._view.set_match_filter(matched if query else None)

    def _on_entity_row_changed(self, cur: QListWidgetItem | None, _prev: QListWidgetItem | None) -> None:
        if self._loading or cur is None:
            return
        self._entity_id = str(cur.data(_VALUE_ROLE) or "")
        # 从列表选人时把他滚进视野——否则大场景里选完还得自己去地图上找
        self._view.select_entity(self._entity_id, reveal=True)
        self._sync_summary()

    def _on_canvas_picked(self, entity_id: str) -> None:
        self._entity_id = str(entity_id or "")
        self._loading = True
        for i in range(self._entity_list.count()):
            it = self._entity_list.item(i)
            if str(it.data(_VALUE_ROLE) or "") == self._entity_id:
                self._entity_list.setCurrentItem(it)
                break
        self._loading = False
        self._sync_summary()

    # ---- 收尾 --------------------------------------------------------------

    def _sync_summary(self) -> None:
        if self._entity_id and self._scene_id:
            self._summary.setText(f"已选：{self._scene_id} / {self._entity_id}")
            self._summary.setStyleSheet(theme.semantic_text_css("ok"))
        else:
            self._summary.setText("还没选实体：在地图上点一个标记，或在下方列表里选。")
            self._summary.setStyleSheet(theme.semantic_text_css("muted"))
        if self._ok_button is not None:
            self._ok_button.setEnabled(bool(self._entity_id and self._scene_id))

    def _accept_current(self) -> None:
        if not (self._entity_id and self._scene_id):
            return
        self.accept()


class SceneEntityPickField(QWidget):
    """已提交的 (场景, 实体) 只读回显 + 「选点…」按钮（选择器铁律的弹窗形态）。

    未知 / 悬垂值**保值展示**：数据里写的什么就显示什么，不因为"当前工程解析不到"
    而静默清空或顶替（共享控件保值契约）。
    """

    value_changed = Signal(str, str)

    def __init__(
        self,
        model_getter: Callable[[], ProjectModel],
        parent: QWidget | None = None,
        *,
        allow_empty: bool = True,
    ) -> None:
        super().__init__(parent)
        self._model_getter = model_getter
        self._allow_empty = bool(allow_empty)
        self._scene_id = ""
        self._entity_id = ""

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._display = QLineEdit()
        self._display.setReadOnly(True)
        self._display.setMinimumWidth(150)
        self._display.setPlaceholderText("（未选实体）")
        lay.addWidget(self._display, 1)
        self._pick_btn = QPushButton("选点…")
        self._pick_btn.setMaximumWidth(72)
        self._pick_btn.setToolTip("打开场景地图，直接在图上点这个人")
        self._pick_btn.clicked.connect(self._open_picker)
        lay.addWidget(self._pick_btn)
        if self._allow_empty:
            self._clear_btn = QPushButton("清空")
            self._clear_btn.setMaximumWidth(56)
            self._clear_btn.clicked.connect(self._clear)
            lay.addWidget(self._clear_btn)

    def scene_id(self) -> str:
        return self._scene_id

    def entity_id(self) -> str:
        return self._entity_id

    def set_value(self, scene_id: str, entity_id: str) -> None:
        """程序性回填，**不**发 value_changed（否则回填会被当成用户编辑而置脏）。"""
        self._scene_id = str(scene_id or "").strip()
        self._entity_id = str(entity_id or "").strip()
        self._sync_display()

    def _sync_display(self) -> None:
        """框里只写实体 id，场景进 tooltip。

        「场景/实体」两段串在这么窄的一格里必被裁掉头（实测显示成 `i头 / npc_零工工头`），
        而场景本来就在下一行「限定场景」原样回显——重复一遍换来一个读不出的框不划算。
        """
        base = "头顶闲聊的说话人实体；点右侧「选点…」在场景地图上挑。"
        if not self._entity_id:
            self._display.setText("")
            self._display.setToolTip(base)
            return
        self._display.setText(self._entity_id)
        where = f"{self._scene_id} / " if self._scene_id else ""
        self._display.setToolTip(f"{where}{self._entity_id}\n{base}")

    def _open_picker(self) -> None:
        model = self._model_getter()
        if model is None:
            return
        dlg = SceneEntityPickerDialog(
            model, current_scene=self._scene_id, current_entity=self._entity_id, parent=self)
        try:
            if dlg.exec() != QDialog.DialogCode.Accepted:
                return
            sid, eid = dlg.selected()
        finally:
            # 每次选点都拖着一整张 2048px 级背景的 QGraphicsScene，不销毁就一路攒到页面关闭
            dlg.deleteLater()
        if not eid:
            return
        self._scene_id, self._entity_id = sid, eid
        self._sync_display()
        self.value_changed.emit(self._scene_id, self._entity_id)

    def _clear(self) -> None:
        # allow_empty=False 时连按钮都不建；这里再挡一道，免得调用方直接调到它
        if not self._allow_empty or not (self._scene_id or self._entity_id):
            return
        self._scene_id, self._entity_id = "", ""
        self._sync_display()
        self.value_changed.emit("", "")
