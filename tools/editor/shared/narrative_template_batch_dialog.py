"""「给选中实体批量应用状态机模板」弹窗（场景编辑器右键入口的 UI 壳）。

只管收集：选哪张模板、手填参数填什么、要不要生成对话桩；真正的演算与暂存在
``narrative_template_batch``（纯逻辑、可无 Qt 单测）。**本弹窗不写任何文件、也不改 model**
——按下确定后由调用方拿 ``plan`` 去 ``apply_batch_stamp``，全有全无。

选择器纪律（norms 不变量 5）：模板与引用型参数一律走可搜索弹窗 / 列表，不用裸 QLineEdit；
只有 identifier / text / number / boolean 这几种**自由值**才允许直接输入。
"""
from __future__ import annotations

from typing import Any, Callable

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QVBoxLayout,
    QWidget,
)

from .dialog_geometry import remember_dialog_geometry
from .form_layout import compact_form
from .narrative_template_batch import (
    bound_param_names,
    free_params,
    plan_batch_stamp,
)
from .narrative_templates import (
    PARAM_SOURCES,
    normalize_templates_file,
    template_produces,
)
from .reference_picker import ReferencePickerField

_VALUE_ROLE = Qt.ItemDataRole.UserRole

# 产物种类的策划可读名（终审复审·可用性③：列表/预览不许甩 composition、dialogueStubs
# 这类 JSON 字段名——库内文案纪律）。键 = narrative_templates.PRODUCT_KINDS。
_PRODUCT_LABELS = {
    "composition": "状态机图",
    "quest": "任务",
    "dialogueStubs": "对话桩",
}

#: 引用型参数 → ProjectModel 的 id-provider。候选一律取自模型（禁手打引用），
#: 与 ``narrative_templates.REF_PARAM_CATALOG_KEY``（web 侧数据源）同一批参数类型。
_REF_PROVIDERS: dict[str, Callable[[Any], list]] = {
    "planeRef": lambda m: m.all_plane_ids(),
    "dialogueRef": lambda m: m.all_dialogue_graph_ids(),
    "sceneRef": lambda m: m.all_scene_ids(),
    "questRef": lambda m: m.all_quest_ids(),
    "cutsceneRef": lambda m: m.all_cutscene_ids(),
    "scenarioRef": lambda m: m.scenario_ids_ordered(),
    "npcRef": lambda m: m.all_npc_ids_global(),
    "hotspotRef": lambda m: m.all_hotspot_ids(),
    "zoneRef": lambda m: _zone_rows(m),
    "minigameRef": lambda m: (
        list(m.all_water_minigame_ids())
        + list(m.all_sugar_wheel_minigame_ids())
        + list(m.all_paper_craft_minigame_ids())
    ),
}


def _zone_rows(model: Any) -> list[tuple[str, str, str]]:
    """Zone 候选：**裸 id**（运行时 ZoneSystem 以 zone.id 建 owner 索引，限定形式索引不上），
    详情列出所在场景以便区分同名 zone。"""
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        for zone in scene.get("zones") or []:
            if not isinstance(zone, dict):
                continue
            zid = str(zone.get("id") or "").strip()
            if not zid or zid in seen:
                continue
            seen.add(zid)
            out.append((zid, str(zone.get("label") or zid), f"场景 {sid}"))
    return out


def _provider_rows(model: Any, ptype: str) -> list:
    fn = _REF_PROVIDERS.get(ptype)
    if fn is None:
        return []
    try:
        return list(fn(model) or [])
    except Exception:  # noqa: BLE001 - 候选取不到就给空表，不能让弹窗打不开
        return []


