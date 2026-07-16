"""扎纸槽位可视化画布（M8）往返护栏：

证明新增的 PaperSlotCanvas 只提供「看与改 x/y/width/height」的视图能力，
不破坏既有数据保真：
  (a) 构造编辑器 + 选中槽位（含画布选择联动）不改任何槽位坐标；
  (b) 模拟一次矩形拖动 / 缩放，只更新被拖那个槽的 x/y/width/height，其余槽位与同槽
      的非几何字段逐字段不变；
  (c) 拖动后坐标仍为 int（不引入 float），且未触动的槽位序列化逐字段相等。
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


PC_ID = "pc_canvas_fixture"


def _fixture_doc() -> dict:
    """含 1 实例 / 1 订单 / 3 槽位（各带不同 x/y/w/h、accepts、可选标志）。"""
    return {
        "id": PC_ID,
        "label": "画布护栏夹具",
        "orders": [
            {
                "id": "order_1",
                "title": "糊一个纸人",
                "description": "描述",
                "correctPaper": "paper_white",
                "successScore": 76,
                "warnScore": 50,
                "paperOptions": [
                    {"id": "paper_white", "label": "白纸", "tint": "#f3ead7", "score": 0},
                ],
                "finishOptions": [
                    {"id": "finish_burn", "label": "焚化", "score": 5, "tags": ["送行"]},
                ],
                "slots": [
                    {"id": "slot_head", "label": "头脸", "x": 226, "y": 82,
                     "width": 108, "height": 82, "accepts": ["part_face"]},
                    {"id": "slot_body", "label": "身躯", "x": 200, "y": 200,
                     "width": 140, "height": 160, "optional": True, "accepts": ["part_robe"]},
                    {"id": "slot_charm", "label": "挂件", "x": 388, "y": 92,
                     "width": 112, "height": 82, "accepts": ["part_charm"]},
                ],
                "parts": [
                    {"id": "part_face", "label": "脸", "score": 3},
                    {"id": "part_robe", "label": "袍", "score": 2},
                    {"id": "part_charm", "label": "纸符", "score": 1},
                ],
            }
        ],
    }


def _slots(model: ProjectModel) -> list[dict]:
    return model.paper_craft_instances[PC_ID]["orders"][0]["slots"]


class PaperSlotCanvasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _build_model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        pc_dir = root / "public" / "assets" / "data" / "paper_craft"
        pc_dir.mkdir(parents=True, exist_ok=True)
        (pc_dir / "index.json").write_text(
            json.dumps([{"id": PC_ID, "label": "画布护栏夹具", "file": f"{PC_ID}.json"}],
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

    # (a) 构造 + 选择（含画布选择联动）不改任何槽位坐标。
    def test_construct_and_select_does_not_mutate_slots(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            original = copy.deepcopy(model.paper_craft_instances[PC_ID])

            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)

            # 画布每行应有一个矩形 item。
            self.assertEqual(len(editor.slot_canvas._items), 3)

            # 逐一从主列表选过每个槽位（触发 _select_slot + 画布选择联动）。
            for si in range(editor.slot_combo.count()):
                editor.slot_combo.setCurrentIndex(si)
            # 反向：从画布选择联动回主列表。
            editor._on_canvas_slot_selected(0)
            editor._on_canvas_slot_selected(2)

            self.assertEqual(
                model.paper_craft_instances[PC_ID], original,
                "构造/选择/画布联动不得改动任何槽位字段",
            )

    # (b) 模拟一次矩形拖动 / 缩放：只改被拖那个槽的 x/y/w/h，其余字段全保留。
    def test_simulated_drag_updates_only_target_slot(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)

            before = copy.deepcopy(_slots(model))

            # 选中第 1 个槽位，模拟把它拖到新位置 + 缩放（画布发出的整数几何信号）。
            editor.slot_combo.setCurrentIndex(0)
            editor._on_canvas_slot_geometry(0, 300, 150, 120, 90)

            after = _slots(model)
            # 目标槽：x/y/w/h 更新为拖动值。
            self.assertEqual(after[0]["x"], 300)
            self.assertEqual(after[0]["y"], 150)
            self.assertEqual(after[0]["width"], 120)
            self.assertEqual(after[0]["height"], 90)
            # 目标槽：非几何字段（id/label/accepts）保留。
            self.assertEqual(after[0]["id"], "slot_head")
            self.assertEqual(after[0]["label"], "头脸")
            self.assertEqual(after[0]["accepts"], ["part_face"])
            # 兄弟槽位逐字段不变。
            self.assertEqual(after[1], before[1], "未触动槽位 #1 必须逐字段不变")
            self.assertEqual(after[2], before[2], "未触动槽位 #2 必须逐字段不变")

            # spinbox 已被同步到新几何（双向同步）。
            self.assertEqual(editor.slot_x.value(), 300)
            self.assertEqual(editor.slot_y.value(), 150)
            self.assertEqual(editor.slot_w.value(), 120)
            self.assertEqual(editor.slot_h.value(), 90)

    # (b') 反向：编辑 spinbox → 矩形跟随（spinbox 写回与画布同步并存，互不破坏数据）。
    def test_spinbox_edit_syncs_rect_and_writes_back(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            editor.slot_combo.setCurrentIndex(1)

            editor.slot_x.setValue(210)
            editor.slot_w.setValue(150)

            s = _slots(model)[1]
            self.assertEqual(s["x"], 210)
            self.assertEqual(s["width"], 150)
            # 矩形几何已被 spinbox 同步。
            item = editor.slot_canvas._items[1]
            self.assertEqual(int(round(item.pos().x())), 210)
            self.assertEqual(int(round(item.rect().width())), 150)

    # (c) 坐标恒为 int（不引入 float），未触动槽位序列化逐字段相等。
    def test_coords_stay_int_and_untouched_slots_serialize_identically(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            disk = json.loads(
                (Path(td) / "p" / "public" / "assets" / "data" / "paper_craft"
                 / f"{PC_ID}.json").read_text(encoding="utf-8")
            )
            untouched_1 = copy.deepcopy(disk["orders"][0]["slots"][1])
            untouched_2 = copy.deepcopy(disk["orders"][0]["slots"][2])

            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            editor.slot_combo.setCurrentIndex(0)
            # 拖动只动槽 0。
            editor._on_canvas_slot_geometry(0, 11, 22, 33, 44)

            slots = _slots(model)
            for key in ("x", "y", "width", "height"):
                self.assertIsInstance(slots[0][key], int, f"{key} 必须保持 int 类型")
            # 未触动槽位与磁盘原值逐字段相等（包括类型）。
            self.assertEqual(slots[1], untouched_1)
            self.assertEqual(slots[2], untouched_2)


    # (d) P2：sceneRect 固定为运行时 560×410 工作台，不随槽位外接框漂移。
    def test_scene_rect_fixed_to_workbench(self) -> None:
        from tools.editor.editors.paper_craft_canvas import _WORKBENCH_W, _WORKBENCH_H

        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            r = editor.slot_canvas._scene.sceneRect()
            self.assertEqual((int(r.width()), int(r.height())), (_WORKBENCH_W, _WORKBENCH_H))
            self.assertEqual((_WORKBENCH_W, _WORKBENCH_H), (560, 410))

    # (e) P2：槽位可拖出旧外接框，只夹在工作台内。
    def test_slot_draggable_beyond_old_bounding_box(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            editor.slot_combo.setCurrentIndex(0)
            # 旧实现夹在"槽位外接框+24"内；现在放宽到工作台，可拖到接近 560/410。
            editor._on_canvas_slot_geometry(0, 520, 380, 30, 24)
            s = _slots(model)[0]
            self.assertEqual((s["x"], s["y"], s["width"], s["height"]), (520, 380, 30, 24))

    # (f) P2：越界的既有坐标（模型真值）在载入时不被静默夹紧。
    def test_out_of_bounds_slot_not_clamped_on_load(self) -> None:
        with TemporaryDirectory() as td:
            model = self._build_model(Path(td) / "p")
            # 把一个槽位改到工作台外（x=600 > 560），构造编辑器加载不应改模型。
            model.paper_craft_instances[PC_ID]["orders"][0]["slots"][0]["x"] = 600
            before = copy.deepcopy(model.paper_craft_instances[PC_ID])
            editor = PaperCraftEditor(model)
            editor.instance_list.setCurrentRow(0)
            editor.order_combo.setCurrentIndex(0)
            self.assertEqual(
                model.paper_craft_instances[PC_ID], before,
                "越界坐标是模型真值，载入不得被画布静默夹紧",
            )


if __name__ == "__main__":
    unittest.main()
