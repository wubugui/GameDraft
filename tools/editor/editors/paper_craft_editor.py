"""编辑 public/assets/data/paper_craft：扎纸部件装配小游戏。

实例与各子集合（订单 / 部件 / 槽位 / 纸色 / 收尾）均采用项目主从列表样板
（QListWidget + 详情表单），支持新增 / 删除（确认）/ 上移下移 / 右键菜单 / Delete 键。
注意：本编辑器只改"编辑子集合的控件"，从不改 orders / paperOptions / slots / parts /
finishOptions 数组的字段或读写映射——导出 JSON 对未触动数据逐字节保持不变。
"""
from __future__ import annotations

import re

from PySide6.QtCore import Signal, Qt
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel, QPushButton,
    QComboBox, QLineEdit, QTextEdit, QSpinBox, QCheckBox, QListWidget,
    QListWidgetItem, QGroupBox, QStyle, QScrollArea, QMenu, QSplitter,
    QInputDialog, QMessageBox,
)

from ..shared import confirm
from .paper_craft_canvas import PaperSlotCanvas
from ..shared.action_editor import ActionEditor
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.hex_color_pick_row import HexColorPickRow
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap


_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$")


class _MasterList(QListWidget):
    """主从列表（QListWidget）适配器：暴露与原 QComboBox 等价的少量接口，

    使既有的、按下拉 index 取值的读写/重排/重填逻辑可原样复用，从而保证导出 JSON
    映射不变。仅替换"编辑子集合的控件"，不触碰数据形态。

    - currentIndex() / setCurrentIndex(i) ↔ currentRow() / setCurrentRow(i)
    - addItem(text, data) 把 data 存入 UserRole（与 combo 的第二参语义一致）
    - currentData() 取当前行的 UserRole
    - currentIndexChanged 信号别名到 currentRowChanged
    """

    currentIndexChanged = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.currentRowChanged.connect(self.currentIndexChanged)

    def addItem(self, text, data=None):  # type: ignore[override]
        it = QListWidgetItem(str(text))
        if data is not None:
            it.setData(Qt.ItemDataRole.UserRole, data)
        super().addItem(it)

    def currentIndex(self) -> int:
        return self.currentRow()

    def setCurrentIndex(self, i: int) -> None:
        self.setCurrentRow(i)

    def currentData(self):
        it = self.currentItem()
        return it.data(Qt.ItemDataRole.UserRole) if it is not None else None


