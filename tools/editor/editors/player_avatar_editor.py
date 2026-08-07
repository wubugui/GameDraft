"""玩家化身：game_config.playerAvatar（动画 manifest + idle/walk/run 与 clip 映射）。"""
from __future__ import annotations

import re
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QFormLayout,
    QGroupBox,
    QLabel,
    QComboBox,
    QSpinBox,
    QDoubleSpinBox,
    QCheckBox,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QMessageBox,
)

from ..project_model import ProjectModel
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.condition_expr_tree import ConditionExprTreeRootWidget
from ..shared.num_fields import float_or as _float_or, int_or as _int_or
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.portrait_catalog import load_portrait_sets

_DEFAULT_MANIFEST = "/resources/runtime/animation/player_anim/anim.json"
_IDENTITY = "（与逻辑名相同，不映射）"
_IDENTITY_DATA = ""

_LOGICAL_ROWS: tuple[tuple[str, str], ...] = (
    ("idle", "待机（Player 静止、剧情移动结束）"),
    ("walk", "行走（方向键移动，未按住奔跑）"),
    ("run", "奔跑（按住奔跑键）"),
)

# 身体动词的逻辑名（与 src/data/types.ts 的 PLAYER_VERB_LOGICAL_STATES 对齐）。
# **不映射 = 该动词在本装扮下自动禁用**（如背尸包没有 kick，扛着尸体就踢不了）。
_VERB_LOGICAL_ROWS: tuple[tuple[str, str], ...] = (
    ("crouch", "蹲（按住 C；下蹲片段，倒放即起身）"),
    ("crouchWalk", "蹲行（蹲着移动；不映射则保持蹲姿定格滑行）"),
    ("gaze", "驻足注视（按住 X；站定看，可直接映射到 stand）"),
    ("kick", "上脚 / 踢（按 F；一次性片段）"),
    ("jump", "跳（按空格；原地跳与 act_spot 跨点跳共用）"),
    ("lie", "躺（躺点上按 C；躺下片段，倒放即起身）"),
)

_MANIFEST_RE = re.compile(r"^/resources/runtime/animation/([^/]+)/anim\.json$")


def _bundle_id_from_manifest(url: str) -> str:
    m = _MANIFEST_RE.match((url or "").strip())
    return m.group(1) if m else ""


def _states_keys(anim: dict[str, Any]) -> list[str]:
    st = anim.get("states")
    if not isinstance(st, dict):
        return []
    return sorted(str(k) for k in st.keys())


