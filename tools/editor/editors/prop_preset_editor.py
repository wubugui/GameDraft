"""挂件预设：prop_presets.json，供 attachToSocket 的 prop 参数引用。

**这一页存在的理由**：支点（刀柄在贴图哪儿）/自转（图画歪了多少）/缩放
描述的是**挂件自己**——同一把桃木剑，不管挂谁的手、哪个场景，刀柄永远在同一处。
把它们写在每个 attachToSocket 调用点上，既要重敲又必然发散（五处挂剑迟早有一处不一样）。
所以：这里登记一次，动作只写 `prop: "taomu_jian"`。

手持光源（2026-09-12）按**同一个理由**扩到这里：一支点着的火把不只是一张图，
它还带一盏跟着手走的灯、一团火焰粒子、一串状态（点着 / 护火 / 残炭 / 灭）——
这些同样是火把**自己**的属性，不是调用点的属性。于是本页多出四块：

- `light` 自带光源（挂上就有、卸下就没，每帧跟着挂点走）；
- `particles` 粒子挂载（契约 v3，取代旧 `vfx`）：`[{effect, point?}]`，每条一个粒子效果挂在贴图上的
  一个点，跟着支点 / 自转 / 缩放 / 镜像走；火焰的**声音住在效果资产自己的 `sound.loop`** 里，
  本表刻意**不开音频字段**——开了就是第二个真相源；
- `persistent` 手持物（玩法事实，入档、跨场景自动重挂）；
- `states` + `defaultState` 状态表（每个状态覆盖上面这些块）。

燃烧物（2026-09-15，数据契约见 `prop_preview` 模块头）再加一块「火焰」：起火点 `firePoint`
（灯位 / 效果锚点 / 火苗底部都从这里出）、看得见的火苗 `flame`（共用帧动画图集）、
燃烧强度 `burn`、挡风比例 `windShelter`（护火：只压火苗倾斜，不碰灯）；状态里可覆盖
起火点 / burn / 挡风，并带「进入时动作」`onEnterActions`。
风吹灭（同日）：基础块「风吹灭」`blowout`（火势被风压掉 → 残炭 / 灭，带越线动作；残炭里挡住风复燃回 `recoverState`）
+ 状态里三态覆盖；「玩家操作」`playerControl`（T 点火 / 熄灭、按住 Q 护火切到哪几个状态，快灭提示线 `hintBelow`）。
两块默认折叠·懒建。
能点火（2026-09-16，燃烧系统 A3.8）：基础块「能点火」`igniter`（勾 = 写对象，可选火焰长度 `flameLength` 厘米）
+ 状态里三态覆盖（沿用 / `null` 这个状态点不了 / 整块替换），默认折叠·懒建。
火把养成（2026-09-16，玩法清单 A3.7）再加三块，**都只在基础块**（状态里写了运行时不读）：
「耐久（燃料）」`fuel`（能烧几秒 / 风里烧得快多少 / 烧完切到哪个状态 / 烧完之后的动作）、
「效果块」`effects`（挑 prop_effects.json 里的脾气，数值相乘、行为并集，至多两块——与等级带的合起来算）、
「等级」`levels`（随身那根火把的升级：顺序即等级，每级一套外观 + 一串效果块；等级住在存档里，
动作 `setPropLevel` 升、条件叶 `propLevel` 问）。三块同样默认折叠·懒建。
起火点可以在试挂预览上**点选 / 拖动**设置（所见即所得），火苗按当前预览状态的
burn × 满火高度画第 0 帧；每个粒子挂点画一个小圆点并标效果 id（粒子本身不模拟）。
粒子挂载的挂点同样可以在预览上点选（行尾「点选」）。`burn` / `windShelter` 同时驱动帧动画火苗与
该状态全部粒子挂载。

可燃挂件（2026-09-16，玩法清单 A3.8「模板 + 实例」）：「可燃」块写 `burnable: {template, initial?, signals?}`
（`playerIgnite` / `igniteConditions` 对挂件不显示——挂件不走按 E 点）。开了可燃：火把那一套块
（灯 / 粒子挂载 / 火焰 / 风吹灭 / 玩家操作 / 能点火 / 耐久 / 效果块 / 等级 / 状态表）与可燃**互斥**——界面灰掉并说明，
写着的可以一键清掉；贴图 / 帧贴图 / 支点被模板接管（提示，不拦）。试挂预览改画模板的图：挂点对准模板握点、
等比缩放到模板真实宽（× 这里的缩放），标出模板的着火点。

骨架照主从列表样板（`_refresh` / `_on_select` / `_apply`），右侧详情分组
（基本 / 摆放 / 粒子挂载 / 火焰 / 自带光源 / 状态表 / 试挂预览）。**粒子挂载、火焰、光源块与状态表
默认折叠且懒建**（布局纪律：重块首次展开才造控件；没展开过的块原样透传磁盘值）。
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
    pose_is_front,
    sockets_path_for_bundle,
)
from ..shared.form_layout import compact_form
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.prop_preset_refs import rename_prop_references, scan_prop_usages
from ..shared import burnables as _bn
from ..shared.burnable_host_form import BurnableHostSection
from ..shared.prop_preview import (
    BURNABLE_TAKEN_OVER_KEYS,
    FlameDef,
    anim_world_size,
    burnable_prop_placement,
    prop_image_file,
    resolve_prop_preview,
)
from ..shared.prop_tryon_canvas import PropTryOnCanvas
from ..shared.socket_image_list import SocketImageListField
from .prop_preset_blocks import (
    PropBlowoutBlock,
    PropEffectsBlock,
    PropFireBlock,
    PropFuelBlock,
    PropIgniterBlock,
    PropLevelsEditor,
    PropLightBlock,
    PropPlayerControlBlock,
    PropStatesEditor,
    PropParticlesBlock,
    _MISSING,
    reorder_like,
)

#: 摆放字段的运行时缺省（与 SpriteEntity.syncAttachments / propPresets.ts 一致）
DEFAULTS: dict[str, float] = {"anchorX": 0.5, "anchorY": 0.5, "rotation": 0.0, "scale": 1.0}


class _DataOnlyModel:
    """只装着本页 `_data` 的假模型：让 `rename_prop_references` 只改这份工作副本。

    它的扫描面读 `signal_refactor.CONDITION_SOURCES`（其中 `prop_presets` 一格就是这份表），
    其余属性都不存在 ⇒ getattr 兜 None 自动跳过；标脏由本页自己的 flush 负责，这里吞掉。
    """

    def __init__(self, data: dict) -> None:
        self.prop_presets = data

    def mark_dirty(self, *_a: object) -> None:
        return None


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
        #: Discard / 从内存重载期间：切条目**不许**把表单提交回 _data（那会把放弃的编辑复活）
        self._discarding = False
        #: 试挂用的动画包挂点数据（选包时按需读盘，不进模型）
        self._sockets: dict[str, Any] = {}
        self._atlas: QPixmap | None = None
        self._prop_pix: QPixmap | None = None
        #: 火苗图集缓存（URL → 整张图；预览只裁第 0 帧）
        self._flame_sheets: dict[str, QPixmap | None] = {}

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
            ("改名", "改 id，并把全工程 attachToSocket.prop 与手持挂件条件 {heldProp, prop} 的引用一起改过去",
             self._on_rename),
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
        #: 开了可燃：贴图被模板接管的提示（没开时藏起来）
        self._burn_image_hint = QLabel("")
        self._burn_image_hint.setWordWrap(True)
        self._burn_image_hint.setStyleSheet("color:#d08a20;")
        self._burn_image_hint.setVisible(False)
        bf.addRow(self._burn_image_hint)
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
        #: 开了可燃：支点被模板握点接管、缩放乘在模板真实宽上的提示
        self._burn_place_hint = QLabel("")
        self._burn_place_hint.setWordWrap(True)
        self._burn_place_hint.setStyleSheet("color:#d08a20;")
        self._burn_place_hint.setVisible(False)
        pf.addRow(self._burn_place_hint)
        rl.addWidget(place)

        # 可燃（A3.8 模板 + 实例）：默认折叠·懒建，有配置时自动展开。与下面火把那一套互斥。
        self._burnable_block = BurnableHostSection(model, "prop", self)
        self._burnable_block.host_image_hint = lambda: self._image_row.path()
        self._burnable_block.set_note_provider(self._burnable_notes)
        self._burnable_block.changed.connect(self._on_burnable_changed)
        self._burnable_block.open_workbench_requested.connect(self._open_burn_workbench)
        rl.addWidget(self._burnable_block)
        #: 开了可燃时火把那一套灰掉：说明 + 一键清掉写着的互斥块
        self._burn_exclusive_box = QWidget()
        ebl = QHBoxLayout(self._burn_exclusive_box)
        ebl.setContentsMargins(0, 0, 0, 0)
        self._burn_exclusive_note = QLabel("")
        self._burn_exclusive_note.setWordWrap(True)
        self._burn_exclusive_note.setStyleSheet("color:#d08a20;")
        ebl.addWidget(self._burn_exclusive_note, 1)
        self._burn_exclusive_clear = QPushButton("清掉互斥的配置")
        self._burn_exclusive_clear.setToolTip(
            "把与可燃互斥、但这条预设里还写着的块（灯 / 粒子挂载 / 火苗 / 起火点 / 玩家操作 / 风吹灭 / 能点火 / 耐久 / "
            "效果块 / 等级 / 状态表）从表单里删掉（先问一句；没 Apply 前「从内存重载」可以反悔）。")
        self._burn_exclusive_clear.clicked.connect(self._clear_burnable_exclusive)
        ebl.addWidget(self._burn_exclusive_clear)
        self._burn_exclusive_box.setVisible(False)
        rl.addWidget(self._burn_exclusive_box)

        # 重块：默认折叠 + 懒建（布局纪律）。没展开过的块 dump() 原样回吐磁盘值。
        # 只接 `changed` 信号，不再另传 on_changed 回调——两条都接会让一次编辑走两遍。
        self._particles_block = PropParticlesBlock(model, self)
        self._particles_block.changed.connect(self._on_block_changed)
        self._particles_block.pick_requested.connect(lambda i: self._start_mount_pick("", i))
        rl.addWidget(self._particles_block)
        self._fire_block = PropFireBlock(model, self)
        self._fire_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._fire_block)
        self._light_block = PropLightBlock(None, self)
        self._light_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._light_block)
        # 风吹灭 / 玩家操作：状态名下拉的候选来自下面的状态表（_sync_state_names）
        self._blowout_block = PropBlowoutBlock(model, self)
        self._blowout_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._blowout_block)
        self._player_block = PropPlayerControlBlock(self)
        self._player_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._player_block)
        self._igniter_block = PropIgniterBlock(self)
        self._igniter_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._igniter_block)
        # 火把养成（A3.7）：耐久 / 效果块 / 等级。三块只在基础块；效果块与等级**合起来**算上限，
        # 而且运行时是"等级那串在前、预设自己那串在后、满两块就不再收"，所以两边各拿对方**整串
        # id**（不是条数——条数算不出谁被挤掉），并互相通知重算红字：
        # 等级那边改了 / 换了选中的一级 ⇒ cap_changed；预设自己这边改了 ⇒ changed。
        self._fuel_block = PropFuelBlock(model, self)
        self._fuel_block.changed.connect(self._on_block_changed)
        rl.addWidget(self._fuel_block)
        self._effects_block = PropEffectsBlock(
            model, self, level_effects_getter=lambda: self._levels_editor.effects_by_level())
        self._effects_block.changed.connect(self._on_block_changed)
        self._effects_block.changed.connect(self._refresh_level_cap_note)
        rl.addWidget(self._effects_block)
        self._levels_editor = PropLevelsEditor(
            model, self, base_effects_getter=lambda: self._effects_block.effect_ids())
        self._levels_editor.changed.connect(self._on_block_changed)
        self._levels_editor.cap_changed.connect(self._effects_block.refresh_cap_note)
        rl.addWidget(self._levels_editor)
        self._states_editor =PropStatesEditor(model, None, self)
        self._states_editor.changed.connect(self._on_block_changed)
        self._states_editor.particle_pick_requested.connect(self._start_mount_pick)
        #: 预览点选写到哪：None = 起火点；(状态名 or "" = 基础块, 第几条) = 那条粒子挂载的挂点
        self._pick_target: tuple[str, int] | None = None
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
        self._pick_fire_btn = QPushButton("点选起火点")
        self._pick_fire_btn.setCheckable(True)
        self._pick_fire_btn.setMaximumWidth(160)
        self._pick_fire_btn.setToolTip(
            "按下后在下面的预览上点 / 拖，起火点就落在光标处（逆着支点 / 自转 / 缩放 / 镜像解回贴图坐标）。\n"
            "写到哪：按「状态」预览、且那个状态勾了「起火点 覆盖」⇒ 写那个状态；否则写基础块的「火焰」块。\n"
            "青色斜十字 = 起火点；火苗按当前状态的 burn × 满火高度画第 0 帧（无风无闪）。")
        self._pick_fire_btn.toggled.connect(self._on_pick_fire_toggled)
        pk.addRow("起火点", self._pick_fire_btn)
        tf.addWidget(pick)
        self._canvas = PropTryOnCanvas()
        self._canvas.fire_point_picked.connect(self._on_fire_point_picked)
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
        self._discarding = True
        try:
            self._refresh(keep=self._current)
        finally:
            self._discarding = False
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

    def _commit_form(self) -> None:
        """commit-on-leave：把当前表单并回 `_data`（editor-data-sync-paradigm 契约 3）。

        只在当前条目仍在 `_data` 里时做——改名 / 删除之后旧键已经不在了，这时并回去
        等于把刚删掉 / 改掉的条目原名复活。
        """
        if self._current and self._current in self._data:
            self._data = self._staged()

    def _on_select(self, key: str) -> None:
        new_key = str(key or "")
        if (not self._loading and not self._discarding
                and self._current and new_key != self._current):
            # 编辑完直接点下一条：不提交就是"刚填的静默消失"（切条目是清脏的离开路径之一）
            self._commit_form()
        self._current = new_key
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
            self._particles_block.set_data(entry)
            self._fire_block.set_data(entry)
            self._light_block.set_socket_items(self._socket_items())
            self._light_block.set_data(entry.get("light"))
            self._states_editor.set_socket_items(self._socket_items())
            self._states_editor.set_data(entry.get("states"), entry.get("defaultState"))
            self._sync_state_names()
            self._blowout_block.set_data(entry)
            self._player_block.set_data(entry)
            self._igniter_block.set_data(entry)
            self._fuel_block.set_data(entry)
            self._effects_block.set_data(entry)
            self._levels_editor.set_data(entry)
            self._burnable_block.load(entry)
        finally:
            self._loading = False
        self._sync_burnable_exclusive()
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
        self._sync_state_names()
        self._on_field_changed()

    def _refresh_level_cap_note(self) -> None:
        """预设自己那一串效果块变了 ⇒ 等级表单里那行红字也得重算（反向那半由 cap_changed 走）。"""
        self._levels_editor.refresh_cap_note()

    # ---- 可燃（A3.8 模板 + 实例）----------------------------------------

    #: 与可燃互斥的块：(预设键, 块属性名, 人话)。灰掉的是整块控件。
    _BURN_EXCLUSIVE_BLOCKS = (
        ("particles", "_particles_block", "粒子挂载"),
        ("firePoint", "_fire_block", "起火点"),
        ("flame", "_fire_block", "帧动画火苗"),
        ("light", "_light_block", "自带光源"),
        ("blowout", "_blowout_block", "风吹灭"),
        ("playerControl", "_player_block", "玩家操作"),
        ("igniter", "_igniter_block", "能点火"),
        ("fuel", "_fuel_block", "耐久（燃料）"),
        ("effects", "_effects_block", "效果块"),
        ("levels", "_levels_editor", "等级"),
        ("states", "_states_editor", "状态表"),
    )

    def _open_burn_workbench(self, template_id: str) -> None:
        opener = getattr(self.window(), "open_burn_workbench", None)
        if callable(opener):
            opener(str(template_id or "").strip())

    def _on_burnable_changed(self) -> None:
        if self._loading:
            return
        self._sync_burnable_exclusive()
        self._on_block_changed()

    def _burnable_conflicts(self) -> tuple[list[str], list[str]]:
        """``(写着的互斥块人话, 写着的被接管字段)``——按表单当前值（没 Apply 的也算）。"""
        entry = self._collect() if self._current else {}
        exclusive = [label for key, _attr, label in self._BURN_EXCLUSIVE_BLOCKS if key in entry]
        taken = [k for k in BURNABLE_TAKEN_OVER_KEYS if k in entry]
        return exclusive, taken

    def _burnable_notes(self, tid: str, doc: dict | None) -> list[str]:
        """「可燃」块里的具体冲突：互斥块写着 = 校验器 error；贴图 / 支点写着 = 警告（被模板接管、不画）。"""
        del tid, doc
        if not self._current:
            return []
        exclusive, taken = self._burnable_conflicts()
        out: list[str] = []
        if exclusive:
            out.append(f"与可燃互斥、却还写着：{'、'.join(exclusive)}（校验器报错；下面「清掉互斥的配置」一键删）")
        if taken:
            out.append(f"被模板接管、写了也不画：{' / '.join(taken)}（校验器警告）")
        return out

    def _sync_burnable_exclusive(self) -> None:
        """开了可燃：火把那一套块灰掉 + 说明；贴图 / 支点提示被模板接管。没开：全部恢复。只动界面、不动数据。"""
        on = self._burnable_block.is_enabled() and bool(self._current)
        seen: set[str] = set()
        for _key, attr, _label in self._BURN_EXCLUSIVE_BLOCKS:
            if attr in seen:
                continue
            seen.add(attr)
            block = getattr(self, attr)
            block.setEnabled(not on)
            block.setToolTip("与可燃互斥：这个挂件开了可燃（上面「可燃」块），这一块运行时不读、写了算错误。" if on else "")
        self._pick_fire_btn.setEnabled(not on)
        if on and self._pick_fire_btn.isChecked():
            self._pick_fire_btn.setChecked(False)
        tid = self._burnable_block.current_template()
        doc = self._model.burnable_doc(tid) if tid and hasattr(self._model, "burnable_doc") else None
        exclusive, _taken = self._burnable_conflicts() if on else ([], [])
        self._burn_exclusive_box.setVisible(on)
        self._burn_exclusive_clear.setEnabled(bool(exclusive))
        if on:
            base = ("开了可燃：灯 / 粒子挂载 / 火苗 / 起火点 / 玩家操作 / 风吹灭 / 能点火 / 耐久 / 效果块 / 等级 / 状态表"
                    "与可燃互斥（下面这些块灰掉了）——火、光、粒子、吹灭全由模板管。")
            self._burn_exclusive_note.setText(base + (f"\n⚠ 还写着：{'、'.join(exclusive)}" if exclusive else ""))
        img = str((doc or {}).get("image") or "") if doc else ""
        self._burn_image_hint.setVisible(on)
        self._burn_place_hint.setVisible(on)
        if on:
            self._burn_image_hint.setText(
                f"被模板接管：贴图 / 帧贴图不画，画的是模板「{tid}」的图" + (f"（{img}）" if img else "") + "。")
            if isinstance(doc, dict) and _bn.template_world_size(doc) is not None:
                gu, gv = _bn.template_grip(doc)
                self._burn_place_hint.setText(
                    f"被模板接管：支点 x / y 不用，挂点对准模板握点（u {gu:g} v {gv:g}）；"
                    f"缩放乘在模板真实宽 {doc['widthCm']:g} cm 上（1 cm = {_bn.WU_PER_CM:g} wu）；自转、光照、持久化照用。")
            else:
                self._burn_place_hint.setText("被模板接管：支点不用、缩放乘在模板真实宽上（模板装不上，现在画不出来）。")
        self._burnable_block.refresh_notes()

    def _confirm_clear_exclusive(self, labels: list[str]) -> bool:
        """清掉互斥块之前的确认（测试里 monkeypatch 这一个方法，别让离屏模态框挂死）。"""
        ans = QMessageBox.question(
            self, "清掉互斥的配置",
            f"这条挂件预设开了可燃，下面这些块与可燃互斥：\n{'、'.join(labels)}\n\n从表单里删掉它们吗？"
            "（没 Apply 之前「从内存重载」可以反悔）",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        return ans == QMessageBox.StandardButton.Yes

    def _clear_burnable_exclusive(self) -> None:
        if not self._current:
            return
        staged = self._staged()
        entry = staged.get(self._current)
        if not isinstance(entry, dict):
            return
        keys = [key for key, _attr, _label in self._BURN_EXCLUSIVE_BLOCKS if key in entry]
        if not keys:
            return
        labels = [label for key, _attr, label in self._BURN_EXCLUSIVE_BLOCKS if key in keys]
        if not self._confirm_clear_exclusive(labels):
            return
        for key in keys:
            entry.pop(key, None)
        if "states" in keys:
            entry.pop("defaultState", None)     # 没有状态表，缺省状态名无处可指
        self._data = staged
        self._dirty = True
        self._on_select(self._current)
        self._status.setText(f"已从表单里删掉与可燃互斥的：{'、'.join(labels)}（Apply 后写入内存）。")

    def _sync_state_names(self) -> None:
        """风吹灭 / 玩家操作里状态名下拉的候选 = 这个预设的状态表（增删改名后跟上；当前选择保值、不标脏）。"""
        names = self._states_editor.state_names()
        self._blowout_block.set_state_names(names)
        self._player_block.set_state_names(names)
        self._fuel_block.set_state_names(names)

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
        # 粒子挂载：_MISSING = 不写键；磁盘上显式写着 `particles: []` 的要原样保住
        particles = self._particles_block.dump()
        if particles is not _MISSING:
            out["particles"] = particles
        # 火焰（firePoint / flame / burn / windShelter）：块自己管"没动过回吐原值"，这里只并进来
        out.update(self._fire_block.dump())
        # 风吹灭 / 玩家操作 / 能点火 / 耐久 / 效果块 / 等级：_MISSING = 不写键；坏形态没动过原样保住
        for key, block in (("blowout", self._blowout_block), ("playerControl", self._player_block),
                           ("igniter", self._igniter_block), ("fuel", self._fuel_block),
                           ("effects", self._effects_block), ("levels", self._levels_editor)):
            val = block.dump()
            if val is not _MISSING:
                out[key] = val
        # 手持物：运行时只认 `=== true`，但磁盘上显式写着 false 的要保住
        if self._persistent.isChecked() or "persistent" in original:
            out["persistent"] = self._persistent.isChecked()
        states, default_state = self._states_editor.dump()
        if isinstance(states, dict) and states:
            out["states"] = states
        if default_state:
            out["defaultState"] = default_state
        # 可燃：没展开过 / 没动过原样回吐；关 = 不写 `burnable` 键
        self._burnable_block.write_to(out)
        # 数值表示保真：磁盘上的 `rotation: 0`(int) 不得因为过了一趟 QDoubleSpinBox
        # 就漂成 `0.0`(float)——那是纯格式噪音，会把无关改动混进 diff。
        return preserve_numeric_repr(out, original)

    #: `_collect` 负责产出的键。其余键（将来给 PropPresetDef 加字段）原样透传。
    _MANAGED_KEYS = (
        "label", "image", "images", "anchorX", "anchorY", "rotation", "scale", "lit",
        "light", "particles", "persistent", "states", "defaultState",
        "firePoint", "flame", "burn", "windShelter", "blowout", "playerControl", "igniter",
        "fuel", "effects", "levels", "burnable",
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
        self._commit_form()   # 当前条目没 Apply 的编辑先并回去，否则新建一条就把它丢了
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
                # 挂件状态的进入动作里也可能 attachToSocket 别的挂件：本页持有的是 _data 这份
                # 工作副本（flush 时整份写回模型），模型那边改了、这边不改，下一次 flush 就拍回旧名
                n_local = rename_prop_references(_DataOnlyModel(self._data), old, key)
                self._status.setText(f"已跟随改写 {max(n, n_local)} 处引用。")
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

    def _on_pick_fire_toggled(self, on: bool) -> None:
        """开 / 关「点选」——只是交互模式，不是数据改动，不标脏。关掉 = 下一次点选回到写起火点。"""
        if not on:
            self._pick_target = None
            self._pick_fire_btn.setText("点选起火点")
        self._canvas.set_fire_pick_enabled(on)

    def _start_mount_pick(self, owner: str, index: int) -> None:
        """粒子挂载行的「点选」：接下来在预览上点 / 拖写那一条的挂点（owner "" = 基础块，否则状态名）。

        状态的挂载要按那个状态预览才看得见它的挂点，所以顺手把预览状态切过去。
        """
        self._pick_target = (str(owner or ""), int(index))
        if owner:
            idx = self._state_combo.findData(owner)
            if idx >= 0 and self._state_combo.currentIndex() != idx:
                self._state_combo.setCurrentIndex(idx)
        self._pick_fire_btn.setText(f"点选挂载 {index + 1}（{owner or '基础块'}）")
        if self._pick_fire_btn.isChecked():
            self._canvas.set_fire_pick_enabled(True)
        else:
            self._pick_fire_btn.setChecked(True)     # → _on_pick_fire_toggled(True)

    def _on_fire_point_picked(self, x: float, y: float) -> None:
        """预览上点到的点写到哪：正在点选某条粒子挂载 ⇒ 写它的挂点；
        否则是起火点——预览的状态自己覆盖了起火点就写它，否则写基础块。"""
        if not self._current or self._loading:
            return
        if self._pick_target is not None:
            owner, index = self._pick_target
            if owner:
                self._states_editor.set_state_particle_point(owner, index, x, y)
            else:
                self._particles_block.set_point(index, x, y)
            return
        name = str(self._state_combo.currentData() or "")
        if name and self._states_editor.state_has_fire_point(name):
            self._states_editor.set_state_fire_point(name, x, y)
        else:
            self._fire_block.set_fire_point(x, y)

    def _preview_fire(self) -> tuple[Any, float, FlameDef | None, list]:
        """当前预览状态下的 (起火点, burn, 火苗, 粒子挂载)：合并口径与运行时同一份（`resolve_prop_preview`）。

        基础块取「火焰」「粒子挂载」块的**当前控件值**（没 Apply 也看得见），状态取状态表暂存。
        """
        base = dict(self._fire_block.dump())
        particles = self._particles_block.dump()
        if particles is not _MISSING:
            base["particles"] = particles
        name = str(self._state_combo.currentData() or "")
        if name:
            base["states"] = {name: self._preview_state()}
        r = resolve_prop_preview(base, name)
        return r.fire_point, r.burn, r.flame, r.particles

    def _flame_cell(self, flame: FlameDef | None) -> QPixmap | None:
        """火苗图集第 0 帧那一格（按贴图推格尺寸：cellW = texW/cols，cellH = texH/rows）。"""
        if flame is None:
            return None
        if flame.image not in self._flame_sheets:
            pix = None
            disk = prop_image_file(getattr(self._model, "project_path", None), flame.image)
            if disk is not None:
                loaded = QPixmap(str(disk))
                pix = loaded if not loaded.isNull() else None
            self._flame_sheets[flame.image] = pix
        sheet = self._flame_sheets.get(flame.image)
        if sheet is None:
            return None
        cw, ch = flame.cell_size(sheet.width(), sheet.height())
        if cw < 1 or ch < 1:
            return None
        return sheet.copy(0, 0, int(cw), int(ch))

    def _burnable_preview_template(self) -> tuple[str, dict | None]:
        """试挂预览按可燃挂件画时的 ``(模板 id, 模板文档)``；没开可燃 ⇒ ``("", None)``。"""
        if not self._current or not self._burnable_block.is_enabled():
            return "", None
        tid = self._burnable_block.current_template()
        doc = self._model.burnable_doc(tid) if tid and hasattr(self._model, "burnable_doc") else None
        return tid, doc if isinstance(doc, dict) else None

    def _load_prop_pixmap(self) -> None:
        """预览用的挂件贴图：按当前预览状态解析（状态没给图就回落基础块）。开了可燃：画模板的图。"""
        tid, doc = self._burnable_preview_template()
        if tid:
            imgs = [str(doc.get("image") or "").strip()] if doc is not None else []
        else:
            imgs = self._preview_images()
        path = imgs[0] if imgs else ""
        self._prop_pix = None
        if not path:
            return
        candidate = prop_image_file(getattr(self._model, "project_path", None), path)
        if candidate is not None:
            pix = QPixmap(str(candidate))
            if not pix.isNull():
                self._prop_pix = pix

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
        atlas = self._atlas
        world = anim_world_size(
            anim,
            atlas.width() if atlas is not None else 0,
            atlas.height() if atlas is not None else 0,
        )
        world_w, world_h = world if world is not None else (0.0, 0.0)
        self._canvas.set_host(cell, world_w, world_h)

        pose = None
        sock = self._sockets.get(self._socket_combo.currentText())
        if isinstance(sock, dict) and isinstance(sock.get("poses"), dict):
            raw = sock["poses"].get(slot_text)
            if isinstance(raw, dict):
                try:
                    pose = (
                        float(raw.get("x", 0.5)), float(raw.get("y", 0.5)),
                        float(raw.get("angle", 0.0) or 0.0), pose_is_front(raw),
                    )
                except (TypeError, ValueError):
                    pose = None
        self._canvas.set_pose(pose)
        self._canvas.set_prop(self._prop_pix)
        self._canvas.set_facing(-1 if self._facing.currentIndex() == 1 else 1)
        burn_tid, burn_doc = self._burnable_preview_template()
        burn_place = None
        if burn_tid:
            # 可燃挂件（与运行时同口径）：模板的图、挂点对准模板握点、scale = widthCm·0.88/texW × 这里的缩放；
            # 火把那一套（起火点 / 火苗 / 粒子挂载）与可燃互斥，不画；标出模板的着火点
            preset = {"scale": float(self._spins["scale"].value()), "rotation": float(self._spins["rotation"].value())}
            tex_w = float(self._prop_pix.width()) if self._prop_pix is not None else 0.0
            burn_place = burnable_prop_placement(preset, burn_doc, tex_w)
            if burn_place is not None:
                self._canvas.set_placement(burn_place.anchor_x, burn_place.anchor_y, burn_place.rotation, burn_place.scale)
            else:
                self._canvas.set_placement(*self._preview_placement())
            self._canvas.set_fire(None, configured=False)
            self._canvas.set_particle_mounts([])
            self._canvas.set_burn_points([(pid, (u, v)) for pid, u, v in _bn.ignition_points_uv(burn_doc)])
            fire_point, burn, flame, mounts, flame_cell = None, 1.0, None, [], None
        else:
            self._canvas.set_placement(*self._preview_placement())
            self._canvas.set_burn_points([])
            fire_point, burn, flame, mounts = self._preview_fire() if self._current else (None, 1.0, None, [])
            flame_cell = self._flame_cell(flame)
            self._canvas.set_fire(
                fire_point,
                configured=fire_point is not None or flame is not None,
                flame_cell=flame_cell,
                flame_height_wu=(flame.height * burn) if flame is not None else 0.0,
            )
            self._canvas.set_particle_mounts([(m.effect, m.point) for m in mounts])

        notes = []
        state_name = str(self._state_combo.currentData() or "")
        if not self._current:
            notes.append("左边先选/新建一个挂件预设。")
        elif burn_tid:
            if burn_doc is None:
                notes.append(f"可燃模板「{burn_tid}」不存在（或读不懂）：运行时这件挂件画不出来。")
            elif self._prop_pix is None:
                notes.append(f"可燃模板「{burn_tid}」的图找不到文件：{burn_doc.get('image') or '（没写）'}。")
            elif burn_place is None:
                notes.append(f"可燃模板「{burn_tid}」没写真实尺寸，缩放没有基准。")
            else:
                notes.append(
                    f"可燃挂件：模板「{burn_tid}」宽 {burn_doc['widthCm']:g} cm → scale {burn_place.scale:.4g}"
                    f"（= {burn_doc['widthCm']:g}×{_bn.WU_PER_CM:g} ÷ 贴图宽 {self._prop_pix.width()} × 缩放 "
                    f"{float(self._spins['scale'].value()):g}）；挂点对准握点 u {burn_place.anchor_x:g} v {burn_place.anchor_y:g}。")
            state_name = ""
        elif self._prop_pix is None:
            if state_name:
                notes.append(f"状态「{state_name}」与基础块都没有能用的贴图（或路径找不到文件）。")
            else:
                notes.append("这条预设还没有贴图（或路径找不到文件）。")
        if world_w <= 0 or world_h <= 0:
            notes.append("该动画包的世界尺寸推不出来（没写 worldWidth/worldHeight 也读不到图集），缩放没有可信基准。")
        if pose is None and self._current:
            notes.append("这一帧该挂点没有标注——游戏里挂件在这一帧会隐藏。")
        if state_name:
            notes.append(f"按状态「{state_name}」预览（状态没写的项沿用基础块）。")
        if flame is not None:
            if flame_cell is None:
                notes.append("火苗图集找不到文件（或读不出格子），火苗没法预览。")
            elif burn <= 0:
                notes.append("burn = 0：这个状态火苗不画。")
            else:
                notes.append(f"火苗：满火 {flame.height:g} wu × burn {burn:g}（第 0 帧，无风无闪）。")
        if fire_point is not None and self._prop_pix is None:
            notes.append("没有能用的挂件贴图，起火点（贴图归一化）落不到画面上。")
        self._canvas.set_note("　".join(notes))

    # ---- 主窗钩子 ----------------------------------------------------

    def select_by_id(self, prop_id: str, _scene_id: str = "") -> bool:
        """全局搜索 / 动作总表跳转落点。返回是否真的定位到了（导航诚实化契约）。"""
        target = (prop_id or "").strip()
        if not target or target not in self._data:
            return False
        if target != self._current:
            self._commit_form()   # 跳走之前先把没 Apply 的编辑并回去
            self._refresh(keep=target)
        return self._current == target

    def reload_refs_from_model(self) -> None:
        """别处新增动画包/挂点/效果资产后，候选要能看见（本页表单字段值不动）。"""
        current = self._bundle_combo.currentText()
        self._fill_bundles()
        if current:
            idx = self._bundle_combo.findText(current)
            if idx >= 0:
                self._bundle_combo.setCurrentIndex(idx)
        # 效果资产是独立进程（粒子工作台）写的，切页回来必须重拉候选；当前值保值
        self._particles_block.reload_refs()
        self._blowout_block.reload_refs()
        self._states_editor.reload_refs()
        self._fuel_block.reload_refs()
        # 效果块库是另一页（「挂件效果块」）写的，切页回来必须重拉候选与摘要；当前值保值
        self._effects_block.reload_refs()
        self._levels_editor.reload_refs()
        # 可燃物模板是燃烧工作台（别的进程）写的：重拉模板候选、重算接管提示，试挂按新模板的图重画
        self._burnable_block.reload_refs_from_model()
        self._sync_burnable_exclusive()
        # 火苗图集可能在别处换了图 / 新导入：丢缓存，下次预览重读
        self._flame_sheets.clear()
        self._load_prop_pixmap()
        self._refresh_preview()

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
