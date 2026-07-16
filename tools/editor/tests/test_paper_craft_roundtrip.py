"""paper_craft 编辑器往返护栏：把子集合控件从下拉改成主从列表后，

构造编辑器 → 选中实例 → 依次走过订单/部件/槽位/纸色/收尾每个子列表的选择
（触发 commit-on-leave 与各 _select_*/_write_* 路径）→ 断言
model.paper_craft_instances[...] 与原始输入逐字段深度相等：证明无任何字段被丢弃、
重排或改形。这是 M16（子集合改主从列表）/ M1（实例增删）改动的字节保真硬契约。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.paper_craft_editor import PaperCraftEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


PC_ID = "pc_rt_fixture"


def _fixture_doc() -> dict:
    """含 ≥2 订单（各带反馈字段）、≥2 部件、≥2 槽位、≥2 纸色（各带 tint）、收尾块。"""
    def order(oid: str, suffix: str) -> dict:
        return {
            "id": oid,
            "title": f"标题{suffix}",
            "description": f"描述{suffix}",
            "targetHint": f"提示{suffix}",
            "finishQuestion": f"问句{suffix}？",
            "correctPaper": "paper_red",
            "successScore": 76,
            "warnScore": 50,
            "paperOptions": [
                {"id": "paper_white", "label": "白纸", "tint": "#f3ead7", "score": 0},
                {"id": "paper_red", "label": "红纸", "tint": "#c0392b", "score": 10},
            ],
            "finishOptions": [
                {"id": "finish_burn", "label": "焚化", "score": 5, "tags": ["送行"]},
                {"id": "finish_keep", "label": "留存", "score": -3, "tags": ["犯忌", "失礼"]},
            ],
            "slots": [
                {"id": "slot_head", "label": "头脸", "x": 226, "y": 82,
                 "width": 108, "height": 82, "accepts": ["part_face"]},
                {"id": "slot_body", "label": "身躯", "x": 200, "y": 200,
                 "width": 140, "height": 160, "optional": True, "accepts": ["part_robe"]},
            ],
            "parts": [
                {"id": "part_face", "label": "脸", "score": 3, "tags": ["点眼犯忌"]},
                {"id": "part_robe", "label": "袍", "score": 2, "tags": []},
            ],
            "onSuccessActions": [{"type": "playSfx", "id": f"ok_{oid}"}],
            "onWarnActions": [{"type": "setFlag", "params": {"flag": f"warn_{oid}", "value": True}}],
            "onBadActions": [{"type": "playSfx", "id": f"bad_{oid}"}],
        }

    return {
        "id": PC_ID,
        "label": "往返护栏夹具",
        "orders": [order("order_1", "甲"), order("order_2", "乙")],
    }


class PaperCraftRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _build_model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        pc_dir = root / "public" / "assets" / "data" / "paper_craft"
        pc_dir.mkdir(parents=True, exist_ok=True)
        (pc_dir / "index.json").write_text(
            json.dumps([{"id": PC_ID, "label": "往返护栏夹具", "file": f"{PC_ID}.json"}],
                       ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (pc_dir / f"{PC_ID}.json").write_text(
            json.dumps(_fixture_doc(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_navigation_preserves_every_field(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            original = copy.deepcopy(model.paper_craft_instances[PC_ID])

            editor = PaperCraftEditor(model)
            # 选中实例（主从列表第 0 行）。
            self.assertGreater(editor.instance_list.count(), 0, "实例应被加载进主列表")
            editor.instance_list.setCurrentRow(0)
            self.assertIs(editor._doc, model.paper_craft_instances[PC_ID])

            # 走过每个订单，并在每个订单下逐一选过部件/槽位/纸色/收尾，
            # 触发 commit-on-leave（各 _select_* 读取路径都被执行）。纯选择/导航
            # 不得改动任何字段——这是"无丢弃/重排/改形"的核心往返保证。
            for oi in range(editor.order_combo.count()):
                editor.order_combo.setCurrentIndex(oi)
                for sub in (editor.part_combo, editor.slot_combo,
                            editor.paper_combo, editor.finish_combo):
                    for si in range(sub.count()):
                        sub.setCurrentIndex(si)

            result = model.paper_craft_instances[PC_ID]
            self.assertEqual(
                result, original,
                "导航/选择后实例必须与原始输入逐字段深度相等（无丢弃/重排/改形）",
            )

    def test_per_field_edit_writes_back_without_dropping_siblings(self) -> None:
        # 编辑某个子项的一个字段后写回：该字段更新、同元素其它字段与兄弟元素全部保留。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)

            # 改第一个纸色的显示名 → 写回；tint/score 以及第二个纸色不得丢失。
            editor.paper_combo.setCurrentIndex(0)
            editor.paper_label.setText("白纸(改)")
            editor._write_paper()

            papers = model.paper_craft_instances[PC_ID]["orders"][0]["paperOptions"]
            self.assertEqual(papers[0]["label"], "白纸(改)")
            self.assertEqual(papers[0]["tint"], "#f3ead7", "同元素 tint 必须保留")
            self.assertEqual(papers[0]["score"], 0)
            self.assertEqual(papers[1], {"id": "paper_red", "label": "红纸",
                                         "tint": "#c0392b", "score": 10},
                             "兄弟纸色元素必须原样保留")

    def test_reorder_swaps_without_corrupting_actions(self) -> None:
        # 重排订单：交换数组元素，且每个订单自带的动作数组不串台。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)

            orders = model.paper_craft_instances[PC_ID]["orders"]
            o1 = copy.deepcopy(orders[0])
            o2 = copy.deepcopy(orders[1])

            editor.order_combo.setCurrentIndex(0)
            editor._move_orders(1)  # 把 order_1 下移到第 2 位

            self.assertEqual(orders[0], o2, "下移后首位应为原第 2 个订单（含其动作数组）")
            self.assertEqual(orders[1], o1, "下移后次位应为原第 1 个订单（含其动作数组）")
            # 关键：各订单自带的 onSuccess/onWarn/onBad 数组未被串台改写。
            self.assertEqual(orders[0]["onSuccessActions"], o2["onSuccessActions"])
            self.assertEqual(orders[1]["onSuccessActions"], o1["onSuccessActions"])

    def test_add_instance_registers_index_and_file_entry(self) -> None:
        # M1：新增实例同时写 index 项与实例字典（保存层据此持久化新文件）。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)

            from unittest import mock
            with mock.patch(
                "tools.editor.editors.paper_craft_editor.QInputDialog.getText",
                return_value=("pc_new_inst", True),
            ):
                editor._add_instance()

            self.assertIn("pc_new_inst", model.paper_craft_instances)
            idx_ids = {r.get("id") for r in model.paper_craft_index if isinstance(r, dict)}
            self.assertIn("pc_new_inst", idx_ids)
            row = next(r for r in model.paper_craft_index if r.get("id") == "pc_new_inst")
            self.assertEqual(row.get("file"), "pc_new_inst.json",
                             "index 项必须带 file 字段，保存层才能写出新实例文件")

    def test_new_fields_guarded_writes_preserve_format(self) -> None:
        # E1 新增可编辑字段（part.image / paper.tags）的写回必须"守门"：
        # 不给本无该键的记录凭空加键；填入后才落键。编辑器往返不引入格式漂移。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)

            # (a) 改部件显示名 → 不得给本无 image 键的部件加 "image"。
            editor.part_combo.setCurrentIndex(0)
            editor.part_label.setText("脸(改)")
            editor._write_part()
            part0 = model.paper_craft_instances[PC_ID]["orders"][0]["parts"][0]
            self.assertEqual(part0["label"], "脸(改)")
            self.assertNotIn("image", part0, "未填图片时不得加 image 键（格式保真）")

            # (b) 改白纸显示名（白纸夹具无 tags）→ 不得加 "tags"。
            editor.paper_combo.setCurrentIndex(0)
            editor.paper_label.setText("白纸(改)")
            editor._write_paper()
            paper0 = model.paper_craft_instances[PC_ID]["orders"][0]["paperOptions"][0]
            self.assertEqual(paper0["label"], "白纸(改)")
            self.assertNotIn("tags", paper0, "未填标签时不得加 tags 键（格式保真）")

            # (c) 填入图片 / 标签后才落键，且值正确。
            img = "/resources/runtime/images/minigames/paper_craft/parts/x.png"
            editor.part_image.set_path(img)
            editor._write_part()
            self.assertEqual(
                model.paper_craft_instances[PC_ID]["orders"][0]["parts"][0]["image"], img,
            )
            editor.paper_tags.setText("红白相冲, 纸色不合")
            editor._write_paper()
            self.assertEqual(
                model.paper_craft_instances[PC_ID]["orders"][0]["paperOptions"][0]["tags"],
                ["红白相冲", "纸色不合"],
            )

    def test_line_edit_writes_on_typing_without_focus_loss(self) -> None:
        # P1-05：行内 QLineEdit 改 textChanged 即时写模型。模拟"打完字不失焦直接
        # flush（=Ctrl+S/关窗）"——setText 发 textChanged（等价键入），无失焦事件；
        # flush_to_model 后模型必须已含新值（旧 editingFinished 接法此处会丢字）。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)

            # 每个行内 QLineEdit：键入 → 不失焦 → 立即断言模型已更新。
            editor.order_title.setText("现改的标题")
            editor.part_combo.setCurrentIndex(0)
            editor.part_label.setText("现改的部件名")
            editor.slot_combo.setCurrentIndex(0)
            editor.slot_label.setText("现改的槽名")
            editor.paper_combo.setCurrentIndex(0)
            editor.paper_label.setText("现改的纸名")
            editor.finish_combo.setCurrentIndex(0)
            editor.finish_label.setText("现改的收尾名")
            editor.instance_label_edit.setText("现改的实例名")

            # flush_to_model 是 Save All / 关窗前的统一钩子：这里必须无损通过。
            self.assertTrue(editor.flush_to_model())
            self.assertTrue(editor.confirm_close())

            order0 = model.paper_craft_instances[PC_ID]["orders"][0]
            self.assertEqual(order0["title"], "现改的标题",
                             "textChanged 应即时写回，不失焦也不丢字")
            self.assertEqual(order0["parts"][0]["label"], "现改的部件名")
            self.assertEqual(order0["slots"][0]["label"], "现改的槽名")
            self.assertEqual(order0["paperOptions"][0]["label"], "现改的纸名")
            self.assertEqual(order0["finishOptions"][0]["label"], "现改的收尾名")
            self.assertEqual(model.paper_craft_instances[PC_ID]["label"], "现改的实例名")

    def test_reload_refs_preserves_action_content(self) -> None:
        # reload_refs_from_model（切页激活重拉动作编辑器引用候选）不得改动作内容。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            before = copy.deepcopy(model.paper_craft_instances[PC_ID])
            editor.reload_refs_from_model()
            self.assertEqual(model.paper_craft_instances[PC_ID], before,
                             "reload_refs 只重拉候选，不得改任何字段")

    def test_instance_label_edit_syncs_index_and_instance(self) -> None:
        # 实例显示名写回须同步 index 行 + 实例文件 label；backgroundImage 守门。
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)

            editor.instance_label_edit.setText("改名了")
            editor._write_instance_meta()
            self.assertEqual(model.paper_craft_instances[PC_ID]["label"], "改名了")
            row = next(r for r in model.paper_craft_index if r.get("id") == PC_ID)
            self.assertEqual(row.get("label"), "改名了", "index 行 label 须同步")
            self.assertNotIn(
                "backgroundImage", model.paper_craft_instances[PC_ID],
                "未设底图时不得加 backgroundImage 键（格式保真）",
            )

            bg = "/resources/runtime/images/minigames/paper_craft/bg.png"
            editor.instance_bg.set_path(bg)
            editor._write_instance_meta()
            self.assertEqual(model.paper_craft_instances[PC_ID]["backgroundImage"], bg)


if __name__ == "__main__":
    unittest.main()
