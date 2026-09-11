"""统一的「位置引用」选择器 —— 所有引用某个点的动作参数共用。

2026-09-11 制作人定：轨迹曲线没有锚点、播放位置在播放时给，而"某个点"可以来自四处，
**选点不能只靠下拉菜单**。本控件把四种来源收成一个复合控件，落盘三种形状
（TS 权威 ``PositionRef``，``src/utils/positionRef.ts`` / ``src/data/types.ts``）：

- 数字坐标 ``{kind:'point', x, y}``：手输，或「地图拾取…」在场景底图上点一下；
- 实体此刻位置 ``{kind:'entity', id}``：运行时取该实体**执行那一刻**的位置（NPC / player / 热点 / 过场临时演员）；
- 曲线插槽 ``{kind:'slot', trajectoryId, slotId}``：**场景曲线**暴露的命名插槽（轨迹工作台里摆的站位）；
- 曲线上的点 ``{kind:'curve', trajectoryId, point, atMs?/progress?}``：在烘好的帧上按时刻 / 进度取值
  （2026-09-11 制作人要的"曲线 eval 的实时点"）。**那条曲线正在播就按这次播放算**——铜钱还在飞时，
  "终点"就是它这次真要落的地方；没在播就按场景曲线的原点算。省掉了"为落点专门摆一个插槽"。

宿主动作里 ``x`` / ``y`` 仍是 manifest 的必填键（moveEntityTo / jumpEntityTo / teleportEntityTo /
persistNpcAt / cutsceneSpawnActor / setSceneEntityPosition）：本控件同时给出一份**编辑期快照**
:meth:`PositionRefField.snapshot_xy`（实体 = 场景 JSON 里的摆放位置；插槽 = 资产里的插槽坐标），
宿主把它写进 ``x`` / ``y`` 当回落，``at`` 才是运行时真正用的活引用。**数字模式不写 ``at``**
（``x`` / ``y`` 就是全部，老数据的形状一个字节不动）。playTrajectory 没有顶层 x/y，数字模式写成
``at: {kind:'point'}``。

保值契约（[shared-widget-value-fidelity]）：实体 / 轨迹 / 插槽的候选里找不到数据里那个 id 时，
选择器保留原值并标「缺失」，绝不顶替成第一候选或清空。
"""
from __future__ import annotations

import math
from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractSpinBox,
    QComboBox,
    QDialog,
    QDoubleSpinBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .id_ref_selector import IdRefSelector

MODE_NONE = ""
MODE_POINT = "point"
MODE_ENTITY = "entity"
MODE_SLOT = "slot"
MODE_CURVE = "curve"

#: 「曲线上的点」取哪个点（与 TS ``CurvePointPick`` 同一套字面量）
CURVE_POINTS: tuple[tuple[str, str], ...] = (
    ("end", "终点（落点）"),
    ("start", "起点"),
    ("time", "指定时刻（毫秒）"),
    ("progress", "指定进度（0~1）"),
)

_MODE_LABELS: tuple[tuple[str, str], ...] = (
    (MODE_POINT, "数字坐标（手输 / 地图拾取）"),
    (MODE_ENTITY, "实体此刻位置"),
    (MODE_SLOT, "曲线插槽（场景曲线的命名站位）"),
    (MODE_CURVE, "曲线上的点（按时刻 / 进度取值）"),
)
_NONE_LABEL = "（不指定）"

_XY_RANGE = 1_000_000_000.0


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_position_ref(raw: Any) -> dict[str, Any] | None:
    """与运行时 ``parsePositionRef`` 同口径：认得的三种形状原样规范化，认不得返回 None。"""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind == MODE_POINT:
        x, y = _num(raw.get("x")), _num(raw.get("y"))
        if x is None or y is None:
            return None
        return {"kind": MODE_POINT, "x": x, "y": y}
    if kind == MODE_ENTITY:
        eid = str(raw.get("id") or "").strip()
        return {"kind": MODE_ENTITY, "id": eid} if eid else None
    if kind == MODE_SLOT:
        tid = str(raw.get("trajectoryId") or "").strip()
        sid = str(raw.get("slotId") or "").strip()
        return {"kind": MODE_SLOT, "trajectoryId": tid, "slotId": sid} if tid and sid else None
    if kind == MODE_CURVE:
        tid = str(raw.get("trajectoryId") or "").strip()
        if not tid:
            return None
        at_ms, prog = _num(raw.get("atMs")), _num(raw.get("progress"))
        pick = str(raw.get("point") or "").strip()
        if pick not in {k for k, _ in CURVE_POINTS}:
            pick = "time" if at_ms is not None else "progress" if prog is not None else "end"
        out: dict[str, Any] = {"kind": MODE_CURVE, "trajectoryId": tid, "point": pick}
        if pick == "time":
            out["atMs"] = at_ms if at_ms is not None else 0.0
        if pick == "progress":
            out["progress"] = prog if prog is not None else 1.0
        return out
    return None


