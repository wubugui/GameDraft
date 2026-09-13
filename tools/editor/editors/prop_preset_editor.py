"""挂件预设：prop_presets.json，供 attachToSocket 的 prop 参数引用。

**这一页存在的理由**：支点（刀柄在贴图哪儿）/自转（图画歪了多少）/缩放
描述的是**挂件自己**——同一把桃木剑，不管挂谁的手、哪个场景，刀柄永远在同一处。
把它们写在每个 attachToSocket 调用点上，既要重敲又必然发散（五处挂剑迟早有一处不一样）。
所以：这里登记一次，动作只写 `prop: "taomu_jian"`。

手持光源（2026-09-12）按**同一个理由**扩到这里：一支点着的火把不只是一张图，
它还带一盏跟着手走的灯、一团火焰粒子、一串状态（点着 / 护火 / 残炭 / 灭）——
这些同样是火把**自己**的属性，不是调用点的属性。于是本页多出四块：

- `light` 自带光源（挂上就有、卸下就没，每帧跟着挂点走）；
- `vfx` 自带效果（效果资产 id；火焰的**声音住在效果资产自己的 `sound.loop`** 里，
  本表刻意**不开音频字段**——开了就是第二个真相源）；
- `persistent` 手持物（玩法事实，入档、跨场景自动重挂）；
- `states` + `defaultState` 状态表（每个状态覆盖上面这些块）。

骨架照主从列表样板（`_refresh` / `_on_select` / `_apply`），右侧详情分组
（基本 / 摆放 / 自带效果 / 自带光源 / 状态表 / 试挂预览）。**光源块与状态表默认折叠
且懒建**（布局纪律：重块首次展开才造控件；没展开过的块原样透传磁盘值）。
控件本体在 `prop_preset_blocks.py`——`light` 那张表单在基础块与每个状态里各出现一次，
写两遍必然发散。试挂预览与运行时同一套位姿数学，见 `prop_tryon_canvas`。
"""
from __future__ import annotations

import copy
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared.anim_atlas_preview import crop_atlas_cell
from ..shared.animation_sockets import (
    load_socket_set,
    sockets_path_for_bundle,
)
from ..shared.form_layout import compact_form
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.prop_preset_refs import rename_prop_references, scan_prop_usages
from ..shared.prop_tryon_canvas import PropTryOnCanvas
from ..shared.socket_image_list import SocketImageListField
from .prop_preset_blocks import (
    PropLightBlock,
    PropStatesEditor,
    VfxIdListField,
    reorder_like,
)

#: 摆放字段的运行时缺省（与 SpriteEntity.syncAttachments / propPresets.ts 一致）
DEFAULTS: dict[str, float] = {"anchorX": 0.5, "anchorY": 0.5, "rotation": 0.0, "scale": 1.0}


def _num(entry: dict, key: str) -> float:
    try:
        v = float(entry.get(key, DEFAULTS[key]))
    except (TypeError, ValueError):
        return DEFAULTS[key]
    return v if v == v else DEFAULTS[key]  # NaN → 缺省


