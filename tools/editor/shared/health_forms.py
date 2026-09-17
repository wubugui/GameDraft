"""三把火作者控件。缺省值与显式 0 分开；未编辑的字段保留原值。"""
from __future__ import annotations

from copy import deepcopy
from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QHBoxLayout, QFormLayout, QVBoxLayout, QCheckBox, QDoubleSpinBox, QListWidget, QPushButton, QLabel

from .form_layout import compact_form
from .id_ref_selector import IdRefSelector
from .flag_key_field import FlagKeyPickField
from .rich_text_field import RichTextLineEdit

ABSENT = object()


class OptionalHealthNumber(QWidget):
    changed = Signal()

    def __init__(self, value=ABSENT, parent=None, *, default=0, minimum=0, maximum=1000000, label="指定", required=False):
        super().__init__(parent)
        if required and value is ABSENT:
            value = default
        self._original = deepcopy(value) if value is not ABSENT else ABSENT
        self._edited = False
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        self.enabled = QCheckBox(label, self)
        self.spin = QDoubleSpinBox(self)
        self.spin.setDecimals(6)
        self.spin.setRange(minimum, maximum)
        self.spin.setMaximumWidth(150)
        number = value if isinstance(value, (int, float)) and not isinstance(value, bool) else default
        if isinstance(number, (int, float)):
            self.spin.setRange(min(minimum, number), max(maximum, number))
            self.spin.setValue(number)
        self.enabled.setChecked(value is not ABSENT)
        if required:
            self.enabled.hide()
        self.spin.setEnabled(self.enabled.isChecked())
        self.enabled.toggled.connect(self.spin.setEnabled)
        self.enabled.toggled.connect(self._edit)
        self.spin.valueChanged.connect(self._edit)
        row.addWidget(self.enabled)
        row.addWidget(self.spin)
        row.addStretch(1)

    def _edit(self, *_):
        self._edited = True
        self.changed.emit()

    def value(self):
        if not self._edited:
            return deepcopy(self._original) if self._original is not ABSENT else ABSENT
        return self.spin.value() if self.enabled.isChecked() else ABSENT


def health_handle_rows(model, declaration: str) -> list[tuple[str, str]]:
    """取动作登记表同源的定义，不把引用当定义。包含未保存图、嵌套动作与过场。"""
    if model is None:
        return []
    from ..editors.action_registry_editor import _scan_actions
    found = {}
    for record in _scan_actions(model):
        if record.action_type != declaration:
            continue
        key = str((record.action.get("params") or {}).get("id", "") or "").strip()
        if key:
            found[key] = key
    return sorted(found.items())


def health_source_rows(model) -> list[tuple[str, str]]:
    """具体威胁的声明 id；不是 NPC id，不随实体改名变化。"""
    if model is None:
        return []
    from ..editors.action_registry_editor import _scan_actions
    found = {}
    for record in _scan_actions(model):
        if record.action_type == "inflictHealthDamage":
            key = str((record.action.get("params") or {}).get("sourceId", "") or "").strip()
            if key:
                found[key] = key
    from .health_refs import vfx_health_sources
    for effect in (getattr(model, 'vfx_effects', {}) or {}).values():
        found.update(vfx_health_sources(effect))
    scenes = getattr(model, "scenes", {})
    for scene in (scenes.values() if isinstance(scenes, dict) else scenes):
        if not isinstance(scene, dict):
            continue
        for entity in [*scene.get("npcs", []), *scene.get("hotspots", [])]:
            threat = entity.get("healthThreat")
            if isinstance(threat, dict) and threat.get("id"):
                found[str(threat["id"])] = f"{scene.get('id', '')} / {entity.get('name', entity.get('id', ''))}"
    return sorted(found.items())


