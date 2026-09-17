"""NPC/热点共用的威胁组件作者面；侧栏折叠时不构建条件与引用控件。"""
from __future__ import annotations
from copy import deepcopy
from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QCheckBox, QLineEdit, QComboBox
from .collapsible_section import CollapsibleSection
from .form_layout import compact_form
from .health_forms import ABSENT, OptionalHealthNumber
from .id_ref_selector import IdRefSelector
from .widget_discard import discard_widget


class HealthThreatForm(QWidget):
    changed = Signal()

    def __init__(self, model, scene_id, value=ABSENT, parent=None):
        super().__init__(parent)
        self.model = model
        from .action_editor import NarrativeSignalPickerField
        from .condition_editor import ConditionEditor
        self.original = deepcopy(value) if value is not ABSENT else ABSENT
        raw = value if isinstance(value, dict) else {}
        self.edited = set()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.enabled = QCheckBox("这个实体会侵袭玩家的三把火", self)
        self.enabled.setChecked(value is not ABSENT)
        layout.addWidget(self.enabled)
        self.body = QWidget(self)
        form = compact_form(QFormLayout(self.body))
        self.fields = {}
        identity = QLineEdit(str(raw.get("id", "")), self.body)
        identity.setToolTip("威胁定义的唯一 id，特定护身物按它匹配；不是实体 id。改名/删除后如仍有引用，保存会拦截并列出使用处。")
        identity.textChanged.connect(lambda *_: self._edit("id"))
        self.fields["id"] = identity
        form.addRow("威胁 id", identity)
        for key, title, entries in (
            ("kind", "侵袭种类", [("yin", "阴间实体（过界显示三火）"), ("fright", "惊吓侵扰（不代表过界）")]),
            ("fireResponse", "遇火反应", [(None, "默认：火光驱退"), ("repelled", "火光驱退"), ("ignore", "特殊：不怕火")]),
            ("nightOnly", "发生时段", [(None, "默认：只在非白昼时段"), (True, "仅非白昼"), (False, "全天")]),
            ("affectsWhenHidden", "隐藏时", [(None, "默认：停止侵袭"), (False, "停止侵袭"), (True, "仍会侵袭（无形来源）")]),
            ("duringPresentation", "演出期间", [(None, "默认：暂停侵袭"), (False, "暂停侵袭"), (True, "继续侵袭（教学须配最低保护）")]),
            ("soundOnlyMoving", "存在声播放时机", [(None, "默认：范围内持续"), (False, "范围内持续"), (True, "只在玩家走动时")]),
        ):
            combo = QComboBox(self.body)
            for data, label in entries:
                combo.addItem(label, data)
            original = raw.get(key, "yin" if key == "kind" else None)
            idx = combo.findData(original)
            if idx < 0:
                combo.addItem(f"（数据）{original}", original)
                idx = combo.count() - 1
            combo.setCurrentIndex(idx)
            combo.currentIndexChanged.connect(lambda *_, k=key: self._edit(k))
            self.fields[key] = combo
            form.addRow(title, combo)
        for key, title, default, required in (
            ("boundaryRadius", "过界半径（场景单位）", 240, True),
            ("damageRadius", "伤害半径（场景单位）", 180, True),
            ("attackPerSecond", "每秒侵袭强度", 5, True),
            ("nearRadius", "近身半径（场景单位）", 40, False),
            ("nearAttackPerSecond", "近身每秒侵袭强度", 400, False),
            ("soundInterval", "存在声间隔（秒，至少 0.1）", .7, False),
            ("soundBehindPlayer", "声源跟在身后距离（空＝实体）", 70, False),
            ("soundVolume", "存在声音量（0—1）", 1, False),
        ):
            field = OptionalHealthNumber(raw.get(key, ABSENT), self.body, default=default, required=required,
                minimum=.1 if key == 'soundInterval' else .000001 if key == 'boundaryRadius' else 0,
                maximum=1 if key == 'soundVolume' else 1000000)
            field.changed.connect(lambda k=key: self._edit(k))
            self.fields[key] = field
            form.addRow(title, field)
        sound = IdRefSelector(self.body, allow_empty=True, editable=False, click_opens_popup=True)
        sound.set_items([(key, key) for key in (getattr(model, 'audio_config', {}) or {}).get("sfx", {})])
        sound.set_current(str(raw.get("presenceSfx", "")))
        sound.value_changed.connect(lambda *_: self._edit("presenceSfx"))
        self.fields["presenceSfx"] = sound
        form.addRow("存在声（SFX，可空）", sound)
        note = IdRefSelector(self.body, allow_empty=True, editable=False, click_opens_popup=True)
        note.set_items([(str(n.get("id", "")), str(n.get("title", n.get("id", "")))) for n in model.system_note_rows()])
        note.set_current(str(raw.get("deathNoteId", "")))
        note.value_changed.connect(lambda *_: self._edit("deathNoteId"))
        self.fields["deathNoteId"] = note
        form.addRow("专属死亡说明（可空）", note)
        for key, title in (("enteredSignal", "过界时信号"), ("repelledSignal", "被火驱退时信号"), ("leftSignal", "离开范围时信号")):
            picker = NarrativeSignalPickerField(model, str(raw.get(key, "")), self.body)
            picker.valueChanged.connect(lambda *_, k=key: self._edit(k))
            self.fields[key] = picker
            form.addRow(title, picker)
        self.conditions = ConditionEditor("额外激活条件（仍遵守实体/位面/时段）", self.body)
        self.conditions.set_flag_pattern_context(model, scene_id)
        self.conditions.set_data(raw.get("conditions", []))
        self.conditions.changed.connect(lambda: self._edit("conditions"))
        form.addRow(self.conditions)
        layout.addWidget(self.body)
        self.body.setEnabled(self.enabled.isChecked())
        self.enabled.toggled.connect(self.body.setEnabled)
        self.enabled.toggled.connect(lambda *_: self._edit("enabled"))

    def _edit(self, key):
        self.edited.add(key)
        self.changed.emit()

    def reload_refs_from_model(self):
        for key, rows in (
            ('presenceSfx', [(k, k) for k in (getattr(self.model, 'audio_config', {}) or {}).get('sfx', {})]),
            ('deathNoteId', [(str(n.get('id', '')), str(n.get('title', n.get('id', '')))) for n in self.model.system_note_rows()]),
        ):
            field = self.fields[key]
            value = field.current_id()
            field.blockSignals(True)
            field.set_items(rows)
            field.set_current(value)
            field.blockSignals(False)

    def value(self):
        if not self.edited:
            return deepcopy(self.original) if self.original is not ABSENT else ABSENT
        if not self.enabled.isChecked():
            return ABSENT
        result = deepcopy(self.original) if isinstance(self.original, dict) else {}
        keys = set(self.edited) | ({"id", "kind", "boundaryRadius", "damageRadius", "attackPerSecond"} if self.original is ABSENT else set())
        for key in keys:
            field = self.fields.get(key)
            if isinstance(field, OptionalHealthNumber):
                value = field.value()
                if value is ABSENT:
                    result.pop(key, None)
                else:
                    result[key] = value
            elif isinstance(field, QLineEdit):
                result[key] = field.text().strip()
            elif isinstance(field, QComboBox):
                value = field.currentData()
                if value is None:
                    result.pop(key, None)
                else:
                    result[key] = value
            elif field is not None:
                value = field.current_id() if isinstance(field, IdRefSelector) else field.current_signal()
                if value:
                    result[key] = value
                else:
                    result.pop(key, None)
        if "conditions" in keys:
            conditions = self.conditions.to_list()
            if conditions:
                result["conditions"] = conditions
            else:
                result.pop("conditions", None)
        return result


