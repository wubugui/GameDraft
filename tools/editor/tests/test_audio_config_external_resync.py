# -*- coding: utf-8 -*-
"""audio_config.json 的跨进程同步护栏。

由来:音频加工台(tools/audio_editor)在外面改 audio_config 里某些 key 的 src,
而主编辑器这边的 audio_config **只在打开工程时读一次**、保存又是「内存整份 dump
回盘」,并且 `StagedJsonWriter.expect_unchanged` 这条外部改动基线全库零调用者。
三件事叠起来的后果:外部工具改好的 src,会被这边下一次 Save All 静默盖回旧值,
界面还报「保存成功」——成果凭空消失且无人察觉。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from PySide6.QtWidgets import QApplication

from tools.editor.editors.audio_editor import AudioEditor
from tools.editor.main_window import MainWindow
from tools.editor.project_model import ProjectModel


class AudioConfigResyncTests(unittest.TestCase):
    def _model(self, doc: dict) -> tuple[ProjectModel, Path]:
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        data = root / "public/assets/data"
        data.mkdir(parents=True)
        cfg = data / "audio_config.json"
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        model = ProjectModel()
        model.project_path = root
        # 必须走 _load：它同时登记外部改动基线，那正是 Save All 的闸所依赖的东西
        model.audio_config = model._load(cfg, {})
        return model, cfg

    def _base(self) -> dict:
        return {"bgm": {}, "ambient": {}, "sfx": {"k": {"src": "/resources/runtime/audio/a.wav"}},
                "systemSfx": {}}

    def test_unchanged_when_disk_matches_memory(self):
        model, _cfg = self._model(self._base())
        self.assertEqual(model.reload_audio_config_from_disk(), "unchanged")

    def test_external_write_is_picked_up(self):
        model, cfg = self._model(self._base())
        doc = self._base()
        doc["sfx"]["k"]["src"] = "/resources/runtime/audio/edited/from_tool.wav"
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        self.assertEqual(model.reload_audio_config_from_disk(), "reloaded")
        self.assertEqual(model.audio_config["sfx"]["k"]["src"],
                         "/resources/runtime/audio/edited/from_tool.wav",
                         "外部工具的写入没被同步进来 —— 下次 Save All 就会盖掉它")

    def test_dirty_audio_blocks_reload_instead_of_eating_edits(self):
        """两边都有真东西时自动取哪边都会吞掉另一边,所以一律不动、交给人。"""
        model, cfg = self._model(self._base())
        model.audio_config["sfx"]["k"]["volume"] = 0.5      # 面板里改了没保存
        model.mark_dirty("audio")
        doc = self._base()
        doc["sfx"]["k"]["src"] = "/resources/runtime/audio/edited/from_tool.wav"
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        self.assertEqual(model.reload_audio_config_from_disk(), "blocked")
        self.assertEqual(model.audio_config["sfx"]["k"]["volume"], 0.5,
                         "用户没保存的改动被磁盘版本吞掉了")

    def test_no_project_is_safe(self):
        model = ProjectModel()
        self.assertEqual(model.reload_audio_config_from_disk(), "unchanged")

    def test_peeking_at_disk_never_touches_the_external_change_baseline(self):
        """只是「看一眼盘上是什么」不许动基线。

        那份基线是 Save All 发现「文件被别的进程改过」的唯一凭据
        (detect_external_changes + 提交时的 expect_unchanged)。用 `_load` 去偷看一眼
        就会把它刷成磁盘现值 —— 等于亲手拆掉这道 fail-closed 的闸,外部写入从
        「被拦下」变成「被静默覆盖」。
        """
        model, cfg = self._model(self._base())
        key = model._baseline_key(cfg)
        before = model._file_baselines.get(key)

        doc = self._base()
        doc["sfx"]["k"]["src"] = "/resources/runtime/audio/edited/from_tool.wav"
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        self.assertTrue(model.audio_config_differs_on_disk())
        self.assertEqual(model._file_baselines.get(key), before, "偷看一眼就把基线冲掉了")

        model.mark_dirty("audio")
        self.assertEqual(model.reload_audio_config_from_disk(), "blocked")
        self.assertEqual(model._file_baselines.get(key), before,
                         "blocked 分支也把基线冲掉了 —— Save All 的外部改动闸就此失效")
        self.assertIn("public/assets/data/audio_config.json", model.detect_external_changes())


class AudioPanelResyncTests(unittest.TestCase):
    """面板层：模型被重读之后,那四张表必须跟着重铺。

    由来(对抗复审实测):音频面板的表格是开工程时的一次性快照,全类没有 showEvent /
    data_changed 订阅。只换模型不换表格,面板反而会因为「表 ≠ 模型」判成脏,
    于是 Save All 用陈旧表格把刚同步进来的 src 又写回去 —— 比不同步更糟。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _project(self) -> tuple[ProjectModel, Path]:
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        data = root / "public/assets/data"
        data.mkdir(parents=True)
        cfg = data / "audio_config.json"
        doc = {"bgm": {}, "ambient": {},
               "sfx": {"k": {"src": "/resources/runtime/audio/a.wav", "volume": 0.8}},
               "systemSfx": {}}
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        model = ProjectModel()
        model.project_path = root
        model.audio_config = model._load(cfg, {})
        return model, cfg

    def _owner(self, model, panel):
        """够用的 MainWindow 替身：本方法只用到这几样。"""
        msgs: list[str] = []
        owner = SimpleNamespace(
            _model=model,
            _status=SimpleNamespace(showMessage=lambda text, ms=0: msgs.append(text)),
            _editor_instances=[panel],
            _messages=msgs,
        )
        owner._find_audio_editor = lambda: MainWindow._find_audio_editor(owner)
        owner._warn_audio_config_conflict = lambda: MainWindow._warn_audio_config_conflict(owner)
        return owner

    def _external_write(self, cfg: Path, src: str) -> None:
        doc = json.loads(cfg.read_text(encoding="utf-8"))
        doc["sfx"]["k"]["src"] = src
        cfg.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def test_external_src_survives_a_following_save_all_flush(self):
        model, cfg = self._project()
        panel = AudioEditor(model)
        self.addCleanup(panel.deleteLater)
        self.assertFalse(panel.has_unapplied_edits(), "刚开就脏了")

        new_src = "/resources/runtime/audio/edited/from_tool_ab12cd34.wav"
        self._external_write(cfg, new_src)
        MainWindow._resync_audio_config_from_disk(self._owner(model, panel))
        self.assertEqual(model.audio_config["sfx"]["k"]["src"], new_src)

        # Save All 会无差别对每个面板 flush —— 这一步以前会把陈旧表格写回去
        panel.flush_to_model(for_save_all=True)
        self.assertEqual(model.audio_config["sfx"]["k"]["src"], new_src,
                         "面板用开工程时的陈旧表格把外部写入盖回去了")
        self.assertEqual(model.audio_config["sfx"]["k"]["volume"], 0.8, "volume 掉了")
        self.assertNotIn("audio", model._dirty, "什么都没改却标了脏")

    def test_unapplied_panel_edits_block_the_resync(self):
        """面板里有没提交的编辑时,两边都有真东西 —— 一律不动,交给人。"""
        model, cfg = self._project()
        panel = AudioEditor(model)
        self.addCleanup(panel.deleteLater)
        sfx_tab = panel._sub_tabs[2]
        sfx_tab.add_row("panel_only", "/resources/runtime/audio/typed_by_hand.wav")
        self.assertTrue(panel.has_unapplied_edits())

        self._external_write(cfg, "/resources/runtime/audio/edited/from_tool.wav")
        owner = self._owner(model, panel)
        MainWindow._resync_audio_config_from_disk(owner)

        self.assertEqual(model.audio_config["sfx"]["k"]["src"],
                         "/resources/runtime/audio/a.wav", "模型被自动同步了,吞掉了面板里的编辑")
        self.assertIn("panel_only", sfx_tab._table_ids(), "面板里的编辑被冲掉了")
        self.assertTrue(any("停止自动同步" in m for m in owner._messages), "冲突没有告诉人")


if __name__ == "__main__":
    unittest.main()
