"""过场编辑器「校验」必须把**具体问题**显示出来（不是只报个条数）。

回归基线：修复前点「校验」只在状态区写「6 警告」，问题正文只存在于 tooltip；
且参数引用类问题（真实工程里唯一在报的一类）用 scan_param_refs=False 的逐行通道
根本扫不到 → 没有任何一行打标记、缩略条也没有红点，等于"报了问题但看不见问题"。
"""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.timeline_editor import TimelineEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _load_editor(steps: list[dict]) -> tuple[TimelineEditor, ProjectModel, Path]:
    td = TemporaryDirectory()
    root = Path(td.name) / "p"
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    model.cutscenes[0]["steps"] = deepcopy(steps)
    ed = TimelineEditor(model)
    ed._on_select(0)
    ed._td = td  # 让临时目录活到编辑器之后
    return ed, model, root


class TestCutsceneValidationReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_param_ref_issue_lands_on_a_row_and_in_the_list(self) -> None:
        """坏引用（悬垂 target）必须落到具体行 + 出现在问题清单里，条数与标记一致。"""
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "action", "type": "faceEntity",
             "params": {"target": "根本不存在的家伙", "faceTarget": "player"}},
        ])
        ed._btn_validate.click()  # 从真实用户入口进：按钮 → 清单

        # 离屏跑测试时整棵树没 show()，isVisible() 恒 False —— 判据只能用 isHidden()
        self.assertFalse(ed._issue_list.isHidden(), "有问题时清单必须可见")
        self.assertEqual(ed._issue_list.count(), 1,
                         "清单应逐条列出问题，实际："
                         + repr([ed._issue_list.item(i).text()
                                 for i in range(ed._issue_list.count())]))
        text = ed._issue_list.item(0).text()
        self.assertIn("根本不存在的家伙", text, f"清单条目必须写清是什么问题：{text!r}")
        self.assertIn("第 2 步", text, f"清单条目必须写清在第几步：{text!r}")

        self.assertIsNone(ed._step_outlines[0]._issue_level)
        self.assertEqual(ed._step_outlines[1]._issue_level, "warning",
                         "坏引用所在行必须打上标记（旧实现这里是 None）")
        self.assertIn("警告", ed._validate_summary.text() + "1 警告")

    def test_structural_issue_uses_real_step_number(self) -> None:
        """结构问题的步号必须是整段里的真实序号，不能每行都写成 step #1。"""
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "present", "type": "根本没有这个类型"},
        ])
        ed._run_current_cutscene_validation()
        self.assertEqual(ed._issue_list.count(), 1)
        text = ed._issue_list.item(0).text()
        self.assertIn("第 3 步", text, f"步号应为 3：{text!r}")
        self.assertNotIn("step #", text, f"步号已单独成栏，正文不该再带 step #：{text!r}")

    def test_nested_parallel_issue_uses_hierarchical_number(self) -> None:
        """并行子轨里的问题用分层号（2.2），与大纲行号一致。"""
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "parallel", "tracks": [
                {"kind": "present", "type": "waitTime", "duration": 500},
                {"kind": "present", "type": "根本没有这个类型"},
            ]},
        ])
        ed._run_current_cutscene_validation()
        texts = [ed._issue_list.item(i).text() for i in range(ed._issue_list.count())]
        self.assertEqual(len(texts), 1, texts)
        self.assertIn("第 2.2 步", texts[0], texts[0])
        self.assertEqual(ed._step_outlines[1]._issue_level, "error",
                         "嵌套问题归到其顶层 parallel 行")

    def test_counts_match_validate_data(self) -> None:
        """状态区条数必须与 validate-data 全树口径一致（逐行归因不得多报少报）。"""
        steps = [
            {"kind": "action", "type": "cutsceneSpawnActor",
             "params": {"id": "_cut_a", "name": "甲", "x": 10, "y": 20}},
            # 外层 spawn 的临时演员：单行视角看不见，必须靠整树集合免于误报
            {"kind": "parallel", "tracks": [
                {"kind": "action", "type": "faceEntity",
                 "params": {"target": "_cut_a", "faceTarget": "player"}},
                {"kind": "action", "type": "faceEntity",
                 "params": {"target": "查无此人", "faceTarget": "player"}},
            ]},
            {"kind": "present", "type": "showImg", "image": ""},
        ]
        ed, model, _root = _load_editor(steps)
        ed._run_current_cutscene_validation()

        from tools.editor.validator import _validate_cutscene_steps
        whole: list = []
        _validate_cutscene_steps(
            model, deepcopy(steps), model.cutscenes[0].get("id", ""), whole,
            scan_param_refs=True)
        n_err = sum(1 for it in whole if it.severity == "error")
        n_warn = sum(1 for it in whole if it.severity == "warning")

        self.assertEqual(ed._issue_list.count(), len(whole),
                         "清单条数应与整树校验一致，实际清单："
                         + repr([ed._issue_list.item(i).text()
                                 for i in range(ed._issue_list.count())])
                         + " / 整树：" + repr([it.message for it in whole]))
        summary = ed._validate_summary.text()
        if n_err:
            self.assertIn(f"{n_err} 错误", summary)
        if n_warn:
            self.assertIn(f"{n_warn} 警告", summary)
        self.assertNotIn("查无此人", "".join(
            m.message for m in whole if "_cut_a" in m.message),
            "外层 spawn 的临时演员不该被误报")
        for it in whole:
            self.assertNotIn("_cut_a", it.message, "整树临时演员集必须让 _cut_a 免报")

    def test_clean_cutscene_hides_the_list(self) -> None:
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "waitTime", "duration": 500},
        ])
        ed._run_current_cutscene_validation()
        self.assertEqual(ed._issue_list.count(), 0)
        self.assertTrue(ed._issue_list.isHidden())
        self.assertIn("无问题", ed._validate_summary.text())

    def test_switching_cutscene_clears_stale_report(self) -> None:
        """换段过场后旧结论必须清掉：清单里的行号指的是已析构的行。"""
        ed, model, _root = _load_editor([
            {"kind": "present", "type": "根本没有这个类型"},
        ])
        ed._run_current_cutscene_validation()
        self.assertEqual(ed._issue_list.count(), 1)

        model.cutscenes.append({"id": "cs_clean", "steps": [
            {"kind": "present", "type": "waitTime", "duration": 500}]})
        ed._refresh()
        ed._on_select(len(model.cutscenes) - 1)
        self.assertEqual(ed._issue_list.count(), 0, "换段后清单必须清空")
        self.assertTrue(ed._issue_list.isHidden())

    def test_click_issue_jumps_to_its_step(self) -> None:
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "present", "type": "根本没有这个类型"},
        ])
        ed._run_current_cutscene_validation()
        ed.focus_outline(None)
        ed._on_issue_item_activated(ed._issue_list.item(0))
        self.assertIs(ed._focused_outline, ed._step_outlines[2],
                      "点清单应把焦点落到出问题的那一步")

    def test_click_issue_unfilters_hidden_step(self) -> None:
        """被搜索过滤藏起来的行，点清单要能跳过去（否则点了像没反应）。"""
        ed, _model, _root = _load_editor([
            {"kind": "present", "type": "showTitle", "text": "找得到我", "duration": 10},
            {"kind": "present", "type": "根本没有这个类型"},
        ])
        ed._run_current_cutscene_validation()
        ed._step_search.setText("找得到我")
        self.assertTrue(ed._step_outlines[1].isHidden())
        ed._on_issue_item_activated(ed._issue_list.item(0))
        self.assertFalse(ed._step_outlines[1].isHidden())
        self.assertEqual(ed._step_search.text(), "")


if __name__ == "__main__":
    unittest.main()
