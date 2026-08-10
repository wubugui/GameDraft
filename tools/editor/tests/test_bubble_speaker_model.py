"""头顶闲聊「说话人三档」契约测试。

覆盖四个登记面：
1. 运行时↔校验器的手工镜像（说话人键 / 动作 target 前缀）——语义级 parity，不只锁存在性；
2. 校验器规则（角色档没摆放 / 实体档钉错场景 / 没钉场景又重名）；
3. 编辑器表单往返（打开→不改→保存零漂移；两档写出的形状；选点钉死场景）；
4. 实体重构跟随（钉死场景的机械跟随、迁移改钉、撤销对称）。
"""
from __future__ import annotations

import copy
import re
import sys
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from tools.editor.shared.entity_refactor import (
    move_entity,
    push_journal,
    rename_entity,
    scan_entity_usages,
    undo_last,
)
from tools.editor.validator import (
    BUBBLE_CHARACTER_TARGET_PREFIX,
    Issue,
    _bubble_speaker_key_from_def,
    _bubble_speaker_key_from_target,
    _validate_bubble_lines,
)

_REPO = Path(__file__).resolve().parents[3]
_RUNTIME_SRC = _REPO / "src" / "systems" / "BubbleChatterSystem.ts"


# --------------------------------------------------------------------------- #
# 1) 运行时↔校验器镜像 parity
# --------------------------------------------------------------------------- #

def test_character_target_prefix_matches_runtime() -> None:
    """`character:` 前缀在 TS 与 Python 各写了一份，漂了就等于两边算出不同的说话人键。"""
    src = _RUNTIME_SRC.read_text(encoding="utf-8")
    m = re.search(r"CHARACTER_TARGET_PREFIX\s*=\s*'([^']+)'", src)
    assert m, "运行时不再导出 CHARACTER_TARGET_PREFIX，镜像失去锚点"
    assert m.group(1) == BUBBLE_CHARACTER_TARGET_PREFIX


def test_runtime_speaker_key_shapes_are_mirrored() -> None:
    """三档的键形状（player / character:<id> / entity:<id>）必须在运行时源码里对得上。"""
    src = _RUNTIME_SRC.read_text(encoding="utf-8")
    assert "return `character:${ref.characterId}`" in src
    assert "return `entity:${ref.id}`" in src
    assert "if (ref.kind === 'player') return 'player';" in src


@pytest.mark.parametrize(("speaker", "expected"), [
    ({"kind": "player"}, "player"),
    ({"kind": "character", "characterId": "clara"}, "character:clara"),
    ({"kind": "entity", "id": "npc_a"}, "entity:npc_a"),
    ({"kind": "character", "characterId": ""}, ""),
    ({"kind": "entity", "id": ""}, ""),
])
def test_speaker_key_from_def(speaker: dict, expected: str) -> None:
    assert _bubble_speaker_key_from_def(speaker) == expected


@pytest.mark.parametrize(("target", "expected"), [
    ("player", "player"),
    ("character:clara", "character:clara"),
    ("npc_a", "entity:npc_a"),
    # 前缀后面是空的：运行时按裸实体读（不能静默变成"谁都不是"），Python 侧必须同款
    ("character:", "entity:character:"),
    # 动作侧不做规范化：TS 的 bubbleSpeakerFromActionTarget('') 也落成 {kind:'entity',id:''}
    ("", "entity:"),
])
def test_speaker_key_from_target(target: str, expected: str) -> None:
    assert _bubble_speaker_key_from_target(target) == expected


# --------------------------------------------------------------------------- #
# 2) 校验器规则
# --------------------------------------------------------------------------- #

class _FakeModel:
    """`_validate_bubble_lines` 的最小消费面。"""

    def __init__(self, line_sets: list[dict]) -> None:
        self.scenes = {
            "甲村": {
                "npcs": [
                    {"id": "npc_张三", "name": "张三", "characterId": "clara"},
                    {"id": "npc_重名", "name": "甲村重名"},
                ],
                "hotspots": [{"id": "hs_摊位"}],
                "zones": [{"id": "z_只是个区域"}],
            },
            "乙镇": {
                "npcs": [{"id": "npc_重名", "name": "乙镇重名"}],
                "hotspots": [],
                "zones": [],
            },
        }
        self.character_registry = {
            "clara": {"id": "clara", "name": "克拉拉"},
            "edgar": {"id": "edgar", "name": "埃德加"},
        }
        self.bubble_lines = {"lineSets": line_sets}

    def all_scene_ids(self) -> list[str]:
        return list(self.scenes)


def _issues(line_sets: list[dict]) -> list[Issue]:
    out: list[Issue] = []
    _validate_bubble_lines(_FakeModel(line_sets), out)
    return out


def _msgs(line_sets: list[dict], level: str) -> list[str]:
    return [i.message for i in _issues(line_sets) if i.severity == level]