class NarrativeTemplateBatchDialog(QDialog):
    """选中实体 → 挑模板 → 填共享参数 → 预览 → 确定。``plan()`` 返回可直接应用的计划。"""

    def __init__(self, model: Any, targets: list[dict[str, Any]], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._targets = list(targets or [])
        self._plan: dict[str, Any] | None = None
        self._fields: dict[str, tuple[str, QWidget]] = {}
        # 预览 = 对 N 个实体各盖一次 + 整份 narrative 过一遍保存期校验。100 个箱子时
        # 每敲一个字重算一次会明显卡手，故统一走去抖；确认时另有一次同步重算。
        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(180)
        self._preview_timer.timeout.connect(self._refresh_preview)
        self.setWindowTitle(f"给 {len(self._targets)} 个实体应用状态机模板")

        root = QVBoxLayout(self)
        root.addWidget(QLabel(
            "每个实体各盖一份产物；id / ownerId 由实体推导（模板参数用 from 声明绑定）。\n"
            "全有全无：任一份出错则整批不写入；写入也只是暂存，落盘仍靠「全部保存」。",
        ))

        self._templates = normalize_templates_file(
            getattr(model, "narrative_templates", None),
        )["templates"]
        self._list = QListWidget(self)
        self._list.setToolTip("narrative_templates.json 里的状态机模板")
        for tpl in self._templates:
            produces = "、".join(_PRODUCT_LABELS.get(k, k) for k in template_produces(tpl))
            item = QListWidgetItem(
                f"{tpl.get('label') or tpl.get('id')}（{tpl.get('id')}）· 产出 {produces}",
            )
            item.setData(_VALUE_ROLE, str(tpl.get("id") or ""))
            self._list.addItem(item)
        self._list.currentRowChanged.connect(lambda _i: self._rebuild_param_form())
        root.addWidget(self._list, 1)

        self._form_host = QWidget(self)
        self._form = compact_form(QFormLayout(self._form_host))
        root.addWidget(self._form_host)

        self._gen_stubs = QCheckBox("同时生成缺失的对话桩", self)
        self._gen_stubs.setToolTip(
            "只对声明产出 dialogueStubs 的模板有效；已存在的对话图永不覆盖。\n"
            "共用一张发射端对话图的模板（箱子那种）不该勾。",
        )
        root.addWidget(self._gen_stubs)

        self._preview = QPlainTextEdit(self)
        self._preview.setReadOnly(True)
        self._preview.setMaximumHeight(160)
        root.addWidget(self._preview)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        self._ok_button = buttons.button(QDialogButtonBox.StandardButton.Ok)
        self._ok_button.setText("盖章")
        buttons.accepted.connect(self._on_accept)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

        if self._templates:
            self._list.setCurrentRow(0)
        else:
            self._preview.setPlainText(
                "narrative_templates.json 里还没有任何模板。\n"
                "先在「叙事状态机」页从一张现成作曲抽取模板，再回来批量盖章。",
            )
            self._ok_button.setEnabled(False)
        remember_dialog_geometry(self, "narrative_template_batch")

    # ---- 表单 -----------------------------------------------------------

    def current_template(self) -> dict[str, Any] | None:
        item = self._list.currentItem()
        if item is None:
            return None
        tid = str(item.data(_VALUE_ROLE) or "")
        return next((t for t in self._templates if str(t.get("id") or "") == tid), None)

    def _clear_form(self) -> None:
        self._fields.clear()
        while self._form.count():
            row = self._form.takeAt(0)
            widget = row.widget() if row is not None else None
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

    def _rebuild_param_form(self) -> None:
        self._clear_form()
        tpl = self.current_template()
        if tpl is None:
            return
        bound = bound_param_names(tpl)
        if bound:
            note = "、".join(f"{name} ← {PARAM_SOURCES.get(src, src)}" for name, src in bound.items())
            label = QLabel(f"由实体推导：{note}")
            label.setWordWrap(True)
            self._form.addRow(label)
        for p in free_params(tpl):
            name = str(p.get("name") or "")
            ptype = str(p.get("type") or "text")
            widget = self._build_field(ptype, p)
            widget.setToolTip(str(p.get("note") or "") or f"参数类型：{ptype}")
            self._form.addRow(f"{p.get('label') or name}：", widget)
            self._fields[name] = (ptype, widget)
        self._refresh_preview()

    def _build_field(self, ptype: str, param: dict[str, Any]) -> QWidget:
        default = param.get("default")
        if ptype == "boolean":
            box = QCheckBox(self._form_host)
            box.setChecked(bool(default))
            box.stateChanged.connect(lambda _s: self._schedule_preview())
            return box
        if ptype == "number":
            spin = QDoubleSpinBox(self._form_host)
            spin.setRange(-1e9, 1e9)
            spin.setDecimals(4)
            try:
                spin.setValue(float(default or 0))
            except (TypeError, ValueError):
                spin.setValue(0.0)
            spin.valueChanged.connect(lambda _v: self._schedule_preview())
            return spin
        if ptype in _REF_PROVIDERS:
            field = ReferencePickerField(
                provider=lambda t=ptype: _provider_rows(self._model, t),
                parent=self._form_host,
                title=f"选择{ptype}",
                geometry_key=f"narrative_template_batch_{ptype}",
            )
            if default not in (None, ""):
                field.set_value(str(default))
            field.value_changed.connect(lambda _v: self._schedule_preview())
            return field
        # identifier / text：自由值，唯一允许裸输入的两类。
        line = QLineEdit(self._form_host)
        line.setMaximumWidth(320)
        if default not in (None, ""):
            line.setText(str(default))
        line.textChanged.connect(lambda _t: self._schedule_preview())
        return line

    def shared_values(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, (ptype, widget) in self._fields.items():
            if ptype == "boolean":
                out[name] = bool(widget.isChecked())
            elif ptype == "number":
                value = widget.value()
                out[name] = int(value) if float(value).is_integer() else float(value)
            elif ptype in _REF_PROVIDERS:
                out[name] = widget.current_value()
            else:
                out[name] = widget.text().strip()
        return out

    # ---- 预览 / 确认 -----------------------------------------------------

    def _compute_plan(self) -> dict[str, Any]:
        tpl = self.current_template()
        if tpl is None:
            return {"ok": False, "errors": ["请先选择一张模板"], "warnings": [], "items": []}
        return plan_batch_stamp(
            self._model,
            str(tpl.get("id") or ""),
            self._targets,
            self.shared_values(),
            generate_dialogue_stubs=self._gen_stubs.isChecked(),
        )

    def _schedule_preview(self) -> None:
        self._preview_timer.start()

    def _refresh_preview(self) -> None:
        plan = self._compute_plan()
        self._plan = plan if plan.get("ok") else None
        lines: list[str] = []
        if plan.get("ok"):
            lines.append(f"将新增 {len(plan.get('items', []))} 份产物（产出：{'、'.join(_PRODUCT_LABELS.get(k, k) for k in plan.get('produces', []))}）")
            for item in plan.get("items", [])[:6]:
                target = item.get("target", {})
                lines.append(
                    f"  {target.get('kind')}:{target.get('id')} → 作曲 {item.get('compositionId')}"
                    + (f"、任务 {item['questId']}" if item.get("questId") else "")
                    + (f"、对话桩 {'/'.join(item['stubsStaged'])}" if item.get("stubsStaged") else ""),
                )
            if len(plan.get("items", [])) > 6:
                lines.append(f"  …… 其余 {len(plan['items']) - 6} 份同构")
        else:
            lines.append("暂不能盖章：")
            lines.extend(f"  {msg}" for msg in plan.get("errors", [])[:8])
        for warn in plan.get("warnings", [])[:6]:
            lines.append(f"  [warn] {warn}")
        self._preview.setPlainText("\n".join(lines))
        if self._templates:
            self._ok_button.setEnabled(bool(plan.get("ok")))

    def _on_accept(self) -> None:
        # 重算一次再收：预览是编辑期快照，中途别的页可能已经改过模型。
        self._refresh_preview()
        if self._plan is None or not self._plan.get("ok"):
            return
        self.accept()

    def plan(self) -> dict[str, Any] | None:
        return self._plan
