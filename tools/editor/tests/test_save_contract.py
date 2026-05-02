"""save_all：校验顺序、写盘失败后 dirty、磁盘不变、增量写、大批量过场步骤。"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    copy_assets_subset,
    file_sha256,
    repo_root_from_tests,
    snapshot_json_hashes,
    write_minimal_loadable_project,
)


class TestSaveContract(unittest.TestCase):
    """保存契约自动化（先于性能优化锁定语义）。"""

    @classmethod
    def setUpClass(cls) -> None:
        if QApplication.instance() is None:
            cls._qt_app = QApplication(sys.argv)
        else:
            cls._qt_app = QApplication.instance()

    def test_not_dirty_does_not_call_presave_validators(self) -> None:
        calls: dict[str, int] = {}

        def vref(model):
            calls["refs"] = calls.get("refs", 0) + 1
            return None

        def vs(*args, **kwargs):  # noqa: ANN001
            calls["scenario"] = calls.get("scenario", 0) + 1
            return None

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)

            written: list[str] = []

            def capture(p: Path, _data):
                written.append(Path(p).name)

            self.assertFalse(m.is_dirty)
            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save", vref,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                vs,
            ), patch(
                "tools.editor.project_model.write_json", side_effect=capture,
            ):
                m.save_all()
            self.assertEqual(calls, {})
            self.assertEqual(written, [])

    # ---- validator ordering ------------------------------------------------

    def test_presave_validator_order_before_writes(self) -> None:
        log: list[str] = []

        def vref(model):
            log.append("ref_validator")
            return None

        def vscenario(*args, **kwargs):  # noqa: ANN001
            log.append("scenario_validator")
            return None

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            self.assertFalse(m.is_dirty)
            m.game_config["_touch"] = 1
            m.mark_dirty("config")

            def wj(path: Path, _data):  # noqa: ANN001
                log.append(f"write:{path.name}")

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save", vref,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                vscenario,
            ), patch("tools.editor.project_model.write_json", side_effect=wj):
                m.save_all()

        self.assertIn("ref_validator", log)
        self.assertIn("scenario_validator", log)
        ir = log.index("ref_validator")
        iscen = log.index("scenario_validator")
        iw = next(i for i, x in enumerate(log) if x.startswith("write:"))
        self.assertLess(ir, iscen)
        self.assertLess(iscen, iw)

    def test_save_all_project_path_none_is_silent_noop(self) -> None:
        m = ProjectModel()
        self.assertIsNone(m.project_path)
        called: list[int] = []

        def boom(*_a, **_k):
            called.append(1)

        with patch("tools.editor.project_model.write_json", side_effect=boom):
            m.save_all()
        self.assertEqual(called, [])

    def test_scenario_validation_failure_no_write_keeps_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.game_config["_probe"] = 1
            m.mark_dirty("config")
            writes: list[Path] = []

            def cap(p: Path, _d):
                writes.append(p)

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value="stub scenario catalog error",
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                with self.assertRaises(ValueError) as ar:
                    m.save_all()
            self.assertIn("stub scenario", ar.exception.args[0])
            self.assertEqual(writes, [])
            self.assertTrue(m.is_dirty)

    def test_real_ref_validator_rejects_missing_item_tag(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.items[0]["name"] = "[tag:item:__NOT_AN_ITEM_ID__]"
            m.mark_dirty("item")
            writes: list[Path] = []

            def cap(p: Path, _d):
                writes.append(p)

            with patch("tools.editor.project_model.write_json", side_effect=cap):
                with self.assertRaises(ValueError) as ar:
                    m.save_all()
            self.assertIn("嵌入引用", ar.exception.args[0])
            self.assertEqual(writes, [])
            self.assertTrue(m.is_dirty)

    # ---- validation failure: no mutation on disk ----------------------------

    def test_validation_failure_leaves_existing_files_bytes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            items_path = root / "public" / "assets" / "data" / "items.json"
            digest_before = file_sha256(items_path)
            self.assertFalse(m.is_dirty)

            m.items[0]["name"] = "[tag:item:__DOES_NOT_EXIST__]"
            m.mark_dirty("item")

            def _fail_refs(_model):
                return "stub invalid tag"

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save", _fail_refs,
            ):
                with self.assertRaises(ValueError):
                    m.save_all()
            digest_after = file_sha256(items_path)
            self.assertEqual(digest_before, digest_after)
            self.assertTrue(m.is_dirty)

    # ---- mid-batch write failure: dirty preserved --------------------------

    def test_write_failure_keeps_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.game_config["_a"] = 1
            m.items[0]["name"] = "still_ok"
            m.mark_dirty("config")
            m.mark_dirty("item")
            writes: list[int] = []

            def boom(path: Path, _data):  # noqa: ANN001
                writes.append(1)
                if len(writes) >= 2:
                    raise OSError("simulated_io_error")

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=boom):
                with self.assertRaises(OSError):
                    m.save_all()
            self.assertTrue(m.is_dirty)
            self.assertEqual(len(writes), 2)

    # ---- incremental by dirty bucket -------------------------------------

    def test_dirty_scene_item_id_writes_single_scene_only(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)

            touched: list[Path] = []

            def cap(p: Path, _data):  # noqa: ANN001
                touched.append(Path(p))

            m.scenes["sc_a"]["name"] = "Patched_A"
            m.mark_dirty("scene", "sc_a")
            snap_before_other = snapshot_json_hashes(
                root / "public" / "assets" / "scenes",
            )
            snap_before_data = snapshot_json_hashes(
                root / "public" / "assets" / "data",
            )

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            sp = root / "public" / "assets" / "scenes"
            self.assertEqual(touched, [sp / "sc_a.json"])
            self.assertFalse(m.is_dirty)
            after = snapshot_json_hashes(root / "public" / "assets" / "scenes")
            self.assertEqual(after["sc_b.json"], snap_before_other["sc_b.json"])
            after_data = snapshot_json_hashes(root / "public" / "assets" / "data")
            self.assertEqual(after_data, snap_before_data)

    def test_dirty_scene_all_writes_every_scene_json(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            m.scenes["sc_a"]["name"] = "All_A"
            m.scenes["sc_b"]["name"] = "All_B"
            m.mark_dirty("scene", "")

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            sp = root / "public" / "assets" / "scenes"
            want = sorted([sp / "sc_a.json", sp / "sc_b.json"])
            self.assertEqual(sorted(touched), want)
            self.assertFalse(m.is_dirty)

    def test_dirty_item_writes_only_aggregate_items(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)

            touched: list[Path] = []

            def cap(p: Path, _data):  # noqa: ANN001
                touched.append(Path(p))

            m.items[0]["name"] = "renamed_plain"
            m.mark_dirty("item")
            scenes_before = snapshot_json_hashes(root / "public" / "assets" / "scenes")

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            dp = root / "public" / "assets" / "data"
            self.assertEqual(touched, [dp / "items.json"])
            scenes_after = snapshot_json_hashes(root / "public" / "assets" / "scenes")
            self.assertEqual(scenes_before, scenes_after)

    def test_dirty_flag_registry_writes_only_flag_registry(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.flag_registry["static"] = [{"key": "f_contract", "valueType": "bool"}]
            m.mark_dirty("flag_registry")

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            fp = root / "public" / "assets" / "data" / "flag_registry.json"
            self.assertEqual(touched, [fp])
            self.assertFalse(m.is_dirty)

    def test_dirty_scenarios_writes_only_scenarios_json(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.scenarios_catalog = {"scenarios": [{"id": "s_contract", "phases": {}}]}
            m.mark_dirty("scenarios")

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            dp = root / "public" / "assets" / "data"
            self.assertEqual(touched, [dp / "scenarios.json"])
            self.assertFalse(m.is_dirty)

    def test_dirty_overlay_images_writes_only_overlay_json(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.overlay_images["x"] = "y.png"
            m.mark_dirty("overlay_images")

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            dp = root / "public" / "assets" / "data"
            self.assertEqual(touched, [dp / "overlay_images.json"])
            self.assertFalse(m.is_dirty)

    def test_dirty_document_reveals_writes_only_document_reveals(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.document_reveals.append({"id": "dr1"})
            m.mark_dirty("document_reveals")

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            dp = root / "public" / "assets" / "data"
            self.assertEqual(touched, [dp / "document_reveals.json"])
            self.assertFalse(m.is_dirty)

    def test_dirty_archive_writes_four_archive_aggregates(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.archive_characters.append({"id": "c_arc", "name": "N"})
            m.mark_dirty("archive")

            touched: list[Path] = []

            def cap(p: Path, _data):
                touched.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            ap = root / "public" / "assets" / "data" / "archive"
            want = sorted([
                ap / "characters.json",
                ap / "lore.json",
                ap / "books.json",
                ap / "documents.json",
            ])
            self.assertEqual(sorted(touched), want)
            self.assertFalse(m.is_dirty)

    def test_filter_dirty_unlinks_orphan_files(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            fd = root / "public" / "assets" / "data" / "filters"
            fd.mkdir(parents=True, exist_ok=True)
            (fd / "gone.json").write_text("{}\n", encoding="utf-8")
            (fd / "stay.json").write_text(
                json.dumps({"keep": True}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            m = ProjectModel()
            m.load_project(root)
            self.assertIn("gone", m.filter_defs)
            del m.filter_defs["gone"]
            m.mark_dirty("filter")
            m.save_all()
            self.assertFalse(m.is_dirty)
            self.assertFalse((fd / "gone.json").is_file())
            self.assertTrue((fd / "stay.json").is_file())

    # ---- cutscene bulk steps (pressure, no Timeline UI) --------------------

    def test_cutscene_large_steps_saved_intact(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            blob = [{"kind": "present", "type": "waitClick"}] * 120
            m.cutscenes[0]["steps"] = blob  # id cut_ok
            m.mark_dirty("cutscene")

            payloads: dict[str, dict] = {}

            def cap(p: Path, data):  # noqa: ANN001
                payloads[Path(p).name] = data

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=cap):
                m.save_all()

            self.assertFalse(m.is_dirty)
            cs = payloads.get("index.json")
            assert isinstance(cs, list) and cs
            self.assertEqual(len(cs[0].get("steps", [])), 120)
            dumped = json.dumps(cs, ensure_ascii=False, indent=2) + "\n"
            rnd = json.loads(dumped)
            self.assertEqual(len(rnd[0]["steps"]), 120)

    def test_cutscene_mixed_step_shapes_pressure(self) -> None:
        """不少于 105 步，含并行轨与占位字幕文本（不含 tag 前缀）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)

            seq: list[dict] = []
            for _ in range(60):
                seq.append({"kind": "present", "type": "waitClick"})
                seq.append({"kind": "present", "type": "waitTime", "duration": 50})
            seq.append({"kind": "present", "type": "showSubtitle", "text": "", "position": "bottom"})
            seq.append({"kind": "action", "type": "playSfx", "params": {"key": ""}})
            seq.append({
                "kind": "parallel",
                "tracks": [
                    {"kind": "present", "type": "waitClick"},
                    {"kind": "present", "type": "hideImg", "id": "h1"},
                ],
            })

            payload: dict | None = None

            def grab(_path: Path, data):  # noqa: ANN001
                nonlocal payload
                if isinstance(data, list):
                    payload = {"list": data}

            m.cutscenes[0]["steps"] = seq
            self.assertGreater(len(seq), 100)
            m.mark_dirty("cutscene")

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch("tools.editor.project_model.write_json", side_effect=grab):
                m.save_all()

            lst = payload["list"]
            loaded = lst[0]
            steps = loaded.get("steps", [])
            self.assertEqual(len(steps), len(seq))
            self.assertEqual(steps[-1]["kind"], "parallel")
            self.assertEqual(len(steps[-1]["tracks"]), 2)
            self.assertEqual(steps[-1]["tracks"][1].get("type"), "hideImg")

    # ---- optional fixture copy (真实 assets 裁剪) -------------------------

    def test_fixture_copy_only_dirty_config_writes(self) -> None:
        repo = repo_root_from_tests()
        if not (repo / "public" / "assets").is_dir():
            raise unittest.SkipTest("仓库缺少 public/assets，跳过拷贝用例")

        with TemporaryDirectory() as td:
            dst = Path(td) / "proj"
            # dialogues/graphs 与 scenarios dialogueGraphIds 对齐会标 dirty；拷贝 dialogues 避免误 Skip
            subs: tuple[str, ...] = ("data", "scenes", "dialogues")
            copy_assets_subset(repo, dst, subs)

            dp = dst / "public" / "assets" / "data"
            scenes_dir = dst / "public" / "assets" / "scenes"
            if not dp.is_dir():
                raise unittest.SkipTest("拷贝后缺少 data")

            m = ProjectModel()
            try:
                m.load_project(dst)
            except Exception as exc:
                raise unittest.SkipTest(f"fixture 加载不适合本机快照: {exc}") from exc

            if m.is_dirty:
                try:
                    m.save_all()
                except ValueError as exc:
                    raise unittest.SkipTest(
                        f"fixture 对齐/保存前置失败，跳过：{exc}",
                    ) from exc
                if m.is_dirty:
                    raise unittest.SkipTest(
                        "载入后仍存在非零 dirty（非本用例能稳定断言的配置），跳过",
                    )

            hashes_before_data = snapshot_json_hashes(dp)
            hashes_before_scenes = (
                snapshot_json_hashes(scenes_dir) if scenes_dir.is_dir() else {}
            )
            m.game_config["_editor_incr_contract_probe"] = 1
            m.mark_dirty("config")

            try:
                m.save_all()
            except ValueError as exc:
                raise unittest.SkipTest(f"fixture 数据未通过保存前校验，跳过：{exc}") from exc

            self.assertFalse(m.is_dirty)
            hashes_after_data = snapshot_json_hashes(dp)
            changed = {
                rel
                for rel in hashes_before_data
                if hashes_before_data[rel] != hashes_after_data.get(rel)
            }
            self.assertEqual(
                changed,
                {"game_config.json"},
                msg=f"仅 config dirty 时应只重写 game_config；实际变动: {changed}",
            )

            hashes_after_scenes = (
                snapshot_json_hashes(scenes_dir) if scenes_dir.is_dir() else {}
            )
            self.assertEqual(hashes_before_scenes, hashes_after_scenes)


if __name__ == "__main__":
    unittest.main()
