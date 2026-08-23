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

from .changes import (
    EntitiesChanged,
    EntityProperty,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
)
from .commands import _MISSING, build_change_fields_command

__all__ = ["PanelBridge", "diff_fields"]

#: 面板 staging 里这些键是它自己的记账，不该写进场景数据。
_INTERNAL_KEYS = frozenset()


def diff_fields(staged: dict, current: dict) -> dict:
    """staging 与模型逐字段比对，返回**需要写入的字段**。

    `staged` 是面板对该实体的**完整投影**（`load_*_props` 深拷贝 + 控件 flush），
    所以两个方向都要比：

    - staged 有而 current 没有 / 值不同 → 写入；
    - **current 有而 staged 没有 → 删键**。取消勾选、清空下拉这类操作正是靠
      「键消失」表达的；只比 staged 的键会让"取消勾选"永远存不下来。

    **数值相等即视为未改动**，即使 int/float 表示不同。这一条与命令层刻意相反，
    理由是这两层的输入性质不同：命令层的入参是工具**主动写下**的值，表示变化就是
    真实意图；而这里的 `staged` 是一份**穿过控件的投影** —— `QDoubleSpinBox`
    一律吐 float，面板的 x/y 实时回写更是硬编码 `float(...)`。于是用户只拖了 x，
    同一实体的 y 也被顺手变成 `320.0`。若按表示判定，每次提交都会捎带一串
    "值没变、只多了 `.0`" 的假改动写进场景（真实场景里成串的整数坐标会被逐个
    污染），diff 与黄金往返双双失真。

    bool 单独挡在前面：Python 里 `True == 1`，不挡就会把"勾选变成 1"当作没变。
    """
    out: dict = {}
    for key, value in staged.items():
        if key in _INTERNAL_KEYS:
            continue
        old = current.get(key, _ABSENT)
        if old is _ABSENT:
            if _is_empty_default(value):
                # **面板给缺省键刷了个空值 ≠ 用户改了东西。**
                # `_write_*_widgets_to_dict` 会把面板管的每个键都写一遍，空文本框
                # 写成 `""`、空表写成 `{}`。本仓约定"缺省不落键"（写空值污染 JSON、
                # 黄金往返立刻红），而且这会让**光是选中一个实体**就产生一条命令：
                # 撤销栈平白多一格、场景被标脏，用户什么都没做。
                continue
            out[key] = copy.deepcopy(value)
            continue
        if _same_value(old, value):
            continue
        out[key] = copy.deepcopy(value)
    for key in current:
        if key in _INTERNAL_KEYS or key in staged:
            continue
        out[key] = _MISSING          # 命令层认这个哨兵 = 删键
    return out


#: 视为"没写"的空值。**不含 `0` / `False`** —— 它们是有意义的取值，
#: 与"这个键不存在"不是一回事（`interactionRange: 0` 与缺省的 50 天差地别）。
_EMPTY_DEFAULTS = ("", {}, [])


def _is_empty_default(value) -> bool:
    if isinstance(value, bool) or isinstance(value, (int, float)):
        return False
    if value is None:
        return True
    return any(value == e and type(value) is type(e) for e in _EMPTY_DEFAULTS)


def _same_value(old, new) -> bool:
    """两个 staging 值是否"没有实质变化"。

    数值只比大小、不比 int/float 表示（理由见 `diff_fields`）；其余按 `==`。
    """
    if isinstance(old, bool) or isinstance(new, bool):
        return type(old) is type(new) and old == new
    if isinstance(old, (int, float)) and isinstance(new, (int, float)):
        return float(old) == float(new)
    return old == new


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
        self._committing = False
        panel.changed.connect(self._on_panel_changed)
        document.changed.connect(self._on_document_changed)

    def detach(self) -> None:
        """断开与面板/文档的连线。

        **换场景时必须调。** 面板是**页面级共享**的（每次换场景不重建），
        而桥的 parent 是页面 —— 不断开的话每换一次场景就多一个活着的旧桥挂在
        `panel.changed` 上，它们仍持着上一个场景的 ref 与**已析构的**文档：
        轻则把编辑写进上一个场景的同名实体，重则碰死掉的 QUndoStack 抛
        `Internal C++ object already deleted`。实测每次重载多两个接收者。
        """
        for sig, slot in ((self._panel.changed, self._on_panel_changed),
                          (self._doc.changed, self._on_document_changed)):
            try:
                sig.disconnect(slot)
            except (RuntimeError, TypeError):
                pass    # 已断开或宿主已析构：目的已达到
        self._loaded = None

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
        if isinstance(event, SelectionChanged):
            self.sync_from_selection()
            return
        if isinstance(event, SceneReloaded):
            self.sync_from_selection()
            return
        if isinstance(event, EntitiesChanged):
            # **本桥自己发起的那次变更不要回灌** —— 那会在用户打字的中途把控件
            # 重置回刚提交的值（光标跳走、输入法中断）。
            if self._committing:
                return
            if self._loaded is not None and self._loaded in event.refs:
                # 画布拖动 / 撤销 / 别处改动 → 面板必须刷成模型当前值。
                # 不刷的话下一次面板编辑会把**陈旧值连同新编辑**一起写回去，
                # 等于把刚才那次拖动（或撤销）悄悄撤销。
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
        """把面板的当前控件值与模型的差异做成**一条命令**。无差异则什么都不做。

        **必须先把控件刷进 staging。** 老面板绝大多数控件的信号只接
        `_emit_props_changed()`（置脏 + 发信号），**不写 staging**；staging 只在
        `flush_active_panel_widgets_to_staging()` 里由 `_write_*_widgets_to_dict`
        一次性刷新。少了这一步，桥读到的永远是"载入时的深拷贝"，diff 恒为空、
        命令永不构造 —— 改标签、改类型、取消勾选全部**静默丢失**，而且因为本页
        的 flush/confirm_close 恒为 True，切页关窗连一句提示都没有。

        本方法**不可重入**。`flush_active_panel_widgets_to_staging()` 内部会调
        `_emit_props_changed()`，那正是把本方法接上去的那个信号 —— 不挡住就是
        `commit → flush → 信号 → commit → …` 的无限递归，直接把进程**栈溢出打死**
        （不是抛异常，是硬崩）。老面板刷 staging 顺手发信号是它的既有行为，
        桥这一侧必须自己扛住。
        """
        if self._committing:
            return False
        ref = self._loaded
        if ref is None:
            return False
        binding = _PANEL_BINDING.get(ref.kind)
        if binding is None:
            return False
        self._committing = True
        try:
            flush = getattr(self._panel, "flush_active_panel_widgets_to_staging", None)
            if callable(flush):
                flush()
        finally:
            self._committing = False
        staged = getattr(self._panel, binding[0], None)
        current = self._doc.model_entity(ref)
        if not isinstance(staged, dict) or not isinstance(current, dict):
            return False
        # 以**载入时的 ref** 为准去找模型行：面板可能已经把 id 改了，
        # 用新 id 就再也定位不到那一行（老画布靠 _source_* 引用兜这件事）。
        fields = diff_fields(staged, current)
        if not fields:
            return False
        cmd = build_change_fields_command(
            self._doc, [ref], [fields], _properties_for(fields), "编辑属性",
            mergeable=self._gesture_open)
        self._committing = True
        try:
            pushed = self._doc.push(cmd)
        finally:
            self._committing = False
        if pushed:
            self._gesture_open = True
            if "id" in fields and fields["id"] is not _MISSING:
                # id 改了：后续编辑要认新的那一行，否则第二次编辑定位不到
                self._loaded = EntityRef(ref.kind, str(fields["id"]))
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
