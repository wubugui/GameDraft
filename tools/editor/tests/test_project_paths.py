"""ProjectPaths 单元测试：迁移后路径策略契约。

锁住以下行为，避免再次改一露万：

* ``public/assets`` 仅文本/配置，``public/resources/runtime`` 承载所有媒体，
  ``resources/editor_projects`` 承载工具工程数据。
* URL → 磁盘解析按 ``kind`` 分流；媒体字段写 ``/assets/...`` 必须被拒绝。
* 场景 JSON 与场景媒体分别落到 assets 和 runtime 子树。
* 文件选择器默认目录覆盖图片、音频、场景包、动画、editor_projects 等。
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.shared.project_paths import (
    DIR_KIND_DATA,
    DIR_KIND_DIALOGUES,
    DIR_KIND_EDITOR_ANIMATION_PROJECT,
    DIR_KIND_EDITOR_ASSET_BROWSER_CACHE,
    DIR_KIND_EDITOR_ASSET_INBOX,
    DIR_KIND_EDITOR_ANIMVIDEO,
    DIR_KIND_EDITOR_DATA,
    DIR_KIND_EDITOR_MISC_MEDIA,
    DIR_KIND_EDITOR_PROJECTS,
    DIR_KIND_EDITOR_SCENE_WORKSPACE,
    DIR_KIND_FILTERS,
    DIR_KIND_RUNTIME_ANIMATION,
    DIR_KIND_RUNTIME_AUDIO,
    DIR_KIND_RUNTIME_IMAGES,
    DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS,
    DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS,
    DIR_KIND_RUNTIME_IMAGES_MINIGAMES,
    DIR_KIND_RUNTIME_IMAGES_NPCS,
    DIR_KIND_RUNTIME_ROOT,
    DIR_KIND_RUNTIME_SCENES,
    DIR_KIND_SCENE_JSON_DIR,
    DIR_KIND_SCENE_RUNTIME,
    URL_KIND_ANY,
    URL_KIND_MEDIA,
    URL_KIND_TEXT,
    ProjectPaths,
)


def _make_skeleton(root: Path) -> None:
    (root / "public" / "assets" / "data" / "filters").mkdir(parents=True)
    (root / "public" / "assets" / "scenes").mkdir(parents=True)
    (root / "public" / "assets" / "dialogues").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "images" / "illustrations").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "images" / "backgrounds").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "images" / "minigames").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "images" / "npcs").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "audio").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "animation").mkdir(parents=True)
    (root / "public" / "resources" / "runtime" / "scenes" / "demo").mkdir(parents=True)
    (root / "resources" / "editor_projects" / "editor_data" / "animation").mkdir(parents=True)
    (root / "resources" / "editor_projects" / "editor_data" / "asset_inbox").mkdir(parents=True)
    (root / "resources" / "editor_projects" / "editor_data" / "scene").mkdir(parents=True)


class TestRoots(unittest.TestCase):
    def test_three_authoritative_roots(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(paths.assets_root, root / "public" / "assets")
            self.assertEqual(paths.runtime_root, root / "public" / "resources" / "runtime")
            self.assertEqual(paths.editor_projects_root, root / "resources" / "editor_projects")
            self.assertEqual(paths.editor_data_root, root / "resources" / "editor_projects" / "editor_data")

    def test_text_layout_is_under_assets(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(paths.data_dir, root / "public" / "assets" / "data")
            self.assertEqual(paths.scenes_dir, root / "public" / "assets" / "scenes")
            self.assertEqual(paths.dialogues_dir, root / "public" / "assets" / "dialogues")
            self.assertEqual(paths.filters_dir, root / "public" / "assets" / "data" / "filters")

    def test_media_layout_is_under_runtime(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(paths.runtime_images_dir, root / "public" / "resources" / "runtime" / "images")
            self.assertEqual(paths.runtime_audio_dir, root / "public" / "resources" / "runtime" / "audio")
            self.assertEqual(paths.runtime_animation_dir, root / "public" / "resources" / "runtime" / "animation")
            self.assertEqual(paths.runtime_scenes_dir, root / "public" / "resources" / "runtime" / "scenes")


class TestSceneSplit(unittest.TestCase):
    def test_scene_json_in_assets(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.scene_json_path("码头白天"),
                root / "public" / "assets" / "scenes" / "码头白天.json",
            )

    def test_scene_runtime_dir_in_runtime(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.scene_runtime_dir("码头白天"),
                root / "public" / "resources" / "runtime" / "scenes" / "码头白天",
            )

    def test_scene_runtime_asset_short_name(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.scene_runtime_asset("码头白天", "background.png"),
                root / "public" / "resources" / "runtime" / "scenes" / "码头白天" / "background.png",
            )
            self.assertEqual(
                paths.scene_runtime_asset("码头白天", "raw_depth_rg.png"),
                root / "public" / "resources" / "runtime" / "scenes" / "码头白天" / "raw_depth_rg.png",
            )

    def test_scene_runtime_asset_full_runtime_url(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.scene_runtime_asset(
                    "ignored",
                    "/resources/runtime/images/illustrations/码头人群1.png",
                ),
                root / "public" / "resources" / "runtime" / "images" / "illustrations" / "码头人群1.png",
            )

    def test_scene_runtime_asset_rejects_assets_url(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            with self.assertRaises(ValueError):
                paths.scene_runtime_asset("码头白天", "/assets/images/x.png")

    def test_scene_id_must_be_clean(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            with self.assertRaises(ValueError):
                paths.scene_json_path("../escape")
            with self.assertRaises(ValueError):
                paths.scene_runtime_dir("a/b")


class TestUrlToDiskMedia(unittest.TestCase):
    def test_runtime_url_with_or_without_leading_slash(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            target = root / "public" / "resources" / "runtime" / "images" / "illustrations" / "x.png"
            self.assertEqual(
                paths.url_to_disk("/resources/runtime/images/illustrations/x.png", URL_KIND_MEDIA),
                target,
            )
            self.assertEqual(
                paths.url_to_disk("resources/runtime/images/illustrations/x.png", URL_KIND_MEDIA),
                target,
            )

    def test_short_relative_name_is_runtime_media(self) -> None:
        """与 [img:images/backgrounds/x.png] 这类历史短名一致：媒体短名落 runtime。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.url_to_disk("images/backgrounds/back_alley_dock_bg.png", URL_KIND_MEDIA),
                root / "public" / "resources" / "runtime" / "images" / "backgrounds" / "back_alley_dock_bg.png",
            )

    def test_assets_url_rejected_for_media(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(
                paths.url_to_disk("/assets/images/illustrations/x.png", URL_KIND_MEDIA),
            )
            self.assertIsNone(
                paths.url_to_disk("assets/images/x.png", URL_KIND_MEDIA),
            )

    def test_url_decoding_supports_chinese(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            encoded = "/resources/runtime/images/illustrations/%E7%A0%81%E5%A4%B4%E4%BA%BA%E7%BE%A41.png"
            self.assertEqual(
                paths.url_to_disk(encoded, URL_KIND_MEDIA),
                root / "public" / "resources" / "runtime" / "images" / "illustrations" / "码头人群1.png",
            )

    def test_path_traversal_rejected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(
                paths.url_to_disk("/resources/runtime/../../../escape.png", URL_KIND_MEDIA),
            )

    def test_http_url_is_not_local(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(paths.url_to_disk("https://example.com/a.png", URL_KIND_MEDIA))

    def test_absolute_path_returned_as_is(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            abs_path = (root / "any" / "where.png").resolve()
            self.assertEqual(paths.url_to_disk(str(abs_path), URL_KIND_MEDIA), abs_path)


class TestUrlToDiskText(unittest.TestCase):
    def test_assets_url_resolves_to_assets_root(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.url_to_disk("/assets/data/strings.json", URL_KIND_TEXT),
                root / "public" / "assets" / "data" / "strings.json",
            )

    def test_runtime_url_rejected_for_text(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(
                paths.url_to_disk("/resources/runtime/audio/a.wav", URL_KIND_TEXT),
            )


class TestUrlToDiskAny(unittest.TestCase):
    def test_any_accepts_both_roots(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.url_to_disk("/assets/data/x.json", URL_KIND_ANY),
                root / "public" / "assets" / "data" / "x.json",
            )
            self.assertEqual(
                paths.url_to_disk("/resources/runtime/audio/y.wav", URL_KIND_ANY),
                root / "public" / "resources" / "runtime" / "audio" / "y.wav",
            )


class TestUrlToDiskEditorProjects(unittest.TestCase):
    def test_editor_projects_url_resolves_under_editor_root(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.url_to_disk(
                    "/resources/editor_projects/editor_data/animation/project.json",
                    URL_KIND_TEXT,
                ),
                root / "resources" / "editor_projects" / "editor_data" / "animation" / "project.json",
            )

    def test_editor_projects_rejected_as_media(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(
                paths.url_to_disk(
                    "/resources/editor_projects/editor_data/x.png",
                    URL_KIND_MEDIA,
                ),
            )


class TestDiskToUrl(unittest.TestCase):
    def test_runtime_disk_to_url(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            disk = root / "public" / "resources" / "runtime" / "images" / "backgrounds" / "x.png"
            disk.write_bytes(b"")
            self.assertEqual(
                paths.disk_to_runtime_url(disk),
                "/resources/runtime/images/backgrounds/x.png",
            )

    def test_assets_disk_to_url(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            disk = root / "public" / "assets" / "data" / "strings.json"
            disk.write_text("{}", encoding="utf-8")
            self.assertEqual(paths.disk_to_assets_url(disk), "/assets/data/strings.json")

    def test_outside_returns_none(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertIsNone(paths.disk_to_runtime_url(Path(td) / "elsewhere.png"))
            self.assertIsNone(paths.disk_to_assets_url(Path(td) / "elsewhere.json"))

    def test_runtime_disk_must_not_resolve_to_assets_url(self) -> None:
        """媒体文件不允许伪装成 /assets/... URL（确保两根分流）。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            disk = root / "public" / "resources" / "runtime" / "audio" / "x.wav"
            disk.write_bytes(b"")
            self.assertIsNone(paths.disk_to_assets_url(disk))


class TestDefaultDirs(unittest.TestCase):
    def test_runtime_media_default_dirs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_ROOT),
                root / "public" / "resources" / "runtime",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_IMAGES),
                root / "public" / "resources" / "runtime" / "images",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS),
                root / "public" / "resources" / "runtime" / "images" / "illustrations",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS),
                root / "public" / "resources" / "runtime" / "images" / "backgrounds",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_IMAGES_MINIGAMES),
                root / "public" / "resources" / "runtime" / "images" / "minigames",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_IMAGES_NPCS),
                root / "public" / "resources" / "runtime" / "images" / "npcs",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_AUDIO),
                root / "public" / "resources" / "runtime" / "audio",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_ANIMATION),
                root / "public" / "resources" / "runtime" / "animation",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_RUNTIME_SCENES),
                root / "public" / "resources" / "runtime" / "scenes",
            )

    def test_scene_runtime_default_dir_uses_scene_id(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir(DIR_KIND_SCENE_RUNTIME, scene_id="码头白天"),
                root / "public" / "resources" / "runtime" / "scenes" / "码头白天",
            )

    def test_scene_runtime_without_scene_id_falls_back(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir(DIR_KIND_SCENE_RUNTIME),
                root / "public" / "resources" / "runtime" / "scenes",
            )

    def test_text_default_dirs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir(DIR_KIND_SCENE_JSON_DIR),
                root / "public" / "assets" / "scenes",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_DATA),
                root / "public" / "assets" / "data",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_DIALOGUES),
                root / "public" / "assets" / "dialogues",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_FILTERS),
                root / "public" / "assets" / "data" / "filters",
            )

    def test_editor_projects_default_dirs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_PROJECTS),
                root / "resources" / "editor_projects",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_DATA),
                root / "resources" / "editor_projects" / "editor_data",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_ANIMATION_PROJECT),
                root / "resources" / "editor_projects" / "editor_data" / "animation",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_ASSET_INBOX),
                root / "resources" / "editor_projects" / "editor_data" / "asset_inbox",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_ANIMVIDEO),
                root / "resources" / "editor_projects" / "editor_data" / "animvideo",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_SCENE_WORKSPACE),
                root / "resources" / "editor_projects" / "editor_data" / "scene",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_ASSET_BROWSER_CACHE),
                root / "resources" / "editor_projects" / "editor_data" / "asset_browser_cache",
            )
            self.assertEqual(
                paths.default_dir(DIR_KIND_EDITOR_MISC_MEDIA),
                root / "resources" / "editor_projects" / "misc_media",
            )

    def test_unknown_kind_raises(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            with self.assertRaises(ValueError):
                paths.default_dir("not_a_real_kind")

    def test_default_dir_existing_or_root_falls_back(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            paths = ProjectPaths(root)
            # 没有任何子目录时，回退应该到 project_root
            self.assertEqual(
                paths.default_dir_existing_or_root(DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS),
                root,
            )

    def test_default_dir_existing_or_root_returns_real_dir(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            self.assertEqual(
                paths.default_dir_existing_or_root(DIR_KIND_RUNTIME_IMAGES_BACKGROUNDS),
                root / "public" / "resources" / "runtime" / "images" / "backgrounds",
            )


class TestUnderHelpers(unittest.TestCase):
    def test_is_under_runtime(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            self.assertTrue(
                paths.is_under_runtime(
                    root / "public" / "resources" / "runtime" / "images" / "illustrations" / "x.png",
                ),
            )
            self.assertFalse(
                paths.is_under_runtime(root / "public" / "assets" / "data" / "x.json"),
            )

    def test_is_under_assets(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            self.assertTrue(
                paths.is_under_assets(root / "public" / "assets" / "scenes" / "demo.json"),
            )
            self.assertFalse(
                paths.is_under_assets(
                    root / "public" / "resources" / "runtime" / "audio" / "x.wav",
                ),
            )

    def test_is_under_editor_projects(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _make_skeleton(root)
            paths = ProjectPaths(root)
            self.assertTrue(
                paths.is_under_editor_projects(
                    root / "resources" / "editor_projects" / "editor_data" / "animation",
                ),
            )
            self.assertFalse(
                paths.is_under_editor_projects(
                    root / "public" / "resources" / "runtime" / "images",
                ),
            )


if __name__ == "__main__":
    unittest.main()