def params_xy(params: dict | None) -> tuple[float, float] | None:
    """动作参数里的顶层 ``x`` / ``y``（两个都是有限数才算有）。"""
    if not isinstance(params, dict):
        return None
    x, y = _num(params.get("x")), _num(params.get("y"))
    if x is None or y is None:
        return None
    return (x, y)


# --------------------------------------------------------------------------- #
# 编辑期快照（只读工程数据，不写任何东西）
# --------------------------------------------------------------------------- #

def _spawn_point_xy(sc: dict) -> tuple[float, float] | None:
    raw = sc.get("spawnPoints")
    if isinstance(raw, dict) and raw:
        for key in ("", "default"):
            v = raw.get(key)
            xy = params_xy(v if isinstance(v, dict) else None)
            if xy:
                return xy
        for v in raw.values():
            xy = params_xy(v if isinstance(v, dict) else None)
            if xy:
                return xy
    ps = sc.get("playerStart")
    return params_xy(ps if isinstance(ps, dict) else None)


def scene_entity_xy(
    model: Any, scene_id: str, entity_id: str, cutscene_id: str | None = None,
) -> tuple[float, float] | None:
    """实体在场景 JSON 里的摆放位置（NPC / 热点 / player 的默认出生点 / 过场临时演员的生成点）。

    只是编辑期快照：运行时 ``{kind:'entity'}`` 取的是**执行那一刻**的位置。找不到返回 None。
    """
    eid = str(entity_id or "").strip()
    sid = str(scene_id or "").strip()
    if not model or not eid:
        return None
    scenes = getattr(model, "scenes", None) or {}
    sc = scenes.get(sid) if sid else None
    if eid.startswith("_cut_"):
        cuts = getattr(model, "cutscenes", None) or []
        ordered = list(cuts)
        if cutscene_id:
            ordered.sort(key=lambda c: 0 if str((c or {}).get("id") or "") == str(cutscene_id) else 1)
        for cs in ordered:
            for step in _walk_steps((cs or {}).get("steps") or []):
                if step.get("kind") == "action" and step.get("type") == "cutsceneSpawnActor":
                    p = step.get("params") or {}
                    if str(p.get("id") or "").strip() == eid:
                        return params_xy(p)
        return None
    if not isinstance(sc, dict):
        return None
    if eid == "player":
        return _spawn_point_xy(sc)
    for bucket in ("npcs", "hotspots"):
        for row in sc.get(bucket) or []:
            if isinstance(row, dict) and str(row.get("id") or "").strip() == eid:
                return params_xy(row)
    return None


def _walk_steps(steps: list):
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        yield step
        tracks = step.get("tracks")
        if isinstance(tracks, list):
            for sub in tracks:
                if isinstance(sub, dict):
                    yield from _walk_steps([sub])


def entity_rows_for_position(model: Any, scene_id: str) -> list[tuple[str, str]]:
    """「实体此刻位置」的候选：过场临时演员 + 本场景 NPC + player + 本场景热点。"""
    if not model:
        return [("player", "player")]
    rows: list[tuple[str, str]] = []
    fn = getattr(model, "actor_id_items_for_scene", None)
    if callable(fn):
        rows.extend((str(i), str(lab)) for i, lab in fn(scene_id or None))
    hf = getattr(model, "hotspot_ids_for_scene", None)
    if callable(hf):
        rows.extend((str(i), f"{lab}（热点）" if lab and lab != i else f"{i}（热点）") for i, lab in hf(scene_id or None))
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for i, lab in rows:
        if i and i not in seen:
            seen.add(i)
            out.append((i, lab))
    return out