def _ok_lines() -> list[dict]:
    return [{"text": "一句"}]


def test_player_speaker_needs_nothing_extra() -> None:
    assert not _issues([{"id": "s", "speaker": {"kind": "player"}, "lines": _ok_lines()}])


def test_character_speaker_happy_path() -> None:
    assert not _issues([
        {"id": "s", "speaker": {"kind": "character", "characterId": "clara"}, "lines": _ok_lines()},
    ])


def test_character_not_in_registry_is_error() -> None:
    errs = _msgs([{"id": "s", "speaker": {"kind": "character", "characterId": "无此人"},
                   "lines": _ok_lines()}], "error")
    assert any("character_registry" in m for m in errs), errs


def test_character_without_any_placement_is_error() -> None:
    """埃德加在注册表里，但没有任何摆放引用他 → 运行时找不到嘴，整组不说话。"""
    errs = _msgs([{"id": "s", "speaker": {"kind": "character", "characterId": "edgar"},
                   "lines": _ok_lines()}], "error")
    assert any("没有任何场景摆放" in m for m in errs), errs


def test_character_pinned_to_scene_without_placement_is_error() -> None:
    errs = _msgs([{"id": "s", "speaker": {"kind": "character", "characterId": "clara"},
                   "scenes": ["乙镇"], "lines": _ok_lines()}], "error")
    assert any("没有摆放" in m for m in errs), errs


def test_character_with_two_placements_in_one_scene_warns() -> None:
    model = _FakeModel([{"id": "s", "speaker": {"kind": "character", "characterId": "clara"},
                         "lines": _ok_lines()}])
    model.scenes["甲村"]["npcs"].append({"id": "npc_另一个克拉拉", "characterId": "clara"})
    out: list[Issue] = []
    _validate_bubble_lines(model, out)
    warns = [i.message for i in out if i.severity == "warning"]
    assert any("只让其中第一个可见的说话" in m for m in warns), warns


def test_entity_pinned_to_wrong_scene_is_error() -> None:
    """人在甲村、场景钉在乙镇 → 运行时按当前场景解析，这组永远不响。"""
    errs = _msgs([{"id": "s", "speaker": {"kind": "entity", "id": "npc_张三"},
                   "scenes": ["乙镇"], "lines": _ok_lines()}], "error")
    assert any("不在限定的场景" in m for m in errs), errs


def test_entity_pinned_to_right_scene_is_clean() -> None:
    assert not _issues([{"id": "s", "speaker": {"kind": "entity", "id": "npc_张三"},
                         "scenes": ["甲村"], "lines": _ok_lines()}])


def test_entity_unpinned_but_unique_is_clean() -> None:
    """只有一个场景定义它 → 不钉场景也不会串台，不该无谓地报警告（警告棘轮）。"""
    assert not _issues([{"id": "s", "speaker": {"kind": "entity", "id": "npc_张三"},
                         "lines": _ok_lines()}])


def test_entity_unpinned_and_duplicated_warns() -> None:
    warns = _msgs([{"id": "s", "speaker": {"kind": "entity", "id": "npc_重名"},
                    "lines": _ok_lines()}], "warning")
    assert any("多个场景重名" in m for m in warns), warns


def test_zone_is_not_a_valid_speaker() -> None:
    """zone 运行时冒不出气泡；放行它就等于放行一种"配了完全没反应"的写法。"""
    errs = _msgs([{"id": "s", "speaker": {"kind": "entity", "id": "z_只是个区域"},
                   "lines": _ok_lines()}], "error")
    assert any("不是任何场景里的实体" in m for m in errs), errs


def test_hotspot_speaker_is_valid() -> None:
    assert not _issues([{"id": "s", "speaker": {"kind": "entity", "id": "hs_摊位"},
                         "scenes": ["甲村"], "lines": _ok_lines()}])


# --------------------------------------------------------------------------- #
# 3) 编辑器表单
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def qt_app():
    return QApplication.instance() or QApplication(sys.argv)


