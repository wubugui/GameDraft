"""火把养成作者面的**可用性**护栏（2026-09-16 离屏复核开的单子）。

这一组针对的全是"逻辑层全绿、人却用不了"的那一类：控件状态、宽度、颜色、屏幕上的字。
model 层断言一条都测不出它们——所以判据一律落在控件的真实状态与主题样式表文本上。

覆盖：

1. 等级页主从列表：载入之后第 1 级**真的**选中（`_current == 0` + 右侧表单填好了），
   不是"看着高亮、表单空白还能打字，打进去的字谁也收不到"；点已经选中那一行能重新同步。
2. 效果块上限提示：口径 = 运行时 `HeldPropSystem.effectsOf`（等级在前、查不到的不占名额、
   满两块就 break），换选中的等级 / 另一串改了都要重算。
3. 窄图标按钮（＋ / － / ↑ / ↓ / −）画得出字形 —— 主题给 QPushButton 的左右内边距
   合计 28px，比这些按钮本身还宽。
4. 禁用的输入框看得出是禁用的（三套主题都得有 `:disabled`）。
5. 短字段的宽度上限不许低于它自己画得下的宽度（下拉的缺省项被切一半 = 作者读到半句话）。
6. 只读引用框：文字从头显示 + "选了"与"没选"长得不一样。
7. 单位写在屏幕上，不许只躺在 tooltip 里。
8. 屏幕上的字不是 Markdown（`**` / 反引号原样显示）；空态要有话说。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import (  # noqa: E402
    QApplication,
    QComboBox,
    QLabel,
    QLineEdit,
    QPushButton,
)

from tools.editor import theme  # noqa: E402
from tools.editor.editors.prop_effects_editor import PropEffectsEditor  # noqa: E402
from tools.editor.editors.prop_preset_editor import PropPresetEditor  # noqa: E402
from tools.editor.editors.prop_preset_blocks import (  # noqa: E402
    EFFECT_OVER,
    EFFECT_TAKES,
    EFFECT_UNKNOWN,
    PROP_EFFECTS_MAX_HINT,
    prop_effects_cap_note,
    prop_effects_verdict,
)
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.reference_picker import ReferencePickerField  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

IMG = "/resources/runtime/images/a.png"

EFFECTS = {
    "oiled": {"label": "裹布浸桐油", "wind": {"windSpeed": 1.25}},
    "resin": {"label": "松脂旺", "burn": 1.4},
    "moss": {"label": "苔衣", "fuelRate": 0.8},
    "herb": {"label": "艾草", "tags": ["驱虫"]},
}
#: 现网 `xianteng_torch` 的形状：三级，第 3 级自己就挂满两块
PRESETS = {
    "xianteng_torch": {
        "label": "纤藤火把", "image": IMG,
        "states": {"lit": {"burn": 1}, "out": {"burn": 0}},
        "fuel": {"seconds": 0, "windFactor": 0.1},
        "levels": [
            {"label": "第一级"},
            {"label": "第二级", "effects": ["oiled"]},
            {"label": "第三级", "effects": ["oiled", "resin"]},
        ],
    },
    "plain": {"image": IMG},
    #: 没有等级的那一种（空态）
    "nolevels": {"image": IMG, "effects": ["oiled"]},
}


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


#: 宽度类护栏必须跨**整个字号区间**跑：写死的 px 上限在缺省字号下常常刚好够，
#: 制作人把字号调大一档（设置里可调到 {@link theme.MAX_FONT_PX}）就开始切字——
#: 只按缺省字号断言等于没有护栏。顺带把三套主题都过一遍（内边距各不相同）。
_THEME_FONT_MATRIX = [
    (theme.THEME_MODERN, theme.DEFAULT_FONT_PX),
    (theme.THEME_LIGHT, theme.MAX_FONT_PX),
    (theme.THEME_DARK, theme.MIN_FONT_PX),
]


@pytest.fixture(params=_THEME_FONT_MATRIX, ids=lambda p: f"{p[0]}@{p[1]}px")
def themed(app, request):
    """真按主题 + 真按字号跑：宽度类的毛病全在 QSS 的内边距与字号里，不上主题一条都复现不了。"""
    before_theme, before_px = theme.current_theme_id(), theme.current_font_px()
    theme.apply_application_theme(app, request.param[0], request.param[1])
    yield app
    theme.apply_application_theme(app, before_theme, before_px)


def _write(root: Path, presets: dict, effects: dict) -> ProjectModel:
    write_minimal_loadable_project(root)
    dp = root / "public/assets/data"
    img = root / "public/resources/runtime/images"
    img.mkdir(parents=True, exist_ok=True)
    (img / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    for name, doc in (("prop_presets.json", presets), ("prop_effects.json", effects)):
        (dp / name).write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    m = ProjectModel()
    m.load_project(root)
    return m


@pytest.fixture()
def model(tmp_path, app) -> ProjectModel:
    return _write(tmp_path / "p", copy.deepcopy(PRESETS), copy.deepcopy(EFFECTS))


def _descendants(root, kind):
    return [w for w in root.findChildren(kind)]


def _visible_texts(root) -> list[tuple[str, str]]:
    """页面上人能读到的字：(哪个控件, 文字)。tooltip 也算——它也是给人看的。"""
    out: list[tuple[str, str]] = []
    for w in root.findChildren(object):
        getter = getattr(w, "text", None)
        if callable(getter):
            try:
                out.append((type(w).__name__, str(getter())))
            except TypeError:      # QPushButton.text() 无参；别的重载跳过
                pass
        tip = getattr(w, "toolTip", None)
        if callable(tip):
            out.append((type(w).__name__, str(tip())))
    return [(k, t) for k, t in out if t]


# =========================================================================== #
# 1. 等级页主从列表在第一次打开时就是活的
# =========================================================================== #

def test_levels_first_row_is_really_selected_on_open(model: ProjectModel, app) -> None:
    """载入时 `setCurrentRow(0)` 发的信号被 loading 守卫吞掉 ⇒ 第 1 级"看着选中、
    表单却是空的且能打字"。这是数据丢失级：打进去的字提交不到任何一级。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        lv = ed._levels_editor
        assert lv._built and lv._list.count() == 3
        assert lv._list.currentRow() == 0, "列表高亮应落在第 1 级"
        assert lv._current == 0, "内部游标必须跟着高亮走，否则提交提交不到任何一级"
        assert lv._label.text() == "第一级", "右侧表单必须已经填好第 1 级的内容"
        assert lv._detail.isEnabled()
        assert not ed._dirty, "载入不许判脏"
    finally:
        ed.deleteLater()


