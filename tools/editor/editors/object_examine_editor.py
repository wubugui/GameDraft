"""Native object examination documents: lazy property forms and image hit regions.

Immediate model editing, like SmellProfileEditor; no private pending buffer or
file I/O. Only the selected property builds a widget. Unknown fields, absent
defaults, list order and numeric representations survive untouched browsing.
"""
from __future__ import annotations

from copy import deepcopy
import re

from PySide6.QtCore import Qt, QPointF
from PySide6.QtGui import QColor, QPen, QPixmap, QPolygonF
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QSplitter, QListWidget,
    QTreeWidget, QTreeWidgetItem, QLabel, QPushButton, QComboBox, QCheckBox,
    QDoubleSpinBox, QGraphicsScene, QGraphicsView, QGraphicsItem, QScrollArea,
    QInputDialog, QMessageBox,
)
from ..shared.action_editor import ActionEditor
from ..shared.form_layout import compact_form
from ..shared.image_path_picker import CutsceneImagePathRow, disk_path_for_runtime_url
from ..shared.reference_picker import ReferencePickerField
from ..shared.rich_text_field import RichTextLineEdit

_ACTION_KEYS = {'actions', 'onFound', 'onAllFound'}
_ENUMS = {'kind': ['still'], 'backgroundPreset': ['mud', 'straw', 'wood', 'stone', 'softGlow']}
# Authoring presets, not runtime defaults or a second validation schema.
_ROOT_FIELDS = {'title': '', 'bagLabel': '', 'allFoundHint': '', 'onAllFound': [],
                'smell': {'scent': '', 'intensity': 60}, 'ambience': {'headSway': {'amplitude': 1}},
                'audio': {'ambient': '', 'hoverSfx': '', 'clickSfx': ''}}
_HS_FIELDS = {'label': '', 'narration': '', 'anomalyShade': '', 'anomalyRevealed': '',
              'shadeUiX': 0.2, 'shadeUiY': 0.3, 'decoy': False, 'actions': [],
              'onFound': [], 'operations': [], 'itemUses': [], 'polygon': []}