@pytest.fixture()
def real_model(tmp_path: Path):
    """真 ProjectModel（条件树/富文本控件要读 flag_registry 等一堆真字段）。

    在最小可加载工程上补两个场景 + 角色注册表；台词本由各用例自己塞。
    """
    import json

    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path / "p"
    write_minimal_loadable_project(root)
    dp = root / "public" / "assets" / "data"
    sp = root / "public" / "assets" / "scenes"

    def dump(path: Path, obj: object) -> None:
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    dump(dp / "character_registry.json", {"characters": [
        {"id": "clara", "name": "克拉拉"},
        {"id": "edgar", "name": "埃德加"},
    ]})
    dump(sp / "甲村.json", {
        "id": "甲村", "name": "甲村",
        "npcs": [
            {"id": "npc_张三", "name": "张三", "characterId": "clara", "x": 100, "y": 200},
            {"id": "npc_重名", "name": "甲村重名", "x": 10, "y": 20},
        ],
        "hotspots": [{"id": "hs_摊位", "type": "inspect", "x": 5, "y": 6}],
        "zones": [{"id": "z_只是个区域", "polygon": [[0, 0], [1, 0], [1, 1]]}],
        "spawnPoints": {},
    })
    dump(sp / "乙镇.json", {
        "id": "乙镇", "name": "乙镇",
        "npcs": [{"id": "npc_重名", "name": "乙镇重名", "x": 0, "y": 0}],
        "hotspots": [], "zones": [], "spawnPoints": {},
    })
    m = ProjectModel()
    m.load_project(root)
    return m


def _editor(model, line_sets: list[dict]):
    from tools.editor.editors.bubble_lines_editor import BubbleLinesEditor
    model.bubble_lines = {"lineSets": copy.deepcopy(line_sets)}
    return BubbleLinesEditor(model)


def test_editor_roundtrip_leaves_every_shape_untouched(qt_app, real_model) -> None:
    """打开→选中→不动→写回：三档形状都必须零漂移（含老数据的多场景/无场景）。"""
    sets = [
        {"id": "a", "speaker": {"kind": "player"}, "scenes": ["甲村"], "lines": _ok_lines()},
        {"id": "b", "speaker": {"kind": "character", "characterId": "clara"}, "lines": _ok_lines()},
        {"id": "c", "speaker": {"kind": "entity", "id": "npc_张三"}, "scenes": ["甲村"],
         "lines": _ok_lines()},
        # 老数据：没钉场景 / 钉了多个——编辑器不许替用户改这两种
        {"id": "d", "speaker": {"kind": "entity", "id": "npc_重名"}, "lines": _ok_lines()},
        {"id": "e", "speaker": {"kind": "entity", "id": "npc_重名"},
         "scenes": ["甲村", "乙镇"], "lines": _ok_lines()},
    ]
    ed = _editor(real_model, sets)
    try:
        for row in range(len(sets)):
            ed._list.setCurrentRow(row)
            assert not ed._set_dirty(), f"第 {row} 条（{sets[row]['id']}）打开即脏"
        assert real_model.bubble_lines["lineSets"] == sets
    finally:
        ed.deleteLater()


def test_editor_switch_to_character_writes_character_shape(qt_app, real_model) -> None:
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_张三"},
                               "scenes": ["甲村"], "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        ed._f_speaker_kind.setCurrentIndex(ed._f_speaker_kind.findData("character"))
        ed._f_character.set_value("clara")
        ed._apply()
        sp = real_model.bubble_lines["lineSets"][0]["speaker"]
        assert sp == {"kind": "character", "characterId": "clara"}, sp
        # 切到角色档后，场景行仍是原来那份（不借机清空作者写的限定场景）
        assert real_model.bubble_lines["lineSets"][0]["scenes"] == ["甲村"]
    finally:
        ed.deleteLater()


def test_editor_player_row_writes_player_shape(qt_app, real_model) -> None:
    """「主角」是角色档里的一行，但落盘仍是 kind:player（语义不同：换人了嘴也跟着换）。"""
    from tools.editor.editors.bubble_lines_editor import _PLAYER_CHARACTER_VALUE
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "character", "characterId": "clara"},
                               "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        ed._f_character.set_value(_PLAYER_CHARACTER_VALUE)
        ed._apply()
        assert real_model.bubble_lines["lineSets"][0]["speaker"] == {"kind": "player"}
    finally:
        ed.deleteLater()


def test_editor_character_rows_include_player_and_registry(qt_app, real_model) -> None:
    from tools.editor.editors.bubble_lines_editor import _PLAYER_CHARACTER_VALUE
    ed = _editor(real_model, [])
    try:
        values = [r[0] for r in ed._character_rows()]
        assert values[0] == _PLAYER_CHARACTER_VALUE
        assert set(values[1:]) == {"clara", "edgar"}
    finally:
        ed.deleteLater()


def test_editor_entity_pick_pins_the_scene(qt_app, real_model) -> None:
    """选点＝同时定了场景与实体，scenes 由选点反填（这就是"不再单配限定场景"的落点）。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "player"}, "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        ed._f_speaker_kind.setCurrentIndex(ed._f_speaker_kind.findData("entity"))
        ed._f_entity.set_value("乙镇", "npc_重名")
        ed._apply()
        c = real_model.bubble_lines["lineSets"][0]
        assert c["speaker"] == {"kind": "entity", "id": "npc_重名"}
        assert c["scenes"] == ["乙镇"]
    finally:
        ed.deleteLater()


def test_editor_legacy_multi_scene_entity_is_not_auto_pinned(qt_app, real_model) -> None:
    """老数据钉了两个场景：反填不出唯一场景就留空，保存也不许替用户挑一个。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_重名"},
                               "scenes": ["甲村", "乙镇"], "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        assert ed._f_entity.scene_id() == ""
        ed._apply()
        assert real_model.bubble_lines["lineSets"][0]["scenes"] == ["甲村", "乙镇"]
    finally:
        ed.deleteLater()


