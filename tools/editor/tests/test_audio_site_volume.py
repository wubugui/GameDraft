# -*- coding: utf-8 -*-
"""逐处音量（本处音量）的编辑器侧护栏。

制作人的原话是「配置各种 BGS/SE 的时候不能设置音量，只有一个预览声音，预览声音有个鸡儿用」——
所以这一套锁的就是两件事：

1. **每个引用点都能设音量，且写得进数据**（不是只在 playSfx 一个 action 上有）；
2. **▶ 试听按运行时音量放**（否则那一格只是装饰，作者调到"听着刚好"，进游戏还是不对）。

外加三条数据安全底线（往返保真 / 未知键保留 / 载入不脏），破一条就是静默毁数据。
"""
from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import audio_cue  # noqa: E402
from tools.editor.shared import audio_library as lib  # noqa: E402
from tools.editor.shared.audio_preview_selector import AudioIdPreviewSelector  # noqa: E402
from tools.editor.tests.save_test_utils import (  # noqa: E402
    write_minimal_loadable_project,
)

REPO = Path(__file__).resolve().parents[3]


# ===========================================================================
# 跨语言镜像 parity
# ===========================================================================

class ChannelDefaultParityTests(unittest.TestCase):
    """通道出厂音量是一份**跨语言镜像**：漂了不报错，只会让试听说谎。"""

    def test_channel_defaults_match_runtime(self) -> None:
        src = (REPO / "src/systems/AudioManager.ts").read_text("utf-8")
        expected = {}
        for channel in ("bgm", "sfx", "ambient", "voice"):
            m = re.search(rf"private\s+{channel}Volume\s*=\s*([0-9.]+)\s*;", src)
            self.assertIsNotNone(
                m, f"没能从 AudioManager.ts 解析出 {channel}Volume 初值（字段被改名了？）",
            )
            expected[channel] = float(m.group(1))
        self.assertEqual(
            lib.CHANNEL_DEFAULT_VOLUME, expected,
            "编辑器侧的通道出厂音量与运行时漂了——试听会按错的响度放",
        )

    def test_unknown_channel_falls_back_to_full(self) -> None:
        self.assertEqual(lib.channel_default_volume("不存在的通道"), 1.0)


# ===========================================================================
# 纯解析/写回
# ===========================================================================

class AudioCueHelperTests(unittest.TestCase):
    def test_parses_both_shapes(self) -> None:
        self.assertEqual(audio_cue.cue_id("sfx_a"), "sfx_a")
        self.assertEqual(audio_cue.cue_id({"id": " sfx_a "}), "sfx_a")
        self.assertEqual(audio_cue.cue_id(None), "")
        self.assertEqual(audio_cue.cue_id(5), "")

    def test_zero_volume_is_not_unset(self) -> None:
        """0 = "这里就是要哑"，与"没配"是两回事——合并了就把手配的静音吃掉。"""
        self.assertEqual(audio_cue.cue_volume({"id": "a", "volume": 0}), 0)
        self.assertIsNone(audio_cue.cue_volume({"id": "a"}))
        self.assertIsNone(audio_cue.cue_volume("a"))

    def test_volume_keeps_literal_type(self) -> None:
        """int 保 int：往返保真，`1` 不许漂成 `1.0`。"""
        v = audio_cue.cue_volume({"id": "a", "volume": 1})
        self.assertIsInstance(v, int)
        self.assertNotIsInstance(audio_cue.cue_volume({"id": "a", "volume": True}), int)

    def test_make_cue_writes_bare_id_when_neutral(self) -> None:
        self.assertEqual(audio_cue.make_cue("a", None), "a")
        self.assertEqual(audio_cue.make_cue("a", 0.5), {"id": "a", "volume": 0.5})
        self.assertIsNone(audio_cue.make_cue("  ", 0.5))

    def test_make_cue_preserves_unknown_keys(self) -> None:
        """🔴 对象形态以后会长出 pan/fadeMs：重建新对象 = 把别人的字段静默删掉。"""
        original = {"id": "a", "volume": 0.5, "pan": -0.3, "作者注": "留着"}
        out = audio_cue.make_cue("a", 0.2, original)
        self.assertEqual(out, {"id": "a", "volume": 0.2, "pan": -0.3, "作者注": "留着"})
        # 清掉音量也只删 volume 一个键
        out2 = audio_cue.make_cue("a", None, original)
        self.assertEqual(out2, {"id": "a", "pan": -0.3, "作者注": "留着"})

    def test_make_cue_collapses_id_only_object(self) -> None:
        self.assertEqual(audio_cue.make_cue("a", None, {"id": "a"}), "a")

    def test_resolve_volume_for_write(self) -> None:
        N = audio_cue.NEUTRAL_VOLUME
        # 没动过 → 原样回写（含盘上写着的中性 1）
        self.assertEqual(audio_cue.resolve_volume_for_write(1.0, 1.0, 1), 1)
        self.assertIsNone(audio_cue.resolve_volume_for_write(N, N, None))
        # 动过且落在中性 → 不写键
        self.assertIsNone(audio_cue.resolve_volume_for_write(N, 0.5, 0.5))
        # 动过且非中性 → 新值
        self.assertEqual(audio_cue.resolve_volume_for_write(0.25, 1.0, None), 0.25)


