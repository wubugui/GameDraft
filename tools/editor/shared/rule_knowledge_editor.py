"""Native rule-state projections; keys come from the rule's owner graph."""
from __future__ import annotations

from copy import deepcopy
from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QVBoxLayout, QCheckBox, QFormLayout, QComboBox, QLabel

from .form_layout import compact_form
from .id_ref_selector import IdRefSelector
from .rich_text_field import RichTextTextEdit


def rule_owner_graphs(model, rule_id):
    out = []
    for comp in model.narrative_graphs.get('compositions', []):
        graphs = [comp.get('mainGraph')] + [e.get('graph') for e in comp.get('elements', [])]
        out.extend(g for g in graphs if isinstance(g, dict)
                   and g.get('ownerType') == 'rule' and g.get('ownerId') == rule_id)
    return out


class RuleKnowledgeEditor(QWidget):
    changed = Signal()

    def __init__(self, model, parent=None):
        super().__init__(parent)
        self.model, self._raw, self._loading = model, None, False
        self._rule_id = ''
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        self.enabled = QCheckBox('由规矩所属叙事图决定已知正文')
        root.addWidget(self.enabled)
        self.note = QLabel('一个规矩只绑定一张 ownerType=rule 的图；未列出的层不显示。')
        self.note.setWordWrap(True)
        root.addWidget(self.note)
        self.state = IdRefSelector(allow_empty=False, click_opens_popup=True)
        root.addWidget(self.state)
        self.fields = {}
        for key, label in [('xiang', '象'), ('li', '理'), ('shu', '术')]:
            group = QWidget()
            form = compact_form(QFormLayout(group))
            known = QCheckBox(f'此状态已知「{label}」')
            text = RichTextTextEdit(model)
            text.setMaximumHeight(90)
            verified = QComboBox()
            verified.addItems(['unverified', 'effective', 'questionable'])
            form.addRow(known)
            form.addRow('正文', text)
            form.addRow('验证', verified)
            root.addWidget(group)
            self.fields[key] = (known, text, verified)
            known.toggled.connect(lambda on, k=key: self._set_known(k, on))
            text.textChanged.connect(lambda k=key: self._edit(k, 'text'))
            verified.currentTextChanged.connect(lambda _v, k=key: self._edit(k, 'verified'))
        self.enabled.toggled.connect(self._toggle)
        self.state.value_changed.connect(self._select)

    def set_rule(self, rule_id, value):
        self._loading = True
        self._rule_id, self._raw = rule_id, deepcopy(value)
        graphs = rule_owner_graphs(self.model, rule_id)
        states = graphs[0].get('states', {}) if len(graphs) == 1 else {}
        choices = [(sid, s.get('label', sid)) for sid, s in states.items()]
        choices += [(sid, sid + ' [缺失]') for sid in (value or {}) if sid not in states]
        self.state.set_items(choices)
        keys = list(value or {})
        current = self.state.current_id()
        self.state.set_current(current if current in states or current in keys else next(iter(states), keys[0] if keys else ''))
        self.enabled.setChecked(value is not None)
        self.note.setText('所属图：' + (graphs[0]['id'] if len(graphs) == 1 else f'找到 {len(graphs)} 张图；须唯一绑定'))
        self._loading = False
        self._select()

    def value(self):
        return deepcopy(self._raw)

    def _toggle(self, on):
        if self._loading:
            return
        self._raw = {sid: {'layers': {}} for sid, _ in self._state_rows()} if on else None
        self._select()
        self.changed.emit()

    def _state_rows(self):
        graphs = rule_owner_graphs(self.model, self._rule_id)
        return [(sid, s.get('label', sid)) for sid, s in graphs[0].get('states', {}).items()] if len(graphs) == 1 else []

    def _select(self, *_):
        self._loading = True
        self.state.setEnabled(self._raw is not None)
        layers = (self._raw or {}).get(self.state.current_id(), {}).get('layers', {})
        for key, (known, text, verified) in self.fields.items():
            layer = layers.get(key)
            known.setEnabled(self._raw is not None and bool(self.state.current_id()))
            known.setChecked(isinstance(layer, dict))
            text.setEnabled(known.isEnabled() and known.isChecked())
            verified.setEnabled(text.isEnabled())
            text.setPlainText((layer or {}).get('text', ''))
            value = (layer or {}).get('verified', 'unverified')
            if verified.findText(value) < 0:
                verified.addItem(value)
            verified.setCurrentText(value)
        self._loading = False

    def _layers(self):
        if self._loading or self._raw is None or not self.state.current_id():
            return None
        return self._raw.setdefault(self.state.current_id(), {'layers': {}}).setdefault('layers', {})

    def _set_known(self, key, on):
        layers = self._layers()
        if layers is None:
            return
        if on:
            layers.setdefault(key, {'text': ''})
        else:
            layers.pop(key, None)
        self._select()
        self.changed.emit()

    def _edit(self, key, field):
        layers = self._layers()
        if layers is None or key not in layers:
            return
        _, text, verified = self.fields[key]
        layers[key][field] = text.toPlainText() if field == 'text' else verified.currentText()
        self.changed.emit()