def test_editor_speaker_row_visibility_follows_mode(qt_app, real_model) -> None:
    """实体档下「限定场景」不是可配项——编辑入口必须真的消失，只留只读回显。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_张三"},
                               "scenes": ["甲村"], "lines": _ok_lines()}])
    try:
        ed.show()
        ed._list.setCurrentRow(0)
        QApplication.processEvents()
        assert ed._f_entity.isVisibleTo(ed) and not ed._f_character.isVisibleTo(ed)
        assert not ed._scenes_rows_host.isVisibleTo(ed)
        assert not ed._scenes_add_btn.isVisibleTo(ed)
        assert ed._scenes_locked.isVisibleTo(ed)
        assert "甲村" in ed._scenes_locked.text()

        ed._f_speaker_kind.setCurrentIndex(ed._f_speaker_kind.findData("character"))
        QApplication.processEvents()
        assert ed._f_character.isVisibleTo(ed) and not ed._f_entity.isVisibleTo(ed)
        assert ed._scenes_rows_host.isVisibleTo(ed)
        assert ed._scenes_add_btn.isVisibleTo(ed)
        assert not ed._scenes_locked.isVisibleTo(ed)
    finally:
        ed.deleteLater()


def test_editor_warns_when_legacy_entity_has_no_pinned_scene(qt_app, real_model) -> None:
    """没钉场景的老数据要在回显里说清楚后果，而不是装作没事。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_重名"},
                               "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        assert "没钉死场景" in ed._scenes_locked.text()
    finally:
        ed.deleteLater()


def test_scene_entity_picker_lists_npc_and_hotspot_but_not_zone(qt_app, real_model) -> None:
    from tools.editor.shared.scene_entity_picker import scene_speaker_entities
    rows = scene_speaker_entities(real_model, "甲村")
    assert [r["id"] for r in rows] == ["npc_张三", "npc_重名", "hs_摊位"]
    assert rows[0]["label"] == "张三"


def test_scene_entity_picker_label_inherits_character_name(qt_app, real_model) -> None:
    """NPC 没就地写 name 时显示名从角色注册表继承（与运行时合并口径一致）。"""
    from tools.editor.shared.scene_entity_picker import scene_speaker_entities
    real_model.scenes["甲村"]["npcs"][0].pop("name")
    rows = scene_speaker_entities(real_model, "甲村")
    assert rows[0]["label"] == "克拉拉"


def test_scene_entity_picker_dialog_pairs_scene_with_entity(qt_app, real_model) -> None:
    """弹窗的返回值必须是 (场景, 实体) 二元组——这是跨场景重名能选到的唯一原因。"""
    from tools.editor.shared.scene_entity_picker import SceneEntityPickerDialog
    dlg = SceneEntityPickerDialog(real_model, current_scene="乙镇", current_entity="npc_重名")
    try:
        assert dlg.selected() == ("乙镇", "npc_重名")
        # 换到甲村：同名实体是**另一个**，旧选择必须作废而不是跟着漂过去
        dlg._scene_filter.setText("甲村")
        QApplication.processEvents()
        dlg._scene_list.setCurrentRow(0)
        assert dlg.selected() == ("", "")
        dlg._on_canvas_picked("npc_重名")
        assert dlg.selected() == ("甲村", "npc_重名")
    finally:
        dlg.deleteLater()


# --------------------------------------------------------------------------- #
# 4) 实体重构跟随
# --------------------------------------------------------------------------- #

class _RefactorModel:
    """重构引擎消费面：两场景 + 同名实体 + 一份台词本。"""

    def __init__(self) -> None:
        self.scenes = {
            "甲村": {"npcs": [{"id": "npc_重名", "name": "甲", "x": 0, "y": 0}],
                     "hotspots": [], "zones": [], "spawnPoints": {}},
            "乙镇": {"npcs": [{"id": "npc_重名", "name": "乙", "x": 0, "y": 0}],
                     "hotspots": [], "zones": [], "spawnPoints": {}},
        }
        self.bubble_lines = {"lineSets": [
            {"id": "钉甲村", "speaker": {"kind": "entity", "id": "npc_重名"},
             "scenes": ["甲村"], "lines": [{"text": "甲"}]},
            {"id": "钉乙镇", "speaker": {"kind": "entity", "id": "npc_重名"},
             "scenes": ["乙镇"], "lines": [{"text": "乙"}]},
            {"id": "没钉场景", "speaker": {"kind": "entity", "id": "npc_重名"},
             "lines": [{"text": "老数据"}]},
            {"id": "角色档", "speaker": {"kind": "character", "characterId": "clara"},
             "lines": [{"text": "不该被实体改名碰到"}]},
        ]}
        self.pending_dialogue_stubs: dict[str, dict] = {}
        self.pending_dialogue_graph_edits: dict[str, dict] = {}
        self.dialogues_path = None
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, bucket: str, item: str = "") -> None:
        self.dirty.append((bucket, item))

    def _by_id(self, set_id: str) -> dict:
        return next(c for c in self.bubble_lines["lineSets"] if c["id"] == set_id)