class HealthProtectionForm(QWidget):
    """物品携带防护。主动使用复用 use.actions 的 applyHealthProtection。"""
    def __init__(self, model, value=ABSENT, parent=None):
        super().__init__(parent)
        self._model = model
        self._original = deepcopy(value) if value is not ABSENT else ABSENT
        raw = value if isinstance(value, dict) else {}
        self._edited = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.enabled = QCheckBox("携带在背包中即生效（同类物品多份只算一次）", self)
        self.enabled.setChecked(value is not ABSENT)
        layout.addWidget(self.enabled)
        self.body = QWidget(self)
        form = compact_form(QFormLayout(self.body))
        self.reduction = OptionalHealthNumber(raw.get("reduction", ABSENT), self.body, maximum=1)
        self.bonus = OptionalHealthNumber(raw.get("maxHealthBonus", ABSENT), self.body)
        self.reduction.setToolTip("0 不减伤；0.5 减半；1 完全防护。多来源按剩余伤害相乘。")
        form.addRow("减伤比例", self.reduction)
        form.addRow("阳气上限加成", self.bonus)
        kinds = QWidget(self.body)
        kind_row = QHBoxLayout(kinds)
        kind_row.setContentsMargins(0, 0, 0, 0)
        self.kind_checks = {}
        for key, title in (("yin", "阴气侵袭"), ("fright", "惊吓侵扰")):
            check = QCheckBox(title, kinds)
            check.setChecked(key in (raw.get("kinds") or []))
            self.kind_checks[key] = check
            kind_row.addWidget(check)
        kind_row.addWidget(QLabel("都不勾＝不限类型"))
        form.addRow("防护类型", kinds)
        self.sources = QListWidget(self.body)
        self.sources.setMaximumHeight(100)
        for source in (raw.get("threatIds") or []):
            self.sources.addItem(str(source))
        form.addRow("指定威胁（空＝全部）", self.sources)
        pick_row = QWidget(self.body)
        pick_layout = QHBoxLayout(pick_row)
        pick_layout.setContentsMargins(0, 0, 0, 0)
        self.source_picker = IdRefSelector(pick_row, allow_empty=True, editable=False, click_opens_popup=True)
        self.source_picker.set_items(health_source_rows(model))
        add = QPushButton("加入", pick_row)
        remove = QPushButton("移除选中", pick_row)
        pick_layout.addWidget(self.source_picker, 1)
        pick_layout.addWidget(add)
        pick_layout.addWidget(remove)
        form.addRow(pick_row)
        add.clicked.connect(self._add_source)
        remove.clicked.connect(self._remove_source)
        layout.addWidget(self.body)
        self.body.setEnabled(self.enabled.isChecked())
        self.enabled.toggled.connect(self.body.setEnabled)
        self.enabled.toggled.connect(self._edit)
        self.reduction.changed.connect(self._edit)
        self.bonus.changed.connect(self._edit)
        for check in self.kind_checks.values():
            check.toggled.connect(self._edit)

    def _edit(self, *_):
        self._edited = True

    def _add_source(self):
        key = self.source_picker.current_id()
        existing = [self.sources.item(i).text() for i in range(self.sources.count())]
        if key and key not in existing:
            self.sources.addItem(key)
            self._edit()

    def _remove_source(self):
        index = self.sources.currentRow()
        if index >= 0:
            self.sources.takeItem(index)
            self._edit()

    def reload_refs_from_model(self):
        current = self.source_picker.current_id()
        self.source_picker.set_items(health_source_rows(self._model))
        self.source_picker.set_current(current)

    def value(self):
        if not self._edited:
            return deepcopy(self._original) if self._original is not ABSENT else ABSENT
        if not self.enabled.isChecked():
            return ABSENT
        result = deepcopy(self._original) if isinstance(self._original, dict) else {}
        for key, field in (("reduction", self.reduction), ("maxHealthBonus", self.bonus)):
            value = field.value()
            if value is ABSENT:
                result.pop(key, None)
            else:
                result[key] = value
        kinds = [key for key, check in self.kind_checks.items() if check.isChecked()]
        sources = [self.sources.item(i).text() for i in range(self.sources.count())]
        for key, value in (("kinds", kinds), ("threatIds", sources)):
            if value:
                result[key] = value
            else:
                result.pop(key, None)
        return result


