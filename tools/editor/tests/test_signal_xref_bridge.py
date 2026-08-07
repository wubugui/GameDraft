"""「信号关系」桥（只读）与两个来源的口径对账。

这三件事必须钉死：
1. 扫描**只读**——面板打开不许把工程弄脏（打开即脏是编辑器红线）。
2. 扫描按**画布草稿**算——面板要回答"我改成这样之后"的关系，不是上次存盘的关系。
3. 跳转是**三态**（精确/只开了页/没跳成），原样透传，不许把 None 谎报成成功。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QObject

from tools.editor.editors.narrative_state_editor import NarrativeEditorBridge
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

REPO_ROOT = Path(__file__).resolve().parents[3]


def _emit(signal: str) -> dict:
    return {"type": "emitNarrativeSignal", "params": {"signal": signal}}


def _narrative(signal: str = "sig_x") -> dict:
    return {
        "schemaVersion": 2,
        "signals": [{"id": signal, "label": "接活了"}],
        "compositions": [{
            "id": "comp",
            "label": "第一单",
            "mainGraph": {
                "id": "flow",
                "ownerType": "flow",
                "initialState": "initial",
                "states": {"initial": {"id": "initial", "label": "开局"}, "done": {"id": "done", "label": "接了活"}},
                "transitions": [{"id": "t1", "from": "initial", "to": "done", "signal": signal}],
            },
            "elements": [],
        }],
    }


class SignalXrefBridgeTests(unittest.TestCase):
    def _project(self, td: str) -> tuple[ProjectModel, Path]:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        # 一处真实发射：任务完成时发信号（内容资产动作树，pointer 要能落到 quests.json）
        quests = root / "public" / "assets" / "data" / "quests.json"
        quests.write_text(json.dumps(
            [{"id": "q_1", "title": "第一单", "onComplete": [_emit("sig_x")]}],
            ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        model = ProjectModel()
        model.load_project(root)
        model.narrative_graphs = _narrative()
        return model, root

    def test_scan_is_read_only_and_finds_both_sides(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            dirty_before = model.is_dirty
            bridge = NarrativeEditorBridge(model)
            res = json.loads(bridge.scanSignalXref("{}"))
            self.assertTrue(res["ok"], res)
            self.assertEqual(model.is_dirty, dirty_before, "扫描不许把工程弄脏")

            cards = {c["signal"]: c for c in res["xref"]["signals"]}
            self.assertIn("sig_x", cards)
            card = cards["sig_x"]
            self.assertEqual(card["emitterCount"], 1)
            self.assertEqual(card["listenerCount"], 1)
            self.assertEqual(card["emitters"][0]["containerId"], "q_1")
            self.assertEqual(card["emitters"][0]["file"], "public/assets/data/quests.json")
            self.assertEqual(card["listeners"][0]["transitionId"], "t1")
            self.assertEqual(card["label"], "接活了")

    def test_scan_uses_the_canvas_draft_not_the_stored_model(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            bridge = NarrativeEditorBridge(model)
            draft = _narrative("sig_x")
            draft["compositions"][0]["mainGraph"]["transitions"].append(
                {"id": "t2", "from": "done", "to": "initial", "signal": "sig_draft_only"})
            draft["signals"].append({"id": "sig_draft_only"})
            res = json.loads(bridge.scanSignalXref(json.dumps({"data": draft}, ensure_ascii=False)))
            self.assertTrue(res["ok"], res)
            cards = {c["signal"]: c for c in res["xref"]["signals"]}
            self.assertIn("sig_draft_only", cards, "画布上新接的线必须立刻看得见")
            self.assertEqual(cards["sig_draft_only"]["listenerCount"], 1)
            # 草稿只进临时代理，真实模型纹丝不动
            self.assertEqual(
                [t["id"] for t in model.narrative_graphs["compositions"][0]["mainGraph"]["transitions"]],
                ["t1"],
            )
            self.assertFalse(model.is_dirty, "预览扫描不许标脏")

    def test_scan_sees_signals_registered_natively_after_the_page_loaded(self) -> None:
        """网页文档是加载期快照。原生「信号管理器」之后注册的信号，扫描必须也认——
        否则面板会把它们一律标成「没登记」，是假警报（而这正是策划刚建完新信号的时刻）。
        """
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            bridge = NarrativeEditorBridge(model)
            draft = json.loads(bridge.getData())        # 网页拿到的加载期快照
            # 之后原生信号管理器注册了一条新信号（直接改模型，网页并不知道）
            model.narrative_graphs["signals"].append({"id": "sig_new", "label": "刚建的"})

            res = json.loads(bridge.scanSignalXref(json.dumps({"data": draft}, ensure_ascii=False)))
            cards = {c["signal"]: c for c in res["xref"]["signals"]}
            self.assertIn("sig_new", cards)
            self.assertTrue(cards["sig_new"]["registered"], "宿主刚注册的信号不该被说成没登记")
            # 只读扫描：既不许改模型，也不许推进保存基线（那是保存路径的状态机）
            self.assertIsNone(bridge._pending_web_signal_ids)
            self.assertEqual(
                [s["id"] for s in model.narrative_graphs["signals"]], ["sig_x", "sig_new"],
            )

    def test_scan_reports_failure_instead_of_raising(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            bridge = NarrativeEditorBridge(model)
            res = json.loads(bridge.scanSignalXref("{not json"))
            # 坏入参回落真实模型（与既有 scan_* 一致），不炸
            self.assertTrue(res["ok"], res)

    def test_reveal_passes_three_states_through(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            for reply, expect_ok, expect_exact in (
                ((True, "已定位"), True, True),
                ((None, "已打开页面"), True, False),
                ((False, "没有对应编辑页"), False, False),
            ):
                win = _FakeHostWindow(reply)
                # 真的挂成父对象：走的就是生产代码里那条"沿 parent 链找宿主"的查找
                bridge = NarrativeEditorBridge(model, parent=win)
                res = json.loads(bridge.revealXrefRef(json.dumps({
                    "file": "public/assets/data/quests.json",
                    "pointer": "/0/onComplete/0",
                    "anchors": [["", "q_1"]],
                }, ensure_ascii=False)))
                self.assertEqual(res["ok"], expect_ok, res)
                self.assertEqual(res["exact"], expect_exact, res)
                self.assertEqual(win.calls[0][0], "public/assets/data/quests.json")
                self.assertEqual(win.calls[0][1], "/0/onComplete/0")
                self.assertEqual(win.calls[0][2], [["", "q_1"]])
                bridge.setParent(None)

    def test_reveal_reports_into_the_host_status_bar(self) -> None:
        """跳转会切走编辑页，写在叙事页上的回执当场就看不见了——必须同时丢一份到主窗状态栏。"""
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            win = _FakeHostWindow((None, "已打开图对话「甲」"))
            bridge = NarrativeEditorBridge(model, parent=win)
            bridge.revealXrefRef(json.dumps({"file": "a.json", "pointer": "/0"}))
            self.assertEqual(win.status_messages, [("已打开图对话「甲」", 6000)])
            bridge.setParent(None)

    def test_reveal_survives_a_throwing_host(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            win = _FakeHostWindow(RuntimeError("页面炸了"))
            bridge = NarrativeEditorBridge(model, parent=win)
            res = json.loads(bridge.revealXrefRef(json.dumps({"file": "a.json", "pointer": "/0"})))
            self.assertFalse(res["ok"])
            self.assertIn("跳转失败", res["reason"])
            bridge.setParent(None)

    def test_reveal_without_host_says_so(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            bridge = NarrativeEditorBridge(model)
            res = json.loads(bridge.revealXrefRef(json.dumps({"file": "x.json", "pointer": ""})))
            self.assertFalse(res["ok"])
            self.assertIn("跳转", res["reason"])

    def test_reveal_rejects_empty_file(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            bridge = NarrativeEditorBridge(model)
            res = json.loads(bridge.revealXrefRef(json.dumps({"pointer": "/0"})))
            self.assertFalse(res["ok"])
            self.assertIn("文件", res["reason"])


class _FakeHostWindow(QObject):
    """假宿主：只提供跳转引擎那一个方法，用来验证 bridge 沿 parent 链找得到它。"""

    def __init__(self, reply) -> None:
        super().__init__()
        self.reply = reply
        self.calls: list[tuple] = []
        self.status_messages: list[tuple[str, int]] = []
        outer = self

        class _Status:
            def showMessage(self, text, timeout=0):  # noqa: N802 - 照 QStatusBar 的接口
                outer.status_messages.append((text, timeout))

        self._status = _Status()

    def navigate_to_search_hit(self, file, pointer, anchors=None, matched_text="", context_text=""):
        self.calls.append((file, pointer, anchors, matched_text, context_text))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


class SignalXrefSourceParityTests(unittest.TestCase):
    """真实工程上，编辑器内存来源与磁盘来源必须给出**一模一样**的两侧。

    两个来源分别喂编辑器面板与调试器窗口；它们一旦漂移，同一条信号在两个工具里
    就会显示不同的关系——那比没有这个功能更糟。
    """

    def test_model_source_matches_disk_source_on_the_real_project(self) -> None:
        from tools.narrative_xref import build_index, from_disk, from_project_model

        model = ProjectModel()
        model.load_project(REPO_ROOT)
        model_index = build_index(from_project_model(model))
        disk_index = build_index(from_disk(REPO_ROOT))

        self.assertEqual(
            [c.to_dict() for c in model_index.overview()],
            [c.to_dict() for c in disk_index.overview()],
        )


if __name__ == "__main__":
    unittest.main()