def test_rename_follows_scene_pinned_speaker_even_when_id_not_unique() -> None:
    """钉死了场景＝零歧义：不看全局唯一性也照样跟随；别的场景那条一个字不动。"""
    m = _RefactorModel()
    rename_entity(m, "甲村", "npc", "npc_重名", "npc_甲")
    assert m._by_id("钉甲村")["speaker"]["id"] == "npc_甲"
    assert m._by_id("钉乙镇")["speaker"]["id"] == "npc_重名"
    # 没钉场景的那条是歧义面（id 不全局唯一）→ 留人工，不瞎改
    assert m._by_id("没钉场景")["speaker"]["id"] == "npc_重名"
    assert m._by_id("角色档")["speaker"] == {"kind": "character", "characterId": "clara"}


def test_rename_undo_restores_pinned_speaker() -> None:
    m = _RefactorModel()
    summary = rename_entity(m, "甲村", "npc", "npc_重名", "npc_甲")
    push_journal(m, summary)
    assert undo_last(m)["ok"]
    assert m._by_id("钉甲村")["speaker"]["id"] == "npc_重名"


def test_move_repins_scenes_and_undo_puts_it_back() -> None:
    """人搬到别的场景，台词本的 scenes 得跟着改钉，否则运行时整组不响。"""
    m = _RefactorModel()
    # 目标场景已有同 id 实体会被撞名闸拦，先把它清掉
    m.scenes["乙镇"]["npcs"] = []
    summary = move_entity(m, "甲村", "npc", "npc_重名", "乙镇")
    push_journal(m, summary)
    assert m._by_id("钉甲村")["scenes"] == ["乙镇"]
    assert m._by_id("没钉场景").get("scenes") is None
    assert undo_last(m)["ok"]
    assert m._by_id("钉甲村")["scenes"] == ["甲村"]


def test_scan_counts_pinned_and_bare_speakers() -> None:
    m = _RefactorModel()
    report = scan_entity_usages(m, "甲村", "npc", "npc_重名")
    # 钉甲村 + 没钉场景 = 2；钉乙镇那条指的是别的场景那一个，不算
    assert report["bubbleLineSpeakers"] == 2


# --------------------------------------------------------------------------- #
# 5) 选点画布的可用性行为（标签泛滥 / 筛选联动 / 悬停）
# --------------------------------------------------------------------------- #

def _label_all_max() -> int:
    from tools.editor.shared.scene_entity_picker import SceneEntityPickView
    return SceneEntityPickView.LABEL_ALL_MAX


def _pick_view(rows: list[dict]):
    from tools.editor.shared.scene_entity_picker import SceneEntityPickView
    v = SceneEntityPickView()
    v.setup_from_scene_json(_NoSceneModel(), "不存在的场景")   # 只要一块空画布
    v.set_entities(rows)
    return v


class _NoSceneModel:
    scenes: dict = {}

    class _Paths:
        def scene_runtime_asset(self, *_a, **_k):
            raise ValueError("no asset")

    paths = _Paths()


def _rows(n: int) -> list[dict]:
    return [{"kind": "npc", "id": f"e{i}", "label": f"名字{i}", "x": i * 10.0, "y": 0.0}
            for i in range(n)]


def test_labels_all_visible_when_few_entities(qt_app) -> None:
    v = _pick_view(_rows(5))
    try:
        assert all(v._labels[f"e{i}"].isVisible() for i in range(5))
    finally:
        v.deleteLater()


def test_labels_declutter_when_many_entities(qt_app) -> None:
    """雾津街头有 53 个说话人，全铺标签就是一团糊字——只留选中/悬停/命中筛选的。"""
    n = _label_all_max() + 5
    v = _pick_view(_rows(n))
    try:
        assert not any(v._labels[f"e{i}"].isVisible() for i in range(n))
        v.select_entity("e3")
        assert v._labels["e3"].isVisible()
        assert not v._labels["e4"].isVisible()
    finally:
        v.deleteLater()