# ===========================================================================
# 共享控件
# ===========================================================================

class SelectorVolumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        write_minimal_loadable_project(self.root)
        self.model = ProjectModel()
        self.model.load_project(self.root)
        self.model.audio_config.setdefault("sfx", {}).update({
            "sfx_door": {"src": "/resources/runtime/audio/door.wav", "volume": 0.5},
            "sfx_tick": {"src": "/resources/runtime/audio/tick.wav"},
        })
        self._widgets: list[AudioIdPreviewSelector] = []

    def tearDown(self) -> None:
        for w in self._widgets:
            w.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def _sel(self, *, with_volume: bool = True) -> AudioIdPreviewSelector:
        w = AudioIdPreviewSelector(
            self.model, "sfx", allow_empty=True, editable=True, with_volume=with_volume,
        )
        w.set_items([("sfx_door", "sfx_door"), ("sfx_tick", "sfx_tick")])
        self._widgets.append(w)
        return w

    # ------------------------------------------------------------- 载入不脏
    def test_programmatic_set_emits_nothing(self) -> None:
        w = self._sel()
        fired: list[int] = []
        w.changed.connect(lambda: fired.append(1))
        w.value_changed.connect(lambda _v: fired.append(1))
        w.set_cue({"id": "sfx_door", "volume": 0.3})
        self.assertEqual(fired, [], "程序性装载发信号 = 打开面板即脏（红线）")

    def test_user_volume_edit_emits_changed(self) -> None:
        """只接 value_changed 的调用点会漏掉纯音量改动——控件这一侧必须发得出来。"""
        w = self._sel()
        w.set_cue("sfx_door")
        fired: list[int] = []
        w.changed.connect(lambda: fired.append(1))
        w._volume.setValue(0.4)
        self.assertTrue(fired, "改音量必须发 changed，否则切走就丢")

    # ------------------------------------------------------------- 往返保真
    def test_untouched_roundtrip_is_byte_identical(self) -> None:
        for raw in ("sfx_door", {"id": "sfx_door", "volume": 0.25},
                    {"id": "sfx_door", "volume": 1}, {"id": "sfx_door", "volume": 5.0}):
            with self.subTest(raw=raw):
                w = self._sel()
                w.set_cue(raw)
                self.assertEqual(w.cue_for_write(), raw, "打开即保存不许改动任何一个字节")

    def test_neutral_edit_drops_the_key(self) -> None:
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 0.25})
        w._volume.setValue(audio_cue.NEUTRAL_VOLUME)
        self.assertEqual(w.cue_for_write(), "sfx_door", "调回中性就该回到裸 id，不留噪音键")

    def test_edit_writes_object_form(self) -> None:
        w = self._sel()
        w.set_cue("sfx_door")
        w._volume.setValue(0.35)
        self.assertEqual(w.cue_for_write(), {"id": "sfx_door", "volume": 0.35})

    def test_over_range_original_is_not_silently_clamped(self) -> None:
        """盘上超出控件量程的值：没动过就得原样回写，不能被 Qt 的量程悄悄改小。"""
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 9.0})
        self.assertEqual(w.cue_for_write(), {"id": "sfx_door", "volume": 9.0})

    def test_unknown_keys_survive_a_volume_edit(self) -> None:
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 0.2, "pan": -0.5})
        w._volume.setValue(0.8)
        self.assertEqual(w.cue_for_write(), {"id": "sfx_door", "volume": 0.8, "pan": -0.5})

    # ------------------------------------------------------------- 试听口径
    def test_preview_gain_uses_site_volume_over_entry_volume(self) -> None:
        """本处音量**替换**素材级，再乘通道出厂音量（与运行时同口径）。"""
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 0.25})
        gain = w._preview.runtime_gain("sfx_door")
        self.assertAlmostEqual(gain, 0.25 * lib.channel_default_volume("sfx"), places=6)

    def test_preview_gain_falls_back_to_entry_volume(self) -> None:
        w = self._sel()
        w.set_cue("sfx_door")           # 素材级 0.5
        self.assertAlmostEqual(
            w._preview.runtime_gain("sfx_door"),
            0.5 * lib.channel_default_volume("sfx"), places=6,
        )

    def test_preview_gain_is_clamped_to_full_scale(self) -> None:
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 4.0})
        self.assertLessEqual(w._preview.runtime_gain("sfx_door"), 1.0)

    def test_preview_gain_zero_is_silent_not_original(self) -> None:
        w = self._sel()
        w.set_cue({"id": "sfx_door", "volume": 0})
        self.assertEqual(w._preview.runtime_gain("sfx_door"), 0.0)

    def test_selector_without_volume_still_previews_at_entry_volume(self) -> None:
        w = self._sel(with_volume=False)
        w.set_cue("sfx_door")
        self.assertAlmostEqual(
            w._preview.runtime_gain("sfx_door"),
            0.5 * lib.channel_default_volume("sfx"), places=6,
        )