class PlayerAvatarEditor(QWidget):
    """编辑 ``game_config.json`` 中的 ``playerAvatar``。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self.setMinimumSize(420, 460)

        root = QVBoxLayout(self)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        inner = QWidget()
        lay = QVBoxLayout(inner)

        hint = QLabel(
            "逻辑状态名 <b>idle / walk / run</b> 由游戏代码固定（见 <code>Player.ts</code>）；"
            "身体动词（蹲/注视/上脚/跳/躺）的逻辑名见下方折叠区。")
        hint.setWordWrap(True)
        hint.setTextFormat(Qt.TextFormat.RichText)
        hint.setToolTip(
            "此处选择动画包并为三态指定 anim.json 里 states 的键。\n"
            "事件中可用 Action：setPlayerAvatar（animManifest 或 bundleId + 可选 stateMap）"
            "切换化身；resetPlayerAvatar 恢复为下方保存的默认（与 game_config 一致）。"
        )
        lay.addWidget(hint)

        pack_box = QGroupBox("动画包（anim.json）")
        pack_form = compact_form(QFormLayout(pack_box))
        self._bundle_combo = QComboBox()
        self._bundle_combo.setMinimumWidth(200)
        self._bundle_combo.setToolTip(
            "选择工程内已导出的动画包；选定后自动填充下方 animManifest URL。"
            "选「仅手动填写 URL」可直接编辑路径。"
        )
        self._bundle_combo.currentIndexChanged.connect(self._on_bundle_changed)
        pack_form.addRow("工程内动画包", self._bundle_combo)

        man_row = QHBoxLayout()
        self._manifest_edit = QLineEdit()
        self._manifest_edit.setPlaceholderText(_DEFAULT_MANIFEST)
        self._manifest_edit.setMinimumWidth(240)
        self._manifest_edit.setToolTip(
            "写入 playerAvatar.animManifest 的 anim.json URL；"
            "形如 /resources/runtime/animation/<包名>/anim.json。"
        )
        man_row.addWidget(self._manifest_edit, 1)
        reset_m = QPushButton("按包名填充路径")
        reset_m.setToolTip(f"写入 {_MANIFEST_RE.pattern} 形式的标准 URL")
        reset_m.clicked.connect(self._fill_manifest_from_bundle)
        man_row.addWidget(reset_m)
        pack_form.addRow("animManifest URL", man_row)

        self._portrait_combo = QComboBox()
        self._portrait_combo.setMinimumWidth(200)
        self._portrait_combo.setToolTip(
            "对话头像立绘集（resources/runtime/images/dialogue_portraits/<slug>/）。\n"
            "留空 = 按动画包目录名同名推导（如 player_taoist_anim）。\n"
            "图对话行头像选「跟随说话人」时，主角行按此解析；setPlayerAvatar 换装可覆盖。"
        )
        pack_form.addRow("portraitSlug（对话头像）", self._portrait_combo)

        lay.addWidget(pack_box)

        map_box = QGroupBox("逻辑状态 → clip（states 键）")
        map_form = compact_form(QFormLayout(map_box))
        self._clip_combos: dict[str, QComboBox] = {}
        for logical, desc in _LOGICAL_ROWS:
            map_form.addRow(self._make_clip_row(logical, desc))
        lay.addWidget(map_box)

        verb_sec = CollapsibleSection("身体动词 → clip（不映射 = 该动词在本装扮下禁用）", start_open=False)
        verb_sec.set_header_tool_tip(
            "蹲 / 驻足注视 / 上脚 / 跳 / 躺 的动画映射。\n"
            "某动词在此解析不到片段时，游戏里该动词自动禁用、不出提示——\n"
            "这正是「背尸包没有 kick 就踢不了」的实现方式，不需要另设开关。"
        )
        verb_box = QWidget()
        verb_form = compact_form(QFormLayout(verb_box))
        for logical, desc in _VERB_LOGICAL_ROWS:
            verb_form.addRow(self._make_clip_row(logical, desc))
        verb_sec.add_body(verb_box)
        lay.addWidget(verb_sec)
        lay.addWidget(self._build_idle_section())

        btn_row = QHBoxLayout()
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("把上方动画包与三态映射写入 game_config.playerAvatar 并标脏；保存工程后写入磁盘。")
        apply_btn.clicked.connect(self._apply)
        btn_row.addWidget(apply_btn)
        reload_anim = QPushButton("从磁盘重载动画列表")
        reload_anim.setToolTip("同步 video_to_atlas 导出后的 anim.json 目录")
        reload_anim.clicked.connect(self._reload_anims)
        btn_row.addWidget(reload_anim)
        btn_row.addStretch()
        lay.addLayout(btn_row)

        lay.addStretch()
        scroll.setWidget(inner)
        root.addWidget(scroll)

        self._sync_player_avatar_deferred: bool = False
        self._model.data_changed.connect(self._on_model_changed)
        self._rebuild_bundle_combo()
        self._load_from_model()

    def _make_clip_row(self, logical: str, desc: str) -> QWidget:
        """一行「逻辑名 — 说明 + clip 下拉」。states 键是短枚举，用下拉合规。"""
        row = QHBoxLayout()
        short_desc, _, detail = desc.partition("（")
        lab = QLabel(f"<b>{logical}</b> — {short_desc.strip()}")
        lab.setTextFormat(Qt.TextFormat.RichText)
        row.addWidget(lab)
        cb = QComboBox()
        cb.setMaximumWidth(220)
        if detail:
            cb.setToolTip(detail.rstrip("）"))
        self._clip_combos[logical] = cb
        row.addWidget(cb, 1)
        w = QWidget()
        w.setLayout(row)
        return w

    def flush_to_model(self) -> None:
        self._apply()

    def _on_model_changed(self, data_type: str, _item_id: str) -> None:
        if data_type not in ("config", "animation", ""):
            return
        self._sync_player_avatar_deferred = True
        if self.isVisible():
            self._flush_player_avatar_model_sync()

    def _flush_player_avatar_model_sync(self) -> None:
        if not self._sync_player_avatar_deferred:
            return
        # 脏保护（P2 ⑥，照 anim_editor 样板）：有未 Apply 的选择时，别用模型值重载覆盖
        # 正在编辑的表单（否则「别页动过 config 后切回」= 静默丢当前编辑）。
        # 候选（动画包列表）仍刷新，只是不回填字段。
        if self._is_dirty():
            self._rebuild_bundle_combo()
            return
        self._sync_player_avatar_deferred = False
        self._rebuild_bundle_combo()
        self._load_from_model()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        self._flush_player_avatar_model_sync()

    def _compose_player_avatar(self) -> tuple[dict, dict | None]:
        """把当前 UI 组成 playerAvatar dict，并返回 (新值, 模型旧值)。_apply 与脏判断共用。"""
        man = self._manifest_edit.text().strip() or _DEFAULT_MANIFEST
        state_map: dict[str, str] = {}
        for logical, cb in self._clip_combos.items():
            clip = str(cb.currentData() or "").strip()
            if clip and clip != _IDENTITY_DATA:
                state_map[logical] = clip
        old = self._model.game_config.get("playerAvatar")
        pa: dict[str, Any] = dict(old) if isinstance(old, dict) else {}
        pa["animManifest"] = man
        # 面板只有九个固定逻辑名的下拉，但 stateMap 是 SpriteEntity.resolveClip 的**通用别名表**
        # （validator 对未知逻辑名只给 warning、视为合法）。重建式写法会把策划自定义的别名
        # （过场里 playNpcAnimation state=<别名> 用的那些）在"打开→保存"时悄悄删掉。
        old_map = old.get("stateMap") if isinstance(old, dict) else None
        if isinstance(old_map, dict):
            for logical, clip in old_map.items():
                if logical not in self._clip_combos:
                    state_map.setdefault(str(logical), clip)
        if state_map:
            pa["stateMap"] = state_map
        else:
            pa.pop("stateMap", None)
        idle = self._read_idle_config()
        if idle:
            pa["idle"] = idle
        else:
            pa.pop("idle", None)
        slug = str(self._portrait_combo.currentData() or "").strip()
        if slug:
            pa["portraitSlug"] = slug
        else:
            pa.pop("portraitSlug", None)
        return pa, (old if isinstance(old, dict) else None)

    # ---------- 待机节目 ----------

    def _build_idle_section(self) -> CollapsibleSection:
        """长时间不操作时主角自己演的小节目。动画状态下拉**现场扫 manifest**，
        策划往角色动画包里补一个状态，这里立刻能选到（不需要改代码）。"""
        sec = CollapsibleSection("待机节目（长时间不操作时自己演）", start_open=False)
        sec.set_header_tool_tip(
            "停手够久 → 按下面的条目挑一个演：可以只播动画、只冒一句话、或者两样一起。\n"
            "整块留空 = 不演。动画状态取自上面选的动画包（补了新状态记得点「从磁盘重载动画列表」）。"
        )
        body = QWidget()
        bl = QVBoxLayout(body)
        bl.setContentsMargins(0, 0, 0, 0)

        head = QWidget()
        hf = compact_form(QFormLayout(head))
        self._idle_enabled = QCheckBox("开启待机节目")
        self._idle_enabled.setChecked(True)
        hf.addRow("", self._idle_enabled)
        self._idle_first = QSpinBox()
        self._idle_first.setRange(0, 86400000)
        self._idle_first.setSingleStep(1000)
        self._idle_first.setValue(12000)
        self._idle_first.setMaximumWidth(120)
        self._idle_first.setToolTip("停手多久后演第一个节目")
        hf.addRow("首次延迟(ms)", self._idle_first)
        self._idle_repeat = QSpinBox()
        self._idle_repeat.setRange(0, 86400000)
        self._idle_repeat.setSingleStep(1000)
        self._idle_repeat.setValue(18000)
        self._idle_repeat.setMaximumWidth(120)
        self._idle_repeat.setToolTip("之后每隔多久再演一个")
        hf.addRow("重复间隔(ms)", self._idle_repeat)
        self._idle_jitter = QSpinBox()
        self._idle_jitter.setRange(0, 86400000)
        self._idle_jitter.setSingleStep(500)
        self._idle_jitter.setValue(6000)
        self._idle_jitter.setMaximumWidth(120)
        self._idle_jitter.setToolTip("间隔的随机抖动上限；固定间隔会让待机看着像机器")
        hf.addRow("间隔抖动(ms)", self._idle_jitter)
        bl.addWidget(head)

        self._idle_rows_host = QWidget()
        self._idle_rows_lay = QVBoxLayout(self._idle_rows_host)
        self._idle_rows_lay.setContentsMargins(0, 0, 0, 0)
        bl.addWidget(self._idle_rows_host)
        self._idle_rows: list[dict] = []

        add = QPushButton("+ 节目")
        add.setMaximumWidth(90)
        add.clicked.connect(lambda: self._add_idle_row({}))
        bl.addWidget(add)

        sec.add_body(body)
        return sec

    def _add_idle_row(self, entry) -> None:
        if not isinstance(entry, dict):
            # 坏元素只读透传（norms：空集合与数组坏元素一律不改写）。
            # ⚠ 必须挂显式 `raw` 标记：靠 `original is not None` 判的话 JSON 里的 `null`
            # 会被当成正常行，读表时去取不存在的控件 → KeyError → 整页被跳过、编辑静默不落盘。
            self._idle_rows.append({"box": QWidget(), "original": entry, "raw": True})
            return
        box = QGroupBox(f"节目 {len(self._idle_rows) + 1}")
        f = compact_form(QFormLayout(box))

        anim = QComboBox()
        anim.setMaximumWidth(220)
        anim.setToolTip("anim.json 里 states 的键；留「（不播动画）」＝只冒气泡")
        f.addRow("待机动画", anim)

        text = RichTextLineEdit(self._model)
        text.setText(str(entry.get("bubbleText") or ""))
        text.setPlaceholderText("头顶自言自语，可留空")
        f.addRow("气泡台词", text)

        dur = QSpinBox()
        dur.setRange(0, 3600000)
        dur.setSingleStep(200)
        dur.setValue(_int_or(entry.get("bubbleDurationMs"), 2600))
        dur.setMaximumWidth(120)
        f.addRow("气泡停留(ms)", dur)

        weight = QDoubleSpinBox()
        weight.setRange(0.0, 1000.0)
        weight.setSingleStep(0.5)
        weight.setValue(_float_or(entry.get("weight"), 1.0))
        weight.setMaximumWidth(80)
        weight.setToolTip("随机挑节目的权重")
        f.addRow("权重", weight)

        cd = QSpinBox()
        cd.setRange(0, 86400000)
        cd.setSingleStep(1000)
        cd.setValue(_int_or(entry.get("cooldownMs"), 0))
        cd.setMaximumWidth(120)
        cd.setToolTip("这条自己的冷却；0＝不限")
        f.addRow("冷却(ms)", cd)

        cond = ConditionExprTreeRootWidget(model_getter=lambda: self._model)
        cond.set_expr(entry.get("when"))
        f.addRow("条件", cond)

        rm = QPushButton("删掉这个节目")
        rm.setMaximumWidth(130)
        f.addRow("", rm)

        self._idle_rows_lay.addWidget(box)
        row = {
            "box": box, "anim": anim, "text": text, "dur": dur,
            "weight": weight, "cd": cd, "cond": cond,
            "wanted_anim": str(entry.get("animState") or ""),
            "original": entry,
        }
        self._idle_rows.append(row)
        rm.clicked.connect(lambda: self._remove_idle_row(row))
        # ⚠ 用户改选后必须回写 wanted_anim：它是"刷候选时要还原成哪个"的唯一依据，
        # 不回写的话点一下「从磁盘重载动画列表」/换动画包，选择就被退回载入时的旧值。
        anim.currentIndexChanged.connect(
            lambda _i, r=row: r.__setitem__("wanted_anim", str(r["anim"].currentData() or "")))
        self._repopulate_idle_anim_combo(row)

    def _remove_idle_row(self, row: dict) -> None:
        if row not in self._idle_rows:
            return
        self._idle_rows.remove(row)
        row["box"].setParent(None)
        row["box"].deleteLater()
        for i, r in enumerate(self._idle_rows):
            box = r.get("box")
            if isinstance(box, QGroupBox):
                box.setTitle(f"节目 {i + 1}")

    def _repopulate_idle_anim_combo(self, row: dict) -> None:
        if "anim" not in row:
            return   # 坏元素行没有控件
        """候选＝当前动画包的 states 键。保值：数据里的旧值即使不在候选里也保留可见，
        免得换个包打开一次就把配置洗掉（共享控件保值契约同理）。"""
        cb = row["anim"]
        wanted = str(row.get("wanted_anim") or "") or str(cb.currentData() or "")
        cb.blockSignals(True)
        cb.clear()
        cb.addItem("（不播动画）", "")
        keys = _states_keys(self._anim_for_current_manifest())
        for k in keys:
            cb.addItem(k, k)
        if wanted and wanted not in keys:
            cb.addItem(f"(数据) {wanted}", wanted)
        idx = cb.findData(wanted) if wanted else 0
        cb.setCurrentIndex(idx if idx >= 0 else 0)
        cb.blockSignals(False)
        row["wanted_anim"] = wanted

    def _read_idle_config(self) -> dict:
        """读表；整块与缺省一致且没有任何条目时返回 {} 表示"不写这个键"。"""
        entries: list = []
        for row in self._idle_rows:
            if row.get("raw"):
                entries.append(row.get("original"))   # 坏元素原样写回（含 null）
                continue
            original = row.get("original")
            anim = str(row["anim"].currentData() or "").strip()
            text = row["text"].text().strip()
            if not anim and not text:
                continue                      # 既不动也不说：不是一个节目
            # 从原件复制：未知子键（未来字段 / 备注）不该被这一次保存抹掉
            e: dict = dict(original) if isinstance(original, dict) else {}
            for k in ("animState", "bubbleText", "bubbleDurationMs", "weight", "cooldownMs", "when"):
                e.pop(k, None)
            if anim:
                e["animState"] = anim
            if text:
                e["bubbleText"] = text
                d = int(row["dur"].value())
                if d != 2600:
                    e["bubbleDurationMs"] = d
            w = float(row["weight"].value())
            if abs(w - 1.0) > 1e-9:
                e["weight"] = int(w) if float(w).is_integer() else w
            cd = int(row["cd"].value())
            if cd > 0:
                e["cooldownMs"] = cd
            when = row["cond"].get_expr()
            if when:
                e["when"] = when
            entries.append(e)

        old_idle = (self._model.game_config.get("playerAvatar") or {}).get("idle")
        idle: dict = dict(old_idle) if isinstance(old_idle, dict) else {}
        # 本表单管的键先清掉再按 UI 重填；**其余键原样留着**——animWatchdogMs 这类
        # UI 里没有控件的字段，重建式写法会让"打开一次就没了"。
        # 类型不对的值原样留着（`firstDelayMs: ["12000"]` 是手改坏的，UI 表达不了它——
        # 表达不了就别改写，否则"打开一次"就把人家写的东西悄悄抹了）
        # ⚠ 只有"用户没动过"的那些才保值。拿载入时的控件快照比：动过就写用户的值，
        # 否则策划把这个字段改了、Apply 之后又被原样盖回去，还不标脏（改动凭空消失）。
        at_load = getattr(self, "_idle_scalars_at_load", {})
        now = {
            "firstDelayMs": int(self._idle_first.value()),
            "repeatIntervalMs": int(self._idle_repeat.value()),
            "jitterMs": int(self._idle_jitter.value()),
        }
        keep_raw = {
            k: idle[k] for k in ("firstDelayMs", "repeatIntervalMs", "jitterMs")
            if k in idle and not isinstance(idle[k], (int, float))
            and now.get(k) == at_load.get(k)
        }
        for k in ("enabled", "firstDelayMs", "repeatIntervalMs", "jitterMs", "entries"):
            idle.pop(k, None)
        if not self._idle_enabled.isChecked():
            idle["enabled"] = False
        elif isinstance(old_idle, dict) and old_idle.get("enabled") is True:
            idle["enabled"] = True      # 盘上显式写了 true 就留着（往返字节不变）
        for key, widget, default in (
            ("firstDelayMs", self._idle_first, 12000),
            ("repeatIntervalMs", self._idle_repeat, 18000),
            ("jitterMs", self._idle_jitter, 6000),
        ):
            v = int(widget.value())
            if v != default:
                idle[key] = v
        if getattr(self, "_idle_entries_raw", None) is not None:
            idle["entries"] = self._idle_entries_raw     # 非数组：原样还回去
        elif entries:
            idle["entries"] = entries
        idle.update(keep_raw)
        return idle

    def _load_idle_config(self, cfg: dict) -> None:
        idle = cfg.get("idle") if isinstance(cfg.get("idle"), dict) else {}
        self._idle_enabled.setChecked(idle.get("enabled") is not False)
        # ⚠ 一律走 int_or：`or` 会把 0 当"没配"（firstDelayMs:0 被顶成 12000 再连键一起删），
        # 而 int() 直接吃到非数值（手写成 "12s" / ["12000"]）会让整个玩家化身页构造即崩。
        self._idle_first.setValue(_int_or(idle.get("firstDelayMs"), 12000))
        self._idle_repeat.setValue(_int_or(idle.get("repeatIntervalMs"), 18000))
        self._idle_jitter.setValue(_int_or(idle.get("jitterMs"), 6000))
        # 载入快照：keep_raw 用它判断"用户到底动没动过这个字段"
        self._idle_scalars_at_load = {
            "firstDelayMs": int(self._idle_first.value()),
            "repeatIntervalMs": int(self._idle_repeat.value()),
            "jitterMs": int(self._idle_jitter.value()),
        }
        for row in list(self._idle_rows):
            self._remove_idle_row(row)
        raw_entries = idle.get("entries")
        # entries 不是数组（手改成字符串/字典/数字）：整块保值、不建行。
        # 遍历字符串会把它拆成逐字符数组、遍历数字直接 TypeError 把整页构造炸掉。
        self._idle_entries_raw = None if isinstance(raw_entries, list) else raw_entries
        for e in (raw_entries if isinstance(raw_entries, list) else []):
            self._add_idle_row(e)

    def _is_dirty(self) -> bool:
        pa, old = self._compose_player_avatar()
        return pa != (old or {})

    def _reload_anims(self) -> None:
        self._model.reload_animations_from_disk()
        self._rebuild_bundle_combo()
        self._repopulate_clip_combos()
        for row in self._idle_rows:
            self._repopulate_idle_anim_combo(row)
        self._status_message("已重载 public/resources/runtime/animation")

    def _status_message(self, msg: str) -> None:
        win = self.window()
        sb = getattr(win, "statusBar", None)
        if callable(sb):
            bar = sb()
            if bar is not None:
                bar.showMessage(msg, 4000)

    def _rebuild_bundle_combo(self) -> None:
        self._bundle_combo.blockSignals(True)
        self._bundle_combo.clear()
        for bid in sorted(self._model.animations.keys()):
            self._bundle_combo.addItem(bid, bid)
        self._bundle_combo.addItem("（仅手动填写 URL）", "__custom__")
        self._bundle_combo.blockSignals(False)

    def _current_bundle_id(self) -> str:
        i = self._bundle_combo.currentIndex()
        if i < 0:
            return ""
        d = self._bundle_combo.currentData()
        if d == "__custom__":
            return ""
        return str(d) if d else ""

    def _on_bundle_changed(self, _idx: int) -> None:
        bid = self._current_bundle_id()
        if bid:
            self._manifest_edit.setText(f"/resources/runtime/animation/{bid}/anim.json")
        self._repopulate_clip_combos()
        for row in self._idle_rows:
            self._repopulate_idle_anim_combo(row)

    def _fill_manifest_from_bundle(self) -> None:
        bid = self._current_bundle_id()
        if not bid:
            QMessageBox.information(
                self,
                "提示",
                "请先在列表中选择一个动画包，或使用「仅手动填写 URL」后在下方直接编辑路径。",
            )
            return
        self._manifest_edit.setText(f"/resources/runtime/animation/{bid}/anim.json")

    def _anim_for_current_manifest(self) -> dict[str, Any]:
        bid = _bundle_id_from_manifest(self._manifest_edit.text())
        if bid and bid in self._model.animations:
            return self._model.animations[bid]
        return {}

    def _repopulate_clip_combos(self) -> None:
        anim = self._anim_for_current_manifest()
        keys = _states_keys(anim)
        cfg = self._model.game_config.get("playerAvatar") or {}
        sm = cfg.get("stateMap") if isinstance(cfg.get("stateMap"), dict) else {}

        for logical, cb in self._clip_combos.items():
            cb.blockSignals(True)
            cb.clear()
            cb.addItem(_IDENTITY, _IDENTITY_DATA)
            for k in keys:
                cb.addItem(k, k)
            want = sm.get(logical) if isinstance(sm.get(logical), str) else None
            if want and want not in keys and want:
                cb.addItem(f"{want} （当前 anim 中无此键）", want)
            if want:
                idx = cb.findData(want)
                if idx < 0:
                    idx = cb.findText(want)
                if idx >= 0:
                    cb.setCurrentIndex(idx)
                else:
                    cb.setCurrentIndex(0)
            else:
                cb.setCurrentIndex(0)
            cb.blockSignals(False)

    def _populate_portrait_combo(self) -> None:
        cfg = self._model.game_config.get("playerAvatar") or {}
        cur = str(cfg.get("portraitSlug") or "").strip()
        self._portrait_combo.blockSignals(True)
        self._portrait_combo.clear()
        self._portrait_combo.addItem("（按动画包同名推导）", "")
        sets = (
            load_portrait_sets(self._model.project_path)
            if self._model.project_path is not None
            else []
        )
        for s in sets:
            self._portrait_combo.addItem(s, s)
        if cur and self._portrait_combo.findData(cur) < 0:
            # 数据里带了磁盘上不存在的立绘集：保留可见，不静默清掉
            self._portrait_combo.addItem(f"{cur}（缺集）", cur)
        idx = self._portrait_combo.findData(cur)
        self._portrait_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self._portrait_combo.blockSignals(False)

    def _load_from_model(self) -> None:
        cfg = self._model.game_config.get("playerAvatar")
        if not isinstance(cfg, dict):
            cfg = {}
        man = str(cfg.get("animManifest") or "").strip() or _DEFAULT_MANIFEST
        self._manifest_edit.setText(man)

        bid = _bundle_id_from_manifest(man)
        self._bundle_combo.blockSignals(True)
        if bid:
            idx = self._bundle_combo.findData(bid)
            if idx >= 0:
                self._bundle_combo.setCurrentIndex(idx)
            else:
                cidx = self._bundle_combo.findData("__custom__")
                self._bundle_combo.setCurrentIndex(max(0, cidx))
        else:
            cidx = self._bundle_combo.findData("__custom__")
            self._bundle_combo.setCurrentIndex(max(0, cidx))
        self._bundle_combo.blockSignals(False)

        self._repopulate_clip_combos()
        self._populate_portrait_combo()
        self._load_idle_config(cfg)

    def _apply(self) -> None:
        # 保留未知子键（未来字段），只更新本面板管理的键（compose 与脏判断共用）。
        pa, old = self._compose_player_avatar()
        if pa == old:
            return  # 无实质变化：不写不标脏（否则每次 Save All 都重写 game_config）
        self._model.game_config["playerAvatar"] = pa
        self._model.mark_dirty("config")
        self._status_message("已更新 playerAvatar")