def test_match_filter_dims_and_labels(qt_app) -> None:
    n = _label_all_max() + 5
    v = _pick_view(_rows(n))
    try:
        v.set_match_filter({"e1", "e2"})
        assert v._labels["e1"].isVisible() and v._labels["e2"].isVisible()
        assert not v._labels["e3"].isVisible()
        assert v._dots["e3"].brush().color().alpha() < v._dots["e1"].brush().color().alpha()
        v.set_match_filter(None)          # 清筛选 → 压暗撤销
        assert v._dots["e3"].brush().color().alpha() == v._dots["e1"].brush().color().alpha()
    finally:
        v.deleteLater()


def test_empty_click_keeps_selection(qt_app) -> None:
    """空白处误点不该把已选清掉（选择器保值）。"""
    v = _pick_view(_rows(3))
    try:
        v.select_entity("e1")
        v._handle_left_pick_world(99999.0, 99999.0)
        assert v.selected_entity() == "e1"
    finally:
        v.deleteLater()


def test_click_near_marker_picks_it(qt_app) -> None:
    v = _pick_view(_rows(3))
    got: list[str] = []
    v.entityPicked.connect(got.append)
    try:
        v._handle_left_pick_world(20.0, 0.0)   # e2 在 (20,0)
        assert v.selected_entity() == "e2"
        assert got == ["e2"]
    finally:
        v.deleteLater()


# --------------------------------------------------------------------------- #
# 6) 回归护栏：审查打回的两条 P0
# --------------------------------------------------------------------------- #

def test_switching_scene_rebuilds_markers_and_list(qt_app, real_model) -> None:
    """换场景必须把标记与实体列表整批换掉。

    回归的是一条**会被 Qt 槽吞掉异常**的崩溃：`setup_from_scene_json` 会 clear 整个
    QGraphicsScene，旧标记的 Python 包装器随之失效；清理时碰它就抛 RuntimeError，
    异常在槽里被吞 → 地图从此空白、实体列表停在上一个场景，而测试若只看返回值仍然绿。
    所以这里断言的是**可观察后果**（标记集合 / 列表内容），不是"有没有抛"。
    """
    from tools.editor.shared.scene_entity_picker import _VALUE_ROLE, SceneEntityPickerDialog
    dlg = SceneEntityPickerDialog(real_model, current_scene="甲村")
    try:
        assert set(dlg._view._dots) == {"npc_张三", "npc_重名", "hs_摊位"}
        rows = [dlg._scene_list.item(i) for i in range(dlg._scene_list.count())]
        target = next(i for i, it in enumerate(rows) if it.data(_VALUE_ROLE) == "乙镇")
        dlg._scene_list.setCurrentRow(target)
        QApplication.processEvents()
        assert set(dlg._view._dots) == {"npc_重名"}, "换场景后地图标记没跟着换"
        listed = [dlg._entity_list.item(i).data(_VALUE_ROLE)
                  for i in range(dlg._entity_list.count())]
        assert listed == ["npc_重名"], "换场景后实体列表还停在上一个场景"
    finally:
        dlg.deleteLater()


def test_scene_filter_does_not_blank_the_map(qt_app, real_model) -> None:
    """在场景筛选框里敲字会触发整表重建 → 顺带重画地图，同一条崩溃路径。

    ⚠ 这里**不能只比 id 集合**：崩溃发生在字典被清空之前，键集合原封不动，而图元早已
    是一批死指针（C++ 侧已删、也不在当前 scene 上）——地图肉眼全空，断言却恒绿。
    判据必须是"标记还活着、且还挂在当前这张 scene 上"。
    """
    from shiboken6 import isValid
    from tools.editor.shared.scene_entity_picker import SceneEntityPickerDialog
    dlg = SceneEntityPickerDialog(real_model, current_scene="甲村")
    try:
        dlg._scene_filter.setText("甲")
        QApplication.processEvents()
        assert set(dlg._view._dots) == {"npc_张三", "npc_重名", "hs_摊位"}
        gfx = dlg._view.scene()
        for eid, dot in dlg._view._dots.items():
            assert isValid(dot), f"{eid} 的标记已被 C++ 侧销毁（地图实际是空的）"
            assert dot.scene() is gfx, f"{eid} 的标记不在当前画布上"
        for eid, label in dlg._view._labels.items():
            assert isValid(label) and label.scene() is gfx, f"{eid} 的标签已失效"
    finally:
        dlg.deleteLater()


