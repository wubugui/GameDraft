"""把老画布那 6657 行属性面板接进新画布 —— **一行都不改**。

## 核心决定：staging 降级成"UI 局部编辑缓冲"，不是第二份真相

老面板是 Apply 式的：编辑写进它自己的 staging 深拷贝，点「应用」才整份覆盖模型。
老画布因此有**两层真相**，"这次写哪一份"要在几十处写入路径里各自判断 ——
那正是本次重建要消灭的根因。

新画布不接受两层真相。所以这里的接法是：

- 面板照旧把编辑写进它自己的 staging（那是它的内部实现，不改）；
- **Document 永远不读 staging**（`staging_dict_for` 恒返回 None，`write_target`
  恒指向模型）；
- 面板每发一次 `changed`，桥就把 staging 与模型逐字段比对，**把差异做成一条命令**
  推进撤销栈。

于是：面板功能一条不少，而"写入只有命令一条路"这条不变量仍然成立。
方案书 §5.7「Step 5 删 staging」要的效果在这里已经达成 —— staging 不再是真相，
只是一个还没被重写的输入控件集合的内部缓冲。

## 为什么不是"等 Apply 再提交"

Apply 式提交会让撤销粒度变成"一整页表单"，而且用户不点 Apply 直接切走就丢编辑
（老画布为此长出了 commit-on-leave / confirm_close / flush_to_model 一整套补丁）。
即时命令化之后，这三条补丁**没有存在的理由** —— 页面的对应钩子因此可以恒为 True。

## 合并

连续编辑（拖数值框、连打方向键）由命令合并收成一条撤销记录，判据是"同一实体 +
同一批字段"。跨实体或跨字段集就自然断开，不会把两次不相干的编辑并成一条。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import QObject

from .changes import EntityProperty, EntityRef
from .commands import build_change_fields_command

__all__ = ["PanelBridge", "diff_fields"]

#: 面板 staging 里这些键是它自己的记账，不该写进场景数据。
_INTERNAL_KEYS = frozenset()


def diff_fields(staged: dict, current: dict) -> dict:
    """staging 与模型逐字段比对，返回**需要写入的字段**。

    只看 staging 里出现过的键：面板不碰的键（未受管字段、AI 写的未知键）
    因此原样留在模型里 —— 黄金往返要求未受管字段零篡改。

    刻意**区分 int/float 表示**（`100` 与 `100.0` 视为不同），与命令层同口径：
    数值往返保真要求未改动的数值键按原始表示回写。
    """
    out: dict = {}
    for key, value in staged.items():
        if key in _INTERNAL_KEYS:
            continue
        old = current.get(key, _ABSENT)
        if old is _ABSENT:
            out[key] = copy.deepcopy(value)
            continue
        if type(old) is not type(value) or old != value:
            out[key] = copy.deepcopy(value)
    return out


class _Absent:
    __slots__ = ()


_ABSENT = _Absent()

#: 实体族 → 面板的 staging 属性名 / 载入方法名
_PANEL_BINDING = {
    "hotspot": ("_staging_hotspot", "load_hotspot_props"),
    "npc": ("_staging_npc", "load_npc_props"),
    "zone": ("_staging_zone", "load_zone_props"),
}


class PanelBridge(QObject):
    """`ScenePropertyPanel` ↔ `SceneDocument` 的双向桥。"""

    def __init__(self, panel, document, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._panel = panel
        self._doc = document
        self._loaded: EntityRef | None = None
        self._syncing = False
        self._gesture_open = False
        panel.changed.connect(self._on_panel_changed)
        document.changed.connect(self._on_document_changed)

    # ---- Document 侧的 StagingProvider 契约 --------------------------------

    def staging_dict_for(self, kind: str, entity_id: str) -> dict | None:
        """**恒返回 None** —— Document 永远写模型。

        这是本桥最要紧的一行。返回 staging 会让"两层真相"整套问题原地复活：
        画布拖动写进面板的深拷贝，而面板下一次 Apply 又用那份深拷贝整份覆盖模型，
        期间任何直写模型的改动都被静默盖掉（P1-01 / P1-25 那族事故）。
        """
        return None

    # ---- 选择 → 载入面板 ---------------------------------------------------

    def _on_document_changed(self, event) -> None:
        from .changes import SelectionChanged
        if not isinstance(event, SelectionChanged):
            return
        self.sync_from_selection()

    def sync_from_selection(self) -> None:
        sel = self._doc.selection
        if len(sel) != 1:
            self._loaded = None
            return
        ref = sel[0]
        binding = _PANEL_BINDING.get(ref.kind)
        if binding is None:
            self._loaded = None
            return
        ent = self._doc.model_entity(ref)
        if not isinstance(ent, dict):
            self._loaded = None
            return
        loader = getattr(self._panel, binding[1], None)
        if not callable(loader):
            self._loaded = None
            return
        self._syncing = True
        try:
            loader(ent)
        finally:
            self._syncing = False
        self._loaded = ref

    def reload_current(self) -> None:
        """撤销/重做或外部改动之后，把面板刷成模型的当前值。

        不刷的话面板还显示旧值，用户下一次编辑会把**旧值连同新编辑**一起写回去，
        等于把撤销悄悄撤销了。
        """
        ref = self._loaded
        if ref is None:
            return
        self._loaded = None
        self._doc_ref_reload(ref)

    def _doc_ref_reload(self, ref: EntityRef) -> None:
        keep = self._doc.selection
        self._loaded = None
        if ref in keep:
            self.sync_from_selection()

    # ---- 面板编辑 → 命令 ---------------------------------------------------

    def begin_gesture(self) -> None:
        """连续编辑的起点（例如按下数值框的上下箭头）。之后的变更并进同一条命令。"""
        self._gesture_open = False

    def _on_panel_changed(self) -> None:
        if self._syncing or self._loaded is None or self._doc.restoring:
            return
        self.commit_panel_edits()

    def commit_panel_edits(self) -> bool:
        """把面板 staging 与模型的差异做成**一条命令**。无差异则什么都不做。"""
        ref = self._loaded
        if ref is None:
            return False
        binding = _PANEL_BINDING.get(ref.kind)
        if binding is None:
            return False
        staged = getattr(self._panel, binding[0], None)
        current = self._doc.model_entity(ref)
        if not isinstance(staged, dict) or not isinstance(current, dict):
            return False
        # 面板可能已经把 id 改了：以**载入时的 ref** 为准去找模型行，
        # 否则改完 id 就再也定位不到那一行（老画布靠 _source_* 引用兜这件事）。
        fields = diff_fields(staged, current)
        if not fields:
            return False
        cmd = build_change_fields_command(
            self._doc, [ref], [fields], _properties_for(fields), "编辑属性",
            mergeable=self._gesture_open)
        pushed = self._doc.push(cmd)
        if pushed:
            self._gesture_open = True
        return pushed


#: 字段名 → 变更类别。订阅者据此决定"重摆"还是"重建"（重建要读盘，最贵）。
_FIELD_PROPERTY = {
    "x": EntityProperty.POSITION, "y": EntityProperty.POSITION,
    "scale": EntityProperty.TRANSFORM, "rotation": EntityProperty.TRANSFORM,
    "polygon": EntityProperty.GEOMETRY,
    "collisionPolygon": EntityProperty.GEOMETRY,
    "collisionPolygonLocal": EntityProperty.GEOMETRY,
    "patrol": EntityProperty.GEOMETRY,
    "displayImage": EntityProperty.APPEARANCE,
    "animFile": EntityProperty.APPEARANCE,
    "id": EntityProperty.IDENTITY, "name": EntityProperty.IDENTITY,
    "label": EntityProperty.IDENTITY,
    "group": EntityProperty.GROUPING,
    "planes": EntityProperty.PRESENCE, "phases": EntityProperty.PRESENCE,
    "cutsceneIds": EntityProperty.PRESENCE,
    "cutsceneOnly": EntityProperty.PRESENCE,
    "spriteSort": EntityProperty.SORT,
}


def _properties_for(fields: dict) -> EntityProperty:
    """把字段集折成 property 位掩码。

    未登记的字段落 `BEHAVIOUR`（交互半径、条件之类不影响画面几何的）——
    **刻意不落 ALL**：落 ALL 会让每次改个无关字段都触发全量重建，包括读盘。
    """
    out = EntityProperty.NONE
    for key in fields:
        out |= _FIELD_PROPERTY.get(key, EntityProperty.BEHAVIOUR)
    return out or EntityProperty.BEHAVIOUR
