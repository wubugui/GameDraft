"""位面（planes.json）编辑器。

与运行时约定见 `src/systems/plane/types.ts`（PlaneDef，TS 权威）：
- 任意时刻恰有一个激活位面；`normal` 为开局默认，允许各槽全空。
- 实体归属经 hotspot/npc/zone 的可选 `planes: string[]`（缺省=存在于所有位面），
  在场景编辑器里维护；叙事状态节点用 `activePlane` 点名位面。
- 本编辑器只维护位面自身的系统配置五槽：movement / interaction / camera /
  lighting / healthDrainPerSec。缺省值不落键（保持 JSON 干净），未知键原样保留。
"""
from __future__ import annotations

import copy
import json

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
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
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.list_affordances import wire_list_affordances
from ..shared.numeric_roundtrip import preserve_numeric_repr

_MOVEMENT_KEYS = ("driftX", "driftY", "speedScale", "allowRun")
_INTERACTION_KEYS = ("canPickup", "canInteractHotspots", "canTalkNpcs")


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
        rl.addWidget(basic_box)

        mv_sec = CollapsibleSection("移动 movement（漂移 / 移速 / 禁跑）", start_open=False)
        mv_sec.set_header_tool_tip(
            "玩家控制器槽：漂移向量加、移速系数乘、allowRun 取 AND。"
            "缺省值（0 / 1 / 允许跑）不写入 JSON。默认折叠。",
        )
        mv_inner = QWidget()
        mf = compact_form(QFormLayout(mv_inner))
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
        self._f_drain = QDoubleSpinBox()
        self._f_drain.setRange(0.0, 1000000.0)
        self._f_drain.setDecimals(6)
        self._f_drain.setSingleStep(0.1)
        self._f_drain.setToolTip("位面激活期间每秒扣的阳气量；0=不掉（缺省不写键）")
        cf.addRow("healthDrainPerSec", self._f_drain)
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

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 640])
        root.addWidget(splitter)
        self._refresh()

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

    def _lighting_preview_text(self, lighting: dict | None) -> str:
        if lighting is None:
            return "（未配置）"
        if not lighting:
            return "已配置：空对象 {}"
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
        mv = p.get("movement") if isinstance(p.get("movement"), dict) else {}
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
        it = p.get("interaction") if isinstance(p.get("interaction"), dict) else {}
        self._f_can_pickup.setChecked(it.get("canPickup") is not False)
        self._f_can_hotspots.setChecked(it.get("canInteractHotspots") is not False)
        self._f_can_talk.setChecked(it.get("canTalkNpcs") is not False)
        cam = p.get("camera") if isinstance(p.get("camera"), dict) else {}
        has_zoom = "zoom" in cam
        self._f_zoom_chk.setChecked(has_zoom)
        self._f_zoom.setEnabled(has_zoom)
        self._f_zoom.blockSignals(True)
        try:
            self._f_zoom.setValue(float(cam.get("zoom", 1.0)))
        except (TypeError, ValueError):
            self._f_zoom.setValue(1.0)
        finally:
            self._f_zoom.blockSignals(False)
        self._f_drain.blockSignals(True)
        try:
            self._f_drain.setValue(float(p.get("healthDrainPerSec", 0.0) or 0.0))
        except (TypeError, ValueError):
            self._f_drain.setValue(0.0)
        finally:
            self._f_drain.blockSignals(False)
        lighting = p.get("lighting") if isinstance(p.get("lighting"), dict) else None
        # 显式 lighting:{} 也要保留（is not None），浏览不改数据。
        self._pending_lighting = copy.deepcopy(lighting) if lighting is not None else None
        self._f_lighting_preview.setText(self._lighting_preview_text(self._pending_lighting))

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

        old_mv = p.get("movement") if isinstance(p.get("movement"), dict) else {}
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
        if mv:
            p["movement"] = mv
        else:
            p.pop("movement", None)

        old_it = p.get("interaction") if isinstance(p.get("interaction"), dict) else {}
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
        if it:
            p["interaction"] = it
        else:
            p.pop("interaction", None)

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

        old_drain = p.get("healthDrainPerSec")
        drain = self._widget_or_original(self._f_drain.value(), old_drain)
        if isinstance(drain, (int, float)) and drain == old_drain and "healthDrainPerSec" in p:
            p["healthDrainPerSec"] = old_drain
        elif drain != 0:
            p["healthDrainPerSec"] = drain
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
