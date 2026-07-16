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
    QLineEdit,
    QPushButton,
    QScrollArea,
    QMessageBox,
)

from ..project_model import ProjectModel
from ..shared.form_layout import compact_form
from ..shared.portrait_catalog import load_portrait_sets

_DEFAULT_MANIFEST = "/resources/runtime/animation/player_anim/anim.json"
_IDENTITY = "（与逻辑名相同，不映射）"
_IDENTITY_DATA = ""

_LOGICAL_ROWS: tuple[tuple[str, str], ...] = (
    ("idle", "待机（Player 静止、剧情移动结束）"),
    ("walk", "行走（方向键移动，未按住奔跑）"),
    ("run", "奔跑（按住奔跑键）"),
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
            "逻辑状态名 <b>idle / walk / run</b> 由游戏代码固定（见 <code>Player.ts</code>）。")
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
            row = QHBoxLayout()
            short_desc, _, detail = desc.partition("（")
            short_desc = short_desc.strip()
            lab = QLabel(f"<b>{logical}</b> — {short_desc}")
            lab.setTextFormat(Qt.TextFormat.RichText)
            row.addWidget(lab)
            cb = QComboBox()
            cb.setMinimumWidth(180)
            if detail:
                cb.setToolTip(detail.rstrip("）"))
            self._clip_combos[logical] = cb
            row.addWidget(cb, 1)
            w = QWidget()
            w.setLayout(row)
            map_form.addRow(w)
        lay.addWidget(map_box)

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
        if state_map:
            pa["stateMap"] = state_map
        else:
            pa.pop("stateMap", None)
        slug = str(self._portrait_combo.currentData() or "").strip()
        if slug:
            pa["portraitSlug"] = slug
        else:
            pa.pop("portraitSlug", None)
        return pa, (old if isinstance(old, dict) else None)

    def _is_dirty(self) -> bool:
        pa, old = self._compose_player_avatar()
        return pa != (old or {})

    def _reload_anims(self) -> None:
        self._model.reload_animations_from_disk()
        self._rebuild_bundle_combo()
        self._repopulate_clip_combos()
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

    def _apply(self) -> None:
        # 保留未知子键（未来字段），只更新本面板管理的键（compose 与脏判断共用）。
        pa, old = self._compose_player_avatar()
        if pa == old:
            return  # 无实质变化：不写不标脏（否则每次 Save All 都重写 game_config）
        self._model.game_config["playerAvatar"] = pa
        self._model.mark_dirty("config")
        self._status_message("已更新 playerAvatar")
