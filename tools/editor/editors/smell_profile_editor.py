"""气味 Profile 编辑器（方案 E）。

主从列表(profiles) + 详情表单(色/飘法/特殊渲染块) + QtWebEngine 实时预览。
预览跑的是和游戏 HUD **同一个** SmellIndicatorRenderer（β 严格一致），经
http://127.0.0.1:5173/smell_preview.html 的 window.__setProfiles / __setScent 注入。
数据：public/assets/data/smell_profiles.json（保存守往返格式契约）。
"""
from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import Qt, QUrl
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QFormLayout, QListWidget, QLineEdit,
    QDoubleSpinBox, QSpinBox, QCheckBox, QGroupBox, QPushButton, QLabel, QSlider,
)

from ..shared.hex_color_pick_row import HexColorPickRow

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from ..web_engine_page import QuietWebEnginePage
except ImportError:  # pragma: no cover
    QWebEngineView = None  # type: ignore[assignment,misc]
    QuietWebEnginePage = None  # type: ignore[assignment,misc]

PREVIEW_URL = "http://127.0.0.1:5173/smell_preview.html"
NUMERIC = [
    ("rise", "上升 rise"), ("sway", "摆幅 sway"),
    ("swayFreq", "摆频 swayFreq"), ("jitter", "抖动 jitter"),
]


