"""任务「目标 + 引导」编辑控件（玩法文档 D7 / D8）。

两个可复用控件：

- :class:`GuidanceEditor` —— 一条任务/一条目标挂的引导列表。三种通道（地图标记 /
  场景内浮标 / 场景提示）**互不排斥**，同一个目标可以同时挂任意条。
- :class:`ObjectivesEditor` —— 目标清单，每条目标 = 文案 + 完成条件 + 自己的引导。

两条硬约束贯穿本模块：

1. **选择器铁律**：场景 id、实体 id 一律走 ``IdRefSelector``（候选取自 ProjectModel），
   绝不用裸 ``QLineEdit`` 承载引用——手打错的后果是运行时引导默默不出现。
   例外只有「目标自己的 id」（定义自身新 id）。
2. **零丢失往返**：``to_list()`` 以磁盘原始 dict 为底稿改写（未识别的键原样透传），
   数值表示经 :func:`preserve_numeric_repr` 恢复，未配的可选键一律不写出——
   打开一个任务再保存，不得凭空多出 ``offscreenArrow: false`` 这类中性值
   （那不是格式漂移，是改行为）。
"""
from __future__ import annotations

from copy import deepcopy

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFormLayout, QFrame, QHBoxLayout, QLabel, QLineEdit,
    QPushButton, QVBoxLayout, QWidget,
)

from .collapsible_section import CollapsibleSection
from .condition_editor import ConditionEditor
from .form_layout import compact_form
from .id_ref_selector import IdRefSelector
from .numeric_roundtrip import preserve_numeric_repr
from .rich_text_field import RichTextLineEdit

GUIDANCE_KINDS = ("mapMarker", "worldMarker", "sceneHint")
ENTITY_KINDS = ("", "npc", "hotspot", "zone")

_KIND_LABELS = {
    "mapMarker": "地图标记（在地图上标出这处地点）",
    "worldMarker": "场景内浮标（目标头顶浮标 + 出屏指向箭头）",
    "sceneHint": "场景提示（进入该场景时 HUD 出一行字）",
}

#: 短字段的宽度上限：不设上限会在小屏上把三栏挤爆（编辑器布局铁律）
_NARROW = 120


def _scene_pairs(model) -> list[tuple[str, str]]:
    return [(s, s) for s in (model.all_scene_ids() if model else [])]


def _entity_pairs(model, scene_id: str, kind: str) -> list[tuple[str, str]]:
    """按场景 + 实体种类取候选；场景没选或种类没选时给空表（保值展示照旧）。"""
    if not model or not scene_id or not kind:
        return []
    if kind == "npc":
        return model.npc_ids_for_scene(scene_id)
    if kind == "hotspot":
        return model.hotspot_ids_for_scene(scene_id)
    if kind == "zone":
        scene = (getattr(model, "scenes", None) or {}).get(scene_id) or {}
        out: list[tuple[str, str]] = []
        for z in scene.get("zones") or []:
            if isinstance(z, dict):
                zid = str(z.get("id", "") or "").strip()
                if zid:
                    out.append((zid, zid))
        return out
    return []