def trajectory_slot_source_rows(model: Any, scene_id: str) -> list[tuple[str, str]]:
    """「曲线插槽」的轨迹候选：有插槽的**场景曲线**；绑在当前场景的排前面，其它场景的标出来。"""
    fn = getattr(model, "trajectory_slot_rows", None) if model else None
    if not callable(fn):
        return []
    try:
        return [(str(i), str(lab)) for i, lab in fn(scene_id or None)]
    except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
        return []


def slot_rows(model: Any, trajectory_id: str) -> list[tuple[str, str]]:
    fn = getattr(model, "trajectory_slots", None) if model else None
    if not callable(fn) or not trajectory_id:
        return []
    try:
        return [(str(s["id"]), f"{s.get('label') or s['id']}  ({s['x']:.0f}, {s['y']:.0f})") for s in fn(trajectory_id)]
    except Exception:  # noqa: BLE001
        return []


def curve_rows(model: Any, scene_id: str) -> list[tuple[str, str]]:
    """「曲线上的点」的轨迹候选：烘过帧的曲线（场景曲线在前）。"""
    fn = getattr(model, "trajectory_curve_rows", None) if model else None
    if not callable(fn):
        return []
    try:
        return [(str(i), str(lab)) for i, lab in fn(scene_id or None)]
    except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
        return []


def curve_xy(model: Any, ref: dict) -> tuple[float, float] | None:
    """「曲线上的点」的编辑期快照（作者场景里的那个点）。运行时的"正在播就按这次播放算"这里看不到。"""
    fn = getattr(model, "trajectory_curve_point", None) if model else None
    if not callable(fn) or not isinstance(ref, dict):
        return None
    try:
        return fn(str(ref.get("trajectoryId") or ""), str(ref.get("point") or "end"),
                  _num(ref.get("atMs")), _num(ref.get("progress")))
    except Exception:  # noqa: BLE001
        return None


def slot_xy(model: Any, trajectory_id: str, slot_id: str) -> tuple[float, float] | None:
    fn = getattr(model, "trajectory_slots", None) if model else None
    if not callable(fn) or not trajectory_id or not slot_id:
        return None
    try:
        for s in fn(trajectory_id):
            if str(s.get("id")) == str(slot_id):
                return params_xy(s)
    except Exception:  # noqa: BLE001
        return None
    return None


# --------------------------------------------------------------------------- #
# 控件
# --------------------------------------------------------------------------- #