class SmellProfileEditor(QWidget):
    """气味 profile 主从编辑 + β 实时预览。"""

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._path = self._resolve_path(model)
        self._data: dict = {}
        self._cur_id: str | None = None
        self._loading = False
        self._view = None
        self._build_ui()
        self._load()

    @staticmethod
    def _resolve_path(model) -> Path:
        assets = getattr(model, "assets_path", None) or "public/assets"
        return Path(assets) / "data" / "smell_profiles.json"

    # ---------- UI ----------
    def _build_ui(self) -> None:
        root = QHBoxLayout(self)

        self._list = QListWidget()
        self._list.setMaximumWidth(150)
        self._list.currentItemChanged.connect(self._on_select)
        root.addWidget(self._list)

        form_host = QWidget()
        fl = QVBoxLayout(form_host)
        f = QFormLayout()
        self._name = QLineEdit()
        self._name.textChanged.connect(self._on_change)
        f.addRow("名 name", self._name)
        self._color = HexColorPickRow("#cccccc")
        self._color.changed.connect(self._on_change)
        f.addRow("颜色 color", self._color)
        self._spins: dict[str, QDoubleSpinBox] = {}
        for key, label in NUMERIC:
            sp = QDoubleSpinBox()
            sp.setRange(0.0, 10.0)
            sp.setSingleStep(0.05)
            sp.setDecimals(2)
            sp.valueChanged.connect(self._on_change)
            self._spins[key] = sp
            f.addRow(label, sp)
        self._heavy = QCheckBox("沉·贴地(heavy)")
        self._wrong = QCheckBox("飘得不对劲(wrong)")
        self._heavy.toggled.connect(self._on_change)
        self._wrong.toggled.connect(self._on_change)
        f.addRow("", self._heavy)
        f.addRow("", self._wrong)
        fl.addLayout(f)

        self._special = QGroupBox("特殊渲染（香粉发亮 / 包络）")
        self._special.setCheckable(True)
        self._special.setChecked(False)
        self._special.toggled.connect(self._on_change)
        sg = QFormLayout(self._special)
        self._glow = QCheckBox("自体发亮(glow·add 混合)")
        self._coil = QCheckBox("盘卷不散(coil)")
        self._reach = QCheckBox("几缕逆着往下够(reach)")
        self._shudder = QCheckBox("基线被照亮发抖(baselineShudder)")
        for c in (self._glow, self._coil, self._reach, self._shudder):
            c.toggled.connect(self._on_change)
            sg.addRow("", c)
        self._env: dict[str, QSpinBox | QDoubleSpinBox] = {}
        for key, label, rng in [
            ("attackMs", "攻击 attack(ms)", (0, 5000)),
            ("holdMs", "停留 hold(ms)", (0, 8000)),
            ("decayMs", "衰减 decay(ms)", (0, 20000)),
        ]:
            sp = QSpinBox()
            sp.setRange(*rng)
            sp.valueChanged.connect(self._on_change)
            self._env[key] = sp
            sg.addRow(label, sp)
        pk = QDoubleSpinBox()
        pk.setRange(0.0, 2.0)
        pk.setSingleStep(0.05)
        pk.setDecimals(2)
        pk.valueChanged.connect(self._on_change)
        self._env["peak"] = pk
        sg.addRow("峰值 peak", pk)
        fl.addWidget(self._special)

        save = QPushButton("保存 smell_profiles.json")
        save.clicked.connect(self._save)
        fl.addWidget(save)
        fl.addStretch(1)
        root.addWidget(form_host, 1)

        prev_host = QWidget()
        pv = QVBoxLayout(prev_host)
        pv.addWidget(QLabel("实时预览（β·与游戏同一渲染器）"))
        if QWebEngineView is not None:
            try:
                view = QWebEngineView(self)
                if QuietWebEnginePage is not None:
                    view.setPage(QuietWebEnginePage(view))
                view.setMinimumSize(270, 230)
                view.load(QUrl(PREVIEW_URL))
                view.loadFinished.connect(lambda _ok: self._push_preview())
                self._view = view
                pv.addWidget(view)
            except Exception:  # pragma: no cover
                self._view = None
                pv.addWidget(QLabel("（QtWebEngine 初始化失败，预览不可用）"))
        else:
            pv.addWidget(QLabel("（QtWebEngine 不可用，预览不可用；游戏内为准）"))
        pv.addWidget(QLabel("预览强度 intensity"))
        self._intensity = QSlider(Qt.Orientation.Horizontal)
        self._intensity.setRange(0, 100)
        self._intensity.setValue(85)
        self._intensity.valueChanged.connect(lambda _v: self._push_preview())
        pv.addWidget(self._intensity)
        sniff = QPushButton("嗅一下（脉冲）")
        sniff.clicked.connect(self._preview_sniff)
        pv.addWidget(sniff)
        pv.addWidget(QLabel("提示：预览需游戏 dev server 在跑（5173）"))
        pv.addStretch(1)
        root.addWidget(prev_host)

    # ---------- data ----------
    def _load(self) -> None:
        try:
            self._data = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            self._data = {
                "baseline": {"color": "#969aa2", "breatheFreq": 0.9},
                "transition": {"fadeMs": 800},
                "profiles": {},
            }
        self._list.clear()
        for pid in self._data.get("profiles", {}):
            self._list.addItem(pid)
        if self._list.count():
            self._list.setCurrentRow(0)

    def _on_select(self, cur, _prev) -> None:
        if cur is None:
            return
        pid = cur.text()
        self._cur_id = pid
        p = self._data.get("profiles", {}).get(pid, {})
        self._loading = True
        self._name.setText(str(p.get("name", "")))
        self._color.set_hex(str(p.get("color", "#cccccc")))
        for k, sp in self._spins.items():
            sp.setValue(float(p.get(k, 0) or 0))
        self._heavy.setChecked(bool(p.get("heavy")))
        self._wrong.setChecked(bool(p.get("wrong")))
        sp_block = p.get("special") or {}
        self._special.setChecked(bool(p.get("special")))
        self._glow.setChecked(bool(sp_block.get("glow")))
        self._coil.setChecked(bool(sp_block.get("coil")))
        self._reach.setChecked(bool(sp_block.get("reach")))
        self._shudder.setChecked(bool(sp_block.get("baselineShudder")))
        env = sp_block.get("envelope", {}) or {}
        self._env["attackMs"].setValue(int(env.get("attackMs", 150)))
        self._env["holdMs"].setValue(int(env.get("holdMs", 800)))
        self._env["decayMs"].setValue(int(env.get("decayMs", 4000)))
        self._env["peak"].setValue(float(env.get("peak", 1.0)))
        self._loading = False
        self._push_preview()

    def _on_change(self, *_args) -> None:
        if self._loading or self._cur_id is None:
            return
        p: dict = {}
        nm = self._name.text().strip()
        if nm:
            p["name"] = nm
        p["color"] = self._color.hex()
        for k, sp in self._spins.items():
            p[k] = round(sp.value(), 3)
        if self._heavy.isChecked():
            p["heavy"] = True
        if self._wrong.isChecked():
            p["wrong"] = True
        if self._special.isChecked():
            sp_block: dict = {}
            if self._glow.isChecked():
                sp_block["glow"] = True
            if self._coil.isChecked():
                sp_block["coil"] = True
            if self._reach.isChecked():
                sp_block["reach"] = True
            if self._shudder.isChecked():
                sp_block["baselineShudder"] = True
            sp_block["envelope"] = {
                "attackMs": int(self._env["attackMs"].value()),
                "holdMs": int(self._env["holdMs"].value()),
                "decayMs": int(self._env["decayMs"].value()),
                "peak": round(float(self._env["peak"].value()), 3),
            }
            p["special"] = sp_block
        self._data.setdefault("profiles", {})[self._cur_id] = p
        self._push_preview()

    # ---------- preview (β) ----------
    def _push_preview(self) -> None:
        if self._view is None:
            return
        try:
            payload = json.dumps(self._data, ensure_ascii=False)
            sid = json.dumps(self._cur_id or "")
            js = (
                f"window.__setProfiles && window.__setProfiles({payload});"
                f"window.__setScent && window.__setScent({sid}, {int(self._intensity.value())});"
            )
            self._view.page().runJavaScript(js)
        except Exception:  # pragma: no cover
            pass

    def _preview_sniff(self) -> None:
        if self._view is not None:
            self._view.page().runJavaScript("window.__sniff && window.__sniff();")

    # ---------- save ----------
    def _save(self) -> None:
        text = json.dumps(self._data, ensure_ascii=False, indent=2) + "\n"
        self._path.write_text(text, encoding="utf-8")
