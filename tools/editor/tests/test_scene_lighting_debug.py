from __future__ import annotations

import sys

import numpy as np
from PIL import Image
import pytest

from tools.scene_depth_editor.lighting_debug import (
    FATE_HIT,
    FinalGatherSettings,
    MISS_HIT_NORMALIZED,
    QuadSettings,
    build_quad_samples,
    cosine_hemisphere_directions,
    trace_depth_field,
)
from tools.scene_depth_editor.reconstruction import OrthoProjection


def _projection(*, ppu: float = 10.0) -> OrthoProjection:
    return OrthoProjection(
        R=np.eye(3, dtype=np.float64),
        ppu=ppu,
        cx=256.0,
        cy=256.0,
    )


def test_cosine_directions_stay_in_requested_hemisphere() -> None:
    normals = np.array([
        [0.0, 0.0, -1.0],
        [0.6, 0.0, -0.8],
        [0.0, 1.0, 0.0],
    ], dtype=np.float32)
    directions = cosine_hemisphere_directions(
        normals, 1024, seed=11, point_indices=np.arange(3, dtype=np.int32),
    )
    dots = np.sum(directions * normals[:, None, :], axis=-1)
    assert directions.shape == (3, 1024, 3)
    assert float(dots.min()) > 0.0
    assert np.allclose(np.linalg.norm(directions, axis=-1), 1.0, atol=2e-6)
    assert np.allclose(dots.mean(axis=1), 2.0 / 3.0, atol=2e-3)