class PositionRefField(QWidget):
    """复合控件：模式下拉 + 当前模式的那一行 + 一行说明（快照 / 提醒）。

    ``scene_provider``：宿主此刻的地图场景 id（moveEntityTo 的「地图 sceneId」下拉、过场的 targetScene…）。
    实体候选、地图拾取的底图、插槽的场景一致性检查都按它来；宿主换场景后调 :meth:`refresh_candidates`。
    ``optional`` = 允许「不指定」（playTrajectory 的播放位置：场景曲线原地播）。
    """

    changed = Signal()

    def __init__(
        self,
        model: Any,
        scene_provider: Callable[[], str],
        *,
        optional: bool = False,
        cutscene_id: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_provider = scene_provider
        self._optional = bool(optional)
        self._cutscene_id = (cutscene_id or "") or None
        self._loaded_xy: tuple[float, float] | None = None
        self._loading = False

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(2)

        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        self.mode_combo = QComboBox(self)
        self.mode_combo.setEditable(False)
        if self._optional:
            self.mode_combo.addItem(_NONE_LABEL, MODE_NONE)
        for mode, label in _MODE_LABELS:
            self.mode_combo.addItem(label, mode)
        self.mode_combo.setToolTip(
            "这个点从哪来：\n"
            "· 数字坐标：世界坐标 wu，可手输，或「地图拾取」在场景底图上点；\n"
            "· 实体此刻位置：运行时取该实体执行那一刻的位置（不是场景里的初始摆放）；\n"
            "· 曲线插槽：场景曲线在轨迹工作台里配的命名站位（插槽属于曲线绑定的那个场景）。"
        )
        self.mode_combo.currentIndexChanged.connect(self._on_mode_changed)
        top.addWidget(self.mode_combo, 1)
        root.addLayout(top)

        # ---- 数字坐标 ----
        self._row_point = QWidget(self)
        pl = QHBoxLayout(self._row_point)
        pl.setContentsMargins(0, 0, 0, 0)
        self.x_spin = QDoubleSpinBox(self._row_point)
        self.y_spin = QDoubleSpinBox(self._row_point)
        for sb, pre in ((self.x_spin, "x="), (self.y_spin, "y=")):
            sb.setRange(-_XY_RANGE, _XY_RANGE)   # 世界坐标量程给足（numeric-roundtrip-fidelity 契约 2）
            sb.setDecimals(2)
            sb.setSingleStep(10)
            sb.setPrefix(pre)
            sb.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
            sb.setMinimumWidth(110)
            sb.valueChanged.connect(self._emit_changed)
            pl.addWidget(sb)
        self.pick_btn = QPushButton("地图拾取…", self._row_point)
        self.pick_btn.setToolTip("在当前地图场景的底图上点一下取世界坐标（中键平移，滚轮缩放）。")
        self.pick_btn.clicked.connect(self._open_map_pick)
        pl.addWidget(self.pick_btn)
        pl.addStretch(1)
        root.addWidget(self._row_point)

        # ---- 实体此刻位置 ----
        self._row_entity = QWidget(self)
        el = QHBoxLayout(self._row_entity)
        el.setContentsMargins(0, 0, 0, 0)
        self.entity_sel = IdRefSelector(self._row_entity, allow_empty=False)
        self.entity_sel.setToolTip("运行时取这个实体此刻的位置：NPC / player / 热点 / 本过场临时演员。")
        self.entity_sel.value_changed.connect(self._emit_changed)
        el.addWidget(self.entity_sel, 1)
        root.addWidget(self._row_entity)

        # ---- 曲线插槽 ----
        self._row_slot = QWidget(self)
        sl = QHBoxLayout(self._row_slot)
        sl.setContentsMargins(0, 0, 0, 0)
        self.traj_sel = IdRefSelector(self._row_slot, allow_empty=False)
        self.traj_sel.setToolTip("有插槽的场景曲线（assets/data/trajectories/*.json；插槽在轨迹工作台里摆）。")
        self.traj_sel.value_changed.connect(self._on_traj_changed)
        self.slot_sel = IdRefSelector(self._row_slot, allow_empty=False)
        self.slot_sel.setToolTip("该曲线暴露的命名插槽。")
        self.slot_sel.value_changed.connect(self._emit_changed)
        sl.addWidget(self.traj_sel, 3)
        sl.addWidget(self.slot_sel, 2)
        root.addWidget(self._row_slot)

        # ---- 曲线上的点 ----
        self._row_curve = QWidget(self)
        cl = QHBoxLayout(self._row_curve)
        cl.setContentsMargins(0, 0, 0, 0)
        self.curve_sel = IdRefSelector(self._row_curve, allow_empty=False)
        self.curve_sel.setToolTip("在这条曲线烘好的帧上取值；它正在播时按**这次播放**算（实时点）。")
        self.curve_sel.value_changed.connect(self._on_curve_changed)
        self.point_combo = QComboBox(self._row_curve)
        for key, label in CURVE_POINTS:
            self.point_combo.addItem(label, key)
        self.point_combo.setToolTip("取曲线上的哪个点。终点 = 落点，最常用。")
        self.point_combo.currentIndexChanged.connect(self._on_curve_point_changed)
        self.at_spin = QDoubleSpinBox(self._row_curve)
        self.at_spin.setRange(0.0, 3_600_000.0)
        self.at_spin.setDecimals(0)
        self.at_spin.setSingleStep(50)
        self.at_spin.setSuffix(" ms")
        self.at_spin.setMaximumWidth(120)
        self.at_spin.valueChanged.connect(self._emit_changed)
        self.prog_spin = QDoubleSpinBox(self._row_curve)
        self.prog_spin.setRange(0.0, 1.0)
        self.prog_spin.setDecimals(3)
        self.prog_spin.setSingleStep(0.05)
        self.prog_spin.setMaximumWidth(100)
        self.prog_spin.valueChanged.connect(self._emit_changed)
        cl.addWidget(self.curve_sel, 3)
        cl.addWidget(self.point_combo, 2)
        cl.addWidget(self.at_spin)
        cl.addWidget(self.prog_spin)
        root.addWidget(self._row_curve)

        self.info_lbl = QLabel("", self)
        self.info_lbl.setWordWrap(True)
        self.info_lbl.setStyleSheet("color:#888;")
        root.addWidget(self.info_lbl)

        self.refresh_candidates()
        self._sync_rows()

    # ---- 载入 / 读出 -----------------------------------------------------

    def load(self, raw_ref: Any, xy: tuple[float, float] | None) -> None:
        """从参数载入：``raw_ref`` = params['at']（可为 None），``xy`` = 顶层 x/y（可为 None）。程序性载入不发 changed。"""
        self._loading = True
        try:
            self._loaded_xy = tuple(xy) if xy else None
            ref = parse_position_ref(raw_ref)
            if ref is None and isinstance(raw_ref, dict):
                # 认不得的形状：按数据里写的 kind 尽量保值展示（validator 会报），别静默丢
                kind = str(raw_ref.get("kind") or "").strip()
                if kind == MODE_ENTITY:
                    ref = {"kind": MODE_ENTITY, "id": str(raw_ref.get("id") or "")}
                elif kind == MODE_SLOT:
                    ref = {"kind": MODE_SLOT, "trajectoryId": str(raw_ref.get("trajectoryId") or ""),
                           "slotId": str(raw_ref.get("slotId") or "")}
                elif kind == MODE_CURVE:
                    ref = {"kind": MODE_CURVE, "trajectoryId": str(raw_ref.get("trajectoryId") or ""),
                           "point": str(raw_ref.get("point") or "end")}
            if ref is not None and ref["kind"] == MODE_ENTITY:
                self._set_mode(MODE_ENTITY)
                self.entity_sel.set_current(ref["id"])
            elif ref is not None and ref["kind"] == MODE_SLOT:
                self._set_mode(MODE_SLOT)
                self.traj_sel.set_current(ref["trajectoryId"])
                self._refill_slots()
                self.slot_sel.set_current(ref["slotId"])
            elif ref is not None and ref["kind"] == MODE_CURVE:
                self._set_mode(MODE_CURVE)
                self.curve_sel.set_current(ref["trajectoryId"])
                idx = self.point_combo.findData(ref.get("point") or "end")
                self.point_combo.blockSignals(True)
                self.point_combo.setCurrentIndex(max(0, idx))
                self.point_combo.blockSignals(False)
                if ref.get("atMs") is not None:
                    self.at_spin.blockSignals(True)
                    self.at_spin.setValue(float(ref["atMs"]))
                    self.at_spin.blockSignals(False)
                if ref.get("progress") is not None:
                    self.prog_spin.blockSignals(True)
                    self.prog_spin.setValue(float(ref["progress"]))
                    self.prog_spin.blockSignals(False)
            elif ref is not None:
                self._set_mode(MODE_POINT)
                self._set_spins(ref["x"], ref["y"])
            elif xy is not None:
                self._set_mode(MODE_POINT)
                self._set_spins(xy[0], xy[1])
            elif self._optional:
                self._set_mode(MODE_NONE)
            else:
                self._set_mode(MODE_POINT)
                self._set_spins(0.0, 0.0)
        finally:
            self._loading = False
        self._sync_rows()

    def mode(self) -> str:
        d = self.mode_combo.currentData()
        return str(d) if isinstance(d, str) else MODE_POINT

    def value(self) -> dict[str, Any] | None:
        """落盘的 ``PositionRef``；「不指定」返回 None。数字模式也返回 point 形状，由宿主决定写不写 ``at``。"""
        m = self.mode()
        if m == MODE_NONE:
            return None
        if m == MODE_POINT:
            return {"kind": MODE_POINT, "x": round(float(self.x_spin.value()), 2), "y": round(float(self.y_spin.value()), 2)}
        if m == MODE_ENTITY:
            return {"kind": MODE_ENTITY, "id": self.entity_sel.current_id().strip()}
        if m == MODE_CURVE:
            pick = str(self.point_combo.currentData() or "end")
            out: dict[str, Any] = {"kind": MODE_CURVE, "trajectoryId": self.curve_sel.current_id().strip(), "point": pick}
            if pick == "time":
                out["atMs"] = round(float(self.at_spin.value()), 2)
            if pick == "progress":
                out["progress"] = round(float(self.prog_spin.value()), 3)
            return out
        return {"kind": MODE_SLOT, "trajectoryId": self.traj_sel.current_id().strip(), "slotId": self.slot_sel.current_id().strip()}

    def snapshot_xy(self) -> tuple[float, float] | None:
        """给宿主写 x/y 用的编辑期快照（数字 = 本身；实体 / 插槽 = 工程数据里的位置；解析不到回落到载入值）。"""
        m = self.mode()
        if m == MODE_POINT:
            return (round(float(self.x_spin.value()), 2), round(float(self.y_spin.value()), 2))
        live = self._live_snapshot()
        if live is not None:
            return (round(live[0], 2), round(live[1], 2))
        return self._loaded_xy

    def set_point(self, x: float, y: float) -> None:
        """切到数字模式并写入坐标（地图弹窗 / 宿主推导的缺省坐标走这里）。"""
        self._set_mode(MODE_POINT)
        self._set_spins(x, y)
        self._sync_rows()
        self._emit_changed()

    # ---- 候选 -------------------------------------------------------------

    def scene_id(self) -> str:
        try:
            return str(self._scene_provider() or "").strip()
        except Exception:  # noqa: BLE001
            return ""

    def refresh_candidates(self) -> None:
        """宿主的地图场景变了：重灌实体 / 轨迹候选（当前值保值）。"""
        sid = self.scene_id()
        cur_e = self.entity_sel.current_id()
        self.entity_sel.set_items(entity_rows_for_position(self._model, sid))
        self.entity_sel.set_current(cur_e)
        cur_t = self.traj_sel.current_id()
        self.traj_sel.set_items(trajectory_slot_source_rows(self._model, sid))
        self.traj_sel.set_current(cur_t)
        cur_c = self.curve_sel.current_id()
        self.curve_sel.set_items(curve_rows(self._model, sid))
        self.curve_sel.set_current(cur_c)
        self._refill_slots()
        self._sync_info()

    def _refill_slots(self) -> None:
        cur = self.slot_sel.current_id()
        self.slot_sel.set_items(slot_rows(self._model, self.traj_sel.current_id().strip()))
        self.slot_sel.set_current(cur)

    # ---- 内部 -------------------------------------------------------------

    def _set_mode(self, mode: str) -> None:
        idx = self.mode_combo.findData(mode)
        if idx < 0:
            idx = self.mode_combo.findData(MODE_POINT)
        self.mode_combo.blockSignals(True)
        self.mode_combo.setCurrentIndex(max(0, idx))
        self.mode_combo.blockSignals(False)

    def _set_spins(self, x: float, y: float) -> None:
        for sb, v in ((self.x_spin, x), (self.y_spin, y)):
            sb.blockSignals(True)
            try:
                sb.setValue(float(v))
            except (TypeError, ValueError):
                sb.setValue(0.0)
            sb.blockSignals(False)

    def _on_mode_changed(self, _i: int) -> None:
        self._sync_rows()
        self._emit_changed()

    def _on_traj_changed(self, _v: str) -> None:
        self._refill_slots()
        self._emit_changed()

    def _on_curve_changed(self, _v: str) -> None:
        self._sync_curve_inputs()
        self._emit_changed()

    def _on_curve_point_changed(self, _i: int) -> None:
        self._sync_curve_inputs()
        self._emit_changed()

    def _sync_curve_inputs(self) -> None:
        """只显示当前取点方式要用的那个数值框；时刻框的上限跟着曲线总时长走。"""
        pick = str(self.point_combo.currentData() or "end")
        self.at_spin.setVisible(pick == "time")
        self.prog_spin.setVisible(pick == "progress")
        fn = getattr(self._model, "trajectory_duration_ms", None) if self._model else None
        if callable(fn):
            try:
                total = float(fn(self.curve_sel.current_id().strip()) or 0.0)
            except Exception:  # noqa: BLE001
                total = 0.0
            if total > 0:
                self.at_spin.setRange(0.0, max(total, float(self.at_spin.value())))

    def _emit_changed(self, *_a: Any) -> None:
        self._sync_info()
        if not self._loading:
            self.changed.emit()

    def _sync_rows(self) -> None:
        m = self.mode()
        self._row_point.setVisible(m == MODE_POINT)
        self._row_entity.setVisible(m == MODE_ENTITY)
        self._row_slot.setVisible(m == MODE_SLOT)
        self._row_curve.setVisible(m == MODE_CURVE)
        if m == MODE_CURVE:
            self._sync_curve_inputs()
        self._sync_info()

    def _live_snapshot(self) -> tuple[float, float] | None:
        m = self.mode()
        if m == MODE_ENTITY:
            return scene_entity_xy(self._model, self.scene_id(), self.entity_sel.current_id(), self._cutscene_id)
        if m == MODE_SLOT:
            return slot_xy(self._model, self.traj_sel.current_id().strip(), self.slot_sel.current_id().strip())
        if m == MODE_CURVE:
            return curve_xy(self._model, self.value() or {})
        return None

    def _sync_info(self) -> None:
        m = self.mode()
        if m == MODE_NONE:
            self.info_lbl.setText("不指定：场景曲线在它画的位置原地播；相对曲线会退到运动对象此刻位置并在控制台 warn。")
            return
        if m == MODE_POINT:
            self.info_lbl.setText("世界坐标（wu）。")
            return
        if m == MODE_ENTITY:
            eid = self.entity_sel.current_id().strip()
            if not eid:
                self.info_lbl.setText("还没选实体。")
                return
            xy = self._live_snapshot()
            where = f"场景里的摆放位置 ≈ ({xy[0]:.0f}, {xy[1]:.0f})；" if xy else "场景数据里找不到它的摆放位置；"
            self.info_lbl.setText(where + "运行时取它执行那一刻的位置。")
            return
        if m == MODE_CURVE:
            self.info_lbl.setText(self._curve_info())
            return
        tid = self.traj_sel.current_id().strip()
        sid = self.slot_sel.current_id().strip()
        if not tid or not sid:
            self.info_lbl.setText("选一条有插槽的场景曲线，再选插槽。")
            return
        xy = self._live_snapshot()
        bits: list[str] = []
        if xy:
            bits.append(f"插槽位置 ({xy[0]:.0f}, {xy[1]:.0f})")
        else:
            bits.append("资产里没有这个插槽（或曲线不存在）——运行时解析不到就整步跳过")
        tscene = ""
        fn = getattr(self._model, "trajectory_scene_id", None) if self._model else None
        if callable(fn):
            try:
                tscene = str(fn(tid) or "")
            except Exception:  # noqa: BLE001
                tscene = ""
        here = self.scene_id()
        if tscene and here and tscene != here:
            bits.append(f"⚠ 曲线绑定在场景 {tscene}，本动作的地图场景是 {here}：插槽是那边的坐标")
        elif tscene:
            bits.append(f"曲线绑定场景 {tscene}")
        self.info_lbl.setText("；".join(bits) + "。")

    def _curve_info(self) -> str:
        tid = self.curve_sel.current_id().strip()
        if not tid:
            return "选一条烘过的曲线，再选取哪个点。"
        bits: list[str] = []
        xy = curve_xy(self._model, self.value() or {})
        if xy:
            bits.append(f"作者场景里 ≈ ({xy[0]:.0f}, {xy[1]:.0f})")
        else:
            bits.append("这条曲线在工程里取不到值（没烘过 / 缺原点 / 是相对曲线）")
        bf = getattr(self._model, "trajectory_binding", None) if self._model else None
        binding = ""
        if callable(bf):
            try:
                binding = str(bf(tid) or "")
            except Exception:  # noqa: BLE001
                binding = ""
        if binding == "free":
            bits.append("⚠ 相对曲线：只有它正在播时这个点才有位置，否则运行时解析不出来")
        else:
            bits.append("它正在播时按**这次播放**算（实时点），没在播就按曲线原点算")
        return "；".join(bits) + "。"

    def _open_map_pick(self) -> None:
        from .move_entity_map_picker import WorldPointPickDialog

        sid = self.scene_id()
        m = self._model
        if not m:
            QMessageBox.warning(self, "地图拾取", "未加载工程。")
            return
        if not sid or sid not in (getattr(m, "scenes", None) or {}):
            QMessageBox.information(self, "地图拾取", "先选一个有效的地图场景（sceneId / 过场的 targetScene）。")
            return
        cur = self.snapshot_xy() or (0.0, 0.0)
        dlg = WorldPointPickDialog(m, sid, float(cur[0]), float(cur[1]), self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        px, py = dlg.picked_xy()
        self.set_point(px, py)


__all__ = [
    "CURVE_POINTS", "MODE_CURVE", "MODE_ENTITY", "MODE_NONE", "MODE_POINT", "MODE_SLOT",
    "PositionRefField", "curve_rows", "curve_xy", "parse_position_ref", "params_xy",
    "scene_entity_xy", "slot_xy", "entity_rows_for_position",
]
