"""指定火把与环境保护火的作者面，保留缺省/零值/未识别字段。"""
from copy import deepcopy
from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QHBoxLayout, QCheckBox, QComboBox, QListWidget, QPushButton
from .health_forms import ABSENT, OptionalHealthNumber
from .health_threat_form import HealthThreatSection
from .form_layout import compact_form
from .id_ref_selector import IdRefSelector


class FireProtectionConfigForm(QWidget):
    def __init__(self, model, value=ABSENT, parent=None):
        super().__init__(parent)
        self.model, self.original = model, deepcopy(value) if value is not ABSENT else ABSENT
        raw = value if isinstance(value, dict) else {}
        self.edited = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.props = QListWidget(self)
        self.props.setMaximumHeight(100)
        for prop in raw.get("heldPropIds", []) if isinstance(raw.get("heldPropIds", []), list) else []:
            self.props.addItem(str(prop))
        layout.addWidget(self.props)
        row = QHBoxLayout()
        self.picker = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        self.reload_refs_from_model()
        add, remove = QPushButton("加入火把", self), QPushButton("移除选中", self)
        row.addWidget(self.picker, 1)
        row.addWidget(add)
        row.addWidget(remove)
        layout.addLayout(row)
        self.grace = OptionalHealthNumber(raw.get("lossGraceSeconds", ABSENT), self, default=0.15,
                                         label="覆盖熄灭缓冲秒数（默认 0.15）", maximum=10)
        layout.addWidget(self.grace)
        self.setToolTip("只有列入此处且实际燃烧的玩家挂件提供保护；月光、装饰灯均无效。")
        add.clicked.connect(self._add)
        remove.clicked.connect(self._remove)

    def reload_refs_from_model(self):
        current = self.picker.current_id()
        self.picker.set_items([(str(k), str(v.get("label", k))) for k, v in (self.model.prop_presets or {}).items() if isinstance(v, dict)])
        self.picker.set_current(current)

    def _add(self):
        value = self.picker.current_id()
        if value and value not in [self.props.item(i).text() for i in range(self.props.count())]:
            self.props.addItem(value)
            self.edited = True

    def _remove(self):
        if self.props.currentRow() >= 0:
            self.props.takeItem(self.props.currentRow())
            self.edited = True

    def value(self):
        grace = self.grace.value()
        if not self.edited and not self.grace._edited:
            return deepcopy(self.original) if self.original is not ABSENT else ABSENT
        result = deepcopy(self.original) if isinstance(self.original, dict) else {}
        if self.edited:
            result["heldPropIds"] = [self.props.item(i).text() for i in range(self.props.count())]
        if grace is ABSENT:
            result.pop("lossGraceSeconds", None)
        else:
            result["lossGraceSeconds"] = grace
        return result


class EnvironmentFireForm(QWidget):
    changed = Signal()

    def __init__(self, model, scene_id, value=ABSENT, parent=None):
        super().__init__(parent)
        from .condition_editor import ConditionEditor
        self.original = deepcopy(value) if value is not ABSENT else ABSENT
        self.edited = set()
        raw = value if isinstance(value, dict) else {}
        form = compact_form(QFormLayout(self))
        self.enabled = QCheckBox("此处火光可阻止普通阴间侵袭", self)
        self.enabled.setChecked(value is not ABSENT)
        form.addRow(self.enabled)
        self.radius = OptionalHealthNumber(raw.get("radius", ABSENT), self, required=True, default=180)
        form.addRow("保护半径（场景单位）", self.radius)
        self.burning = QComboBox(self)
        for label, data in (("默认：须有实际燃烧的明火", None), ("须有实际燃烧的明火", True), ("持续火源（仍检查激活条件）", False)):
            self.burning.addItem(label, data)
        original = raw.get("requiresBurning")
        idx = self.burning.findData(original)
        if idx < 0:
            self.burning.addItem(f"（数据）{original}", original)
            idx = self.burning.count() - 1
        self.burning.setCurrentIndex(idx)
        form.addRow("燃烧要求", self.burning)
        self.conditions = ConditionEditor("火源激活条件", self)
        self.conditions.set_flag_pattern_context(model, scene_id)
        self.conditions.set_data(raw.get("conditions", []))
        form.addRow(self.conditions)
        self.enabled.toggled.connect(lambda *_: self._edit("enabled"))
        self.radius.changed.connect(lambda: self._edit("radius"))
        self.burning.currentIndexChanged.connect(lambda *_: self._edit("requiresBurning"))
        self.conditions.changed.connect(lambda: self._edit("conditions"))

    def _edit(self, key):
        self.edited.add(key)
        self.changed.emit()

    def value(self):
        if not self.edited:
            return deepcopy(self.original) if self.original is not ABSENT else ABSENT
        if not self.enabled.isChecked():
            return ABSENT
        result = deepcopy(self.original) if isinstance(self.original, dict) else {}
        if "radius" in self.edited or self.original is ABSENT:
            radius = self.radius.value()
            if radius is not ABSENT:
                result["radius"] = radius
        if "requiresBurning" in self.edited:
            value = self.burning.currentData()
            if value is None:
                result.pop("requiresBurning", None)
            else:
                result["requiresBurning"] = value
        if "conditions" in self.edited:
            result["conditions"] = self.conditions.to_list()
        return result


class EnvironmentFireSection(HealthThreatSection):
    component_key = "fireProtection"
    form_type = EnvironmentFireForm
    section_title = "环境火光保护"
