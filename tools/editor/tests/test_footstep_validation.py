"""脚步集与空间化音频（`footstep_sets.json`）的校验。

这一套校验**全是 warning 级**，因为整个特性可以一条都不配（脚步素材尚未入库时
`sets` 就是空的）。配错的代价不是崩溃而是"安静地没声音"，
所以每一条都必须**只在数据真的有问题时才报**——正常数据一条 warning 都不许多出来，
否则收尾门（不新增 error、warning 数不增加）立刻被自己卡住。

最要命的那条是「音效 key 没在 `audio_config.sfx` 里登记」：`AudioManager.playSfx`
对未知 id 是 `if (!entry) return;`，没有 warn、没有事件、调试面板也看不出来。

每集形状：`{label?, sfx:{片段名: 一条音效key}, gainDb?}`。没有变体数组、没有抖动；
触地帧不在这份文件里（住动画包 sockets.json 的 contactSlots，见 test_contact_slots.py）。

**跑法分两层**：绝大多数用例走 `_validate_footstep_sets` 本体（够快，能一个用例只坏一处），
`WiredIntoValidateTests` 单独钉住"它真的被 `validate()` 挂上了"——
本仓反复吃过"函数写对了但没挂进入口、一条也不跑"的亏。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    repo_root_from_tests,
    write_minimal_loadable_project,
)
from tools.editor.validator import (
    _FOOTSTEP_MAX_DISTANCE_MIN_RATIO,
    _validate_footstep_sets,
    validate,
)

#: 干净的一份：两个集各给片段一条 key、回落无环、spatial 比值健康、听者是 camera。
#: 每个坏数据用例都从它拷一份、**只坏一处**——这样"多报的那条"必然出自那一处。
_CLEAN: dict[str, Any] = {
    "sets": {
        "石板": {
            "label": "青石板",
            "sfx": {"walk": "step_stone_1", "run": "step_stone_run_1"},
        },
        "泥地": {
            "sfx": {"walk": "step_mud_1"},
        },
    },
    "clipFallback": {"carry_walk": "walk", "crouchWalk": "walk"},
    "defaults": {"gainDb": -6},
    # v3 起直达声参数在声学空间 direct 里，这里只剩相机后退（旧的四项写了会报「运行时已不读」）
    "spatial": {
        "listenerBackAtBaseZoomWu": 600,
    },
    "listener": {"mode": "camera"},
}

#: `_CLEAN` 里用到的全部音效 key，都在 audio_config 的 sfx 区登记过。
_SFX = {
    aid: {"src": f"/resources/runtime/audio/{aid}.wav"}
    for s in _CLEAN["sets"].values()
    for aid in s["sfx"].values()
}


def _clone(obj: Any) -> Any:
    """深拷贝走 json 往返：顺带保证测试数据本身是可序列化的真 JSON 形状。"""
    return json.loads(json.dumps(obj, ensure_ascii=False))


def _issues(
    footstep: Any = None,
    *,
    scenes: dict[str, dict] | None = None,
    audio: dict[str, Any] | None = None,
) -> list[str]:
    """跑 `_validate_footstep_sets`，返回 `"[severity] message"`。

    校验器只碰 `footstep_sets` / `audio_config` / `scenes` 三个属性，所以用桩就够——
    不必为每个用例现建一个临时工程（40 多个用例那样跑要慢一个数量级）。
    """
    model = SimpleNamespace(
        footstep_sets=_CLEAN if footstep is None else footstep,
        audio_config={"sfx": _SFX} if audio is None else audio,
        scenes=scenes or {},
    )
    out: list[Any] = []
    _validate_footstep_sets(model, out)  # type: ignore[arg-type]
    return [f"[{i.severity}] {i.message}" for i in out]


def _mutate(**patch: Any) -> dict[str, Any]:
    d = _clone(_CLEAN)
    d.update(patch)
    return d


def _scene(sid: str, **extra: Any) -> dict[str, Any]:
    d: dict[str, Any] = {"id": sid, "name": sid, "hotspots": [], "npcs": [],
                         "zones": [], "spawnPoints": {}}
    d.update(extra)
    return d


class FootstepCleanDataTests(unittest.TestCase):
    def test_clean_config_is_silent(self) -> None:
        self.assertEqual(_issues(), [])

    def test_empty_sets_is_silent(self) -> None:
        """素材没入库时 `sets` 是空的。这**必须**零 warning。"""
        self.assertEqual(_issues(_mutate(sets={})), [])

    def test_missing_file_is_silent(self) -> None:
        """缺文件时 ProjectModel 按空表处理，同样不该报。"""
        self.assertEqual(_issues({}), [])

    def test_everything_is_warning_level(self) -> None:
        """铁律：校验器只能比运行时松。任何一条升成 error 都会卡住收尾门。"""
        broken = _mutate(
            sets={"坏": {"sfx": {"walk": "没登记的key"}}, "旧": {"variants": {"walk": ["a"]}}},
            clipFallback={"a": "b", "b": "a"},
            contactFrames={"walk": [3, 11]},
            spatial={"maxDistanceWu": 300, "listenerBackAtBaseZoomWu": 600},
            listener={"mode": "npc"},
        )
        msgs = _issues(broken, scenes={"sc": _scene("sc", footstepSet="没这个集")})
        self.assertTrue(msgs)
        self.assertTrue(all(m.startswith("[warning] ") for m in msgs), msgs)


class FootstepDefaultsTests(unittest.TestCase):
    """`defaults`:全局音量缩放 gainDb + 空间化总闸 spatialized。"""

    def test_valid_defaults_are_silent(self) -> None:
        self.assertEqual(_issues(_mutate(defaults={"gainDb": -6, "spatialized": False})), [])
        self.assertEqual(_issues(_mutate(defaults={"gainDb": 0, "spatialized": True})), [])
        self.assertEqual(_issues(_mutate(defaults={})), [])

    def test_non_bool_spatialized_is_reported(self) -> None:
        """运行时判据是 `!== false`:写 0 / "false" 判不出来,作者以为关了其实没关。"""
        for bad in (0, 1, "false", "off", None if False else "true"):
            with self.subTest(bad=bad):
                msgs = _issues(_mutate(defaults={"spatialized": bad}))
                self.assertTrue(any("spatialized" in m for m in msgs), (bad, msgs))

    def test_non_num_gain_is_reported(self) -> None:
        msgs = _issues(_mutate(defaults={"gainDb": "-6"}))
        self.assertTrue(any("gainDb" in m for m in msgs), msgs)

    def test_defaults_wrong_shape(self) -> None:
        msgs = _issues(_mutate(defaults=[1, 2]))
        self.assertTrue(any("defaults" in m for m in msgs), msgs)


class FootstepSfxKeyTests(unittest.TestCase):
    def test_unregistered_sfx_key_is_reported(self) -> None:
        d = _clone(_CLEAN)
        d["sets"]["石板"]["sfx"]["run"] = "step_stone_不存在"
        msgs = _issues(d)
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("step_stone_不存在", msgs[0])
        self.assertIn("sfx", msgs[0])

    def test_id_registered_in_another_channel_does_not_count(self) -> None:
        """只认 sfx 区：`playSfx` 按区查表不回落，登记在 voice 区等于没登记。"""
        d = _clone(_CLEAN)
        d["sets"]["泥地"]["sfx"]["walk"] = "只在voice里"
        msgs = _issues(d, audio={"sfx": _SFX, "voice": {"只在voice里": {"src": "x.wav"}}})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("只在voice里", msgs[0])

    def test_missing_sfx_channel_entirely(self) -> None:
        msgs = _issues(audio={})
        self.assertEqual(len(msgs), len(_SFX), msgs)  # _CLEAN 的每一条 key 都报一次
        self.assertTrue(all("sfx" in m for m in msgs), msgs)

    def test_illegal_id_is_reported_as_illegal_not_missing(self) -> None:
        d = _clone(_CLEAN)
        d["sets"]["泥地"]["sfx"]["walk"] = " 前导空格"
        msgs = _issues(d)
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("不合法", msgs[0])

    def test_non_string_value(self) -> None:
        """一个片段只有一条 key：数组（旧变体形状的残留）与数字都报，且说明「没有变体数组」。

        （合法形状现在有两种：裸 key 与带本处音量的 ``{id, volume}``。）
        """
        for bad in (["step_mud_1", "step_mud_2"], 42, None):
            with self.subTest(bad=bad):
                d = _clone(_CLEAN)
                d["sets"]["泥地"]["sfx"]["walk"] = bad
                msgs = _issues(d)
                self.assertEqual(len(msgs), 1, msgs)
                self.assertIn("没有变体数组", msgs[0])

    def test_object_form_with_site_volume_is_accepted(self) -> None:
        """带本处音量的 ``{id, volume}`` 是合法形状（同一条素材挂两个片段、其中一个要轻一半）。"""
        d = _clone(_CLEAN)
        walk = d["sets"]["泥地"]["sfx"]["walk"]
        d["sets"]["泥地"]["sfx"]["walk"] = {"id": walk, "volume": 0.5}
        self.assertEqual(_issues(d), [])

    def test_object_form_with_unknown_id_still_warns(self) -> None:
        d = _clone(_CLEAN)
        d["sets"]["泥地"]["sfx"]["walk"] = {"id": "没登记过的", "volume": 0.5}
        msgs = _issues(d)
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("audio_config.sfx", msgs[0])

    def test_empty_key_means_unset(self) -> None:
        d = _clone(_CLEAN)
        d["sets"]["泥地"]["sfx"]["walk"] = ""
        msgs = _issues(d)
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("没选音效", msgs[0])

    def test_legacy_variants_shape_is_reported(self) -> None:
        """旧形状 `variants` 运行时不读——整集无声，必须点名说是旧形状而不是「缺少 sfx」。"""
        msgs = _issues(_mutate(sets={"x": {"variants": {"walk": ["step_mud_1"]}}}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("旧形状", msgs[0])
        self.assertIn("variants", msgs[0])

    def test_sfx_wrong_shapes(self) -> None:
        self.assertTrue(any("缺少 sfx" in m
                            for m in _issues(_mutate(sets={"x": {}}))))
        self.assertTrue(any("sfx 须为对象" in m
                            for m in _issues(_mutate(sets={"x": {"sfx": []}}))))
        self.assertTrue(any("该集须为对象" in m
                            for m in _issues(_mutate(sets={"x": "step_mud_1"}))))

    def test_top_level_and_sets_shape(self) -> None:
        self.assertTrue(any("顶层须为对象" in m for m in _issues([1, 2])))
        self.assertTrue(any("sets 须为对象" in m for m in _issues(_mutate(sets=[]))))


class FootstepLegacyContactFramesTests(unittest.TestCase):
    def test_contact_frames_key_is_reported_as_moved(self) -> None:
        """触地帧已迁到动画包 sockets.json 的 contactSlots；留在这里的键运行时不读。"""
        msgs = _issues(_mutate(contactFrames={"walk": [3, 11]}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("contactSlots", msgs[0])
        self.assertIn("动画浏览", msgs[0])

    def test_absent_key_is_silent(self) -> None:
        self.assertEqual(_issues(), [])


class FootstepClipFallbackTests(unittest.TestCase):
    def test_two_step_cycle(self) -> None:
        msgs = _issues(_mutate(clipFallback={"a": "b", "b": "a"}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("成环", msgs[0])
        self.assertIn("a → b → a", msgs[0])

    def test_self_cycle(self) -> None:
        msgs = _issues(_mutate(clipFallback={"walk": "walk"}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("walk → walk", msgs[0])

    def test_one_cycle_reported_once_even_with_many_entrances(self) -> None:
        """三条链都汇进同一个环，只该报一次——否则一个笔误刷出一屏 warning。"""
        msgs = _issues(_mutate(clipFallback={
            "a": "b", "b": "c", "c": "a", "d": "a", "e": "b",
        }))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("成环", msgs[0])

    def test_two_independent_cycles_both_reported(self) -> None:
        msgs = _issues(_mutate(clipFallback={"a": "b", "b": "a", "x": "y", "y": "x"}))
        self.assertEqual(len(msgs), 2, msgs)

    def test_long_acyclic_chain_is_silent(self) -> None:
        self.assertEqual(_issues(_mutate(clipFallback={
            "carry_heavy_walk": "carry_walk", "carry_walk": "walk", "crouchWalk": "walk",
        })), [])

    def test_wrong_shapes(self) -> None:
        self.assertTrue(any("clipFallback 须为对象" in m
                            for m in _issues(_mutate(clipFallback=["walk"]))))
        for bad in ("", "   ", 3, None):
            with self.subTest(bad=bad):
                self.assertTrue(any("回落目标须为非空片段名" in m
                                    for m in _issues(_mutate(clipFallback={"a": bad}))))


class FootstepSpatialTests(unittest.TestCase):
    """v3（2026-09-08）起脚步走空间音总线：直达声参数住在声学空间 `direct` 里，
    `spatial.refDistanceWu / rolloff / maxDistanceWu / panWidth` 运行时不读——写了要说它们已经死了。"""

    def test_dead_keys_warn_once_and_name_them(self) -> None:
        msgs = _issues(_mutate(spatial={
            "maxDistanceWu": 300, "listenerBackAtBaseZoomWu": 600,
        }))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("运行时已不读", msgs[0])
        self.assertIn("maxDistanceWu", msgs[0])
        msgs = _issues(_mutate(spatial={"refDistanceWu": 150, "panWidth": 0.7}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("refDistanceWu/panWidth", msgs[0])

    def test_live_keys_alone_are_silent(self) -> None:
        """还有用的两项（相机后退 / 平面纵深系数）单独写不报。"""
        self.assertEqual(_issues(_mutate(spatial={"listenerBackAtBaseZoomWu": 600})), [])
        self.assertEqual(_issues(_mutate(spatial={"planarDepthScale": 1.4142})), [])
        self.assertEqual(_issues(_mutate(spatial={})), [])

    def test_ratio_constant_still_importable(self) -> None:
        self.assertGreater(_FOOTSTEP_MAX_DISTANCE_MIN_RATIO, 1)

    def test_non_numeric_values(self) -> None:
        msgs = _issues(_mutate(spatial={"listenerBackAtBaseZoomWu": "600"}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("须为数值", msgs[0])
        self.assertTrue(any("spatial 须为对象" in m
                            for m in _issues(_mutate(spatial=[3000]))))


class FootstepListenerTests(unittest.TestCase):
    def test_npc_without_target(self) -> None:
        for cfg in ({"mode": "npc"}, {"mode": "npc", "targetId": ""},
                    {"mode": "npc", "targetId": "   "}):
            with self.subTest(cfg=cfg):
                msgs = _issues(_mutate(listener=cfg))
                self.assertEqual(len(msgs), 1, msgs)
                self.assertIn("targetId", msgs[0])

    def test_npc_with_target_is_silent(self) -> None:
        self.assertEqual(_issues(_mutate(listener={"mode": "npc", "targetId": "blind_li"})), [])

    def test_fixed_missing_coordinates(self) -> None:
        msgs = _issues(_mutate(listener={"mode": "fixed"}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("x", msgs[0])
        self.assertIn("y", msgs[0])
        msgs = _issues(_mutate(listener={"mode": "fixed", "x": 100}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("y", msgs[0])

    def test_fixed_non_numeric_coordinate(self) -> None:
        """运行时判的是 `typeof cfg.x !== 'number'`——字符串 '100' 直接回落 camera。"""
        msgs = _issues(_mutate(listener={"mode": "fixed", "x": "100", "y": 200}))
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("x", msgs[0])

    def test_fixed_with_coordinates_is_silent(self) -> None:
        self.assertEqual(_issues(
            _mutate(listener={"mode": "fixed", "x": 100, "y": 200, "heightWu": 150})), [])

    def test_zero_coordinates_are_valid(self) -> None:
        self.assertEqual(_issues(_mutate(listener={"mode": "fixed", "x": 0, "y": 0})), [])

    def test_unknown_mode(self) -> None:
        for cfg in ({"mode": "player_"}, {"mode": ""}, {}, {"mode": 3}):
            with self.subTest(cfg=cfg):
                msgs = _issues(_mutate(listener=cfg))
                self.assertEqual(len(msgs), 1, msgs)
                self.assertIn("camera", msgs[0])

    def test_camera_and_player_modes_are_silent(self) -> None:
        for mode in ("camera", "player"):
            with self.subTest(mode=mode):
                self.assertEqual(_issues(_mutate(listener={"mode": mode})), [])

    def test_listener_wrong_shape(self) -> None:
        self.assertTrue(any("listener 须为对象" in m
                            for m in _issues(_mutate(listener="camera"))))


class FootstepSceneZoneRefTests(unittest.TestCase):
    def test_ref_to_known_set_is_silent(self) -> None:
        self.assertEqual(_issues(scenes={
            "sc_a": _scene("sc_a", footstepSet="石板",
                           zones=[{"id": "z", "footstepSet": "泥地"}]),
        }), [])

    def test_dangling_scene_ref(self) -> None:
        msgs = _issues(scenes={"sc_a": _scene("sc_a", footstepSet="不存在的集")})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("不存在的集", msgs[0])

    def test_dangling_zone_ref(self) -> None:
        msgs = _issues(scenes={"sc_a": _scene("sc_a", zones=[
            {"id": "z_泥", "footstepSet": "泥地"},
            {"id": "z_坏", "footstepSet": "没有这个集"},
        ])})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("z_坏", msgs[0])
        self.assertIn("没有这个集", msgs[0])

    def test_empty_ref_is_not_a_reference(self) -> None:
        """不写 / 写空串 = 本处不发脚步，是合法选择，不该报。"""
        self.assertEqual(_issues(scenes={
            "sc_a": _scene("sc_a", footstepSet="", zones=[{"id": "z", "footstepSet": ""}]),
            "sc_b": _scene("sc_b"),
        }), [])

    def test_dangling_ref_against_empty_sets(self) -> None:
        """脚步集空表是常态（素材未入库），但此时引用确确实实是悬垂的——
        运行时只 warnOnce 一次，正要靠这条报出来，不能像 smell 那样加空表护栏。"""
        msgs = _issues(_mutate(sets={}), scenes={"sc_a": _scene("sc_a", footstepSet="石板")})
        self.assertEqual(len(msgs), 1, msgs)

    def test_depth_floor_zone_footstep_set_is_a_noop(self) -> None:
        msgs = _issues(scenes={"sc_a": _scene("sc_a", zones=[
            {"id": "z_遮挡", "zoneKind": "depth_floor", "footstepSet": "石板"},
        ])})
        self.assertEqual(len(msgs), 1, msgs)
        self.assertIn("depth_floor", msgs[0])

    def test_malformed_zone_entry_does_not_crash(self) -> None:
        self.assertEqual(_issues(scenes={
            "sc_a": _scene("sc_a", zones=["junk", None, {"id": "z"}]),
        }), [])


class WiredIntoValidateTests(unittest.TestCase):
    """这一套真的被 `validate()` 挂上了——写对了却没挂进入口是本仓的老坑。"""

    @staticmethod
    def _run(footstep: Any, scenes: dict[str, dict] | None = None) -> list[Any]:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.footstep_sets = footstep
            model.audio_config = {"sfx": _SFX}
            if scenes is not None:
                model.scenes = scenes
            return validate(model)

    def test_bad_config_surfaces_through_public_entry(self) -> None:
        issues = self._run(_mutate(listener={"mode": "npc"}))
        hits = [i for i in issues if i.data_type == "footstep_sets"]
        self.assertEqual(len(hits), 1, [i.message for i in hits])
        self.assertEqual(hits[0].severity, "warning")
        self.assertIn("targetId", hits[0].message)

    def test_dangling_scene_ref_surfaces_through_public_entry(self) -> None:
        issues = self._run(_CLEAN, {"sc_a": _scene("sc_a", footstepSet="没这个集")})
        hits = [i for i in issues
                if i.data_type == "scene" and "footstepSet" in i.message]
        self.assertEqual(len(hits), 1, [i.message for i in hits])
        self.assertEqual(hits[0].severity, "warning")

    def test_clean_config_adds_nothing(self) -> None:
        issues = self._run(_CLEAN)
        self.assertEqual(
            [i.message for i in issues
             if i.data_type in ("footstep_sets", "footstep_set")
             or (i.data_type == "scene" and "footstepSet" in i.message)],
            [],
        )


class RealRepoDataTests(unittest.TestCase):
    """仓库真实数据现在**必须**零脚步 warning——收尾门判据是 warning 数不增加。"""

    @staticmethod
    def _repo_json(rel: str) -> Any:
        path = repo_root_from_tests() / "public" / "assets" / rel
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def test_repo_footstep_config_is_clean(self) -> None:
        data = self._repo_json("data/footstep_sets.json")
        if data is None:
            self.skipTest("footstep_sets.json 不在预期位置")
        audio = self._repo_json("data/audio_config.json") or {}
        msgs = _issues(data, audio=audio)
        self.assertEqual(msgs, [], "仓库真实脚步配置多出了 warning，收尾门会被卡住")

    def test_repo_scenes_have_no_dangling_footstep_refs(self) -> None:
        data = self._repo_json("data/footstep_sets.json")
        scenes_dir = repo_root_from_tests() / "public" / "assets" / "scenes"
        if data is None or not scenes_dir.is_dir():
            self.skipTest("仓库数据不在预期位置")
        scenes: dict[str, dict] = {}
        for p in sorted(scenes_dir.glob("*.json")):
            try:
                sc = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(sc, dict):
                scenes[str(sc.get("id") or p.stem)] = sc
        self.assertTrue(scenes, "一个场景都没读到，这条断言等于没跑")
        # sets 之外的项由上一条覆盖；这里只看引用面，音效 key 用真表以免噪声
        audio = self._repo_json("data/audio_config.json") or {}
        msgs = [m for m in _issues(data, scenes=scenes, audio=audio) if "footstepSet" in m]
        self.assertEqual(msgs, [])


if __name__ == "__main__":
    unittest.main()
