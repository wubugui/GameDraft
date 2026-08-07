"""头顶闲聊台词本编辑器（数据类型 'bubble_lines'）。

一条「台词本」＝ 某个说话人在某些场景、某些条件下会自己念叨的一组话。
与 action `showSpeechBubble`（剧本里某一拍必须说的那句）分工不同，这里配的是氛围。
"""
from __future__ import annotations

import copy

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.condition_expr_tree import ConditionExprTreeRootWidget
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.list_affordances import wire_list_affordances
from ..shared.num_fields import float_or as _float_or, int_or as _int_or
from ..shared.rich_text_field import RichTextLineEdit

_TRIGGERS = [("ambient", "常驻氛围（冷却到了就可能说）"), ("approach", "玩家走近时说一次")]
_PICK_MODES = [("random", "随机（按权重）"), ("sequence", "顺序循环")]
_TUNING_FIELDS = [
    ("globalMinIntervalMs", "全局最小间隔(ms)", 0, 600000, 4000,
     "任意两句闲聊之间至少隔这么久；调小=更聒噪"),
    ("perSpeakerMinIntervalMs", "同一人最小间隔(ms)", 0, 600000, 12000,
     "同一个人两句话之间的最小间隔"),
    ("maxConcurrent", "同屏气泡上限", 1, 8, 2,
     "含 action 发的气泡；到上限就不再自动说"),
    ("audibleRange", "可听半径", 0, 5000, 900,
     "离玩家超过这个距离就不说（世界单位）"),
]