def _num_or_none(text: str):
    """输入框文本 → int/float/None（空串或写不成数就是 None，不擅自补 0）。"""
    s = (text or "").strip()
    if not s:
        return None
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        return int(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return None


def _num_text(value) -> str:
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return str(value)


# --------------------------------------------------------------------------- #
# 规范化（纯函数）：**写盘形态的唯一定义**
#
# 控件的 to_dict()/to_list() 与「判脏」两条路都过它。别把"哪些键该剔"的规则再手抄一份
# 到判脏里——那就是第二处镜像，迟早漂移，表现是「打开一个任务什么都没动就判脏、
# 一浏览就把磁盘上显式写的默认值键悄悄抹掉」。
# --------------------------------------------------------------------------- #

def normalize_guidance_entry(raw: dict) -> dict:
    """一条引导的写盘形态：未配的可选键一律不写，与 kind 无关的键删掉。"""
    out = dict(raw)
    kind = str(out.get("kind") or "mapMarker")
    out["kind"] = kind
    out["sceneId"] = str(out.get("sceneId") or "")
    if not out.get("conditions"):
        out.pop("conditions", None)

    def drop_if_blank(key: str) -> None:
        v = out.get(key)
        if v is None or (isinstance(v, str) and not v.strip()):
            out.pop(key, None)
        elif isinstance(v, str):
            out[key] = v.strip()

    if kind == "sceneHint":
        drop_if_blank("text")
        for k in ("label", "entityKind", "entityId", "x", "y", "offscreenArrow", "showDistance"):
            out.pop(k, None)
        return out

    out.pop("text", None)
    drop_if_blank("label")
    if kind == "mapMarker":
        for k in ("entityKind", "entityId", "x", "y", "offscreenArrow", "showDistance"):
            out.pop(k, None)
        return out

    # worldMarker：实体与坐标都可留（运行时实体优先，坐标是解析不到时的后备）
    ek = str(out.get("entityKind") or "").strip()
    eid = str(out.get("entityId") or "").strip()
    if ek and eid:
        out["entityKind"], out["entityId"] = ek, eid
    else:
        out.pop("entityKind", None)
        out.pop("entityId", None)
    for k in ("x", "y"):
        v = out.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            out.pop(k, None)
    if out.get("offscreenArrow") is None:
        out.pop("offscreenArrow", None)
    else:
        out["offscreenArrow"] = bool(out["offscreenArrow"])
    if out.get("showDistance") is True:
        out["showDistance"] = True
    else:
        out.pop("showDistance", None)
    return out


def normalize_guidance_list(items) -> list[dict]:
    """场景没填的整条丢弃（半填行运行时也不成立）。"""
    out: list[dict] = []
    for g in (items or []):
        if not isinstance(g, dict):
            continue
        entry = normalize_guidance_entry(g)
        if entry.get("sceneId"):
            out.append(entry)
    return out


def normalize_objective(raw: dict) -> dict:
    out = dict(raw)
    out["id"] = str(out.get("id") or "").strip()
    out["text"] = str(out.get("text") or "")
    if not out.get("availableWhen"):
        out.pop("availableWhen", None)
    conds = out.get("completeWhen") or []
    if conds:
        out["completeWhen"] = conds
    else:
        out.pop("completeWhen", None)
    guide = normalize_guidance_list(out.get("guidance"))
    if guide:
        out["guidance"] = guide
    else:
        out.pop("guidance", None)
    if out.get("optional") is True:
        out["optional"] = True
    else:
        out.pop("optional", None)
    return out


def normalize_objectives_list(items) -> list[dict]:
    """id 为空的整条丢弃（运行时靠 id 认目标，没 id 的行是半填状态）。"""
    out: list[dict] = []
    for o in (items or []):
        if not isinstance(o, dict):
            continue
        entry = normalize_objective(o)
        if entry.get("id"):
            out.append(entry)
    return out


class _LazyConditions(CollapsibleSection):
    """未展开时不构建重型条件树，仍完整往返并支持跨面板引用刷新。"""

    changed = Signal()

    def __init__(self, model, title: str, hint: str):
        super().__init__(title, start_open=False)
        self._model = model
        self._title = title
        self._hint = hint
        self._data: list = []
        self.editor: ConditionEditor | None = None
        self.set_header_tool_tip(hint)
        self.expanded_changed.connect(self._expand)

    def _expand(self, expanded: bool) -> None:
        if not expanded or self.editor is not None:
            return
        self.editor = ConditionEditor(self._title, hint=self._hint)
        self.editor.set_flag_pattern_context(self._model, None)
        self.editor.set_data(deepcopy(self._data))
        self.add_body(self.editor)
        self.editor.changed.connect(self.changed)

    def set_data(self, data: list) -> None:
        self._data = deepcopy(data)
        if self.editor is not None:
            previous = self.editor.blockSignals(True)
            try:
                self.editor.set_data(deepcopy(data))
            finally:
                self.editor.blockSignals(previous)

    def to_list(self) -> list:
        return self.editor.to_list() if self.editor is not None else deepcopy(self._data)

    def reload_refs_from_model(self) -> None:
        if self.editor is not None:
            self.editor.set_flag_pattern_context(self._model, None)


class _GuidanceRow(QFrame):
    """一条引导。字段按 kind 显隐——三种通道各自只露自己用得上的那几个。"""

    changed = Signal()
    remove_requested = Signal(object)

    def __init__(self, model, data: dict | None = None, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._orig: dict = dict(data or {})
        self.setFrameShape(QFrame.Shape.StyledPanel)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(6, 4, 6, 4)
        outer.setSpacing(4)

        top = QHBoxLayout()
        self.kind = QComboBox()
        for k in GUIDANCE_KINDS:
            self.kind.addItem(_KIND_LABELS[k], k)
        top.addWidget(QLabel("通道:"))
        top.addWidget(self.kind, 1)
        btn_del = QPushButton("x")
        btn_del.setFixedWidth(24)
        btn_del.setToolTip("删除这条引导")
        btn_del.clicked.connect(lambda: self.remove_requested.emit(self))
        top.addWidget(btn_del)
        outer.addLayout(top)

        body = QWidget()
        f = compact_form(QFormLayout(body))
        self.scene = IdRefSelector(allow_empty=False, editable=False, click_opens_popup=True)
        self.scene.set_items(_scene_pairs(model))
        self.scene.setToolTip("引导目标所在场景；三种通道都要填")
        f.addRow("场景", self.scene)

        self.label = RichTextLineEdit(model)
        self.label.setToolTip("地图标记/浮标上的短标签；留空则不显示标签")
        self.row_label = self.label
        f.addRow("标签", self.label)

        self.text = RichTextLineEdit(model)
        self.text.setToolTip("进入该场景时 HUD 出的一行提示（sceneHint 必填）")
        f.addRow("提示文字", self.text)

        self.entity_kind = QComboBox()
        self.entity_kind.addItems(ENTITY_KINDS)
        self.entity_kind.setMaximumWidth(_NARROW)
        self.entity_kind.setToolTip("浮标指向的实体种类；留空表示改用固定坐标")
        f.addRow("实体种类", self.entity_kind)

        self.entity_id = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
        self.entity_id.setToolTip(
            "浮标指向的实体（候选按上面的场景 + 种类过滤）。\n"
            "实体改名/迁场景时重构引擎会跟着改；指不到的目标校验器报 error。",
        )
        f.addRow("实体", self.entity_id)

        xy = QWidget()
        xyl = QHBoxLayout(xy)
        xyl.setContentsMargins(0, 0, 0, 0)
        self.x = QLineEdit()
        self.x.setMaximumWidth(_NARROW)
        self.y = QLineEdit()
        self.y.setMaximumWidth(_NARROW)
        xyl.addWidget(QLabel("x"))
        xyl.addWidget(self.x)
        xyl.addWidget(QLabel("y"))
        xyl.addWidget(self.y)
        xyl.addStretch()
        xy.setToolTip("没指实体时用的固定坐标（世界坐标）")
        self.xy_row = xy
        f.addRow("坐标", xy)

        # ⚠ 运行时缺省是 true 的可选 bool 一律三态：复选框的中性态是 false，
        # 「没设」与「设成 false」分不开，等于策划配不出 false（编辑器 norms 明令）。
        self.offscreen = QComboBox()
        self.offscreen.addItems(["", "true", "false"])
        self.offscreen.setMaximumWidth(_NARROW)
        self.offscreen.setToolTip("目标不在视野内时贴屏幕边缘画箭头。留空 = 用缺省（开）")
        f.addRow("出屏箭头", self.offscreen)

        self.show_distance = QCheckBox("显示到目标的距离")
        self.show_distance.setToolTip("缺省不显示")
        f.addRow("", self.show_distance)

        outer.addWidget(body)

        self.conditions = _LazyConditions(
            model, "生效条件", "按时段或事件状态显示这条已知去处；未配恒生效。",
        )
        outer.addWidget(self.conditions)
        self.conditions.changed.connect(self.changed)

        self.kind.currentIndexChanged.connect(self._sync_visibility)
        self.kind.currentIndexChanged.connect(self.changed)
        self.scene.currentIndexChanged.connect(self._refresh_entity_items)
        self.scene.currentIndexChanged.connect(self.changed)
        self.entity_kind.currentIndexChanged.connect(self._refresh_entity_items)
        self.entity_kind.currentIndexChanged.connect(self.changed)
        self.entity_id.currentIndexChanged.connect(self.changed)
        self.label.textChanged.connect(self.changed)
        self.text.textChanged.connect(self.changed)
        self.x.textChanged.connect(self.changed)
        self.y.textChanged.connect(self.changed)
        self.offscreen.currentIndexChanged.connect(self.changed)
        self.show_distance.toggled.connect(self.changed)

        self._fill(self._orig)

    # -- 填表 / 读表 ---------------------------------------------------------

    def _fill(self, data: dict) -> None:
        kind = str(data.get("kind") or "mapMarker")
        idx = self.kind.findData(kind)
        self.kind.setCurrentIndex(idx if idx >= 0 else 0)
        self.scene.set_current(str(data.get("sceneId") or ""))
        self.label.setText(str(data.get("label") or ""))
        self.text.setText(str(data.get("text") or ""))
        ek = str(data.get("entityKind") or "")
        self.entity_kind.setCurrentText(ek if ek in ENTITY_KINDS else "")
        self._refresh_entity_items()
        self.entity_id.set_current(str(data.get("entityId") or ""))
        self.x.setText(_num_text(data.get("x")))
        self.y.setText(_num_text(data.get("y")))
        oa = data.get("offscreenArrow")
        self.offscreen.setCurrentText("" if oa is None else ("true" if oa else "false"))
        self.show_distance.setChecked(data.get("showDistance") is True)
        self.conditions.set_data(list(data.get("conditions") or []))
        self._sync_visibility()

    def _refresh_entity_items(self) -> None:
        self.entity_id.set_items(
            _entity_pairs(self._model, self.scene.current_id() or "", self.entity_kind.currentText()),
        )

    def reload_refs_from_model(self) -> None:
        self.scene.set_items(_scene_pairs(self._model))
        self._refresh_entity_items()
        self.conditions.reload_refs_from_model()

    def _sync_visibility(self) -> None:
        kind = self.kind.currentData()
        world = kind == "worldMarker"
        hint = kind == "sceneHint"
        for w in (self.entity_kind, self.entity_id, self.xy_row, self.offscreen, self.show_distance):
            w.setVisible(world)
            lbl = self._label_for(w)
            if lbl is not None:
                lbl.setVisible(world)
        self.text.setVisible(hint)
        lbl = self._label_for(self.text)
        if lbl is not None:
            lbl.setVisible(hint)
        # 标签对地图标记与浮标都有意义，场景提示用不上（提示本身就是一句话）
        self.label.setVisible(not hint)
        lbl = self._label_for(self.label)
        if lbl is not None:
            lbl.setVisible(not hint)

    def _label_for(self, widget: QWidget):
        parent = widget.parentWidget()
        layout = parent.layout() if parent else None
        if isinstance(layout, QFormLayout):
            return layout.labelForField(widget)
        return None

    def to_dict(self) -> dict:
        """以磁盘原始 dict 为底稿改写：未识别的键原样透传，其余交给统一的规范化函数。"""
        out = dict(self._orig)
        out["kind"] = str(self.kind.currentData() or "mapMarker")
        out["sceneId"] = self.scene.current_id() or ""
        out["label"] = self.label.text().strip()
        out["text"] = self.text.text().strip()
        out["entityKind"] = self.entity_kind.currentText()
        out["entityId"] = self.entity_id.current_id() or ""
        for key, field in (("x", self.x), ("y", self.y)):
            out[key] = _num_or_none(field.text())
        oa = self.offscreen.currentText()
        out["offscreenArrow"] = None if oa == "" else (oa == "true")
        out["showDistance"] = self.show_distance.isChecked()
        out["conditions"] = self.conditions.to_list()
        return preserve_numeric_repr(normalize_guidance_entry(out), self._orig)


class GuidanceEditor(QWidget):
    """一条任务 / 一条目标挂的引导列表（可 0 条）。"""

    changed = Signal()

    def __init__(self, model, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._rows: list[_GuidanceRow] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(4)
        head = QHBoxLayout()
        hint = QLabel("引导通道互不排斥，可同时挂多条；只对「当前任务」生效")
        hint.setWordWrap(True)
        head.addWidget(hint, 1)
        btn_add = QPushButton("+ 引导")
        btn_add.setToolTip("添加一条引导通道")
        btn_add.clicked.connect(self._add_clicked)
        head.addWidget(btn_add)
        root.addLayout(head)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(6)
        root.addLayout(self._rows_layout)

    def set_data(self, items: list | None) -> None:
        self._clear()
        for it in (items or []):
            if isinstance(it, dict):
                self._add_row(it)

    def to_list(self) -> list[dict]:
        return normalize_guidance_list([r.to_dict() for r in self._rows])

    def reload_refs_from_model(self) -> None:
        for r in self._rows:
            r.reload_refs_from_model()

    def _clear(self) -> None:
        while self._rows_layout.count():
            item = self._rows_layout.takeAt(0)
            w = item.widget()
            if w:
                w.setParent(None)
                w.deleteLater()
        self._rows.clear()

    def _add_row(self, data: dict) -> _GuidanceRow:
        row = _GuidanceRow(self._model, data, self)
        row.changed.connect(self.changed)
        row.remove_requested.connect(self._remove_row)
        self._rows_layout.addWidget(row)
        self._rows.append(row)
        return row

    def _add_clicked(self) -> None:
        self._add_row({"kind": "mapMarker", "sceneId": ""})
        self.changed.emit()

    def _remove_row(self, row: _GuidanceRow) -> None:
        if row in self._rows:
            self._rows.remove(row)
        self._rows_layout.removeWidget(row)
        row.setParent(None)
        row.deleteLater()
        self.changed.emit()


class _ObjectiveRow(QWidget):
    """一条目标：文案 + 完成条件 + 自己的引导。整条包在可折叠块里。"""

    changed = Signal()
    remove_requested = Signal(object)
    move_requested = Signal(object, int)

    def __init__(self, model, data: dict | None = None, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._orig: dict = dict(data or {})

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(2)

        body = QWidget()
        outer = QVBoxLayout(body)
        outer.setContentsMargins(6, 4, 6, 4)
        outer.setSpacing(4)

        head = QHBoxLayout()
        # 「定义自身新 id」是选择器铁律的唯一例外，裸输入框在这里是对的
        self.id_edit = QLineEdit()
        self.id_edit.setMaximumWidth(160)
        self.id_edit.setToolTip("目标 id（任务内唯一；仅供数据引用，玩家看不到）")
        head.addWidget(QLabel("id:"))
        head.addWidget(self.id_edit)
        self.optional = QCheckBox("可选目标")
        self.optional.setToolTip("可选目标不参与自动跟踪；玩家仍可主动选择这条线索")
        head.addWidget(self.optional)
        head.addStretch()
        btn_up = QPushButton("↑")
        btn_up.setFixedWidth(24)
        btn_up.setToolTip("上移（目标是有序的，「当前目标」取第一条未完成的必做目标）")
        btn_up.clicked.connect(lambda: self.move_requested.emit(self, -1))
        head.addWidget(btn_up)
        btn_down = QPushButton("↓")
        btn_down.setFixedWidth(24)
        btn_down.setToolTip("下移")
        btn_down.clicked.connect(lambda: self.move_requested.emit(self, 1))
        head.addWidget(btn_down)
        btn_del = QPushButton("x")
        btn_del.setFixedWidth(24)
        btn_del.setToolTip("删除这条目标")
        btn_del.clicked.connect(lambda: self.remove_requested.emit(self))
        head.addWidget(btn_del)
        outer.addLayout(head)

        form = QWidget()
        f = compact_form(QFormLayout(form))
        self.text = RichTextLineEdit(model)
        self.text.setToolTip("玩家看到的一句话目标（面板复选框行、HUD 目标行都用它）")
        f.addRow("目标文案", self.text)
        outer.addWidget(form)

        self.available = _LazyConditions(
            model, "开放条件", "条件满足才展示并允许跟踪；用于已发现线索和仍可行的方法。未配恒展示。",
        )
        outer.addWidget(self.available)
        self.available.changed.connect(self.changed)

        self.cond = ConditionEditor(
            "完成条件",
            hint="目标勾选是从条件派生的、不入存档——与「任务清单是叙事状态的镜像」同一口径。\n"
                 "留空 = 不会自动勾掉，只随任务整体完成。",
        )
        self.cond.set_flag_pattern_context(model, None)
        sec_cond = CollapsibleSection("完成条件", start_open=False)
        sec_cond.add_body(self.cond)
        outer.addWidget(sec_cond)

        self.guidance = GuidanceEditor(model)
        self.guidance_section = CollapsibleSection("本目标的引导", start_open=False)
        self.guidance_section.set_header_tool_tip("不配则回落到任务级引导")
        self.guidance_section.add_body(self.guidance)
        outer.addWidget(self.guidance_section)

        self.section = CollapsibleSection("目标", start_open=False)
        self.section.add_body(body)
        root.addWidget(self.section)

        self.id_edit.textChanged.connect(self.changed)
        self.text.textChanged.connect(self._on_text_changed)
        self.optional.toggled.connect(self.changed)
        self.cond.changed.connect(self.changed)
        self.guidance.changed.connect(self.changed)

        self._fill(self._orig)

    def _fill(self, data: dict) -> None:
        self.id_edit.setText(str(data.get("id") or ""))
        self.text.setText(str(data.get("text") or ""))
        self.optional.setChecked(data.get("optional") is True)
        self.available.set_data(list(data.get("availableWhen") or []))
        self.cond.set_data(list(data.get("completeWhen") or []))
        self.guidance.set_data(list(data.get("guidance") or []))
        self._sync_title()

    def _on_text_changed(self) -> None:
        self._sync_title()
        self.changed.emit()

    def _sync_title(self) -> None:
        """折叠块的标题跟着目标文案走——折起来时还能一眼认出这是哪条。"""
        text = self.text.text().strip() or self.id_edit.text().strip() or "（未命名目标）"
        self.section.set_title(text[:28])

    def reload_refs_from_model(self) -> None:
        self.cond.set_flag_pattern_context(self._model, None)
        self.available.reload_refs_from_model()
        self.guidance.reload_refs_from_model()

    def to_dict(self) -> dict:
        out = dict(self._orig)
        out["id"] = self.id_edit.text().strip()
        out["text"] = self.text.text()
        out["completeWhen"] = self.cond.to_list()
        out["availableWhen"] = self.available.to_list()
        out["guidance"] = self.guidance.to_list()
        out["optional"] = self.optional.isChecked()
        return normalize_objective(out)


class ObjectivesEditor(QWidget):
    """任务的目标清单（有序；「当前目标」= 第一条未完成的必做目标）。"""

    changed = Signal()

    def __init__(self, model, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._rows: list[_ObjectiveRow] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(4)
        head = QHBoxLayout()
        hint = QLabel("目标有序；勾选状态由完成条件派生，不入存档")
        hint.setWordWrap(True)
        head.addWidget(hint, 1)
        btn_add = QPushButton("+ 目标")
        btn_add.setToolTip("添加一条目标")
        btn_add.clicked.connect(self._add_clicked)
        head.addWidget(btn_add)
        root.addLayout(head)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(4)
        root.addLayout(self._rows_layout)

    def set_data(self, items: list | None) -> None:
        self._clear()
        for it in (items or []):
            if isinstance(it, dict):
                self._add_row(it)

    def to_list(self) -> list[dict]:
        return normalize_objectives_list([r.to_dict() for r in self._rows])

    def reload_refs_from_model(self) -> None:
        for r in self._rows:
            r.reload_refs_from_model()

    def _clear(self) -> None:
        while self._rows_layout.count():
            item = self._rows_layout.takeAt(0)
            w = item.widget()
            if w:
                w.setParent(None)
                w.deleteLater()
        self._rows.clear()

    def _add_row(self, data: dict) -> _ObjectiveRow:
        row = _ObjectiveRow(self._model, data, self)
        row.changed.connect(self.changed)
        row.remove_requested.connect(self._remove_row)
        row.move_requested.connect(self._move_row)
        self._rows_layout.addWidget(row)
        self._rows.append(row)
        return row

    def _next_id(self) -> str:
        taken = {r.id_edit.text().strip() for r in self._rows}
        n = 1
        while f"obj{n}" in taken:
            n += 1
        return f"obj{n}"

    def _add_clicked(self) -> None:
        row = self._add_row({"id": self._next_id(), "text": ""})
        row.section.set_expanded(True)
        # 目标级引导比任务级引导多埋两层折叠，新建时顺手展开这一层——
        # 否则"给这条目标挂个浮标"要先在两层折叠里找路，是这套表单最劝退的一步。
        row.guidance_section.set_expanded(True)
        self.changed.emit()

    def _remove_row(self, row: _ObjectiveRow) -> None:
        if row in self._rows:
            self._rows.remove(row)
        self._rows_layout.removeWidget(row)
        row.setParent(None)
        row.deleteLater()
        self.changed.emit()

    def _move_row(self, row: _ObjectiveRow, delta: int) -> None:
        idx = self._rows.index(row) if row in self._rows else -1
        target = idx + delta
        if idx < 0 or target < 0 or target >= len(self._rows):
            return
        # 从**实时**控件状态重建，条件/引导跟着各自的目标一起搬（不是只换标题）
        items = [r.to_dict() for r in self._rows]
        # 重建会把每行的折叠态打回默认：先按目标 id 记下来，重建后原样还回去。
        # 不还的话「展开两条目标 → 调一下顺序 → 全收起来了」，正配到一半的人得重新点开。
        expanded = {
            str(r.id_edit.text().strip()): (r.section.is_expanded(), r.guidance_section.is_expanded())
            for r in self._rows
        }
        items[idx], items[target] = items[target], items[idx]
        self.set_data(items)
        for r in self._rows:
            state = expanded.get(str(r.id_edit.text().strip()))
            if state is None:
                continue
            r.section.set_expanded(state[0])
            r.guidance_section.set_expanded(state[1])
        self.changed.emit()
