"""气味 Profile 编辑器（方案 E）。

主从列表(profiles) + 详情表单(色/飘法/特殊渲染块) + QtWebEngine 实时预览。
预览跑的是和游戏 HUD **同一个** SmellIndicatorRenderer（β 严格一致），经
http://127.0.0.1:5173/smell_preview.html 的 window.__setProfiles / __setScent 注入。

数据体系（审查 P1-7 修复后）：
- 单一真相源 = ProjectModel.smell_profiles（load_project 载入的活引用），编辑即写模型
  并 mark_dirty("smell_profiles")，由主编辑器「全部保存」经 file_io.write_json 原子落盘。
- 编辑器自己不做任何文件 IO（旧版自读自写 + 读坏静默换空骨架 + 保存毁档的根因）。
- 写回只更新本面板管理的键，profile 上的未知键原样保留；未改动数值按原始表示回写。
"""
from __future__ import annotations

import json

from PySide6.QtCore import Qt, QUrl
from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QFormLayout, QInputDialog, QListWidget,
    QLineEdit, QDoubleSpinBox, QMessageBox, QSpinBox, QCheckBox, QGroupBox,
    QPushButton, QLabel, QSlider,
)

from ..shared import confirm
from ..shared.form_layout import compact_form
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

# 本面板管理的 profile 键（写回时只动这些；其余键原样保留）
_MANAGED_KEYS = (
    "name", "color", "rise", "sway", "swayFreq", "jitter", "heavy", "wrong", "special",
)