def test_switching_speaker_kind_never_destroys_the_committed_speaker(qt_app, real_model) -> None:
    """只把类型下拉一拨（还没选新值）不许写盘——本编辑器无撤销，写半截＝销毁作者的配置。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_张三"},
                               "scenes": ["甲村"], "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        ed._f_speaker_kind.setCurrentIndex(ed._f_speaker_kind.findData("character"))
        assert not ed._set_dirty(), "只拨了类型、还没选角色，就已经算改动了"
        ed.flush_to_model()
        assert real_model.bubble_lines["lineSets"][0]["speaker"] == {"kind": "entity", "id": "npc_张三"}
        assert ed._speaker_hint.isVisible() or ed._speaker_hint.text(), "没告诉用户这次没写盘"
    finally:
        ed.deleteLater()


def test_entity_field_has_no_dead_clear_button(qt_app, real_model) -> None:
    """说话人必填 ⇒ "清空"永远落不了盘。与其留个按了等于没按的按钮，不如不给。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_张三"},
                               "scenes": ["甲村"], "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        assert not hasattr(ed._f_entity, "_clear_btn")
        ed._f_entity._clear()          # 直接调也不许把值抹掉
        ed._apply()
        assert real_model.bubble_lines["lineSets"][0]["speaker"] == {"kind": "entity", "id": "npc_张三"}
    finally:
        ed.deleteLater()


def test_new_line_set_defaults_to_a_valid_speaker(qt_app, real_model) -> None:
    """新建条目不许当场造出一条 validate-data error（半截 speaker）。"""
    ed = _editor(real_model, [])
    try:
        ed._add()
        assert real_model.bubble_lines["lineSets"][0]["speaker"] == {"kind": "player"}
    finally:
        ed.deleteLater()


def test_scene_rows_row_height_survives_mode_switching(qt_app, real_model) -> None:
    """「限定场景」整行不许被压塌。

    根因是"容器隐藏期间往里加子控件、事后再 show"——隐藏 widget 的 updateGeometry
    不向上传播。踩过一次：实测 sizeHint 74px、实际只给 34px，整行成一条缝。
    """
    ed = _editor(real_model, [
        {"id": "ent", "speaker": {"kind": "entity", "id": "npc_张三"},
         "scenes": ["甲村"], "lines": _ok_lines()},
        {"id": "chr", "speaker": {"kind": "character", "characterId": "clara"},
         "scenes": ["甲村", "乙镇"], "lines": _ok_lines()},
    ])
    try:
        ed.resize(1180, 760)
        ed.show()
        host = ed._scenes_rows_host.parentWidget()
        for _ in range(3):
            for row in (0, 1):
                ed._list.setCurrentRow(row)
                # 两轮：首帧布局还在沉降（实测差 3px），第二轮才是稳态
                QApplication.processEvents()
                QApplication.processEvents()
                assert host.height() >= host.sizeHint().height(), (
                    f"第 {row} 条下「限定场景」被压塌："
                    f"给了 {host.height()}px、要 {host.sizeHint().height()}px"
                )
    finally:
        ed.deleteLater()


def test_scene_rows_edit_cannot_silently_unpin_an_entity_speaker(qt_app, real_model) -> None:
    """拨到「角色」但没选角色时 speaker 仍是实体——此时删场景行不许把它的场景钉抹掉。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "entity", "id": "npc_张三"},
                               "scenes": ["甲村"], "lines": _ok_lines()}])
    try:
        ed._list.setCurrentRow(0)
        ed._f_speaker_kind.setCurrentIndex(ed._f_speaker_kind.findData("character"))
        ed._clear_scene_rows()          # 等价于把那一行 × 掉
        ed._apply()
        c = real_model.bubble_lines["lineSets"][0]
        assert c["speaker"] == {"kind": "entity", "id": "npc_张三"}
        assert c["scenes"] == ["甲村"], "speaker 还是实体，场景钉却被抹了"
    finally:
        ed.deleteLater()


def test_no_speaker_hint_on_an_unselected_form(qt_app, real_model) -> None:
    """没选中任何条目时右侧是禁用空表单，不该亮着"还没选角色"的橙字。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "player"}, "lines": _ok_lines()}])
    try:
        ed.show()
        QApplication.processEvents()
        assert not ed._speaker_hint.isVisible()
    finally:
        ed.deleteLater()


def test_bubble_speaker_action_candidates_include_hotspots(qt_app, real_model) -> None:
    """热点也能冒气泡：候选面漏了它，"热点说话人"的 setBubbleLineSet 就配不出来。"""
    from tools.editor.shared.action_editor import ActionRow
    row = ActionRow({"type": "setBubbleLineSet", "params": {}}, model=real_model, scene_id="甲村")
    try:
        w = row._param_widgets.get("target")
        assert w is not None
        values = set(w._ids)
        assert "hs_摊位" in values, f"热点不在候选里：{sorted(v for v in values if v)}"
        assert "character:clara" in values
        assert "player" in values
    finally:
        row.deleteLater()


def test_open_page_shows_a_disabled_empty_form(qt_app, real_model) -> None:
    """开页没选条目时右侧必须是禁用的空表单，而不是两档都摊开、点 Apply 无声无息。"""
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "player"}, "lines": _ok_lines()}])
    try:
        assert not ed._right_host.isEnabled()
        assert not ed._apply_btn.isEnabled()
    finally:
        ed.deleteLater()