class PropPresetEditor(QWidget):
    """维护 public/assets/data/prop_presets.json。"""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._data: dict[str, dict] = {}
        self._current: str = ""
        self._loading = False
        self._dirty = False
        #: 试挂用的动画包挂点数据（选包时按需读盘，不进模型）
        self._sockets: dict[str, Any] = {}
        self._atlas: QPixmap | None = None
        self._prop_pix: QPixmap | None = None

        root = QVBoxLayout(self)
        hint = QLabel("登记挂件的贴图 + 支点 + 自转 + 缩放；动作里 attachToSocket 只写 prop 引用它。")
        hint.setToolTip(
            "挂点标注（动画编辑器里逐帧标的）管「手在哪、手转到什么角度」；\n"
            "这一页管「这张贴图的哪个点算被握住的地方、图本身画歪了多少、多大」。\n"
            "两者职责不同：换把刀不用重标挂点，只改这里三个数。")
        root.addWidget(hint)
        self._status = QLabel("")
        self._status.setWordWrap(True)
        root.addWidget(self._status)

        split = QSplitter(Qt.Orientation.Horizontal, self)
        root.addWidget(split, stretch=1)

        # ---- 左：挂件列表 ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget()
        self._list.currentTextChanged.connect(self._on_select)
        ll.addWidget(self._list, stretch=1)
        btns = QHBoxLayout()
        for text, tip, slot in (
            ("新建", "新增一个挂件预设（自己起 id，全表唯一）", self._on_new),
            ("改名", "改 id，并把全工程 attachToSocket.prop 的引用一起改过去", self._on_rename),
            ("删除", "删除该预设；仍被引用时先给出引用清单再确认", self._on_delete),
        ):
            b = QPushButton(text)
            b.setToolTip(tip)
            b.clicked.connect(slot)
            btns.addWidget(b)
        ll.addLayout(btns)
        left.setMaximumWidth(240)
        split.addWidget(left)

        # ---- 右：详情（表单 | 预览 左右并排）----
        # 并排而不是上下：调支点/自转/缩放全靠盯着预览拖滑条，
        # 上下摆会逼人来回滚动，等于把这页唯一的价值弄没了。
        detail = QWidget()
        dl = QHBoxLayout(detail)
        dl.setContentsMargins(0, 0, 0, 0)
        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        right = QWidget()
        rl = QVBoxLayout(right)
        right_scroll.setWidget(right)
        dl.addWidget(right_scroll, stretch=1)
        split.addWidget(detail)
        split.setStretchFactor(1, 1)

        basic = QGroupBox("基本")
        bf = compact_form(QFormLayout(basic))
        self._id_label = QLabel("")
        bf.addRow("id", self._id_label)
        self._label_edit = QLineEdit()
        self._label_edit.setMaximumWidth(220)
        self._label_edit.setPlaceholderText("如：桃木剑")
        self._label_edit.setToolTip("只给编辑器列表看的人类名字，运行时不用")
        self._label_edit.textChanged.connect(self._on_field_changed)
        bf.addRow("显示名", self._label_edit)
        self._image_row = CutsceneImagePathRow(
            model, "", external_copy_subdir="props",
            external_copy_hint="项目外图片会复制到 resources/runtime/images/props/",
        )
        self._image_row.changed.connect(self._on_field_changed)
        self._image_row.setToolTip("单张贴图＝静态挂件。多帧挂件用下面的帧列表。")
        bf.addRow("贴图", self._image_row)
        self._images_field = SocketImageListField(model, [], self)
        self._images_field.changed.connect(self._on_field_changed)
        self._images_field.setToolTip(
            "多帧贴图：挂点标注里的 frame 选第几张（顺序即帧号）。\n"
            "不引入第二个时钟——跟着角色的帧走，所以没有锁相问题。")
        bf.addRow("帧贴图", self._images_field)
        rl.addWidget(basic)

        place = QGroupBox("摆放")
        pf = compact_form(QFormLayout(place))
        self._spins: dict[str, QDoubleSpinBox] = {}
        self._sliders: dict[str, QSlider] = {}
        for key, label, lo, hi, step, tip in (
            ("anchorX", "支点 x", 0.0, 1.0, 0.01,
             "贴图上的支点：0=左边缘，1=右边缘，0.5=图心。挂点对准的就是这一点。"),
            ("anchorY", "支点 y", 0.0, 1.0, 0.01,
             "贴图上的支点：0=上边缘，1=下边缘。刀给刀柄、灯笼给提环。"),
            ("rotation", "自转", -360.0, 360.0, 1.0,
             "补贴图画的时候的朝向（度）；叠加在挂点标注角度之上，镜像时一起取反。"),
            ("scale", "缩放", 0.0, 100.0, 0.05,
             "相对角色的大小；贴图 1 像素 = 1 世界单位时为 1。"),
        ):
            row = QWidget()
            hl = QHBoxLayout(row)
            hl.setContentsMargins(0, 0, 0, 0)
            spin = QDoubleSpinBox()
            spin.setRange(lo, hi)
            spin.setSingleStep(step)
            spin.setDecimals(4 if key.startswith("anchor") else 2)
            spin.setMaximumWidth(96)
            spin.setToolTip(tip)
            spin.valueChanged.connect(lambda _v, k=key: self._on_spin_changed(k))
            hl.addWidget(spin)
            sld = QSlider(Qt.Orientation.Horizontal)
            sld.setRange(int(lo * 100), int(hi * 100))
            sld.setMaximumWidth(220)
            sld.setToolTip(tip + "\n拖滑条边看预览边调，比敲数字快。")
            sld.valueChanged.connect(lambda v, k=key: self._on_slider_changed(k, v))
            hl.addWidget(sld)
            self._spins[key] = spin
            self._sliders[key] = sld
            pf.addRow(label, row)
        self._lit = QCheckBox("吃场景光照")
        self._lit.setChecked(True)
        self._lit.setToolTip(
            "勾上＝与角色走同一条逐像素光照（缺省）。\n"
            "自发光的东西（灯笼火苗、符纸微光）取消勾选，避免被暗环境压黑。")
        self._lit.toggled.connect(self._on_field_changed)
        pf.addRow("光照", self._lit)
        self._persistent = QCheckBox("手持物（入档、跨场景自动重挂）")
        self._persistent.setToolTip(
            "勾上＝这是**玩法事实**：存进档、切场景自动重挂（手里的火把）。\n"
            "不勾（缺省）＝演出挂件，切场景即散（与既有行为一致）。\n"
            "⚠ 只有勾了这个的挂件，setPropState 切出来的状态才会跟着存档走。")
        self._persistent.toggled.connect(self._on_field_changed)
        pf.addRow("持久化", self._persistent)
        rl.addWidget(place)

        vfx_box = QGroupBox("自带效果")
        vf = compact_form(QFormLayout(vfx_box))
        self._vfx_field = VfxIdListField(model, [], self)
        self._vfx_field.changed.connect(self._on_field_changed)
        self._vfx_field.setToolTip(
            "挂上就一起放的效果资产（火焰、火星…），候选来自 assets/data/vfx/*.json。\n"
            "⚠ 火焰的**声音住在效果资产自己的 sound.loop 里**（那条本来就从发射器原点空间播、\n"
            "跟着锚点走），所以本页刻意没有音频字段——开了就是第二个真相源。")
        vf.addRow("效果", self._vfx_field)
        rl.addWidget(vfx_box)

        # 重块：默认折叠 + 懒建（布局纪律）。没展开过的块 dump() 原样回吐磁盘值。
        # 只接 `changed` 信号，不再另传 on_changed 回调——两条都接会让一次编辑走两遍。
        self._light_block = PropLightBlock(None, self)
        self._light_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._light_block)
        self._states_editor = PropStatesEditor(model, None, self)
        self._states_editor.changed.connect(self._on_block_changed)
        rl.addWidget(self._states_editor)

        tryon = QGroupBox("试挂预览")
        tf = QVBoxLayout(tryon)
        pick = QWidget()
        pk = compact_form(QFormLayout(pick))

        def _sized(combo: QComboBox) -> QComboBox:
            """下拉一律按内容自适应：默认策略只在首次显示时量一次，
            而这几个下拉那时还是空的，量出来就是个装不下 id 的窄条。"""
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
            return combo

        self._bundle_combo = _sized(QComboBox())
        self._bundle_combo.setMaximumWidth(220)
        self._bundle_combo.setToolTip("挂到哪个动画包上试；列表是工程里已有挂点标注的包。")
        self._bundle_combo.currentTextChanged.connect(self._on_bundle_changed)
        pk.addRow("动画包", self._bundle_combo)
        self._socket_combo = _sized(QComboBox())
        self._socket_combo.setMaximumWidth(220)
        self._socket_combo.setToolTip("挂到哪个挂点上；列表来自该包的 sockets.json。")
        self._socket_combo.currentTextChanged.connect(self._refresh_preview)
        pk.addRow("挂点", self._socket_combo)
        self._slot_combo = _sized(QComboBox())
        self._slot_combo.setMaximumWidth(220)
        self._slot_combo.setToolTip("看哪一帧；只列该挂点标注过的图集槽位。")
        self._slot_combo.currentTextChanged.connect(self._refresh_preview)
        pk.addRow("帧", self._slot_combo)
        self._facing = _sized(QComboBox())
        self._facing.addItems(["朝右", "朝左（验镜像）"])
        self._facing.setMaximumWidth(220)
        self._facing.setToolTip("切朝左看镜像对不对：支点该翻到另一侧、角度与自转一起取反。")
        self._facing.currentIndexChanged.connect(self._refresh_preview)
        pk.addRow("朝向", self._facing)
        self._state_combo = _sized(QComboBox())
        self._state_combo.setMaximumWidth(220)
        self._state_combo.setToolTip(
            "按哪个状态预览：切过去就看到该状态的贴图与摆放（状态里没写的项沿用基础块，\n"
            "合并口径与运行时 `resolvePropAttach` 一致）。\n"
            "「基础块」＝没有状态表时的样子。")
        self._state_combo.currentIndexChanged.connect(self._on_preview_state_changed)
        pk.addRow("状态", self._state_combo)
        tf.addWidget(pick)
        self._canvas = PropTryOnCanvas()
        tf.addWidget(self._canvas, stretch=1)
        tryon.setMaximumWidth(380)
        dl.addWidget(tryon)
        rl.addStretch()

        actions = QHBoxLayout()
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("写入内存并标脏；保存工程（Ctrl+S）时写入 prop_presets.json")
        apply_btn.clicked.connect(self._apply)
        reload_btn = QPushButton("从内存重载")
        reload_btn.setToolTip("丢弃本页未 Apply 的改动，按 ProjectModel.prop_presets 重填")
        reload_btn.clicked.connect(self._reload_from_model)
        actions.addWidget(apply_btn)
        actions.addWidget(reload_btn)
        actions.addStretch()
        root.addLayout(actions)

        self._reload_from_model()
        self._fill_bundles()

    # ---- 数据 --------------------------------------------------------

    def _reload_from_model(self) -> None:
        raw = getattr(self._model, "prop_presets", None)
        self._data = copy.deepcopy(raw) if isinstance(raw, dict) else {}
        self._dirty = False
        self._refresh(keep=self._current)
        self._status.setText("")

    def _refresh(self, keep: str = "") -> None:
        self._loading = True
        try:
            self._list.clear()
            for key in self._data:
                self._list.addItem(str(key))
        finally:
            self._loading = False
        if keep and keep in self._data:
            items = self._list.findItems(keep, Qt.MatchFlag.MatchExactly)
            if items:
                self._list.setCurrentItem(items[0])
                return
        if self._list.count() > 0:
            self._list.setCurrentRow(0)
        else:
            self._current = ""
            self._on_select("")

    def _entry(self) -> dict:
        e = self._data.get(self._current)
        return e if isinstance(e, dict) else {}

    def _on_select(self, key: str) -> None:
        self._current = str(key or "")
        entry = self._entry()
        self._loading = True
        try:
            self._id_label.setText(self._current or "（无选中）")
            self._label_edit.setText(str(entry.get("label", "") or ""))
            self._label_edit.setCursorPosition(0)  # 光标停末尾会只露出名字尾巴
            self._image_row.set_path(str(entry.get("image", "") or ""))
            imgs = entry.get("images")
            self._images_field.set_paths(imgs if isinstance(imgs, list) else [])
            for k, spin in self._spins.items():
                v = _num(entry, k)
                spin.setValue(v)
                self._sliders[k].setValue(int(round(v * 100)))
            self._lit.setChecked(entry.get("lit") is not False)
            self._persistent.setChecked(entry.get("persistent") is True)
            self._vfx_field.set_ids(entry.get("vfx"))
            self._light_block.set_socket_items(self._socket_items())
            self._light_block.set_data(entry.get("light"))
            self._states_editor.set_socket_items(self._socket_items())
            self._states_editor.set_data(entry.get("states"), entry.get("defaultState"))
        finally:
            self._loading = False
        self._refresh_state_combo()
        self._load_prop_pixmap()
        self._refresh_preview()

    def _socket_items(self) -> list[tuple[str, str]]:
        """灯挂点的候选：当前试挂动画包 sockets.json 里标过的挂点。

        挂件预设本身与动画包无关（同一把刀能挂任何角色），所以这里没有"唯一正确"的候选面；
        取当前试挂的那个包是**能给出候选的唯一口径**，取不到就允许手打（控件 editable）。
        """
        return [(name, name) for name in sorted(self._sockets)]

    def _on_field_changed(self) -> None:
        if self._loading:
            return
        self._dirty = True
        self._load_prop_pixmap()
        self._refresh_preview()

    def _on_block_changed(self) -> None:
        """光源块 / 状态表里改了东西：状态下拉要跟着变，其余与普通字段同。"""
        if self._loading:
            return
        self._refresh_state_combo()
        self._on_field_changed()

    def _refresh_state_combo(self) -> None:
        """试挂预览的状态下拉。当前选择尽量保留（改一个状态名不该把预览跳回基础块）。"""
        names = self._states_editor.state_names()
        cur = str(self._state_combo.currentData() or "")
        was = self._loading
        self._loading = True
        try:
            self._state_combo.clear()
            self._state_combo.addItem("基础块（没有状态表时的样子）", "")
            for n in names:
                self._state_combo.addItem(n, n)
            idx = self._state_combo.findData(cur) if cur else 0
            self._state_combo.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            self._loading = was

    def _on_preview_state_changed(self, *_a: object) -> None:
        """切预览状态**不是**数据改动——绝不标脏（打开即脏是红线）。"""
        if self._loading:
            return
        self._load_prop_pixmap()
        self._refresh_preview()

    def _preview_state(self) -> dict:
        """当前预览选的那个状态的暂存值（空 dict = 按基础块预览）。"""
        name = str(self._state_combo.currentData() or "")
        return self._states_editor.state_data(name) if name else {}

    def _on_spin_changed(self, key: str) -> None:
        if self._loading:
            return
        self._loading = True
        try:
            self._sliders[key].setValue(int(round(self._spins[key].value() * 100)))
        finally:
            self._loading = False
        self._dirty = True
        self._refresh_preview()

    def _on_slider_changed(self, key: str, value: int) -> None:
        if self._loading:
            return
        self._loading = True
        try:
            self._spins[key].setValue(value / 100.0)
        finally:
            self._loading = False
        self._dirty = True
        self._refresh_preview()

    def _collect(self) -> dict:
        """当前表单 → 一条预设。

        缺省值**原本没有该键时**才不落键——写死"等于缺省就删"会让磁盘上显式写着
        `rotation: 0` 的条目一打开就被抹掉，违反"打开→不动→保存 输出与磁盘等价"。
        """
        original = self._entry()
        out: dict[str, Any] = {}
        label = self._label_edit.text().strip()
        if label:
            out["label"] = label
        image = self._image_row.path().strip()
        if image:
            out["image"] = image
        images = self._images_field.to_list()
        if images:
            out["images"] = images
        for k, spin in self._spins.items():
            v = round(float(spin.value()), 4)
            if v != DEFAULTS[k] or k in original:
                out[k] = v
        if not self._lit.isChecked() or "lit" in original:
            out["lit"] = self._lit.isChecked()
        # 自带光源：None = 不写 `light` 键（没展开过的折叠块原样回吐磁盘值）
        light = self._light_block.dump()
        if isinstance(light, dict):
            out["light"] = light
        # 自带效果：空列表**原本没有该键时**才不落键（磁盘上写着 `vfx: []` 的要原样保住）
        vfx = self._vfx_field.to_list()
        if vfx or "vfx" in original:
            out["vfx"] = vfx
        # 手持物：运行时只认 `=== true`，但磁盘上显式写着 false 的要保住
        if self._persistent.isChecked() or "persistent" in original:
            out["persistent"] = self._persistent.isChecked()
        states, default_state = self._states_editor.dump()
        if isinstance(states, dict) and states:
            out["states"] = states
        if default_state:
            out["defaultState"] = default_state
        # 数值表示保真：磁盘上的 `rotation: 0`(int) 不得因为过了一趟 QDoubleSpinBox
        # 就漂成 `0.0`(float)——那是纯格式噪音，会把无关改动混进 diff。
        return preserve_numeric_repr(out, original)

    #: `_collect` 负责产出的键。其余键（将来给 PropPresetDef 加字段）原样透传。
    _MANAGED_KEYS = (
        "label", "image", "images", "anchorX", "anchorY", "rotation", "scale", "lit",
        "light", "vfx", "persistent", "states", "defaultState",
    )

    def _staged(self) -> dict[str, dict]:
        """把当前表单并回 _data 的一份拷贝（未知键透传）。"""
        data = copy.deepcopy(self._data)
        if self._current:
            original = data.get(self._current) or {}
            merged = dict(original)
            for k in self._MANAGED_KEYS:
                merged.pop(k, None)
            merged.update(self._collect())
            # 键序按磁盘原序：原有键回原位置，只有新增键才追加（numeric-roundtrip 契约 4）。
            # 不重排的话，一打开旧条目就把 label/image/… 整批挪到末尾 = 往返改字节。
            data[self._current] = reorder_like(merged, original)
        return data

    def _apply(self) -> None:
        data = self._staged()
        self._data = data
        if data != (getattr(self._model, "prop_presets", None) or {}):
            self._model.prop_presets = copy.deepcopy(data)
            self._model.mark_dirty("prop_presets")
            self._status.setText("已写入内存；Ctrl+S 保存工程写入磁盘。")
        else:
            self._status.setText("无变化。")
        self._dirty = False

    # ---- 增删改名 ----------------------------------------------------

    def _on_new(self) -> None:
        # 定义自身新 id 是裸输入框的唯一合法场合（选择器铁律的明文例外）
        new_id, ok = QInputDialog.getText(self, "新建挂件预设", "挂件 id（英文/下划线，全表唯一）：")
        key = (new_id or "").strip()
        if not ok or not key:
            return
        if key in self._data:
            QMessageBox.warning(self, "挂件预设", f"id「{key}」已存在。")
            return
        self._data[key] = {}
        self._dirty = True
        self._refresh(keep=key)

    def _on_rename(self) -> None:
        if not self._current:
            return
        old = self._current
        new_id, ok = QInputDialog.getText(self, "改名", "新 id：", text=old)
        key = (new_id or "").strip()
        if not ok or not key or key == old:
            return
        if key in self._data:
            QMessageBox.warning(self, "挂件预设", f"id「{key}」已存在。")
            return
        # 先把当前表单并进去，否则改名会丢掉这一轮编辑
        self._data = self._staged()
        hits = scan_prop_usages(self._model, old)
        if hits:
            preview = "、".join(hits[:8]) + ("…" if len(hits) > 8 else "")
            ans = QMessageBox.question(
                self, "改名",
                f"「{old}」被 {len(hits)} 处引用（{preview}）。\n"
                f"点「Yes」把这些引用一起改成「{key}」；点「No」只改 id（引用会悬垂）。",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
                | QMessageBox.StandardButton.Cancel,
            )
            if ans == QMessageBox.StandardButton.Cancel:
                return
            if ans == QMessageBox.StandardButton.Yes:
                n = rename_prop_references(self._model, old, key)
                self._status.setText(f"已跟随改写 {n} 处引用。")
        # 保持键序：改名不该把条目挪到末尾
        self._data = {(key if k == old else k): v for k, v in self._data.items()}
        self._dirty = True
        self._refresh(keep=key)

    def _on_delete(self) -> None:
        if not self._current:
            return
        key = self._current
        hits = scan_prop_usages(self._model, key)
        msg = f"删除挂件预设「{key}」？"
        if hits:
            preview = "、".join(hits[:8]) + ("…" if len(hits) > 8 else "")
            msg += (f"\n\n它仍被 {len(hits)} 处引用（{preview}）。\n"
                    "删除后这些 attachToSocket 会挂不出东西（运行时只 warn 一行）。")
        if QMessageBox.question(self, "挂件预设", msg) != QMessageBox.StandardButton.Yes:
            return
        self._data.pop(key, None)
        self._current = ""
        self._dirty = True
        self._refresh()

    # ---- 试挂预览 ----------------------------------------------------

    def _fill_bundles(self) -> None:
        """列出有挂点标注的动画包——没标注的包试挂不出东西，列了只是噪音。"""
        base = getattr(self._model, "animation_bundles_path", None)
        names: list[str] = []
        anims = getattr(self._model, "animations", None) or {}
        for key in sorted(anims):
            if base is None:
                continue
            path = sockets_path_for_bundle(base, key)
            if path.is_file():
                names.append(str(key))
        self._loading = True
        try:
            self._bundle_combo.clear()
            self._bundle_combo.addItems(names)
        finally:
            self._loading = False
        if names:
            self._on_bundle_changed(names[0])
        else:
            self._canvas.set_note("工程里还没有任何动画包标了挂点——先去动画编辑器的「挂点」区标一个。")

    def _on_bundle_changed(self, bundle: str) -> None:
        key = str(bundle or "")
        self._sockets = {}
        self._atlas = None
        base = getattr(self._model, "animation_bundles_path", None)
        if key and base is not None:
            data = load_socket_set(sockets_path_for_bundle(base, key))
            if isinstance(data, dict):
                self._sockets = data.get("sockets") or {}
            atlas_path = base / key / "atlas.png"
            if atlas_path.is_file():
                pix = QPixmap(str(atlas_path))
                self._atlas = pix if not pix.isNull() else None
        self._loading = True
        try:
            self._socket_combo.clear()
            self._socket_combo.addItems(sorted(self._sockets))
        finally:
            self._loading = False
        # 灯挂点的候选跟着试挂包走（当前值保值，见 IdRefSelector）
        self._light_block.set_socket_items(self._socket_items())
        self._states_editor.set_socket_items(self._socket_items())
        self._refresh_slots()
        self._refresh_preview()

    def _refresh_slots(self) -> None:
        name = self._socket_combo.currentText()
        poses = {}
        sock = self._sockets.get(name)
        if isinstance(sock, dict) and isinstance(sock.get("poses"), dict):
            poses = sock["poses"]
        slots = sorted(poses, key=lambda s: int(s) if str(s).lstrip("-").isdigit() else 0)
        self._loading = True
        try:
            self._slot_combo.clear()
            self._slot_combo.addItems([str(s) for s in slots])
        finally:
            self._loading = False

    def _preview_images(self) -> list[str]:
        """预览用的贴图列表。合并口径与运行时 `resolvePropAttach` **逐字一致**：

        状态给了图就**整体替换**（不是与基础块拼起来——拼出来的序列谁也没想要），
        状态没给才用基础块的；两处内部都是 `image` 在前、`images` 在后。
        """
        st = self._preview_state()
        for src in (st, None):
            if src is None:
                one = self._image_row.path().strip()
                many = self._images_field.to_list()
            else:
                one = str(src.get("image") or "").strip()
                many = [x for x in (src.get("images") or []) if isinstance(x, str) and x.strip()]
            out = ([one] if one else []) + list(many)
            if out:
                return out
        return []

    def _preview_placement(self) -> tuple[float, float, float, float]:
        """支点/自转/缩放：状态里写了的赢，没写的沿用基础块（同 `resolvePropAttach`）。"""
        st = self._preview_state()
        out: list[float] = []
        for key in ("anchorX", "anchorY", "rotation", "scale"):
            v = st.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append(float(v))
            else:
                out.append(float(self._spins[key].value()))
        return out[0], out[1], out[2], out[3]

    def _load_prop_pixmap(self) -> None:
        """预览用的挂件贴图：按当前预览状态解析（状态没给图就回落基础块）。"""
        imgs = self._preview_images()
        path = imgs[0] if imgs else ""
        self._prop_pix = None
        if not path:
            return
        base = getattr(self._model, "project_path", None)
        if base is None:
            return
        rel = path.lstrip("/")
        for root in (base / "public", base):
            candidate = root / rel
            if candidate.is_file():
                pix = QPixmap(str(candidate))
                if not pix.isNull():
                    self._prop_pix = pix
                return

    def _refresh_preview(self) -> None:
        if self._socket_combo.currentText() and not self._slot_combo.count():
            self._refresh_slots()
        bundle = self._bundle_combo.currentText()
        anim = (getattr(self._model, "animations", None) or {}).get(bundle) or {}
        slot_text = self._slot_combo.currentText()
        cell = None
        if self._atlas is not None and slot_text.lstrip("-").isdigit():
            cell = crop_atlas_cell(
                self._atlas,
                int(anim.get("cols", 1) or 1),
                int(anim.get("rows", 1) or 1),
                int(slot_text),
                cell_w=int(anim.get("cellWidth") or 0) or None,
                cell_h=int(anim.get("cellHeight") or 0) or None,
            )
        world_w = 0.0
        try:
            world_w = float(anim.get("worldWidth") or 0.0)
        except (TypeError, ValueError):
            world_w = 0.0
        self._canvas.set_host(cell, world_w)

        pose = None
        sock = self._sockets.get(self._socket_combo.currentText())
        if isinstance(sock, dict) and isinstance(sock.get("poses"), dict):
            raw = sock["poses"].get(slot_text)
            if isinstance(raw, dict):
                try:
                    pose = (
                        float(raw.get("x", 0.5)), float(raw.get("y", 0.5)),
                        float(raw.get("angle", 0.0) or 0.0), raw.get("front") is True,
                    )
                except (TypeError, ValueError):
                    pose = None
        self._canvas.set_pose(pose)
        self._canvas.set_prop(self._prop_pix)
        self._canvas.set_placement(*self._preview_placement())
        self._canvas.set_facing(-1 if self._facing.currentIndex() == 1 else 1)

        notes = []
        state_name = str(self._state_combo.currentData() or "")
        if not self._current:
            notes.append("左边先选/新建一个挂件预设。")
        elif self._prop_pix is None:
            if state_name:
                notes.append(f"状态「{state_name}」与基础块都没有能用的贴图（或路径找不到文件）。")
            else:
                notes.append("这条预设还没有贴图（或路径找不到文件）。")
        if world_w <= 0:
            notes.append("该动画包缺 worldWidth，缩放没有可信基准。")
        if pose is None and self._current:
            notes.append("这一帧该挂点没有标注——游戏里挂件在这一帧会隐藏。")
        if state_name:
            notes.append(f"按状态「{state_name}」预览（状态没写的项沿用基础块）。")
        self._canvas.set_note("　".join(notes))

    # ---- 主窗钩子 ----------------------------------------------------

    def select_by_id(self, prop_id: str, _scene_id: str = "") -> None:
        """全局搜索/跳转落点。"""
        target = (prop_id or "").strip()
        if target and target in self._data:
            self._refresh(keep=target)

    def reload_refs_from_model(self) -> None:
        """别处新增动画包/挂点/效果资产后，候选要能看见（本页表单字段值不动）。"""
        current = self._bundle_combo.currentText()
        self._fill_bundles()
        if current:
            idx = self._bundle_combo.findText(current)
            if idx >= 0:
                self._bundle_combo.setCurrentIndex(idx)
        # 效果资产是独立进程（粒子工作台）写的，切页回来必须重拉候选；当前值保值
        self._vfx_field.reload_refs()
        self._states_editor.reload_refs()

    def flush_to_model(self, for_save_all: bool = False) -> None:
        """保存工程前：仅在内容确有变化时写回并标脏（禁无条件 mark_dirty）。"""
        del for_save_all
        data = self._staged()
        if data != (getattr(self._model, "prop_presets", None) or {}):
            self._model.prop_presets = copy.deepcopy(data)
            self._model.mark_dirty("prop_presets")
        self._dirty = False

    def confirm_close(self, parent=None) -> bool:
        """Discard 必须中和——否则关闭路径的统一 flush 会把放弃的编辑写回。"""
        if not self._dirty:
            return True
        ans = QMessageBox.question(
            parent or self, "挂件预设", "有未应用的改动，保存到内存吗？",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if ans == QMessageBox.StandardButton.Cancel:
            return False
        if ans == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            self._reload_from_model()
        return True
