"""位面（planes.json）编辑器。

与运行时约定见 `src/systems/plane/types.ts`（PlaneDef，TS 权威）：
- 任意时刻恰有一个激活位面；`normal` 为开局默认，允许各槽全空。
- 实体归属经 hotspot/npc/zone 的可选 `planes: string[]`（缺省=存在于所有位面），
  在场景编辑器里维护；叙事状态节点用 `activePlane` 点名位面。
- 本编辑器维护位面自身的系统配置：extends（数据层组合，槽级继承）、membership
  （世界模型 shared/exclusive）与六槽 movement / interaction / camera / lighting /
  travel / healthDrainPerSec。缺省值不落键（保持 JSON 干净），未知键原样保留。
"""
from __future__ import annotations

import copy
import json

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSplitter,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.list_affordances import wire_list_affordances
from ..shared.numeric_roundtrip import preserve_numeric_repr

_MOVEMENT_KEYS = ("driftX", "driftY", "speedScale", "allowRun")
_INTERACTION_KEYS = ("canPickup", "canInteractHotspots", "canTalkNpcs")

#: extends 槽级继承回填的键——必须与运行时 PlaneReconciler.INHERITED_SLOT_KEYS 一致
#: （parity 测试锁定，防两侧清单漂移）。
INHERITED_SLOT_KEYS = (
    "membership",
    "movement",
    "interaction",
    "camera",
    "lighting",
    "travel",
    "healthDrainPerSec",
)


def resolve_effective_slots(planes: list, plane_id: str) -> tuple[dict, dict]:
    """按运行时 expandExtends 口径解析 plane_id 各槽的生效值（复核 P1-05）。

    返回 (effective, source)：effective[k] = 生效值；source[k] = 提供该槽的位面 id
    （== plane_id 表示本位面显式写了该槽）。槽级覆盖：本位面写了某槽整槽用自己的，
    缺槽沿 extends 链取第一个写了的祖先。环/缺父与运行时一致——中断继承。
    """
    by_id: dict[str, dict] = {}
    for p in planes or []:
        if isinstance(p, dict):
            pid = str(p.get("id") or "").strip()
            if pid:
                by_id[pid] = p  # 重复 id 后者胜（与运行时 Map.set 一致）
    effective: dict = {}
    source: dict = {}
    seen: set[str] = set()
    cur_id = plane_id
    cur = by_id.get(cur_id)
    while isinstance(cur, dict) and cur_id not in seen:
        seen.add(cur_id)
        for k in INHERITED_SLOT_KEYS:
            if k not in effective and k in cur:
                effective[k] = cur[k]
                source[k] = cur_id
        nxt = cur.get("extends")
        cur_id = nxt.strip() if isinstance(nxt, str) else ""
        cur = by_id.get(cur_id) if cur_id else None
    return effective, source