class HealthThreatSection(CollapsibleSection):
    changed = Signal()
    component_key = "healthThreat"
    form_type = HealthThreatForm
    section_title = "三把火侵袭（鬼物／惊扰）"

    def __init__(self, model, parent=None):
        super().__init__(self.section_title, parent=parent, start_open=False)
        self.model = model
        self.form = None
        self.raw = ABSENT
        self.scene_id = None
        self.expanded_changed.connect(self._expand)

    def _expand(self, expanded):
        if expanded and self.form is None:
            self.form = self.form_type(self.model, self.scene_id, self.raw, self)
            self.form.changed.connect(self.changed)
            self.add_body(self.form)

    def load_entity(self, entity, scene_id):
        self.raw = deepcopy(entity[self.component_key]) if self.component_key in entity else ABSENT
        self.scene_id = scene_id
        if self.form is not None:
            discard_widget(self.form)
            self.form = None
        self._expand(self.is_expanded())

    def write_to(self, entity):
        value = self.form.value() if self.form is not None else self.raw
        if value is ABSENT:
            entity.pop(self.component_key, None)
        else:
            entity[self.component_key] = deepcopy(value)

    def reload_refs_from_model(self):
        if self.form is not None:
            refresh = getattr(self.form, 'reload_refs_from_model', None)
            if callable(refresh):
                refresh()