# ===========================================================================
# 校验器
# ===========================================================================

class ValidatorSiteVolumeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        write_minimal_loadable_project(self.root)
        self.model = ProjectModel()
        self.model.load_project(self.root)
        self.model.audio_config.setdefault("ambient", {})["amb_ok"] = {"src": "/a.wav"}
        self.model.audio_config.setdefault("bgm", {})["bgm_ok"] = {"src": "/b.mp3"}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _issues(self, scene: dict) -> list:
        from tools.editor import validator
        issues: list = []
        self.model.scenes = {"sc": scene}
        validator._validate_scene_audio_cues(self.model, issues)
        return issues

    def _texts(self, scene: dict) -> str:
        return "\n".join(i.message for i in self._issues(scene))

    def test_valid_scene_is_silent(self) -> None:
        self.assertEqual(self._issues({
            "bgm": {"id": "bgm_ok", "volume": 0.5},
            "ambientSounds": [{"id": "amb_ok", "volume": 0.2}],
        }), [])

    def test_unknown_ambient_id_warns(self) -> None:
        """此前这一面**一个字都没校验过**：改名一条环境音，场景静默失声。"""
        self.assertIn("audio_config.ambient", self._texts({"ambientSounds": ["没这条"]}))

    def test_unknown_bgm_id_warns(self) -> None:
        self.assertIn("audio_config.bgm", self._texts({"bgm": {"id": "没这首"}}))

    def test_non_numeric_volume_is_an_error(self) -> None:
        txt = self._texts({"bgm": {"id": "bgm_ok", "volume": "响一点"}})
        self.assertIn("须为数值", txt)

    def test_absurd_volume_warns_but_over_one_is_fine(self) -> None:
        self.assertNotIn("大得离谱", self._texts({"bgm": {"id": "bgm_ok", "volume": 1.5}}))
        self.assertIn("大得离谱", self._texts({"bgm": {"id": "bgm_ok", "volume": 40}}))

    def test_duplicate_ambient_layer_warns(self) -> None:
        """同层写两遍：运行时只留第一条，后写那条的音量静默不生效。"""
        txt = self._texts({"ambientSounds": ["amb_ok", {"id": "amb_ok", "volume": 0.2}]})
        self.assertIn("出现了两次", txt)

    def test_shape_error_is_reported_not_crashed(self) -> None:
        self.assertIn("须是音频 id", self._texts({"bgm": 42}))

    def test_time_variant_audio_is_checked_too(self) -> None:
        txt = self._texts({
            "timeVariants": {"夜": {"ambientSounds": ["夜里没这条"]}},
        })
        self.assertIn("timeVariants.夜.ambientSounds[0]", txt)


# ===========================================================================
# 页面级：每个引用点都真能设、真写得进数据
# ===========================================================================

class _PageBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        write_minimal_loadable_project(self.root)
        self.model = ProjectModel()
        self.model.load_project(self.root)
        self.model.audio_config.setdefault("sfx", {}).update({
            "sfx_door": {"src": "/resources/runtime/audio/door.wav"},
            "sfx_step": {"src": "/resources/runtime/audio/step.wav"},
        })
        self.model.audio_config.setdefault("ambient", {}).update({
            "amb_wind": {"src": "/resources/runtime/audio/wind.wav"},
        })
        self.model.audio_config.setdefault("bgm", {}).update({
            "bgm_theme": {"src": "/resources/runtime/audio/theme.mp3"},
        })
        self._trash: list = []

    def tearDown(self) -> None:
        for w in self._trash:
            try:
                w.deleteLater()
            except Exception:
                pass
        QApplication.processEvents()
        self._tmp.cleanup()