def test_broken_speaker_shape_is_passed_through_not_crashed(qt_app, real_model) -> None:
    """手写坏了的 speaker（不是 dict）只读透传：既不许崩，也不许被这一次保存改形状。"""
    ed = _editor(real_model, [
        {"id": "ok", "speaker": {"kind": "player"}, "lines": _ok_lines()},
        {"id": "broken", "speaker": "关二狗", "scenes": ["甲村"], "lines": _ok_lines()},
    ])
    try:
        ed._list.setCurrentRow(0)
        ed._list.setCurrentRow(1)
        # 表单表达不了这个形状 → 说话人档落到"实体档但没选出实体"，正好命中"不写"规则；
        # 其余字段（台词/冷却…）照常可编辑，不为一个坏键把整条锁死
        assert ed._f_entity.entity_id() == ""
        assert not ed._set_dirty(), "坏 speaker 打开即脏"
        ed.flush_to_model()
        assert real_model.bubble_lines["lineSets"][1]["speaker"] == "关二狗"
        assert real_model.bubble_lines["lineSets"][1]["scenes"] == ["甲村"]
    finally:
        ed.deleteLater()


def test_added_scene_row_counts_toward_size_immediately(qt_app, real_model) -> None:
    """新加的场景行必须**当场**算进容器尺寸，不能等下一轮事件循环。

    `layout.addWidget` 之后子控件仍是 `isHidden()`，而隐藏项会被 QVBoxLayout 整个跳过
    ⇒ 容器 sizeHint 当场是 0，同一回合算出来的行高按"零行"给，用户看到的就是
    "刚点开这条时「限定场景」是一条缝"。判别力：拿掉 `_add_scene_row` 里的 `host.show()`
    这条立刻变红（sizeHint 高 = 0）。
    """
    ed = _editor(real_model, [{"id": "a", "speaker": {"kind": "character", "characterId": "clara"},
                               "scenes": ["甲村", "乙镇"], "lines": _ok_lines()}])
    try:
        ed.show()
        ed._list.setCurrentRow(0)          # 刻意**不** processEvents
        assert len(ed._scene_rows) == 2
        assert ed._scenes_rows_host.sizeHint().height() > 0, (
            "场景行加进去了却不算尺寸——行高会按零行给"
        )
        assert not ed._scene_rows[0]["widget"].isHidden()
    finally:
        ed.deleteLater()


def test_qt_formlayout_row_collapses_without_explicit_relayout(qt_app) -> None:
    """机制留证：为什么 `_relayout_scene_rows` 必须存在（与本项目代码无关的纯 Qt 行为）。

    结构 QFormLayout → host → 中间层 → rows；在中间层**隐藏期间**往 rows 里加控件，
    再 show 出来：不补 relayout 行高冻在旧值，补了就对。下一个人想删掉那个 helper
    之前，先看这条。
    """
    from PySide6.QtWidgets import QFormLayout, QLabel, QVBoxLayout, QWidget

    def build(relayout: bool) -> tuple[int, int]:
        root = QWidget()
        form = QFormLayout(root)
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint)
        host = QWidget()
        hl = QVBoxLayout(host)
        hl.setContentsMargins(0, 0, 0, 0)
        mid = QWidget()
        ml = QVBoxLayout(mid)
        ml.setContentsMargins(0, 0, 0, 0)
        hl.addWidget(mid)
        rows = QWidget()
        rl = QVBoxLayout(rows)
        rl.setContentsMargins(0, 0, 0, 0)
        ml.addWidget(rows)
        form.addRow("行", host)
        root.resize(500, 300)
        root.show()
        QApplication.processEvents()
        mid.setVisible(False)
        QApplication.processEvents()
        for i in range(3):                      # 隐藏期间加子控件
            w = QLabel(f"第{i}行")
            rl.addWidget(w)
            w.show()
        if relayout:
            rows.updateGeometry()
            host.updateGeometry()
            form.invalidate()
        mid.setVisible(True)
        QApplication.processEvents()
        QApplication.processEvents()
        got = (host.height(), host.sizeHint().height())
        root.deleteLater()
        QApplication.processEvents()
        return got

    collapsed_h, collapsed_want = build(relayout=False)
    fixed_h, fixed_want = build(relayout=True)
    assert collapsed_h < collapsed_want, (
        f"Qt 行为变了：不补 relayout 也没塌（{collapsed_h}/{collapsed_want}）——"
        "若确已修复可删掉 _relayout_scene_rows，但要先在真编辑器上复验"
    )
    assert fixed_h >= fixed_want, f"补了 relayout 仍塌：{fixed_h}/{fixed_want}"