class HealthConfigForm(QWidget):
    """内嵌 game_config 页；模型写盘、标脏、关闭语义仍归宿主页。"""
    def __init__(self, model, value, parent=None):
        super().__init__(parent)
        self._model = model
        self._original = deepcopy(value) if isinstance(value, dict) else {}
        form = compact_form(QFormLayout(self))
        self.numbers = {}
        for key, title, default, minimum in (
            ("maxHealth", "初始阳气上限", 100, 0.000001),
            ("deathThreshold", "耗尽阈值", 0, 0),
            ("restoreFloor", "剧情系绳恢复值", 60, 0.000001),
        ):
            field = OptionalHealthNumber(self._original.get(key, ABSENT), self, default=default, minimum=minimum,
                                         label=f"覆盖默认 {default}")
            self.numbers[key] = field
            form.addRow(title, field)
        self.cue = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        self.reload_refs_from_model()
        self.cue.set_current(str(self._original.get("tetherCueId", "")))
        self.cue.setToolTip("未指定时使用 signal_death_tether；普通死亡不会自动触发系绳。")
        form.addRow("系绳演出", self.cue)
        self.suppress = FlagKeyPickField(model, None, str(self._original.get("tetherSuppressFlagKey", "")), self)
        form.addRow("旧剧情接管键", self.suppress)
        # 延迟 import：条件树持有 ActionEditor；模块导入期互引会打断整个编辑器启动。
        from .condition_expr_tree import ConditionExprTreeRootWidget
        self.tether_condition = ConditionExprTreeRootWidget(self, model_getter=lambda: model)
        self.tether_condition.set_expr(self._original.get("tetherCondition"))
        self._condition_edited = False
        self.tether_condition.changed.connect(self._mark_condition_edited)
        form.addRow("允许剧情系绳的条件", self.tether_condition)
        retry = self._original.get("retry")
        self._retry_original = deepcopy(retry) if isinstance(retry, dict) else {}
        self.retry_texts = {}
        for key, title, placeholder in (
            ("title", "死亡提示", "三把火熄了。"),
            ("retryText", "重试选项", "从上一个安全点重试"),
            ("menuText", "回菜单选项", "返回主菜单"),
            ("failedText", "恢复失败提示", "重试未成功，请再试一次，或返回主菜单。"),
        ):
            field = RichTextLineEdit(model, self)
            field.setText(str(self._retry_original.get(key, "")))
            field.setPlaceholderText(placeholder)
            self.retry_texts[key] = field
            form.addRow(title, field)
        self.death_note = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        self.death_note.set_current(str(self._retry_original.get("firstDeathNoteId", "")))
        form.addRow("首次死亡说明卡", self.death_note)
        from .fire_protection_form import FireProtectionConfigForm
        self.fire = FireProtectionConfigForm(model, self._original.get("fireProtection", ABSENT), self)
        form.addRow("指定保护火源", self.fire)
        self.reload_refs_from_model()

    def _mark_condition_edited(self):
        self._condition_edited = True

    def reload_refs_from_model(self):
        current = self.cue.current_id()
        self.cue.set_items([(str(c.get("id", "")), str(c.get("description") or c.get("id", "")))
                            for c in (getattr(self._model, "signal_cues", []) or []) if isinstance(c, dict)])
        self.cue.set_current(current)
        if hasattr(self, "death_note"):
            current_note = self.death_note.current_id()
            self.death_note.set_items([(str(n.get("id", "")), str(n.get("title", n.get("id", ""))))
                                       for n in self._model.system_note_rows()])
            self.death_note.set_current(current_note)
        if hasattr(self, "fire"):
            self.fire.reload_refs_from_model()

    def value(self) -> dict:
        result = deepcopy(self._original)
        for key, field in self.numbers.items():
            value = field.value()
            if value is ABSENT:
                result.pop(key, None)
            else:
                result[key] = value
        for key, value in (("tetherCueId", self.cue.current_id()), ("tetherSuppressFlagKey", self.suppress.key())):
            if value:
                result[key] = value
            elif self._original.get(key) != "":
                result.pop(key, None)
        if self._condition_edited:
            condition = self.tether_condition.get_expr()
            if condition:
                result["tetherCondition"] = condition
            else:
                result.pop("tetherCondition", None)
        retry = deepcopy(self._retry_original)
        for key, field in self.retry_texts.items():
            value = field.text()
            if value:
                retry[key] = value
            elif self._retry_original.get(key) != "":
                retry.pop(key, None)
        note = self.death_note.current_id()
        if note:
            retry["firstDeathNoteId"] = note
        elif self._retry_original.get("firstDeathNoteId") != "":
            retry.pop("firstDeathNoteId", None)
        if retry or "retry" in self._original:
            result["retry"] = retry
        fire = self.fire.value()
        if fire is ABSENT:
            result.pop("fireProtection", None)
        else:
            result["fireProtection"] = fire
        return result