class PaperCraftEditor(QWidget):
    preview_requested = Signal(str)

    def __init__(self, model, parent=None):
        super().__init__(parent)
        self._model = model
        self._doc: dict | None = None
        self._order: dict | None = None
        self._part: dict | None = None
        self._slot: dict | None = None
        self._paper: dict | None = None
        self._finish: dict | None = None
        self._syncing = False

        root = QVBoxLayout(self)
        top = QHBoxLayout()
        root.addLayout(top)
        top.addWidget(QLabel("扎纸小游戏：左侧选实例 → 右侧编辑订单及其子集合"))
        top.addStretch(1)
        self.preview_btn = QPushButton("预览…")
        self.preview_btn.setToolTip("保存后以开发模式启动游戏并直接进入当前实例")
        self.preview_btn.clicked.connect(self._preview)
        top.addWidget(self.preview_btn)

        outer = QSplitter(Qt.Orientation.Horizontal)
        outer.setChildrenCollapsible(False)
        root.addWidget(outer, 1)

        # ── 左：实例主列表（新增 / 删除）────────────────────────────────
        inst_panel = QWidget()
        inst_l = QVBoxLayout(inst_panel)
        inst_l.setContentsMargins(0, 0, 0, 0)
        inst_l.addWidget(QLabel("扎纸实例"))
        self.instance_list = QListWidget()
        self.instance_list.setMinimumWidth(200)
        self.instance_list.currentRowChanged.connect(lambda *_: self._select_instance())
        inst_l.addWidget(self.instance_list, 1)
        inst_btns = QHBoxLayout()
        self._inst_add = QPushButton("+ 实例")
        self._inst_add.setToolTip("新增一个扎纸实例（id 将作为文件名 stem，并登记进 index）")
        self._inst_add.clicked.connect(self._add_instance)
        self._inst_del = QPushButton("删除实例")
        self._inst_del.setToolTip("删除当前选中的扎纸实例（含其全部订单）")
        self._inst_del.clicked.connect(self._remove_instance)
        inst_btns.addWidget(self._inst_add)
        inst_btns.addWidget(self._inst_del)
        inst_l.addLayout(inst_btns)
        outer.addWidget(inst_panel)

        # ── 正文：六组（订单 / 完成反馈 / 部件 / 槽位 / 纸色 / 收尾）────────
        body_scroll = QScrollArea()
        body_scroll.setWidgetResizable(True)
        body_host = QWidget()
        body = QHBoxLayout(body_host)
        body.setContentsMargins(0, 0, 0, 0)
        body_scroll.setWidget(body_host)
        outer.addWidget(body_scroll)
        outer.setStretchFactor(0, 0)
        outer.setStretchFactor(1, 1)

        left = QVBoxLayout()
        body.addLayout(left, 1)
        right = QVBoxLayout()
        body.addLayout(right, 1)

        # 实例级字段：显示名 + 可选纸人底图（此前 GUI 无法编辑，只能手改 JSON）。
        inst_box = QGroupBox("实例设置")
        inst_form = compact_form(QFormLayout(inst_box))
        self.instance_label_edit = QLineEdit()
        self.instance_label_edit.setMaximumWidth(240)  # 短标题：上限而非下限，小屏可缩
        self.instance_label_edit.setToolTip(
            "实例显示名（同步写入 index 与实例文件；运行时小游戏列表据此显示）"
        )
        # textChanged 即时写模型（P1-05）：editingFinished 在"打完字直接 Ctrl+S/关窗"
        # 或菜单弹出（PopupFocusReason 不发失焦）时不触发，编辑会静默丢；
        # 全文件行内 QLineEdit 同规（照 sugar/water 样板）。
        self.instance_label_edit.textChanged.connect(self._write_instance_meta)
        self.instance_bg = CutsceneImagePathRow(
            self._model, "", external_copy_subdir="paper_craft",
        )
        self.instance_bg.setToolTip(
            "可选：纸人底图。留空则用中性背板。运行时作半透明背景，"
            "编辑器槽位画布也据此显示底图。"
        )
        self.instance_bg.changed.connect(self._write_instance_meta)
        inst_form.addRow("名称", self.instance_label_edit)
        inst_form.addRow("底图", self.instance_bg)
        left.addWidget(inst_box)

        order_box = QGroupBox("订单")
        order_form = compact_form(QFormLayout(order_box))
        self.order_combo = self._make_list(
            self._select_order,
            self._add_order, self._remove_order,
            lambda: self._move_orders(-1), lambda: self._move_orders(1),
            del_key=self._remove_order,
        )
        self.order_combo.setMaximumHeight(120)
        self.order_title = QLineEdit()
        self.order_title.setMaximumWidth(240)  # 短标题：上限而非下限，小屏可缩、大屏不拉满
        self.order_title.textChanged.connect(self._write_order)
        self.order_desc = QTextEdit()
        # 长文本：去掉宽度下限，跟随列宽伸缩（小屏可缩、大屏占满宽行）
        self.order_desc.setMinimumHeight(56)
        self.order_desc.setMaximumHeight(140)
        self.order_desc.textChanged.connect(self._write_order)
        self.correct_paper_combo = QComboBox()
        self.correct_paper_combo.currentTextChanged.connect(self._write_order)
        self.success_score = QSpinBox()
        self.success_score.setRange(-999, 999)
        self.success_score.valueChanged.connect(self._write_order)
        self.warn_score = QSpinBox()
        self.warn_score.setRange(-999, 999)
        self.warn_score.valueChanged.connect(self._write_order)
        order_form.addRow("订单列表", self._list_with_tools(self.order_combo))
        order_form.addRow("标题", self.order_title)
        order_form.addRow("描述", self.order_desc)
        order_form.addRow("正确纸色", self.correct_paper_combo)
        order_form.addRow("合格分", self.success_score)
        order_form.addRow("警告分", self.warn_score)
        left.addWidget(order_box)

        # 完成反馈：提示文案 + 三档结果动作(此前 GUI 无法编辑,只能手改 JSON)。默认折叠。
        fb_sec = CollapsibleSection("完成反馈：提示文案 / 成功·警告·失败动作", start_open=False)
        fb_inner = QWidget()
        fb_form = compact_form(QFormLayout(fb_inner))
        # 仅当用户实际编辑某反馈字段时才写回它(ActionEditor.to_list 会规范化动作格式,
        # 若每次 _write_order 都重写动作数组会改变未触动订单的导出格式)。
        self._fb_dirty: set[str] = set()
        self.order_target_hint = RichTextLineEdit(self._model)
        self.order_target_hint.textChanged.connect(lambda *_: self._on_fb_changed("targetHint"))
        self.order_finish_question = RichTextLineEdit(self._model)
        self.order_finish_question.textChanged.connect(lambda *_: self._on_fb_changed("finishQuestion"))
        fb_form.addRow("目标提示 targetHint", self.order_target_hint)
        fb_form.addRow("收尾问句 finishQuestion", self.order_finish_question)
        self.ae_success = ActionEditor("onSuccessActions（达标时）")
        self.ae_warn = ActionEditor("onWarnActions（警告档）")
        self.ae_bad = ActionEditor("onBadActions（不合格）")
        for _ae, _k in (
            (self.ae_success, "onSuccessActions"),
            (self.ae_warn, "onWarnActions"),
            (self.ae_bad, "onBadActions"),
        ):
            _ae.set_project_context(self._model, None)
            _ae.changed.connect(lambda *_, _key=_k: self._on_fb_changed(_key))
            fb_form.addRow(_ae)
        fb_sec.add_body(fb_inner)
        left.addWidget(fb_sec)

        part_box = QGroupBox("部件")
        part_form = compact_form(QFormLayout(part_box))
        _part_up = lambda: self._move_order_list(self.part_combo, "parts", self._select_part, -1)
        _part_down = lambda: self._move_order_list(self.part_combo, "parts", self._select_part, 1)
        self.part_combo = self._make_list(
            self._select_part, self._add_part, self._remove_part,
            _part_up, _part_down, del_key=self._remove_part,
        )
        self.part_combo.setMaximumHeight(110)
        self.part_label = QLineEdit()
        self.part_label.textChanged.connect(self._write_part)
        self.part_score = QSpinBox()
        self.part_score.setRange(-999, 999)
        self.part_score.valueChanged.connect(self._write_part)
        self.part_tags = QLineEdit()
        self.part_tags.setPlaceholderText("逗号分隔，如：点眼犯忌, 红白相冲")
        self.part_tags.setMaximumWidth(240)  # 上限而非下限，小屏可缩
        self.part_tags.textChanged.connect(self._write_part)
        self.part_image = CutsceneImagePathRow(
            self._model, "", external_copy_subdir="paper_craft",
        )
        self.part_image.setToolTip(
            "可选：部件图片。留空则运行时按部件 id 取 "
            "minigames/paper_craft/parts/<id>.png。"
        )
        self.part_image.changed.connect(self._write_part)
        part_form.addRow("部件列表", self._list_with_tools(self.part_combo))
        part_form.addRow("显示名", self.part_label)
        part_form.addRow("分数", self.part_score)
        part_form.addRow("结果标签", self.part_tags)
        part_form.addRow("图片", self.part_image)
        left.addWidget(part_box)

        slot_box = QGroupBox("槽位")
        slot_outer = QVBoxLayout(slot_box)
        slot_outer.setContentsMargins(6, 6, 6, 6)
        slot_outer.setSpacing(4)
        # 槽位矩形可视化画布：在纸人底图上拖拽 / 缩放矩形，与下方 x/y/宽/高 双向同步。
        # 仅作视图与编辑入口，不改 slots 数组的字段形态或读写映射。
        self.slot_canvas = PaperSlotCanvas(self._model)
        self.slot_canvas.setMinimumHeight(160)  # 画布有 fit/缩放，降低下限以适配 13"
        self.slot_canvas.slot_selected.connect(self._on_canvas_slot_selected)
        self.slot_canvas.slot_geometry_changed.connect(self._on_canvas_slot_geometry)
        slot_outer.addWidget(self.slot_canvas, 1)
        slot_form_host = QWidget()
        slot_form = compact_form(QFormLayout(slot_form_host))
        slot_outer.addWidget(slot_form_host)
        _slot_after = lambda: (self._refresh_slot_canvas(), self._select_slot())
        _slot_up = lambda: self._move_order_list(self.slot_combo, "slots", _slot_after, -1)
        _slot_down = lambda: self._move_order_list(self.slot_combo, "slots", _slot_after, 1)
        self.slot_combo = self._make_list(
            self._select_slot, self._add_slot, self._remove_slot,
            _slot_up, _slot_down, del_key=self._remove_slot,
        )
        self.slot_combo.setMaximumHeight(110)
        self.slot_label = QLineEdit()
        self.slot_label.textChanged.connect(self._write_slot)
        self.slot_optional = QCheckBox("可不放")
        self.slot_optional.stateChanged.connect(self._write_slot)
        self.slot_x = self._spin()
        self.slot_y = self._spin()
        self.slot_w = self._spin()
        self.slot_h = self._spin()
        for sp in (self.slot_x, self.slot_y, self.slot_w, self.slot_h):
            sp.valueChanged.connect(self._write_slot)
        self.accepts_list = QListWidget()
        self.accepts_list.setMinimumHeight(120)
        self.accepts_list.itemChanged.connect(self._write_slot_accepts)
        slot_form.addRow("槽位列表", self._list_with_tools(self.slot_combo))
        slot_form.addRow("显示名", self.slot_label)
        slot_form.addRow("可选", self.slot_optional)
        slot_form.addRow("x", self.slot_x)
        slot_form.addRow("y", self.slot_y)
        slot_form.addRow("宽", self.slot_w)
        slot_form.addRow("高", self.slot_h)
        slot_form.addRow("可接部件", self.accepts_list)
        right.addWidget(slot_box, 1)

        paper_box = QGroupBox("纸色")
        paper_form = compact_form(QFormLayout(paper_box))
        _paper_up = lambda: self._move_order_list(self.paper_combo, "paperOptions", self._select_paper, -1)
        _paper_down = lambda: self._move_order_list(self.paper_combo, "paperOptions", self._select_paper, 1)
        self.paper_combo = self._make_list(
            self._select_paper, self._add_paper, self._remove_paper,
            _paper_up, _paper_down, del_key=self._remove_paper,
        )
        self.paper_combo.setMaximumHeight(110)
        self.paper_label = QLineEdit()
        self.paper_label.textChanged.connect(self._write_paper)
        self.paper_score = QSpinBox()
        self.paper_score.setRange(-999, 999)
        self.paper_score.valueChanged.connect(self._write_paper)
        self.paper_tint = HexColorPickRow("#cccccc", title="纸色 tint")
        self.paper_tint.changed.connect(self._write_paper)
        self.paper_tags = QLineEdit()
        self.paper_tags.setPlaceholderText("逗号分隔，如：红白相冲, 纸色不合")
        self.paper_tags.setMaximumWidth(240)  # 上限而非下限，小屏可缩
        self.paper_tags.textChanged.connect(self._write_paper)
        paper_form.addRow("纸色列表", self._list_with_tools(self.paper_combo))
        paper_form.addRow("显示名", self.paper_label)
        paper_form.addRow("分数", self.paper_score)
        paper_form.addRow("色值 tint", self.paper_tint)
        paper_form.addRow("结果标签", self.paper_tags)
        right.addWidget(paper_box)

        finish_box = QGroupBox("收尾")
        finish_form = compact_form(QFormLayout(finish_box))
        _finish_up = lambda: self._move_order_list(self.finish_combo, "finishOptions", self._select_finish, -1)
        _finish_down = lambda: self._move_order_list(self.finish_combo, "finishOptions", self._select_finish, 1)
        self.finish_combo = self._make_list(
            self._select_finish, self._add_finish, self._remove_finish,
            _finish_up, _finish_down, del_key=self._remove_finish,
        )
        self.finish_combo.setMaximumHeight(110)
        self.finish_label = QLineEdit()
        self.finish_label.textChanged.connect(self._write_finish)
        self.finish_score = QSpinBox()
        self.finish_score.setRange(-999, 999)
        self.finish_score.valueChanged.connect(self._write_finish)
        self.finish_tags = QLineEdit()
        self.finish_tags.setMaximumWidth(240)  # 上限而非下限，小屏可缩
        self.finish_tags.textChanged.connect(self._write_finish)
        finish_form.addRow("收尾列表", self._list_with_tools(self.finish_combo))
        finish_form.addRow("显示名", self.finish_label)
        finish_form.addRow("分数", self.finish_score)
        finish_form.addRow("结果标签", self.finish_tags)
        right.addWidget(finish_box)

        self.reload()

    # ── 主从列表骨架 ───────────────────────────────────────────────────
    def _make_list(self, on_select, on_add, on_remove, on_up, on_down, *, del_key=None) -> _MasterList:
        """生成一个子集合主列表（QListWidget），绑定选择、右键菜单、Delete 键。"""
        lw = _MasterList()
        lw.currentIndexChanged.connect(on_select)
        lw.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        lw.customContextMenuRequested.connect(
            lambda pos, w=lw: self._list_context_menu(w, pos, on_add, on_remove, on_up, on_down)
        )
        # Delete 键删除当前项（与右键 / − 按钮一致走确认）。
        lw._pc_del_key = del_key  # type: ignore[attr-defined]
        lw.installEventFilter(self)
        # 工具按钮行（+ / − / ↑ / ↓）随列表一并保存，供 _list_with_tools 取用。
        lw._pc_tools = self._crud_row(on_add, on_remove, on_up, on_down)  # type: ignore[attr-defined]
        return lw

    def _list_with_tools(self, lw: _MasterList) -> QWidget:
        """把列表与其工具按钮行竖直组合为一个 form row。"""
        host = QWidget()
        lay = QVBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        lay.addWidget(lw)
        lay.addWidget(lw._pc_tools)  # type: ignore[attr-defined]
        return host

    def _list_context_menu(self, lw, pos, on_add, on_remove, on_up, on_down) -> None:
        menu = QMenu(lw)
        act_add = menu.addAction("新增")
        has_row = lw.currentRow() >= 0
        act_up = menu.addAction("上移")
        act_down = menu.addAction("下移")
        menu.addSeparator()
        act_del = menu.addAction("删除")
        act_up.setEnabled(has_row)
        act_down.setEnabled(has_row)
        act_del.setEnabled(has_row)
        chosen = menu.exec(lw.mapToGlobal(pos))
        if chosen is act_add:
            on_add()
        elif chosen is act_up:
            on_up()
        elif chosen is act_down:
            on_down()
        elif chosen is act_del:
            on_remove()

    def eventFilter(self, obj, event):  # noqa: N802 (Qt override)
        if isinstance(obj, _MasterList) and event.type() == event.Type.KeyPress:
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                fn = getattr(obj, "_pc_del_key", None)
                if callable(fn) and obj.currentRow() >= 0:
                    fn()
                    return True
        return super().eventFilter(obj, event)

    def reload(self) -> None:
        self._syncing = True
        self.instance_list.clear()
        for iid, label in self._model.all_paper_craft_minigame_ids():
            it = QListWidgetItem(f"{label}  [{iid}]")
            it.setData(Qt.ItemDataRole.UserRole, iid)
            self.instance_list.addItem(it)
        self._syncing = False
        if self.instance_list.count():
            self.instance_list.setCurrentRow(0)
        else:
            self._select_instance()

    def select_by_id(self, item_id: str, _scene_id: str = "") -> bool:
        iid = (item_id or "").strip()
        if not iid:
            return False
        for r in range(self.instance_list.count()):
            it = self.instance_list.item(r)
            if it is not None and str(it.data(Qt.ItemDataRole.UserRole) or "") == iid:
                self.instance_list.setCurrentRow(r)
                return True
        return False

    # ── 主窗鸭子协议钩子（P1-05：此前全缺，Save All/关窗静默跳过本编辑器）──────
    def flush_to_model(self) -> bool:
        """Save All / 关窗前钩子。本编辑器所有行内控件均已 textChanged/valueChanged
        即时写模型（无懒回写暂存），此处无待收取内容；不做无条件 mark_dirty（否则
        零编辑也伪脏、每次保存都重写扎纸文件）。返回 True 表示可保存。"""
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """关闭门控：编辑即时入模型、无未应用暂存 → 恒可关（Discard 无需中和）。"""
        del parent
        return True

    def reload_refs_from_model(self) -> None:
        """主窗切页激活时：强制重建内部 ActionEditor 的行以重拉跨域引用候选
        （item/flag/quest 等在别处新增后不切页看不见）。ActionEditor.set_project_context
        在 model 相同（本编辑器恒相同）时短路，故用 set_data(to_list()) 原值重建，
        内容不变、不触发 changed/_fb_dirty，不重置其它表单字段。"""
        prev = self._syncing
        self._syncing = True
        try:
            for ae in (self.ae_success, self.ae_warn, self.ae_bad):
                ae.set_data(ae.to_list())
        finally:
            self._syncing = prev

    def _spin(self) -> QSpinBox:
        sp = QSpinBox()
        sp.setRange(-9999, 9999)
        return sp

    def _crud_row(self, on_add, on_remove, on_up=None, on_down=None) -> QWidget:
        """生成一行「+ / − / ↑ / ↓」短按钮，仅做增删与重排，不触碰既有读写/取值逻辑。

        on_up/on_down 为 None 时不显示重排按钮（保持向后兼容）。
        """
        row = QWidget()
        lay = QHBoxLayout(row)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        add_btn = outline_row_tool_button(
            self, "新增", std=QStyle.StandardPixmap.SP_FileDialogNewFolder, fallback_text="+"
        )
        del_btn = outline_row_tool_button(
            self, "删除当前", std=delete_standard_pixmap(), fallback_text="−"
        )
        add_btn.clicked.connect(on_add)
        del_btn.clicked.connect(on_remove)
        lay.addWidget(add_btn)
        lay.addWidget(del_btn)
        if on_up is not None and on_down is not None:
            up_btn = outline_row_tool_button(
                self, "上移当前（调整 JSON 数组顺序）",
                std=QStyle.StandardPixmap.SP_ArrowUp, fallback_text="↑",
            )
            down_btn = outline_row_tool_button(
                self, "下移当前（调整 JSON 数组顺序）",
                std=QStyle.StandardPixmap.SP_ArrowDown, fallback_text="↓",
            )
            up_btn.clicked.connect(on_up)
            down_btn.clicked.connect(on_down)
            lay.addWidget(up_btn)
            lay.addWidget(down_btn)
        lay.addStretch(1)
        return row

    def _unique_id(self, rows: list, prefix: str) -> str:
        """在 *rows* 现有 id 之外生成一个唯一 id，保持顺序无关。"""
        used = {
            str(r.get("id")) for r in rows if isinstance(r, dict) and r.get("id") is not None
        }
        n = len(rows) + 1
        while f"{prefix}_{n}" in used:
            n += 1
        return f"{prefix}_{n}"

    def _mark_dirty(self) -> None:
        self._model.mark_dirty("paper_craft")

    def _preview(self) -> None:
        iid = self._current_instance_id()
        if iid:
            self.preview_requested.emit(str(iid))

    def _current_instance_id(self) -> str | None:
        it = self.instance_list.currentItem()
        if it is None:
            return None
        return str(it.data(Qt.ItemDataRole.UserRole) or "") or None

    # ── 实例增删 ───────────────────────────────────────────────────────
    def _add_instance(self) -> None:
        raw, ok = QInputDialog.getText(self, "新增扎纸实例", "实例 id（将作为文件名 stem）：")
        if not ok:
            return
        iid = raw.strip()
        if not _ID_RE.match(iid):
            QMessageBox.warning(self, "扎纸小游戏", "id 格式不正确（字母开头，字母数字下划线横线）")
            return
        if iid in self._model.paper_craft_instances:
            QMessageBox.warning(self, "扎纸小游戏", "该 id 已存在")
            return
        fname = f"{iid}.json"
        self._model.paper_craft_index.append({"id": iid, "label": "新扎纸", "file": fname})
        self._model.paper_craft_instances[iid] = {
            "id": iid,
            "label": "新扎纸",
            "orders": [],
        }
        self._mark_dirty()
        self._syncing = True
        it = QListWidgetItem(f"新扎纸  [{iid}]")
        it.setData(Qt.ItemDataRole.UserRole, iid)
        self.instance_list.addItem(it)
        self._syncing = False
        self.instance_list.setCurrentRow(self.instance_list.count() - 1)

    def _remove_instance(self) -> None:
        iid = self._current_instance_id()
        if not iid:
            return
        if not confirm.confirm_delete(self, f"扎纸实例「{iid}」及其全部订单"):
            return
        self._model.paper_craft_index = [
            x for x in self._model.paper_craft_index
            if not (isinstance(x, dict) and str(x.get("id") or "") == iid)
        ]
        self._model.paper_craft_instances.pop(iid, None)
        self._mark_dirty()
        row = self.instance_list.currentRow()
        self._syncing = True
        self.instance_list.takeItem(row)
        self._syncing = False
        if self.instance_list.count():
            self.instance_list.setCurrentRow(min(row, self.instance_list.count() - 1))
        else:
            self._select_instance()

    def _select_instance(self) -> None:
        if self._syncing:
            return
        iid = self._current_instance_id()
        self._doc = self._model.paper_craft_instances.get(str(iid)) if iid else None
        self._syncing = True
        self.instance_label_edit.setText(str((self._doc or {}).get("label") or ""))
        self.instance_bg.set_path(str((self._doc or {}).get("backgroundImage") or ""))
        self.instance_label_edit.setEnabled(self._doc is not None)
        self.instance_bg.setEnabled(self._doc is not None)
        self.order_combo.clear()
        for order in (self._doc or {}).get("orders", []):
            if isinstance(order, dict):
                self.order_combo.addItem(str(order.get("title") or order.get("id") or ""), order.get("id"))
        self._syncing = False
        if self.order_combo.count():
            self.order_combo.setCurrentIndex(0)
        else:
            self._select_order()

    def _write_instance_meta(self) -> None:
        """写回实例显示名与底图：label 同步 index 行 + 实例文件 + 左侧列表显示文本；
        backgroundImage 仅在有值或键已存在时写（不给从无此键的实例凭空加键），并刷新画布底图。"""
        if self._syncing or self._doc is None:
            return
        iid = self._current_instance_id()
        if not iid:
            return
        label = self.instance_label_edit.text()
        self._doc["label"] = label
        # 运行时小游戏列表读 index 的 label，需与实例文件保持一致。
        for row in self._model.paper_craft_index:
            if isinstance(row, dict) and str(row.get("id") or "") == iid:
                row["label"] = label
                break
        it = self.instance_list.currentItem()
        if it is not None:
            it.setText(f"{label}  [{iid}]")
        bg = self.instance_bg.path().strip()
        if bg or "backgroundImage" in self._doc:
            self._doc["backgroundImage"] = bg
        self._refresh_slot_canvas()
        self._mark_dirty()

    def _select_order(self) -> None:
        if self._syncing:
            return
        orders = (self._doc or {}).get("orders", [])
        idx = self.order_combo.currentIndex()
        self._order = orders[idx] if 0 <= idx < len(orders) and isinstance(orders[idx], dict) else None
        self._refresh_order_fields()

    def _orders_list(self) -> list | None:
        orders = (self._doc or {}).get("orders")
        return orders if isinstance(orders, list) else None

    def _add_order(self) -> None:
        orders = self._orders_list()
        if orders is None:
            return
        oid = self._unique_id(orders, "order")
        orders.append({
            "id": oid,
            "title": "新订单",
            "description": "",
            "correctPaper": "",
            "successScore": 76,
            "warnScore": 50,
            # 运行时要求两组选项非空（缺失加载即拒），保存侧也会拦；播种一条 stub 起步。
            "paperOptions": [{"id": "paper_1", "label": "新纸色", "tint": "#cccccc", "score": 0}],
            "finishOptions": [{"id": "finish_1", "label": "新收尾", "score": 0, "tags": []}],
            "slots": [],
            "parts": [],
        })
        self._refill_orders(len(orders) - 1)
        self._mark_dirty()

    def _remove_order(self) -> None:
        orders = self._orders_list()
        if not orders:
            return
        idx = self.order_combo.currentIndex()
        if not (0 <= idx < len(orders)):
            return
        if not confirm.confirm_delete(
            self, f"订单「{orders[idx].get('id', '')}」及其部件/槽位/纸色/收尾",
        ):
            return
        orders.pop(idx)
        self._refill_orders(min(idx, len(orders) - 1))
        self._mark_dirty()

    def _refill_orders(self, select: int) -> None:
        """复用 _select_instance 的填充语义重建订单列表，再选中 *select*。"""
        self._syncing = True
        self.order_combo.clear()
        for order in (self._doc or {}).get("orders", []):
            if isinstance(order, dict):
                self.order_combo.addItem(
                    str(order.get("title") or order.get("id") or ""), order.get("id")
                )
        self._syncing = False
        if self.order_combo.count():
            self.order_combo.setCurrentIndex(max(0, select))
        self._select_order()

    def _on_fb_changed(self, key: str) -> None:
        """某反馈字段被用户改动:记下脏键并触发写回(写回时只落这些脏键)。"""
        if self._syncing or not self._order:
            return
        self._fb_dirty.add(key)
        self._write_order()

    def _refresh_order_fields(self) -> None:
        self._syncing = True
        self._fb_dirty = set()
        o = self._order or {}
        self.order_title.setText(str(o.get("title") or ""))
        self.order_desc.setPlainText(str(o.get("description") or ""))
        self.success_score.setValue(int(o.get("successScore") or 76))
        self.warn_score.setValue(int(o.get("warnScore") or 50))
        self.order_target_hint.setText(str(o.get("targetHint") or ""))
        self.order_finish_question.setText(str(o.get("finishQuestion") or ""))
        self.ae_success.set_data(list(o.get("onSuccessActions") or []))
        self.ae_warn.set_data(list(o.get("onWarnActions") or []))
        self.ae_bad.set_data(list(o.get("onBadActions") or []))

        self.correct_paper_combo.clear()
        # 显式"未设置"哨兵（data=""）占据 index 0：当 correctPaper 为空或指向已删/未知纸张时
        # 选中它，使 _write_order 写回的仍是 ""，不再把第一种纸张静默写成正确答案（HIGH-10）。
        self.correct_paper_combo.addItem("（未设置）", "")
        for p in o.get("paperOptions", []):
            if isinstance(p, dict):
                self.correct_paper_combo.addItem(str(p.get("label") or p.get("id") or ""), str(p.get("id") or ""))
        cp = str(o.get("correctPaper") or "")
        i = self.correct_paper_combo.findData(cp)
        self.correct_paper_combo.setCurrentIndex(i if i >= 0 else 0)

        self._fill_combo(self.part_combo, o.get("parts", []))
        self._fill_combo(self.slot_combo, o.get("slots", []))
        self._fill_combo(self.paper_combo, o.get("paperOptions", []))
        self._fill_combo(self.finish_combo, o.get("finishOptions", []))
        self._syncing = False
        self._refresh_slot_canvas()
        self._select_part()
        self._select_slot()
        self._select_paper()
        self._select_finish()

    def _fill_combo(self, combo, rows: list) -> None:
        combo.clear()
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict):
                combo.addItem(str(row.get("label") or row.get("id") or ""), row.get("id"))
        # 主列表无下拉的"无选中即第一项"语义，显式选首项以匹配既有 _select_* 取值语义。
        if isinstance(combo, _MasterList) and combo.count():
            combo.setCurrentRow(0)

    def _write_order(self) -> None:
        if self._syncing or not self._order:
            return
        self._order["title"] = self.order_title.text()
        self._order["description"] = self.order_desc.toPlainText()
        self._order["successScore"] = self.success_score.value()
        self._order["warnScore"] = self.warn_score.value()
        self._order["correctPaper"] = str(self.correct_paper_combo.currentData() or "")
        # 格式保真:仅写回用户本次实际改动过的反馈字段(且有内容或键已存在),
        # 避免规范化未触动订单的动作数组、或给本无这些键的订单凭空加键。
        if "targetHint" in self._fb_dirty:
            th = self.order_target_hint.text()
            if th or "targetHint" in self._order:
                self._order["targetHint"] = th
        if "finishQuestion" in self._fb_dirty:
            fq = self.order_finish_question.text()
            if fq or "finishQuestion" in self._order:
                self._order["finishQuestion"] = fq
        for _key, _ae in (
            ("onSuccessActions", self.ae_success),
            ("onWarnActions", self.ae_warn),
            ("onBadActions", self.ae_bad),
        ):
            if _key not in self._fb_dirty:
                continue
            _acts = _ae.to_list()
            if _acts or _key in self._order:
                self._order[_key] = _acts
        self._mark_dirty()

    def _select_part(self) -> None:
        self._part = self._pick_from("parts", self.part_combo.currentIndex())
        _prev_sync = self._syncing  # 嵌套调用不得提前解锁外层（审查 P2-22）
        self._syncing = True
        p = self._part or {}
        self.part_label.setText(str(p.get("label") or ""))
        self.part_score.setValue(int(p.get("score") or 0))
        self.part_tags.setText(", ".join(str(x) for x in p.get("tags", []) if x))
        self.part_image.set_path(str(p.get("image") or ""))
        self._syncing = _prev_sync

    def _write_part(self) -> None:
        if self._syncing or not self._part:
            return
        self._part["label"] = self.part_label.text()
        self._part["score"] = self.part_score.value()
        _ptags = self._split_tags(self.part_tags.text())
        if _ptags or "tags" in self._part:
            self._part["tags"] = _ptags
        # image：仅在有值或键已存在时写，避免给本无此键的部件凭空加 "image": ""。
        img = self.part_image.path().strip()
        if img or "image" in self._part:
            self._part["image"] = img
        self._mark_dirty()

    def _order_list(self, key: str) -> list | None:
        if not isinstance(self._order, dict):
            return None
        rows = self._order.get(key)
        if not isinstance(rows, list):
            rows = []
            self._order[key] = rows
        return rows

    def _refill_order_list(self, combo, key: str, select: int, after) -> None:
        """复用 _fill_combo 的填充语义重建列表，再选中 *select* 并触发对应 _select_*。

        与 _pick_from(key, index) 的取值语义保持一致：列表项与 list 顺序一一对应。
        """
        self._syncing = True
        self._fill_combo(combo, self._order_list(key) or [])
        self._syncing = False
        if combo.count():
            combo.setCurrentIndex(max(0, min(select, combo.count() - 1)))
        after()

    def _move_order_list(self, combo, key: str, after, delta: int) -> None:
        """在 *self._order[key]* 数组内把当前项与相邻项交换（仅调整顺序，不改字段）。"""
        rows = self._order_list(key)
        if not rows:
            return
        i = combo.currentIndex()
        j = i + delta
        if i < 0 or j < 0 or i >= len(rows) or j >= len(rows):
            return
        rows[i], rows[j] = rows[j], rows[i]
        self._refill_order_list(combo, key, j, after)
        self._mark_dirty()

    def _move_orders(self, delta: int) -> None:
        """在 orders 数组内把当前订单与相邻订单交换。"""
        orders = self._orders_list()
        if not orders:
            return
        i = self.order_combo.currentIndex()
        j = i + delta
        if i < 0 or j < 0 or i >= len(orders) or j >= len(orders):
            return
        orders[i], orders[j] = orders[j], orders[i]
        self._refill_orders(j)
        self._mark_dirty()

    def _add_part(self) -> None:
        rows = self._order_list("parts")
        if rows is None:
            return
        rows.append({"id": self._unique_id(rows, "part"), "label": "新部件", "score": 0, "tags": []})
        self._refill_order_list(self.part_combo, "parts", len(rows) - 1, self._select_part)
        self._refresh_accepts_list()
        self._mark_dirty()

    def _remove_part(self) -> None:
        rows = self._order_list("parts")
        if not rows:
            return
        idx = self.part_combo.currentIndex()
        if not (0 <= idx < len(rows)):
            return
        if not confirm.confirm_delete(self, f"部件「{rows[idx].get('id', '')}」"):
            return
        rows.pop(idx)
        self._refill_order_list(self.part_combo, "parts", min(idx, len(rows) - 1), self._select_part)
        self._refresh_accepts_list()
        self._mark_dirty()

    def _select_slot(self) -> None:
        self._slot = self._pick_from("slots", self.slot_combo.currentIndex())
        _prev_sync = self._syncing  # 嵌套调用不得提前解锁外层（审查 P2-22）
        self._syncing = True
        s = self._slot or {}
        self.slot_label.setText(str(s.get("label") or ""))
        self.slot_optional.setChecked(bool(s.get("optional")))
        self.slot_x.setValue(int(s.get("x") or 0))
        self.slot_y.setValue(int(s.get("y") or 0))
        self.slot_w.setValue(int(s.get("width") or 0))
        self.slot_h.setValue(int(s.get("height") or 0))
        self._refresh_accepts_list()
        self.slot_canvas.set_selected_row(self.slot_combo.currentIndex())
        self._syncing = _prev_sync

    def _slots_for_canvas(self) -> list[dict]:
        rows = (self._order or {}).get("slots")
        return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []

    def _instance_background_image(self) -> str:
        """实例级可选底图 URL（运行时 PaperCraftMinigameScene 读取 backgroundImage 绘制纸人底图）。

        缺省时返回空串，画布退回中性背板（固定 560×410 工作台尺寸），不向 JSON 写入该字段。
        """
        return str((self._doc or {}).get("backgroundImage") or "")

    def _refresh_slot_canvas(self) -> None:
        self.slot_canvas.refresh(
            slots=self._slots_for_canvas(),
            background_image=self._instance_background_image(),
            selected_row=self.slot_combo.currentIndex(),
        )

    def _on_canvas_slot_selected(self, row: int) -> None:
        """画布选中某槽 → 主列表跟随选中（走既有 _select_slot 取值路径）。"""
        if self._syncing:
            return
        if 0 <= row < self.slot_combo.count() and row != self.slot_combo.currentIndex():
            self.slot_combo.setCurrentIndex(row)

    def _on_canvas_slot_geometry(self, row: int, x: int, y: int, w: int, h: int) -> None:
        """画布拖拽 / 缩放某槽 → 写回该槽 x/y/width/height 并同步 spinbox。

        坐标已由画布 int(round) 取整：与原 spinbox 写回的整数像素语义完全一致，
        仅触及被拖动的那一个槽位，其余槽位字段逐字节不变。
        """
        rows = self._order_list("slots")
        if not rows or not (0 <= row < len(rows)) or not isinstance(rows[row], dict):
            return
        slot = rows[row]
        slot["x"] = int(x)
        slot["y"] = int(y)
        slot["width"] = int(w)
        slot["height"] = int(h)
        self._mark_dirty()
        # 若拖动的是当前选中槽，同步 spinbox（_syncing 抑制 spinbox 的 valueChanged 回写）。
        if row == self.slot_combo.currentIndex():
            self._syncing = True
            try:
                self.slot_x.setValue(int(x))
                self.slot_y.setValue(int(y))
                self.slot_w.setValue(int(w))
                self.slot_h.setValue(int(h))
            finally:
                self._syncing = False

    def _refresh_accepts_list(self) -> None:
        self.accepts_list.clear()
        accepts = set(str(x) for x in (self._slot or {}).get("accepts", []))
        for p in (self._order or {}).get("parts", []):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or "")
            item = QListWidgetItem(str(p.get("label") or pid))
            item.setData(Qt.ItemDataRole.UserRole, pid)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(Qt.CheckState.Checked if pid in accepts else Qt.CheckState.Unchecked)
            self.accepts_list.addItem(item)

    def _write_slot(self) -> None:
        if self._syncing or not self._slot:
            return
        self._slot["label"] = self.slot_label.text()
        # optional：仅在勾选或键已存在时写，避免给本无此键的槽位凭空加 "optional": false
        # （与同文件 part.image / paper.tags 的守门范式一致，审查 P3）
        if self.slot_optional.isChecked() or "optional" in self._slot:
            self._slot["optional"] = self.slot_optional.isChecked()
        self._slot["x"] = self.slot_x.value()
        self._slot["y"] = self.slot_y.value()
        self._slot["width"] = self.slot_w.value()
        self._slot["height"] = self.slot_h.value()
        self._mark_dirty()
        # spinbox → 矩形：把当前槽的几何同步给画布（不触发画布回写）。
        self.slot_canvas.update_slot_rect(self.slot_combo.currentIndex(), self._slot)

    def _add_slot(self) -> None:
        rows = self._order_list("slots")
        if rows is None:
            return
        rows.append({
            "id": self._unique_id(rows, "slot"),
            "label": "新槽位",
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 100,
            "accepts": [],
        })
        self._refill_order_list(self.slot_combo, "slots", len(rows) - 1, self._select_slot)
        self._refresh_slot_canvas()
        self._select_slot()
        self._mark_dirty()

    def _remove_slot(self) -> None:
        rows = self._order_list("slots")
        if not rows:
            return
        idx = self.slot_combo.currentIndex()
        if not (0 <= idx < len(rows)):
            return
        if not confirm.confirm_delete(self, f"槽位「{rows[idx].get('id', '')}」"):
            return
        rows.pop(idx)
        self._refill_order_list(self.slot_combo, "slots", min(idx, len(rows) - 1), self._select_slot)
        self._refresh_slot_canvas()
        self._select_slot()
        self._mark_dirty()

    def _write_slot_accepts(self) -> None:
        if self._syncing or not self._slot:
            return
        ids: list[str] = []
        for i in range(self.accepts_list.count()):
            item = self.accepts_list.item(i)
            if item.checkState() == Qt.CheckState.Checked:
                ids.append(str(item.data(Qt.ItemDataRole.UserRole)))
        self._slot["accepts"] = ids
        self._mark_dirty()

    def _refresh_correct_paper_combo(self) -> None:
        """纸色列表变化后就地刷新 correctPaper 候选（审查 P2-25：旧实现只在重选订单时
        重建，新纸色选不到、删除后残留 stale 项）。保持当前选择；悬垂落「（未设置）」。"""
        o = self._order or {}
        cur = str(o.get("correctPaper") or "")
        cb = self.correct_paper_combo
        cb.blockSignals(True)
        try:
            cb.clear()
            cb.addItem("（未设置）", "")
            for p_ in o.get("paperOptions", []):
                if isinstance(p_, dict):
                    cb.addItem(str(p_.get("label") or p_.get("id") or ""), str(p_.get("id") or ""))
            i = cb.findData(cur)
            cb.setCurrentIndex(i if i >= 0 else 0)
        finally:
            cb.blockSignals(False)

    def _select_paper(self) -> None:
        self._paper = self._pick_from("paperOptions", self.paper_combo.currentIndex())
        _prev_sync = self._syncing  # 嵌套调用不得提前解锁外层（审查 P2-22）
        self._syncing = True
        p = self._paper or {}
        self.paper_label.setText(str(p.get("label") or ""))
        self.paper_score.setValue(int(p.get("score") or 0))
        self.paper_tint.set_hex(str(p.get("tint") or "#cccccc"))
        self.paper_tags.setText(", ".join(str(x) for x in p.get("tags", []) if x))
        self._syncing = _prev_sync

    def _write_paper(self) -> None:
        if self._syncing or not self._paper:
            return
        self._paper["label"] = self.paper_label.text()
        self._paper["score"] = self.paper_score.value()
        self._paper["tint"] = self.paper_tint.hex().strip()
        # tags：仅在有值或键已存在时写，避免给本无此键的纸色凭空加 "tags": []。
        tags = self._split_tags(self.paper_tags.text())
        if tags or "tags" in self._paper:
            self._paper["tags"] = tags
        self._mark_dirty()

    def _add_paper(self) -> None:
        rows = self._order_list("paperOptions")
        if rows is None:
            return
        rows.append({
            "id": self._unique_id(rows, "paper"),
            "label": "新纸色",
            "tint": "#cccccc",
            "score": 0,
        })
        self._refill_order_list(self.paper_combo, "paperOptions", len(rows) - 1, self._select_paper)
        self._refresh_correct_paper_combo()
        self._mark_dirty()

    def _remove_paper(self) -> None:
        rows = self._order_list("paperOptions")
        if not rows:
            return
        idx = self.paper_combo.currentIndex()
        if not (0 <= idx < len(rows)):
            return
        if not confirm.confirm_delete(self, f"纸色「{rows[idx].get('id', '')}」"):
            return
        rows.pop(idx)
        self._refill_order_list(
            self.paper_combo, "paperOptions", min(idx, len(rows) - 1), self._select_paper
        )
        self._refresh_correct_paper_combo()
        self._mark_dirty()

    def _select_finish(self) -> None:
        self._finish = self._pick_from("finishOptions", self.finish_combo.currentIndex())
        _prev_sync = self._syncing  # 嵌套调用不得提前解锁外层（审查 P2-22）
        self._syncing = True
        f = self._finish or {}
        self.finish_label.setText(str(f.get("label") or ""))
        self.finish_score.setValue(int(f.get("score") or 0))
        self.finish_tags.setText(", ".join(str(x) for x in f.get("tags", []) if x))
        self._syncing = _prev_sync

    def _write_finish(self) -> None:
        if self._syncing or not self._finish:
            return
        self._finish["label"] = self.finish_label.text()
        self._finish["score"] = self.finish_score.value()
        _ftags = self._split_tags(self.finish_tags.text())
        if _ftags or "tags" in self._finish:
            self._finish["tags"] = _ftags
        self._mark_dirty()

    def _add_finish(self) -> None:
        rows = self._order_list("finishOptions")
        if rows is None:
            return
        rows.append({"id": self._unique_id(rows, "finish"), "label": "新收尾", "score": 0, "tags": []})
        self._refill_order_list(
            self.finish_combo, "finishOptions", len(rows) - 1, self._select_finish
        )
        self._mark_dirty()

    def _remove_finish(self) -> None:
        rows = self._order_list("finishOptions")
        if not rows:
            return
        idx = self.finish_combo.currentIndex()
        if not (0 <= idx < len(rows)):
            return
        if not confirm.confirm_delete(self, f"收尾「{rows[idx].get('id', '')}」"):
            return
        rows.pop(idx)
        self._refill_order_list(
            self.finish_combo, "finishOptions", min(idx, len(rows) - 1), self._select_finish
        )
        self._mark_dirty()

    def _pick_from(self, key: str, idx: int) -> dict | None:
        rows = (self._order or {}).get(key, [])
        if not isinstance(rows, list) or not (0 <= idx < len(rows)):
            return None
        row = rows[idx]
        return row if isinstance(row, dict) else None

    def _split_tags(self, text: str) -> list[str]:
        return [x.strip() for x in text.replace("，", ",").split(",") if x.strip()]
