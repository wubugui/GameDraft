"""场景实体批量盖状态机模板：产物声明、实体推导、全有全无暂存、来源戳，以及右键入口流程探针。

模型层绿灯不算数（norms 过程义务 3）：最后两个用例从**场景编辑器右键菜单那一层**进，
断言模型真被暂存、以及叙事页开着草稿时会被拦住。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication, QDialog

from tools.editor.project_model import ProjectModel
from tools.editor.shared.narrative_template_batch import (
    apply_batch_stamp,
    bound_param_names,
    free_params,
    plan_batch_stamp,
    scene_entity_targets,
)
from tools.editor.shared.narrative_templates import (
    normalize_template,
    stamp_template,
    template_produces,
    validate_template,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


# --------------------------------------------------------------------------- #
# 夹具：100 个箱子共用一条私有信号 + 一张发射端对话图，各自只要**一张**图
# --------------------------------------------------------------------------- #
def _chest_template() -> dict:
    return {
        "id": "chest_archetype",
        "label": "箱子状态机",
        "version": 3,
        "produces": ["composition"],
        "params": [
            {"name": "ownerId", "type": "identifier", "from": "entity.id", "required": True},
            {"name": "ownerType", "type": "identifier", "from": "entity.kind", "required": True},
            {"name": "openSignal", "type": "identifier", "default": "chest_opened"},
        ],
        "composition": {
            "id": "chest_{{ownerId}}",
            "label": "箱子 {{ownerId}}",
            # mainGraph 直接绑实体：运行时 indexGraphOwner 对每张注册图一视同仁，
            # 私有信号投递面（getGraphIdsByOwner）因此认得它。
            "mainGraph": {
                "id": "chest_{{ownerId}}_state",
                "ownerType": "{{ownerType}}",
                "ownerId": "{{ownerId}}",
                "initialState": "closed",
                "states": {"closed": {"id": "closed"}, "opened": {"id": "opened"}},
                "transitions": [
                    {"id": "t_open", "from": "closed", "to": "opened", "signal": "{{openSignal}}"},
                ],
            },
            "elements": [],
        },
    }


def _three_products_template() -> dict:
    """老式模板：没有 produces 声明，骨架里有什么就盖什么（向后兼容基线）。"""
    return {
        "id": "task_archetype",
        "params": [{"name": "taskId", "type": "identifier", "required": True}],
        "signals": [{"id": "{{taskId}}__accepted"}],
        "composition": {
            "id": "flow_{{taskId}}",
            "mainGraph": {
                "id": "flow_{{taskId}}_graph", "ownerType": "flow", "ownerId": "{{taskId}}",
                "initialState": "a",
                "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                "transitions": [
                    {"id": "t1", "from": "a", "to": "b", "signal": "{{taskId}}__accepted"},
                ],
            },
            "elements": [{
                "id": "dlg", "kind": "dialogueBlackbox", "refId": "dlg_{{taskId}}",
                "meta": {"emits": ["{{taskId}}__accepted"]},
            }],
        },
        "quest": {"id": "q_{{taskId}}", "title": "{{taskId}}"},
        "dialogueStubs": [{"id": "dlg_{{taskId}}", "emitSignal": "{{taskId}}__accepted"}],
    }


def _scene_with_chests(sid: str, count: int) -> dict:
    return {
        "id": sid, "name": sid,
        "hotspots": [
            {"id": f"chest_{i}", "type": "inspect", "label": f"箱子{i}",
             "x": 10 * i, "y": 10, "interactionRange": 50, "data": {"text": ""}}
            for i in range(1, count + 1)
        ],
        "npcs": [],
        "zones": [],
        "spawnPoints": {"door": {"x": 0, "y": 0}},
    }


def _project(root: Path, *, chests: int = 3, template: dict | None = None) -> ProjectModel:
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    model.scenes = {"sc_a": _scene_with_chests("sc_a", chests)}
    model.narrative_graphs = {
        "schemaVersion": 3,
        # 100 个箱子共用**一个**信号名，声明为私有；它由那张共用对话图发出。
        "signals": [{"id": "chest_opened", "label": "开箱", "scope": "private"}],
        "compositions": [],
    }
    model.narrative_templates = {
        "schemaVersion": 1,
        "templates": [normalize_template(template or _chest_template())],
    }
    model._dirty.clear()
    return model


# --------------------------------------------------------------------------- #
# 产物声明
# --------------------------------------------------------------------------- #
def test_produces_defaults_to_whatever_the_skeleton_has() -> None:
    tpl = normalize_template(_three_products_template())
    assert template_produces(tpl) == ["composition", "quest", "dialogueStubs"]
    res = stamp_template(tpl, {"taskId": "淹尸活"}, generate_dialogue_stubs=True)
    assert res["ok"], res["errors"]
    assert res["questId"] == "q_淹尸活"
    assert [s["id"] for s in res["dialogueStubs"]] == ["dlg_淹尸活"]


def test_declared_produces_limits_the_stamp_to_one_graph() -> None:
    """箱子模板只声明 composition：quest / 对话桩连替换都不做。"""
    tpl = normalize_template(_chest_template())
    assert template_produces(tpl) == ["composition"]
    res = stamp_template(tpl, {"ownerId": "chest_1", "ownerType": "hotspot", "openSignal": "chest_opened"},
                         generate_dialogue_stubs=True)
    assert res["ok"], res["errors"]
    assert res["quest"] is None and res["questId"] == ""
    assert res["dialogueStubs"] == []


def test_declared_produces_suppresses_skeletons_that_do_exist() -> None:
    """真正的判据：骨架里**有** quest / 对话桩，但 produces 只声明 composition —— 就只能盖一张图。

    （箱子模板没有那两样，所以它自己证明不了声明生效；这里用三产物模板加声明来卡。）
    """
    tpl = normalize_template({**_three_products_template(), "produces": ["composition"]})
    assert template_produces(tpl) == ["composition"]
    res = stamp_template(tpl, {"taskId": "淹尸活"}, generate_dialogue_stubs=True)
    assert res["ok"], res["errors"]
    assert res["quest"] is None and res["questId"] == ""
    assert res["dialogueStubs"] == []


def test_declaring_a_product_without_a_skeleton_is_an_error() -> None:
    tpl = normalize_template({**_chest_template(), "produces": ["composition", "quest"]})
    codes = [i["code"] for i in validate_template(tpl)]
    assert "template.produces.missing" in codes


def test_skeleton_present_but_not_declared_is_a_warning() -> None:
    tpl = normalize_template({**_three_products_template(), "produces": ["composition"]})
    rows = [i for i in validate_template(tpl) if i["code"] == "template.produces.unused"]
    assert len(rows) == 2 and all(r["severity"] == "warning" for r in rows)


def test_unknown_produce_entry_is_reported_from_raw_input() -> None:
    from tools.editor.shared.narrative_templates import validate_templates_file

    raw = {"templates": [{**_chest_template(), "produces": ["composition", "sprites"]}]}
    codes = [i["code"] for i in validate_templates_file(raw)]
    assert "template.produces.unknown" in codes
    # normalize 只留合法项，不把整条声明丢掉
    assert normalize_template(raw["templates"][0])["produces"] == ["composition"]


def test_every_ref_param_type_has_a_model_backed_provider() -> None:
    """镜像对账（norms 不变量 8）：引用型参数一个都不许落到裸输入框。"""
    from tools.editor.shared.narrative_template_batch_dialog import _REF_PROVIDERS
    from tools.editor.shared.narrative_templates import REF_PARAM_CATALOG_KEY

    assert set(REF_PARAM_CATALOG_KEY) == set(_REF_PROVIDERS)


def test_ref_providers_run_against_a_real_model() -> None:
    """候选取自 ProjectModel：provider 名字打错会在这里现形（返回空表也算过不去）。"""
    from tools.editor.shared.narrative_template_batch_dialog import _REF_PROVIDERS

    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=1)
        model.scenes["sc_a"]["zones"] = [{"id": "z1", "polygon": []}]
        for ptype, fn in _REF_PROVIDERS.items():
            assert isinstance(list(fn(model) or []), list), ptype
        assert [r[0] for r in _REF_PROVIDERS["zoneRef"](model)] == ["z1"]
        assert [r[0] for r in _REF_PROVIDERS["hotspotRef"](model)] == ["chest_1"]


def test_unknown_param_source_is_an_error() -> None:
    tpl = _chest_template()
    tpl["params"][0]["from"] = "entity.uuid"
    codes = [i["code"] for i in validate_template(normalize_template(tpl))]
    assert "template.param.from.unknown" in codes


# --------------------------------------------------------------------------- #
# 实体推导 / 批量盖章
# --------------------------------------------------------------------------- #
def test_targets_only_take_supported_entity_kinds() -> None:
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=2)
        refs = [("hotspot", "chest_1"), ("spawn", "door"), ("hotspot", "缺席"), ("hotspot", "chest_2")]
        targets = scene_entity_targets(model, "sc_a", refs)
        assert [t["id"] for t in targets] == ["chest_1", "chest_2"]
        assert targets[0] == {"kind": "hotspot", "id": "chest_1", "label": "箱子1", "sceneId": "sc_a"}


def test_bound_params_are_hidden_from_the_form() -> None:
    tpl = normalize_template(_chest_template())
    assert bound_param_names(tpl) == {"ownerId": "entity.id", "ownerType": "entity.kind"}
    assert [p["name"] for p in free_params(tpl)] == ["openSignal"]


def test_batch_stamp_derives_id_and_owner_from_each_entity() -> None:
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=3)
        targets = scene_entity_targets(model, "sc_a", [("hotspot", f"chest_{i}") for i in (1, 2, 3)])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        assert plan["ok"], plan["errors"]
        assert [i["compositionId"] for i in plan["items"]] == ["chest_chest_1", "chest_chest_2", "chest_chest_3"]
        graphs = [c["mainGraph"] for c in plan["narrative"]["compositions"]]
        assert [g["ownerId"] for g in graphs] == ["chest_1", "chest_2", "chest_3"]
        assert {g["ownerType"] for g in graphs} == {"hotspot"}
        # 三张图听的是**同一个**私有信号名——这正是私有信号存在的理由
        assert {t["signal"] for g in graphs for t in g["transitions"]} == {"chest_opened"}


def test_entity_binding_beats_a_stale_form_value() -> None:
    """表单里混进同名残值时，实体推导必须**覆盖**它——否则 100 个箱子会共用一个 ownerId，
    owner 索引全打到同一个实体上，等于这套机制白做。"""
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=2)
        targets = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1"), ("hotspot", "chest_2")])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {
            "openSignal": "chest_opened",
            "ownerId": "残值_不该生效",
            "ownerType": "npc",
        })
        assert plan["ok"], plan["errors"]
        graphs = [c["mainGraph"] for c in plan["narrative"]["compositions"]]
        assert [g["ownerId"] for g in graphs] == ["chest_1", "chest_2"]
        assert {g["ownerType"] for g in graphs} == {"hotspot"}


def test_plan_is_side_effect_free_until_applied() -> None:
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=2)
        targets = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1")])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        assert plan["ok"]
        assert model.narrative_graphs["compositions"] == []
        assert not model.is_dirty

        apply_batch_stamp(model, plan)
        assert [c["id"] for c in model.narrative_graphs["compositions"]] == ["chest_chest_1"]
        assert "narrative_graphs" in model._dirty


def test_batch_internal_id_collision_aborts_everything() -> None:
    """两个实体推出同一个作曲 id（这里靠重复 ref 制造）不许静默盖出两条同 id 作曲。"""
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=1)
        target = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1")])[0]
        plan = plan_batch_stamp(model, "chest_archetype", [target, dict(target)],
                                {"openSignal": "chest_opened"})
        assert not plan["ok"]
        assert any("已存在" in e for e in plan["errors"]), plan["errors"]
        assert model.narrative_graphs["compositions"] == []


def test_one_bad_target_aborts_the_whole_batch() -> None:
    """全有全无：第三个实体撞上已存在的作曲 id，前两个也一份都不落。"""
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=3)
        model.narrative_graphs["compositions"].append({
            "id": "chest_chest_3",
            "mainGraph": {"id": "占位", "initialState": "s", "states": {"s": {"id": "s"}}, "transitions": []},
            "elements": [],
        })
        targets = scene_entity_targets(model, "sc_a", [("hotspot", f"chest_{i}") for i in (1, 2, 3)])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        assert not plan["ok"]
        assert apply_batch_stamp(model, plan) is plan
        assert [c["id"] for c in model.narrative_graphs["compositions"]] == ["chest_chest_3"]
        assert not model.is_dirty


def test_merged_result_must_pass_the_save_path_validator() -> None:
    """盖出来的东西过不了保存期校验 = 一份都不落（不能把坏作曲塞进模型等 Save All 才炸）。"""
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=1)
        tpl = _chest_template()
        # initialState 指向不存在的状态：结构性 error
        tpl["composition"]["mainGraph"]["initialState"] = "不存在的状态"
        model.narrative_templates = {"schemaVersion": 1, "templates": [normalize_template(tpl)]}
        targets = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1")])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        assert not plan["ok"]
        assert any("校验失败" in e for e in plan["errors"]), plan["errors"]
        assert model.narrative_graphs["compositions"] == []


def test_stamped_products_record_source_template_and_version() -> None:
    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=2)
        targets = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1"), ("hotspot", "chest_2")])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        assert plan["ok"], plan["errors"]
        for comp in plan["narrative"]["compositions"]:
            assert comp["stampedFrom"] == {"templateId": "chest_archetype", "templateVersion": 3}


def test_single_stamp_bridge_also_records_provenance() -> None:
    """叙事页那条单张盖章的路必须同样打戳——两条写模型的路不能只有一条记来源。"""
    from tools.editor.editors.narrative_state_editor import NarrativeEditorBridge

    with TemporaryDirectory() as td:
        model = _project(Path(td) / "p", chests=1)
        bridge = NarrativeEditorBridge(model)
        payload = json.dumps({
            "templateId": "chest_archetype",
            "values": {"ownerId": "chest_1", "ownerType": "hotspot", "openSignal": "chest_opened"},
        }, ensure_ascii=False)
        result = json.loads(bridge.stampTemplate(payload))
        assert result["ok"], result
        stamped = next(c for c in result["narrative"]["compositions"] if c["id"] == "chest_chest_1")
        assert stamped["stampedFrom"] == {"templateId": "chest_archetype", "templateVersion": 3}
        assert result["summary"]["questStaged"] is False


def test_save_all_lands_batch_products_on_disk() -> None:
    with TemporaryDirectory() as td:
        root = Path(td) / "p"
        model = _project(root, chests=2)
        targets = scene_entity_targets(model, "sc_a", [("hotspot", "chest_1"), ("hotspot", "chest_2")])
        plan = plan_batch_stamp(model, "chest_archetype", targets, {"openSignal": "chest_opened"})
        apply_batch_stamp(model, plan)
        model.save_all()
        disk = json.loads(
            (root / "public/assets/data/narrative_graphs.json").read_text(encoding="utf-8"),
        )
        assert [c["id"] for c in disk["compositions"]] == ["chest_chest_1", "chest_chest_2"]
        assert disk["signals"][0]["scope"] == "private"


# --------------------------------------------------------------------------- #
# 场景编辑器右键入口（流程探针：从最外层用户入口进）
# --------------------------------------------------------------------------- #
class SceneEditorBatchStampEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path):
        from tools.editor.editors.scene_editor import SceneEditor

        model = _project(root, chests=3)
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    def _select(self, ed, ids: list[str]) -> None:
        for item in ed._iter_entity_tree_items():
            data = item.data(0, __import__("PySide6.QtCore", fromlist=["Qt"]).Qt.ItemDataRole.UserRole)
            if data and tuple(data)[0] == "hotspot" and tuple(data)[1] in ids:
                item.setSelected(True)
        QApplication.processEvents()

    def test_context_menu_dispatches_to_the_batch_handler(self) -> None:
        """从右键菜单这一层进：菜单项在、可用，**且真的派发到那个处理函数**。

        `QMenu.exec` 在 PySide 里打桩不掉（打了就是离屏永久阻塞），所以按既有
        `build_group_context_menu` 先例把「构菜单」与「exec」分开，两侧各验一半。
        """
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            self._select(ed, ["chest_1"])
            menu = ed.build_entity_tree_context_menu(ed._tree_selected_refs())
            act = next((a for a in menu.actions() if str(a.data()) == "template"), None)
            self.assertIsNotNone(act, [a.text() for a in menu.actions()])
            self.assertEqual(act.text(), "应用状态机模板…")
            self.assertTrue(act.isEnabled(), "选中热点时该项必须可用")
            menu.deleteLater()

            called: list[bool] = []
            ed._apply_state_machine_template_to_selection = lambda: called.append(True)
            ed._run_tree_context_action("template")
            self.assertEqual(called, [True], "菜单项没接到批量盖章处理函数")

    def test_context_menu_entry_is_disabled_for_spawn_only_selection(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            menu = ed.build_entity_tree_context_menu([("spawn", "door")])
            act = next(a for a in menu.actions() if str(a.data()) == "template")
            self.assertFalse(act.isEnabled(), "只选出生点时不该能盖状态机模板")
            menu.deleteLater()

    def test_entry_stages_one_graph_per_selected_entity(self) -> None:
        from tools.editor.shared import narrative_template_batch_dialog as dlg_mod

        # 终审复审 G-1：此前这里没挂宿主——H6 哨兵（找不到主窗 = 按"有草稿"拦）会弹
        # QMessageBox.warning，而用例只打桩了 information：离屏下模态 exec() 永不返回，
        # 整跑挂死 15 分钟（不打桩必挂死、只打桩必被闸拦而失败）。happy path 必须挂一个
        # **干净**叙事页的宿主（_web_editor_dirty_state 恰好返回 False——闸门判据是
        # `is not False`），warning 仍打桩兜底：闸若误拦，失败信息里能看到拦的文案。
        class _FakeHost:
            def __init__(self, page): self._editor_instances = [page]
            def parent(self): return None

        class _FakeCleanNarrativePage:
            def _web_editor_dirty_state(self): return False

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select(ed, ["chest_1", "chest_2", "chest_3"])
            ed.parent = lambda: _FakeHost(_FakeCleanNarrativePage())
            real_exec = dlg_mod.NarrativeTemplateBatchDialog.exec
            dlg_mod.NarrativeTemplateBatchDialog.exec = (
                lambda d: (d._refresh_preview(), QDialog.DialogCode.Accepted)[1]
            )
            boxes: list[str] = []
            from PySide6.QtWidgets import QMessageBox

            real_info = QMessageBox.information
            real_warn = QMessageBox.warning
            QMessageBox.information = staticmethod(lambda *a, **k: boxes.append(str(a[2])))
            QMessageBox.warning = staticmethod(lambda *a, **k: boxes.append(str(a[2])))
            try:
                ed._apply_state_machine_template_to_selection()
            finally:
                dlg_mod.NarrativeTemplateBatchDialog.exec = real_exec
                QMessageBox.information = real_info
                QMessageBox.warning = real_warn
            ids = [c["id"] for c in model.narrative_graphs["compositions"]]
            self.assertEqual(ids, ["chest_chest_1", "chest_chest_2", "chest_chest_3"], boxes)
            self.assertIn("narrative_graphs", model._dirty)
            # 零磁盘写：落盘只经 Save All
            self.assertFalse(
                (Path(td) / "p/public/assets/data/narrative_graphs.json").exists()
                and json.loads((Path(td) / "p/public/assets/data/narrative_graphs.json")
                               .read_text(encoding="utf-8")).get("compositions"),
            )

    def test_entry_refuses_while_narrative_page_holds_an_unsaved_draft(self) -> None:
        """叙事页开着草稿时必须拦住：那边下次保存会把这一批作曲整份覆盖掉。"""
        from PySide6.QtWidgets import QMessageBox

        from tools.editor.shared import narrative_template_batch_dialog as dlg_mod

        class _FakeHost:
            def __init__(self, page): self._editor_instances = [page]
            def parent(self): return None

        class _FakeNarrativePage:
            def _web_editor_dirty_state(self): return True

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select(ed, ["chest_1"])
            host = _FakeHost(_FakeNarrativePage())
            ed.parent = lambda: host
            warned: list[str] = []
            real_warn = QMessageBox.warning
            QMessageBox.warning = staticmethod(lambda *a, **k: warned.append(str(a[2])))
            # 兜底打桩：闸门若被拆掉，模态 exec() 在离屏下永不返回、整跑挂死而不是失败
            # （见 editor-change-verification-gate「新加确认弹窗 = 可能挂死既有测试」）。
            real_exec = dlg_mod.NarrativeTemplateBatchDialog.exec
            dlg_mod.NarrativeTemplateBatchDialog.exec = lambda _d: QDialog.DialogCode.Rejected
            try:
                ed._apply_state_machine_template_to_selection()
            finally:
                QMessageBox.warning = real_warn
                dlg_mod.NarrativeTemplateBatchDialog.exec = real_exec
            self.assertTrue(warned and "未保存的草稿" in warned[0], warned)
            self.assertEqual(model.narrative_graphs["compositions"], [])


if __name__ == "__main__":
    unittest.main()