class SmellProfileEditor(QWidget):
    """气味 profile 主从编辑 + β 实时预览。"""

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._cur_id: str | None = None
        self._loading = False
        self._view = None
        self._build_ui()
        self.reload_refs_from_model()

    # ---------- model access ----------
    @property
    def _data(self) -> dict:
        d = getattr(self._model, "smell_profiles", None)
        if not isinstance(d, dict):
            d = {}
            try:
                self._model.smell_profiles = d
            except Exception:
                pass
        return d

    def _profiles(self) -> dict:
        return self._data.setdefault("profiles", {})

    def _mark_dirty(self) -> None:
        mk = getattr(self._model, "mark_dirty", None)
        if callable(mk):
            mk("smell_profiles")

    # ---------- UI ----------
    def _build_ui(self) -> None:
        root = QHBoxLayout(self)

        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget()
        self._list.setMaximumWidth(170)
        self._list.currentItemChanged.connect(self._on_select)
        lv.addWidget(self._list)
        btn_row = QHBoxLayout()
        b_add = QPushButton("＋")
        b_add.setToolTip("新增气味 profile")
        b_add.setFixedWidth(28)
        b_add.clicked.connect(self._add_profile)
        b_ren = QPushButton("改名")
        b_ren.setToolTip(
            "重命名 profile id。\n注意：引用该 id 的 zone.smell.scent / setSmell 不会自动改，"
            "改完请跑数据校验确认无悬垂引用。",
        )
        b_ren.clicked.connect(self._rename_profile)
        b_del = QPushButton("－")
        b_del.setToolTip("删除选中 profile")
        b_del.setFixedWidth(28)
        b_del.clicked.connect(self._delete_profile)
        btn_row.addWidget(b_add)
        btn_row.addWidget(b_ren)
        btn_row.addWidget(b_del)
        btn_row.addStretch(1)
        lv.addLayout(btn_row)
        root.addWidget(left)

        form_host = QWidget()
        fl = QVBoxLayout(form_host)
        f = compact_form(QFormLayout())
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
        sg = compact_form(QFormLayout(self._special))
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

        hint = QLabel("改动随主编辑器「全部保存」(Ctrl+S) 写入 smell_profiles.json")
        hint.setStyleSheet("color: #888;")
        fl.addWidget(hint)
        fl.addStretch(1)
        root.addWidget(form_host, 1)

        prev_host = QWidget()
        pv = QVBoxLayout(prev_host)
        prev_lbl = QLabel("实时预览（β·与游戏同一渲染器）")
        prev_lbl.setToolTip("预览需游戏 dev server 在跑（F5 启动，5173 端口）")
        pv.addWidget(prev_lbl)
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
        sniff.setToolTip("预览需游戏 dev server 在跑（5173）")
        sniff.clicked.connect(self._preview_sniff)
        pv.addWidget(sniff)
        pv.addStretch(1)
        root.addWidget(prev_host)

    # ---------- data ----------
    def reload_refs_from_model(self) -> None:
        """从模型重建 profile 列表（保持当前选中）。主窗口切页/开工程后调用。"""
        cur = self._cur_id
        self._list.blockSignals(True)
        self._list.clear()
        for pid in self._profiles():
            self._list.addItem(pid)
        self._list.blockSignals(False)
        if cur:
            for i in range(self._list.count()):
                if self._list.item(i).text() == cur:
                    self._list.setCurrentRow(i)
                    return
        self._cur_id = None
        if self._list.count():
            self._list.setCurrentRow(0)

    def _on_select(self, cur, _prev) -> None:
        if cur is None:
            self._cur_id = None
            return
        pid = cur.text()
        self._cur_id = pid
        p = self._profiles().get(pid, {})
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

    @staticmethod
    def _keep_numeric_repr(new_val: float, old_val: object) -> object:
        """未改动的数值按原始 int/float 表示回写（1 不漂成 1.0）。"""
        if (
            isinstance(old_val, (int, float))
            and not isinstance(old_val, bool)
            and float(old_val) == float(new_val)
        ):
            return old_val
        return new_val

    def _on_change(self, *_args) -> None:
        if self._loading or self._cur_id is None:
            return
        profiles = self._profiles()
        old = profiles.get(self._cur_id)
        old = old if isinstance(old, dict) else {}
        # 未知键原样保留，只重写本面板管理的键
        p: dict = {k: v for k, v in old.items()}
        for k in _MANAGED_KEYS:
            p.pop(k, None)
        managed: dict = {}
        nm = self._name.text().strip()
        if nm:
            managed["name"] = nm
        managed["color"] = self._color.hex()
        for k, sp in self._spins.items():
            managed[k] = self._keep_numeric_repr(round(sp.value(), 3), old.get(k))
        if self._heavy.isChecked():
            managed["heavy"] = True
        if self._wrong.isChecked():
            managed["wrong"] = True
        if self._special.isChecked():
            old_sp = old.get("special") if isinstance(old.get("special"), dict) else {}
            sp_block: dict = {
                k: v for k, v in old_sp.items()
                if k not in ("glow", "coil", "reach", "baselineShudder", "envelope")
            }
            if self._glow.isChecked():
                sp_block["glow"] = True
            if self._coil.isChecked():
                sp_block["coil"] = True
            if self._reach.isChecked():
                sp_block["reach"] = True
            if self._shudder.isChecked():
                sp_block["baselineShudder"] = True
            old_env = old_sp.get("envelope") if isinstance(old_sp.get("envelope"), dict) else {}
            sp_block["envelope"] = {
                "attackMs": self._keep_numeric_repr(int(self._env["attackMs"].value()), old_env.get("attackMs")),
                "holdMs": self._keep_numeric_repr(int(self._env["holdMs"].value()), old_env.get("holdMs")),
                "decayMs": self._keep_numeric_repr(int(self._env["decayMs"].value()), old_env.get("decayMs")),
                "peak": self._keep_numeric_repr(round(float(self._env["peak"].value()), 3), old_env.get("peak")),
            }
            managed["special"] = sp_block
        # 按原键序合并：old 里已有的管理键保持原位置更新，新增的追加在尾部
        merged: dict = {}
        for k, v in old.items():
            if k in managed:
                merged[k] = managed.pop(k)
            elif k in _MANAGED_KEYS:
                continue  # 被取消勾选的管理键（heavy/wrong/special/name 空）→ 删除
            else:
                merged[k] = v
        merged.update(managed)
        if merged == old:
            return  # 无实质变化：不写不标脏
        profiles[self._cur_id] = merged
        self._mark_dirty()
        self._push_preview()

    # ---------- CRUD ----------
    def _add_profile(self) -> None:
        pid, ok = QInputDialog.getText(self, "新增气味 Profile", "profile id（如 xiangfen）:")
        pid = (pid or "").strip()
        if not ok or not pid:
            return
        profiles = self._profiles()
        if pid in profiles:
            QMessageBox.warning(self, "新增气味 Profile", f"id「{pid}」已存在。")
            return
        profiles[pid] = {
            "name": pid, "color": "#cccccc",
            "rise": 1.0, "sway": 0.5, "swayFreq": 1.0, "jitter": 0.2,
        }
        self._mark_dirty()
        self.reload_refs_from_model()
        for i in range(self._list.count()):
            if self._list.item(i).text() == pid:
                self._list.setCurrentRow(i)
                break

    def _rename_profile(self) -> None:
        if not self._cur_id:
            return
        old_id = self._cur_id
        new_id, ok = QInputDialog.getText(
            self, "重命名气味 Profile",
            f"「{old_id}」的新 id：\n（引用不会自动更新，改完请跑数据校验）",
            text=old_id,
        )
        new_id = (new_id or "").strip()
        if not ok or not new_id or new_id == old_id:
            return
        profiles = self._profiles()
        if new_id in profiles:
            QMessageBox.warning(self, "重命名", f"id「{new_id}」已存在。")
            return
        # 保持键序原位改名
        rebuilt = {}
        for k, v in profiles.items():
            rebuilt[new_id if k == old_id else k] = v
        profiles.clear()
        profiles.update(rebuilt)
        self._cur_id = new_id
        self._mark_dirty()
        self.reload_refs_from_model()

    def _delete_profile(self) -> None:
        if not self._cur_id:
            return
        if not confirm.confirm_delete(self, f"气味 profile「{self._cur_id}」"):
            return
        self._profiles().pop(self._cur_id, None)
        self._cur_id = None
        self._mark_dirty()
        self.reload_refs_from_model()

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
