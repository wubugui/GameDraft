"""信号改名 / 删除要级联到宿主身上可燃配置的 ``burnable.signals``（A3.8 模板 + 实例）。

可燃实例点着 / 烧完 / 熄灭时由 BurnSystem 真发这些信号；改名不改写它们 = 发射端悄悄悬垂，
叙事状态机永远等不到；删除不清它们 = 留一个指向不存在信号的发射点。四类宿主都要覆盖：
热点 / NPC（场景 JSON）、挂件预设、轨迹生成规格（动作树里 ``playTrajectory.params.spawn``）。
"""
from __future__ import annotations

from copy import deepcopy

from tools.editor.shared.signal_refactor import delete_signal, rename_signal, scan_signal_usages, undo_delete
from tools.editor.tests.test_signal_refactor import FakeModel


def _model() -> FakeModel:
    m = FakeModel()
    m.scenes = {
        "场景1": {
            "hotspots": [{"id": "pile", "burnable": {"template": "paper_pile",
                                                     "signals": {"ignited": "sig_b", "burntOut": "sig_b"}}}],
            "npcs": [{"id": "figure", "burnable": {"template": "paper_pile", "signals": {"extinguished": "sig_b"}}}],
            "zones": [{"id": "z1", "onEnter": [{"type": "playTrajectory", "params": {
                "trajectory": "t", "spawn": {"id": "dyn", "keep": True,
                                             "burnable": {"template": "candle_red", "signals": {"ignited": "sig_b"}}}}}]}],
        },
    }
    m.prop_presets = {"xiang": {"burnable": {"template": "incense_stick", "signals": {"burntOut": "sig_b"}}}}
    return m


def test_scan_counts_every_burnable_host_signal() -> None:
    m = _model()
    usages = scan_signal_usages(m, "sig_b")
    by_attr = {(a["attr"], a["itemId"]): a["count"] for a in usages["assets"]}
    assert by_attr[("scenes", "场景1")] == 4
    assert by_attr[("prop_presets", "xiang")] == 1


def test_rename_rewrites_burnable_signals_everywhere() -> None:
    m = _model()
    rename_signal(m, "sig_b", "sig_b2")
    sc = m.scenes["场景1"]
    assert sc["hotspots"][0]["burnable"]["signals"] == {"ignited": "sig_b2", "burntOut": "sig_b2"}
    assert sc["npcs"][0]["burnable"]["signals"] == {"extinguished": "sig_b2"}
    assert sc["zones"][0]["onEnter"][0]["params"]["spawn"]["burnable"]["signals"] == {"ignited": "sig_b2"}
    assert m.prop_presets["xiang"]["burnable"]["signals"] == {"burntOut": "sig_b2"}
    assert ("prop_presets", "") in m.dirty


def test_delete_clears_burnable_signals_and_undo_restores_exactly() -> None:
    m = _model()
    before_scenes, before_props = deepcopy(m.scenes), deepcopy(m.prop_presets)
    _, undo = delete_signal(m, "sig_b", force=True)
    sc = m.scenes["场景1"]
    assert sc["hotspots"][0]["burnable"] == {"template": "paper_pile", "signals": {}}
    assert sc["npcs"][0]["burnable"]["signals"] == {}
    assert sc["zones"][0]["onEnter"][0]["params"]["spawn"]["burnable"]["signals"] == {}
    assert m.prop_presets["xiang"]["burnable"]["signals"] == {}
    assert scan_signal_usages(m, "sig_b")["totalRefs"] == 0
    undo_delete(m, undo)
    assert m.scenes == before_scenes
    assert m.prop_presets == before_props


def test_block_without_template_is_not_an_emitter() -> None:
    """没写 template 的块运行时不建实例、不发信号——与目录 / xref 同口径，不算引用。"""
    m = FakeModel()
    m.scenes = {"场景1": {"hotspots": [{"id": "h", "burnable": {"signals": {"ignited": "sig_b"}}}]}}
    assert scan_signal_usages(m, "sig_b")["totalRefs"] == 0
