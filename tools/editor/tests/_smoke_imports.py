"""Smoke-import 检查：路径迁移影响范围内的关键模块都能解析。"""
from __future__ import annotations


def main() -> None:
    # 路径策略本身
    import tools.editor.shared.project_paths  # noqa: F401
    import tools.editor.project_model  # noqa: F401

    # 主编辑器/共享/小游戏（带 PySide6）
    import tools.editor.editors.scene_editor  # noqa: F401
    import tools.editor.editors.audio_editor  # noqa: F401
    import tools.editor.editors.archive_editor  # noqa: F401
    import tools.editor.editors.sugar_wheel_editor  # noqa: F401
    import tools.editor.editors.water_minigame_canvas  # noqa: F401
    import tools.editor.editors.anim_editor  # noqa: F401
    import tools.editor.shared.image_path_picker  # noqa: F401
    import tools.editor.shared.move_entity_map_picker  # noqa: F401
    import tools.editor.shared.blend_overlay_preview  # noqa: F401

    # 其它工具
    import tools.graph_editor.parsers.json_parser  # noqa: F401
    import tools.graph_editor.serializer  # noqa: F401
    import tools.dialogue_graph_editor.flow_layout_store  # noqa: F401
    import tools.copy_manager.scanner.json_scanner  # noqa: F401
    import tools.copy_manager.scanner.ink_scanner  # noqa: F401
    import tools.copy_manager.scanner.cutscene_scanner  # noqa: F401
    import tools.copy_manager.exporters.json_exporter  # noqa: F401
    import tools.asset_browser.thumbnail_service  # noqa: F401
    import tools.asset_browser.metadata_store  # noqa: F401
    import tools.asset_ingest.ingest_window  # noqa: F401
    import tools.filter_tool.paths  # noqa: F401
    import tools.migrate_anim_bundles  # noqa: F401
    import tools.production_workbench.story_units  # noqa: F401
    import tools.production_workbench.asset_audit  # noqa: F401
    import tools.production_workbench.asset_style_sampler  # noqa: F401
    import tools.production_workbench.asset_candidates  # noqa: F401
    import tools.production_workbench.asset_output_validation  # noqa: F401
    import tools.production_workbench.asset_postprocess  # noqa: F401
    import tools.production_workbench.asset_tasks  # noqa: F401
    import tools.production_workbench.animation_sheet  # noqa: F401
    import tools.production_workbench.codex_asset_runner  # noqa: F401
    import tools.production_workbench.image_tools  # noqa: F401
    import tools.production_workbench.runtime_command  # noqa: F401
    import tools.production_workbench.runtime_debug  # noqa: F401
    import tools.production_workbench.report_log  # noqa: F401
    import tools.production_workbench.story_acceptance  # noqa: F401
    import tools.production_workbench.story_acceptance_commands  # noqa: F401
    import tools.production_workbench.story_acceptance_run  # noqa: F401
    import tools.production_workbench.daily_check  # noqa: F401
    import tools.production_workbench.graph_diagnostics  # noqa: F401
    import tools.production_workbench.workbench_window  # noqa: F401

    # video_to_atlas / scene_depth_editor 依赖 numpy/PyOpenGL，
    # 这里只在能导入时做 smoke check
    try:
        import tools.video_to_atlas.export_panel  # noqa: F401
    except ModuleNotFoundError:
        pass
    try:
        import tools.scene_depth_editor.app  # noqa: F401
    except ModuleNotFoundError:
        pass

    print("imports OK")


if __name__ == "__main__":
    main()