class BubbleLinesEditor(QWidget):
    """bubble_lines.json 编辑器。左列台词本，右侧表单 + 台词行。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        # 顶层允许两种形状：{tuning, lineSets} 或裸数组（运行时 applyDefs 也都接受）。
        # 裸数组时按 lineSets 处理，避免 `.get` 直接把页签炸掉。
        if isinstance(model.bubble_lines, list):
            model.bubble_lines = {"lineSets": model.bubble_lines}

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 台词本")
        btn_add.setToolTip("新增一本头顶闲聊台词")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除选中的台词本（Delete 键 / 右键菜单亦可）")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除台词本")
        ll.addWidget(self._list)
        ll.addWidget(self._build_tuning_box())

        right_host = QWidget()
        rl = QVBoxLayout(right_host)

        basic = QGroupBox("基本")
        f = compact_form(QFormLayout())
        basic.setLayout(f)
        self._f_id = QLineEdit()
        self._f_id.setToolTip("台词本 id，全表唯一；action setBubbleLineSet 按它引用")
        f.addRow("id", self._f_id)
        self._f_desc = QLineEdit()
        self._f_desc.setMinimumWidth(240)
        self._f_desc.setToolTip("策划备注（不影响运行时，可空）")
        f.addRow("说明", self._f_desc)

        sp_row = QWidget()
        sp_lay = QHBoxLayout(sp_row)
        sp_lay.setContentsMargins(0, 0, 0, 0)
        self._f_speaker_kind = QComboBox()
        self._f_speaker_kind.addItem("场景实体", "entity")
        self._f_speaker_kind.addItem("主角", "player")
        self._f_speaker_kind.setMaximumWidth(110)
        self._f_speaker_kind.currentIndexChanged.connect(self._sync_speaker_enabled)
        sp_lay.addWidget(self._f_speaker_kind)
        # 实体引用走选择器（选择器铁律）；未知/悬垂值由 IdRefSelector 保值展示
        self._f_speaker_id = IdRefSelector(allow_empty=True, click_opens_popup=True)
        self._f_speaker_id.setToolTip("谁在说：NPC / 热点 id（与 showEmote 的 target 同口径）")
        sp_lay.addWidget(self._f_speaker_id, 1)
        f.addRow("说话人", sp_row)

        # 多值：单选控件会把 `["a","b"]` 静默截断成第一条（切一下列表就丢数据）
        scenes_host = QWidget()
        scenes_lay = QVBoxLayout(scenes_host)
        scenes_lay.setContentsMargins(0, 0, 0, 0)
        self._scene_rows: list[dict] = []
        self._scenes_rows_host = QWidget()
        self._scenes_rows_lay = QVBoxLayout(self._scenes_rows_host)
        self._scenes_rows_lay.setContentsMargins(0, 0, 0, 0)
        scenes_lay.addWidget(self._scenes_rows_host)
        add_scene = QPushButton("+ 场景")
        add_scene.setMaximumWidth(90)
        add_scene.setToolTip("限定在哪些场景说；一条都不加＝不限场景")
        add_scene.clicked.connect(lambda: self._add_scene_row(""))
        scenes_lay.addWidget(add_scene)
        f.addRow("限定场景", scenes_host)

        self._f_trigger = QComboBox()
        for v, lab in _TRIGGERS:
            self._f_trigger.addItem(lab, v)
        self._f_trigger.currentIndexChanged.connect(self._sync_trigger_enabled)
        f.addRow("触发方式", self._f_trigger)

        self._f_range = QSpinBox()
        self._f_range.setRange(10, 2000)
        self._f_range.setValue(140)
        self._f_range.setMaximumWidth(110)
        self._f_range.setToolTip("玩家走近多少距离内触发（仅「走近」方式生效）")
        f.addRow("走近半径", self._f_range)

        self._f_priority = QSpinBox()
        self._f_priority.setRange(-100, 100)
        self._f_priority.setMaximumWidth(90)
        self._f_priority.setToolTip("同时可说时大者先说")
        f.addRow("优先级", self._f_priority)

        self._f_cooldown = QSpinBox()
        self._f_cooldown.setRange(0, 3600000)
        self._f_cooldown.setSingleStep(1000)
        self._f_cooldown.setValue(20000)
        self._f_cooldown.setMaximumWidth(120)
        self._f_cooldown.setToolTip("本台词本自身冷却（ms）")
        f.addRow("冷却(ms)", self._f_cooldown)

        self._f_duration = QSpinBox()
        self._f_duration.setRange(200, 60000)
        self._f_duration.setSingleStep(200)
        self._f_duration.setValue(2600)
        self._f_duration.setMaximumWidth(120)
        self._f_duration.setToolTip("气泡停留多久（ms）")
        f.addRow("停留(ms)", self._f_duration)

        self._f_pick = QComboBox()
        for v, lab in _PICK_MODES:
            self._f_pick.addItem(lab, v)
        f.addRow("挑句方式", self._f_pick)

        self._f_scale_chk = QCheckBox("覆盖气泡缩放")
        self._f_scale_chk.setToolTip("不勾＝用 game_config.emoteBubbleScale 全局值")
        self._f_scale = QDoubleSpinBox()
        self._f_scale.setRange(0.3, 4.0)
        self._f_scale.setSingleStep(0.1)
        self._f_scale.setValue(1.0)
        self._f_scale.setMaximumWidth(90)
        self._f_scale.setEnabled(False)
        self._f_scale_chk.toggled.connect(self._f_scale.setEnabled)
        sc_row = QWidget()
        sc_lay = QHBoxLayout(sc_row)
        sc_lay.setContentsMargins(0, 0, 0, 0)
        sc_lay.addWidget(self._f_scale_chk)
        sc_lay.addWidget(self._f_scale)
        sc_lay.addStretch(1)
        f.addRow("气泡缩放", sc_row)
        rl.addWidget(basic)

        cond_box = QGroupBox("说这组话的条件（留空＝不限）")
        cb = QVBoxLayout(cond_box)
        self._cond = ConditionExprTreeRootWidget(model_getter=lambda: self._model)
        cb.addWidget(self._cond)
        rl.addWidget(cond_box)

        lines_box = QGroupBox("台词（每行一句）")
        lb = QVBoxLayout(lines_box)
        hint = QLabel(
            "支持 [tag:…] 项目引用与 [c:…] 语义色板（用行尾「引用」「染色」按钮插，勿手打）。\n"
            "「只说一次」勾上＝整局说过就不再说（随存档记住）。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#888;")
        lb.addWidget(hint)
        self._lines_host = QWidget()
        self._lines_lay = QVBoxLayout(self._lines_host)
        self._lines_lay.setContentsMargins(0, 0, 0, 0)
        lb.addWidget(self._lines_host)
        add_line = QPushButton("+ 一句")
        add_line.setMaximumWidth(90)
        add_line.clicked.connect(lambda: self._add_line_row({"text": ""}))
        lb.addWidget(add_line)
        self._line_rows: list[dict] = []
        rl.addWidget(lines_box)

        self._apply_btn = QPushButton("Apply")
        self._apply_btn.clicked.connect(self._apply)
        rl.addWidget(self._apply_btn)
        rl.addStretch(1)
        self._right_host = right_host

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(right_host)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([260, 700])
        root.addWidget(splitter)

        self._reload_ref_candidates()
        self._refresh()
        self._load_tuning()
        if self._list.count() == 0:
            self._clear_form()

    # ---------- tuning ----------

    def _build_tuning_box(self) -> QGroupBox:
        box = QGroupBox("全局节奏（tuning）")
        f = compact_form(QFormLayout())
        box.setLayout(f)
        self._tuning_widgets: dict[str, QSpinBox] = {}
        for key, label, lo, hi, default, tip in _TUNING_FIELDS:
            w = QSpinBox()
            w.setRange(lo, hi)
            w.setValue(default)
            w.setMaximumWidth(120)
            w.setToolTip(tip)
            if key.endswith("Ms"):
                w.setSingleStep(500)
            f.addRow(label, w)
            self._tuning_widgets[key] = w
        btn = QPushButton("应用节奏")
        btn.setToolTip("把上面四个值写回 bubble_lines.json 的 tuning")
        btn.clicked.connect(self._apply_tuning)
        f.addRow("", btn)
        return box

    def _load_tuning(self) -> None:
        bl = self._model.bubble_lines
        raw = bl.get("tuning") if isinstance(bl, dict) else None
        self._tuning_key_present = isinstance(raw, dict)
        t = raw if isinstance(raw, dict) else {}
        self._tuning_original = dict(t)
        for key, _label, _lo, _hi, default, _tip in _TUNING_FIELDS:
            v = t.get(key)
            self._tuning_widgets[key].setValue(int(v) if isinstance(v, (int, float)) else default)
        # 载入后的快照＝"用户还没动过"的基线；脏判断比它，而不是比模型里的 dict
        # （比模型的话，盘上没配 tuning 时四个缺省值天然"不等"，一 flush 就凭空写进去一整块）
        self._tuning_at_load = self._read_tuning_ui()

    def _read_tuning_ui(self) -> dict:
        return {
            key: int(self._tuning_widgets[key].value())
            for key, _l, _lo, _hi, _d, _t in _TUNING_FIELDS
        }

    def _tuning_dirty(self) -> bool:
        return self._read_tuning_ui() != getattr(self, "_tuning_at_load", self._read_tuning_ui())

    def _apply_tuning(self) -> None:
        if not self._tuning_dirty():
            return
        # 从原件复制：盘上 tuning 里的未知键（未来字段 / 备注）不该被这一次保存抹掉
        merged = dict(getattr(self, "_tuning_original", {}))
        merged.update(self._read_tuning_ui())
        self._model.bubble_lines["tuning"] = merged
        self._tuning_at_load = self._read_tuning_ui()
        self._tuning_original = merged
        self._model.mark_dirty("bubble_lines")

    # ---------- 列表 ----------

    def _sets(self) -> list:
        """读当前台词本列表。**只读**——不许就地给模型注入 `lineSets` 键，
        否则"只是打开看了看"会让下次因别的原因保存时凭空多一个键。"""
        bl = self._model.bubble_lines
        sets = bl.get("lineSets") if isinstance(bl, dict) else None
        return sets if isinstance(sets, list) else []

    def _sets_mutable(self) -> list:
        """要往里加/删条目时用；此时才真正建键。"""
        sets = self._model.bubble_lines.get("lineSets")
        if not isinstance(sets, list):
            sets = []
            self._model.bubble_lines["lineSets"] = sets
        return sets

    def _reload_ref_candidates(self) -> None:
        """说话人候选＝**NPC 与热点**（与运行时 resolveEmoteTarget 同口径）。

        ⚠ 刻意排除 zone：`all_scene_entity_ids()` 把 zone 也算实体，但运行时的
        `resolveEmoteTarget` 只认「过场演员 / NPC / player / 当前场景热点」，选了 zone
        这组一句话都不说、还不报错。同 id 跨场景只留第一次出现，标签带场景名便于分辨。
        """
        ents: list[tuple[str, str]] = []
        seen: set[str] = set()
        for eid, label in self._model.all_scene_entity_ids():
            if eid in seen or label.startswith("zone:"):
                continue
            seen.add(eid)
            ents.append((eid, label))
        self._f_speaker_id.set_items(ents)
        for row in getattr(self, "_scene_rows", []):
            row["sel"].set_items([(sid, sid) for sid in self._model.all_scene_ids()])

    def _refresh(self) -> None:
        self._list.clear()
        for c in self._sets():
            # 手改坏一处 JSON 不该把整个页签砸掉（坏元素只读透传）
            self._list.addItem(self._label_for(c) if isinstance(c, dict) else "（无法解析的条目，原样保留）")

    def _label_for(self, c) -> str:
        if not isinstance(c, dict):
            return "（无法解析的条目，原样保留）"
        sp = c.get("speaker") if isinstance(c.get("speaker"), dict) else {}
        who = "主角" if sp.get("kind") == "player" else str(sp.get("id") or "?")
        return f"{c.get('id', '?')}  · {who}  ({len(c.get('lines') or [])} 句)"

    # ---------- 台词行 ----------

    def _clear_line_rows(self) -> None:
        for row in self._line_rows:
            row["widget"].setParent(None)
            row["widget"].deleteLater()
        self._line_rows = []

    def _add_line_row(self, line) -> None:
        if not isinstance(line, dict):
            # 坏元素：不给控件，只把原值挂着等原样写回。
            # ⚠ 显式 `raw` 标记：靠 `original is not None` 判的话 JSON 的 `null` 会当成正常行，
            # 读表时去取不存在的控件 → KeyError → 整页被跳过、编辑静默不落盘。
            self._line_rows.append({"widget": QWidget(), "original": line, "raw": True})
            return
        host = QWidget()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        text = RichTextLineEdit(self._model)
        text.setText(str(line.get("text") or ""))
        lay.addWidget(text, 1)
        weight = QDoubleSpinBox()
        # 下限给到 0：夹到 0.1 会把盘上写的 0.05 悄悄改掉
        weight.setRange(0.0, 100.0)
        weight.setSingleStep(0.5)
        weight.setValue(_float_or(line.get("weight"), 1.0))
        weight.setMaximumWidth(70)
        weight.setToolTip("随机挑句的权重")
        lay.addWidget(weight)
        once = QCheckBox("只说一次")
        once.setChecked(line.get("once") is True)
        lay.addWidget(once)
        rm = QPushButton("×")
        rm.setMaximumWidth(28)
        rm.setToolTip("删掉这一句")
        lay.addWidget(rm)
        self._lines_lay.addWidget(host)
        entry = {"widget": host, "text": text, "weight": weight, "once": once, "original": line}
        self._line_rows.append(entry)
        rm.clicked.connect(lambda: self._remove_line_row(entry))

    def _remove_line_row(self, entry: dict) -> None:
        if entry not in self._line_rows:
            return
        self._line_rows.remove(entry)
        entry["widget"].setParent(None)
        entry["widget"].deleteLater()

    def _read_lines(self) -> list:
        """读台词行。坏元素（非 dict）原样透传；dict 从原件复制，只覆盖本表单管的键。"""
        out: list = []
        for row in self._line_rows:
            if row.get("raw"):
                out.append(row.get("original"))
                continue
            original = row.get("original")
            t = row["text"].text().strip()
            if not t:
                continue
            item: dict = dict(original) if isinstance(original, dict) else {}
            item["text"] = t
            w = float(row["weight"].value())
            if abs(w - 1.0) > 1e-9:
                item["weight"] = int(w) if float(w).is_integer() else w
            else:
                item.pop("weight", None)
            if row["once"].isChecked():
                item["once"] = True
            else:
                item.pop("once", None)
            out.append(item)
        return out

    # ---------- 表单 ----------

    def _add_scene_row(self, scene_id: str) -> None:
        host = QWidget()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        sel = IdRefSelector(allow_empty=True, click_opens_popup=True)
        sel.set_items([(sid, sid) for sid in self._model.all_scene_ids()])
        sel.set_current(scene_id)
        lay.addWidget(sel, 1)
        rm = QPushButton("×")
        rm.setMaximumWidth(28)
        lay.addWidget(rm)
        self._scenes_rows_lay.addWidget(host)
        row = {"widget": host, "sel": sel}
        self._scene_rows.append(row)
        rm.clicked.connect(lambda: self._remove_scene_row(row))

    def _remove_scene_row(self, row: dict) -> None:
        if row not in self._scene_rows:
            return
        self._scene_rows.remove(row)
        row["widget"].setParent(None)
        row["widget"].deleteLater()

    def _clear_scene_rows(self) -> None:
        for row in list(self._scene_rows):
            self._remove_scene_row(row)

    def _read_scenes(self) -> list[str]:
        out: list[str] = []
        for row in self._scene_rows:
            sid = row["sel"].current_id()
            if sid and sid not in out:
                out.append(sid)
        return out

    def _sync_speaker_enabled(self) -> None:
        self._f_speaker_id.setEnabled(self._f_speaker_kind.currentData() == "entity")

    def _sync_trigger_enabled(self) -> None:
        self._f_range.setEnabled(self._f_trigger.currentData() == "approach")

    def _clear_form(self) -> None:
        self._current_idx = -1
        self._f_id.clear()
        self._f_desc.clear()
        self._f_speaker_id.set_current("")
        self._clear_scene_rows()
        self._cond.set_expr(None)
        self._clear_line_rows()
        self._right_host.setEnabled(False)
        self._apply_btn.setEnabled(False)

    def reload_refs_from_model(self) -> None:
        """切页激活时**只**重拉候选，绝不回填表单。

        契约（mainwindow-editor-hooks）：本钩子不得重置字段——回填会把用户还没 Apply
        的编辑静默冲掉（去别的页改点东西再切回来就没了，且无提示）。
        """
        self._reload_ref_candidates()

    def select_by_id(self, item_id: str, _scene_id: str = "") -> bool:
        for i, c in enumerate(self._sets()):
            if isinstance(c, dict) and c.get("id") == item_id:
                self._list.setCurrentRow(i)
                return True
        return False

    def _on_select(self, row: int) -> None:
        sets = self._sets()
        if row < 0 or row >= len(sets):
            self._current_idx = -1
            return
        if 0 <= self._current_idx < len(sets) and self._current_idx != row and self._set_dirty():
            self._apply()
        self._right_host.setEnabled(True)
        self._apply_btn.setEnabled(True)
        self._current_idx = row
        c = sets[row]
        if not isinstance(c, dict):
            # 坏元素：锁掉右侧表单，避免把它编成别的形状（透传保值）
            self._right_host.setEnabled(False)
            self._apply_btn.setEnabled(False)
            return
        self._f_id.setText(str(c.get("id") or ""))
        self._f_desc.setText(str(c.get("description") or ""))
        sp = c.get("speaker") if isinstance(c.get("speaker"), dict) else {}
        kind = "player" if sp.get("kind") == "player" else "entity"
        self._f_speaker_kind.setCurrentIndex(self._f_speaker_kind.findData(kind))
        self._f_speaker_id.set_current(str(sp.get("id") or ""))
        self._sync_speaker_enabled()
        self._clear_scene_rows()
        for sid in c.get("scenes") or []:
            self._add_scene_row(str(sid))
        trig = "approach" if c.get("trigger") == "approach" else "ambient"
        self._f_trigger.setCurrentIndex(self._f_trigger.findData(trig))
        self._sync_trigger_enabled()
        # ⚠ 一律显式判类型，**不能用 `or`**：0 是合法值（cooldownMs:0＝不限冷却），
        # `c.get("cooldownMs") or 20000` 会把 0 顶成 20000——那是改行为不是格式漂移。
        self._f_range.setValue(_int_or(c.get("approachRange"), 140))
        self._f_priority.setValue(_int_or(c.get("priority"), 0))
        self._f_cooldown.setValue(_int_or(c.get("cooldownMs"), 20000))
        self._f_duration.setValue(_int_or(c.get("durationMs"), 2600))
        pick = "sequence" if c.get("pickMode") == "sequence" else "random"
        self._f_pick.setCurrentIndex(self._f_pick.findData(pick))
        has_scale = isinstance(c.get("bubbleScale"), (int, float))
        self._f_scale_chk.setChecked(has_scale)
        self._f_scale.setValue(_float_or(c.get("bubbleScale"), 1.0))
        self._cond.set_expr(c.get("when"))
        self._clear_line_rows()
        for line in c.get("lines") or []:
            self._add_line_row(line)

    def _write_into(self, c: dict) -> None:
        c["id"] = self._f_id.text().strip()
        desc = self._f_desc.text().strip()
        if desc:
            c["description"] = desc
        else:
            c.pop("description", None)
        # 从原件复制：speaker 里的未知子键（策划备注之类）与键序都不该被这一次保存抹掉
        old_sp = c.get("speaker")
        sp: dict = dict(old_sp) if isinstance(old_sp, dict) else {}
        if self._f_speaker_kind.currentData() == "player":
            sp["kind"] = "player"
            sp.pop("id", None)
        else:
            sp["kind"] = "entity"
            sp["id"] = self._f_speaker_id.current_id()
        c["speaker"] = sp
        scenes = self._read_scenes()
        old_scenes = c.get("scenes")
        if isinstance(old_scenes, list) and set(map(str, old_scenes)) == set(scenes) and scenes:
            pass                      # 集合没变（可能有重复项/别的顺序）：原样留着
        elif scenes:
            c["scenes"] = scenes
        else:
            c.pop("scenes", None)
        when = self._cond.get_expr()
        if when:
            c["when"] = when
        else:
            c.pop("when", None)
        # 缺省值一律不写键（"打开→不改→保存"不得凭空多键）
        if self._f_trigger.currentData() == "approach":
            c["trigger"] = "approach"
            # 与缺省相同就不写键（"打开→不改→保存"不得凭空多键）
            rng = int(self._f_range.value())
            if rng != 140:
                c["approachRange"] = rng
            else:
                c.pop("approachRange", None)
        else:
            c.pop("trigger", None)
            c.pop("approachRange", None)
        for key, widget, default in (
            ("priority", self._f_priority, 0),
            ("durationMs", self._f_duration, 2600),
        ):
            v = int(widget.value())
            if v != default:
                c[key] = v
            else:
                c.pop(key, None)
        # ⚠ cooldownMs 的 0 不是"没配"：0＝不限冷却，缺省＝20000。按"等于缺省就删键"处理
        # 会把 0 改写成 20000（**改行为**，不是格式漂移）。故只有盘上本来没这个键、
        # 且 UI 仍停在缺省值时才不写。
        cd = int(self._f_cooldown.value())
        old_cd = c.get("cooldownMs")
        if old_cd is not None and not isinstance(old_cd, (int, float)) and cd == 20000:
            pass                      # 盘上是坏值且用户没动过：表单表达不了它，原样留着
        elif cd != 20000 or "cooldownMs" in c:
            c["cooldownMs"] = cd
        else:
            c.pop("cooldownMs", None)
        if self._f_pick.currentData() == "sequence":
            c["pickMode"] = "sequence"
        else:
            c.pop("pickMode", None)
        if self._f_scale_chk.isChecked():
            v = float(self._f_scale.value())
            c["bubbleScale"] = int(v) if float(v).is_integer() else v
        else:
            c.pop("bubbleScale", None)
        c["lines"] = self._read_lines()

    def _is_dirty(self) -> bool:
        """整页脏不脏（tuning + 当前条目）。tuning 必须算进来——它不在选中项里、
        只挂在左栏那四个 spinbox 上，漏掉的话改了节奏直接 Ctrl+S / 关窗会静默丢失。"""
        return self._tuning_dirty() or self._set_dirty()

    def _set_dirty(self) -> bool:
        """只看当前选中的台词本有没有改。"""
        sets = self._sets()
        if self._current_idx < 0 or self._current_idx >= len(sets):
            return False
        c = sets[self._current_idx]
        if not isinstance(c, dict):
            return False
        test = copy.deepcopy(c)
        self._write_into(test)
        return test != c

    def flush_to_model(self) -> bool:
        # 门控真实变更：无条件 apply 会让"只是打开看了看"也标脏（脏态真实性）
        self._apply_tuning()          # 内部自带 _tuning_dirty 门
        if self._current_idx >= 0 and self._set_dirty():
            self._apply()
        return True

    def commit_pending_on_leave(self) -> None:
        """切页离开时提交未 Apply 的编辑（主窗钩子；有 Apply 按钮的 staging 面板必须实现）。"""
        self.flush_to_model()

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前台词本有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply_tuning()
            self._apply()
        else:
            # Discard：表单与 tuning 一起回滚到模型值，否则关闭路径随后的统一 flush
            # 会按 UI≠模型判脏，把刚被放弃的编辑重新提交
            self._load_tuning()
            self._on_select(self._current_idx)
        return True

    def _apply(self) -> None:
        sets = self._sets()
        if self._current_idx < 0 or self._current_idx >= len(sets):
            return
        c = sets[self._current_idx]
        if not isinstance(c, dict):
            return
        self._write_into(c)
        self._model.mark_dirty("bubble_lines")
        lw = self._list.item(self._current_idx)
        if lw is not None:
            lw.setText(self._label_for(c))

    def _add(self) -> None:
        sets = self._sets_mutable()
        taken = {str(c.get("id", "")) for c in sets if isinstance(c, dict)}
        n = 0
        while f"bubble_{n}" in taken:
            n += 1
        sets.append({
            "id": f"bubble_{n}",
            "speaker": {"kind": "entity", "id": ""},
            "lines": [],
        })
        self._model.mark_dirty("bubble_lines")
        self._refresh()
        self._list.setCurrentRow(len(sets) - 1)

    def _delete(self) -> None:
        sets = self._sets_mutable()
        if self._current_idx < 0 or self._current_idx >= len(sets):
            return
        c = sets[self._current_idx]
        if not confirm.confirm_delete(self, f"台词本「{c.get('id', '')}」"):
            return
        idx = self._current_idx
        sets.pop(idx)
        self._current_idx = -1
        self._model.mark_dirty("bubble_lines")
        self._refresh()
        if sets:
            self._list.setCurrentRow(min(idx, len(sets) - 1))
        else:
            self._clear_form()