class ScenePageVolumeTests(_PageBase):
    """场景的 BGS（ambientSounds）与 BGM —— 制作人点名的那两处。"""

    def _panel(self, scene: dict):
        from tools.editor.editors.scene_editor import SceneEditor
        self.model.scenes = {"sc_a": scene}
        ed = SceneEditor(self.model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._trash.append(ed)
        return ed._props

    @staticmethod
    def _scene(**over) -> dict:
        sc = {"id": "sc_a", "name": "甲", "hotspots": [], "npcs": [], "zones": []}
        sc.update(over)
        return sc

    def test_ambient_volume_loads_and_writes_back(self) -> None:
        panel = self._panel(self._scene(ambientSounds=[{"id": "amb_wind", "volume": 0.2}]))
        self.assertEqual(panel._current_ambient_preview_volume(), None)  # 还没选中行
        panel._sc_ambient_list.setCurrentRow(0)
        self.assertAlmostEqual(panel._current_ambient_preview_volume(), 0.2)
        self.assertEqual(
            panel._ambient_cues_from_widgets(), [{"id": "amb_wind", "volume": 0.2}],
        )

    def test_ambient_volume_edit_lands_on_the_selected_row_only(self) -> None:
        panel = self._panel(self._scene(ambientSounds=["amb_wind", "amb_other"]))
        panel._sc_ambient_list.setCurrentRow(1)
        panel._sc_ambient_volume.setValue(0.3)
        self.assertEqual(
            panel._ambient_cues_from_widgets(),
            ["amb_wind", {"id": "amb_other", "volume": 0.3}],
        )

    def test_switching_rows_does_not_leak_the_previous_volume(self) -> None:
        """🔴 换行时 setValue 若不挡信号，就会把上一行的音量写到新选中的行上。"""
        panel = self._panel(self._scene(ambientSounds=[
            {"id": "amb_wind", "volume": 0.2}, "amb_other",
        ]))
        panel._sc_ambient_list.setCurrentRow(0)
        panel._sc_ambient_list.setCurrentRow(1)
        self.assertEqual(
            panel._ambient_cues_from_widgets(),
            [{"id": "amb_wind", "volume": 0.2}, "amb_other"],
        )

    def test_ambient_volume_follows_the_row_when_reordered(self) -> None:
        panel = self._panel(self._scene(ambientSounds=[
            "amb_wind", {"id": "amb_other", "volume": 0.25},
        ]))
        panel._sc_ambient_list.setCurrentRow(1)
        panel._move_ambient(-1)
        self.assertEqual(
            panel._ambient_cues_from_widgets(),
            [{"id": "amb_other", "volume": 0.25}, "amb_wind"],
        )

    def test_bgm_volume_roundtrips(self) -> None:
        panel = self._panel(self._scene(bgm={"id": "bgm_theme", "volume": 0.4}))
        self.assertEqual(panel._sc_bgm.current_id(), "bgm_theme")
        sc: dict = {"bgm": {"id": "bgm_theme", "volume": 0.4}}
        panel._flush_scene_widgets_into(sc)
        self.assertEqual(sc["bgm"], {"id": "bgm_theme", "volume": 0.4})

    def test_bgm_volume_edit_is_written(self) -> None:
        panel = self._panel(self._scene(bgm="bgm_theme"))
        panel._sc_bgm._volume.setValue(0.5)
        sc: dict = {"bgm": "bgm_theme"}
        panel._flush_scene_widgets_into(sc)
        self.assertEqual(sc["bgm"], {"id": "bgm_theme", "volume": 0.5})

    def test_legacy_bare_ids_roundtrip_untouched(self) -> None:
        """旧数据零迁移：没人碰过的场景保存出来必须一字不差。"""
        panel = self._panel(self._scene(bgm="bgm_theme", ambientSounds=["amb_wind"]))
        sc: dict = {"bgm": "bgm_theme", "ambientSounds": ["amb_wind"]}
        panel._flush_scene_widgets_into(sc)
        self.assertEqual(sc["bgm"], "bgm_theme")
        self.assertEqual(sc["ambientSounds"], ["amb_wind"])


class SystemSfxPageVolumeTests(_PageBase):
    """系统音效表：同一条素材当确认音要清脆、当悬停音要压低。"""

    def test_volume_roundtrip_through_the_table(self) -> None:
        from tools.editor.editors.audio_editor import _SystemSfxTab as SystemSfxTab
        self.model.audio_config["systemSfx"] = {
            "uiHover": {"id": "sfx_door", "volume": 0.15},
            "uiConfirm": "sfx_step",
        }
        tab = SystemSfxTab(self.model)
        self._trash.append(tab)
        tab._refresh()
        self.assertFalse(tab._is_dirty(), "打开即脏是红线")
        self.assertEqual(tab._build_mapping(), self.model.audio_config["systemSfx"])

    def test_setting_a_volume_marks_dirty_and_writes_object(self) -> None:
        from tools.editor.editors.audio_editor import _SystemSfxTab as SystemSfxTab
        self.model.audio_config["systemSfx"] = {"uiHover": "sfx_door"}
        tab = SystemSfxTab(self.model)
        self._trash.append(tab)
        tab._refresh()
        sel = tab._table.cellWidget(0, 1)
        sel._volume.setValue(0.15)
        self.assertTrue(tab._is_dirty())
        self.assertEqual(tab._build_mapping(), {"uiHover": {"id": "sfx_door", "volume": 0.15}})


class FootstepPageVolumeTests(_PageBase):
    """脚步集：同一条素材挂在两个片段上、其中一个要轻一半。"""

    def _editor(self, sets: dict):
        from tools.editor.editors.footstep_sets_editor import FootstepSetsEditor
        self.model.footstep_sets = {"sets": sets}
        ed = FootstepSetsEditor(self.model)
        self._trash.append(ed)
        ed._refresh_set_list()
        ed._set_list.setCurrentRow(0)
        return ed

    def test_object_form_loads_into_the_selector(self) -> None:
        ed = self._editor({"stone": {"sfx": {"walk": {"id": "sfx_step", "volume": 0.5}}}})
        ed._clip_list.setCurrentRow(0)
        self.assertTrue(ed._sfx_selector.isEnabled())
        self.assertEqual(ed._sfx_selector.current_id(), "sfx_step")
        self.assertAlmostEqual(ed._sfx_selector.current_volume(), 0.5)

    def test_volume_edit_writes_object_form(self) -> None:
        ed = self._editor({"stone": {"sfx": {"walk": "sfx_step"}}})
        ed._clip_list.setCurrentRow(0)
        ed._sfx_selector._volume.setValue(0.4)
        self.assertEqual(ed._sfx["walk"], {"id": "sfx_step", "volume": 0.4})

    def test_malformed_values_stay_read_only(self) -> None:
        """数组/数字这些本页不认识的形状仍旧只读透传（旧契约不许退化）。"""
        ed = self._editor({"stone": {"sfx": {"walk": ["a", "b"]}}})
        ed._clip_list.setCurrentRow(0)
        self.assertFalse(ed._sfx_selector.isEnabled())
        self.assertEqual(ed._sfx["walk"], ["a", "b"])


class ActionEditorVolumeTests(_PageBase):
    """三个音频 action 的 volume 参数都住在 id 选择器里（与 ▶ 同一个数）。"""

    def _editor(self, action: dict):
        from tools.editor.shared.action_editor import ActionEditor
        ed = ActionEditor("测试")
        ed.set_project_context(self.model, None)
        ed.set_data([action])
        self._trash.append(ed)
        return ed

    def _row_widget(self, ed):
        return ed._rows[0] if hasattr(ed, "_rows") else None

    def test_each_audio_action_carries_a_volume(self) -> None:
        cases = [
            ({"type": "playSfx", "params": {"id": "sfx_door", "volume": 0.3}}, 0.3),
            ({"type": "playBgm", "params": {"id": "bgm_theme", "volume": 0.4}}, 0.4),
            ({"type": "playSceneAmbient", "params": {"id": "amb_wind", "volume": 0.2}}, 0.2),
        ]
        for action, expected in cases:
            with self.subTest(action["type"]):
                ed = self._editor(action)
                out = ed.to_list()[0]
                self.assertAlmostEqual(out["params"]["volume"], expected)

    def test_untouched_action_roundtrips(self) -> None:
        for action in (
            {"type": "playSfx", "params": {"id": "sfx_door"}},
            {"type": "playBgm", "params": {"id": "bgm_theme", "fadeMs": 500}},
            {"type": "playSceneAmbient", "params": {"id": "amb_wind", "volume": 1}},
        ):
            with self.subTest(action["type"]):
                ed = self._editor(json.loads(json.dumps(action)))
                self.assertEqual(ed.to_list()[0], action)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