def test_quad_bulge_moves_center_cameraward_and_derives_normals() -> None:
    sprite = Image.new("RGBA", (24, 32), (160, 120, 80, 255))
    settings = QuadSettings(
        foot_world=(1.0, 2.0, 3.0),
        width=0.6,
        height=1.2,
        bulge_ratio=0.2,
        calculation_height=32,
    )
    quad = build_quad_samples(sprite, _projection(), settings)
    center = (quad.qz_offset.shape[0] // 2, quad.qz_offset.shape[1] // 2)
    assert quad.qz_offset[center] < 0.0
    assert np.isclose(float(quad.qz_offset.max()), 0.0, atol=1e-6)
    assert np.allclose(np.linalg.norm(quad.normals_world, axis=-1), 1.0, atol=2e-6)
    assert quad.normals_world[center][2] < -0.99
    assert np.allclose(quad.corners_world[0], [0.7, 2.0, 3.0])
    assert np.allclose(quad.corners_world[2], [1.3, 3.2, 3.0])


def test_quad_main_normal_changes_shading_normals_without_changing_geometry() -> None:
    sprite = Image.new("RGBA", (24, 32), (160, 120, 80, 255))
    base = QuadSettings(
        foot_world=(1.0, 2.0, 3.0),
        width=0.6,
        height=1.2,
        bulge_ratio=0.25,
        calculation_height=32,
    )
    tilted = QuadSettings(
        foot_world=base.foot_world,
        width=base.width,
        height=base.height,
        bulge_ratio=base.bulge_ratio,
        main_normal_local=(1.0, 0.0, -1.0),
        calculation_height=base.calculation_height,
    )
    default_quad = build_quad_samples(sprite, _projection(), base)
    tilted_quad = build_quad_samples(sprite, _projection(), tilted)

    # Billboard/silhouette geometry is unchanged by the shading normal.
    assert np.array_equal(tilted_quad.points_world, default_quad.points_world)
    assert np.array_equal(tilted_quad.corners_world, default_quad.corners_world)
    # The chosen local direction is normalized and transformed to pseudo world.
    expected = np.array([1.0, 0.0, -1.0], dtype=np.float32) / np.sqrt(2.0)
    assert np.allclose(tilted_quad.main_normal_world, expected, atol=2e-6)
    center = (tilted_quad.normals_world.shape[0] // 2,
              tilted_quad.normals_world.shape[1] // 2)
    assert np.dot(tilted_quad.normals_world[center], expected) > 0.99
    assert not np.allclose(tilted_quad.normals_world, default_quad.normals_world)


def test_quad_rejects_zero_main_normal() -> None:
    sprite = Image.new("RGBA", (8, 8), (255, 255, 255, 255))
    with pytest.raises(ValueError, match="main_normal_local"):
        build_quad_samples(
            sprite,
            _projection(),
            QuadSettings(main_normal_local=(0.0, 0.0, 0.0)),
        )


def test_depth_march_hits_constant_surface_and_reads_its_radiance() -> None:
    depth = np.ones((512, 512), dtype=np.float32)
    radiance_color = np.array([0.25, 0.5, 0.75], dtype=np.float32)
    radiance = np.broadcast_to(radiance_color, (512, 512, 3)).copy()
    points = np.array([[0.0, 0.0, 0.0]], dtype=np.float32)
    normals = np.array([[0.0, 0.0, 1.0]], dtype=np.float32)
    settings = FinalGatherSettings(
        samples_per_pixel=512,
        step_pixels=1.0,
        max_distance=15.0,
        front_epsilon_pixels=0.5,
        back_thickness_pixels=1.5,
        miss_mode=MISS_HIT_NORMALIZED,
        visual_ray_budget=512,
    )
    incoming, coverage, origins, endpoints, fates, toward_background, metrics = (
        trace_depth_field(
            depth, radiance, _projection(), points, normals, settings,
        )
    )
    assert coverage[0] > 0.98
    assert np.allclose(incoming[0], radiance_color, atol=2e-3)
    assert origins.shape == endpoints.shape
    assert len(fates) == len(toward_background)
    assert np.mean(fates == FATE_HIT) > 0.98
    assert metrics["toward_background_percent"] == 100.0


def test_depth_march_is_invariant_under_pseudo_world_rotation() -> None:
    angle = np.deg2rad(37.0)
    rotation = np.array([
        [np.cos(angle), 0.0, np.sin(angle)],
        [0.0, 1.0, 0.0],
        [-np.sin(angle), 0.0, np.cos(angle)],
    ], dtype=np.float64)
    projection = OrthoProjection(
        R=rotation,
        ppu=12.0,
        cx=256.0,
        cy=256.0,
    )
    depth = np.ones((512, 512), dtype=np.float32)
    radiance = np.ones((512, 512, 3), dtype=np.float32)
    point_q = np.array([[0.0, 0.0, 0.0]], dtype=np.float32)
    normal_q = np.array([[0.0, 0.0, 1.0]], dtype=np.float32)
    point_world = point_q @ rotation.T
    normal_world = normal_q @ rotation.T
    settings = FinalGatherSettings(
        samples_per_pixel=256,
        step_pixels=1.0,
        max_distance=12.0,
        front_epsilon_pixels=0.5,
        back_thickness_pixels=1.5,
        miss_mode=MISS_HIT_NORMALIZED,
        visual_ray_budget=256,
    )
    incoming, coverage, _origins, endpoints, fates, _directions, _metrics = (
        trace_depth_field(
            depth, radiance, projection, point_world, normal_world, settings,
        )
    )
    assert coverage[0] > 0.97
    assert np.allclose(incoming[0], 1.0, atol=2e-3)
    hit_q = endpoints[fates == FATE_HIT] @ rotation
    assert np.all(hit_q[:, 2] > 0.8)
    assert np.all(hit_q[:, 2] < 1.2)


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_lighting_panel_nudge_button_drives_transform_from_user_event() -> None:
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication, QPushButton, QScrollArea

    from tools.scene_depth_editor.app import SceneDepthEditorApp

    app = SceneDepthEditorApp()
    try:
        app.root.show()
        QApplication.instance().processEvents()
        x_plus = next(
            button for button in app.root.findChildren(QPushButton)
            if button.text() == "X +"
        )
        scroll_area = next(iter(app.root.findChildren(QScrollArea)))
        scroll_area.ensureWidgetVisible(x_plus)
        QApplication.instance().processEvents()
        old_x = app.lighting_x_var.get()
        step = float(app._lighting_entries["move_step"].get())
        QTest.mouseClick(x_plus, Qt.LeftButton)
        QApplication.instance().processEvents()
        assert app.lighting_x_var.get() == pytest.approx(old_x + step)
        assert float(app._lighting_entries["x"].get()) == pytest.approx(old_x + step)
        assert app._lighting_position_initialized is True
        grow = next(
            button for button in app.root.findChildren(QPushButton)
            if button.text() == "放大"
        )
        old_scale = app.lighting_uniform_scale_var.get()
        QTest.mouseClick(grow, Qt.LeftButton)
        QApplication.instance().processEvents()
        assert app.lighting_uniform_scale_var.get() > old_scale

        app._lighting_entries["normal_x"].setText("1")
        app._lighting_entries["normal_y"].setText("0.5")
        app._lighting_entries["normal_z"].setText("-1")
        apply_button = next(
            button for button in app.root.findChildren(QPushButton)
            if button.text() == "应用输入值"
        )
        QTest.mouseClick(apply_button, Qt.LeftButton)
        QApplication.instance().processEvents()
        normal = np.array([
            app.lighting_normal_x_var.get(),
            app.lighting_normal_y_var.get(),
            app.lighting_normal_z_var.get(),
        ])
        assert np.linalg.norm(normal) == pytest.approx(1.0)
        assert np.allclose(normal, np.array([1.0, 0.5, -1.0]) / 1.5)
    finally:
        app.root.destroy()


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_lighting_and_hdr_panels_are_separate_readable_scroll_sections() -> None:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QApplication, QGroupBox, QScrollArea

    from tools.scene_depth_editor.app import SceneDepthEditorApp

    app = SceneDepthEditorApp()
    try:
        app.root.resize(1060, 640)
        app.root.show()
        QApplication.instance().processEvents()
        area = next(iter(app.root.findChildren(QScrollArea)))
        assert area.horizontalScrollBarPolicy() == Qt.ScrollBarAlwaysOff
        groups = {group.title(): group for group in app.root.findChildren(QGroupBox)}
        required = (
            "HDR 场景辐射度",
            "角色 Quad｜位置、尺寸与主法线",
            "实体光照采样",
            "射线显示与计算结果",
        )
        assert all(title in groups for title in required)
        for title in required:
            group = groups[title]
            assert group.width() >= 400
            assert group.minimumSizeHint().width() <= group.width()
            area.ensureWidgetVisible(group)
            QApplication.instance().processEvents()
            top_left = group.mapTo(area.viewport(), group.rect().topLeft())
            bottom_right = group.mapTo(area.viewport(), group.rect().bottomRight())
            assert bottom_right.y() >= 0
            assert top_left.y() <= area.viewport().height()

        assert app._hdr_stats_label.height() >= 86
        assert app._lighting_size_label.height() >= 62
        assert app._lighting_normal_label.height() >= 58
        assert app._lighting_metrics_label.height() >= 58
    finally:
        app.root.destroy()


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_hdr_preview_updates_from_real_slider_event(tmp_path) -> None:
    from PySide6.QtCore import QPoint, Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import (
        QApplication, QGroupBox, QPushButton, QScrollArea, QSlider,
    )

    from tools.scene_depth_editor.app import SceneDepthEditorApp

    app = SceneDepthEditorApp()
    try:
        app.open_scene_by_id_safe("teahouse")
        # Never write the repository's real scene workspace from this event test.
        app._scene_path = tmp_path
        app._hdr_cached_radiance = None
        app._hdr_cache_metadata = None
        app._hdr_result = None
        app._set_hdr_cache_state("missing", "测试工作区尚未生成")
        app.root.show()
        QApplication.instance().processEvents()
        open_button = next(
            button for button in app.root.findChildren(QPushButton)
            if button.text() == "打开实时 HDR 预览"
        )
        QTest.mouseClick(open_button, Qt.LeftButton)
        QTest.qWait(80)
        assert app._hdr_window is not None
        assert app._hdr_photo is not None
        before = app._current_hdr_result()
        assert before is not None
        before_p95 = before.stats["luminance_p95_nits"]
        cached_linear_source = app._hdr_linear_source
        assert cached_linear_source is not None
        assert before.stats["working_set_megabytes"] >= 2.0 * before.stats["data_megabytes"]
        assert app._write_hdr_cache() is True
        assert app._hdr_cache_state == "fresh"

        hdr_group = next(
            group for group in app.root.findChildren(QGroupBox)
            if group.title() == "HDR 场景辐射度"
        )
        scene_exposure_slider = hdr_group.findChildren(QSlider)[0]
        QTest.mouseClick(
            scene_exposure_slider,
            Qt.LeftButton,
            pos=QPoint(scene_exposure_slider.width() * 3 // 4,
                       scene_exposure_slider.height() // 2),
        )
        QTest.qWait(120)
        after = app._current_hdr_result()
        assert after is not None
        assert app.lighting_scene_ev_var.get() > 0.0
        assert after.stats["luminance_p95_nits"] > before_p95
        assert app._hdr_linear_source is cached_linear_source
        assert app._hdr_photo is not None
        assert app._hdr_cache_state == "stale"
        assert "物理标定" in app._hdr_cache_reason
        assert "需要更新" in app._hdr_cache_label.text()

        update_button = next(
            button for button in app.root.findChildren(QPushButton)
            if button.text() == "更新 HDR 辐射度缓存到 Editor 工程"
        )
        scroll_area = next(iter(app.root.findChildren(QScrollArea)))
        scroll_area.ensureWidgetVisible(update_button)
        QApplication.instance().processEvents()
        QTest.mouseClick(update_button, Qt.LeftButton)
        QTest.qWait(80)
        assert app._hdr_cache_state == "fresh"
        assert "缓存有效" in app._hdr_cache_label.text()
        assert (tmp_path / app._HDR_CACHE).exists()
        assert (tmp_path / app._HDR_CACHE_META).exists()
    finally:
        app._close_hdr_preview()
        app.root.destroy()


@pytest.mark.skipif(sys.platform != "darwin", reason="scene depth editor uses Qt on macOS")
def test_hdr_and_main_normal_editor_state_round_trip() -> None:
    from tools.scene_depth_editor.app import SceneDepthEditorApp

    source = SceneDepthEditorApp()
    restored = SceneDepthEditorApp()
    try:
        source.lighting_scene_ev_var.set(1.7)
        source.hdr_gain_scale_var.set(0.65)
        source.hdr_max_gain_ev_var.set(4.25)
        source.hdr_display_ev_var.set(-1.2)
        source.hdr_tone_mapper_var.set("Reinhard")
        source.hdr_preview_mode_var.set("EV 热力图")
        source.hdr_mesh_preview_var.set(True)
        source.lighting_normal_x_var.set(0.5)
        source.lighting_normal_y_var.set(0.25)
        source.lighting_normal_z_var.set(-0.75)
        data = source._collect_editor_data()

        restored._apply_editor_data(data)
        assert restored.lighting_scene_ev_var.get() == pytest.approx(1.7)
        assert restored.hdr_gain_scale_var.get() == pytest.approx(0.65)
        assert restored.hdr_max_gain_ev_var.get() == pytest.approx(4.25)
        assert restored.hdr_display_ev_var.get() == pytest.approx(-1.2)
        assert restored.hdr_tone_mapper_var.get() == "Reinhard"
        assert restored.hdr_preview_mode_var.get() == "EV 热力图"
        assert restored.hdr_mesh_preview_var.get() is True
        normal = np.array([
            restored.lighting_normal_x_var.get(),
            restored.lighting_normal_y_var.get(),
            restored.lighting_normal_z_var.get(),
        ])
        expected = np.array([0.5, 0.25, -0.75])
        expected /= np.linalg.norm(expected)
        assert np.allclose(normal, expected)
    finally:
        source.root.destroy()
        restored.root.destroy()
