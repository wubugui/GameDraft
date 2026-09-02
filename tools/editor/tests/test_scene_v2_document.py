"""新画布骨架的五条验收 —— 方案书 §5.3。

这五条不是"覆盖率"，是**架构是否成立的判据**。每一条对应老画布的一类顽疾；
任一条红了，就说明 Document–View–Command 在这里没有真正落地，而只是换了个文件名。

| 验收 | 对应老画布的哪一类 bug |
|---|---|
| `write_target` 两条分支 | 写错副本 / 整组拖动少一个成员跟上 / 拖完面板数字弹回 |
| 零变更不入栈不标脏 | 只是点一下看属性，坐标被写、场景变脏、整数漂成小数 |
| 连续手势合并成一条 | 按住方向键一秒，要按 30 次 Ctrl+Z |
| undo/redo 发同类型事件 | 正着改能刷新、撤回来画面不动 |
| AboutToBeRemoved 能读到数据 | 删除时视图持已析构对象 → 段错误 |
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import (
    EntitiesAboutToBeRemoved,
    EntitiesChanged,
    EntitiesRemoved,
    EntityProperty,
    EntityRef,
    SelectionChanged,
)
from tools.editor.editors.scene_v2.commands import (
    CMD_ID_TRANSFORM,
    build_change_fields_command,
)
from tools.editor.editors.scene_v2.document import SceneDocument


class _FakeModel:
    """ProjectModel 的最小替身：Document 只用到 `scenes` 与 `mark_dirty`。"""

    def __init__(self, scene: dict) -> None:
        self.scenes = {"街": scene}
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


class _FakeStaging:
    """属性面板替身：只回答"这个实体是不是正被我编辑"。"""

    def __init__(self) -> None:
        self.open: dict[tuple[str, str], dict] = {}

    def staging_dict_for(self, kind: str, entity_id: str) -> dict | None:
        return self.open.get((kind, entity_id))


def _scene() -> dict:
    return {
        "id": "街", "name": "街",
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 120, "unknownKey": {"keep": 1}},
            {"id": "h2", "type": "inspect", "x": 300, "y": 320},
        ],
        "npcs": [{"id": "n1", "name": "甲", "x": 160, "y": 180}],
        "zones": [],
    }


class _Recorder:
    """把 Document 发出的全部事件按序记下来。"""

    def __init__(self, doc: SceneDocument) -> None:
        self.events: list = []
        doc.changed.connect(self.events.append)

    def of(self, cls) -> list:
        return [e for e in self.events if isinstance(e, cls)]

    def clear(self) -> None:
        self.events.clear()


class SceneV2DocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, "街")
        self.staging = _FakeStaging()
        self.doc.set_staging_provider(self.staging)
        self.rec = _Recorder(self.doc)

    def tearDown(self) -> None:
        self.doc.deleteLater()
        QApplication.processEvents()

    # ---- 验收 1：write_target 的两条分支 ----------------------------------

    def test_write_target_uses_model_when_not_being_edited(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.assertIs(self.doc.write_target(ref), self.doc.model_entity(ref))
        self.assertFalse(self.doc.is_staged(ref))

    def test_write_target_uses_staging_when_panel_has_it_open(self) -> None:
        ref = EntityRef("hotspot", "h1")
        staged = {"id": "h1", "x": 999, "y": 999}
        self.staging.open[("hotspot", "h1")] = staged

        self.assertIs(self.doc.write_target(ref), staged,
                      "面板正编辑该实体时必须写 staging，否则 Apply 会整份盖掉这次改动")
        self.assertTrue(self.doc.is_staged(ref))

    def test_other_entities_still_go_to_the_model_while_one_is_staged(self) -> None:
        """整组位移的形状：一个成员被面板打开，其余成员仍写模型。

        判错这一条 = "整组拖动少一个人跟上"，而画布还照新位置画，肉眼看不出坏数据。
        """
        self.staging.open[("hotspot", "h1")] = {"id": "h1", "x": 0, "y": 0}
        other = EntityRef("hotspot", "h2")
        self.assertIs(self.doc.write_target(other), self.doc.model_entity(other))

    def test_reads_also_go_through_the_arbiter(self) -> None:
        """读也要裁决 —— 读模型而写 staging 正是"每 8ms 打一架"的根因。"""
        staged = {"id": "n1", "x": 777, "y": 888}
        self.staging.open[("npc", "n1")] = staged
        self.assertEqual(self.doc.entity(EntityRef("npc", "n1"))["x"], 777)

    # ---- 验收 2：零变更不入栈、不标脏 --------------------------------------

    def test_noop_command_is_not_built(self) -> None:
        ref = EntityRef("hotspot", "h1")
        cmd = build_change_fields_command(
            self.doc, [ref], [{"x": 100, "y": 120}], EntityProperty.POSITION, "移动")
        self.assertIsNone(cmd, "值没变却构造出了命令")

    def test_noop_does_not_dirty_or_push(self) -> None:
        ref = EntityRef("hotspot", "h1")
        cmd = build_change_fields_command(
            self.doc, [ref], [{"x": 100}], EntityProperty.POSITION, "移动")
        self.assertFalse(self.doc.push(cmd))
        self.assertEqual(self.doc.undo_stack.count(), 0)
        self.assertEqual(self.model.dirty, [], "零变更把场景标脏了")

    def test_int_float_representation_is_a_real_change(self) -> None:
        """`100` 与 `100.0` 视为不同 —— 数值往返保真：未改动的键必须按原表示回写。"""
        ref = EntityRef("hotspot", "h1")
        cmd = build_change_fields_command(
            self.doc, [ref], [{"x": 100.0}], EntityProperty.POSITION, "移动")
        self.assertIsNotNone(cmd, "int→float 是真变更，不该被当成零变更吞掉")

    # ---- 验收 3：一次手势合并成一条撤销记录 --------------------------------

    def test_ten_frames_of_one_gesture_collapse_to_one_command(self) -> None:
        ref = EntityRef("hotspot", "h1")
        for frame in range(10):
            cmd = build_change_fields_command(
                self.doc, [ref], [{"x": 100 + frame + 1}], EntityProperty.POSITION,
                "拖动", mergeable=(frame > 0))   # 第一帧不合并，之后合并
            self.doc.push(cmd)

        self.assertEqual(self.doc.undo_stack.count(), 1,
                         "一次拖动产生了多条撤销记录（老画布要按 30 次 Ctrl+Z 的那个坑）")
        self.assertEqual(self.doc.model_entity(ref)["x"], 110)

        self.doc.undo_stack.undo()
        self.assertEqual(self.doc.model_entity(ref)["x"], 100,
                         "合并后的撤销必须回到手势起点，不是回到中间某一帧")

    def test_a_new_gesture_starts_a_new_command(self) -> None:
        """两次独立手势不许被并成一条，否则撤销一次退回两次操作。"""
        ref = EntityRef("hotspot", "h1")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"x": 150}], EntityProperty.POSITION, "拖动"))
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"x": 200}], EntityProperty.POSITION, "拖动"))
        self.assertEqual(self.doc.undo_stack.count(), 2)

    def test_different_entities_do_not_merge(self) -> None:
        ref1, ref2 = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h2")
        self.doc.push(build_change_fields_command(
            self.doc, [ref1], [{"x": 150}], EntityProperty.POSITION, "拖动"))
        self.doc.push(build_change_fields_command(
            self.doc, [ref2], [{"x": 350}], EntityProperty.POSITION, "拖动",
            mergeable=True))
        self.assertEqual(self.doc.undo_stack.count(), 2,
                         "不同实体的命令被并了 —— 撤销会把两个都退回去")

    def test_merge_id_is_constant_and_the_flag_lives_on_the_incoming_command(self) -> None:
        """``id()`` 恒定；"第一帧不合并"靠 `mergeWith` 查**来者**的标志位。

        这里踩过一次：把第一帧的 ``id()`` 写成 -1 看着合理，实际是后续帧
        **没有东西可以并进去**（Qt 的判据是 ``top.id() == new.id()``，top 正是
        第一帧），于是一次拖动仍留下两条记录。
        """
        ref = EntityRef("hotspot", "h1")
        first = build_change_fields_command(
            self.doc, [ref], [{"x": 150}], EntityProperty.POSITION, "拖动")
        later = build_change_fields_command(
            self.doc, [ref], [{"x": 160}], EntityProperty.POSITION, "拖动",
            mergeable=True)
        self.assertEqual(first.id(), CMD_ID_TRANSFORM)
        self.assertEqual(later.id(), CMD_ID_TRANSFORM)
        self.assertFalse(first.mergeWith(first), "不可合并的来者必须被拒")
        self.assertTrue(first.mergeWith(later), "同手势的后续帧应当并得进去")

    # ---- 验收 4：undo 与 redo 发同类型事件 ---------------------------------

    def test_undo_and_redo_emit_the_same_event_type(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"x": 500}], EntityProperty.POSITION, "移动"))
        self.rec.clear()

        self.doc.undo_stack.undo()
        after_undo = self.rec.of(EntitiesChanged)
        self.rec.clear()
        self.doc.undo_stack.redo()
        after_redo = self.rec.of(EntitiesChanged)

        self.assertEqual(len(after_undo), 1, "undo 没发变更事件 → 画面不会刷新")
        self.assertEqual(len(after_redo), 1, "redo 没发变更事件")
        self.assertEqual(after_undo[0].refs, after_redo[0].refs)
        self.assertEqual(after_undo[0].properties, after_redo[0].properties)

    def test_undo_restores_the_value_and_redo_reapplies(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"x": 500}], EntityProperty.POSITION, "移动"))
        self.assertEqual(self.doc.model_entity(ref)["x"], 500)
        self.doc.undo_stack.undo()
        self.assertEqual(self.doc.model_entity(ref)["x"], 100)
        self.doc.undo_stack.redo()
        self.assertEqual(self.doc.model_entity(ref)["x"], 500)

    def test_undo_restores_a_key_that_did_not_exist(self) -> None:
        """原本没有的键，撤销后必须**仍然没有** —— 补成 None 是数据污染。"""
        ref = EntityRef("hotspot", "h2")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"scale": 2.0}], EntityProperty.TRANSFORM, "缩放"))
        self.assertEqual(self.doc.model_entity(ref)["scale"], 2.0)
        self.doc.undo_stack.undo()
        self.assertNotIn("scale", self.doc.model_entity(ref),
                         "撤销把原本不存在的键补成了值，黄金往返会红")

    def test_unknown_keys_survive_a_roundtrip(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"x": 500}], EntityProperty.POSITION, "移动"))
        self.doc.undo_stack.undo()
        self.assertEqual(self.doc.model_entity(ref).get("unknownKey"), {"keep": 1},
                         "未受管字段在撤销往返里被弄丢了")

    # ---- 验收 5：AboutToBeRemoved 时数据还在 -------------------------------

    def test_about_to_be_removed_carries_live_data(self) -> None:
        ref = EntityRef("hotspot", "h1")
        seen: list[dict] = []

        def on_change(ev) -> None:
            if isinstance(ev, EntitiesAboutToBeRemoved):
                # 此刻按 ref 仍然查得到实体 —— 这正是"最后一次合法访问"
                seen.append(dict(self.doc.model_entity(ev.refs[0]) or {}))

        self.doc.changed.connect(on_change)
        self.doc.about_to_remove([ref])

        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["x"], 100, "AboutToBeRemoved 时数据应当还能读到")
        self.assertEqual(
            self.rec.of(EntitiesAboutToBeRemoved)[0].snapshots[0]["x"], 100,
            "事件自带的快照也应当是完整数据")

    def test_about_to_remove_drops_it_from_selection(self) -> None:
        """选择集是最常见的悬挂引用来源，文档必须自己先清掉。"""
        ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([ref, EntityRef("hotspot", "h2")])
        self.rec.clear()
        self.doc.about_to_remove([ref])
        self.assertNotIn(ref, self.doc.selection)
        self.assertTrue(self.rec.of(SelectionChanged))

    def test_removed_event_follows(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.about_to_remove([ref])
        self.doc.removed([ref])
        self.assertEqual(len(self.rec.of(EntitiesRemoved)), 1)

    # ---- 其余不变量 --------------------------------------------------------

    def test_selection_is_deduplicated_and_ordered(self) -> None:
        a, b = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h2")
        self.doc.set_selection([a, b, a])
        self.assertEqual(self.doc.selection, (a, b))

    def test_setting_the_same_selection_emits_nothing(self) -> None:
        a = EntityRef("hotspot", "h1")
        self.doc.set_selection([a])
        self.rec.clear()
        self.doc.set_selection([a])
        self.assertEqual(self.rec.of(SelectionChanged), [],
                         "重复设同一选择集也发信号 → 下游会被无谓刷新甚至递归")

    def test_push_is_a_noop_while_restoring(self) -> None:
        """回放期间一切 push 短路，杜绝"undo 过程中 push"。"""
        ref = EntityRef("hotspot", "h1")
        self.doc.restoring = True
        try:
            pushed = self.doc.push(build_change_fields_command(
                self.doc, [ref], [{"x": 700}], EntityProperty.POSITION, "移动"))
        finally:
            self.doc.restoring = False
        self.assertFalse(pushed)
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_entity_refs_follow_json_order(self) -> None:
        """平局次序要复刻运行时的装配序，所以 ref 必须按 JSON 数组序。"""
        self.assertEqual(
            [r.id for r in self.doc.entity_refs("hotspot")], ["h1", "h2"])

    def test_entity_ref_key_roundtrip(self) -> None:
        ref = EntityRef("npc", "n1")
        self.assertEqual(ref.key, "npc:n1")
        self.assertEqual(EntityRef.parse("npc:n1"), ref)


class IdentityFollowsTheCommandTests(SceneV2DocumentTests):
    """改 id = 换身份：命令持的 ref 必须跟着变，事件里旧新两个 ref 都要带。

    不跟的话两个方向都坏：正着改，视图只收到旧 ref（查不到 → 拆图元），新 id 没人建，
    实体从画布上消失；撤销按旧 id `write_target` 拿到 None 就 `continue`，一个字节都不写、
    一个事件都不发 —— Ctrl+Z 看着像坏了。
    """

    def test_changing_the_id_emits_both_refs_and_undo_finds_the_entity(self) -> None:
        old, new = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h9")
        self.doc.set_selection([old])
        self.rec.clear()
        self.doc.push(build_change_fields_command(
            self.doc, [old], [{"id": "h9"}], EntityProperty.IDENTITY, "改 id"))
        self.assertEqual(self.rec.of(EntitiesChanged)[-1].refs, (old, new),
                         "事件里必须同时带旧 ref（拆图元）与新 ref（建图元）")
        self.assertEqual(self.doc.selection, (new,), "选择集没跟着新 id 走")
        self.assertIsNone(self.doc.model_entity(old))
        self.assertIsNotNone(self.doc.model_entity(new))

        self.rec.clear()
        self.doc.undo_stack.undo()
        self.assertIsNotNone(self.doc.model_entity(old),
                             "撤销按旧 id 找不到人，什么都没做")
        self.assertIsNone(self.doc.model_entity(new))
        self.assertEqual(self.rec.of(EntitiesChanged)[-1].refs, (new, old))
        self.assertEqual(self.doc.selection, (old,), "撤销后选择集还指着新 id")

    def test_consecutive_id_edits_merge_and_undo_in_one_step(self) -> None:
        """第二条命令是对着第一条改出来的**新 id** 构造的，仍要并进同一条记录。"""
        h1 = EntityRef("hotspot", "h1")
        self.doc.push(build_change_fields_command(
            self.doc, [h1], [{"id": "h1a"}], EntityProperty.IDENTITY, "改 id"))
        self.doc.push(build_change_fields_command(
            self.doc, [EntityRef("hotspot", "h1a")], [{"id": "h1ab"}],
            EntityProperty.IDENTITY, "改 id", mergeable=True))
        self.assertEqual(self.doc.undo_stack.count(), 1, "逐字敲 id 变成了一键一条撤销记录")
        self.assertIsNotNone(self.doc.model_entity(EntityRef("hotspot", "h1ab")))
        self.doc.undo_stack.undo()
        self.assertIsNotNone(self.doc.model_entity(h1), "合并后撤销按合并前的 id 找不到人")
        self.assertIsNone(self.doc.model_entity(EntityRef("hotspot", "h1ab")))

    def test_scene_level_id_is_not_treated_as_an_identity_change(self) -> None:
        """`scene` 的 id 是字典键，不是寻址字段 —— 不能把它当成改了实体身份。"""
        ref = EntityRef("scene", "街")
        self.doc.push(build_change_fields_command(
            self.doc, [ref], [{"name": "新街"}], EntityProperty.IDENTITY, "改名"))
        self.assertEqual(self.rec.of(EntitiesChanged)[-1].refs, (ref,))
        self.assertIs(self.doc.model_entity(ref), self.model.scenes["街"])


if __name__ == "__main__":
    unittest.main()