class ObjectExamineEditor(QWidget):
    def __init__(self, model, parent=None):
        super().__init__(parent)
        self._model = model
        self._cur_id = None
        self._property_widget = None
        self._tree_by_path = {}
        root = QVBoxLayout(self)
        split = QSplitter()
        root.addWidget(split)
        left = QWidget(); layout = QVBoxLayout(left)
        self._list = QListWidget(); self._list.setMaximumWidth(190)
        self._list.currentTextChanged.connect(self._on_select)
        layout.addWidget(self._list)
        add = QPushButton('新建检视物件'); add.clicked.connect(self._new_instance)
        layout.addWidget(add); split.addWidget(left)
        center = QWidget(); layout = QVBoxLayout(center)
        self._tree = QTreeWidget(); self._tree.setHeaderLabels(['结构 / 字段', '当前值'])
        self._tree.currentItemChanged.connect(self._on_property)
        layout.addWidget(self._tree)
        bar = QHBoxLayout()
        self._add_field = QPushButton('添加字段 / 条目'); self._add_field.clicked.connect(self._add)
        self._remove_field = QPushButton('移除可选字段'); self._remove_field.clicked.connect(self._remove)
        bar.addWidget(self._add_field); bar.addWidget(self._remove_field); layout.addLayout(bar)
        self._detail = QWidget(); self._form = compact_form(QFormLayout(self._detail))
        scroll = QScrollArea(); scroll.setWidgetResizable(True); scroll.setWidget(self._detail)
        layout.addWidget(scroll); split.addWidget(center)
        self._scene = QGraphicsScene(self)
        self._preview = QGraphicsView(self._scene)
        self._scene.selectionChanged.connect(self._preview_selected)
        split.addWidget(self._preview); split.setSizes([160, 470, 450])
        tip = QLabel('点结构字段编辑；点图中红框选择热区。坐标使用原图像素，物理尺寸使用厘米。修改由「全部保存」统一写盘。')
        tip.setWordWrap(True); root.addWidget(tip)
        self.reload_refs_from_model()

    @property
    def _doc(self):
        return self._model.object_examine_instances.get(self._cur_id)

    def reload_refs_from_model(self):
        current = self._cur_id
        self._list.blockSignals(True); self._list.clear()
        self._list.addItems(list(self._model.object_examine_instances))
        self._list.blockSignals(False)
        if current and self.select_by_id(current): return
        if self._list.count(): self._list.setCurrentRow(0)

    def select_by_id(self, iid, _scene_id=''):
        matches = self._list.findItems(iid, Qt.MatchFlag.MatchExactly)
        if not matches: return False
        self._list.setCurrentItem(matches[0]); self._on_select(iid)
        return True

    def _on_select(self, iid):
        self._cur_id = iid
        self._rebuild_tree(); self._draw_preview()

    def _value(self, path):
        value = self._doc
        for key in path: value = value[key]
        return value

    def _set(self, path, value):
        old = self._value(path)
        if old == value: return
        self._value(path[:-1])[path[-1]] = deepcopy(value)
        self._model.mark_dirty('object_examine')
        node = self._tree_by_path.get(path)
        if node: node.setText(1, self._summary(value))
        if path == ('label',):
            for row in self._model.object_examine_index:
                if row.get('id') == self._cur_id: row['label'] = value
        if path and (path[0] == 'presentation' or path[-1] in {'x', 'y', 'width', 'height', 'polygon'}):
            self._draw_preview()

    @staticmethod
    def _summary(value):
        if isinstance(value, (dict, list)): return f'{len(value)} 项'
        return str(value)

    def _rebuild_tree(self, select=()):
        self._tree.blockSignals(True); self._tree.clear(); self._tree_by_path.clear()
        def add(parent, path, value, title):
            node = QTreeWidgetItem(parent, [str(title), self._summary(value)])
            node.setData(0, Qt.ItemDataRole.UserRole, path); self._tree_by_path[path] = node
            if path and path[-1] in _ACTION_KEYS: return
            if isinstance(value, dict):
                for key, child in value.items(): add(node, path + (key,), child, key)
            elif isinstance(value, list):
                for i, child in enumerate(value):
                    label = child.get('label') or child.get('id') or i if isinstance(child, dict) else i
                    add(node, path + (i,), child, label)
        if self._doc is not None: add(self._tree, (), self._doc, self._cur_id)
        self._tree.blockSignals(False)
        node = self._tree_by_path.get(select) or self._tree_by_path.get(())
        if node:
            node.setExpanded(True); self._tree.setCurrentItem(node)

    def _on_property(self, node, _prev=None):
        while self._form.count():
            item = self._form.takeAt(0)
            if item.widget(): item.widget().deleteLater()
        self._property_widget = None
        if node is None or self._doc is None: return
        path = tuple(node.data(0, Qt.ItemDataRole.UserRole)); value = self._value(path)
        key = path[-1] if path else ''
        self._add_field.setEnabled(isinstance(value, (dict, list)) and key not in _ACTION_KEYS)
        self._remove_field.setEnabled(bool(path) and isinstance(key, str) and key in self._optional(path[:-1]))
        put = lambda v: self._set(path, v)
        if key in _ACTION_KEYS:
            w = ActionEditor(str(key)); w.set_project_context(self._model)
            w.set_data(deepcopy(value)); w.changed.connect(lambda: put(w.to_list()))
        elif key in {'image', 'backgroundImage'}:
            w = CutsceneImagePathRow(self._model, str(value), external_copy_subdir='examine')
            w.changed.connect(lambda: put(w.path()))
        elif key in {'itemId', 'requiresItem', 'scent', 'ambient', 'hoverSfx', 'clickSfx'}:
            if key in {'itemId', 'requiresItem'}: provider = self._model.all_item_ids
            elif key == 'scent': provider = self._model.all_smell_profile_ids
            else:
                channel = 'ambient' if key == 'ambient' else 'sfx'
                provider = lambda: [(s, s) for s in self._model.all_audio_ids(channel)]
            w = ReferencePickerField(provider, allow_empty=True)
            w.set_value(str(value)); w.value_changed.connect(put)
        elif key in _ENUMS:
            w = QComboBox(); w.addItems(_ENUMS[key])
            if value not in _ENUMS[key]: w.addItem(str(value))
            w.setCurrentText(str(value)); w.currentTextChanged.connect(put)
        elif isinstance(value, bool):
            w = QCheckBox('启用'); w.setChecked(value); w.toggled.connect(put)
        elif isinstance(value, (float, int)):
            w = QDoubleSpinBox(); w.setRange(-1e8, 1e8); w.setDecimals(6); w.setMaximumWidth(180)
            w.setValue(value); w.valueChanged.connect(lambda v: put(int(v) if isinstance(value, int) and v.is_integer() else v))
        elif isinstance(value, str) and key != 'id':
            w = RichTextLineEdit(self._model); w.setText(value); w.textChanged.connect(put)
        else:
            w = QLabel('选择子字段。ID 在新建时确定；已有 ID 的改名需通过引用重构。' if key == 'id' else '展开结构选择字段，或添加可选字段 / 条目。')
            w.setWordWrap(True)
        self._property_widget = w
        self._form.addRow(str(key) or '检视物件', w)

    def _optional(self, path):
        if not path: return _ROOT_FIELDS
        if path == ('presentation',):
            return {'backgroundPreset': 'stone', 'backgroundImage': '', 'backgroundBrightness': 1,
                    'physicalWidthCm': 100, 'contactAoIntensity': 1, 'contactAoRadiusCm': 2, 'upright': False}
        if path == ('ambience',):
            return {'headSway': {'amplitude': 1}, 'breathing': {'strength': 1}, 'dust': {'density': 1},
                    'candlelight': {'strength': 0.1, 'periodSec': 3.4}, 'flyingFlies': {'count': 5}}
        if len(path) == 2 and path[0] == 'hotspots': return _HS_FIELDS
        if len(path) == 4 and path[2] == 'operations':
            return {'narration': '', 'actions': [], 'requiresItem': ''}
        if len(path) == 4 and path[2] == 'itemUses': return {'narration': '', 'actions': []}
        return {}

    def _add(self):
        node = self._tree.currentItem()
        if node is None: return
        path = tuple(node.data(0, Qt.ItemDataRole.UserRole)); value = self._value(path)
        if isinstance(value, dict):
            defaults = self._optional(path); names = [k for k in defaults if k not in value]
            if not names: return
            key, ok = QInputDialog.getItem(self, '添加字段', '字段', names, editable=False)
            if not ok: return
            value[key] = deepcopy(defaults[key]); selected = path + (key,)
        elif isinstance(value, list):
            key = path[-1]
            if key in {'hotspots', 'operations'}:
                iid, ok = QInputDialog.getText(self, '新增条目', '新的 ID')
                if not ok: return
                iid = iid.strip()
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', iid) or any(v.get('id') == iid for v in value):
                    QMessageBox.warning(self, '无法新增', 'ID 须唯一，以字母开头，仅含字母、数字、下划线或短横线。'); return
                child = {'id': iid, 'label': iid}
                child.update({'x': 0, 'y': 0, 'width': 100, 'height': 100} if key == 'hotspots' else {'actions': []})
            elif key == 'itemUses': child = {'itemId': '', 'label': '', 'actions': []}
            elif key == 'polygon': child = {'x': 0, 'y': 0}
            else: return
            value.append(child); selected = path + (len(value) - 1,)
        else: return
        self._model.mark_dirty('object_examine'); self._rebuild_tree(selected); self._draw_preview()

    def _remove(self):
        node = self._tree.currentItem()
        if node is None: return
        path = tuple(node.data(0, Qt.ItemDataRole.UserRole))
        if not path or path[-1] not in self._optional(path[:-1]): return
        del self._value(path[:-1])[path[-1]]
        self._model.mark_dirty('object_examine'); self._rebuild_tree(path[:-1]); self._draw_preview()

    def _new_instance(self):
        iid, ok = QInputDialog.getText(self, '新建检视物件', '新的实例 ID')
        iid = iid.strip()
        if not ok: return
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', iid) or iid in self._model.object_examine_instances:
            QMessageBox.warning(self, '无法新增', 'ID 须唯一，以字母开头，仅含字母、数字、下划线或短横线。'); return
        self._model.object_examine_instances[iid] = {'id': iid, 'label': iid,
            'presentation': {'kind': 'still', 'image': '', 'physicalWidthCm': 100}, 'hotspots': []}
        self._model.object_examine_index.append({'id': iid, 'label': iid, 'file': iid + '.json'})
        self._model.mark_dirty('object_examine'); self.reload_refs_from_model(); self.select_by_id(iid)

    def _draw_preview(self):
        self._scene.blockSignals(True); self._scene.clear()
        if self._doc:
            path = disk_path_for_runtime_url(self._model, self._doc.get('presentation', {}).get('image', ''))
            if path and path.is_file():
                pixmap = QPixmap(str(path))
                if not pixmap.isNull(): self._scene.addPixmap(pixmap)
            for i, h in enumerate(self._doc.get('hotspots', [])):
                pen = QPen(QColor('#d76b4a'), 3)
                if len(h.get('polygon', [])) >= 3:
                    polygon = QPolygonF([QPointF(p['x'], p['y']) for p in h['polygon']])
                    rect = self._scene.addPolygon(polygon, pen)
                else:
                    rect = self._scene.addRect(h.get('x', 0), h.get('y', 0), h.get('width', 0), h.get('height', 0), pen)
                rect.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable)
                rect.setData(0, i)
        self._scene.blockSignals(False)
        self._preview.fitInView(self._scene.itemsBoundingRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def _preview_selected(self):
        selected = self._scene.selectedItems()
        if selected:
            node = self._tree_by_path.get(('hotspots', selected[0].data(0)))
            if node: self._tree.setCurrentItem(node); node.setExpanded(True)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._preview.fitInView(self._scene.itemsBoundingRect(), Qt.AspectRatioMode.KeepAspectRatio)