class PlaneEditor(QWidget):
    """planes.json 编辑器（数据类型 'planes'）。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        self._pending_lighting: dict | None = None

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 位面")
        btn_add.setToolTip(
            "新增一个位面。列表为空时会先补齐首条 normal（常态）位面。",
        )
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中的位面（Delete 键 / 右键菜单亦可）；normal 不可删除。")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除位面")
        ll.addWidget(self._list)

        right_host = QWidget()
        rl = QVBoxLayout(right_host)

        basic_box = QGroupBox("基本")
        f = compact_form(QFormLayout())
        basic_box.setLayout(f)
        self._f_id = QLineEdit()
        self._f_id.setToolTip(
            "位面 id，全表唯一；被实体 planes 归属与叙事状态 activePlane 引用。"
            "normal 为开局默认激活位面。",
        )
        f.addRow("id", self._f_id)
        self._f_label = QLineEdit()
        self._f_label.setMinimumWidth(200)
        self._f_label.setToolTip("显示名（可空；空则各处以 id 展示）")
        f.addRow("label", self._f_label)
        self._f_extends = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._f_extends.setToolTip(
            "数据层组合（单继承）：加载期按槽级覆盖展开——本位面写了某槽整槽用自己的，"
            "未写的槽继承父位面。空=不继承。normal 不可继承他者。",
        )
        self._f_extends.value_changed.connect(self._on_extends_changed)
        f.addRow("extends", self._f_extends)
        self._f_membership = QComboBox()
        self._f_membership.addItem("（继承/缺省）", "")
        self._f_membership.addItem("shared（共享世界型，显式）", "shared")
        self._f_membership.addItem("exclusive（独立世界型）", "exclusive")
        self._f_membership.setToolTip(
            "世界模型：决定无 planes 归属字段的实体在本位面是否存在。\n"
            "（继承/缺省）=不写键：有 extends 时沿链继承父位面，否则按缺省 shared；\n"
            "shared（显式）：缺省实体存在，同一世界加修饰；\n"
            "exclusive：缺省实体不存在，异世界从空场景开始，只有显式归属实体在。\n"
            "normal 恒为共享世界型。",
        )
        f.addRow("membership", self._f_membership)
        self._f_inherit_summary = QLabel("")
        self._f_inherit_summary.setWordWrap(True)
        self._f_inherit_summary.setToolTip(
            "extends 槽级继承的生效来源（与运行时展开口径一致）。"
            "只列继承自祖先的槽；本位面显式写的槽不在其中。",
        )
        self._f_inherit_summary.setVisible(False)
        f.addRow("继承生效", self._f_inherit_summary)
        rl.addWidget(basic_box)

        mv_sec = CollapsibleSection("移动 movement（漂移 / 移速 / 禁跑）", start_open=False)
        mv_sec.set_header_tool_tip(
            "玩家控制器槽：漂移向量加、移速系数乘、allowRun 取 AND。"
            "缺省值（0 / 1 / 允许跑）不写入 JSON。默认折叠。",
        )
        mv_inner = QWidget()
        mf = compact_form(QFormLayout(mv_inner))
        self._f_mv_gate = QCheckBox("本位面显式配置此槽（不继承）")
        self._f_mv_gate.setToolTip(
            "运行时按整槽继承：本位面写了 movement 整槽用自己的，未写则沿 extends 继承。\n"
            "勾选=写入 movement 槽（全缺省也写 {}，即『用缺省覆盖父配置』）；\n"
            "不勾选=不写键（继承/缺省），下方灰显生效值。",
        )
        self._f_mv_gate.toggled.connect(self._on_slot_gate_toggled)
        mf.addRow(self._f_mv_gate)
        # 数值往返保真：decimals/range 必须宽到"载入即显示原值"（显示舍入/范围夹取会让
        # 纯浏览后 _is_dirty 为真、commit-on-leave 把走样值写回模型）。
        self._f_drift_x = QDoubleSpinBox()
        self._f_drift_x.setRange(-1000000.0, 1000000.0)
        self._f_drift_x.setDecimals(6)
        self._f_drift_x.setSingleStep(1.0)
        self._f_drift_x.setToolTip("水平漂移（世界单位/秒；0=无，缺省不写键）")
        mf.addRow("driftX", self._f_drift_x)
        self._f_drift_y = QDoubleSpinBox()
        self._f_drift_y.setRange(-1000000.0, 1000000.0)
        self._f_drift_y.setDecimals(6)
        self._f_drift_y.setSingleStep(1.0)
        self._f_drift_y.setToolTip("垂直漂移（世界单位/秒；0=无，缺省不写键）")
        mf.addRow("driftY", self._f_drift_y)
        self._f_speed_scale = QDoubleSpinBox()
        self._f_speed_scale.setRange(0.0, 1000.0)
        self._f_speed_scale.setDecimals(6)
        self._f_speed_scale.setSingleStep(0.05)
        self._f_speed_scale.setValue(1.0)
        self._f_speed_scale.setToolTip("移速系数（乘在场景基础移速上；1=不变，缺省不写键）")
        mf.addRow("speedScale", self._f_speed_scale)
        self._f_allow_run = QCheckBox("允许跑步")
        self._f_allow_run.setChecked(True)
        self._f_allow_run.setToolTip("缺省允许；取消勾选写 allowRun:false（该位面禁跑）")
        mf.addRow("allowRun", self._f_allow_run)
        mv_sec.add_body(mv_inner)
        rl.addWidget(mv_sec)

        it_sec = CollapsibleSection("交互 interaction（拾取 / 热点 / NPC）", start_open=False)
        it_sec.set_header_tool_tip(
            "交互门闸槽：三项缺省均允许（true 不写键）；取消勾选写 false。默认折叠。",
        )
        it_inner = QWidget()
        itf = compact_form(QFormLayout(it_inner))
        self._f_it_gate = QCheckBox("本位面显式配置此槽（不继承）")
        self._f_it_gate.setToolTip(
            "勾选=写入 interaction 槽（全缺省也写 {}，覆盖父配置）；"
            "不勾选=不写键（继承/缺省），下方灰显生效值。",
        )
        self._f_it_gate.toggled.connect(self._on_slot_gate_toggled)
        itf.addRow(self._f_it_gate)
        self._f_can_pickup = QCheckBox("允许拾取")
        self._f_can_pickup.setChecked(True)
        self._f_can_pickup.setToolTip("缺省允许；取消勾选写 canPickup:false")
        itf.addRow("canPickup", self._f_can_pickup)
        self._f_can_hotspots = QCheckBox("允许交互热点")
        self._f_can_hotspots.setChecked(True)
        self._f_can_hotspots.setToolTip("缺省允许；取消勾选写 canInteractHotspots:false")
        itf.addRow("canInteractHotspots", self._f_can_hotspots)
        self._f_can_talk = QCheckBox("允许与 NPC 对话")
        self._f_can_talk.setChecked(True)
        self._f_can_talk.setToolTip("缺省允许；取消勾选写 canTalkNpcs:false")
        itf.addRow("canTalkNpcs", self._f_can_talk)
        it_sec.add_body(it_inner)
        rl.addWidget(it_sec)

        tv_sec = CollapsibleSection("旅行 travel（地图快速旅行门闸）", start_open=False)
        tv_sec.set_header_tool_tip(
            "旅行插件槽：位面激活期间是否允许打开地图快速旅行（面板与 map:travel 双闸）。"
            "缺省允许（true 不写键）。默认折叠。",
        )
        tv_inner = QWidget()
        tvf = compact_form(QFormLayout(tv_inner))
        self._f_tv_gate = QCheckBox("本位面显式配置此槽（不继承）")
        self._f_tv_gate.setToolTip(
            "勾选=写入 travel 槽（全缺省也写 {}，覆盖父配置）；"
            "不勾选=不写键（继承/缺省），下方灰显生效值。",
        )
        self._f_tv_gate.toggled.connect(self._on_slot_gate_toggled)
        tvf.addRow(self._f_tv_gate)
        self._f_allow_map_travel = QCheckBox("允许地图快速旅行")
        self._f_allow_map_travel.setChecked(True)
        self._f_allow_map_travel.setToolTip(
            "缺省允许；取消勾选写 travel.allowMapTravel:false"
            "（该位面激活期间地图面板拒开并提示，map:travel 事件同样被拦）",
        )
        tvf.addRow("allowMapTravel", self._f_allow_map_travel)
        tv_sec.add_body(tv_inner)
        rl.addWidget(tv_sec)

        misc_sec = CollapsibleSection("相机 / 掉阳气", start_open=False)
        misc_sec.set_header_tool_tip(
            "camera.zoom：位面激活期间的相机档（后者胜）；healthDrainPerSec：每秒掉阳气。默认折叠。",
        )
        misc_inner = QWidget()
        cf = compact_form(QFormLayout(misc_inner))
        zoom_row = QWidget()
        zrl = QHBoxLayout(zoom_row)
        zrl.setContentsMargins(0, 0, 0, 0)
        self._f_zoom_chk = QCheckBox("自定义")
        self._f_zoom_chk.setToolTip("勾选则该位面覆盖相机 zoom；不勾选不写 camera.zoom 键")
        self._f_zoom = QDoubleSpinBox()
        self._f_zoom.setRange(0.01, 100.0)
        self._f_zoom.setDecimals(6)
        self._f_zoom.setSingleStep(0.05)
        self._f_zoom.setValue(1.0)
        self._f_zoom.setEnabled(False)
        self._f_zoom.setToolTip("相机缩放档（与场景 camera.zoom 同语义）")
        self._f_zoom_chk.toggled.connect(self._f_zoom.setEnabled)
        zrl.addWidget(self._f_zoom_chk)
        zrl.addWidget(self._f_zoom)
        zrl.addStretch(1)
        cf.addRow("camera.zoom", zoom_row)
        drain_row = QWidget()
        drl = QHBoxLayout(drain_row)
        drl.setContentsMargins(0, 0, 0, 0)
        self._f_drain_chk = QCheckBox("显式写入")
        self._f_drain_chk.setToolTip(
            "勾选=写 healthDrainPerSec 键（写 0 也是显式值，可覆盖父位面的掉血）；\n"
            "不勾选=不写键（继承/缺省 0），右侧灰显生效值。",
        )
        self._f_drain = QDoubleSpinBox()
        self._f_drain.setRange(0.0, 1000000.0)
        self._f_drain.setDecimals(6)
        self._f_drain.setSingleStep(0.1)
        self._f_drain.setEnabled(False)
        self._f_drain.setToolTip("位面激活期间每秒扣的阳气量；0=不掉")
        self._f_drain_chk.toggled.connect(self._f_drain.setEnabled)
        drl.addWidget(self._f_drain_chk)
        drl.addWidget(self._f_drain)
        drl.addStretch(1)
        cf.addRow("healthDrainPerSec", drain_row)
        misc_sec.add_body(misc_inner)
        rl.addWidget(misc_sec)

        lt_sec = CollapsibleSection("光照 lighting（SceneLightEnv 局部档）", start_open=False)
        lt_sec.set_header_tool_tip(
            "位面激活期间叠加的光照档（partial SceneLightEnv，运行时 resolveLightEnv 补全）。"
            "字段较专业，走「专家 JSON…」编辑；空=不写键。默认折叠。",
        )
        lt_inner = QWidget()
        ltl = QVBoxLayout(lt_inner)
        self._f_lighting_preview = QLabel("（未配置）")
        self._f_lighting_preview.setWordWrap(True)
        self._f_lighting_preview.setToolTip("只读预览；用下方按钮编辑")
        ltl.addWidget(self._f_lighting_preview)
        lt_btn_row = QHBoxLayout()
        btn_lt_edit = QPushButton("专家 JSON…")
        btn_lt_edit.setToolTip(
            "以 JSON 直接编辑 lighting（SceneLightEnv 局部档，如 key/ambient/shadow/toneStrength）。"
            "留空并确定=清除。",
        )
        btn_lt_edit.clicked.connect(self._edit_lighting_json)
        lt_btn_row.addWidget(btn_lt_edit)
        lt_btn_row.addStretch(1)
        ltl.addLayout(lt_btn_row)
        lt_sec.add_body(lt_inner)
        rl.addWidget(lt_sec)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)
        rl.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right_host)

        # 位面面板 = 策划总入口 hub：配置之外还聚合点名反向索引 / 归属实体 / 问题。
        # 后三页是纯反向索引聚合视图，数据所有权仍在叙事编辑器 / 场景编辑器 / validator。
        self._tabs = QTabWidget()
        self._tabs.addTab(scroll, "配置")
        self._tabs.addTab(self._build_naming_tab(), "点名状态机")
        self._tabs.addTab(self._build_members_tab(), "归属实体")
        self._tabs.addTab(self._build_issues_tab(), "问题")
        self._tabs.currentChanged.connect(self._on_tab_changed)

        splitter.addWidget(left)
        splitter.addWidget(self._tabs)
        splitter.setSizes([220, 640])
        root.addWidget(splitter)
        self._refresh()

    # ---- hub 页签（点名 / 归属 / 问题）--------------------------------------

    def _build_naming_tab(self) -> QWidget:
        host = QWidget()
        lay = QVBoxLayout(host)
        hint = QLabel("哪些叙事状态机的哪些状态点名（activePlane）当前选中位面。双击跳转叙事编辑器定位。")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self._naming_tree = QTreeWidget()
        self._naming_tree.setHeaderLabels(["状态机图", "状态", "显示名"])
        self._naming_tree.setRootIsDecorated(False)
        self._naming_tree.itemDoubleClicked.connect(self._on_naming_double_clicked)
        self._naming_tree.setToolTip("双击行：切到「叙事状态机」页并聚焦该状态")
        lay.addWidget(self._naming_tree, 1)
        return host

    def _build_members_tab(self) -> QWidget:
        host = QWidget()
        lay = QVBoxLayout(host)
        hint = QLabel(
            "显式归属（planes 含该 id）当前选中位面的场景实体，按场景分组。"
            "双击实体行跳转场景编辑器并打开该位面的位面视图。",
        )
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self._members_tree = QTreeWidget()
        self._members_tree.setHeaderLabels(["场景 / 实体", "类型"])
        self._members_tree.itemDoubleClicked.connect(self._on_member_double_clicked)
        self._members_tree.setToolTip("双击实体行：切到「Scene」页选中该实体并开位面视图")
        lay.addWidget(self._members_tree, 1)
        return host

    def _build_issues_tab(self) -> QWidget:
        host = QWidget()
        lay = QVBoxLayout(host)
        row = QHBoxLayout()
        btn = QPushButton("运行校验")
        btn.setToolTip("跑全量 validator 并过滤位面相关问题（plane 数据域 + activatePlane / plane 条件叶子相关）")
        btn.clicked.connect(self._refresh_issues_tab)
        row.addWidget(btn)
        self._issues_status = QLabel("")
        row.addWidget(self._issues_status, 1)
        lay.addLayout(row)
        self._issues_list = QListWidget()
        lay.addWidget(self._issues_list, 1)
        return host

    def _current_plane_id(self) -> str:
        if 0 <= self._current_idx < len(self._model.planes):
            return str(self._model.planes[self._current_idx].get("id") or "").strip()
        return ""

    def _on_tab_changed(self, idx: int) -> None:
        if idx == 1:
            self._refresh_naming_tab()
        elif idx == 2:
            self._refresh_members_tab()

    def _refresh_hub_tabs_for_selection(self) -> None:
        """切换选中位面后，只刷新当前可见的 hub 页（其余页在切页签时懒刷新）。"""
        idx = self._tabs.currentIndex() if hasattr(self, "_tabs") else 0
        if idx == 1:
            self._refresh_naming_tab()
        elif idx == 2:
            self._refresh_members_tab()

    def _iter_all_narrative_graphs(self):
        """mainGraph + 元素内嵌子图（与 validator._iter_narrative_graphs 同口径）。"""
        data = getattr(self._model, "narrative_graphs", None)
        if not isinstance(data, dict):
            return
        for comp in data.get("compositions") or []:
            if not isinstance(comp, dict):
                continue
            main = comp.get("mainGraph")
            if isinstance(main, dict) and main.get("id"):
                yield main
            for el in comp.get("elements") or []:
                if isinstance(el, dict):
                    g = el.get("graph")
                    if isinstance(g, dict) and g.get("id"):
                        yield g

    def _refresh_naming_tab(self) -> None:
        self._naming_tree.clear()
        pid = self._current_plane_id()
        if not pid:
            return
        for g in self._iter_all_narrative_graphs():
            gid = str(g.get("id") or "")
            states = g.get("states")
            if not isinstance(states, dict):
                continue
            for sid, st in states.items():
                if not isinstance(st, dict):
                    continue
                if str(st.get("activePlane") or "").strip() != pid:
                    continue
                item = QTreeWidgetItem([gid, str(sid), str(st.get("label") or "")])
                item.setData(0, Qt.ItemDataRole.UserRole, (gid, str(sid)))
                self._naming_tree.addTopLevelItem(item)
        for col in range(3):
            self._naming_tree.resizeColumnToContents(col)

    def _on_naming_double_clicked(self, item: QTreeWidgetItem, _col: int) -> None:
        payload = item.data(0, Qt.ItemDataRole.UserRole)
        if not (isinstance(payload, tuple) and len(payload) == 2):
            return
        navigate = getattr(self.window(), "navigate_to_narrative_state", None)
        if callable(navigate):
            navigate(payload[0], payload[1])

    def _refresh_members_tab(self) -> None:
        self._members_tree.clear()
        pid = self._current_plane_id()
        if not pid:
            return
        kind_label = {"npcs": ("npc", "NPC"), "hotspots": ("hotspot", "热点"), "zones": ("zone", "Zone")}
        scenes = getattr(self._model, "scenes", None)
        if not isinstance(scenes, dict):
            return
        for scene_id, scene in scenes.items():
            if not isinstance(scene, dict):
                continue
            scene_item: QTreeWidgetItem | None = None
            for field, (kind, label) in kind_label.items():
                for entity in scene.get(field) or []:
                    if not isinstance(entity, dict):
                        continue
                    planes = entity.get("planes")
                    if not (isinstance(planes, list) and pid in [str(x).strip() for x in planes]):
                        continue
                    eid = str(entity.get("id") or "").strip()
                    if not eid:
                        continue
                    if scene_item is None:
                        scene_item = QTreeWidgetItem([str(scene_id), ""])
                        self._members_tree.addTopLevelItem(scene_item)
                    child = QTreeWidgetItem([eid, label])
                    child.setData(0, Qt.ItemDataRole.UserRole, (kind, eid, str(scene_id)))
                    scene_item.addChild(child)
        self._members_tree.expandAll()
        for col in range(2):
            self._members_tree.resizeColumnToContents(col)

    def _on_member_double_clicked(self, item: QTreeWidgetItem, _col: int) -> None:
        payload = item.data(0, Qt.ItemDataRole.UserRole)
        if not (isinstance(payload, tuple) and len(payload) == 3):
            return  # 场景分组行不跳转
        navigate = getattr(self.window(), "navigate_to_scene_entity", None)
        if callable(navigate):
            navigate(payload[0], payload[1], payload[2], plane_view=self._current_plane_id())

    def _refresh_issues_tab(self) -> None:
        from ..validator import validate

        self._issues_list.clear()
        issues = validate(self._model)
        plane_related = [
            i for i in issues
            if i.data_type == "plane"
            or "位面" in i.message
            or "activatePlane" in i.message
            or "plane 条件" in i.message
        ]
        for issue in plane_related:
            self._issues_list.addItem(
                f"[{issue.severity}] {issue.data_type}/{issue.item_id}: {issue.message}",
            )
        self._issues_status.setText(
            f"位面相关 {len(plane_related)} 条（全部 {len(issues)} 条）",
        )

    # ---- helpers -----------------------------------------------------------

    @staticmethod
    def _widget_or_original(widget_value: float, original) -> float | int:
        """控件值回写时的往返保真：与原值在控件精度（6 位）内相等则回写原值本身。

        兜住控件显示舍入（>6 位小数）与 int/float 表示差——纯浏览绝不改数据。
        """
        v = round(widget_value, 6)
        if (
            isinstance(original, (int, float)) and not isinstance(original, bool)
            and round(float(original), 6) == v
        ):
            return original
        return v

    def _row_text(self, p: dict) -> str:
        pid = p.get("id", "?")
        label = str(p.get("label") or "").strip()
        return f"{pid}  [{label}]" if label and label != pid else str(pid)

    def _refresh(self) -> None:
        self._list.clear()
        for p in self._model.planes:
            self._list.addItem(self._row_text(p))

    def select_by_id(self, plane_id: str, _scene_id: str = "") -> None:
        """外部跳转入口：按 plane id 选中对应行（行序 == model.planes 序）。"""
        pid = str(plane_id or "").strip()
        if not pid:
            return
        for i, p in enumerate(self._model.planes):
            if str(p.get("id") or "") == pid:
                self._list.setCurrentRow(i)  # 触发 _on_select（commit-on-leave 安全）
                return

    def reload_refs_from_model(self) -> None:
        """主窗口切页/开工程后调用：重建列表（保持当前选中 id）。"""
        # commit-on-leave：重建会经 clear→_on_select(-1) 清索引，绕过切行提交路径，
        # 不先提交会静默丢当前未应用编辑。
        if 0 <= self._current_idx < len(self._model.planes) and self._is_dirty():
            self._apply()
        cur_id = ""
        if 0 <= self._current_idx < len(self._model.planes):
            cur_id = str(self._model.planes[self._current_idx].get("id") or "")
        self._list.blockSignals(True)
        self._refresh()
        self._list.blockSignals(False)
        self._current_idx = -1
        if cur_id:
            for i, p in enumerate(self._model.planes):
                if str(p.get("id") or "") == cur_id:
                    self._list.setCurrentRow(i)
                    return
        if self._list.count():
            self._list.setCurrentRow(0)

    def _lighting_preview_text(
        self,
        lighting: dict | None,
        effective: dict | None = None,
        source: dict | None = None,
        pid: str = "",
    ) -> str:
        if lighting is None:
            # 未配置时若沿 extends 继承到了祖先的 lighting，把来源亮出来（复核 P1-05）。
            if source and source.get("lighting") and source.get("lighting") != pid:
                eff = (effective or {}).get("lighting")
                n = len(eff) if isinstance(eff, dict) else 0
                return f"（本位面未配置；继承自 {source['lighting']}：{n} 个字段）"
            return "（未配置）"
        if not lighting:
            return "已配置：空对象 {}（显式覆盖父配置为无光照档）"
        keys = "、".join(str(k) for k in lighting.keys())
        return f"已配置字段：{keys}"

    def _edit_lighting_json(self) -> None:
        dlg = QDialog(self)
        dlg.setWindowTitle("lighting 专家 JSON")
        dlg.resize(520, 420)
        lay = QVBoxLayout(dlg)
        hint = QLabel(
            "partial SceneLightEnv（与场景 lightEnv 同 schema，缺省字段由运行时补全）。"
            "留空并确定=清除 lighting。",
        )
        hint.setWordWrap(True)
        lay.addWidget(hint)
        text = QPlainTextEdit(dlg)
        if self._pending_lighting:
            text.setPlainText(
                json.dumps(self._pending_lighting, ensure_ascii=False, indent=2),
            )
        lay.addWidget(text, 1)
        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=dlg,
        )
        bbox.accepted.connect(dlg.accept)
        bbox.rejected.connect(dlg.reject)
        lay.addWidget(bbox)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        raw = text.toPlainText().strip()
        if not raw:
            self._pending_lighting = None
            self._f_lighting_preview.setText(self._lighting_preview_text(None))
            return
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            QMessageBox.warning(self, "JSON 无效", f"lighting 未保存：{exc}")
            return
        if not isinstance(parsed, dict):
            QMessageBox.warning(self, "JSON 无效", "lighting 须为对象（partial SceneLightEnv）")
            return
        self._pending_lighting = parsed  # 显式 {} 原样保留；清除走上面的"留空并确定"分支
        self._f_lighting_preview.setText(self._lighting_preview_text(self._pending_lighting))

    # ---- list ops ----------------------------------------------------------

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.planes):
            self._current_idx = -1  # 清选中即清索引，杜绝"删除删旧项"
            return
        # commit-on-leave：切到别的位面前提交上一项未应用编辑，避免静默丢弃。
        if 0 <= self._current_idx < len(self._model.planes) \
                and self._current_idx != row and self._is_dirty():
            self._apply()
        self._current_idx = row
        p = self._model.planes[row]
        pid = str(p.get("id", "") or "")
        self._f_id.setText(pid)
        # normal 是契约保留 id（开局默认位面、被实体缺省语义依赖），禁止改名。
        self._f_id.setReadOnly(pid == "normal")
        self._f_label.setText(str(p.get("label", "") or ""))
        # extends 候选 = 其它位面（排除自身防自继承）；normal 恒不继承，禁用。
        self._f_extends.set_items(
            [(iid, lbl) for iid, lbl in self._model.all_plane_ids() if iid != pid],
        )
        self._f_extends.set_current(str(p.get("extends", "") or ""))
        self._f_extends.setEnabled(pid != "normal")
        # membership 三态：不写键=（继承/缺省），显式 shared / exclusive 原样往返。
        mem_raw = p.get("membership")
        mem = mem_raw if mem_raw in ("shared", "exclusive") else ""
        self._f_membership.blockSignals(True)
        self._f_membership.setCurrentIndex(max(0, self._f_membership.findData(mem)))
        self._f_membership.blockSignals(False)
        self._f_membership.setEnabled(pid != "normal")

        # 槽级继承感知填充：本位面写了的槽 → 闸门勾选、显示自己的值；未写的槽 →
        # 闸门不勾、控件灰显沿 extends 链解析出的生效值（与运行时展开口径一致）。
        effective, source = resolve_effective_slots(self._model.planes, pid)

        def _eff_slot(key: str) -> dict:
            v = effective.get(key)
            return v if isinstance(v, dict) else {}

        own_mv = p.get("movement")
        has_mv = isinstance(own_mv, dict)
        self._set_gate(self._f_mv_gate, has_mv)
        self._set_movement_controls(own_mv if has_mv else _eff_slot("movement"))
        self._set_slot_controls_enabled("movement", has_mv)

        own_it = p.get("interaction")
        has_it = isinstance(own_it, dict)
        self._set_gate(self._f_it_gate, has_it)
        self._set_interaction_controls(own_it if has_it else _eff_slot("interaction"))
        self._set_slot_controls_enabled("interaction", has_it)

        own_tv = p.get("travel")
        has_tv = isinstance(own_tv, dict)
        self._set_gate(self._f_tv_gate, has_tv)
        self._set_travel_controls(own_tv if has_tv else _eff_slot("travel"))
        self._set_slot_controls_enabled("travel", has_tv)

        cam = p.get("camera") if isinstance(p.get("camera"), dict) else {}
        has_zoom = "zoom" in cam
        self._f_zoom_chk.blockSignals(True)
        self._f_zoom_chk.setChecked(has_zoom)
        self._f_zoom_chk.blockSignals(False)
        self._f_zoom.setEnabled(has_zoom)
        zoom_src = cam if has_zoom else _eff_slot("camera")
        self._f_zoom.blockSignals(True)
        try:
            self._f_zoom.setValue(float(zoom_src.get("zoom", 1.0)))
        except (TypeError, ValueError):
            self._f_zoom.setValue(1.0)
        finally:
            self._f_zoom.blockSignals(False)

        own_drain = p.get("healthDrainPerSec")
        has_drain = "healthDrainPerSec" in p
        self._f_drain_chk.blockSignals(True)
        self._f_drain_chk.setChecked(has_drain)
        self._f_drain_chk.blockSignals(False)
        self._f_drain.setEnabled(has_drain)
        drain_show = own_drain if has_drain else effective.get("healthDrainPerSec", 0.0)
        self._f_drain.blockSignals(True)
        try:
            self._f_drain.setValue(float(drain_show or 0.0))
        except (TypeError, ValueError):
            self._f_drain.setValue(0.0)
        finally:
            self._f_drain.blockSignals(False)

        lighting = p.get("lighting") if isinstance(p.get("lighting"), dict) else None
        # 显式 lighting:{} 也要保留（is not None），浏览不改数据。
        self._pending_lighting = copy.deepcopy(lighting) if lighting is not None else None
        self._f_lighting_preview.setText(
            self._lighting_preview_text(self._pending_lighting, effective, source, pid),
        )
        self._refresh_inherit_summary(pid, effective, source)
        self._refresh_hub_tabs_for_selection()

    # ---- 槽级继承感知辅助（复核 P1-05）--------------------------------------

    @staticmethod
    def _set_gate(gate: QCheckBox, checked: bool) -> None:
        gate.blockSignals(True)
        gate.setChecked(checked)
        gate.blockSignals(False)

    def _set_movement_controls(self, mv: dict) -> None:
        for spin, key, default in (
            (self._f_drift_x, "driftX", 0.0),
            (self._f_drift_y, "driftY", 0.0),
            (self._f_speed_scale, "speedScale", 1.0),
        ):
            spin.blockSignals(True)
            try:
                spin.setValue(float(mv.get(key, default)))
            except (TypeError, ValueError):
                spin.setValue(default)
            finally:
                spin.blockSignals(False)
        self._f_allow_run.setChecked(mv.get("allowRun") is not False)

    def _set_interaction_controls(self, it: dict) -> None:
        self._f_can_pickup.setChecked(it.get("canPickup") is not False)
        self._f_can_hotspots.setChecked(it.get("canInteractHotspots") is not False)
        self._f_can_talk.setChecked(it.get("canTalkNpcs") is not False)

    def _set_travel_controls(self, tv: dict) -> None:
        self._f_allow_map_travel.setChecked(tv.get("allowMapTravel") is not False)

    def _set_slot_controls_enabled(self, slot: str, enabled: bool) -> None:
        widgets = {
            "movement": (self._f_drift_x, self._f_drift_y, self._f_speed_scale, self._f_allow_run),
            "interaction": (self._f_can_pickup, self._f_can_hotspots, self._f_can_talk),
            "travel": (self._f_allow_map_travel,),
        }[slot]
        for wdg in widgets:
            wdg.setEnabled(enabled)

    def _on_slot_gate_toggled(self, checked: bool) -> None:
        """闸门切换：勾选=以当前生效值为起点开放编辑；取消=回显继承生效值并灰显。"""
        if self._current_idx < 0 or self._current_idx >= len(self._model.planes):
            return
        gate = self.sender()
        slot = {
            id(self._f_mv_gate): "movement",
            id(self._f_it_gate): "interaction",
            id(self._f_tv_gate): "travel",
        }.get(id(gate))
        if slot is None:
            return
        if not checked:
            # 回到继承：控件回显（不含本位面槽的）生效值。临时按「本位面无此槽」解析。
            p = self._model.planes[self._current_idx]
            probe = {k: v for k, v in p.items() if k != slot}
            planes = [probe if q is p else q for q in self._model.planes]
            effective, _src = resolve_effective_slots(planes, str(p.get("id", "") or ""))
            eff = effective.get(slot)
            eff = eff if isinstance(eff, dict) else {}
            if slot == "movement":
                self._set_movement_controls(eff)
            elif slot == "interaction":
                self._set_interaction_controls(eff)
            else:
                self._set_travel_controls(eff)
        self._set_slot_controls_enabled(slot, checked)

    def _on_extends_changed(self, _new: str) -> None:
        """extends 变更即时刷新继承生效摘要与灰显槽的回显值（不改模型，Apply 才提交）。"""
        if self._current_idx < 0 or self._current_idx >= len(self._model.planes):
            return
        p = self._model.planes[self._current_idx]
        pid = str(p.get("id", "") or "")
        # 以「假如 extends 改成新值」的口径解析：替换当前行的 extends 后求生效值。
        probe = dict(p)
        new_ext = str(self._f_extends.current_id() or "").strip()
        if new_ext:
            probe["extends"] = new_ext
        else:
            probe.pop("extends", None)
        planes = [probe if q is p else q for q in self._model.planes]
        effective, source = resolve_effective_slots(planes, pid)
        self._refresh_inherit_summary(pid, effective, source)
        for slot, gate in (
            ("movement", self._f_mv_gate),
            ("interaction", self._f_it_gate),
            ("travel", self._f_tv_gate),
        ):
            if not gate.isChecked():
                eff = effective.get(slot)
                eff = eff if isinstance(eff, dict) else {}
                if slot == "movement":
                    self._set_movement_controls(eff)
                elif slot == "interaction":
                    self._set_interaction_controls(eff)
                else:
                    self._set_travel_controls(eff)
        if not self._f_drain_chk.isChecked():
            self._f_drain.blockSignals(True)
            try:
                self._f_drain.setValue(float(effective.get("healthDrainPerSec", 0.0) or 0.0))
            except (TypeError, ValueError):
                self._f_drain.setValue(0.0)
            finally:
                self._f_drain.blockSignals(False)

    def _refresh_inherit_summary(self, pid: str, effective: dict, source: dict) -> None:
        """extends 链继承摘要：只列来自祖先的槽（本位面显式写的不列）。"""
        parts: list[str] = []
        for k in INHERITED_SLOT_KEYS:
            src = source.get(k)
            if not src or src == pid:
                continue
            v = effective.get(k)
            if isinstance(v, dict):
                parts.append(f"{k} ← {src}")
            else:
                parts.append(f"{k}={v!r} ← {src}")
        if parts:
            self._f_inherit_summary.setText("；".join(parts))
            self._f_inherit_summary.setVisible(True)
        else:
            self._f_inherit_summary.setText("")
            self._f_inherit_summary.setVisible(False)

    def _is_dirty(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._model.planes):
            return False
        p = self._model.planes[self._current_idx]
        test = copy.deepcopy(p)
        self._write_plane_into(test)
        return test != p

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交，避免静默丢弃。"""
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前位面有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            # Discard：把表单回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._on_select(self._current_idx)
        return True

    def _write_plane_into(self, p: dict) -> None:
        """把当前 UI 值就地写入 p（不 mark_dirty / 不刷新列表）。_apply 与脏判断共用。

        缺省值不落键（值为缺省时 pop）；原本显式存在的键按原值回写（preserve_numeric_repr，
        避免 int→float 漂移）；各槽字典内的未知键原样保留。
        """
        p["id"] = self._f_id.text().strip()
        label = self._f_label.text().strip()
        if label:
            p["label"] = label
        else:
            p.pop("label", None)

        ext = str(self._f_extends.current_id() or "").strip()
        if ext and ext != p["id"]:
            p["extends"] = ext
        else:
            p.pop("extends", None)

        # membership 三态：（继承/缺省）=不写键；显式 shared / exclusive 落键。
        # 有 extends 时显式 shared 即可覆盖父位面的 exclusive（复核 P1-05）。
        mem = str(self._f_membership.currentData() or "")
        if mem:
            p["membership"] = mem
        else:
            p.pop("membership", None)

        # 槽级闸门：勾选=显式写槽（槽内仍按「缺省值不落键 / 原显式值保留」收敛，
        # 全缺省时写空 {} —— 即『用缺省整槽覆盖父配置』的原语，与运行时槽级继承
        # 语义一致）；不勾选=不写键（继承/缺省），忽略灰显控件的回显值。
        old_mv = p.get("movement") if isinstance(p.get("movement"), dict) else {}
        if self._f_mv_gate.isChecked():
            mv: dict = {}
            for key, spin, default in (
                ("driftX", self._f_drift_x, 0.0),
                ("driftY", self._f_drift_y, 0.0),
                ("speedScale", self._f_speed_scale, 1.0),
            ):
                v = self._widget_or_original(spin.value(), old_mv.get(key))
                if key in old_mv or v != default:
                    mv[key] = v
            if not self._f_allow_run.isChecked():
                mv["allowRun"] = False
            elif old_mv.get("allowRun") is True:
                mv["allowRun"] = True
            preserve_numeric_repr(mv, old_mv)
            for k, v in old_mv.items():
                if k not in _MOVEMENT_KEYS:
                    mv[k] = v
            p["movement"] = mv
        else:
            p.pop("movement", None)

        old_it = p.get("interaction") if isinstance(p.get("interaction"), dict) else {}
        if self._f_it_gate.isChecked():
            it: dict = {}
            for key, chk in (
                ("canPickup", self._f_can_pickup),
                ("canInteractHotspots", self._f_can_hotspots),
                ("canTalkNpcs", self._f_can_talk),
            ):
                if not chk.isChecked():
                    it[key] = False
                elif old_it.get(key) is True:
                    it[key] = True
            preserve_numeric_repr(it, old_it)
            for k, v in old_it.items():
                if k not in _INTERACTION_KEYS:
                    it[k] = v
            p["interaction"] = it
        else:
            p.pop("interaction", None)

        old_tv = p.get("travel") if isinstance(p.get("travel"), dict) else {}
        if self._f_tv_gate.isChecked():
            tv: dict = {}
            if not self._f_allow_map_travel.isChecked():
                tv["allowMapTravel"] = False
            elif old_tv.get("allowMapTravel") is True:
                tv["allowMapTravel"] = True
            for k, v in old_tv.items():
                if k != "allowMapTravel":
                    tv[k] = v
            p["travel"] = tv
        else:
            p.pop("travel", None)

        old_cam = p.get("camera") if isinstance(p.get("camera"), dict) else {}
        cam: dict = {}
        if self._f_zoom_chk.isChecked():
            cam["zoom"] = self._widget_or_original(self._f_zoom.value(), old_cam.get("zoom"))
            preserve_numeric_repr(cam, old_cam)
        for k, v in old_cam.items():
            if k != "zoom":
                cam[k] = v
        if cam:
            p["camera"] = cam
        else:
            p.pop("camera", None)

        # 显式写入勾选 = 落键（写 0 也是显式值，可覆盖父位面的掉血）；不勾 = 不写键。
        old_drain = p.get("healthDrainPerSec")
        if self._f_drain_chk.isChecked():
            p["healthDrainPerSec"] = self._widget_or_original(self._f_drain.value(), old_drain)
        else:
            p.pop("healthDrainPerSec", None)

        # 显式 lighting:{}（原样保留）与"未配置/清除"（None → pop）语义区分，浏览不改数据。
        if self._pending_lighting is not None:
            p["lighting"] = copy.deepcopy(self._pending_lighting)
        else:
            p.pop("lighting", None)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        p = self._model.planes[self._current_idx]
        # id 门禁：空 id / 与他行重复 / 非 normal 行改名 normal（normal 是契约保留 id）
        # 一律拒绝提交并回显原 id，防止把引用它的实体归属/叙事点名悄悄打断。
        new_id = self._f_id.text().strip()
        old_id = str(p.get("id", "") or "")
        if not new_id:
            QMessageBox.warning(self, "id 无效", "位面 id 不能为空，已还原。")
            self._f_id.setText(old_id)
            return
        if new_id != old_id:
            taken = {
                str(row.get("id", "") or "")
                for i, row in enumerate(self._model.planes)
                if i != self._current_idx and isinstance(row, dict)
            }
            if new_id in taken:
                QMessageBox.warning(self, "id 冲突", f"位面 id {new_id!r} 已存在，已还原。")
                self._f_id.setText(old_id)
                return
            if new_id == "normal":
                QMessageBox.warning(
                    self, "id 保留",
                    "normal 是契约保留 id（开局默认激活位面），不能把其它位面改名为 normal。",
                )
                self._f_id.setText(old_id)
                return
        self._write_plane_into(p)
        self._model.mark_dirty("planes")
        lw = self._list.item(self._current_idx)
        if lw is not None:
            lw.setText(self._row_text(p))

    def _add(self) -> None:
        # commit-on-leave：_refresh 的 clear 会把 _current_idx 清成 -1，绕过切行提交，
        # 先提交当前未应用编辑再动列表（否则静默丢弃）。
        if 0 <= self._current_idx < len(self._model.planes) and self._is_dirty():
            self._apply()
        taken = {str(p.get("id", "")) for p in self._model.planes}
        if not self._model.planes and "normal" not in taken:
            # 契约：planes.json 首条为 normal（常态）。列表为空时先补齐再加新位面。
            self._model.planes.append({"id": "normal", "label": "常态"})
            taken.add("normal")
        n = 0
        while f"plane_{n}" in taken:
            n += 1
        self._model.planes.append({"id": f"plane_{n}"})
        self._model.mark_dirty("planes")
        self._refresh()
        self._list.setCurrentRow(len(self._model.planes) - 1)

    def _delete(self) -> None:
        if self._current_idx < 0:
            return
        p = self._model.planes[self._current_idx]
        pid = str(p.get("id", "") or "")
        if pid == "normal":
            QMessageBox.warning(
                self, "不可删除",
                "normal 是开局默认激活位面（契约：planes.json 首条），不能删除。",
            )
            return
        if not confirm.confirm_delete(self, f"位面「{pid}」"):
            return
        self._model.planes.pop(self._current_idx)
        self._current_idx = -1
        self._model.mark_dirty("planes")
        self._refresh()
