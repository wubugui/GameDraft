"""角色注册表：character_registry.json。

角色身份（名字 / 动画包 / 对话头像）在此**一处**定义，场景 NPC 用 `NpcDef.characterId`
引用——同一角色跨多个场景不再重复配置。头像 portraitSlug 留空则运行时按动画包目录名推导。
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QFormLayout,
    QListWidget,
    QListWidgetItem,
    QLineEdit,
    QComboBox,
    QPushButton,
    QLabel,
    QMessageBox,
)

from ..project_model import ProjectModel
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.portrait_catalog import load_portrait_sets

_ROLE = Qt.ItemDataRole.UserRole


class CharacterRegistryEditor(QWidget):
    """编辑 ``character_registry.json`` 的角色列表。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._cur_id: str | None = None

        root = QHBoxLayout(self)

        left = QVBoxLayout()
        left.addWidget(QLabel("角色"))
        self._list = QListWidget()
        self._list.currentItemChanged.connect(self._on_select)
        left.addWidget(self._list)
        btns = QHBoxLayout()
        b_add = QPushButton("新增")
        b_add.clicked.connect(self._add)
        b_del = QPushButton("删除")
        b_del.clicked.connect(self._del)
        btns.addWidget(b_add)
        btns.addWidget(b_del)
        left.addLayout(btns)
        left_w = QWidget()
        left_w.setLayout(left)
        left_w.setMaximumWidth(260)
        root.addWidget(left_w)

        form_w = QWidget()
        form = compact_form(QFormLayout(form_w))
        hint = QLabel(
            "身份在此定义、场景 NPC 用 characterId 引用（同角色跨场景只配一次）。"
            "portraitSlug 留空 = 按动画包目录名推导。"
        )
        hint.setWordWrap(True)
        form.addRow(hint)
        self._id = QLineEdit()
        self._id.setToolTip("角色 id（NpcDef.characterId 引用它）。改 id 会断开现有引用，慎改。")
        form.addRow("id", self._id)
        self._name = QLineEdit()
        form.addRow("name（显示名）", self._name)
        self._anim = IdRefSelector(allow_empty=True, editable=True)
        self._anim.setMinimumWidth(200)
        self._anim.setToolTip("动画包 anim.json（工程内已导出的包）。")
        form.addRow("animFile（动画包）", self._anim)
        self._portrait = QComboBox()
        self._portrait.setMinimumWidth(200)
        self._portrait.setToolTip("对话头像立绘集；留空=按动画包目录名同名推导。")
        form.addRow("portraitSlug（对话头像）", self._portrait)
        b_apply = QPushButton("Apply")
        b_apply.clicked.connect(self._apply)
        form.addRow(b_apply)
        root.addWidget(form_w, 1)

        self._reload_list()

    # 跨面板刷新约定：切到本页时重建列表（角色可能被场景侧新增引用不影响，这里只读注册表本身）
    def reload_refs_from_model(self) -> None:
        keep = self._cur_id
        self._reload_list()
        if keep:
            self._select_id(keep)

    def _reload_list(self) -> None:
        self._list.blockSignals(True)
        self._list.clear()
        for cid in sorted(self._model.character_registry):
            ch = self._model.character_registry[cid]
            it = QListWidgetItem(f"{ch.get('name') or cid}  ·  {cid}")
            it.setData(_ROLE, cid)
            self._list.addItem(it)
        self._list.blockSignals(False)

    def _select_id(self, cid: str) -> None:
        for i in range(self._list.count()):
            if self._list.item(i).data(_ROLE) == cid:
                self._list.setCurrentRow(i)
                return

    def _on_select(self, cur: QListWidgetItem | None, _prev: QListWidgetItem | None) -> None:
        if cur is None:
            self._cur_id = None
            return
        cid = str(cur.data(_ROLE) or "")
        ch = self._model.character_registry.get(cid) or {}
        self._cur_id = cid
        self._id.setText(cid)
        self._name.setText(str(ch.get("name") or ""))
        a_items = self._model.anim_asset_path_choices()
        af = str(ch.get("animFile") or "")
        if af and all(x[0] != af for x in a_items):
            a_items = [(af, af)] + a_items
        self._anim.blockSignals(True)
        self._anim.set_items(a_items)
        self._anim.set_current(af)
        self._anim.blockSignals(False)
        self._portrait.blockSignals(True)
        self._portrait.clear()
        self._portrait.addItem("（按动画包名推导）", "")
        if self._model.project_path is not None:
            for s in load_portrait_sets(self._model.project_path):
                self._portrait.addItem(s, s)
        ps = str(ch.get("portraitSlug") or "")
        if ps and self._portrait.findData(ps) < 0:
            self._portrait.addItem(f"{ps}（缺集）", ps)
        self._portrait.setCurrentIndex(max(0, self._portrait.findData(ps)))
        self._portrait.blockSignals(False)

    def _apply(self) -> None:
        cid = self._id.text().strip()
        if not cid:
            QMessageBox.warning(self, "角色", "id 不能为空。")
            return
        old = self._cur_id
        if old and old != cid and cid in self._model.character_registry:
            QMessageBox.warning(self, "角色", f"id {cid!r} 已存在。")
            return
        entry: dict = {"id": cid}
        nm = self._name.text().strip()
        if nm:
            entry["name"] = nm
        af = self._anim.current_id().strip()
        if af:
            entry["animFile"] = af
        ps = str(self._portrait.currentData() or "").strip()
        if ps:
            entry["portraitSlug"] = ps
        if old and old != cid:
            self._model.character_registry.pop(old, None)
        self._model.character_registry[cid] = entry
        self._model.mark_dirty("characterRegistry")
        self._reload_list()
        self._select_id(cid)

    def _add(self) -> None:
        i = 1
        while f"character_{i}" in self._model.character_registry:
            i += 1
        cid = f"character_{i}"
        self._model.character_registry[cid] = {"id": cid, "name": "新角色"}
        self._model.mark_dirty("characterRegistry")
        self._reload_list()
        self._select_id(cid)

    def _del(self) -> None:
        if not self._cur_id:
            return
        refs = [
            str(npc.get("id") or "")
            for sc in self._model.scenes.values()
            if isinstance(sc, dict)
            for npc in (sc.get("npcs") or [])
            if isinstance(npc, dict) and str(npc.get("characterId") or "").strip() == self._cur_id
        ]
        if refs:
            QMessageBox.warning(
                self, "角色",
                f"角色 {self._cur_id!r} 仍被 {len(refs)} 个 NPC 引用（如 {refs[0]}）。请先在场景里解除引用再删。",
            )
            return
        self._model.character_registry.pop(self._cur_id, None)
        self._model.mark_dirty("characterRegistry")
        self._cur_id = None
        self._reload_list()