def test_typing_into_the_first_level_commits_and_keeps_the_highlight(
        model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        lv = ed._levels_editor
        lv._label.setText("裹布浸桐油")
        out = ed._staged()["xianteng_torch"]["levels"]
        assert out[0]["label"] == "裹布浸桐油", "打进去的字必须落到第 1 级上"
        assert out[1]["label"] == "第二级" and out[2]["label"] == "第三级", "别的级不许动"
        assert lv._list.currentRow() == 0, "改个名字不该把选中清掉"
    finally:
        ed.deleteLater()


def test_level_buttons_work_right_after_open(model: ProjectModel, app) -> None:
    """`－` / `↑` / `↓` 全看 `_current`：它停在 -1 就是"按了没反应"。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        lv = ed._levels_editor
        lv._move(1)
        assert [x["label"] for x in ed._staged()["xianteng_torch"]["levels"]] == \
            ["第二级", "第一级", "第三级"]
    finally:
        ed.deleteLater()


def test_clicking_the_already_selected_row_resyncs_the_detail_form(
        model: ProjectModel, app) -> None:
    """点已经选中那一行 Qt 不发 currentRowChanged —— 没有 itemClicked 这条路，
    表单一旦和暂存分岔就再也回不来。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        lv = ed._levels_editor
        lv._list.setCurrentRow(1)
        assert lv._label.text() == "第二级"
        # 模拟"表单被弄乱、想点回同一行重来"：静默改掉控件，不走提交
        lv._label.blockSignals(True)
        lv._label.setText("乱敲的")
        lv._label.blockSignals(False)
        lv._list.itemClicked.emit(lv._list.item(1))
        assert lv._label.text() == "第二级", "点回同一行要把表单按暂存重填"
    finally:
        ed.deleteLater()


def test_levels_empty_state_says_what_to_do(tmp_path, app) -> None:
    m = _write(tmp_path / "e", {"plain": copy.deepcopy(PRESETS["plain"])}, copy.deepcopy(EFFECTS))
    ed = PropPresetEditor(m)
    try:
        assert ed.select_by_id("plain")
        lv = ed._levels_editor
        lv.ensure_built()
        assert lv._list.count() == 0
        assert not lv._empty_hint.isHidden() and "＋" in lv._empty_hint.text(), (
            "一个空列表 + 一个灰掉的表单，作者不知道该点哪儿")
        assert ed._staged()["plain"] == PRESETS["plain"], "展开空态不许凭空写 levels"
        lv._on_new()
        assert lv._empty_hint.isHidden(), "有等级了还挂着「还没有等级」= 另一种误导"
    finally:
        ed.deleteLater()


# =========================================================================== #
# 2. 上限提示的口径 = 运行时
# =========================================================================== #

def _known(*ids: str):
    return lambda eid: eid in set(ids)


def test_verdict_matches_runtime_effects_of() -> None:
    """三条规矩逐条钉死（漏一条红字就在说假话）。"""
    k = _known("a", "b", "c")
    # 等级那串排在**前面**
    assert prop_effects_verdict(["a"], ["b", "c"], k) == [
        ("level", "a", EFFECT_TAKES), ("base", "b", EFFECT_TAKES), ("base", "c", EFFECT_OVER)]
    # 查不到的跳过，**不占名额**
    assert prop_effects_verdict([], ["zz", "a", "b"], k) == [
        ("base", "zz", EFFECT_UNKNOWN), ("base", "a", EFFECT_TAKES), ("base", "b", EFFECT_TAKES)]
    # 收满就 break：之后的一律不生效（连查不到的都算不上"跳过"）
    assert prop_effects_verdict(["a", "b"], ["zz"], k) == [
        ("level", "a", EFFECT_TAKES), ("level", "b", EFFECT_TAKES), ("base", "zz", EFFECT_OVER)]
    # 两块正好 ⇒ 没有红字
    assert prop_effects_cap_note(["a"], ["b"], k, level_name="这一级") == ""


def test_verdict_mirrors_the_typescript_source() -> None:
    """镜像对账：运行时改了拼接顺序 / 跳过规则，这条得红。"""
    text = (_ROOT / "src/systems/heldProp/HeldPropSystem.ts").read_text("utf-8")
    body = re.search(r"private effectsOf\(.*?\n  \}", text, re.S)
    assert body, "HeldPropSystem.ts 里找不到 effectsOf"
    src = body.group(0)
    assert re.search(r"\[\s*\.\.\.\(preset\.levels\?\.\[level - 1\]\?\.effects \?\? \[\]\),"
                     r"\s*\.\.\.\(preset\.effects \?\? \[\]\)\s*\]", src), \
        "等级那串不再排在预设自己前面 ⇒ 编辑器红字的顺序口径要跟着改"
    assert "if (!e) {" in src and "continue;" in src, "查不到的不再是 continue（不占名额）"
    assert f"out.length >= PROP_EFFECTS_MAX" in src and "break;" in src, "满了不再 break"


def test_base_effects_hint_counts_the_worst_level(model: ProjectModel, app) -> None:
    """现网 xianteng_torch 的第 3 级自己就挂满两块 ⇒ 预设自己再加一块就已经不生效了。
    只数"选中那一级"的旧写法在这里一声不吭。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        block = ed._effects_block
        block.ensure_built()
        field = block._field
        assert field._note.text() == "", "预设自己一块都没挂，不该有红字"
        field._add_row("moss", quiet=False)
        note = field._note.text()
        assert "超过上限" in note, "第 3 级已经占满两块，这一块根本轮不上"
        assert "第 3 级" in note, "红字要点名是哪一级把它挤掉的"
        assert "预设自己「moss」" in note and "静默不生效" in note, \
            "要说清哪一块不生效，不能只报个数"
        assert "第 3 级「oiled」" in note and "第 3 级「resin」" in note, \
            "也要说清真生效的是哪两块"
    finally:
        ed.deleteLater()


def test_hint_recomputes_when_the_selected_level_changes(model: ProjectModel, app) -> None:
    """换一级 = 换一串效果块。不重算就是"红字写着上一级的算术"。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        ed._effects_block.ensure_built()
        lv = ed._levels_editor
        base = ed._effects_block._field
        base._add_row("moss", quiet=False)
        assert "超过上限" in base._note.text()
        # 第 1 级什么都没挂 ⇒ 站在第 1 级上这一块是生效的，但第 3 级仍然挤掉它：
        # 红字不该因为"当前选中第 1 级"就消失
        lv._list.setCurrentRow(0)
        assert "第 3 级" in base._note.text(), "红字要按最早出事的那一级说话，不跟着选中漂"
        # 等级那一侧的红字则是"这一级"的账
        lv._list.setCurrentRow(2)
        assert "超过上限" in lv._effects._note.text() and "这一级" in lv._effects._note.text()
        lv._list.setCurrentRow(0)
        assert lv._effects._note.text() == "", "第 1 级没挂 ⇒ 这一级 0 + 预设自己 1 块，没超"
    finally:
        ed.deleteLater()


def test_level_hint_recomputes_when_the_base_string_changes(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        ed._effects_block.ensure_built()
        lv = ed._levels_editor
        lv._list.setCurrentRow(1)      # 第 2 级挂 1 块
        assert lv._effects._note.text() == ""
        ed._effects_block._field._add_row("moss", quiet=False)
        ed._effects_block._field._add_row("herb", quiet=False)
        assert "超过上限" in lv._effects._note.text(), \
            "预设自己那串变了，等级这边的红字也得跟着重算"
    finally:
        ed.deleteLater()


def test_unknown_ids_do_not_eat_a_slot_in_the_hint(model: ProjectModel, app) -> None:
    """运行时 `if (!e) continue` —— 查不到的那一条不占名额。旧写法只数行数，
    写错一个 id 就白白报一次"超上限"（作者去删一块真能用的）。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("nolevels")      # 没有等级，账只在这一串上
        ed._effects_block.ensure_built()
        field = ed._effects_block._field
        field._add_row("绝不存在", quiet=False)
        field._add_row("resin", quiet=False)
        assert [r["sel"].current_id() for r in field._rows] == ["oiled", "绝不存在", "resin"]
        assert field._note.text() == "", (
            "三行里只有两行查得到 ⇒ 运行时正好收两块，一块都没被挤掉")
    finally:
        ed.deleteLater()


# =========================================================================== #
# 3. 窄图标按钮画得出字形
# =========================================================================== #

def _clipped_buttons(root) -> list[str]:
    out = []
    for b in _descendants(root, QPushButton):
        b.ensurePolished()
        cap = b.maximumWidth()
        if cap < 16777215 and b.sizeHint().width() > cap:
            out.append(f"{b.text()!r} 上限 {cap} < 画得下所需 {b.sizeHint().width()}")
    return out


def test_effects_page_icon_buttons_are_not_blank(model: ProjectModel, themed) -> None:
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("resin")
        ed._fields._add_row({"kind": "fear", "tag": "t", "radius": 1, "strength": 1}, quiet=True)
        ed._tags._add_row("x", quiet=True)
        assert _clipped_buttons(ed) == [], "按钮窄过内边距 ⇒ 画出来是空白的"
    finally:
        ed.deleteLater()


def test_preset_page_level_and_effect_buttons_are_not_blank(model: ProjectModel, themed) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        ed._effects_block.ensure_built()
        ed._effects_block._field._add_row("resin", quiet=True)
        lv = ed._levels_editor
        lv._list.setCurrentRow(2)
        assert _clipped_buttons(lv) == []
        assert _clipped_buttons(ed._effects_block) == []
    finally:
        ed.deleteLater()


def test_every_theme_gives_compact_buttons_their_own_padding() -> None:
    for name in ("_stylesheet_flat_dark", "_stylesheet_flat_light", "_stylesheet_flat_modern"):
        qss = getattr(theme, name)()
        rule = f'QPushButton[{theme.COMPACT_BUTTON_PROP}="true"]'
        assert rule in qss, f"{name} 没给窄图标按钮留内边距档"
        block = qss.split(rule, 1)[1].split("}", 1)[0]
        assert "padding" in block


# =========================================================================== #
# 4. 禁用的输入框看得出是禁用的
# =========================================================================== #

_INPUT_CLASSES = ("QLineEdit", "QComboBox", "QSpinBox", "QDoubleSpinBox")


def test_every_theme_styles_disabled_inputs() -> None:
    """没有 `:disabled` 规则时，没勾上的可选数值（`0.0` / `0.100`）和能改的长得一模一样，
    作者对着改半天没反应 —— 而且 QSS 一接管背景色，Fusion 原生的禁用外观就不画了。"""
    for name in ("_stylesheet_flat_dark", "_stylesheet_flat_light", "_stylesheet_flat_modern"):
        qss = getattr(theme, name)()
        rules = [b for b in qss.split("}") if ":disabled" in b and "QPushButton" not in b]
        for cls in _INPUT_CLASSES:
            hit = [b for b in rules if f"{cls}:disabled" in b]
            assert hit, f"{name} 没给 {cls} 写禁用态样式"
            block = hit[0].split("{", 1)[1]
            assert "color:" in block and "background-color:" in block, \
                f"{name} 的 {cls}:disabled 既没换字色也没换底色 = 等于没写"


def test_disabled_input_style_differs_from_the_live_one() -> None:
    """光有规则不够，取值得和常态不一样。"""
    for name in ("_stylesheet_flat_dark", "_stylesheet_flat_light", "_stylesheet_flat_modern"):
        qss = getattr(theme, name)()
        live = qss.split("QLineEdit, QPlainTextEdit, QTextEdit {", 1)[1].split("}", 1)[0]
        dead = qss.split("QLineEdit:disabled", 1)[1].split("{", 1)[1].split("}", 1)[0]
        live_color = re.search(r"color:\s*([^;]+);", live).group(1).strip()
        dead_color = re.search(r"^\s*color:\s*([^;]+);", dead, re.M).group(1).strip()
        assert live_color != dead_color, f"{name} 的禁用字色和常态一样"


# =========================================================================== #
# 5. 宽度上限不许低于控件自己画得下的宽度
# =========================================================================== #

def _too_narrow(widgets) -> list[str]:
    out = []
    for w in widgets:
        w.ensurePolished()
        cap = w.maximumWidth()
        if cap < 16777215 and w.sizeHint().width() > cap:
            label = w.currentText() if isinstance(w, QComboBox) else ""
            out.append(f"{type(w).__name__}({label!r}) 上限 {cap} < 所需 {w.sizeHint().width()}")
    return out


def test_guard_blocks_run_combo_shows_its_whole_default_row(model: ProjectModel, themed) -> None:
    """「沿用缺省（不写 = true：只能走）」被钉死的 240px 切成「…只能」。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        block = ed._player_block
        block.ensure_built()
        combo = block._guard_run
        assert "沿用缺省" in combo.itemText(0)
        assert _too_narrow([combo]) == []
    finally:
        ed.deleteLater()


def _held_prop_tree(model):
    from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget

    tree = ConditionExprTreeRootWidget(model_getter=lambda: model)
    tree.set_expr({"heldProp": "player"})
    return tree


def test_held_prop_operator_combos_fit_their_own_default_item(model: ProjectModel, themed) -> None:
    tree = _held_prop_tree(model)
    try:
        root = tree.root_node()
        assert root._hp_op.itemText(0) == "（不限）"
        assert _too_narrow([root._hp_op, root._hp_fuel_op]) == []
    finally:
        tree.deleteLater()


def test_held_prop_socket_combo_shows_the_head_of_its_text(model: ProjectModel, themed) -> None:
    """可编辑下拉设完文本光标停在末尾 ⇒ 「（不限挂点）」显示成「不限挂点）」。"""
    tree = _held_prop_tree(model)
    try:
        line = tree.root_node()._hp_socket.lineEdit()
        assert line is not None and line.text() == "（不限挂点）"
        assert line.cursorPosition() == 0, "光标停在末尾 = 框一窄就只看得见尾巴"
    finally:
        tree.deleteLater()


# =========================================================================== #
# 6. 只读引用框
# =========================================================================== #

def test_reference_field_shows_the_head_and_marks_itself_filled(themed) -> None:
    field = ReferencePickerField(
        lambda: [("xianteng_torch", "纤藤火把　（3 级）", "挂件预设")])
    try:
        line = field.findChild(QLineEdit)
        assert line is not None
        field.set_value("xianteng_torch")
        assert line.text().startswith("纤藤火把"), "展示名要在前面"
        assert line.cursorPosition() == 0, "滚到末尾就只剩 [xianteng_torch]，人名那一半全没了"
        assert line.property(theme.REFERENCE_VALUE_PROP) == "filled"
        field.clear_value()
        assert line.property(theme.REFERENCE_VALUE_PROP) == "empty", \
            "选了和没选必须长得不一样（只读框一律被涂成灰字）"
    finally:
        field.deleteLater()


def test_every_theme_distinguishes_a_filled_reference_field() -> None:
    for name in ("_stylesheet_flat_dark", "_stylesheet_flat_light", "_stylesheet_flat_modern"):
        qss = getattr(theme, name)()
        filled = f'QLineEdit[{theme.REFERENCE_VALUE_PROP}="filled"]'
        empty = f'QLineEdit[{theme.REFERENCE_VALUE_PROP}="empty"]'
        assert filled in qss and empty in qss, f"{name} 少了引用框的取值态"
        fb = qss.split(filled, 1)[1].split("{", 1)[1].split("}", 1)[0]
        eb = qss.split(empty, 1)[1].split("{", 1)[1].split("}", 1)[0]
        assert fb.strip() != eb.strip(), f"{name} 的两态样式一样 = 等于没写"


def test_reference_field_still_round_trips_a_dangling_value(themed) -> None:
    """保值展示这条不许被样式改动带坏（共享控件，别的页也在用）。"""
    field = ReferencePickerField(lambda: [("a", "甲", "")])
    try:
        field.set_value("没这个东西")
        assert field.current_value() == "没这个东西"
        line = field.findChild(QLineEdit)
        assert "缺失" in line.text()
        assert line.property(theme.REFERENCE_VALUE_PROP) == "filled", "悬垂值也是有值"
    finally:
        field.deleteLater()


# =========================================================================== #
# 7. 单位写在屏幕上
# =========================================================================== #

def test_units_are_on_screen_not_only_in_tooltips(model: ProjectModel, app) -> None:
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("resin")
        ed._fields._add_row({"kind": "fear", "tag": "t", "radius": 1, "strength": 1}, quiet=True)
        labels = [w.text() for w in _descendants(ed._fields, QLabel)]
        assert any("半径" in t and "wu" in t for t in labels), "半径得写明 wu"
        assert any("强度" in t and re.search(r"\d", t) for t in labels), "强度得给个量级"
    finally:
        ed.deleteLater()


def test_held_prop_vitality_and_fuel_say_their_scale(model: ProjectModel, app) -> None:
    tree = _held_prop_tree(model)
    try:
        labels = [w.text() for w in _descendants(tree.root_node()._hp_wrap, QLabel)]
        assert sum(1 for t in labels if "0..1" in t) >= 2, (
            "火势与燃料都是 0..1 的比例，光看 0.2 分不出是两成还是两秒")
    finally:
        tree.deleteLater()


# =========================================================================== #
# 8. 屏幕上的字不是 Markdown；空态要有话说
# =========================================================================== #

def test_the_effects_page_does_not_leak_markdown(model: ProjectModel, app) -> None:
    ed = PropEffectsEditor(model)
    try:
        assert ed.select_by_id("resin")
        ed._fields._add_row({"kind": "fear", "tag": "t", "radius": 1, "strength": 1}, quiet=True)
        ed._tags._add_row("x", quiet=True)
        bad = [(k, t) for k, t in _visible_texts(ed) if "**" in t or "`" in t]
        assert bad == [], "QLabel / tooltip 不渲染 Markdown，`**` 与反引号原样显示给作者看"
    finally:
        ed.deleteLater()


def test_the_new_preset_blocks_do_not_leak_markdown(model: ProjectModel, app) -> None:
    """火把养成那三块（耐久 / 效果块 / 等级）与效果块页是同一批新面、同一条毛病。"""
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        ed._fuel_block.ensure_built()
        ed._effects_block.ensure_built()
        ed._levels_editor.ensure_built()
        for block in (ed._fuel_block, ed._effects_block, ed._levels_editor):
            bad = [(k, t) for k, t in _visible_texts(block) if "**" in t or "`" in t]
            assert bad == [], f"{type(block).__name__}: {bad}"
    finally:
        ed.deleteLater()


def test_effect_cap_hint_is_readable_prose(model: ProjectModel, app) -> None:
    ed = PropPresetEditor(model)
    try:
        assert ed.select_by_id("xianteng_torch")
        ed._effects_block.ensure_built()
        field = ed._effects_block._field
        field._add_row("moss", quiet=False)
        note = field._note.text()
        assert "**" not in note and "`" not in note
        assert str(PROP_EFFECTS_MAX_HINT) in note
    finally:
        ed.deleteLater()
