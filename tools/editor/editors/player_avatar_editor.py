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

_DEFAULT_MANIFEST = "/assets/animation/player_anim/anim.json"
_IDENTITY = "（与逻辑名相同，不映射）"
_IDENTITY_DATA = ""

_LOGICAL_ROWS: tuple[tuple[str, str], ...] = (
    ("idle", "待机（Player 静止、剧情移动结束）"),
    ("walk", "行走（方向键移动，未按住奔跑）"),
    ("run", "奔跑（按住奔跑键）"),
)

_MANIFEST_RE = re.compile(r"^/assets/animation/([^/]+)/anim\.json$")


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
        self.setMinimumSize(520, 560)

        root = QVBoxLayout(self)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        inner = QWidget()
        lay = QVBoxLayout(inner)

        hint = QLabel(
            "逻辑状态名 <b>idle / walk / run</b> 由游戏代码固定（见 <code>Player.ts</code>）。"
            "此处选择动画包并为三态指定 <code>anim.json</code> 里 <code>states</code> 的键。"
            "<br/>事件中可用 Action：<b>setPlayerAvatar</b>（<code>animManifest</code> 或 <code>bundleId</code> +可选 <code>stateMap</code>）"
            "切换化身；<b>resetPlayerAvatar</b> 恢复为下方保存的默认（与 <code>game_config</code> 一致）。"
        )
        hint.setWordWrap(True)
        hint.setTextFormat(Qt.TextFormat.RichText)
        lay.addWidget(hint)

        pack_box = QGroupBox("动画包（anim.json）")
        pack_form = QFormLayout(pack_box)
        self._bundle_combo = QComboBox()
        self._bundle_combo.setMinimumWidth(280)
        self._bundle_combo.currentIndexChanged.connect(self._on_bundle_changed)
        pack_form.addRow("工程内动画包", self._bundle_combo)

        man_row = QHBoxLayout()
        self._manifest_edit = QLineEdit()
        self._manifest_edit.setPlaceholderText(_DEFAULT_MANIFEST)
        self._manifest_edit.setMinimumWidth(400)
        man_row.addWidget(self._manifest_edit, 1)
        reset_m = QPushButton("按包名填充路径")
        reset_m.setToolTip(f"写入 {_MANIFEST_RE.pattern} 形式的标准 URL")
        reset_m.clicked.connect(self._fill_manifest_from_bundle)
        man_row.addWidget(reset_m)
        pack_form.addRow("animManifest URL", man_row)

        lay.addWidget(pack_box)

        map_box = QGroupBox("逻辑状态 → clip（states 键）")
        map_form = QFormLayout(map_box)
        self._clip_combos: dict[str, QComboBox] = {}
        for logical, desc in _LOGICAL_ROWS:
            row = QHBoxLayout()
            lab = QLabel(f"<b>{logical}</b> — {desc}")
            lab.setWordWrap(True)
            lab.setTextFormat(Qt.TextFormat.RichText)
            row.addWidget(lab, 1)
            cb = QComboBox()
            cb.setMinimumWidth(220)
            self._clip_combos[logical] = cb
            row.addWidget(cb)
            w = QWidget()
            w.setLayout(row)
            map_form.addRow(w)
        lay.addWidget(map_box)

        btn_row = QHBoxLayout()
        apply_btn = QPushButton("写入 game_config（Apply）")
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

        self._model.data_changed.connect(self._on_model_changed)
        self._rebuild_bundle_combo()
        self._load_from_model()

    def flush_to_model(self) -> None:
        self._apply()

    def _on_model_changed(self, data_type: str, _item_id: str) -> None:
        if data_type in ("config", "animation", ""):
            self._rebuild_bundle_combo()
            self._load_from_model()

    def _reload_anims(self) -> None:
        self._model.reload_animations_from_disk()
        self._rebuild_bundle_combo()
        self._repopulate_clip_combos()
        self._status_message("已重载 public/assets/animation")

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
            self._manifest_edit.setText(f"/assets/animation/{bid}/anim.json")
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
        self._manifest_edit.setText(f"/assets/animation/{bid}/anim.json")

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

    def _apply(self) -> None:
        man = self._manifest_edit.text().strip() or _DEFAULT_MANIFEST
        state_map: dict[str, str] = {}
        for logical, cb in self._clip_combos.items():
            clip = str(cb.currentData() or "").strip()
            if clip and clip != _IDENTITY_DATA:
                state_map[logical] = clip

        pa: dict[str, Any] = {"animManifest": man}
        if state_map:
            pa["stateMap"] = state_map
        self._model.game_config["playerAvatar"] = pa
        self._model.mark_dirty("config")
        self._status_message("已更新 playerAvatar")
